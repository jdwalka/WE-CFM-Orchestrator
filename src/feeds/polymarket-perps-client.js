// polymarket-perps-client.js — Polymarket Perpetuals (Perps) API & WebSocket Client
// WalkerEnterprise WE|||CRYPTO Engine
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  const PERPS_HTTP_URL = 'https://api.perpetuals.polymarket.com';
  const PERPS_WS_URL   = 'wss://ws.perpetuals.polymarket.com/v1/ws';
  const PROXY_PERPS_URL = 'http://127.0.0.1:8080/polymarket-perps';

  // Perps auth (if required) must come from Electron IPC — never hardcode.
  const CREDENTIALS = {
    apiKey: '',
    secret: '',
    passphrase: '',
    address: '',
  };

  const state = {
    connected: false,
    markets: {},
    tickers: {},
    fundingRates: {},
    openInterest: {},
    orderbooks: {},
    lastMessageTs: 0,
    reconnectAttempts: 0,
  };

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

    try {
      const res = await fetch(`${PROXY_PERPS_URL}${path}`, { ...options, headers });
      if (res.ok) return await res.json();
    } catch (_) {}

    const res = await fetch(`${PERPS_HTTP_URL}${path}`, { ...options, headers });
    if (!res.ok) throw new Error(`Perps API HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    try {
      ws = new WebSocket(PERPS_WS_URL);

      ws.onopen = () => {
        state.connected = true;
        state.reconnectAttempts = 0;
        console.info('[PolymarketPerpsWS] Connected to wss://ws.perpetuals.polymarket.com/v1/ws ✓');

        // Subscribe to tickers and mark prices
        const subMsg = {
          action: 'subscribe',
          channels: ['tickers', 'mark_prices', 'funding_rates'],
        };
        try { ws.send(JSON.stringify(subMsg)); } catch (_) {}

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ action: 'ping' })); } catch (_) {}
          }
        }, 15000);
      };

      ws.onmessage = (event) => {
        state.lastMessageTs = Date.now();
        try {
          const msg = JSON.parse(event.data);
          if (msg.channel === 'tickers' && msg.data) {
            msg.data.forEach((t) => {
              if (t.symbol) state.tickers[t.symbol.toUpperCase()] = t;
            });
          } else if (msg.channel === 'funding_rates' && msg.data) {
            msg.data.forEach((f) => {
              if (f.symbol) state.fundingRates[f.symbol.toUpperCase()] = f;
            });
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

    init() {
      connectWs();
      this.refreshMarketSummary();
    },

    async refreshMarketSummary() {
      try {
        const markets = await _fetchPerps('/v1/markets').catch(() => []);
        if (Array.isArray(markets)) {
          markets.forEach((m) => {
            const sym = (m.symbol || m.base_asset || '').toUpperCase();
            if (sym) state.markets[sym] = m;
          });
        }
      } catch (_) {}
    },

    async getMarket(symbol = 'BTC-USD') {
      return _fetchPerps(`/v1/markets/${encodeURIComponent(symbol)}`);
    },

    async getFundingRates() {
      return _fetchPerps('/v1/funding-rates').catch(() => state.fundingRates);
    },

    async getOrderBook(symbol = 'BTC-USD') {
      return _fetchPerps(`/v1/orderbook/${encodeURIComponent(symbol)}`);
    },

    async getPositions(address = CREDENTIALS.address) {
      return _fetchPerps(`/v1/positions?address=${encodeURIComponent(address)}`);
    },

    async createPerpOrder(orderPayload) {
      return _fetchPerps('/v1/orders', {
        method: 'POST',
        body: JSON.stringify(orderPayload),
      });
    },

    async cancelPerpOrder(orderId) {
      return _fetchPerps(`/v1/orders/${encodeURIComponent(orderId)}`, {
        method: 'DELETE',
      });
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
