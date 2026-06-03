// ================================================================
// whale-alert-monitor.js — Real-time whale transaction tracking
// ================================================================
// Monitors large transactions across BTC, ETH, BNB using Whale Alert API
// Exposes: window.WhaleAlertMonitor
//   .getWhaleTransactions(chain, opts) → Promise<{ txs, count, largest }>
//   .startMonitoring(chains, callback)  → void
//   .stopMonitoring()                   → void
//   .stats()                            → { monitored, alerts, sources }
// ================================================================

(function () {
  'use strict';

  const WHALE_ALERT_BASE = 'https://api.whale-alert.io/v1';
  
  // Try to get API key from localStorage/env, fallback to limited free endpoint
  const API_KEY = localStorage.getItem('whaleAlertApiKey') || 
                  window._env?.WHALE_ALERT_KEY || 
                  '';

  const CHAIN_MAP = {
    BTC: 'bitcoin',
    ETH: 'ethereum',
    BNB: 'binance',
  };

  const THRESHOLDS = {
    BTC: 5000000,     // $5M USD minimum
    ETH: 2000000,     // $2M USD minimum
    BNB: 1000000,     // $1M USD minimum
  };

  // ── In-memory tracking ────────────────────────────────────────
  const _monitored = new Map(); // chain → { active, startTime, count }
  const _whaleCache = new Map(); // chain → { txs[], timestamp }
  const _listeners = [];

  // ── Rate limiting ────────────────────────────────────────────
  const _rateLimits = {
    lastFetch: {},    // chain → timestamp
    minInterval: 20000, // 10s minimum between requests per chain
  };

  // ── Health tracking ──────────────────────────────────────────
  const _health = {
    whaleAlert: { fails: 0, lastFail: 0, lastSuccess: 0 },
  };

  function _markFail(src) {
    if (_health[src]) {
      _health[src].fails++;
      _health[src].lastFail = Date.now();
    }
  }

  function _markOk(src) {
    if (_health[src]) {
      _health[src].fails = 0;
      _health[src].lastFail = 0;
      _health[src].lastSuccess = Date.now();
    }
  }

  // ── Fetching ──────────────────────────────────────────────────

  async function _fetchWhaleTransactions(chain) {
    const whaleChain = CHAIN_MAP[chain];
    if (!whaleChain) return null;

    const threshold = THRESHOLDS[chain];

    try {
      // Rate limit check
      const lastFetch = _rateLimits.lastFetch[chain] || 0;
      if (Date.now() - lastFetch < _rateLimits.minInterval) {
        return _whaleCache.get(chain)?.txs || [];
      }

      const url = new URL(`${WHALE_ALERT_BASE}/transactions`);
      url.searchParams.set('blockchain', whaleChain);
      url.searchParams.set('min_value', threshold);
      url.searchParams.set('limit', 50);
      if (API_KEY) url.searchParams.set('api_key', API_KEY);

      const ctrl = new AbortController();
      const tid = setTimeout(() => {
        try {
          ctrl.abort(new DOMException('Whale Alert fetch timed out after 30000ms', 'TimeoutError'));
        } catch (_) {
          try { ctrl.abort(); } catch (_) { }
        }
      }, 30000);

      const res = await fetch(url.toString(), { signal: ctrl.signal });
      clearTimeout(tid);

      if (!res.ok) {
        _markFail('whaleAlert');
        return [];
      }

      const data = await res.json();
      _rateLimits.lastFetch[chain] = Date.now();
      _markOk('whaleAlert');

      // Normalize response
      const txs = (data.result || []).map(tx => ({
        hash: tx.hash,
        timestamp: tx.timestamp,
        amount: tx.amount,
        amount_usd: tx.amount_usd,
        from: tx.from?.address,
        to: tx.to?.address,
        from_label: tx.from?.owner_type,
        to_label: tx.to?.owner_type,
        chain,
        score: tx.amount_usd || 0,
        direction: tx.to?.owner_type === 'exchange' ? 'sell' : 
                   tx.from?.owner_type === 'exchange' ? 'buy' : 'transfer',
      }));

      _whaleCache.set(chain, { txs, timestamp: Date.now() });
      return txs;

    } catch (err) {
      _markFail('whaleAlert');
      console.error(`[WhaleAlert] ${chain} fetch failed:`, err.message);
      return _whaleCache.get(chain)?.txs || [];
    }
  }

  // ── Monitoring ────────────────────────────────────────────────

  async function _monitorCycle(chains, callback) {
    const allTxs = [];

    for (const chain of chains) {
      const txs = await _fetchWhaleTransactions(chain);
      if (txs.length > 0) {
        allTxs.push(...txs);
        const mon = _monitored.get(chain);
        if (mon) mon.count += txs.length;
      }
    }

    if (allTxs.length > 0) {
      allTxs.sort((a, b) => b.score - a.score);
      callback?.({ txs: allTxs, count: allTxs.length, largest: allTxs[0] });
    }
  }

  let _monitorInterval = null;

  // ── Public API ────────────────────────────────────────────────

  const WhaleAlertMonitor = {

    /**
     * Fetch whale transactions for a single chain.
     * Returns Promise<{ txs, count, largest }>
     */
    async getWhaleTransactions(chain, opts = {}) {
      const txs = await _fetchWhaleTransactions(chain);
      return {
        txs: txs.slice(0, opts.limit || 20),
        count: txs.length,
        largest: txs[0] || null,
        chain,
        timestamp: Date.now(),
      };
    },

    /**
     * Get synchronous accumulation score (-1.0 to 1.0) based on cached transactions.
     * buy = outflow from exchange (accumulation)
     * sell = inflow to exchange (distribution)
     */
    getAccumulationScore(chain) {
      const txs = _whaleCache.get(chain)?.txs || [];
      if (txs.length === 0) return 0;
      
      let buyVol = 0;
      let sellVol = 0;
      
      for (const tx of txs) {
        if (tx.direction === 'buy') buyVol += tx.score;
        else if (tx.direction === 'sell') sellVol += tx.score;
      }
      
      const total = buyVol + sellVol;
      return total > 0 ? (buyVol - sellVol) / total : 0;
    },

    /**
     * Start monitoring multiple chains for whale activity.
     * Calls callback every 20s with latest whales.
     */
    startMonitoring(chains = ['BTC', 'ETH', 'BNB'], callback) {
      if (_monitorInterval) return; // Already running

      chains.forEach(c => {
        _monitored.set(c, { active: true, startTime: Date.now(), count: 0 });
      });

      _monitorCycle(chains, callback); // Initial fetch

      _monitorInterval = setInterval(() => {
        _monitorCycle(chains, callback);
      }, 20000); // 20s polling

      console.log(`[WhaleAlert] Monitoring started: ${chains.join(', ')}`);
    },

    /**
     * Stop all monitoring.
     */
    stopMonitoring() {
      if (_monitorInterval) {
        clearInterval(_monitorInterval);
        _monitorInterval = null;
        _monitored.clear();
        console.log('[WhaleAlert] Monitoring stopped');
      }
    },

    /**
     * Get current stats.
     */
    stats() {
      const monitored = {};
      for (const [chain, info] of _monitored) {
        monitored[chain] = {
          ...info,
          uptime: Date.now() - info.startTime,
        };
      }
      return {
        monitored,
        cacheSize: _whaleCache.size,
        health: _health.whaleAlert,
      };
    },

    /**
     * Clear caches.
     */
    flush() {
      _whaleCache.clear();
      _monitored.clear();
      this.stopMonitoring();
    },
  };

  // ── Expose globally ──────────────────────────────────────────
  window.WhaleAlertMonitor = WhaleAlertMonitor;

})();
