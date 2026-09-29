// ================================================================
// dex-activity-monitor.js — Real-time DEX swap & liquidity tracking
// ================================================================
// Monitors DEX activity (swaps, pools, volume) on ETH/BNB using Transpose
// Exposes: window.DexActivityMonitor
//   .getSwaps(chain, opts)         → Promise<{ swaps, volume, topPairs }>
//   .getLiquidityChanges(chain)    → Promise<{ changes, pools }>
//   .startMonitoring(chains, cb)   → void
//   .stopMonitoring()              → void
//   .stats()                        → { volume, swaps, pools }
// ================================================================

(function () {
  'use strict';

  const TRANSPOSE_BASE = 'https://api.transpose.io/sql';
  const TRANSPOSE_KEY = localStorage.getItem('transposeApiKey') || 
                        window._env?.TRANSPOSE_KEY ||
                        '';

  const CHAIN_MAP = {
    ETH: 'ethereum',
    BNB: 'bsc',
  };

  // ── In-memory cache ──────────────────────────────────────────
  const _dexCache = new Map(); // chain → { swaps[], pools[], timestamp }
  const _volumeStats = new Map(); // chain → { 24h, 1h, 5m }

  // ── Health ───────────────────────────────────────────────────
  const _health = {
    transpose: { fails: 0, lastFail: 0, lastSuccess: 0 },
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

  // ── Fetching DEX swaps ────────────────────────────────────────

  async function _fetchSwaps(chain) {
    if (!TRANSPOSE_KEY) {
      console.warn('[DexMonitor] No Transpose API key; using fallback');
      return [];
    }

    const chainId = CHAIN_MAP[chain];
    if (!chainId) return [];

    try {
      const sql = `
        SELECT 
          tx_hash as hash,
          block_timestamp as timestamp,
          token_in_symbol as from_token,
          token_out_symbol as to_token,
          amount_in as amount_from,
          amount_out as amount_to,
          amount_out_usd as value_usd,
          dex_name as dex,
          sender as user
        FROM ${chainId}.swaps
        WHERE block_timestamp >= now() - interval 1 hour
        ORDER BY block_timestamp DESC
        LIMIT 100
      `;

      const res = await fetch(`${TRANSPOSE_BASE}?api_key=${TRANSPOSE_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        _markFail('transpose');
        return [];
      }

      const data = await res.json();
      _markOk('transpose');

      const swaps = (data.results || []).map(s => ({
        hash: s.hash,
        timestamp: s.timestamp,
        from_token: s.from_token,
        to_token: s.to_token,
        amount_from: parseFloat(s.amount_from) || 0,
        amount_to: parseFloat(s.amount_to) || 0,
        value_usd: parseFloat(s.value_usd) || 0,
        dex: s.dex,
        user: s.user,
        chain,
      }));

      // Track volume
      const volume24h = swaps.reduce((sum, s) => sum + s.value_usd, 0);
      _volumeStats.set(chain, {
        volume24h,
        swapCount: swaps.length,
        avgSize: volume24h / (swaps.length || 1),
      });

      _dexCache.set(chain, { swaps, timestamp: Date.now() });
      return swaps;

    } catch (err) {
      _markFail('transpose');
      console.error(`[DexMonitor] ${chain} fetch failed:`, err.message);
      return _dexCache.get(chain)?.swaps || [];
    }
  }

  // ── Fetching liquidity changes ───────────────────────────────

  async function _fetchLiquidityChanges(chain) {
    if (!TRANSPOSE_KEY) return [];

    const chainId = CHAIN_MAP[chain];
    if (!chainId) return [];

    try {
      const sql = `
        SELECT 
          pool_address,
          token0_symbol,
          token1_symbol,
          reserve0,
          reserve1,
          block_timestamp as timestamp,
          event_type
        FROM ${chainId}.uniswap_v3_pools
        WHERE block_timestamp >= now() - interval 1 hour
        ORDER BY block_timestamp DESC
        LIMIT 50
      `;

      const res = await fetch(`${TRANSPOSE_BASE}?api_key=${TRANSPOSE_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) return [];

      const data = await res.json();
      return (data.results || []).map(p => ({
        pool: p.pool_address,
        token0: p.token0_symbol,
        token1: p.token1_symbol,
        reserve0: parseFloat(p.reserve0) || 0,
        reserve1: parseFloat(p.reserve1) || 0,
        timestamp: p.timestamp,
        event: p.event_type,
        chain,
      }));

    } catch (err) {
      console.error(`[DexMonitor] Liquidity fetch failed:`, err.message);
      return [];
    }
  }

  // ── Monitoring loop ──────────────────────────────────────────

  let _monitorInterval = null;
  const _monitored = new Set();

  async function _monitorCycle(chains, callback) {
    const allSwaps = [];

    for (const chain of chains) {
      const swaps = await _fetchSwaps(chain);
      allSwaps.push(...swaps);
    }

    if (allSwaps.length > 0) {
      allSwaps.sort((a, b) => b.value_usd - a.value_usd);
      callback?.({
        swaps: allSwaps,
        count: allSwaps.length,
        volume: allSwaps.reduce((s, sw) => s + sw.value_usd, 0),
        topSwaps: allSwaps.slice(0, 10),
      });
    }
  }

  // ── Public API ────────────────────────────────────────────────

  const DexActivityMonitor = {

    /**
     * Get recent swaps for a chain.
     * Returns Promise<{ swaps, volume, topPairs, count }>
     */
    async getSwaps(chain, opts = {}) {
      let swaps = _dexCache.get(chain)?.swaps || [];

      if (!swaps.length || !opts.cached) {
        swaps = await _fetchSwaps(chain);
      }

      const topPairs = {};
      swaps.forEach(s => {
        const pair = `${s.from_token}/${s.to_token}`;
        if (!topPairs[pair]) topPairs[pair] = { count: 0, volume: 0 };
        topPairs[pair].count++;
        topPairs[pair].volume += s.value_usd;
      });

      return {
        swaps: swaps.slice(0, opts.limit || 50),
        count: swaps.length,
        volume: swaps.reduce((s, sw) => s + sw.value_usd, 0),
        topPairs: Object.entries(topPairs)
          .map(([pair, stats]) => ({ pair, ...stats }))
          .sort((a, b) => b.volume - a.volume)
          .slice(0, 10),
        timestamp: Date.now(),
      };
    },

    /**
     * Get recent liquidity pool changes.
     */
    async getLiquidityChanges(chain) {
      const changes = await _fetchLiquidityChanges(chain);
      return {
        changes: changes.slice(0, 20),
        count: changes.length,
        chain,
        timestamp: Date.now(),
      };
    },

    /**
     * Get synchronous capital flow score (-1.0 to 1.0) based on cached swaps.
     * Checks stablecoin rotation (USDT/USDC/DAI/BUSD).
     */
    getDexFlowScore(chain) {
      const swaps = _dexCache.get(chain)?.swaps || [];
      if (swaps.length === 0) return 0;

      const stables = ['USDT', 'USDC', 'DAI', 'BUSD', 'FDUSD'];
      let stableIn = 0; // selling crypto for stables (distribution)
      let stableOut = 0; // buying crypto with stables (accumulation)

      for (const s of swaps) {
        const fromStable = stables.includes(s.from_token?.toUpperCase());
        const toStable = stables.includes(s.to_token?.toUpperCase());
        if (fromStable && !toStable) stableOut += s.value_usd;
        else if (toStable && !fromStable) stableIn += s.value_usd;
      }

      const totalFlow = stableIn + stableOut;
      return totalFlow > 0 ? (stableOut - stableIn) / totalFlow : 0;
    },

    /**
     * Start monitoring DEX activity.
     */
    startMonitoring(chains = ['ETH', 'BNB'], callback) {
      if (_monitorInterval) return;

      chains.forEach(c => _monitored.add(c));
      _monitorCycle(chains, callback);

      _monitorInterval = setInterval(() => {
        _monitorCycle(chains, callback);
      }, 20000); // 20s polling

      console.log(`[DexMonitor] Monitoring started: ${chains.join(', ')}`);
    },

    /**
     * Stop monitoring.
     */
    stopMonitoring() {
      if (_monitorInterval) {
        clearInterval(_monitorInterval);
        _monitorInterval = null;
        _monitored.clear();
      }
    },

    /**
     * Get stats.
     */
    stats() {
      const volume = {};
      for (const [chain, stats] of _volumeStats) {
        volume[chain] = stats;
      }
      return {
        monitored: Array.from(_monitored),
        volume,
        cacheSize: _dexCache.size,
        health: _health.transpose,
      };
    },

    /**
     * Flush caches.
     */
    flush() {
      _dexCache.clear();
      _volumeStats.clear();
      this.stopMonitoring();
    },
  };

  window.DexActivityMonitor = DexActivityMonitor;

})();
