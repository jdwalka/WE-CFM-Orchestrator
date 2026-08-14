/**
 * Historical Settlement Fetcher
 *
 * Pulls SETTLED contracts from Polymarket (and optional Coinbase) to build
 * historical accuracy scorecards. Kalshi network I/O is permanently disabled.
 *
 * NOT waiting for new contracts to close — fetching what already settled.
 */

class HistoricalSettlementFetcher {
  constructor() {
    this.polyBase = 'https://gamma-api.polymarket.com';
    this.coinbaseBase = 'https://api.exchange.coinbase.com';
    this.coinbasePredictionsEnabled = this._readFlag('enableCoinbasePredictions');

    // Cache for settled contracts (avoid redundant API calls)
    this.settledCache = {
      kalshi: [], // legacy empty — never populated
      polymarket: [],
      coinbase: [],
    };

    this.lastFetch = {
      kalshi: 0,
      polymarket: 0,
      coinbase: 0,
    };

    this.cacheTTL = 300_000; // 5 minutes

    console.log('[HistoricalSettlementFetcher] Initialized (Polymarket-only; Kalshi fetch disabled)');
  }

  _readFlag(name) {
    try {
      const v = localStorage.getItem(name);
      return v === '1' || v === 'true';
    } catch (_) {
      return false;
    }
  }

  /**
   * Kalshi settled fetch — permanently disabled (Polymarket-only overhaul).
   * Kept as a no-op so older callers do not throw.
   */
  async fetchKalshiSettled(_hoursBack = 24, _limit = 100) {
    this.settledCache.kalshi = [];
    this.lastFetch.kalshi = Date.now();
    return [];
  }

