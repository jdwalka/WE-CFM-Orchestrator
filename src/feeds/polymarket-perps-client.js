// polymarket-perps-client.js — Polymarket Perpetuals (Perps) API & WebSocket Client
// WalkerEnterprise WE|||CRYPTO Engine
//
// Endpoint paths verified live against https://docs.polymarket.com/api-reference/perps/overview
// (2026-08-22) — the API is keyed by numeric instrument_id, not symbol strings, so every
// symbol-based call below resolves through the instrument map fetched on init().
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  const PERPS_HTTP_URL = 'https://api.perpetuals.polymarket.com';
  const PERPS_WS_URL   = 'wss://ws.perpetuals.polymarket.com/v1/ws';
  function getProxyPerpsUrl() {
    const p = (typeof window !== 'undefined' && window.__PROXY_PORT__) || 3010;
    return `http://127.0.0.1:${p}/polymarket-perps`;
  }
  const PROXY_PERPS_URL = getProxyPerpsUrl();

  // Perps auth (if required) must come from Electron IPC — never hardcode.
  const CREDENTIALS = {
    apiKey: '',
    secret: '',
    passphrase: '',
    address: '',
  };

  const state = {
    connected: false,
    markets: {},        // symbol -> instrument object
    tickers: {},         // symbol -> ticker object
    fundingRates: {},    // symbol -> funding rate string
    openInterest: {},    // symbol -> open interest string
    orderbooks: {},
    lastMessageTs: 0,
    reconnectAttempts: 0,
  };

  // instrument_id <-> symbol, populated by refreshInstruments()
  const idToSymbol = {};
  const symbolToId = {};

  let ws = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;

  async function _fetchPerps(path, options = {}) {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    // Optional address-only context (never secrets)
    if (CREDENTIALS.address) headers['POLY_ADDRESS'] = CREDENTIALS.address;

    const res = await fetch(`${PERPS_HTTP_URL}${path}`, { ...options, headers });
    if (!res.ok) throw new Error(`Perps API HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }

  function resolveInstrumentId(symbolOrId) {
    if (typeof symbolOrId === 'number') return symbolOrId;
    const sym = String(symbolOrId).toUpperCase();
    return symbolToId[sym] ?? symbolToId[`${sym}-USD`] ?? null;
  }

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    try {
      ws = new WebSocket(PERPS_WS_URL);

      ws.onopen = () => {
        state.connected = true;
        state.reconnectAttempts = 0;
        console.info('[PolymarketPerpsWS] Connected to wss://ws.perpetuals.polymarket.com/v1/ws ✓');

        // Public market-data channel: all instrument tickers (price, funding, OI).
        // Message shape verified against docs.polymarket.com/api-reference/wss/perps-tickers
        try { ws.send(JSON.stringify({ req: 'sub', chs: ['tickers::all'] })); } catch (_) {}

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ req: 'post', op: { type: 'ping' } })); } catch (_) {}
          }
        }, 15000);
      };

      ws.onmessage = (event) => {
        state.lastMessageTs = Date.now();
        try {
          const msg = JSON.parse(event.data);
          if (typeof msg.ch === 'string' && msg.ch.startsWith('tickers::') && msg.data) {
            const t = msg.data;
            const symbol = idToSymbol[t.iid];
            if (symbol) {
              state.tickers[symbol] = t;
              if (t.fr != null) state.fundingRates[symbol] = t.fr;
              if (t.oi != null) state.openInterest[symbol] = t.oi;
            }
          }
          window.dispatchEvent(new CustomEvent('polymarket:perps:update', { detail: msg }));
        } catch (_) {}
      };

      ws.onerror = (err) => {
        console.warn('[PolymarketPerpsWS] Error:', err?.message || 'WS error');
      };

      ws.onclose = () => {
        state.connected = false;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        const delay = Math.min(30000, 2000 * Math.pow(1.5, state.reconnectAttempts++));
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWs, delay);
      };
    } catch (e) {
      console.warn('[PolymarketPerpsWS] Connect exception:', e?.message);
    }
  }

  const PolymarketPerpsClient = {
    state,

    async init() {
      await this.refreshInstruments();
      connectWs();
      this.refreshTickers();
    },

    // GET /v1/info/instruments — trading specs for every perpetual contract.
    // Must run before any symbol-keyed lookup: the API has no per-symbol path,
    // only numeric instrument_id, so this builds the symbol <-> id map.
    async refreshInstruments() {
      try {
        const instruments = await _fetchPerps('/v1/info/instruments?instrument_type=perpetual');
        if (Array.isArray(instruments)) {
          instruments.forEach((inst) => {
            const sym = (inst.symbol || '').toUpperCase();
            if (!sym) return;
            idToSymbol[inst.instrument_id] = sym;
            symbolToId[sym] = inst.instrument_id;
            state.markets[sym] = inst;
          });
        }
      } catch (e) {
        console.warn('[PolymarketPerpsWS] refreshInstruments failed:', e?.message);
      }
    },

    // GET /v1/info/tickers — live price/funding/OI for every instrument.
    async refreshTickers() {
      try {
        const tickers = await _fetchPerps('/v1/info/tickers');
        if (Array.isArray(tickers)) {
          tickers.forEach((t) => {
            const symbol = idToSymbol[t.instrument_id];
            if (!symbol) return;
            state.tickers[symbol] = t;
            if (t.funding_rate != null) state.fundingRates[symbol] = t.funding_rate;
            if (t.open_interest != null) state.openInterest[symbol] = t.open_interest;
          });
        }
      } catch (e) {
        console.warn('[PolymarketPerpsWS] refreshTickers failed:', e?.message);
      }
    },

    // Instrument spec (contract size, leverage caps, etc.) for one symbol, e.g. 'BTC-USD'.
    // Not every coin on the dashboard has a perp — DOGE and BNB are not listed by Polymarket
    // Perps as of 2026-08-22; callers must handle a null return.
    getMarket(symbol = 'BTC-USD') {
      return state.markets[symbol.toUpperCase()] || null;
    },

    async getFundingHistory(symbolOrId, { start, end } = {}) {
      const iid = resolveInstrumentId(symbolOrId);
      if (iid == null) throw new Error(`Unknown perps instrument: ${symbolOrId}`);
      const params = new URLSearchParams({ instrument_id: String(iid) });
      if (start) params.set('start_timestamp', String(start));
      if (end) params.set('end_timestamp', String(end));
      return _fetchPerps(`/v1/info/funding?${params.toString()}`);
    },

    async getOrderBook(symbol = 'BTC-USD', depth = 100) {
      const iid = resolveInstrumentId(symbol);
      if (iid == null) throw new Error(`Unknown perps instrument: ${symbol}`);
      return _fetchPerps(`/v1/info/book?instrument_id=${iid}&depth=${depth}`);
    },

    // Requires POLYMARKET-PROXY / POLYMARKET-SECRET auth headers wired from Electron IPC.
    // CREDENTIALS is intentionally empty at rest — this will 401 until real signing is added.
    async getPositions() {
      const headers = {};
      if (CREDENTIALS.apiKey) headers['POLYMARKET-PROXY'] = CREDENTIALS.apiKey;
      if (CREDENTIALS.secret) headers['POLYMARKET-SECRET'] = CREDENTIALS.secret;
      return _fetchPerps('/v1/account/portfolio', { headers });
    },

    // Order placement requires request signing (sig/salt/ts over the order body — see
    // docs.polymarket.com/http/signing#2-proxy-signing). Not implemented: this codebase has
    // no signer wired in yet. Throwing loudly beats silently POSTing an unsigned order.
    async createPerpOrder(_orderPayload) {
      throw new Error('[PolymarketPerpsWS] createPerpOrder: proxy-signing not implemented yet — see docs.polymarket.com/http/signing');
    },

    async cancelPerpOrder(_orderId) {
      throw new Error('[PolymarketPerpsWS] cancelPerpOrder: proxy-signing not implemented yet — see docs.polymarket.com/http/signing');
    },

    getTicker(sym = 'BTC') {
      const symbol = sym.toUpperCase();
      return state.tickers[`${symbol}-USD`] || state.tickers[symbol] || null;
    },

    getFundingRate(sym = 'BTC') {
      const symbol = sym.toUpperCase();
      return state.fundingRates[`${symbol}-USD`] || state.fundingRates[symbol] || null;
    },
  };

  window.PolymarketPerpsClient = PolymarketPerpsClient;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => PolymarketPerpsClient.init());
  } else {
    PolymarketPerpsClient.init();
  }

  console.info('[WE] PolymarketPerpsClient live (HTTP & WS) ✓');
})();
