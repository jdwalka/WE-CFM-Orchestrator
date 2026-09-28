// ================================================================
// WE|||CRYPTO — Prediction Analytics Engine v2
// 1-15 min directional predictions + scalp timing + contrarian bets
//
// Live data from:
//   Crypto.com Exchange — 5m/15m candles, order book, trade flow
//   CoinGecko — OHLC + ticker for HYPE, BNB (no CDC USD pair)
//
// Indicators:
//   RSI(14), EMA(9/21) cross, VWAP deviation, OBV slope,
//   Volume delta (buy/sell aggressor), Momentum,
//   Book imbalance (bid wall vs ask wall), Trade flow ratio
//
// Scalp/Contrarian layer:
//   Session timing (Asia/London/NY open power hours),
//   Exhaustion detection (climax volume + reversal),
//   Book absorption (large wall eaten = breakout),
//   Overextension fade zones (±2σ from VWAP)
// ================================================================

(function () {
  'use strict';

  const VERBOSE_PREDICTION_LOGS = (() => {
    try {
      return window.WECRYPTO_VERBOSE_PREDICTIONS === true || localStorage.getItem('wecrypto_verbose_predictions') === '1';
    } catch (_) {
      return false;
    }
  })();
  const _predictionLogThrottle = new Map();

  function predictionDebugLog(key, level, messageFactory, intervalMs = 20000) {
    if (!VERBOSE_PREDICTION_LOGS) return;
    const now = Date.now();
    const last = _predictionLogThrottle.get(key) || 0;
    if ((now - last) < intervalMs) return;
    _predictionLogThrottle.set(key, now);
    const msg = typeof messageFactory === 'function' ? messageFactory() : messageFactory;
    const writer = console[level] || console.log;
    writer.call(console, msg);
  }

  const CDC_BASE = 'https://api.crypto.com/v2/public';
  const GECKO_BASE = 'https://api.coingecko.com/api/v3';
  const BIN_BASE = 'https://data-api.binance.vision/api/v3';  // market-data fallback after WS
  const MEXC_BASE = 'https://api.mexc.com/api/v3';
  const CB_EXCH_BASE = 'https://api.exchange.coinbase.com';
  const CB_EXCH_SYMS = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD' };
  const GECKO_ONLY = new Set(['BNB']);
  const BIN_SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT' };
  const MEXC_SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', HYPE: 'HYPEUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT' };
  const BYBIT_BASE = 'https://api.bybit.com/v5';
  function getBybitUrl(path) { return `${BYBIT_BASE}${path}`; }
  const BYBIT_SYMS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', HYPE: 'HYPEUSDT', DOGE: 'DOGEUSDT', BNB: 'BNBUSDT' };
  const KUCOIN_BASE = 'https://api.kucoin.com/api/v1';
  const KUCOIN_SYMS = { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', HYPE: 'HYPE-USDT', DOGE: 'DOGE-USDT', BNB: 'BNB-USDT' };
  const BFNX_BASE = 'https://api-pub.bitfinex.com/v2';
  // BNB removed — not listed on Bitfinex. SOL corrected (tSOLUST was a typo → tSOLUSD).
  const BFNX_SYMS = { BTC: 'tBTCUSD', ETH: 'tETHUSD', SOL: 'tSOLUSD', XRP: 'tXRPUSD', DOGE: 'tDOGEUSD' };
  const CDC_TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
  let SHORT_HORIZON_MINUTES = [1, 5, 10, 15];
  let DEFAULT_SHORT_HORIZON_MIN = 15;  // Primary target: next 15-min candle session (Polymarket contracts)
  const STATIC_HORIZONS = [1, 5, 10, 15];

  function coinPriceDecimals(sym) {
    const central = Number(window.CoinPrecision?.getCoinDecimals?.(sym));
    if (Number.isFinite(central)) return central;
    const key = String(sym || '').toUpperCase();
    if (key === 'DOGE') return 7;
    if (key === 'SOL' || key === 'HYPE' || key === 'XRP') return 4;
    return 2;
  }

  const {
    POLYMARKET_VERIFY_ONLY,
    getPolymarketNextBoundaryMinutes,
    calculatePolymarketSentiment,
    getPolymarket15mSettlementContext,
  } = window.PredictionPolymarketLogic;
  const SHORT_HORIZON_WEIGHTS = { 1: 0.25, 5: 0.45, 10: 0.75, 15: 2.40 };
  // HIGH COVERAGE MODE (user: always take a trade) — low floors, lean not block.
  const SHORT_HORIZON_FILTERS = {
    h1: { entryThreshold: 0.06, minAgreement: 0.50 },
    h5: { entryThreshold: 0.08, minAgreement: 0.50 },
    h10: { entryThreshold: 0.08, minAgreement: 0.50 },
    h15: { entryThreshold: 0.06, minAgreement: 0.50 },
  };

  const candleCache = Object.create(null);
  window._predictions = Object.create(null);
  window._backtests = Object.create(null);
  let predictionTimer = null;
  let predictionRunPromise = null;
  let advancedBacktestWarmPromise = null;
  let inferenceRunPromise = null;
  let lastInferenceRunTs = 0;
  let tideRunPromise = null;
  let lastTideRunTs = 0;
  let tideStatusCache = null;
  let tideStatusCacheTs = 0;
  const INFERENCE_MIN_INTERVAL_MS = 240000; // Trigger ~3.75x per 15 min window (was 150000/6x -- throttled back 2026-08-22, ASI1 daily quota was exhausting early)
  const INFERENCE_REQUEST_TIMEOUT_MS = 7000;
  const INFERENCE_QUOTA_COOLDOWN_MS = 5 * 60 * 1000;
  const TIDE_MIN_INTERVAL_MS = 15000;
  const TIDE_REQUEST_TIMEOUT_MS = 6500;
  const TIDE_STATUS_TTL_MS = 60 * 1000;
  const TIDE_DISABLED_RETRY_MS = 5 * 60 * 1000;
  const PREDICTION_FIRST_PASS_TIMEOUT_MS = 18000;
  const GECKO_MARKET_SOFT_TIMEOUT_MS = 2500;
  const GECKO_MIN_GAP_MS = 60_000; // hard-backoff: max ~1 req/min
  const GECKO_RATE_LIMIT_PAUSE_MS = 5 * 60_000;
  const GECKO_AUTH_PAUSE_MS = 5 * 60_000;
  let inferenceCooldownUntilTs = 0;
  let inferenceCooldownReason = '';
  let tideDisabledUntilTs = 0;
  let tideDisabledReason = '';
  const {
    configure: configurePredictionMicrostructure,
    getFreshLiveBook,
    resolveFreshOrderBook,
    updateLiveOrderBook,
    shouldRepriceForLiveBook,
    rescoreLiveMicrostructure,
    analyzeBook,
    detectWallAbsorption,
    classifyBookLiquidity,
    getLiveMicrostructure,
  } = window.PredictionMicrostructure;

  configurePredictionMicrostructure({
    getCandleCache(sym) {
      return candleCache[String(sym || '').toUpperCase()] || null;
    },
    getPredictionCoins() {
      return Array.isArray(window.PREDICTION_COINS)
        ? window.PREDICTION_COINS
        : (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []);
    },
    getPredictions() {
      return window._predictions || {};
    },
    getBacktests() {
      return window._backtests || {};
    },
    setPrediction(sym, prediction) {
      window._predictions[String(sym || '').toUpperCase()] = prediction;
    },
    computePrediction(coin, backtest) {
      return computePrediction(coin, backtest);
    },
    preservePredictionOverlay(previousPrediction, nextPrediction) {
      return preservePredictionOverlay(previousPrediction, nextPrediction);
    },
  });

  // ── Backtest localStorage cache (cold-start / refresh acceleration) ───────
  // Bump cache key to force recomputation after h1/h5 horizon-candle fix + 5m PTB anchor.
  const BT_CACHE_KEY = 'poly_twap_ptb_bt_cache_v3';
  const BT_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

  function saveBtCache() {
    try {
      let store = {};
      try {
        const existingRaw = localStorage.getItem(BT_CACHE_KEY);
        if (existingRaw) store = JSON.parse(existingRaw) || {};
      } catch (_) { }
      let updated = false;
      PREDICTION_COINS.forEach(coin => {
        const bt = window._backtests[coin.sym];
        if (bt && bt.summary) {
          store[coin.sym] = { bt, ts: Date.now(), walkKey: candleCache[coin.sym]?._walkBacktestKey || '' };
          updated = true;
        }
      });
      if (updated || Object.keys(store).length > 0) {
        localStorage.setItem(BT_CACHE_KEY, JSON.stringify(store));
      }
    } catch (e) { }
  }

  (function loadBtCache() {
    try {
      const raw = localStorage.getItem(BT_CACHE_KEY);
      if (!raw) return;
      const store = JSON.parse(raw);
      PREDICTION_COINS.forEach(coin => {
        const entry = store[coin.sym];
        if (!entry || Date.now() - entry.ts > BT_CACHE_TTL_MS) return;
        window._backtests[coin.sym] = entry.bt;
        // Pre-seed in-memory key so runWalkForwardBacktest skips re-run when candles match
        if (!candleCache[coin.sym]) candleCache[coin.sym] = {};
        candleCache[coin.sym]._walkBacktestKey = entry.walkKey;
        candleCache[coin.sym]._walkBacktest = entry.bt;
      });
    } catch (e) { }
  })();
  const ENABLE_MDT_SCORE_MULT = true; // set false to instantly revert to pre-MDT formula

  // ================================================================
  // COMPOSITE_WEIGHTS — Global base weights
  // Empirically derived from 30-day Python backtest (h-subshell ±5, 7 coins × 4 horizons).
  // PER_COIN_INDICATOR_BIAS multipliers applied at composite-time — see below.
  //
  // KEY FINDING: Prior weights were backwards. momentum was worst indicator
  // (27–40% WR across 6/7 coins). bands + williamsR were consistently best
  // (63–70% WR for BTC/ETH). Weights now reflect empirical reality.
  // ================================================================
  const COMPOSITE_WEIGHTS = {
     supertrend: 0.1,
     hma: 0.076,
     vwma: 0.06,
     ema: 0.054,
     sma: 0.03,
     macd: 0.076,
     persistence: 0.07,
     bands: 0.05,
     keltner: 0.05,
     williamsR: 0.07,
     rsi: 0.065,
     cci: 0.05,
     stochrsi: 0.04,
     volume: 0.12,
     obv: 0.076,
     cmf: 0.07,
     mfi: 0.07,
     structure: 0.1,
     ichimoku: 0.05,
     adx: 0.04,
     fisher: 0.04,
     book: 0.25,
     flow: 0.22,
     toxicity: 0.06,
     spoof: 0.07,
     iceberg: 0.08,
     orderBookImbalance: 0.18,
     imbalanceVelocity: 0.12,
     liquidityDepth: 0.08,
     liquidityVacuum: 0.12,
     fundingRate: 0.1,
     mktSentiment: 0.18,
     fearGreed: 0.12,
     cmcMacro: 0.08,
   };
    supertrend: 0.1,
    hma: 0.076,
    vwma: 0.06,
    ema: 0.054,
    sma: 0.03,
    macd: 0.076,
    persistence: 0.07,
    bands: 0.05,
    keltner: 0.05,
    williamsR: 0.07,
    rsi: 0.065,
    cci: 0.05,
    stochrsi: 0.04,
    volume: 0.12,
    obv: 0.076,
    cmf: 0.07,
    mfi: 0.07,
    structure: 0.1,
    ichimoku: 0.05,
    adx: 0.04,
    fisher: 0.04,
    book: 0.25,
    flow: 0.22,
    toxicity: 0.06,
    spoof: 0.07,
    iceberg: 0.08,
    orderBookImbalance: 0.18,
    imbalanceVelocity: 0.12,
    liquidityDepth: 0.08,
    liquidityVacuum: 0.12,
    fundingRate: 0.1,
    mktSentiment: 0.18,
    fearGreed: 0.12,
    cmcMacro: 0.08,
  };

  const {
    REGIME_WEIGHT_MULTS,
    ONLINE_WEIGHT_BOUNDS,
    OUTER_ORBITAL_WEIGHTS,
    _coinKey,
    _ensureOnlineState,
    _ensureOnlineSignalState,
    _clampOnlineStep,
    applyOnlineWeightOverlay,
    applyRegimeMults,
  } = window.PredictionRegimeWeights;

  // ================================================================
  // PER_COIN_INDICATOR_BIAS — retuned 2026-08-02 from advanced 30d h15 indicator accuracy.
  // Caps extremes (no bias > 1.6 on tradable coins). XRP/SOL trade-disabled via TRADING_POLICY.
  // Micro book/flow kept modest for live path (not in offline advanced suite).
  const PER_COIN_INDICATOR_BIAS = {
    BTC: {
      bands: 1.034,
      williamsR: 1.038,
      obv: 1.057,
      vwap: 1,
      hma: 0.979,
      momentum: 0.6,
      stochrsi: 1.027,
      sma: 0.923,
      adx: 1,
      mfi: 1.1,
      supertrend: 0.972,
      ema: 0.955,
      macd: 0.978,
      rsi: 0.778,
    },
    ETH: {
      bands: 1.038,
      williamsR: 1.037,
      obv: 1.05,
      vwap: 1,
      hma: 0.979,
      momentum: 0.6,
      stochrsi: 1.031,
      sma: 0.916,
      adx: 1,
      mfi: 1.1,
      supertrend: 0.976,
      ema: 0.946,
      macd: 0.953,
      rsi: 0.78,
    },
    SOL: {
      bands: 1.039,
      williamsR: 1.044,
      obv: 1.059,
      vwap: 1,
      hma: 0.979,
      momentum: 0.599,
      stochrsi: 1.033,
      sma: 0.911,
      adx: 1,
      mfi: 1.1,
      supertrend: 0.973,
      ema: 0.94,
      macd: 0.952,
      rsi: 0.78,
    },
    XRP: {
      bands: 1.037,
      williamsR: 1.036,
      obv: 1.057,
      vwap: 1,
      hma: 0.979,
      momentum: 0.6,
      stochrsi: 1.027,
      sma: 0.908,
      adx: 1,
      mfi: 1.1,
      supertrend: 0.975,
      ema: 0.937,
      macd: 0.977,
      rsi: 0.78,
    },
  };

  // Expose for adaptive retuner (live mutations propagate to next prediction run)
  window.PER_COIN_INDICATOR_BIAS = PER_COIN_INDICATOR_BIAS;

  // SOL re-tuned 2026-04-30: 14d walk-forward, 78 signals, 55.1% WR, PF 1.99 — maxScore 0.55 cap
  // DOGE re-enabled 2026-05-05: Pyth Lazer feed ID 10 + History API provide official OHLC candles
  const SIGNAL_DISABLED_COINS = new Set();

  // Session multipliers removed — crypto trades 24/7; model adjusts naturally.
  // _sessMult is hardwired to 1.0 at the score computation line below.

  // ================================================================
  // REGIME-ADAPTIVE CONFIDENCE THRESHOLDS
  // Applied when market regime is classified via statistical analysis
  // ================================================================
  const {
    REGIME_CONFIDENCE_MAP,
    SIGNAL_GATE,
    SIGNAL_GATE_OVERRIDES,
    evaluateSignalGate,
  } = window.PredictionSignalGates;

  // ── Polymarket routing helpers (execution guard, rationale builder, stats utils)
  const {
    getSecsToPolymarketClose,
    normalCDF,
    buildRationale,
    buildExecutionGuard,
  } = window.PREDICTIONS_POLYMARKET_ROUTING;

  // ── Exchange data fetchers — provided by data-fetchers.js scaffold ─────────
  const {
    fetchWithTimeout, fetchAnalyticsWithRoute, fetchFearGreed, resetGeckoRequestQueue, getFngCacheValue,
    fetchCDCCandles, fetchCDCBook, fetchCDCTrades,
    fetchGeckoJSON, fetchGeckoCandles, fetchGeckoTicker, fetchGeckoMaxHistory,
    fetchBINCandles, fetchBINBook, fetchBINTrades,
    fetchMEXCCandles, fetchMEXCBook, fetchMEXCTrades,
    fetchBybitCandles, fetchBybitBook, fetchBybitTrades,
    fetchKucoinCandles, fetchKucoinBook, fetchKucoinTrades,
    fetchBitfinexCandles, fetchBitfinexBook, fetchBitfinexTrades,
    fetchCBExchCandles, fetchCBExchBook, fetchCBExchTrades,
    fetchKrakenCandles, fetchKrakenBook, fetchKrakenTrades,
    anchoredPoolCandles, bucketCandles,
    geckoBucketMs, bucketGeckoSeries,
  } = window.PREDICTIONS_DATA_FETCHERS;

  // Fallbacks if data-fetchers is older / partially loaded (prevents BNB load crash)
  function _geckoBucketMsLocal(tf) {
    switch (tf) {
      case '15m': return 15 * 60 * 1000;
      case '1h': return 60 * 60 * 1000;
      default: return 5 * 60 * 1000;
    }
  }
  function _bucketGeckoSeriesLocal(prices, volumes, bucketMs) {
    const buckets = new Map();
    (prices || []).forEach((point, idx) => {
      const ts = Number(point[0]);
      const price = Number(point[1]);
      const vol = Number(volumes?.[idx]?.[1] || 0);
      if (!Number.isFinite(ts) || !Number.isFinite(price)) return;
      const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
      const bucket = buckets.get(bucketStart) || { t: bucketStart, o: price, h: price, l: price, c: price, v: 0 };
      bucket.h = Math.max(bucket.h, price);
      bucket.l = Math.min(bucket.l, price);
      bucket.c = price;
      bucket.v += Number.isFinite(vol) ? vol : 0;
      buckets.set(bucketStart, bucket);
    });
    return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
  }
  const _geckoBucketMs = typeof geckoBucketMs === 'function' ? geckoBucketMs : _geckoBucketMsLocal;
  const _bucketGeckoSeries = typeof bucketGeckoSeries === 'function' ? bucketGeckoSeries : _bucketGeckoSeriesLocal;

  const CORE_SIGNAL_KEYS = ['hma', 'vwma', 'rsi', 'ema', 'sma', 'obv', 'volume', 'momentum', 'bands', 'persistence', 'structure', 'macd', 'stochrsi', 'adx', 'ichimoku', 'williamsR', 'mfi', 'vwap', 'supertrend', 'cci', 'cmf', 'fisher', 'keltner'];
  const MICRO_SIGNAL_KEYS = ['book', 'flow', 'toxicity', 'spoof', 'iceberg', 'orderBookImbalance', 'imbalanceVelocity', 'liquidityDepth', 'liquidityVacuum', 'fundingRate'];
  const SIGNAL_LABELS = {
    rsi: 'RSI',
    ema: 'EMA Cross',
    hma: 'Hull MA',
    vwma: 'VWMA',
    vwap: 'VWAP',
    obv: 'OBV',
    volume: 'Volume Flow',
    momentum: 'Momentum',
    bands: 'Band Pressure',
    persistence: 'Trend Persistence',
    structure: 'Support/Resistance',
    book: 'Order Book',
    flow: 'Tape Flow',
    toxicity: 'Flow Toxicity',
    spoof: 'Spoofing Risk',
    iceberg: 'Iceberg Absorption',
    orderBookImbalance: '10/20L Book Imbalance',
    imbalanceVelocity: 'Imbalance Velocity',
    liquidityDepth: 'Liquidity Depth',
    liquidityVacuum: 'Liquidity Vacuum',
    fundingRate: 'Funding Pressure',
    macd: 'MACD',
    stochrsi: 'Stoch RSI',
    adx: 'ADX',
    ichimoku: 'Ichimoku',
    williamsR: 'Williams %R',
    mfi: 'MFI',
    mktSentiment: 'Prediction Markets',
  };
  const BACKTEST_THRESHOLD_GRID = [0.08, 0.10, 0.12, 0.16, 0.20];
  const BACKTEST_AGREEMENT_GRID = [0.50, 0.54, 0.58];
  // ALWAYS-TRADE MODE — every coin live, tiny minEdge; size risk elsewhere.
  // User preference 2026-08-02: more bets, always able to take a side.
  const ALWAYS_TRADE_MODE = true;
  const TRADING_POLICY = {
    BTC: { trade: true, paper: false, sessionPrefer: [], minEdge: 0.01 },
    ETH: { trade: true, paper: false, sessionPrefer: [], minEdge: 0.01 },
    SOL: { trade: true, paper: false, sessionPrefer: [], minEdge: 0.01 },
    XRP: { trade: true, paper: false, sessionPrefer: [], minEdge: 0.01 },
    BNB: { trade: true, paper: false, sessionPrefer: [], minEdge: 0.01 },
    DOGE: { trade: true, paper: false, sessionPrefer: [], minEdge: 0.01 },
    HYPE: { trade: true, paper: false, sessionPrefer: [], minEdge: 0.01 },
  };
  window.TRADING_POLICY = TRADING_POLICY;
  window.ALWAYS_TRADE_MODE = ALWAYS_TRADE_MODE;

  const BACKTEST_FILTER_OVERRIDES = {
    // Calibrated via Walk-Forward Backtest (2026-08-13): tight filters prevent noise flips on 5m candles.
    BTC: { h1: { entryThreshold: 0.30, minAgreement: 0.58 }, h5: { entryThreshold: 0.30, minAgreement: 0.58 }, h10: { entryThreshold: 0.30, minAgreement: 0.58 }, h15: { entryThreshold: 0.28, minAgreement: 0.58 } },
    ETH: { h1: { entryThreshold: 0.30, minAgreement: 0.58 }, h5: { entryThreshold: 0.30, minAgreement: 0.58 }, h10: { entryThreshold: 0.30, minAgreement: 0.58 }, h15: { entryThreshold: 0.28, minAgreement: 0.58 } },
    XRP: { h1: { entryThreshold: 0.30, minAgreement: 0.58 }, h5: { entryThreshold: 0.30, minAgreement: 0.58 }, h10: { entryThreshold: 0.28, minAgreement: 0.58 }, h15: { entryThreshold: 0.25, minAgreement: 0.58 } },
    SOL: { h1: { entryThreshold: 0.30, minAgreement: 0.58 }, h5: { entryThreshold: 0.30, minAgreement: 0.58 }, h10: { entryThreshold: 0.30, minAgreement: 0.58 }, h15: { entryThreshold: 0.25, minAgreement: 0.58 } },
    BNB: { h1: { entryThreshold: 0.30, minAgreement: 0.58 }, h5: { entryThreshold: 0.30, minAgreement: 0.58 }, h10: { entryThreshold: 0.30, minAgreement: 0.58 }, h15: { entryThreshold: 0.28, minAgreement: 0.58 } },
    DOGE: { h1: { entryThreshold: 0.30, minAgreement: 0.58 }, h5: { entryThreshold: 0.30, minAgreement: 0.58 }, h10: { entryThreshold: 0.30, minAgreement: 0.58 }, h15: { entryThreshold: 0.28, minAgreement: 0.58 } },
    HYPE: { h1: { entryThreshold: 0.30, minAgreement: 0.58 }, h5: { entryThreshold: 0.30, minAgreement: 0.58 }, h10: { entryThreshold: 0.30, minAgreement: 0.58 }, h15: { entryThreshold: 0.28, minAgreement: 0.58 } },
  };
  const ORBITAL_ROUTER_PROFILES = {
    core: {
      benchmarkWeight: 1.10,
      trendWeight: 1.08,
      momentumWeight: 0.96,
      structureWeight: 1.04,
      microWeight: 0.86,
      timingWeight: 0.78,
      derivativeWeight: 0.92,
      historyWeight: 1.06,
      riskWeight: 0.92,
      tradeNet: 0.34,
      tradeRisk: 0.92,
      watchNet: 0.15,
      invalidateRisk: 1.64,
    },
    momentum: {
      benchmarkWeight: 0.98,
      trendWeight: 1.02,
      momentumWeight: 1.08,
      structureWeight: 0.96,
      microWeight: 1.04,
      timingWeight: 1.12,
      derivativeWeight: 1.04,
      historyWeight: 0.92,
      riskWeight: 0.94,
      tradeNet: 0.32,
      tradeRisk: 0.88,
      watchNet: 0.14,
      invalidateRisk: 1.56,
    },
    highBeta: {
      benchmarkWeight: 0.98,
      trendWeight: 1.02,
      momentumWeight: 1.10,
      structureWeight: 0.96,
      microWeight: 0.96,
      timingWeight: 1.02,
      derivativeWeight: 0.98,
      historyWeight: 0.98,
      riskWeight: 1.08,
      tradeNet: 0.42,
      tradeRisk: 0.74,
      watchNet: 0.18,
      invalidateRisk: 1.28,
    },
  };
  const BACKTEST_STARTING_EQUITY = 100;
  const BACKTEST_MIN_TRAIN_OBS = 36;
  const BACKTEST_LOOKBACK_OBS = 160;
  const BACKTEST_MIN_REGIME_OBS = 18;
  const LIVE_DATA_TTL_MS = 870000;        // 14.5 min — candle cache stays valid across the full 15-min window
  // ── Live-path performance profile (Canada node / 24-7 Electron) ──────────
  // Walk-forward was 4 horizons × 250 steps × buildSignalModel(400 bars) →
  // main-thread freezes and 25s prediction timeouts. Keep signal quality,
  // cut redundant history that doesn't improve 5m/15m Polymarket decisions.
  const PERF = {
    candle1mLimit: 120,          // was 180
    candle5mLimit: 150,          // was 300
    candle15mLimit: 120,         // was 300
    maxBacktestSteps: 120,       // was 250
    backtestWindowBars: 200,     // was 400
    firstPassTimeoutMs: 14000,   // slightly tighter than prior 20s-class caps when defined
  };
  let geckoRequestQueue = Promise.resolve();
  let lastGeckoRequestAt = 0;
  let lastExchangeRequestAt = 0;

  // ================================================================
  // SESSION TIMING (real-world market dynamics)
  // ================================================================

  function getSessionInfo() {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const t = utcH + utcM / 60;

    // Session windows (UTC)
    const sessions = {
      asia_open: { start: 0, end: 2, label: 'Asia Open', scalp: true, desc: 'Tokyo/Seoul open — high volatility spike, scalp-friendly' },
      asia_mid: { start: 2, end: 6, label: 'Asia Session', scalp: false, desc: 'Mid-session Asia — liquidity thinning' },
      london_open: { start: 7, end: 9, label: 'London Open', scalp: true, desc: 'London/EU open — biggest volume surge, prime scalp window' },
      london_mid: { start: 9, end: 12, label: 'London Session', scalp: false, desc: 'EU active — steady directional flow' },
      ny_open: { start: 13, end: 15.5, label: 'NY Open', scalp: true, desc: 'NYSE open overlap — maximum liquidity, sharpest moves' },
      ny_mid: { start: 15.5, end: 18, label: 'NY Session', scalp: false, desc: 'US afternoon — momentum continuation or reversal' },
      ny_close: { start: 18, end: 21, label: 'NY Close', scalp: true, desc: 'NYSE close — position squaring, mean-reversion scalps' },
      dead_zone: { start: 21, end: 24, label: 'Dead Zone', scalp: false, desc: 'Low liquidity — avoid scalping, wide spreads' },
    };

    let current = sessions.dead_zone;
    for (const [, s] of Object.entries(sessions)) {
      if (t >= s.start && t < s.end) { current = s; break; }
    }

    // Next scalp window
    const scalpWindows = Object.values(sessions).filter(s => s.scalp);
    let nextScalp = null;
    for (const sw of scalpWindows) {
      if (sw.start > t) { nextScalp = sw; break; }
    }
    if (!nextScalp) nextScalp = scalpWindows[0]; // wrap to next day

    const minsToNext = nextScalp.start > t
      ? Math.round((nextScalp.start - t) * 60)
      : Math.round((24 - t + nextScalp.start) * 60);

    return { current, nextScalp, minsToNext, utcHour: utcH, localHour: now.getHours() };
  }

  // Returns info about the next 15-minute candle boundary
  function getNextCandleSession() {
    const now = new Date();
    const utcMin = now.getUTCMinutes();
    const utcSec = now.getUTCSeconds();
    const minsIntoSlot = utcMin % 15;
    const secsIntoSlot = minsIntoSlot * 60 + utcSec;
    const slotDurationSec = 15 * 60;
    const secsRemaining = slotDurationSec - secsIntoSlot;
    const minsRemaining = Math.ceil(secsRemaining / 60);

    // Current slot open time (floor to last 15-min boundary)
    const currentSlotMs = now.getTime() - secsIntoSlot * 1000;
    const nextSlotMs = currentSlotMs + slotDurationSec * 1000;
    const nextSlotClose = nextSlotMs + slotDurationSec * 1000;

    // How mature is the current session (0 = just opened, 1 = about to close)
    const maturity = secsIntoSlot / slotDurationSec;

    return {
      minsRemaining,             // mins until current 15-min candle closes & next opens
      nextOpen: new Date(nextSlotMs).toISOString(),
      nextClose: new Date(nextSlotClose).toISOString(),
      maturity: parseFloat(maturity.toFixed(3)), // 0.0–1.0
      freshEntry: maturity < 0.20,               // first 3 min of slot — best entry
      lateEntry: maturity > 0.80,                // last 3 min — stale, avoid
    };
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function withSoftTimeout(promise, timeoutMs, fallbackValue) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(fallbackValue), Math.max(1, Number(timeoutMs) || 1));
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  // ── Phase 1: fast initial load (Coinbase + Binance, ~1-3 s) ─────────────────
  // Populates candleCache so runAll() can score immediately.  Results include
  // raw _cb*/_bin* arrays so Phase 2 enrichment can merge without re-fetching.
  async function loadCoinData(coin) {
    try {
      const existing = candleCache[coin.sym] || {};
      const hasFreshLiveData = Array.isArray(existing.candles)
        && existing.candles.length >= 60
        && (Date.now() - (existing.ts || 0) < LIVE_DATA_TTL_MS);
      if (hasFreshLiveData) return;
      const hasLongHistory = Array.isArray(existing.longHistory) && existing.longHistory.length >= 90 && (Date.now() - (existing.longHistoryTs || 0) < 12 * 60 * 60 * 1000);
      const retainedLongHistory = hasLongHistory ? existing.longHistory : (existing.longHistory || []);

      if (GECKO_ONLY.has(coin.sym)) {
        // HYPE / BNB: prioritize Coinbase + Binance, keep Gecko as low-rate fallback.
        const [market, bin1m, bin5m, bin15m, cb1m, cb5m, cb15m, cbBook] = await Promise.all([
          withSoftTimeout(
            fetchGeckoJSON(`/coins/${coin.geckoId}/market_chart?vs_currency=usd&days=1`).catch(() => null),
            GECKO_MARKET_SOFT_TIMEOUT_MS,
            null
          ),
          fetchBINCandles(coin.sym, '1m', PERF.candle1mLimit).catch(() => []),
          fetchBINCandles(coin.sym, '5m', PERF.candle5mLimit).catch(() => []),
          fetchBINCandles(coin.sym, '15m', PERF.candle15mLimit).catch(() => []),
          fetchCBExchCandles(coin.sym, 60, PERF.candle1mLimit).catch(() => []),
          fetchCBExchCandles(coin.sym, 300, PERF.candle5mLimit).catch(() => []),
          fetchCBExchCandles(coin.sym, 900, PERF.candle15mLimit).catch(() => []),
          fetchCBExchBook(coin.sym).catch(() => null),
        ]);
        const prices = Array.isArray(market?.prices) ? market.prices : [];
        const volumes = Array.isArray(market?.total_volumes) ? market.total_volumes : [];
        const gecko5m = _bucketGeckoSeries(prices, volumes, _geckoBucketMs('5m'));
        const gecko15m = _bucketGeckoSeries(prices, volumes, _geckoBucketMs('15m'));
        const ws15m = window.CandleWS ? window.CandleWS.getClosedBuckets15m(coin.sym) : [];
        const ws1m = window.CandleWS ? window.CandleWS.getClosedBuckets1m(coin.sym) : [];
        const candles = anchoredPoolCandles(cb5m, bin5m, gecko5m);
        const candles15m = anchoredPoolCandles(ws15m, cb15m, bin15m, gecko15m);
        const candles1m = anchoredPoolCandles(ws1m, cb1m, bin1m);
        if (!candles.length && Array.isArray(existing.candles) && existing.candles.length) {
          candleCache[coin.sym] = existing;
          return;
        }
        const latestPrice = cb5m.length ? cb5m[cb5m.length - 1].c
          : prices.length ? Number(prices[prices.length - 1][1]) : (candles[candles.length - 1]?.c || existing.ticker?.usd || 0);
        const firstPrice = prices.length ? Number(prices[0][1]) : (candles[0]?.o || latestPrice);
        const totalVolume = volumes.length
          ? volumes.reduce((s, p) => s + Number(p?.[1] || 0), 0)
          : candles.reduce((s, c) => s + Number(c.v || 0), 0);
        const ticker = { usd: latestPrice, usd_24h_change: firstPrice > 0 ? ((latestPrice - firstPrice) / firstPrice) * 100 : 0, usd_24h_vol: totalVolume };
        const book = cbBook?.bids?.length ? cbBook : null;
        const sourceParts = [];
        if (cb5m.length || cb1m.length) sourceParts.push('coinbase');
        if (bin5m.length || bin1m.length) sourceParts.push('binance');
        if (window.BlockchainScan?.get?.(coin.sym)) sourceParts.push('blockchain');
        sourceParts.push('coingecko');
        candleCache[coin.sym] = {
          candles, candles15m, candles1m, ticker, book, trades: [],
          source: sourceParts.filter(Boolean).join(' + '),
          ts: Date.now(),
          longHistory: retainedLongHistory,
          longHistoryTs: retainedLongHistory?.length ? (existing.longHistoryTs || Date.now()) : 0,
          _cb1m: cb1m, _cb5m: cb5m, _cb15m: cb15m,
          _bin1m: bin1m, _bin5m: bin5m, _bin15m: bin15m,
          _gecko5m: gecko5m, _gecko15m: gecko15m,
        };
      } else {
        // BTC / ETH / SOL / XRP / DOGE: Coinbase + Binance only
        const [bin1m, bin5m, bin15m, cb1m, cb5m, cb15m, cbBook, cbTrades] = await Promise.all([
          fetchBINCandles(coin.sym, '1m', PERF.candle1mLimit).catch(() => []),
          fetchBINCandles(coin.sym, '5m', PERF.candle5mLimit).catch(() => []),
          fetchBINCandles(coin.sym, '15m', PERF.candle15mLimit).catch(() => []),
          fetchCBExchCandles(coin.sym, 60, PERF.candle1mLimit).catch(() => []),
          fetchCBExchCandles(coin.sym, 300, PERF.candle5mLimit).catch(() => []),
          fetchCBExchCandles(coin.sym, 900, PERF.candle15mLimit).catch(() => []),
          fetchCBExchBook(coin.sym).catch(() => null),
          fetchCBExchTrades(coin.sym).catch(() => []),
        ]);
        const ws15m_b = window.CandleWS ? window.CandleWS.getClosedBuckets15m(coin.sym) : [];
        const ws1m = window.CandleWS ? window.CandleWS.getClosedBuckets1m(coin.sym) : [];
        const candles5m = anchoredPoolCandles(cb5m, bin5m);
        const candles15m = anchoredPoolCandles(ws15m_b, cb15m, bin15m);
        console.log(`[15mPool DEBUG majors] ${coin.sym} | cb15m:${cb15m.length} bin15m:${bin15m.length} ws15m:${ws15m_b.length} pooled15m:${candles15m.length} | cb5m:${cb5m.length} bin5m:${bin5m.length}`);
        if (candles15m.length === 0) {
          console.warn(`[15mPool] ${coin.sym} 15m pooling got 0 bars - check WS connection and 15m REST fetches. Errors above may indicate rate limits or proxy blocks.`);
        }
        const candles1m = anchoredPoolCandles(ws1m, cb1m, bin1m);
        // If exchange APIs returned nothing, keep existing cache rather than blanking it
        if (!candles5m.length) {
          if (Array.isArray(existing.candles) && existing.candles.length) {
            candleCache[coin.sym] = existing;
            return;
          }
          throw new Error('No exchange candles available');
        }
        const sourceParts = [];
        if (cb5m.length || cb1m.length) sourceParts.push('coinbase');
        if (bin5m.length || bin1m.length) sourceParts.push('binance');
        candleCache[coin.sym] = {
          candles: candles5m, candles15m, candles1m,
          book: cbBook, trades: cbTrades,
          source: sourceParts.join(' + ') + (candles15m.length ? ' +15m-pooled' : ''),
          ts: Date.now(),
          longHistory: retainedLongHistory,
          longHistoryTs: retainedLongHistory?.length ? (existing.longHistoryTs || Date.now()) : 0,
          _cb1m: cb1m, _cb5m: cb5m, _cb15m: cb15m,
          _bin1m: bin1m, _bin5m: bin5m, _bin15m: bin15m,
        };
      }
    } catch (err) {
      console.warn(`[loadCoinData] ${coin.sym}:`, err.message);
    }
  }

  // ── Phase 2: background enrichment (slow proxy-routed sources, 30 s later) ──
  // Merges CDC / MEXC / Bybit / KuCoin / Bitfinex / Kraken data with the CB+BIN
  // anchor already in candleCache, then re-scores the coin silently.
  async function enrichCoinDataBackground(coin) {
    try {
      const existing = candleCache[coin.sym] || {};
      const cb1m = existing._cb1m || [];
      const cb5m = existing._cb5m || [];
      const cb15m = existing._cb15m || [];
      const bin1m = existing._bin1m || [];
      const bin5m = existing._bin5m || [];
      const bin15m = existing._bin15m || [];

      if (GECKO_ONLY.has(coin.sym)) {
        const hasLongHistory = Array.isArray(existing.longHistory) && existing.longHistory.length >= 90 && (Date.now() - (existing.longHistoryTs || 0) < 12 * 60 * 60 * 1000);
        const [mexc1m, mexc5m, mexc15m, mexcBook, bybit1m, bybit5m, bybit15m, bybitBook, kucoin1m, kucoin5m, kucoin15m, kucoinBook, bfnx1m, bfnx5m, bfnx15m, bfnxBook, krk1m, krk5m, krk15m, krkBook, longHistory] = await Promise.all([
          fetchMEXCCandles(coin, '1m', 180).catch(() => []),
          fetchMEXCCandles(coin, '5m', 300).catch(() => []),
          fetchMEXCCandles(coin, '15m', 300).catch(() => []),
          fetchMEXCBook(coin).catch(() => null),
          fetchBybitCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBybitCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBybitCandles(coin.sym, '15m', 300).catch(() => []),
          fetchBybitBook(coin.sym).catch(() => null),
          fetchKucoinCandles(coin.sym, '1m', 180).catch(() => []),
          fetchKucoinCandles(coin.sym, '5m', 300).catch(() => []),
          fetchKucoinCandles(coin.sym, '15m', 300).catch(() => []),
          fetchKucoinBook(coin.sym).catch(() => null),
          fetchBitfinexCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBitfinexCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBitfinexCandles(coin.sym, '15m', 300).catch(() => []),
          fetchBitfinexBook(coin.sym).catch(() => null),
          fetchKrakenCandles(coin.sym, '1m', 180).catch(() => []),
          fetchKrakenCandles(coin.sym, '5m', 300).catch(() => []),
          fetchKrakenCandles(coin.sym, '15m', 300).catch(() => []),
          fetchKrakenBook(coin.sym).catch(() => null),
          hasLongHistory ? Promise.resolve(existing.longHistory) : fetchGeckoMaxHistory(coin.geckoId, coin.sym).catch(() => existing.longHistory || []),
        ]);
        const gecko5m = existing._gecko5m || [];
        const gecko15m = existing._gecko15m || [];
        const ws15m = window.CandleWS ? window.CandleWS.getClosedBuckets15m(coin.sym) : [];
        const ws1m = window.CandleWS ? window.CandleWS.getClosedBuckets1m(coin.sym) : [];
        const candles = anchoredPoolCandles(cb5m, gecko5m, bin5m, mexc5m, bybit5m, kucoin5m, bfnx5m, krk5m);
        const candles15m = anchoredPoolCandles(ws15m, cb15m, gecko15m, bin15m, mexc15m, bybit15m, kucoin15m, bfnx15m, krk15m);
        const candles1m = anchoredPoolCandles(ws1m, cb1m, bin1m, mexc1m, bybit1m, kucoin1m, bfnx1m, krk1m);
        if (!candles.length) return;
        const book = existing.book?.bids?.length ? existing.book
          : bybitBook?.bids?.length ? bybitBook : kucoinBook?.bids?.length ? kucoinBook
            : bfnxBook?.bids?.length ? bfnxBook : krkBook?.bids?.length ? krkBook : null;
        const srcBase = (existing.source || '').split(' + ');
        if (mexc5m.length || mexc1m.length) srcBase.push('mexc');
        if (bybit5m.length || bybit1m.length) srcBase.push('bybit');
        if (kucoin5m.length || kucoin1m.length) srcBase.push('kucoin');
        if (bfnx5m.length || bfnx1m.length) srcBase.push('bitfinex');
        if (krk5m.length || krk1m.length) srcBase.push('kraken');
        candleCache[coin.sym] = {
          ...existing, candles, candles15m, candles1m, book,
          source: [...new Set(srcBase)].filter(Boolean).join(' + '),
          ts: Date.now(),
          longHistory: longHistory || existing.longHistory || [],
          longHistoryTs: longHistory?.length ? Date.now() : (existing.longHistoryTs || 0),
        };
      } else {
        const hasLongHistory = Array.isArray(existing.longHistory) && existing.longHistory.length >= 90 && (Date.now() - (existing.longHistoryTs || 0) < 12 * 60 * 60 * 1000);
        const [cdc1m, cdc5m, cdc15m, cdcBook, cdcTrades, mexc1m, mexc5m, mexc15m, mexcBook, mexcTrades, bybit1m, bybit5m, bybit15m, bybitBook, bybitTrades, kucoin1m, kucoin5m, kucoin15m, kucoinBook, kucoinTrades, bfnx1m, bfnx5m, bfnx15m, bfnxBook, bfnxTrades, krk1m, krk5m, krk15m, krkBook, krkTrades, longHistory] = await Promise.all([
          fetchCDCCandles(coin.instrument, '1m', 180).catch(() => []),
          fetchCDCCandles(coin.instrument, '5m', 300).catch(() => []),
          fetchCDCCandles(coin.instrument, '15m', 300).catch(() => []),
          fetchCDCBook(coin.instrument).catch(() => null),
          fetchCDCTrades(coin.instrument).catch(() => []),
          fetchMEXCCandles(coin, '1m', 180).catch(() => []),
          fetchMEXCCandles(coin, '5m', 300).catch(() => []),
          fetchMEXCCandles(coin, '15m', 300).catch(() => []),
          fetchMEXCBook(coin).catch(() => null),
          fetchMEXCTrades(coin).catch(() => []),
          fetchBybitCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBybitCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBybitCandles(coin.sym, '15m', 300).catch(() => []),
          fetchBybitBook(coin.sym).catch(() => null),
          fetchBybitTrades(coin.sym).catch(() => []),
          fetchKucoinCandles(coin.sym, '1m', 180).catch(() => []),
          fetchKucoinCandles(coin.sym, '5m', 300).catch(() => []),
          fetchKucoinCandles(coin.sym, '15m', 300).catch(() => []),
          fetchKucoinBook(coin.sym).catch(() => null),
          fetchKucoinTrades(coin.sym).catch(() => []),
          fetchBitfinexCandles(coin.sym, '1m', 180).catch(() => []),
          fetchBitfinexCandles(coin.sym, '5m', 300).catch(() => []),
          fetchBitfinexCandles(coin.sym, '15m', 300).catch(() => []),
          fetchBitfinexBook(coin.sym).catch(() => null),
          fetchBitfinexTrades(coin.sym).catch(() => []),
          fetchKrakenCandles(coin.sym, '1m', 180).catch(() => []),
          fetchKrakenCandles(coin.sym, '5m', 300).catch(() => []),
          fetchKrakenCandles(coin.sym, '15m', 300).catch(() => []),
          fetchKrakenBook(coin.sym).catch(() => null),
          fetchKrakenTrades(coin.sym).catch(() => []),
          hasLongHistory ? Promise.resolve(existing.longHistory) : fetchGeckoMaxHistory(coin.geckoId, coin.sym).catch(() => existing.longHistory || []),
        ]);
        const ws15m_b = window.CandleWS ? window.CandleWS.getClosedBuckets15m(coin.sym) : [];
        const ws1m = window.CandleWS ? window.CandleWS.getClosedBuckets1m(coin.sym) : [];
        const candles5m = anchoredPoolCandles(cb5m, cdc5m, mexc5m, bin5m, bybit5m, kucoin5m, bfnx5m, krk5m);
        const candles15m = anchoredPoolCandles(ws15m_b, cb15m, cdc15m, mexc15m, bin15m, bybit15m, kucoin15m, bfnx15m, krk15m);
        const candles1m = anchoredPoolCandles(ws1m, cb1m, cdc1m, mexc1m, bin1m, bybit1m, kucoin1m, bfnx1m, krk1m);
        if (!candles5m.length) return;
        const book = existing.book?.bids?.length ? existing.book
          : cdcBook?.bids?.length ? cdcBook : mexcBook?.bids?.length ? mexcBook
            : bybitBook?.bids?.length ? bybitBook : kucoinBook?.bids?.length ? kucoinBook
              : bfnxBook?.bids?.length ? bfnxBook : krkBook?.bids?.length ? krkBook : null;
        const trades = existing.trades?.length ? existing.trades
          : cdcTrades.length ? cdcTrades : mexcTrades.length ? mexcTrades
            : bybitTrades.length ? bybitTrades : kucoinTrades.length ? kucoinTrades
              : bfnxTrades.length ? bfnxTrades : krkTrades;
        const sourceParts = (existing.source || '').split(' + ');
        if (cdc5m.length || cdc1m.length) sourceParts.push('crypto.com');
        if (mexc5m.length || mexc1m.length) sourceParts.push('mexc');
        if (bybit5m.length || bybit1m.length) sourceParts.push('bybit');
        if (kucoin5m.length || kucoin1m.length) sourceParts.push('kucoin');
        if (bfnx5m.length || bfnx1m.length) sourceParts.push('bitfinex');
        if (krk5m.length || krk1m.length) sourceParts.push('kraken');
        candleCache[coin.sym] = {
          ...existing,
          candles: candles5m, candles15m, candles1m, book, trades,
          source: [...new Set(sourceParts)].filter(Boolean).join(' + '),
          ts: Date.now(), longHistory,
          longHistoryTs: longHistory?.length ? Date.now() : (existing.longHistoryTs || 0),
        };
      }
      // Re-score this coin with the enriched data
      window._backtests[coin.sym] = runWalkForwardBacktest(coin);
      window._predictions[coin.sym] = preservePredictionOverlay(
        window._predictions[coin.sym],
        computePrediction(coin, window._backtests[coin.sym])
      );
    } catch (err) {
      console.warn(`[enrichCoinDataBackground] ${coin.sym}:`, err.message);
    }
  }

  function preservePredictionOverlay(previousPrediction, nextPrediction) {
    if (!nextPrediction || typeof nextPrediction !== 'object') return nextPrediction;
    const prev = previousPrediction && typeof previousPrediction === 'object' ? previousPrediction : null;
    if (!prev) return nextPrediction;

    if (prev.llm && typeof prev.llm === 'object' && !nextPrediction.llm) {
      nextPrediction.llm = { ...prev.llm };
    }

    if (prev.tide && typeof prev.tide === 'object' && !nextPrediction.tide) {
      nextPrediction.tide = { ...prev.tide };
    }

    // Preserve backtest if missing in nextPrediction
    const symKey = String(nextPrediction.sym || prev.sym || '').toUpperCase();
    if (!nextPrediction.backtest && prev.backtest) {
      nextPrediction.backtest = prev.backtest;
    }
    if (!nextPrediction.backtest && symKey && window._backtests?.[symKey]) {
      nextPrediction.backtest = window._backtests[symKey];
    }

    // Preserve holderMetrics if missing in nextPrediction
    if (!nextPrediction.holderMetrics && prev.holderMetrics) {
      nextPrediction.holderMetrics = prev.holderMetrics;
    }
    if (!nextPrediction.holderMetrics && symKey && window.HolderMetrics?._cachedMetrics?.[symKey]) {
      const hm = window.HolderMetrics._cachedMetrics[symKey];
      if (hm && Date.now() - (hm.ts || 0) < 180_000) {
        nextPrediction.holderMetrics = {
          concentration: hm.concentration,
          source: hm.source,
          holderCount: hm.holderCount,
          holderScoreContribution: (window.HolderMetrics.score?.(hm) || 0) * 0.10,
        };
      }
    }

    if (prev.diagnostics && typeof prev.diagnostics === 'object') {
      nextPrediction.diagnostics = {
        ...(nextPrediction.diagnostics || {}),
        qualityLabel: nextPrediction.diagnostics?.qualityLabel ?? prev.diagnostics.qualityLabel ?? (nextPrediction.backtest?.summary?.label ? `Backtest ${nextPrediction.backtest.summary.label.toLowerCase()}` : null),
        tradeFitLabel: nextPrediction.diagnostics?.tradeFitLabel ?? prev.diagnostics.tradeFitLabel ?? nextPrediction.backtest?.summary?.tradeFitLabel ?? null,
        reliability: nextPrediction.diagnostics?.reliability ?? prev.diagnostics.reliability ?? nextPrediction.backtest?.summary?.reliability ?? null,
        tradeFit: nextPrediction.diagnostics?.tradeFit ?? prev.diagnostics.tradeFit ?? nextPrediction.backtest?.summary?.tradeFit ?? null,
        preferredHorizon: nextPrediction.diagnostics?.preferredHorizon ?? prev.diagnostics.preferredHorizon ?? nextPrediction.backtest?.summary?.preferredHorizon ?? null,
        llmRegime: nextPrediction.diagnostics?.llmRegime ?? prev.diagnostics.llmRegime ?? null,
        llmConfidence: nextPrediction.diagnostics?.llmConfidence ?? prev.diagnostics.llmConfidence ?? null,
        llmWarnings: nextPrediction.diagnostics?.llmWarnings ?? prev.diagnostics.llmWarnings ?? [],
        llmDegraded: nextPrediction.diagnostics?.llmDegraded ?? prev.diagnostics.llmDegraded ?? null,
        llmCooldownRemainingMs: nextPrediction.diagnostics?.llmCooldownRemainingMs ?? prev.diagnostics.llmCooldownRemainingMs ?? null,
        llmSuggestedIncreases: nextPrediction.diagnostics?.llmSuggestedIncreases ?? prev.diagnostics.llmSuggestedIncreases ?? [],
        llmSuggestedDecreases: nextPrediction.diagnostics?.llmSuggestedDecreases ?? prev.diagnostics.llmSuggestedDecreases ?? [],
        llmNotes: nextPrediction.diagnostics?.llmNotes ?? prev.diagnostics.llmNotes ?? null,
        tideDirection: nextPrediction.diagnostics?.tideDirection ?? prev.diagnostics.tideDirection ?? null,
        tideConfidence: nextPrediction.diagnostics?.tideConfidence ?? prev.diagnostics.tideConfidence ?? null,
        tideForecastPrice: nextPrediction.diagnostics?.tideForecastPrice ?? prev.diagnostics.tideForecastPrice ?? null,
        tideMode: nextPrediction.diagnostics?.tideMode ?? prev.diagnostics.tideMode ?? null,
        tideQueued: nextPrediction.diagnostics?.tideQueued ?? prev.diagnostics.tideQueued ?? null,
        tideError: nextPrediction.diagnostics?.tideError ?? prev.diagnostics.tideError ?? null,
      };
    }

    return nextPrediction;
  }

  // ================================================================
  // TECHNICAL INDICATORS
  // ================================================================

  // Wilder's smoothed RSI (canonical 14-period).
  // Step 1: seed avgGain/avgLoss as the SMA of the first `period` differences.
  // Step 2: apply Wilder's exponential smoothing (alpha = 1/period) for all
  //         subsequent bars.  This matches TradingView / most charting packages.
  function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    // Seed — SMA of first `period` differences
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= period;
    avgLoss /= period;
    // Wilder's smoothing for all remaining bars
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  }

  function calcEMA(data, period) {
    const k = 2 / (period + 1);
    const ema = [data[0]];
    for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
    return ema;
  }

  // Simple Moving Average — unweighted average of last `period` bars
  function calcSMA(data, period) {
    const sma = [];
    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - period + 1);
      const slice = data.slice(start, i + 1);
      sma.push(slice.reduce((s, v) => s + v, 0) / slice.length);
    }
    return sma;
  }

  // ── Chainlink TWAP / Time-Weighted Aggregation ──────────────────────────────
  // Aggregates 1m candles into coarser timeframes (5m, 10m, 15m) using time-weighted averaging
  // aligned to Chainlink 60s/30s TWAP benchmark standards.
  function aggregateToTWAP(candles1m, barSize = 5) {
    if (!candles1m || candles1m.length === 0) return [];

    const twapCandles = [];
    for (let i = 0; i < candles1m.length; i += barSize) {
      const slice = candles1m.slice(i, i + barSize);
      if (slice.length === 0) continue;

      const barsNeeded = slice.length;
      const twapClose = slice.reduce((sum, c) => sum + c.c, 0) / barsNeeded;

      // OHLCV aggregated with TWAP close
      const twapBar = {
        t: slice[0].t,
        o: slice[0].o,
        h: Math.max(...slice.map(c => c.h)),
        l: Math.min(...slice.map(c => c.l)),
        c: twapClose,  // Chainlink TWAP close
        v: slice.reduce((sum, c) => sum + (c.v || 0), 0),
      };

      twapCandles.push(twapBar);
    }

    return twapCandles;
  }
  const aggregateToRTI = aggregateToTWAP; // compat alias

  // Helper: Decide whether to use 1m TWAP aggregation or standard 5m candles
  function shouldUseTWAPAggregation(horizonMin, candles1mAvailable) {
    return horizonMin <= 5 && candles1mAvailable && candles1mAvailable.length >= 30;
  }
  const shouldUseRTIAggregation = shouldUseTWAPAggregation; // compat alias

  // ── Hull Moving Average ────────────────────────────────────────────────────
  // WMA helper (linearly weighted, most-recent bars get highest weight).
  function calcWMA(data, period) {
    const result = [];
    const denom = (period * (period + 1)) / 2;
    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - period + 1);
      const slice = data.slice(start, i + 1);
      const p = slice.length;
      const d = p === period ? denom : (p * (p + 1)) / 2;
      result.push(slice.reduce((s, v, j) => s + v * (j + 1), 0) / d);
    }
    return result;
  }

  // Hull Moving Average: WMA( 2×WMA(n/2) − WMA(n), floor(√n) )
  // Nearly lag-free vs EMA — primary trend filter for 15m binary predictions.
  // Default period 16 → half=8, smoothing=4 — tuned for 15m crypto candles.
  function calcHMA(data, period = 16) {
    if (data.length < 4) return data.map(() => data[data.length - 1] ?? 0);
    const half = Math.max(Math.floor(period / 2), 2);
    const sqrtN = Math.max(Math.floor(Math.sqrt(period)), 2);
    const wmaFull = calcWMA(data, period);
    const wmaHalf = calcWMA(data, half);
    const diff = wmaHalf.map((v, i) => 2 * v - wmaFull[i]);
    return calcWMA(diff, sqrtN);
  }

  // Volume-Weighted Moving Average: Σ(close_i × vol_i) / Σ(vol_i) over n bars.
  // High-volume candles dominate — pulls toward where real money moved.
  // Complements HMA: HMA gives direction, VWMA confirms volume conviction.
  function calcVWMA(candles, period = 20) {
    const result = [];
    for (let i = 0; i < candles.length; i++) {
      const start = Math.max(0, i - period + 1);
      const slice = candles.slice(start, i + 1);
      const sumPV = slice.reduce((s, c) => s + c.c * (c.v || 1), 0);
      const sumV = slice.reduce((s, c) => s + (c.v || 1), 0);
      result.push(sumV > 0 ? sumPV / sumV : candles[i].c);
    }
    return result;
  }

  // ── Supertrend (ATR-based trend direction) ─────────────────────────────────
  function calcSupertrend(candles, period, multiplier) {
    period = period || 10; multiplier = multiplier || 3.0;
    if (candles.length < period + 2) return { signal: 0, bullish: null };
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    }
    let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    const atrs = [atr];
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
      atrs.push(atr);
    }
    let finalUpper = 0, finalLower = 0, supertrend = 0, bullish = false;
    let initialized = false;
    for (let i = 0; i < atrs.length; i++) {
      const ci = candles[i + 1];
      const hl2 = (ci.h + ci.l) / 2;
      const rawUpper = hl2 + multiplier * atrs[i];
      const rawLower = hl2 - multiplier * atrs[i];
      const prevClose = candles[i].c;
      if (!initialized) {
        finalUpper = rawUpper; finalLower = rawLower;
        supertrend = rawUpper; bullish = false; initialized = true;
      } else {
        const newUpper = (rawUpper < finalUpper || prevClose > finalUpper) ? rawUpper : finalUpper;
        const newLower = (rawLower > finalLower || prevClose < finalLower) ? rawLower : finalLower;
        const prevST = supertrend;
        if (prevST === finalUpper) {
          bullish = ci.c > newUpper;
          supertrend = bullish ? newLower : newUpper;
        } else {
          bullish = ci.c >= newLower;
          supertrend = bullish ? newLower : newUpper;
        }
        finalUpper = newUpper; finalLower = newLower;
      }
    }
    return { signal: bullish ? 1 : -1, bullish, supertrend };
  }

  // ── Commodity Channel Index ────────────────────────────────────────────────
  function calcCCI(candles, period) {
    period = period || 14;
    if (candles.length < period) return 0;
    const slice = candles.slice(-period);
    const tps = slice.map(c => (c.h + c.l + c.c) / 3);
    const mean = tps.reduce((s, v) => s + v, 0) / period;
    const meanDev = tps.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
    return meanDev > 0.00001 ? clamp((tps[tps.length - 1] - mean) / (0.015 * meanDev), -500, 500) : 0;
  }

  // ── Chaikin Money Flow ─────────────────────────────────────────────────────
  function calcCMF(candles, period) {
    period = period || 20;
    if (candles.length < period) return 0;
    const slice = candles.slice(-period);
    let mfvSum = 0, volSum = 0;
    for (const c of slice) {
      const range = c.h - c.l;
      const vol = c.v || 1;
      const mfm = range > 0 ? ((c.c - c.l) - (c.h - c.c)) / range : 0;
      mfvSum += mfm * vol; volSum += vol;
    }
    return volSum > 0 ? mfvSum / volSum : 0;
  }

  // ── Fisher Transform ───────────────────────────────────────────────────────
  function calcFisher(candles, period) {
    period = period || 10;
    if (candles.length < period) return 0;
    const slice = candles.slice(-period);
    const hh = Math.max(...slice.map(c => c.h));
    const ll = Math.min(...slice.map(c => c.l));
    const close = candles[candles.length - 1].c;
    const range = hh - ll;
    let value = range > 0 ? 2 * ((close - ll) / range) - 1 : 0;
    value = Math.max(-0.999, Math.min(0.999, value));
    return 0.5 * Math.log((1 + value) / (1 - value));
  }

  // ── Keltner Channels ───────────────────────────────────────────────────────
  function calcKeltner(candles, period, mult) {
    period = period || 20; mult = mult || 2.0;
    if (candles.length < period) return { position: 0.5 };
    const closes = candles.map(c => c.c);
    const ema = calcEMA(closes, period);
    const middle = ema[ema.length - 1];
    const atr = calcATR(candles, period);
    const upper = middle + mult * atr;
    const lower = middle - mult * atr;
    const width = Math.max(upper - lower, middle * 0.0001);
    return { position: Math.max(0, Math.min(1, (closes[closes.length - 1] - lower) / width)) };
  }

  function calcVWAP(candles) {
    let cumVol = 0, cumTP = 0;
    return candles.map(c => {
      const tp = (c.h + c.l + c.c) / 3;
      const vol = c.v || 1;
      cumVol += vol; cumTP += tp * vol;
      return cumVol > 0 ? cumTP / cumVol : tp;
    });
  }

  function calcStdDev(arr, period) {
    if (arr.length < period) return 0;
    const slice = arr.slice(-period);
    const mean = slice.reduce((s, v) => s + v, 0) / period;
    return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  }

  function calcOBV(candles) {
    const obv = [0];
    for (let i = 1; i < candles.length; i++) {
      const vol = candles[i].v || 1;
      if (candles[i].c > candles[i - 1].c) obv.push(obv[i - 1] + vol);
      else if (candles[i].c < candles[i - 1].c) obv.push(obv[i - 1] - vol);
      else obv.push(obv[i - 1]);
    }
    return obv;
  }

  function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
    if (closes.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
    const emaFast = calcEMA(closes, fast);
    const emaSlow = calcEMA(closes, slow);
    const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
    const signalLine = calcEMA(macdLine, signalPeriod);
    const lastMACD = macdLine[macdLine.length - 1];
    const lastSignal = signalLine[signalLine.length - 1];
    return { macd: lastMACD, signal: lastSignal, histogram: lastMACD - lastSignal };
  }

  function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
    const needed = rsiPeriod + stochPeriod + Math.max(smoothK, smoothD) + 2;
    if (closes.length < needed) return { k: 50, d: 50 };
    const rsiValues = [];
    for (let i = rsiPeriod; i < closes.length; i++) {
      rsiValues.push(calcRSI(closes.slice(0, i + 1), rsiPeriod));
    }
    const rawK = [];
    for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
      const slice = rsiValues.slice(i - stochPeriod + 1, i + 1);
      const hi = Math.max(...slice);
      const lo = Math.min(...slice);
      rawK.push(hi !== lo ? ((rsiValues[i] - lo) / (hi - lo)) * 100 : 50);
    }
    if (!rawK.length) return { k: 50, d: 50 };
    const smoothedK = calcEMA(rawK, smoothK);
    const smoothedD = calcEMA(smoothedK, smoothD);
    return {
      k: smoothedK[smoothedK.length - 1],
      d: smoothedD[smoothedD.length - 1],
    };
  }

  function calcADX(candles, period = 14) {
    if (candles.length < period * 2 + 1) return { adx: 25, pdi: 25, mdi: 25 };
    const trs = [], plusDMs = [], minusDMs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
      const up = c.h - p.h, down = p.l - c.l;
      plusDMs.push(up > down && up > 0 ? up : 0);
      minusDMs.push(down > up && down > 0 ? down : 0);
    }
    const wilderSmooth = (arr, p) => {
      if (arr.length < p) return [arr.reduce((s, v) => s + v, 0)];
      let s = arr.slice(0, p).reduce((a, v) => a + v, 0);
      const out = [s];
      for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
      return out;
    };
    const atrS = wilderSmooth(trs, period);
    const pdiS = wilderSmooth(plusDMs, period);
    const mdiS = wilderSmooth(minusDMs, period);
    const dxArr = atrS.map((atr, i) => {
      const pdi = atr > 0 ? (pdiS[i] / atr) * 100 : 0;
      const mdi = atr > 0 ? (mdiS[i] / atr) * 100 : 0;
      const sum = pdi + mdi;
      return sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0;
    });
    const adxArr = wilderSmooth(dxArr, period);
    const li = adxArr.length - 1;
    const lastATR = atrS[li];
    return {
      adx: adxArr[li],
      pdi: lastATR > 0 ? (pdiS[li] / lastATR) * 100 : 0,
      mdi: lastATR > 0 ? (mdiS[li] / lastATR) * 100 : 0,
    };
  }

  function calcIchimoku(candles) {
    if (candles.length < 9) return { tenkan: 0, kijun: 0, spanA: 0, spanB: 0, cloudPos: 'inside' };
    const high = arr => Math.max(...arr.map(c => c.h));
    const low = arr => Math.min(...arr.map(c => c.l));
    const tenkan = (high(candles.slice(-9)) + low(candles.slice(-9))) / 2;
    const slice26 = candles.length >= 26 ? candles.slice(-26) : candles;
    const kijun = (high(slice26) + low(slice26)) / 2;
    const slice52 = candles.length >= 52 ? candles.slice(-52) : slice26;
    const spanA = (tenkan + kijun) / 2;
    const spanB = (high(slice52) + low(slice52)) / 2;
    const price = candles[candles.length - 1].c;
    const cloudTop = Math.max(spanA, spanB);
    const cloudBot = Math.min(spanA, spanB);
    const cloudPos = price > cloudTop ? 'above' : price < cloudBot ? 'below' : 'inside';
    return { tenkan, kijun, spanA, spanB, price, cloudPos, cloudTop, cloudBot };
  }

  function calcWilliamsR(candles, period = 14) {
    if (candles.length < period) return -50;
    const slice = candles.slice(-period);
    const hh = Math.max(...slice.map(c => c.h));
    const ll = Math.min(...slice.map(c => c.l));
    const close = candles[candles.length - 1].c;
    return hh !== ll ? ((hh - close) / (hh - ll)) * -100 : -50;
  }

  function calcMFI(candles, period = 14) {
    if (candles.length < period + 1) return 50;
    const slice = candles.slice(-period - 1);
    let posFlow = 0, negFlow = 0;
    for (let i = 1; i < slice.length; i++) {
      const prevTP = (slice[i - 1].h + slice[i - 1].l + slice[i - 1].c) / 3;
      const currTP = (slice[i].h + slice[i].l + slice[i].c) / 3;
      const rawFlow = currTP * (slice[i].v || 1);
      if (currTP > prevTP) posFlow += rawFlow;
      else if (currTP < prevTP) negFlow += rawFlow;
    }
    if (negFlow === 0) return posFlow > 0 ? 100 : 50;
    return 100 - 100 / (1 + posFlow / negFlow);
  }

  function calcATR(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    }
    return sum / period;
  }

  function calcBollinger(closes, period = 20, stdMult = 2) {
    if (closes.length < period) {
      const last = closes[closes.length - 1] || 0;
      return { middle: last, upper: last, lower: last, widthPct: 0, position: 0.5 };
    }
    const slice = closes.slice(-period);
    const middle = average(slice);
    const std = calcStdDev(closes, period);
    const upper = middle + std * stdMult;
    const lower = middle - std * stdMult;
    const width = Math.max(upper - lower, middle * 0.0001);
    const position = clamp((slice[slice.length - 1] - lower) / width, 0, 1);
    return {
      middle,
      upper,
      lower,
      widthPct: middle > 0 ? (width / middle) * 100 : 0,
      position,
    };
  }

  function calcTrendPersistence(closes, emaSeries, lookback = 8) {
    if (!closes.length || !emaSeries.length) return { aboveRate: 50, slopePct: 0, signal: 0, label: 'Neutral' };
    const span = Math.min(lookback, closes.length, emaSeries.length);
    const recentCloses = closes.slice(-span);
    const recentEma = emaSeries.slice(-span);
    const above = recentCloses.filter((close, idx) => close >= recentEma[idx]).length;
    const aboveRate = span ? (above / span) * 100 : 50;
    const emaStart = recentEma[0] || recentEma[recentEma.length - 1] || 1;
    const slopePct = emaStart ? ((recentEma[recentEma.length - 1] - emaStart) / emaStart) * 100 : 0;
    const signal = clamp(((aboveRate - 50) / 30) + slopePct * 4, -1, 1);
    const label = aboveRate >= 75 && slopePct > 0.04 ? 'Persistent uptrend'
      : aboveRate <= 25 && slopePct < -0.04 ? 'Persistent downtrend'
        : 'Mixed persistence';
    return { aboveRate, slopePct, signal, label };
  }

  function calcStructureBias(candles, atrPct) {
    if (!candles || candles.length < 12) {
      return { support: 0, resistance: 0, supportGapPct: 0, resistanceGapPct: 0, signal: 0, label: 'No structure', zone: 'none', bufferPct: atrPct || 0 };
    }
    const recent = candles.slice(-24);
    const latest = recent[recent.length - 1].c;
    const support = Math.min(...recent.map(c => c.l));
    const resistance = Math.max(...recent.map(c => c.h));
    const supportGapPct = latest > 0 ? ((latest - support) / latest) * 100 : 0;
    const resistanceGapPct = latest > 0 ? ((resistance - latest) / latest) * 100 : 0;
    const bufferPct = clamp(Math.max((atrPct || 0) * 1.25, 0.35), 0.35, 2.4);
    let zone = 'middle';
    let signal = 0;
    if (supportGapPct <= bufferPct && supportGapPct <= resistanceGapPct) {
      zone = 'support';
      signal = clamp((bufferPct - supportGapPct) / bufferPct, 0, 1) * 0.85;
    } else if (resistanceGapPct <= bufferPct && resistanceGapPct < supportGapPct) {
      zone = 'resistance';
      signal = -clamp((bufferPct - resistanceGapPct) / bufferPct, 0, 1) * 0.85;
    }
    const label = zone === 'support' ? 'Near support buffer'
      : zone === 'resistance' ? 'Near resistance buffer'
        : 'Inside range';
    return { support, resistance, supportGapPct, resistanceGapPct, signal, label, zone, bufferPct };
  }

  function slope(arr, n = 5) {
    if (arr.length < n + 1) return 0;
    const r = arr.slice(-n);
    const avg = (Math.abs(r[0]) + Math.abs(r[r.length - 1])) / 2 || 1;
    return ((r[r.length - 1] - r[0]) / avg) * 100;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // Live px for Polymarket binary settlement (Chainlink 30s TWAP). Official
  // Pyth Crypto.*/USD feeds stay as AI spot — they are not the 5m/15m oracle.
  function resolveLiveSettlementPx(sym, fallback) {
    const key = String(sym || '').toUpperCase();
    const rtds = window.PredictionMarkets?.getFreshRtdsTwap?.(key, 15_000);
    if (Number.isFinite(rtds?.price) && rtds.price > 0) return { px: rtds.price, src: 'rtds-twap30' };
    const twap = window.Microstructure?.getTwap?.(key, 30_000);
    if (Number.isFinite(twap) && twap > 0) return { px: twap, src: 'micro-twap30' };
    if (Number.isFinite(fallback) && fallback > 0) return { px: fallback, src: 'fallback' };
    return { px: null, src: null };
  }

  function studentT4CDF(t) {
    // Exact closed-form Student-t CDF for nu=4 degrees of freedom:
    // F(t) = 0.5 + (t / (2 * sqrt(t^2 + 4))) * (1 + 2 / (t^2 + 4))
    if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
    const denom = t * t + 4;
    return 0.5 + (t / (2 * Math.sqrt(denom))) * (1 + 2 / denom);
  }

  function getRegimeTailMultiplier(regimeName, burstPressure = 0) {
    if (burstPressure <= 0.35) return 1.0;
    const r = String(regimeName || '').toUpperCase();
    if (r.includes('HIGH') || r.includes('EXPLOSIVE') || r.includes('VOLATILE')) {
      return 1.58; // Regularized from 2.172x
    }
    if (r.includes('MID') || r.includes('ACCELERATING') || r.includes('TRENDING')) {
      return 1.21; // Regularized from 1.417x
    }
    if (r.includes('LOW') || r.includes('COMPRESSED') || r.includes('RANGING')) {
      return 1.05; // Anchored at 1.05x
    }
    return 1.85; // UNKNOWN regularized from 2.788x
  }

  // P(settle ≥ PTB) with time-decayed sigma. Lagging CEX score cannot invent a
  // late-window cross when live TWAP is on the wrong side of PTB.
  function computeBinaryPtbCdf({ ptb, livePx, windowMin, remainingMs, atrDollar, score, liveDir, momDir, regime, burstPressure }) {
    const windowMs = Math.max(60_000, Number(windowMin || 15) * 60_000);
    const remMs = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : windowMs;
    const remainingFrac = clamp(remMs / windowMs, 0.01, 1);
    const gap = livePx - ptb;
    const gapFrac = gap / ptb;
    const breakingUp = liveDir > 0 || momDir === 'UP';
    const breakingDown = liveDir < 0 || momDir === 'DOWN';
    const late = remainingFrac < 0.12;
    const ultraLate = remMs < 45_000;

    let expectedMove = (Number(score) || 0) * atrDollar * 0.35 * remainingFrac;
    if (late) expectedMove *= 0.15;
    if (ultraLate) expectedMove = 0;
    if (gap < 0 && expectedMove > 0 && !breakingUp) expectedMove = Math.min(expectedMove, Math.abs(gap) * 0.12);
    if (gap > 0 && expectedMove < 0 && !breakingDown) expectedMove = Math.max(expectedMove, -Math.abs(gap) * 0.12);

    const meanFinal = livePx + expectedMove;
    const sigma = Math.max(livePx * 0.00012, atrDollar * Math.sqrt(remainingFrac) * (late ? 0.32 : 0.48));
    const z = (meanFinal - ptb) / (sigma || 1);
    let pUp = normalCDF(z);

    // Overnight Asia Session Regularized Tail Risk Adjustment:
    // When burst pressure > 0.35, normal projections understate tail arrivals by 16.9%.
    // Enforce Student-t (nu=4) distribution with regularized regime tail factors.
    const bp = Number(burstPressure || 0);
    const tailMult = getRegimeTailMultiplier(regime, bp);
    if (bp > 0.35 && tailMult > 1.0) {
      const pStudent = studentT4CDF(z);
      const tailP = 0.5 + (pStudent - 0.5) * tailMult;
      pUp = clamp(tailP, 0.02, 0.98);
    }

    if (ultraLate && Math.abs(gapFrac) > 0.00008) {
      pUp = gap > 0 ? Math.max(pUp, 0.93) : Math.min(pUp, 0.07);
    } else if (remainingFrac < 0.20 && gap < 0 && !breakingUp) {
      pUp = Math.min(pUp, 0.18);
    } else if (remainingFrac < 0.20 && gap > 0 && !breakingDown) {
      pUp = Math.max(pUp, 0.82);
    } else if (gap < 0 && !breakingUp) {
      pUp = Math.min(pUp, 0.38);
    } else if (gap > 0 && !breakingDown) {
      pUp = Math.max(pUp, 0.62);
    }

    pUp = clamp(pUp, 0.02, 0.98);
    return {
      pUp,
      modelYesPct: Math.round(pUp * 100),
      meanFinal,
      sigma,
      remainingFrac,
      remainingMs: remMs,
      gap,
      gapFrac,
      livePx,
      ptb,
      expectedMove,
    };
  }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function horizonKey(horizonMin) {
    const exact = STATIC_HORIZONS.find(min => min === horizonMin);
    if (exact) return `h${exact}`;
    const fallback = STATIC_HORIZONS.find(min => horizonMin <= min) || STATIC_HORIZONS[STATIC_HORIZONS.length - 1];
    return `h${fallback}`;
  }

  function projectionKey(horizonMin) {
    return `p${horizonMin}`;
  }

  function defaultShortFilter(horizonMin) {
    return SHORT_HORIZON_FILTERS[horizonKey(horizonMin)] || SHORT_HORIZON_FILTERS.h15;
  }

  function inferBarMinutes(candles) {
    if (!candles || candles.length < 2) return 5;
    const diffs = [];
    for (let i = 1; i < candles.length; i++) {
      const delta = candles[i].t - candles[i - 1].t;
      if (delta > 0) diffs.push(delta / 60000);
    }
    if (!diffs.length) return 5;
    diffs.sort((a, b) => a - b);
    const mid = Math.floor(diffs.length / 2);
    return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
  }

  function confidenceFromScore(absScore) {
    if (absScore < 0.1) return Math.round(absScore * 100);
    return Math.round(Math.min(absScore * 120, 95));
  }

  function signalFromScore(score) {
    const absScore = Math.abs(score);
    // ALWAYS_TRADE: only pure zero is neutral — any lean becomes a side.
    const deadband = (typeof window !== 'undefined' && window.ALWAYS_TRADE_MODE) ? 0.01 : 0.12;
    if (absScore < deadband) return 'neutral';
    if (score > 0) return absScore > 0.45 ? 'strong_bull' : 'bullish';
    return absScore > 0.45 ? 'strong_bear' : 'bearish';
  }

  function directionFromScore(score, threshold = 0.04) {
    // ALWAYS_TRADE: tiny threshold so we rarely return FLAT.
    const t = (typeof window !== 'undefined' && window.ALWAYS_TRADE_MODE) ? 0.01 : threshold;
    return score > t ? 'UP' : score < -t ? 'DOWN' : 'FLAT';
  }

  function scoreBucket(absScore) {
    if (absScore >= 0.4) return 'strong';
    if (absScore >= 0.25) return 'moderate';
    if (absScore >= 0.1) return 'light';
    return 'neutral';
  }

  function summarizeAgreement(signalMap) {
    const values = Object.values(signalMap).filter(v => Math.abs(v) >= 0.08);
    if (!values.length) return { agreement: 0.5, conflict: 0, bulls: 0, bears: 0, active: 0, label: 'Balanced' };
    const bulls = values.filter(v => v > 0).length;
    const bears = values.filter(v => v < 0).length;
    const active = bulls + bears;
    const majority = Math.max(bulls, bears);
    const minority = Math.min(bulls, bears);
    const agreement = active ? majority / active : 0.5;
    const conflict = active ? minority / active : 0;
    let label = 'Balanced';
    if (conflict >= 0.45) label = 'High conflict';
    else if (agreement >= 0.8) label = bulls > bears ? 'Bull consensus' : bears > bulls ? 'Bear consensus' : 'Balanced';
    else if (agreement >= 0.6) label = bulls > bears ? 'Bull tilt' : bears > bulls ? 'Bear tilt' : 'Balanced';
    return { agreement, conflict, bulls, bears, active, label };
  }

  function defaultBacktestFilter(horizonMin, sym = null) {
    const key = horizonKey(horizonMin);
    let override = sym ? BACKTEST_FILTER_OVERRIDES[sym]?.[key] : null;

    // H15-TUNING: Apply h15-specific entry filters if available and horizon is h15
    if (horizonMin === 15 && window._h15Tuner) {
      const h15Override = window._h15Tuner.getTunedFilter(15, sym, override || defaultShortFilter(horizonMin));
      override = h15Override;
    }

    if (override) return override;
    return defaultShortFilter(horizonMin);
  }

  function getOrbitalRouterProfile(sym) {
    let key;
    if (['BTC', 'ETH', 'BNB', 'XRP'].includes(sym)) key = 'core';
    else if (['DOGE', 'HYPE'].includes(sym)) key = 'highBeta';
    else key = 'momentum';  // SOL + unknown coins
    const profile = { key, ...ORBITAL_ROUTER_PROFILES[key] };
    const atomic = window.ShellRouter?.getAtomicProfile?.(sym) || null;
    const atomicWeight = Number(atomic?.atomicWeightUsd || 0);
    const gravity = Number.isFinite(atomicWeight) && atomicWeight > 0
      ? clamp((Math.log10(atomicWeight) - 9) / 3, 0, 1)
      : 0.5;

    if (gravity >= 0.8) {
      profile.benchmarkWeight *= 1.06;
      profile.historyWeight *= 1.05;
      profile.momentumWeight *= 0.94;
      profile.microWeight *= 0.95;
    } else if (gravity <= 0.55) {
      profile.momentumWeight *= 1.08;
      profile.timingWeight *= 1.06;
      profile.derivativeWeight *= 1.04;
    }

    switch (atomic?.orbitalFocus) {
      case 'momentum':
        profile.momentumWeight *= 1.08;
        profile.timingWeight *= 1.04;
        break;
      case 'derivatives':
        profile.derivativeWeight *= 1.10;
        profile.microWeight *= 0.98;
        break;
      case 'sentiment':
        profile.timingWeight *= 1.08;
        profile.riskWeight *= 1.04;
        break;
      case 'core':
      case 'defi-base':
        profile.benchmarkWeight *= 1.04;
        profile.historyWeight *= 1.03;
        break;
      default:
        break;
    }

    profile.atomicProfile = atomic;
    profile.atomicWeightUsd = atomicWeight || null;
    profile.atomicGravity = gravity;
    return profile;
  }

  function applyRouterProfile(packet, profile) {
    if (!profile) return packet;
    let weight = 1;
    switch (packet.category) {
      case 'benchmark': weight = profile.benchmarkWeight; break;
      case 'trend': weight = profile.trendWeight; break;
      case 'momentum': weight = profile.momentumWeight; break;
      case 'structure': weight = profile.structureWeight; break;
      case 'microstructure': weight = profile.microWeight; break;
      case 'timing': weight = profile.timingWeight; break;
      case 'derivatives': weight = profile.derivativeWeight; break;
      case 'historical': weight = profile.historyWeight; break;
      default: weight = 1; break;
    }
    if (packet.role === 'risk') weight *= profile.riskWeight;
    return {
      ...packet,
      relevance: clamp((packet.relevance || 0.7) * weight, 0.18, 1),
    };
  }

  function classifyMarketRegime(model) {
    const emaCross = model?.indicators?.ema?.value ?? 0;
    const momentum = model?.indicators?.momentum?.value ?? 0;
    const vwapDev = model?.indicators?.vwap?.value ?? 0;
    const atrPct = model?.volatility?.atrPct ?? 0;

    let trend = 'range';
    if (emaCross > 0.12 && momentum > 0.18) trend = 'bull';
    else if (emaCross < -0.12 && momentum < -0.18) trend = 'bear';
    else if (Math.abs(vwapDev) > 1.4 && Math.sign(vwapDev) !== Math.sign(momentum || 0)) trend = 'meanrev';

    let vol = 'mid';
    if (atrPct >= 1.4) vol = 'high';
    else if (atrPct <= 0.45) vol = 'low';

    return `${trend}_${vol}`;
  }

  function applyBacktestFilter(observation, filter) {
    const conflictVeto = observation.conflict >= 0.38 && observation.agreement < (filter.minAgreement + 0.08);
    const weakCoreVeto = Math.abs(observation.coreScore || 0) < (filter.entryThreshold * 0.92) && observation.conflict >= 0.30;
    const directionalCore = observation.coreScore ?? observation.score ?? 0;
    const structureVeto = (observation.structureZone === 'resistance' && directionalCore > 0 && observation.agreement < 0.65 && Math.abs(observation.structureBias || 0) >= 0.18)
      || (observation.structureZone === 'support' && directionalCore < 0 && observation.agreement < 0.65 && Math.abs(observation.structureBias || 0) >= 0.18);
    const persistenceVeto = Math.sign(observation.persistenceScore || 0) !== 0
      && Math.sign(observation.persistenceScore || 0) !== Math.sign(directionalCore)
      && Math.abs(observation.persistenceScore || 0) >= 0.35
      && Math.abs(directionalCore) < (filter.entryThreshold + 0.04);
    const isActive = observation.absScore >= filter.entryThreshold
      && observation.agreement >= filter.minAgreement
      && !(filter.maxScore && observation.absScore > filter.maxScore)
      && !conflictVeto
      && !weakCoreVeto
      && !structureVeto
      && !persistenceVeto;
    const direction = isActive ? (observation.score > 0 ? 1 : -1) : 0;
    const signedReturn = direction === 0 ? 0 : (observation.isWin != null ? (observation.isWin ? Math.abs(observation.returnPct) : -Math.abs(observation.returnPct)) : observation.returnPct);
    return {
      ...observation,
      direction,
      signedReturn,
      bucket: direction === 0 ? 'neutral' : scoreBucket(observation.absScore),
      appliedThreshold: filter.entryThreshold,
      appliedAgreement: filter.minAgreement,
      vetoed: !isActive && (conflictVeto || weakCoreVeto || structureVeto || persistenceVeto),
      vetoReason: conflictVeto ? 'conflict veto'
        : weakCoreVeto ? 'weak-core veto'
          : structureVeto ? 'structure veto'
            : persistenceVeto ? 'persistence veto'
              : '',
    };
  }

  function scoreCalibrationCandidate(observations, stats, horizonBars, horizonMin) {
    if (!observations.length || !stats.activeSignals) return -Infinity;

    const effectiveSamples = stats.activeSignals / Math.max(1, horizonBars);
    if (effectiveSamples < 2) return -Infinity;

    const targetCoverage = horizonMin <= 15 ? 0.52 : 0.40;
    const coverage = observations.length ? stats.activeSignals / observations.length : 0;
    const edgeRatio = stats.avgAbsReturn > 0 ? stats.avgSignedReturn / stats.avgAbsReturn : 0;
    const winEdge = (stats.winRate - 50) / 18;
    const pfEdge = stats.profitFactor > 0 ? (stats.profitFactor - 1) / 1.4 : -0.6;
    const sampleScore = clamp(effectiveSamples / 12, 0, 1);
    const strongStats = stats.buckets?.strong || { trades: 0, avgEdge: 0 };
    const strongEdge = strongStats.trades >= Math.max(4, horizonBars)
      ? clamp(strongStats.avgEdge / Math.max(stats.avgAbsReturn || 0.15, 0.15), -1, 1)
      : 0;
    const coveragePenalty = coverage > targetCoverage * 2
      ? (coverage - targetCoverage * 2) * 1.1
      : coverage < targetCoverage * 0.18
        ? (targetCoverage * 0.18 - coverage) * 1.4
        : 0;

    // Overnight Asia Session Regularized Horizon Decay:
    // Horizons > 30m suffer from horizon drift & regime transition (+7.45% calib gap, Brier 0.1024).
    // Apply exponential prior decay (tau = 45m) and score relaxation -0.04 to avoid false-breakout traps.
    let horizonDecayMultiplier = 1.0;
    let horizonRelaxationBonus = 0.0;
    if (Number(horizonMin) > 30) {
      const tau = 45; // minutes
      horizonDecayMultiplier = Math.exp(-(Number(horizonMin) - 30) / tau);
      horizonRelaxationBonus = -0.04;
    }

    const rawScore = winEdge * 1.25
      + edgeRatio * 1.10
      + pfEdge * 0.45
      + strongEdge * 0.25
      + sampleScore * 0.45
      - coveragePenalty;

    return rawScore * horizonDecayMultiplier + horizonRelaxationBonus;
  }

  function calibrateBacktestFilter(history, regime, horizonMin, horizonBars) {
    const fallback = defaultBacktestFilter(horizonMin);
    if (!history.length) return { ...fallback, calibrationSample: 0, regimeAware: false };

    const recent = history.slice(-Math.min(BACKTEST_LOOKBACK_OBS, 120));
    const regimeHistory = recent.filter(obs => obs.regime === regime);
    const pool = regimeHistory.length >= BACKTEST_MIN_REGIME_OBS ? regimeHistory : recent;

    let best = null;
    for (const entryThreshold of BACKTEST_THRESHOLD_GRID) {
      for (const minAgreement of BACKTEST_AGREEMENT_GRID) {
        const filtered = pool.map(obs => applyBacktestFilter(obs, { entryThreshold, minAgreement }));
        const stats = summarizeBacktestObservations(filtered, horizonMin, 0, horizonBars);
        const score = scoreCalibrationCandidate(pool, stats, horizonBars, horizonMin);
        if (!best || score > best.score || (score === best.score && stats.activeSignals > (best.stats?.activeSignals || 0))) {
          best = { score, entryThreshold, minAgreement, stats };
        }
      }
    }

    if (!best || !Number.isFinite(best.score) || (best.stats?.activeSignals || 0) < Math.max(3, horizonBars)) {
      return { ...fallback, calibrationSample: pool.length, regimeAware: pool === regimeHistory };
    }

    return {
      entryThreshold: best.entryThreshold,
      minAgreement: best.minAgreement,
      calibrationSample: pool.length,
      regimeAware: pool === regimeHistory,
      trainingStats: best.stats,
    };
  }

  function scoreHorizonReliability(stats) {
    if (!stats || !stats.observations) return 0.5;
    if (!stats.activeSignals) return clamp(0.46 + Math.min(0.08, stats.observations / 200), 0.46, 0.54);

    const effectiveSamples = stats.effectiveSamples || (stats.activeSignals / Math.max(1, stats.horizonBars));
    const edgeRatio = stats.avgAbsReturn > 0 ? stats.avgSignedReturn / stats.avgAbsReturn : 0;
    const winEdge = (stats.winRate - 50) / 20;
    const sampleFactor = clamp(effectiveSamples / 10, 0, 1);
    const coverageFactor = clamp((stats.coverage || 0) / 100, 0, 1);
    const profitFactor = stats.profitFactor > 0 ? Math.min(stats.profitFactor, 2.2) : 1;
    const pfEdge = (profitFactor - 1) / 1.2;

    let reliability = 0.50
      + winEdge * 0.16
      + edgeRatio * 0.16
      + pfEdge * 0.06
      + sampleFactor * 0.07
      + coverageFactor * 0.05;

    if (stats.avgSignedReturn < 0 && stats.winRate < 50) reliability = Math.min(reliability, 0.48);
    return clamp(reliability, 0.05, 0.95);
  }

  function buildEquityStats(observations, startingEquity = BACKTEST_STARTING_EQUITY) {
    let equity = startingEquity;
    let peak = startingEquity;
    let maxDrawdownPct = 0;
    observations.forEach(obs => {
      // Clamp to ±20% per trade to prevent overflow from bad candle data (single
      // exchange returning near-zero close that slips through pooling median)
      const boundedReturn = clamp(obs.signedReturn, -20, 20);
      equity *= 1 + (boundedReturn / 100);
      peak = Math.max(peak, equity);
      const drawdownPct = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
      maxDrawdownPct = Math.min(maxDrawdownPct, drawdownPct);
    });
    return {
      startingEquity,
      endingEquity: equity,
      returnPct: startingEquity > 0 ? ((equity / startingEquity) - 1) * 100 : 0,
      maxDrawdownPct: Math.abs(maxDrawdownPct),
    };
  }

  function summarizeReliabilityLabel(reliability) {
    return reliability >= 0.72 ? 'Strong'
      : reliability >= 0.56 ? 'Decent'
        : reliability >= 0.40 ? 'Mixed'
          : 'Weak';
  }

  function summarizeTradeFitLabel(tradeFit) {
    return tradeFit >= 0.72 ? 'Dialed in'
      : tradeFit >= 0.58 ? 'Short-term edge'
        : tradeFit >= 0.44 ? 'Watchlist only'
          : 'Needs caution';
  }

  function scoreTradeFitHorizon(stats, horizonMin) {
    if (!stats || !stats.observations) return null;
    if (!stats.activeSignals) {
      return clamp(0.45 + Math.min(0.06, stats.observations / 240), 0.45, 0.51);
    }

    const avgAbsReturn = Math.max(stats.avgAbsReturn || 0.12, 0.12);
    const edgeRatio = clamp(stats.avgSignedReturn / avgAbsReturn, -1, 1);
    const expectancyRatio = clamp((stats.expectancy || 0) / avgAbsReturn, -1, 1);
    const winScore = clamp((stats.winRate - 45) / 20, 0, 1);
    const edgeScore = clamp((edgeRatio + 0.15) / 0.95, 0, 1);
    const expectancyScore = clamp((expectancyRatio + 0.1) / 0.9, 0, 1);
    const sampleTarget = horizonMin <= 15 ? 7 : 5;
    const sampleBase = stats.normalizedEffectiveSamples || stats.effectiveSamples || 0;
    const sampleScore = clamp(sampleBase / sampleTarget, 0, 1);
    const drawdownLimit = horizonMin <= 15 ? 9 : 12;
    const drawdownScore = clamp(1 - ((stats.equity?.maxDrawdownPct || 0) / drawdownLimit), 0, 1);
    const strongBucket = stats.buckets?.strong || { trades: 0, winRate: 0, avgEdge: 0 };
    const strongScore = strongBucket.trades
      ? clamp((((strongBucket.winRate - 50) / 25) * 0.55 + clamp(strongBucket.avgEdge / avgAbsReturn, -1, 1) * 0.45 + 1) / 2, 0, 1)
      : 0.5;
    const coveragePenalty = clamp(((stats.coverage || 0) - (horizonMin <= 15 ? 62 : 46)) / 50, 0, 1);

    const tradeFit = 0.28
      + winScore * 0.20
      + edgeScore * 0.18
      + expectancyScore * 0.14
      + sampleScore * 0.10
      + drawdownScore * 0.08
      + strongScore * 0.10
      - coveragePenalty * 0.08;

    return clamp(tradeFit, 0.05, 0.95);
  }

  function scoreTradeFit(horizonStats = {}) {
    const parts = SHORT_HORIZON_MINUTES
      .map(horizonMin => {
        const score = scoreTradeFitHorizon(horizonStats[horizonKey(horizonMin)], horizonMin);
        return Number.isFinite(score) ? { score, weight: SHORT_HORIZON_WEIGHTS[horizonMin] || 1 } : null;
      })
      .filter(Boolean);
    if (!parts.length) return 0.5;
    const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
    return parts.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight;
  }

  function summarizeSignalDrivers(signalVector, indicators) {
    const topDrivers = Object.entries(signalVector)
      .filter(([, value]) => Math.abs(value) >= 0.12)
      .map(([key, value]) => ({
        key,
        label: SIGNAL_LABELS[key] || key,
        direction: value > 0 ? 'up' : 'down',
        impact: Math.abs(value) * (COMPOSITE_WEIGHTS[key] || 0.1),
        detail: indicators[key]?.label || 'Active',
      }))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 3);

    return {
      topDrivers,
      driverSummary: topDrivers.length
        ? topDrivers.map(driver => `${driver.label} ${driver.direction === 'up' ? 'supports UP' : 'leans DOWN'} (${driver.detail})`).join(' · ')
        : 'No dominant driver cluster',
    };
  }

  // ================================================================
  // MICROSTRUCTURE ANALYSIS
  // ================================================================

  function analyzeTradeFlow(trades) {
    if (!trades || trades.length === 0) return { buyRatio: 50, sellRatio: 50, aggressor: 'neutral', bigTrades: 0, label: 'No data' };
    let buyVol = 0, sellVol = 0, bigTrades = 0;
    const avgQty = trades.reduce((s, t) => s + parseFloat(t.qty || 0), 0) / trades.length;
    trades.forEach(t => {
      const qty = parseFloat(t.qty || 0);
      if (t.side === 'buy') buyVol += qty; else sellVol += qty;
      if (qty > avgQty * 3) bigTrades++;
    });
    const total = buyVol + sellVol || 1;
    const buyRatio = (buyVol / total) * 100;
    const sellRatio = (sellVol / total) * 100;
    const aggressor = buyRatio > 60 ? 'buyers' : sellRatio > 60 ? 'sellers' : 'neutral';
    let label = aggressor === 'buyers' ? 'Buy Aggression' : aggressor === 'sellers' ? 'Sell Aggression' : 'Mixed Flow';
    if (bigTrades > 3) label += ` (${bigTrades} whale trades)`;
    return { buyRatio, sellRatio, aggressor, bigTrades, label };
  }

  // ================================================================
  // SCALP TIMING + CONTRARIAN DETECTION
  // ================================================================

  function detectScalpSetups(candles, indicators, book, tradeFlow, session) {
    const setups = [];
    const last = candles[candles.length - 1];
    const lastPrice = last.c;

    // 1. Session-based scalp windows
    if (session.current.scalp) {
      setups.push({
        type: 'scalp_window',
        label: `${session.current.label} — Prime Scalp Window`,
        desc: session.current.desc,
        strength: 'high',
        direction: null, // session itself is neutral
      });
    }

    // 2. VWAP overextension fade (contrarian)
    if (Math.abs(indicators.vwapDev) > 1.5) {
      const dir = indicators.vwapDev > 0 ? 'down' : 'up';
      setups.push({
        type: 'contrarian_vwap',
        label: `VWAP Fade — ${dir === 'up' ? 'Buy the dip' : 'Sell the rip'}`,
        desc: `Price ${indicators.vwapDev > 0 ? 'above' : 'below'} VWAP by ${Math.abs(indicators.vwapDev).toFixed(2)}%. Mean reversion likely within 15-30min.`,
        strength: Math.abs(indicators.vwapDev) > 2.5 ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 3. RSI exhaustion reversal (contrarian)
    if (indicators.rsi > 75 || indicators.rsi < 25) {
      const dir = indicators.rsi > 75 ? 'down' : 'up';
      setups.push({
        type: 'contrarian_rsi',
        label: `RSI Exhaustion — ${indicators.rsi > 75 ? 'Overbought fade' : 'Oversold bounce'}`,
        desc: `RSI at ${indicators.rsi.toFixed(1)} signals ${indicators.rsi > 75 ? 'buyer exhaustion' : 'seller exhaustion'}. Watch for reversal candle confirmation.`,
        strength: (indicators.rsi > 82 || indicators.rsi < 18) ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 4. Volume climax (contrarian)
    if (candles.length > 12) {
      const recentVols = candles.slice(-12).map(c => c.v);
      const avgVol = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
      const lastVol = candles[candles.length - 1].v;
      if (lastVol > avgVol * 2.5 && avgVol > 0) {
        const wasUp = last.c > last.o;
        setups.push({
          type: 'contrarian_volume_climax',
          label: `Volume Climax — ${wasUp ? 'Blow-off top' : 'Capitulation'}`,
          desc: `Last candle volume ${(lastVol / avgVol).toFixed(1)}x average. ${wasUp ? 'Buyers exhausted' : 'Sellers exhausted'} — expect reversal within 15min.`,
          strength: 'high',
          direction: wasUp ? 'down' : 'up',
        });
      }
    }

    // 5. Book imbalance scalp
    if (book && Math.abs(book.imbalance) > 0.35) {
      const dir = book.imbalance > 0 ? 'up' : 'down';
      setups.push({
        type: 'scalp_book',
        label: `Book Imbalance Scalp — ${dir === 'up' ? 'Bid wall support' : 'Ask wall resistance'}`,
        desc: `Order book ${book.imbalance > 0 ? 'bid-heavy' : 'ask-heavy'} (${Math.abs(book.imbalance * 100).toFixed(0)}% skew). Scalp ${dir} with tight stop.`,
        strength: Math.abs(book.imbalance) > 0.5 ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 6. Trade flow aggressor scalp
    if (tradeFlow && tradeFlow.aggressor !== 'neutral') {
      const dir = tradeFlow.aggressor === 'buyers' ? 'up' : 'down';
      setups.push({
        type: 'scalp_flow',
        label: `Tape Reading — ${tradeFlow.aggressor === 'buyers' ? 'Aggressive buying' : 'Aggressive selling'}`,
        desc: `Recent trades: ${tradeFlow.buyRatio.toFixed(0)}% buy / ${tradeFlow.sellRatio.toFixed(0)}% sell. ${tradeFlow.bigTrades > 0 ? tradeFlow.bigTrades + ' whale-size trades detected.' : ''}`,
        strength: (tradeFlow.buyRatio > 70 || tradeFlow.sellRatio > 70) ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 7. EMA cross scalp
    if (Math.abs(indicators.emaCross) > 0.15) {
      const dir = indicators.emaCross > 0 ? 'up' : 'down';
      setups.push({
        type: 'scalp_ema',
        label: `EMA Cross Momentum — ${dir === 'up' ? '9 above 21' : '9 below 21'}`,
        desc: `EMA(9) ${indicators.emaCross > 0 ? 'crossed above' : 'dropped below'} EMA(21). Ride the trend for 15-30min.`,
        strength: Math.abs(indicators.emaCross) > 0.4 ? 'high' : 'medium',
        direction: dir,
      });
    }

    // 8. Dead zone warning (avoid scalping)
    if (!session.current.scalp && session.current.label === 'Dead Zone') {
      setups.push({
        type: 'avoid',
        label: 'Dead Zone — Avoid Scalping',
        desc: 'Low liquidity period. Wide spreads, erratic fills. Next scalp window opens in ' + session.minsToNext + ' min.',
        strength: 'warning',
        direction: null,
      });
    }

    return setups;
  }

  // ================================================================
  // PREDICTION COMPUTATION
  // ================================================================

  // Normal CDF: imported from window.PREDICTIONS_POLYMARKET_ROUTING

  // ── SMC: Smart Money Concepts Helpers ─────────────────────────────────────
  function detectLiquidityPools(candles) {
    const pools = { highs: [], lows: [] };
    const n = candles.length;
    if (n < 20) return pools;

    const pivots = { highs: [], lows: [] };
    for (let i = 2; i < n - 2; i++) {
      const c = candles[i];
      if (c.h > candles[i - 1].h && c.h > candles[i - 2].h && c.h > candles[i + 1].h && c.h > candles[i + 2].h) {
        pivots.highs.push({ price: c.h, index: i });
      }
      if (c.l < candles[i - 1].l && c.l < candles[i - 2].l && c.l < candles[i + 1].l && c.l < candles[i + 2].l) {
        pivots.lows.push({ price: c.l, index: i });
      }
    }

    const cluster = (pivotsArray, type) => {
      const merged = [];
      for (const p of pivotsArray) {
        let found = false;
        for (const m of merged) {
          if (Math.abs(p.price - m.price) / m.price <= 0.001) {
            m.touches++;
            m.price = type === 'high' ? Math.max(m.price, p.price) : Math.min(m.price, p.price);
            m.latestIndex = Math.max(m.latestIndex, p.index);
            found = true;
            break;
          }
        }
        if (!found) {
          merged.push({ price: p.price, touches: 1, latestIndex: p.index });
        }
      }
      return merged.filter(m => m.touches >= 2);
    };

    pools.highs = cluster(pivots.highs, 'high');
    pools.lows = cluster(pivots.lows, 'low');
    return pools;
  }

  function detectLiquiditySweeps(candles, pools) {
    const sweeps = [];
    const n = candles.length;
    if (n < 5) return sweeps;
    for (let i = n - 4; i < n - 1; i++) {
      const c = candles[i];
      for (const pool of pools.highs) {
        if (c.h > pool.price && c.c < pool.price) {
          sweeps.push({ dir: -1, pool: pool.price, index: i, type: 'mitigated' });
        }
      }
      for (const pool of pools.lows) {
        if (c.l < pool.price && c.c > pool.price) {
          sweeps.push({ dir: 1, pool: pool.price, index: i, type: 'mitigated' });
        }
      }
    }
    return sweeps;
  }

  function detectFVGs(candles) {
    const fvgs = [];
    const n = candles.length;
    if (n < 5) return fvgs;
    for (let i = n - 5; i < n - 1; i++) {
      const c1 = candles[i - 1];
      const c2 = candles[i];
      const c3 = candles[i + 1];
      if (!c1 || !c2 || !c3) continue;

      if (c1.h < c3.l && c2.c > c2.o) {
        fvgs.push({ dir: 1, ce: (c1.h + c3.l) / 2, top: c3.l, bottom: c1.h, index: i });
      }
      if (c1.l > c3.h && c2.c < c2.o) {
        fvgs.push({ dir: -1, ce: (c1.l + c3.h) / 2, top: c1.l, bottom: c3.h, index: i });
      }
    }
    return fvgs;
  }

  // ── detectReversalFlags: identify price/indicator divergences and exhaustion signals ──
  function detectReversalFlags(candles, rsi, macdResult, adxResult, obvSlope, mom) {
    const n = candles.length;
    if (n < 14) return [];
    const closes = candles.map(c => c.c);
    const flags = [];

    // Helper
    const absVal = v => Math.abs(v);

    // Pre-compute the earlier-window RSI once — reused by both RSI_BEAR_DIV and
    // RSI_BULL_DIV below (eliminates duplicate calcRSI call on the same slice).
    const _rsiOldShared = n >= 24 ? calcRSI(closes.slice(0, -8), 14) : null;

    // 1. RSI_BEAR_DIV
    if (n >= 24) {
      const oldSlice = closes.slice(-16, -8);
      const newSlice = closes.slice(-8);
      const oldHigh = Math.max(...oldSlice);
      const newHigh = Math.max(...newSlice);
      const rsiOld = _rsiOldShared;
      const rsiNew = rsi;
      const rsiDiff = rsiOld - rsiNew; // how much higher old RSI was
      if (newHigh > oldHigh * 1.003 && rsiDiff >= 5 && rsiNew > 50) {
        const severity = rsiNew > 65 ? 'critical' : 'warning';
        const strength = clamp(rsiDiff / 20, 0.3, 0.9);
        flags.push({ id: 'RSI_BEAR_DIV', severity, bias: 'bearish', label: 'RSI Bear Div', desc: `Price made higher high but RSI dropped ${rsiDiff.toFixed(1)} pts — bearish divergence`, strength });
      }
    }

    // 2. RSI_BULL_DIV
    if (n >= 24) {
      const oldSlice = closes.slice(-16, -8);
      const newSlice = closes.slice(-8);
      const oldLow = Math.min(...oldSlice);
      const newLow = Math.min(...newSlice);
      const rsiOld = _rsiOldShared;
      const rsiNew = rsi;
      const rsiDiff = rsiNew - rsiOld; // how much higher new RSI is
      if (newLow < oldLow * 0.997 && rsiDiff >= 5 && rsiNew < 50) {
        const severity = rsiNew < 35 ? 'critical' : 'warning';
        const strength = clamp(rsiDiff / 20, 0.3, 0.9);
        flags.push({ id: 'RSI_BULL_DIV', severity, bias: 'bullish', label: 'RSI Bull Div', desc: `Price made lower low but RSI rose ${rsiDiff.toFixed(1)} pts — bullish divergence`, strength });
      }
    }

    // 3. OBV_BEAR_DIV
    if (mom > 0.3 && obvSlope < -3.0) {
      const strength = clamp(absVal(obvSlope) / 12, 0.3, 0.8);
      flags.push({ id: 'OBV_BEAR_DIV', severity: 'warning', bias: 'bearish', label: 'OBV Bear Div', desc: `Price rising (mom ${mom.toFixed(2)}%) but OBV falling (slope ${obvSlope.toFixed(1)}) — distribution`, strength });
    }

    // 4. OBV_BULL_DIV
    if (mom < -0.3 && obvSlope > 3.0) {
      const strength = clamp(absVal(obvSlope) / 12, 0.3, 0.8);
      flags.push({ id: 'OBV_BULL_DIV', severity: 'warning', bias: 'bullish', label: 'OBV Bull Div', desc: `Price falling (mom ${mom.toFixed(2)}%) but OBV rising (slope ${obvSlope.toFixed(1)}) — accumulation`, strength });
    }

    // 5. MACD_BEAR_CROSS
    if (macdResult && closes.length >= 35) {
      const prevMacd = calcMACD(closes.slice(0, -1));
      const prevHist = prevMacd ? prevMacd.histogram : 0;
      if (prevHist > 0.00001 && macdResult.histogram < 0) {
        const severity = adxResult.adx > 22 ? 'alert' : 'warning';
        const strength = clamp(absVal(macdResult.histogram - prevHist) / 0.005, 0.35, 0.85);
        flags.push({ id: 'MACD_BEAR_CROSS', severity, bias: 'bearish', label: 'MACD Bear X', desc: `MACD histogram flipped negative (${macdResult.histogram.toFixed(5)}) — fresh bearish crossover`, strength });
      }
    }

    // 6. MACD_BULL_CROSS
    if (macdResult && closes.length >= 35) {
      const prevMacd = calcMACD(closes.slice(0, -1));
      const prevHist = prevMacd ? prevMacd.histogram : 0;
      if (prevHist < -0.00001 && macdResult.histogram > 0) {
        const severity = adxResult.adx > 22 ? 'alert' : 'warning';
        const strength = clamp(absVal(macdResult.histogram - prevHist) / 0.005, 0.35, 0.85);
        flags.push({ id: 'MACD_BULL_CROSS', severity, bias: 'bullish', label: 'MACD Bull X', desc: `MACD histogram flipped positive (${macdResult.histogram.toFixed(5)}) — fresh bullish crossover`, strength });
      }
    }

    // 7. ADX_HINGE
    if (n >= 10) {
      const prevAdxResult = calcADX(candles.slice(0, -3));
      const prevAdx = prevAdxResult ? prevAdxResult.adx : 0;
      if (prevAdx > adxResult.adx + 2.5 && prevAdx > 28) {
        const bias = adxResult.pdi > adxResult.mdi ? 'bearish' : 'bullish';
        const strength = clamp((prevAdx - adxResult.adx) / 8, 0.3, 0.75);
        flags.push({ id: 'ADX_HINGE', severity: 'warning', bias, label: 'ADX Hinge', desc: `ADX dropping from ${prevAdx.toFixed(1)} to ${adxResult.adx.toFixed(1)} — trend exhausting, possible reversal`, strength });
      }
    }

    // 8. VOL_CLIMAX_SELL
    if (n >= 22) {
      const avgVol = average(candles.slice(-21, -1).map(c => c.v || 0));
      const lastVol = candles[n - 1].v || 0;
      const volMult = avgVol > 0 ? lastVol / avgVol : 0;
      const lastBar = candles[n - 1];
      const body = absVal(lastBar.c - lastBar.o);
      const range = (lastBar.h - lastBar.l) || 0.00001;
      if (volMult >= 2.5 && lastBar.c < lastBar.o && body / range > 0.45) {
        const severity = volMult > 4 ? 'critical' : 'alert';
        flags.push({ id: 'VOL_CLIMAX_SELL', severity, bias: 'bullish', label: 'Vol Climax Sell', desc: `Volume ${volMult.toFixed(1)}x avg on large bearish bar — potential capitulation bottom`, strength: clamp(volMult / 6, 0.3, 0.9) });
      }
    }

    // 9. VOL_CLIMAX_BUY
    if (n >= 22) {
      const avgVol = average(candles.slice(-21, -1).map(c => c.v || 0));
      const lastVol = candles[n - 1].v || 0;
      const volMult = avgVol > 0 ? lastVol / avgVol : 0;
      const lastBar = candles[n - 1];
      const body = absVal(lastBar.c - lastBar.o);
      const range = (lastBar.h - lastBar.l) || 0.00001;
      if (volMult >= 2.5 && lastBar.c > lastBar.o && body / range > 0.45) {
        const severity = volMult > 4 ? 'critical' : 'alert';
        flags.push({ id: 'VOL_CLIMAX_BUY', severity, bias: 'bearish', label: 'Vol Climax Buy', desc: `Volume ${volMult.toFixed(1)}x avg on large bullish bar — potential euphoria top`, strength: clamp(volMult / 6, 0.3, 0.9) });
      }
    }

    // 10. WICK_REJECT_TOP
    {
      const atr = calcATR(candles, 14);
      const last4 = candles.slice(-4);
      let found = false;
      for (let i = 0; i < last4.length && !found; i++) {
        const bar = last4[i];
        const body = absVal(bar.c - bar.o);
        const range = (bar.h - bar.l) || 0.00001;
        const upperWick = bar.h - Math.max(bar.o, bar.c);
        if (upperWick > atr * 1.3 && upperWick > body * 2.2 && upperWick / range > 0.45) {
          flags.push({ id: 'WICK_REJECT_TOP', severity: 'warning', bias: 'bearish', label: 'Wick Reject Top', desc: `Upper wick ${(upperWick / atr).toFixed(1)}x ATR — strong rejection at highs`, strength: clamp(upperWick / (atr * 3), 0.3, 0.8) });
          found = true;
        }
      }
    }

    // 11. WICK_REJECT_BOT
    {
      const atr = calcATR(candles, 14);
      const last4 = candles.slice(-4);
      let found = false;
      for (let i = 0; i < last4.length && !found; i++) {
        const bar = last4[i];
        const body = absVal(bar.c - bar.o);
        const range = (bar.h - bar.l) || 0.00001;
        const lowerWick = Math.min(bar.o, bar.c) - bar.l;
        if (lowerWick > atr * 1.3 && lowerWick > body * 2.2 && lowerWick / range > 0.45) {
          flags.push({ id: 'WICK_REJECT_BOT', severity: 'warning', bias: 'bullish', label: 'Wick Reject Bot', desc: `Lower wick ${(lowerWick / atr).toFixed(1)}x ATR — strong rejection at lows`, strength: clamp(lowerWick / (atr * 3), 0.3, 0.8) });
          found = true;
        }
      }
    }

    // 12. MOM_FAILURE_BEAR
    if (n >= 13) {
      const oldMom = ((closes[n - 7] - closes[n - 13]) / (closes[n - 13] || 1)) * 100;
      if (mom > 0.2 && oldMom > 0 && mom < oldMom * 0.5 && mom < oldMom - 0.3) {
        const strength = clamp((oldMom - mom) / (oldMom || 1), 0.25, 0.70);
        flags.push({ id: 'MOM_FAILURE_BEAR', severity: 'warning', bias: 'bearish', label: 'Mom Failure Bear', desc: `Momentum fading: was ${oldMom.toFixed(2)}%, now ${mom.toFixed(2)}% — up move losing steam`, strength });
      }
    }

    // 13. MOM_FAILURE_BULL
    if (n >= 13) {
      const oldMom = ((closes[n - 7] - closes[n - 13]) / (closes[n - 13] || 1)) * 100;
      if (mom < -0.2 && oldMom < 0 && mom > oldMom * 0.5 && mom > oldMom + 0.3) {
        const strength = clamp((mom - oldMom) / (Math.abs(oldMom) || 1), 0.25, 0.70);
        flags.push({ id: 'MOM_FAILURE_BULL', severity: 'warning', bias: 'bullish', label: 'Mom Failure Bull', desc: `Selling pressure easing: was ${oldMom.toFixed(2)}%, now ${mom.toFixed(2)}% — down move losing steam`, strength });
      }
    }

    // Deduplicate by base ID (strip _BULL, _BEAR, _BUY, _SELL, _TOP, _BOT suffix)
    const baseMap = new Map();
    for (const flag of flags) {
      const base = flag.id.replace(/_(BULL|BEAR|BUY|SELL|TOP|BOT)$/, '');
      const existing = baseMap.get(base);
      if (!existing || flag.strength > existing.strength) {
        baseMap.set(base, flag);
      }
    }

    return Array.from(baseMap.values());
  }

  // ── runMomentumDecisionTree: multi-layer regime classifier ──────────────
  function runMomentumDecisionTree(candles, { rsi, emaCross, mom, vwapDevRolling, obvSlope, adxResult, macdResult, stochRsiResult, persistence, structure, reversalFlags }) {
    const n = candles.length;
    const closes = candles.map(c => c.c);
    const path = [];
    let regime = 'FLAT';
    let bias = 'neutral';
    let biasScore = 0;
    let biasConf = 20;
    let preemptive = false;
    let layer = 6;

    const sgn = v => v > 0 ? 1 : v < 0 ? -1 : 0;
    const absVal = v => Math.abs(v);

    const REGIME_LABELS = {
      DIV_BEARISH: 'Bearish Divergence', DIV_BULLISH: 'Bullish Divergence',
      OBV_DIV_BEAR: 'OBV Distribution', OBV_DIV_BULL: 'OBV Accumulation',
      SURGE_BULL: 'Bullish Surge', SURGE_BEAR: 'Bearish Surge',
      COIL_BULL: 'Bull Coil', COIL_BEAR: 'Bear Coil',
      TRENDING_UP: 'Uptrend', TRENDING_DOWN: 'Downtrend', TREND_MIXED: 'Mixed Trend',
      RANGE_ACCUMULATION: 'Accumulation', RANGE_DISTRIBUTION: 'Distribution',
      RANGE_TOP: 'Range Top', RANGE_BOT: 'Range Bottom',
      FLAG_CONFLICT: 'Signal Conflict',
      FLAT: 'Flat / Ranging',
    };

    // ── Layer 1: DIVERGENCE GATE (preemptive) ──
    if (n >= 20 && layer === 6) {
      const midIdx = n - 10;
      if (midIdx >= 8) {
        const oldSlice = closes.slice(midIdx - 8, midIdx);
        const newSlice = closes.slice(midIdx, n);
        const oldHigh = Math.max(...oldSlice);
        const newHigh = Math.max(...newSlice);
        const oldLow = Math.min(...oldSlice);
        const newLow = Math.min(...newSlice);
        const priceTrendUp = newHigh > oldHigh * 1.003;
        const priceTrendDown = newLow < oldLow * 0.997;
        const rsiOld = calcRSI(closes.slice(0, midIdx), 14);
        const rsiNew = rsi;
        const rsiDiff = rsiNew - rsiOld;

        if (priceTrendUp && rsiDiff < -4 && rsiNew > 55) {
          regime = 'DIV_BEARISH'; bias = 'bearish';
          biasScore = -clamp(absVal(rsiDiff) / 15, 0.35, 0.85);
          biasConf = Math.min(75, 45 + absVal(rsiDiff) * 1.5);
          preemptive = true; layer = 1;
          path.push({ node: 'RSI_DIV', type: 'divergence', cond: `priceTrendUp && rsiDiff=${rsiDiff.toFixed(1)} < -4 && rsiNew=${rsiNew.toFixed(1)} > 55`, result: 'DIV_BEARISH', pass: true });
        } else if (priceTrendDown && rsiDiff > 4 && rsiNew < 45) {
          regime = 'DIV_BULLISH'; bias = 'bullish';
          biasScore = clamp(absVal(rsiDiff) / 15, 0.35, 0.85);
          biasConf = Math.min(75, 45 + absVal(rsiDiff) * 1.5);
          preemptive = true; layer = 1;
          path.push({ node: 'RSI_DIV', type: 'divergence', cond: `priceTrendDown && rsiDiff=${rsiDiff.toFixed(1)} > 4 && rsiNew=${rsiNew.toFixed(1)} < 45`, result: 'DIV_BULLISH', pass: true });
        } else {
          path.push({ node: 'RSI_DIV', type: 'divergence', cond: `priceTrendUp=${priceTrendUp} rsiDiff=${rsiDiff.toFixed(1)}`, result: 'skip', pass: false });
        }
      }

      // OBV divergence check (only if no RSI div found yet)
      if (layer === 6) {
        if (mom > 0.25 && obvSlope < -2.5) {
          regime = 'OBV_DIV_BEAR'; bias = 'bearish';
          biasScore = -0.55; biasConf = 58; preemptive = true; layer = 1;
          path.push({ node: 'OBV_DIV', type: 'divergence', cond: `mom=${mom.toFixed(2)}>0.25 && obvSlope=${obvSlope.toFixed(1)}<-2.5`, result: 'OBV_DIV_BEAR', pass: true });
        } else if (mom < -0.25 && obvSlope > 2.5) {
          regime = 'OBV_DIV_BULL'; bias = 'bullish';
          biasScore = 0.55; biasConf = 58; preemptive = true; layer = 1;
          path.push({ node: 'OBV_DIV', type: 'divergence', cond: `mom=${mom.toFixed(2)}<-0.25 && obvSlope=${obvSlope.toFixed(1)}>2.5`, result: 'OBV_DIV_BULL', pass: true });
        } else {
          path.push({ node: 'OBV_DIV', type: 'divergence', cond: `mom=${mom.toFixed(2)} obvSlope=${obvSlope.toFixed(1)}`, result: 'skip', pass: false });
        }
      }
    }

    // ── Layer 2: VOLUME SURGE GATE (preemptive) ──
    if (layer === 6 && n >= 25) {
      const avgVol = average(candles.slice(-23, -3).map(c => c.v || 0));
      const recentBars = candles.slice(-3);
      const recentAvgVol = average(recentBars.map(c => c.v || 0));
      const surgeMult = avgVol > 0 ? recentAvgVol / avgVol : 0;

      if (surgeMult >= 1.8) {
        let surgeUp = 0, surgeDn = 0;
        for (const bar of recentBars) {
          const body = absVal(bar.c - bar.o);
          const range = (bar.h - bar.l) || 0.00001;
          const vol = bar.v || 0;
          if (body / range > 0.45) {
            if (bar.c > bar.o) surgeUp += vol;
            else surgeDn += vol;
          }
        }
        const surgeDir = surgeUp > surgeDn * 1.4 ? 1 : surgeDn > surgeUp * 1.4 ? -1 : 0;
        if (surgeDir !== 0) {
          regime = surgeDir > 0 ? 'SURGE_BULL' : 'SURGE_BEAR';
          bias = surgeDir > 0 ? 'bullish' : 'bearish';
          biasScore = surgeDir * clamp(0.40 + (surgeMult - 1.8) * 0.15, 0.40, 0.80);
          biasConf = Math.min(80, 50 + Math.min(surgeMult * 15, 30));
          preemptive = true; layer = 2;
          path.push({ node: 'VOL_SURGE', type: 'surge', cond: `surgeMult=${surgeMult.toFixed(2)} surgeDir=${surgeDir}`, result: regime, pass: true });
        } else {
          path.push({ node: 'VOL_SURGE', type: 'surge', cond: `surgeMult=${surgeMult.toFixed(2)} surgeDir=0`, result: 'skip', pass: false });
        }
      } else {
        path.push({ node: 'VOL_SURGE', type: 'surge', cond: `surgeMult=${surgeMult.toFixed(2)}<1.8`, result: 'skip', pass: false });
      }
    }

    // ── Layer 3: STRUCTURE COIL GATE (preemptive) ──
    if (layer === 6 && n >= 20) {
      const atrRecent = calcATR(candles.slice(-6), 5);
      const atrHist = calcATR(candles.slice(-20, -5), 14);
      const coilRatio = atrHist > 0 ? atrRecent / atrHist : 1;

      if (coilRatio < 0.55) {
        const ema9Last = calcEMA(closes, 9);
        const ema21Last = calcEMA(closes, 21);
        const lastEma9 = ema9Last[ema9Last.length - 1];
        const lastEma21 = ema21Last[ema21Last.length - 1];
        const lastClose = closes[closes.length - 1];
        const priceAboveEma = lastClose > lastEma9 && lastClose > lastEma21;
        const priceBelowEma = lastClose < lastEma9 && lastClose < lastEma21;
        const macdMom = macdResult && macdResult.histogram > 0 ? 1 : -1;

        if (priceAboveEma) {
          regime = 'COIL_BULL'; bias = 'bullish';
          biasScore = 0.30 * (macdMom >= 0 ? 1.2 : 0.8);
          biasConf = Math.min(65, 40 + (0.55 - coilRatio) * 80);
          preemptive = true; layer = 3;
          path.push({ node: 'COIL', type: 'structure', cond: `coilRatio=${coilRatio.toFixed(2)}<0.55 priceAboveEma=true`, result: 'COIL_BULL', pass: true });
        } else if (priceBelowEma) {
          regime = 'COIL_BEAR'; bias = 'bearish';
          biasScore = -0.30 * (macdMom <= 0 ? 1.2 : 0.8);
          biasConf = Math.min(65, 40 + (0.55 - coilRatio) * 80);
          preemptive = true; layer = 3;
          path.push({ node: 'COIL', type: 'structure', cond: `coilRatio=${coilRatio.toFixed(2)}<0.55 priceBelowEma=true`, result: 'COIL_BEAR', pass: true });
        } else {
          path.push({ node: 'COIL', type: 'structure', cond: `coilRatio=${coilRatio.toFixed(2)}<0.55 ema=neutral`, result: 'skip', pass: false });
        }
      } else {
        path.push({ node: 'COIL', type: 'structure', cond: `coilRatio=${coilRatio.toFixed(2)}>=0.55`, result: 'skip', pass: false });
      }
    }

    // ── Layer 4: TREND GATE (confirming) ──
    if (layer === 6 && adxResult.adx >= 22) {
      const adx = adxResult.adx;
      const pdi = adxResult.pdi;
      const mdi = adxResult.mdi;
      const diDiff = (pdi - mdi) / ((pdi + mdi) || 1);
      const trendUp = emaCross > 0 && pdi > mdi && mom > 0;
      const trendDn = emaCross < 0 && mdi > pdi && mom < 0;

      if (trendUp) {
        const str = clamp((adx / 50) * Math.min(absVal(emaCross) / 0.3, 1), 0.25, 1);
        const confirmed = (macdResult && macdResult.histogram > 0) && (stochRsiResult && stochRsiResult.k > 50);
        const caution = (macdResult && macdResult.histogram < 0) || (stochRsiResult && stochRsiResult.k > 82);
        regime = 'TRENDING_UP'; bias = 'bullish'; layer = 4;
        biasScore = str * (confirmed ? 1.15 : caution ? 0.65 : 0.90);
        biasConf = confirmed ? Math.min(88, 68 + (adx - 22) * 0.8)
          : caution ? Math.min(55, 42 + (adx - 22) * 0.5)
            : Math.min(72, 58 + (adx - 22) * 0.6);
        path.push({ node: 'TREND', type: 'trend', cond: `adx=${adx.toFixed(1)} trendUp confirmed=${confirmed} caution=${caution}`, result: 'TRENDING_UP', pass: true });
      } else if (trendDn) {
        const str = clamp((adx / 50) * Math.min(absVal(emaCross) / 0.3, 1), 0.25, 1);
        const confirmed = (macdResult && macdResult.histogram < 0) && (stochRsiResult && stochRsiResult.k < 50);
        const caution = (macdResult && macdResult.histogram > 0) || (stochRsiResult && stochRsiResult.k < 18);
        regime = 'TRENDING_DOWN'; bias = 'bearish'; layer = 4;
        biasScore = -(str * (confirmed ? 1.15 : caution ? 0.65 : 0.90));
        biasConf = confirmed ? Math.min(88, 68 + (adx - 22) * 0.8)
          : caution ? Math.min(55, 42 + (adx - 22) * 0.5)
            : Math.min(72, 58 + (adx - 22) * 0.6);
        path.push({ node: 'TREND', type: 'trend', cond: `adx=${adx.toFixed(1)} trendDn confirmed=${confirmed} caution=${caution}`, result: 'TRENDING_DOWN', pass: true });
      } else {
        const diDiffVal = (pdi - mdi) / ((pdi + mdi) || 1);
        regime = 'TREND_MIXED'; layer = 4;
        biasScore = diDiffVal * 0.35 * sgn(emaCross || mom);
        biasConf = 32;
        bias = biasScore > 0 ? 'bullish' : biasScore < 0 ? 'bearish' : 'neutral';
        path.push({ node: 'TREND', type: 'trend', cond: `adx=${adx.toFixed(1)} mixed diDiff=${diDiffVal.toFixed(2)}`, result: 'TREND_MIXED', pass: true });
      }
    }

    // ── Layer 5: RANGE GATE (confirming) ──
    if (layer === 6 && adxResult.adx < 22) {
      const accumulating = obvSlope > 2.0 && rsi > 50 && absVal(vwapDevRolling) < 0.5;
      const distributing = obvSlope < -2.0 && rsi < 50 && absVal(vwapDevRolling) < 0.5;
      const atRangeTop = vwapDevRolling > 0.8 && stochRsiResult && stochRsiResult.k > 65;
      const atRangeBot = vwapDevRolling < -0.8 && stochRsiResult && stochRsiResult.k < 35;

      if (accumulating) {
        regime = 'RANGE_ACCUMULATION'; bias = 'bullish';
        biasScore = clamp(obvSlope / 6, 0.20, 0.55); biasConf = 45; layer = 5;
        path.push({ node: 'RANGE', type: 'range', cond: 'accumulating', result: 'RANGE_ACCUMULATION', pass: true });
      } else if (distributing) {
        regime = 'RANGE_DISTRIBUTION'; bias = 'bearish';
        biasScore = -clamp(absVal(obvSlope) / 6, 0.20, 0.55); biasConf = 45; layer = 5;
        path.push({ node: 'RANGE', type: 'range', cond: 'distributing', result: 'RANGE_DISTRIBUTION', pass: true });
      } else if (atRangeTop) {
        regime = 'RANGE_TOP'; bias = 'bearish';
        biasScore = -0.35; biasConf = 40; layer = 5;
        path.push({ node: 'RANGE', type: 'range', cond: 'atRangeTop', result: 'RANGE_TOP', pass: true });
      } else if (atRangeBot) {
        regime = 'RANGE_BOT'; bias = 'bullish';
        biasScore = 0.35; biasConf = 40; layer = 5;
        path.push({ node: 'RANGE', type: 'range', cond: 'atRangeBot', result: 'RANGE_BOT', pass: true });
      } else {
        regime = 'FLAT'; layer = 5;
        biasScore = 0; biasConf = 20; bias = 'neutral';
        path.push({ node: 'RANGE', type: 'range', cond: `adx=${adxResult.adx.toFixed(1)}<22 no condition`, result: 'FLAT', pass: false });
      }
    }

    // ── Layer 6: FLAT ──
    if (layer === 6) {
      const macdMom = sgn(macdResult ? macdResult.histogram : 0);
      const persMom0 = persistence && persistence.signal ? persistence.signal : 0;
      biasScore = clamp((macdMom + sgn(persMom0)) / 4, -0.18, 0.18);
      biasConf = 20; layer = 6; regime = 'FLAT';
      bias = biasScore > 0.02 ? 'bullish' : biasScore < -0.02 ? 'bearish' : 'neutral';
      path.push({ node: 'FLAT', type: 'flat', cond: `macdMom=${macdMom} persMom=${persMom0.toFixed(2)}`, result: 'FLAT', pass: false });
    }

    // ── Reversal flag integration ──
    if (Array.isArray(reversalFlags) && reversalFlags.length > 0) {
      for (const flag of reversalFlags) {
        const aligns = flag.bias === bias;
        if (aligns) {
          if (flag.severity === 'critical') { biasConf = Math.min(biasConf + 12, 95); biasScore = clamp(biasScore * 1.10, -1, 1); }
          else if (flag.severity === 'alert') { biasConf = Math.min(biasConf + 6, 95); }
        } else if (flag.bias !== 'neutral') {
          if (flag.severity === 'critical') { biasConf = Math.max(biasConf - 15, 5); biasScore *= 0.80; }
          else if (flag.severity === 'alert') { biasConf = Math.max(biasConf - 8, 5); }
        }
      }
      // Check for conflict flip
      const critAlertContra = reversalFlags.filter(f => f.bias !== bias && f.bias !== 'neutral' && (f.severity === 'critical' || f.severity === 'alert'));
      if (critAlertContra.length > 0 && biasConf < 35) {
        regime = 'FLAG_CONFLICT'; bias = 'neutral'; biasScore *= 0.3; biasConf = 15;
        path.push({ node: 'FLAG_CONFLICT', type: 'reversal', cond: `${critAlertContra.length} critical/alert contra flags && biasConf<35`, result: 'FLAG_CONFLICT', pass: true });
      }
    }

    // ── Persistence modifier (layers 5-6 only) ──
    if (layer >= 5) {
      const persMom = persistence && persistence.signal ? persistence.signal : 0;
      if (absVal(persMom) > 0.15) {
        const agrees = sgn(persMom) === sgn(biasScore);
        if (agrees) {
          biasConf = Math.min(biasConf + 8, 75);
          biasScore = clamp(biasScore * 1.10, -1, 1);
        } else {
          biasConf = Math.max(biasConf - 12, 10);
          biasScore *= 0.82;
        }
      }
    }

    // ── Final verdict ──
    biasScore = clamp(biasScore, -1, 1);
    biasConf = Math.round(clamp(biasConf, 0, 95));

    let verdict;
    if (layer <= 3) {
      verdict = biasScore > 0.20 ? 'UP' : biasScore < -0.20 ? 'DOWN' : 'HOLD';
    } else if (layer <= 5) {
      if (biasConf >= 55 && absVal(biasScore) >= 0.30) verdict = biasScore > 0 ? 'UP' : 'DOWN';
      else if (biasConf < 28 || absVal(biasScore) < 0.12) verdict = 'HOLD';
      else verdict = biasScore > 0.12 ? 'UP' : biasScore < -0.12 ? 'DOWN' : 'HOLD';
    } else {
      verdict = absVal(biasScore) > 0.12 && biasConf > 22 ? (biasScore > 0 ? 'UP' : 'DOWN') : 'HOLD';
    }

    const regimeLabel = REGIME_LABELS[regime] || 'Flat / Ranging';

    return { regime, bias, biasScore, biasConf, verdict, path, preemptive, layer, regimeLabel };
  }

  // ── applyBiasFilter: nudge signalVector components toward MDT bias ───────
  function applyBiasFilter(signalVector, mdt) {
    if (!mdt || Math.abs(mdt.biasScore) < 0.18 || mdt.biasConf < 35) return { ...signalVector };

    const biasDir = Math.sign(mdt.biasScore);
    const strength = Math.abs(mdt.biasScore) * (mdt.biasConf / 95);
    const boostMult = mdt.preemptive ? 0.28 : 0.22;
    const dampMult = mdt.preemptive ? 0.22 : 0.18;

    const trendKeys = ['ema', 'macd', 'momentum', 'obv', 'persistence', 'structure', 'adx'];
    const oscKeys = ['rsi', 'stochrsi', 'williamsR', 'mfi', 'bands'];

    const result = { ...signalVector };

    for (const key of trendKeys) {
      if (result[key] === undefined) continue;
      const val = result[key];
      if (Math.sign(val) === biasDir && Math.abs(val) > 0.05) {
        result[key] = val * (1 + strength * boostMult);
      } else if (Math.sign(val) !== biasDir && Math.sign(val) !== 0 && Math.abs(val) > 0.08) {
        result[key] = val * (1 - strength * dampMult);
      }
    }

    for (const key of oscKeys) {
      if (result[key] === undefined) continue;
      const val = result[key];
      if (Math.sign(val) === biasDir && Math.abs(val) > 0.05) {
        result[key] = val * (1 + strength * 0.12);
      } else if (Math.sign(val) !== biasDir && Math.sign(val) !== 0 && Math.abs(val) > 0.08) {
        result[key] = val * (1 - strength * 0.10);
      }
    }

    return result;
  }

  /**
   * Detects the current live market regime based on volatility, trend, momentum, book & tape.
   * Returns a regime object used to adapt indicator weights and build the prediction rationale.
   */
  function detectLiveRegime(candles, bookAnalysis, tapeData) {
    const closes = candles.map(c => c.c);
    const n = closes.length;
    if (n < 20) return { regime: 'unknown', confidence: 0, label: 'Insufficient data' };

    // 1. ATR-based volatility regime
    const atr = calcATR(candles, 10);
    const atrPct = closes[n - 1] > 0 ? (atr / closes[n - 1]) * 100 : 0;
    const isHighVol = atrPct > 0.35;
    const isLowVol = atrPct < 0.10;

    // 2. Trend regime: price vs EMA9 and EMA21
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const e9 = ema9[ema9.length - 1];
    const e21 = ema21[ema21.length - 1];
    const price = closes[n - 1];
    const emaCross = e9 > e21 ? 'bull' : e9 < e21 ? 'bear' : 'flat';
    const priceVsE9 = (price - e9) / (Math.abs(e9) || 1) * 100;

    // 3. Momentum: last 5 bars direction consistency
    let upBars = 0, downBars = 0;
    for (let i = n - 5; i < n; i++) {
      if (closes[i] > closes[i - 1]) upBars++;
      else if (closes[i] < closes[i - 1]) downBars++;
    }
    const momentumBias = upBars >= 4 ? 'strong_up' : downBars >= 4 ? 'strong_down' : 'mixed';

    // 4. Book pressure (if fresh) — expects imbalance in range [-1, 1]
    const bookBias = bookAnalysis?.imbalance > 0.15 ? 'bid_heavy'
      : bookAnalysis?.imbalance < -0.15 ? 'ask_heavy' : 'balanced';

    // 5. Tape aggression (if available) — expects buyRatio normalised 0–1
    const tapeBias = tapeData?.buyRatio > 0.65 ? 'buy_aggression'
      : tapeData?.buyRatio < 0.35 ? 'sell_aggression' : 'neutral_tape';

    // Determine regime
    let regime, confidence, label;
    if (isHighVol && momentumBias !== 'mixed') {
      regime = 'trending_volatile';
      confidence = 0.75;
      label = `Volatile trend (${momentumBias === 'strong_up' ? '↑' : '↓'}) — momentum valid`;
    } else if (!isHighVol && !isLowVol && emaCross !== 'flat') {
      regime = 'trending_smooth';
      confidence = 0.80;
      label = `Smooth trend (EMA ${emaCross}) — high 15m reliability`;
    } else if (isLowVol && Math.abs(priceVsE9) < 0.15) {
      regime = 'ranging';
      confidence = 0.65;
      label = 'Range-bound — mean reversion favored';
    } else if (isHighVol && momentumBias === 'mixed') {
      regime = 'choppy';
      confidence = 0.30;
      label = 'Choppy/indecisive — avoid new entries';
    } else {
      regime = 'neutral';
      confidence = 0.50;
      label = 'Mixed signals — model-driven';
    }

    return { regime, confidence, label, emaCross, momentumBias, bookBias, tapeBias, atrPct, isHighVol, isLowVol };
  }

  /**
   * Detect whether the current 15m tape is expanding faster than the model's
   * legacy assumptions. This is a data-driven release valve for modern crypto
   * sessions: stronger range expansion, more persistent bodies, and heavier
   * volume can justify slightly faster targets/confidence without hardcoding
   * any macro narrative into the signal engine.
   */
  function buildTapeVelocityProfile(candles, tradeFlow, liveRegime, rawComposite = 0) {
    const n = candles?.length || 0;
    const lastPrice = candles?.[n - 1]?.c || 0;
    if (n < 12 || !Number.isFinite(lastPrice) || lastPrice <= 0) {
      return {
        state: 'normal',
        label: 'Normal 15m tape',
        rangeExpansion: 1,
        bodyExpansion: 1,
        volumeBurst: 1,
        directionalConsistency: 0.5,
        netMovePct: 0,
        scoreAligned: false,
        scoreBoostMult: 1,
        confidenceBoostMult: 1,
        targetDriftMult: 1,
        rangeExpansionMult: 1,
        releaseValve: false,
      };
    }

    const recent = candles.slice(-3);
    const baseline = candles.slice(-12, -3);
    const avgRangePct = set => average((set || []).map(c => ((c.h - c.l) / (c.c || 1)) * 100));
    const avgBodyPct = set => average((set || []).map(c => (Math.abs(c.c - c.o) / (Math.abs(c.o) || 1)) * 100));
    const avgVolume = set => average((set || []).map(c => c.v || 0));

    const recentRangePct = avgRangePct(recent) || 0;
    const baselineRangePct = Math.max(avgRangePct(baseline) || recentRangePct || 0.01, 0.01);
    const recentBodyPct = avgBodyPct(recent) || 0;
    const baselineBodyPct = Math.max(avgBodyPct(baseline) || recentBodyPct || 0.005, 0.005);
    const recentVolume = avgVolume(recent) || 0;
    const baselineVolume = Math.max(avgVolume(baseline) || recentVolume || 1, 1);

    const rangeExpansion = clamp(recentRangePct / baselineRangePct, 0.70, 2.60);
    const bodyExpansion = clamp(recentBodyPct / baselineBodyPct, 0.70, 2.60);
    const volumeBurst = clamp(recentVolume / baselineVolume, 0.50, 3.00);

    let sameDirBars = 0;
    let directionalBars = 0;
    for (const bar of recent) {
      const dir = Math.sign((bar.c || 0) - (bar.o || 0));
      if (dir !== 0) {
        directionalBars += 1;
        if (dir === Math.sign((recent[recent.length - 1]?.c || 0) - (recent[0]?.o || 0))) sameDirBars += 1;
      }
    }
    const directionalConsistency = directionalBars ? sameDirBars / directionalBars : 0.5;

    const windowOpen = candles[Math.max(0, n - 4)]?.o || candles[Math.max(0, n - 4)]?.c || lastPrice;
    const netMovePct = ((lastPrice - windowOpen) / (windowOpen || 1)) * 100;
    const driftDir = Math.sign(netMovePct);
    const scoreDir = Math.sign(rawComposite || 0);
    const flowDir = tradeFlow?.aggressor === 'buyers' ? 1 : tradeFlow?.aggressor === 'sellers' ? -1 : 0;
    const momentumDir = liveRegime?.momentumBias === 'strong_up' ? 1
      : liveRegime?.momentumBias === 'strong_down' ? -1 : 0;
    const alignmentVotes = [driftDir, flowDir, momentumDir].filter(v => v !== 0);
    const alignedVotes = scoreDir === 0 ? 0 : alignmentVotes.filter(v => v === scoreDir).length;
    const alignmentScore = scoreDir === 0
      ? 0.5
      : clamp(alignedVotes / Math.max(1, alignmentVotes.length), 0, 1);
    const scoreAligned = scoreDir !== 0 && alignmentScore >= 0.67;
    const trendConfidence = clamp(Number(liveRegime?.confidence ?? 0.5), 0, 1);
    const velocityScore = clamp(
      Math.max(0, rangeExpansion - 1) * 0.34
      + Math.max(0, bodyExpansion - 1) * 0.22
      + Math.max(0, volumeBurst - 1) * 0.16
      + directionalConsistency * 0.18
      + trendConfidence * 0.10,
      0,
      1.25
    );

    const trendingRegime = /trending/.test(String(liveRegime?.regime || ''));
    let state = 'normal';
    let label = 'Normal 15m tape';
    if (velocityScore >= 0.82) {
      state = 'explosive';
      label = 'Explosive 15m tape — fast range expansion';
    } else if (velocityScore >= 0.54) {
      state = 'accelerating';
      label = 'Accelerating 15m tape — momentum carrying farther';
    } else if (rangeExpansion <= 0.88 && bodyExpansion <= 0.92) {
      state = 'compressed';
      label = 'Compressed tape — smaller 15m drift';
    }

    let scoreBoostMult = 1;
    let confidenceBoostMult = 1;
    let targetDriftMult = 1;
    const rangeExpansionMult = clamp(
      1 + Math.max(0, rangeExpansion - 1) * 0.24 + Math.max(0, bodyExpansion - 1) * 0.16,
      0.95,
      1.38
    );

    const boostable = trendingRegime
      && trendConfidence >= 0.58
      && scoreAligned
      && directionalConsistency >= 0.60
      && velocityScore >= 0.48;
    if (boostable) {
      const accel = clamp((velocityScore - 0.48) / 0.62, 0, 1);
      scoreBoostMult = 1 + accel * 0.14;
      confidenceBoostMult = 1 + accel * 0.12;
      targetDriftMult = 1 + accel * 0.26;
    } else if (state === 'compressed') {
      targetDriftMult = 0.94;
    }

    const burstPressure = clamp(
      Math.max(0, volumeBurst - 1) * 0.35
      + Math.max(0, rangeExpansion - 1) * 0.35
      + Math.max(0, bodyExpansion - 1) * 0.30,
      0,
      1
    );

    return {
      state,
      label,
      rangeExpansion,
      bodyExpansion,
      volumeBurst,
      directionalConsistency,
      netMovePct,
      scoreAligned,
      alignmentScore,
      scoreBoostMult,
      confidenceBoostMult,
      targetDriftMult,
      rangeExpansionMult,
      burstPressure,
      releaseValve: boostable && (state === 'accelerating' || state === 'explosive'),
    };
  }

  /**
   * Builds a human-readable + machine-usable prediction rationale.
   * sigVec = array of { name, value, weight } signal contributions.
   * Returns rationale object with lines[], dirLabel, conviction, preLocked flag.
   */
  function buildSignalModel(candles, book, trades, options = {}) {
    if (!candles || candles.length < 20) return null;

    // Gate: coins with no statistical edge pending external feed integration
    if (options.sym && SIGNAL_DISABLED_COINS.has(options.sym.toUpperCase())) {
      return {
        score: 0, confidence: 0, direction: 'NEUTRAL', disabled: true,
        disabledReason: `${options.sym} signal disabled — pending Birdeye/Dexscreener feed`
      };
    }

    const includeMicrostructure = options.includeMicrostructure !== false;
    const includeSetups = options.includeSetups !== false;
    const closes = candles.map(c => c.c);
    const lastPrice = closes[closes.length - 1];
    const session = options.session || getSessionInfo();

    // --- Indicators ---
    const rsi = calcRSI(closes);
    let rsiSig = 0;
    if (rsi > 70) rsiSig = clamp(-0.6 - ((rsi - 70) / 30) * 0.4, -1, -0.2);
    else if (rsi < 30) rsiSig = clamp(0.6 + ((30 - rsi) / 30) * 0.4, 0.2, 1);
    else rsiSig = (rsi - 50) / 50 * 0.3;

    // RSI(7) fast signal for 15m responsiveness — 2026 research: faster period better for scalping
    const rsi7 = calcRSI(closes, 7);
    let rsi7Sig = 0;
    if (rsi7 > 70) rsi7Sig = clamp(-0.6 - ((rsi7 - 70) / 30) * 0.4, -1, -0.2);
    else if (rsi7 < 30) rsi7Sig = clamp(0.6 + ((30 - rsi7) / 30) * 0.4, 0.2, 1);
    else rsi7Sig = (rsi7 - 50) / 50 * 0.3;
    // Blend 70% RSI(14) + 30% RSI(7) for stability with responsiveness
    rsiSig = rsiSig * 0.70 + rsi7Sig * 0.30;

    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const emaCross = (ema9[ema9.length - 1] - ema21[ema21.length - 1]) / (ema21[ema21.length - 1] || 1) * 100;
    const emaSig = clamp(emaCross * 5, -1, 1);

    const sma9 = calcSMA(closes, 9);
    const sma21 = calcSMA(closes, 21);
    const smaCross = (sma9[sma9.length - 1] - sma21[sma21.length - 1]) / (sma21[sma21.length - 1] || 1) * 100;
    const smaSig = clamp(smaCross * 5, -1, 1);

    const vwap = calcVWAP(candles);
    const vwapLast = vwap[vwap.length - 1];
    const vwapDev = ((lastPrice - vwapLast) / (vwapLast || 1)) * 100;
    const vwapStd = calcStdDev(closes, 20);
    const vwapBands = { upper: vwapLast + vwapStd * 2, lower: vwapLast - vwapStd * 2 };
    let vwapSig = 0;
    // Use a rolling 80-candle VWAP for deviation check so the signal
    // doesn't fire on session-level drift that has nothing to do with
    // short-term over-extension.
    const vwapRolling = calcVWAP(candles.slice(-80));
    const vwapRollingLast = vwapRolling[vwapRolling.length - 1];
    const vwapDevRolling = ((lastPrice - vwapRollingLast) / (vwapRollingLast || 1)) * 100;
    if (Math.abs(vwapDevRolling) < 0.3) vwapSig = 0;
    else if (vwapDevRolling > 1.5) vwapSig = -0.5;
    else if (vwapDevRolling < -1.5) vwapSig = 0.5;
    else vwapSig = vwapDevRolling > 0 ? 0.3 : -0.3;

    const obv = calcOBV(candles);
    const obvSlope = slope(obv, 8);
    const obvSig = clamp(obvSlope / 5, -1, 1);

    // Volume delta from candle body position
    const recent = candles.slice(-12);
    let buyV = 0, sellV = 0;
    recent.forEach(c => {
      const range = c.h - c.l || 0.0001;
      const bodyPos = (c.c - c.l) / range;
      const vol = c.v || 1;
      buyV += vol * bodyPos;
      sellV += vol * (1 - bodyPos);
    });
    const volRatio = buyV / (sellV || 1);
    const volSig = clamp((volRatio - 1) * 0.5, -1, 1);

    const mom = closes.length > 6 ? ((closes[closes.length - 1] - closes[closes.length - 7]) / (closes[closes.length - 7] || 1)) * 100 : 0;
    const momSig = clamp(mom / 2, -1, 1);

    // DIAGNOSTIC: RTI dampening analysis for weak coins
    const isWeakCoin = options.sym && ['DOGE', 'BNB'].includes(options.sym.toUpperCase());
    if (isWeakCoin && candles && candles.length > 0) {
      const rawClose = candles[candles.length - 1].c;
      // RTI dampening analysis (rtiCandles not currently available in this context)
    }

    const atr = calcATR(candles);
    const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
    const bands = calcBollinger(closes);
    const bandDistance = bands.position - 0.5;
    let bandSig = 0;
    if (bands.position >= 0.88) bandSig = -clamp((bands.position - 0.88) / 0.12, 0, 1);
    else if (bands.position <= 0.12) bandSig = clamp((0.12 - bands.position) / 0.12, 0, 1);
    else bandSig = clamp(-bandDistance * 0.45, -0.22, 0.22);
    const persistence = calcTrendPersistence(closes, ema21);
    const structure = calcStructureBias(candles, atrPct);

    // --- Extended Indicators ---
    const macdResult = calcMACD(closes);
    const macdHistNorm = lastPrice > 0 ? (macdResult.histogram / lastPrice) * 1000 : 0;
    const macdCross = macdResult.macd > macdResult.signal ? 0.18 : macdResult.macd < macdResult.signal ? -0.18 : 0;
    const macdSig = clamp(macdHistNorm * 2.5 + macdCross, -1, 1);

    const stochRsiResult = calcStochRSI(closes);
    // Simple K-line position with cross confirmation
    const kdCross = stochRsiResult.k > stochRsiResult.d ? 1 : stochRsiResult.k < stochRsiResult.d ? -1 : 0;
    let stochSig = 0;
    if (stochRsiResult.k > 80) {
      stochSig = -0.6 - ((stochRsiResult.k - 80) / 20) * 0.4;
    } else if (stochRsiResult.k < 20) {
      stochSig = 0.6 + ((20 - stochRsiResult.k) / 20) * 0.4;
    } else {
      stochSig = (stochRsiResult.k - 50) / 50 * 0.35;
    }
    stochSig = clamp(stochSig + kdCross * 0.12, -1, 1);

    const adxResult = calcADX(candles);
    const diDiff = (adxResult.pdi - adxResult.mdi) / Math.max(adxResult.pdi + adxResult.mdi, 1);
    const adxStrength = clamp(adxResult.adx / 50, 0, 1);
    const adxSig = clamp(diDiff * adxStrength * 1.2, -1, 1);

    const ichimoku = calcIchimoku(candles);
    let ichiSig = 0;
    if (ichimoku.cloudPos === 'above') ichiSig = 0.5 + (ichimoku.tenkan > ichimoku.kijun ? 0.2 : 0);
    else if (ichimoku.cloudPos === 'below') ichiSig = -0.5 - (ichimoku.tenkan < ichimoku.kijun ? 0.2 : 0);
    else ichiSig = ichimoku.tenkan > ichimoku.kijun ? 0.12 : ichimoku.tenkan < ichimoku.kijun ? -0.12 : 0;
    ichiSig = clamp(ichiSig, -1, 1);

    const wR = calcWilliamsR(candles);
    let wRSig = 0;
    if (wR > -20) wRSig = -0.6 - ((wR + 20) / 20) * 0.4;
    else if (wR < -80) wRSig = 0.6 + ((-80 - wR) / 20) * 0.4;
    else wRSig = clamp((-wR - 50) / 50 * 0.6, -1, 1);
    wRSig = clamp(wRSig, -1, 1);

    const mfi = calcMFI(candles);
    let mfiSig = 0;
    if (mfi > 80) mfiSig = -0.6 - ((mfi - 80) / 20) * 0.4;
    else if (mfi < 20) mfiSig = 0.6 + ((20 - mfi) / 20) * 0.4;
    else mfiSig = (mfi - 50) / 50 * 0.35;
    mfiSig = clamp(mfiSig, -1, 1);

    // --- Hull MA signal (primary trend filter) ---
    const hmaLine = calcHMA(closes, 16);
    const hmaCurr = hmaLine[hmaLine.length - 1];
    const hmaPrev = hmaLine[hmaLine.length - 2] ?? hmaCurr;
    const hmaPrev2 = hmaLine[hmaLine.length - 3] ?? hmaPrev;
    const hmaSlope = (hmaCurr - hmaPrev2) / (Math.abs(hmaPrev2) || 1) * 100;
    const hmaDevPct = (lastPrice - hmaCurr) / (Math.abs(hmaCurr) || 1) * 100;
    let hmaSig = clamp(hmaSlope * 8, -0.7, 0.7);
    if (Math.abs(hmaDevPct) > 0.4) hmaSig += clamp(hmaDevPct * 0.28, -0.3, 0.3);
    hmaSig = clamp(hmaSig, -1, 1);

    // --- VWMA signal (volume-weighted trend confirmation) ---
    const vwmaLine = calcVWMA(candles, 20);
    const vwmaCurr = vwmaLine[vwmaLine.length - 1];
    const vwmaPrev = vwmaLine[vwmaLine.length - 3] ?? vwmaCurr;
    const vwmaSlope = (vwmaCurr - vwmaPrev) / (Math.abs(vwmaPrev) || 1) * 100;
    const vwmaDevPct = (lastPrice - vwmaCurr) / (Math.abs(vwmaCurr) || 1) * 100;
    let vmaSig = clamp(vwmaSlope * 6, -0.6, 0.6);
    vmaSig += clamp(vwmaDevPct * 0.35, -0.4, 0.4);
    vmaSig = clamp(vmaSig, -1, 1);

    // --- Trend Regime Modulation ---
    // In a strong trend (bear dump or bull pump), contrarian oscillator signals (oversold bounces in a dump,
    // or overbought fades in a pump) are destructive counter-trend traps.
    // Damping applied directly before signal vector construction below.

    // --- Book & Trade Flow ---
    const bookAnalysis = analyzeBook(book);
    const tradeFlow = analyzeTradeFlow(trades);
    const microstructure = (() => {
      try {
        if (window.MicrostructureEngine?.analyze && options.sym) {
          return window.MicrostructureEngine.analyze(options.sym, book, trades, {
            horizon: options.horizon || 15,
          });
        }
      } catch (_) { }
      return null;
    })();
    const bookFresh = book && (Date.now() - (book.timestamp || 0)) < 30000;
    const bookSigBase = bookFresh ? clamp((bookAnalysis.imbalance || 0) * 1.5, -1, 1) : 0;
    let flowSigBase = 0;
    if (tradeFlow.aggressor === 'buyers') flowSigBase = Math.min(1, (tradeFlow.buyRatio - 50) / 30);
    else if (tradeFlow.aggressor === 'sellers') flowSigBase = Math.max(-1, -(tradeFlow.sellRatio - 50) / 30);

    // Conservative microstructure blend to preserve existing book/flow semantics.
    const microstructureComposite = clamp(microstructure?.composite || 0, -1, 1);
    const sweepScore = clamp(microstructure?.sweep?.score || 0, -1, 1);
    const vacuumPenalty = clamp(microstructure?.vacuum?.severity || 0, 0, 1);
    const toxicityPenalty = clamp((microstructure?.toxicity?.tox ?? microstructure?.toxicity?.proxy ?? 0), 0, 1);
    const spoofScore = clamp(microstructure?.spoofing?.score || 0, 0, 1);
    const spoofDir = clamp(microstructure?.spoofing?.direction || 0, -1, 1);
    const icebergScore = clamp(microstructure?.iceberg?.score || 0, 0, 1);
    const icebergDir = clamp(microstructure?.iceberg?.direction || 0, -1, 1);
    const toxicitySig = -toxicityPenalty;
    const spoofSig = clamp(spoofDir * spoofScore, -1, 1);
    const icebergSig = clamp(icebergDir * icebergScore, -1, 1);
    const bookSig = clamp(bookSigBase * 0.86 + microstructureComposite * 0.14, -1, 1);
    let flowSig = clamp(flowSigBase * 0.84 + sweepScore * 0.16, -1, 1);
    const bookSigAdj = clamp(bookSig + spoofSig * 0.12, -1, 1);
    flowSig = clamp(flowSig + icebergSig * 0.16, -1, 1);
    if (vacuumPenalty > 0.55) {
      flowSig *= (1 - vacuumPenalty * 0.35);
    }
    if (toxicityPenalty > 0.60) {
      flowSig *= (1 - (toxicityPenalty - 0.60) * 0.35);
    }

    // --- Prediction Market Sentiment (Kalshi + Polymarket) ---
    const polymarketSentiment = calculatePolymarketSentiment(options.sym);
    const mktData = polymarketSentiment.marketData;
    const mktSig = polymarketSentiment.signal;
    const mktModelSig = polymarketSentiment.modelSignal;

    // Supertrend
    const stR = calcSupertrend(candles, 10, 3.0);
    const supertrendSig = stR.signal;

    // CCI
    // FIX (2026-05-04 CRITICAL): Remove sign inversion in neutral zone (line 3406)
    // BEFORE: else cciSig = clamp(-cciVal / 200, ...);  // ← Inverted CCI signal 100% of time in neutral zone
    // AFTER: else cciSig = clamp(cciVal / 200, ...);   // ← Correct: +CCI → +signal (bullish)
    const cciVal = calcCCI(candles, 14);
    let cciSig = 0;
    if (cciVal > 150) cciSig = -clamp((cciVal - 100) / 150, 0, 1);
    else if (cciVal < -150) cciSig = clamp((-100 - cciVal) / 150, 0, 1);
    else cciSig = clamp(cciVal / 200, -0.3, 0.3);  // ✅ FIXED: Removed negation
    cciSig = clamp(cciSig, -1, 1);

    // CMF — Chaikin Money Flow
    const cmfVal = calcCMF(candles, 20);
    const cmfSig = clamp(cmfVal * 2.5, -1, 1);

    // Fisher Transform
    // FIX (2026-05-04 CRITICAL): Remove negation that inverts Fisher signal 100% of the time
    const fisherVal = calcFisher(candles, 10);
    let fisherSig = clamp(fisherVal / 2.5, -1, 1);  // ✅ FIXED: Removed negation

    // Keltner Channels
    const kelt = calcKeltner(candles, 20, 2.0);
    let keltSig = 0;
    if (kelt.position >= 0.88) keltSig = -clamp((kelt.position - 0.88) / 0.12, 0, 1);
    else if (kelt.position <= 0.12) keltSig = clamp((0.12 - kelt.position) / 0.12, 0, 1);
    else keltSig = clamp(-(kelt.position - 0.5) * 0.45, -0.22, 0.22);

    // Use cached Fear & Greed (non-blocking, updates in background)
    const fng = getFngCacheValue();
    let fngSig = 0;
    if (fng !== null) {
      if (fng < 30) fngSig = clamp((30 - fng) / 30 * 0.4, 0, 0.4);      // Extreme Fear → bullish
      else if (fng > 70) fngSig = clamp(-(fng - 70) / 30 * 0.4, -0.4, 0); // Extreme Greed → bearish
    }
    fetchFearGreed(); // kick off background refresh (non-blocking)

    // --- Advanced Market Microstructure Signals ────────────────────────────
    // Funding rate pressure, order book imbalance (10-20 levels), liquidity vacuum
    let fundingRateSig = 0;
    let orderBookImbalanceSig = 0;
    let imbalanceVelocitySig = 0;
    let liquidityDepthSig = 0;
    let liquidityVacuumSig = 0;
    let microStructureMeta = { funding: null, imbalance: null, velocity: null, liquidity: null, vacuum: null };

    if (window.MicrostructureSignals) {
      // ★ Funding Rate: Long/short positioning imbalance on perpetuals
      // High positive rate = long overheated → bearish pressure
      // High negative rate = short overheated → bullish pressure
      if (window._fundingRateCache && window._fundingRateCache[options.sym]) {
        const fundRate = window._fundingRateCache[options.sym];
        const fundAnalysis = window.MicrostructureSignals.analyzeFundingPressure(fundRate.rate);
        fundingRateSig = fundAnalysis.signal * 0.45;  // Weight: 45% of a single indicator
        microStructureMeta.funding = fundAnalysis;
        if (Math.abs(fundRate.rate) > 0.001) {
          predictionDebugLog(`micro-funding:${options.sym}`, 'log', () => `[MicroSignals] ${options.sym} funding rate=${(fundRate.rate * 100).toFixed(3)}% -> sig=${fundAnalysis.signal.toFixed(3)}`, 15000);
        }
      }

      // ★ Order Book Imbalance: Weighted bid/ask depth across 10-20 levels
      // Heavy buy walls = bullish setup (buying absorption capacity)
      // Heavy sell walls = bearish setup (selling pressure)
      if (book && book.bids && book.asks) {
        const balanceMetrics = options.sym ? window.OB?.getBalanceMetrics?.(options.sym) : null;
        const imbalanceData = window.MicrostructureSignals.analyzeOrderBookImbalance(book, {
          levels: [10, 20],
          balance: balanceMetrics,
        });
        if (!imbalanceData.error) {
          const imbalanceSigData = window.MicrostructureSignals.imbalanceToSignal(
            imbalanceData,
            imbalanceData.distribution
          );
          orderBookImbalanceSig = imbalanceSigData.signal * 0.58;
          imbalanceVelocitySig = clamp((imbalanceData.velocity?.value || 0) * 0.42, -0.42, 0.42);
          const liquidity = imbalanceData.liquidity || {};
          const liqScore = Number.isFinite(Number(liquidity.score)) ? Number(liquidity.score) : 0.65;
          const liqDirection = Math.sign(imbalanceSigData.signal || imbalanceData.imbalance || 0);
          const liqRisk = liqScore < 0.38 ? -0.18 : liqScore < 0.58 ? -0.08 : liqScore > 0.78 ? 0.04 : 0;
          liquidityDepthSig = clamp(liqDirection * liqRisk, -0.22, 0.08);
          microStructureMeta.imbalance = {
            ...imbalanceSigData,
            rawImbalance: imbalanceData.imbalance,
            levels: imbalanceData.levels,
          };
          microStructureMeta.velocity = imbalanceData.velocity;
          microStructureMeta.liquidity = liquidity;
          if (Math.abs(imbalanceData.imbalance) > 0.25) {
            const vel = imbalanceData.velocity?.value || 0;
            predictionDebugLog(`micro-book:${options.sym}`, 'log', () => `[MicroSignals] ${options.sym} book imbalance=${imbalanceData.imbalance.toFixed(3)} vel=${vel.toFixed(3)} type=${imbalanceSigData.type} -> sig=${imbalanceSigData.signal.toFixed(3)}`, 7000);
          }
        }
      }

      // ★ Liquidity Vacuum: Detect price levels with sparse order density
      // Bull vacuums (gaps above bids) = likely upside run
      // Bear vacuums (gaps below asks) = likely downside run
      if (book && book.bids && book.asks && lastPrice > 0) {
        const vacuumData = window.MicrostructureSignals.detectLiquidityVacuum(
          book,
          lastPrice,
          30  // Check 30 levels
        );
        if (vacuumData.vacuumFound && vacuumData.zones.length > 0) {
          const vacuumSigData = window.MicrostructureSignals.vacuumToSignal(vacuumData);
          liquidityVacuumSig = vacuumSigData.signal * 0.35;  // Weight: 35% of a single indicator
          microStructureMeta.vacuum = vacuumSigData;
          predictionDebugLog(`micro-vacuum:${options.sym}`, 'log', () => `[MicroSignals] ${options.sym} vacuum risk=${vacuumData.risk.toFixed(3)} type=${vacuumSigData.type} zones=${vacuumData.zonesCount} -> sig=${vacuumSigData.signal.toFixed(3)}`, 7000);
        }
      }
    }

    // --- CoinMarketCap Pro Macro Sentiment (global dominance + volume flux) ---
    let cmcMacroSig = 0;
    if (window._cmcProFeed) {
      const cmcQuote = window._cmcProFeed.getCachedQuote(options.sym?.toUpperCase());
      const cmcGlobal = window._cmcProFeed.globalMetrics?.();
      // Coin dominance trend: if BTC dominance rising → risk-off, bearish micro-cap sentiment
      if (cmcGlobal && cmcGlobal.btcDominance) {
        const btcDom = cmcGlobal.btcDominance || 0;
        if (btcDom > 55) cmcMacroSig -= 0.15;  // BTC dominance high → alts struggle
        else if (btcDom < 42) cmcMacroSig += 0.12;  // BTC dominance low → alts favored
      }
      // Volume anomaly: surge in coin volume relative to 24h avg
      if (cmcQuote && options.sym && (lastPrice || 1) > 0) {
        const vol24h = cmcQuote.volume24h || 0;
        const volPrice = vol24h / Math.max(lastPrice, 0.001);
        if (volPrice > 1e6) cmcMacroSig += 0.08;  // Breakout volume signature
        else if (volPrice < 1e5) cmcMacroSig -= 0.06;  // Anemic volume
      }
      cmcMacroSig = clamp(cmcMacroSig, -0.25, 0.25);
    }
    if (window._cmcProFeed && window._cmcProFeed.startPolling) {
      // Lazy-start polling on first prediction run (non-blocking)
      if (!window._cmcProFeed._pollingStarted) {
        window._cmcProFeed.startPolling(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'], 3600000);
        window._cmcProFeed._pollingStarted = true;
      }
    }

    // --- Trend Regime Modulation ---
    // In a strong trend (bear dump or bull pump), contrarian oscillator signals (oversold bounces in a dump,
    // or overbought fades in a pump) are destructive counter-trend traps. Suppress contrarian signals
    // proportionally to trend and momentum strength so they do not overpower the trend.
    const isStrongBear = (supertrendSig === -1 || hmaSlope < -0.02 || mom < -0.20 || vmaSig < -0.15) && (adxResult.mdi > adxResult.pdi || adxResult.adx > 18 || mom < -0.30);
    const isStrongBull = (supertrendSig === 1 || hmaSlope > 0.02 || mom > 0.20 || vmaSig > 0.15) && (adxResult.pdi > adxResult.mdi || adxResult.adx > 18 || mom > 0.30);

    if (isStrongBear) {
      // Dump regime: Suppress all false oversold bounce signals
      if (rsiSig > 0) rsiSig = 0;
      if (stochSig > 0) stochSig = 0;
      if (wRSig > 0) wRSig = 0;
      if (bandSig > 0) bandSig = 0;
      if (mfiSig > 0) mfiSig = 0;
      if (vwapSig > 0) vwapSig = 0;
      if (cciSig > 0) cciSig = 0;
      if (keltSig > 0) keltSig = 0;
      if (fisherSig > 0) fisherSig = 0;
    } else if (isStrongBull) {
      // Pump regime: Suppress all false overbought fade signals
      if (rsiSig < 0) rsiSig = 0;
      if (stochSig < 0) stochSig = 0;
      if (wRSig < 0) wRSig = 0;
      if (bandSig < 0) bandSig = 0;
      if (mfiSig < 0) mfiSig = 0;
      if (vwapSig < 0) vwapSig = 0;
      if (cciSig < 0) cciSig = 0;
      if (keltSig < 0) keltSig = 0;
      if (fisherSig < 0) fisherSig = 0;
    }

    // Last known LLM verdict for this coin (async -- carried forward across
    // ticks by preservePredictionOverlay until a fresher one lands). Zeroed
    // out if stale (>6min old -- longer than either contract horizon), if
    // the raw-data truth gate nullified it, or if it never resolved to a
    // real UP/DOWN call. This is a *signal*, same as any indicator above --
    // its actual influence comes from applyOnlineWeightOverlay's per-signal
    // mult once poly5m-resolution-tracker.js has graded enough real calls.
    const llmVerdict = window._predictions?.[options.sym]?.llm;
    const llmFreshMs = 6 * 60_000;
    const llmIsFresh = !!llmVerdict && Number.isFinite(llmVerdict.ts) && (Date.now() - llmVerdict.ts) < llmFreshMs;
    const llmSig = (llmIsFresh && !llmVerdict.nullified && (llmVerdict.call === 'UP' || llmVerdict.call === 'DOWN'))
      ? (llmVerdict.call === 'UP' ? 1 : -1) * clamp(Number(llmVerdict.confidence || 0) / 100, 0, 1)
      : 0;

    const signalVector = {
      hma: hmaSig,
      vwma: vmaSig,
      llm: llmSig,
      rsi: rsiSig,
      ema: emaSig,
      sma: smaSig,
      vwap: vwapSig,
      obv: obvSig,
      volume: volSig,
      momentum: momSig,
      bands: bandSig,
      persistence: persistence.signal,
      structure: structure.signal,
      book: includeMicrostructure ? bookSigAdj : 0,
      flow: includeMicrostructure ? flowSig : 0,
      toxicity: includeMicrostructure ? toxicitySig : 0,
      spoof: includeMicrostructure ? spoofSig : 0,
      iceberg: includeMicrostructure ? icebergSig : 0,
      // ★ NEW: Advanced microstructure signals (2026-05-15)
      fundingRate: fundingRateSig,         // Perpetual market positioning pressure
      orderBookImbalance: orderBookImbalanceSig,  // Weighted bid/ask depth (10-20 levels)
      imbalanceVelocity: imbalanceVelocitySig,  // 15m rolling change in weighted imbalance
      liquidityDepth: liquidityDepthSig,  // Thin/deep 10/20-level liquidity regime
      liquidityVacuum: liquidityVacuumSig,  // Price levels with sparse order density
      macd: macdSig,
      stochrsi: stochSig,
      adx: adxSig,
      ichimoku: ichiSig,
      williamsR: wRSig,
      mfi: mfiSig,
      mktSentiment: mktModelSig,
      supertrend: supertrendSig,
      cci: cciSig,
      cmf: cmfSig,
      fisher: fisherSig,
      keltner: keltSig,
      fearGreed: fngSig,
      cmcMacro: cmcMacroSig,  // ★ CoinMarketCap Pro: BTC dominance + global volume
    };

    // --- SPDF QUANTUM DEADBAND INTERCEPT ---
    // Force all active continuous signals into discrete integer spin states (+1, 0, -1)
    for (const key of Object.keys(signalVector)) {
      const val = signalVector[key];
      if (typeof val === 'number') {
        if (val > 0.15) signalVector[key] = 1;
        else if (val < -0.15) signalVector[key] = -1;
        else signalVector[key] = 0;
      }
    }

    // ── PATCH1.11: Wall Absorption Signal Suppression ──────────────────────
    // When a bid/ask wall absorption event is detected on 1m candles,
    // noisy indicators (momentum, OBV, stochrsi) fire in the wick direction.
    // Suppress them and inject counter-bias via persistence.
    const wallAbs = detectWallAbsorption(options.candles1m || null);
    if (wallAbs.detected) {
      const sup = wallAbs.strength;
      signalVector.momentum = signalVector.momentum * (1 - sup * 0.88); // most noisy
      signalVector.obv = signalVector.obv * (1 - sup * 0.68); // wrong-dir accumulation
      signalVector.stochrsi = signalVector.stochrsi * (1 - sup * 0.52); // reacts to wick overshoots
      // Inject absorption counter-bias via persistence (highest-quality weight)
      const absorbBias = wallAbs.dir * sup * 0.65;
      signalVector.persistence = clamp(signalVector.persistence * 0.4 + absorbBias, -1, 1);
    }
    // ── SMC: Evaluate Liquidity Sweeps + FVGs + Polymarket Edge ───────────
    const smcPools = detectLiquidityPools(candles);
    const smcSweeps = detectLiquiditySweeps(candles, smcPools);
    const smcFVGs = detectFVGs(candles);
    let smcFlags = [];

    const polymarketProb = mktData?.combinedProb ?? 0.5;

    for (const sweep of smcSweeps) {
      const fvg = smcFVGs.find(f => f.dir === sweep.dir && f.index > sweep.index);
      if (fvg) {
        let aggressive = false;
        if (sweep.dir === 1 && polymarketProb < 0.35) aggressive = true;
        if (sweep.dir === -1 && polymarketProb > 0.65) aggressive = true;

        const lastC = candles[candles.length - 1];
        const retraced = sweep.dir === 1 ? lastC.l <= fvg.ce : lastC.h >= fvg.ce;

        if (aggressive || retraced) {
          const bias = sweep.dir === 1 ? 'bullish' : 'bearish';
          smcFlags.push({
            id: 'SMC_SWEEP_FVG',
            severity: 'critical',
            bias: bias,
            label: 'SMC Sweep + FVG',
            desc: `Swept liquidity at ${sweep.pool.toFixed(2)}, formed ${bias} FVG. ${aggressive ? '(Aggressive Edge Entry)' : '(CE Retracement Entry)'}`,
            strength: 0.95
          });
        }
      }
    }

    // ── MDT: Momentum Decision Tree (preemptive bias engine) ──────────────
    const reversalFlags = detectReversalFlags(candles, rsi, macdResult, adxResult, obvSlope, mom);
    reversalFlags.push(...smcFlags);
    const mdt = runMomentumDecisionTree(candles, {
      rsi, emaCross, mom, vwapDevRolling, obvSlope,
      adxResult, macdResult, stochRsiResult, persistence, structure, reversalFlags,
    });
    // Apply bias filter BEFORE composite is computed
    const biasedVector = applyBiasFilter(signalVector, mdt);
    Object.assign(signalVector, biasedVector);
    const activeKeys = Object.keys(signalVector).filter(key => includeMicrostructure || !MICRO_SIGNAL_KEYS.includes(key));
    const modelActiveKeys = POLYMARKET_VERIFY_ONLY
      ? activeKeys.filter(key => key !== 'mktSentiment')
      : activeKeys;
    // Regime detection BEFORE composite — adaptiveWeights must affect actual score computation
    const _tapeNorm = tradeFlow ? { buyRatio: tradeFlow.buyRatio / 100 } : null;
    const liveRegime = detectLiveRegime(candles, bookAnalysis, _tapeNorm);
    const regimeWeights = applyRegimeMults(COMPOSITE_WEIGHTS, liveRegime.regime);
    const adaptiveWeights = applyOnlineWeightOverlay(options.sym, regimeWeights);

    // H15-TUNING: Apply h15-specific indicator weights if available and horizon is h15
    let coinBias = PER_COIN_INDICATOR_BIAS[options.sym?.toUpperCase()] ?? {};
    if (options.horizon === 15 && window._h15Tuner) {
      const baseBias = coinBias;
      coinBias = window._h15Tuner.getTunedBias(15, options.sym?.toUpperCase(), baseBias);
    }

    // MergeKit Ensembling: SLERP interpolation across regime matrices + coin biases.
    // Base is `adaptiveWeights` (regime mults + per-signal online-learned mult),
    // NOT the static COMPOSITE_WEIGHTS -- using the static table here silently
    // discarded every online-learned mult (incl. the LLM signal's, once it has
    // a track record) any time MergeKit succeeded, which is every tick.
    let effectiveWeights = adaptiveWeights;
    if (typeof window !== 'undefined' && window.PredictionWeightMergeKit?.mergeModelWeights) {
      try {
        effectiveWeights = window.PredictionWeightMergeKit.mergeModelWeights(
          adaptiveWeights,
          coinBias,
          window.PredictionRegimeWeights?.REGIME_WEIGHT_MULTS?.[liveRegime.regime] || {},
          // Live-tunable: set window.MERGEKIT_SLERP_T from the console to adjust
          // MergeKit's pull on the composite without a redeploy. Default raised
          // from 0.35 -> 0.5 so the regime-blended vector carries real weight.
          { slerpT: (typeof window !== 'undefined' && Number.isFinite(window.MERGEKIT_SLERP_T)) ? window.MERGEKIT_SLERP_T : 0.5 }
        );
      } catch (_) { effectiveWeights = adaptiveWeights; }
    }

    const weightedComposite = keys => {
      const effW = key => ((effectiveWeights[key] ?? OUTER_ORBITAL_WEIGHTS[key] ?? 0) * (coinBias[key] ?? 1.0));
      const totalWeight = keys.reduce((sum, key) => sum + effW(key), 0) || 1;
      return keys.reduce((sum, key) => sum + signalVector[key] * effW(key), 0) / totalWeight;
    };
    const coreComposite = weightedComposite(CORE_SIGNAL_KEYS);
    const microComposite = includeMicrostructure ? weightedComposite(MICRO_SIGNAL_KEYS) : 0;
    const rawComposite = weightedComposite(modelActiveKeys);
    const tapeVelocity = buildTapeVelocityProfile(candles, tradeFlow, liveRegime, rawComposite);

    // ADX gate: suppress signal in flat/ranging markets (ADX < 20 = noise).
    // Proportional — dead-flat market (ADX=5) dampens composite by 75%.
    const adxGate = adxResult.adx < 10
      ? Math.max(0.05, adxResult.adx / 10 * 0.25)
      : adxResult.adx < 20
        ? Math.max(0.25, adxResult.adx / 20)
        : 1.0;

    // Amplify: realistic composite range is 0–0.45 → stretch to 0–0.9 so
    // high-agreement signals reach meaningful confidence levels in the UI.
    const composite = rawComposite; // keep raw for downstream use
    const mdtScoreMult = (() => {
      if (!mdt || Math.abs(mdt.biasScore) < 0.18 || mdt.biasConf < 35) return 1;
      const aligns = Math.sign(rawComposite) === Math.sign(mdt.biasScore) || rawComposite === 0;
      const strength = Math.abs(mdt.biasScore) * (mdt.biasConf / 95);
      const maxEffect = mdt.preemptive ? 0.18 : 0.11;
      return aligns ? (1 + strength * maxEffect) : (1 - strength * maxEffect * 0.65);
    })();
    const _sessMult = 1.0; // session multipliers removed — crypto is 24/7

    // CRITICAL FIX 2026-05-06: Detect bearish divergence (uptrend + negative momentum = reversal imminent)
    // Signal: price trending up but momentum falling = exhaustion = reverse is coming
    // Use REAL-TIME CFM momentum (from window._cfm) not stale 6-bar ROC — CFM has live tick momentum
    // SAFE: Fallback to candle ROC if CFM not available (prevents crashes if CFM loads late)
    let liveRealtimeMomentum = mom;  // Start with candle ROC as safe default
    try {
      const cfmData = window._cfm?.[options.sym?.toUpperCase()];
      if (cfmData && typeof cfmData.momentum === 'number') {
        liveRealtimeMomentum = cfmData.momentum;  // Override with real-time CFM only if valid
      }
    } catch (e) {
      // Silently fall back to mom if CFM access fails — don't crash
    }

    const modelCompositeDir = rawComposite > 0.05 ? 1 : rawComposite < -0.05 ? -1 : 0;
    const liveMomentumDir = liveRealtimeMomentum > 0.02 ? 1 : liveRealtimeMomentum < -0.02 ? -1 : 0;
    const liveMomentumDivergence = modelCompositeDir !== 0 && liveMomentumDir !== 0 && modelCompositeDir !== liveMomentumDir;
    const divergenceSuppression = liveMomentumDivergence
      ? (options.sym?.toUpperCase() === 'SOL' ? 0.42 : 0.58)
      : 1.0;

    // ★ NEW (2026-05-15): Microstructure Consensus Logic
    // FINDING: Momentum alone shows 47% directional accuracy (worse than random)
    // STRATEGY: Use microstructure signals to validate/override momentum direction
    // RULE: Fire signal only if 2+ signals agree (funding+book+vacuum+momentum)
    let consensusDirection = 0;  // -1=bearish, 0=conflict, +1=bullish
    let consensusConfidence = 0;  // 0-1 scale
    const microSignals = [
      { name: 'funding', sig: fundingRateSig, strength: Math.abs(fundingRateSig) * 0.45 },
      { name: 'book', sig: orderBookImbalanceSig, strength: Math.abs(orderBookImbalanceSig) * 0.50 },
      { name: 'imbalanceVelocity', sig: imbalanceVelocitySig, strength: Math.abs(imbalanceVelocitySig) * 0.40 },
      { name: 'vacuum', sig: liquidityVacuumSig, strength: Math.abs(liquidityVacuumSig) * 0.35 },
    ];

    // Count agreements (2+ signals pointing same direction = consensus)
    const bullCount = microSignals.filter(s => s.sig > 0.05).length + (momSig > 0.05 ? 1 : 0);
    const bearCount = microSignals.filter(s => s.sig < -0.05).length + (momSig < -0.05 ? 1 : 0);

    if (bullCount >= 2) {
      consensusDirection = 1;  // Bullish consensus
      consensusConfidence = Math.min(1, bullCount * 0.35);  // 2 signals → 70%, 3 → 95%, 4 → 100%
    } else if (bearCount >= 2) {
      consensusDirection = -1;  // Bearish consensus
      consensusConfidence = Math.min(1, bearCount * 0.35);
    }
    // else: consensusDirection = 0 (conflict, no consensus)

    // Apply consensus override as a directional blend. The previous multiplier
    // could amplify the wrong sign when consensus and raw composite disagreed.
    let consensusComposite = rawComposite;
    let consensusAdjustment = 0;
    if (consensusDirection !== 0 && consensusConfidence > 0.5) {
      const consensusTarget = consensusDirection * clamp(consensusConfidence * 0.44, 0.18, 0.44);
      const compositeConflicts = Math.sign(rawComposite) !== 0 && Math.sign(rawComposite) !== consensusDirection;
      const blend = compositeConflicts ? 0.68 : 0.24;
      consensusComposite = clamp(rawComposite * (1 - blend) + consensusTarget * blend, -1, 1);
      consensusAdjustment = consensusComposite - rawComposite;
    }

    // Log consensus (only if meaningful)
    if ((bullCount >= 2 || bearCount >= 2) && Math.abs(liveRealtimeMomentum) > 0.05) {
      predictionDebugLog(`consensus:${options.sym}`, 'log', () => `[CONSENSUS] ${options.sym}: direction=${consensusDirection > 0 ? 'BULL' : 'BEAR'} conf=${(consensusConfidence * 100).toFixed(0)}% (${bullCount + bearCount} signals), mom=${momSig.toFixed(2)}`, 20000);
    }

    // REMOVED PHASE INVERSION: A 45% loss rate is a 55% win rate. Flipping the score turned a winning edge into a losing one!
    let score = clamp(consensusComposite * 1.6 * adxGate * divergenceSuppression * (ENABLE_MDT_SCORE_MULT ? mdtScoreMult : 1) * _sessMult * (tapeVelocity.scoreBoostMult || 1), -1, 1);

    // Edge Committee overlay — selective voting by top-performing indicators (when config loaded)
    let edgeCommitteeVote = null;
    if (window.EdgeCommittee?.applyScoreGate) {
      try {
        const gated = window.EdgeCommittee.applyScoreGate(score, signalVector, options.sym);
        score = gated.score;
        edgeCommitteeVote = gated.vote || null;
      } catch (err) {
        console.warn('[EdgeCommittee] applyScoreGate failed:', err?.message || err);
      }
    }
    const agreement = summarizeAgreement(Object.fromEntries(modelActiveKeys.map(key => [key, signalVector[key]])));
    const coreAgreement = summarizeAgreement(Object.fromEntries(CORE_SIGNAL_KEYS.map(key => [key, signalVector[key]])));

    const indicatorsPack = { rsi, emaCross, vwapDev: vwapDevRolling, vwapBands };
    const scalpSetups = includeSetups ? detectScalpSetups(candles, indicatorsPack, bookAnalysis, tradeFlow, session) : [];

    const indicatorsSummary = {
      rsi: { value: rsi, signal: rsiSig, label: rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : rsi > 55 ? 'Bullish' : rsi < 45 ? 'Bearish' : 'Neutral' },
      ema: { value: emaCross, signal: emaSig, label: emaCross > 0.1 ? 'Bull Cross' : emaCross < -0.1 ? 'Bear Cross' : 'Converging', ema9: ema9[ema9.length - 1], ema21: ema21[ema21.length - 1] },
      vwap: { value: vwapDevRolling, signal: vwapSig, price: vwapRollingLast, bands: vwapBands, label: Math.abs(vwapDevRolling) < 0.3 ? 'At VWAP' : vwapDevRolling > 0 ? 'Above VWAP' : 'Below VWAP' },
      obv: { slope: obvSlope, signal: obvSig, label: obvSlope > 2 ? 'Accumulation' : obvSlope < -2 ? 'Distribution' : 'Flat' },
      volume: { buyPct: buyV / ((buyV + sellV) || 1) * 100, sellPct: sellV / ((buyV + sellV) || 1) * 100, ratio: volRatio, signal: volSig, label: volRatio > 1.2 ? 'Buy Pressure' : volRatio < 0.8 ? 'Sell Pressure' : 'Balanced' },
      momentum: { value: mom, signal: momSig, label: mom > 0.5 ? 'Rising' : mom < -0.5 ? 'Falling' : 'Flat' },
      bands: { position: bands.position, widthPct: bands.widthPct, signal: bandSig, upper: bands.upper, lower: bands.lower, label: bands.position >= 0.88 ? 'Upper-band stretch' : bands.position <= 0.12 ? 'Lower-band stretch' : 'Inside bands' },
      persistence,
      structure,
      book: bookAnalysis,
      flow: { ...tradeFlow, signal: flowSig },
      microstructure: microstructure || {
        composite: 0,
        sweep: { score: 0, label: 'No tape' },
        vacuum: { active: false, severity: 0, label: 'Unknown' },
        toxicity: { available: false, proxy: 0, vpin: 0, tox: 0, label: 'Unavailable' },
        spoofing: { score: 0, direction: 0, side: 'none', label: 'Unavailable' },
        iceberg: { score: 0, direction: 0, side: 'none', label: 'Unavailable' },
      },
      macd: { macd: macdResult.macd, signal: macdResult.signal, histogram: macdResult.histogram, sig: macdSig, label: macdResult.histogram > 0 ? (macdResult.macd > macdResult.signal ? 'Bull MACD' : 'Bullish') : (macdResult.macd < macdResult.signal ? 'Bear MACD' : 'Bearish') },
      stochrsi: { k: stochRsiResult.k, d: stochRsiResult.d, signal: stochSig, label: stochRsiResult.k > 80 ? 'Overbought' : stochRsiResult.k < 20 ? 'Oversold' : stochRsiResult.k > stochRsiResult.d ? 'Bull cross' : 'Bear cross' },
      ichimoku: { ...ichimoku, signal: ichiSig, label: ichimoku.cloudPos === 'above' ? 'Above cloud' : ichimoku.cloudPos === 'below' ? 'Below cloud' : 'In cloud' },
      williamsR: { value: wR, signal: wRSig, label: wR > -20 ? 'Overbought' : wR < -80 ? 'Oversold' : 'Neutral' },
      mfi: { value: mfi, signal: mfiSig, label: mfi > 80 ? 'Overbought' : mfi < 20 ? 'Oversold' : mfi > 55 ? 'Bullish' : mfi < 45 ? 'Bearish' : 'Neutral' },
      hma: { value: hmaCurr, slope: hmaSlope, signal: hmaSig, label: hmaSlope > 0.04 ? 'Rising' : hmaSlope < -0.04 ? 'Falling' : 'Flat' },
      vwma: { value: vwmaCurr, slope: vwmaSlope, dev: vwmaDevPct, signal: vmaSig, label: vwmaDevPct > 0.3 ? 'Price above VWMA' : vwmaDevPct < -0.3 ? 'Price below VWMA' : 'At VWMA' },
      mktSentiment: {
        kalshi: mktData?.kalshi ?? null,
        poly: mktData?.poly ?? null,
        combined: mktData?.combinedProb ?? null,
        signal: mktSig,
        label: polymarketSentiment.label,
      },
      tapeVelocity: {
        state: tapeVelocity.state,
        label: tapeVelocity.label,
        rangeExpansion: tapeVelocity.rangeExpansion,
        bodyExpansion: tapeVelocity.bodyExpansion,
        volumeBurst: tapeVelocity.volumeBurst,
        directionalConsistency: tapeVelocity.directionalConsistency,
        targetDriftMult: tapeVelocity.targetDriftMult,
        rangeExpansionMult: tapeVelocity.rangeExpansionMult,
      },
      cmcMacro: {
        signal: cmcMacroSig,
        label: cmcMacroSig > 0.15 ? 'CMC: Alts favored' : cmcMacroSig < -0.15 ? 'CMC: BTC dominance' : 'CMC: Neutral',
      },
      // ★ NEW: Advanced market microstructure signals (2026-05-15)
      fundingRate: {
        signal: fundingRateSig,
        meta: microStructureMeta.funding,
        label: microStructureMeta.funding
          ? `Funding: ${microStructureMeta.funding.pressure} (${(microStructureMeta.funding.signal * 100).toFixed(1)}%)`
          : 'Funding: N/A',
      },
      orderBookImbalance: {
        signal: orderBookImbalanceSig,
        meta: microStructureMeta.imbalance,
        label: microStructureMeta.imbalance
          ? `Book 10/20: ${microStructureMeta.imbalance.type} (${(microStructureMeta.imbalance.signal * 100).toFixed(1)}%)`
          : 'Book: Neutral',
      },
      imbalanceVelocity: {
        signal: imbalanceVelocitySig,
        meta: microStructureMeta.velocity,
        label: microStructureMeta.velocity
          ? `Imbalance velocity: ${microStructureMeta.velocity.band || 'stable'} (${(microStructureMeta.velocity.value * 100).toFixed(1)}%)`
          : 'Imbalance velocity: stable',
      },
      liquidityDepth: {
        signal: liquidityDepthSig,
        meta: microStructureMeta.liquidity,
        label: microStructureMeta.liquidity
          ? `Liquidity: ${microStructureMeta.liquidity.band || 'normal'} (${Math.round((microStructureMeta.liquidity.score || 0) * 100)} score)`
          : 'Liquidity: unknown',
      },
      liquidityVacuum: {
        signal: liquidityVacuumSig,
        meta: microStructureMeta.vacuum,
        label: microStructureMeta.vacuum
          ? `Vacuum: ${microStructureMeta.vacuum.type} risk=${(microStructureMeta.vacuum.risk * 100).toFixed(1)}%`
          : 'Vacuum: None detected',
      },
      // ★ NEW: Consensus model metrics (2026-05-15)
      microstructureConsensus: {
        direction: consensusDirection,  // -1/0/+1
        confidence: consensusConfidence,  // 0-1 scale
        signalCount: bullCount + bearCount,  // How many signals agreed
        adjustedComposite: consensusComposite,
        adjustment: consensusAdjustment,
        label: consensusDirection > 0
          ? `Consensus BULL (${(consensusConfidence * 100).toFixed(0)}% confidence)`
          : consensusDirection < 0
            ? `Consensus BEAR (${(consensusConfidence * 100).toFixed(0)}% confidence)`
            : 'No consensus (conflict)',
      },
    };
    const driverSummary = summarizeSignalDrivers(signalVector, indicatorsSummary);
    const dir = directionFromScore(score);

    // DIAGNOSTIC: Signal composition analysis for weak coins
    if (isWeakCoin && Math.abs(score) > 0.20) {  // Interesting signals only
      const topIndicators = Object.entries(signalVector)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 5)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`);
      const conf = confidenceFromScore(Math.abs(score));
      console.debug(`[SIGNAL-COMP] ${options.sym}: score=${score.toFixed(3)} conf=${conf}% dir=${dir} bull=${agreement.bulls}/${agreement.active} top: ${topIndicators.join(' ')}`);
    }

    // Build sigVec for rationale(named signal contributions, using adaptive weights)
    const _sigVec = [];
    if (typeof rsiSig !== 'undefined') _sigVec.push({ name: 'rsi', value: rsiSig, weight: adaptiveWeights.rsi ?? COMPOSITE_WEIGHTS.rsi ?? 0.06 });
    if (typeof macdSig !== 'undefined') _sigVec.push({ name: 'macd', value: macdSig, weight: adaptiveWeights.macd ?? COMPOSITE_WEIGHTS.macd ?? 0.07 });
    if (typeof emaSig !== 'undefined') _sigVec.push({ name: 'ema', value: emaSig, weight: adaptiveWeights.ema ?? COMPOSITE_WEIGHTS.ema ?? 0.05 });
    if (typeof hmaSig !== 'undefined') _sigVec.push({ name: 'hma', value: hmaSig, weight: adaptiveWeights.hma ?? COMPOSITE_WEIGHTS.hma ?? 0.07 });
    if (typeof bandSig !== 'undefined') _sigVec.push({ name: 'bands', value: bandSig, weight: adaptiveWeights.bands ?? COMPOSITE_WEIGHTS.bands ?? 0.08 });
    if (typeof stochSig !== 'undefined') _sigVec.push({ name: 'stochrsi', value: stochSig, weight: adaptiveWeights.stochrsi ?? COMPOSITE_WEIGHTS.stochrsi ?? 0.04 });
    if (typeof wRSig !== 'undefined') _sigVec.push({ name: 'williamsR', value: wRSig, weight: adaptiveWeights.williamsR ?? COMPOSITE_WEIGHTS.williamsR ?? 0.07 });
    if (typeof bookSigAdj !== 'undefined') _sigVec.push({ name: 'book', value: bookSigAdj, weight: adaptiveWeights.book ?? COMPOSITE_WEIGHTS.book ?? 0.25 });
    if (typeof obvSig !== 'undefined') _sigVec.push({ name: 'obv', value: obvSig, weight: adaptiveWeights.obv ?? COMPOSITE_WEIGHTS.obv ?? 0.07 });
    if (typeof cciSig !== 'undefined') _sigVec.push({ name: 'cci', value: cciSig, weight: adaptiveWeights.cci ?? COMPOSITE_WEIGHTS.cci ?? 0.05 });
    if (typeof fngSig !== 'undefined') _sigVec.push({ name: 'fearGreed', value: fngSig, weight: adaptiveWeights.fearGreed ?? COMPOSITE_WEIGHTS.fearGreed ?? 0.12 });
    if (typeof vwapSig !== 'undefined') _sigVec.push({ name: 'vwap', value: vwapSig, weight: adaptiveWeights.vwap ?? OUTER_ORBITAL_WEIGHTS.vwap ?? 0.05 });
    if (typeof flowSig !== 'undefined') _sigVec.push({ name: 'flow', value: flowSig, weight: adaptiveWeights.flow ?? COMPOSITE_WEIGHTS.flow ?? 0.22 });
    if (typeof toxicitySig !== 'undefined') _sigVec.push({ name: 'toxicity', value: toxicitySig, weight: adaptiveWeights.toxicity ?? COMPOSITE_WEIGHTS.toxicity ?? 0.06 });
    if (typeof spoofSig !== 'undefined') _sigVec.push({ name: 'spoof', value: spoofSig, weight: adaptiveWeights.spoof ?? COMPOSITE_WEIGHTS.spoof ?? 0.07 });
    if (typeof icebergSig !== 'undefined') _sigVec.push({ name: 'iceberg', value: icebergSig, weight: adaptiveWeights.iceberg ?? COMPOSITE_WEIGHTS.iceberg ?? 0.08 });
    if (typeof volSig !== 'undefined') _sigVec.push({ name: 'volume', value: volSig, weight: adaptiveWeights.volume ?? COMPOSITE_WEIGHTS.volume ?? 0.10 });
    if (!POLYMARKET_VERIFY_ONLY && typeof mktSig !== 'undefined') _sigVec.push({ name: 'mktSentiment', value: mktSig, weight: adaptiveWeights.mktSentiment ?? COMPOSITE_WEIGHTS.mktSentiment ?? 0.18 });
    // ★ NEW: Microstructure signals (higher priority due to real-time market data)
    if (typeof fundingRateSig !== 'undefined' && Math.abs(fundingRateSig) > 0.01) _sigVec.push({ name: 'fundingRate', value: fundingRateSig, weight: adaptiveWeights.fundingRate ?? 0.15 });
    if (typeof orderBookImbalanceSig !== 'undefined' && Math.abs(orderBookImbalanceSig) > 0.01) _sigVec.push({ name: 'orderBookImbalance', value: orderBookImbalanceSig, weight: adaptiveWeights.orderBookImbalance ?? 0.16 });
    if (typeof imbalanceVelocitySig !== 'undefined' && Math.abs(imbalanceVelocitySig) > 0.01) _sigVec.push({ name: 'imbalanceVelocity', value: imbalanceVelocitySig, weight: adaptiveWeights.imbalanceVelocity ?? 0.12 });
    if (typeof liquidityDepthSig !== 'undefined' && Math.abs(liquidityDepthSig) > 0.01) _sigVec.push({ name: 'liquidityDepth', value: liquidityDepthSig, weight: adaptiveWeights.liquidityDepth ?? 0.08 });
    if (typeof liquidityVacuumSig !== 'undefined' && Math.abs(liquidityVacuumSig) > 0.01) _sigVec.push({ name: 'liquidityVacuum', value: liquidityVacuumSig, weight: adaptiveWeights.liquidityVacuum ?? 0.12 });

    // Resolve polymarket probability for alignment check
    const _polymarketProb = mktData?.combinedProb ?? null;

    const rationale = buildRationale(_sigVec, liveRegime, _polymarketProb, options.sym || '');
    const projectionTargetDriftMult = tapeVelocity.targetDriftMult || 1;
    const projectionRangeExpansionMult = tapeVelocity.rangeExpansionMult || 1;

    return {
      price: lastPrice,
      score,
      signal: signalFromScore(score),
      confidence: Math.round(clamp(confidenceFromScore(Math.abs(score)) * (tapeVelocity.confidenceBoostMult || 1), 0, 95)),
      indicators: indicatorsSummary,
      projections: SHORT_HORIZON_MINUTES.reduce((acc, horizonMin) => {
        // Binary-window scale: move over THIS horizon, not /60 hour fraction.
        // Old targetScale=horizonMin/60 made 5m projections ~static, so polyAlign
        // collapsed to "current vs PTB" and kept calling UP after lagging bull runs.
        const targetScale = Math.max(0.35, Math.min(1.15, horizonMin / 15));
        const rangeScale = Math.max(0.18, Math.sqrt(horizonMin / 15) * 0.55) * projectionRangeExpansionMult;

        // Use model score for projection target so UI targets match verdict direction
        const expectedMovePct = Math.max(Math.abs(mom / 100), (atr / lastPrice) * 0.55);
        const modelDrift = score * expectedMovePct;

        let target = lastPrice * (1 + modelDrift * targetScale * projectionTargetDriftMult);
        const entry = projectionKey(horizonMin);
        acc[entry] = { horizonMin, target, high: target + atr * rangeScale, low: target - atr * rangeScale };

        // For the 5-min horizon, align target to the current 5-min Polymarket contract
        // Settlement = final price vs FIXED price-to-beat (not candle open→close).
        if (horizonMin === 5) {
          const coinKey = String(options.sym || '').toUpperCase();
          const p5m = window.PredictionMarkets?.getCoin(coinKey)?.poly5m ?? null;
          const polyRef = Number(p5m?.targetPriceNum ?? p5m?.priceToBeatNum);
          const polyYes = p5m?.probability ?? null;
          if (Number.isFinite(polyRef) && polyRef > 0) {
            const closeTimeMs = p5m?.closeTime ? new Date(p5m.closeTime).getTime() : null;
            const remainingMs = Number.isFinite(closeTimeMs) ? Math.max(0, closeTimeMs - Date.now()) : 5 * 60_000;
            const atrDollar = (Number.isFinite(atr) && atr > 0) ? atr : lastPrice * 0.0017;
            const live = resolveLiveSettlementPx(coinKey, lastPrice);
            const livePx = live.px || lastPrice;
            const momDir = window.Microstructure?.getSnapshot?.(coinKey)?.momentum?.dir || null;
            const cdf = computeBinaryPtbCdf({
              ptb: polyRef,
              livePx,
              windowMin: 5,
              remainingMs,
              atrDollar,
              score,
              liveDir: Math.sign(mom) || 0,
              momDir,
              regime: liveRegime?.regime,
              burstPressure: tapeVelocity?.burstPressure ?? 0,
            });
            target = cdf.meanFinal;
            acc[entry].target = cdf.meanFinal;
            acc[entry].high = cdf.meanFinal + atrDollar * rangeScale * Math.sqrt(cdf.remainingFrac);
            acc[entry].low = cdf.meanFinal - atrDollar * rangeScale * Math.sqrt(cdf.remainingFrac);

            const polyYesPct = polyYes !== null ? Math.round(polyYes * 100) : null;
            const divergence = polyYesPct !== null ? Math.abs(cdf.modelYesPct - polyYesPct) : null;
            const cdfImpliedDir = cdf.modelYesPct >= 50 ? 'UP' : 'DOWN';
            acc[entry].polyAlign = {
              ref: polyRef,
              gapPct: ((polyRef - livePx) / livePx) * 100,
              modelYesPct: cdf.modelYesPct,
              polyYesPct,
              divergence,
              strikeDir: 'above',
              closeTimeMs,
              remainingMs,
              remainingFrac: cdf.remainingFrac,
              meanFinal: cdf.meanFinal,
              sigma: cdf.sigma,
              dirConflict: dir !== 'FLAT' && cdfImpliedDir !== dir,
              cdfImpliedDir,
              livePx,
              liveSrc: live.src,
              status: divergence === null ? 'no-market'
                : divergence <= 12 ? 'aligned'
                  : divergence <= 25 ? 'soft-split'
                    : 'divergent',
            };
          }
        }

        // For the 15-min horizon, align target to the NEXT 15-min candle session
        if (horizonMin === 15) {
          const ns = getNextCandleSession();
          const scaledMom = modelDrift * (ns.minsRemaining / 60) * projectionTargetDriftMult;
          const nsTarget = lastPrice * (1 + scaledMom);
          acc[entry].nextSession = {
            target: nsTarget,
            high: nsTarget + atr * rangeScale,
            low: nsTarget - atr * rangeScale,
            opensIn: ns.minsRemaining,
            open: ns.nextOpen,
            close: ns.nextClose,
            maturity: ns.maturity,
            freshEntry: ns.freshEntry,
            lateEntry: ns.lateEntry,
          };

          // ── Polymarket 15M Contract Alignment ──────────────────────────────────
          // YES resolves if closePrice ≥ targetPriceNum (meet or exceed).
          // Compute model-implied P(closePrice ≥ ref) using normal CDF over
          // our projected price distribution (mean = target, sigma = ATR-range).
          const {
            poly15mCtx,
            polymarketRef,
            polymarketYes,
            polymarketStrikeDir,
            isBelowPoly,
            rtiData,
            rtiPrice,
            settlementPrice,
          } = getPolymarket15mSettlementContext(options.sym, lastPrice);

          if (polymarketRef !== null && polymarketRef > 0) {
            const closeTimeMs = poly15mCtx?.closeTime ? new Date(poly15mCtx.closeTime).getTime() : null;
            const remainingMs = Number.isFinite(closeTimeMs) ? Math.max(0, closeTimeMs - Date.now()) : 15 * 60_000;
            const atrDollar = (Number.isFinite(atr) && atr > 0) ? atr : lastPrice * 0.0017;
            const live = resolveLiveSettlementPx(options.sym, settlementPrice || lastPrice);
            const livePx = live.px || settlementPrice || lastPrice;
            const momDir = window.Microstructure?.getSnapshot?.(options.sym)?.momentum?.dir || null;
            const cdf = computeBinaryPtbCdf({
              ptb: polymarketRef,
              livePx,
              windowMin: 15,
              remainingMs,
              atrDollar,
              score,
              liveDir: Math.sign(mom) || 0,
              momDir,
              regime: liveRegime?.regime,
              burstPressure: tapeVelocity?.burstPressure ?? 0,
            });
            // P(YES) for above-strike = P(settle ≥ PTB). Below-strike flips.
            const modelYesPct = isBelowPoly ? (100 - cdf.modelYesPct) : cdf.modelYesPct;
            const polymarketYesPct = polymarketYes !== null ? Math.round(polymarketYes * 100) : null;
            const divergence = polymarketYesPct !== null ? Math.abs(modelYesPct - polymarketYesPct) : null;
            const gapPct = ((polymarketRef - livePx) / livePx) * 100;
            target = cdf.meanFinal;
            acc[entry].target = cdf.meanFinal;

            // Direction consistency check:
            // modelYesPct ≥ 50 means model thinks YES wins.
            // For 'above': YES=UP — so modelYesPct ≥ 50 should agree with dir='UP'
            // For 'below': YES=DOWN — so modelYesPct ≥ 50 should agree with dir='DOWN'
            const modelYesSide = modelYesPct >= 50 ? 'YES' : 'NO';
            const yesDir = isBelowPoly ? 'DOWN' : 'UP';
            const noDir = isBelowPoly ? 'UP' : 'DOWN';
            const cdfImpliedDir = modelYesPct >= 50 ? yesDir : noDir;
            const dirConflict = dir !== 'FLAT' && cdfImpliedDir !== dir;
            if (dirConflict) {
              predictionDebugLog(
                `poly-align:${options.sym}`,
                'warn',
                () => `[PolyAlign] DIR CONFLICT ${options.sym}: momentum=${dir} but CDF implies ${cdfImpliedDir} (modelYesPct=${modelYesPct}% strike=${polymarketStrikeDir} ref=${polymarketRef} price=${lastPrice.toFixed(2)})`,
                15000
              );
            }

            const align15 = {
              ref: polymarketRef,
              gapPct,
              modelYesPct,
              polymarketYesPct,
              divergence,
              yesAsk: poly15mCtx?.yesAsk ?? null,
              yesBid: poly15mCtx?.yesBid ?? null,
              noAsk: poly15mCtx?.noAsk ?? null,
              noBid: poly15mCtx?.noBid ?? null,
              strikeDir: polymarketStrikeDir,
              floorPrice: poly15mCtx?.floorPrice ?? polymarketRef,
              capPrice: poly15mCtx?.capPrice ?? null,
              strikeType: poly15mCtx?.strikeType ?? null,
              ticker: poly15mCtx?.ticker ?? null,
              closeTimeMs,
              remainingMs,
              remainingFrac: cdf.remainingFrac,
              meanFinal: cdf.meanFinal,
              sigma: cdf.sigma,
              livePx,
              liveSrc: live.src,
              rtiPrice: rtiPrice,
              rtiData: rtiData ? { openAvg: rtiData.openAvg, closeAvg: rtiData.closeAvg, delta: rtiData.delta } : null,
              priceSource: live.src || 'twap',
              tapeVelocityState: tapeVelocity.state,
              targetDriftMult: projectionTargetDriftMult,
              rangeExpansionMult: projectionRangeExpansionMult,
              dirConflict,
              cdfImpliedDir,
              status: divergence === null ? 'no-market'
                : divergence <= 12 ? 'aligned'
                  : divergence <= 25 ? 'soft-split'
                    : 'divergent',
            };
            acc[entry].polyAlign = align15;
          }
        }
        return acc;
      }, {}),
      volatility: { atr, atrPct, label: atrPct > 2 ? 'High' : atrPct > 0.8 ? 'Medium' : 'Low' },
      session,
      nextCandleSession: getNextCandleSession(),
      scalpSetups,
      mdt,
      reversalFlags,
      rationale,
      liveRegime,
      adaptiveWeights,
      adaptiveWeightState: JSON.parse(JSON.stringify(_ensureOnlineState(options.sym))),
      diagnostics: {
        agreement: agreement.agreement,
        conflict: agreement.conflict,
        activeSignals: agreement.active,
        bullishSignals: agreement.bulls,
        bearishSignals: agreement.bears,
        consensusLabel: agreement.label,
        tapeVelocity,
        components: signalVector,
        coreScore: clamp(coreComposite, -1, 1),
        microScore: clamp(microComposite, -1, 1),
        consensusComposite,
        consensusAdjustment,
        edgeCommittee: edgeCommitteeVote,
        liveMomentumDivergence,
        liveRealtimeMomentum,
        coreAgreement: coreAgreement.agreement,
        persistenceScore: persistence.signal,
        structureBias: structure.signal,
        structureZone: structure.zone,
        topDrivers: driverSummary.topDrivers,
        driverSummary: driverSummary.driverSummary,
        microstructure: indicatorsSummary.microstructure,
        wallAbsorption: wallAbs,
        mdt,
        reversalFlags,
        mdtScoreMult,
      },
    };
  }

  // ── PROPRIETARY MOMENTUM QUALITY GATE ─────────────────────────────────────
  // Detects pure directional drift ("thin upward/downward momentum") vs choppy
  // price action. Replaces rigid section-count gate with 7 quality dimensions:
  //   1. DriftPurity   — net move vs total absolute moves (1=pure drift, 0=choppy)
  //   2. CandlePurity  — body-to-range ratio (thin candles = clean momentum)
  //   3. Staircase     — % of successive closes stepping in drift direction
  //   4. WickBalance   — continuation wicks vs rejection wicks ratio
  //   5. GradientSteadiness — low variance in per-bar returns = steady drift
  //   6. VolumeSteadiness   — consistent volume = organic not pump-driven
  //   7. RecentStreak  — unbroken recent candles in drift direction
  function buildFastTimingModel(candles, sym = null) {
    if (!candles || candles.length < 8) return null;
    const N = candles.length;
    const window = candles.slice(-Math.min(15, N));
    const last5 = candles.slice(-5);
    const lastPrice = candles[N - 1].c;

    // ── 1. DriftPurity — net move / Σ|candle moves| ──────────────────────────
    let netMove = 0, totalAbs = 0;
    for (const c of window) {
      const m = c.c - c.o;
      netMove += m;
      totalAbs += Math.abs(m);
    }
    const driftPurity = totalAbs > 0 ? Math.abs(netMove) / totalAbs : 0;
    const driftDir = netMove > 0 ? 1 : netMove < 0 ? -1 : 0;

    // ── 2. CandlePurity — body / (high - low) ────────────────────────────────
    const avgPurity = window.reduce((s, c) => {
      const body = Math.abs(c.c - c.o);
      const range = (c.h - c.l) || 0.0001;
      return s + body / range;
    }, 0) / window.length;

    // ── 3. Staircase — successive closes stepping in drift direction ──────────
    let stairSteps = 0;
    for (let i = 1; i < window.length; i++) {
      if (driftDir > 0 && window[i].c > window[i - 1].c) stairSteps++;
      if (driftDir < 0 && window[i].c < window[i - 1].c) stairSteps++;
    }
    const staircaseRate = stairSteps / Math.max(1, window.length - 1);

    // ── 4. WickBalance — continuation vs rejection wicks ─────────────────────
    // Positive = wicks support the move (buyers/sellers absorb pressure)
    // Negative = rejection wicks (opposition winning at the extremes)
    let wickWith = 0, wickContra = 0;
    for (const c of window) {
      const bodyTop = Math.max(c.o, c.c);
      const bodyBot = Math.min(c.o, c.c);
      const upperWick = c.h - bodyTop;
      const lowerWick = bodyBot - c.l;
      if (driftDir > 0) { wickWith += lowerWick; wickContra += upperWick; }
      else { wickWith += upperWick; wickContra += lowerWick; }
    }
    const totalWick = (wickWith + wickContra) || 0.0001;
    const wickBalance = (wickWith - wickContra) / totalWick; // -1..+1

    // ── 5. GradientSteadiness — low variance = steady not jumpy ──────────────
    const returns = window.map(c => (c.c - c.o) / (c.o || 1) * 100);
    const avgRet = returns.reduce((s, v) => s + v, 0) / returns.length;
    const stdDev = Math.sqrt(returns.reduce((s, v) => s + (v - avgRet) ** 2, 0) / returns.length);
    const gradientSteadiness = Math.abs(avgRet) > 0
      ? clamp(1 / (1 + stdDev / Math.abs(avgRet)), 0, 1)
      : 0;

    // ── 6. VolumeSteadiness — organic buying vs erratic pumps ────────────────
    const vols = window.map(c => c.v || 0);
    const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length;
    const volCV = avgVol > 0
      ? Math.sqrt(vols.reduce((s, v) => s + (v - avgVol) ** 2, 0) / vols.length) / avgVol
      : 1;
    const volSteadiness = clamp(1 / (1 + volCV), 0, 1);

    // ── 7. RecentStreak — unbroken recent candles in drift direction ──────────
    let streak = 0;
    for (let i = window.length - 1; i >= 0; i--) {
      if (Math.sign(window[i].c - window[i].o) === driftDir) streak++;
      else break;
    }

    // ── COMPOSITE MOMENTUM QUALITY (0..1) ─────────────────────────────────────
    const momentumQuality = clamp(
      driftPurity * 0.28 +  // primary: directional purity
      avgPurity * 0.16 +  // candle cleanliness
      staircaseRate * 0.18 +  // stairstepping pressure
      (0.5 + wickBalance * 0.5) * 0.14 +  // wick support (normalized 0..1)
      gradientSteadiness * 0.13 +  // steady gradient
      volSteadiness * 0.11,   // organic volume
      0, 1
    );

    // ── GATE THRESHOLDS (quality-based, not bar-count) ────────────────────────
    const highQuality = momentumQuality >= 0.60 && driftPurity >= 0.55 && streak >= 3;
    const medQuality = momentumQuality >= 0.42 && driftPurity >= 0.35 && streak >= 2;
    const gated = highQuality || medQuality;
    const hardGated = highQuality;

    // ── SCORE ──────────────────────────────────────────────────────────────────
    const qualMult = hardGated ? 1.22 : medQuality ? 0.90 : 0.24;
    const score = clamp(driftDir * momentumQuality * qualMult, -1, 1);

    // ── PER-HORIZON SCORES ─────────────────────────────────────────────────────
    // 5m contract: needs high quality AND last 5 candles net-aligned
    const last5Net = last5.reduce((s, c) => s + (c.c - c.o), 0);
    const driftDir5 = last5Net > 0 ? 1 : last5Net < 0 ? -1 : 0;
    let streak5 = 0;
    for (let i = window.length - 1; i >= 0; i--) {
      if (Math.sign(window[i].c - window[i].o) === driftDir5) streak5++;
      else break;
    }
    const last5Aligned = driftDir5 === driftDir;
    const h1Score = hardGated && last5Aligned ? clamp(score * 1.12, -1, 1) : 0;
    const h5Score = gated && last5Aligned
      ? clamp(score * (hardGated ? 1.06 : 0.88), -1, 1)
      : (driftDir5 !== 0 ? clamp(driftDir5 * momentumQuality * (streak5 >= 2 ? 0.64 : 0.22), -1, 1) : 0);
    const h10Score = gated ? clamp(score * 0.90, -1, 1) : score * 0.26;
    // 15m contract: most forgiving — even medium drift matters; missed quiet ETH drifts end here
    const h15Score = medQuality ? clamp(score * 0.88, -1, 1) : score * 0.38;

    const qualityLabel = hardGated ? '🟢 Pure thin drift'
      : medQuality ? '🟡 Moderate drift'
        : '🔴 Choppy / no drift';
    const dirLabel = driftDir > 0 ? 'UP' : driftDir < 0 ? 'DOWN' : 'FLAT';

    return {
      price: lastPrice,
      score,
      signal: signalFromScore(score),
      confidence: gated
        ? Math.min(92, Math.round(60 * momentumQuality * (hardGated ? 1.14 : 1.0)))
        : Math.floor(30 * momentumQuality),
      label: `${qualityLabel} · ${dirLabel} (streak ${streak}, purity ${(driftPurity * 100).toFixed(0)}%)`,
      gated,
      hardGated,
      gateLabel: qualityLabel,
      accelerating: streak >= 4 && staircaseRate > 0.72,
      agreeing: streak,
      momentumQuality,
      horizonScores: { h1: h1Score, h5: h5Score, h10: h10Score, h15: h15Score },
      diagnostics: {
        agreement: clamp(momentumQuality, 0, 1),
        conflict: clamp(1 - driftPurity, 0, 1),
        momentum: avgRet,
        volBurst: vols[vols.length - 1] / (avgVol || 1),
        gated,
        hardGated,
        accelerating: streak >= 4 && staircaseRate > 0.72,
        // quality breakdown — exposed for diagnostics UI
        driftPurity,
        avgPurity,
        staircaseRate,
        wickBalance,
        gradientSteadiness,
        volSteadiness,
        streak,
        driftDir,
        momentumQuality,
        qualityLabel,
        // 5m specific indicators
        driftDir5,
        streak5,
        last5Aligned,
      },
    };
  }

  function summarizeBacktestObservations(observations, horizonMin, barMinutes, horizonBars) {
    const active = observations.filter(o => o.direction !== 0);
    const wins = active.filter(o => o.signedReturn > 0).length;
    const losses = active.filter(o => o.signedReturn < 0).length;
    const scratches = active.length - wins - losses;
    const totalSignedReturn = active.reduce((sum, o) => sum + o.signedReturn, 0);
    const totalRawReturn = active.reduce((sum, o) => sum + o.returnPct, 0);
    const totalAbsReturn = active.reduce((sum, o) => sum + Math.abs(o.returnPct), 0);
    const grossWins = active.filter(o => o.signedReturn > 0).reduce((sum, o) => sum + o.signedReturn, 0);
    const grossLosses = Math.abs(active.filter(o => o.signedReturn < 0).reduce((sum, o) => sum + o.signedReturn, 0));
    const thresholdSeries = observations.map(o => o.appliedThreshold).filter(Number.isFinite);
    const agreementSeries = observations.map(o => o.appliedAgreement).filter(Number.isFinite);
    const activeThresholdSeries = active.map(o => o.appliedThreshold).filter(Number.isFinite);
    const activeAgreementSeries = active.map(o => o.appliedAgreement).filter(Number.isFinite);
    const regimeAwareRate = observations.length ? observations.filter(o => o.regimeAware).length / observations.length * 100 : 0;
    const expectancy = active.length ? totalSignedReturn / active.length : 0;
    const equity = buildEquityStats(active);
    const byBucket = ['strong', 'moderate', 'light'].reduce((acc, bucket) => {
      const bucketTrades = active.filter(o => o.bucket === bucket);
      acc[bucket] = {
        trades: bucketTrades.length,
        winRate: bucketTrades.length ? bucketTrades.filter(o => o.signedReturn > 0).length / bucketTrades.length * 100 : 0,
        avgEdge: bucketTrades.length ? bucketTrades.reduce((sum, o) => sum + o.signedReturn, 0) / bucketTrades.length : 0,
      };
      return acc;
    }, {});

    return {
      horizonMin,
      horizonBars,
      barMinutes,
      observations: observations.length,
      activeSignals: active.length,
      longCount: active.filter(o => o.direction > 0).length,
      shortCount: active.filter(o => o.direction < 0).length,
      winRate: active.length ? wins / active.length * 100 : 0,
      avgSignedReturn: active.length ? totalSignedReturn / active.length : 0,
      avgRawReturn: active.length ? totalRawReturn / active.length : 0,
      avgAbsReturn: active.length ? totalAbsReturn / active.length : 0,
      neutralityRate: observations.length ? (observations.length - active.length) / observations.length * 100 : 0,
      coverage: observations.length ? active.length / observations.length * 100 : 0,
      wins,
      losses,
      scratches,
      maxWin: active.length ? Math.max(...active.map(o => o.signedReturn)) : 0,
      maxLoss: active.length ? Math.min(...active.map(o => o.signedReturn)) : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? grossWins : 0,
      expectancy,
      equity,
      effectiveSamples: active.length ? active.length / Math.max(1, horizonBars) : 0,
      normalizedEffectiveSamples: active.length ? active.length / Math.max(1, Math.round(horizonMin / 60)) : 0,
      scoreEdgeRatio: totalAbsReturn > 0 ? totalSignedReturn / totalAbsReturn : 0,
      entryThreshold: activeThresholdSeries.length ? median(activeThresholdSeries) : median(thresholdSeries),
      minAgreement: activeAgreementSeries.length ? median(activeAgreementSeries) : median(agreementSeries),
      regimeAwareRate,
      calibrationSamples: observations.length ? average(observations.map(o => o.calibrationSample || 0)) : 0,
      buckets: byBucket,
    };
  }

  function backtestReliability(...statsList) {
    const horizons = statsList.flat().filter(Boolean);
    if (!horizons.length) return 0.5;
    const weighted = horizons.reduce((acc, stats) => {
      const weight = Math.max(1, stats.effectiveSamples || 0);
      acc.score += scoreHorizonReliability(stats) * weight;
      acc.weight += weight;
      return acc;
    }, { score: 0, weight: 0 });
    return weighted.weight ? weighted.score / weighted.weight : 0.5;
  }

  const ADVANCED_BACKTEST_VERSION = 'adv-v2-vol7d';
  const ADV_VOL_LOOKBACK_BARS = 7 * 288; // last week of 5m bars

  function percentileRank(series, value) {
    if (!Array.isArray(series) || !series.length || !Number.isFinite(value)) return 50;
    const belowOrEqual = series.reduce((count, item) => {
      return count + ((Number.isFinite(item) && item <= value) ? 1 : 0);
    }, 0);
    return (belowOrEqual / series.length) * 100;
  }

  function computeEwmaVolSeries(logReturns, lambda = 0.94) {
    if (!Array.isArray(logReturns) || !logReturns.length) return [];
    const out = new Array(logReturns.length);
    const warmup = Math.min(30, logReturns.length);
    let sigma2 = 0;
    for (let i = 0; i < warmup; i++) sigma2 += (logReturns[i] || 0) ** 2;
    sigma2 /= Math.max(1, warmup);
    out[0] = Math.sqrt(Math.max(0, sigma2));
    for (let i = 1; i < logReturns.length; i++) {
      sigma2 = lambda * sigma2 + (1 - lambda) * ((logReturns[i - 1] || 0) ** 2);
      out[i] = Math.sqrt(Math.max(0, sigma2));
    }
    return out;
  }

  function computeJumpRatio(logReturns) {
    if (!Array.isArray(logReturns) || logReturns.length < 3) return 0;
    let rv = 0;
    let bvSum = 0;
    for (let i = 0; i < logReturns.length; i++) {
      const r = Number(logReturns[i]) || 0;
      rv += r * r;
      if (i > 0) bvSum += Math.abs(r) * Math.abs(Number(logReturns[i - 1]) || 0);
    }
    if (rv <= 0) return 0;
    const n = logReturns.length;
    const bv = (Math.PI / 2) * (n / (n - 1)) * bvSum;
    return clamp((rv - bv) / rv, 0, 1);
  }

  function computeVarianceRatio(logReturns, q = 5) {
    if (!Array.isArray(logReturns) || logReturns.length < q * 3) return { vr: 1, signal: 'random_walk' };
    const n = logReturns.length;
    const mu = average(logReturns);
    const var1 = logReturns.reduce((sum, r) => sum + (r - mu) ** 2, 0) / Math.max(1, n - 1);
    if (!Number.isFinite(var1) || var1 <= 0) return { vr: 1, signal: 'random_walk' };
    let varQRaw = 0;
    for (let i = q; i < n; i++) {
      let qRet = 0;
      for (let j = 0; j < q; j++) qRet += logReturns[i - j];
      varQRaw += (qRet - q * mu) ** 2;
    }
    const denom = q * (n - q) * (1 - q / n);
    const varQ = denom > 0 ? varQRaw / denom : var1 * q;
    const vr = varQ / (var1 * q);
    const signal = vr > 1.2 ? 'trending' : vr < 0.8 ? 'mean_reverting' : 'random_walk';
    return { vr: Number.isFinite(vr) ? vr : 1, signal };
  }

  function buildAdvancedVolatilitySnapshot(cache) {
    const series = (Array.isArray(cache?.candles) && cache.candles.length >= 20)
      ? cache.candles
      : ((Array.isArray(cache?.candles15m) && cache.candles15m.length >= 20)
        ? cache.candles15m
        : ((Array.isArray(cache?.candles1m) && cache.candles1m.length >= 20)
          ? cache.candles1m
          : (Array.isArray(cache?.longHistory) ? cache.longHistory : [])));
    if (!Array.isArray(series) || series.length < 15) return null;
    const recent = series.slice(-Math.min(ADV_VOL_LOOKBACK_BARS, series.length));
    const closes = recent.map(c => Number(c?.c)).filter(v => Number.isFinite(v) && v > 0);
    if (closes.length < 10) return null;
    const logReturns = [];
    for (let i = 1; i < closes.length; i++) {
      logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }
    if (!logReturns.length) return null;
    const ewmaSeries = computeEwmaVolSeries(logReturns);
    const ewmaNow = ewmaSeries[ewmaSeries.length - 1] || 0;
    const ewmaPct = ewmaNow * 100;
    const volPercentile = percentileRank(ewmaSeries.slice(0, -1), ewmaNow);
    const regime = volPercentile < 25 ? 'CALM'
      : volPercentile < 75 ? 'NORMAL'
        : volPercentile < 90 ? 'ELEVATED'
          : 'CRISIS';
    const jumpRatio = computeJumpRatio(logReturns.slice(-20));
    const vrData = computeVarianceRatio(logReturns.slice(-80), Math.min(5, Math.max(2, Math.floor(logReturns.length / 4))));
    return {
      lookbackDays: Number((recent.length / 288).toFixed(2)),
      sampleBars: recent.length,
      ewmaVolPct: Number(ewmaPct.toFixed(4)),
      volPercentile: Number(volPercentile.toFixed(1)),
      regime,
      jumpRatio: Number(jumpRatio.toFixed(4)),
      varianceRatio: Number((vrData.vr || 1).toFixed(4)),
      varianceSignal: vrData.signal,
    };
  }

  function advancedBacktestKey(cache) {
    const candles = cache?.longHistory || [];
    if (!candles.length || candles.length < 30) return '';
    const bars5m = cache?.candles || [];
    return [
      ADVANCED_BACKTEST_VERSION,
      candles.length,
      candles[candles.length - 1]?.t || 0,
      bars5m.length,
      bars5m[bars5m.length - 1]?.t || 0,
    ].join(':');
  }

  function getCachedAdvancedBacktest(cache) {
    const key = advancedBacktestKey(cache);
    if (!key || cache?._advancedBacktestKey !== key) return null;
    return cache._advancedBacktest || null;
  }

  function emitPredictionEvent(name, detail = {}) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function withTimeout(promise, timeoutMs, label = 'operation') {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)),
    ]);
  }

  function toFiniteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function buildInferenceSnapshot(coin, pred) {
    const indicators = pred?.indicators || {};
    const diagnostics = pred?.diagnostics || {};
    const mktSentiment = indicators.mktSentiment || {};
    const book = indicators.book || {};
    const volume = indicators.volume || {};
    const combinedProbRaw = Number.isFinite(mktSentiment.combined)
      ? mktSentiment.combined
      : Number.isFinite(mktSentiment.kalshi)
        ? mktSentiment.kalshi
        : 0.5;
    const polymarketProb = clamp(combinedProbRaw, 0, 1);
    const rawImbalance = toFiniteNumber(book.imbalance, 0);
    const normalizedImbalance = rawImbalance >= -1 && rawImbalance <= 1
      ? (rawImbalance + 1) / 2
      : clamp(rawImbalance, 0, 1);
    const buyPressure = Number.isFinite(volume.buyPct)
      ? clamp(volume.buyPct / 100, 0, 1)
      : normalizedImbalance;
    const conflict = toFiniteNumber(diagnostics.conflict, 0);
    const conflicts = [];
    if (conflict >= 0.55) conflicts.push(`High indicator conflict (${Math.round(conflict * 100)}%)`);
    if (diagnostics.directionalConflict) conflicts.push('Signal router directional conflict');
    if (Array.isArray(pred?.reversalFlags) && pred.reversalFlags.length) {
      conflicts.push(`Reversal flags active (${pred.reversalFlags.length})`);
    }
    const tapeVelocity = pred?.diagnostics?.tapeVelocity || {};

    const summary = pred?.backtest?.summary || {};
    const winRatePct = Number.isFinite(summary.winRate) ? summary.winRate : 50;
    const avgSignedReturn = toFiniteNumber(summary.avgSignedReturn, 0);

    const polyCoin = window.PredictionMarkets?.getCoin?.(coin.sym) || {};
    const poly15 = polyCoin.poly15m || null;
    const poly5 = polyCoin.poly5m || null;
    return {
      coin: coin.sym,
      horizon: 'h15',
      // Prefer ASI1 pre-contract analysis on prediction-card inference overlay
      preContract: true,
      preferAsi1: true,
      rangePrediction: true,
      rangeHorizonMinutes: 15,
      horizonMinutes: 15,
      poly15m: poly15,
      poly5m: poly5,
      volatility: Math.max(0, toFiniteNumber(pred?.volatility?.atrPct, 0) / 100),
      orderbook: {
        imbalance: normalizedImbalance,
        buyPressure,
      },
      indicators: {
        RSI: toFiniteNumber(indicators.rsi?.value, 50),
        MACD: toFiniteNumber(indicators.macd?.macd, 0),
        Signal: toFiniteNumber(indicators.macd?.signal, 0),
        MACDHist: toFiniteNumber(indicators.macd?.histogram, 0),
        CCI: toFiniteNumber(indicators.cci?.value, 0),
        Fisher: toFiniteNumber(indicators.fisher?.value ?? diagnostics.components?.fisher, 0),
        ADX: toFiniteNumber(indicators.adx?.adx, 20),
        PlusDI: toFiniteNumber(indicators.adx?.pdi, 20),
        MinusDI: toFiniteNumber(indicators.adx?.mdi, 20),
        ATR: toFiniteNumber(pred?.volatility?.atr, 0),
        PolymarketPercent: polymarketProb,
      },
      weights: pred?.adaptiveWeights || COMPOSITE_WEIGHTS,
      recentAccuracy: {
        winRate: clamp(winRatePct / 100, 0, 1),
        trend: clamp(avgSignedReturn / 100, -1, 1),
      },
      marketStructure: {
        tapeVelocityState: String(tapeVelocity.state || 'normal'),
        rangeExpansion: toFiniteNumber(tapeVelocity.rangeExpansion, 1),
        bodyExpansion: toFiniteNumber(tapeVelocity.bodyExpansion, 1),
        volumeBurst: toFiniteNumber(tapeVelocity.volumeBurst, 1),
        directionalConsistency: toFiniteNumber(tapeVelocity.directionalConsistency, 0.5),
        targetDriftMult: toFiniteNumber(tapeVelocity.targetDriftMult, 1),
        rangeExpansionMult: toFiniteNumber(tapeVelocity.rangeExpansionMult, 1),
      },
      setups: pred?.setups || [],
      contrarianSetups: pred?.contrarianSetups || [],
      verdictDir: pred?.verdictDir || 'wait',
      compositeEdge: pred?.compositeEdge || 0,
      conflicts,
    };
  }

  function normalizeTideConfidence(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n >= 0 && n <= 1) return Math.round(clamp(n, 0, 1) * 100);
    return Math.round(clamp(n, 0, 100));
  }

  function normalizeTideDirection(value, fallback = 'WAIT') {
    const text = String(value || '').trim().toUpperCase();
    if (!text) return fallback;
    if (/(BUY|LONG|UP|BULL)/.test(text)) return 'UP';
    if (/(SELL|SHORT|DOWN|BEAR)/.test(text)) return 'DOWN';
    if (/(WAIT|HOLD|NEUTRAL|FLAT|SIDEWAYS)/.test(text)) return 'WAIT';
    return fallback;
  }

  function normalizeTideCandle(candle) {
    if (!candle) return null;
    const source = Array.isArray(candle)
      ? {
        t: candle[0],
        o: candle[1],
        h: candle[2],
        l: candle[3],
        c: candle[4],
        v: candle[5],
      }
      : candle;
    const t = Number(source.t ?? source.ts ?? source.time ?? source.timestamp ?? 0);
    const o = Number(source.o ?? source.open ?? 0);
    const h = Number(source.h ?? source.high ?? 0);
    const l = Number(source.l ?? source.low ?? 0);
    const c = Number(source.c ?? source.close ?? 0);
    const v = Number(source.v ?? source.volume ?? 0);
    if (!Number.isFinite(t) || !Number.isFinite(c)) return null;
    return {
      t,
      o: Number.isFinite(o) ? o : c,
      h: Number.isFinite(h) ? h : c,
      l: Number.isFinite(l) ? l : c,
      c,
      v: Number.isFinite(v) ? v : 0,
    };
  }

  function buildTideSeries(series, limit = 96) {
    return (Array.isArray(series) ? series : [])
      .slice(-Math.max(1, limit))
      .map(normalizeTideCandle)
      .filter(Boolean);
  }

  async function getGoogleCloudStatus(force = false) {
    if (!window?.electron?.invoke) return null;
    if (!force && tideStatusCache && (Date.now() - tideStatusCacheTs) < TIDE_STATUS_TTL_MS) {
      return tideStatusCache;
    }

    try {
      const response = await window.electron.invoke('google:cloudStatus');
      tideStatusCache = response?.success
        ? response.status
        : { enabled: false, error: response?.error || 'cloud-status-unavailable' };
    } catch (error) {
      tideStatusCache = { enabled: false, error: error?.message || 'cloud-status-unavailable' };
    }
    tideStatusCacheTs = Date.now();
    return tideStatusCache;
  }

  function buildTideSnapshot(coin, pred) {
    const cache = candleCache[coin.sym] || {};
    const indicators = pred?.indicators || {};
    const diagnostics = pred?.diagnostics || {};
    const mktSentiment = indicators.mktSentiment || {};
    const book = indicators.book || {};
    const volume = indicators.volume || {};
    const series1m = buildTideSeries(cache.candles1m, 90);
    const series5m = buildTideSeries(cache.candles, 120);
    const series15m = buildTideSeries(cache.candles15m, 96);

    return {
      schemaVersion: 'wecrypto.tide.v1',
      coin: coin.sym,
      horizonMinutes: DEFAULT_SHORT_HORIZON_MIN,
      asOfTs: new Date().toISOString(),
      source: cache.source || pred?.source || null,
      currentPrice: toFiniteNumber(pred?.price || cache?.ticker?.usd || series1m[series1m.length - 1]?.c || series5m[series5m.length - 1]?.c, 0),
      market: {
        modelDirection: normalizeTideDirection(pred?.direction || pred?.signal || null),
        confidencePct: Math.round(clamp(toFiniteNumber(pred?.confidence, 0), 0, 1) * 100),
        kalshiProb: clamp(Number.isFinite(mktSentiment.kalshi) ? mktSentiment.kalshi : 0.5, 0, 1),
        combinedProb: clamp(Number.isFinite(mktSentiment.combined) ? mktSentiment.combined : 0.5, 0, 1),
      },
      indicators: {
        rsi: toFiniteNumber(indicators.rsi?.value, 50),
        macd: toFiniteNumber(indicators.macd?.macd, 0),
        macdSignal: toFiniteNumber(indicators.macd?.signal, 0),
        macdHist: toFiniteNumber(indicators.macd?.histogram, 0),
        adx: toFiniteNumber(indicators.adx?.adx, 20),
        atrPct: toFiniteNumber(pred?.volatility?.atrPct, 0),
        fisher: toFiniteNumber(indicators.fisher?.value ?? diagnostics.components?.fisher, 0),
        cci: toFiniteNumber(indicators.cci?.value, 0),
        orderbookImbalance: toFiniteNumber(book.imbalance, 0),
        buyPressurePct: toFiniteNumber(volume.buyPct, 50),
      },
      series: {
        m1: series1m,
        m5: series5m,
        m15: series15m,
      },
      windows: {
        m1Count: series1m.length,
        m5Count: series5m.length,
        m15Count: series15m.length,
      },
    };
  }

  function compactSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    return {
      schemaVersion: snapshot.schemaVersion || null,
      coin: snapshot.coin || snapshot.symbol || null,
      horizonMinutes: Number(snapshot.horizonMinutes || snapshot.horizon || 0) || null,
      asOfTs: snapshot.asOfTs || null,
      currentPrice: toFiniteNumber(snapshot.currentPrice ?? snapshot.price, null),
      windows: snapshot.windows && typeof snapshot.windows === 'object'
        ? {
          m1Count: Number(snapshot.windows.m1Count || 0) || 0,
          m5Count: Number(snapshot.windows.m5Count || 0) || 0,
          m15Count: Number(snapshot.windows.m15Count || 0) || 0,
        }
        : null,
      market: snapshot.market && typeof snapshot.market === 'object'
        ? {
          modelDirection: snapshot.market.modelDirection || null,
          confidencePct: toFiniteNumber(snapshot.market.confidencePct, null),
          kalshiProb: toFiniteNumber(snapshot.market.kalshiProb, null),
          combinedProb: toFiniteNumber(snapshot.market.combinedProb, null),
        }
        : null,
    };
  }

  function appendCloudInferenceRecord(record) {
    if (!window?.electron?.invoke) return;
    window.electron.invoke('firebase:appendInference', record).catch(() => { });
  }

  async function runInferenceOverlay(predictionsMap) {
    if (!window?.electron?.invoke) return [];
    if (inferenceRunPromise) return inferenceRunPromise;
    if (inferenceCooldownUntilTs && Date.now() < inferenceCooldownUntilTs) return [];
    if ((Date.now() - lastInferenceRunTs) < INFERENCE_MIN_INTERVAL_MS) return [];

    const work = PREDICTION_COINS
      .map(coin => ({ coin, pred: predictionsMap?.[coin.sym] }))
      .filter(({ pred }) => pred && pred.source !== 'error' && pred.source !== 'loading');

    if (!work.length) return [];

    inferenceRunPromise = (async () => {
      const results = await Promise.all(work.map(async ({ coin, pred }, idx) => {
        const snapshot = buildInferenceSnapshot(coin, pred);
        try {
          const runLlm = () => withTimeout(
            window.electron.invoke('llm:analyzeSnapshot', snapshot),
            INFERENCE_REQUEST_TIMEOUT_MS,
            `llm:${coin.sym}`
          );

          const response = window._signalScheduler
            ? await window._signalScheduler.schedule(runLlm, {
              lane: 'validation',
              provider: 'llm',
              delayMs: idx * 220,
              dedupeKey: `llm:${coin.sym}`,
              timeoutMs: INFERENCE_REQUEST_TIMEOUT_MS + 250,
              tag: `llm:${coin.sym}`,
            })
            : await runLlm();

          if (!response?.success || !response.output) {
            return { coin: coin.sym, ok: false, reason: response?.error || 'empty-response' };
          }

          const llmOutput = response.output;
          const llmCooldown = response?.providerStatus?.cooldown || response?.diagnostics?.cooldown || null;
          const llmCooldownRemainingMs = Math.max(0, Number(llmCooldown?.remaining_ms || 0));
          const llmDegraded = !!response?.degraded || !!llmCooldown?.active;
          if (llmCooldownRemainingMs > 0) {
            inferenceCooldownUntilTs = Math.max(inferenceCooldownUntilTs || 0, Date.now() + llmCooldownRemainingMs);
            inferenceCooldownReason = llmCooldown?.last_reason || llmOutput?.warnings?.[0] || 'LLM cooldown active';
          }
          const llmConfidencePct = Math.round(clamp(toFiniteNumber(llmOutput.confidence, 0), 0, 1) * 100);
          const llmNotes = String(
            llmOutput?.suggestions?.notes
            || llmOutput?.suggestions?.reasoning
            || ''
          ).trim();

          const aiCall = String(llmOutput.call || llmOutput.direction || '').toUpperCase();
          let truth = null;
          if (window.InferenceTruthGuard?.evaluate) {
            truth = window.InferenceTruthGuard.evaluate({
              call: aiCall,
              confidence: clamp(toFiniteNumber(llmOutput.confidence, 0), 0, 1),
              sym: coin.sym,
              horizon: '15m',
              modelScore: pred.score,
              modelDirection: pred.direction || pred.signal,
              volumeDelta: pred.indicators?.volume?.value ?? pred.volumeDelta,
              depthImbalance: pred.indicators?.book?.value,
            });
          }

          const nullified = !!truth?.nullified;
          const effectiveCall = truth?.effectiveCall || (aiCall === 'UP' || aiCall === 'DOWN' ? aiCall : null);
          const effectiveConfPct = truth
            ? Math.round(clamp(truth.confidence, 0, 1) * 100)
            : llmConfidencePct;
          const gatedNotes = nullified
            ? `⛔ NULLIFIED by raw data (${truth.reason}). Truth=${effectiveCall}. Was AI=${aiCall}. ${llmNotes}`.slice(0, 700)
            : (truth?.soft
              ? `⚠ soft raw conflict — ${truth.reason}. ${llmNotes}`.slice(0, 700)
              : llmNotes);

          // When nullified, zero LLM influence on adaptive weights / notes path
          if (nullified && Array.isArray(llmOutput.suggestions?.increase_weight)) {
            llmOutput.suggestions.increase_weight = [];
          }
          if (nullified && Array.isArray(llmOutput.suggestions?.decrease_weight)) {
            llmOutput.suggestions.decrease_weight = [];
          }

          pred.llm = {
            ts: Date.now(), // freshness gate for the composite-score llm signal (see signalVector.llm)
            regime: String(llmOutput.regime || 'unknown'),
            confidence: effectiveConfPct,
            suggestions: llmOutput.suggestions || {},
            warnings: [
              ...(Array.isArray(llmOutput.warnings) ? llmOutput.warnings.map(String) : []),
              ...(nullified ? [`truth_nullified:${truth.reason}`] : []),
              ...(truth?.soft ? [`truth_soft:${truth.reason}`] : []),
            ],
            notes: gatedNotes,
            ai_wording: llmOutput.ai_wording || null,
            analysis: llmOutput.analysis || null,
            market_patterns: llmOutput.ai_wording?.market_patterns || llmOutput.market_patterns || null,
            preContract: llmOutput.preContract || null,
            provider: llmOutput.provider || response?.providerStatus?.provider || response?.diagnostics?.lastProvider || response?.diagnostics?.provider || null,
            model: llmOutput.model || response?.providerStatus?.model || response?.diagnostics?.lastModel || null,
            degraded: llmDegraded || nullified,
            cooldownRemainingMs: llmCooldownRemainingMs,
            providerStatus: response?.providerStatus || null,
            call: effectiveCall,
            aiCallOriginal: aiCall === 'UP' || aiCall === 'DOWN' ? aiCall : null,
            nullified,
            softConflict: !!truth?.soft,
            truthWeight: truth?.weight ?? 1,
            sourceOfTruth: truth?.sourceOfTruth || 'llm',
            truthReason: truth?.reason || null,
            truthCall: truth?.truthCall || null,
          };

          pred.diagnostics = {
            ...(pred.diagnostics || {}),
            llmRegime: pred.llm.regime,
            llmConfidence: effectiveConfPct,
            llmWarnings: pred.llm.warnings.slice(0, 5),
            llmDegraded: llmDegraded || nullified,
            llmNullified: nullified,
            llmSourceOfTruth: pred.llm.sourceOfTruth,
            llmCooldownRemainingMs,
            llmSuggestedIncreases: nullified
              ? []
              : (Array.isArray(pred.llm.suggestions?.increase_weight)
                ? pred.llm.suggestions.increase_weight.slice(0, 3)
                : []),
            llmSuggestedDecreases: nullified
              ? []
              : (Array.isArray(pred.llm.suggestions?.decrease_weight)
                ? pred.llm.suggestions.decrease_weight.slice(0, 3)
                : []),
            llmNotes: gatedNotes,
          };

          if (window.DataLogger?.logLogicDebug) {
            try {
              window.DataLogger.logLogicDebug('llm', 'inference_overlay', {
                sym: coin.sym,
                regime: pred.llm.regime,
                confidence: llmConfidencePct,
                degraded: llmDegraded,
                provider: pred.llm.provider,
              });
            } catch (_) { }
          }

          appendCloudInferenceRecord({
            kind: 'llm_inference',
            schemaVersion: 'wecrypto.inference.v1',
            sym: coin.sym,
            provider: pred.llm.provider || 'llm',
            snapshot: compactSnapshot(snapshot),
            output: {
              regime: pred.llm.regime,
              confidence: llmConfidencePct,
              warnings: pred.llm.warnings.slice(0, 3),
              notes: llmNotes.slice(0, 220),
              degraded: llmDegraded,
            },
            diagnostics: {
              cooldownRemainingMs: llmCooldownRemainingMs,
              source: 'runInferenceOverlay',
            },
          });

          if (window.MultiDriveCache?.recordInference) {
            try {
              window.MultiDriveCache.recordInference(
                coin.sym,
                {
                  regime: pred.llm.regime,
                  confidence: llmConfidencePct,
                  warnings: pred.llm.warnings.slice(0, 3),
                  notes: llmNotes.slice(0, 220),
                },
                snapshot,
                { sync: false }
              );
            } catch (_) { }
          }

          return { coin: coin.sym, ok: true };
        } catch (err) {
          const reason = err?.message || 'failed';
          if (/429|quota|resource_exhausted/i.test(reason)) {
            inferenceCooldownUntilTs = Date.now() + INFERENCE_QUOTA_COOLDOWN_MS;
            inferenceCooldownReason = reason;
          }
          return { coin: coin.sym, ok: false, reason };
        }
      }));

      const updated = results.filter(r => r.ok).length;
      if (updated > 0) {
        emitPredictionEvent('predictioninference', { updated, total: results.length });
      }
      if (inferenceCooldownUntilTs && inferenceCooldownReason) {
        console.warn('[LLM] Inference cooldown active after quota/rate-limit failure:', inferenceCooldownReason);
      }
      if (window.MultiDriveCache?.flushSync) {
        try { window.MultiDriveCache.flushSync(); } catch (_) { }
      }
      return results;
    })();

    try {
      return await inferenceRunPromise;
    } finally {
      inferenceRunPromise = null;
      lastInferenceRunTs = Date.now();
    }
  }

  async function runTideOverlay(predictionsMap) {
    if (!window?.electron?.invoke) return [];
    if (tideRunPromise) return tideRunPromise;
    if (tideDisabledUntilTs && Date.now() < tideDisabledUntilTs) return [];
    if ((Date.now() - lastTideRunTs) < TIDE_MIN_INTERVAL_MS) return [];

    const cloudStatus = await getGoogleCloudStatus();
    const tideBridgeEnabled = !!(cloudStatus?.vertexTideEnabled || cloudStatus?.pubSubEnabled);
    if (!tideBridgeEnabled) {
      tideDisabledUntilTs = Date.now() + TIDE_DISABLED_RETRY_MS;
      tideDisabledReason = cloudStatus?.error || 'Google TiDE bridge disabled';
      return [];
    }

    const work = PREDICTION_COINS
      .map(coin => ({ coin, pred: predictionsMap?.[coin.sym], cache: candleCache[coin.sym] || {} }))
      .filter(({ pred, cache }) => {
        const seriesCount = (cache?.candles1m?.length || 0) + (cache?.candles?.length || 0) + (cache?.candles15m?.length || 0);
        return pred && pred.source !== 'error' && pred.source !== 'loading' && seriesCount >= 30;
      });

    if (!work.length) return [];

    tideRunPromise = (async () => {
      const results = await Promise.all(work.map(async ({ coin, pred }, idx) => {
        const snapshot = buildTideSnapshot(coin, pred);
        if (!snapshot.series.m1.length && !snapshot.series.m5.length && !snapshot.series.m15.length) {
          return { coin: coin.sym, ok: false, reason: 'no-series' };
        }

        try {
          const runTide = () => withTimeout(
            window.electron.invoke('google:tideForecast', snapshot),
            TIDE_REQUEST_TIMEOUT_MS,
            `tide:${coin.sym}`
          );

          const response = window._signalScheduler
            ? await window._signalScheduler.schedule(runTide, {
              lane: 'momentum',
              provider: 'vertex-tide',
              delayMs: idx * 180,
              dedupeKey: `tide:${coin.sym}`,
              timeoutMs: TIDE_REQUEST_TIMEOUT_MS + 300,
              tag: `tide:${coin.sym}`,
            })
            : await runTide();

          if (!response?.success && !response?.queued) {
            return { coin: coin.sym, ok: false, reason: response?.error || 'tide-failed' };
          }

          const currentPred = window._predictions?.[coin.sym] || predictionsMap?.[coin.sym] || pred;
          const forecast = response?.forecast || {};
          const previousTide = currentPred?.tide || null;
          const tideDirection = normalizeTideDirection(
            forecast.direction,
            previousTide?.direction || 'WAIT'
          );
          const tideConfidence = normalizeTideConfidence(
            forecast.confidence,
            Number.isFinite(Number(previousTide?.confidence)) ? Number(previousTide.confidence) : 0
          );
          const tideForecastPrice = Number.isFinite(Number(forecast.forecastPrice))
            ? Number(forecast.forecastPrice)
            : (Number.isFinite(Number(previousTide?.forecastPrice)) ? Number(previousTide.forecastPrice) : null);

          currentPred.tide = {
            direction: tideDirection,
            confidence: tideConfidence,
            forecastPrice: tideForecastPrice,
            quantiles: forecast.quantiles || previousTide?.quantiles || null,
            mode: response?.mode || previousTide?.mode || null,
            queued: !!response?.queued,
            error: response?.error || null,
            asOfTs: snapshot.asOfTs,
            schemaVersion: snapshot.schemaVersion,
          };

          currentPred.diagnostics = {
            ...(currentPred.diagnostics || {}),
            tideDirection,
            tideConfidence,
            tideForecastPrice,
            tideMode: currentPred.tide.mode,
            tideQueued: currentPred.tide.queued,
            tideError: currentPred.tide.error,
          };

          if (window.DataLogger?.logLogicDebug) {
            try {
              window.DataLogger.logLogicDebug('tide', 'tide_forecast', {
                sym: coin.sym,
                direction: currentPred.tide.direction,
                confidence: currentPred.tide.confidence,
                mode: currentPred.tide.mode,
                queued: currentPred.tide.queued,
                error: currentPred.tide.error || null,
              });
            } catch (_) { }
          }

          appendCloudInferenceRecord({
            kind: 'tide_forecast',
            schemaVersion: snapshot.schemaVersion || 'wecrypto.tide.v1',
            sym: coin.sym,
            provider: 'vertex-tide',
            snapshot: compactSnapshot(snapshot),
            forecast: {
              direction: currentPred.tide.direction,
              confidence: currentPred.tide.confidence,
              forecastPrice: currentPred.tide.forecastPrice,
              quantiles: currentPred.tide.quantiles || null,
              mode: currentPred.tide.mode,
              queued: currentPred.tide.queued,
              error: currentPred.tide.error || null,
            },
            diagnostics: {
              source: 'runTideOverlay',
            },
            rawResponse: {
              success: !!response?.success,
              queued: !!response?.queued,
              mode: response?.mode || null,
              error: response?.error || null,
            },
          });

          return { coin: coin.sym, ok: true, mode: currentPred.tide.mode, queued: currentPred.tide.queued };
        } catch (error) {
          const reason = error?.message || 'tide-failed';
          if (/not configured|cloud-status-unavailable|bridge disabled/i.test(reason)) {
            tideDisabledUntilTs = Date.now() + TIDE_DISABLED_RETRY_MS;
            tideDisabledReason = reason;
          }
          return { coin: coin.sym, ok: false, reason };
        }
      }));

      const updated = results.filter(r => r.ok).length;
      if (updated > 0) {
        emitPredictionEvent('predictiontide', { updated, total: results.length });
      }
      if (tideDisabledUntilTs && tideDisabledReason) {
        console.warn('[TiDE] Shadow forecast paused:', tideDisabledReason);
      }
      return results;
    })();

    try {
      return await tideRunPromise;
    } finally {
      tideRunPromise = null;
      lastTideRunTs = Date.now();
    }
  }

  function runAdvancedBacktest(coin) {
    const cache = candleCache[coin.sym];
    const candles = cache?.longHistory || [];
    if (!candles.length || candles.length < 30) return null;
    const longKey = advancedBacktestKey(cache);
    if (cache._advancedBacktestKey === longKey && cache._advancedBacktest) {
      return cache._advancedBacktest;
    }

    const barMinutes = inferBarMinutes(candles);
    const horizons = [
      { key: 'd1', horizonMin: 24 * 60, filter: { entryThreshold: 0.16, minAgreement: 0.58 } },
      { key: 'd7', horizonMin: 7 * 24 * 60, filter: { entryThreshold: 0.18, minAgreement: 0.60 } },
    ];
    const results = {};

    horizons.forEach(({ key, horizonMin, filter }) => {
      const horizonBars = Math.max(1, Math.round(horizonMin / (barMinutes || (24 * 60))));
      const startIndex = Math.min(Math.max(10, horizonBars + 2), Math.max(1, candles.length - horizonBars - 1));
      const observations = [];

      for (let idx = startIndex; idx < candles.length - horizonBars; idx++) {
        const windowCandles = candles.slice(0, idx + 1);
        const model = buildSignalModel(windowCandles, null, [], {
          includeMicrostructure: false,
          includeSetups: false,
        });
        if (!model) continue;

        const entry = windowCandles[windowCandles.length - 1].c;
        const ptb = windowCandles[windowCandles.length - 1].o || entry;
        const exit = candles[idx + horizonBars].c;

        const atrPctRaw = Number(model.volatility?.atrPct);
        const atrPct = (Number.isFinite(atrPctRaw) && atrPctRaw > 0) ? (atrPctRaw / 100) : 0.0035;
        const atrDollar = entry * atrPct;
        const remainingFrac = 0.60;
        const expectedMove = model.score * atrDollar * 0.40 * remainingFrac;
        const meanFinal = entry + expectedMove;
        const sigma = Math.max(entry * 0.0015, atrDollar * Math.sqrt(remainingFrac));
        const z = (meanFinal - ptb) / (sigma || 1);
        let pUp = normalCDF(z);

        const actualSettleUp = exit >= ptb;
        const modelCallUp = pUp >= 0.50;
        const isWin = (modelCallUp === actualSettleUp);
        const payoffPct = isWin ? 1.0 : -1.0;
        const rawReturn = payoffPct * (Math.abs((exit - ptb) / (ptb || 1)) * 100 + 0.5);
        const returnPct = clamp(rawReturn, -25, 25);
        const ptbScore = clamp((pUp - 0.5) * 2.0, -1, 1);

        observations.push({
          idx,
          ...applyBacktestFilter({
            idx,
            isWin,
            score: ptbScore,
            absScore: Math.abs(ptbScore),
            signal: model.signal,
            agreement: model.diagnostics?.agreement ?? 0.5,
            conflict: model.diagnostics?.conflict ?? 0,
            coreScore: ptbScore,
            persistenceScore: model.diagnostics?.persistenceScore ?? 0,
            structureBias: model.diagnostics?.structureBias ?? 0,
            structureZone: model.diagnostics?.structureZone ?? 'middle',
            regime: classifyMarketRegime(model),
            returnPct,
            bucket: scoreBucket(Math.abs(ptbScore)),
          }, filter),
          calibrationSample: 0,
          regimeAware: false,
        });
      }

      results[key] = summarizeBacktestObservations(observations, horizonMin, barMinutes, horizonBars);
    });

    const reliability = backtestReliability(results.d1, results.d7);
    const tradeFit = average([
      scoreTradeFitHorizon(results.d1, 24 * 60),
      scoreTradeFitHorizon(results.d7, 7 * 24 * 60),
    ].filter(Number.isFinite));
    const result = {
      sym: coin.sym,
      source: 'coingecko-max',
      candleCount: candles.length,
      startDate: candles[0]?.t ? new Date(candles[0].t).toISOString().slice(0, 10) : '',
      endDate: candles[candles.length - 1]?.t ? new Date(candles[candles.length - 1].t).toISOString().slice(0, 10) : '',
      d1: results.d1,
      d7: results.d7,
      volatility: buildAdvancedVolatilitySnapshot(cache),
      summary: {
        reliability,
        tradeFit,
        label: summarizeReliabilityLabel(reliability),
        tradeFitLabel: summarizeTradeFitLabel(tradeFit),
      },
    };
    cache._advancedBacktestKey = longKey;
    cache._advancedBacktest = result;
    return result;
  }

  async function warmAdvancedBacktests() {
    if (advancedBacktestWarmPromise) return advancedBacktestWarmPromise;
    advancedBacktestWarmPromise = (async () => {
      let updated = false;
      for (const coin of PREDICTION_COINS) {
        const cache = candleCache[coin.sym];
        if (!advancedBacktestKey(cache) || getCachedAdvancedBacktest(cache)) continue;
        await wait(0);
        const advanced = runAdvancedBacktest(coin);
        if (!advanced || !window._backtests[coin.sym]) continue;
        window._backtests[coin.sym] = {
          ...window._backtests[coin.sym],
          advanced,
        };
        window._predictions[coin.sym] = preservePredictionOverlay(
          window._predictions[coin.sym],
          computePrediction(coin, window._backtests[coin.sym])
        );
        updated = true;
      }
      if (updated) emitPredictionEvent('predictionadvancedready');
      return updated;
    })();
    try {
      return await advancedBacktestWarmPromise;
    } finally {
      advancedBacktestWarmPromise = null;
    }
  }

  function runWalkForwardBacktest(coin) {
    const cache = candleCache[coin.sym];
    if (!cache || ((!cache.candles || cache.candles.length < 30) && (!cache.candles1m || cache.candles1m.length < 30))) return null;

    const walkKey = SHORT_HORIZON_MINUTES.map(horizonMin => {
      const series = (horizonMin <= 5 && cache.candles1m && cache.candles1m.length >= 30)
        ? cache.candles1m
        : cache.candles;
      // Remove live price (last.c) from cache key so it doesn't recompute on every tick!
      return `${horizonMin}:${series?.length || 0}`;
    }).join('|');
    if (cache._walkBacktestKey === walkKey && cache._walkBacktest) {
      return cache._walkBacktest;
    }
    const results = {};

    SHORT_HORIZON_MINUTES.forEach(horizonMin => {
      const candles = (horizonMin <= 5 && cache.candles1m && cache.candles1m.length >= 30)
        ? cache.candles1m  // Use raw 1-minute candles for h1/h5
        : cache.candles;   // Use 5-minute candles for h10+
      if (!candles || candles.length < 30) return;

      const barMinutes = inferBarMinutes(candles) || 5;
      const horizonBars = Math.max(1, Math.round(horizonMin / barMinutes));

      // Limit backtest steps to prevent UI freeze / Canada-node CPU thrash
      const maxBacktestSteps = PERF.maxBacktestSteps;
      const minStartIndex = Math.max(26, horizonBars + 10);
      const startIndex = Math.max(minStartIndex, candles.length - horizonBars - maxBacktestSteps);
      const windowBars = PERF.backtestWindowBars;

      const observations = [];
      const history = [];

      for (let idx = startIndex; idx < candles.length - horizonBars; idx++) {
        // Slice window to bound buildSignalModel's O(N) complexity
        const windowCandles = candles.slice(Math.max(0, idx + 1 - windowBars), idx + 1);
        const model = buildSignalModel(windowCandles, null, [], {
          includeMicrostructure: false,
          includeSetups: false,
        });
        if (!model) continue;

        const entry = windowCandles[windowCandles.length - 1].c;
        const ptb = windowCandles[windowCandles.length - 1].o || entry;
        const exit = candles[idx + horizonBars].c;

        // PTB CDF probability & intrawindow expected move (matching live predictions.js)
        const atrPctRaw = Number(model.volatility?.atrPct);
        const atrPct = (Number.isFinite(atrPctRaw) && atrPctRaw > 0) ? (atrPctRaw / 100) : 0.0035;
        const atrDollar = entry * atrPct;
        const remainingFrac = 0.60;
        const expectedMove = model.score * atrDollar * 0.40 * remainingFrac;
        const meanFinal = entry + expectedMove;
        const sigma = Math.max(entry * 0.0015, atrDollar * Math.sqrt(remainingFrac));
        const z = (meanFinal - ptb) / (sigma || 1);
        let pUp = normalCDF(z);

        const gap = entry - ptb;
        if (gap < 0 && model.score <= 0 && pUp > 0.45) pUp = Math.min(pUp, 0.40);
        if (gap > 0 && model.score >= 0 && pUp < 0.55) pUp = Math.max(pUp, 0.60);

        // In Polymarket binary contract terms:
        // Settlement is: exit (Chainlink settlement TWAP) >= PTB ? UP : DOWN
        const actualSettleUp = exit >= ptb;
        const modelCallUp = pUp >= 0.50;
        const isWin = (modelCallUp === actualSettleUp);
        const payoffPct = isWin ? 1.0 : -1.0;
        const rawReturn = payoffPct * (Math.abs((exit - ptb) / (ptb || 1)) * 100 + 0.5);
        const returnPct = clamp(rawReturn, -25, 25);
        const ptbScore = clamp((pUp - 0.5) * 2.0, -1, 1);

        const rawObservation = {
          idx,
          isWin,
          score: ptbScore,
          absScore: Math.abs(ptbScore),
          signal: model.signal,
          agreement: model.diagnostics?.agreement ?? 0.5,
          conflict: model.diagnostics?.conflict ?? 0,
          coreScore: ptbScore,
          persistenceScore: model.diagnostics?.persistenceScore ?? 0,
          structureBias: model.diagnostics?.structureBias ?? 0,
          structureZone: model.diagnostics?.structureZone ?? 'middle',
          regime: classifyMarketRegime(model),
          returnPct,
          bucket: scoreBucket(Math.abs(ptbScore)),
        };
        const calibration = history.length >= BACKTEST_MIN_TRAIN_OBS
          ? calibrateBacktestFilter(history, rawObservation.regime, horizonMin, horizonBars)
          : { ...defaultBacktestFilter(horizonMin, coin.sym), calibrationSample: history.length, regimeAware: false };
        observations.push({
          ...applyBacktestFilter(rawObservation, calibration),
          calibrationSample: calibration.calibrationSample || history.length,
          regimeAware: !!calibration.regimeAware,
        });
        history.push(rawObservation);
      }

      const key = horizonKey(horizonMin);
      results[key] = summarizeBacktestObservations(observations, horizonMin, barMinutes, horizonBars);
      results[key].tradeFit = scoreTradeFitHorizon(results[key], horizonMin);
      results[key].tradeFitLabel = summarizeTradeFitLabel(results[key].tradeFit ?? 0.5);
    });

    const reliability = backtestReliability(SHORT_HORIZON_MINUTES.map(horizonMin => results[horizonKey(horizonMin)]));
    const tradeFit = scoreTradeFit(results);
    const preferred = SHORT_HORIZON_MINUTES.reduce((best, horizonMin) => {
      const stats = results[horizonKey(horizonMin)];
      const score = stats?.tradeFit;
      if (!Number.isFinite(score)) return best;
      if (!best || score > best.score) return { horizonMin, score };
      return best;
    }, null);
    const preferredHorizon = preferred?.horizonMin || DEFAULT_SHORT_HORIZON_MIN;
    const preferredStats = results[horizonKey(preferredHorizon)] || null;
    const baseFilter = defaultBacktestFilter(preferredHorizon, coin.sym);
    const result = {
      sym: coin.sym,
      source: cache.source,
      candleCount: Math.max(cache.candles?.length || 0, cache.candles1m?.length || 0),
      candleCount15m: cache.candles15m?.length || 0,
      ...results,
      volatility: buildAdvancedVolatilitySnapshot(cache),
      advanced: getCachedAdvancedBacktest(cache) || (cache.longHistory?.length >= 30 ? runAdvancedBacktest(coin) : null),
      summary: {
        reliability,
        label: summarizeReliabilityLabel(reliability),
        tradeFit,
        tradeFitLabel: summarizeTradeFitLabel(tradeFit),
        preferredHorizon,
        entryThreshold: preferredStats?.entryThreshold ?? baseFilter.entryThreshold,
        minAgreement: preferredStats?.minAgreement ?? baseFilter.minAgreement,
        horizonOrder: SHORT_HORIZON_MINUTES.slice(),
        startingEquity: BACKTEST_STARTING_EQUITY,
      },
    };
    cache._walkBacktestKey = walkKey;
    cache._walkBacktest = result;
    return result;
  }

  function applyLiveCalibration(model, backtest) {
    const wfReliability = backtest?.summary?.reliability ?? 0.5;
    const wfTradeFit = backtest?.summary?.tradeFit ?? wfReliability;

    // Blend D1/D7 advanced backtest (structural long-term fit) with short walk-forward.
    // 65 % walk-forward (tactical) + 35 % advanced (structural baseline).
    const advReliability = backtest?.advanced?.summary?.reliability;
    const advTradeFit = backtest?.advanced?.summary?.tradeFit;
    const reliability = Number.isFinite(advReliability)
      ? 0.65 * wfReliability + 0.35 * advReliability : wfReliability;
    const tradeFit = Number.isFinite(advTradeFit)
      ? 0.65 * wfTradeFit + 0.35 * advTradeFit : wfTradeFit;
    const agreement = model.diagnostics?.agreement ?? 0.5;
    const conflict = model.diagnostics?.conflict ?? 0;
    const coreScore = Number.isFinite(model.diagnostics?.coreScore) ? model.diagnostics.coreScore : model.score;
    const microScore = Number.isFinite(model.diagnostics?.microScore) ? model.diagnostics.microScore : 0;
    const preferredHorizon = backtest?.summary?.preferredHorizon ?? DEFAULT_SHORT_HORIZON_MIN;
    const preferredStats = backtest?.[horizonKey(preferredHorizon)] || null;
    const liveFilter = defaultBacktestFilter(preferredHorizon, backtest?.sym || null);
    const entryThreshold = preferredStats?.entryThreshold ?? backtest?.summary?.entryThreshold ?? liveFilter.entryThreshold;
    const minAgreement = preferredStats?.minAgreement ?? backtest?.summary?.minAgreement ?? liveFilter.minAgreement;
    const tapeVelocity = model.diagnostics?.tapeVelocity || null;
    const tapeReleaseValve = !!tapeVelocity?.releaseValve
      && agreement >= Math.max(0.5, minAgreement - 0.03)
      && conflict < 0.30;
    // maxScore cap: prevents momentum-exhaustion signals (conf 60%+ = anti-predictive for high-beta coins)
    const maxScore = liveFilter.maxScore ?? 1.0;
    const decisionFloor = 0.08;
    const calibration = clamp((0.68 + reliability * 0.20 + tradeFit * 0.24 + agreement * 0.10) - conflict * 0.28, 0.35, 1.10);
    const coreAdjusted = coreScore * calibration;
    const microAligns = Math.sign(coreScore) === 0 || Math.sign(microScore) === 0 || Math.sign(microScore) === Math.sign(coreScore);
    const microCap = 0.16;
    const microOverlay = clamp(
      microScore * (microAligns ? 0.12 : 0.04),
      -microCap,
      microCap
    );
    const persistenceScore = model.diagnostics?.persistenceScore ?? 0;
    const structureBias = model.diagnostics?.structureBias ?? 0;
    const structureZone = model.diagnostics?.structureZone ?? 'middle';
    const scoreBuffer = entryThreshold * (conflict > 0.28 ? 0.22 : 0.14);
    const agreementBuffer = conflict > 0.28 ? 0.05 : 0.03;
    const inBufferZone = Math.abs(coreScore) < (entryThreshold + scoreBuffer) || agreement < (minAgreement + agreementBuffer);
    const conflictVeto = conflict >= 0.38 && agreement < (minAgreement + 0.08);
    const weakCoreVeto = Math.abs(coreScore) < (entryThreshold * 0.92) && conflict >= 0.30;
    const structureVeto = (structureZone === 'resistance' && coreScore > 0 && agreement < 0.65 && Math.abs(structureBias) >= 0.18)
      || (structureZone === 'support' && coreScore < 0 && agreement < 0.65 && Math.abs(structureBias) >= 0.18);
    const persistenceVeto = Math.sign(persistenceScore) !== 0
      && Math.sign(persistenceScore) !== Math.sign(coreScore)
      && Math.abs(persistenceScore) >= 0.35
      && Math.abs(coreScore) < (entryThreshold + 0.04);
    const strongBacktest = reliability >= 0.56 || tradeFit >= 0.58;
    const conflictHard = conflictVeto && conflict >= 0.48 && agreement < (minAgreement + 0.03) && (!strongBacktest || Math.abs(coreScore) < (entryThreshold * 0.92));
    const weakCoreHard = weakCoreVeto && Math.abs(coreScore) < (entryThreshold * 0.72) && conflict >= 0.36 && !strongBacktest;
    const structureHard = structureVeto && Math.abs(structureBias) >= 0.28 && agreement < 0.60;
    const persistenceHard = persistenceVeto && Math.abs(persistenceScore) >= 0.48 && Math.abs(coreScore) < entryThreshold && !strongBacktest;
    const hardVeto = conflictHard || weakCoreHard || structureHard || persistenceHard;
    const softVeto = (conflictVeto || weakCoreVeto || structureVeto || persistenceVeto) && !hardVeto;
    let adjustedScore = clamp(coreAdjusted * (0.75 + agreement * 0.25) * (1 - conflict * 0.24) + microOverlay + structureBias * 0.08, -1, 1);
    if (inBufferZone) {
      const belowThreshold = Math.abs(coreScore) < entryThreshold || agreement < minAgreement;
      if (belowThreshold) {
        const thresholdRatio = Math.abs(coreScore) / Math.max(entryThreshold, 0.001);
        adjustedScore *= tapeReleaseValve
          ? clamp(0.68 + thresholdRatio * 0.22, 0.68, 0.88)
          : clamp(0.55 + thresholdRatio * 0.25, 0.55, 0.80);
      } else {
        adjustedScore *= tapeReleaseValve ? 0.94 : 0.88;
      }
    }
    if (hardVeto) {
      adjustedScore = 0;
    } else if (maxScore < 1.0 && Math.abs(coreScore) > maxScore) {
      // Momentum exhaustion cap: signal fired too late, high-confidence = reversal zone
      adjustedScore = 0;
    } else if (softVeto) {
      const softClamp = Math.max(decisionFloor * 0.9, Math.abs(coreScore) * 0.48);
      adjustedScore = clamp(adjustedScore, -softClamp, softClamp) * 0.82;
    }
    if (tapeReleaseValve && !hardVeto) {
      const velocityLift = 1 + Math.max(0, (tapeVelocity?.scoreBoostMult || 1) - 1) * 0.45;
      adjustedScore = clamp(adjustedScore * velocityLift, -1, 1);
    }
    const horizonBiasBoost = preferredHorizon <= 5 ? 1.06 : preferredHorizon <= 10 ? 1.04 : preferredHorizon <= 15 ? 1.02 : 1;
    const adjustedConfidence = Math.round(clamp(
      confidenceFromScore(Math.abs(adjustedScore)) * (0.74 + reliability * 0.22) * (0.80 + tradeFit * 0.24) * (0.78 + agreement * 0.22) * (1 - conflict * 0.30) * horizonBiasBoost * (inBufferZone ? (tapeReleaseValve ? 0.90 : 0.82) : 1) * (softVeto ? 0.74 : 1) * (tapeReleaseValve ? (1 + Math.max(0, (tapeVelocity?.confidenceBoostMult || 1) - 1) * 0.60) : 1),
      0,
      95
    ));
    const vetoReason = conflictVeto ? 'Conflict veto'
      : weakCoreVeto ? 'Weak-core veto'
        : structureVeto ? 'Structure veto'
          : persistenceVeto ? 'Persistence veto'
            : '';
    const vetoSeverity = hardVeto ? 'hard' : softVeto ? 'soft' : '';

    return {
      ...model,
      rawScore: model.score,
      score: adjustedScore,
      signal: signalFromScore(adjustedScore),
      confidence: adjustedConfidence,
      diagnostics: {
        ...model.diagnostics,
        reliability,
        tradeFit,
        tradeFitLabel: summarizeTradeFitLabel(tradeFit),
        preferredHorizon,
        qualityLabel: reliability >= 0.72 ? 'Backtest strong' : reliability >= 0.56 ? 'Backtest decent' : reliability >= 0.40 ? 'Backtest mixed' : 'Backtest weak',
        calibration,
        rawConfidence: model.confidence,
        entryThreshold,
        minAgreement,
        decisionFloor,
        scoreBuffer,
        agreementBuffer,
        inBufferZone,
        vetoReason,
        vetoed: !!vetoReason,
        vetoSeverity,
        hardVeto,
        softVeto,
        tapeReleaseValve,
        thresholdFactor: Math.abs(coreScore) >= entryThreshold ? 1 : Math.abs(coreScore) / Math.max(entryThreshold, 0.001),
      },
    };
  }

  function applyFastTimingOverlay(model, fastTiming) {
    if (!fastTiming) return model;
    if (model.diagnostics?.vetoed) return model;
    const aligns = Math.sign(model.score) === 0 || Math.sign(fastTiming.score) === 0
      || Math.sign(model.score) === Math.sign(fastTiming.score);

    // Gate-aware overlay: hard-locked sections carry more weight than a soft gate;
    // a blocked gate provides almost no contribution and penalises confidence.
    const overlayWeight = fastTiming.hardGated && aligns ? 0.22
      : fastTiming.gated && aligns ? 0.16
        : fastTiming.gated === false ? 0.04
          : aligns ? 0.14 : 0.07;

    const adjustedScore = clamp(model.score + fastTiming.score * overlayWeight, -1, 1);

    const confDelta = fastTiming.hardGated && aligns ? fastTiming.confidence * 0.16
      : fastTiming.gated && aligns ? fastTiming.confidence * 0.12
        : fastTiming.gated === false ? -fastTiming.confidence * 0.08
          : aligns ? fastTiming.confidence * 0.12 : -fastTiming.confidence * 0.05;

    const adjustedConfidence = Math.round(clamp(model.confidence + confDelta, 0, 95));

    return {
      ...model,
      score: adjustedScore,
      signal: signalFromScore(adjustedScore),
      confidence: adjustedConfidence,
      diagnostics: {
        ...model.diagnostics,
        fastTiming: { ...fastTiming, aligns },
        driverSummary: fastTiming.score && Math.abs(fastTiming.score) >= 0.12
          ? `${model.diagnostics?.driverSummary || 'No dominant driver cluster'} · ${fastTiming.label}`
          : (model.diagnostics?.driverSummary || 'No dominant driver cluster'),
      },
    };
  }

  function normalizePythPrice(entry) {
    if (!entry) return null;
    let price = Number(typeof entry === 'object' ? entry.price : entry);
    const expo = Number(typeof entry === 'object' ? entry.expo : 0);
    if (!Number.isFinite(price) || price <= 0) return null;
    if (Number.isFinite(expo) && expo !== 0 && price > 100000) {
      price *= Math.pow(10, expo);
    }
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  function getFreshLivePriceSnapshot(sym, coin) {
    const now = Date.now();
    const samples = [];
    const push = (source, price, ts, maxAgeMs, weight = 1) => {
      const px = Number(price);
      const sampleTs = Number(ts || now);
      if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(sampleTs)) return;
      const ageMs = Math.max(0, now - sampleTs);
      if (ageMs > maxAgeMs) return;
      samples.push({ source, price: px, ts: sampleTs, ageMs, weight });
    };

    const rtds = window.PredictionMarkets?.getFreshRtdsTwap?.(sym, 15_000);
    push('rtds-twap', rtds?.price, rtds?.obsTs, 15_000, 1.25);

    const microTwap = window.Microstructure?.getTwap?.(sym, 30_000);
    push('micro-twap', microTwap, now, 15_000, 1.10);

    const rti = window._rtiPrices?.[sym];
    push('twap-stream', rti?.price, rti?.ts, 15_000, 0.90);

    const ticker = coin?.instrument ? window._appTickers?.[coin.instrument] : null;
    push('ticker', ticker?.last, ticker?.timestamp || ticker?.ts, 15_000, 0.80);

    const pythEntry = window._pythPrices?.[sym];
    const pythPrice = normalizePythPrice(pythEntry);
    const pythTs = pythEntry?.publishTime ? Number(pythEntry.publishTime) * 1000 : null;
    push('pyth', pythPrice, pythTs, 20_000, 0.75);

    if (!samples.length) return null;
    const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0) || 1;
    const price = samples.reduce((sum, sample) => sum + sample.price * sample.weight, 0) / totalWeight;
    return { price, ts: now, samples };
  }

  function buildLiveTimingGuard(coin, cache, modelScore, fastTiming) {
    const sym = coin?.sym;
    const candles1m = cache?.candles1m || [];
    if (!sym || candles1m.length < 4) return null;

    const live = getFreshLivePriceSnapshot(sym, coin);
    const latestClosed = candles1m[candles1m.length - 1];
    const livePrice = live?.price || Number(latestClosed?.c);
    const prev1 = Number(candles1m[candles1m.length - 2]?.c);
    const prev3 = Number(candles1m[candles1m.length - 4]?.c);
    if (!Number.isFinite(livePrice) || !Number.isFinite(prev1) || !Number.isFinite(prev3) || prev1 <= 0 || prev3 <= 0) {
      return null;
    }

    const drift1mPct = ((livePrice - prev1) / prev1) * 100;
    const drift3mPct = ((livePrice - prev3) / prev3) * 100;
    const sol = sym === 'SOL';
    const oneMinThreshold = sol ? 0.035 : 0.050;
    const threeMinThreshold = sol ? 0.085 : 0.120;
    const liveDir = drift1mPct <= -oneMinThreshold || drift3mPct <= -threeMinThreshold
      ? -1
      : drift1mPct >= oneMinThreshold || drift3mPct >= threeMinThreshold
        ? 1
        : 0;
    const modelDir = modelScore > 0.12 ? 1 : modelScore < -0.12 ? -1 : 0;
    const fastDir = fastTiming?.diagnostics?.driftDir || 0;
    const fastScore = Number(fastTiming?.score || 0);
    const fastConflict = modelDir !== 0 && fastDir !== 0 && fastDir !== modelDir && Math.abs(fastScore) >= (sol ? 0.12 : 0.18);
    const liveConflict = modelDir !== 0 && liveDir !== 0 && liveDir !== modelDir;
    const conflict = liveConflict || fastConflict;
    const hard = conflict && (
      Math.abs(drift1mPct) >= (sol ? 0.060 : 0.085)
      || Math.abs(drift3mPct) >= (sol ? 0.140 : 0.180)
      || Math.abs(fastScore) >= (sol ? 0.22 : 0.28)
    );

    return {
      conflict,
      hard,
      modelDir,
      liveDir,
      fastDir,
      livePrice,
      liveSource: live?.samples?.map(sample => sample.source).join('+') || 'closed-1m',
      drift1mPct,
      drift3mPct,
      fastScore,
      scoreMultiplier: conflict ? (hard ? 0.28 : 0.55) : 1,
      confidenceMultiplier: conflict ? (hard ? 0.48 : 0.70) : 1,
    };
  }

  function packetStrength(packet) {
    return (packet.strength || 0) * (packet.trust || 0) * (packet.relevance || 0) * (packet.freshness || 0);
  }

  function buildSignalRouterContext(coin, model, fastTiming, backtest, cache) {
    const sourceFreshness = clamp(1 - ((Date.now() - (cache?.ts || Date.now())) / 90000), 0.25, 1);
    const sourceLabel = cache?.source || '';
    const trustBase = sourceLabel.includes('coinbase') ? 0.90
      : sourceLabel.includes('crypto.com') ? 0.86
        : sourceLabel.includes('binance') ? 0.80
          : sourceLabel.includes('bybit') ? 0.80
            : sourceLabel.includes('kucoin') ? 0.78
              : sourceLabel.includes('bitfinex') ? 0.78
                : sourceLabel.includes('mexc') ? 0.76
                  : 0.72;
    const microTrust = cache?.book && cache?.trades?.length ? 0.84 : 0.46;
    const timingTrust = cache?.candles1m?.length ? 0.82 : 0.35;
    const derivativeTrust = derivCache[coin.sym] ? 0.70 : 0.30;
    const chainSnapshot = window.BlockchainScan?.get?.(coin.sym) || null;
    const chainAgeMs = chainSnapshot?.ts ? Math.max(0, Date.now() - chainSnapshot.ts) : null;
    const chainFreshness = chainAgeMs == null ? 0.28 : clamp(1 - (chainAgeMs / 180000), 0.20, 1);
    const chainTrust = chainSnapshot?.error ? 0.28 : 0.74;
    const bookLiquidity = classifyBookLiquidity(model.indicators?.book);
    const session = model.session || getSessionInfo();
    const transitionRisk = (!session.current.scalp && session.current.label === 'Dead Zone') || session.minsToNext <= 30;
    const routerProfile = getOrbitalRouterProfile(coin.sym);
    const innerArmed = Math.abs(model.diagnostics?.coreScore || model.score || 0) >= (routerProfile.key === 'highBeta' ? 0.15 : 0.10);
    const liveRegimeKey = String(model?.liveRegime?.regime || '').toLowerCase();
    let quantState = /trend/.test(liveRegimeKey)
      ? 'trend'
      : /chop|rang|neutral|unknown/.test(liveRegimeKey)
        ? 'chop'
        : 'neutral';
    let quantSource = 'live-regime';
    const hmmPath = window.QuantCore?.hmm?.lastViterbiPath;
    const hmmLast = Array.isArray(hmmPath) && hmmPath.length
      ? String(hmmPath[hmmPath.length - 1]).toLowerCase()
      : '';
    if (hmmLast) {
      if (/trend|bull|bear/.test(hmmLast)) quantState = 'trend';
      else if (/chop|flat|range|sideways|mean/.test(hmmLast)) quantState = 'chop';
      else quantState = 'transition';
      quantSource = 'quant-hmm';
    }
    const quantRegime = {
      state: quantState,
      confidence: clamp(Number(model?.liveRegime?.confidence ?? 0.5), 0, 1),
      source: quantSource,
      liveRegime: model?.liveRegime?.regime || null,
      hmmState: hmmLast || null,
    };
    return {
      coin,
      model,
      fastTiming,
      backtest,
      cache,
      sourceFreshness,
      trustBase,
      microTrust,
      timingTrust,
      derivativeTrust,
      chainSnapshot,
      chainFreshness,
      chainTrust,
      bookLiquidity,
      session,
      transitionRisk,
      innerArmed,
      quantRegime,
      routerProfile,
      preferredHorizon: backtest?.summary?.preferredHorizon ?? model.diagnostics?.preferredHorizon ?? DEFAULT_SHORT_HORIZON_MIN,
    };
  }

  function buildSignalPackets(context) {
    const {
      model, fastTiming, backtest, sourceFreshness, trustBase, microTrust, timingTrust, derivativeTrust,
      chainSnapshot, chainFreshness, chainTrust,
      bookLiquidity, session, transitionRisk, preferredHorizon, routerProfile, innerArmed,
    } = context;
    const ultraFast = preferredHorizon <= 5;
    const shortBias = preferredHorizon <= 15;
    const slowerShort = preferredHorizon >= 10;
    const packets = [];
    const riskPackets = [];
    const scoreDirection = Math.sign(model.score || 0);
    const pushPacket = packet => {
      packets.push(applyRouterProfile({
        role: 'driver',
        freshness: sourceFreshness,
        relevance: 0.7,
        trust: trustBase,
        direction: scoreDirection,
        ...packet,
      }, routerProfile));
    };

    pushPacket({
      family: 'benchmark',
      category: 'benchmark',
      label: 'Core benchmark',
      detail: model.indicators?.vwap?.label || 'Benchmark aligned',
      strength: clamp(Math.abs(model.diagnostics?.coreScore || model.score || 0), 0, 1),
      relevance: ultraFast ? 0.94 : shortBias ? 0.90 : 0.82,
    });
    pushPacket({
      family: 'trend',
      category: 'trend',
      label: 'Trend structure',
      detail: `${model.indicators?.ema?.label || 'EMA'} · ${model.indicators?.persistence?.label || 'persistence'}`,
      direction: Math.sign(model.diagnostics?.persistenceScore || model.diagnostics?.coreScore || 0),
      strength: clamp(Math.max(Math.abs(model.indicators?.ema?.signal || 0), Math.abs(model.diagnostics?.persistenceScore || 0)), 0, 1),
      relevance: ultraFast ? 0.82 : shortBias ? 0.88 : 0.94,
    });
    pushPacket({
      family: 'momentum',
      category: 'momentum',
      label: 'Momentum complex',
      detail: `${model.indicators?.rsi?.label || 'RSI'} · ${model.indicators?.momentum?.label || 'momentum'}`,
      direction: Math.sign((model.indicators?.rsi?.signal || 0) + (model.indicators?.momentum?.signal || 0)),
      strength: clamp(Math.max(Math.abs(model.indicators?.rsi?.signal || 0), Math.abs(model.indicators?.momentum?.signal || 0)), 0, 1),
      relevance: 0.74,
    });
    pushPacket({
      family: 'structure',
      category: 'structure',
      label: 'Range structure',
      detail: model.indicators?.structure?.label || 'Range state',
      direction: Math.sign(model.diagnostics?.structureBias || 0),
      strength: clamp(Math.abs(model.diagnostics?.structureBias || 0), 0, 1),
      relevance: 0.84,
    });

    if (chainSnapshot && !chainSnapshot.error) {
      const chainScore = Number(chainSnapshot.score || 0);
      const chainRisk = Number(chainSnapshot.risk || 0);
      // Only emit directional on-chain pressure when score is real (not congestion proxy).
      if (Math.abs(chainScore) >= 0.08) {
        pushPacket({
          family: 'onchain',
          category: 'onchain',
          label: 'Blockchain pressure',
          detail: `${chainSnapshot.chain || chainSnapshot.label || coin.sym} · ${chainSnapshot.signal || 'NEUTRAL'} (${chainSnapshot.source || 'chain'})`,
          direction: Math.sign(chainScore || 0),
          strength: clamp(Math.abs(chainScore) / 0.55, 0, 1),
          freshness: chainFreshness,
          trust: chainTrust,
          // On-chain metrics lag badly for 5m binaries — de-weight ultra-short
          relevance: ultraFast ? 0.12 : shortBias ? 0.38 : 0.68,
        });
      } else if (chainRisk >= 0.25) {
        riskPackets.push(applyRouterProfile({
          family: 'onchain-risk',
          category: 'onchain',
          role: 'risk',
          label: 'On-chain congestion',
          detail: `${chainSnapshot.chain || coin.sym} congestion=${chainSnapshot.congestion || 'MED'} (non-directional)`,
          direction: 0,
          strength: clamp(chainRisk, 0, 1),
          freshness: chainFreshness,
          trust: chainTrust,
          relevance: ultraFast ? 0.55 : 0.40,
        }, routerProfile));
      }
    } else if (chainSnapshot?.error) {
      riskPackets.push(applyRouterProfile({
        family: 'onchain-risk',
        category: 'onchain',
        role: 'risk',
        label: 'On-chain feed degraded',
        detail: String(chainSnapshot.error || 'chain fetch failed').slice(0, 120),
        direction: 0,
        strength: 0.62,
        freshness: chainFreshness || 0.28,
        trust: 0.78,
        relevance: shortBias ? 0.86 : 0.70,
      }, routerProfile));
    }

    if (innerArmed && model.indicators?.book) {
      pushPacket({
        family: 'micro-book',
        category: 'microstructure',
        label: 'Order book',
        detail: `${model.indicators.book.label} · ${bookLiquidity.label}`,
        direction: Math.sign(model.indicators.book.imbalance || 0),
        strength: clamp(Math.abs(model.indicators.book.imbalance || 0), 0, 1),
        trust: microTrust * bookLiquidity.score,
        relevance: ultraFast ? 0.96 : slowerShort ? 0.68 : shortBias ? 0.84 : 0.42,
      });
    }

    if (innerArmed && model.indicators?.flow) {
      pushPacket({
        family: 'micro-flow',
        category: 'microstructure',
        label: 'Trade flow',
        detail: model.indicators.flow.label || 'Tape flow',
        direction: model.indicators.flow.aggressor === 'buyers' ? 1 : model.indicators.flow.aggressor === 'sellers' ? -1 : 0,
        strength: clamp(Math.abs(model.indicators?.flow?.signal || 0), 0, 1),
        trust: microTrust,
        relevance: ultraFast ? 0.92 : slowerShort ? 0.62 : shortBias ? 0.82 : 0.36,
      });
    }

    if (innerArmed && model.indicators?.microstructure) {
      const micro = model.indicators.microstructure;
      pushPacket({
        family: 'micro-engine',
        category: 'microstructure',
        label: 'Microstructure engine',
        detail: `${micro.sweep?.label || 'Sweep'} · ${micro.vacuum?.label || 'Liquidity'}`,
        direction: Math.sign(micro.composite || 0),
        strength: clamp(Math.abs(micro.composite || 0), 0, 1),
        trust: microTrust * 0.82,
        relevance: ultraFast ? 0.90 : shortBias ? 0.74 : 0.40,
      });

      if ((micro.spoofing?.score || 0) >= 0.50) {
        pushPacket({
          family: 'micro-spoof',
          category: 'microstructure',
          label: 'Spoofing pressure',
          detail: micro.spoofing?.label || 'Spoofing risk',
          direction: Math.sign(micro.spoofing?.direction || 0),
          strength: clamp(micro.spoofing?.score || 0, 0, 1),
          trust: microTrust * 0.78,
          relevance: ultraFast ? 0.90 : shortBias ? 0.78 : 0.44,
        });
      }

      if ((micro.iceberg?.score || 0) >= 0.50) {
        pushPacket({
          family: 'micro-iceberg',
          category: 'microstructure',
          label: 'Iceberg absorption',
          detail: micro.iceberg?.label || 'Absorption detected',
          direction: Math.sign(micro.iceberg?.direction || 0),
          strength: clamp(micro.iceberg?.score || 0, 0, 1),
          trust: microTrust * 0.80,
          relevance: ultraFast ? 0.92 : shortBias ? 0.80 : 0.46,
        });
      }
    }

    if (innerArmed && fastTiming) {
      const horizonScore = fastTiming.horizonScores?.[`h${preferredHorizon}`] ?? fastTiming.score;
      const gateArmed = fastTiming.gated !== undefined;  // is this the new sectioned model?
      pushPacket({
        family: 'timing',
        category: 'timing',
        label: gateArmed
          ? `${fastTiming.gateLabel || 'Sectioned timing'} ${preferredHorizon}m`
          : 'Pooled 1m timing',
        detail: fastTiming.label,
        direction: Math.sign(horizonScore || 0),
        strength: clamp(
          Math.abs(horizonScore || 0) * (fastTiming.hardGated ? 1.15 : fastTiming.gated === false ? 0.35 : 1.0),
          0, 1
        ),
        trust: timingTrust * (fastTiming.gated === false ? 0.45 : 1.0),
        relevance: ultraFast ? 0.98 : slowerShort ? 0.44 : shortBias ? 0.88 : 0.28,
      });
    }

    if (derivCache[context.coin.sym]) {
      const deriv = derivCache[context.coin.sym];
      const hasLive = deriv.source === 'derivatives-feed';
      // Direction: prefer the live composite pressure (liq imbalance + funding + OI) when meaningful,
      // else fall back to the funding-sign rule (crowded shorts = bullish, crowded longs = bearish).
      const liveDir = hasLive && Math.abs(deriv.pressure || 0) > 0.15 ? Math.sign(deriv.pressure) : 0;
      const fundDir = deriv.funding < -0.08 ? 1 : deriv.funding > 0.08 ? -1 : 0;
      const direction = liveDir || fundDir;
      const fundStrength = clamp(Math.abs(deriv.funding || 0) / 0.35, 0, 1);
      const liqStrength = hasLive
        ? clamp(Math.abs(deriv.liqImbalance || 0) * (Math.min(deriv.liqTotalUsd || 0, 5e6) / 5e6), 0, 1)
        : 0;
      const strength = Math.max(fundStrength, liqStrength, hasLive ? clamp(Math.abs(deriv.pressure || 0), 0, 1) : 0);
      const detailBits = [`funding ${deriv.funding?.toFixed?.(3) ?? deriv.funding}%`];
      if (hasLive && deriv.oiDeltaPct != null) detailBits.push(`OIΔ ${deriv.oiDeltaPct >= 0 ? '+' : ''}${deriv.oiDeltaPct.toFixed(1)}%`);
      if (hasLive && (deriv.liqTotalUsd || 0) > 100_000) detailBits.push(`liq $${(deriv.liqTotalUsd / 1e6).toFixed(2)}M ${deriv.liqImbalance >= 0 ? 'short' : 'long'}`);
      packets.push(applyRouterProfile({
        family: 'derivatives',
        category: 'derivatives',
        role: 'driver',
        label: 'Perp positioning',
        detail: `${deriv.market || deriv.exchange || 'perps'} ${detailBits.join(' · ')}`,
        direction,
        strength,
        freshness: sourceFreshness,
        trust: hasLive ? Math.min(0.82, derivativeTrust + 0.12) : derivativeTrust,
        relevance: 0.68,
      }, routerProfile));
    }

    // ★ Options skew (Deribit, BTC/ETH only): 25Δ risk reversal = directional vol demand.
    // Positive RR = calls bid (bullish skew); negative = puts bid (bearish). Gated at ≥1.5 vol pts.
    if (typeof window !== 'undefined' && window.OptionsGammaFeed?.get) {
      const opt = window.OptionsGammaFeed.get(context.coin.sym);
      if (opt && opt.available && Number.isFinite(opt.riskReversal25) && Math.abs(opt.riskReversal25) >= 1.5) {
        const rr = opt.riskReversal25;
        const pinTxt = (opt.pinDistPct != null) ? `, pin ${opt.pinDistPct >= 0 ? '+' : ''}${opt.pinDistPct.toFixed(2)}%` : '';
        // Deribit polls every OptionsGammaFeed.POLL_MS (~90s) and silently keeps the
        // last-good snapshot on fetch failure (options-gamma-feed.js fetchAll()), so a
        // fixed freshness would let an hours-stale skew keep driving predictions forever.
        // Decay it from opt.ts like the rest of this packet set uses sourceFreshness,
        // over a window a few polls wide so a couple of transient misses don't zero it.
        const optPollMs = window.OptionsGammaFeed.POLL_MS || 90000;
        const optFreshness = Number.isFinite(opt.ts)
          ? clamp(1 - ((Date.now() - opt.ts) / (3 * optPollMs)), 0, 1)
          : 0;
        packets.push(applyRouterProfile({
          family: 'options-skew',
          category: 'derivatives',
          role: 'driver',
          label: 'Options skew',
          detail: `${opt.skewLabel} (25Δ RR ${rr >= 0 ? '+' : ''}${rr.toFixed(1)}v${pinTxt})`,
          direction: rr > 0 ? 1 : -1,
          strength: clamp(Math.abs(rr) / 8, 0, 1),
          freshness: optFreshness,
          trust: 0.6,
          relevance: 0.5,
        }, routerProfile));
      }
    }

    if (backtest?.summary) {
      packets.push(applyRouterProfile({
        family: 'history',
        category: 'historical',
        role: 'driver',
        label: 'Historical fit',
        detail: `${Math.round((backtest.summary.tradeFit ?? backtest.summary.reliability ?? 0) * 100)}% trade fit`,
        direction: scoreDirection,
        strength: clamp((backtest.summary.tradeFit ?? backtest.summary.reliability ?? 0.5), 0, 1),
        freshness: 0.92,
        trust: 0.88,
        relevance: 0.78,
      }, routerProfile));
    }

    if (transitionRisk) {
      riskPackets.push(applyRouterProfile({
        family: 'session-risk',
        category: 'session',
        role: 'risk',
        label: 'Session transition',
        detail: session.current.label === 'Dead Zone' ? 'Dead zone liquidity risk' : `Next scalp window in ${session.minsToNext} min`,
        direction: 0,
        strength: session.current.label === 'Dead Zone' ? 0.82 : 0.58,
        freshness: 1,
        trust: 0.86,
        relevance: 0.86,
      }, routerProfile));
    }
    if (bookLiquidity.state === 'thin') {
      riskPackets.push(applyRouterProfile({
        family: 'liquidity-risk',
        category: 'liquidity',
        role: 'risk',
        label: 'Thin liquidity',
        detail: bookLiquidity.label,
        direction: 0,
        strength: 0.78,
        freshness: sourceFreshness,
        trust: 0.82,
        relevance: ultraFast ? 0.96 : shortBias ? 0.90 : 0.64,
      }, routerProfile));
    }
    if ((model.indicators?.microstructure?.vacuum?.severity || 0) >= 0.62) {
      riskPackets.push(applyRouterProfile({
        family: 'vacuum-risk',
        category: 'liquidity',
        role: 'risk',
        label: 'Liquidity vacuum',
        detail: model.indicators?.microstructure?.vacuum?.label || 'Spread expansion + depth collapse',
        direction: 0,
        strength: clamp(model.indicators.microstructure.vacuum.severity, 0, 1),
        freshness: sourceFreshness,
        trust: 0.86,
        relevance: ultraFast ? 0.98 : shortBias ? 0.86 : 0.66,
      }, routerProfile));
    }
    if ((model.indicators?.microstructure?.toxicity?.tox || model.indicators?.microstructure?.toxicity?.proxy || 0) >= 0.62) {
      riskPackets.push(applyRouterProfile({
        family: 'toxicity-risk',
        category: 'microstructure',
        role: 'risk',
        label: 'Flow toxicity',
        detail: model.indicators?.microstructure?.toxicity?.label || 'One-sided flow toxicity',
        direction: 0,
        strength: clamp(model.indicators?.microstructure?.toxicity?.tox || model.indicators?.microstructure?.toxicity?.proxy || 0, 0, 1),
        freshness: sourceFreshness,
        trust: 0.84,
        relevance: ultraFast ? 0.92 : shortBias ? 0.84 : 0.58,
      }, routerProfile));
    }
    if (model.diagnostics?.conflict >= 0.34) {
      riskPackets.push(applyRouterProfile({
        family: 'conflict-risk',
        category: 'consensus',
        role: 'risk',
        label: 'Signal conflict',
        detail: `${Math.round((model.diagnostics.conflict || 0) * 100)}% conflict`,
        direction: 0,
        strength: clamp((model.diagnostics.conflict - 0.24) / 0.30, 0, 1),
        freshness: 1,
        trust: 0.9,
        relevance: 0.95,
      }, routerProfile));
    }
    if (model.diagnostics?.vetoed) {
      const hardVeto = !!model.diagnostics?.hardVeto;
      riskPackets.push(applyRouterProfile({
        family: 'gate-risk',
        category: 'gating',
        role: 'risk',
        label: hardVeto ? 'Decision gate' : 'Decision caution',
        detail: model.diagnostics.vetoReason || 'Execution veto',
        direction: 0,
        strength: hardVeto ? 0.95 : 0.46,
        freshness: 1,
        trust: hardVeto ? 1 : 0.86,
        relevance: hardVeto ? 1 : 0.72,
      }, routerProfile));
    }
    const slideRisk = routerProfile.key === 'highBeta'
      && preferredHorizon >= 10
      && (model.diagnostics?.persistenceScore || 0) <= -0.24
      && (model.indicators?.ema?.signal || 0) <= -0.12
      && (((model.indicators?.vwap?.signal || 0) <= -0.10) || ((model.diagnostics?.structureBias || 0) <= -0.08));
    if (slideRisk) {
      riskPackets.push(applyRouterProfile({
        family: 'slide-risk',
        category: 'trend-slip',
        role: 'risk',
        label: 'Slide regime',
        detail: 'High-beta coin is slipping on 15m trend structure; fade fast timing',
        direction: 0,
        strength: 0.88,
        freshness: 1,
        trust: 0.94,
        relevance: 0.96,
      }, routerProfile));
    }

    // ── Shell Router: inject cross-shell routed signal ───────────────────────
    // ShellRouter emits photons when a shell ionises (sell threshold crossed).
    // Photons arrive at this coin's shell after the configured propagation delay
    // (s→p: 90s, s→d: 210s) with β amplification.
    // The packet is role:'risk' so it survives filterSignalPackets() for 15M
    // horizon contracts. applyRouterProfile() then scales it by timingWeight:
    //   momentum coins (SOL/HYPE): ×1.12 — shell events hit harder
    //   core coins    (BTC/ETH):   ×0.78 — core absorbs timing pressure quietly
    const _shellPkt = window.ShellRouter?.getRoutedPacket(context.coin?.sym);
    if (_shellPkt && (_shellPkt.freshness || 0) > 0.30) {
      riskPackets.push(applyRouterProfile({ ..._shellPkt }, routerProfile));
    }

    return [...packets, ...riskPackets];
  }

  function filterSignalPackets(packets, context) {
    const filtered = packets.filter(packet => (packet.freshness || 0) >= 0.3 && (packet.trust || 0) >= 0.28);
    const familyBest = new Map();
    filtered.forEach(packet => {
      const existing = familyBest.get(packet.family);
      if (!existing || packetStrength(packet) > packetStrength(existing)) {
        familyBest.set(packet.family, packet);
      }
    });
    let deduped = Array.from(familyBest.values());

    if (context.preferredHorizon >= 10) {
      deduped = deduped.filter(packet => packet.category !== 'timing' || packet.role === 'risk');
    }
    if (context.transitionRisk) {
      deduped = deduped.filter(packet => packet.category !== 'microstructure' || packet.role === 'risk' || packetStrength(packet) >= 0.48);
    }
    if ((context.model.diagnostics?.conflict || 0) >= 0.38) {
      deduped = deduped.filter(packet => packet.role === 'risk' || packet.category !== 'timing' || packetStrength(packet) >= 0.52);
    }

    return deduped.sort((a, b) => packetStrength(b) - packetStrength(a));
  }

  function scoreRoutedRisks(risks) {
    const categorySeen = new Map();
    const familySeen = new Map();
    return risks
      .slice()
      .sort((a, b) => packetStrength(b) - packetStrength(a))
      .reduce((sum, packet, index) => {
        const categoryHits = categorySeen.get(packet.category) || 0;
        const familyHits = familySeen.get(packet.family) || 0;
        const rankWeight = index === 0 ? 1 : index === 1 ? 0.78 : index === 2 ? 0.62 : 0.48;
        const correlationDiscount = Math.max(0.55, 1 - categoryHits * 0.18 - familyHits * 0.10);
        categorySeen.set(packet.category, categoryHits + 1);
        familySeen.set(packet.family, familyHits + 1);
        return sum + packetStrength(packet) * rankWeight * correlationDiscount;
      }, 0);
  }

  function summarizeRoutedSignals(packets, context) {
    const drivers = packets.filter(packet => packet.role !== 'risk' && packet.direction !== 0);
    const risks = packets.filter(packet => packet.role === 'risk');
    const profile = context.routerProfile || getOrbitalRouterProfile(context.coin?.sym || 'BTC');
    const bullish = drivers.filter(packet => packet.direction > 0).reduce((sum, packet) => sum + packetStrength(packet), 0);
    const bearish = drivers.filter(packet => packet.direction < 0).reduce((sum, packet) => sum + packetStrength(packet), 0);
    const riskScore = scoreRoutedRisks(risks);
    const net = bullish - bearish;
    const bias = net > 0.08 ? 'up' : net < -0.08 ? 'down' : 'neutral';
    const modelDirection = Math.sign(context.model.score || 0);
    const biasDirection = bias === 'up' ? 1 : bias === 'down' ? -1 : 0;
    const directionalConflict = modelDirection !== 0 && biasDirection !== 0 && modelDirection !== biasDirection;
    const hardVeto = !!context.model.diagnostics?.hardVeto;
    const softVeto = !!context.model.diagnostics?.softVeto;
    const quantRegime = context.quantRegime || null;
    const chopRegime = quantRegime?.state === 'chop';
    const trendRegime = quantRegime?.state === 'trend';
    const tradeNet = profile.tradeNet * (chopRegime ? 1.12 : trendRegime ? 0.94 : 1);
    const tradeRisk = profile.tradeRisk * (chopRegime ? 0.90 : trendRegime ? 1.05 : 1);
    const watchNet = profile.watchNet * (chopRegime ? 1.08 : trendRegime ? 0.96 : 1);
    let action = 'watch';
    if (hardVeto || riskScore >= profile.invalidateRisk) action = 'invalidated';
    else if (directionalConflict) action = 'stand-aside';
    else if (Math.abs(net) >= tradeNet && riskScore <= tradeRisk && !softVeto) action = 'trade';
    else if (softVeto || Math.abs(net) < watchNet || riskScore >= (tradeRisk + 0.18)) action = 'stand-aside';
    const baseConfidenceMultiplier = action === 'trade' ? 1.05 : action === 'watch' ? 0.97 : action === 'stand-aside' ? 0.74 : 0.54;
    const confidenceMultiplier = baseConfidenceMultiplier * (chopRegime ? 0.92 : trendRegime ? 1.03 : 1.0);
    const topDrivers = drivers.slice(0, 3).map(packet => ({
      label: packet.label,
      detail: packet.detail,
      direction: packet.direction > 0 ? 'up' : 'down',
      strength: packetStrength(packet),
    }));
    const riskFlags = risks.slice(0, 3).map(packet => packet.label);
    if (directionalConflict) riskFlags.unshift('Directional mismatch');
    if (quantRegime?.state === 'chop') riskFlags.unshift('Quant regime: chop guard');
    if (quantRegime?.state === 'transition') riskFlags.unshift('Quant regime: transition');
    const summaryText = [
      topDrivers.length ? topDrivers.map(packet => `${packet.label} ${packet.direction === 'up' ? 'supports UP' : 'leans DOWN'} (${packet.detail})`).join(' · ') : 'No dominant routed drivers',
      riskFlags.length ? `Risks: ${riskFlags.join(', ')}` : 'No elevated router risks',
      quantRegime ? `Regime: ${quantRegime.state} (${Math.round((quantRegime.confidence || 0) * 100)}% ${quantRegime.source})` : null,
    ].filter(Boolean).join(' | ');

    return {
      packets,
      topDrivers,
      riskFlags,
      bullish,
      bearish,
      riskScore,
      bias,
      directionalConflict,
      action,
      confidenceMultiplier,
      quantRegime,
      summaryText,
    };
  }

  // Session-scoped verification logging for microstructure execution cues.
  // Auto-disables to avoid permanent console noise.
  const _liveCueVerify = {
    remaining: 90,
    lastBySym: {},
    trail: [],
    maxTrail: 120,
  };

  function _recordLiveCueEntry(entry) {
    _liveCueVerify.trail.push(entry);
    if (_liveCueVerify.trail.length > _liveCueVerify.maxTrail) {
      _liveCueVerify.trail = _liveCueVerify.trail.slice(-_liveCueVerify.maxTrail);
    }

    if (typeof window !== 'undefined') {
      window._execCueVerifyTrail = _liveCueVerify.trail;
      window.__WECRYPTO_EXEC_CUES = {
        remaining: _liveCueVerify.remaining,
        latest: _liveCueVerify.trail[_liveCueVerify.trail.length - 1] || null,
        getTrail: () => _liveCueVerify.trail.slice(),
      };
      try {
        window.dispatchEvent(new CustomEvent('exec-cue:micro-verify', { detail: entry }));
      } catch (_) { }
    }
  }

  function logLiveExecutionCues(sym, routed, packets) {
    if (_liveCueVerify.remaining <= 0) return;
    const microFamilies = new Set(['micro-book', 'micro-flow', 'micro-engine', 'micro-spoof', 'micro-iceberg', 'toxicity-risk', 'vacuum-risk']);
    const cuePackets = (Array.isArray(packets) ? packets : []).filter(p => microFamilies.has(p.family));
    if (!cuePackets.length) return;

    const short = cuePackets
      .map(p => `${p.family}:${(p.role || 'driver')[0]}:${(p.direction || 0) > 0 ? 'UP' : (p.direction || 0) < 0 ? 'DOWN' : 'NEUT'}:${(p.strength || 0).toFixed(2)}`)
      .join('|');
    const risk = (routed?.riskFlags || []).join(',');
    const sig = `${short}#${risk}`;
    if (_liveCueVerify.lastBySym[sym] === sig) return;
    _liveCueVerify.lastBySym[sym] = sig;

    const entry = {
      ts: Date.now(),
      sym,
      action: routed?.action || 'n/a',
      bias: Number(routed?.bias || 0),
      cues: short,
      risks: risk ? risk.split(',').filter(Boolean) : [],
    };
    _recordLiveCueEntry(entry);

    predictionDebugLog(
      `exec-cue:${sym}`,
      'log',
      () => `[ExecCue][MICRO-VERIFY] ${sym} action=${entry.action} bias=${entry.bias.toFixed(3)} cues=${short}${risk ? ` risks=${risk}` : ''}`,
      5000
    );
    _liveCueVerify.remaining--;
    if (_liveCueVerify.remaining === 0) {
      console.log('[ExecCue][MICRO-VERIFY] Session verification logging complete; auto-disabled');
    }
  }

  function buildHyperShortAnchors(coin, ctx = {}) {
    const sym = coin?.sym;
    const price = ctx.price ?? ctx.livePrice;
    let score = ctx.score;
    let confidence = ctx.confidence;
    const diag = { temporal: null, graph: null, narrative: null };

    if (window.MultiAssetGraph?.update && price) {
      window.MultiAssetGraph.update(sym, price);
    }

    if (window.TemporalFusionLite?.applyToScore) {
      const fusion = window.TemporalFusionLite.applyToScore(score, {
        score,
        fastTiming: ctx.fastTiming,
        msToClose: ctx.msToClose,
        atrPct: ctx.atrPct,
        volatility: ctx.volatility,
        blend: 0.36,
      });
      diag.temporal = fusion;
      score = fusion.score;
    }

    if (window.MultiAssetGraph?.applyToScore && sym !== window.MultiAssetGraph?.ANCHOR) {
      const graph = window.MultiAssetGraph.applyToScore(score, sym, 0.11);
      diag.graph = graph;
      score = graph.score;
    }

    if (window.NarrativeVelocity?.applyToScore) {
      const narrative = window.NarrativeVelocity.applyToScore(score, sym, { weight: 0.07 });
      diag.narrative = narrative;
      score = narrative.score;
    }

    // ASI1 Advisory Blend: inject high-conviction ASI1 Pre-Contract signals into model score
    try {
      const asi1Brief = window.Asi1PreContract?.get?.(sym, '5m') || window.Asi1PreContract?.get?.(sym, '15m');
      if (asi1Brief && asi1Brief.call && (asi1Brief.confidence >= 0.60)) {
        const asi1Dir = asi1Brief.call === 'UP' ? 1 : (asi1Brief.call === 'DOWN' ? -1 : 0);
        if (asi1Dir !== 0) {
          const asi1Weight = 0.12;
          score = score * (1 - asi1Weight) + asi1Dir * (asi1Brief.confidence * 0.35) * asi1Weight;
          diag.asi1 = { call: asi1Brief.call, confidence: asi1Brief.confidence, weight: asi1Weight };
        }
      }
    } catch (_) { /* */ }

    if (diag.temporal || diag.graph || diag.narrative || diag.asi1) {
      const boosts = [
        diag.temporal?.conflict ? -4 : 0,
        diag.graph?.adjusted ? 2 : 0,
        diag.narrative?.adjusted ? 2 : 0,
        diag.asi1 ? Math.round((diag.asi1.confidence || 0.6) * 6) : 0,
      ];
      confidence = Math.round(clamp(confidence + boosts.reduce((s, v) => s + v, 0), 0, 95));
    }

    return { score: clamp(score, -1, 1), confidence, diagnostics: diag };
  }

  /**
   * Pre-Open Horizon Forecaster (T+1)
   * Predicts 3-5 minutes ahead of the upcoming contract window open (:00, :05, :10, :15...).
   * Projects estimated Strike (Price To Beat) and calculates forward CDF probability.
   */
  function computePreOpenHorizonForecast(coin, horizonMin = 5) {
    const sym = coin.sym || coin;
    const cache = candleCache[sym];
    if (!cache || (!cache.candles && !cache.candles1m)) return null;

    const nowMs = Date.now();
    const windowSecMs = horizonMin * 60_000;
    const nextBoundaryMs = Math.ceil(nowMs / windowSecMs) * windowSecMs;
    const msToNextBoundary = Math.max(0, nextBoundaryMs - nowMs);
    const minsToNextBoundary = msToNextBoundary / 60_000;

    const candles = (horizonMin <= 5 && cache.candles1m && cache.candles1m.length >= 26) ? cache.candles1m : cache.candles;
    if (!candles || candles.length < 10) return null;
    const lastCandle = candles[candles.length - 1];
    const lastPrice = Number(lastCandle.c || lastCandle.o);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;

    const lastPred = cache._lastPrediction || window._predictions?.[sym] || null;
    const atrPctRaw = Number(lastPred?.volatility?.atrPct);
    const atrPct = Number.isFinite(atrPctRaw) && atrPctRaw > 0 ? atrPctRaw / 100 : 0.0035;
    const atrDollar = lastPrice * atrPct;

    const baseScore = Number(lastPred?.score || 0);
    const drift1mPct = Number(lastPred?.diagnostics?.liveTimingGuard?.drift1mPct || 0);
    const surge = typeof window !== 'undefined' && window.SurgePrefetch?.get ? window.SurgePrefetch.get(sym) : null;

    // Project Price at Next Boundary (Estimated PTB for T+1)
    const leadInDriftDollar = lastPrice * ((drift1mPct / 100) * (msToNextBoundary / 60_000) * 0.5);
    const surgeBiasDollar = surge?.active ? lastPrice * (surge.call === 'UP' ? 0.0008 : -0.0008) : 0;
    const projectedOpenPtb = lastPrice + leadInDriftDollar + surgeBiasDollar;

    // Project Settlement Price 5m/15m after Next Boundary
    const expectedHorizonMove = baseScore * atrDollar * 0.40;
    const projectedSettlement = projectedOpenPtb + expectedHorizonMove;

    // Calculate Forward CDF Probability against Projected PTB
    const sigma = Math.max(projectedOpenPtb * 0.0015, atrDollar);
    const z = (projectedSettlement - projectedOpenPtb) / (sigma || 1);
    const pUp = normalCDF(z);
    const forecastDirection = pUp >= 0.50 ? 'UP' : 'DOWN';
    const confidence = Math.round(Math.abs(pUp - 0.50) * 200);

    return {
      sym,
      horizonMin,
      targetBoundaryTs: nextBoundaryMs,
      targetBoundaryIso: new Date(nextBoundaryMs).toISOString(),
      msToNextBoundary,
      minsToNextBoundary: parseFloat(minsToNextBoundary.toFixed(2)),
      currentPrice: lastPrice,
      projectedOpenPtb: parseFloat(projectedOpenPtb.toFixed(coinPriceDecimals(sym))),
      projectedSettlement: parseFloat(projectedSettlement.toFixed(coinPriceDecimals(sym))),
      forecastDirection,
      pUp: parseFloat(pUp.toFixed(4)),
      confidence,
      preOpenCall: forecastDirection,
      sniperAction: confidence >= 40 ? `PRE_POSITION_${forecastDirection}` : 'STANDBY_CONFIRM',
      surgeState: surge?.active ? surge.call : 'calm',
    };
  }

  /**
   * Evaluates whether a contract is inside the Market Maker Strike Defense / Pin-Risk zone.
   * Defends against the 1.23s post-expiry snap trap where MMs defend the strike right into the wire.
   */
  function detectPinRisk(sym, spot, ptb, secondsToClose, depthImbalance = 0) {
    const s = Number(spot);
    const p = Number(ptb);
    const ttc = Number(secondsToClose);
    if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(p) || p <= 0) {
      return { isDefendedPinZone: false, pinRiskScore: 0, warning: null };
    }

    const cache = candleCache[sym] || {};
    const lastPred = cache._lastPrediction || (typeof window !== 'undefined' && window._predictions?.[sym]) || null;
    const atrPctRaw = Number(lastPred?.volatility?.atrPct);
    const atrPct = Number.isFinite(atrPctRaw) && atrPctRaw > 0 ? atrPctRaw / 100 : 0.0035;
    const atrDollar = s * atrPct;
    // 1-minute noise scale (1-min ATR ~= horizon ATR / sqrt(15))
    const atr1m = atrDollar / Math.sqrt(15);
    const pinNoiseThreshold = Math.max(s * 0.0008, 0.5 * atr1m); // ~8 bps or 0.5σ 1m ATR

    const distance = Math.abs(s - p);
    const distanceBps = (distance / p) * 10000;
    const inLateWindow = Number.isFinite(ttc) && ttc > 0 && ttc <= 90;
    const inExtremeLateWindow = Number.isFinite(ttc) && ttc > 0 && ttc <= 45;

    // Pin Risk: in the final 90 seconds and distance to strike is within the noise margin
    const isDefendedPinZone = inLateWindow && distance <= pinNoiseThreshold;
    let pinRiskScore = 0;
    if (isDefendedPinZone) {
      const distRatio = Math.max(0, 1 - (distance / pinNoiseThreshold));
      const timeRatio = Math.max(0, 1 - (ttc / 90));
      pinRiskScore = Math.round((distRatio * 0.6 + timeRatio * 0.4) * 100);
    }

    let warning = null;
    if (isDefendedPinZone) {
      warning = inExtremeLateWindow
        ? `CRITICAL PIN RISK (${pinRiskScore}%): Spot within $${distance.toFixed(1)} (${distanceBps.toFixed(1)} bps) of PTB with ${Math.round(ttc)}s left. MM defense wall active; high probability of 1-2s post-expiry snap. Refusing late directional entry; pivot to T+1.`
        : `PIN RISK DEFENDED (${pinRiskScore}%): Spot within 0.5σ noise margin of PTB. MM strike defense detected; do not chase wire. Pivot focus to T+1 future window.`;
    }

    return {
      sym,
      spot: s,
      ptb: p,
      secondsToClose: ttc,
      distance: parseFloat(distance.toFixed(coinPriceDecimals(sym))),
      distanceBps: parseFloat(distanceBps.toFixed(2)),
      pinNoiseThreshold: parseFloat(pinNoiseThreshold.toFixed(2)),
      isDefendedPinZone,
      pinRiskScore,
      warning,
      recommendedAction: isDefendedPinZone ? 'HOLD_FLAT_ROLL_T1' : 'PROCEED',
    };
  }

  /**
   * Computes the Range & Strike Viability Ladder for a coin and horizon.
   * Classifies strike brackets around current spot into CLEAN_TARGET, CONTESTED_FRICTION, and PIN_TRAP_DANGER.
   */
  function computeRangeViability(coin, horizonMin = 15, currentPtb = null, ttcSec = null) {
    const sym = coin.sym || coin;
    const cache = candleCache[sym] || {};
    const lastPred = cache._lastPrediction || (typeof window !== 'undefined' && window._predictions?.[sym]) || null;
    const s = Number(lastPred?.price || lastPred?.currentPrice || cache.ticker?.usd || cache.candles?.[cache.candles.length - 1]?.c || 0);
    if (!Number.isFinite(s) || s <= 0) return null;

    const atrPctRaw = Number(lastPred?.volatility?.atrPct);
    const atrPct = Number.isFinite(atrPctRaw) && atrPctRaw > 0 ? atrPctRaw / 100 : 0.0035;
    const horizonSec = horizonMin * 60;
    const effectiveTtc = (ttcSec != null && Number.isFinite(Number(ttcSec))) ? Math.max(10, Number(ttcSec)) : horizonSec;
    const timeDecayFactor = Math.sqrt(Math.max(0.05, effectiveTtc / horizonSec));

    // Dynamic horizon sigma
    const sigmaHorizon = Math.max(s * 0.001, s * atrPct * timeDecayFactor);
    const safeBoundUpper = s + (1.65 * sigmaHorizon);
    const safeBoundLower = s - (1.65 * sigmaHorizon);

    // Multi-strike brackets around spot (-1.5σ, -0.75σ, Active PTB or Spot, +0.75σ, +1.5σ)
    const activePtb = Number(currentPtb) > 0 ? Number(currentPtb) : s;
    const baseDistance = Math.abs(s - activePtb);
    const baseSigmaDist = baseDistance / (sigmaHorizon || 1);

    const strikes = [
      { name: 'Lower Clean Put / Down', strike: s - (1.5 * sigmaHorizon), type: 'BELOW' },
      { name: 'Lower Contested Strike', strike: s - (0.75 * sigmaHorizon), type: 'BELOW' },
      { name: 'At-The-Money / Active PTB', strike: activePtb, type: 'ATM' },
      { name: 'Upper Contested Strike', strike: s + (0.75 * sigmaHorizon), type: 'ABOVE' },
      { name: 'Upper Clean Call / Up', strike: s + (1.5 * sigmaHorizon), type: 'ABOVE' },
    ];

    const rankedStrikes = strikes.map((stk) => {
      const dist = Math.abs(s - stk.strike);
      const distBps = (dist / s) * 10000;
      const sigmaDist = dist / (sigmaHorizon || 1);

      let viabilityZone = 'CONTESTED_FRICTION';
      let tag = '🟡 Contested';
      let recommendation = 'NEUTRAL';

      if (effectiveTtc <= 90 && sigmaDist <= 0.5) {
        viabilityZone = 'PIN_TRAP_DANGER';
        tag = '🔴 Pin Trap Danger';
        recommendation = 'AVOID_PIN_TRAP';
      } else if (sigmaDist >= 1.25 && effectiveTtc > 120) {
        viabilityZone = 'CLEAN_TARGET';
        tag = '🟢 Prime Target';
        recommendation = 'RECOMMENDED';
      } else if (sigmaDist < 0.6) {
        viabilityZone = effectiveTtc <= 120 ? 'PIN_TRAP_DANGER' : 'CONTESTED_FRICTION';
        tag = effectiveTtc <= 120 ? '🔴 Pin Danger' : '🟡 Narrow ATM';
        recommendation = effectiveTtc <= 120 ? 'AVOID_PIN_TRAP' : 'MONITOR_RUNWAY';
      }

      return {
        ...stk,
        strike: parseFloat(stk.strike.toFixed(coinPriceDecimals(sym))),
        distanceDollar: parseFloat(dist.toFixed(2)),
        distanceBps: parseFloat(distBps.toFixed(1)),
        sigmaDist: parseFloat(sigmaDist.toFixed(2)),
        viabilityZone,
        tag,
        recommendation,
      };
    });

    const bestTarget = rankedStrikes.find((r) => r.viabilityZone === 'CLEAN_TARGET') || rankedStrikes[0];

    return {
      sym,
      horizonMin,
      spot: s,
      sigmaHorizon: parseFloat(sigmaHorizon.toFixed(2)),
      expectedMoveDollar: parseFloat((1.65 * sigmaHorizon).toFixed(2)),
      safeBoundLower: parseFloat(safeBoundLower.toFixed(2)),
      safeBoundUpper: parseFloat(safeBoundUpper.toFixed(2)),
      effectiveTtc,
      activePtbDeltaBps: parseFloat(((s - activePtb) / activePtb * 10000).toFixed(1)),
      activePtbSigmaDist: parseFloat(baseSigmaDist.toFixed(2)),
      strikes: rankedStrikes,
      bestTarget,
    };
  }

  function computePrediction(coin, backtest = null) {
    const computedTs = Date.now();
    const cache = candleCache[coin.sym];
    if (!cache) return { error: 'Insufficient data' };
    const resolvedBacktest = backtest || window._backtests?.[coin.sym] || null;
    let candles15m = cache.candles15m || [];
    // Prefer pre-pooled multi-source 15m (CB + BIN + WS + others via anchoredPoolCandles).
    // Only fall back to bucketing the 5m pooled candles if the dedicated 15m series is really empty.
    // This ensures 15m markets actually use the pooled data from multiple exchanges/WS.
    if ((!candles15m || candles15m.length < 4) && cache.candles && cache.candles.length >= 8) {
      const fallback = bucketCandles(cache.candles, 15 * 60 * 1000);
      if (fallback.length > candles15m.length) {
        candles15m = fallback;
        cache.candles15m = candles15m;
      }
    }
    console.log(`[15mPool SNAPSHOT] ${coin.sym} using candles15m len=${candles15m.length} (from cache ${cache.candles15m?.length || 0}), 5m=${cache.candles?.length}, debug=${JSON.stringify(cache._15m || {})}`);

    if (candles15m.length < 4) {
      console.warn(`[15mPool] ${coin.sym} 15m bars <4 after pooling (ws:${(window.CandleWS ? window.CandleWS.getClosedBuckets15m(coin.sym) : []).length}, cb:${cache._cb15m?.length||0}, bin:${cache._bin15m?.length||0}). Using 5m fallback or partial. Check exchange-ws errors and proxy.`);
      const earlyRel = resolvedBacktest?.summary?.reliability ?? 0.50;
      return {
        sym: coin.sym, name: coin.name, color: coin.color, icon: coin.icon,
        price: cache?.ticker?.usd || window._predictions?.[coin.sym]?.price || 0,
        signal: 'neutral', confidence: 15, score: 0,
        ts: computedTs, timestamp: computedTs,
        source: `partial (15m pooled ${candles15m.length} bars from exchanges)`, candleCount: cache?.candles?.length || 0, candleCount1m: cache?.candles1m?.length || 0, candleCount15m: candles15m.length, updatedAt: '–',
        _15mPoolingDebug: {
          ws: window.CandleWS ? (window.CandleWS.getClosedBuckets15m(coin.sym) || []).length : 0,
          cb: cache?._cb15m?.length || 0,
          bin: cache?._bin15m?.length || 0,
          pooled: candles15m.length,
          fallbackUsed: true
        },
        error: 'Insufficient 15m data (pooled from exchanges)',
        indicators: {},
        diagnostics: {
          reliability: earlyRel,
          qualityLabel: resolvedBacktest ? summarizeReliabilityLabel(earlyRel) : 'Backtest unavailable',
          tradeFitLabel: resolvedBacktest?.summary?.tradeFitLabel || 'Timing mixed',
        },
        volatility: { label: 'Unknown', atrPct: 0 },
        projections: {}, reversalFlags: [], scalpSetups: [],
        backtest: resolvedBacktest,
      };
    }

    // ★★★ REVERT: Using 15m candles caused massive lag (indicators spanning 3.5 hours).
    // Reverting to 5-min data (cache.candles) so predictions react fast enough for 15m markets.
    const effectiveBook = resolveFreshOrderBook(coin.sym, cache.book);
    const effectiveCache = { ...cache, book: effectiveBook || cache.book };
    const liveBookAgeMs = effectiveBook?.timestamp ? Math.max(0, Date.now() - effectiveBook.timestamp) : null;
    const baseModel = buildSignalModel(cache.candles, effectiveBook || cache.book, cache.trades, {
      includeMicrostructure: true,
      includeSetups: true,
      sym: coin.sym,
      candles1m: cache.candles1m || null,  // PATCH1.11: wall absorption needs 1m data
      horizon: 15,  // ★ H15 TUNING: Apply h15-specific indicator weights (2026-05-06)
    });
    const calibrated = applyLiveCalibration(baseModel, resolvedBacktest);
    const fastTiming = buildFastTimingModel(cache.candles1m, coin.sym);
    const timed = applyFastTimingOverlay(calibrated, fastTiming);
    const routerContext = buildSignalRouterContext(coin, timed, fastTiming, resolvedBacktest, effectiveCache);
    const routedPackets = filterSignalPackets(buildSignalPackets(routerContext), routerContext);
    const routed = summarizeRoutedSignals(routedPackets, routerContext);
    logLiveExecutionCues(coin.sym, routed, routedPackets);

    // ── CFM Floating Router ─────────────────────────────────────────
    // Base score from existing packet router (unchanged path)
    // ALWAYS_TRADE: never zero-out on invalidated/stand-aside — keep directional lean.
    const always = !!ALWAYS_TRADE_MODE;
    const baseScore = (routed.action === 'invalidated' && !always)
      ? 0
      : routed.action === 'stand-aside'
        ? timed.score * (always ? 0.85 : 0.45)
        : clamp(timed.score * Math.max(routed.confidenceMultiplier || 1, always ? 0.85 : 0), -1, 1);
    const baseConf = Math.round(clamp(timed.confidence * Math.max(routed.confidenceMultiplier || 1, always ? 0.85 : 0), 0, 95));

    // Enrich with: CFM anchor packets + outcome calibration + singularity resolver
    const cfmEnrich = window.CFMRouter?.enrich(
      coin.sym, routerContext, routedPackets, routed, baseScore, baseConf, routerContext.quantRegime
    ) || null;

    let normalizedScore = cfmEnrich?.finalScore ?? baseScore;
    let normalizedConfidence = cfmEnrich?.finalConf ?? baseConf;
    let resolvedRouterAction = cfmEnrich?.resolvedAction ?? routed.action;
    // Force tradeable action unless truly invalid and not in always-trade mode
    if (always && (resolvedRouterAction === 'stand-aside' || resolvedRouterAction === 'watch' || resolvedRouterAction === 'invalidated')) {
      resolvedRouterAction = 'trade';
    }
    const executionGuard = buildExecutionGuard(timed, effectiveCache);
    if (executionGuard?.blocked && resolvedRouterAction !== 'invalidated' && !always) {
      resolvedRouterAction = 'stand-aside';
      normalizedScore = clamp(normalizedScore * 0.45, -1, 1);
      normalizedConfidence = Math.round(clamp(normalizedConfidence * 0.62, 0, 95));
    }
    const liveTimingGuard = buildLiveTimingGuard(coin, effectiveCache, normalizedScore, fastTiming);
    if (liveTimingGuard?.conflict && resolvedRouterAction !== 'invalidated') {
      if (!always && (liveTimingGuard.hard || resolvedRouterAction === 'trade')) {
        resolvedRouterAction = 'stand-aside';
      }
      // ALWAYS_TRADE: dampen only, never stand-aside on tape conflict
      const mult = always ? Math.max(0.55, liveTimingGuard.scoreMultiplier || 1) : liveTimingGuard.scoreMultiplier;
      normalizedScore = clamp(normalizedScore * mult, -1, 1);
      normalizedConfidence = Math.round(clamp(normalizedConfidence * (always ? 0.85 : liveTimingGuard.confidenceMultiplier), 0, 95));
    }
    // ALWAYS_TRADE: if score is essentially flat, lean with live tape / PTB / last non-zero core
    if (always && Math.abs(normalizedScore) < 0.04) {
      const liveDir = liveTimingGuard?.liveDir || 0;
      const core = Number(timed.diagnostics?.coreScore ?? timed.score ?? 0);
      const lean = liveDir !== 0 ? liveDir * 0.12 : (core !== 0 ? Math.sign(core) * 0.10 : 0.08);
      normalizedScore = lean;
      normalizedConfidence = Math.max(normalizedConfidence, 35);
      resolvedRouterAction = 'trade';
    }

    // ── 5m/15m PTB settlement anchor ───────────────────────────────────────
    // Polymarket pays UP iff final >= price-to-beat. Free-form momentum often
    // lags after multi-green candles and keeps calling UP into a PTB fail.
    // Re-score vs live PTB + short drift so "flip UP" cannot fire against tape.
    let ptbAnchor = null;
    try {
      const rtdsLive = window.PredictionMarkets?.getFreshRtdsTwap?.(coin.sym, 15_000);
      const twapPx = rtdsLive?.price ?? window.Microstructure?.getTwap?.(coin.sym, 30_000);
      const livePx = Number(twapPx || timed.price || 0);

      const pmCoin = window.PredictionMarkets?.getCoin?.(coin.sym);
      const p5m = pmCoin?.poly5m || pmCoin?.poly15m || pmCoin?.poly;
      let ptb = Number(p5m?.targetPriceNum ?? p5m?.priceToBeatNum);
      if (!Number.isFinite(ptb) || ptb <= 0) {
        ptb = Number(p5m?.openPrice ?? p5m?.cryptoMarketConfig?.initialPrice);
      }
      if (!Number.isFinite(ptb) || ptb <= 0) {
        const candleSeries = candleCache[coin.sym]?.candles;
        if (candleSeries && candleSeries.length > 0) {
          ptb = Number(candleSeries[candleSeries.length - 1].o);
        }
      }
      if (!Number.isFinite(ptb) || ptb <= 0) {
        ptb = Number(livePx);
      }

      if (Number.isFinite(ptb) && ptb > 0 && Number.isFinite(livePx) && livePx > 0) {
        const closeTimeMs = p5m?.closeTime ? new Date(p5m.closeTime).getTime() : null;
        const remainingMs = Number.isFinite(closeTimeMs) ? Math.max(0, closeTimeMs - Date.now()) : 5 * 60_000;
        const remainingFrac = clamp(remainingMs / (5 * 60_000), 0.08, 1);
        const atrPctRaw = Number(timed.volatility?.atrPct);
        const atrPct = (Number.isFinite(atrPctRaw) && atrPctRaw > 0) ? (atrPctRaw / 100) : 0.0035;
        const atrDollar = livePx * atrPct;
        const expectedMove = normalizedScore * atrDollar * 0.40 * remainingFrac;
        const gap = livePx - ptb;
        const gapFrac = gap / ptb;
        const liveDir = liveTimingGuard?.liveDir || (gap >= 0 ? (liveTimingGuard?.drift1mPct > 0 ? 1 : 0) : (liveTimingGuard?.drift1mPct < 0 ? -1 : 0));

        let effectiveExpectedMove = expectedMove;
        if (gap < 0 && effectiveExpectedMove > 0 && liveDir <= 0) {
          // If currently below PTB and tape is not driving upward, expected move cannot cross PTB
          effectiveExpectedMove = Math.min(effectiveExpectedMove, Math.abs(gap) * 0.2);
        } else if (gap > 0 && effectiveExpectedMove < 0 && liveDir >= 0) {
          effectiveExpectedMove = Math.max(effectiveExpectedMove, -Math.abs(gap) * 0.2);
        }

        const liveDrift1m = livePx * (Number(liveTimingGuard?.drift1mPct) || 0) / 100;
        const meanFinal = livePx + effectiveExpectedMove + liveDrift1m;
        const sigma = Math.max(livePx * 0.0015, atrDollar * Math.sqrt(remainingFrac));
        const z = (meanFinal - ptb) / (sigma || 1);
        let pUp = normalCDF(z);

        // Strict State Anchor:
        // If price is BELOW PTB and not actively breaking up, pUp MUST NOT be >= 50%
        if (gap < 0 && liveDir <= 0 && pUp > 0.45) {
          pUp = Math.min(pUp, 0.40);
        }
        // Late window: being below PTB is DOWN even if lagging tape still prints "buy".
        if (remainingFrac < 0.22 && gap < 0) {
          pUp = Math.min(pUp, 0.16);
        }
        if (remainingMs < 45_000 && gap < 0) {
          pUp = Math.min(pUp, 0.07);
        }
        // If price is ABOVE PTB and not actively breaking down, pUp MUST NOT be <= 50%
        if (gap > 0 && liveDir >= 0 && pUp < 0.55) {
          pUp = Math.max(pUp, 0.60);
        }

        const modelYesPct = Math.round(pUp * 100);
        // Map P(UP) → score in [-1,1]; 50% → 0
        const ptbScore = clamp((pUp - 0.5) * 2.0, -1, 1);
        // Hard veto: don't "flip UP" when already below/at PTB without live up-tape.
        // Lagging bull composites after multi-green runs are completely eliminated.
        const falseUp = (normalizedScore > 0.02 || ptbScore < 0) && (
          (gapFrac < 0 && liveDir <= 0) ||
          (gapFrac < 0 && remainingFrac < 0.25) ||
          (gapFrac < 0.00020 && liveDir < 0 && remainingFrac < 0.60) ||
          (gapFrac < 0 && modelYesPct < 55) ||
          (modelYesPct <= 45 && liveDir <= 0)
        );
        // Hard veto: don't "flip DOWN" when firmly above PTB with upward tape
        const falseDown = (normalizedScore < -0.02 || ptbScore > 0) && (
          (gapFrac > 0.00035 && liveDir >= 0 && remainingFrac < 0.45) ||
          (modelYesPct >= 58 && liveDir > 0)
        );
        const blend = remainingFrac < 0.35 ? 0.72 : remainingFrac < 0.65 ? 0.55 : 0.40;
        const before = normalizedScore;
        if (falseUp) {
          // Hard veto: force firmly negative on downward divergence below PTB
          normalizedScore = clamp(Math.min(-0.16, ptbScore < 0 ? ptbScore : -0.16), -1, -0.06);
          normalizedConfidence = Math.round(clamp(normalizedConfidence * 0.70, 45, 95));
          resolvedRouterAction = always ? 'trade' : 'stand-aside';
        } else if (falseDown) {
          // Hard veto: force firmly positive on upward divergence above PTB
          normalizedScore = clamp(Math.max(0.16, ptbScore > 0 ? ptbScore : 0.16), 0.06, 1);
          normalizedConfidence = Math.round(clamp(normalizedConfidence * 0.70, 45, 95));
          resolvedRouterAction = always ? 'trade' : 'stand-aside';
        } else {
          normalizedScore = clamp(normalizedScore * (1 - blend) + ptbScore * blend, -1, 1);
          // Strict clamp: if price is below PTB with down drift, score MUST NOT be positive
          if (gap < 0 && liveDir <= 0 && normalizedScore > 0) {
            normalizedScore = clamp(Math.min(-0.16, ptbScore), -1, -0.06);
          } else if (gap > 0 && liveDir >= 0 && normalizedScore < 0) {
            normalizedScore = clamp(Math.max(0.16, ptbScore), 0.06, 1);
          } else if (always && Math.abs(normalizedScore) < 0.04) {
            normalizedScore = Math.sign(ptbScore || normalizedScore || 1) * 0.08;
          }
          if (always) resolvedRouterAction = 'trade';
        }
        // Refresh polyAlign on the result projections for UI/odds
        ptbAnchor = {
          ptb, livePx, meanFinal, modelYesPct, pUp, gapFrac, remainingFrac,
          before, after: normalizedScore, falseUp, falseDown, liveDir,
        };
        if (timed.projections?.p5) {
          timed.projections.p5.target = meanFinal;
          timed.projections.p5.polyAlign = {
            ...(timed.projections.p5.polyAlign || {}),
            ref: ptb,
            gapPct: ((ptb - livePx) / livePx) * 100,
            modelYesPct,
            cdfImpliedDir: modelYesPct >= 50 ? 'UP' : 'DOWN',
            remainingMs,
            remainingFrac,
            meanFinal,
            dirConflict: Math.sign(before) !== 0 && Math.sign(before) !== Math.sign(ptbScore),
            status: 'ptb-anchored',
          };
        }
      }
    } catch (ptbErr) {
      console.warn('[PTB-Anchor] 5m re-score failed:', ptbErr?.message || ptbErr);
    }

    let normalizedSignal = resolvedRouterAction === 'invalidated'
      ? 'neutral'
      : signalFromScore(normalizedScore);

    // ── Quantum Flow Tensor (QFT) System Overlay ───────────────────────
    let qftResult = null;
    if (typeof window !== 'undefined' && window.QuantumFlowTensor) {
      qftResult = window.QuantumFlowTensor.run(coin.sym, { direction: normalizedSignal, score: normalizedScore }, effectiveBook);
      if (qftResult && qftResult.active) {
        if (qftResult.qftDirection === 'wait' && always) {
          // ALWAYS_TRADE: ignore QFT wait — keep lean
        } else {
          normalizedSignal = qftResult.qftDirection;
          normalizedScore = clamp(normalizedScore * qftResult.qftScoreModifier, -1, 1);
          if (qftResult.qftDirection === 'wait') {
            resolvedRouterAction = 'stand-aside';
          }
        }
      }
    }

    // Hyper-short anchors: temporal fusion + BTC spillover graph + narrative velocity
    let hyperShortDiag = null;
    if (window.TemporalFusionLite || window.MultiAssetGraph || window.NarrativeVelocity) {
      try {
        const anchorOut = buildHyperShortAnchors(coin, {
          score: normalizedScore,
          confidence: normalizedConfidence,
          price: liveTimingGuard?.livePrice || timed.price,
          fastTiming,
          msToClose: executionGuard?.msToClose,
          atrPct: timed.volatility?.atrPct ?? 0,
          volatility: timed.volatility,
        });
        hyperShortDiag = anchorOut.diagnostics;
        normalizedScore = anchorOut.score;
        normalizedConfidence = anchorOut.confidence;
        normalizedSignal = resolvedRouterAction === 'invalidated'
          ? 'neutral'
          : signalFromScore(normalizedScore);
      } catch (anchorErr) {
        console.warn('[HyperShortAnchors] fusion failed:', anchorErr?.message || anchorErr);
      }
    }

    const result = {
      sym: coin.sym,
      name: coin.name,
      color: coin.color,
      icon: coin.icon,
      price: liveTimingGuard?.livePrice || timed.price,
      signal: normalizedSignal,
      score: normalizedScore,
      rawScore: timed.rawScore,
      confidence: normalizedConfidence,
      indicators: timed.indicators,
      projections: timed.projections,
      volatility: timed.volatility,
      session: timed.session,
      scalpSetups: timed.scalpSetups,
      diagnostics: {
        ...timed.diagnostics,
        orbitalStates: timed.orbitalStates,
        components: timed.components,
        routedAction: resolvedRouterAction,
        routedBias: routed.bias,
        directionalConflict: routed.directionalConflict,
        routedRiskScore: routed.riskScore,
        routedRiskFlags: routed.riskFlags,
        routedPackets,
        routedSummary: routed.summaryText,
        quantRegime: routerContext.quantRegime,
        executionGuard,
        liveTimingGuard,
        ptbAnchor,
        liveBook: effectiveBook ? {
          source: effectiveBook.source || null,
          ageMs: liveBookAgeMs,
          imbalance: timed.indicators?.book?.imbalance ?? null,
          weightedImbalance: timed.indicators?.orderBookImbalance?.meta?.rawImbalance ?? null,
          imbalanceVelocity: timed.indicators?.imbalanceVelocity?.meta?.value ?? null,
          liquidityBand: timed.indicators?.liquidityDepth?.meta?.band ?? null,
          liquidityNotional20: timed.indicators?.liquidityDepth?.meta?.notional20 ?? null,
          label: timed.indicators?.book?.label ?? null,
        } : null,
        // CFM floating router diagnostics
        cfmPackets: cfmEnrich?.cfmPackets || [],
        cfmCalibration: cfmEnrich?.calibration || null,
        cfmRegimeGate: cfmEnrich?.regimeGate || null,
        cfmAnchor: cfmEnrich?.anchor || 0,
        cfmOverride: cfmEnrich?.cfmOverride || false,
        cfmOverrideReason: cfmEnrich?.overrideReason || null,
        cfmEarlyExit: cfmEnrich?.earlyExit || null,
        // QFT Proprietary System
        hyperShortAnchors: hyperShortDiag,
        qft: qftResult,
      },
      backtest: resolvedBacktest,
      preOpenForecast: {
        h5: computePreOpenHorizonForecast(coin, 5),
        h15: computePreOpenHorizonForecast(coin, 15),
      },
      // --- Derivatives: funding, OI, squeeze ---
      derivatives: derivCache[coin.sym] || null,
      squeeze: detectSqueeze(coin.sym),
      // --- CVD ---
      cvd: calcCVD(cache.trades),
      ts: computedTs,
      timestamp: computedTs,
      source: cache.candles1m?.length
        ? `${cache.source}${effectiveBook?.source === 'orderbook-ws' ? ' + live book' : ''} + pooled 1m${cache.candles15m?.length ? ' + pooled 15m' : ''}`
        : `${cache.source}${effectiveBook?.source === 'orderbook-ws' ? ' + live book' : ''}${cache.candles15m?.length ? ' + pooled 15m' : ''} (15m from exchanges)`,
      updatedAt: new Date().toLocaleTimeString(),
      candleCount: cache.candles.length,
      candleCount1m: cache.candles1m?.length || 0,
      candleCount15m: cache.candles15m?.length || 0,
      _15mPoolingDebug: {
        ws: window.CandleWS ? (window.CandleWS.getClosedBuckets15m(coin.sym) || []).length : 0,
        cb: cache._cb15m?.length || 0,
        bin: cache._bin15m?.length || 0,
        gecko: cache._gecko15m?.length || 0,
        pooled: cache.candles15m?.length || 0,
        sourceInCache: cache.source || 'n/a'
      },
      _15mPoolingDebug: {
        ws: window.CandleWS ? (window.CandleWS.getClosedBuckets15m(coin.sym) || []).length : 0,
        cb: cache._cb15m?.length || 0,
        bin: cache._bin15m?.length || 0,
        gecko: cache._gecko15m?.length || 0,
        pooled: cache.candles15m?.length || 0,
        sourceInCache: cache.source || 'n/a'
      },
    };

    // ★ REGIME CLASSIFICATION — Statistical analysis for adaptive thresholds
    // Classifies market regime using Hurst exponent, Variance Ratio, and Permutation Entropy
    let regime = null;
    if (window.RegimeClassifier && cache.candles && cache.candles.length >= 65) {
      try {
        const closes = cache.candles.map(c => c.close);
        const ohlc = cache.candles;
        regime = window.RegimeClassifier.classifyRegime(closes, ohlc);
        if (regime) {
          predictionDebugLog(`regime:${coin.sym}`, 'log', () => `[predictions] ${coin.sym} regime: ${regime.regime_state} (H=${regime.h_exponent.toFixed(2)}, VR=${regime.variance_ratio.toFixed(2)}, Ent=${regime.entropy_score.toFixed(2)}, conf=${regime.confidence})`, 30000);
        }
      } catch (err) {
        console.warn(`[predictions] Regime classification error for ${coin.sym}:`, err.message);
      }
    }

    // PATCH1.10: attach signal quality gate (regime-adaptive)
    result.gate = evaluateSignalGate(result, coin.sym, regime);
    result.diagnostics = {
      ...(result.diagnostics || {}),
      signalGate: {
        passed: !!result.gate?.passed,
        gated: !!result.gate?.gated,
        quality: result.gate?.quality || null,
        label: result.gate?.label || null,
        reasons: Array.isArray(result.gate?.reasons) ? result.gate.reasons.slice(0, 6) : [],
      },
    };

    // PATCH (orbital): WECRYPTO cross-chain orbital engine — additive diagnostics.
    // Never veto; contributes OEQ + s/p/d/f + counter-trade intent for the card layer.
    try {
      const orbitalApi = window.OrbitalEngine;
      if (orbitalApi && typeof orbitalApi.isEnabled === 'function' && orbitalApi.isEnabled()) {
        const orbital = orbitalApi.processInterval(coin.sym, cache.candles15m);
        if (orbital) {
          result.orbital = orbital;
          result.diagnostics.orbital = orbital;
          // Stream classified payload → Firebase/TIDE (non-blocking, rate-limited).
          if (window._orbitalBroadcaster && typeof window._orbitalBroadcaster.push === 'function') {
            window._orbitalBroadcaster.push(orbital);
          }
        }
      }
    } catch (orbitalErr) {
      console.warn('[predictions] orbital engine error for', coin.sym, orbitalErr && orbitalErr.message);
    }

    // PATCH6: Attach entry delay based on volatility
    if (window._adaptiveTuner) {
      const entryDelayInfo = window._adaptiveTuner.getEntryDelay(coin.sym);
      result.entryDelay = entryDelayInfo.delayCandles;
      result.entryDelayReason = entryDelayInfo.reason;
      result.entryDelayVolatility = entryDelayInfo.volatilityReason;
    }

    // PATCH7: Integrate wallet intel (holder metrics) — use cached data synchronously
    if (window.HolderMetrics) {
      try {
        const cachedMetrics = window.HolderMetrics._cachedMetrics?.[coin.sym];
        if (cachedMetrics && Date.now() - cachedMetrics.ts < 120_000) {
          // Use fresh cache (within 2 min)
          const holderScore = window.HolderMetrics.score(cachedMetrics);
          const holderWeight = 0.10; // 10% weight
          result.scoreAdjusted = result.score + (holderScore * holderWeight);
          result.holderMetrics = {
            concentration: cachedMetrics.concentration,
            source: cachedMetrics.source,
            holderCount: cachedMetrics.holderCount,
            holderScoreContribution: holderScore * holderWeight,
          };
        }
      } catch (e) {
        // Silently fail if metrics unavailable
      }
    }

    // RL stack overlay — mispricing hunt + contrarian plays (after polyAlign available)
    if (window.TradingRLAgent?.applyToScore) {
      try {
        const polyAlign = result.projections?.p15?.polyAlign ?? null;
        const probVel = window.PredictionMarkets?.getProbVelocity?.(coin.sym);
        const rlCtx = {
          signalVector: result.diagnostics?.components || timed.components || {},
          score: result.score,
          agreement: result.diagnostics?.agreement ?? 0.5,
          conflict: result.diagnostics?.conflict ?? 0,
          tapeVelocity: result.diagnostics?.tapeVelocity || timed.diagnostics?.tapeVelocity,
          probVelocity: probVel?.trend ?? probVel?.velocity ?? probVel ?? 0,
          atrPct: result.volatility?.atrPct ?? 0,
          polyAlign,
          imbalanceVelocity: result.diagnostics?.liveBook?.imbalanceVelocity ?? 0,
          liveBook: result.diagnostics?.liveBook ?? null,
          spreadPct: effectiveBook?.spreadPct ?? timed.indicators?.book?.spreadPct ?? 0,
          toxicity: timed.indicators?.toxicity?.meta?.score ?? timed.diagnostics?.toxicity ?? 0,
        };
        const rlOut = window.TradingRLAgent.applyToScore(result.score, rlCtx);
        if (rlOut?.decision && rlOut.decision.action !== 'pass') {
          result.score = rlOut.score;
          result.signal = signalFromScore(result.score);
          result.diagnostics = {
            ...(result.diagnostics || {}),
            rlStack: {
              action: rlOut.decision.action,
              confidence: rlOut.decision.confidence,
              rapidMove: rlOut.decision.rapidMove,
              reason: rlOut.reason,
              pathway: rlOut.decision.pathway || null,
              pathways: rlOut.decision.pathways || [],
              mispricing: rlOut.decision.mispricing || null,
              rlActionId: rlOut.decision.actionId,
              sniperDecision: rlOut.decision.sniperDecision || null,
            },
          };
          if (rlOut.decision.mispricing?.huntScore > 0) {
            result.mispricing = rlOut.decision.mispricing;
          }

          // --- Live Telegram alerts for sniper actions ---
          try {
            window._lastSniperAlert = window._lastSniperAlert || {};
            const lastAlert = window._lastSniperAlert[coin.sym] || {};
            const now = Date.now();
            const sniperDec = rlOut.decision.sniperDecision;
            const currentAction = sniperDec?.action || 'SCOUT_WAIT';
            const isHurdleGated = rlOut.reason && rlOut.reason.includes('ev_below_hurdle');

            let shouldAlert = false;
            let alertType = null;

            if (currentAction === 'EXECUTE_STRIKE') {
              if (lastAlert.action !== 'EXECUTE_STRIKE' || (now - (lastAlert.ts || 0)) > 180_000) {
                shouldAlert = true;
                alertType = 'STRIKE';
              }
            } else if (isHurdleGated) {
              if (lastAlert.action !== 'GATE' || (now - (lastAlert.ts || 0)) > 300_000) {
                shouldAlert = true;
                alertType = 'GATE';
              }
            }

            if (shouldAlert && window.electron?.telegram?.sendMessage) {
              window._lastSniperAlert[coin.sym] = {
                action: alertType === 'STRIKE' ? 'EXECUTE_STRIKE' : 'GATE',
                ts: now
              };

              let alertText = '';
              const tteMinutes = polyAlign?.closeTimeMs
                ? ((polyAlign.closeTimeMs - now) / 60000).toFixed(1)
                : '15.0';

              if (alertType === 'STRIKE') {
                const evPct = ((sniperDec.ev || 0) * 100).toFixed(1);
                const hurdlePct = ((sniperDec.hurdle || 0) * 100).toFixed(1);
                alertText = `🎯 <b>[SNIPER EXECUTE STRIKE]</b> <b>${coin.sym}</b>\n` +
                  `Action: 🟢 <b>EXECUTE STRIKE</b>\n` +
                  `Direction: <b>${rlOut.decision.action}</b>\n` +
                  `Market Price: <code>${(sniperDec.p_market || 0.5).toFixed(2)}</code>\n` +
                  `Model probability: <code>${Math.round(polyAlign?.modelYesPct || 50)}%</code>\n` +
                  `Expected Value: <code>+${evPct}%</code> (Hurdle: <code>+${hurdlePct}%</code>)\n` +
                  `Time to Expiry: <code>${tteMinutes}m</code> remaining\n` +
                  `Spot Volatility: <code>${(rlCtx.spotVolatility || 0.05).toFixed(2)}</code>`;
              } else if (alertType === 'GATE') {
                alertText = `🛡️ <b>[SNIPER GATE ACTIVE]</b> <b>${coin.sym}</b>\n` +
                  `Action: 🛑 <b>SCOUT WAIT (Gated)</b>\n` +
                  `Blended Intent: <b>${rlOut.decision.action === 'WAIT' ? (rlCtx.score >= 0 ? 'UP' : 'DOWN') : rlOut.decision.action}</b>\n` +
                  `Reason: <code>Expected Value below Volatility Hurdle</code>\n` +
                  `Details: <code>${rlOut.reason}</code>\n` +
                  `Time to Expiry: <code>${tteMinutes}m</code> remaining`;
              }

              window.electron.telegram.sendMessage(null, alertText, 'html').catch(err => {
                console.warn('[Telegram Alert] Send failed:', err.message);
              });
            }
          } catch (tgAlertErr) {
            console.warn('[Telegram Alert] Evaluation error:', tgAlertErr.message);
          }
        }
      } catch (rlErr) {
        console.warn('[TradingRLAgent] applyToScore failed:', rlErr?.message || rlErr);
      }
    }

    return result;
  }

  // ================================================================
  // DERIVATIVES DATA (funding rates, OI, squeeze detection)
  // ================================================================

  let derivCache = {}; // sym → { funding, oi, basis, exchange, timestamp }
  let derivAge = 0;

  async function fetchDerivatives() {
    if (Date.now() - derivAge < 120000) return; // cache 2 min (CoinGecko rate limit)

    // ★ Primary: live DerivativesFeed — real OI delta, liquidation stream, and
    // OI-weighted cross-venue funding. Richer + fresher than CoinGecko /derivatives.
    try {
      const live = (typeof window !== 'undefined' && window.DerivativesFeed?.getAll)
        ? window.DerivativesFeed.getAll() : null;
      if (live) {
        Object.entries(live).forEach(([sym, s]) => {
          if (!s || !s.available) return;
          const liq = s.liquidations || {};
          derivCache[sym] = {
            funding: Number.isFinite(s.funding) ? s.funding : 0,
            fundingVelocity: s.fundingVelocity ?? null,
            oi: s.oiUsd ?? 0,
            oiDeltaPct: s.oiDeltaPct ?? null,
            oiTrend: s.oiTrend || 'flat',
            basis: s.basisPct ?? 0,
            liqImbalance: liq.imbalance ?? 0,
            liqTotalUsd: liq.totalUsd ?? 0,
            liqLongUsd: liq.longLiqUsd ?? 0,
            liqShortUsd: liq.shortLiqUsd ?? 0,
            pressure: s.pressure ?? 0,
            label: s.label || '',
            exchange: (s.venues || []).join('+') || 'perps',
            source: 'derivatives-feed',
            ts: s.ts || Date.now(),
          };
        });
      }
    } catch (e) {
      console.warn('[Derivatives] live feed merge failed:', e.message);
    }

    // Fallback/supplement: CoinGecko /derivatives only for coins the live feed lacks.
    try {
      const COVER = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'];
      const needGecko = COVER.some(s => derivCache[s]?.source !== 'derivatives-feed');
      if (needGecko) {
        const data = await fetchGeckoJSON('/derivatives').catch(() => null);
        if (Array.isArray(data)) {
          const symMap = { BTCUSDT: 'BTC', ETHUSDT: 'ETH', SOLUSDT: 'SOL', XRPUSDT: 'XRP', DOGEUSDT: 'DOGE', BNBUSDT: 'BNB' };
          data.forEach(d => {
            const sym = symMap[d.symbol];
            if (!sym) return;
            if (derivCache[sym]?.source === 'derivatives-feed') return; // don't clobber richer data
            if (d.last) {
              derivCache[sym] = {
                funding: parseFloat(d.funding_rate || 0),
                oi: parseFloat(d.open_interest || 0),
                basis: parseFloat(d.basis || 0) * 100,
                spread: parseFloat(d.bid_ask_spread || 0),
                exchange: d.market || '',
                source: 'coingecko',
                ts: Date.now(),
              };
            }
          });
        }
      }
      derivAge = Date.now();
    } catch (err) {
      console.warn('Derivatives fetch failed:', err.message);
    }
  }

  // CVD: Cumulative Volume Delta from trade data
  function calcCVD(trades) {
    if (!trades || trades.length === 0) return { cvd: 0, divergence: 'none', trend: 0 };
    let cvd = 0;
    const cvdArr = [];
    trades.forEach(t => {
      const qty = parseFloat(t.qty || 0);
      cvd += t.side === 'buy' ? qty : -qty;
      cvdArr.push(cvd);
    });
    // CVD slope (is it rising or falling?)
    const recent = cvdArr.slice(-10);
    const cvdSlope = recent.length > 2 ? (recent[recent.length - 1] - recent[0]) / (Math.abs(recent[0]) || 1) * 100 : 0;
    return { cvd, slope: cvdSlope, arr: cvdArr };
  }

  // Squeeze detector
  function detectSqueeze(sym) {
    const deriv = derivCache[sym];
    if (!deriv) return null;
    const funding = deriv.funding;

    // ★ Primary: real liquidation cascade from the live stream (imbalance + notional).
    // imbalance ∈ [-1,+1]: +1 = pure short-liquidation (squeeze up), -1 = long-liquidation (cascade down).
    const liqImb = deriv.liqImbalance;
    const liqTotal = deriv.liqTotalUsd || 0;
    if (Number.isFinite(liqImb) && liqTotal > 250_000 && Math.abs(liqImb) > 0.6) {
      const up = liqImb > 0;
      return {
        type: up ? 'short_squeeze' : 'long_squeeze',
        severity: liqTotal > 2_000_000 ? 'high' : 'medium',
        desc: `${up ? 'Shorts' : 'Longs'} liquidating ($${(liqTotal / 1e6).toFixed(2)}M, ${(Math.abs(liqImb) * 100).toFixed(0)}% one-sided) — ${up ? 'upward' : 'downward'} cascade live.`,
        direction: up ? 'up' : 'down',
        source: 'liquidation-stream',
      };
    }

    // ★ Secondary: leverage building (OI ↑) into a crowded funding extreme.
    if (Number.isFinite(deriv.oiDeltaPct) && deriv.oiDeltaPct > 1.5 && Math.abs(funding) > 0.05) {
      const up = funding < 0; // crowded shorts + OI build → short-squeeze risk
      return {
        type: up ? 'short_squeeze' : 'long_squeeze',
        severity: 'medium',
        desc: `OI +${deriv.oiDeltaPct.toFixed(1)}% with funding ${funding.toFixed(3)}% — leverage building, ${up ? 'short' : 'long'}-squeeze risk.`,
        direction: up ? 'up' : 'down',
        source: 'oi-funding',
      };
    }

    // Fallback: original funding-threshold heuristic (used when live deriv data absent).
    if (funding < -0.5) {
      return {
        type: 'short_squeeze', severity: Math.abs(funding) > 1 ? 'high' : 'medium',
        desc: `Funding ${funding.toFixed(3)}% — shorts paying heavy. Squeeze risk if price bounces.`,
        direction: 'up', source: 'funding-heuristic',
      };
    }
    if (funding > 0.3) {
      return {
        type: 'long_squeeze', severity: funding > 0.5 ? 'high' : 'medium',
        desc: `Funding +${funding.toFixed(3)}% — longs overcrowded. Liquidation cascade risk on dip.`,
        direction: 'down', source: 'funding-heuristic',
      };
    }
    return null;
  }

  // ================================================================
  // PUBLIC API
  // ================================================================

  window.PredictionEngine = {
    updateLiveOrderBook,
    rescoreLiveMicrostructure,
    getLiveMicrostructure,
    // Pre-warms the candle cache for all coins without scoring.
    // Call 60s before each boundary so runAll() scores from warm cache instantly.
    async warmCache() {
      try {
        await Promise.allSettled([
          ...PREDICTION_COINS.map(c => loadCoinData(c)),
          fetchDerivatives()
        ]);
      } catch { }
    },
    forceReset() {
      // Unstick a hung predictionRunPromise so the next runAll() starts fresh.
      predictionRunPromise = null;
      resetGeckoRequestQueue();  // abandon backed-up serial gecko chain
      // Preserve lastGeckoRequestAt so manual refreshes cannot bypass CoinGecko pacing.
      window.throttledFetchReset?.();          // drain stale throttle waitQueue
    },
    applyOnlineWeightUpdate(sym, updates = {}, opts = {}) {
      const state = _ensureOnlineState(sym);
      const now = Date.now();
      Object.entries(updates || {}).forEach(([signal, raw]) => {
        const st = _ensureOnlineSignalState(sym, signal);
        if (!st) return;
        const explicitMult = typeof raw === 'number' ? null : Number(raw?.mult);
        const delta = typeof raw === 'number' ? Number(raw) : Number(raw?.delta);
        if (Number.isFinite(explicitMult)) {
          st.mult = clamp(explicitMult, ONLINE_WEIGHT_BOUNDS.minMult, ONLINE_WEIGHT_BOUNDS.maxMult);
        } else if (Number.isFinite(delta)) {
          st.mult = clamp(st.mult + _clampOnlineStep(delta), ONLINE_WEIGHT_BOUNDS.minMult, ONLINE_WEIGHT_BOUNDS.maxMult);
        }
        st.updatedAt = now;
      });
      state.updatedAt = now;
      if (opts.reason) state.reason = String(opts.reason);
      return JSON.parse(JSON.stringify(state));
    },
    applyCorrelationPruning(sym, pruneMap = {}, opts = {}) {
      const state = _ensureOnlineState(sym);
      const now = Date.now();
      Object.entries(pruneMap || {}).forEach(([signal, raw]) => {
        const st = _ensureOnlineSignalState(sym, signal);
        if (!st) return;
        let pruneMult = 1;
        if (typeof raw === 'boolean') {
          pruneMult = raw ? ONLINE_WEIGHT_BOUNDS.minPruneMult : 1;
        } else if (Number.isFinite(Number(raw))) {
          pruneMult = Number(raw);
        } else if (raw && Number.isFinite(Number(raw.mult))) {
          pruneMult = Number(raw.mult);
        }
        st.pruneMult = clamp(pruneMult, ONLINE_WEIGHT_BOUNDS.minPruneMult, 1);
        st.updatedAt = now;
      });
      state.updatedAt = now;
      if (opts.reason) state.pruneReason = String(opts.reason);
      return JSON.parse(JSON.stringify(state));
    },
    // Cross-session persistence for the adaptive tuner (see data-logger.js's
    // weight_tuning_state category): snapshot the full per-coin/per-signal
    // online-learned state, or restore one at startup instead of cold-starting.
    getOnlineWeightState() {
      return window.PredictionRegimeWeights?.getAllOnlineState?.() ?? {};
    },
    loadOnlineWeightState(snapshot) {
      return window.PredictionRegimeWeights?.loadOnlineState?.(snapshot) ?? { loaded: false, coins: 0 };
    },
    recordOnlineSignalOutcome(payload = {}) {
      const st = _ensureOnlineSignalState(payload.sym, payload.signalKey);
      if (!st) return null;

      const pred = String(payload.predictedSign || payload.predictedDirection || payload.direction || '').toUpperCase();
      const out = String(payload.outcomeSign || payload.actualSign || payload.actualDirection || payload.actualOutcome || payload.outcome || '').toUpperCase();
      const correct = (typeof payload.correct === 'boolean') ? payload.correct : (pred && out && pred === out);
      const confidence = clamp(Number(payload.confidence) || 50, 0, 100);
      const confScale = confidence / 100;
      const delta = correct ? 0.015 + confScale * 0.015 : -(0.02 + confScale * 0.02);

      st.mult = clamp(st.mult + _clampOnlineStep(delta), ONLINE_WEIGHT_BOUNDS.minMult, ONLINE_WEIGHT_BOUNDS.maxMult);
      st.samples += 1;
      if (correct) st.wins += 1;
      else st.losses += 1;
      st.updatedAt = Date.now();
      return { ...st };
    },
    getWeightState(sym) {
      return JSON.parse(JSON.stringify(_ensureOnlineState(sym)));
    },
    setAdaptiveWeights(sym, weights = {}) {
      const state = _ensureOnlineState(sym);
      const now = Date.now();
      const nextSignals = { ...state.signals };

      for (const [signal, rawWeight] of Object.entries(weights || {})) {
        const weight = Number(rawWeight);
        if (!Number.isFinite(weight)) continue;

        const current = nextSignals[signal] || {};
        nextSignals[signal] = {
          ...current,
          mult: clamp(weight, ONLINE_WEIGHT_BOUNDS.minMult, ONLINE_WEIGHT_BOUNDS.maxMult),
          pruneMult: Number.isFinite(Number(current.pruneMult))
            ? clamp(Number(current.pruneMult), ONLINE_WEIGHT_BOUNDS.minPruneMult, 1)
            : 1,
          updatedAt: now,
          source: 'adaptive-learning',
        };
      }

      state.signals = nextSignals;
      state.updatedAt = now;
      state.source = 'adaptive-learning';

      if (typeof window !== 'undefined') {
        window._adaptiveWeightState = window._adaptiveWeightState || {};
        window._adaptiveWeightState[_coinKey(sym)] = JSON.parse(JSON.stringify(state));
      }

      return JSON.parse(JSON.stringify(state));
    },
    applyAdaptiveWeights(weightsByCoin = {}) {
      const applied = {};
      for (const [coin, weights] of Object.entries(weightsByCoin || {})) {
        if (!weights || typeof weights !== 'object') continue;
        applied[coin] = this.setAdaptiveWeights(coin, weights);
      }
      return applied;
    },
    getEffectiveWeights(sym, regimeKey = 'neutral') {
      const regimeWeights = applyRegimeMults(COMPOSITE_WEIGHTS, regimeKey);
      return applyOnlineWeightOverlay(sym, regimeWeights);
    },
    async runAll() {
      if (predictionRunPromise) return predictionRunPromise;

      // -------------------------------------------------------------
      // POLYMARKET 15M DYNAMIC TIMING (Sync with :00, :15, :30, :45 clock boundaries)
      // -------------------------------------------------------------
      const dynBoundary = getPolymarketNextBoundaryMinutes();
      DEFAULT_SHORT_HORIZON_MIN = dynBoundary;
      SHORT_HORIZON_MINUTES = Array.from(new Set([1, 5, 10, 15, dynBoundary])).sort((a, b) => a - b);

      // Reset gecko serial queue and throttle waiters so stale calls from prior
      // runs (e.g. after Refresh clicks) don't block this fresh run.
      resetGeckoRequestQueue();
      // Preserve lastGeckoRequestAt so rapid refreshes keep the provider gap.
      window.throttledFetchReset?.();
      predictionRunPromise = (async () => {
        // Per-coin 20s hard cap — inner fetches have up to 12s individual timeouts;
        // using 20s here gives them clear room to complete before runAll proceeds.
        const withCoinTimeout = (p) =>
          Promise.race([p, new Promise(r => setTimeout(r, PREDICTION_FIRST_PASS_TIMEOUT_MS))]);
        await Promise.allSettled([
          ...PREDICTION_COINS.map(c => withCoinTimeout(loadCoinData(c))),
          Promise.race([fetchDerivatives(), new Promise(r => setTimeout(r, PREDICTION_FIRST_PASS_TIMEOUT_MS))])
        ]);
        // Yield between each coin's backtest to keep the UI thread responsive
        for (const coin of PREDICTION_COINS) {
          try {
            window._backtests[coin.sym] = runWalkForwardBacktest(coin);
          } catch (btErr) {
            console.error('[runAll] runWalkForwardBacktest crash:', coin.sym, btErr);
            window._backtests[coin.sym] = null;
          }
          await new Promise(r => setTimeout(r, 0));
        }
        saveBtCache();
        PREDICTION_COINS.forEach(coin => {
          try {
            const basePrediction = computePrediction(coin, window._backtests[coin.sym]);

            // ── h15-TUNER INTEGRATION ─────────────────────────────────────
            if (window._h15Tuner && typeof window._h15Tuner.getTunedBias === 'function') {
              try {
                const tunedBias = window._h15Tuner.getTunedBias(15, coin.sym, {
                  baseScore: basePrediction.score,
                  baseConfidence: basePrediction.confidence,
                  signal: basePrediction.signal,
                });

                const hasScoreTune = tunedBias && (
                  Object.prototype.hasOwnProperty.call(tunedBias, 'tunedScore') ||
                  Object.prototype.hasOwnProperty.call(tunedBias, 'tunedConfidence') ||
                  Object.prototype.hasOwnProperty.call(tunedBias, 'biasBoost')
                );
                if (hasScoreTune) {
                  const biasBoost = Number.isFinite(Number(tunedBias.biasBoost)) ? Number(tunedBias.biasBoost) : 0;
                  basePrediction.score = tunedBias.tunedScore ?? basePrediction.score;
                  basePrediction.confidence = tunedBias.tunedConfidence ?? basePrediction.confidence;
                  basePrediction.h15TunerApplied = true;
                  basePrediction.h15BiasBoost = biasBoost;
                  predictionDebugLog(
                    `h15-score-tune:${coin.sym}`,
                    'log',
                    () => `[runAll] h15-tuner: boosting ${coin.sym} -> score=${Number(basePrediction.score || 0).toFixed(3)} conf=${basePrediction.confidence}% (bias=${biasBoost.toFixed(3)})`,
                    30000
                  );
                }
              } catch (tunerErr) {
                console.warn(`[runAll] h15-tuner error for ${coin.sym}:`, tunerErr.message);
              }
            } else if (coin === PREDICTION_COINS[0]) {
              // Log once per run if h15-tuner is not available
              console.log(`[runAll] h15-tuner skipped (window._h15Tuner not available)`);
            }

            window._predictions[coin.sym] = preservePredictionOverlay(
              window._predictions[coin.sym],
              basePrediction
            );
          } catch (cpErr) {
            console.error('[runAll] computePrediction crash:', coin.sym, cpErr);
            const fallbackTs = Date.now();
            window._predictions[coin.sym] = {
              sym: coin.sym, name: coin.name, color: coin.color, icon: coin.icon,
              price: candleCache?.[coin.sym]?.ticker?.usd || 0,
              signal: 'neutral', confidence: 10, score: 0,
              ts: fallbackTs, timestamp: fallbackTs,
              source: 'error', candleCount: candleCache?.[coin.sym]?.candles?.length || 0, candleCount1m: candleCache?.[coin.sym]?.candles1m?.length || 0, candleCount15m: candleCache?.[coin.sym]?.candles15m?.length || 0, updatedAt: new Date().toLocaleTimeString(),
              _15mPoolingDebug: {
                ws: window.CandleWS ? (window.CandleWS.getClosedBuckets15m(coin.sym) || []).length : 0,
                cb: candleCache?.[coin.sym]?._cb15m?.length || 0,
                bin: candleCache?.[coin.sym]?._bin15m?.length || 0,
                pooled: candleCache?.[coin.sym]?.candles15m?.length || 0
              },
              error: cpErr.message || 'Compute error',
              indicators: {}, diagnostics: {}, volatility: { label: 'Unknown', atrPct: 0 },
              projections: {}, reversalFlags: [], scalpSetups: [],
            };
          }
        });

        // ── ALLOCATION ENGINE INTEGRATION ─────────────────────────────────
        // Compute portfolio weights from final scores + ATR values
        try {
          if (window.allocationEngine && typeof window.allocationEngine === 'function') {
            const scores = {};
            const atr = {};

            PREDICTION_COINS.forEach(coin => {
              const pred = window._predictions[coin.sym];
              if (pred && pred.score !== undefined) {
                // Normalize score from [-1, +1] to [-3, +3] for allocation engine
                scores[coin.sym] = pred.score * 3;
                // Extract ATR from volatility indicator (atrPct is ATR as % of price)
                if (pred.volatility && pred.volatility.atrPct) {
                  atr[coin.sym] = (pred.price || 1) * (pred.volatility.atrPct / 100);
                } else {
                  atr[coin.sym] = 1; // fallback
                }
              }
            });

            // Call allocation engine with current ATR smoothing state
            const allocResult = window.allocationEngine(scores, atr, {
              prevAtrSmooth: window._allocationState?.atrSmooth || null,
              maxWeight: 0.70,
              minWeight: 0.00,
            });

            // Cache ATR smoothing state for next prediction cycle
            if (!window._allocationState) window._allocationState = {};
            window._allocationState.atrSmooth = allocResult.atrSmooth;
            window._allocationWeights = allocResult.final;

            // Attach allocation weights to each prediction for UI reference
            PREDICTION_COINS.forEach(coin => {
              if (window._predictions[coin.sym]) {
                window._predictions[coin.sym].allocationWeight = allocResult.final[coin.sym] || 0;
              }
            });

            console.log('[allocationEngine] Weights computed:', window._allocationWeights);
          }
        } catch (allocErr) {
          console.error('[allocationEngine] Error:', allocErr);
        }

        runInferenceOverlay(window._predictions).catch(() => { });
        runTideOverlay(window._predictions).catch(() => { });

        // Heavy advanced backtests only when UI is visible (skip on headless Canada node)
        const uiHidden = typeof document !== 'undefined' && document.hidden;
        if (!uiHidden) {
          warmAdvancedBacktests().catch(() => { });
        }
        // Phase 2: enrich with slow proxy-routed sources after initial score.
        // Longer delay when hidden to avoid pile-up with the next prediction cycle.
        setTimeout(() => {
          Promise.allSettled(PREDICTION_COINS.map(c => enrichCoinDataBackground(c).catch(() => { })))
            .then(() => { saveBtCache(); window.dispatchEvent(new CustomEvent('predictionsEnriched')); });
        }, uiHidden ? 55_000 : 30_000);
        return window._predictions;
      })();
      try {
        return await predictionRunPromise;
      } finally {
        predictionRunPromise = null;
      }
    },
    get(sym) { return window._predictions[sym] || null; },
    getAll() { return window._predictions; },
    getBacktest(sym) { return window._backtests[sym] || null; },
    getBacktests() { return window._backtests; },
    getPreOpenForecast(sym, horizonMin = 5) { return computePreOpenHorizonForecast(sym, horizonMin); },
    getPinRisk(sym, spot, ptb, secondsToClose, depthImbalance = 0) {
      return detectPinRisk(sym, spot, ptb, secondsToClose, depthImbalance);
    },
    getRangeViability(sym, horizonMin = 15, currentPtb = null, ttcSec = null) {
      return computeRangeViability(sym, horizonMin, currentPtb, ttcSec);
    },
    getSession() { return getSessionInfo(); },
    startAutoRefresh() {
      this.stopAutoRefresh();
      this.runAll();
      // Scoring is now driven by app.js quarter-aligned scheduler via scheduleOnQuarterHours.
      // This method kept for compatibility; actual schedule is managed externally.
    },
    stopAutoRefresh() {
      if (predictionTimer) { clearTimeout(predictionTimer); predictionTimer = null; }
    }
  };

})();
