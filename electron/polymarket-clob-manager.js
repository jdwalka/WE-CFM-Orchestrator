const { ClobClient } = require('@polymarket/clob-client-v2');
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');

let clobClient = null;

function initClobClient() {
  try {
    const secretsPath = path.join(__dirname, '..', 'secrets', 'POLYMARKET_API.txt');
    if (!fs.existsSync(secretsPath)) {
      console.warn('[Polymarket CLOB] secrets/POLYMARKET_API.txt not found.');
      return;
    }
    
    const content = fs.readFileSync(secretsPath, 'utf-8');
    
    // Extract key, secret, passphrase using regex
    const keyMatch = content.match(/"key":\s*"([^"]+)"/);
    const secretMatch = content.match(/"secret":\s*"([^"]+)"/);
    const passMatch = content.match(/"passphrase":\s*"([^"]+)"/);
    
    if (!keyMatch || !secretMatch || !passMatch) {
      console.warn('[Polymarket CLOB] L2 credentials not found in secrets/POLYMARKET_API.txt');
      return;
    }
    
    const creds = {
      key: keyMatch[1],
      secret: secretMatch[1],
      passphrase: passMatch[1]
    };
    
    clobClient = new ClobClient({
      host: 'https://clob.polymarket.com',
      chain: 137, // Polygon Mainnet
      creds
    });
    
    console.log('[Polymarket CLOB] Authenticated client initialized successfully.');
  } catch (err) {
    console.error('[Polymarket CLOB] Failed to initialize:', err);
  }
}

function registerIpcHandlers() {
  // Generic authenticated GET fetcher
  ipcMain.handle('poly:fetchClob', async (event, endpoint) => {
    if (!clobClient) {
      return { error: 'ClobClient not initialized' };
    }
    try {
      // Use the client's internal .get() which signs requests with HMAC
      const result = await clobClient.get(endpoint);
      return result;
    } catch (err) {
      console.error(`[Polymarket CLOB] fetchClob error for ${endpoint}:`, err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('poly:getMarkets', async (event, nextCursor = '') => {
    if (!clobClient) return { error: 'Not initialized' };
    try {
      const markets = await clobClient.getMarkets(nextCursor);
      return markets;
    } catch (err) {
      console.error('[Polymarket CLOB] getMarkets error:', err.message);
      return { error: err.message };
    }
  });
}

module.exports = {
  initClobClient,
  registerIpcHandlers
};
