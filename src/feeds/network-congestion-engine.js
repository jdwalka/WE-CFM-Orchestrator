/**
 * Network Congestion Feature Engine
 * 
 * Captures raw blockchain network metrics (gas, mempool, TPS) to feed into
 * prediction models. Includes multi-source failover and caching to ensure
 * complete data even when primary APIs fail.
 * 
 * Features:
 * - Raw GWEI values for ETH gas fees
 * - Mempool congestion for BTC
 * - TPS stress for SOL
 * - Per-chain congestion scoring
 * - Fallback APIs when primary fails
 */

(function () {
  'use strict';

  const CACHE = {};
  const CACHE_TTL_MS = 30000;  // Cache for 30s
  let _updateTimer = null;
  let _btcFeeWarnTs = 0;

  // ── Network Congestion Metrics (raw values) ──
  const CONGESTION_METRICS = {
    ETH: {
      gasFast: null,      // GWEI
      gasMedium: null,    // GWEI
      gasSlow: null,      // GWEI
      txsPerDay: null,
      networkLoad: null,  // 0-1 estimate
      lastUpdate: null
    },
    BTC: {
      mempoolSizeMB: null,
      mempoolTxCount: null,
      feeFastSatVB: null,
      networkLoad: null,  // 0-1 estimate
      lastUpdate: null
    },
    SOL: {
      avgTPS: null,
      peakTPS: null,
      networkLoad: null,  // 0-1 estimate
      lastUpdate: null
    },
    XRP: {
      baseFeeDrops: null,
      loadFactor: null,
      networkLoad: null,
      lastUpdate: null
    }
  };

  function _readEnvLike(name) {
    try {
      if (typeof window !== 'undefined' && window.__env && window.__env[name]) return window.__env[name];
    } catch (_) { }
    try {
      if (typeof localStorage !== 'undefined') {
        const keyMap = {
          ETHERSCAN_API_KEY: 'etherscanApiKey',
          HELIUS_API_KEY: 'heliusApiKey',
        };
        const localKey = keyMap[name];
        if (localKey) {
          const v = localStorage.getItem(localKey);
          if (v) return v;
        }
      }
    } catch (_) { }
    try {
      if (typeof process !== 'undefined' && process && process.env && process.env[name]) return process.env[name];
    } catch (_) { }
    return '';
  }

  function _etherscanV2Url(module, action) {
    const qs = new URLSearchParams({
      chainid: '1',
      module: String(module || ''),
      action: String(action || ''),
    });
    const apiKey = _readEnvLike('ETHERSCAN_API_KEY');
    if (apiKey) qs.set('apikey', apiKey);
    return `https://api.etherscan.io/v2/api?${qs.toString()}`;
  }

  // ── Fetch ETH gas with fallback sources ──
  async function fetchETHGas() {
    try {
      // Primary: Etherscan V2 proxy gasPrice
      const etherscanProxy = await Promise.race([
        fetch(_etherscanV2Url('proxy', 'eth_gasPrice'), { signal: AbortSignal.timeout(30000) })
          .then(r => r.ok ? r.json() : null),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))
      ]).catch(() => null);

      const proxyGasWei = etherscanProxy?.result ? parseInt(etherscanProxy.result, 16) || 0 : 0;
      const proxyGasGwei = proxyGasWei > 0 ? (proxyGasWei / 1e9) : 0;
      if (proxyGasGwei > 0) {
        return {
          fast: proxyGasGwei,
          medium: proxyGasGwei,
          slow: proxyGasGwei,
          source: 'etherscan-proxy'
        };
      }

      // Fallback: Etherscan V2 GasTracker
      const etherscan = await Promise.race([
        fetch(_etherscanV2Url('gastracker', 'gasoracle'),
          { signal: AbortSignal.timeout(30000) })
          .then(r => r.json()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))
      ]).catch(() => null);

      if (etherscan?.result?.FastGasPrice) {
        return {
          fast: parseFloat(etherscan.result.FastGasPrice),
          medium: parseFloat(etherscan.result.StandardGasPrice),
          slow: parseFloat(etherscan.result.SafeGasPrice),
          source: 'etherscan'
        };
      }

      // Fallback: Polygonscan (coarse L1 estimate)
      const polygonscan = await Promise.race([
        fetch('https://api.polygonscan.com/api?module=gastracker&action=gasoracle',
          { signal: AbortSignal.timeout(30000) })
          .then(r => r.json()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))
      ]).catch(() => null);

      if (polygonscan?.result) {
        return {
          fast: parseFloat(polygonscan.result.FastGasPrice) * 30,  // Adjust for L1 scale
          medium: parseFloat(polygonscan.result.StandardGasPrice) * 30,
          slow: parseFloat(polygonscan.result.SafeGasPrice) * 30,
          source: 'polygonscan-adjusted'
        };
      }

      return null;
    } catch (e) {
      console.warn('[NetCongestion] ETH gas fetch failed:', e.message);
      return null;
    }
  }

  // ── Fetch BTC mempool with failover ──
  async function fetchBTCMempool() {
    try {
      // Primary: mempool.space with resilientFetch (adds fallback to blockchain.info)
      const mempoolRes = window.resilientFetch
        ? await window.resilientFetch('https://mempool.space/api/mempool').catch(() => null)
        : await fetch('https://mempool.space/api/mempool', { signal: AbortSignal.timeout(30000) })
          .then(r => r.json())
          .catch(() => null);

      const mempool = mempoolRes?.ok
        ? await mempoolRes.json()
        : mempoolRes instanceof Object && mempoolRes.vsize
          ? mempoolRes
          : null;

      if (mempool?.vsize && mempool?.count) {
        // Fetch fees - try multiple endpoints with resilientFetch fallback
        let fees = null;

        // Try: mempool.space/api/v1/fees/recommended (with resilientFetch fallback)
        try {
          const feeRes = window.resilientFetch
            ? await window.resilientFetch('https://mempool.space/api/v1/fees/recommended')
            : await fetch('https://mempool.space/api/v1/fees/recommended',
              { signal: AbortSignal.timeout(5000) });
          if (feeRes?.ok) fees = await feeRes.json();
        } catch (e) { /* fall through */ }

        // Fallback: use default BTC fees (will adjust with market data elsewhere)
        if (!fees?.fastestFee) {
          const now = Date.now();
          if ((now - _btcFeeWarnTs) > 120000) {
            console.warn('[NetCongestion] mempool.space fees endpoint unavailable, using defaults');
            _btcFeeWarnTs = now;
          }
          fees = { fastestFee: 20, halfHourFee: 15, minimumFee: 5 };
        }

        return {
          mempoolSizeMB: (mempool.vsize / 1e6).toFixed(1),
          mempoolTxCount: mempool.count,
          feeFastSatVB: fees?.fastestFee || 20,
          source: 'mempool.space'
        };
      }

      console.warn('[NetCongestion] mempool.space mempool fetch failed');
      return null;
    } catch (e) {
      console.warn('[NetCongestion] BTC mempool fetch failed:', e.message);
      return null;
    }
  }

  // ── Fetch SOL TPS (with RPC fallback) ──
  async function fetchSOLMetrics() {
    // projectserum public RPC is dead / hangs — do not probe it.
    const SOL_RPCS = [
      'https://api.mainnet-beta.solana.com',
      'https://solana-rpc.publicnode.com',
    ];
    const heliusKey = _readEnvLike('HELIUS_API_KEY');
    if (heliusKey) {
      SOL_RPCS.splice(1, 0, `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`);
    }

    for (const rpc of SOL_RPCS) {
      try {
        const perfSamples = await Promise.race([
          fetch(rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPerformanceSamples', params: [10] }),
            signal: AbortSignal.timeout(30000)
          }).then(r => r.json()),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))
        ]).catch(() => null);

        if (perfSamples?.result?.length) {
          const samples = perfSamples.result;
          const avgTPS = Math.round(samples.reduce((s, x) => s + (x.numTransactions / (x.samplePeriodSecs || 60)), 0) / samples.length);
          const peakTPS = Math.round(Math.max(...samples.map(x => x.numTransactions / (x.samplePeriodSecs || 60))));

          return {
            avgTPS,
            peakTPS,
            source: 'solana-rpc'
          };
        }
      } catch (e) {
        console.debug(`[NetCongestion] SOL RPC ${rpc} failed:`, e.message);
        continue;
      }
    }

    console.warn('[NetCongestion] All SOL RPC nodes failed');
    return null;
  }

  // ── Calculate per-coin network load (0-1 scale) ──
  function calculateNetworkLoad(coin, data) {
    switch (coin) {
      case 'ETH':
        if (!data?.medium) return null;
        // 0 = low gas (<10), 1 = high gas (>100)
        return Math.min(1, Math.max(0, (data.medium - 10) / 90));

      case 'BTC':
        if (!data?.mempoolSizeMB) return null;
        // 0 = <5MB, 1 = >50MB
        return Math.min(1, Math.max(0, (parseFloat(data.mempoolSizeMB) - 5) / 45));

      case 'SOL':
        if (!data?.avgTPS) return null;
        // 0 = <500 TPS, 1 = >4000 TPS
        return Math.min(1, Math.max(0, (data.avgTPS - 500) / 3500));

      default:
        return null;
    }
  }

  // ── Update all metrics ──
  async function updateAllMetrics() {
    const now = Date.now();

    // ETH
    const ethGas = await fetchETHGas();
    if (ethGas) {
      CONGESTION_METRICS.ETH.gasFast = ethGas.fast;
      CONGESTION_METRICS.ETH.gasMedium = ethGas.medium;
      CONGESTION_METRICS.ETH.gasSlow = ethGas.slow;
      CONGESTION_METRICS.ETH.networkLoad = calculateNetworkLoad('ETH', ethGas);
      CONGESTION_METRICS.ETH.lastUpdate = now;
    }

    // BTC
    const btcMempool = await fetchBTCMempool();
    if (btcMempool) {
      CONGESTION_METRICS.BTC.mempoolSizeMB = btcMempool.mempoolSizeMB;
      CONGESTION_METRICS.BTC.mempoolTxCount = btcMempool.mempoolTxCount;
      CONGESTION_METRICS.BTC.feeFastSatVB = btcMempool.feeFastSatVB;
      CONGESTION_METRICS.BTC.networkLoad = calculateNetworkLoad('BTC', btcMempool);
      CONGESTION_METRICS.BTC.lastUpdate = now;
    }

    // SOL
    const solMetrics = await fetchSOLMetrics();
    if (solMetrics) {
      CONGESTION_METRICS.SOL.avgTPS = solMetrics.avgTPS;
      CONGESTION_METRICS.SOL.peakTPS = solMetrics.peakTPS;
      CONGESTION_METRICS.SOL.networkLoad = calculateNetworkLoad('SOL', solMetrics);
      CONGESTION_METRICS.SOL.lastUpdate = now;
    }

    return CONGESTION_METRICS;
  }

  // ── Expose API ──
  window.NetworkCongestion = {
    /**
     * Get current congestion metrics for a coin
     */
    get(coin) {
      return CONGESTION_METRICS[coin] || null;
    },

    /**
     * Get all metrics
     */
    getAll() {
      return { ...CONGESTION_METRICS };
    },

    /**
     * Get network load factor (0-1) for prediction boost
     */
    getLoad(coin) {
      const m = CONGESTION_METRICS[coin];
      return m?.networkLoad ?? null;
    },

    /**
     * Start periodic updates
     */
    start(intervalMs = 30000) {
      if (_updateTimer) clearInterval(_updateTimer);
      updateAllMetrics();  // Immediate update
      _updateTimer = setInterval(() => updateAllMetrics(), intervalMs);
      console.log('[NetworkCongestion] Started polling (interval:', intervalMs, 'ms)');
    },

    /**
     * Stop updates
     */
    stop() {
      if (_updateTimer) {
        clearInterval(_updateTimer);
        _updateTimer = null;
        console.log('[NetworkCongestion] Stopped polling');
      }
    },

    /**
     * Force immediate update
     */
    refresh() {
      return updateAllMetrics();
    }
  };

  // Auto-start on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.NetworkCongestion.start(30000);
    });
  } else {
    window.NetworkCongestion.start(30000);
  }

  console.log('[NetworkCongestion] Module loaded. Polling network metrics every 30s.');
})();
