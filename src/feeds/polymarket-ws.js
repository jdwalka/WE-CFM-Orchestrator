// polymarket-ws.js — Real-Time Polymarket CLOB & RTDS WebSocket Feed
// WalkerEnterprise WE|||CRYPTO Engine
//
// Single owner of public market microstructure (CLOB market channel + RTDS).
// PredictionMarkets and UI consumers MUST use this module — do not open a
// second wss://ws-subscriptions-clob.polymarket.com/ws/market from the renderer.
// Authenticated trading IPC stays in electron/polymarket-clob-manager.js.
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.PolymarketWS) return;

  const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';

  // Docs: market channel app-level heartbeat is text frame PING every 10s → PONG.
  // RTDS: text frame PING every 5s.
  const CLOB_HEARTBEAT_MS = 10_000;
  const RTDS_HEARTBEAT_MS = 5_000;
  const RECONNECT_BASE_MS = 1_000;
  const RECONNECT_MAX_MS = 30_000;
  const L2_DEPTH_CAP = 15;
  // Near-touch window for notional (top N levels each side).
  const NEAR_TOUCH_LEVELS = 3;

  let _clobWs = null;
  let _rtdsWs = null;
  let _clobHeartbeat = null;
  let _rtdsHeartbeat = null;
  let _reconnectAttempts = 0;
  let _activeAssetIds = new Set();
  /** @type {Record<string, object>} tokenId -> book + micro features */
  let _marketState = {};
  /** @type {Record<string, { price: number, timestamp: number }>} */
  let _rtdsPrices = {};

  function _log(msg, ...args) {
    console.log(`[PolymarketWS] ${msg}`, ...args);
  }

  function _warn(msg, ...args) {
    console.warn(`[PolymarketWS] ${msg}`, ...args);
  }

  function _reportHealth(healthy, reason = '') {
    if (window.NetworkHealth && typeof window.NetworkHealth.reportStatus === 'function') {
      window.NetworkHealth.reportStatus('Polymarket', healthy ? 'healthy' : 'degraded', {
        reason: reason || (healthy ? 'CLOB/RTDS WS connected' : 'WS connecting'),
        bucket: healthy ? 'network/transport' : 'app/logic',
      });
    }
  }

  function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Normalize a book side to [{ price, size }, ...] sorted (bids desc, asks asc), capped. */
  function _normalizeLevels(rows, side) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const out = [];
    for (const row of rows) {
      let price;
      let size;
      if (Array.isArray(row)) {
        price = _num(row[0]);
        size = _num(row[1]);
      } else if (row && typeof row === 'object') {
        price = _num(row.price);
        size = _num(row.size ?? row.amount ?? row.quantity);
      } else {
        continue;
      }
      if (price == null || size == null || size < 0) continue;
      // Outcome tokens are [0,1]; keep out-of-range only if clearly a valid price level.
      if (price < 0) continue;
      out.push({ price, size });
    }
    if (side === 'bid') {
      out.sort((a, b) => b.price - a.price);
    } else {
      out.sort((a, b) => a.price - b.price);
    }
    return out.slice(0, L2_DEPTH_CAP);
  }

  function _bestFromLevels(levels, side) {
    if (!levels || !levels.length) return null;
    if (side === 'bid') return levels[0].price;
    return levels[0].price;
  }

  function _sumNotional(levels, n) {
    if (!levels || !levels.length) return 0;
    let sum = 0;
    const lim = Math.min(n, levels.length);
    for (let i = 0; i < lim; i++) {
      const lv = levels[i];
      sum += lv.price * lv.size;
    }
    return sum;
  }

  function _sumSize(levels, n) {
    if (!levels || !levels.length) return 0;
    let sum = 0;
    const lim = Math.min(n, levels.length);
    for (let i = 0; i < lim; i++) sum += levels[i].size;
    return sum;
  }

  /**
   * Compute mid / spread / depth imbalance / near-touch notional from L2.
   * depthImbalance ∈ [-1, 1]: positive = more bid notional (support), negative = more ask.
   */
  function _computeMicro(bids, asks, bestBid, bestAsk) {
    let mid = null;
    if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
      mid = (bestBid + bestAsk) / 2;
    } else if (Number.isFinite(bestBid)) {
      mid = bestBid;
    } else if (Number.isFinite(bestAsk)) {
      mid = bestAsk;
    }

    let spread = null;
    if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
      spread = bestAsk - bestBid;
    }

    const bidN = _sumNotional(bids, L2_DEPTH_CAP);
    const askN = _sumNotional(asks, L2_DEPTH_CAP);
    const total = bidN + askN;
    const depthImbalance = total > 0 ? (bidN - askN) / total : null;

    const nearTouchNotional =
      _sumNotional(bids, NEAR_TOUCH_LEVELS) + _sumNotional(asks, NEAR_TOUCH_LEVELS);
    const nearTouchBidSize = _sumSize(bids, NEAR_TOUCH_LEVELS);
    const nearTouchAskSize = _sumSize(asks, NEAR_TOUCH_LEVELS);

    return {
      mid: mid != null && Number.isFinite(mid) ? mid : null,
      spread: spread != null && Number.isFinite(spread) ? spread : null,
      depthImbalance:
        depthImbalance != null && Number.isFinite(depthImbalance) ? depthImbalance : null,
      nearTouchNotional: Number.isFinite(nearTouchNotional) ? nearTouchNotional : null,
      nearTouchBidSize: Number.isFinite(nearTouchBidSize) ? nearTouchBidSize : null,
      nearTouchAskSize: Number.isFinite(nearTouchAskSize) ? nearTouchAskSize : null,
      bidDepthNotional: Number.isFinite(bidN) ? bidN : null,
      askDepthNotional: Number.isFinite(askN) ? askN : null,
    };
  }

  function _ensureState(assetId) {
    if (!_marketState[assetId]) {
      _marketState[assetId] = {
        bestBid: null,
        bestAsk: null,
        mid: null,
        spread: null,
        depthImbalance: null,
        nearTouchNotional: null,
        nearTouchBidSize: null,
        nearTouchAskSize: null,
        bidDepthNotional: null,
        askDepthNotional: null,
        bids: [],
        asks: [],
        lastPrice: null,
        lastTradeTs: null,
        lastTradeSize: null,
        lastTradeSide: null,
        tickSize: null,
        market: null,
        updatedAt: 0,
      };
    }
    return _marketState[assetId];
  }

  function _applyMicroToState(st) {
    const micro = _computeMicro(st.bids, st.asks, st.bestBid, st.bestAsk);
    Object.assign(st, micro);
    st.updatedAt = Date.now();
    return st;
  }

  function _emitBook(assetId, st, extra = {}) {
    window.dispatchEvent(new CustomEvent('polymarket:book', {
      detail: {
        assetId,
        bestBid: st.bestBid,
        bestAsk: st.bestAsk,
        mid: st.mid,
        spread: st.spread,
        depthImbalance: st.depthImbalance,
        nearTouchNotional: st.nearTouchNotional,
        nearTouchBidSize: st.nearTouchBidSize,
        nearTouchAskSize: st.nearTouchAskSize,
        bidDepthNotional: st.bidDepthNotional,
        askDepthNotional: st.askDepthNotional,
        bids: st.bids,
        asks: st.asks,
        lastPrice: st.lastPrice,
        timestamp: Date.now(),
        ...extra,
      },
    }));
  }

  // ── CLOB WebSocket (Orderbook & Market Trades) ─────────────────────────────
  function connectClob() {
    if (_clobWs && (_clobWs.readyState === WebSocket.OPEN || _clobWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      _clobWs = new WebSocket(CLOB_WS_URL);

      _clobWs.onopen = () => {
        _log('CLOB WebSocket connected ✓');
        _reconnectAttempts = 0;
        _reportHealth(true, 'CLOB WebSocket connected');
        _startClobHeartbeat();
        resubscribeClob(/* full */ true);
      };

      _clobWs.onmessage = (event) => {
        const raw = event.data;
        if (raw == null) return;
        // Heartbeat reply is plain text PONG (docs).
        if (typeof raw === 'string') {
          const t = raw.trim();
          if (t === 'PONG' || t === 'pong') return;
          if (t === 'PING' || t === 'ping') {
            try { _clobWs.send('PONG'); } catch (_) {}
            return;
          }
        }
        try {
          const data = JSON.parse(typeof raw === 'string' ? raw : String(raw));
          const rows = Array.isArray(data) ? data : [data];
          for (const row of rows) handleClobMessage(row);
        } catch (_) {}
      };

      _clobWs.onerror = (err) => {
        _warn('CLOB WebSocket error:', err?.message || err);
      };

      _clobWs.onclose = () => {
        _stopClobHeartbeat();
        _clobWs = null;
        scheduleReconnect();
      };
    } catch (err) {
      _warn('CLOB WebSocket connection attempt failed:', err?.message || err);
      scheduleReconnect();
    }
  }

  function _startClobHeartbeat() {
    _stopClobHeartbeat();
    // Docs: send text frame PING every 10 seconds.
    _clobHeartbeat = setInterval(() => {
      if (_clobWs && _clobWs.readyState === WebSocket.OPEN) {
        try {
          _clobWs.send('PING');
        } catch (_) {}
      }
    }, CLOB_HEARTBEAT_MS);
  }

  function _stopClobHeartbeat() {
    if (_clobHeartbeat) {
      clearInterval(_clobHeartbeat);
      _clobHeartbeat = null;
    }
  }

  function _handleBookEvent(msg) {
    const assetId = String(msg.asset_id || msg.assetId || msg.token_id || msg.tokenId || '');
    if (!assetId) return;

    const bids = _normalizeLevels(msg.bids, 'bid');
    const asks = _normalizeLevels(msg.asks, 'ask');
    const st = _ensureState(assetId);

    st.bids = bids;
    st.asks = asks;
    st.bestBid = _bestFromLevels(bids, 'bid') ?? _num(msg.best_bid ?? msg.bestBid) ?? st.bestBid;
    st.bestAsk = _bestFromLevels(asks, 'ask') ?? _num(msg.best_ask ?? msg.bestAsk) ?? st.bestAsk;
    if (msg.market) st.market = String(msg.market);
    const ltp = _num(msg.last_trade_price ?? msg.lastTradePrice);
    if (ltp != null) {
      st.lastPrice = ltp;
      st.lastTradeTs = Date.now();
    }
    _applyMicroToState(st);
    _emitBook(assetId, st, { eventType: 'book' });
  }

  function _handlePriceChangeEvent(msg) {
    const changes = Array.isArray(msg.price_changes)
      ? msg.price_changes
      : Array.isArray(msg.priceChanges)
        ? msg.priceChanges
        : null;

    if (changes) {
      for (const change of changes) {
        const assetId = String(change.asset_id || change.assetId || change.token_id || change.tokenId || '');
        if (!assetId) continue;
        const st = _ensureState(assetId);
        const bb = _num(change.best_bid ?? change.bestBid);
        const ba = _num(change.best_ask ?? change.bestAsk);
        if (bb != null) st.bestBid = bb;
        if (ba != null) st.bestAsk = ba;

        // Patch a single level when price/size/side present (delta).
        const levelPrice = _num(change.price);
        const levelSize = _num(change.size);
        const side = String(change.side || '').toUpperCase();
        if (levelPrice != null && levelSize != null && (side === 'BUY' || side === 'SELL' || side === 'BID' || side === 'ASK')) {
          const isBid = side === 'BUY' || side === 'BID';
          const key = isBid ? 'bids' : 'asks';
          let levels = Array.isArray(st[key]) ? st[key].slice() : [];
          const idx = levels.findIndex((l) => Math.abs(l.price - levelPrice) < 1e-12);
          if (levelSize <= 0) {
            if (idx >= 0) levels.splice(idx, 1);
          } else if (idx >= 0) {
            levels[idx] = { price: levelPrice, size: levelSize };
          } else {
            levels.push({ price: levelPrice, size: levelSize });
          }
          st[key] = _normalizeLevels(levels, isBid ? 'bid' : 'ask');
          // Re-derive best from L2 when we have depth; otherwise keep BBO from message.
          if (st.bids.length) st.bestBid = _bestFromLevels(st.bids, 'bid');
          if (st.asks.length) st.bestAsk = _bestFromLevels(st.asks, 'ask');
        }

        if (msg.market) st.market = String(msg.market);
        _applyMicroToState(st);
        _emitBook(assetId, st, { eventType: 'price_change' });

        const px = _num(change.price);
        if (px != null) {
          window.dispatchEvent(new CustomEvent('polymarket:tick', {
            detail: {
              assetId,
              price: px,
              size: levelSize,
              side: change.side || null,
              bestBid: st.bestBid,
              bestAsk: st.bestAsk,
              timestamp: Date.now(),
              eventType: 'price_change',
            },
          }));
        }
      }
      return;
    }

    // Single-asset price_change / bare price payload
    const assetId = String(msg.asset_id || msg.assetId || msg.market || '');
    const price = _num(msg.price || msg.last_trade_price);
    if (!assetId || price == null) return;
    const st = _ensureState(assetId);
    const bb = _num(msg.best_bid ?? msg.bestBid);
    const ba = _num(msg.best_ask ?? msg.bestAsk);
    if (bb != null) st.bestBid = bb;
    if (ba != null) st.bestAsk = ba;
    st.lastPrice = price;
    st.lastTradeTs = Date.now();
    _applyMicroToState(st);
    _emitBook(assetId, st, { eventType: 'price_change' });
    window.dispatchEvent(new CustomEvent('polymarket:tick', {
      detail: {
        assetId,
        price,
        side: msg.side || null,
        bestBid: st.bestBid,
        bestAsk: st.bestAsk,
        timestamp: Date.now(),
        eventType: 'price_change',
      },
    }));
  }

  function _handleBestBidAskEvent(msg) {
    const assetId = String(msg.asset_id || msg.assetId || msg.token_id || msg.tokenId || '');
    if (!assetId) return;
    const st = _ensureState(assetId);
    const bb = _num(msg.best_bid ?? msg.bestBid);
    const ba = _num(msg.best_ask ?? msg.bestAsk);
    if (bb != null) st.bestBid = bb;
    if (ba != null) st.bestAsk = ba;
    const spr = _num(msg.spread);
    if (spr != null) st.spread = spr;
    if (msg.market) st.market = String(msg.market);
    _applyMicroToState(st);
    if (spr != null) st.spread = spr; // prefer server spread when provided
    _emitBook(assetId, st, { eventType: 'best_bid_ask' });
  }

  function _handleLastTradePriceEvent(msg) {
    const assetId = String(msg.asset_id || msg.assetId || msg.token_id || msg.tokenId || '');
    const price = _num(msg.price);
    if (!assetId || price == null) return;
    const st = _ensureState(assetId);
    st.lastPrice = price;
    st.lastTradeTs = Date.now();
    st.lastTradeSize = _num(msg.size);
    st.lastTradeSide = msg.side || null;
    if (msg.market) st.market = String(msg.market);
    st.updatedAt = Date.now();
    window.dispatchEvent(new CustomEvent('polymarket:tick', {
      detail: {
        assetId,
        price,
        size: st.lastTradeSize,
        side: st.lastTradeSide,
        bestBid: st.bestBid,
        bestAsk: st.bestAsk,
        timestamp: Date.now(),
        eventType: 'last_trade_price',
        transactionHash: msg.transaction_hash || msg.transactionHash || null,
      },
    }));
  }

  function _handleTickSizeChange(msg) {
    const assetId = String(msg.asset_id || msg.assetId || msg.token_id || msg.tokenId || '');
    if (!assetId) return;
    const st = _ensureState(assetId);
    st.tickSize = _num(msg.new_tick_size ?? msg.newTickSize) ?? st.tickSize;
    st.updatedAt = Date.now();
  }

  function _handleMarketResolved(msg) {
    const market = msg.market || msg.condition_id || msg.conditionId || null;
    const detail = {
      id: msg.id || null,
      market,
      // conditionId alias — MarketResolver matches pending by slug or conditionId
      conditionId: market,
      slug: msg.slug || msg.event_message?.slug || msg.eventMessage?.slug || null,
      assetIds: msg.assets_ids || msg.asset_ids || msg.tokenIds || msg.token_ids || null,
      // snake_case aliases for Batch 3 resolver (accepts either shape)
      assets_ids: msg.assets_ids || msg.asset_ids || msg.tokenIds || msg.token_ids || null,
      winningAssetId: msg.winning_asset_id || msg.winningAssetId || msg.winning_token_id || null,
      winning_asset_id: msg.winning_asset_id || msg.winningAssetId || msg.winning_token_id || null,
      winningOutcome: msg.winning_outcome || msg.winningOutcome || null,
      winning_outcome: msg.winning_outcome || msg.winningOutcome || null,
      timestamp: Date.now(),
      raw: msg,
    };
    // Batch 3: MarketResolver listens for push settlement / window rollover.
    _log(`market_resolved market=${market || 'n/a'} slug=${detail.slug || 'n/a'} outcome=${detail.winningOutcome || 'n/a'}`);
    window.dispatchEvent(new CustomEvent('polymarket:market_resolved', { detail }));
  }

  function _handleNewMarket(msg) {
    const detail = {
      id: msg.id || null,
      market: msg.market || null,
      slug: msg.slug || null,
      question: msg.question || null,
      assetIds: msg.assets_ids || msg.asset_ids || msg.tokenIds || msg.clobTokenIds || null,
      outcomes: msg.outcomes || null,
      conditionId: msg.condition_id || msg.conditionId || null,
      active: msg.active,
      timestamp: Date.now(),
      raw: msg,
    };
    window.dispatchEvent(new CustomEvent('polymarket:new_market', { detail }));
  }

  function handleClobMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    const eventType = msg.event_type || msg.type || msg.eventType || '';
    if (eventType === 'pong' || eventType === 'PONG') return;

    // Route by known event types first.
    if (eventType === 'book') {
      _handleBookEvent(msg);
      return;
    }
    if (eventType === 'price_change') {
      _handlePriceChangeEvent(msg);
      return;
    }
    if (eventType === 'best_bid_ask') {
      _handleBestBidAskEvent(msg);
      return;
    }
    if (eventType === 'last_trade_price') {
      _handleLastTradePriceEvent(msg);
      return;
    }
    if (eventType === 'tick_size_change') {
      _handleTickSizeChange(msg);
      return;
    }
    if (eventType === 'market_resolved') {
      _handleMarketResolved(msg);
      return;
    }
    if (eventType === 'new_market') {
      _handleNewMarket(msg);
      return;
    }

    // Fallback heuristics for untagged payloads (older wire shapes).
    if (Array.isArray(msg.price_changes) || Array.isArray(msg.priceChanges)) {
      _handlePriceChangeEvent(msg);
      return;
    }
    if (msg.bids || msg.asks) {
      _handleBookEvent(msg);
      return;
    }
    if (msg.best_bid != null || msg.best_ask != null || msg.bestBid != null || msg.bestAsk != null) {
      _handleBestBidAskEvent(msg);
      return;
    }
    if (msg.price != null && (msg.asset_id || msg.assetId)) {
      _handleLastTradePriceEvent(msg);
    }
  }

  function resubscribeClob(full = false) {
    if (!_clobWs || _clobWs.readyState !== WebSocket.OPEN) return;
    if (_activeAssetIds.size === 0) return;
    try {
      const ids = Array.from(_activeAssetIds);
      // Initial / reconnect: type market. custom_feature_enabled unlocks
      // best_bid_ask, new_market, market_resolved (docs).
      const subMsg = full
        ? {
            type: 'market',
            assets_ids: ids,
            custom_feature_enabled: true,
          }
        : {
            assets_ids: ids,
            operation: 'subscribe',
            custom_feature_enabled: true,
          };
      _clobWs.send(JSON.stringify(subMsg));
      _log(`Subscribed to ${ids.length} Polymarket asset tokens (custom_feature_enabled)`);
    } catch (err) {
      _warn('CLOB subscription send error:', err?.message || err);
    }
  }

  function subscribeNewAssets(newIds) {
    if (!_clobWs || _clobWs.readyState !== WebSocket.OPEN) return;
    if (!newIds.length) return;
    try {
      _clobWs.send(JSON.stringify({
        assets_ids: newIds,
        operation: 'subscribe',
        custom_feature_enabled: true,
      }));
      _log(`Incremental subscribe +${newIds.length} assets`);
    } catch (err) {
      _warn('CLOB incremental subscribe error:', err?.message || err);
    }
  }

  function unsubscribeAssets(assetIds) {
    if (!Array.isArray(assetIds) || !assetIds.length) return;
    const toDrop = [];
    for (const id of assetIds) {
      const s = String(id || '').trim();
      if (s && _activeAssetIds.has(s)) {
        _activeAssetIds.delete(s);
        toDrop.push(s);
      }
    }
    if (!toDrop.length) return;
    if (_clobWs && _clobWs.readyState === WebSocket.OPEN) {
      try {
        _clobWs.send(JSON.stringify({
          assets_ids: toDrop,
          operation: 'unsubscribe',
        }));
      } catch (err) {
        _warn('CLOB unsubscribe error:', err?.message || err);
      }
    }
  }

  // ── RTDS WebSocket (Chainlink Price-to-Beat / live crypto prices) ────────
  function connectRtds() {
    if (_rtdsWs && (_rtdsWs.readyState === WebSocket.OPEN || _rtdsWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      _rtdsWs = new WebSocket(RTDS_WS_URL);

      _rtdsWs.onopen = () => {
        _log('Polymarket RTDS Live Data socket connected ✓');
        _startRtdsHeartbeat();
        // Prefer documented subscription envelope; also try legacy topic keys.
        try {
          _rtdsWs.send(JSON.stringify({
            action: 'subscribe',
            subscriptions: [
              { topic: 'crypto_prices', type: 'update' },
              { topic: 'crypto_prices_chainlink', type: '*' },
            ],
          }));
        } catch (_) {}
        // Legacy single-topic frames (older clients / intermediate proxies).
        for (const topic of ['crypto_prices', 'crypto_prices_5m', 'crypto_prices_15m', 'crypto_prices_chainlink']) {
          try {
            _rtdsWs.send(JSON.stringify({ action: 'subscribe', topic }));
          } catch (_) {}
        }
      };

      _rtdsWs.onmessage = (event) => {
        const raw = event.data;
        if (raw == null) return;
        if (typeof raw === 'string') {
          const t = raw.trim();
          if (t === 'PONG' || t === 'pong') return;
          if (t === 'PING' || t === 'ping') {
            try { _rtdsWs.send('PONG'); } catch (_) {}
            return;
          }
        }
        try {
          const data = JSON.parse(typeof raw === 'string' ? raw : String(raw));
          handleRtdsMessage(data);
        } catch (_) {}
      };

      _rtdsWs.onerror = (err) => {
        _warn('RTDS socket error:', err?.message || err);
      };

      _rtdsWs.onclose = () => {
        _stopRtdsHeartbeat();
        _rtdsWs = null;
        setTimeout(connectRtds, 5_000);
      };
    } catch (_) {
      setTimeout(connectRtds, 10_000);
    }
  }

  function _startRtdsHeartbeat() {
    _stopRtdsHeartbeat();
    // Docs: send text frame PING every 5 seconds.
    _rtdsHeartbeat = setInterval(() => {
      if (_rtdsWs && _rtdsWs.readyState === WebSocket.OPEN) {
        try {
          _rtdsWs.send('PING');
        } catch (_) {}
      }
    }, RTDS_HEARTBEAT_MS);
  }

  function _stopRtdsHeartbeat() {
    if (_rtdsHeartbeat) {
      clearInterval(_rtdsHeartbeat);
      _rtdsHeartbeat = null;
    }
  }

  function handleRtdsMessage(msg) {
    if (!msg) return;
    // Envelope: { topic, type, payload } or { topic, data }
    const topic = msg.topic || '';
    const payload = msg.payload || msg.data || msg;
    if (!payload || typeof payload !== 'object') return;

    const symRaw = payload.symbol || payload.coin || payload.sym || '';
    const sym = String(symRaw).toUpperCase().replace(/[^A-Z0-9/]/g, '');
    const price = _num(
      payload.full_accuracy_value ?? payload.value ?? payload.price ?? payload.closePrice
    );
    if (!sym || price == null || price <= 0) return;

    const ts = _num(payload.timestamp) || _num(msg.timestamp) || Date.now();
    _rtdsPrices[sym] = { price, timestamp: ts, topic };
    // Also index bare base (BTCUSDT → BTC, BTC/USD → BTC) for coin lookups.
    const base = sym.split('/')[0].replace(/(USDT|USD|USDC)$/i, '');
    if (base && base !== sym) {
      _rtdsPrices[base] = { price, timestamp: ts, topic };
    }

    window.dispatchEvent(new CustomEvent('polymarket:rtds', {
      detail: { sym, base: base || sym, price, timestamp: ts, topic },
    }));
  }

  function scheduleReconnect() {
    _reconnectAttempts++;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(1.5, _reconnectAttempts - 1));
    _reportHealth(false, `Reconnecting in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(connectClob, delay);
  }

  /**
   * Pair snapshot for Up/Down binary markets (used by PredictionMarkets).
   * Backward-compatible fields: bestBid, bestAsk, upProbability, downBestBid, downBestAsk.
   * Plus L2 micro: mid, spread, depthImbalance, nearTouchNotional, bids, asks.
   */
  function getPairSnapshot(upAssetId, downAssetId, conditionId) {
    const up = (upAssetId && _marketState[upAssetId]) || {};
    const down = (downAssetId && _marketState[downAssetId]) || {};
    const upBid = _num(up.bestBid);
    const upAsk = _num(up.bestAsk);
    const downBid = _num(down.bestBid);
    const downAsk = _num(down.bestAsk);

    let upMid = null;
    if (upBid != null && upAsk != null) upMid = (upBid + upAsk) / 2;
    else if (upBid != null && downAsk != null) upMid = (upBid + (1 - downAsk)) / 2;
    else if (upAsk != null && downBid != null) upMid = (upAsk + (1 - downBid)) / 2;
    else if (upBid != null) upMid = upBid;
    else if (upAsk != null) upMid = upAsk;
    else if (up.lastPrice != null) upMid = _num(up.lastPrice);
    if (upMid != null && (upMid <= 0 || upMid >= 1)) upMid = null;

    const micro = _computeMicro(up.bids || [], up.asks || [], upBid, upAsk);

    return {
      upAssetId: upAssetId || null,
      downAssetId: downAssetId || null,
      conditionId: conditionId || null,
      bestBid: upBid,
      bestAsk: upAsk,
      upProbability: upMid,
      downBestBid: downBid,
      downBestAsk: downAsk,
      mid: micro.mid ?? upMid,
      spread: micro.spread,
      depthImbalance: micro.depthImbalance,
      nearTouchNotional: micro.nearTouchNotional,
      nearTouchBidSize: micro.nearTouchBidSize,
      nearTouchAskSize: micro.nearTouchAskSize,
      bidDepthNotional: micro.bidDepthNotional,
      askDepthNotional: micro.askDepthNotional,
      bids: Array.isArray(up.bids) ? up.bids : [],
      asks: Array.isArray(up.asks) ? up.asks : [],
      downBids: Array.isArray(down.bids) ? down.bids : [],
      downAsks: Array.isArray(down.asks) ? down.asks : [],
      lastPrice: up.lastPrice ?? null,
      lastTradeTs: up.lastTradeTs ?? null,
      ts: Number(up.updatedAt || down.updatedAt || Date.now()) || Date.now(),
      source: 'polymarket-clob-ws',
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  const PolymarketWS = {
    start() {
      connectClob();
      connectRtds();
    },
    /**
     * Subscribe to asset (token) IDs on the shared CLOB market channel.
     * Incremental when socket is already open; full resubscribe on reconnect.
     */
    subscribeAssets(assetIds) {
      if (!Array.isArray(assetIds)) return;
      const fresh = [];
      for (const id of assetIds) {
        const s = String(id || '').trim();
        if (!s) continue;
        if (!_activeAssetIds.has(s)) {
          _activeAssetIds.add(s);
          fresh.push(s);
        }
      }
      if (!fresh.length) return;
      if (_clobWs && _clobWs.readyState === WebSocket.OPEN) {
        subscribeNewAssets(fresh);
      } else {
        connectClob();
      }
    },
    unsubscribeAssets,
    getMarketState(assetId) {
      if (!assetId) return null;
      const st = _marketState[String(assetId)];
      return st ? { ...st, bids: st.bids?.slice?.() || [], asks: st.asks?.slice?.() || [] } : null;
    },
    getPairSnapshot,
    /** Alias used by PredictionMarkets after gutting local _polyClobWS. */
    getSnapshotValue(upAssetId, downAssetId, conditionId) {
      return getPairSnapshot(upAssetId, downAssetId, conditionId);
    },
    getRtdsPrice(sym) {
      return _rtdsPrices[String(sym).toUpperCase()] || null;
    },
    getAllMarketStates() {
      return { ..._marketState };
    },
    getStatus() {
      return {
        clobConnected: _clobWs?.readyState === WebSocket.OPEN,
        rtdsConnected: _rtdsWs?.readyState === WebSocket.OPEN,
        subscribedAssetsCount: _activeAssetIds.size,
        l2DepthCap: L2_DEPTH_CAP,
      };
    },
  };

  window.PolymarketWS = PolymarketWS;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => PolymarketWS.start());
  } else {
    PolymarketWS.start();
  }
})();
