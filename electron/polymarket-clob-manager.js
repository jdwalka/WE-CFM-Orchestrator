/**
 * Polymarket CLOB manager (Electron main only).
 * L2 credentials stay in secrets/POLYMARKET_API.txt — never in the renderer.
 *
 * IPC surface:
 *   poly:status          — ready / address / liveTrading (no secrets)
 *   poly:getMarkets      — authenticated market list
 *   poly:fetchClob       — signed GET (path only)
 *   poly:getOrderBook    — book for token
 *   poly:getOpenOrders   — open orders
 *   poly:placeOrder      — createAndPostOrder (requires POLY_LIVE_TRADING)
 *   poly:cancelOrder     — cancel one
 *   poly:cancelAll       — kill switch
 */
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');

let clobClient = null;
let _address = '';
let _liveTrading = false;
let _initError = '';

const MAX_ORDER_SIZE = Number(process.env.POLY_MAX_ORDER_SIZE || 100);
const MAX_ORDER_PRICE = 0.99;
const MIN_ORDER_PRICE = 0.01;

function _readSecrets() {
  const secretsPath = path.join(__dirname, '..', 'secrets', 'POLYMARKET_API.txt');
  if (!fs.existsSync(secretsPath)) {
    return { error: 'secrets/POLYMARKET_API.txt not found' };
  }
  const content = fs.readFileSync(secretsPath, 'utf-8');
  const keyMatch = content.match(/"key":\s*"([^"]+)"/);
  const secretMatch = content.match(/"secret":\s*"([^"]+)"/);
  const passMatch = content.match(/"passphrase":\s*"([^"]+)"/);
  // Optional wallet / funder address for status (never required for L2 read)
  const addrMatch =
    content.match(/"address":\s*"([^"]+)"/i) ||
    content.match(/"funder":\s*"([^"]+)"/i) ||
    content.match(/0x[a-fA-F0-9]{40}/);

  if (!keyMatch || !secretMatch || !passMatch) {
    return { error: 'L2 key/secret/passphrase not found in POLYMARKET_API.txt' };
  }

  return {
    creds: {
      key: keyMatch[1],
      secret: secretMatch[1],
      passphrase: passMatch[1],
    },
    address: addrMatch ? (addrMatch[1] || addrMatch[0]) : '',
  };
}

function initClobClient() {
  try {
    const parsed = _readSecrets();
    if (parsed.error) {
      _initError = parsed.error;
      console.warn('[Polymarket CLOB]', parsed.error);
      return;
    }

    _address = parsed.address || '';
    _liveTrading =
      process.env.POLY_LIVE_TRADING === '1' ||
      process.env.POLY_LIVE_TRADING === 'true' ||
      /"liveTrading"\s*:\s*true/i.test(
        fs.readFileSync(path.join(__dirname, '..', 'secrets', 'POLYMARKET_API.txt'), 'utf-8')
      );

    // Prefer v2; fall back to v1 package name if only one is installed
    let ClobClient;
    try {
      ({ ClobClient } = require('@polymarket/clob-client-v2'));
    } catch (_) {
      ({ ClobClient } = require('@polymarket/clob-client'));
    }

    clobClient = new ClobClient({
      host: 'https://clob.polymarket.com',
      chain: 137,
      creds: parsed.creds,
    });

    _initError = '';
    console.log(
      `[Polymarket CLOB] Authenticated client ready (liveTrading=${_liveTrading}, address=${_address ? _address.slice(0, 8) + '…' : 'n/a'})`
    );
  } catch (err) {
    _initError = err.message || String(err);
    clobClient = null;
    console.error('[Polymarket CLOB] Failed to initialize:', err);
  }
}

function _requireClient() {
  if (!clobClient) return { error: _initError || 'ClobClient not initialized' };
  return null;
}

