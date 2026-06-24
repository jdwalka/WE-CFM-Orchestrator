/*
 * ContractQueueManager
 *
 * Lightweight manager that handles overlapping/early-appearing contracts.
 * - Records orders locally (ContractCacheManager) immediately
 * - Marks orders "tentative" when they target a contract that appears early
 * - Processes orders according to configured behavior (process_both, hold_then_confirm)
 * - Reconciles tentative orders after lifecycle events
 *
 * Config (env or constructor):
 *  - CONTRACT_QUEUE_EARLY_SECS (default 90)
 *  - CONTRACT_QUEUE_WAIT_SECS (default 20)
 *  - CONTRACT_QUEUE_BEHAVIOR (process_both | hold_then_confirm) (default process_both)
 *  - DOCKER_RECONCILE_URL (optional) - POSTs finalization payload to this endpoint
 */

'use strict';

const path = require('path');
let ContractCacheManager = null;
try {
  ContractCacheManager = require('./contract-cache-manager');
} catch (e) {
  ContractCacheManager = null;
}

const DEFAULT_EARLY_SECS = Number(process.env.CONTRACT_QUEUE_EARLY_SECS || 90);
const DEFAULT_WAIT_SECS = Number(process.env.CONTRACT_QUEUE_WAIT_SECS || 20);
const DEFAULT_BEHAVIOR = process.env.CONTRACT_QUEUE_BEHAVIOR || 'process_both';

