// ================================================================
// wallet-intel-config.js — Configuration & initialization
// ================================================================
// Store API keys in localStorage and initialize all intel monitors
// Call: WalletIntelConfig.init() after DOM loads
// ================================================================

const WalletIntelConfig = {
  /**
   * Initialize all wallet intelligence monitors with API keys.
   * Keys can be set via localStorage, environment, or passed directly.
   */
  init(opts = {}) {
    // Set API keys
    if (opts.whaleAlertKey) {
      localStorage.setItem('whaleAlertApiKey', opts.whaleAlertKey);
    }
    if (opts.transposeKey) {
      localStorage.setItem('transposeApiKey', opts.transposeKey);
    }
    if (opts.alchemyKey) {
      localStorage.setItem('alchemyApiKey', opts.alchemyKey);
    }
    if (opts.etherscanKey) {
      localStorage.setItem('etherscanApiKey', opts.etherscanKey);
    }
    if (opts.bscscanKey) {
      localStorage.setItem('bscscanApiKey', opts.bscscanKey);
    }

    console.log('[WalletIntel] Config initialized with provided API keys');
    return this;
  },

  /**
   * Check which monitors are loaded and ready.
   */
  checkReady() {
    return {
      whaleAlert: !!window.WhaleAlertMonitor,
      dex: !!window.DexActivityMonitor,
      portfolio: !!window.PortfolioIntel,
      walletCache: !!window.WalletCache,
      ready: !![
        window.WhaleAlertMonitor,
        window.DexActivityMonitor,
        window.PortfolioIntel,
        window.WalletCache,
      ].every(x => x),
    };
  },

  /**
   * Start monitoring all systems.
   */
  startMonitoring(opts = {}) {
    const DEFAULT_CHAINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
    const chains = (opts.chains && opts.chains.length ? opts.chains : DEFAULT_CHAINS)
      .map(c => String(c || '').toUpperCase())
      .filter(Boolean);
    const callback = opts.callback || (() => { });

    // Whale Alert: DROPPED (dead API key → permanent 401s). The monitor module
    // stays loadable for manual/emergency-desk use, but auto-start is off.
    // Opt back in per-call with opts.whale === true.
    if (opts.whale === true && window.WhaleAlertMonitor) {
      window.WhaleAlertMonitor.startMonitoring(chains, callback);
    } else {
      console.log('[WalletIntel] WhaleAlert auto-start skipped (feed dropped)');
    }

    if (window.DexActivityMonitor) {
      // BTC, XRP, DOGE are commonly not represented in EVM DEX monitors.
      const dexChains = chains.filter(c => !['BTC', 'XRP', 'DOGE'].includes(c));
      window.DexActivityMonitor.startMonitoring(dexChains, callback);
    }

    console.log('[WalletIntel] Monitoring started for:', chains.join(', '));
    return this;
  },

  /**
   * Stop all monitoring.
   */
  stopMonitoring() {
    if (window.WhaleAlertMonitor) window.WhaleAlertMonitor.stopMonitoring();
    if (window.DexActivityMonitor) window.DexActivityMonitor.stopMonitoring();
    console.log('[WalletIntel] Monitoring stopped');
    return this;
  },

  /**
   * Get status of all intel systems.
   */
  status() {
    const stats = {
      whaleAlert: window.WhaleAlertMonitor?.stats?.(),
      dex: window.DexActivityMonitor?.stats?.(),
      portfolio: window.PortfolioIntel?.stats?.(),
    };

    return {
      loaded: this.checkReady(),
      stats,
      timestamp: Date.now(),
    };
  },

  /**
   * Quick helper: Add a wallet to track across all sources.
   */
  trackWallet(addr, callback, chains = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE']) {
    if (!window.PortfolioIntel) {
      console.error('[WalletIntel] PortfolioIntel not loaded');
      return;
    }
    const normalizedChains = (chains || [])
      .map(c => String(c || '').toUpperCase())
      .filter(Boolean);
    window.PortfolioIntel.trackWallet(addr, callback, normalizedChains);
    console.log('[WalletIntel] Now tracking:', addr, 'across', normalizedChains.join(', '));
  },

  /**
   * Stop tracking a wallet.
   */
  untrackWallet(addr) {
    if (window.PortfolioIntel) {
      window.PortfolioIntel.untrackWallet(addr);
      console.log('[WalletIntel] Stopped tracking:', addr);
    }
  },

  /**
   * Get all wallets being tracked.
   */
  getTrackedWallets() {
    if (!window.PortfolioIntel) return [];
    return window.PortfolioIntel.getTrackedWallets();
  },

  /**
   * Flush all caches and stop monitoring.
   */
  reset() {
    if (window.WhaleAlertMonitor) window.WhaleAlertMonitor.flush?.();
    if (window.DexActivityMonitor) window.DexActivityMonitor.flush?.();
    if (window.PortfolioIntel) window.PortfolioIntel.flush?.();
    console.log('[WalletIntel] All systems reset');
  },
};

// Export globally
window.WalletIntelConfig = WalletIntelConfig;
