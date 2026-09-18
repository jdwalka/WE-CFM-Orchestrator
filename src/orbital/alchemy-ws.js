// ================================================================
// alchemy-ws.js — Alchemy WebSocket Real-time Feed  v1.0
// Replaces ETH polling with live push subscriptions via WSS
// ================================================================
// Exports:  window.AlchemyWS
// Events:   alchemy-ws-eth-head   → { block, gasGwei, baseFee, priority }
//           alchemy-ws-tx         → { hash, to, from, blockNumber }
//           chain-router-update   → merged into ChainRouter cache
// Methods:  .start(), .stop(), .getStatus(), .subscribeAddress(filter)
// ================================================================
(function () {
  'use strict';

  let   _ws              = null;
  let   _reconnectTimer  = null;
  let   _pingTimer       = null;
  let   _reconnectDelay  = 1000;  // starts at 1s, exponential backoff up to 60s
  let   _running         = false;
  let   _latestHead      = null;
  let   _subscriptions   = {};    // subId → type
  let   _pendingSubs     = [];    // queued subscriptions before WS is open

  const MAX_RECONNECT_DELAY = 60000;
  const PING_INTERVAL       = 25000;  // keep-alive every 25s

  // ── Address filters (configurable via subscribeAddress) ──────────

  const _addressFilters = [];

  // ── Helpers ──────────────────────────────────────────────────────

  function scoreLabel(s) {
    return s > 0.30 ? 'BULLISH' : s < -0.05 ? 'BEARISH' : 'NEUTRAL';
  }

  function send(msg) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify(msg));
      return true;
    }
    _pendingSubs.push(msg);
    return false;
  }

  function subscribeNewHeads() {
    send({ jsonrpc: '2.0', id: 10, method: 'eth_subscribe', params: ['newHeads'] });
  }

  function subscribeMinedTxs(filters) {
    if (!filters || !filters.length) return;
    send({
      jsonrpc: '2.0',
      id: 11,
      method: 'eth_subscribe',
      params: [
        'alchemy_minedTransactions',
        {
          addresses: filters,
          includeRemoved: false,
          hashesOnly: true,
        },
      ],
    });
  }

  // ── Parse incoming WS message ─────────────────────────────────────

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Subscription confirmation
    if (msg.id && msg.result && typeof msg.result === 'string') {
      _subscriptions[msg.result] = msg.id === 10 ? 'newHeads' : 'minedTxs';
      console.debug('[AlchemyWS] Subscribed:', msg.result, '→', _subscriptions[msg.result]);
      return;
    }

    // Subscription event
    if (msg.method === 'eth_subscription') {
      const subId  = msg.params?.subscription;
      const type   = _subscriptions[subId];
      const result = msg.params?.result;
      if (!result) return;

      if (type === 'newHeads') {
        handleNewHead(result);
      } else if (type === 'minedTxs') {
        handleMinedTx(result);
      }
    }
  }

  function handleNewHead(head) {
    const block   = parseInt(head.number, 16) || 0;
    // EIP-1559: baseFeePerGas is in wei
    const baseFeeWei  = parseInt(head.baseFeePerGas || '0x0', 16);
    const baseFeeGwei = baseFeeWei / 1e9;
    // Typical priority fee ~1-2 Gwei on top of base fee
    const priorityFee = 1.5;
    const gasGwei     = baseFeeGwei + priorityFee;

    _latestHead = {
      block,
      gasGwei: Math.max(gasGwei, 0),
      baseFee: baseFeeGwei,
      priorityFee,
      hash: head.hash,
      timestamp: Date.now(),
    };

    // Dispatch head event for any listeners
    window.dispatchEvent(new CustomEvent('alchemy-ws-eth-head', { detail: _latestHead }));

    // Push into ChainRouter cache if available
    _pushToChainRouter(_latestHead);

    console.debug(`[AlchemyWS] newHead #${block} | base=${baseFeeGwei.toFixed(2)} | gas≈${gasGwei.toFixed(2)} Gwei`);
  }

  function handleMinedTx(txOrHash) {
    const hash = typeof txOrHash === 'string' ? txOrHash : txOrHash?.hash;
    if (!hash) return;

    window.dispatchEvent(new CustomEvent('alchemy-ws-tx', {
      detail: { hash, ...(typeof txOrHash === 'object' ? txOrHash : {}) },
    }));

    console.debug('[AlchemyWS] Mined TX:', hash);
  }

  function _pushToChainRouter(head) {
    const { gasGwei, baseFee, block } = head;
    const score = gasGwei > 60 ? 0.50 : gasGwei > 25 ? 0.20 : gasGwei < 5 ? -0.15 : 0;

    const ethEntry = {
      sym: 'ETH', label: 'Ethereum', chain: 'Ethereum Mainnet',
      source: 'Alchemy WSS', explorerUrl: 'https://etherscan.io',
      metrics: [
        { k: 'Gas Avg',      v: gasGwei ? `${gasGwei.toFixed(1)} Gwei` : '—' },
        { k: 'Base Fee',     v: baseFee  ? `${baseFee.toFixed(1)} Gwei` : '—' },
        { k: 'Gas Fast',     v: gasGwei  ? `${(gasGwei * 1.15).toFixed(1)} Gwei` : '—' },
        { k: 'Gas Slow',     v: baseFee  ? `${(baseFee + 0.5).toFixed(1)} Gwei` : '—' },
        { k: 'Block Height', v: block ? block.toLocaleString() : '—' },
        { k: 'Feed',         v: 'Live WSS' },
      ],
      congestion: gasGwei > 50 ? 'HIGH' : gasGwei > 20 ? 'MED' : 'LOW',
      score,
      signal: scoreLabel(score),
      velocity: { score: 0, dominant: 'gas' },
      leadingScore: score,
      velocityLabel: 'Live',
      raw: { gasAvg: gasGwei, gasFast: gasGwei * 1.15, gasSlow: baseFee + 0.5, txsToday: 0 },
      ts: Date.now(),
    };

    // Inject directly into ChainRouter cache if available
    if (window.ChainRouter) {
      window.ChainRouter._cache = window.ChainRouter._cache || {};
      // Access internal cache via the getAll reference
      const cache = window.ChainRouter.getAll();
      if (cache) {
        // Dispatch as chain-router-update with merged data
        const merged = { ...cache, ETH: ethEntry };
        window.dispatchEvent(new CustomEvent('chain-router-update',    { detail: merged }));
        window.dispatchEvent(new CustomEvent('blockchain-scan-update', { detail: merged }));
      }
    }
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────

  async function connect() {
    if (_ws && _ws.readyState <= WebSocket.OPEN) return;

    const key = await window.AlchemyKey.get();
    if (!key) {
      console.warn('[AlchemyWS] No Alchemy key configured — live ETH WSS feed disabled.');
      return;
    }
    if (!_running) return; // stop() may have been called while awaiting the key

    console.debug('[AlchemyWS] Connecting to Alchemy WSS...');
    _ws = new WebSocket(`wss://eth-mainnet.g.alchemy.com/v2/${key}`);

    _ws.onopen = () => {
      console.debug('[AlchemyWS] Connected');
      _reconnectDelay = 1000;

      // Subscribe to newHeads immediately
      subscribeNewHeads();

      // Subscribe to address filters if any
      if (_addressFilters.length) {
        subscribeMinedTxs(_addressFilters);
      }

      // Flush any queued subscriptions
      const queued = _pendingSubs.splice(0);
      queued.forEach(msg => _ws.send(JSON.stringify(msg)));

      // Start keep-alive ping
      clearInterval(_pingTimer);
      _pingTimer = setInterval(() => {
        send({ jsonrpc: '2.0', id: 99, method: 'net_version', params: [] });
      }, PING_INTERVAL);

      window.dispatchEvent(new CustomEvent('alchemy-ws-status', { detail: { connected: true } }));
    };

    _ws.onmessage = (event) => handleMessage(event.data);

    _ws.onerror = (err) => {
      console.warn('[AlchemyWS] Error:', err.message || err);
    };

    _ws.onclose = (event) => {
      clearInterval(_pingTimer);
      console.warn(`[AlchemyWS] Disconnected (code ${event.code})`);
      window.dispatchEvent(new CustomEvent('alchemy-ws-status', { detail: { connected: false } }));

      if (_running) {
        _reconnectTimer = setTimeout(() => {
          _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY);
          connect();
        }, _reconnectDelay);
      }
    };
  }

  // ── Public API ────────────────────────────────────────────────────

  const AlchemyWS = {
    /** Start WS and subscribe to live ETH heads */
    start() {
      _running = true;
      connect();
    },

    /** Stop WS and cancel reconnects */
    stop() {
      _running = false;
      clearTimeout(_reconnectTimer);
      clearInterval(_pingTimer);
      if (_ws) { _ws.close(1000, 'Stopped'); _ws = null; }
    },

    /** Add address filter for alchemy_minedTransactions */
    subscribeAddress(filter) {
      // filter: { to?: '0x...', from?: '0x...' }
      _addressFilters.push(filter);
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        subscribeMinedTxs([filter]);
      }
    },

    /** Get last known ETH block head */
    getLatestHead() { return _latestHead; },

    /** Current WS status */
    getStatus() {
      return {
        connected: !!_ws && _ws.readyState === WebSocket.OPEN,
        readyState: _ws ? _ws.readyState : -1,
        latestBlock: _latestHead?.block || null,
        lastUpdate: _latestHead?.timestamp || null,
        subscriptions: { ...(_subscriptions) },
        addressFilters: [..._addressFilters],
      };
    },
  };

  window.AlchemyWS = AlchemyWS;

  // Auto-start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AlchemyWS.start());
  } else {
    AlchemyWS.start();
  }

})();