class ContractQueueManager {
  constructor(config = {}) {
    this.earlyArrivalMs = (Number(config.earlyArrivalSeconds) || DEFAULT_EARLY_SECS) * 1000;
    this.allowedWaitMs = (Number(config.allowedWaitSeconds) || DEFAULT_WAIT_SECS) * 1000;
    this.behavior = config.behavior || DEFAULT_BEHAVIOR; // 'process_both' or 'hold_then_confirm'
    this.persistencePreference = config.persistencePreference || 'local-first';

    // market ticker -> { market_id, start_ts, expiry_ts, status, seenAt }
    this.contracts = new Map();

    // tentative order records pending finalization: { metadata, orderRequest, createdAt }
    this.tentativeOrders = [];

    // local cache (try to reuse global if present)
    try {
      if (typeof window !== 'undefined' && window._contractCache) {
        this.cache = window._contractCache;
      } else if (ContractCacheManager) {
        // instantiate a local cache (Node fallback)
        try { this.cache = new ContractCacheManager(); } catch (e) { this.cache = null; }
      } else {
        this.cache = null;
      }
    } catch (e) {
      this.cache = null;
    }

    // Expose globally for other modules
    try {
      if (typeof window !== 'undefined') window._contractQueue = this;
      if (typeof global !== 'undefined' && !global._contractQueue) global._contractQueue = this;
    } catch (_) {}

    // Listen for lifecycle events if in a browser/electron window
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      try {
        window.addEventListener('kalshi:market_lifecycle', (e) => {
          try { this.registerLifecycleEvent(e.detail || {}); } catch (_) {}
        });
      } catch (_) {}
    }
  }

  registerLifecycleEvent(evt = {}) {
    const ticker = evt.market_ticker || evt.marketTicker || evt.ticker;
    if (!ticker) return;

    const start_ts = Number(evt.start_ts || evt.start || evt.start_ts || 0) || null;
    const expiry_ts = Number(evt.expiry_ts || evt.expiry || evt.end_ts || 0) || null;
    const status = evt.type || evt.status || evt.event || null;

    const info = {
      market_id: evt.market_id || evt.marketId || evt.market || null,
      start_ts,
      expiry_ts,
      status,
      seenAt: Date.now()
    };

    this.contracts.set(ticker, info);

    // if market closed/settled, finalize tentative orders for this ticker
    if (status && /close|settle|settled|finalize/i.test(String(status))) {
      try { this._finalizeOrdersForTicker(ticker); } catch (_) {}
    }
  }

  _findPotentialOverlap(ticker) {
    const target = this.contracts.get(ticker);
    if (!target || !target.start_ts) return false;

    for (const [otherTicker, info] of this.contracts.entries()) {
      if (otherTicker === ticker) continue;
      if (!info.expiry_ts) continue;
      const delta = info.expiry_ts - target.start_ts; // positive if other expires after this starts
      if (delta > 0 && delta <= this.earlyArrivalMs) return true;
    }
    return false;
  }

  async handleOrder(orderRequest, restClient) {
    const ticker = orderRequest.market_ticker || orderRequest.market_id || 'unknown';
    const now = Date.now();

    // Determine tentativeness by checking for potential overlap
    const isTentative = this._findPotentialOverlap(ticker);

    const metadata = {
      market_ticker: ticker,
      market_id: orderRequest.market_id || null,
      side: orderRequest.side || null,
      qty: orderRequest.quantity || orderRequest.qty || 0,
      yes_price: orderRequest.yes_price,
      timestamp: now,
      tentative: !!isTentative
    };

    // Local write (prevalent)
    try {
      if (this.cache && typeof this.cache.recordOrder === 'function') {
        try {
          this.cache.recordOrder(metadata.market_ticker, metadata.side, metadata.qty, metadata.yes_price);
        } catch (e) {
          // best-effort
          console.warn('[ContractQueue] cache.recordOrder failed:', e?.message || e);
        }
      }
    } catch (e) { /* swallow */ }

    if (isTentative) {
      this.tentativeOrders.push({ metadata, orderRequest, createdAt: now });
    }

    // Choose action based on behavior
    if (this.behavior === 'process_both' || !isTentative) {
      // send immediately
      try {
        const response = await restClient.ordersApi.createOrder(orderRequest);
        const out = {
          success: true,
          data: response?.data || null,
          orderId: response?.data?.order_id || null,
          timestamp: Date.now()
        };
        return out;
      } catch (err) {
        return {
          success: false,
          error: err?.message || String(err),
          code: err?.response?.status || 'UNKNOWN',
          timestamp: Date.now()
        };
      }
    }

    // hold_then_confirm behavior: wait a short window then send
    await new Promise(resolve => setTimeout(resolve, Math.max(0, this.allowedWaitMs)));

    try {
      const response = await restClient.ordersApi.createOrder(orderRequest);
      return {
        success: true,
        data: response?.data || null,
        orderId: response?.data?.order_id || null,
        timestamp: Date.now()
      };
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        code: err?.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  async _finalizeOrdersForTicker(ticker) {
    const toFinalize = this.tentativeOrders.filter(o => o.metadata.market_ticker === ticker);
    for (const entry of toFinalize) {
      try {
        // mark settlement or confirmation in local cache (best-effort)
        if (this.cache && typeof this.cache.recordSettlement === 'function') {
          try { this.cache.recordSettlement(entry.metadata.market_ticker, 'finalized', false, true); } catch (_) {}
        }
      } catch (_) {}

      // Reconcile externally if configured
      try { await this._reconcileOrder(entry); } catch (_) {}
    }

    // remove finalized entries
    this.tentativeOrders = this.tentativeOrders.filter(o => o.metadata.market_ticker !== ticker);
  }

  async _reconcileOrder(entry) {
    const url = process.env.DOCKER_RECONCILE_URL;
    if (!url) return;

    // choose a fetch implementation
    let fetchFn = (typeof fetch === 'function') ? fetch : null;
    if (!fetchFn) {
      try { fetchFn = require('node-fetch'); } catch (e) { fetchFn = null; }
    }

    const payload = {
      type: 'finalize-order',
      metadata: entry.metadata,
      createdAt: entry.createdAt
    };

    if (!fetchFn) {
      console.warn('[ContractQueue] reconcile skipped: no fetch available for', entry.metadata.market_ticker);
      return;
    }

    try {
      await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.warn('[ContractQueue] reconcile POST failed:', e?.message || e);
    }
  }
}

module.exports = new ContractQueueManager();