  /**
   * Fetch resolved Polymarket markets for crypto predictions
   * Returns array of { marketId, symbol, outcome, resolvedTime }
   */
  async fetchPolymarketSettled(hoursBack = 24, limit = 100) {
    const now = Date.now();

    // Check cache
    if (this.settledCache.polymarket.length > 0 && now - this.lastFetch.polymarket < this.cacheTTL) {
      console.log(`[HistoricalFetcher] Using Polymarket cache (${this.settledCache.polymarket.length} resolved markets)`);
      return this.settledCache.polymarket;
    }

    try {
      // Polymarket markets endpoint
      const url = `${this.polyBase}/markets?status=resolved&limit=${limit}`;
      const response = await fetch(url, { timeout: 20000 });

      if (!response.ok) {
        console.error(`[HistoricalFetcher] Polymarket API error: ${response.status}`);
        return [];
      }

      const markets = await response.json();

      const resolved = markets
        .filter(m => {
          // Only crypto prediction markets
          if (!m.question) return false;
          if (m.endDateIso == null && m.endDate == null) return false;
          // check if title contains crypto names
          return ['BTC', 'ETH', 'SOL', 'XRP'].some(sym =>  // 4-coin focus
            m.question.toUpperCase().includes(sym)
          );
        })
        .map(m => {
          // Extract symbol from question
          const symMatch = m.question.match(/(BTC|ETH|SOL|XRP|DOGE|BNB)/i);
          const symbol = symMatch ? symMatch[1].toUpperCase() : null;

          // Parse outcomes/outcomePrices (Gamma may JSON-stringify arrays).
          // Crypto Up/Down markets label "Up"/"Down"; classic binary uses "Yes"/"No".
          // Prefer directional UP/DOWN for scorecards; keep legacy outcome YES/NO too.
          let outcomes = m.outcomes;
          if (typeof outcomes === 'string') {
            try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; }
          }
          let prices = m.outcomePrices;
          if (typeof prices === 'string') {
            try { prices = JSON.parse(prices); } catch { prices = null; }
          }
          const priceArr = Array.isArray(prices) ? prices.map(p => parseFloat(p)) : [];
          const outArr = Array.isArray(outcomes) ? outcomes.map(o => String(o || '').trim()) : [];

          let upIndex = outArr.findIndex(o => o.toLowerCase() === 'up');
          if (upIndex < 0) upIndex = outArr.findIndex(o => o.toLowerCase() === 'yes');
          if (upIndex < 0) upIndex = 0;

          const upPrice = Number.isFinite(priceArr[upIndex]) ? priceArr[upIndex]
            : parseFloat(String(priceArr[0] ?? '0'));
          const otherIdx = upIndex === 0 ? 1 : 0;
          const downPrice = Number.isFinite(priceArr[otherIdx]) ? priceArr[otherIdx]
            : parseFloat(String(priceArr[1] ?? '0'));
          // Directional outcome for Up/Down markets (and Yes→UP / No→DOWN).
          // Decisive prices (≥0.98 / ≤0.02) win; otherwise higher side.
          let outcomeDir = 'DOWN';
          if (upPrice >= 0.98) outcomeDir = 'UP';
          else if (upPrice <= 0.02) outcomeDir = 'DOWN';
          else outcomeDir = upPrice >= downPrice ? 'UP' : 'DOWN';
          // Legacy YES/NO field (Yes/Up → YES) for older consumers of calculateAccuracy
          const outcome = outcomeDir === 'UP' ? 'YES' : 'NO';

          const resolvedTime = m.updatedAt ? new Date(m.updatedAt).getTime() : (m.endDateIso ? new Date(m.endDateIso).getTime() : new Date(m.endDate).getTime());

          return {
            source: 'polymarket',
            marketId: m.id,
            slug: m.slug || m.market_slug || null,
            symbol,
            title: m.question,
            outcome,           // YES | NO (legacy)
            outcomeDir,        // UP | DOWN (preferred for crypto Up/Down)
            outcomes: outArr.length ? outArr : null,
            outcomePrices: priceArr.length ? priceArr : m.outcomePrices,
            resolvedTime: resolvedTime,
            createdAt: m.createdAt ? new Date(m.createdAt).getTime() : null,
            // Raw market object for debugging
            raw: m,
          };
        })
        .slice(0, 50); // Keep most recent 50

      this.settledCache.polymarket = resolved;
      this.lastFetch.polymarket = now;

      if (!this._loggedPolyMarkets) this._loggedPolyMarkets = new Set();
      resolved.forEach(m => {
        if (typeof window !== 'undefined' && window.DataLogger && window.DataLogger.logPolymarketOutcome) {
          if (!this._loggedPolyMarkets.has(m.marketId)) {
            this._loggedPolyMarkets.add(m.marketId);
            window.DataLogger.logPolymarketOutcome(m.symbol, {
              marketId: m.marketId,
              title: m.title,
              outcome: m.outcome,
              resolvedTimeMs: m.resolvedTime,
              outcomePrices: m.outcomePrices
            });
          }
        }
      });

      console.log(`[HistoricalFetcher] Fetched ${resolved.length} resolved Polymarket crypto markets`);
      return resolved;
    } catch (err) {
      console.error('[HistoricalFetcher] Polymarket fetch error:', err.message);
      return this.settledCache.polymarket; // Return cache on error
    }
  }

  /**
   * Fetch settled Coinbase Prediction Markets
   */
  async fetchCoinbasePredictionsSettled(hoursBack = 24, limit = 50) {
    const now = Date.now();

    if (!this.coinbasePredictionsEnabled) {
      this.lastFetch.coinbase = now;
      return this.settledCache.coinbase;
    }

    // Check cache
    if (this.settledCache.coinbase.length > 0 && now - this.lastFetch.coinbase < this.cacheTTL) {
      console.log(`[HistoricalFetcher] Using Coinbase cache (${this.settledCache.coinbase.length} settled predictions)`);
      return this.settledCache.coinbase;
    }

    try {
      // Coinbase prediction markets endpoint
      const url = `${this.coinbaseBase}/predictions?status=settled&limit=${limit}`;
      const response = await fetch(url, { timeout: 20000 });

      if (!response.ok) {
        console.error(`[HistoricalFetcher] Coinbase API error: ${response.status}`);
        return [];
      }

      const data = await response.json();
      const markets = data.predictions || [];

      const settled = markets
        .filter(m => {
          if (!m.title) return false;
          return ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'].some(sym =>
            m.title.toUpperCase().includes(sym)
          );
        })
        .map(m => {
          const symMatch = m.title.match(/(BTC|ETH|SOL|XRP|DOGE|BNB)/i);
          const symbol = symMatch ? symMatch[1].toUpperCase() : null;

          return {
            source: 'coinbase',
            marketId: m.id,
            symbol,
            title: m.title,
            outcome: m.winning_outcome, // 'YES' or 'NO'
            settleTime: m.settled_at ? new Date(m.settled_at).getTime() : null,
            createdAt: m.created_at ? new Date(m.created_at).getTime() : null,
            raw: m,
          };
        })
        .slice(0, 50);

      this.settledCache.coinbase = settled;
      this.lastFetch.coinbase = now;

      console.log(`[HistoricalFetcher] Fetched ${settled.length} settled Coinbase predictions`);
      return settled;
    } catch (err) {
      console.error('[HistoricalFetcher] Coinbase fetch error:', err.message);
      return this.settledCache.coinbase;
    }
  }

  /**
   * Fetch all settled markets from all sources
   */
  async fetchAllSettled(hoursBack = 24) {
    const [kalshi, polymarket, coinbase] = await Promise.all([
      this.fetchKalshiSettled(hoursBack),
      this.fetchPolymarketSettled(hoursBack),
      this.fetchCoinbasePredictionsSettled(hoursBack),
    ]);

    return {
      kalshi,
      polymarket,
      coinbase,
      total: kalshi.length + polymarket.length + coinbase.length,
      timestamp: Date.now(),
    };
  }

  /**
   * Calculate accuracy against model predictions
   * Compares settled outcomes to window._lastPrediction for each coin
   */
  calculateAccuracy(settledMarkets) {
    const predictions = window._lastPrediction || {};
    const accuracy = {};

    // Group by coin symbol
    const byCoin = {};
    for (const market of settledMarkets) {
      const sym = market.symbol;
      if (!sym) continue;
      if (!byCoin[sym]) byCoin[sym] = [];
      byCoin[sym].push(market);
    }

    // Calculate per-coin accuracy
    for (const [sym, markets] of Object.entries(byCoin)) {
      const pred = predictions[sym];
      if (!pred) {
        accuracy[sym] = {
          symbol: sym,
          total: markets.length,
          correct: 0,
          accuracy: 0,
          prediction: null,
        };
        continue;
      }

      const modelDir = pred.direction; // 'UP' or 'DOWN'
      let correct = 0;

      for (const m of markets) {
        // Kalshi: result is 'YES' or 'NO'
        let marketDir = null;
        if (m.source === 'kalshi') {
          const strike = String(m.strikeType ?? m.raw?.strike_type ?? 'above').toLowerCase();
          const yesDir = strike === 'below' ? 'DOWN' : 'UP';
          const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
          marketDir = String(m.result).toUpperCase() === 'YES' ? yesDir : noDir;
        } else if (m.source === 'polymarket') {
          // Prefer outcomeDir (UP/DOWN); fall back to YES→UP / NO→DOWN
          marketDir = m.outcomeDir
            || (m.outcome === 'YES' || m.outcome === 'UP' ? 'UP' : 'DOWN');
        } else {
          // Coinbase: outcome is already 'YES' or 'NO' (price up/down)
          marketDir = m.outcome === 'YES' ? 'UP' : 'DOWN';
        }

        if (marketDir === modelDir) {
          correct++;
        }
      }

      accuracy[sym] = {
        symbol: sym,
        total: markets.length,
        correct,
        accuracy: Math.round((correct / markets.length) * 1000) / 10, // percentage with 1 decimal
        prediction: modelDir,
      };
    }

    return accuracy;
  }

  /**
   * Get scorecard-ready data
   */
  async getScorecard() {
    const settled = await this.fetchAllSettled();

    // Flatten to single array
    const allSettled = [
      ...settled.kalshi,
      ...settled.polymarket,
      ...settled.coinbase,
    ];

    // Group by coin
    const byCoin = {};
    for (const market of allSettled) {
      const sym = market.symbol;
      if (!sym) continue;
      if (!byCoin[sym]) {
        byCoin[sym] = {
          symbol: sym,
          settled: [],
          accuracy: null,
        };
      }
      byCoin[sym].settled.push(market);
    }

    // Calculate accuracy per coin
    const scorecard = {};
    for (const [sym, data] of Object.entries(byCoin)) {
      const pred = window._lastPrediction?.[sym];
      const modelDir = pred?.direction;

      let correct = 0;
      for (const m of data.settled) {
        let marketDir;
        if (m.source === 'kalshi') {
          const strike = String(m.strikeType ?? m.raw?.strike_type ?? 'above').toLowerCase();
          const yesDir = strike === 'below' ? 'DOWN' : 'UP';
          const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
          marketDir = String(m.result).toUpperCase() === 'YES' ? yesDir : noDir;
        } else if (m.source === 'polymarket') {
          marketDir = m.outcomeDir
            || (m.outcome === 'YES' || m.outcome === 'UP' ? 'UP' : 'DOWN');
        } else {
          marketDir = m.outcome === 'YES' ? 'UP' : 'DOWN';
        }
        if (marketDir === modelDir) correct++;
      }

      scorecard[sym] = {
        symbol: sym,
        total: data.settled.length,
        correct,
        accuracy: data.settled.length > 0 ? Math.round((correct / data.settled.length) * 1000) / 10 : 0,
        prediction: modelDir,
        recentMarkets: data.settled.slice(0, 5), // Last 5 for detail
      };
    }

    // Feed accuracy data into adaptive learning engine
    if (typeof window !== 'undefined' && window.AdaptiveLearner) {
      for (const [sym, scoreData] of Object.entries(scorecard)) {
        const pred = window._lastPrediction?.[sym];
        if (pred && scoreData.total > 0) {
          // Record this batch of contracts to adaptive engine
          const wasCorrect = scoreData.correct === scoreData.total; // Simplified: all correct or not
          const signals = pred.signals || {};
          window.AdaptiveLearner.recordSignalContribution(sym, signals, wasCorrect);
        }
      }

      // Trigger auto-tuning if it's time
      const tuneEvent = window.AdaptiveLearner.autoTuneWeights();
      if (tuneEvent && Object.keys(tuneEvent.adjustments).length > 0) {
        window._lastTuneEvent = tuneEvent;
      }
    }

    return {
      timestamp: Date.now(),
      scorecard,
      totalSettled: allSettled.length,
      sources: {
        kalshi: settled.kalshi.length,
        polymarket: settled.polymarket.length,
        coinbase: settled.coinbase.length,
      },
    };
  }

  /**
   * Get diagnostics
   */
  getDiagnostics() {
    return {
      cache: {
        kalshi: this.settledCache.kalshi.length,
        polymarket: this.settledCache.polymarket.length,
        coinbase: this.settledCache.coinbase.length,
      },
      lastFetch: this.lastFetch,
      cacheTTL: this.cacheTTL,
    };
  }

  /**
   * Unified fetch for all settled contracts with error handling
   * Used by adaptive learning polling cycle
   */
  async fetchSettledContracts() {
    try {
      const all = await this.fetchAllSettled();
      const settled = [
        ...all.kalshi,
        ...all.polymarket,
        ...all.coinbase,
      ];

      return {
        settled: settled.map(s => ({
          symbol: s.symbol,
          source: s.source,
          result: s.result || s.outcome, // Kalshi: result, Polymarket/Coinbase: outcome
          openTime: s.createdAt || s.created_at,
          closeTime: s.resolvedTime || s.settleTime || s.closed_time,
          raw: s,
        })),
        errors: [],
      };
    } catch (err) {
      console.error('[HistoricalSettlementFetcher] fetchSettledContracts error:', err);
      return {
        settled: [],
        errors: [{ source: 'multi', error: err.message }],
      };
    }
  }
}

// Export globally
if (typeof window !== 'undefined') {
  window.HistoricalSettlementFetcher = HistoricalSettlementFetcher;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HistoricalSettlementFetcher;
}

console.log('[HistoricalSettlementFetcher] Module loaded');
