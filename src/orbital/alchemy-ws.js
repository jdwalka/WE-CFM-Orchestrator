// ================================================================
// alchemy-ws.js — Alchemy WebSocket Real-time Feed  v2.0
// Multi-chain live push subscriptions via WSS — one connection per chain,
// each pushed straight into ChainRouter as the primary source (see
// ChainRouter.pushLive in chain-router.js). ChainRouter's own HTTP handler
// chain for each symbol becomes the fallback, used automatically whenever
// a chain's push goes stale (LIVE_PUSH_FRESH_MS in chain-router.js) —
// WSS down, reconnecting, or a symbol not wired to a WSS feed at all.
//
// Chains: ETH, BNB, BASE — all EVM, all support the same eth_subscribe
// WSS protocol Alchemy uses (verified against the live account key before
// wiring each one in). HYPE is deliberately NOT included even though
// hyperliquid-mainnet.g.alchemy.com also answers eth_subscribe (verified
// this too) — HYPE's meaningful signal is Hyperliquid's own perp funding
// rate (chain-router.js's hypeHyperliquid, HTTP-only, no WSS equivalent
// exists for it), not HyperEVM's execution-layer gas price. Pushing gas
// data as HYPE's "live" primary would silently replace a meaningful
// signal with a less meaningful one merely because it arrives faster.
// SOL and BTC/DOGE aren't EVM at all and use a different subscription
// mechanism entirely (Solana's own WS JSON-RPC, or none for BTC/DOGE) —
// out of scope for this module.
// ================================================================
// Exports:  window.AlchemyWS
// Events:   alchemy-ws-head        → { sym, block, gasGwei, baseFee, priority }
//           alchemy-ws-eth-head    → { block, gasGwei, baseFee, priority } (ETH only, back-compat with v1)
//           alchemy-ws-tx          → { sym, hash, to, from, blockNumber }
//           alchemy-ws-status      → { sym, connected }
// Methods:  .start([syms]), .stop([syms]), .getStatus([sym]),
//           .subscribeAddress(filter, sym='ETH'), .getLatestHead(sym='ETH')
// ================================================================
(function () {
  'use strict';

  // Gas thresholds mirror each chain's HTTP handler in chain-router.js
  // exactly (ethAlchemy/bnbAlchemy/baseAlchemy) — the same gas price must
  // not score differently depending on whether WSS or HTTP happened to
  // answer for a given poll.
  const CHAINS = {
    ETH:  { wssChain: 'eth',  label: 'Ethereum',  chainName: 'Ethereum Mainnet', explorerUrl: 'https://etherscan.io', highGas: 60, medGas: 25, decimals: 1 },
    BNB:  { wssChain: 'bnb',  label: 'BNB Chain', chainName: 'BSC Mainnet',      explorerUrl: 'https://bscscan.com',  highGas: 8,  medGas: 3,  decimals: 2 },
    BASE: { wssChain: 'base', label: 'Base',      chainName: 'Base Mainnet',     explorerUrl: 'https://basescan.org', highGas: 2,  medGas: 0.5, decimals: 3 },
  };

  const MAX_RECONNECT_DELAY = 60000;
  const PING_INTERVAL       = 25000;  // keep-alive every 25s

  // sym -> { ws, reconnectTimer, pingTimer, reconnectDelay, running,
  //          subscriptions, pendingSubs, addressFilters, latestHead }
  const conns = {};

  function initConn(sym) {
    return conns[sym] || (conns[sym] = {
      ws: null, reconnectTimer: null, pingTimer: null, reconnectDelay: 1000,
      running: false, subscriptions: {}, pendingSubs: [], addressFilters: [], latestHead: null,
    });
  }

  function scoreLabel(s) {
    return s > 0.30 ? 'BULLISH' : s < -0.05 ? 'BEARISH' : 'NEUTRAL';
  }

  function send(sym, msg) {
    const c = conns[sym];
    if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify(msg));
      return true;
    }
    if (c) c.pendingSubs.push(msg);
    return false;
  }

  function subscribeNewHeads(sym) {
    send(sym, { jsonrpc: '2.0', id: 10, method: 'eth_subscribe', params: ['newHeads'] });
  }

  function subscribeMinedTxs(sym, filters) {
    if (!filters || !filters.length) return;
    send(sym, {
      jsonrpc: '2.0',
      id: 11,
      method: 'eth_subscribe',
      params: [
        'alchemy_minedTransactions',
        { addresses: filters, includeRemoved: false, hashesOnly: true },
      ],
    });
  }

  // ── Parse incoming WS message ─────────────────────────────────────

  function handleMessage(sym, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const c = conns[sym];
    if (!c) return;

    // Subscription confirmation
    if (msg.id && msg.result && typeof msg.result === 'string') {
      c.subscriptions[msg.result] = msg.id === 10 ? 'newHeads' : 'minedTxs';
      console.debug(`[AlchemyWS:${sym}] Subscribed:`, msg.result, '→', c.subscriptions[msg.result]);
      return;
    }

    // Subscription event
    if (msg.method === 'eth_subscription') {
      const subId  = msg.params?.subscription;
      const type   = c.subscriptions[subId];
      const result = msg.params?.result;
      if (!result) return;

      if (type === 'newHeads') {
        handleNewHead(sym, result);
      } else if (type === 'minedTxs') {
        handleMinedTx(sym, result);
      }
    }
  }

  function handleNewHead(sym, head) {
    const cfg = CHAINS[sym];
    const c = conns[sym];
    const block = parseInt(head.number, 16) || 0;
    // EIP-1559: baseFeePerGas is in wei
    const baseFeeWei  = parseInt(head.baseFeePerGas || '0x0', 16);
    const baseFeeGwei = baseFeeWei / 1e9;
    // Typical priority fee ~1-2 Gwei on top of base fee
    const priorityFee = 1.5;
    const gasGwei     = Math.max(baseFeeGwei + priorityFee, 0);

    c.latestHead = {
      block, gasGwei, baseFee: baseFeeGwei, priorityFee,
      hash: head.hash, timestamp: Date.now(),
    };

    window.dispatchEvent(new CustomEvent('alchemy-ws-head', { detail: { sym, ...c.latestHead } }));
    if (sym === 'ETH') {
      // v1 only ever fired this (ETH-only) event name — kept as-is in case
      // anything is ever added that listens for it specifically.
      window.dispatchEvent(new CustomEvent('alchemy-ws-eth-head', { detail: c.latestHead }));
    }

    _pushToChainRouter(sym, cfg, c.latestHead);

    console.debug(`[AlchemyWS:${sym}] newHead #${block} | base=${baseFeeGwei.toFixed(2)} | gas≈${gasGwei.toFixed(2)} Gwei`);
  }

  function handleMinedTx(sym, txOrHash) {
    const hash = typeof txOrHash === 'string' ? txOrHash : txOrHash?.hash;
    if (!hash) return;

    window.dispatchEvent(new CustomEvent('alchemy-ws-tx', {
      detail: { sym, hash, ...(typeof txOrHash === 'object' ? txOrHash : {}) },
    }));

    console.debug(`[AlchemyWS:${sym}] Mined TX:`, hash);
  }

  function _pushToChainRouter(sym, cfg, head) {
    if (!window.ChainRouter) return;
    const { gasGwei, baseFee, block } = head;
    const d = cfg.decimals;
    const score = gasGwei > cfg.highGas ? 0.50 : gasGwei > cfg.medGas ? 0.20 : gasGwei < (cfg.medGas * 0.2) ? -0.15 : 0;
    const congestion = gasGwei > cfg.highGas ? 'HIGH' : gasGwei > cfg.medGas ? 'MED' : 'LOW';

    window.ChainRouter.pushLive(sym, {
      sym, label: cfg.label, chain: cfg.chainName,
      source: 'Alchemy WSS', explorerUrl: cfg.explorerUrl,
      metrics: [
        { k: 'Gas Avg',      v: gasGwei ? `${gasGwei.toFixed(d)} Gwei` : '—' },
        { k: 'Base Fee',     v: baseFee  ? `${baseFee.toFixed(d)} Gwei` : '—' },
        { k: 'Gas Fast',     v: gasGwei  ? `${(gasGwei * 1.15).toFixed(d)} Gwei` : '—' },
        { k: 'Gas Slow',     v: baseFee  ? `${(baseFee + 0.5).toFixed(d)} Gwei` : '—' },
        { k: 'Block Height', v: block ? block.toLocaleString() : '—' },
        { k: 'Feed',         v: 'Live WSS' },
      ],
      congestion, score, signal: scoreLabel(score),
      raw: { gasAvg: gasGwei, gasFast: gasGwei * 1.15, gasSlow: baseFee + 0.5, txsToday: 0 },
      ts: Date.now(),
    });
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────

  async function connect(sym) {
    const c = initConn(sym);
    if (c.ws && c.ws.readyState <= WebSocket.OPEN) return;

    const key = await window.AlchemyKey.get();
    if (!key) {
      console.warn(`[AlchemyWS:${sym}] No Alchemy key configured — live WSS feed disabled.`);
      return;
    }
    if (!c.running) return; // stop() may have been called while awaiting the key

    const cfg = CHAINS[sym];
    console.debug(`[AlchemyWS:${sym}] Connecting to Alchemy WSS...`);
    c.ws = new WebSocket(`wss://${cfg.wssChain}-mainnet.g.alchemy.com/v2/${key}`);

    c.ws.onopen = () => {
      console.debug(`[AlchemyWS:${sym}] Connected`);
      c.reconnectDelay = 1000;

      subscribeNewHeads(sym);
      if (c.addressFilters.length) subscribeMinedTxs(sym, c.addressFilters);

      const queued = c.pendingSubs.splice(0);
      queued.forEach(msg => c.ws.send(JSON.stringify(msg)));

      clearInterval(c.pingTimer);
      c.pingTimer = setInterval(() => {
        send(sym, { jsonrpc: '2.0', id: 99, method: 'net_version', params: [] });
      }, PING_INTERVAL);

      window.dispatchEvent(new CustomEvent('alchemy-ws-status', { detail: { sym, connected: true } }));
    };

    c.ws.onmessage = (event) => handleMessage(sym, event.data);

    c.ws.onerror = (err) => {
      console.warn(`[AlchemyWS:${sym}] Error:`, err.message || err);
    };

    c.ws.onclose = (event) => {
      clearInterval(c.pingTimer);
      console.warn(`[AlchemyWS:${sym}] Disconnected (code ${event.code})`);
      window.dispatchEvent(new CustomEvent('alchemy-ws-status', { detail: { sym, connected: false } }));

      if (c.running) {
        c.reconnectTimer = setTimeout(() => {
          c.reconnectDelay = Math.min(c.reconnectDelay * 2, MAX_RECONNECT_DELAY);
          connect(sym);
        }, c.reconnectDelay);
      }
    };
  }

  function stopChain(sym) {
    const c = conns[sym];
    if (!c) return;
    c.running = false;
    clearTimeout(c.reconnectTimer);
    clearInterval(c.pingTimer);
    if (c.ws) { c.ws.close(1000, 'Stopped'); c.ws = null; }
  }

  // ── Public API ────────────────────────────────────────────────────

  const AlchemyWS = {
    /** Start WS and subscribe to live heads. Defaults to every configured chain. */
    start(syms) {
      const list = syms || Object.keys(CHAINS);
      for (const sym of list) {
        if (!CHAINS[sym]) { console.warn(`[AlchemyWS] Unknown chain: ${sym}`); continue; }
        initConn(sym).running = true;
        connect(sym);
      }
    },

    /** Stop WS and cancel reconnects. Defaults to every connected chain. */
    stop(syms) {
      (syms || Object.keys(conns)).forEach(stopChain);
    },

    /** Add address filter for alchemy_minedTransactions on one chain (default ETH). */
    subscribeAddress(filter, sym = 'ETH') {
      const c = initConn(sym);
      c.addressFilters.push(filter);
      if (c.ws && c.ws.readyState === WebSocket.OPEN) {
        subscribeMinedTxs(sym, [filter]);
      }
    },

    /** Get last known block head for one chain (default ETH). */
    getLatestHead(sym = 'ETH') {
      return conns[sym]?.latestHead || null;
    },

    /** Status for one chain, or all configured chains if sym is omitted. */
    getStatus(sym) {
      const build = (s) => {
        const c = conns[s];
        if (!c) {
          return { connected: false, readyState: -1, latestBlock: null, lastUpdate: null, subscriptions: {}, addressFilters: [] };
        }
        return {
          connected: !!c.ws && c.ws.readyState === WebSocket.OPEN,
          readyState: c.ws ? c.ws.readyState : -1,
          latestBlock: c.latestHead?.block || null,
          lastUpdate: c.latestHead?.timestamp || null,
          subscriptions: { ...c.subscriptions },
          addressFilters: [...c.addressFilters],
        };
      };
      if (sym) return build(sym);
      const all = {};
      Object.keys(CHAINS).forEach((s) => { all[s] = build(s); });
      return all;
    },
  };

  window.AlchemyWS = AlchemyWS;

  // Auto-start every configured chain when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AlchemyWS.start());
  } else {
    AlchemyWS.start();
  }

})();
