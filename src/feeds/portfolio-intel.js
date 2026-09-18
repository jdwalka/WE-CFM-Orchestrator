// ================================================================
// portfolio-intel.js — Multi-chain wallet portfolio aggregation
// ================================================================
// Aggregates balance, transaction, DEX, and whale data across chains
// Exposes: window.PortfolioIntel
//   .analyze(wallets[], opts)       → Promise<{ portfolio, risks, alerts }>
//   .getWalletActivity(addr, chain) → Promise<{ txs, swaps, whales }>
//   .trackWallet(addr, callback)    → void
//   .untrackWallet(addr)            → void
// ================================================================

(function () {
  'use strict';

  // Chain slug + whether a devnet variant exists — endpoints are resolved
  // on demand via _alchemyEndpoint() so a key set after page load (e.g. via
  // wallet-intel-config.js) takes effect immediately, and so there is no
  // module-level fallback key baked into a constant at import time.
  const CHAINS = {
    BTC: { name: 'bitcoin' },
    ETH: { name: 'ethereum', hasDevnet: true },
    SOL: { name: 'solana', hasDevnet: true },
    BNB: { name: 'bsc' },
    BASE: { name: 'base', hasDevnet: true },
    HYPE: { name: 'hyperliquid' },
  };

  // Exact subdomain prefix per chain+variant — stored whole (not derived by
  // appending "-mainnet") because the devnet/testnet prefixes don't follow
  // that suffix pattern (e.g. eth-sepolia, solana-devnet, not
  // eth-sepolia-mainnet).
  const ALCHEMY_HOST_PREFIX = {
    BTC: 'bitcoin-mainnet',
    ETH: 'eth-mainnet', ETH_DEVNET: 'eth-sepolia',
    SOL: 'solana-mainnet', SOL_DEVNET: 'solana-devnet',
    BNB: 'bnb-mainnet',
    BASE: 'base-mainnet', BASE_DEVNET: 'base-sepolia',
    HYPE: 'hyperliquid-mainnet',
  };

  async function _alchemyEndpoint(chain, useDevnet) {
    const key = await window.AlchemyKey.get();
    if (!key) return null;
    const prefix = useDevnet ? ALCHEMY_HOST_PREFIX[`${chain}_DEVNET`] : ALCHEMY_HOST_PREFIX[chain];
    if (!prefix) return null;
    return `https://${prefix}.g.alchemy.com/v2/${key}`;
  }

  // ── In-memory tracking ────────────────────────────────────────
  const _trackedWallets = new Map(); // addr → { chains, callback, data }
  const _portfolioCache = new Map(); // addr → { balances, positions, timestamp }
  const _watchList = new Set();

  // ── Health ───────────────────────────────────────────────────
  const _health = {
    alchemy: { fails: 0, lastFail: 0, lastSuccess: 0 },
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

  // ── Fetch wallet portfolio via Alchemy ──────────────────────

  async function _fetchPortfolioAlchemy(addr, chain, useDevnet = false) {
    const chainConfig = CHAINS[chain];
    if (!chainConfig) return null;

    const endpoint = await _alchemyEndpoint(chain, useDevnet && chainConfig.hasDevnet);
    if (!endpoint) return null;

    try {
      const isSol = chain === 'SOL';

      // 1. Get Balances
      const balPayload = isSol ? {
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [addr]
      } : {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getTokenBalances',
        params: [addr]
      };

      const balRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(balPayload),
        signal: AbortSignal.timeout(30000),
      });

      if (!balRes.ok) {
        _markFail('alchemy');
        return null;
      }

      const balData = await balRes.json();
      _markOk('alchemy');

      // 2. Get Transaction History
      const txPayload = isSol ? {
        jsonrpc: '2.0',
        id: 2,
        method: 'getSignaturesForAddress',
        params: [addr, { limit: 100 }]
      } : {
        jsonrpc: '2.0',
        id: 2,
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromAddress: addr,
          category: ['external', 'internal', 'erc20'],
          maxCount: '0x64', // 100
        }]
      };

      const txRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(txPayload),
      });

      const txData = txRes.ok ? await txRes.json() : null;

      // 3. Normalize Response
      let balances = [];
      let transfers = [];

      if (isSol) {
        const solBalance = balData.result?.value || 0;
        balances = [{ contractAddress: 'native', tokenBalance: '0x' + solBalance.toString(16) }];
        transfers = (txData?.result || []).map(t => ({
          hash: t.signature,
          blockNum: '0x' + (t.slot || 0).toString(16),
          category: 'external'
        }));
      } else {
        balances = balData.result?.tokenBalances || [];
        transfers = txData?.result?.transfers || [];
      }

      return {
        balances,
        transfers,
        source: 'alchemy',
        network: useDevnet ? 'devnet' : 'mainnet',
      };

    } catch (err) {
      _markFail('alchemy');
      console.error(`[PortfolioIntel] Alchemy fetch (${chain} ${useDevnet ? 'devnet' : 'mainnet'}) failed:`, err.message);
      return null;
    }
  }

  // ── Aggregate wallet activity ────────────────────────────────

  async function _getWalletActivityAggregated(addr, chain) {
    try {
      const normalized = addr.toLowerCase().trim();
      const chainKey = String(chain || 'ETH').toUpperCase();
      const cacheKey = `${normalized}:${chainKey}`;

      // Get base balances from cache or fetch
      let portfolio = _portfolioCache.get(cacheKey);
      if (!portfolio || Date.now() - portfolio.timestamp > 300000) { // 5m TTL
        portfolio = await _fetchPortfolioAlchemy(normalized, chainKey);
        if (portfolio) {
          _portfolioCache.set(cacheKey, { ...portfolio, timestamp: Date.now() });
        }
      }

      // Get whale activity
      let whales = [];
      if (window.WhaleAlertMonitor) {
        try {
          const result = await window.WhaleAlertMonitor.getWhaleTransactions(chainKey);
          whales = result.txs.filter(t =>
            t.from === normalized || t.to === normalized
          );
        } catch (e) { /* ignore */ }
      }

      // Get DEX activity
      let swaps = [];
      if (window.DexActivityMonitor && (chainKey === 'ETH' || chainKey === 'BNB')) {
        try {
          const result = await window.DexActivityMonitor.getSwaps(chainKey);
          swaps = result.swaps.filter(s =>
            s.user?.toLowerCase() === normalized
          );
        } catch (e) { /* ignore */ }
      }

      return {
        address: normalized,
        chain: chainKey,
        portfolio,
        whales,
        swaps,
        timestamp: Date.now(),
      };

    } catch (err) {
      console.error(`[PortfolioIntel] Activity aggregation failed:`, err.message);
      return null;
    }
  }

  // ── Risk analysis ────────────────────────────────────────────

  function _analyzeRisks(activity) {
    const risks = [];

    // Large incoming whales
    if (activity.whales?.length) {
      const largeIncoming = activity.whales.filter(w => w.direction === 'buy');
      if (largeIncoming.length > 5) {
        risks.push({
          level: 'medium',
          type: 'whale_accumulation',
          message: `${largeIncoming.length} whale inflows detected`,
          whales: largeIncoming.slice(0, 3),
        });
      }
    }

    // High DEX activity
    if (activity.swaps?.length) {
      const volume24h = activity.swaps.reduce((s, sw) => s + sw.value_usd, 0);
      if (volume24h > 1000000) { // $1M+ in 24h
        risks.push({
          level: 'low',
          type: 'high_activity',
          message: `$${Math.round(volume24h / 1000)}K in DEX volume (24h)`,
          volume: volume24h,
        });
      }
    }

    // Low liquidity risk (if portfolio is large)
    const portfolioValue = activity.portfolio?.balances?.reduce((s, b) => s + (parseFloat(b.value) || 0), 0) || 0;
    if (portfolioValue > 10000000 && activity.swaps?.length < 5) {
      risks.push({
        level: 'high',
        type: 'liquidity_risk',
        message: 'Large portfolio with low swap activity',
        portfolio: portfolioValue,
      });
    }

    return risks;
  }

  // ── Monitoring loop ──────────────────────────────────────────

  const _monitorIntervals = new Map(); // addr → intervalId

  async function _monitorWallet(addr) {
    const tracked = _trackedWallets.get(addr);
    if (!tracked) return;

    const chains = Array.isArray(tracked.chains) && tracked.chains.length
      ? tracked.chains
      : ['ETH', 'BNB', 'BTC', 'SOL', 'XRP', 'DOGE', 'HYPE'];

    const settled = await Promise.allSettled(
      chains.map(chain => _getWalletActivityAggregated(addr, chain))
    );

    const activities = settled
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (!activities.length) return;

    const chainRisks = activities.map(activity => ({
      chain: activity.chain,
      risks: _analyzeRisks(activity),
    }));

    const risks = chainRisks.flatMap(x => x.risks.map(r => ({ ...r, chain: x.chain })));

    tracked.data = {
      activities,
      chainRisks,
      risks,
      timestamp: Date.now(),
    };

    tracked.callback?.({ activities, chainRisks, risks });
  }

  // ── Public API ────────────────────────────────────────────────

  const PortfolioIntel = {

    /**
     * Analyze one or more wallets for risks and opportunities.
     */
    async analyze(wallets = [], opts = {}) {
      const results = [];

      for (const wallet of wallets) {
        const chains = opts.chains || ['ETH', 'BNB', 'BTC', 'SOL', 'XRP', 'DOGE', 'HYPE'];
        for (const chain of chains) {
          const activity = await _getWalletActivityAggregated(wallet, chain);
          if (activity) {
            const risks = _analyzeRisks(activity);
            results.push({
              wallet,
              chain,
              activity,
              risks,
              score: 100 - (risks.length * 10), // Simple risk score
            });
          }
        }
      }

      return {
        portfolio: results,
        totalRisks: results.reduce((s, r) => s + r.risks.length, 0),
        topRisks: results
          .flatMap(r => r.risks)
          .sort((a, b) => {
            const levelMap = { critical: 3, high: 2, medium: 1, low: 0 };
            return (levelMap[b.level] || 0) - (levelMap[a.level] || 0);
          })
          .slice(0, 10),
        timestamp: Date.now(),
      };
    },

    /**
     * Get all activity for a wallet on a chain.
     */
    async getWalletActivity(addr, chain = 'ETH') {
      return _getWalletActivityAggregated(addr, chain);
    },

    /**
     * Start tracking a wallet with real-time updates.
     */
    trackWallet(addr, callback, chains = ['ETH', 'BNB', 'BTC', 'SOL', 'XRP', 'DOGE', 'HYPE']) {
      const normalized = addr.toLowerCase().trim();
      const normalizedChains = (chains || [])
        .map(c => String(c || '').toUpperCase())
        .filter(Boolean);
      _trackedWallets.set(normalized, { chains: normalizedChains, callback, data: null });
      _watchList.add(normalized);

      // Initial fetch
      _monitorWallet(normalized);

      // Poll every 60s
      const interval = setInterval(() => {
        _monitorWallet(normalized);
      }, 60000);

      _monitorIntervals.set(normalized, interval);
      console.log(`[PortfolioIntel] Tracking wallet: ${normalized}`);
    },

    /**
     * Stop tracking a wallet.
     */
    untrackWallet(addr) {
      const normalized = addr.toLowerCase().trim();
      const interval = _monitorIntervals.get(normalized);
      if (interval) clearInterval(interval);

      _trackedWallets.delete(normalized);
      _monitorIntervals.delete(normalized);
      _watchList.delete(normalized);
      console.log(`[PortfolioIntel] Stopped tracking: ${normalized}`);
    },

    /**
     * Get all tracked wallets.
     */
    getTrackedWallets() {
      return Array.from(_watchList);
    },

    /**
     * Stats.
     */
    stats() {
      return {
        tracked: _trackedWallets.size,
        watched: _watchList.size,
        cached: _portfolioCache.size,
        health: _health.alchemy,
      };
    },

    /**
     * Flush.
     */
    flush() {
      for (const interval of _monitorIntervals.values()) {
        clearInterval(interval);
      }
      _trackedWallets.clear();
      _monitorIntervals.clear();
      _watchList.clear();
      _portfolioCache.clear();
    },
  };

  window.PortfolioIntel = PortfolioIntel;

})();
