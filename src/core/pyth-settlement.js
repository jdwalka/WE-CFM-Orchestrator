// ================================================================
// Pyth Settlement Validator
// Checks Pyth price feeds for settlement confirmation & staleness
// Integrates with adaptive tuning module for live market regime tracking
// ================================================================

class PythSettlementValidator {
  constructor(pythHermesBaseUrl = 'https://hermes.pyth.network') {
    this.pythBase = pythHermesBaseUrl;
    this.pythBases = Array.from(new Set([
      pythHermesBaseUrl,
      'https://hermes.pyth.network',
    ].filter(Boolean)));
    this.requestTimeoutMs = 5000;

    // Pyth feed IDs for our 7 main coins
    this.feedIds = {
      BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
      ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
      SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
      XRP: 'ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
      DOGE: 'dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
      BNB: '2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
      HYPE: '4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b',
    };

    // Price cache (avoid redundant API calls)
    this.priceCache = {};
    this.cacheExpiry = 5000; // 5 seconds

    // Volatility history (for regime detection)
    this.volatilityHistory = {};
    this.maxHistoryLen = 50;

    // Settlement log
    this.settlementLog = [];

    console.log('[PythSettlementValidator] Initialized');
  }

  async fetchJsonWithTimeout(url, timeoutMs = this.requestTimeoutMs) {
    const fetchImpl =
      (typeof window !== 'undefined' && (window.resilientFetch || window.throttledFetch))
        ? (window.resilientFetch || window.throttledFetch).bind(window)
        : fetch;

    if (typeof AbortController === 'undefined') {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`Pyth API error: ${response.status}`);
      return response.json();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      try {
        controller.abort(new DOMException(`Pyth fetch timed out after ${timeoutMs}ms`, 'TimeoutError'));
      } catch (_) {
        try { controller.abort(); } catch (_) { }
      }
    }, timeoutMs);

    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Pyth API error: ${response.status}`);
      return await response.json();
    } catch (err) {
      const canProxy = typeof window !== 'undefined' && typeof window.proxyFetch === 'function';
      if (!canProxy) throw err;
      const proxyController = new AbortController();
      const proxyTimeoutId = setTimeout(() => {
        try { proxyController.abort(new DOMException(`Pyth proxy timed out after ${timeoutMs}ms`, 'TimeoutError')); } catch (_) { }
      }, timeoutMs);
      try {
        const proxied = await window.proxyFetch(url, { signal: proxyController.signal });
        if (!proxied.ok) throw new Error(`Pyth proxy error: ${proxied.status}`);
        return await proxied.json();
      } finally {
        clearTimeout(proxyTimeoutId);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────────

  /**
   * Fetch current price for a coin from Pyth Hermes
   * @param {string} sym - Coin symbol (BTC, ETH, SOL, etc.)
   * @returns {Promise<object>} { price, confidence, publishTime, age_ms }
   */
  async getCurrentPrice(sym) {
    const feedId = this.feedIds[sym];
    if (!feedId) {
      throw new Error(`[PythSettlementValidator] Unknown coin: ${sym}`);
    }

    // Check cache
    const cached = this.priceCache[sym];
    if (cached && Date.now() - cached.fetchTime < this.cacheExpiry) {
      return cached.data;
    }

    try {
      let json = null;
      let lastError = null;
      for (const base of this.pythBases) {
        try {
          const url = `${base.replace(/\/+$/, '')}/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}`;
          json = await this.fetchJsonWithTimeout(url, this.requestTimeoutMs);
          this.pythBase = base;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (!json) throw lastError || new Error('Pyth API returned no response');

      const feed = json.parsed?.[0];

      if (!feed || !feed.price) {
        throw new Error(`No price data for ${sym}`);
      }

      const price = parseFloat(feed.price.price);
      const confidence = parseFloat(feed.price.conf);
      const publishTime = parseInt(feed.price.publish_time) * 1000; // Convert to ms
      const age_ms = Date.now() - publishTime;

      const result = {
        price,
        confidence,
        publishTime,
        age_ms,
        feedId: feed.id,
      };

      // Cache result
      this.priceCache[sym] = { data: result, fetchTime: Date.now() };

      // Update window timestamp for adaptive tuner's staleness check
      if (typeof window !== 'undefined') {
        window.PYTH_HERMES_LAST_UPDATE = Date.now();
      }

      return result;
    } catch (err) {
      if (cached?.data) {
        console.warn(`[PythSettlementValidator] ${sym} fetch failed, serving stale cache:`, err.message);
        return {
          ...cached.data,
          stale: true,
          fetchError: err.message,
          age_ms: cached.data.publishTime ? Date.now() - cached.data.publishTime : cached.data.age_ms,
        };
      }
      console.error(`[PythSettlementValidator] Error fetching ${sym}:`, err.message);
      throw err;
    }
  }

  /**
   * Get multiple coin prices in one batch
   * @param {array<string>} coins - Array of coin symbols
   * @returns {Promise<object>} { BTC: {...}, ETH: {...}, ... }
   */
  async getPrices(coins) {
    const results = {};
    const errors = [];

    for (const sym of coins) {
      try {
        results[sym] = await this.getCurrentPrice(sym);
      } catch (err) {
        errors.push({ coin: sym, error: err.message });
      }
    }

    return { prices: results, errors };
  }

  /**
   * Validate a settlement (compare Kalshi outcome to Pyth price)
   * @param {object} trade - { coin, startPrice, endTime, kalshiOutcome }
   * @returns {Promise<object>} { valid, pythPrice, kalshiOutcome, match, deviation }
   */
  async validateSettlement(trade) {
    const { coin, startPrice, endTime, kalshiOutcome, strikeType, strikeDir } = trade;

    try {
      const pythPrice = await this.getCurrentPrice(coin);

      // Price movement direction
      const pythDir = pythPrice.price > startPrice ? 'UP' : 'DOWN';
      const strike = String(strikeDir ?? strikeType ?? 'above').toLowerCase();
      const yesDir = strike === 'below' ? 'DOWN' : 'UP';
      const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
      const isYes = String(kalshiOutcome || '').toUpperCase() === 'YES';
      const kalshiDir = isYes ? yesDir : noDir;

      const match = pythDir === kalshiDir;
      const deviation = Math.abs(pythPrice.price - startPrice) / startPrice;

      const result = {
        valid: true,
        coin,
        pythPrice: pythPrice.price,
        confidence: pythPrice.confidence,
        age_ms: pythPrice.age_ms,
        kalshiOutcome,
        pythDirection: pythDir,
        kalshiDirection: kalshiDir,
        match,
        deviation: Math.round(deviation * 20000) / 100,
        timestamp: Date.now(),
      };

      // Log if there's a mismatch
      if (!match) {
        console.warn(
          `[PythSettlementValidator] Settlement mismatch for ${coin}: ` +
          `Pyth=${pythDir} vs Kalshi=${kalshiDir}`
        );
      }

      this.settlementLog.push(result);
      if (this.settlementLog.length > 100) {
        this.settlementLog = this.settlementLog.slice(-100);
      }

      return result;
    } catch (err) {
      console.error(`[PythSettlementValidator] Settlement validation failed:`, err);
      return {
        valid: false,
        error: err.message,
        coin,
        kalshiOutcome,
      };
    }
  }

  /**
   * Check if Pyth feed is fresh (not stale)
   * @param {string} sym - Coin symbol
   * @param {number} maxAge_ms - Max acceptable age in milliseconds (default 60000 = 1 minute)
   * @returns {Promise<boolean>} True if fresh, false if stale
   */
  async isFresh(sym, maxAge_ms = 60000) {
    try {
      const priceData = await this.getCurrentPrice(sym);
      return priceData.age_ms < maxAge_ms;
    } catch (err) {
      console.error(`[PythSettlementValidator] Freshness check failed for ${sym}:`, err.message);
      return false;
    }
  }

  /**
   * Track price volatility for market regime detection
   * Updates volatilityHistory with recent price movements
   * @param {string} sym - Coin symbol
   * @param {number} price - Current price
   */
  recordPrice(sym, price) {
    if (!this.volatilityHistory[sym]) {
      this.volatilityHistory[sym] = [];
    }

    const history = this.volatilityHistory[sym];
    const lastPrice = history.length > 0 ? history[history.length - 1].price : null;

    const entry = {
      timestamp: Date.now(),
      price,
      pct_change: lastPrice ? ((price - lastPrice) / lastPrice) * 100 : 0,
    };

    history.push(entry);

    if (history.length > this.maxHistoryLen) {
      history.shift();
    }
  }

  /**
   * Compute recent volatility (standard deviation of price changes)
   * @param {string} sym - Coin symbol
   * @param {number} windowSize - Number of recent samples (default 20)
   * @returns {object} { volatility, mean, stdDev, volatilityRegime }
   */
  getVolatility(sym, windowSize = 20) {
    const history = this.volatilityHistory[sym] || [];

    if (history.length < 2) {
      return {
        volatility: 0.5,
        mean: 0,
        stdDev: 0,
        volatilityRegime: 'insufficient_data',
        samplesUsed: history.length,
      };
    }

    // Use last `windowSize` samples
    const recent = history.slice(-windowSize);
    const changes = recent.map(e => e.pct_change);

    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance = changes.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / changes.length;
    const stdDev = Math.sqrt(variance);

    // Classify volatility regime
    let regime;
    if (stdDev < 0.3) {
      regime = 'low';
    } else if (stdDev < 0.8) {
      regime = 'moderate';
    } else if (stdDev < 1.5) {
      regime = 'high';
    } else {
      regime = 'extreme';
    }

    return {
      volatility: Math.round(stdDev * 1000) / 1000,
      mean: Math.round(mean * 1000) / 1000,
      stdDev: Math.round(stdDev * 1000) / 1000,
      volatilityRegime: regime,
      samplesUsed: recent.length,
    };
  }

  /**
   * Get market regime summary for tuning decisions
   * @returns {object} Aggregated volatility data across all coins
   */
  getMarketRegime() {
    const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB'];
    const regimes = {};

    for (const sym of coins) {
      regimes[sym] = this.getVolatility(sym, 25);
    }

    // Aggregate: count volatility regimes
    const regimeCounts = {
      low: 0,
      moderate: 0,
      high: 0,
      extreme: 0,
    };

    for (const sym of coins) {
      const r = regimes[sym].volatilityRegime;
      if (r in regimeCounts) {
        regimeCounts[r]++;
      }
    }

    const dominantRegime = Object.keys(regimeCounts).reduce((a, b) =>
      regimeCounts[a] > regimeCounts[b] ? a : b
    );

    return {
      timestamp: Date.now(),
      coinRegimes: regimes,
      dominantRegime,
      regimeCounts,
    };
  }

  /**
   * Get diagnostics for debugging
   */
  getDiagnostics() {
    return {
      priceCache: this.priceCache,
      volatilityHistory: this.volatilityHistory,
      settlementLog: this.settlementLog.slice(-20),
      marketRegime: this.getMarketRegime(),
    };
  }
}

// ══════════════════════════════════════════════════════════════
// Export for use in predictions.js and app.js
// ══════════════════════════════════════════════════════════════

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PythSettlementValidator;
}
