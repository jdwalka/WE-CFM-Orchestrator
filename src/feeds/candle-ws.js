// candle-ws.js — Coinbase Advanced Trade WebSocket
// Real-time 1-min candle feed aggregated into live 15-minute buckets.
// Used as the live price standard for prediction comparison.
// No auth required — candles + ticker are public channels.
// Exposes: window.CandleWS

(function () {
  'use strict';

  const WS_URL          = 'wss://advanced-trade-ws.coinbase.com';
  const BUCKET_MS       = 15 * 60 * 1000;  // 15-minute window
  const MAX_BUCKETS     = 200;              // ~50 hours of 15m history per coin
  const MAX_BUCKETS_1M  = 500;             // ~8 hours of 1m history per coin

  // Map Coinbase product_id → internal symbol
  const PRODUCTS = [
    'BTC-USD', 'ETH-USD', 'SOL-USD',
    'XRP-USD', 'DOGE-USD', 'HYPE-USD'
  ];
  const SYM_MAP = {
    'BTC-USD':  'BTC',
    'ETH-USD':  'ETH',
    'SOL-USD':  'SOL',
    'XRP-USD':  'XRP',
    'DOGE-USD': 'DOGE',
    'HYPE-USD': 'HYPE'
  };

  // Per-coin state
  const store = {};
  for (const sym of Object.values(SYM_MAP)) {
    store[sym] = {
      buckets15m: [],   // [{t, o, h, l, c, v, closed}] newest last — 15-min buckets
      buckets1m:  [],   // [{t, o, h, l, c, v, closed}] newest last — 1-min candles
      live1m:     null, // latest 1-min candle from WS
      ticker:     null  // latest ticker snapshot
    };
  }

  let ws              = null;
  let connected       = false;
  let reconnectTimer  = null;
  let reconnectDelay  = 3000;

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function bucket15mStart(tsMs) {
    return Math.floor(tsMs / BUCKET_MS) * BUCKET_MS;
  }

  // Merge a 1-min candle into the appropriate 15-min bucket
  function upsertCandle(sym, c) {
    const buckets = store[sym].buckets15m;
    const bStart  = bucket15mStart(c.t);

    let bucket = buckets.length ? buckets[buckets.length - 1] : null;

    if (!bucket || bucket.t !== bStart) {
      // Close previous bucket if it exists and is older
      if (bucket && bucket.t < bStart) {
        bucket.closed = true;
        // Dispatch event so app.js can evaluate predictions against this closed candle
        try {
          dispatchEvent(new CustomEvent('candleWS:bucketClosed', {
            detail: { sym, bucket: { ...bucket } }
          }));
        } catch { /* non-critical */ }
      }

      // Open new bucket
      bucket = { t: bStart, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, closed: false };
      buckets.push(bucket);
      if (buckets.length > MAX_BUCKETS) buckets.shift();
    } else {
      // Update live bucket — high-water mark H/L, roll close
      bucket.h  = Math.max(bucket.h, c.h);
      bucket.l  = Math.min(bucket.l, c.l);
      bucket.c  = c.c;
      bucket.v += c.v;
    }

    // ── 1-minute bucket history ───────────────────────────────────────────
    // Each distinct c.t is a 1m candle. When we see a newer t, the previous
    // 1m candle is complete — fire candleWS:1mClosed and archive it.
    const b1m   = store[sym].buckets1m;
    const last1m = b1m.length ? b1m[b1m.length - 1] : null;

    if (!last1m || last1m.t < c.t) {
      // Previous 1m candle is now closed
      if (last1m && !last1m.closed) {
        last1m.closed = true;
        try {
          dispatchEvent(new CustomEvent('candleWS:1mClosed', {
            detail: { sym, bucket: { ...last1m } }
          }));
        } catch { /* non-critical */ }
      }
      // Open new 1m candle
      const newBucket1m = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, closed: false };
      b1m.push(newBucket1m);
      if (b1m.length > MAX_BUCKETS_1M) b1m.shift();
      // Fire tick for the new live candle
      try {
        dispatchEvent(new CustomEvent('candleWS:1mTick', {
          detail: { sym, bucket: { ...newBucket1m } }
        }));
      } catch { /* non-critical */ }
    } else if (last1m.t === c.t) {
      // Update the live 1m candle in place
      last1m.h = Math.max(last1m.h, c.h);
      last1m.l = Math.min(last1m.l, c.l);
      last1m.c = c.c;
      last1m.v = c.v;  // CB sends the running total for the minute — don't accumulate
      // Fire tick so chart can show the live candle updating
      try {
        dispatchEvent(new CustomEvent('candleWS:1mTick', {
          detail: { sym, bucket: { ...last1m } }
        }));
      } catch { /* non-critical */ }
    }

    store[sym].live1m = { ...c };
  }

  // ─── Message handler ────────────────────────────────────────────────────────

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    
    if (msg?.type === 'price_update' && msg?.source === 'coingecko_poller') {
      dispatchEvent(new CustomEvent('coingecko:markets', { detail: msg.data }));
      return;
    }
    
    if (!msg || !msg.events) return;

    if (msg.channel === 'candles') {
      for (const event of msg.events) {
        for (const c of (event.candles || [])) {
          const sym = SYM_MAP[c.product_id];
          if (!sym) continue;
          upsertCandle(sym, {
            t: Number(c.start) * 1000,
            o: Number(c.open),
            h: Number(c.high),
            l: Number(c.low),
            c: Number(c.close),
            v: Number(c.volume)
          });
        }
      }
    }

    if (msg.channel === 'ticker') {
      for (const event of msg.events) {
        for (const t of (event.tickers || [])) {
          const sym = SYM_MAP[t.product_id];
          if (!sym) continue;
          store[sym].ticker = {
            price:     Number(t.price),
            bestBid:   Number(t.best_bid),
            bestAsk:   Number(t.best_ask),
            vol24h:    Number(t.volume_24_h),
            ts:        Date.now()
          };
        }
      }
    }
  }

  // ─── Subscribe ──────────────────────────────────────────────────────────────

  async function fetchCoinbaseJwt() {
    try {
      if (window.desktopApp?.generateCoinbaseJWT) {
        const res = await window.desktopApp.generateCoinbaseJWT();
        if (res?.success && res.jwt) return res.jwt;
        if (res?.error) console.warn('[CandleWS] Coinbase JWT failed:', res.error);
      }
    } catch (e) {
      console.warn('[CandleWS] Coinbase JWT failed:', e.message);
    }

    for (const port of [3011, 3010]) {
      try {
        const res = await fetch(`http://localhost:${port}/jwt/coinbase`);
        if (res.ok) {
          const data = await res.json();
          if (data.token) return data.token;
        }
      } catch (_) {
        // Local proxy is optional when Electron can sign through IPC.
      }
    }
    return '';
  }

  async function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    const jwt = await fetchCoinbaseJwt();
    
    const sub = (channel) => {
      const payload = {
        type:        'subscribe',
        product_ids: PRODUCTS,
        channel
      };
      if (jwt) payload.jwt = jwt;
      ws.send(JSON.stringify(payload));
    };
    
    sub('heartbeats');
    sub('candles');
    sub('ticker');
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────────

  function connect() {
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    clearTimeout(reconnectTimer);

    try {
      ws = new WebSocket(WS_URL);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      connected      = true;
      reconnectDelay = 3000;
      subscribe();
      dispatchEvent(new CustomEvent('candleWS:connected'));
    };

    ws.onmessage = (e) => handleMessage(e.data);

    ws.onclose = () => {
      connected = false;
      ws        = null;
      dispatchEvent(new CustomEvent('candleWS:disconnected'));
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires right after — reconnect handled there
    };
  }

  function scheduleReconnect() {
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
      connect();
    }, reconnectDelay);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  window.CandleWS = {
    /** Start the WebSocket connection */
    start() { connect(); },

    /** Is the WebSocket currently open? */
    isConnected() { return connected; },

    /**
     * All closed 15-minute buckets for a coin (newest last).
     * These are the definitive completed candles to compare predictions against.
     */
    getClosedBuckets15m(sym) {
      return (store[sym]?.buckets15m || []).filter(b => b.closed);
    },

    /**
     * The currently building (open) 15-minute bucket.
     * Live — updates every 1-minute candle tick.
     */
    getLiveBucket15m(sym) {
      const b = (store[sym]?.buckets15m || []);
      const last = b[b.length - 1];
      return (last && !last.closed) ? last : null;
    },

    /**
     * All 15-minute buckets (open + closed).
     * Use for display; use getClosedBuckets15m for backtesting.
     */
    getAllBuckets15m(sym) {
      return store[sym]?.buckets15m || [];
    },

    /** Last N closed 15-minute buckets */
    getLastN15m(sym, n = 20) {
      const closed = (store[sym]?.buckets15m || []).filter(b => b.closed);
      return closed.slice(-n);
    },

    // ── 1-minute candle history ─────────────────────────────────────

    /** All closed 1-minute candles for a coin (newest last, up to ~8h) */
    getClosedBuckets1m(sym) {
      return (store[sym]?.buckets1m || []).filter(b => b.closed);
    },

    /** All 1-minute candles including the live (open) current candle */
    getAllBuckets1m(sym) {
      return store[sym]?.buckets1m || [];
    },

    /** The currently-forming (open) 1-minute candle — updates every WS tick */
    getLiveBucket1m(sym) {
      const b = store[sym]?.buckets1m || [];
      const last = b[b.length - 1];
      return (last && !last.closed) ? last : null;
    },

    /** Last N closed 1m candles */
    getLastN1m(sym, n = 60) {
      const closed = (store[sym]?.buckets1m || []).filter(b => b.closed);
      return closed.slice(-n);
    },

    /** Latest 1-minute candle from WS feed */
    getLive1m(sym) { return store[sym]?.live1m || null; },

    /** Latest ticker snapshot (price, bid, ask, vol24h) */
    getTicker(sym) { return store[sym]?.ticker || null; },

    /**
     * Returns a score 0-1 indicating how complete the current 15m bucket is.
     * 1.0 = bucket just closed, 0.0 = just opened.
     */
    getBucketProgress() {
      const now   = Date.now();
      const start = bucket15mStart(now);
      return (now - start) / BUCKET_MS;
    },

    /**
     * ms until the current 15-minute bucket closes.
     */
    getMsUntilClose() {
      const now   = Date.now();
      const start = bucket15mStart(now);
      return (start + BUCKET_MS) - now;
    },

    /**
     * Compare last prediction against the most recently closed 15m candle.
     * Returns { sym, predDir, actual, correct, pctMove } or null.
     */
    evalLastPrediction(sym, predictedDirection, predictedAtPrice) {
      const closed = (store[sym]?.buckets15m || []).filter(b => b.closed);
      if (closed.length < 1) return null;
      const last   = closed[closed.length - 1];
      const actual = last.c > last.o ? 'UP' : last.c < last.o ? 'DOWN' : 'FLAT';
      const pctMove = predictedAtPrice
        ? ((last.c - predictedAtPrice) / predictedAtPrice) * 100
        : ((last.c - last.o) / last.o) * 100;
      return {
        sym,
        predDir:   predictedDirection,
        actual,
        correct:   predictedDirection === actual,
        pctMove:   +pctMove.toFixed(4),
        bucketOpen: last.o,
        bucketClose: last.c,
        bucketT:    last.t
      };
    }
  };

})();