function _validateOrder(order) {
  if (!order || typeof order !== 'object') return 'order payload required';
  const price = Number(order.price);
  const size = Number(order.size);
  if (!Number.isFinite(price) || price < MIN_ORDER_PRICE || price > MAX_ORDER_PRICE) {
    return `price must be between ${MIN_ORDER_PRICE} and ${MAX_ORDER_PRICE}`;
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_ORDER_SIZE) {
    return `size must be > 0 and <= ${MAX_ORDER_SIZE}`;
  }
  if (!order.tokenID && !order.tokenId && !order.token_id) {
    return 'tokenID required';
  }
  const side = String(order.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return 'side must be BUY or SELL';
  return null;
}

function registerIpcHandlers() {
  // Avoid double-register on hot reload
  const channels = [
    'poly:status',
    'poly:fetchClob',
    'poly:getMarkets',
    'poly:getOrderBook',
    'poly:getOpenOrders',
    'poly:placeOrder',
    'poly:cancelOrder',
    'poly:cancelAll',
  ];
  for (const ch of channels) {
    try { ipcMain.removeHandler(ch); } catch (_) { /* first register */ }
  }

  ipcMain.handle('poly:status', async () => ({
    ready: !!clobClient,
    address: _address || '',
    liveTrading: _liveTrading,
    maxOrderSize: MAX_ORDER_SIZE,
    error: _initError || null,
  }));

  ipcMain.handle('poly:fetchClob', async (_event, endpoint) => {
    const err = _requireClient();
    if (err) return err;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
      return { error: 'endpoint must be a path starting with /' };
    }
    try {
      return await clobClient.get(endpoint);
    } catch (e) {
      console.error(`[Polymarket CLOB] fetchClob ${endpoint}:`, e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('poly:getMarkets', async (_event, nextCursor = '') => {
    const err = _requireClient();
    if (err) return err;
    try {
      return await clobClient.getMarkets(nextCursor);
    } catch (e) {
      console.error('[Polymarket CLOB] getMarkets:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('poly:getOrderBook', async (_event, tokenID) => {
    const err = _requireClient();
    if (err) return err;
    if (!tokenID) return { error: 'tokenID required' };
    try {
      if (typeof clobClient.getOrderBook === 'function') {
        return await clobClient.getOrderBook(tokenID);
      }
      return await clobClient.get(`/book?token_id=${encodeURIComponent(tokenID)}`);
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('poly:getOpenOrders', async () => {
    const err = _requireClient();
    if (err) return err;
    try {
      if (typeof clobClient.getOpenOrders === 'function') {
        return await clobClient.getOpenOrders();
      }
      return await clobClient.get('/data/orders');
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('poly:placeOrder', async (_event, order) => {
    const err = _requireClient();
    if (err) return err;
    if (!_liveTrading) {
      return {
        error: 'Live trading disabled. Set POLY_LIVE_TRADING=1 or "liveTrading": true in secrets/POLYMARKET_API.txt',
        paper: true,
      };
    }
    const v = _validateOrder(order);
    if (v) return { error: v };

    const tokenID = order.tokenID || order.tokenId || order.token_id;
    const side = String(order.side).toUpperCase();
    const price = Number(order.price);
    const size = Number(order.size);
    const orderType = order.orderType || order.type || 'GTC';

    try {
      const payload = {
        tokenID,
        price,
        size,
        side,
        feeRateBps: order.feeRateBps ?? 0,
      };
      if (typeof clobClient.createAndPostOrder === 'function') {
        const result = await clobClient.createAndPostOrder(payload, undefined, orderType);
        console.log(`[Polymarket CLOB] placeOrder ${side} ${size}@${price} token=${String(tokenID).slice(0, 12)}…`);
        return { ok: true, result };
      }
      if (typeof clobClient.createOrder === 'function') {
        const signed = await clobClient.createOrder(payload);
        const result = typeof clobClient.postOrder === 'function'
          ? await clobClient.postOrder(signed, orderType)
          : signed;
        return { ok: true, result };
      }
      return { error: 'ClobClient has no createAndPostOrder/createOrder API' };
    } catch (e) {
      console.error('[Polymarket CLOB] placeOrder failed:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('poly:cancelOrder', async (_event, orderID) => {
    const err = _requireClient();
    if (err) return err;
    if (!_liveTrading) return { error: 'Live trading disabled', paper: true };
    if (!orderID) return { error: 'orderID required' };
    try {
      if (typeof clobClient.cancelOrder === 'function') {
        return { ok: true, result: await clobClient.cancelOrder({ orderID }) };
      }
      if (typeof clobClient.cancel === 'function') {
        return { ok: true, result: await clobClient.cancel(orderID) };
      }
      return { error: 'ClobClient has no cancelOrder API' };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('poly:cancelAll', async () => {
    const err = _requireClient();
    if (err) return err;
    if (!_liveTrading) return { error: 'Live trading disabled', paper: true };
    try {
      if (typeof clobClient.cancelAll === 'function') {
        const result = await clobClient.cancelAll();
        console.warn('[Polymarket CLOB] cancelAll invoked (kill switch)');
        return { ok: true, result };
      }
      return { error: 'ClobClient has no cancelAll API' };
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = {
  initClobClient,
  registerIpcHandlers,
};
