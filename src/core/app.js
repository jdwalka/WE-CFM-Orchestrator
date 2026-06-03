// ================================================================
// WE CFM Orchestrator — Application Shell
// Benchmark feeds via Crypto.com Exchange API (no key required)
// Supporting flow and wallet data via Blockscout public API
// ================================================================

(function () {
  'use strict';

  window.__env = window.__env || {};
  try {
    if (window.desktopApp?.publicEnv && typeof window.desktopApp.publicEnv === 'object') {
      Object.assign(window.__env, window.desktopApp.publicEnv);
    }
  } catch (_) { }

  // ---- Icon cache — stores computed HTML string per symbol so each coin's
  //      img element is only constructed once and reused across re-renders ----
  const _iconCache = new Map();
  // Track in-flight icon fetches so we don't fire duplicate requests per symbol
  const _iconFetchQueue = new Set();

  // ---- LLM Integration ----
  let _llmIntegration = null;
  let _llmCycleCount = 0;
  try {
    if (typeof window !== 'undefined' && window.require) {
      const LLMIntClass = window.require('../src/llm/llm_integration.js');
      _llmIntegration = typeof LLMIntClass === 'function' ? new LLMIntClass() : LLMIntClass;
      window._llmIntegration = _llmIntegration;
      console.log('[App] LLMIntegration loaded successfully.');
    }
  } catch (e) {
    console.warn('[App] Failed to load LLMIntegration:', e.message);
  }

  // ---- State ----
  let currentView = 'cfm';
  let _fetchAttempted = false;  // set after first fetchAll() completes (success or fail)
  let _appBootTs = Date.now();
  let _userInteractedWithNav = false;
  let coinFilter = 'all';
  let chartCoin = 'SOLUSD';
  let chartTf = '1h';
  let sortBy = 'volume';
  let sortDir = -1;
  let refreshTimer = null;
  let refreshSecs = 15;
  let tickers = {};         // instrument_name → ticker data
  let sparkData = {};         // sym → [prices] for sparklines
  let candleChart = null;       // lightweight-charts instance
  let donutChart = null;       // Chart.js donut
  let scanRunning = false;
  let cfmExpanded = new Set();
  let predictionCollapsed = new Set();
  let _universeActiveTab = 'table'; // persists across auto-refresh re-renders
  let screenerSortBy = 'marketCap';
  let screenerSortDir = -1;
  let screenerMetaCache = {};
  let screenerMetaAge = 0;
  let screenerMetaPromise = null;
  let _screenerMetaBackoffUntil = 0;
  let _screenerMetaFailureStreak = 0;
  // _lastGeckoSupplementalTs = timestamp of next ALLOWED call (not last call)
  let _lastGeckoSupplementalTs = 0;
  let _lastGeckoSupplementalResult = [];
  // CoinGecko candle queue: serial dispatch + rate-limit gap (mirrors predictions.js)
  let _geckoCandleQueue = Promise.resolve();
  let _lastGeckoCandleAt = 0;
  let chartResizeObserver = null;
  let chartSeries = {};
  let chartRawCandles = [];
  let chartSnapshot = null;
  let predictionRefreshHandle = null;  // { cancel() } — quarter-aligned scorer + prefetch
  let predictionRunInFlight = null;
  let predictionRunTimeoutId = null;
  let _lastPredictionRunTs = 0;
  let _lastPredRenderTs = 0;
  let _predictionEngineFailureCount = 0;
  let _predictionEngineRetryAfterTs = 0;
  let _predictionEngineRetryTimer = null;
  let _predictionEngineLastError = '';
  let _predLastUserScrollTs = 0;
  let _predDeferredRefreshTimer = null;
  let _predScrollTrackerBound = false;
  let _asyncRefreshEngineBooted = false;
  let _kalshiIpcWarnTs = 0;
  let _kalshiIpcWasAvailable = null;
  let orbitalAnimationFrame = null;   // rAF handle for Market Universe orbital canvas
  let _rv = 0; // render version counter — increment on every render/refresh call so stale async renders can self-cancel
  let _observabilityCache = { sig: '', ts: 0, data: null };

  // ── Persistence keys ─────────────────────────────────────────────────────
  const PRED_LOG_STORE = 'beta1_pred_log';
  const KALSHI_LOG_STORE = 'beta1_kalshi_log';
  const LAST_PRED_STORE = 'beta1_last_pred';
  const LAST_KALSHI_STORE = 'beta1_last_kalshi';
  const KALSHI_ERR_STORE = 'beta1_kalshi_errors';
  const ORCH_LOG_STORE = 'beta1_orch_log';
  const KALSHI_TRAIL_STORE = 'beta1_kalshi_2m_trail';
  const LOG_CAP = 250;
  const LOG_BACKUP_COOLDOWN_MS = 15000;
  const LOG_BACKUP_TARGETS = [
    'Z:\\WECRYP\\logs',
    'Z:\\My Drive\\WECRYP\\logs',
  ];
  const TRADE_BELL_STORE = 'beta1_trade_setup_bell_v2';
  const LEGACY_TRADE_BELL_STORE = 'beta1_trade_setup_bell';
  const HIGH_CONF_OVERLAY_STORE = 'beta1_high_conf_overlay_v1';
  const PREDICTION_RUN_TIMEOUT_MS = 25_000;
  const PRED_SCROLL_IDLE_MS = 1000;

  function startPredictionRun() {
    if (predictionRunInFlight) return predictionRunInFlight;
    const engine = window.PredictionEngine;
    if (!engine?.runAll) return Promise.reject(new Error('PredictionEngine.runAll unavailable'));

    const rawRun = Promise.resolve().then(() => engine.runAll());
    let guardedRun;
    guardedRun = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (predictionRunInFlight !== guardedRun) return;
        console.warn(`[Predictions] runAll timed out after ${PREDICTION_RUN_TIMEOUT_MS}ms; clearing stuck in-flight state.`);
        predictionRunInFlight = null;
        if (predictionRunTimeoutId === timeoutId) predictionRunTimeoutId = null;
        engine.forceReset?.();
        reject(new Error(`Prediction run timed out after ${PREDICTION_RUN_TIMEOUT_MS}ms`));
      }, PREDICTION_RUN_TIMEOUT_MS);
      predictionRunTimeoutId = timeoutId;

      rawRun.then(resolve, reject).finally(() => {
        if (predictionRunInFlight === guardedRun) predictionRunInFlight = null;
        if (predictionRunTimeoutId === timeoutId) {
          clearTimeout(timeoutId);
          predictionRunTimeoutId = null;
        }
      });
    });

    predictionRunInFlight = guardedRun;
    return guardedRun;
  }

  function resetPredictionRunState() {
    if (predictionRunTimeoutId) {
      clearTimeout(predictionRunTimeoutId);
      predictionRunTimeoutId = null;
    }
    predictionRunInFlight = null;
    window.PredictionEngine?.forceReset?.();
  }

  // ── Prediction accuracy tracker ──────────────────────────────────────────
  // window._lastPrediction[sym] = { direction: 'UP'|'DOWN'|'FLAT', price, ts, signal }
  window._lastPrediction = window._lastPrediction || {};
  // Rolling log of evaluated results (capped at 200 entries)
  window._predLog = window._predLog || [];
  // Kalshi contract outcome log — builds model vs market confidence over time
  window._kalshiLog = window._kalshiLog || [];
  // Last Kalshi alignment snapshot per coin (for outcome evaluation on bucket close)
  window._lastKalshiSnapshot = window._lastKalshiSnapshot || {};
  // Per-contract prediction trail (2-minute cadence from contract open)
  window._kalshiPredictionTrail = window._kalshiPredictionTrail || {};
  // Contract-level error log — captures mismatches, wick events, fetch failures
  window._kalshiErrors = window._kalshiErrors || [];
  // Market Divergence: per-coin divergence timing state (model vs Kalshi crowd)
  window._marketDivergence = window._marketDivergence || {};
  // Orchestrator intent history — logs each actionable state change per coin
  window._orchLog = window._orchLog || [];
  // Trade setup bell preference + cooldown state
  let _tradeBellEnabled = true;
  let _highConfidenceOverlayEnabled = true;
  let _tradeBellCtx = null;
  let _tradeBellLastGlobalTs = 0;
  let _tradeBellUnlockBound = false;
  let _tradeBellSessionPrimed = false;
  let _contractBellCloseMs = 0;
  let _contractBellLastTs = 0;
  const _contractBellTickerBySym = new Map();
  let _signalAudioLastPingTs = 0;

  let _lastLogBackupTs = 0;
  let _logBackupInFlight = false;

  function capArray(arr, limit = LOG_CAP) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(-limit);
  }

  function capTrailMap(mapObj, limit = LOG_CAP) {
    const entries = Object.entries(mapObj || {});
    if (entries.length <= limit) return mapObj || {};
    return Object.fromEntries(entries.slice(-limit));
  }

  function capRuntimeLogs() {
    window._predLog = capArray(window._predLog);
    window._kalshiLog = capArray(window._kalshiLog);
    window._kalshiErrors = capArray(window._kalshiErrors);
    window._orchLog = capArray(window._orchLog);
    window._kalshiPredictionTrail = capTrailMap(window._kalshiPredictionTrail);
  }

  function scheduleLogBackup(force = false) {
    const now = Date.now();
    if (!force && (now - _lastLogBackupTs) < LOG_BACKUP_COOLDOWN_MS) return;
    if (_logBackupInFlight) return;
    if (!window.dataStore?.ensureDir || !window.dataStore?.writeFile) return;

    _lastLogBackupTs = now;
    _logBackupInFlight = true;

    setTimeout(async () => {
      try {
        capRuntimeLogs();
        const snapshot = {
          timestamp: new Date().toISOString(),
          predLog: capArray(window._predLog),
          kalshiLog: capArray(window._kalshiLog),
          kalshiErrors: capArray(window._kalshiErrors),
          orchLog: capArray(window._orchLog),
          kalshiTrail: capTrailMap(window._kalshiPredictionTrail),
        };
        const payload = JSON.stringify(snapshot, null, 2);

        await Promise.allSettled(LOG_BACKUP_TARGETS.map(async (dir) => {
          await window.dataStore.ensureDir(dir);
          await window.dataStore.writeFile(`${dir}\\wecrypto-log-backup.json`, payload);
        }));
      } catch (e) {
        console.warn('[LogBackup] Z: backup failed:', e.message);
      } finally {
        _logBackupInFlight = false;
      }
    }, 0);
  }

  async function restoreLogsFromBackupIfNeeded() {
    try {
      const hasLocalLogs =
        (Array.isArray(window._predLog) && window._predLog.length > 0) ||
        (Array.isArray(window._kalshiLog) && window._kalshiLog.length > 0) ||
        (Array.isArray(window._kalshiErrors) && window._kalshiErrors.length > 0) ||
        (Array.isArray(window._orchLog) && window._orchLog.length > 0);

      if (hasLocalLogs) return;
      if (!window.dataStore?.readFile) return;

      for (const dir of LOG_BACKUP_TARGETS) {
        const fp = `${dir}\\wecrypto-log-backup.json`;
        const res = await window.dataStore.readFile(fp);
        if (!res?.ok || !res.content) continue;

        const parsed = JSON.parse(res.content);
        window._predLog = capArray(parsed.predLog);
        window._kalshiLog = capArray(parsed.kalshiLog);
        window._kalshiErrors = capArray(parsed.kalshiErrors);
        window._orchLog = capArray(parsed.orchLog);
        window._kalshiPredictionTrail = capTrailMap(parsed.kalshiTrail);
        capRuntimeLogs();

        try {
          localStorage.setItem(PRED_LOG_STORE, JSON.stringify(window._predLog));
          localStorage.setItem(KALSHI_LOG_STORE, JSON.stringify(window._kalshiLog));
          localStorage.setItem(KALSHI_ERR_STORE, JSON.stringify(window._kalshiErrors));
          localStorage.setItem(ORCH_LOG_STORE, JSON.stringify(window._orchLog));
          localStorage.setItem(KALSHI_TRAIL_STORE, JSON.stringify(window._kalshiPredictionTrail));
        } catch (_) { }

        console.log(`[LogBackup] Restored logs from ${fp}`);
        break;
      }
    } catch (e) {
      console.warn('[LogBackup] Restore from backup failed:', e.message);
    }
  }

  // Restore persisted logs from localStorage on startup
  (function restorePersistedData() {
    const LOG_TTL_MS = 24 * 3600 * 1000; // 24h TTL for sticky loss logs
    const now = Date.now();
    const shouldClearOldLogs = (logStr) => {
      try { const parsed = JSON.parse(logStr); const meta = parsed._metadata || {}; return meta.timestamp && (now - meta.timestamp) > LOG_TTL_MS; } catch { return false; }
    };

    try { const r = localStorage.getItem(PRED_LOG_STORE); if (r && !shouldClearOldLogs(r)) window._predLog = JSON.parse(r); else localStorage.removeItem(PRED_LOG_STORE); } catch (e) { }
    try { const r = localStorage.getItem(KALSHI_LOG_STORE); if (r && !shouldClearOldLogs(r)) window._kalshiLog = JSON.parse(r); else localStorage.removeItem(KALSHI_LOG_STORE); } catch (e) { }
    try { const r = localStorage.getItem(LAST_PRED_STORE); if (r) window._lastPrediction = JSON.parse(r); } catch (e) { }
    try { const r = localStorage.getItem(LAST_KALSHI_STORE); if (r) window._lastKalshiSnapshot = JSON.parse(r); } catch (e) { }
    try { const r = localStorage.getItem(KALSHI_ERR_STORE); if (r) window._kalshiErrors = JSON.parse(r); } catch (e) { }
    try { const r = localStorage.getItem(ORCH_LOG_STORE); if (r) window._orchLog = JSON.parse(r); } catch (e) { }
    try { const r = localStorage.getItem(KALSHI_TRAIL_STORE); if (r) window._kalshiPredictionTrail = JSON.parse(r); } catch (e) { }
    try {
      const r = localStorage.getItem(TRADE_BELL_STORE);
      if (r == null) {
        // Split-control migration: default signal bells ON regardless of legacy wall-sound state.
        _tradeBellEnabled = true;
        localStorage.setItem(TRADE_BELL_STORE, '1');
      } else {
        _tradeBellEnabled = r === '1';
      }
    } catch (e) { }
    try {
      const r = localStorage.getItem(HIGH_CONF_OVERLAY_STORE);
      if (r == null) {
        _highConfidenceOverlayEnabled = true;
        localStorage.setItem(HIGH_CONF_OVERLAY_STORE, '1');
      } else {
        _highConfidenceOverlayEnabled = r === '1';
      }
    } catch (e) { }
    try { localStorage.removeItem(LEGACY_TRADE_BELL_STORE); } catch (e) { }
    capRuntimeLogs();
    scheduleLogBackup(true);
    setTimeout(() => { restoreLogsFromBackupIfNeeded(); }, 0);
    // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();

  // ── Initialize 2-Hour Contract Cache + Multi-Drive Sync ──────────────────
  (function initContractCache() {
    try {
      // Use multi-drive cache if available (instant sync to all drives)
      if (typeof window.MultiDriveCache !== 'undefined') {
        window._contractCache = window.MultiDriveCache;
        console.log('[ContractCache] Using MultiDriveCache (instant sync to all drives)');
      } else if (typeof ContractCacheManager !== 'undefined') {
        // Fallback to single-drive cache
        window._contractCache = new ContractCacheManager({
          maxAgeMs: 2 * 60 * 60 * 1000,  // 2 hours
          archiveThresholdMs: 2.5 * 60 * 60 * 1000  // 2.5 hours
        });
        console.log('[ContractCache] Using ContractCacheManager (localStorage fallback)');
      }
    } catch (e) {
      console.warn('[ContractCache] Failed to initialize:', e.message);
    }
    // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();

  // ── Initialize Proxy Orchestrator ────────────────────────────────────────
  // Coordinates rate-limiting, request deduplication, fallback chains, and multi-layer caching
  (function initProxyOrchestrator() {
    try {
      if (typeof window.ProxyOrchestrator === 'undefined') {
        console.warn('[ProxyOrchestrator] Not loaded yet — will retry on demand');
        // removed cleanup
        return;
      }

      // Reuse the instance created by proxy-orchestrator.js IIFE; only create if missing
      if (typeof window._proxyOrchestrator === 'undefined') {
        window._proxyOrchestrator = new window.ProxyOrchestrator({
          backoff_start: 2000,
          backoff_max: 32000,
        });
      }

      // Register known sources for fallback routing
      window._proxyOrchestrator.fallback.registerSource('kalshi', {
        endpoint: 'kalshi',
      });
      window._proxyOrchestrator.fallback.registerSource('cmc', {
        endpoint: 'cmc',
      });
      window._proxyOrchestrator.fallback.registerSource('pyth', {
        endpoint: 'pyth',
      });
      window._proxyOrchestrator.fallback.registerSource('coingecko', {
        endpoint: 'coingecko',
      });
      window._proxyOrchestrator.fallback.registerSource('coingecko', {
        endpoint: 'coingecko',
      });
      window._proxyOrchestrator.fallback.registerSource('cache', {
        endpoint: 'cache',
      });

      console.log('[ProxyOrchestrator] ✓ Initialized successfully');
      console.log('[ProxyOrchestrator] Health:', window._proxyOrchestrator.getHealthStatus());
    } catch (e) {
      console.warn('[ProxyOrchestrator] Initialization failed:', e.message);
      // Graceful degradation — app continues to work with direct fetch
    }
    // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();

  // ── Initialize Signal Scheduler Agent ────────────────────────────────────
  // Prioritizes price → momentum → validation work so refreshes do not blast
  // all HTTP sources simultaneously when the app is under load.
  (function initSignalScheduler() {
    try {
      if (typeof window.SignalSchedulerAgent === 'undefined') {
        console.warn('[SignalScheduler] Not loaded yet — skipping initialization');
        // removed cleanup
        return;
      }

      window._signalScheduler = new window.SignalSchedulerAgent({
        lanes: {
          microstructure: { concurrency: 4, gapMs: 8 },
          price: { concurrency: 3, gapMs: 20 },
          momentum: { concurrency: 4, gapMs: 65 },
          validation: { concurrency: 1, gapMs: 350 },
          background: { concurrency: 2, gapMs: 180 },
        },
        providers: {
          kalshi: { cooldownMs: 250, cooldownMaxMs: 3000, circuitThreshold: 10, circuitMs: 25000 },
          gecko: { cooldownMs: 3500, cooldownMaxMs: 120000, circuitThreshold: 5, circuitMs: 180000 },
          llm: { cooldownMs: 15000, cooldownMaxMs: 300000, circuitThreshold: 2, circuitMs: 300000 },
          'pyth-lazer': { cooldownMs: 1200, cooldownMaxMs: 20000, circuitThreshold: 3, circuitMs: 25000 },
          cdc: { cooldownMs: 1500, cooldownMaxMs: 45000, circuitThreshold: 4, circuitMs: 60000 },
        },
      });

      console.info('[SignalScheduler] ✓ Initialized');
    } catch (e) {
      console.warn('[SignalScheduler] Initialization failed:', e.message);
    }
    // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();

  function savePredLog() {
    try {
      window._predLog = capArray(window._predLog);
      localStorage.setItem(PRED_LOG_STORE, JSON.stringify(window._predLog));
      scheduleLogBackup();
    } catch (e) { }
  }
  function saveKalshiLog() {
    try {
      window._kalshiLog = capArray(window._kalshiLog);
      localStorage.setItem(KALSHI_LOG_STORE, JSON.stringify(window._kalshiLog));
      scheduleLogBackup();
    } catch (e) { }
  }
  function saveLastPred() { try { localStorage.setItem(LAST_PRED_STORE, JSON.stringify(window._lastPrediction)); } catch (e) { } }
  function saveLastKalshi() { try { localStorage.setItem(LAST_KALSHI_STORE, JSON.stringify(window._lastKalshiSnapshot)); } catch (e) { } }
  function saveKalshiErrors() {
    try {
      window._kalshiErrors = capArray(window._kalshiErrors);
      localStorage.setItem(KALSHI_ERR_STORE, JSON.stringify(window._kalshiErrors));
      scheduleLogBackup();
    } catch (e) { }
  }
  function saveOrchLog() {
    try {
      window._orchLog = capArray(window._orchLog);
      localStorage.setItem(ORCH_LOG_STORE, JSON.stringify(window._orchLog));
      scheduleLogBackup();
    } catch (e) { }
  }
  function saveKalshiTrail() {
    try {
      window._kalshiPredictionTrail = capTrailMap(window._kalshiPredictionTrail);
      localStorage.setItem(KALSHI_TRAIL_STORE, JSON.stringify(window._kalshiPredictionTrail));
      scheduleLogBackup();
    } catch (e) { }
  }
  function saveTradeBellPref() { try { localStorage.setItem(TRADE_BELL_STORE, _tradeBellEnabled ? '1' : '0'); } catch (e) { } }
  function saveHighConfidenceOverlayPref() { try { localStorage.setItem(HIGH_CONF_OVERLAY_STORE, _highConfidenceOverlayEnabled ? '1' : '0'); } catch (e) { } }

  window._journalPending = window._journalPending || {};

  function _getTradeJournal() {
    try {
      if (window.QuantCore?.journal) return window.QuantCore.journal;
      if (window._tradeJournal) return window._tradeJournal;
      if (typeof window.TradeJournal === 'function') {
        window._tradeJournal = new window.TradeJournal({ storage_key: 'beta1_trade_journal' });
        return window._tradeJournal;
      }
    } catch (_) { }
    return null;
  }

  function _normTradeConfidence(v) {
    const n = Number(v || 0);
    if (!Number.isFinite(n)) return 0;
    return n > 1 ? Math.max(0, Math.min(1, n / 100)) : Math.max(0, Math.min(1, n));
  }

  function _oppositeDir(dir) {
    return dir === 'UP' ? 'DOWN' : dir === 'DOWN' ? 'UP' : dir;
  }

  function _normProb(v, fallback = 0.5) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (n > 1) return Math.max(0, Math.min(1, n / 100));
    return Math.max(0, Math.min(1, n));
  }

  function _getFillSimulator() {
    try {
      const sim = window.KalshiFillSimulator;
      if (sim && typeof sim.estimateFill === 'function') return sim;
    } catch (_) { }
    return null;
  }

  function _estimateKalshiFillQuality(sym, pred, predictionDir) {
    const simulator = _getFillSimulator();
    if (!simulator || !pred || !sym || predictionDir === 'FLAT') return null;

    try {
      const executionGuard = pred?.diagnostics?.executionGuard || {};
      const quoteProb = _normProb(
        pred?.projections?.p15?.kalshiAlign?.yesProb ??
        pred?.diagnostics?.kalshi?.yesProb ??
        pred?.diagnostics?.kalshiYesProb ??
        0.5
      );

      const sim = simulator.estimateFill({
        deterministic: true,
        side: predictionDir === 'UP' ? 'BUY_YES' : 'BUY_NO',
        quotePrice: quoteProb,
        midPrice: quoteProb,
        spreadBps: Number(executionGuard?.spreadBps || executionGuard?.spread_bps || 90),
        latencyMs: Number(executionGuard?.quoteToFillMs || executionGuard?.latencyMs || 250),
        volatilityBpsPerSec: Number(pred?.diagnostics?.volatilityBpsPerSec || 35),
        adverseSelection: 0.65,
        queueAhead: Number(executionGuard?.queueAhead || 10),
        queueOutflowPerSec: Number(executionGuard?.queueOutflowPerSec || 3),
        orderSize: Number(executionGuard?.orderSize || 10),
        visibleSize: Number(executionGuard?.visibleSize || executionGuard?.bookTopSize || 200),
        liquidityScore: _normProb(executionGuard?.liquidityScore ?? 0.75, 0.75),
        collapseProbability: _normProb(executionGuard?.liquidityCollapseProb ?? 0.04, 0.04),
        collapseSeverity: _normProb(executionGuard?.liquidityCollapseSeverity ?? 0.5, 0.5),
      });

      return {
        simulator_version: '1.0.0',
        deterministic: true,
        quote_price: quoteProb,
        side: predictionDir === 'UP' ? 'BUY_YES' : 'BUY_NO',
        fill_probability: Number(sim.expected.fillProbability || 0),
        partial_fill_ratio: Number(sim.expected.partialFillRatio || 0),
        slippage_bps: Number(sim.expected.slippageBps || 0),
        spread_widen_bps: Number(sim.expected.spreadWidenBps || 0),
        latency_drift_bps: Number(sim.expected.latencyDriftBps || 0),
        expected_fill_price: Number(sim.expected.fillPrice || quoteProb),
        warnings: sim.warnings || [],
      };
    } catch (_) {
      return null;
    }
  }

  function _buildRealizedFillQuality(meta = {}, pending = null) {
    const expected = pending?.expectedFill || null;
    const realizedFillPrice = Number.isFinite(Number(meta.realized_fill_price))
      ? Number(meta.realized_fill_price)
      : Number.isFinite(Number(meta.fill_price))
        ? Number(meta.fill_price)
        : null;
    const expectedPrice = Number.isFinite(Number(expected?.expected_fill_price))
      ? Number(expected.expected_fill_price)
      : Number.isFinite(Number(expected?.quote_price))
        ? Number(expected.quote_price)
        : null;

    let slippageBps = null;
    if (Number.isFinite(realizedFillPrice) && Number.isFinite(expectedPrice) && Math.abs(expectedPrice) > 1e-9) {
      slippageBps = ((realizedFillPrice - expectedPrice) / expectedPrice) * 20000;
    }

    const realizedRatio = Number.isFinite(Number(meta.realized_fill_ratio))
      ? Math.max(0, Math.min(1, Number(meta.realized_fill_ratio)))
      : null;
    const realizedLatencyMs = Number.isFinite(Number(meta.realized_latency_ms))
      ? Math.max(0, Number(meta.realized_latency_ms))
      : null;

    if (!Number.isFinite(realizedFillPrice) && !Number.isFinite(slippageBps) && realizedRatio === null && realizedLatencyMs === null) {
      return null;
    }

    return {
      realized_fill_price: Number.isFinite(realizedFillPrice) ? realizedFillPrice : null,
      slippage_bps: Number.isFinite(slippageBps) ? slippageBps : null,
      fill_ratio: realizedRatio,
      latency_ms: realizedLatencyMs,
      fill_probability_realized: Number.isFinite(Number(meta.realized_fill_probability))
        ? Math.max(0, Math.min(1, Number(meta.realized_fill_probability)))
        : null,
      source: meta.source || 'unknown',
    };
  }

  function _journalPrediction(sym, pred, predictionDir, bucketTs) {
    const journal = _getTradeJournal();
    if (!journal || !sym || !pred || predictionDir === 'FLAT') return;
    const pending = window._journalPending[sym];
    if (pending && pending.bucketTs === bucketTs) return;
    try {
      const expectedFillQuality = _estimateKalshiFillQuality(sym, pred, predictionDir);
      const tradeId = journal.recordTrade({
        asset: sym,
        prediction: predictionDir,
        confidence: _normTradeConfidence(pred.confidence),
        regime: pred?.diagnostics?.quantRegime?.state || pred?.liveRegime?.regime || 'UNKNOWN',
        signals: pred?.diagnostics?.components || {},
        market_state: {
          score: Number(pred?.score || 0),
          price: Number(pred?.price || 0),
          routed_action: pred?.diagnostics?.routedAction || null,
          execution_guard: pred?.diagnostics?.executionGuard || null,
        },
        fill_price: Number((expectedFillQuality?.expected_fill_price ?? pred?.price) || 0),
        expected_fill_quality: expectedFillQuality,
        settled: false,
        outcome: 'UNKNOWN',
        metadata: {
          source: 'snapshotPredictions',
          bucketTs,
          ticker: pred?.projections?.p15?.kalshiAlign?.ticker || null,
          cfmCalibration: pred?.diagnostics?.cfmCalibration || null,
        },
      });
      window._journalPending[sym] = {
        tradeId,
        bucketTs,
        ticker: pred?.projections?.p15?.kalshiAlign?.ticker || null,
        expectedFill: expectedFillQuality,
      };
    } catch (_) { }
  }

  function _journalSettlement(sym, outcomeUpDown, closePrice = null, meta = {}) {
    const journal = _getTradeJournal();
    if (!journal || !sym || (outcomeUpDown !== 'UP' && outcomeUpDown !== 'DOWN')) return;
    try {
      const pending = window._journalPending[sym];
      const realizedFillQuality = _buildRealizedFillQuality(meta, pending);
      if (pending?.tradeId) {
        const ok = journal.updateTrade(pending.tradeId, {
          close_price: Number.isFinite(closePrice) ? Number(closePrice) : undefined,
          outcome: outcomeUpDown,
          settled: true,
          expected_fill_quality: pending.expectedFill || undefined,
          realized_fill_quality: realizedFillQuality || undefined,
        });
        if (ok) {
          delete window._journalPending[sym];
          // removed cleanup
          return;
        }
      }
      const fallbackDir = meta.predictionDir || window._lastPrediction?.[sym]?.direction || 'UP';
      journal.recordTrade({
        asset: sym,
        prediction: fallbackDir,
        confidence: _normTradeConfidence(meta.confidence),
        regime: meta.regime || 'UNKNOWN',
        market_state: {
          source: meta.source || 'settlement-fallback',
          ticker: meta.ticker || null,
        },
        fill_price: Number(meta.fill_price || 0),
        expected_fill_quality: pending?.expectedFill || null,
        realized_fill_quality: realizedFillQuality,
        close_price: Number.isFinite(closePrice) ? Number(closePrice) : null,
        outcome: outcomeUpDown,
        settled: true,
        metadata: {
          source: meta.source || 'settlement-fallback',
          modelCorrect: meta.modelCorrect ?? null,
        },
      });
    } catch (_) { }
  }

  function isTradeBellOn() { return !!_tradeBellEnabled; }
  function setTradeBellOn(next) {
    const prev = _tradeBellEnabled;
    _tradeBellEnabled = !!next;
    saveTradeBellPref();
    if (_tradeBellEnabled && !prev) {
      primeTradeBellSession();
      playSignalHealthPing('enabled');
    }
    return _tradeBellEnabled;
  }

  function isHighConfidenceOverlayOn() { return !!_highConfidenceOverlayEnabled; }
  function setHighConfidenceOverlayOn(next) {
    _highConfidenceOverlayEnabled = !!next;
    saveHighConfidenceOverlayPref();
    return _highConfidenceOverlayEnabled;
  }

  function trySystemBeep() {
    try {
      const shell = window?.require?.('electron')?.shell;
      if (shell?.beep) {
        shell.beep();
        return true;
      }
    } catch (_) { }
    return false;
  }

  function ensureTradeBellContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!_tradeBellCtx) _tradeBellCtx = new Ctx();
    return _tradeBellCtx;
  }

  function primeTradeBellSession() {
    const ctx = ensureTradeBellContext();
    if (!ctx || _tradeBellSessionPrimed) return;

    const fire = () => {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = ctx.currentTime + 0.01;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, start);
        gain.gain.setValueAtTime(0.00005, start);
        gain.gain.exponentialRampToValueAtTime(0.00001, start + 0.04);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.05);
        _tradeBellSessionPrimed = true;
      } catch (_) { }
    };

    if (ctx.state === 'suspended') ctx.resume().then(fire).catch(() => { });
    else fire();
  }

  function playSignalHealthPing(reason = 'heartbeat') {
    if (!isTradeBellOn()) return false;
    const now = Date.now();
    if ((now - _signalAudioLastPingTs) < 20_000) return false;
    _signalAudioLastPingTs = now;

    const ctx = ensureTradeBellContext();
    if (!ctx) return trySystemBeep();

    const play = () => {
      const start = ctx.currentTime + 0.02;
      const freqs = [660, 880, 740];
      const gaps = [0.00, 0.18, 0.40];
      const durs = [0.14, 0.14, 0.24];
      const gainScale = 0.22;

      freqs.forEach((freq, i) => {
        const noteStart = start + gaps[i];
        const noteDur = durs[i];
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = i === 2 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, noteStart);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(gainScale, noteStart + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteDur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(noteStart);
        osc.stop(noteStart + noteDur + 0.02);
      });
    };

    if (ctx.state === 'suspended') ctx.resume().then(play).catch(() => { trySystemBeep(); });
    else play();
    console.info(`[signalAudio] ping (${reason})`);
    return true;
  }

  function bindTradeBellUnlock() {
    if (_tradeBellUnlockBound) return;
    _tradeBellUnlockBound = true;

    const unlock = () => {
      const ctx = ensureTradeBellContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => { });
      if (isTradeBellOn()) {
        // Avoid blocking input handlers; prime + ping on next tick.
        setTimeout(() => {
          try {
            primeTradeBellSession();
            playSignalHealthPing('unlock');
          } catch (_) { }
        }, 0);
      }
      if (ctx.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
        window.removeEventListener('touchstart', unlock, true);
      }
    };

    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        const ctx = ensureTradeBellContext();
        if (ctx?.state === 'suspended') {
          ctx.resume().then(() => {
            if (isTradeBellOn()) {
              primeTradeBellSession();
              playSignalHealthPing('visible');
            }
          }).catch(() => { if (isTradeBellOn()) trySystemBeep(); });
        } else if (isTradeBellOn()) {
          primeTradeBellSession();
          playSignalHealthPing('visible');
        }
      }
    });
  }
  bindTradeBellUnlock();

  function classifyTradeSetup(ki) {
    if (!ki || ki.action !== 'trade') return null;
    if (ki.alignment === 'CROWD_FADE' || ki.crowdFade) return 'crowd-fade';
    if (ki.closeValue || ki.timingRegime === 'CLOSE_VALUE') return 'close-value';
    if (ki.scalpFlip || ki.timingRegime === 'SCALP_EARLY') return 'scalp-flip';
    if (ki.sweetSpot) return 'sweet-spot';
    if (ki.signalLocked) return 'signal-lock';
    if (ki.alignment === 'ALIGNED') return 'aligned';
    if (ki.alignment === 'DIVERGENT') return 'divergent';
    if (ki.alignment === 'MODEL_LEADS') return 'model-leads';
    return 'trade';
  }

  function maybePlayTradeSetupBell(sym, ki) {
    const setupType = classifyTradeSetup(ki);
    if (!setupType || !isTradeBellOn()) return setupType;

    const now = Date.now();
    // Keep a short anti-spam gap only; changed-opinion gating is handled upstream.
    if ((now - _tradeBellLastGlobalTs) < 600) return setupType;
    _tradeBellLastGlobalTs = now;

    try {
      const ctx = ensureTradeBellContext();
      if (!ctx) {
        trySystemBeep();
        return setupType;
      }

      const playProfile = () => {
        const start = ctx.currentTime + 0.01;
        const dir = (ki.direction || '').toUpperCase();
        const base = dir === 'UP' ? 640 : dir === 'DOWN' ? 520 : 580;
        const master = 0.12;

        const profiles = {
          'crowd-fade': { ratios: [1.00, 1.26, 1.52], gaps: [0.00, 0.23, 0.48], durs: [0.26, 0.26, 0.34] },
          'close-value': { ratios: [1.00, 1.18, 1.44], gaps: [0.00, 0.18, 0.38], durs: [0.22, 0.24, 0.30] },
          'scalp-flip': { ratios: [1.00, 1.30, 1.12], gaps: [0.00, 0.16, 0.32], durs: [0.18, 0.18, 0.24] },
          'sweet-spot': { ratios: [1.00, 1.20, 1.50], gaps: [0.00, 0.22, 0.44], durs: [0.24, 0.24, 0.30] },
          'signal-lock': { ratios: [1.00, 1.12, 1.00], gaps: [0.00, 0.24, 0.52], durs: [0.20, 0.20, 0.28] },
          'aligned': { ratios: [1.00, 1.33], gaps: [0.00, 0.28], durs: [0.26, 0.34] },
          'divergent': { ratios: [1.00, 1.19, 1.42], gaps: [0.00, 0.20, 0.42], durs: [0.22, 0.22, 0.30] },
          'model-leads': { ratios: [1.00, 1.15, 1.34], gaps: [0.00, 0.20, 0.42], durs: [0.22, 0.22, 0.28] },
          'trade': { ratios: [1.00, 1.25], gaps: [0.00, 0.30], durs: [0.24, 0.34] },
        };
        const profile = profiles[setupType] || profiles.trade;

        profile.ratios.forEach((ratio, idx) => {
          const noteStart = start + (profile.gaps[idx] || 0);
          const noteDur = profile.durs[idx] || 0.24;
          const freq = base * ratio;

          const osc = ctx.createOscillator();
          const overtone = ctx.createOscillator();
          const gain = ctx.createGain();

          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, noteStart);
          overtone.type = 'sine';
          overtone.frequency.setValueAtTime(freq * 2, noteStart);

          gain.gain.setValueAtTime(0.0001, noteStart);
          gain.gain.exponentialRampToValueAtTime(master, noteStart + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteDur);

          osc.connect(gain);
          overtone.connect(gain);
          gain.connect(ctx.destination);

          osc.start(noteStart);
          overtone.start(noteStart);
          osc.stop(noteStart + noteDur + 0.02);
          overtone.stop(noteStart + noteDur + 0.02);
        });
      };

      if (ctx.state === 'suspended') ctx.resume().then(playProfile).catch(() => { trySystemBeep(); });
      else playProfile();
    } catch (e) {
      console.warn('[tradeBell]', e.message);
    }

    return setupType;
  }

  function playContractRolloverBell(direction) {
    const ctx = ensureTradeBellContext();
    if (!ctx) return trySystemBeep();

    const playProfile = () => {
      const dir = (direction || '').toUpperCase();
      const base = dir === 'UP' ? 460 : dir === 'DOWN' ? 420 : 440;
      const start = ctx.currentTime + 0.02;
      const ratios = [1.00, 1.20, 1.42, 1.78, 1.30];
      const gaps = [0.00, 0.17, 0.35, 0.57, 0.86];
      const durs = [0.17, 0.17, 0.19, 0.26, 0.34];
      const gainScale = 0.14;

      ratios.forEach((ratio, idx) => {
        const noteStart = start + gaps[idx];
        const noteDur = durs[idx];
        const freq = base * ratio;

        const osc = ctx.createOscillator();
        const overtone = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = idx < 3 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, noteStart);
        overtone.type = 'sine';
        overtone.frequency.setValueAtTime(freq * 1.99, noteStart);

        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(gainScale, noteStart + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteDur);

        osc.connect(gain);
        overtone.connect(gain);
        gain.connect(ctx.destination);

        osc.start(noteStart);
        overtone.start(noteStart);
        osc.stop(noteStart + noteDur + 0.02);
        overtone.stop(noteStart + noteDur + 0.02);
      });
    };

    if (ctx.state === 'suspended') ctx.resume().then(playProfile).catch(() => { trySystemBeep(); });
    else playProfile();
    return true;
  }

  function maybePlayContractArrivalBell(sym, ki) {
    if (!ki || !isTradeBellOn()) return false;
    const now = Date.now();

    const closeMs = Number(ki.closeTimeMs);
    if (Number.isFinite(closeMs) && closeMs > 0) {
      if (_contractBellCloseMs <= 0) {
        _contractBellCloseMs = closeMs; // prime at startup; don't ring on initial paint
        return false;
      }
      if (closeMs <= (_contractBellCloseMs + 5000)) return false;
      _contractBellCloseMs = closeMs;

      if ((now - _contractBellLastTs) < 75000) return false;
      _contractBellLastTs = now;
      playContractRolloverBell(ki.direction);
      console.info(`[contractBell] New contract cycle detected (${sym}) close=${new Date(closeMs).toLocaleTimeString()}`);
      return true;
    }

    const ticker = typeof ki.contractTicker === 'string' ? ki.contractTicker : '';
    if (!ticker) return false;
    const prev = _contractBellTickerBySym.get(sym);
    _contractBellTickerBySym.set(sym, ticker);
    if (!prev || prev === ticker) return false;
    if ((now - _contractBellLastTs) < 75000) return false;
    _contractBellLastTs = now;
    playContractRolloverBell(ki.direction);
    console.info(`[contractBell] New contract ticker detected (${sym}) ${ticker}`);
    return true;
  }

  // ── Contract error logging helper ─────────────────────────────────────────
  // Records anomalies (wick events, proxy mismatches, fetch failures) to
  // window._kalshiErrors for console inspection via KalshiDebug.errors()
  function logContractError(type, sym, data) {
    const entry = { type, sym, ts: Date.now(), tsIso: new Date().toISOString(), ...data };
    window._kalshiErrors.push(entry);
    if (window._kalshiErrors.length > LOG_CAP) window._kalshiErrors.shift();
    saveKalshiErrors();
    console.error(`[KalshiError] ${type} | ${sym}`, entry);

    // ── Record error in scorecard aggregator ───────────────────────────────────
    if (window._aggregator) {
      try {
        window._aggregator.recordError(sym, type, JSON.stringify(data), {
          originalData: data,
          kalshiError: true,
        });
      } catch (e) { /* non-critical */ }
    }

    // ── Record error in 2-hour contract cache (NEW) ─────────────────────────
    if (window._contractCache) {
      try {
        window._contractCache.recordError(type, `${sym}: ${data.message || JSON.stringify(data)}`, {
          sym,
          originalData: data
        });
      } catch (e) { /* non-critical */ }
    }
  }

  function directionFromYesPct(strikeDir, yesPct) {
    if (!Number.isFinite(yesPct)) return 'FLAT';
    const yesDir = strikeDir === 'below' ? 'DOWN' : 'UP';
    const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
    return yesPct >= 50 ? yesDir : noDir;
  }

  // Record the model state every 2 minutes from contract open to close (15m contracts).
  function capturePredictionTrail2m(sym, snap) {
    try {
      const ticker = snap?.ticker;
      const closeTimeMs = snap?.closeTimeMs;
      if (!ticker || !Number.isFinite(closeTimeMs)) return;

      const now = Date.now();
      const openTimeMs = closeTimeMs - (15 * 60_000);
      if (now < openTimeMs || now > closeTimeMs + 30_000) return;

      const stepMs = 2 * 60_000;
      const stepIndex = Math.floor((now - openTimeMs) / stepMs);
      if (stepIndex < 0 || stepIndex > 7) return;

      let trail = window._kalshiPredictionTrail[ticker];
      if (!trail) {
        trail = {
          sym,
          ticker,
          strikeDir: snap.strikeDir ?? 'above',
          openTimeMs,
          closeTimeMs,
          points: [],
        };
        window._kalshiPredictionTrail[ticker] = trail;
      }
      if (!Array.isArray(trail.points)) trail.points = [];
      trail.strikeDir = snap.strikeDir ?? trail.strikeDir ?? 'above';
      trail.openTimeMs = openTimeMs;
      trail.closeTimeMs = closeTimeMs;

      if (trail.points.some(p => p.stepIndex === stepIndex)) return;

      const modelYesPct = Number.isFinite(snap.mYesPct) ? Math.round(snap.mYesPct) : null;
      const point = {
        ts: now,
        stepIndex,
        minsFromOpen: stepIndex * 2,
        secsToClose: Math.max(0, Math.round((closeTimeMs - now) / 1000)),
        modelDir: directionFromYesPct(trail.strikeDir, modelYesPct),
        modelYesPct,
        kalshiYesPct: Number.isFinite(snap.kYesPct) ? Math.round(snap.kYesPct) : null,
        modelScore: Number.isFinite(snap.modelScore) ? +Number(snap.modelScore).toFixed(4) : null,
        modelConf: Number.isFinite(snap.modelConf) ? +Number(snap.modelConf).toFixed(3) : null,
        betAction: snap.betAction ?? null,
        cdfImpliedDir: snap.cdfImpliedDir ?? null,
        dirConflict: !!snap.dirConflict,
        signalComponents: snap.signalComponents ?? null,
      };

      const prev = trail.points.length ? trail.points[trail.points.length - 1] : null;
      trail.points.push(point);
      trail.points.sort((a, b) => a.stepIndex - b.stepIndex);

      if (
        prev &&
        prev.modelDir && point.modelDir &&
        prev.modelDir !== point.modelDir &&
        prev.modelDir !== 'FLAT' &&
        point.modelDir !== 'FLAT'
      ) {
        logContractError('prediction_flip_2m', sym, {
          ticker,
          fromDir: prev.modelDir,
          toDir: point.modelDir,
          fromYesPct: prev.modelYesPct,
          toYesPct: point.modelYesPct,
          fromScore: prev.modelScore,
          toScore: point.modelScore,
          minsFromOpen: point.minsFromOpen,
          secsToClose: point.secsToClose,
        });
      }

      const keys = Object.keys(window._kalshiPredictionTrail);
      if (keys.length > 300) {
        keys
          .sort((a, b) => (window._kalshiPredictionTrail[a]?.closeTimeMs || 0) - (window._kalshiPredictionTrail[b]?.closeTimeMs || 0))
          .slice(0, keys.length - 300)
          .forEach(k => delete window._kalshiPredictionTrail[k]);
      }

      saveKalshiTrail();
    } catch (e) {
      console.warn('[KalshiTrail] capture error:', e.message);
    }
  }

  function _toMs(v) {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : null;
  }

  function _toNum(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function _normDir(v) {
    const s = String(v || '').toUpperCase();
    if (s === 'UP' || s === 'DOWN' || s === 'FLAT') return s;
    if (s === 'YES') return 'UP';
    if (s === 'NO') return 'DOWN';
    if (s === 'BULL' || s === 'BULLISH') return 'UP';
    if (s === 'BEAR' || s === 'BEARISH') return 'DOWN';
    return null;
  }

  function _normOutcomeYN(v) {
    const s = String(v || '').toUpperCase();
    if (s === 'YES' || s === 'NO') return s;
    if (s === 'UP') return 'YES';
    if (s === 'DOWN') return 'NO';
    return null;
  }

  function _normStrikeDir(v) {
    const s = String(v || '').toLowerCase();
    if (s === 'below' || s === 'under') return 'below';
    if (s === 'above' || s === 'over' || s === 'at_least' || s === 'greater_or_equal') return 'above';
    return 'above';
  }

  function _actualFromYNWithStrike(outcomeYN, strikeDir) {
    if (outcomeYN !== 'YES' && outcomeYN !== 'NO') return null;
    const yesDir = _normStrikeDir(strikeDir) === 'below' ? 'DOWN' : 'UP';
    const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
    return outcomeYN === 'YES' ? yesDir : noDir;
  }

  function _normalizeConfidence(v) {
    const n = _toNum(v);
    if (n == null) return null;
    if (n > 1) return Math.max(0, Math.min(1, n / 100));
    return Math.max(0, Math.min(1, n));
  }

  function _triBool(v) {
    if (v === true || v === false) return v;
    if (v == null) return null;
    const normalized = String(v).trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    return null;
  }

  function _parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        const esc = inQuotes && line[i + 1] === '"';
        if (esc) {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  function parseForensicsCsv(csvText) {
    const text = String(csvText || '').trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const headers = _parseCsvLine(lines[0]).map(h => h.toLowerCase());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = _parseCsvLine(lines[i]);
      const row = {};
      headers.forEach((h, ix) => {
        row[h] = cols[ix] ?? '';
      });
      rows.push(row);
    }
    return rows;
  }

  function _csvRowToForensicsEntry(row) {
    if (!row || typeof row !== 'object') return null;
    const sym = String(
      row.sym || row.symbol || row.coin || row.asset || row.ticker_symbol || ''
    ).toUpperCase();
    if (!sym) return null;

    const ts = _toMs(row.ts ?? row.timestamp ?? row.entry_ts ?? row.open_ts ?? row.created_at);
    const settledTs = _toMs(row.settledts ?? row.settled_ts ?? row.resolved_at ?? row.close_ts);
    const modelDir = _normDir(row.modeldir ?? row.model_dir ?? row.direction ?? row.prediction);
    const actualOutcome = _normDir(row.actualoutcome ?? row.actual_outcome ?? row.actual);
    const outcomeYN = _normOutcomeYN(row.outcome ?? row.result ?? row.settle_result);
    const strikeDir = _normStrikeDir(row.strikedir ?? row.strike_dir ?? row.strike ?? row.striketype ?? row.strike_type);

    return {
      source: 'csv',
      sym,
      ticker: row.ticker || row.contract || null,
      ts,
      settledTs,
      modelDir,
      actualOutcome: actualOutcome || _actualFromYNWithStrike(outcomeYN, strikeDir),
      outcomeYN,
      modelCorrect: row.modelcorrect != null
        ? (String(row.modelcorrect).toLowerCase() === 'true' ? true
          : String(row.modelcorrect).toLowerCase() === 'false' ? false : null)
        : null,
      entryConfidence: _normalizeConfidence(row.entryprob ?? row.entry_prob ?? row.confidence ?? row.modelconf),
      entryProb: _normalizeConfidence(row.entryprob ?? row.entry_prob ?? row.confidence),
      dirConflict: String(row.dirconflict ?? row.dir_conflict ?? '').toLowerCase() === 'true',
      wickStraddle: String(row.wickstraddle ?? row.wick_straddle ?? '').toLowerCase() === 'true',
      nearRef: String(row.nearref ?? row.near_ref ?? '').toLowerCase() === 'true',
      proxyMismatch: _triBool(row.proxymismatch ?? row.proxy_mismatch),
      refDiffPct: _toNum(row.refdiffpct ?? row.ref_diff_pct),
      wickSize: _toNum(row.wicksize ?? row.wick_size),
      modelScore: _toNum(row.modelscore ?? row.model_score),
      modelConf: _normalizeConfidence(row.modelconf ?? row.model_conf),
      executionGuard: row.execution_guard || row.executionguard || null,
      predictionTrail2m: Array.isArray(row.predictiontrail2m) ? row.predictiontrail2m : [],
      closeSnapshots: Array.isArray(row.closesnapshots) ? row.closesnapshots : [],
      _raw: row,
    };
  }

  function _logEntryToForensicsEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const sym = String(e.sym || e.coin || '').toUpperCase();
    if (!sym) return null;
    const modelDir = _normDir(e.modelDir ?? e.direction ?? e.predDir);
    const outcomeYN = _normOutcomeYN(e.outcome ?? e.kalshiResult ?? e._kalshiResult);
    const strikeDir = _normStrikeDir(e._strikeDir ?? e.strikeDir ?? e.apiStrikeDir ?? e.strikeType);
    const actualOutcome = _normDir(e.actualOutcome) || _actualFromYNWithStrike(outcomeYN, strikeDir);
    const entryProb = _normalizeConfidence(e.entryProb ?? e.confidence ?? e.modelConf);
    const entryConf = _normalizeConfidence(e.modelConf ?? e.confidence ?? e.entryProb);
    return {
      source: 'kalshi-log',
      sym,
      ticker: e.ticker ?? null,
      ts: _toMs(e.ts),
      settledTs: _toMs(e.settledTs ?? e.resolved_at),
      modelDir,
      actualOutcome,
      outcomeYN,
      modelCorrect: e.modelCorrect === true ? true : e.modelCorrect === false ? false : null,
      marketCorrect: e.marketCorrect === true ? true : e.marketCorrect === false ? false : null,
      entryConfidence: entryConf,
      entryProb,
      dirConflict: !!(e._dirConflict ?? e.dirConflict),
      wickStraddle: !!(e._wickStraddle ?? e.wickStraddle),
      nearRef: !!(e._nearRef ?? e.nearRef),
      proxyMismatch: _triBool(e._proxyMismatch ?? e.proxyMismatch),
      pendingAuth: !!(e._pendingAuth),
      refDiffPct: _toNum(e.refDiffPct),
      wickSize: _toNum(e.wickSize),
      ref: _toNum(e.ref ?? e._refPrice),
      closePrice: _toNum(e.closePrice ?? e._cbSettlePrice),
      modelScore: _toNum(e.modelScore),
      modelConf: _normalizeConfidence(e.modelConf),
      executionGuard: e.executionGuard ?? null,
      mYesPct: _toNum(e.mYesPct),
      kYesPct: _toNum(e.kYesPct),
      predictionTrail2m: Array.isArray(e.predictionTrail2m) ? e.predictionTrail2m : [],
      closeSnapshots: Array.isArray(e.closeSnapshots) ? e.closeSnapshots : [],
      _raw: e,
    };
  }

  function _resolutionEntryToForensicsEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const sym = String(e.sym || e.coin || '').toUpperCase();
    if (!sym) return null;
    const modelDir = _normDir(e.modelDir ?? e.direction ?? e.predDir);
    const actualOutcome = _normDir(e.actualOutcome);
    const outcomeYN = _normOutcomeYN(e.kalshiResult ?? e.outcome ?? e.actualOutcome);
    const strikeDir = _normStrikeDir(e._strikeDir ?? e.strikeDir ?? e.apiStrikeDir ?? e.strikeType);
    return {
      source: '15m-resolution',
      sym,
      ticker: e.ticker ?? null,
      ts: _toMs(e.ts),
      settledTs: _toMs(e.settledTs ?? e.resolved_at),
      modelDir,
      actualOutcome: actualOutcome || _actualFromYNWithStrike(outcomeYN, strikeDir),
      outcomeYN,
      modelCorrect: e.modelCorrect === true ? true : e.modelCorrect === false ? false : null,
      marketCorrect: e.marketCorrect === true ? true : e.marketCorrect === false ? false : null,
      entryConfidence: _normalizeConfidence(e.entryProb ?? e.confidence),
      entryProb: _normalizeConfidence(e.entryProb ?? e.confidence),
      dirConflict: !!(e._dirConflict ?? e.dirConflict),
      wickStraddle: !!(e._wickStraddle ?? e.wickStraddle),
      nearRef: !!(e._nearRef ?? e.nearRef),
      proxyMismatch: _triBool(e._proxyMismatch ?? e.proxyMismatch),
      pendingAuth: !!(e._pendingAuth),
      refDiffPct: _toNum(e.refDiffPct),
      wickSize: _toNum(e.wickSize),
      ref: _toNum(e.refPrice ?? e.floorPrice ?? e.ref),
      closePrice: _toNum(e.cbSettlePrice ?? e.closePrice),
      modelScore: _toNum(e.modelScore),
      modelConf: _normalizeConfidence(e.modelConf ?? e.confidence),
      executionGuard: e.executionGuard ?? null,
      mYesPct: _toNum(e.mYesPct),
      kYesPct: _toNum(e.kYesPct),
      predictionTrail2m: Array.isArray(e.predictionTrail2m) ? e.predictionTrail2m : [],
      closeSnapshots: Array.isArray(e.closeSnapshots) ? e.closeSnapshots : [],
      _raw: e,
    };
  }

  function _computeSuspectSignals(entry) {
    const settleLatencyMs = (entry.settledTs != null && entry.ts != null)
      ? Math.max(0, entry.settledTs - entry.ts)
      : null;
    const rapidCollapse = settleLatencyMs != null && settleLatencyMs <= 30_000;
    const predActualConflict =
      entry.modelDir && entry.actualOutcome && entry.modelDir !== 'FLAT'
        ? entry.modelDir !== entry.actualOutcome
        : entry.modelCorrect === false;

    const highConfidence = (entry.entryConfidence ?? entry.entryProb ?? entry.modelConf ?? 0) >= 0.60;
    const confDropSignal = highConfidence && predActualConflict;

    let suspectScore = 0;
    if (confDropSignal) suspectScore += 36;
    if (rapidCollapse) suspectScore += 24;
    if (entry.proxyMismatch === true) suspectScore += 24;
    if (entry.dirConflict) suspectScore += 18;
    if (entry.wickStraddle) suspectScore += 16;
    if (entry.nearRef) suspectScore += 10;
    if (entry.pendingAuth) suspectScore += 8;
    if ((entry.refDiffPct ?? 999) < 0.15) suspectScore += 8;
    if (entry.executionGuard?.blocked || entry.executionGuard?.hardLate) suspectScore += 14;

    const latencyContributionPct = Math.max(0, Math.min(100,
      (rapidCollapse ? 45 : 10)
      + ((entry.executionGuard?.blocked || entry.executionGuard?.hardLate) ? 35 : 0)
      + ((settleLatencyMs != null && settleLatencyMs <= 18_000) ? 20 : 0)
    ));

    const slippageContributionPct = Math.max(0, Math.min(100,
      (entry.wickStraddle ? 40 : 0)
      + (entry.nearRef ? 20 : 0)
      + (entry.proxyMismatch === true ? 22 : 0)
      + (entry.refDiffPct != null ? Math.min(18, Math.max(0, (0.18 - entry.refDiffPct) * 100)) : 0)
      + (entry.wickSize != null ? Math.min(18, entry.wickSize * 8) : 0)
    ));

    return {
      settleLatencyMs,
      rapidCollapse,
      predActualConflict,
      highConfidence,
      confDropSignal,
      suspectScore,
      latencyContributionPct,
      slippageContributionPct,
    };
  }

  function classifyForensicTrade(entry) {
    const sig = _computeSuspectSignals(entry);
    const conf = entry.entryConfidence ?? entry.entryProb ?? entry.modelConf;

    if (entry.proxyMismatch === true && (entry.wickStraddle || entry.nearRef)) {
      return {
        key: 'SETTLEMENT_PROXY_MISMATCH',
        label: 'Settlement proxy mismatch near reference',
        severity: 'high',
        reason: `Proxy disagreed with authoritative result under wick/near-ref conditions${conf != null ? ` (entryConf=${Math.round(conf * 100)}%)` : ''}.`,
      };
    }

    if (sig.rapidCollapse && sig.confDropSignal) {
      return {
        key: 'LATENCY_COMPRESSION',
        label: 'Latency/compression collapse',
        severity: 'high',
        reason: `High-confidence position reversed within ${Math.round((sig.settleLatencyMs || 0) / 1000)}s close window.`,
      };
    }

    if (entry.dirConflict && sig.predActualConflict) {
      return {
        key: 'DIRECTION_CONFLICT',
        label: 'Momentum vs CDF direction conflict',
        severity: 'medium',
        reason: 'Model momentum and contract-implied direction diverged before settlement.',
      };
    }

    if (entry.wickStraddle || entry.nearRef || (entry.refDiffPct != null && entry.refDiffPct < 0.15)) {
      return {
        key: 'CLOSE_SLIPPAGE',
        label: 'Close-window slippage/precision risk',
        severity: 'medium',
        reason: 'Close price was near or through reference threshold, increasing settlement ambiguity risk.',
      };
    }

    if (sig.predActualConflict) {
      return {
        key: 'MODEL_CONFIDENCE_BREAKDOWN',
        label: 'Model confidence breakdown',
        severity: 'medium',
        reason: 'Predicted direction diverged from resolved outcome without strong structural flags.',
      };
    }

    return {
      key: 'WATCHLIST_ANOMALY',
      label: 'Watchlist anomaly',
      severity: 'low',
      reason: 'Flagged for review due to timing/quality characteristics, not a confirmed mismatch.',
    };
  }

  function _collectNearCloseTimeline(entry) {
    const timeline = [];
    const pushEvent = (ev) => {
      if (!ev || ev.ts == null) return;
      timeline.push(ev);
    };

    if (entry.ts != null) {
      pushEvent({
        ts: entry.ts,
        type: 'entry',
        confidence: entry.entryConfidence ?? entry.entryProb ?? entry.modelConf ?? null,
        modelDir: entry.modelDir ?? null,
        modelScore: entry.modelScore ?? null,
      });
    }

    (entry.predictionTrail2m || []).forEach(p => {
      const ts = _toMs(p.ts);
      const secsToClose = _toNum(p.secsToClose);
      if (secsToClose != null && secsToClose > 190) return;
      pushEvent({
        ts,
        type: 'trail-2m',
        secsToClose,
        modelDir: _normDir(p.modelDir),
        modelYesPct: _toNum(p.modelYesPct),
        kalshiYesPct: _toNum(p.kalshiYesPct),
        modelScore: _toNum(p.modelScore),
        dirConflict: !!p.dirConflict,
      });
    });

    (entry.closeSnapshots || []).forEach(s => {
      const ts = _toMs(s.ts ?? s.timestamp);
      const secsToClose = _toNum(s.secsLeft ?? s.secsToClose);
      if (secsToClose != null && secsToClose > 190) return;
      pushEvent({
        ts,
        type: 'close-snapshot',
        secsToClose,
        kalshiProb: _toNum(s.kalshiProb ?? s.kYesPct),
        modelProb: _toNum(s.modelProb ?? s.modelYesPct),
      });
    });

    if (entry.settledTs != null) {
      pushEvent({
        ts: entry.settledTs,
        type: 'settled',
        outcome: entry.actualOutcome ?? null,
        outcomeYN: entry.outcomeYN ?? null,
        proxyMismatch: entry.proxyMismatch ?? null,
      });
    }

    timeline.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return timeline;
  }

  function _getForensicsDataset(options = {}) {
    const out = [];
    (window._kalshiLog || []).forEach(e => {
      const n = _logEntryToForensicsEntry(e);
      if (n) out.push(n);
    });
    (window._15mResolutionLog || []).forEach(e => {
      const n = _resolutionEntryToForensicsEntry(e);
      if (n) out.push(n);
    });

    let csvRows = [];
    if (Array.isArray(options.csvRows)) csvRows = options.csvRows;
    else if (typeof options.csvText === 'string' && options.csvText.trim()) csvRows = parseForensicsCsv(options.csvText);

    csvRows.forEach(row => {
      const n = _csvRowToForensicsEntry(row);
      if (n) out.push(n);
    });

    const dedup = new Map();
    out.forEach(e => {
      const id = [e.source, e.sym, e.ticker || '', e.ts || '', e.settledTs || '', e.modelDir || ''].join('|');
      if (!dedup.has(id)) dedup.set(id, e);
    });

    return Array.from(dedup.values());
  }

  function identifySuspectContracts(options = {}) {
    const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 45;
    const topN = Number.isFinite(Number(options.topN)) ? Math.max(1, Number(options.topN)) : 12;
    const now = Date.now();
    const lookbackMs = Number.isFinite(Number(options.lookbackMs)) ? Number(options.lookbackMs) : 24 * 3600 * 1000;
    const cutoff = now - lookbackMs;

    const data = _getForensicsDataset(options)
      .filter(e => (e.ts || e.settledTs || 0) >= cutoff)
      .map(e => {
        const sig = _computeSuspectSignals(e);
        const classification = classifyForensicTrade(e);
        return {
          ...e,
          ...sig,
          classification,
        };
      })
      .filter(e => e.suspectScore >= minScore)
      .sort((a, b) => {
        if ((b.suspectScore || 0) !== (a.suspectScore || 0)) return (b.suspectScore || 0) - (a.suspectScore || 0);
        return (b.settledTs || b.ts || 0) - (a.settledTs || a.ts || 0);
      });

    return {
      generatedAt: new Date().toISOString(),
      scanned: _getForensicsDataset(options).length,
      suspects: data.slice(0, topN).map(e => ({
        sym: e.sym,
        source: e.source,
        ticker: e.ticker,
        ts: e.ts,
        settledTs: e.settledTs,
        entryConfidence: e.entryConfidence,
        modelDir: e.modelDir,
        actualOutcome: e.actualOutcome,
        modelCorrect: e.modelCorrect,
        suspectScore: e.suspectScore,
        flags: {
          dirConflict: e.dirConflict,
          wickStraddle: e.wickStraddle,
          nearRef: e.nearRef,
          proxyMismatch: e.proxyMismatch,
          pendingAuth: e.pendingAuth,
          rapidCollapse: e.rapidCollapse,
        },
        settleLatencyMs: e.settleLatencyMs,
        classification: e.classification,
      })),
    };
  }

  function replaySuspectTimeline(suspect, options = {}) {
    if (!suspect) return null;
    const base = {
      ...suspect,
      ..._computeSuspectSignals(suspect),
    };
    const classification = classifyForensicTrade(base);
    const timeline = _collectNearCloseTimeline(base);
    const settlementSource = base.source === 'kalshi-log'
      ? (base.pendingAuth ? 'proxy_then_authoritative' : 'authoritative_or_proxy')
      : base.source === '15m-resolution'
        ? 'resolution_event'
        : 'csv';

    return {
      sym: base.sym,
      ticker: base.ticker || null,
      source: base.source,
      entry: {
        ts: base.ts,
        confidence: base.entryConfidence ?? base.entryProb ?? base.modelConf ?? null,
        modelDir: base.modelDir ?? null,
        modelScore: base.modelScore ?? null,
      },
      nearCloseSnapshots: timeline.filter(t => t.type !== 'entry' && t.type !== 'settled'),
      settlement: {
        ts: base.settledTs,
        source: settlementSource,
        outcome: base.actualOutcome ?? null,
        outcomeYN: base.outcomeYN ?? null,
        modelCorrect: base.modelCorrect,
        mismatch: base.proxyMismatch === true,
        modelConflict: base.predActualConflict === true,
      },
      indicators: {
        directionConflict: !!base.dirConflict,
        wickStraddle: !!base.wickStraddle,
        nearRef: !!base.nearRef,
        refDiffPct: base.refDiffPct,
        wickSizePct: base.wickSize,
      },
      estimatedContribution: {
        latencyPct: base.latencyContributionPct,
        slippagePct: base.slippageContributionPct,
        settleLatencyMs: base.settleLatencyMs,
      },
      classification,
      conciseRootCause: `${classification.label}: ${classification.reason}`,
      timeline,
      includeRaw: options.includeRaw ? base._raw : undefined,
    };
  }

  function replayCollapsedContractsIncident(options = {}) {
    const suspects = identifySuspectContracts({ ...options, topN: options.topN || 2 });
    const data = _getForensicsDataset(options).map(e => ({ ...e, ..._computeSuspectSignals(e) }));

    const suspectReplays = suspects.suspects.map(s => {
      const match = data.find(e =>
        e.sym === s.sym
        && (e.ticker || '') === (s.ticker || '')
        && (e.ts || 0) === (s.ts || 0)
      );
      return replaySuspectTimeline(match || s, options);
    }).filter(Boolean);

    return {
      generatedAt: new Date().toISOString(),
      incident: {
        label: options.label || 'collapsed-contracts-60-to-2',
        targetCollapse: options.targetCollapse || '60%->2% in ~18s',
      },
      suspects: suspectReplays,
      rootCauseSummary: suspectReplays.map(r => ({
        sym: r.sym,
        ticker: r.ticker,
        classification: r.classification.key,
        severity: r.classification.severity,
        concise: r.conciseRootCause,
      })),
    };
  }

  window.KalshiForensics = {
    parseCsv: parseForensicsCsv,
    identifySuspects: identifySuspectContracts,
    replay: replayCollapsedContractsIncident,
    classify: classifyForensicTrade,
    replayTrade: replaySuspectTimeline,
  };

  // ── Clock-aligned quarter-hour scheduler ─────────────────────────────────
  // Returns ms until the next :00/:15/:30/:45 boundary, minimum 500ms.
  function msUntilNextQuarter() {
    const now = new Date();
    const ms = (now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    const qMs = 15 * 60 * 1000;
    return Math.max(500, Math.ceil((ms + 1) / qMs) * qMs - ms);
  }
  // Calls callback at each :00/:15/:30/:45. Drift-free via recursive setTimeout.
  function scheduleOnQuarterHours(callback) {
    let _t = null;
    function tick() { callback(); _t = setTimeout(tick, msUntilNextQuarter()); }
    _t = setTimeout(tick, msUntilNextQuarter());
    return { cancel() { clearTimeout(_t); } };
  }
  const PREDICTION_HORIZONS = [1, 5, 10, 15];
  let predictionControlsExpanded = false;
  let predictionSortBy = 'quality';
  let predictionHideUnavailable = false;
  let predictionOnlyActionable = false;
  let predictionCompact = false;
  let theme = 'dark';
  const chartIndicators = { ema9: true, ema21: true, vwap: true, support: true, resistance: true, trend: true };
  const UI_STORAGE_KEY = 'we-cfm-ui-state-v1';
  const uiState = (() => {
    try {
      const raw = localStorage.getItem(UI_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
    // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();
  if (uiState.currentView) currentView = uiState.currentView;
  if (Number.isFinite(uiState.refreshSecs)) refreshSecs = uiState.refreshSecs;
  if (uiState.theme === 'light' || uiState.theme === 'dark') theme = uiState.theme;
  predictionControlsExpanded = !!uiState.predictionControlsExpanded;
  predictionSortBy = uiState.predictionSortBy || predictionSortBy;
  predictionHideUnavailable = !!uiState.predictionHideUnavailable;
  predictionOnlyActionable = !!uiState.predictionOnlyActionable;
  predictionCompact = !!uiState.predictionCompact;

  function persistUIState() {
    try {
      localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({
        currentView,
        refreshSecs,
        theme,
        predictionControlsExpanded,
        predictionSortBy,
        predictionHideUnavailable,
        predictionOnlyActionable,
        predictionCompact,
      }));
    } catch { }
  }
  const SCREENER_GECKO_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', LTC: 'litecoin', SOL: 'solana', AVAX: 'avalanche-2',
    DOT: 'polkadot', ATOM: 'cosmos', POL: 'polygon-ecosystem-token', ADA: 'cardano',
    XTZ: 'tezos', ARB: 'arbitrum', OP: 'optimism', SUI: 'sui', APT: 'aptos',
    SEI: 'sei-network', NEAR: 'near', BONK: 'bonk', PEPE: 'pepe', WIF: 'dogwifcoin',
    FLOKI: 'floki', JUP: 'jupiter-exchange-solana', AERO: 'aerodrome-finance',
    DYDX: 'dydx-chain', PYTH: 'pyth-network', RNDR: 'render-token', FET: 'fetch-ai',
    TAO: 'bittensor', XLM: 'stellar', LINK: 'chainlink', UNI: 'uniswap',
    AAVE: 'aave', ICP: 'internet-computer', HBAR: 'hedera-hashgraph',
    XRP: 'ripple', DOGE: 'dogecoin', HYPE: 'hyperliquid', BNB: 'binancecoin',
  };

  // ---- DOM refs ----
  const $ = (s, c) => (c || document).querySelector(s);
  const content = $('#content');
  const feedStatus = $('#feedStatus');
  const feedDot = feedStatus ? feedStatus.querySelector('.pulse-dot') : null;
  const feedText = $('#feedStatusText');
  const lastUpdate = $('#lastUpdate');
  const pageTitle = $('#pageTitle');

  function activateNav(view) {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    const activeBtn = document.querySelector(`.nav-btn[data-view="${view}"]`);
    if (pageTitle && activeBtn) pageTitle.textContent = activeBtn.textContent.trim();
  }

  // ---- Theme toggle ----
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  const themeBtn = $('[data-theme-toggle]');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
      persistUIState();
      themeBtn.innerHTML = theme === 'dark'
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      if (candleChart) {
        const bg = theme === 'dark' ? '#111318' : '#ffffff';
        const grid = theme === 'dark' ? '#252932' : '#dde0ea';
        candleChart.applyOptions({ layout: { background: { color: bg }, textColor: theme === 'dark' ? '#7880a0' : '#6470a0' }, grid: { vertLines: { color: grid }, horzLines: { color: grid } } });
      }
    });
  }
  activateNav(currentView);

  // ---- Sidebar nav ----
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _userInteractedWithNav = true;
      if (currentView === 'hourly-ranges' && btn.dataset.view !== 'hourly-ranges') {
        window.HourlyRangesPanel?.stopAutoLoad?.();
      }
      currentView = btn.dataset.view;
      activateNav(currentView);
      persistUIState();
      updateHeaderSummary();
      render();
      syncPredictionRefresh();
      // close mobile sidebar
      $('#sidebar')?.classList.remove('open');
    });
  });

  // ---- Mobile menu ----
  const menuBtn = $('#menuBtn');
  if (menuBtn) menuBtn.addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // ---- Refresh control ----
  const refreshBtn = $('#refreshBtn');
  const refreshSel = $('#refreshInterval');
  if (refreshBtn) refreshBtn.addEventListener('click', () => fetchAll(true));
  if (refreshSel) refreshSel.addEventListener('change', e => {
    refreshSecs = parseInt(e.target.value, 10);
    persistUIState();
    resetTimer();
  });
  if (refreshSel) refreshSel.value = String(refreshSecs);

  // ================================================================
  // API LAYER — Crypto.com Exchange public endpoints (no auth)
  // ================================================================

  const CDC_BASE = 'https://api.crypto.com/exchange/v1/public';
  const GECKO_BASE = 'https://api.coingecko.com/api/v3';
  const GECKO_PRO_BASE = 'https://pro-api.coingecko.com/api/v3';
  const COINCAP_BASE = 'https://rest.coincap.io/v3';
  const BIN_BASE = 'https://data-api.binance.vision/api/v3';   // market-data fallback after WS
  const MEXC_BASE = 'https://api.mexc.com/api/v3';
  const PYTH_HERMES = 'https://hermes.pyth.network';
  const PYTH_LAZER_PROXIES = [
    'pyth-lazer-proxy-1.dourolabs.app',
    'pyth-lazer-proxy-2.dourolabs.app',
    'pyth-lazer-proxy-3.dourolabs.app',
  ];
  const PYTH_HISTORY_BASE = 'https://pyth.dourolabs.app';
  const HL_BASE = 'https://api.hyperliquid.xyz';
  const CB_BASE = 'https://api.exchange.coinbase.com';

  function resolveRuntimeKeyLocal(name) {
    try {
      if (typeof window.resolveRuntimeKey === 'function') return window.resolveRuntimeKey(name) || '';
    } catch (_) { }
    try {
      return window.__env?.[name] || window.desktopApp?.publicEnv?.[name] || '';
    } catch (_) {
      return '';
    }
  }

  function coinGeckoRequest(path, params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== '') qs.set(k, String(v));
    });
    const fallbackKey = String(resolveRuntimeKeyLocal('COINGECKO_API_KEY') || '').trim();
    const fallbackTier = String(resolveRuntimeKeyLocal('COINGECKO_API_TIER') || '').trim().toLowerCase();
    const fallbackUsePro = !!fallbackKey && /^(pro|paid|enterprise)$/.test(fallbackTier);
    const baseUrl = fallbackUsePro ? GECKO_PRO_BASE : GECKO_BASE;
    const rawUrl = `${baseUrl}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;
    const url = typeof window.coinGeckoUrl === 'function' ? window.coinGeckoUrl(rawUrl) : rawUrl;
    const baseOptions = { headers: { Accept: 'application/json' } };
    const options = typeof window.withCoinGeckoAuth === 'function'
      ? window.withCoinGeckoAuth(url, baseOptions)
      : baseOptions;
    if (typeof window.withCoinGeckoAuth !== 'function' && fallbackKey) {
      const headerName = fallbackUsePro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
      options.headers = { ...(options.headers || {}), [headerName]: fallbackKey };
    }
    return { url, options };
  }

  // Binance: instrument → Binance USDT symbol (covers all 37 WATCHLIST coins)
  const BIN_ALL_SYMS = {
    'BTCUSD': 'BTCUSDT', 'ETHUSD': 'ETHUSDT', 'LTCUSD': 'LTCUSDT',
    'SOLUSD': 'SOLUSDT', 'AVAXUSD': 'AVAXUSDT', 'DOTUSD': 'DOTUSDT',
    'ATOMUSD': 'ATOMUSDT', 'POLUSD': 'POLUSDT', 'ADAUSD': 'ADAUSDT',
    'XTZUSD': 'XTZUSDT', 'ARBUSD': 'ARBUSDT', 'OPUSD': 'OPUSDT',
    'SUIUSD': 'SUIUSDT', 'APTUSD': 'APTUSDT', 'SEIUSD': 'SEIUSDT',
    'NEARUSD': 'NEARUSDT', 'BONKUSD': 'BONKUSDT', 'PEPEUSD': 'PEPEUSDT',
    'WIFUSD': 'WIFUSDT', 'FLOKIUSD': 'FLOKIUSDT', 'JUPUSD': 'JUPUSDT',
    'DYDXUSD': 'DYDXUSDT', 'PYTHUSD': 'PYTHUSDT',
    'RENDERUSD': 'RENDERUSDT', 'FETUSD': 'FETUSDT', 'TAOUSD': 'TAOUSDT',
    'XLMUSD': 'XLMUSDT', 'LINKUSD': 'LINKUSDT', 'UNIUSD': 'UNIUSDT',
    'AAVEUSD': 'AAVEUSDT', 'ICPUSD': 'ICPUSDT', 'HBARUSD': 'HBARUSDT',
    'XRPUSD': 'XRPUSDT', 'DOGEUSD': 'DOGEUSDT',
    'BNBUSD': 'BNBUSDT',
  };
  const BIN_ALL_SYM_TO_INSTRUMENT = Object.fromEntries(
    Object.entries(BIN_ALL_SYMS).map(([instr, binSym]) => [binSym, instr])
  );

  // Coinbase Exchange products (expanded — 404s caught gracefully per-coin)
  const COINBASE_PRODUCTS = {
    'BTC-USD': 'BTCUSD', 'ETH-USD': 'ETHUSD', 'SOL-USD': 'SOLUSD',
    'XRP-USD': 'XRPUSD', 'DOGE-USD': 'DOGEUSD', 'BNB-USD': 'BNBUSD',
    'HYPE-USD': 'HYPEUSD', 'LTC-USD': 'LTCUSD', 'AVAX-USD': 'AVAXUSD',
    'LINK-USD': 'LINKUSD', 'UNI-USD': 'UNIUSD', 'AAVE-USD': 'AAVEUSD',
    'DOT-USD': 'DOTUSD', 'ATOM-USD': 'ATOMUSD', 'NEAR-USD': 'NEARUSD',
    'ADA-USD': 'ADAUSD', 'XLM-USD': 'XLMUSD', 'ICP-USD': 'ICPUSD',
    'ARB-USD': 'ARBUSD', 'OP-USD': 'OPUSD', 'SUI-USD': 'SUIUSD',
    'APT-USD': 'APTUSD', 'RENDER-USD': 'RENDERUSD',
  };

  // Kraken response key → instrument (Kraken uses nonstandard pair names)
  const KRAKEN_RESPONSE_MAP = {
    'XXBTZUSD': 'BTCUSD', 'XBTUSD': 'BTCUSD',
    'XETHZUSD': 'ETHUSD', 'ETHUSD': 'ETHUSD',
    'SOLUSD': 'SOLUSD', 'XSOLUSD': 'SOLUSD',
    'XXRPZUSD': 'XRPUSD', 'XRPUSD': 'XRPUSD',
    'XDGEUSD': 'DOGEUSD', 'DOGEUSD': 'DOGEUSD',
    'BNBUSD': 'BNBUSD', 'HYPEUSD': 'HYPEUSD',
    'XLTCZUSD': 'LTCUSD', 'LTCUSD': 'LTCUSD',
    'XXLMZUSD': 'XLMUSD', 'XLMUSD': 'XLMUSD',
    'LINKUSD': 'LINKUSD', 'XTZUSD': 'XTZUSD',
    'ADAUSD': 'ADAUSD', 'ATOMUSD': 'ATOMUSD',
    'DOTUSD': 'DOTUSD', 'NEARUSD': 'NEARUSD',
    'AVAXUSD': 'AVAXUSD', 'UNIUSD': 'UNIUSD',
    'AAVEUSD': 'AAVEUSD',
  };

  // Pyth Network feed IDs — confirmed via hermes.pyth.network/v2/price_feeds
  // Covers 33/37 WATCHLIST coins. Missing: XTZUSD, PEPEUSD, AEROUSD, HYPEUSD → Binance/Gecko fills
  const PYTH_FEEDS = {
    'BTCUSD': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    'ETHUSD': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    'SOLUSD': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    'XRPUSD': 'ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
    'DOGEUSD': 'dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
    'BNBUSD': '2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
    'AVAXUSD': '93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7',
    'DOTUSD': 'ca3eed9b267293f6595901c734c7525ce8ef49adafe8284606ceb307afa2ca5b',
    'ATOMUSD': 'b00b60f88b03a6a625a8d1c048c3f66653edf217439983d037e7222c4e612819',
    'LTCUSD': '6e3f3fa8253588df9326580180233eb791e03b443a3ba7a1d892e73874e19a54',
    'XLMUSD': 'b7a8eba68a997cd0210c2e1e4ee811ad2d174b3611c22d9ebf16f4cb7e9ba850',
    'LINKUSD': '8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
    'ADAUSD': '2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d',
    'UNIUSD': '78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501',
    'AAVEUSD': '2b9ab1e972a281585084148ba1389800799bd4be63b957507db1349314e47445',
    'NEARUSD': 'c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750',
    'ARBUSD': '3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5',
    'OPUSD': '385f64d993f7b77d8182ed5003d97c60aa3361f3cecfe711544d2d59165e9bdf',
    'SUIUSD': '23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
    'APTUSD': '03ae4db29ed4ae33d323568895aa00337e658e348b37509f5372ae51f0af00d5',
    'SEIUSD': '53614f1cb0c031d4af66c04cb9c756234adad0e1cee85303795091499a4084eb',
    'BONKUSD': '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
    'WIFUSD': '4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
    'JUPUSD': '0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
    'FLOKIUSD': '6b1381ce7e874dc5410b197ac8348162c0dd6c0d4c9cd6322672d6c2b1d58293',
    'RENDERUSD': '3d4a2bd9535be6ce8059d75eadeba507b043257321aa544717c56fa19b49e35d',
    'DYDXUSD': '6489800bb8974169adfe35937bf6736507097d13c190d760c557108c7e93a81b',
    'PYTHUSD': '0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff',
    'FETUSD': '7da003ada32eabbac855af3d22fcf0fe692cc589f0cfd5ced63cf0bdcc742efe',
    'TAOUSD': '410f41de235f2db824e562ea7ab2d3d3d4ff048316c61d629c0b93f58584e1af',
    'HBARUSD': '3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd',
    'ICPUSD': 'c9907d786c5821547777780a1e4f89484f3417cb14dd244f2b0a34ea7a554d67',
    'POLUSD': 'ffd11c5a1cfd42f80afb2df4d9f264c15f956d68153335374ec10722edd70472',
  };
  const PYTH_ID_TO_INSTRUMENT = Object.fromEntries(
    Object.entries(PYTH_FEEDS).map(([instr, id]) => [id, instr])
  );
  // Pyth Lazer numeric feed IDs → instrument (IDs confirmed via proxy scan)
  const LAZER_ID_INSTR = { 1: 'BTCUSD', 2: 'ETHUSD', 6: 'SOLUSD', 10: 'DOGEUSD', 14: 'XRPUSD', 15: 'BNBUSD' };
  // History API symbol strings for OHLC candle fetching
  const INSTR_TO_PYTH_SYM = {
    'BTCUSD': 'Crypto.BTC/USD', 'ETHUSD': 'Crypto.ETH/USD', 'SOLUSD': 'Crypto.SOL/USD',
    'XRPUSD': 'Crypto.XRP/USD', 'DOGEUSD': 'Crypto.DOGE/USD', 'BNBUSD': 'Crypto.BNB/USD',
    'AVAXUSD': 'Crypto.AVAX/USD', 'LINKUSD': 'Crypto.LINK/USD', 'ADAUSD': 'Crypto.ADA/USD',
    'LTCUSD': 'Crypto.LTC/USD', 'DOTUSD': 'Crypto.DOT/USD', 'UNIUSD': 'Crypto.UNI/USD',
    'NEARUSD': 'Crypto.NEAR/USD', 'ARBUSD': 'Crypto.ARB/USD', 'OPUSD': 'Crypto.OP/USD',
    'SUIUSD': 'Crypto.SUI/USD', 'APTUSD': 'Crypto.APT/USD', 'ATOMUSD': 'Crypto.ATOM/USD',
    'XLMUSD': 'Crypto.XLM/USD', 'AAVEUSD': 'Crypto.AAVE/USD', 'PYTHUSD': 'Crypto.PYTH/USD',
    'SEIUSD': 'Crypto.SEI/USD', 'BONKUSD': 'Crypto.BONK/USD', 'WIFUSD': 'Crypto.WIF/USD',
    'JUPUSD': 'Crypto.JUP/USD', 'DYDXUSD': 'Crypto.DYDX/USD', 'FETUSD': 'Crypto.FET/USD',
    'ICPUSD': 'Crypto.ICP/USD', 'HBARUSD': 'Crypto.HBAR/USD', 'POLUSD': 'Crypto.POL/USD',
    'RENDERUSD': 'Crypto.RENDER/USD', 'TAOUSD': 'Crypto.TAO/USD', 'FLOKIUSD': 'Crypto.FLOKI/USD',
  };

  // Hyperliquid sym → instrument. kXXX = 1000x contracts (price * 0.001 = real price)
  const HL_SYM_MAP = {
    'BTC': 'BTCUSD', 'ETH': 'ETHUSD', 'SOL': 'SOLUSD', 'XRP': 'XRPUSD',
    'DOGE': 'DOGEUSD', 'BNB': 'BNBUSD', 'HYPE': 'HYPEUSD', 'AVAX': 'AVAXUSD',
    'DOT': 'DOTUSD', 'ATOM': 'ATOMUSD', 'ADA': 'ADAUSD', 'ARB': 'ARBUSD',
    'OP': 'OPUSD', 'SUI': 'SUIUSD', 'APT': 'APTUSD', 'SEI': 'SEIUSD',
    'NEAR': 'NEARUSD', 'WIF': 'WIFUSD', 'JUP': 'JUPUSD', 'DYDX': 'DYDXUSD',
    'PYTH': 'PYTHUSD', 'RENDER': 'RENDERUSD', 'FET': 'FETUSD', 'TAO': 'TAOUSD',
    'XLM': 'XLMUSD', 'LINK': 'LINKUSD', 'UNI': 'UNIUSD', 'AAVE': 'AAVEUSD',
    'ICP': 'ICPUSD', 'HBAR': 'HBARUSD', 'POL': 'POLUSD', 'LTC': 'LTCUSD',
    'XTZ': 'XTZUSD', 'AERO': 'AEROUSD',
    'kBONK': 'BONKUSD', 'kPEPE': 'PEPEUSD', 'kFLOKI': 'FLOKIUSD',
  };
  const HL_K_COINS = new Set(['kBONK', 'kPEPE', 'kFLOKI']);

  // ---- Shared HTTP cache: prevents duplicate CDC calls across engines ----
  // CFM engine and predictions.js also hit CDC tickers.
  // This cache lets them reuse our fetch if it's fresh (<8 seconds old).
  window._sharedTickerCache = { data: null, age: 0 };

  // Normalize short-form CDC API field names to readable names
  function normalizeTicker(t) {
    return {
      instrument_name: (t.i || t.instrument_name || '').replace(/_/g, ''),
      last: t.a ?? t.last,
      high: t.h ?? t.high,
      low: t.l ?? t.low,
      change: t.c ?? t.change,
      best_bid: t.b ?? t.best_bid,
      best_ask: t.k ?? t.best_ask,
      best_bid_size: t.bs ?? t.best_bid_size,
      best_ask_size: t.ks ?? t.best_ask_size,
      volume: t.v ?? t.volume,
      volume_value: t.vv ?? t.volume_value,
      timestamp: t.t ?? t.timestamp,
      source: 'crypto.com',
    };
  }

  function fetchWithTimeout(url, timeoutMs = 15000, options = {}) {
    const {
      schedulerLane = null,
      schedulerProvider = null,
      schedulerDelayMs = 0,
      schedulerDedupeKey = null,
      schedulerPriorityBoost = 0,
      schedulerBoundary = null,
      ...fetchOptions
    } = options || {};

    const runFetch = () => {
      const ctrl = new AbortController();
      const tid = setTimeout(
        () => {
          try {
            ctrl.abort(new DOMException(`App fetch timed out after ${timeoutMs}ms`, 'TimeoutError'));
          } catch (_) {
            try { ctrl.abort(); } catch (_) { }
          }
        },
        timeoutMs
      );
      const fetchImpl = window.throttledFetch || fetch;
      return fetchImpl(url, { ...fetchOptions, signal: ctrl.signal }).finally(() => clearTimeout(tid));
    };

    const scheduler = window._signalScheduler;
    if (!scheduler) return runFetch();

    return scheduler.schedule(runFetch, {
      lane: schedulerLane || scheduler.inferLaneFromUrl?.(url, 'price') || 'price',
      provider: schedulerProvider || scheduler.inferProviderFromUrl?.(url) || 'default',
      delayMs: schedulerDelayMs,
      boundary: schedulerBoundary || null,
      priorityBoost: schedulerPriorityBoost,
      dedupeKey: schedulerDedupeKey || `${String(fetchOptions.method || 'GET').toUpperCase()}:${url}`,
      tag: `app:${url}`,
    });
  }

  function mapPythLazerPricesToTickers(prices) {
    const result = [];
    for (const [instr, data] of Object.entries(prices || {})) {
      if (!data || typeof data !== 'object') continue;
      result.push({
        instrument_name: instr,
        last: data.last,
        best_bid: data.best_bid,
        best_ask: data.best_ask,
        high: data.last,
        low: data.last,
        change: 0,
        volume: 0,
        volume_value: 0,
        timestamp: data.timestamp || Date.now(),
        source: 'pyth-lazer',
      });
    }
    return result;
  }

  async function fetchTickers() {
    // Check shared cache first (may have been populated by CFM engine)
    const cache = window._sharedTickerCache;
    if (cache.data && Date.now() - cache.age < 20000) {
      return cache.data;
    }
    const res = await fetchWithTimeout(`${CDC_BASE}/get-tickers`, 15000);  // 15s for Stockholm/DERP routing
    if (!res.ok) throw new Error(`Tickers HTTP ${res.status}`);
    const json = await res.clone().json();
    if (json.code !== 0) throw new Error(`Tickers error code ${json.code}`);
    const normalized = json.result.data.map(normalizeTicker);
    // Populate shared cache for other engines
    window._sharedTickerCache = { data: normalized, raw: json.result.data, age: Date.now() };
    return normalized;
  }

  function findCoinByInstrument(instrument) {
    return WATCHLIST.find(c => c.instrument === instrument)
      || PORTFOLIO_HOLDINGS.find(c => c.instrument === instrument)
      || PREDICTION_COINS.find(c => c.instrument === instrument)
      || null;
  }

  function geckoIdForInstrument(instrument) {
    const coin = findCoinByInstrument(instrument);
    if (!coin) return null;
    return coin.geckoId || SCREENER_GECKO_IDS[coin.sym] || null;
  }

  function trackedMarketCoins() {
    const byInstrument = new Map();
    [...WATCHLIST, ...PORTFOLIO_HOLDINGS, ...PREDICTION_COINS].forEach(coin => {
      if (!coin?.instrument) return;
      if (!byInstrument.has(coin.instrument)) {
        byInstrument.set(coin.instrument, { ...coin, geckoId: geckoIdForInstrument(coin.instrument) });
      }
    });
    return Array.from(byInstrument.values());
  }

  async function fetchSupplementalTickers(rawTickers) {
    const existing = new Set((rawTickers || []).map(t => t.instrument_name));
    const targets = trackedMarketCoins()
      .filter(c => !existing.has(c.instrument))
      .filter(c => c.geckoId);

    if (!targets.length) return [];

    // Backoff guard — _lastGeckoSupplementalTs stores the next allowed call time
    if (_lastGeckoSupplementalTs && Date.now() < _lastGeckoSupplementalTs) return _lastGeckoSupplementalResult;

    const ids = Array.from(new Set(targets.map(t => t.geckoId))).join(',');
    let res;
    try {
      const cgReq = coinGeckoRequest('/coins/markets', {
        vs_currency: 'usd',
        ids,
        order: 'market_cap_desc',
        sparkline: 'false',
        price_change_percentage: '24h',
      });
      if (typeof window._proxyOrchestrator !== 'undefined' && window._proxyOrchestrator) {
        const data = await window._proxyOrchestrator.fetch(cgReq.url, {
          endpoint: 'coingecko',
          headers: cgReq.options.headers,
        });
        res = { ok: true, json: async () => data };
      } else {
        res = await fetchWithTimeout(cgReq.url, 20000, {
          ...cgReq.options,
          schedulerLane: 'supplemental',
          schedulerProvider: 'coingecko',
        });
      }
    } catch (e) {
      const msg = String(e?.message || e || '');
      const timeoutHit = /timed out|abort|timeout/i.test(msg);
      _lastGeckoSupplementalTs = Date.now() + (timeoutHit ? 10 * 60_000 : 5 * 60_000);
      console.warn(`[GeckoSupplemental] ${timeoutHit ? 'timeout' : 'network error'}; backing off ${(Math.round((_lastGeckoSupplementalTs - Date.now()) / 1000))}s`);
      return _lastGeckoSupplementalResult;
    }
    if (!res.ok) {
      // Geckos often hard-throttle shared egress IPs — lock aggressively.
      if (res.status === 401 || res.status === 403) _lastGeckoSupplementalTs = Date.now() + 60 * 60_000;
      else if (res.status === 429) _lastGeckoSupplementalTs = Date.now() + 10 * 60_000;
      else _lastGeckoSupplementalTs = Date.now() + 5 * 60_000;
      console.warn(`[GeckoSupplemental] HTTP ${res.status}; backing off ${(Math.round((_lastGeckoSupplementalTs - Date.now()) / 1000))}s`);
      return _lastGeckoSupplementalResult;
    }
    const rows = await res.json();
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));

    const result = targets
      .map(coin => {
        const row = byId[coin.geckoId];
        if (!row) return null;
        return {
          instrument_name: coin.instrument,
          last: row.current_price ?? 0,
          high: row.high_24h ?? row.current_price ?? 0,
          low: row.low_24h ?? row.current_price ?? 0,
          change: (row.price_change_percentage_24h_in_currency ?? row.price_change_percentage_24h ?? 0) / 100,
          best_bid: null,
          best_ask: null,
          best_bid_size: '',
          best_ask_size: '',
          volume: row.total_volume ?? 0,
          volume_value: row.total_volume ?? 0,
          timestamp: Date.now(),
          source: 'coingecko',
        };
      })
      .filter(Boolean);

    _lastGeckoSupplementalTs = Date.now() + 3 * 60_000;  // keep Gecko as sparse fallback
    _lastGeckoSupplementalResult = result;
    return result;
  }

  function unwrapKalshiIpcPayload(response) {
    const outer = (response && typeof response === 'object') ? response : {};
    const envelope = Object.prototype.hasOwnProperty.call(outer, 'data') ? outer.data : outer;
    const payload = (envelope && typeof envelope === 'object' && Object.prototype.hasOwnProperty.call(envelope, 'data'))
      ? envelope.data
      : envelope;
    const outerSuccess = typeof outer.success === 'boolean' ? outer.success : true;
    const envelopeSuccess = (envelope && typeof envelope.success === 'boolean') ? envelope.success : true;
    return {
      success: outerSuccess && envelopeSuccess,
      payload: (payload && typeof payload === 'object') ? payload : null,
      error: outer.error || envelope?.error || null,
      status: outer.status || null,
    };
  }

  // ---- Kalshi Prediction Markets — Real-time sentiment data ----
  async function fetchKalshiData() {
    try {
      // Guard: only run when renderer bridge + Electron IPC are available.
      const hasKalshiBridge = !!window.Kalshi;
      const hasElectronIpc = typeof window.electron?.invoke === 'function';
      if (!hasKalshiBridge || !hasElectronIpc) {
        const now = Date.now();
        if (_kalshiIpcWasAvailable !== false || (now - _kalshiIpcWarnTs) > 60000) {
          console.warn('[Kalshi] IPC unavailable; skipping Kalshi fetch until Electron bridge is ready');
          _kalshiIpcWarnTs = now;
        }
        _kalshiIpcWasAvailable = false;
        window._kalshiSnapshot = null;
        return;
      }

      if (_kalshiIpcWasAvailable === false) {
        console.log('[Kalshi] IPC restored; Kalshi polling resumed');
      }
      _kalshiIpcWasAvailable = true;

      // Get markets (limit to top 100 by volume)
      const marketsRes = await window.Kalshi.getMarkets({ limit: 100, status: 'open' });
      const marketsParsed = unwrapKalshiIpcPayload(marketsRes);
      const markets = Array.isArray(marketsParsed.payload?.markets) ? marketsParsed.payload.markets : [];
      if (!marketsParsed.success || !markets.length) {
        console.warn('[Kalshi] Markets fetch failed:', marketsParsed.error || 'No open markets returned');
        return;
      }

      // Get balance for portfolio context (Disabled per user request)
      // const balanceRes = await window.Kalshi.getBalance();
      // const balanceParsed = unwrapKalshiIpcPayload(balanceRes);
      // const balance = balanceParsed.success ? (balanceParsed.payload?.balance ?? null) : null;
      const balance = null;

      // Store Kalshi snapshot
      window._kalshiSnapshot = {
        timestamp: Date.now(),
        markets,
        balance,
        count: markets.length,
      };

      // Build quick lookup by market ticker
      const kalshiByTicker = {};
      markets.forEach(m => {
        kalshiByTicker[m.market_ticker] = {
          price: parseFloat(m.last_price),      // 0-100 probability
          volume: parseFloat(m.volume),          // 24h volume
          timestamp: Date.now(),
        };
      });
      window._kalshiByTicker = kalshiByTicker;

      console.log(`[Kalshi] Loaded ${markets.length} markets, balance: $${balance}`);
    } catch (error) {
      const msg = String(error?.message || error || 'unknown error');
      const now = Date.now();
      if (!msg.includes('Electron IPC not available') || (now - _kalshiIpcWarnTs) > 60000) {
        console.warn('[Kalshi] Fetch error:', msg);
        if (msg.includes('Electron IPC not available')) _kalshiIpcWarnTs = now;
      }
      window._kalshiSnapshot = null;
    }
  }

  function getWSTickerRows(provider, instrumentToSymbol, source) {
    const ws = window.ExchangeWS;
    if (!ws || typeof ws.getTicker !== 'function') return [];
    const rows = [];
    const ts = Date.now();
    for (const [instrument, symbol] of Object.entries(instrumentToSymbol)) {
      const normalized = String(symbol || '')
        .replace(/[-_/]/g, '')
        .toUpperCase()
        .replace(/USDT$/, '')
        .replace(/USD$/, '');
      const snap = ws.getTicker(provider, normalized, 30000);
      const last = Number(snap?.price);
      if (!Number.isFinite(last) || last <= 0) continue;
      const bid = Number(snap?.bid);
      const ask = Number(snap?.ask);
      const volume = Number(snap?.vol24h);
      rows.push({
        instrument_name: instrument,
        last,
        high: last,
        low: last,
        change: 0,
        best_bid: Number.isFinite(bid) ? bid : null,
        best_ask: Number.isFinite(ask) ? ask : null,
        best_bid_size: '',
        best_ask_size: '',
        volume: Number.isFinite(volume) ? volume : 0,
        volume_value: Number.isFinite(volume) ? volume * last : 0,
        timestamp: ts,
        source,
      });
    }
    return rows;
  }

  // ---- Live source: Binance 24hr batch — full WATCHLIST coverage, direct, no rate-limit ----
  async function fetchBinanceTickers(symMap = BIN_ALL_SYMS) {
    const wsRows = getWSTickerRows('BINANCE', symMap, 'binance_ws');
    if (wsRows.length >= 5) return wsRows;

    const syms = Object.values(symMap);
    const url = `${BIN_BASE}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`;
    let res = await fetchWithTimeout(url, 5000);
    let rows = [];
    if (res.ok) {
      rows = await res.json();
    } else if (res.status === 400) {
      // Binance US rejects full batch when any symbol is unsupported.
      const singleRows = [];
      for (const symbol of syms) {
        try {
          const r = await fetchWithTimeout(`${BIN_BASE}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, 3000);
          if (!r.ok) continue;
          const one = await r.json();
          if (one && one.symbol) singleRows.push(one);
        } catch (_) { }
      }
      rows = singleRows;
    } else {
      throw new Error(`Binance tickers HTTP ${res.status}`);
    }

    const inv = Object.fromEntries(Object.entries(symMap).map(([k, v]) => [v, k]));
    const result = rows
      .filter(r => inv[r.symbol])
      .map(r => ({
        instrument_name: inv[r.symbol],
        last: parseFloat(r.lastPrice),
        high: parseFloat(r.highPrice),
        low: parseFloat(r.lowPrice),
        change: parseFloat(r.priceChangePercent) / 100,
        best_bid: parseFloat(r.bidPrice),
        best_ask: parseFloat(r.askPrice),
        best_bid_size: '',
        best_ask_size: '',
        volume: parseFloat(r.volume),
        volume_value: parseFloat(r.quoteVolume),
        timestamp: Date.now(),
        source: 'binance',
      }));
    if (!result.length) throw new Error('Binance returned no usable tickers');
    return result;
  }

  // ---- Live source: Kraken public Ticker — direct, free, no rate-limit ----
  async function fetchKrakenTickers() {
    const wsRows = getWSTickerRows('KRAKEN', {
      BTCUSD: 'BTC',
      ETHUSD: 'ETH',
      SOLUSD: 'SOL',
      XRPUSD: 'XRP',
      DOGEUSD: 'DOGE',
    }, 'kraken_ws');
    if (wsRows.length >= 4) return wsRows;

    const pairs = 'XBTUSD,ETHUSD,SOLUSD,XRPUSD,DOGEUSD,LTCUSD,XLMUSD,LINKUSD,XTZUSD,ADAUSD,ATOMUSD,DOTUSD,NEARUSD,AVAXUSD,UNIUSD,AAVEUSD';
    const url = `https://api.kraken.com/0/public/Ticker?pair=${pairs}`;

    // Use resilient fetch with timeout and retry logic
    let res;
    if (window.resilientFetch) {
      try {
        res = await window.resilientFetch(url);
      } catch (err) {
        console.warn('[Kraken] resilientFetch failed, falling back to direct fetch:', err.message);
        res = await fetchWithTimeout(url, 5000);
      }
    } else {
      res = await fetchWithTimeout(url, 5000);
    }

    if (!res.ok) throw new Error(`Kraken tickers HTTP ${res.status}`);
    const json = await res.json();
    if (json.error?.length) throw new Error(`Kraken: ${json.error[0]}`);
    const result = [];
    for (const [key, data] of Object.entries(json.result || {})) {
      const instrument = KRAKEN_RESPONSE_MAP[key];
      if (!instrument) continue;
      const last = parseFloat(data.c[0]);
      const open = parseFloat(data.o);
      result.push({
        instrument_name: instrument,
        last,
        high: parseFloat(data.h[1]),
        low: parseFloat(data.l[1]),
        change: open > 0 ? (last - open) / open : 0,
        best_bid: parseFloat(data.b[0]),
        best_ask: parseFloat(data.a[0]),
        best_bid_size: data.b[1] || '',
        best_ask_size: data.a[1] || '',
        volume: parseFloat(data.v[1]),
        volume_value: parseFloat(data.v[1]) * last,
        timestamp: Date.now(),
        source: 'kraken',
      });
    }
    if (!result.length) throw new Error('Kraken returned no usable tickers');
    return result;
  }

  // ---- Live fallback #3: Coinbase Advanced Trade /products/{id} (direct, parallel) ----
  async function fetchCoinbaseTickers() {
    const wsRows = getWSTickerRows(
      'COINBASE',
      Object.fromEntries(Object.entries(COINBASE_PRODUCTS).map(([product, instrument]) => [instrument, product])),
      'coinbase_ws'
    );
    if (wsRows.length >= 4) return wsRows;

    const entries = Object.entries(COINBASE_PRODUCTS);
    const settled = await Promise.allSettled(
      entries.map(async ([product, instrument]) => {
        let jwtHeader = {};
        try {
          if (window.desktopApp && window.desktopApp.generateCoinbaseJWT) {
            const res = await window.desktopApp.generateCoinbaseJWT({
              requestMethod: 'GET',
              requestPath: `api.coinbase.com/api/v3/brokerage/products/${product}`
            });
            if (res && res.success && res.jwt) jwtHeader = { 'Authorization': `Bearer ${res.jwt}` };
          }
        } catch (e) { }

        const url = `https://api.coinbase.com/api/v3/brokerage/products/${product}`;

        const promise = window.resilientFetch
          ? window.resilientFetch(url, { headers: jwtHeader })
          : fetchWithTimeout(url, 5000, { headers: jwtHeader });

        return promise
          .then(async r => {
            if (!r.ok) {
              throw new Error(`CB ${r.status}`);
            }
            return r.json();
          })
          .then(data => {
            const last = parseFloat(data.price);
            if (!last) return null;
            const pctChange = parseFloat(data.price_percentage_change_24h) / 100;
            return {
              instrument_name: instrument,
              last,
              high: 0,
              low: 0,
              change: pctChange || 0,
              best_bid: null,
              best_ask: null,
              best_bid_size: '',
              best_ask_size: '',
              volume: parseFloat(data.volume_24h) || 0,
              volume_value: (parseFloat(data.volume_24h) || 0) * last,
              timestamp: Date.now(),
              source: 'coinbase',
            };
          })
          .catch(() => null);
      })
    );
    const result = settled.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    if (!result.length) throw new Error('Coinbase returned no usable tickers');
    return result;
  }

  // ---- Pyth Network — decentralized oracle, 33 coins, sub-second, no geo-block ----
  async function fetchPythTickers() {
    const pythWsTimeoutMs = Number(
      (window.__WECRYPTO_CONFIG__ && window.__WECRYPTO_CONFIG__.pythWsTimeoutMs) ||
      localStorage.getItem('pyth.ws.timeout.ms') ||
      2500
    );

    const freshPyth = window._signalScheduler?.getFreshSourceSnapshot('pyth-lazer', 3500);
    if (freshPyth && typeof freshPyth === 'object') {
      const mapped = mapPythLazerPricesToTickers(freshPyth);
      if (mapped.length) {
        if (window.NetworkHealth) {
          window.NetworkHealth.update('Pyth', {
            status: 'healthy',
            lastFetch: Date.now(),
            fallback: false,
            reason: '',
          });
        }
        return mapped;
      }
    }

    // ★ NEW: Try Pyth Lazer WS stream first (sub-100ms, from IPC)
    if (window.pythLazer?.onTickers) {
      try {
        let received = false;
        return await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (!received) reject(new Error(`Pyth Lazer WS timeout (${pythWsTimeoutMs}ms)`));
          }, pythWsTimeoutMs);

          window.pythLazer.onTickers((prices) => {
            clearTimeout(timeout);
            received = true;
            window._signalScheduler?.markSourceFresh('pyth-lazer', prices, Date.now());
            if (window.NetworkHealth) {
              window.NetworkHealth.update('Pyth', {
                status: 'healthy',
                lastFetch: Date.now(),
                fallback: false,
                reason: '',
              });
            }
            resolve(mapPythLazerPricesToTickers(prices));
          });
        });
      } catch (e) {
        console.warn('[PythTickers] WS stream failed:', e.message);
      }
    }

    // ★ FALLBACK 1: Try Lazer proxy REST (no-auth, faster than Hermes)
    try {
      const result = await fetchPythLazerProxyTickers();
      if (window.NetworkHealth) {
        window.NetworkHealth.update('Pyth', {
          status: 'degraded',
          lastFetch: Date.now(),
          fallback: true,
          reason: 'Using Lazer proxy fallback',
        });
      }
      return result;
    } catch (e) {
      console.warn('[PythTickers] Lazer proxy failed:', e.message);
    }

    // ★ FALLBACK 2: Pyth Hermes (standard, wider coin coverage)
    const feedIds = Object.values(PYTH_FEEDS);
    const params = feedIds.map(id => `ids[]=${id}`).join('&');
    const res = await fetchWithTimeout(`${PYTH_HERMES}/v2/updates/price/latest?${params}`, 20000);
    if (!res.ok) throw new Error(`Pyth HTTP ${res.status}`);
    const json = await res.json();
    const result = [];
    for (const feed of json.parsed || []) {
      const instrument = PYTH_ID_TO_INSTRUMENT[feed.id];
      if (!instrument) continue;
      const p = feed.price;
      const last = parseFloat(p.price) * Math.pow(10, p.expo);
      if (!last || last <= 0 || isNaN(last)) continue;
      result.push({
        instrument_name: instrument,
        last,
        high: last,  // Pyth spot only — 24h stats overlaid async by fetchBinanceTickers
        low: last,
        change: 0,
        best_bid: null,
        best_ask: null,
        best_bid_size: '',
        best_ask_size: '',
        volume: 0,
        volume_value: 0,
        timestamp: Date.now(),
        source: 'pyth',
      });
    }
    if (!result.length) throw new Error('Pyth returned no usable feeds');
    if (window.NetworkHealth) {
      window.NetworkHealth.update('Pyth', {
        status: 'degraded',
        lastFetch: Date.now(),
        fallback: true,
        reason: 'Using Hermes fallback',
      });
    }
    return result;
  }

  // ---- Pyth Lazer proxy — no-auth REST, BTC/ETH/SOL/XRP/BNB, sub-5ms ----
  async function fetchPythLazerProxyTickers() {
    const qs = 'price_feed_ids=1&price_feed_ids=2&price_feed_ids=6&price_feed_ids=10&price_feed_ids=14&price_feed_ids=15';
    for (const host of PYTH_LAZER_PROXIES) {
      try {
        const res = await fetchWithTimeout(`https://${host}/v1/latest_price?${qs}`, 4000);
        if (!res.ok) continue;
        const j = await res.json();
        const result = [];
        for (const f of j.priceFeeds || []) {
          const instr = LAZER_ID_INSTR[f.priceFeedId];
          if (!instr) continue;
          const exp = f.exponent ?? -8;
          const scale = Math.pow(10, exp);
          const px = Number(f.price) * scale;
          if (!px || px <= 0 || isNaN(px)) continue;
          result.push({
            instrument_name: instr, last: px,
            high: px, low: px, change: 0,
            best_bid: f.bestBidPrice != null ? Number(f.bestBidPrice) * scale : null,
            best_ask: f.bestAskPrice != null ? Number(f.bestAskPrice) * scale : null,
            best_bid_size: '', best_ask_size: '',
            volume: 0, volume_value: 0,
            timestamp: Date.now(),
            source: 'pyth-lazer',
          });
        }
        if (result.length >= 4) return result;
      } catch (_) { }
    }
    throw new Error('Pyth Lazer proxies unavailable');
  }

  // ---- Hyperliquid allMids — decentralized perps, covers HYPE + wide alt universe ----
  async function fetchHyperliquidMids() {
    const res = await fetchWithTimeout(
      `${HL_BASE}/info`, 20000,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }) }
    );
    if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
    const mids = await res.json();
    const result = [];
    for (const [sym, priceStr] of Object.entries(mids)) {
      const instrument = HL_SYM_MAP[sym];
      if (!instrument) continue;
      const multiplier = HL_K_COINS.has(sym) ? 0.001 : 1;  // kBONK/kPEPE/kFLOKI are 1000x contracts
      const last = parseFloat(priceStr) * multiplier;
      if (!last || last <= 0 || isNaN(last)) continue;
      result.push({
        instrument_name: instrument,
        last,
        high: last,
        low: last,
        change: 0,
        best_bid: null,
        best_ask: null,
        best_bid_size: '',
        best_ask_size: '',
        volume: 0,
        volume_value: 0,
        timestamp: Date.now(),
        source: 'hyperliquid',
      });
    }
    if (!result.length) throw new Error('Hyperliquid returned no usable mids');
    return result;
  }

  // ---- 24h stat overlay — enriches Pyth/HL spot prices with Binance change%/high/low ----
  async function overlayBinance24hStats() {
    try {
      const stats = await fetchBinanceTickers();
      let updated = 0;
      stats.forEach(s => {
        const t = tickers[s.instrument_name];
        if (!t) return;
        // Overwrite 24h stats regardless of source — Binance has the authoritative 24h window
        t.high = s.high;
        t.low = s.low;
        t.change = s.change;
        t.volume = s.volume;
        t.volume_value = s.volume_value;
        t.best_bid = t.best_bid ?? s.best_bid;
        t.best_ask = t.best_ask ?? s.best_ask;
        updated++;
      });
      if (updated) refreshActiveView();
    } catch (e) {
      console.warn('[WE] Binance 24h overlay failed:', e.message);
    }
  }

  function geckoTimeframeConfig(timeframe) {
    switch (timeframe) {
      case '1m': return null;  // CoinGecko has no 1-minute resolution
      case '3m': return null;  // CoinGecko has no 3-minute resolution
      case '5m': return { days: 1, bucketMs: 5 * 60 * 1000 };
      case '15m': return { days: 1, bucketMs: 15 * 60 * 1000 };
      case '1h': return { days: 7, bucketMs: 60 * 60 * 1000 };
      case '4h': return { days: 30, bucketMs: 4 * 60 * 60 * 1000 };
      case '1W': return { days: 365, bucketMs: 7 * 24 * 60 * 60 * 1000 };
      case '1D':
      default:
        return { days: 365, bucketMs: 24 * 60 * 60 * 1000 };
    }
  }

  function averageNums(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function exchangeInterval(timeframe) {
    switch (timeframe) {
      case '1D': return '1d';
      case '1W': return '1w';
      default: return timeframe;
    }
  }

  // MEXC uses slightly different interval strings; returns null for unsupported TFs
  function mexcInterval(timeframe) {
    switch (timeframe) {
      case '1m': return '1m';
      case '3m': return null;   // MEXC has no 3m
      case '5m': return '5m';
      case '15m': return '15m';
      case '30m': return '30m';
      case '1h': return '60m';  // MEXC uses 60m not 1h
      case '4h': return '4h';
      case '1D': return '1d';
      case '1W': return '1W';
      default: return null;
    }
  }

  function poolCandles(...seriesList) {
    // Source priority: first series to claim a timestamp wins O/C (preserves real candle body).
    // H = max across all sources, L = min across all sources, V = average.
    const buckets = new Map();
    seriesList.filter(Array.isArray).forEach(series => {
      series.forEach(row => {
        const [ts, o, h, l, c, v] = row;
        if (!Number.isFinite(Number(ts))) return;
        const t = Number(ts);
        if (!buckets.has(t)) {
          buckets.set(t, { t, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v || 0), vs: 1 });
        } else {
          const b = buckets.get(t);
          // First source already owns O/C — only update H/L/V
          b.h = Math.max(b.h, Number(h));
          b.l = Math.min(b.l, Number(l));
          b.v += Number(v || 0);
          b.vs++;
        }
      });
    });
    return Array.from(buckets.values())
      .sort((a, b) => a.t - b.t)
      .map(b => [b.t, b.o, b.h, b.l, b.c, b.vs > 0 ? b.v / b.vs : 0]);
  }

  async function fetchBinanceCandlesticks(instrument, timeframe) {
    const binSym = BIN_ALL_SYMS[instrument];   // reuse existing instrument→USDT map
    if (!binSym) return [];
    const limit = timeframe === '1m' ? 180 : timeframe === '3m' ? 180 : 300;
    const res = await fetch(`${BIN_BASE}/klines?symbol=${binSym}&interval=${exchangeInterval(timeframe)}&limit=${limit}`);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(row => [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])]);
  }

  async function fetchMEXCCandlesticks(instrument, timeframe) {
    const mexcSym = BIN_ALL_SYMS[instrument];  // MEXC uses identical USDT symbol format
    if (!mexcSym) return [];
    const ivl = mexcInterval(timeframe);
    if (!ivl) return [];  // timeframe not supported by MEXC (e.g. 3m)
    const limit = timeframe === '1m' ? 180 : timeframe === '3m' ? 180 : 300;
    const res = await fetch(`${MEXC_BASE}/klines?symbol=${mexcSym}&interval=${ivl}&limit=${limit}`);
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(row => [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])]);
  }

  async function fetchGeckoCandlesticks(instrument, timeframe) {
    const geckoId = geckoIdForInstrument(instrument);
    if (!geckoId) throw new Error(`No fallback feed configured for ${instrument}`);

    const cfg = geckoTimeframeConfig(timeframe);
    if (!cfg) return [];   // CoinGecko has no data at this resolution (e.g. 1m, 3m)

    // Serial queue + 1200 ms min gap to stay under CoinGecko's rate limit
    const MIN_GAP_MS = 1200;
    const result = await (_geckoCandleQueue = _geckoCandleQueue.then(async () => {
      const wait = _lastGeckoCandleAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      _lastGeckoCandleAt = Date.now();

      const { days, bucketMs } = cfg;
      let lastErr;

      // Try CoinGecko first
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const cgReq = coinGeckoRequest(`/coins/${geckoId}/market_chart`, {
            vs_currency: 'usd',
            days,
          });
          const res = await fetch(cgReq.url, cgReq.options);
          if (res.status === 429) {
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
          const json = await res.json();
          const prices = Array.isArray(json.prices) ? json.prices : [];
          const volumes = Array.isArray(json.total_volumes) ? json.total_volumes : [];
          if (!prices.length) throw new Error(`No CoinGecko chart data for ${instrument}`);

          const buckets = new Map();
          prices.forEach((point, idx) => {
            const ts = Number(point[0]);
            const priceVal = Number(point[1]);
            const volumeVal = Number(volumes[idx]?.[1] || 0);
            if (!Number.isFinite(ts) || !Number.isFinite(priceVal)) return;
            const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
            const bucket = buckets.get(bucketStart) || {
              t: bucketStart, o: priceVal, h: priceVal, l: priceVal,
              c: priceVal, v: 0, samples: 0,
            };
            bucket.h = Math.max(bucket.h, priceVal);
            bucket.l = Math.min(bucket.l, priceVal);
            bucket.c = priceVal;
            bucket.v += Number.isFinite(volumeVal) ? volumeVal : 0;
            bucket.samples++;
            buckets.set(bucketStart, bucket);
          });

          return Array.from(buckets.values())
            .sort((a, b) => a.t - b.t)
            .map(b => [b.t, b.o, b.h, b.l, b.c, b.samples ? b.v / b.samples : 0]);
        } catch (e) {
          lastErr = e;
        }
      }

      // Fallback: CoinCap API (free, no auth)
      console.warn(`[Chart] CoinGecko failed (${lastErr?.message}); trying CoinCap...`);
      try {
        const coincapId = geckoId; // CoinCap uses similar IDs (bitcoin, ethereum, etc)
        const coinCapKey = String(
          resolveRuntimeKeyLocal('COINCAP_API_KEY')
          || resolveRuntimeKeyLocal('COINCAP_BEARER_TOKEN')
          || resolveRuntimeKeyLocal('COINCAP_TOKEN')
          || ''
        ).trim();
        if (!coinCapKey) {
          console.info(`[Chart] CoinCap skipped for ${instrument}: no API key configured`);
          return [];
        }
        const res = await fetchWithTimeout(`${COINCAP_BASE}/assets/${coincapId}/history?interval=d1`, 20000, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${coinCapKey}`,
          },
        });
        if (!res.ok) throw new Error(`CoinCap ${res.status}`);
        const json = await res.json();
        const data = Array.isArray(json.data) ? json.data : [];
        if (!data.length) throw new Error(`No CoinCap data for ${coincapId}`);

        const buckets = new Map();
        data.forEach(point => {
          const ts = Number(point.time);
          const priceVal = parseFloat(point.priceUsd);
          if (!Number.isFinite(ts) || !Number.isFinite(priceVal) || priceVal <= 0) return;
          const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
          const bucket = buckets.get(bucketStart) || {
            t: bucketStart, o: priceVal, h: priceVal, l: priceVal, c: priceVal, v: 0, samples: 0,
          };
          bucket.h = Math.max(bucket.h, priceVal);
          bucket.l = Math.min(bucket.l, priceVal);
          bucket.c = priceVal;
          bucket.samples++;
          buckets.set(bucketStart, bucket);
        });

        const result = Array.from(buckets.values())
          .sort((a, b) => a.t - b.t)
          .map(b => [b.t, b.o, b.h, b.l, b.c, 0]); // CoinCap doesn't provide volume
        if (!result.length) throw new Error('No usable CoinCap data');
        console.info(`[Chart] CoinCap fallback success for ${instrument}`);
        return result;
      } catch (coinCapErr) {
        console.error('[Chart] CoinCap fallback also failed:', coinCapErr.message);
        throw new Error(`Both CoinGecko and CoinCap failed for ${instrument}`);
      }
    }));
    return result;
  }

  async function fetchCandlesticks(instrument, timeframe) {
    const geckoId = geckoIdForInstrument(instrument);
    const prefersGecko = tickers[instrument]?.source === 'coingecko';

    if (prefersGecko && geckoId) {
      // For gecko-primary coins (e.g. HYPE): gecko leads pooling for O/C accuracy
      const [gecko, binance, mexc] = await Promise.all([
        fetchGeckoCandlesticks(instrument, timeframe).catch(() => []),
        fetchBinanceCandlesticks(instrument, timeframe).catch(() => []),
        fetchMEXCCandlesticks(instrument, timeframe).catch(() => []),
      ]);
      const pooled = poolCandles(gecko, binance, mexc);
      if (pooled.length) return pooled;
      return gecko;
    }

    try {
      const apiInstr = instrument.replace(/([A-Z]+)(USD[T]?)$/, '$1_$2');
      const cdcLimit = timeframe === '1m' ? 180 : timeframe === '3m' ? 180 : 300;
      const [cdc, binance, mexc, gecko, pythHist] = await Promise.all([
        fetch(`${CDC_BASE}/get-candlestick?instrument_name=${apiInstr}&timeframe=${timeframe}&count=${cdcLimit}`)
          .then(async res => {
            if (!res.ok) throw new Error(`Candles HTTP ${res.status}`);
            const json = await res.json();
            if (json.code !== 0) throw new Error(`Candles error ${json.code} for ${apiInstr}`);
            return json.result.data.map(c => Array.isArray(c) ? c : [c.t || c[0], c.o || c[1], c.h || c[2], c.l || c[3], c.c || c[4], c.v || c[5]]);
          })
          .catch(() => []),
        fetchBinanceCandlesticks(instrument, timeframe).catch(() => []),
        fetchMEXCCandlesticks(instrument, timeframe).catch(() => []),
        geckoId ? fetchGeckoCandlesticks(instrument, timeframe).catch(() => []) : Promise.resolve([]),
        fetchPythHistoryCandles(instrument, timeframe).catch(() => []),
      ]);
      // Exchange sources lead; gecko fills H/L/V gaps; Pyth History provides official OHLC
      const pooled = poolCandles(cdc, binance, mexc, gecko, pythHist);
      if (pooled.length) return pooled;
      throw new Error(`No pooled candles for ${instrument}`);
    } catch (err) {
      if (geckoId) {
        console.warn(`[WE] Falling back to CoinGecko candles for ${instrument}:`, err.message);
        return fetchGeckoCandlesticks(instrument, timeframe).catch(() => []);
      }
      throw err;
    }
  }

  // ---- Pyth History API OHLC — official candles, real_time channel ----
  async function fetchPythHistoryCandles(instrument, timeframe) {
    const sym = INSTR_TO_PYTH_SYM[instrument];
    const TF_RES = {
      '1m': '1', '3m': '5', '5m': '5', '15m': '15', '30m': '30',
      '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W'
    };
    const res = TF_RES[timeframe];
    if (!sym || !res) throw new Error(`No Pyth History mapping for ${instrument}/${timeframe}`);
    const SEC = {
      '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '120': 7200,
      '240': 14400, '360': 21600, '720': 43200, 'D': 86400, 'W': 604800
    };
    const BARS = {
      '1': 300, '5': 300, '15': 200, '30': 200, '60': 168, '120': 100,
      '240': 90, '360': 72, '720': 60, 'D': 30, 'W': 26
    };
    const now = Math.floor(Date.now() / 1000);
    const from = now - (SEC[res] || 3600) * (BARS[res] || 100);
    const url = `${PYTH_HISTORY_BASE}/v1/real_time/history?symbol=${encodeURIComponent(sym)}&from=${from}&to=${now}&resolution=${res}`;
    const r = await fetchWithTimeout(url, 20000);
    if (!r.ok) throw new Error(`Pyth History HTTP ${r.status}`);
    const d = await r.json();
    if (d.s !== 'ok' || !d.c?.length) throw new Error(`Pyth History no data (s=${d.s})`);
    return d.t.map((ts, i) => [ts * 1000, +d.o[i], +d.h[i], +d.l[i], +d.c[i], +(d.v?.[i] ?? 0)]);
  }

  // ---- Pyth Lazer candles via IPC (sub-100ms latency, official OHLC) ----
  async function fetchPythCandles(symbol, resolution, from, to) {
    try {
      if (!window.pythLazer?.getCandles) {
        throw new Error('Pyth Lazer IPC not available');
      }

      const result = await window.pythLazer.getCandles({
        symbol,
        resolution,
        from: Math.floor(from / 1000),  // convert ms to seconds
        to: Math.floor(to / 1000),
      });

      if (!result.success) {
        throw new Error(result.error || 'Pyth Lazer failed');
      }

      // Transform to [timestamp, o, h, l, c, v] format
      return result.candles.map(c => [c.t * 1000, c.o, c.h, c.l, c.c, c.v || 0]);
    } catch (e) {
      console.warn(`[PythLazer] fetchPythCandles failed for ${symbol}:`, e.message);
      throw e;
    }
  }

  // ================================================================
  // BLOCKSCOUT on-chain lookup (Ethereum mainnet)
  // ================================================================

  async function fetchWalletTokens(address) {
    if (window.WalletCache) {
      const result = await window.WalletCache.getTokens(address);
      window._walletDataSource = result.source;
      window._walletDataDiagnostics = {
        ...(window._walletDataDiagnostics || {}),
        tokens: result.diagnostics || null,
      };
      return result.data;
    }
    // Fallback: original inline logic if WalletCache not loaded
    const ctrl = new AbortController();
    const tid = setTimeout(() => {
      try {
        ctrl.abort(new DOMException('Wallet fetch timed out after 8000ms', 'TimeoutError'));
      } catch (_) {
        try { ctrl.abort(); } catch (_) { }
      }
    }, 20000);
    try {
      // Try resilientFetch first (adds automatic retry + fallback to Etherscan)
      const res = window.resilientFetch
        ? await window.resilientFetch(`https://eth.blockscout.com/api/v2/addresses/${address}/token-balances`, { signal: ctrl.signal })
        : await fetch(`https://eth.blockscout.com/api/v2/addresses/${address}/token-balances`, { signal: ctrl.signal });
      if (res.ok) { window._walletDataSource = 'blockscout'; return res.json(); }
    } catch (e) { if (e.name === 'AbortError') console.warn('[WE] Wallet fetch timed out'); }
    finally { clearTimeout(tid); }
    const esKey = localStorage.getItem('etherscanApiKey') || '';
    if (esKey) {
      try {
        const res = await fetch(`https://api.etherscan.io/api?module=account&action=tokenlist&address=${address}&apikey=${esKey}`);
        if (res.ok) { const d = await res.json(); if (d.status === '1') { window._walletDataSource = 'etherscan'; return normalizeEtherscanTokens(d); } }
      } catch (_) { }
    }
    throw new Error('All wallet data sources unavailable');
  }

  async function fetchWalletTxs(address) {
    if (window.WalletCache) {
      const result = await window.WalletCache.getTxs(address);
      window._walletDataDiagnostics = {
        ...(window._walletDataDiagnostics || {}),
        txs: result.diagnostics || null,
      };
      return result.data;
    }
    // Fallback: Use resilientFetch for automatic retry + fallback to Etherscan
    try {
      const res = window.resilientFetch
        ? await window.resilientFetch(`https://eth.blockscout.com/api/v2/addresses/${address}/transactions?limit=10`)
        : await fetch(`https://eth.blockscout.com/api/v2/addresses/${address}/transactions?limit=10`);
      if (res.ok) return res.json();
    } catch (_) { }
    return { items: [] };
  }

  function normalizeEthplorerTokens(data) {
    const out = [];
    if (data.ETH?.balance) {
      out.push({
        token: { symbol: 'ETH', name: 'Ether', decimals: '18', address: '' },
        value: String(Math.round(data.ETH.balance * 1e18))
      });
    }
    (data.tokens || []).forEach(t => {
      if (!t.tokenInfo) return;
      out.push({
        token: {
          symbol: t.tokenInfo.symbol || '?', name: t.tokenInfo.name || '?',
          decimals: String(t.tokenInfo.decimals ?? 18), address: t.tokenInfo.address || '',
        }, value: String(t.balance ?? 0)
      });
    });
    return out;
  }

  function normalizeEtherscanTokens(data) {
    return (data.result || []).map(t => ({
      token: {
        symbol: t.tokenSymbol || '?', name: t.tokenName || '?',
        decimals: String(t.tokenDecimal ?? 18), address: t.contractAddress || ''
      },
      value: t.value || '0',
    }));
  }

  function normalizeEtherscanTxs(data, address) {
    return {
      items: (data.result || []).map(tx => ({
        hash: tx.hash,
        to: { hash: tx.to },
        from: { hash: tx.from },
        value: tx.value,
        timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
        method: tx.functionName ? tx.functionName.split('(')[0] : 'transfer',
        gas_used: tx.gasUsed,
      }))
    };
  }

  async function fetchBlockscoutPolygon(address) {
    const url = `https://polygon.blockscout.com/api/v2/addresses/${address}/token-balances`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Polygon Blockscout HTTP ${res.status}`);
    return res.json();
  }

  // ================================================================
  // DATA FETCH ORCHESTRATION
  // ================================================================

  // ── New-contract burst-retry heuristic ──────────────────────────────────────
  // After each :00/:15/:30/:45 boundary, Kalshi takes 2-4 min to list the next
  // 15M contract on their API. This fires PredictionMarkets.fetchAll() every 15s
  // for up to 5 minutes and stops the moment all 7 coins have a live ticker.
  // Without this, the UI can lag 4-6 minutes waiting on the normal 30s poll.
  const _CONTRACT_SYMS = ['BTC', 'ETH', 'XRP', 'DOGE', 'BNB'];  // ★ REMOVED HYPE (48%) and SOL (52%) per backtest
  // Delays (seconds) between each successive retry attempt after the boundary pulse
  const _CONTRACT_RETRY_DELAYS = [15, 15, 15, 15, 30, 30, 30, 60, 60]; // ~T+4.5 min total

  function scheduleNewContractRetries() {
    let retryIdx = 0;
    function attempt() {
      if (retryIdx >= _CONTRACT_RETRY_DELAYS.length) {
        console.info('[WE] 🔚 New-contract retry sequence exhausted');
        return;
      }
      const delay = _CONTRACT_RETRY_DELAYS[retryIdx] * 1000;
      retryIdx++;
      setTimeout(async () => {
        if (document.hidden) { attempt(); return; } // tab hidden — defer
        const pmAll = window.PredictionMarkets?.getAll?.() || {};
        const ready = _CONTRACT_SYMS.filter(s => pmAll[s]?.kalshi15m?.ticker);
        if (ready.length === _CONTRACT_SYMS.length) {
          console.info('[WE] ✅ All 7 new Kalshi 15M contracts loaded — retry done');
          return; // all coins have fresh contracts — stop
        }
        console.info(`[WE] 🔄 New-contract retry #${retryIdx} — ${ready.length}/7 ready (${ready.join(',') || 'none'}) — fetching…`);
        if (feedText) feedText.textContent = `🔄 Awaiting new contracts (${ready.length}/7)…`;
        await window.PredictionMarkets?.fetchAll?.();
        // Re-check after fetch
        const pmAll2 = window.PredictionMarkets?.getAll?.() || {};
        const ready2 = _CONTRACT_SYMS.filter(s => pmAll2[s]?.kalshi15m?.ticker);
        if (ready2.length === _CONTRACT_SYMS.length) {
          console.info('[WE] ✅ All 7 new Kalshi 15M contracts loaded after fetch — retry done');
          if (feedText) feedText.textContent = `✅ New contracts ready`;
          return;
        }
        attempt(); // still missing some — schedule next retry
      }, delay);
    }
    // Kick off first retry 10s after the boundary pulse completes
    setTimeout(attempt, 10_000);
  }

  // ── Settlement pulse — fires at every :00/:15/:30/:45 boundary ─────────────
  // Hits ALL 6 CEXes simultaneously alongside chain intel + prediction markets.
  // Streaming via resetTimer() continues uninterrupted between pulses.
  async function settlementPull() {
    const easternStamp = window.WeCryptoClock?.formatEasternTime?.() ||
      new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const label = easternStamp.match(/\b\d{2}:\d{2}\b/)?.[0] || easternStamp;
    console.info(`[WE] ⚡ Settlement pulse ${label} ET — blasting all CEXes + chain + markets`);
    if (feedText) feedText.textContent = `⚡ ${label} ET settlement…`;

    // Fire everything simultaneously — price blast + supporting data
    await Promise.allSettled([
      fetchAll(true, true),                           // all 6 CEXes race, no cache, no CDC window
      window.PredictionMarkets?.fetchAll?.(),         // fresh Kalshi/Polymarket probs for new contract
      window.BlockchainScan?.fetchAll?.(),            // fresh chain intelligence
      window.CexFlow?.fetchAll?.(),                   // fresh CEX flow snapshot
    ]);

    // Reset regular timer so streaming doesn't double-fire immediately after pulse
    resetTimer();
    console.info(`[WE] ⚡ Settlement pulse ${label} complete`);
    // Burst-retry until new Kalshi contracts appear (Kalshi lists them 2-4 min after boundary)
    scheduleNewContractRetries();
  }

  // ---- Pyth Lazer live ticker stream — IPC-pushed prices from main process ----
  function startPythLazerStream() {
    if (!window.pythLazer?.onTickers) return;
    if (window.NetworkHealth) {
      window.NetworkHealth.update('Pyth', {
        status: 'degraded',
        lastFetch: Date.now(),
        fallback: true,
        reason: 'Waiting for first Pyth tick',
      });
    }
    window.pythLazer.onTickers((prices) => {
      if (!prices || typeof prices !== 'object') return;
      window._signalScheduler?.markSourceFresh('pyth-lazer', prices, Date.now());
      if (window.NetworkHealth) {
        window.NetworkHealth.update('Pyth', {
          status: 'healthy',
          lastFetch: Date.now(),
          fallback: false,
          reason: '',
        });
      }
      let updated = false;
      for (const [instr, data] of Object.entries(prices)) {
        if (!tickers[instr]) continue;    // only overlay known instruments
        tickers[instr] = {
          ...tickers[instr],
          last: data.last,
          best_bid: data.best_bid ?? tickers[instr].best_bid,
          best_ask: data.best_ask ?? tickers[instr].best_ask,
          timestamp: data.timestamp,
          source: 'pyth-lazer',
        };
        updated = true;
      }
      if (!updated) return;
      window._appTickers = tickers;
      if (!startPythLazerStream._debounce) {
        startPythLazerStream._debounce = setTimeout(() => {
          startPythLazerStream._debounce = null;
          if (['cfm', 'predictions', 'universe'].includes(currentView)) refreshActiveView();
          scheduleWebStatePublish('pyth-lazer-tick', 150);
        }, 500);
      }
    });
    if (!startPythLazerStream._statusWired) {
      startPythLazerStream._statusWired = true;

      window.pythLazer?.onStatus?.((status) => {
        if (!window.NetworkHealth) return;
        const now = Date.now();
        const ageMs = status?.lastDataTs ? (now - status.lastDataTs) : Number.POSITIVE_INFINITY;
        const healthy = !!status?.connected && ageMs < 6000;
        window.NetworkHealth.update('Pyth', {
          status: healthy ? 'healthy' : 'degraded',
          lastFetch: status?.lastDataTs || now,
          fallback: !healthy,
          reason: healthy ? '' : `Stale stream (${Math.max(0, Math.round(ageMs))}ms)`,
        });
      });

      window.pythLazer?.onTimeout?.((data) => {
        if (!window.NetworkHealth) return;
        window.NetworkHealth.update('Pyth', {
          status: 'healthy',
          lastFetch: Date.now(),
          fallback: true,
          reason: data?.reason === 'no_data_timeout_plus_grace'
            ? 'Lazer quiet; fallback feeds active'
            : (data?.reason || 'Pyth fallback active'),
          bucket: 'unknown',
          bucketReason: '',
        });
      });

      window.pythLazer?.onConnectionLost?.((data) => {
        if (!window.NetworkHealth) return;
        const reason = data?.reason || 'Pyth connection lost';
        window.NetworkHealth.update('Pyth', {
          status: 'degraded',
          lastFetch: Date.now(),
          fallback: true,
          transient: true,
          reason: reason === 'all_connections_down'
            ? 'all_connections_down (auto-reconnect in progress)'
            : reason,
          bucket: 'network/transport',
          bucketReason: '',
        });
      });

      window.pythLazer?.onConnectionFailed?.((data) => {
        if (!window.NetworkHealth) return;
        window.NetworkHealth.update('Pyth', {
          status: 'down',
          lastFetch: Date.now(),
          fallback: true,
          reason: data?.error || 'Pyth connection failed',
        });
      });
    }
    console.info('[PythLazer] ✓ Live ticker stream active');
  }

  function liveTickerSources(cdcPromise = null) {
    const sources = [];
    if (cdcPromise) {
      sources.push({
        source: 'cdc',
        run: async () => {
          const data = await cdcPromise;
          if (!data?.length) throw new Error('cdc empty');
          return data;
        },
      });
    }
    sources.push(
      { source: 'pyth-lazer', run: fetchPythLazerProxyTickers },
      { source: 'pyth', run: fetchPythTickers },
      { source: 'hyperliquid', run: fetchHyperliquidMids },
      { source: 'binance', run: fetchBinanceTickers },
      { source: 'kraken', run: fetchKrakenTickers },
      { source: 'coinbase', run: fetchCoinbaseTickers },
    );
    return sources;
  }

  async function raceTickerSources(sources, batchSize = 2) {
    const errors = [];
    for (let i = 0; i < sources.length; i += batchSize) {
      const batch = sources.slice(i, i + batchSize);
      try {
        return await Promise.any(batch.map(({ source, run }) => (
          Promise.resolve()
            .then(run)
            .then(data => {
              if (!Array.isArray(data) || data.length === 0) {
                throw new Error(`${source} returned no ticker rows`);
              }
              return { source, data };
            })
        )));
      } catch (err) {
        if (err?.errors?.length) errors.push(...err.errors);
        else errors.push(err);
      }
    }
    throw new AggregateError(errors, 'All ticker fallback sources failed');
  }

  async function fetchAll(manual = false, settlement = false) {
    setFeedStatus('loading');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    try {
      let rawTickers = [];
      let dataSource = 'cdc';

      const _shared = window._sharedTickerCache;

      if (settlement) {
        // ── Settlement blast: all 6 CEXes race from the gun — no cache, no CDC window ──
        // At :00/:15/:30/:45 we need the absolute freshest snapshot for the new contract.
        console.info('[WE] ⚡ Settlement fetch: CDC+fallback feeds in bounded batches');
        try {
          const cdcPromise = fetchTickers().catch(() => null);
          const winner = await raceTickerSources(liveTickerSources(cdcPromise), 3);
          rawTickers = winner.data;
          dataSource = winner.source;
          // Let CDC finish in background and hydrate shared cache even if it lost the race
          if (dataSource !== 'cdc') {
            cdcPromise.then(cdcData => {
              if (cdcData?.length) window._sharedTickerCache = { data: cdcData, raw: cdcData, age: Date.now() };
            });
          }
        } catch {
          if (_shared?.data) {
            rawTickers = _shared.data;
            dataSource = 'stale';
            console.warn('[WE] Settlement blast: all sources failed — stale cache');
          }
        }

      } else if (!manual && _shared?.data && Date.now() - _shared.age < 20000) {
        // ── Instant: reuse shared cache if very fresh (<8s) ─────────────────
        rawTickers = _shared.data;
        dataSource = 'cache';
      } else {
        // ── Stage 1: CDC gets a 3s priority window (institutional data quality) ──
        const _cdcFull = fetchTickers().catch(e => { console.warn('[WE] CDC:', e.message); return null; });
        const _cdcQuick = await Promise.race([
          _cdcFull.then(d => d || null),
          new Promise(resolve => setTimeout(() => resolve(null), 3000)),
        ]);

        if (_cdcQuick) {
          rawTickers = _cdcQuick;
          dataSource = 'cdc';
        } else {
          // ── Stage 2: Race fallback sources in small batches to avoid network bursts.
          console.warn('[WE] CDC slow — racing fallback feeds in bounded batches');
          try {
            const winner = await raceTickerSources(liveTickerSources(), 2);
            rawTickers = winner.data;
            dataSource = winner.source;
            _cdcFull.then(cdcData => {
              if (cdcData) window._sharedTickerCache = { data: cdcData, raw: cdcData, age: Date.now() };
            });
          } catch {
            // ── Stage 3: stale cache — absolute last resort ───────────────
            if (_shared?.data) {
              rawTickers = _shared.data;
              dataSource = 'stale';
              console.warn('[WE] All live sources failed — using stale cache (age:', Math.round((Date.now() - _shared.age) / 1000), 's)');
            }
          }
        }
      }

      // Pyth/HL give spot price only (no 24h change%/high/low) — overlay async
      if (dataSource === 'pyth' || dataSource === 'pyth-lazer' || dataSource === 'hyperliquid') {
        overlayBinance24hStats().catch(() => { });
      }

      // Supplemental: fill coins not covered by primary source.
      // Tries Binance first (covers ~37 coins), then CoinGecko for any remaining holes
      // (XTZ, PEPE, AERO, HYPE not on Pyth; Binance may not carry AERO/HYPE).
      try {
        const supp = await fetchSupplementalTickers(rawTickers);
        if (Array.isArray(supp)) supp.forEach(t => { if (t?.instrument_name) tickers[t.instrument_name] = t; });
      } catch (err) {
        console.warn('[WE] Supplemental fetch failed:', err.message);
      }

      // Hard fail only if every live source returned nothing AND no stale tickers exist
      if (!rawTickers.length && Object.keys(tickers).length === 0) {
        throw new Error('No market tickers available from any source');
      }

      // Build lookup map
      rawTickers.forEach(t => { tickers[t.instrument_name] = t; });
      window._appTickers = tickers; // expose for prediction engine
      window._lastTickerFetchTs = Date.now(); // for stale badge

      // Build sparkline buffers from last/change
      WATCHLIST.forEach(c => {
        const t = tickers[c.instrument];
        if (!t) return;
        const price = parseFloat(t.last);
        const chg = parseFloat(t.change);
        if (!sparkData[c.sym]) sparkData[c.sym] = [];
        // Keep rolling 20-point buffer
        sparkData[c.sym].push(price);
        if (sparkData[c.sym].length > 20) sparkData[c.sym].shift();
      });

      // Async: Fetch Kalshi market data in background (non-blocking)
      fetchKalshiData().catch(err => {
        console.warn('[Kalshi] Background fetch failed:', err.message);
      });

      updateHeaderSummary();
      setFeedStatus('live', dataSource);
      updateLastUpdateLabel();
      refreshActiveView(manual);
      scheduleWebStatePublish('fetchAll-success', 120);

    } catch (err) {
      console.error('Fetch error:', err);
      // Keep live status if we already have ticker data — only go red if completely blind
      if (Object.keys(tickers).length > 0) {
        setFeedStatus('degraded');
        refreshActiveView(manual);
      } else {
        setFeedStatus('error');
        render(); // still render so nav works even with empty data
      }
    } finally {
      _fetchAttempted = true;
      scheduleWebStatePublish('fetchAll-finally', 120);

      // ── ACTIVATE CMC POLLING ON FIRST APP STARTUP ────────────────
      if (window._cmcProFeed && typeof window._cmcProFeed.startPolling === 'function' && !window._cmcPollingStarted) {
        try {
          window._cmcProFeed.startPolling(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'], 60000);
          window._cmcPollingStarted = true;
          console.log('[App] ✅ CMC polling activated (1-hour interval)');
        } catch (cmcErr) {
          console.warn('[App] Failed to start CMC polling:', cmcErr.message);
        }
      }

      // ── ACTIVATE PYTH CLIENT ON FIRST APP STARTUP ──────────────────
      if (window.PythClient && typeof window.PythClient.startPolling === 'function' && !window._pythClientStarted) {
        try {
          window.PythClient.startPolling();
          window._pythClientStarted = true;
          console.log('[App] ✅ PYTH price feed activated');
        } catch (pythErr) {
          console.warn('[App] Failed to start PYTH client:', pythErr.message);
        }
      }
    }

    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }

  function setFeedStatus(state, source) {
    if (!feedDot || !feedText) return;
    feedDot.className = 'pulse-dot';
    const src = source && source !== 'cdc' && source !== 'cache' ? ` · ${source.toUpperCase()}` : '';
    if (state === 'loading') { feedDot.classList.add('loading'); feedText.textContent = 'Refreshing...'; }
    else if (state === 'live') { feedDot.classList.add('live'); feedText.textContent = `Live${src}`; }
    else if (state === 'degraded') { feedDot.classList.add('degraded'); feedText.textContent = 'Stale ⚠'; }
    else { feedDot.classList.add('error'); feedText.textContent = 'Error'; }
  }

  function resetTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    // Fallback to interval-based refresh if async engine not available
    const interval = Math.max(15000, (refreshSecs || 15) * 1000);
    refreshTimer = setInterval(() => {
      void fetchAll();
    }, interval);
    console.log(`[WE] Refresh timer set to ${interval}ms`);
  }

  // Live clock + last update age label (updates every second)
  let lastUpdateTicker = null;
  function updateLastUpdateLabel() {
    if (!lastUpdate) return;
    const utc4Now = new Date(Date.now() - (4 * 60 * 60 * 1000));
    const utc4Clock = utc4Now.toISOString().slice(11, 19);
    const lastTs = Number(window._lastTickerFetchTs || 0);
    if (lastTs > 0) {
      const ageSec = Math.max(0, Math.floor((Date.now() - lastTs) / 1000));
      lastUpdate.textContent = `UTC-4 ${utc4Clock} · Updated ${ageSec}s ago`;
    } else {
      lastUpdate.textContent = `UTC-4 ${utc4Clock} · Waiting for first tick`;
    }
  }

  function startLastUpdateTicker() {
    if (lastUpdateTicker) clearInterval(lastUpdateTicker);
    updateLastUpdateLabel();
    lastUpdateTicker = setInterval(updateLastUpdateLabel, 1000);
  }

  // Countdown ticker — updates status badge every second to show seconds until next refresh
  let countdownTicker = null;
  function startCountdownTicker() {
    if (countdownTicker) clearInterval(countdownTicker);
    countdownTicker = setInterval(() => {
      updateMarketSummary(); // Re-render the countdown every second
    }, 1000);
  }

  // ── Kalshi background polling (ASYNC ENGINE) ─────────────────────────────
  // ★ NEW: Replaced with async engine event listeners
  // Listens to 'kalshi:balance-updated' event instead of polling manually
  let kalshiPollTimer = null; // kept for compatibility, but unused

  function startKalshiPolling() {
    if (!window._asyncRefreshEngine) {
      console.warn('[WE] Async engine not loaded yet — skipping Kalshi polling setup');
      return;
    }

    // Subscribe to balance updates from async engine
    const unsub = window._asyncRefreshEngine.on('kalshi:balance-updated', (data) => {
      // Update UI badge with new balance
      const badge = document.getElementById('kalshiBadge');
      const balanceEl = document.getElementById('kalshiBalance');
      if (badge && balanceEl) {
        badge.hidden = false;
        const dollars = (data.balance / 100).toFixed(2);
        balanceEl.textContent = `$${dollars}`;
        balanceEl.classList.add('updating');
        setTimeout(() => balanceEl.classList.remove('updating'), 300);
      }
      console.log(`[Kalshi] Balance updated: $${(data.balance / 100).toFixed(2)}`);
    });

    console.log('[WE] Kalshi polling connected to async engine');
    return unsub;
  }

  function startAsyncRefreshEngine() {
    if (_asyncRefreshEngineBooted) return;
    if (!window._asyncRefreshEngine?.start) {
      console.warn('[WE] Async refresh engine unavailable — keeping legacy timers active');
      return;
    }

    _asyncRefreshEngineBooted = true;

    window._asyncRefreshEngine.on('predictions:updated', () => {
      _lastPredictionRunTs = Date.now();
      predsLoaded = true;
      try { snapshotPredictions(); } catch (_) { }
      if (['predictions', 'cfm', 'universe'].includes(currentView)) refreshActiveView();
      scheduleWebStatePublish('async-predictions', 100);
    });

    window._asyncRefreshEngine.on('orderbook:imbalance', () => {
      try { window._runAdaptiveLiveRetune?.('orderbook-imbalance-event'); } catch (_) {}
      if (['predictions', 'cfm', 'universe'].includes(currentView)) {
        refreshActiveView();
      }
      scheduleWebStatePublish('async-orderbook', 50);
    });

    window._asyncRefreshEngine.on('market:data-updated', () => {
      if (['cfm', 'predictions', 'universe', 'markets5m', 'charts'].includes(currentView)) {
        refreshActiveView();
      }
      scheduleWebStatePublish('async-market', 100);
    });

    window._asyncRefreshEngine.on('settlement:pulse', () => {
      refreshActiveView();
      scheduleWebStatePublish('async-settlement', 100);
    });

    void window._asyncRefreshEngine.start().catch(err => {
      console.warn('[WE] Async refresh engine start failed:', err.message);
      _asyncRefreshEngineBooted = false;
    });
  }

  function stopKalshiPolling() {
    // Unsubscribe handled via returned unsub function from startKalshiPolling()
    if (kalshiPollTimer) {
      clearInterval(kalshiPollTimer);
      kalshiPollTimer = null;
    }
  }

  // Start polling on app init
  startKalshiPolling();

  // ── Historical Settlement Fetcher & Adaptive Learning (30-second cycle) ────
  let historicalPollTimer = null;
  let settledFetcher = null;
  let learningEngine = null;

  function syncAdaptiveWeightsToPredictionEngine() {
    if (!learningEngine || !window.PredictionEngine?.setAdaptiveWeights) return false;

    const weightsByCoin = window._adaptiveWeights || learningEngine.signalWeights || {};
    let applied = false;

    for (const [coin, weights] of Object.entries(weightsByCoin)) {
      if (!weights || typeof weights !== 'object') continue;
      window.PredictionEngine.setAdaptiveWeights(coin, weights);
      applied = true;
    }

    if (applied) {
      window._adaptiveWeightsSyncedAt = Date.now();
    }

    return applied;
  }

  function initHistoricalLearning() {
    if (!settledFetcher && typeof HistoricalSettlementFetcher !== 'undefined') {
      settledFetcher = new HistoricalSettlementFetcher();
      console.log('[App] HistoricalSettlementFetcher initialized');
    }
    if (!learningEngine && typeof AdaptiveLearningEngine !== 'undefined') {
      learningEngine = new AdaptiveLearningEngine();
      console.log('[App] AdaptiveLearningEngine initialized');
    }
    syncAdaptiveWeightsToPredictionEngine();
  }

  function startHistoricalPolling() {
    if (historicalPollTimer) return; // already running

    initHistoricalLearning();

    historicalPollTimer = setInterval(async () => {
      try {
        if (!settledFetcher || !learningEngine) {
          initHistoricalLearning();
          return;
        }

        // Fetch settled contracts from historical market data
        const { settled, errors } = await settledFetcher.fetchSettledContracts();

        if (settled && settled.length > 0) {
          console.log(`[Historical] Fetched ${settled.length} settled contracts`);

          // Add historical settlements to _kalshiLog for scorecard display
          settled.forEach(contract => {
            // Check if already in log (avoid duplicates)
            const isDuplicate = window._kalshiLog.some(e =>
              e.sym === contract.symbol &&
              e.resolved_at === contract.resolvedAt
            );

            if (!isDuplicate) {
              const _resultIsYes = String(contract.result).toUpperCase() === 'YES';
              const _historicalStrikeDir = String(contract.strikeType ?? contract.raw?.strike_type ?? 'above').toLowerCase() === 'below'
                ? 'below'
                : 'above';
              const _actualOutcome = _resultIsYes
                ? (_historicalStrikeDir === 'below' ? 'DOWN' : 'UP')
                : (_historicalStrikeDir === 'below' ? 'UP' : 'DOWN');
              const _predictionDir = contract.modelCorrect === true
                ? _actualOutcome
                : contract.modelCorrect === false
                  ? _oppositeDir(_actualOutcome)
                  : (window._lastPrediction?.[contract.symbol]?.direction || null);
              window._kalshiLog.push({
                sym: contract.symbol,
                outcome: contract.result,  // 'YES' or 'NO'
                actualOutcome: _actualOutcome,
                modelCorrect: contract.modelCorrect ?? null,
                marketCorrect: contract.marketCorrect ?? null,
                settledTs: contract.resolvedAt ? new Date(contract.resolvedAt).getTime() : Date.now(),
                ts: contract.openTime ? new Date(contract.openTime).getTime() : Date.now(),
                resolved_at: contract.resolvedAt,
                created_at: contract.openTime,
                _settled: true,
                _historical: true  // Mark as loaded from historical fetcher
              });

              _journalSettlement(contract.symbol, _actualOutcome, null, {
                source: 'historical-fetcher',
                modelCorrect: contract.modelCorrect ?? null,
                predictionDir: _predictionDir,
              });
            }
          });

          // Keep _kalshiLog limited to LOG_CAP entries
          if (window._kalshiLog.length > LOG_CAP) {
            window._kalshiLog = window._kalshiLog.slice(-LOG_CAP);
          }
          saveKalshiLog();
          if (currentView === 'log' || currentView === 'debuglog') render();

          // Record outcomes for learning engine
          for (const contract of settled) {
            if (contract.symbol && contract.result) {
              // Simulate prediction from model at contract open time
              const prediction = await getPredictionForCoin(contract.symbol, contract.openTime);

              if (prediction) {
                if (typeof learningEngine.recordSignalContribution === 'function') {
                  learningEngine.recordSignalContribution(
                    contract.symbol,
                    prediction.signals, // { RSI, MACD, CCI, ... }
                    prediction.weights, // { RSI: 1.2, MACD: 0.9, ... }
                    (() => {
                      const strike = String(contract?.raw?.strikeType ?? contract?.raw?.strike_type ?? 'above').toLowerCase();
                      const yesDir = strike === 'below' ? 'DOWN' : 'UP';
                      const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
                      return String(contract.result).toUpperCase() === 'YES' ? yesDir : noDir;
                    })()
                  );
                }
              }
            }
          }

          // Auto-tune weights every 2 minutes if enough samples
          const shouldTune = Date.now() % 120000 < 30000; // tune every 2 min window
          if (shouldTune && typeof learningEngine.autoTuneWeights === 'function') {
            const tuned = learningEngine.autoTuneWeights();
            if (tuned && Object.keys(tuned).length > 0) {
              console.log('[Learning] Weights auto-tuned:', tuned);
              syncAdaptiveWeightsToPredictionEngine();
            }
          }

          // Display scorecard
          if (typeof learningEngine.getAccuracyReport === 'function') {
            const scorecard = learningEngine.getAccuracyReport();
            window._accuracyScorecard = scorecard;
            console.log('[Accuracy]', scorecard);
          }
        }

        if (errors && errors.length > 0) {
          console.warn('[Historical] Fetch errors:', errors);
        }
      } catch (err) {
        console.error('[Historical] Polling error:', err.message);
      }
    }, 30000); // poll every 30 seconds
  }

  function stopHistoricalPolling() {
    if (historicalPollTimer) {
      clearInterval(historicalPollTimer);
      historicalPollTimer = null;
    }
  }

  // Helper: get prediction for a coin at a specific time (stub for now)
  async function getPredictionForCoin(symbol, timestamp) {
    if (!window.PredictionEngine) return null;
    try {
      return window.PredictionEngine.predict(symbol);
    } catch (err) {
      return null;
    }
  }

  // Start historical learning on app init
  startHistoricalPolling();

  // Sync cached contracts from drive to memory (Kalshi debug panel accuracy scorecard)
  if (typeof KalshiAccuracyDebug !== 'undefined' && KalshiAccuracyDebug.syncDriveCacheToMemory) {
    setTimeout(() => {
      KalshiAccuracyDebug.syncDriveCacheToMemory().catch(err =>
        console.warn('[App] Drive cache sync failed:', err.message)
      );
    }, 2000); // defer slightly to let app settle
  }

  function syncPredictionRefresh() {
    const shouldRun = (['predictions', 'cfm', 'universe'].includes(currentView)) && window.PredictionEngine;
    if (shouldRun && !predictionRefreshHandle) {
      if (window.CFMEngine && !cfmStarted && !_cfmStarting) {
        _cfmStarting = true;
        CFMEngine.start()
          .then(() => {
            cfmStarted = true;
            _cfmStarting = false;
            window._cfmAll = CFMEngine.getAll ? CFMEngine.getAll() : {};
            if (['predictions', 'cfm', 'universe'].includes(currentView)) render();
          })
          .catch(e => {
            _cfmStarting = false;
            console.error('[CFM] engine start failed:', e);
          });
      }
      const PREFETCH_LEAD_MS = 60000; // warm cache 60s before each boundary

      // ── Prefetch: fires 60s before each :00/:15/:30/:45 ─────────────────
      let prefetchTimer = null;
      function schedulePrefetch() {
        clearTimeout(prefetchTimer);
        const msToBoundary = msUntilNextQuarter();
        // If >60s to go: schedule 60s before the boundary
        // If ≤60s to go: skip this boundary, target the next one
        const lead = msToBoundary > PREFETCH_LEAD_MS
          ? msToBoundary - PREFETCH_LEAD_MS
          : msToBoundary + 15 * 60 * 1000 - PREFETCH_LEAD_MS;
        prefetchTimer = setTimeout(() => {
          if (window.PredictionEngine && PredictionEngine.warmCache) {
            PredictionEngine.warmCache().catch(() => { });
          }
          // Also pre-fetch X sentiment so SNT orbital is warm at boundary
          if (window.SocialSentiment && SocialSentiment.hasKey()) {
            SocialSentiment.fetchAll().catch(() => { });
          }
          schedulePrefetch(); // reschedule for the boundary after next
        }, Math.max(500, lead));
      }
      schedulePrefetch();

      // ── Score: fires at each :00/:15/:30/:45 ─────────────────────────────
      const scoreHandle = scheduleOnQuarterHours(async () => {
        // Bug fix: guard checked before await — must re-check after too
        if (!['predictions', 'cfm', 'universe'].includes(currentView) || document.hidden || predictionRunInFlight) return;
        try {
          const predictionRun = startPredictionRun();
          await predictionRun;
          _lastPredictionRunTs = Date.now();
          predsLoaded = true;
          snapshotPredictions();
          // Bug fix: re-check currentView after the async gap
          if (['predictions', 'cfm', 'universe'].includes(currentView)) refreshActiveView();
        } catch { }
      });

      predictionRefreshHandle = {
        cancel() { scoreHandle.cancel(); clearTimeout(prefetchTimer); }
      };

    } else if (!shouldRun && predictionRefreshHandle) {
      predictionRefreshHandle.cancel();
      predictionRefreshHandle = null;
    }
  }

  window.addEventListener('predictionadvancedready', () => {
    if (currentView !== 'predictions' || !predsLoaded || predictionRunInFlight) return;
    refreshActiveView();
  });

  // Phase 2 enrichment complete — re-snapshot and re-render predictions with full exchange data
  window.addEventListener('predictionsEnriched', () => {
    snapshotPredictions();
    if (currentView !== 'predictions' || !predsLoaded || predictionRunInFlight) return;
    refreshActiveView();
  });

  // Inference overlay complete — capture latest LLM context and refresh cards
  window.addEventListener('predictioninference', () => {
    scheduleWebStatePublish('predictioninference', 75);
    if (!predsLoaded || predictionRunInFlight) return;
    if (['predictions', 'cfm', 'universe'].includes(currentView)) refreshActiveView();
  });

  window.addEventListener('predictiontide', () => {
    scheduleWebStatePublish('predictiontide', 75);
    if (!predsLoaded || predictionRunInFlight) return;
    if (['predictions', 'cfm', 'universe'].includes(currentView)) refreshActiveView();
  });

  window.addEventListener('predictions:microstructure-updated', () => {
    try { window._runAdaptiveLiveRetune?.('microstructure-updated'); } catch (_) {}
    scheduleWebStatePublish('microstructure-prediction', 50);
    if (!predsLoaded || predictionRunInFlight) return;
    if (['predictions', 'cfm', 'universe'].includes(currentView)) refreshActiveView();
  });

  // ================================================================
  // HELPERS
  // ================================================================

  // ── Prediction snapshot & accuracy helpers ───────────────────────────────

  // ── PATCH1.11: 15M Prediction Stability Lock ──────────────────────────────
  // One candle cannot flip a 15-minute Kalshi contract prediction.
  // Once a direction is committed for the active 15M bucket, we require
  // MIN_FLIP_STREAK consecutive opposing snapshots (~45s at 15s refresh)
  // before accepting a direction change. A single wick candle is ignored.
  if (!window._predLock) window._predLock = {};
  const _BUCKET_MS = 15 * 60 * 1000;
  const MIN_FLIP_STREAK = 5; // 5 × 15s refresh = 75s of sustained opposing signal required (no fast-path)
  let _webStatePublishTimer = null;
  let _webStateHeartbeat = null;
  let _lastWebStateSig = '';

  // Call after every PredictionEngine.runAll() to capture the current signal per coin
  function snapshotPredictions() {
    const preds = window._predictions || {};
    const nowMs = Date.now();

    _llmCycleCount++;

    PREDICTION_COINS.forEach(coin => {
      const p = preds[coin.sym];
      
      const pm = window.PredictionMarkets?.getCoin?.(coin.sym);
      const k15Close = pm?.kalshi15m?.closeTime;
      const currentBucket = k15Close ? new Date(k15Close).getTime() : Math.ceil((nowMs + 45000) / _BUCKET_MS) * _BUCKET_MS;

      // ── Record missing or disabled prediction as error ─────────────────────
      if (!p || !p.price) {
        if (window._aggregator) {
          try {
            const reason = !p ? 'NO_PREDICTION' : 'NO_PRICE_DATA';
            window._aggregator.recordError(coin.sym, reason, reason, { prediction: p });
          } catch (e) { /* non-critical */ }
        }
        return;
      }

      if (p.disabled) {
        if (window._aggregator) {
          try {
            window._aggregator.recordError(coin.sym, 'SIGNAL_DISABLED', p.disabledReason || 'Signal disabled', { prediction: p });
          } catch (e) { /* non-critical */ }
        }
        return;
      }

      const signalDir = p.signal === 'strong_bull' || p.signal === 'bullish' ? 'UP'
        : p.signal === 'strong_bear' || p.signal === 'bearish' ? 'DOWN'
          : 'FLAT';
      const scoreDir = p.score > 0.08 ? 'UP' : p.score < -0.08 ? 'DOWN' : 'FLAT';
      if (signalDir !== 'FLAT' && scoreDir !== 'FLAT' && signalDir !== scoreDir) {
        logContractError('signal_score_mismatch', coin.sym, {
          signal: p.signal,
          signalDir,
          scoreDir,
          score: +Number(p.score || 0).toFixed(4),
          confidence: p.confidence ?? null,
        });
        if (window.DataLogger?.logLogicDebug) {
          window.DataLogger.logLogicDebug('snapshotPredictions', 'signal_score_mismatch', {
            sym: coin.sym,
            signal: p.signal,
            signalDir,
            scoreDir,
            score: +Number(p.score || 0).toFixed(4),
            confidence: p.confidence ?? null,
          });
        }
      }
      // Direction must always follow score sign to avoid label-mapping regressions.
      const rawDir = scoreDir !== 'FLAT' ? scoreDir : signalDir;

      // ── Stability gate ──────────────────────────────────────────────────
      let lock = window._predLock[coin.sym];
      if (!lock || lock.bucketTs !== currentBucket) {
        // New 15M bucket: reset lock and accept whatever the model says
        lock = { bucketTs: currentBucket, lockedDir: rawDir, flipStreak: 0, flipDir: null };
      } else if (rawDir === 'FLAT') {
        // FLAT is a neutral wiggle: pause, do not reset or increment the flip streak
      } else if (rawDir === lock.lockedDir) {
        // Agrees with locked direction: reinforce, clear any flip streak
        lock.flipStreak = 0;
        lock.flipDir = null;
      } else {
        // Opposing signal: accumulate streak
        if (lock.flipDir === rawDir) {
          lock.flipStreak++;
        } else {
          lock.flipDir = rawDir;
          lock.flipStreak = 1;
        }
        // ── Fast-path: pure drift flip needs only 1 snapshot ───────────────
        // If the proprietary momentum gate shows a hardGated clean flip
        // (driftPurity >= 0.60, streak confirmed), don't wait 45s — exit now.
        const ft = p.diagnostics?.fastTiming;
        const pureFlip = ft?.hardGated && ft?.momentumQuality >= 0.60
          && Math.sign(ft?.score || 0) !== 0
          && Math.sign(ft?.score || 0) !== (rawDir === 'UP' ? -1 : 1);
        const requiredStreak = pureFlip ? 1 : MIN_FLIP_STREAK;

        if (lock.flipStreak >= requiredStreak) {
          // Sustained reversal confirmed — accept flip
          const oldDir = lock.lockedDir;
          lock.lockedDir = rawDir;
          lock.flipStreak = 0;
          lock.flipDir = null;
          if (oldDir !== 'FLAT') {
            const flipReason = pureFlip
              ? `Pure thin drift flip detected · ${(ft.momentumQuality * 100).toFixed(0)}% quality`
              : `${coin.sym} ${oldDir}→${rawDir} confirmed (${requiredStreak}× sustained)`;
            try {
              window.dispatchEvent(new CustomEvent('cfm:earlyExit', {
                detail: {
                  sym: coin.sym,
                  reason: flipReason,
                  strength: pureFlip ? Math.min(0.95, 0.70 + ft.momentumQuality * 0.25) : 0.8,
                  prediction: oldDir,
                  type: pureFlip ? 'pure_drift_flip' : 'confirmed_prediction_flip',
                  severity: 'high',
                  shouldExit: true,
                  driftQuality: ft?.momentumQuality ?? null,
                }
              }));
            } catch (_e) { /* non-critical */ }
          }
        }
      }
      window._predLock[coin.sym] = lock;
      const dir = lock.lockedDir !== 'FLAT' ? lock.lockedDir : rawDir;

      window._lastPrediction[coin.sym] = {
        direction: dir, price: p.price, signal: p.signal, ts: nowMs,
        rawDir, flipStreak: lock.flipStreak, bucketTs: currentBucket,
      };

      _journalPrediction(coin.sym, p, dir, currentBucket);

      // ── Record prediction in scorecard aggregator ───────────────────────
      if (window._aggregator) {
        try {
          const confidence = (p.confidence ?? 0) * 100; // Convert to 0-100 scale
          const signals = p.signal || {};
          window._aggregator.recordPrediction(coin.sym, dir, confidence, signals);
        } catch (e) { /* non-critical */ }
      }

      // ── Record prediction in 2-hour contract cache (NEW) ─────────────────
      if (window._contractCache) {
        try {
          const confidence = (p.confidence ?? 0) * 100;
          const signals = p.signal || {};
          window._contractCache.recordPrediction(coin.sym, dir, confidence, signals);
        } catch (e) {
          console.warn('[ContractCache] Prediction record error:', e.message);
        }
      }

      // ── Record compact market context for inference recall ────────────────
      if (window._contractCache?.recordMarketContext) {
        try {
          const topDrivers = Array.isArray(p.diagnostics?.topDrivers)
            ? p.diagnostics.topDrivers.slice(0, 3).map(driver => ({
              name: driver?.name || '',
              value: Number(driver?.value || 0),
              weight: Number(driver?.weight || 0),
            }))
            : [];
          const kaCtx = p.projections?.p15?.kalshiAlign || null;

          window._contractCache.recordMarketContext(coin.sym, {
            price: Number(p.price || 0),
            signal: p.signal || 'neutral',
            score: Number(p.score || 0),
            confidence: Number(p.confidence || 0),
            regime: p.liveRegime?.regime || null,
            regimeLabel: p.liveRegime?.label || null,
            agreement: Number(p.diagnostics?.agreement || 0),
            conflict: Number(p.diagnostics?.conflict || 0),
            routedAction: p.diagnostics?.routedAction || null,
            kalshiYesPct: kaCtx?.kalshiYesPct ?? null,
            modelYesPct: kaCtx?.modelYesPct ?? null,
            llmRegime: p.llm?.regime || p.diagnostics?.llmRegime || null,
            llmConfidence: Number(p.llm?.confidence || p.diagnostics?.llmConfidence || 0),
            topDrivers,
          }, { sync: false });
        } catch (e) {
          console.warn('[ContractCache] Market context record error:', e.message);
        }
      }

      // Snapshot Kalshi alignment state so we can evaluate outcome on bucket close
      const ka = p.projections?.p15?.kalshiAlign ?? null;
      if (ka?.ref != null && ka.kalshiYesPct != null) {
        // ── Compute fade state ───────────────────────────────────────────────
        const _strikeDir = ka.strikeDir === 'below' ? 'below' : 'above';
        const _yesDir = _strikeDir === 'below' ? 'down' : 'up';
        const _noDir = _yesDir === 'up' ? 'down' : 'up';
        const _modelScore = p.score ?? 0;
        const _modelConf = p.confidence ?? null;
        const _modelDirRaw = _modelScore > 0.08 ? 'up' : _modelScore < -0.08 ? 'down' : 'wait';
        const _modelDir = (ka.modelYesPct ?? 50) >= 58 ? _yesDir
          : (ka.modelYesPct ?? 50) <= 42 ? _noDir
            : _modelDirRaw;
        const _kalshiDir = ka.kalshiYesPct >= 50 ? _yesDir : _noDir;
        const _fadeActive = _modelDir !== 'wait' && _modelDir !== _kalshiDir;
        const _fadeSolid = _fadeActive && Math.abs(_modelScore) >= 0.20;
        // betAction: same priority as prediction card — Kalshi certainty → CDF yesPct → raw score
        const _snapDir = ka.kalshiYesPct >= 90 ? _yesDir
          : ka.kalshiYesPct <= 10 ? _noDir
            : (ka.modelYesPct ?? 50) >= 58 ? _yesDir
              : (ka.modelYesPct ?? 50) <= 42 ? _noDir
                : _modelDirRaw;
        const _betAction = _snapDir === _yesDir ? 'YES' : _snapDir === _noDir ? 'NO' : null;

        // ── Update Market Divergence tracker for this coin ──────────────────
        const _mdiv = updateMarketDivergence(coin.sym, _modelDir, _kalshiDir, ka.kalshiYesPct, _modelScore);

        window._lastKalshiSnapshot[coin.sym] = {
          ref: ka.ref,
          kYesPct: ka.kalshiYesPct,
          mYesPct: ka.modelYesPct,
          modelDir: _snapDir,
          ts: nowMs,
          // Contract structural fields — now passed through from prediction-markets.js
          floorPrice: ka.floorPrice ?? ka.ref,
          capPrice: ka.capPrice ?? null,
          strikeDir: _strikeDir,
          strikeType: ka.strikeType ?? null,
          ticker: ka.ticker ?? null,
          closeTimeMs: ka.closeTimeMs ?? null,
          // Diagnostic flags
          dirConflict: ka.dirConflict ?? false,
          cdfImpliedDir: ka.cdfImpliedDir ?? null,
          // Fade & model state
          fadeActive: _fadeActive,
          fadeSolid: _fadeSolid,
          betAction: _betAction,
          modelScore: _modelScore,
          modelConf: _modelConf,
          quantRegime: p.diagnostics?.quantRegime || null,
          cfmCalibration: p.diagnostics?.cfmCalibration || null,
          executionGuard: p.diagnostics?.executionGuard || null,
          // Market Divergence state
          mdivPhase: _mdiv.phase ?? 'STALE',
          mdivDurationMs: _mdiv.durationMs ?? 0,
          mdivCatchupDelta: _mdiv.catchupDelta ?? 0,
          // Signal components for per-indicator gradient descent retuner
          signalComponents: p.diagnostics?.components ?? null,
        };
        capturePredictionTrail2m(coin.sym, window._lastKalshiSnapshot[coin.sym]);
        if (ka.dirConflict) {
          console.warn(
            `[Snapshot] ⚠️ ${coin.sym} momentum=${dir} conflicts with CDF direction=${ka.cdfImpliedDir} ` +
            `(mYesPct=${ka.modelYesPct}% kYesPct=${ka.kalshiYesPct}% strike=${ka.strikeDir} ref=${ka.ref})`
          );
        }
      }
    });

    // ── MACRO MARKET CONSENSUS EXIT (DISABLED) ──────────────────────────────────
    // Was firing too early, killing trades. Re-enable after careful tuning.
    // TODO: re-enable with 4+ coin threshold and MIN_FLIP_STREAK=7

    if (window._contractCache?.flushSync) {
      try { window._contractCache.flushSync(); } catch (_) { }
    }

    // ---- LLM Integration Trigger ----
    // Fire background LLM analysis every 4 cycles (~60s) to refresh narrations non-blockingly
    if (window._llmIntegration && (_llmCycleCount % 4 === 0)) {
      Object.entries(preds).forEach(([sym, p]) => {
        try {
          window._llmIntegration.analyze(sym, p, {}).catch(err => {
            console.warn(`[LLMEngine] background analysis for ${sym} failed:`, err.message);
          });
        } catch (err) { }
      });
    }

    saveLastPred();
    saveLastKalshi();
    scheduleWebStatePublish('prediction-snapshot');
  }

  function _webStateConfiguredCoins() {
    const list = Array.isArray(window.PREDICTION_COINS)
      ? window.PREDICTION_COINS
      : ((typeof PREDICTION_COINS !== 'undefined' && Array.isArray(PREDICTION_COINS)) ? PREDICTION_COINS : []);
    return Array.isArray(list) ? list : [];
  }

  const WEB_STATE_SCHEMA_VERSION = 'wecrypto.web.v2';
  let _webStateRevision = 0;

  function _webNum(value, digits = null) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return digits == null ? n : Number(n.toFixed(digits));
  }

  function _deriveWebDirection(pred, lockedDir = null) {
    if (lockedDir && lockedDir !== 'FLAT') return lockedDir;
    const score = Number(pred?.score || 0);
    if (score > 0.08) return 'UP';
    if (score < -0.08) return 'DOWN';
    const signal = String(pred?.signal || '').toLowerCase();
    if (signal.includes('bull')) return 'UP';
    if (signal.includes('bear')) return 'DOWN';
    return null;
  }

  function _webDirectionOrWait(direction) {
    return direction === 'UP' || direction === 'DOWN' ? direction : 'WAIT';
  }

  function _deriveDecisionStatus(intent, summary) {
    if (!intent || typeof intent !== 'object') return 'model-only';
    if (intent.signalLocked) return 'locked';
    if (intent.crowdFade) return 'crowd-fade';
    if (intent.crowdFadeSuggested) return 'candidate';
    const text = `${intent.humanReason || ''} ${intent.reason || ''} ${summary || ''}`.toLowerCase();
    if (/veto/.test(text)) return 'vetoed';
    if (intent.action === 'earlyExit') return 'early-exit';
    if (intent.action === 'skip') return 'skip';
    if (intent.action === 'trade') return 'trade';
    if (intent.action === 'watch') return 'watch';
    return intent.action || 'model-only';
  }

  function buildWebStateSnapshot() {
    const configuredCoins = _webStateConfiguredCoins();
    const activeCoins = configuredCoins.map(c => c?.sym).filter(Boolean);
    const predAll = window.PredictionEngine?.getAll?.() || window._predictions || {};
    const chainAll = window.BlockchainScan?.getAll?.() || {};
    const congestionAll = window.NetworkCongestion?.getAll?.() || {};
    const predictions = {};
    const signals = {};
    const kalshiMarkets = {};
    const stats = {};

    configuredCoins.forEach((coin) => {
      const sym = coin?.sym;
      if (!sym) return;

      const pred = predAll?.[sym] || null;
      const locked = window._lastPrediction?.[sym] || null;
      const rawModelDirection = _deriveWebDirection(pred, null);
      const pm = window.PredictionMarkets?.getCoin?.(sym) || null;
      const kalshi15m = pm?.kalshi15m || null;
      const intent = window.KalshiOrchestrator?.getIntent?.(sym) || null;
      const align = pred?.projections?.p15?.kalshiAlign || null;
      const operatorSummary = intent?.humanReason ?? intent?.reason ?? null;
      const decisionStatus = _deriveDecisionStatus(intent, operatorSummary);
      const biasDirection = _webDirectionOrWait(intent?.direction || rawModelDirection);
      const finalDirection = (decisionStatus === 'vetoed' || intent?.action === 'skip' || intent?.action === 'earlyExit')
        ? 'WAIT'
        : _webDirectionOrWait(intent?.direction || _deriveWebDirection(pred, locked?.direction || null));
      const machineDirection = _webDirectionOrWait(finalDirection);
      const publishedSourceTs = locked?.ts || window._lastTickerFetchTs || null;
      const confidencePct = Number.isFinite(Number(pred?.confidence))
        ? Math.round(Number(pred.confidence) * 100)
        : 0;
      const llmState = (pred?.llm && typeof pred.llm === 'object') ? pred.llm : null;
      const tideState = (pred?.tide && typeof pred.tide === 'object') ? pred.tide : null;

      if (pred) {
        predictions[sym] = {
          direction: machineDirection,
          finalDirection: machineDirection,
          biasDirection,
          rawModelDirection: _webDirectionOrWait(rawModelDirection),
          directionSource: machineDirection !== 'WAIT' && intent?.direction
            ? 'decision'
            : rawModelDirection ? 'model' : 'none',
          decisionStatus,
          action: intent?.action || null,
          side: intent?.side || null,
          score: _webNum(pred.score, 4),
          confidence: _webNum(pred.confidence, 3),
          confidencePct,
          signal: pred.signal || null,
          price: _webNum(pred.price, 8),
          probability: _webNum(kalshi15m?.probability ?? pm?.kalshi, 4),
          combinedProb: _webNum(pm?.combinedProb, 4),
          mispricingPp: _webNum(align?.divergence, 2),
          edgeCents: _webNum(intent?.edgeCents, 2),
          summary: operatorSummary,
          ts: publishedSourceTs,
          model: {
            direction: _webDirectionOrWait(rawModelDirection),
            score: _webNum(pred.score, 4),
            confidence: _webNum(pred.confidence, 3),
            confidencePct,
            signal: pred.signal || null,
            price: _webNum(pred.price, 8),
            ts: publishedSourceTs,
          },
          decision: {
            status: decisionStatus,
            action: intent?.action || null,
            direction: machineDirection,
            biasDirection,
            side: intent?.side || null,
            alignment: intent?.alignment || null,
            confidence: _webNum(intent?.confidence, 3),
            finalModelConfidence: _webNum(intent?.finalModelConfidence, 3),
            crowdFade: !!intent?.crowdFade,
            crowdFadeSuggested: !!intent?.crowdFadeSuggested,
            signalLocked: !!intent?.signalLocked,
            timingRegime: intent?.timingRegime || null,
            timingLabel: intent?.timingLabel || null,
            timingScore: _webNum(intent?.timingScore, 2),
            closeValue: !!intent?.closeValue,
            scalpFlip: !!intent?.scalpFlip,
            exitPlan: intent?.exitPlan || null,
            reason: intent?.reason || null,
            humanReason: intent?.humanReason || null,
          },
          operator: {
            summary: operatorSummary,
            reason: intent?.reason || null,
            humanReason: intent?.humanReason || null,
          },
          llm: llmState ? {
            regime: llmState.regime || 'unknown',
            confidence: Number.isFinite(Number(llmState.confidence)) ? Number(llmState.confidence) : 0,
            degraded: !!llmState.degraded,
            cooldownRemainingMs: Number.isFinite(Number(llmState.cooldownRemainingMs))
              ? Number(llmState.cooldownRemainingMs)
              : 0,
            provider: llmState.provider || null,
            warnings: Array.isArray(llmState.warnings) ? llmState.warnings.slice(0, 3) : [],
            notes: llmState.notes || null,
          } : null,
          tide: tideState ? {
            direction: _webDirectionOrWait(tideState.direction || null),
            confidence: Number.isFinite(Number(tideState.confidence)) ? Number(tideState.confidence) : 0,
            forecastPrice: _webNum(tideState.forecastPrice, 8),
            mode: tideState.mode || null,
            queued: !!tideState.queued,
            error: tideState.error || null,
            asOfTs: tideState.asOfTs || null,
          } : null,
          market: {
            probability: _webNum(kalshi15m?.probability ?? pm?.kalshi, 4),
            combinedProb: _webNum(pm?.combinedProb, 4),
            mispricingPp: _webNum(align?.divergence, 2),
            edgeCents: _webNum(intent?.edgeCents, 2),
            ticker: kalshi15m?.ticker ?? align?.ticker ?? null,
            strikeDir: kalshi15m?.strikeDir ?? align?.strikeDir ?? null,
            targetPriceNum: _webNum(kalshi15m?.targetPriceNum ?? align?.floorPrice ?? align?.ref, 8),
            closeTime: kalshi15m?.closeTime ?? null,
          },
          meta: {
            schemaVersion: WEB_STATE_SCHEMA_VERSION,
            sourceTs: publishedSourceTs,
            currentView,
          },
        };

        signals[sym] = {
          direction: machineDirection,
          finalDirection: machineDirection,
          biasDirection,
          rawModelDirection: _webDirectionOrWait(rawModelDirection),
          decisionStatus,
          confidence: confidencePct,
          signal: pred.signal || null,
          score: _webNum(pred.score, 4),
          action: intent?.action || null,
          summary: operatorSummary,
          tideDirection: tideState ? _webDirectionOrWait(tideState.direction || null) : null,
          tideConfidence: tideState && Number.isFinite(Number(tideState.confidence)) ? Number(tideState.confidence) : 0,
          tideMode: tideState?.mode || null,
          tideQueued: !!tideState?.queued,
        };
      }

      if (pm || intent || align) {
        kalshiMarkets[sym] = {
          ticker: kalshi15m?.ticker ?? align?.ticker ?? null,
          probability: _webNum(kalshi15m?.probability ?? pm?.kalshi, 4),
          combinedProb: _webNum(pm?.combinedProb, 4),
          closeTime: kalshi15m?.closeTime ?? null,
          strikeDir: kalshi15m?.strikeDir ?? align?.strikeDir ?? null,
          targetPriceNum: _webNum(kalshi15m?.targetPriceNum ?? align?.floorPrice ?? align?.ref, 8),
          action: intent?.action ?? null,
          mispricingPp: _webNum(align?.divergence, 2),
          edgeCents: _webNum(intent?.edgeCents, 2),
        };
      }
    });

    const blockchain = Object.fromEntries(
      Object.entries(chainAll).map(([sym, item]) => [sym, {
        signal: item?.signal || null,
        congestion: item?.congestion || null,
        source: item?.source || null,
        ts: item?.ts || null,
      }])
    );

    const congestion = Object.fromEntries(
      Object.entries(congestionAll).map(([sym, item]) => [sym, {
        networkLoad: _webNum(item?.networkLoad, 4),
        lastUpdate: item?.lastUpdate || null,
      }])
    );

    const networkStatus = {};
    if (Object.keys(blockchain).length) networkStatus.blockchain = blockchain;
    if (Object.keys(congestion).length) networkStatus.congestion = congestion;

    const validatorStats = window.Validator15m?.getStats?.() || null;
    if (validatorStats && typeof validatorStats === 'object') {
      stats.validator = validatorStats;
    }
    const calibrationTelemetry = window.KalshiOrchestrator?.getCalibrationTelemetry?.() || null;
    if (calibrationTelemetry && calibrationTelemetry.samples) {
      stats.orchestratorCalibration = calibrationTelemetry;
    }

    stats.export = {
      predictionCount: Object.keys(predictions).length,
      signalCount: Object.keys(signals).length,
      marketCount: Object.keys(kalshiMarkets).length,
      activeCoinCount: activeCoins.length,
    };

    return {
      schemaVersion: WEB_STATE_SCHEMA_VERSION,
      running: true,
      rendererReady: true,
      currentView,
      activeCoins,
      tickerTimestamp: window._lastTickerFetchTs || null,
      predictions,
      signals,
      kalshiMarkets,
      networkStatus,
      stats,
    };
  }

  function publishWebState(reason = 'update', force = false) {
    if (typeof window.electron?.web?.updateState !== 'function') return false;
    try {
      const payload = buildWebStateSnapshot();
      const signature = JSON.stringify(payload);
      if (!force && reason !== 'heartbeat' && signature === _lastWebStateSig) return false;
      _lastWebStateSig = signature;
      _webStateRevision += 1;
      window.electron.web.updateState({
        ...payload,
        revision: _webStateRevision,
        publishedAt: new Date().toISOString(),
        publishReason: reason,
      });
      return true;
    } catch (e) {
      console.warn('[WebState] Publish failed:', e.message);
      return false;
    }
  }

  function scheduleWebStatePublish(reason = 'update', delayMs = 300) {
    if (typeof window.electron?.web?.updateState !== 'function') return;
    if (_webStatePublishTimer) clearTimeout(_webStatePublishTimer);
    _webStatePublishTimer = setTimeout(() => {
      _webStatePublishTimer = null;
      publishWebState(reason);
    }, Math.max(0, delayMs));
  }

  function startWebStateHeartbeat() {
    if (_webStateHeartbeat) return;
    _webStateHeartbeat = setInterval(() => {
      publishWebState('heartbeat', true);
    }, 20000);
  }

  // ── Market Divergence ─────────────────────────────────────────────────────
  // Tracks per-coin divergence state: how long the model has been calling a
  // direction OPPOSITE to Kalshi crowd odds.  The divergence window is the
  // period BEFORE the crowd catches up — optimal timing for a fade bet.
  //
  // Phases:
  //   PRIME    — 0-60s, strong model (|score|≥0.20), market not yet moving → best entry
  //   ACTIVE   — 60-150s, still diverging cleanly
  //   CATCHING — Kalshi odds drifting ≥5pp toward model → entry window closing
  //   DIVERGING— Kalshi doubling down against model (≥8pp away) → elevated risk
  //   LATE     — >150s diverging → model may be wrong or contract expiring
  //   STALE    — no divergence (model aligns with crowd or model is neutral)
  function updateMarketDivergence(sym, modelDir, kalshiDir, kalshiPct, score) {
    const now = Date.now();
    const buf = window._marketDivergence[sym] || {};
    const isDiverging = modelDir !== 'wait' && kalshiDir !== null && modelDir !== kalshiDir;

    if (isDiverging) {
      if (!buf.active || !buf.firstDivTs) {
        buf.active = true;
        buf.firstDivTs = now;
        buf.entryKalshiPct = kalshiPct ?? 50;
        buf.entryScore = score;
        buf.entryModelDir = modelDir;
        buf.peakScore = Math.abs(score);
      }
      buf.durationMs = now - buf.firstDivTs;
      buf.currentKalshiPct = kalshiPct ?? 50;
      buf.currentScore = score;
      buf.peakScore = Math.max(buf.peakScore ?? 0, Math.abs(score));

      // catchupDelta > 0 means Kalshi is moving TOWARD the model's direction
      // (market catching up). Negative means diverging further.
      const catchupDelta = modelDir === 'up'
        ? buf.currentKalshiPct - buf.entryKalshiPct   // UP call → want YES% to rise
        : buf.entryKalshiPct - buf.currentKalshiPct; // DOWN call → want YES% to fall
      buf.catchupDelta = catchupDelta;

      const sec = buf.durationMs / 1000;
      if (catchupDelta >= 5) buf.phase = 'CATCHING';
      else if (catchupDelta <= -8) buf.phase = 'DIVERGING';
      else if (sec < 60 && Math.abs(score) >= 0.20) buf.phase = 'PRIME';
      else if (sec < 150) buf.phase = 'ACTIVE';
      else buf.phase = 'LATE';
    } else {
      if (buf.active && buf.firstDivTs) {
        buf.resolvedTs = now;
        buf.resolvedInMs = now - buf.firstDivTs;
        buf.resolvedPhase = buf.phase;
      }
      buf.active = false;
      buf.firstDivTs = null;
      buf.phase = 'STALE';
      buf.durationMs = 0;
      buf.catchupDelta = 0;
    }
    window._marketDivergence[sym] = buf;
    return buf;
  }

  // Returns rolling accuracy stats from _predLog
  function getPredAccuracy(sym = null, n = 50) {
    const log = sym
      ? window._predLog.filter(e => e.sym === sym)
      : window._predLog;
    const recent = log.slice(-n).filter(e => e.predDir !== 'FLAT');
    if (!recent.length) return null;
    const correct = recent.filter(e => e.correct).length;
    return {
      total: recent.length,
      correct,
      accuracy: (correct / recent.length) * 100,
      avgMove: recent.reduce((s, e) => s + Math.abs(e.pctMove), 0) / recent.length,
      perCoin: PREDICTION_COINS.map(c => {
        const coinLog = recent.filter(e => e.sym === c.sym);
        const cc = coinLog.filter(e => e.correct).length;
        return {
          sym: c.sym, total: coinLog.length, correct: cc,
          accuracy: coinLog.length ? (cc / coinLog.length) * 100 : null
        };
      }).filter(x => x.total > 0)
    };
  }

  // ── 15m bucket-close accuracy evaluation ─────────────────────────────────
  window.addEventListener('candleWS:bucketClosed', (e) => {
    const { sym, bucket } = e.detail || {};
    if (!sym || !bucket) return;
    const stored = window._lastPrediction[sym];
    if (!stored || stored.direction === 'FLAT') return;
    // Only evaluate if prediction was made before this bucket closed
    const bucketClose = bucket.t + 15 * 60 * 1000;
    if (stored.ts > bucketClose) return;

    const actual = bucket.c > bucket.o ? 'UP' : bucket.c < bucket.o ? 'DOWN' : 'FLAT';
    const pctMove = stored.price > 0
      ? ((bucket.c - stored.price) / stored.price) * 100
      : ((bucket.c - bucket.o) / bucket.o) * 100;

    const entry = {
      sym, ts: Date.now(), bucketT: bucket.t,
      predDir: stored.direction, actual,
      correct: stored.direction === actual,
      pctMove: +pctMove.toFixed(4),
      signal: stored.signal
    };
    window._predLog.push(entry);
    if (window._predLog.length > LOG_CAP) window._predLog.shift();
    savePredLog();

    // ── Kalshi outcome tracking ───────────────────────────────────────────
    // YES resolves if closing price ≥ reference threshold (meet or exceed)
    const kSnap = window._lastKalshiSnapshot[sym];
    if (kSnap?.ref != null && kSnap.ts <= bucketClose) {
      // Guard: verify this snapshot's Kalshi contract belongs to THIS 15m bucket.
      const bucketOpen = bucketClose - 15 * 60_000;
      const kCloseMs = kSnap.closeTimeMs;
      const windowOk = kCloseMs == null
        || (kCloseMs >= bucketOpen - 120_000 && kCloseMs <= bucketClose + 120_000);
      if (!windowOk) {
        console.warn(`[KalshiTracker] ${sym} ticker=${kSnap.ticker} closeTime=${kCloseMs} outside bucket [${bucketOpen}–${bucketClose}] — skipped`);
        logContractError('window_mismatch', sym, {
          ticker: kSnap.ticker, kCloseMs, bucketOpen, bucketClose,
        });
      } else {
        const refPrice = (kSnap.floorPrice > 0 ? kSnap.floorPrice : null) ?? kSnap.ref;
        const strikeDir = kSnap.strikeDir ?? 'above';
        const isBelowContract = strikeDir === 'below';

        // Direction-aware resolution: below contracts flip the yes/no comparison
        const yesResolved = isBelowContract ? (bucket.c < refPrice) : (bucket.c >= refPrice);
        const refDiffPct = Math.abs(bucket.c - refPrice) / refPrice * 100;
        // Wick detection: candle H/L straddles the ref price — close is unreliable
        // proxy for CF Benchmarks 60s TWAP. Flag and defer to authoritative result.
        const wickStraddle = bucket.l != null && bucket.h != null
          && bucket.l <= refPrice && bucket.h >= refPrice;
        // wickSize: how far the wick went through the ref as % of price — larger = more dangerous
        const wickSize = wickStraddle
          ? Math.max(bucket.h - refPrice, refPrice - bucket.l) / refPrice * 100
          : 0;
        // Near-ref: within 0.15% — TWAP and single-price can diverge on thin wicks
        const nearRef = refDiffPct < 0.15;
        const pendingAuth = wickStraddle || nearRef;

        // Proxy confidence: lower when wick straddles ref or price is very close
        const proxyConfidence = wickStraddle ? 45 : (refDiffPct < 0.30 ? 72 : 88);

        // Direction-conflict: momentum says one way, CDF probability says the other
        const dirConflict = kSnap.dirConflict ?? false;

        if (pendingAuth || dirConflict) {
          const reason = wickStraddle ? 'wick_straddle' : nearRef ? 'near_ref' : 'dir_conflict';
          if (pendingAuth) {
            console.warn(
              `[KalshiTracker] ⚠️ ${reason.toUpperCase()} ${sym}: close=${bucket.c.toFixed(4)} ` +
              `ref=${refPrice} gap=${refDiffPct.toFixed(4)}% ${wickStraddle ? `wickSize=${wickSize.toFixed(3)}%` : ''} ` +
              `H=${bucket.h} L=${bucket.l} strike=${strikeDir} ticker=${kSnap.ticker} ` +
              `— deferring to authoritative settlement`
            );
          }
          if (dirConflict) {
            console.warn(
              `[KalshiTracker] ⚠️ DIR_CONFLICT at close ${sym}: ` +
              `momentum=${kSnap.modelDir} cdfImplied=${kSnap.cdfImpliedDir} ` +
              `mYesPct=${kSnap.mYesPct}% proxy=${yesResolved ? 'YES' : 'NO'} ref=${refPrice}`
            );
          }
          logContractError(reason, sym, {
            ticker: kSnap.ticker, ref: refPrice, strikeDir,
            close: bucket.c, high: bucket.h, low: bucket.l,
            refDiffPct: +refDiffPct.toFixed(4), wickSize: +wickSize.toFixed(4),
            proxyYES: yesResolved, kYesPct: kSnap.kYesPct, mYesPct: kSnap.mYesPct,
            dirConflict, momentumDir: kSnap.modelDir, cdfImpliedDir: kSnap.cdfImpliedDir,
          });
        }

        const kEntry = {
          sym, ts: Date.now(), settledTs: Date.now(), ref: refPrice,
          ticker: kSnap.ticker ?? null,
          strikeDir,
          outcome: yesResolved ? 'YES' : 'NO',
          actualOutcome: yesResolved
            ? (strikeDir === 'below' ? 'DOWN' : 'UP')
            : (strikeDir === 'below' ? 'UP' : 'DOWN'),
          proxyOutcome: yesResolved ? 'YES' : 'NO',
          proxyConfidence,
          kYesPct: kSnap.kYesPct,
          mYesPct: kSnap.mYesPct,
          modelDir: kSnap.modelDir,
          cdfImpliedDir: kSnap.cdfImpliedDir ?? null,
          dirConflict,
          closePrice: +bucket.c.toFixed(6),
          candleH: bucket.h != null ? +bucket.h.toFixed(6) : null,
          candleL: bucket.l != null ? +bucket.l.toFixed(6) : null,
          refDiffPct: +refDiffPct.toFixed(4),
          wickSize: +wickSize.toFixed(4),
          marketCorrect: (kSnap.kYesPct >= 50) === yesResolved,
          modelCorrect: kSnap.mYesPct != null ? (kSnap.mYesPct >= 50) === yesResolved : null,
          _pendingAuth: pendingAuth || dirConflict,
          _wickStraddle: wickStraddle,
          _nearRef: nearRef,
          _dirConflict: dirConflict,
          // Fade & market divergence state (filled from snapshot; fadeCorrect back-filled on authoritative settle)
          fadeActive: kSnap.fadeActive ?? false,
          fadeSolid: kSnap.fadeSolid ?? false,
          betAction: kSnap.betAction ?? null,
          modelScore: kSnap.modelScore ?? null,
          modelConf: kSnap.modelConf ?? null,
          quantRegime: kSnap.quantRegime ?? null,
          cfmCalibration: kSnap.cfmCalibration ?? null,
          executionGuard: kSnap.executionGuard ?? null,
          mdivPhase: kSnap.mdivPhase ?? 'STALE',
          mdivDurationMs: kSnap.mdivDurationMs ?? 0,
          mdivCatchupDelta: kSnap.mdivCatchupDelta ?? 0,
          fadeCorrect: null, // back-filled by market15m:resolved
          // Signal components for per-indicator gradient descent retuner
          signalComponents: kSnap.signalComponents ?? null,
          // 2-minute prediction trail from this contract window
          predictionTrail2m: (window._kalshiPredictionTrail?.[kSnap.ticker]?.points || []).map(p => ({ ...p })),
        };
        window._kalshiLog.push(kEntry);
        if (window._kalshiLog.length > LOG_CAP) window._kalshiLog.shift();
        saveKalshiLog();

        // ── WECRYPTO Reinforcement Learning Loop ─────────────────────────────
        if (typeof window.update_indicator_weights === 'function' && kSnap.signalComponents && kEntry.modelCorrect !== null) {
          const activeFeatures = kSnap.signalComponents
            .filter(c => Math.abs(c.value) > 0.1)
            .map(c => c.name);

          const expectedProfit = (kSnap.modelScore || 0) * 10;
          const actualProfit = kEntry.modelCorrect ? 10.0 : -10.0;
          const trade_result = {
            profit: actualProfit,
            expected_value: expectedProfit,
            confidence: kSnap.modelConf ?? 0.5
          };

          try {
            const currentWeights = window.PredictionMarkets?.getAdaptiveWeights?.(sym) || {};
            const rlOutput = window.update_indicator_weights(trade_result, currentWeights, activeFeatures);
            console.log(`[RL Loop] 🧠 ${sym} Adaptive Alpha: ${(rlOutput.meta.alpha * 100).toFixed(2)}%. Weight adjustments triggered.`);
            
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              window.PredictionMarkets.setAdaptiveWeights(sym, rlOutput.new_weights);
            }
            if (window.wecryp?.updateSystemWeights) {
              window.wecryp.updateSystemWeights(rlOutput.new_weights).catch(e => console.warn('[RL Firebase Sync Failed]', e));
            }
          } catch (rlErr) {
            console.error('[RL Loop Error]', rlErr);
          }
        }

        // ── Record settlement in scorecard aggregator ─────────────────────
        console.log(`[Settlement] Recording: ${sym} → ${kEntry.actualOutcome} (aggregator=${!!window._aggregator})`);
        if (window._aggregator) {
          try {
            const outcome = kEntry.actualOutcome;
            window._aggregator.recordSettlement(sym, 'kalshi', outcome, Date.now(), {
              strikeType: strikeDir,
              modelCorrect: kEntry.modelCorrect,
              marketCorrect: kEntry.marketCorrect,
              confidence: proxyConfidence,
            });
            console.log(`[Settlement] ✓ Recorded ${sym}`);
          } catch (e) {
            console.error(`[Settlement] ✗ Error recording ${sym}:`, e);
          }
        } else {
          console.warn(`[Settlement] Aggregator not available for ${sym}`);
        }

        // ── Record settlement in 2-hour contract cache (NEW) ──────────────
        if (window._contractCache) {
          try {
            const outcome = kEntry.actualOutcome;
            window._contractCache.recordSettlement(
              sym,
              outcome,
              kEntry.modelCorrect,
              kEntry.marketCorrect
            );
            console.log(`[ContractCache] ✓ Settlement recorded ${sym}`);
          } catch (e) {
            console.error(`[ContractCache] ✗ Settlement error ${sym}:`, e.message);
          }
        }

        console.log(
          `[KalshiTracker] ${sym} strike=${strikeDir} ref=${refPrice} close=${bucket.c.toFixed(4)} ` +
          `→ ${yesResolved ? 'YES ✓' : 'NO'} gap=${refDiffPct.toFixed(4)}% conf=${proxyConfidence} ` +
          `${wickStraddle ? `⚠️WICK(${wickSize.toFixed(2)}%)` : nearRef ? '⚠️NEAR-REF' : ''} ` +
          `K:${kSnap.kYesPct}% M:${kSnap.mYesPct}% ` +
          `market${kEntry.marketCorrect ? '✓' : '✗'} model${kEntry.modelCorrect ? '✓' : '✗'} ` +
          `${pendingAuth ? '[PENDING-AUTH]' : ''}`
        );
      }
    } else if (kSnap == null) {
      console.warn(`[KalshiTracker] ${sym} — no snapshot at bucket close (no Kalshi data polled for this window)`);
    }

    // Refresh accuracy display if predictions tab is visible
    if (currentView === 'predictions' && predsLoaded) updateAccuracyBadge();
    console.log(`[PredTracker] ${sym} ${stored.direction} → ${actual} ${entry.correct ? '✓' : '✗'} | ${pctMove.toFixed(3)}%`);
  });

  // ── Live 1m candle → chart update ─────────────────────────────────────────
  // candleWS fires candleWS:1mTick on every update to the current 1m candle
  // and candleWS:1mClosed when a 1m candle seals. Both update the chart in
  // real-time so the 1m chart view stays live without polling.

  function _push1mToChart(sym, bucket) {
    if (!chartSeries?.candles || chartTf !== '1m') return;
    const coin = WATCHLIST.find(c => c.sym === sym);
    if (!coin || coin.instrument !== chartCoin) return;
    const bar = {
      time: Math.floor(bucket.t / 1000),
      open: bucket.o,
      high: bucket.h,
      low: bucket.l,
      close: bucket.c,
    };
    try {
      chartSeries.candles.update(bar);
      chartSeries.volume.update({
        time: bar.time,
        value: bucket.v,
        color: bucket.c >= bucket.o ? 'rgba(38,212,126,0.3)' : 'rgba(255,75,110,0.3)',
      });
    } catch (_) { /* lightweight-charts may reject out-of-order bars */ }
  }

  window.addEventListener('candleWS:1mTick', (e) => { if (e.detail) _push1mToChart(e.detail.sym, e.detail.bucket); });
  window.addEventListener('candleWS:1mClosed', (e) => { if (e.detail) _push1mToChart(e.detail.sym, e.detail.bucket); });

  // ── Authoritative Kalshi settlement back-fill ─────────────────────────────
  // market-resolver.js polls the actual Kalshi API after settlement and fires
  // this event with the ground-truth outcome. Update matching _kalshiLog entries
  // to replace the candle-close proxy with the official Kalshi result.
  window.addEventListener('market15m:resolved', (e) => {
    const {
      sym, outcome, kalshiResult, modelCorrect, marketCorrect, ticker,
      refPrice, floorPrice, strikeDir, cbSettlePrice,
      settlementAuthority, canonical, schemaVersion,
    } = e.detail || {};
    if (!sym || !outcome) return;

    // outcome arrives as 'UP'|'DOWN' — translate to 'YES'|'NO' for _kalshiLog
    const authOutcomeYN = outcome === 'UP' ? 'YES' : 'NO';

    console.log(
      `[KalshiTracker] 🏁 market15m:resolved ${sym}: result=${kalshiResult} → ${outcome}(${authOutcomeYN}) ` +
      `floor_price=${floorPrice ?? refPrice} strike=${strikeDir ?? 'above'} ` +
      `cbSettle=${cbSettlePrice} ` +
      `model=${modelCorrect ? '✓' : modelCorrect === false ? '✗' : '?'} ` +
      `mkt=${marketCorrect ? '✓' : '✗'} ticker=${ticker}`
    );

    // Walk backwards — most recent unsettled entry for this sym/ticker
    for (let i = window._kalshiLog.length - 1; i >= 0; i--) {
      const entry = window._kalshiLog[i];
      if (entry.sym !== sym) continue;
      if (entry._settled) continue;
      if (ticker && entry.ticker && ticker !== entry.ticker) continue;
      if (Date.now() - entry.ts > 4 * 3_600_000) break;

      const proxyMismatch = entry.outcome !== authOutcomeYN;
      if (proxyMismatch) {
        const isFalseWick = entry._wickStraddle || entry._nearRef;
        console.warn(
          `[KalshiTracker] ⚠️ PROXY MISMATCH ${sym}: ` +
          `proxy='${entry.outcome}' → auth='${authOutcomeYN}' (Kalshi ${kalshiResult}) ` +
          `close=${entry.closePrice} floor_price=${floorPrice ?? refPrice ?? entry.ref} ` +
          `strike=${strikeDir ?? 'above'} gap=${entry.refDiffPct}% ` +
          `cbSettle=${cbSettlePrice} ${isFalseWick ? '← WICK/NEAR-REF CAUSED THIS' : ''} ` +
          `ticker=${ticker}`
        );
        logContractError('proxy_mismatch', sym, {
          ticker, proxy: entry.outcome, authoritative: authOutcomeYN,
          kalshiResult,
          refPrice: floorPrice ?? refPrice ?? entry.ref,  // floor_price preferred
          floorPrice: floorPrice ?? null,
          strikeDir: strikeDir ?? 'above',
          proxyClosePrice: entry.closePrice, cbSettlePrice,
          refDiffPct: entry.refDiffPct, wickStraddle: entry._wickStraddle,
          nearRef: entry._nearRef, kYesPct: entry.kYesPct, mYesPct: entry.mYesPct,
        });
      }

      entry.outcome = authOutcomeYN;          // canonical YES/NO
      entry.modelCorrect = modelCorrect ?? entry.modelCorrect;
      entry.marketCorrect = marketCorrect ?? entry.marketCorrect;
      // Back-fill fadeCorrect: was the model's fade bet right?
      if (entry.fadeActive && entry.betAction) {
        entry.fadeCorrect = entry.betAction === authOutcomeYN;
        console.log(
          `[FadeTracker] ${entry.fadeCorrect ? '✓ FADE CORRECT' : '✗ FADE WRONG'} ` +
          `${sym}: bet=${entry.betAction} auth=${authOutcomeYN} score=${entry.modelScore?.toFixed(2) ?? '?'} ` +
          `mdivPhase=${entry.mdivPhase ?? '?'}`
        );
      }
      entry._settled = true;
      entry._proxyMismatch = proxyMismatch;
      entry._refPrice = floorPrice ?? refPrice ?? entry.ref;  // floor_price preferred
      entry._floorPrice = floorPrice ?? null;
      entry._strikeDir = strikeDir ?? 'above';
      entry._cbSettlePrice = cbSettlePrice ?? null;
      entry._kalshiResult = kalshiResult ?? null;  // raw 'yes'/'no'
      entry._settlementAuthority = settlementAuthority || 'kalshi_api';
      entry._canonical = canonical === true;
      entry._resolverSchemaVersion = schemaVersion || 'resolver.v1';
      entry.settledTs = entry.settledTs || Date.now();
      entry.actualOutcome = outcome;

      _journalSettlement(sym, entry.actualOutcome, cbSettlePrice ?? entry.closePrice ?? null, {
        source: 'market15m:resolved',
        ticker: entry.ticker || ticker || null,
        modelCorrect: entry.modelCorrect,
        confidence: entry.modelConf ?? null,
        regime: entry.quantRegime?.state || 'UNKNOWN',
        predictionDir: entry.modelDir || null,
      });

      // ── Record trade for adaptive tuning ─────────────────────────
      if (window._adaptiveTuner && entry.modelScore != null && entry.modelCorrect != null) {
        window._adaptiveTuner.recordTrade(sym, {
          score: entry.modelScore,
          prediction: entry.modelScore > 0 ? 'UP' : 'DOWN',
          actual: entry.modelCorrect ? 'correct' : 'wrong',
          correct: entry.modelCorrect === true,
          fprFlag: entry.modelCorrect === false && Math.abs(entry.modelScore) > 0.25,
        });
      }
      // Feed every 2-minute in-contract snapshot into outcome retuning.
      if (window._adaptiveTuner && Array.isArray(entry.predictionTrail2m) && entry.predictionTrail2m.length) {
        for (const pt of entry.predictionTrail2m) {
          if (pt?.modelDir !== 'UP' && pt?.modelDir !== 'DOWN') continue;
          try {
            window._adaptiveTuner.recordOutcome(
              sym,
              Number.isFinite(pt.ts) ? pt.ts : entry.ts,
              pt.modelDir,
              outcome,
              pt.signalComponents || entry.signalComponents || {}
            );
          } catch (_) { /* non-blocking */ }
        }
      }

      saveKalshiLog();
      if (currentView === 'predictions' && predsLoaded) updateAccuracyBadge();
      break;
    }
  });

  // Load historical Kalshi contracts from window._kalshiLog into contract cache on startup
  function loadKalshiHistoricalContracts() {
    if (!window._kalshiLog || !Array.isArray(window._kalshiLog)) return;
    const seen = new Set();
    let loaded = 0;

    window._kalshiLog.forEach(contract => {
      // Deduplicate by sym + resolved_at
      const key = `${contract.sym}|${contract.resolved_at}`;
      if (!seen.has(key)) {
        seen.add(key);
        // Only add settled contracts (those with outcome)
        if (contract.outcome && contract._settled) {
          // Ensure contractCache exists
          if (!window.contractCache) window.contractCache = [];

          window.contractCache.push({
            sym: contract.sym,
            direction: contract.direction,
            confidence: contract.confidence,
            settlement_price: contract.settlement_price,
            market_status: contract.market_status,
            resolved_price: contract.resolved_price,
            created_at: contract.created_at,
            resolved_at: contract.resolved_at,
            outcome: contract.outcome,
            modelCorrect: contract.modelCorrect,
            marketCorrect: contract.marketCorrect,
            fadeCorrect: contract.fadeCorrect
          });
          loaded++;
        }
      }
    });

    if (loaded > 0) {
      console.log(`✅ [KalshiHistoricalLoader] Loaded ${loaded} historical contracts from _kalshiLog`);
    }
  }

  // Call on startup after Kalshi log is loaded
  loadKalshiHistoricalContracts();

  function updateAccuracyBadge() {
    const stats = getPredAccuracy(null, 50);
    const el = document.getElementById('pred-accuracy-badge');
    if (!el || !stats) return;
    const color = stats.accuracy >= 60 ? 'var(--color-up)' : stats.accuracy >= 45 ? 'var(--color-gold)' : 'var(--color-down)';
    el.innerHTML =
      `<span style="color:${color};font-weight:700">${stats.accuracy.toFixed(1)}%</span>` +
      `<span style="color:var(--color-text-muted);font-size:10px"> acc · ${stats.correct}/${stats.total} closed buckets</span>`;
  }

  // ── CFM Early Exit Toast ────────────────────────────────────────
  // Appears at top-right when CFM detects momentum reversal vs
  // an active prediction. Auto-dismisses after 45s.
  const activeToasts = new Map(); // sym → element
  function showEarlyExitToast(sym, prediction, reason, strength = 0.5, type = '', detail = {}) {
    // Remove prior toast for same coin
    if (activeToasts.has(sym)) {
      activeToasts.get(sym).remove();
      activeToasts.delete(sym);
    }
    const strPct = Math.round((strength || 0) * 100);
    const isMacro = type === 'macro_market_move';
    const isPure = type === 'pure_drift_flip';
    const isFlip = type === 'confirmed_prediction_flip' || isPure || isMacro;
    const isWall = type === 'coordinated_sell' || (!isMacro && !isPure && isFlip);
    const coin = (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []).find(c => c.sym === sym);
    const icon = coin?.icon || sym;

    const label = isMacro ? '🚨 EXIT NOW — MARKET WIDE'
      : isPure ? '🔄 DRIFT FLIP — EXIT NOW'
        : isFlip ? '🔄 SIGNAL FLIP'
          : isWall ? '⚠️ WALL EVENT'
            : '⚡ EARLY EXIT';

    const bdrColor = isMacro ? '#ff2222'
      : isPure ? 'var(--color-down,#f45)'
        : isWall ? 'var(--color-gold,#f90)'
          : 'var(--color-down,#f45)';

    const strColor = strength >= 0.7 ? bdrColor : strength >= 0.45 ? 'var(--color-gold)' : 'var(--color-text-muted)';

    const bodyText = isMacro
      ? `${detail.macroCoins ?? '3+'}/${(typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS.length : '?')} coins moving <b>${detail.macroDir || ''}</b> — your <b>${prediction}</b> contract is wrong side`
      : isPure
        ? `Pure thin drift flip · ${(detail.driftQuality != null ? Math.round(detail.driftQuality * 100) + '% quality' : '')} · exit your <b>${prediction}</b> now`
        : isWall && !isFlip
          ? `Cross-coin sell detected · exit ${prediction} bet now`
          : `${prediction} call reversed · momentum flip`;

    const toast = document.createElement('div');
    toast.setAttribute('data-exit-toast', sym);
    toast.style.cssText = [
      'position:fixed', 'top:68px', 'right:16px', 'z-index:9999',
      `background:var(--color-surface,#12192e)`, `border:2px solid ${bdrColor}`,
      'border-radius:10px', 'padding:12px 16px', 'min-width:260px', 'max-width:340px',
      'box-shadow:0 4px 32px rgba(0,0,0,.72)', 'animation:fadeInRight .2s ease',
      'cursor:pointer',
      isMacro ? 'animation:fadeInRight .15s ease,pulse 0.6s ease 2' : '',
    ].join(';');
    toast.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <span style="font-size:20px">${icon}</span>
        <span style="font-weight:800;font-size:13px;color:${bdrColor}">${sym} · ${label}</span>
        <span style="margin-left:auto;font-size:11px;font-weight:700;color:${strColor}">${strPct}%</span>
      </div>
      <div style="font-size:12px;color:var(--color-text-muted);line-height:1.5">
        ${bodyText}<br>
        <span style="color:var(--color-text-faint);font-size:10px">${reason || ''}</span>
      </div>
      <div style="font-size:10px;color:var(--color-text-faint);margin-top:6px">Click to dismiss</div>
    `;
    toast.addEventListener('click', () => { toast.remove(); activeToasts.delete(sym); });
    document.body.appendChild(toast);
    activeToasts.set(sym, toast);

    const dismissMs = isMacro ? 90000 : 45000;
    setTimeout(() => {
      if (toast.isConnected) { toast.remove(); activeToasts.delete(sym); }
    }, dismissMs);
    console.log(`[CFMRouter] Exit toast: ${sym} ${prediction} type=${type} strength=${strPct}%`);
  }


  function price(ticker) { return ticker ? parseFloat(ticker.last || 0) : 0; }
  function change(ticker) { return ticker ? parseFloat(ticker.change) * 100 : 0; }
  function volume(ticker) { return ticker ? parseFloat(ticker.volume_value || 0) : 0; }
  function high(ticker) { return ticker ? parseFloat(ticker.high) : 0; }
  function low(ticker) { return ticker ? parseFloat(ticker.low) : 0; }
  function marketCap(meta) { return meta ? parseFloat(meta.marketCap || 0) : 0; }
  function atomicWeight(meta) { return meta ? parseFloat(meta.atomicWeight || meta.marketCap || 0) : 0; }
  function tvlUsd(meta) { return meta ? parseFloat(meta.tvlUsd || 0) : 0; }
  function compareNumbers(a, b, dir = -1) { return dir === -1 ? b - a : a - b; }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function fmt(n, dp = 2) {
    if (n === undefined || n === null || isNaN(n) || !isFinite(n)) return '—';
    n = Number(n);
    if (n < 0.000001 && n > 0) return n.toExponential(3);
    if (n < 0.01) return n.toFixed(6);
    if (n < 1) return n.toFixed(4);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return n.toFixed(dp);
  }

  function fmtPrice(n) {
    if (n === undefined || n === null || isNaN(n) || !isFinite(n)) return '—';
    n = Number(n);
    if (n >= 1000) return '$' + fmt(n, 2);
    if (n >= 1) return '$' + fmt(n, 2);
    if (n >= 0.01) return '$' + fmt(n, 4);
    if (n > 0) return '$' + n.toFixed(8);
    return '—';  // price of 0 means unavailable, not truly zero
  }

  function fmtPct(n) {
    if (n === undefined || n === null || isNaN(n) || !isFinite(n)) return '—';
    const sign = n >= 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }

  function fmtCompactUsd(n) {
    if (n === undefined || n === null || isNaN(n) || !isFinite(n) || n <= 0) return '—';
    n = Number(n);
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(0);
  }

  function chgClass(n) { return n >= 0 ? 'change-pos' : 'change-neg'; }
  function posneg(n) { return n >= 0 ? 'pos' : 'neg'; }

  function coinColor(sym) { return COIN_COLORS[sym] || '#7880a0'; }

  function coinIcon(sym) {
    if (_iconCache.has(sym)) return _iconCache.get(sym);

    const pc = PREDICTION_COINS?.find(c => c.sym === sym);
    const hold = typeof PORTFOLIO_HOLDINGS !== 'undefined' ? PORTFOLIO_HOLDINGS?.find(h => h.sym === sym) : null;
    const textFb = pc?.icon || hold?.icon || sym.slice(0, 2);

    // Waterfall: CoinGecko small (best quality) → CoinCap (Coinbase-affiliated, no rate limit)
    const sources = [
      ...(pc?.iconSources || []),
      `https://assets.coincap.io/assets/icons/${sym.toLowerCase()}@2x.png`,
    ].filter(Boolean);

    // Always render text fallback immediately — zero-dependency, works offline
    const html = `<span class="ci-wrap" data-sym="${sym}"><span class="ci-text">${textFb}</span></span>`;
    _iconCache.set(sym, html);

    // Async: fetch image via window.fetch (goes through proxy shim in Electron)
    // Once resolved, inject blob URL into all live DOM nodes and update cache
    if (sources.length && !_iconFetchQueue.has(sym)) {
      _iconFetchQueue.add(sym);
      (async () => {
        for (const src of sources) {
          try {
            const r = await window.fetch(src);
            if (!r.ok) continue;
            const blob = await r.blob();
            if (!blob.type.startsWith('image/')) continue;
            const blobUrl = URL.createObjectURL(blob);
            // Inject into every live ci-wrap for this symbol
            document.querySelectorAll(`.ci-wrap[data-sym="${sym}"]`).forEach(el => {
              if (!el.querySelector('.ci-img')) {
                const img = document.createElement('img');
                img.className = 'ci-img ci-loaded';
                img.src = blobUrl;
                img.alt = sym;
                el.appendChild(img);
              }
            });
            // Update cache: future renders get the img straight away
            _iconCache.set(sym,
              `<span class="ci-wrap" data-sym="${sym}">` +
              `<span class="ci-text">${textFb}</span>` +
              `<img class="ci-img ci-loaded" src="${blobUrl}" alt="${sym}">` +
              `</span>`
            );
            return; // done — skip remaining sources
          } catch { /* try next source */ }
        }
        // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();
    }

    return html;
  }

  function fmtRecord(wins, losses) {
    const w = Number(wins) || 0;
    const l = Number(losses) || 0;
    return `${w}-${l}`;
  }

  function fmtRatio(ratio, dp = 1) {
    const value = Number(ratio);
    if (!Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(dp)}%`;
  }

  function fmtSigned(n, dp = 0) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(dp)}`;
  }

  function fmtSignedPct(n, dp = 2) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(dp)}%`;
  }

  function predictionDirection(pred, fallback = 0) {
    if (!pred) return fallback;
    const kalshiAlign = pred.projections?.p15?.kalshiAlign;
    const mYesPct = Number.isFinite(kalshiAlign?.modelYesPct) ? kalshiAlign.modelYesPct : null;
    if (mYesPct != null) {
      const strikeDir = kalshiAlign?.strikeDir === 'below' ? 'below' : 'above';
      const yesDir = strikeDir === 'below' ? -1 : 1;
      const noDir = -yesDir;
      if (mYesPct >= 55) return yesDir;
      if (mYesPct <= 45) return noDir;
    }
    const proj15 = pred.projections?.p15;
    if (Number.isFinite(proj15)) {
      if (proj15 > 0.10) return 1;
      if (proj15 < -0.10) return -1;
    }
    const score = Number.isFinite(pred.score) ? pred.score : (Number.isFinite(pred.rawScore) ? pred.rawScore : 0);
    const floor = Number.isFinite(pred.diagnostics?.decisionFloor) ? pred.diagnostics.decisionFloor : 0.1;
    if (score > floor) return 1;
    if (score < -floor) return -1;
    return fallback;
  }

  function toggleExpanded(setRef, key) {
    if (setRef.has(key)) setRef.delete(key);
    else setRef.add(key);
  }

  const GECKO_ID_TO_SYMBOL = Object.fromEntries(Object.entries(SCREENER_GECKO_IDS).map(([sym, id]) => [id, sym]));

  async function fetchScreenerMeta(force = false) {
    const fresh = Date.now() - screenerMetaAge < 10 * 60 * 1000;
    if (!force && fresh && Object.keys(screenerMetaCache).length) return screenerMetaCache;
    if (!force && _screenerMetaBackoffUntil && Date.now() < _screenerMetaBackoffUntil) return screenerMetaCache;
    if (screenerMetaPromise) return screenerMetaPromise;

    const ids = Array.from(new Set(Object.values(SCREENER_GECKO_IDS))).join(',');
    const cgReq = coinGeckoRequest('/coins/markets', {
      vs_currency: 'usd',
      ids,
      order: 'market_cap_desc',
      sparkline: 'false',
      price_change_percentage: '24h',
    });
    
    let fetchPromise;
    if (typeof window._proxyOrchestrator !== 'undefined' && window._proxyOrchestrator) {
      fetchPromise = window._proxyOrchestrator.fetch(cgReq.url, {
        endpoint: 'coingecko',
        headers: cgReq.options.headers,
      });
    } else {
      fetchPromise = fetchWithTimeout(cgReq.url, 20000, {
        ...cgReq.options,
        schedulerLane: 'supplemental',
        schedulerProvider: 'coingecko',
      })
        .then(r => { if (!r.ok) throw new Error(`CoinGecko ${r.status}`); return r.json(); });
    }

    screenerMetaPromise = fetchPromise
      .then(rows => {
        const next = {};
        rows.forEach(row => {
          const sym = GECKO_ID_TO_SYMBOL[row.id];
          if (!sym) return;
          const orbital = window.ShellRouter?.getAtomicProfile?.(sym) || null;
          next[sym] = {
            marketCap: row.market_cap || 0,
            totalVolume: row.total_volume || 0,
            image: row.image || '',
            rank: row.market_cap_rank || null,
            geckoId: row.id,
            tvlUsd: orbital?.tvlUsd || 0,
            atomicWeight: orbital?.atomicWeightUsd || row.market_cap || 0,
            orbitalFocus: orbital?.orbitalFocus || null,
            classification: orbital?.classification || null,
          };
        });
        screenerMetaCache = next;
        screenerMetaAge = Date.now();
        _screenerMetaFailureStreak = 0;
        _screenerMetaBackoffUntil = Date.now() + 10 * 60 * 1000;
        return screenerMetaCache;
      })
      .catch(err => {
        _screenerMetaFailureStreak += 1;
        const msg = String(err?.message || err || '');
        const timeoutHit = /timed out|abort|timeout/i.test(msg);
        const authHit = /401|403/.test(msg);
        const rateHit = /429/.test(msg);
        if (authHit) _screenerMetaBackoffUntil = Date.now() + 60 * 60_000;
        else if (rateHit) _screenerMetaBackoffUntil = Date.now() + 15 * 60_000;
        else if (timeoutHit) _screenerMetaBackoffUntil = Date.now() + 10 * 60_000;
        else {
          const exp = Math.min(15 * 60_000, 60_000 * Math.pow(2, Math.max(0, _screenerMetaFailureStreak - 1)));
          _screenerMetaBackoffUntil = Date.now() + exp;
        }
        console.warn('Screener metadata fetch failed:', err.message);
        return screenerMetaCache;
      })
      .finally(() => {
        screenerMetaPromise = null;
      });

    return screenerMetaPromise;
  }

  function ensurePredictionsScrollTracker() {
    if (_predScrollTrackerBound || !content) return;
    content.addEventListener('scroll', () => {
      if (currentView === 'predictions') _predLastUserScrollTs = Date.now();
    }, { passive: true });
    _predScrollTrackerBound = true;
  }

  function refreshActiveView(force = false) {
    // NOTE: do NOT increment _rv here — refreshActiveView is a same-panel data refresh,
    // not navigation. Only render() (user nav click) should bump the version counter.
    const view = currentView;
    if (currentView === 'charts' && document.getElementById('chartContainer')) {
      updateChartMarketPanels();
      loadCandles({ showLoader: false, reuseChart: true });
      return;
    }
    if (currentView === 'cfm') {
      if (!force) {
        const sinceScroll = Date.now() - _cfmLastUserScrollTs;
        if (sinceScroll < CFM_SCROLL_IDLE_MS) {
          if (!_cfmDeferredRefreshTimer) {
            const waitMs = CFM_SCROLL_IDLE_MS - sinceScroll;
            _cfmDeferredRefreshTimer = setTimeout(() => {
              _cfmDeferredRefreshTimer = null;
              if (currentView === 'cfm') requestCFMRender();
            }, Math.max(120, waitMs));
          }
          return;
        }
      }
      if (_cfmDeferredRefreshTimer) {
        clearTimeout(_cfmDeferredRefreshTimer);
        _cfmDeferredRefreshTimer = null;
      }
      requestCFMRender(force);
      return;
    }
    if (currentView === 'predictions') {
      if (!force) {
        const sinceScroll = Date.now() - _predLastUserScrollTs;
        if (sinceScroll < PRED_SCROLL_IDLE_MS) {
          if (!_predDeferredRefreshTimer) {
            const waitMs = PRED_SCROLL_IDLE_MS - sinceScroll;
            _predDeferredRefreshTimer = setTimeout(() => {
              _predDeferredRefreshTimer = null;
              if (currentView === 'predictions') renderPredictions();
            }, Math.max(120, waitMs));
          }
          return;
        }
      }
      if (_predDeferredRefreshTimer) {
        clearTimeout(_predDeferredRefreshTimer);
        _predDeferredRefreshTimer = null;
      }
      renderPredictions();
      return;
    }
    if (currentView === 'screener') { renderScreener(); return; }
    if (currentView === 'universe') { renderUniverse(); return; }
    if (currentView === 'markets5m') { renderMarkets5M(); return; }
    if (currentView === 'debuglog') { renderDebugLog(); return; }
    if (currentView === 'observability') { renderObservability(); return; }
    if (currentView === 'hourly-ranges') return; // Panel manages its own 30s poll
    render();
  }

  function formatAddress(addr) {
    return addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : '—';
  }

  function formatUtc4Time(input) {
    const ms = typeof input === 'number' ? input : new Date(input).getTime();
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms - (4 * 60 * 60 * 1000)).toISOString().slice(11, 19);
  }

  function updateHeaderSummary() {
    updateMarketSummary();
  }

  function updateMarketSummary() {
    const ms = $('#marketSummary');
    if (!ms) return;
    const btc = tickers['BTCUSD'];
    const sol = tickers['SOLUSD'];
    const xrp = tickers['XRPUSD'];
    const doge = tickers['DOGEUSD'];
    if (!btc && !sol && !xrp) return;
    const cacheAge = Date.now() - (window._lastTickerFetchTs || Date.now());
    const asyncMode = !!window._asyncRefreshEngine;
    // Calculate countdown to next refresh (shows how many seconds until next refresh)
    const nextRefreshMs = Math.max(15000, (refreshSecs || 15) * 1000);
    const countdownSecs = Math.max(0, Math.ceil((nextRefreshMs - cacheAge) / 1000));
    const stalePart = cacheAge > 15000
      ? `<span class="stale-badge">${asyncMode ? 'ASYNC' : 'LIVE'} ${Math.max(1, Math.ceil(cacheAge / 1000))}s ago</span>`
      : `<span class="stale-badge">${asyncMode ? 'ASYNC' : 'LIVE'} ${countdownSecs}s</span>`;
    ms.innerHTML = [
      `<div class="ms-item"><span>Targets</span> <span class="ms-val">${PREDICTION_COINS.length}</span></div>`,
      `<div class="ms-item"><span>Feeds</span> <span class="ms-val">4</span></div>`,
      `<div class="ms-item"><span>Cadence</span> <span class="ms-val">15s</span></div>`,
      window.CandleWS
        ? `<div class="ms-item"><span>15m</span> <span class="ms-val" style="color:${CandleWS.isConnected() ? 'var(--color-up)' : 'var(--color-muted)'}">` +
        (CandleWS.isConnected()
          ? `${Math.floor(CandleWS.getMsUntilClose() / 1000)}s`
          : 'WS…') +
        `</span></div>`
        : '',
      btc ? `<div class="ms-item"><span>BTC</span> <span class="ms-val">${fmtPrice(price(btc))}</span> <span class="ms-chg ${posneg(change(btc))}">${fmtPct(change(btc))}</span></div>` : '',
      sol ? `<div class="ms-item"><span>SOL</span> <span class="ms-val">${fmtPrice(price(sol))}</span> <span class="ms-chg ${posneg(change(sol))}">${fmtPct(change(sol))}</span></div>` : '',
      xrp ? `<div class="ms-item"><span>XRP</span> <span class="ms-val">${fmtPrice(price(xrp))}</span> <span class="ms-chg ${posneg(change(xrp))}">${fmtPct(change(xrp))}</span></div>` : '',
      doge ? `<div class="ms-item"><span>DOGE</span> <span class="ms-val">${fmtPrice(price(doge))}</span> <span class="ms-chg ${posneg(change(doge))}">${fmtPct(change(doge))}</span></div>` : '',
      stalePart,
    ].join('');
  }

  // ================================================================
  // VIEW: MARKETS
  // ================================================================

  const FILTER_GROUPS = {
    all: { label: 'All', pred: () => true },
    portfolio: { label: 'Modeled', pred: c => PORTFOLIO_HOLDINGS.some(h => h.sym === c.sym) },
    core: { label: 'Core', pred: c => c.group === 'core' },
    meme: { label: 'Memes', pred: c => c.group === 'meme' },
    defi: { label: 'DeFi', pred: c => c.group === 'defi' },
    layer2: { label: 'L2', pred: c => c.group === 'layer2' },
    layer1: { label: 'L1', pred: c => c.group === 'layer1' },
    ai: { label: 'AI', pred: c => c.group === 'ai' },
  };

  // ==== 5-Minute Markets Tab =========================================

  let _markets5mCountdown = null;
  function renderMarkets5M() {
    if (_markets5mCountdown) { clearInterval(_markets5mCountdown); _markets5mCountdown = null; }
    const pm = window.PredictionMarkets?.getAll() || {};
    const pred = window.PredictionEngine?.getAll() || {};
    const snipes = window.PredictionMarkets?.getSnipes?.() || [];
    const COINS_5M = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'];  // ★ REMOVED HYPE (48%)

    function _pct(v) {
      if (v == null) return '—';
      return (v * 100).toFixed(0) + '%';
    }
    function _countdown(iso) {
      if (!iso) return '—';
      const closeMs = new Date(iso).getTime();
      const ms = closeMs - Date.now();
      const closeUtc4 = formatUtc4Time(closeMs);
      if (ms <= 0) return 'Settling…';
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const ss = s % 60;
      return `${m}m ${ss < 10 ? '0' : ''}${ss}s · UTC-4 ${closeUtc4}`;
    }
    function _side(prob, large) {
      if (prob == null) return '<span style="color:var(--color-text-faint)">—</span>';
      const sz = large ? 'font-size:20px;font-weight:800' : 'font-size:13px;font-weight:700';
      if (prob >= 0.55) return `<span class="badge-up" style="${sz}">▲ BUY YES</span>`;
      if (prob <= 0.45) return `<span class="badge-down" style="${sz}">▼ BUY NO</span>`;
      return `<span class="badge-neutral" style="${sz}">◆ WAIT</span>`;
    }
    function _confBar(prob) {
      if (prob == null) return '';
      const pct = Math.round(prob * 100);
      const col = pct >= 65 ? 'var(--color-green)' : pct <= 35 ? 'var(--color-red)' : 'var(--color-orange)';
      return `<div style="margin-top:5px;height:4px;background:var(--color-surface-3);border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${col};border-radius:2px;transition:width 0.4s;"></div>
      </div>`;
    }
    function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function _modelProj(sym) {
      const p = pred[sym];
      if (!p) return null;
      return p.projections?.p15 ?? null;
    }
    function _modelOdds(sym) {
      const p = pred[sym];
      if (!p) return null;
      const cdfYesPct = p.projections?.p15?.kalshiAlign?.modelYesPct;
      if (Number.isFinite(cdfYesPct)) {
        return _clamp(cdfYesPct / 100, 0.02, 0.98);
      }
      const proj = p.projections?.p15 ?? null;
      if (Number.isFinite(proj)) {
        return proj >= 0 ? 0.5 + (Math.abs(proj) * 0.5) : 0.5 - (Math.abs(proj) * 0.5);
      }
      if (Number.isFinite(p.score)) {
        return _clamp(0.5 + p.score * 0.40, 0.02, 0.98);
      }
      return null;
    }
    function _modelDivergence(sym, kalshiProb) {
      if (kalshiProb == null) return null;
      const modelOdds = _modelOdds(sym);
      if (modelOdds == null) return null;
      const diff = Math.abs(modelOdds - kalshiProb);
      if (diff > 0.15) return 'DIVERGENCE';
      if (diff > 0.10) return 'MISMATCH';
      return null;
    }
    function _scalpSignal(sym) {
      const p = pred[sym];
      if (!p) return null;
      const conf = p.confidence ?? 0;
      const score = Math.abs(p.score ?? 0);

      // High confidence (>70%) + Strong signal = SCALP opportunity
      if (conf > 70 && score > 0.65) return { type: 'SCALP_HIGH', msg: '⚡ SCALP 3-5m', color: '#4caf50' };

      // Medium-high confidence + Moderate signal = Watch for exit
      if (conf > 60 && score > 0.55) return { type: 'SCALP_MED', msg: '📍 Watch exit 7-10m', color: '#ff9800' };

      // Low confidence = Reversal risk
      if (conf < 45) return { type: 'REVERSAL_RISK', msg: '⚠️ Reversal risk near 12m', color: '#f44336' };

      return null;
    }
    function _marketNote(sym, kalshiProb) {
      if (kalshiProb == null) return '';
      const modelOdds = _modelOdds(sym);
      if (modelOdds == null) return '';
      const kYes = Math.round(kalshiProb * 100);
      const mYes = Math.round(modelOdds * 100);
      const divergence = _modelDivergence(sym, kalshiProb);

      if (divergence === 'DIVERGENCE') {
        const dir = modelOdds > kalshiProb ? 'Model bullish' : 'Model bearish';
        return `🔴 ${divergence}: ${dir} vs Kalshi`;
      } else if (divergence === 'MISMATCH') {
        const dir = modelOdds > kalshiProb ? 'slight model bullish' : 'slight model bearish';
        return `🟡 ${divergence}: ${dir}`;
      }
      return `✅ Aligned: Both ${kYes > 50 ? 'bullish' : 'bearish'}`;
    }
    function _fmtVol(v) {
      if (!v || v < 1) return '';
      if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
      if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
      return `$${v.toFixed(0)}`;
    }

    // ── Snipe banner ────────────────────────────────────────────────────
    const snipeBanner = snipes.length ? `
      <div style="background:rgba(255,200,0,0.08);border:1px solid rgba(255,200,0,0.3);border-radius:8px;padding:10px 14px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <span style="font-size:13px;font-weight:800;color:#ffd700;letter-spacing:0.04em;">⚡ SNIPE ALERTS</span>
        ${snipes.map(s => {
      const secsLeft = Math.floor(s.ms / 1000);
      const mLeft = Math.floor(secsLeft / 60);
      const ssLeft = secsLeft % 60;
      const col = s.dir === 'UP' ? 'var(--color-green)' : 'var(--color-red)';
      return `<span style="background:var(--color-surface-2);border-radius:5px;padding:3px 9px;font-size:12px;font-weight:700;">
            <span style="color:${col}">${s.sym} ${s.dir}</span>
            <span style="color:var(--color-text-muted);margin:0 4px;">·</span>
            <span>${Math.round(s.prob * 100)}% YES</span>
            <span style="color:var(--color-text-faint);margin-left:4px;">⏱ ${mLeft}m${String(ssLeft).padStart(2, '0')}s</span>
          </span>`;
    }).join('')}
      </div>` : '';

    // ── Per-coin cards ──────────────────────────────────────────────────
    const cards = COINS_5M.map(sym => {
      const coin = pm[sym] || {};
      const k5 = coin.kalshi15m || coin.kalshi5m;
      const p5 = coin.poly != null ? { probability: coin.poly } : coin.poly5m;
      const polyAll = coin.polyMarkets || [];   // all Poly markets for coin
      const poly5m = coin.poly5mMkts || [];   // short-term Poly markets
      const tick = tickers[WATCHLIST.find(w => w.sym === sym)?.instrument] || null;
      const curPx = tick ? price(tick) : null;
      const proj = _modelProj(sym);

      const k5prob = k5?.probability ?? null;
      const p5prob = p5?.probability ?? null;

      let combined5m = null;
      if (k5prob != null && p5prob != null) combined5m = k5prob * 0.50 + p5prob * 0.50;
      else if (k5prob != null) combined5m = k5prob;
      else if (p5prob != null) combined5m = p5prob;

      const coinColor = sym === 'BTC' ? '#f7931a' : sym === 'ETH' ? '#627eea' : sym === 'SOL' ? '#9945ff' : sym === 'XRP' ? '#0085c0' : sym === 'BNB' ? '#f3ba2f' : sym === 'HYPE' ? '#34d399' : '#ba9f33';

      // Pick the best Poly markets to display (short-term first, then high-vol)
      const displayPolyMkts = (polyAll.length ? polyAll : poly5m).slice(0, 4);

      return `
        <div class="opp-card" style="border-left:3px solid ${coinColor};padding:14px 16px;">

          <!-- Header -->
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:1.15em;font-weight:800;color:${coinColor}">${sym}</span>
              ${curPx != null ? `<span style="color:var(--color-text-muted);font-size:13px">$${fmtPrice(curPx)}</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${combined5m != null ? _side(combined5m, true) : ''}
              ${combined5m != null ? `<span style="font-size:12px;color:var(--color-text-muted)">${_pct(combined5m)} YES</span>` : ''}
            </div>
          </div>

          ${combined5m != null ? _confBar(combined5m) : ''}

          <!-- Live Rationale Pre-Prediction Block -->
          ${(() => {
          const p = pred[sym];
          if (!p || !p.rationale) return '';
          const r = p.rationale;
          const locked = r.preLocked ? `<div class="rationale-lock">⚡ PRE-LOCKED ${r.dirLabel}</div>` : '';
          const regimeBadge = `<div class="regime-badge regime-${r.regimeKey}">${(p.liveRegime && p.liveRegime.label) || ''}</div>`;
          const conviction = `<div class="conviction-bar">
              <span class="conv-label ${r.convLabel.toLowerCase()}">${r.convLabel} CONVICTION</span>
              <span class="conv-pct" style="color:var(--color-text-faint);font-size:10px">${(r.conviction * 100).toFixed(0)}%</span>
            </div>`;
          const drivers = r.lines.slice(1, 3).map(l => `<div class="rationale-line">${l}</div>`).join('');
          return `<div class="rationale-block">${locked}${regimeBadge}${conviction}${drivers}</div>`;
        })()}

          <!-- Market Divergence Alert -->
          ${k5prob != null ? (() => {
          const note = _marketNote(sym, k5prob);
          const isDivergent = note.includes('DIVERGENCE');
          const isMismatch = note.includes('MISMATCH');
          const bgColor = isDivergent ? 'rgba(255,77,77,0.1)' : isMismatch ? 'rgba(255,193,7,0.1)' : 'rgba(76,175,80,0.1)';
          const borderColor = isDivergent ? 'rgba(255,77,77,0.4)' : isMismatch ? 'rgba(255,193,7,0.4)' : 'rgba(76,175,80,0.3)';
          return `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:5px;padding:7px 10px;margin-bottom:8px;font-size:11px;color:var(--color-text);">${note}</div>`;
        })() : ''}

          <!-- Kalshi + Model row -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">

            <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;">
              <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px;">
                ${k5?._proxy15m ? 'Kalshi Nearest ★' : 'Kalshi Odds'}
              </div>
              ${k5 ? `
                <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:4px;">
                  <span style="color:var(--color-green);font-size:14px;font-weight:700">${_pct(k5prob)}</span>
                  <span style="font-size:12px;color:var(--color-text-muted)">YES</span>
                </div>
                <div style="font-size:11px;color:var(--color-text-faint);margin-top:3px;" id="k5cd-${sym}" data-close="${k5.closeTime}">⏱ ${_countdown(k5.closeTime)}</div>
                <div style="margin-top:5px">${_side(k5prob)}</div>
              ` : `<div style="color:var(--color-text-faint);font-size:11px">No contract</div>`}
            </div>

            <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;">
              <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px;">Model Odds</div>
              ${(() => {
          const modelOdds = _modelOdds(sym);
          if (modelOdds == null) return `<span style="color:var(--color-text-faint);font-size:11px">Run predictions</span>`;
          const action = modelOdds >= 0.55 ? '▲ BUY YES' : modelOdds <= 0.45 ? '▼ BUY NO' : '◆ WAIT';
          const actionColor = modelOdds >= 0.55 ? 'var(--color-green)' : modelOdds <= 0.45 ? 'var(--color-red)' : 'var(--color-text-faint)';
          return modelOdds != null ? `
                  <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:4px;">
                    <span style="color:${actionColor};font-size:14px;font-weight:700">${Math.round(modelOdds * 100)}%</span>
                    <span style="font-size:12px;color:var(--color-text-muted)">YES</span>
                  </div>
                  <div style="font-size:11px;color:var(--color-text-faint);margin-top:3px;">${action}</div>
                ` : `<span style="color:var(--color-text-faint);font-size:11px">—</span>`;
        })()}
            </div>

          </div>

          <!-- Scalp & Exit Timing -->
          ${(() => {
          const scalpSig = _scalpSignal(sym);
          if (!scalpSig) return '';
          const bgColor = scalpSig.color === '#4caf50' ? 'rgba(76,175,80,0.15)' : scalpSig.color === '#ff9800' ? 'rgba(255,152,0,0.15)' : 'rgba(244,67,54,0.15)';
          const borderCol = scalpSig.color;
          return `
              <div style="background:${bgColor};border:2px solid ${borderCol};border-radius:6px;padding:9px 12px;margin-top:8px;font-size:12px;font-weight:700;color:${borderCol};text-align:center;box-shadow:0 0 12px ${borderCol}40;letter-spacing:0.5px;">
                ${scalpSig.msg}
              </div>
            `;
        })()}



        </div>
      `;
    }).join('');

    content.innerHTML = `
      <div class="section-header">
        <span class="section-title">Fast Markets (15m Logic)</span>
        <span style="font-size:11px;color:var(--color-text-faint);">
          1m/5m polling cadence · Kalshi 15m-aligned decisioning
        </span>
      </div>
      ${snipeBanner}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;padding:4px 0;">
        ${cards}
      </div>
      <div style="padding:10px 0;font-size:11px;color:var(--color-text-faint);">
        ⚡ <b>Snipe</b> = Kalshi contract closing within 5 min with ≥65% YES or ≤35% probability.
        Prices in <b>¢</b> = cents per $1 contract (65¢ YES = 65% implied YES for that strike).
        YES/NO mapping follows strike type (<b>above</b> vs <b>below</b>), then resolves to UP/DOWN.
      </div>
    `;

    // Live countdown tick
    _markets5mCountdown = setInterval(() => {
      if (currentView !== 'markets5m') { clearInterval(_markets5mCountdown); _markets5mCountdown = null; return; }
      COINS_5M.forEach(sym => {
        const el = document.getElementById(`k5cd-${sym}`);
        if (!el) return;
        const close = el.dataset.close;
        if (close) el.textContent = `⏱ ${_countdown(close)}`;
      });
    }, 1000);
  }

  // ==== Settlement Debug Log ==========================================
  // Shows Kalshi 15M settlement history, per-coin accuracy, missed
  // opportunities, edge buffer zone analysis, and live velocity table.
  function renderDebugLog() {
    const DEBUG_CAP = {
      resolver: 800,
      resolution: 800,
      kalshi: 800,
      historical: 1200,
      missedOps: 300,
      zones: 120,
      pending: 120,
    };
    const _cap = (arr, n) => (Array.isArray(arr) ? arr.slice(-n) : []);

    const resolverLog = _cap(window.MarketResolver?.getLog?.(), DEBUG_CAP.resolver);
    const resolutionLog = _cap(window._15mResolutionLog, DEBUG_CAP.resolution);
    const settledKalshiLog = _cap((window._kalshiLog || []).filter(
      e => e?._settled || e?.modelCorrect !== null || e?.actualOutcome || e?.outcome
    ), DEBUG_CAP.kalshi);
    const missedOps = _cap(window.MarketResolver?.getMissedOpps?.(), DEBUG_CAP.missedOps);
    const zones = _cap(window.MarketResolver?.getBufferZones?.(), DEBUG_CAP.zones);
    const vels = window.PredictionMarkets?.getAllVelocities?.() || {};
    const pending = _cap(window.MarketResolver?.getPending?.(), DEBUG_CAP.pending);

    // Historical backfill can be very heavy on some machines/drives.
    // Keep it opt-in for debug stability.
    const includeHistorical = window._debugIncludeHistorical === true;
    const historical = includeHistorical
      ? _cap(window.getHistoricalContracts?.(), DEBUG_CAP.historical)
      : [];
    const mergedLog = [
      ...resolverLog,
      ...resolutionLog,
      ...settledKalshiLog,
      ...historical.map(h => ({
        sym: h.symbol,
        ticker: h.ticker || `KX${h.symbol}15M`,
        settledTs: h.ts || h.settledTs,
        actualOutcome: h.actualOutcome || _actualFromYNWithStrike(
          _normOutcomeYN(h.result || h.outcome),
          h.strikeDir ?? h.strikeType ?? h.raw?.strike_type
        ),
        modelCorrect: h.modelCorrect ?? null,
        modelDir: h.modelDir || h.direction || null,
        source: 'historical-backtest',
      })),
    ];

    const seen = new Set();
    const allData = mergedLog
      .filter(Boolean)
      .map(e => ({
        ...e,
        sym: (e.sym || e.symbol || e.coin || '').toUpperCase(),
        settledTs: e.settledTs || e.timestamp || e.ts || null,
      }))
      .filter(e => !!e.sym && !!e.settledTs)
      .filter(e => {
        const key = `${e.sym}-${e.settledTs}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (b.settledTs || 0) - (a.settledTs || 0));

    const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];

    // ── Per-coin accuracy table ─────────────────────────────────────
    const cachedAccuracyStats = window.getAccuracyStats?.();
    const accRows = COINS.map(sym => {
      const dataSource = window._accuracySource || 'auto';

      // Force historical-only mode if user selected it
      if (dataSource === 'historical') {
        const symStats = cachedAccuracyStats?.bySymbol?.[sym];

        if (symStats && symStats.total > 0) {
          const acc = symStats.winRate / 100;
          const pct = symStats.winRate;
          const col = acc >= 0.60 ? 'var(--color-green)' : acc >= 0.50 ? 'var(--color-orange)' : 'var(--color-red)';
          return `<tr>
            <td style="font-weight:700">${sym}</td>
            <td style="color:${col};font-weight:700">${Math.round(pct)}%</td>
            <td>${symStats.wins}/${symStats.total}</td>
            <td>—</td>
            <td style="color:#80cbc4">historic</td>
            <td style="color:var(--color-text-muted)">—</td>
          </tr>`;
        }

        return `<tr><td>${sym}</td><td colspan="5" style="color:var(--color-text-faint)">—</td></tr>`;
      }

      // Auto mode: use real-time if available, fall back to historical
      const a = window.MarketResolver?.getResolutionAccuracy?.(sym, 30);

      if (!a) {
        const symStats = cachedAccuracyStats?.bySymbol?.[sym];

        if (symStats && symStats.total > 0) {
          const acc = symStats.winRate / 100;
          const pct = symStats.winRate;
          const col = acc >= 0.60 ? 'var(--color-green)' : acc >= 0.50 ? 'var(--color-orange)' : 'var(--color-red)';
          return `<tr>
            <td style="font-weight:700">${sym}</td>
            <td style="color:${col};font-weight:700">${Math.round(pct)}%</td>
            <td>${symStats.wins}/${symStats.total}</td>
            <td>—</td>
            <td style="color:var(--color-text-faint)">historic</td>
            <td style="color:var(--color-text-muted)">—</td>
          </tr>`;
        }

        return `<tr><td>${sym}</td><td colspan="5" style="color:var(--color-text-faint)">—</td></tr>`;
      }

      const pct = (a.accuracy * 100).toFixed(0);
      const col = a.accuracy >= 0.60 ? 'var(--color-green)' : a.accuracy >= 0.50 ? 'var(--color-orange)' : 'var(--color-red)';
      const strk = a.streak > 0 ? `<span style="color:var(--color-green)">+${a.streak}🔥</span>`
        : a.streak < 0 ? `<span style="color:var(--color-red)">${a.streak}❄️</span>` : '0';
      const trendIcon = a.trend === 'improving' ? '▲' : a.trend === 'declining' ? '▼' : '→';
      const trendCol = a.trend === 'improving' ? 'var(--color-green)' : a.trend === 'declining' ? 'var(--color-red)' : 'var(--color-text-faint)';
      const calib = a.calibMultiplier != null ? a.calibMultiplier.toFixed(2) + '×' : '—';
      return `<tr>
        <td style="font-weight:700">${sym}</td>
        <td style="color:${col};font-weight:700">${pct}%</td>
        <td>${a.correct}/${a.total}</td>
        <td>${strk}</td>
        <td style="color:${trendCol}">${trendIcon} ${a.trend}</td>
        <td style="color:var(--color-text-muted)">${calib}</td>
      </tr>`;
    }).join('');

    // ── Buffer zone table ───────────────────────────────────────────
    const zoneRows = zones.map(z => {
      if (!z.trades) return `<tr><td>${z.label}</td><td colspan="3" style="color:var(--color-text-faint)">—</td></tr>`;
      const col = z.winRate >= 60 ? 'var(--color-green)' : z.winRate >= 50 ? 'var(--color-orange)' : 'var(--color-red)';
      const safeTag = z.winRate >= 55 ? '<span style="font-size:10px;color:var(--color-green);margin-left:6px">✓ SAFE</span>' : '';
      return `<tr>
        <td>${z.label}${safeTag}</td>
        <td style="color:${col};font-weight:700">${z.winRate != null ? z.winRate + '%' : '—'}</td>
        <td>${z.wins}/${z.trades}</td>
        <td style="color:var(--color-text-faint)">${z.avgEdge != null ? z.avgEdge + '¢' : '—'}</td>
      </tr>`;
    }).join('');

    // ── Velocity table (live Kalshi probability drift) ──────────────
    const velRows = COINS.map(sym => {
      const v = vels[sym] || { trend: 'flat', velCentsPerMin: 0, acceleration: 0, samples: 0, latestProb: null };
      const col = v.trend === 'rising' ? 'var(--color-green)' : v.trend === 'falling' ? 'var(--color-red)' : 'var(--color-text-faint)';
      const arrow = v.trend === 'rising' ? '▲' : v.trend === 'falling' ? '▼' : '→';
      const latestP = v.latestProb != null ? Math.round(v.latestProb * 100) + '¢' : '—';
      const accel = v.acceleration > 0 ? `+${v.acceleration}` : v.acceleration.toString();
      return `<tr>
        <td style="font-weight:700">${sym}</td>
        <td style="color:${col}">${arrow} ${v.trend}</td>
        <td style="color:${col};font-weight:700">${v.velCentsPerMin > 0 ? '+' : ''}${v.velCentsPerMin}¢/min</td>
        <td style="color:var(--color-text-faint)">${accel}</td>
        <td>${v.samples}</td>
        <td>${latestP}</td>
      </tr>`;
    }).join('');

    // ── Recent settlements ──────────────────────────────────────────
    const recent = allData.slice(0, 40);
    const settlementRows = recent.length ? recent.map(e => {
      const ts = new Date(e.settledTs || e.closeTimeMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const badge = e.modelCorrect === true ? '<span style="color:var(--color-green);font-weight:800">✅ CORRECT</span>'
        : e.modelCorrect === false ? '<span style="color:var(--color-red);font-weight:800">❌ WRONG</span>'
          : '<span style="color:var(--color-text-faint)">? N/A</span>';
      const edgeStr = e.edgeCents != null ? (e.edgeCents > 0 ? `+${e.edgeCents}¢` : `${e.edgeCents}¢`) : '—';
      const edgeCol = e.edgeCents >= 10 ? 'var(--color-green)' : e.edgeCents >= 5 ? 'var(--color-orange)' : e.edgeCents > 0 ? 'var(--color-text-muted)' : 'var(--color-red)';
      const actionBadge = e.orchestratorAction
        ? `<span style="background:var(--color-surface-3);border-radius:3px;padding:1px 5px;font-size:10px">${e.orchestratorAction}</span>`
        : '';
      const missedTag = e.missedOpportunity
        ? '<span style="color:#ff9800;font-size:10px;margin-left:4px">⚠ missed</span>'
        : '';
      const dirCol = e.actualOutcome === 'UP' ? 'var(--color-green)' : 'var(--color-red)';
      return `<tr>
        <td>${ts}</td>
        <td style="font-weight:700">${e.sym}</td>
        <td style="color:${dirCol}">${e.actualOutcome}</td>
        <td>${badge}${missedTag}</td>
        <td style="color:var(--color-text-muted)">${e.modelDir ?? '—'}</td>
        <td style="color:${edgeCol}">${edgeStr}</td>
        <td>${actionBadge}</td>
        <td style="color:var(--color-text-muted)">${e.entryProb != null ? Math.round(e.entryProb * 100) + '%' : '—'}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="8" style="color:var(--color-text-faint);text-align:center;padding:20px">No settlements recorded yet — data accumulates as Kalshi 15M contracts expire.</td></tr>`;

    // ── Missed opportunities list ───────────────────────────────────
    const missedRows = missedOps.length ? [...missedOps].reverse().slice(0, 20).map(e => {
      const ts = new Date(e.settledTs || e.closeTimeMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const eStr = e.missedOpportunity?.edgeCents != null ? `${e.missedOpportunity.edgeCents}¢` : '—';
      const align = e.missedOpportunity?.alignment ?? '—';
      return `<tr>
        <td>${ts}</td>
        <td style="font-weight:700">${e.sym}</td>
        <td style="color:var(--color-green)">${e.actualOutcome}</td>
        <td>${e.missedOpportunity?.action ?? '—'}</td>
        <td>${eStr}</td>
        <td style="color:var(--color-text-faint)">${align}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" style="color:var(--color-text-faint);text-align:center;padding:12px">No missed opportunities (model was correct + orchestrator said skip/watch) yet.</td></tr>`;

    // ── Pending snapshots ───────────────────────────────────────────
    const pendingRows = pending.length ? pending.map(e => {
      const close = new Date(e.closeTimeMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const ms = Math.max(0, e.closeTimeMs - Date.now());
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const edgeS = e.edgeCents != null ? `${e.edgeCents > 0 ? '+' : ''}${e.edgeCents}¢` : '—';
      const actB = e.orchestratorAction ? `<span style="background:var(--color-surface-3);border-radius:3px;padding:1px 5px;font-size:10px">${e.orchestratorAction}</span>` : '—';
      return `<tr>
        <td style="font-weight:700">${e.sym}</td>
        <td>${close}</td>
        <td style="color:var(--color-orange)">${m}m${String(s).padStart(2, '0')}s</td>
        <td style="color:var(--color-text-muted)">${e.modelDir ?? '—'}</td>
        <td>${edgeS}</td>
        <td>${actB}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" style="color:var(--color-text-faint);text-align:center;padding:12px">No pending snapshots.</td></tr>`;

    const tbl = (headers, rows) => `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr>${headers.map(h => `<th style="text-align:left;padding:5px 8px;color:var(--color-text-faint);border-bottom:1px solid var(--color-border);font-weight:600">${h}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    const card = (title, body) => `
      <div style="background:var(--color-surface-1);border:1px solid var(--color-border);border-radius:10px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:13px;font-weight:700;color:var(--color-text);margin-bottom:10px;">${title}</div>
        ${body}
      </div>`;

    content.innerHTML = `
      <div style="padding:16px 20px;max-width:960px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <span style="font-size:16px;font-weight:800;letter-spacing:0.06em;">⚗ SETTLEMENT DEBUG LOG</span>
          <span style="font-size:11px;color:var(--color-text-faint);background:var(--color-surface-2);padding:3px 8px;border-radius:4px">${allData.length} settled · ${pending.length} pending · ${missedOps.length} missed opps</span>
          <button onclick="window.MarketResolver?.start?.(); window.refreshDebugLog?.()" style="margin-left:auto;padding:5px 12px;background:var(--color-accent);color:#fff;border:none;border-radius:5px;font-size:11px;cursor:pointer">⟳ Refresh</button>
          <button onclick="window._debugIncludeHistorical = !window._debugIncludeHistorical; window.refreshDebugLog?.()" style="padding:5px 10px;background:var(--color-surface-2);color:var(--color-text);border:1px solid var(--color-border);border-radius:5px;font-size:11px;cursor:pointer" title="Historical data can be heavy and freeze slower systems.">${includeHistorical ? 'Historic: ON' : 'Historic: OFF'}</button>
        </div>

        ${card('📡 Live Kalshi Probability Velocity', tbl(
      ['Coin', 'Trend', '¢/Min', 'Accel', 'Samples', 'Latest YES'],
      velRows
    ))}

        ${card(`🎯 Per-Coin Settlement Accuracy 
          <select id="accuracyDataSource" style="float:right;padding:4px 8px;font-size:11px;border-radius:4px;border:1px solid var(--color-border);background:var(--color-surface-2);color:var(--color-text);cursor:pointer" onchange="(function(){const e=event.target.value;window._accuracySource=e;window.refreshDebugLog?.()})()">
            <option value="auto" ${window._accuracySource !== 'historical' ? 'selected' : ''}>Auto (Real-time + Historical)</option>
            <option value="historical" ${window._accuracySource === 'historical' ? 'selected' : ''}>📊 Historical Only (Backtest)</option>
          </select>
          <div style="clear:both"></div>`, tbl(
      ['Coin', 'Accuracy', 'Correct/Total', 'Streak', 'Trend', 'Calib'],
      accRows
    ))}

        ${card('🛡️ Buffer Zone Analysis — Safe Edge Thresholds', `
          ${tbl(['Edge Bucket', 'Win Rate', 'W/T', 'Avg Edge'], zoneRows)}
          <p style="font-size:11px;color:var(--color-text-faint);margin-top:8px">✓ SAFE = win rate ≥ 55%. Use these thresholds to set orchestrator trade gate.</p>
        `)}

        ${card(`⚠️ Missed Opportunities (${missedOps.length} total — model correct, orchestrator skipped)`, tbl(
      ['Time', 'Coin', 'Outcome', 'Orch Action', 'Edge', 'Alignment'],
      missedRows
    ))}

        ${card(`⏳ Pending Snapshots (${pending.length} awaiting settlement)`, tbl(
      ['Coin', 'Closes', 'Time Left', 'Model Dir', 'Edge', 'Orch Action'],
      pendingRows
    ))}

        ${card(`📋 Settlement History (last 40 of ${allData.length})`, tbl(
      ['Time', 'Coin', 'Actual', 'Model', 'Pred Dir', 'Edge', 'Action', 'Kalshi%'],
      settlementRows
    ))}
      </div>`;

    // Expose refresh shortcut
    window.refreshDebugLog = () => { if (currentView === 'debuglog') renderDebugLog(); };
  }

  function _obsNum(v, fallback = null) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function _obsNormRegime(v) {
    if (!v) return 'UNKNOWN';
    return String(v).trim().replace(/\s+/g, '_').toUpperCase();
  }

  function _obsPct(v, dp = 1) {
    return Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : '—';
  }

  function _obsEsc(v) {
    return String(v ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function _obsLatencyBuckets(valuesMs = []) {
    const labels = ['0-5s', '5-15s', '15-30s', '30-60s', '1-2m', '2-5m', '5-10m', '10m+'];
    const bounds = [5000, 15000, 30000, 60000, 120000, 300000, 600000, Infinity];
    const counts = new Array(labels.length).fill(0);
    for (const v of valuesMs) {
      if (!Number.isFinite(v) || v < 0) continue;
      for (let i = 0; i < bounds.length; i++) {
        if (v <= bounds[i]) {
          counts[i]++;
          break;
        }
      }
    }
    const total = counts.reduce((a, b) => a + b, 0);
    return { labels, counts, total };
  }

  function _obsGetQuantDriftSnapshot() {
    const sources = [
      window.QuantCore?.driftDetector,
      window.QuantCore?.drift,
      window.QuantCore?.diagnostics?.driftDetector,
      window._driftDetector,
    ];

    for (const src of sources) {
      if (!src) continue;
      try {
        if (typeof src.overallStatus === 'function') {
          const status = src.overallStatus();
          if (!status) continue;
          if (typeof status === 'string') {
            return { overall_status: String(status).toUpperCase(), source: 'overallStatus:string' };
          }
          if (typeof status === 'object') {
            return {
              ...status,
              overall_status: String(status.overall_status || status.status || 'UNKNOWN').toUpperCase(),
            };
          }
        }
        if (typeof src === 'object' && (src.overall_status || src.status)) {
          return {
            ...src,
            overall_status: String(src.overall_status || src.status).toUpperCase(),
            source: 'object',
          };
        }
      } catch (_) { }
    }

    return null;
  }

  function _obsEmergencyToolsSummary() {
    const out = {
      available: false,
      active: 0,
      pending: 0,
      total: 0,
      note: 'Emergency tools dashboard unavailable.',
    };

    const et = window.__EMERGENCY_TOOLS;
    if (!et || typeof et.catalog !== 'function') return out;

    out.available = true;
    try {
      const text = String(et.catalog() || '');
      const lines = text.split(/\r?\n/);
      lines.forEach(line => {
        if (line.includes('ACTIVE')) out.active += 1;
        else if (line.includes('PENDING')) out.pending += 1;
      });
      out.total = out.active + out.pending;
      out.note = out.total > 0
        ? `${out.active}/${out.total} tools active`
        : 'Emergency tools catalog loaded.';
    } catch (_) {
      out.note = 'Emergency tools catalog unavailable.';
    }

    return out;
  }

let _llmObsStats = { completions: 0, queues: 0, provider: 'none', model: 'none', enabled: false };
    setInterval(async () => {
      if (!window.electron) return;
      try {
        const diag = await window.electron.invoke('llm:getStats');
        const qStats = window._signalScheduler?.getStats()?.lanes?.validation?.queued || 0;
        if (diag && diag.stats) {
          _llmObsStats.completions = diag.stats.successes || diag.stats.total_calls || diag.stats.calls || 0;
          _llmObsStats.provider = diag.provider || 'none';
          _llmObsStats.model = diag.model || 'none';
          _llmObsStats.enabled = diag.enabled || false;
        } else if (diag) {
          _llmObsStats.completions = diag.successes || diag.calls || 0;
        }
        _llmObsStats.queues = qStats;
      } catch(e) {}
    }, 2000);

  function _obsBuildMetrics() {
    const resLog = window._15mResolutionLog || [];
    const kalshiLog = window._kalshiLog || [];
    const orchLog = window._orchLog || [];
    const kalshiErrors = window._kalshiErrors || [];
    const journal = _getTradeJournal();
    const journalTrades = Array.isArray(journal?.trades) ? journal.trades : [];
    const quantDrift = _obsGetQuantDriftSnapshot();
    const emergencyTools = _obsEmergencyToolsSummary();
    const networkSummary = window.NetworkLog?.summary?.() || { total: 0, lastTs: null, byProvider: {} };
    const recentNetwork = window.NetworkLog?.getRecent?.(10) || [];
    const sig = [
      resLog.length,
      resLog.length ? (resLog[resLog.length - 1].settledTs || resLog[resLog.length - 1].ts || 0) : 0,
      kalshiLog.length,
      kalshiLog.length ? (kalshiLog[kalshiLog.length - 1].settledTs || kalshiLog[kalshiLog.length - 1].ts || 0) : 0,
      orchLog.length,
      orchLog.length ? (orchLog[orchLog.length - 1].ts || 0) : 0,
      journalTrades.length,
      learningEngine?.tuneLog?.length || 0,
      quantDrift?.overall_status || 'NO_QUANT_DRIFT',
      emergencyTools.active,
      emergencyTools.total,
      networkSummary.total,
      networkSummary.lastTs || 0,
    ].join('|');

    if (_observabilityCache.sig === sig && _observabilityCache.data && (Date.now() - _observabilityCache.ts) < 10_000) {
      return _observabilityCache.data;
    }

    const events = [];

    resLog.forEach(e => {
      if (typeof e.modelCorrect === 'boolean') {
        const modelDir = String(e.modelDir || '').toUpperCase();
        const pUp = _obsNum(e.modelProbUp, null);
        const confFromProb = Number.isFinite(pUp) && (modelDir === 'UP' || modelDir === 'DOWN')
          ? (modelDir === 'UP' ? pUp : (1 - pUp))
          : null;
        events.push({
          source: 'resolution',
          sym: e.sym || 'UNK',
          ts: _obsNum(e.settledTs || e.ts, Date.now()),
          correct: e.modelCorrect,
          regime: _obsNormRegime(e.quantRegime?.state || e.quantRegime?.regime || e.mdtRegime || e.regime),
          confidence: Number.isFinite(confFromProb)
            ? Math.max(0, Math.min(1, confFromProb))
            : (Number.isFinite(_obsNum(e.modelScore, null)) ? Math.max(0, Math.min(1, 0.5 + Math.abs(e.modelScore) * 0.5)) : null),
          latency: {
            snapshotTs: _obsNum(e.snapshotTs, null),
            closeTimeMs: _obsNum(e.closeTimeMs, null),
            settledTs: _obsNum(e.settledTs, null),
            fillTs: _obsNum(e.fillTs || e.fillTsMs, null),
          },
          signalComponents: e.signalComponents || null,
          orchestratorAction: e.orchestratorAction || null,
        });
      }
    });

    kalshiLog.forEach(e => {
      if (typeof e.modelCorrect === 'boolean') {
        const modelDir = String(e.modelDir || '').toUpperCase();
        const mYesPct = _obsNum(e.mYesPct, null);
        const conf = Number.isFinite(mYesPct) && (modelDir === 'UP' || modelDir === 'DOWN')
          ? (modelDir === 'UP' ? mYesPct / 100 : (100 - mYesPct) / 100)
          : (Number.isFinite(_obsNum(e.modelConf, null)) ? Math.max(0, Math.min(1, _obsNum(e.modelConf, 0))) : null);
        events.push({
          source: 'kalshi',
          sym: e.sym || 'UNK',
          ts: _obsNum(e.settledTs || e.ts, Date.now()),
          correct: e.modelCorrect,
          regime: _obsNormRegime(e.quantRegime?.state || e.quantRegime?.regime),
          confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
          signalComponents: e.signalComponents || null,
          orchestratorAction: e.orchestratorAction || null,
        });
      }
    });

    journalTrades.forEach(t => {
      if (!t?.settled || (t.win !== 0 && t.win !== 1)) return;
      events.push({
        source: 'journal',
        sym: t.asset || 'UNK',
        ts: _obsNum(t.settled_timestamp || t.timestamp, Date.now()),
        correct: t.win === 1,
        regime: _obsNormRegime(t.regime),
        confidence: Number.isFinite(_obsNum(t.confidence, null)) ? Math.max(0, Math.min(1, t.confidence)) : null,
        signalComponents: t.signals || null,
        orchestratorAction: t.metadata?.routed_action || null,
      });
    });

    const eventsSorted = events.sort((a, b) => a.ts - b.ts);

    const regimeMap = {};
    eventsSorted.forEach(e => {
      const r = e.regime || 'UNKNOWN';
      if (!regimeMap[r]) regimeMap[r] = { regime: r, wins: 0, total: 0 };
      regimeMap[r].total += 1;
      if (e.correct) regimeMap[r].wins += 1;
    });
    const regimeRows = Object.values(regimeMap)
      .map(r => ({ ...r, winRate: r.total ? r.wins / r.total : 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);

    const confBuckets = [
      { label: '50-59%', min: 0.50, max: 0.60, wins: 0, total: 0, confSum: 0 },
      { label: '60-69%', min: 0.60, max: 0.70, wins: 0, total: 0, confSum: 0 },
      { label: '70-79%', min: 0.70, max: 0.80, wins: 0, total: 0, confSum: 0 },
      { label: '80-89%', min: 0.80, max: 0.90, wins: 0, total: 0, confSum: 0 },
      { label: '90-100%', min: 0.90, max: 1.01, wins: 0, total: 0, confSum: 0 },
    ];
    eventsSorted.forEach(e => {
      if (!Number.isFinite(e.confidence)) return;
      const b = confBuckets.find(x => e.confidence >= x.min && e.confidence < x.max);
      if (!b) return;
      b.total += 1;
      b.confSum += e.confidence;
      if (e.correct) b.wins += 1;
    });
    const calibrationRows = confBuckets.map(b => {
      const avgConf = b.total ? b.confSum / b.total : null;
      const empirical = b.total ? b.wins / b.total : null;
      const ece = (avgConf != null && empirical != null) ? Math.abs(avgConf - empirical) : null;
      return { ...b, avgConf, empirical, ece };
    });

    const orchBySym = {};
    orchLog.forEach(o => {
      const sym = o.sym || 'UNK';
      if (!orchBySym[sym]) orchBySym[sym] = [];
      orchBySym[sym].push(_obsNum(o.ts, 0));
    });
    Object.values(orchBySym).forEach(arr => arr.sort((a, b) => a - b));

    const signalToQuote = [];
    const quoteToFill = [];
    const fillToSettle = [];
    const signalToSettle = [];
    const quoteToSettle = [];
    let fillCoverage = 0;
    let latencySamples = 0;

    resLog.forEach(e => {
      const settledTs = _obsNum(e.settledTs, null);
      const quoteTs = _obsNum(e.snapshotTs, null);
      const closeTs = _obsNum(e.closeTimeMs, null);
      const fillTs = _obsNum(e.fillTs || e.fillTsMs, null);
      if (!Number.isFinite(settledTs) || !Number.isFinite(closeTs)) return;
      latencySamples += 1;

      const symArr = orchBySym[e.sym] || [];
      let signalTs = null;
      for (let i = symArr.length - 1; i >= 0; i--) {
        const cand = symArr[i];
        if (cand <= closeTs && cand >= (closeTs - 30 * 60_000)) {
          signalTs = cand;
          break;
        }
      }

      if (Number.isFinite(signalTs) && Number.isFinite(quoteTs) && quoteTs >= signalTs) {
        signalToQuote.push(quoteTs - signalTs);
      }
      if (Number.isFinite(quoteTs) && Number.isFinite(fillTs) && fillTs >= quoteTs) {
        quoteToFill.push(fillTs - quoteTs);
      }
      if (Number.isFinite(fillTs) && Number.isFinite(settledTs) && settledTs >= fillTs) {
        fillToSettle.push(settledTs - fillTs);
        fillCoverage += 1;
      } else if (Number.isFinite(quoteTs) && Number.isFinite(settledTs) && settledTs >= quoteTs) {
        quoteToSettle.push(settledTs - quoteTs);
      }
      if (Number.isFinite(signalTs) && Number.isFinite(settledTs) && settledTs >= signalTs) {
        signalToSettle.push(settledTs - signalTs);
      }
    });

    const latency = {
      samples: latencySamples,
      fillCoverage: latencySamples ? fillCoverage / latencySamples : 0,
      signalToQuote: _obsLatencyBuckets(signalToQuote),
      quoteToFill: _obsLatencyBuckets(quoteToFill),
      fillToSettle: _obsLatencyBuckets(fillToSettle),
      signalToSettle: _obsLatencyBuckets(signalToSettle),
      quoteToSettle: _obsLatencyBuckets(quoteToSettle),
    };

    const recentKalshi = kalshiLog.slice(-80);
    const dirConflictCount = recentKalshi.filter(e => e._dirConflict || e.dirConflict).length;
    const proxyMismatchCount = recentKalshi.filter(e => e._proxyMismatch).length;
    const wickCount = recentKalshi.filter(e => e._wickStraddle || e._nearRef).length;
    const recentErrors = kalshiErrors.slice(-80);
    const errByType = {};
    recentErrors.forEach(e => {
      const type = String(e.type || 'unknown');
      errByType[type] = (errByType[type] || 0) + 1;
    });

    const conflictRate = recentKalshi.length ? dirConflictCount / recentKalshi.length : 0;
    const mismatchRate = recentKalshi.length ? proxyMismatchCount / recentKalshi.length : 0;
    const wickRate = recentKalshi.length ? wickCount / recentKalshi.length : 0;
    let driftStatus = 'STABLE';
    if ((quantDrift?.overall_status === 'MAJOR_DRIFT') || mismatchRate > 0.15 || conflictRate > 0.20) driftStatus = 'ELEVATED';
    else if ((quantDrift?.overall_status === 'DRIFT') || mismatchRate > 0.08 || conflictRate > 0.12 || wickRate > 0.20) driftStatus = 'WATCH';

    const featureDrift = {
      driftStatus,
      quant: quantDrift,
      emergencyTools,
      conflictRate,
      mismatchRate,
      wickRate,
      errByType,
      recentErrors: recentErrors.slice(-6),
    };

    const attributionMap = {};
    const addAttr = (name, score, samples = 1, weight = null) => {
      const key = String(name || 'unknown').toUpperCase();
      if (!attributionMap[key]) {
        attributionMap[key] = {
          signal: key,
          score: 0,
          samples: 0,
          weightSum: 0,
          weightN: 0,
        };
      }
      attributionMap[key].score += Number.isFinite(score) ? score : 0;
      attributionMap[key].samples += Number.isFinite(samples) ? samples : 0;
      if (Number.isFinite(weight)) {
        attributionMap[key].weightSum += weight;
        attributionMap[key].weightN += 1;
      }
    };

    if (learningEngine?.getAllReports) {
      const reports = learningEngine.getAllReports() || {};
      Object.values(reports).forEach(rep => {
        if (!rep?.signals) return;
        Object.entries(rep.signals).forEach(([signal, st]) => {
          const acc = _obsNum(st.accuracy, null);
          const smp = _obsNum(st.samples, 0);
          const w = _obsNum(st.weight, null);
          if (!Number.isFinite(acc) || smp <= 0) return;
          addAttr(signal, (acc - 0.5) * smp, smp, w);
        });
      });
    }

    eventsSorted.forEach(e => {
      const sigs = e.signalComponents;
      if (!sigs || typeof sigs !== 'object') return;
      const outcomeSign = e.correct ? 1 : -1;
      Object.entries(sigs).forEach(([name, raw]) => {
        let val = null;
        let weight = null;
        if (typeof raw === 'number') {
          val = raw;
        } else if (raw && typeof raw === 'object') {
          val = _obsNum(raw.contribution, null);
          if (!Number.isFinite(val)) val = _obsNum(raw.value, null);
          if (!Number.isFinite(val)) val = _obsNum(raw.score, null);
          weight = _obsNum(raw.weight, null);
        }
        if (!Number.isFinite(val)) return;
        addAttr(name, outcomeSign * Math.abs(val), 1, weight);
      });
    });

    const attributionRows = Object.values(attributionMap)
      .map(r => ({
        signal: r.signal,
        score: r.score,
        samples: r.samples,
        avgWeight: r.weightN ? r.weightSum / r.weightN : null,
      }))
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 12);

    const sourceContribution = {};
    eventsSorted.forEach(e => {
      sourceContribution[e.source] = (sourceContribution[e.source] || 0) + 1;
    });

    const drawdownBySym = {};
    eventsSorted.forEach(e => {
      const sym = e.sym || 'UNK';
      if (!drawdownBySym[sym]) {
        drawdownBySym[sym] = {
          sym,
          equity: 0,
          peak: 0,
          maxDrawdown: 0,
          currentLossStreak: 0,
          maxLossStreak: 0,
          clusterCount: 0,
          clusters: [],
        };
      }
      const s = drawdownBySym[sym];
      s.equity += e.correct ? 1 : -1;
      s.peak = Math.max(s.peak, s.equity);
      s.maxDrawdown = Math.max(s.maxDrawdown, s.peak - s.equity);
      if (!e.correct) {
        s.currentLossStreak += 1;
        s.maxLossStreak = Math.max(s.maxLossStreak, s.currentLossStreak);
      } else if (s.currentLossStreak > 0) {
        if (s.currentLossStreak >= 3) {
          s.clusterCount += 1;
          s.clusters.push({ len: s.currentLossStreak, ts: e.ts });
        }
        s.currentLossStreak = 0;
      }
    });
    Object.values(drawdownBySym).forEach(s => {
      if (s.currentLossStreak >= 3) {
        s.clusterCount += 1;
        s.clusters.push({ len: s.currentLossStreak, ts: Date.now() });
      }
    });

    const drawdownRows = Object.values(drawdownBySym)
      .sort((a, b) => (b.maxDrawdown - a.maxDrawdown) || (b.maxLossStreak - a.maxLossStreak))
      .slice(0, 10);

    const out = {
      sampleCount: eventsSorted.length,
      regimeRows,
      calibrationRows,
      latency,
      featureDrift,
      network: {
        summary: networkSummary,
        recent: recentNetwork,
      },
      attributionRows,
      sourceContribution,
      drawdownRows,
      updatedAt: Date.now(),
    };

    _observabilityCache = { sig, ts: Date.now(), data: out };
    return out;
  }

  function _obsRenderHist(title, hist, accent = 'var(--color-primary)') {
    const max = Math.max(1, ...hist.counts);
    const rows = hist.labels.map((label, i) => {
      const c = hist.counts[i] || 0;
      const width = Math.max(0, Math.min(100, (c / max) * 100));
      return `
        <div style="display:grid;grid-template-columns:60px 1fr 40px;gap:8px;align-items:center;margin:4px 0">
          <span style="font-size:10px;color:var(--color-text-muted)">${label}</span>
          <div style="height:8px;background:var(--color-surface-3);border-radius:999px;overflow:hidden">
            <div style="height:100%;width:${width}%;background:${accent};opacity:0.88"></div>
          </div>
          <span style="font-size:10px;font-family:var(--font-mono);color:var(--color-text)">${c}</span>
        </div>`;
    }).join('');
    return `
      <div class="card" style="padding:12px">
        <div class="card-title" style="margin-bottom:8px">${title}</div>
        ${rows}
      </div>`;
  }

  function renderObservability() {
    const m = _obsBuildMetrics();

    const regimeRows = m.regimeRows.length
      ? m.regimeRows.map(r => {
        const wr = r.winRate;
        const col = wr >= 0.6 ? 'var(--color-green)' : wr >= 0.5 ? 'var(--color-orange)' : 'var(--color-red)';
        return `<tr>
          <td>${r.regime}</td>
          <td style="color:${col};font-weight:700">${_obsPct(wr, 0)}</td>
          <td>${r.wins}/${r.total}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="3" style="color:var(--color-text-faint)">No settled regime samples yet.</td></tr>';

    const calibRows = m.calibrationRows.map(b => {
      const ece = b.ece;
      const eceCol = ece == null ? 'var(--color-text-muted)' : ece < 0.05 ? 'var(--color-green)' : ece < 0.10 ? 'var(--color-orange)' : 'var(--color-red)';
      return `<tr>
        <td>${b.label}</td>
        <td>${_obsPct(b.avgConf, 1)}</td>
        <td>${_obsPct(b.empirical, 1)}</td>
        <td style="color:${eceCol};font-weight:700">${_obsPct(b.ece, 1)}</td>
        <td>${b.total}</td>
      </tr>`;
    }).join('');

    const driftCol = m.featureDrift.driftStatus === 'STABLE'
      ? 'var(--color-green)'
      : m.featureDrift.driftStatus === 'WATCH'
        ? 'var(--color-orange)'
        : 'var(--color-red)';

    const driftErrRows = Object.entries(m.featureDrift.errByType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `<span style="padding:2px 7px;border-radius:999px;background:var(--color-surface-3);font-size:10px;color:var(--color-text-muted)">${k}: ${v}</span>`)
      .join(' ');

    const networkProviderRows = Object.entries(m.network.summary.byProvider || {})
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 6)
      .map(([provider, row]) => {
        const last = row.lastTs ? new Date(row.lastTs).toLocaleTimeString() : '—';
        return `<tr>
          <td style="font-weight:700">${_obsEsc(provider)}</td>
          <td>${row.total}</td>
          <td>${row.http}</td>
          <td>${row.network}</td>
          <td style="font-size:10px;color:var(--color-text-muted)">${last}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="5" style="color:var(--color-text-faint)">No network failures captured.</td></tr>';

    const recentNetworkRows = (m.network.recent || []).slice().reverse().map(e => {
      const status = e.status || e.type;
      const col = e.type === 'NETWORK_ERROR' || Number(e.status) >= 500 ? 'var(--color-red)' : 'var(--color-orange)';
      return `<tr>
        <td style="font-size:10px;color:var(--color-text-muted)">${new Date(e.ts).toLocaleTimeString()}</td>
        <td style="font-weight:700">${_obsEsc(e.provider)}</td>
        <td style="color:${col};font-weight:700">${_obsEsc(status)}</td>
        <td style="font-size:10px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_obsEsc(e.url)}">${_obsEsc(e.url)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" style="color:var(--color-text-faint)">No recent network failures.</td></tr>';

    const attrRows = m.attributionRows.length
      ? m.attributionRows.map(r => {
        const col = r.score >= 0 ? 'var(--color-green)' : 'var(--color-red)';
        return `<tr>
          <td style="font-weight:700">${r.signal}</td>
          <td style="color:${col}">${r.score >= 0 ? '+' : ''}${r.score.toFixed(2)}</td>
          <td>${r.samples}</td>
          <td>${Number.isFinite(r.avgWeight) ? r.avgWeight.toFixed(2) + 'x' : '—'}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="4" style="color:var(--color-text-faint)">No signal attribution samples yet.</td></tr>';

    const srcRows = Object.entries(m.sourceContribution)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
      .join('') || '<tr><td colspan="2" style="color:var(--color-text-faint)">No source contribution data yet.</td></tr>';

    const ddRows = m.drawdownRows.length
      ? m.drawdownRows.map(r => {
        const streakCol = r.currentLossStreak >= 3 ? 'var(--color-red)' : 'var(--color-text)';
        return `<tr>
          <td style="font-weight:700">${r.sym}</td>
          <td>${r.maxDrawdown}</td>
          <td>${r.maxLossStreak}</td>
          <td style="color:${streakCol}">${r.currentLossStreak}</td>
          <td>${r.clusterCount}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="5" style="color:var(--color-text-faint)">No drawdown clusters yet.</td></tr>';

    content.innerHTML = `
      <div class="section-header">
        <span class="section-title">Trading Reliability Observability</span>
        <span style="font-size:11px;color:var(--color-text-faint)">
          Updated ${new Date(m.updatedAt).toLocaleTimeString()} · ${m.sampleCount} settled samples
        </span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-bottom:12px;">
        <div class="card" style="padding:12px">
          <div class="card-title">ASI1 LLM Engine</div>
          <div style="font-size:10px; color:var(--color-text-faint); margin-bottom:4px">
            ${_llmObsStats.enabled ? `🟢 ${_llmObsStats.provider.toUpperCase()} | ${_llmObsStats.model}` : '🔴 Offline'}
          </div>
          <div style="display:flex; justify-content: space-between; align-items: center; margin-top: 6px;">
            <div>
              <div style="font-size:22px;font-weight:800;color:var(--color-primary);font-family:var(--font-mono)">${_llmObsStats.completions}</div>
              <div style="font-size:11px;color:var(--color-text-muted);">Chat Completions</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size:22px;font-weight:800;color:${_llmObsStats.queues > 0 ? 'var(--color-orange)' : 'var(--color-green)'};font-family:var(--font-mono)">${_llmObsStats.queues}</div>
              <div style="font-size:11px;color:var(--color-text-muted);">AIs in Queue</div>
            </div>
          </div>
        </div>
        <div class="card" style="padding:12px">
          <div class="card-title">Feature Drift Status</div>
          <div style="font-size:22px;font-weight:800;color:${driftCol};font-family:var(--font-mono)">${m.featureDrift.driftStatus}</div>
          <div style="font-size:11px;color:var(--color-text-muted);margin-top:6px">
            Dir conflict: ${_obsPct(m.featureDrift.conflictRate, 1)} · Proxy mismatch: ${_obsPct(m.featureDrift.mismatchRate, 1)} · Wick/near-ref: ${_obsPct(m.featureDrift.wickRate, 1)}
          </div>
          <div style="font-size:10px;color:var(--color-text-faint);margin-top:6px;line-height:1.45">
            ${m.featureDrift.quant?.overall_status ? `Quant detector: ${m.featureDrift.quant.overall_status}` : 'Quant drift detector not active in this runtime.'}
          </div>
          <div style="font-size:10px;color:var(--color-text-faint);margin-top:4px;line-height:1.45">
            Emergency tools: ${m.featureDrift.emergencyTools?.note || 'unavailable'}
          </div>
        </div>
        <div class="card" style="padding:12px">
          <div class="card-title">Latency Coverage</div>
          <div style="font-size:22px;font-weight:800;color:var(--color-primary);font-family:var(--font-mono)">${m.latency.samples}</div>
          <div style="font-size:11px;color:var(--color-text-muted);margin-top:6px">
            Fill timestamp coverage: ${_obsPct(m.latency.fillCoverage, 0)}
          </div>
          <div style="font-size:10px;color:var(--color-text-faint);margin-top:6px;line-height:1.45">
            Pipeline histograms show signal→quote→fill→settle where available, with quote→settle fallback when fill is missing.
          </div>
        </div>
        <div class="card" style="padding:12px">
          <div class="card-title">Top Drift/Error Flags</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;line-height:1.8">
            ${driftErrRows || '<span style="font-size:10px;color:var(--color-text-faint)">No recent flagged errors.</span>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="card-title">Network Log</div>
        <div style="font-size:11px;color:var(--color-text-muted);margin-bottom:8px">
          Captured by <code>window.NetworkLog</code>. Console helpers: <code>NetworkLog.report()</code>, <code>NetworkLog.export()</code>, <code>NetworkLog.clear()</code>.
        </div>
        <div style="display:grid;grid-template-columns:minmax(260px,0.8fr) minmax(360px,1.2fr);gap:12px">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Provider</th><th>Total</th><th>HTTP</th><th>Network</th><th>Last</th></tr></thead>
              <tbody>${networkProviderRows}</tbody>
            </table>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Time</th><th>Provider</th><th>Status</th><th>URL</th></tr></thead>
              <tbody>${recentNetworkRows}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div class="card">
          <div class="card-title">Win Rate by Regime</div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Regime</th><th>Win Rate</th><th>W/T</th></tr></thead>
              <tbody>${regimeRows}</tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Calibration Error by Confidence Bucket</div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Bucket</th><th>Avg Conf</th><th>Empirical</th><th>Abs Error</th><th>N</th></tr></thead>
              <tbody>${calibRows}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-bottom:12px;">
        ${_obsRenderHist('Latency: Signal → Quote', m.latency.signalToQuote, 'var(--color-primary)')}
        ${_obsRenderHist('Latency: Quote → Fill', m.latency.quoteToFill, 'var(--color-orange)')}
        ${_obsRenderHist('Latency: Fill → Settle', m.latency.fillToSettle, 'var(--color-green)')}
        ${_obsRenderHist('Latency: Quote → Settle (fallback)', m.latency.quoteToSettle, 'var(--color-text-muted)')}
        ${_obsRenderHist('Latency: Signal → Settle', m.latency.signalToSettle, 'var(--color-red)')}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="card">
          <div class="card-title">Signal Attribution / Contribution</div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Signal</th><th>Net Score</th><th>Samples</th><th>Avg Weight</th></tr></thead>
              <tbody>${attrRows}</tbody>
            </table>
          </div>
          <div style="font-size:10px;color:var(--color-text-faint);margin-top:8px">
            Net score combines adaptive-learning accuracy edge and settled-outcome component impact when present.
          </div>
        </div>
        <div class="card">
          <div class="card-title">Source Contribution Summary</div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Source</th><th>Samples</th></tr></thead>
              <tbody>${srcRows}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="card-title">Drawdown Cluster Indicators</div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Coin</th><th>Max Drawdown</th><th>Max Loss Streak</th><th>Current Loss Streak</th><th>Clusters (>=3)</th></tr></thead>
            <tbody>${ddRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderMarkets() {
    // KPI bar
    let portfolioTotal = 0, portfolioChange = 0, gainers = 0, losers = 0;
    PORTFOLIO_HOLDINGS.forEach(h => {
      const t = tickers[h.instrument];
      if (!t) return;
      const val = h.amount * price(t);
      portfolioTotal += val;
      portfolioChange += change(t);
    });
    WATCHLIST.forEach(c => { const t = tickers[c.instrument]; if (!t) return; change(t) >= 0 ? gainers++ : losers++; });
    const avgChg = portfolioChange / (PORTFOLIO_HOLDINGS.filter(h => tickers[h.instrument]).length || 1);

    // Build sorted list
    let coins = WATCHLIST.filter(FILTER_GROUPS[coinFilter].pred);
    coins = coins.map(c => ({ ...c, ticker: tickers[c.instrument] }));
    coins.sort((a, b) => {
      let av = sortBy === 'price' ? price(a.ticker) : sortBy === 'change' ? change(a.ticker) : volume(a.ticker);
      let bv = sortBy === 'price' ? price(b.ticker) : sortBy === 'change' ? change(b.ticker) : volume(b.ticker);
      return compareNumbers(av, bv, sortDir);
    });

    content.innerHTML = `
      <div class="kpi-bar">
        <div class="kpi-card">
          <div class="kpi-label">Portfolio Value</div>
          <div class="kpi-val blue">$${fmt(portfolioTotal, 2)}</div>
          <div class="kpi-sub ${posneg(avgChg)}">${fmtPct(avgChg)} weighted move across modeled positions</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Market Breadth</div>
          <div class="kpi-val"><span style="color:var(--color-green)">${gainers}↑</span> <span style="color:var(--color-text-faint)">/</span> <span style="color:var(--color-red)">${losers}↓</span></div>
          <div class="kpi-sub">Up vs down pressure across ${WATCHLIST.length} monitored markets</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Strongest Upside</div>
          ${topMover(1)}
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Strongest Downside</div>
          ${topMover(-1)}
        </div>
      </div>

      <div class="section-header">
        <span class="section-title">Reference Tape</span>
        <div class="coin-filters">
          ${Object.entries(FILTER_GROUPS).map(([k, g]) => `
            <button class="filter-btn ${coinFilter === k ? 'active' : ''}" data-filter="${k}">${g.label}</button>
          `).join('')}
        </div>
      </div>

      <div class="table-wrap">
        <table class="price-table" id="priceTable">
          <thead>
            <tr>
              <th>#</th>
              <th>Coin</th>
              <th class="sorted" data-sort="price">Price</th>
              <th data-sort="change">24h %</th>
              <th>24h High</th>
              <th>24h Low</th>
              <th data-sort="volume">Volume</th>
              <th>Spark</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${coins.map((c, i) => marketRow(c, i)).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Filter buttons
    content.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => { coinFilter = btn.dataset.filter; renderMarkets(); });
    });

    // Sort headers
    content.querySelectorAll('[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortBy === col) sortDir *= -1; else { sortBy = col; sortDir = -1; }
        renderMarkets();
      });
    });

    // Chart buttons
    content.querySelectorAll('[data-chart]').forEach(btn => {
      btn.addEventListener('click', () => {
        chartCoin = btn.dataset.chart;
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('[data-view="charts"]').classList.add('active');
        currentView = 'charts';
        if (pageTitle) pageTitle.textContent = 'Market Structure';
        render();
      });
    });

    // Draw sparklines
    requestAnimationFrame(() => drawSparklines(coins));
  }

  function marketRow(c, i) {
    const t = c.ticker;
    const p = price(t), ch = change(t), v = volume(t), h24 = high(t), l24 = low(t);
    const isPortfolio = PORTFOLIO_HOLDINGS.some(h => h.sym === c.sym);
    return `
      <tr id="row-${c.sym}">
        <td style="color:var(--color-text-faint);font-size:11px">${i + 1}</td>
        <td>
          <div class="coin-cell">
            <div class="coin-icon" style="background:${coinColor(c.sym)}22;color:${coinColor(c.sym)}">${coinIcon(c.sym)}</div>
            <div>
              <div class="coin-name">${c.sym} ${isPortfolio ? '<span style="color:var(--color-gold);font-size:9px">●</span>' : ''}</div>
              <div class="coin-sym">${c.name}</div>
            </div>
          </div>
        </td>
        <td class="price-val" id="price-${c.sym}">${t ? fmtPrice(p) : '—'}</td>
        <td class="${chgClass(ch)}" id="chg-${c.sym}">${t ? fmtPct(ch) : '—'}</td>
        <td style="color:var(--color-green)">${t ? fmtPrice(h24) : '—'}</td>
        <td style="color:var(--color-red)">${t ? fmtPrice(l24) : '—'}</td>
        <td>
          <div class="vol-bar-wrap">
            <span>$${fmt(v, 0)}</span>
          </div>
        </td>
        <td class="spark-cell"><canvas class="spark-canvas" id="spark-${c.sym}" width="80" height="28"></canvas></td>
        <td><button class="chart-btn" data-chart="${c.instrument}">Chart</button></td>
      </tr>
    `;
  }

  function topMover(dir) {
    let best = null, bestVal = dir > 0 ? -Infinity : Infinity;
    WATCHLIST.forEach(c => {
      const t = tickers[c.instrument];
      if (!t) return;
      const ch = change(t);
      if (dir > 0 && ch > bestVal) { bestVal = ch; best = c; }
      if (dir < 0 && ch < bestVal) { bestVal = ch; best = c; }
    });
    if (!best) return '<div class="kpi-val">—</div>';
    return `<div class="kpi-val ${dir > 0 ? 'green' : 'red'}">${best.sym} ${fmtPct(bestVal)}</div><div class="kpi-sub">${fmtPrice(price(tickers[best.instrument]))}</div>`;
  }

  function drawSparklines(coins) {
    coins.forEach(c => {
      const canvas = document.getElementById(`spark-${c.sym}`);
      if (!canvas) return;
      const data = sparkData[c.sym];
      if (!data || data.length < 2) return;
      const ctx = canvas.getContext('2d');
      const t = c.ticker;
      const isUp = change(t) >= 0;
      const color = isUp ? '#26d47e' : '#ff4b6e';
      const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
      const W = 80, H = 28;
      ctx.clearRect(0, 0, W, H);
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i / (data.length - 1)) * W;
        const y = H - ((v - min) / range) * (H - 4) - 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Fill
      ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
      ctx.fillStyle = isUp ? 'rgba(38,212,126,0.08)' : 'rgba(255,75,110,0.08)';
      ctx.fill();
    });
  }

  // ================================================================
  // VIEW: PORTFOLIO
  // ================================================================

  function renderPortfolio() {
    let total = 0, totalCost = 0;
    const rows = PORTFOLIO_HOLDINGS.map(h => {
      const t = tickers[h.instrument];
      const p = price(t);
      const val = h.amount * p;
      const cost = h.amount * h.costBasis;
      const pnl = val - cost;
      const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
      total += val;
      totalCost += cost;
      return { ...h, price: p, val, cost, pnl, pnlPct, change: change(t) };
    }).sort((a, b) => b.val - a.val);

    const totalPnl = total - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    content.innerHTML = `
      <div class="portfolio-layout">
        <div>
          <!-- Holdings -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-title">Reference Positions — Edit Amounts Below</div>
            <div style="margin-bottom:12px">
              <div class="portfolio-total">$${fmt(total, 2)}</div>
              <div class="portfolio-pnl ${posneg(totalPnl)}">
                ${fmtPct(totalPnlPct)} (${totalPnl >= 0 ? '+' : ''}$${fmt(Math.abs(totalPnl), 2)}) vs reference cost
              </div>
            </div>
            ${rows.map(h => holdingRow(h, total)).join('')}
          </div>

          <!-- Edit Holdings -->
          <div class="card">
            <div class="card-title">Position Inputs</div>
            <div id="holdingInputs">
              ${PORTFOLIO_HOLDINGS.map(h => `
                <div class="input-group">
                  <span class="input-label" style="color:${coinColor(h.sym)}">${h.sym}</span>
                  <input class="input-field" type="number" id="amt-${h.sym}" value="${h.amount}" step="any" min="0" placeholder="Amount" data-sym="${h.sym}">
                  <input class="input-field" type="number" id="cost-${h.sym}" value="${h.costBasis}" step="any" min="0" placeholder="Avg cost" data-sym="${h.sym}-cost" style="max-width:100px">
                </div>
              `).join('')}
            </div>
            <button class="btn-primary" id="updateHoldingsBtn" style="margin-top:10px">Apply Inputs</button>
          </div>
        </div>

        <div>
          <!-- Allocation Donut -->
          <div class="card" style="margin-bottom:14px">
            <div class="card-title">Exposure Mix</div>
            <div class="donut-wrap">
              <canvas class="donut-canvas" id="donutChart" width="180" height="180"></canvas>
            </div>
            <div id="donutLegend">
              ${rows.slice(0, 8).map(h => `
                <div class="legend-item">
                  <div class="legend-dot" style="background:${coinColor(h.sym)}"></div>
                  <span style="flex:1;font-size:11px">${h.sym}</span>
                  <span style="font-family:var(--font-mono);font-size:11px">${total > 0 ? ((h.val / total) * 100).toFixed(1) : 0}%</span>
                  <span style="font-family:var(--font-mono);font-size:11px;color:var(--color-text-muted);min-width:55px;text-align:right">$${fmt(h.val, 0)}</span>
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Stats -->
          <div class="card">
            <div class="card-title">Position Stats</div>
            <div class="kpi-card" style="margin-bottom:8px;border:none;padding:0">
              <div class="kpi-label">Reference Cost Basis</div>
              <div class="kpi-val blue">$${fmt(totalCost, 2)}</div>
            </div>
            <div class="kpi-card" style="margin-bottom:8px;border:none;padding:0">
              <div class="kpi-label">Reference P/L</div>
              <div class="kpi-val ${totalPnl >= 0 ? 'green' : 'red'}">${totalPnl >= 0 ? '+' : ''}$${fmt(Math.abs(totalPnl), 2)}</div>
            </div>
            <div class="kpi-card" style="border:none;padding:0">
              <div class="kpi-label">Reference Return</div>
              <div class="kpi-val ${totalPnlPct >= 0 ? 'green' : 'red'}">${fmtPct(totalPnlPct)}</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Draw donut
    requestAnimationFrame(() => {
      const canvas = document.getElementById('donutChart');
      if (!canvas) return;
      if (donutChart) { donutChart.destroy(); donutChart = null; }
      const top8 = rows.slice(0, 8);
      const otherVal = rows.slice(8).reduce((s, h) => s + h.val, 0);
      const labels = [...top8.map(h => h.sym), otherVal > 0 ? 'Other' : null].filter(Boolean);
      const vals = [...top8.map(h => h.val), otherVal > 0 ? otherVal : null].filter(Boolean);
      const colors = [...top8.map(h => coinColor(h.sym)), '#444a60'];
      donutChart = new Chart(canvas, {
        type: 'doughnut',
        data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }] },
        options: {
          responsive: false, cutout: '70%',
          plugins: {
            legend: { display: false }, tooltip: {
              callbacks: { label: ctx => ` ${ctx.label}: $${fmt(ctx.raw, 0)} (${total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0}%)` }
            }
          }
        }
      });
    });

    // Edit holdings
    const updateBtn = document.getElementById('updateHoldingsBtn');
    if (updateBtn) {
      updateBtn.addEventListener('click', () => {
        PORTFOLIO_HOLDINGS.forEach(h => {
          const amtEl = document.getElementById(`amt-${h.sym}`);
          const costEl = document.getElementById(`cost-${h.sym}`);
          if (amtEl) h.amount = parseFloat(amtEl.value) || 0;
          if (costEl) h.costBasis = parseFloat(costEl.value) || 0;
        });
        renderPortfolio();
      });
    }
  }

  function holdingRow(h, total) {
    const pct = total > 0 ? (h.val / total) * 100 : 0;
    return `
      <div class="holding-row">
        <div class="coin-icon" style="background:${coinColor(h.sym)}22;color:${coinColor(h.sym)};width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${coinIcon(h.sym)}</div>
        <div class="holding-info">
          <div class="holding-name">${h.sym}</div>
          <div class="holding-amt">${h.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} @ ${fmtPrice(h.costBasis)}</div>
          <div class="alloc-bar-wrap"><div class="alloc-bar" style="width:${pct}%;background:${coinColor(h.sym)}"></div></div>
        </div>
        <div class="holding-right">
          <div class="holding-val">${h.price > 0 ? '$' + fmt(h.val, 2) : '—'}</div>
          <div class="holding-chg ${posneg(h.pnl)}">${h.pnlPct !== 0 ? fmtPct(h.pnlPct) + ' PnL' : '—'}</div>
        </div>
      </div>
    `;
  }

  // ================================================================
  // VIEW: CHARTS (Lightweight Charts candlesticks)
  // ================================================================

  function renderCharts() {
    if (candleChart) destroyChart();
    const coins = WATCHLIST;
    const options = coins.map(c => `<option value="${c.instrument}" ${c.instrument === chartCoin ? 'selected' : ''}>${c.sym} — ${c.name}</option>`).join('');

    content.innerHTML = `
      <div class="charts-controls">
        <div class="coin-select-wrap">
          <span class="ctrl-label">Coin</span>
          <select class="ctrl-select" id="chartCoinSelect">${options}</select>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="ctrl-label">Timeframe</span>
          <div class="tf-btns">
            ${['1m', '3m', '5m', '15m', '1h', '4h', '1D', '1W'].map(tf => `<button class="tf-btn ${chartTf === tf ? 'active' : ''}" data-tf="${tf}">${tf}</button>`).join('')}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="ctrl-label">Tracing</span>
          <div class="tf-btns">
            ${[
        ['ema9', 'EMA 9'],
        ['ema21', 'EMA 21'],
        ['vwap', 'VWAP'],
        ['support', 'Support'],
        ['resistance', 'Resistance'],
        ['trend', 'Trend'],
      ].map(([key, label]) => `<button class="tf-btn ${chartIndicators[key] ? 'active' : ''}" data-indicator="${key}">${label}</button>`).join('')}
          </div>
        </div>
        <button class="btn-outline" id="chartRefreshBtn">Refresh Chart</button>
      </div>

      <div class="chart-container" id="chartContainer">
        <div class="chart-stage" id="chartStage"></div>
        <div class="chart-loading" id="chartLoading"><div class="loader-ring"></div><p>Loading candles...</p></div>
      </div>

      <div class="ohlc-row" id="ohlcRow"></div>

      <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="card">
          <div class="card-title">Order Book Snapshot</div>
          <div id="orderBook"><div class="empty-state" style="padding:20px">Select a coin above</div></div>
        </div>
        <div class="card">
          <div class="card-title">Recent Trades</div>
          <div id="recentTrades"><div class="empty-state" style="padding:20px">Select a coin above</div></div>
        </div>
      </div>
    `;

    // Bind controls
    const sel = document.getElementById('chartCoinSelect');
    if (sel) sel.addEventListener('change', e => { chartCoin = e.target.value; loadCandles({ showLoader: true, reuseChart: false }); });

    content.querySelectorAll('.tf-btn').forEach(btn => {
      if (btn.dataset.tf) btn.addEventListener('click', () => {
        chartTf = btn.dataset.tf;
        content.querySelectorAll('.tf-btn[data-tf]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadCandles({ showLoader: false, reuseChart: true });
      });
      if (btn.dataset.indicator) btn.addEventListener('click', () => {
        const key = btn.dataset.indicator;
        chartIndicators[key] = !chartIndicators[key];
        btn.classList.toggle('active', chartIndicators[key]);
        updateChartOverlays();
      });
    });

    const refreshChartBtn = document.getElementById('chartRefreshBtn');
    if (refreshChartBtn) refreshChartBtn.addEventListener('click', () => loadCandles({ showLoader: false, reuseChart: true }));

    loadCandles({ showLoader: !chartRawCandles.length, reuseChart: true });
  }

  function setChartLoading(isLoading) {
    const loading = document.getElementById('chartLoading');
    if (loading) loading.style.display = isLoading ? 'flex' : 'none';
  }

  function calcLineEMA(values, period) {
    if (!values.length) return [];
    const k = 2 / (period + 1);
    const ema = [values[0]];
    for (let i = 1; i < values.length; i++) ema.push(values[i] * k + ema[i - 1] * (1 - k));
    return ema;
  }

  function calcLineVWAP(rows) {
    let cumVol = 0;
    let cumTpVol = 0;
    return rows.map(row => {
      const vol = row.volume || 1;
      const tp = (row.high + row.low + row.close) / 3;
      cumVol += vol;
      cumTpVol += tp * vol;
      return { time: row.time, value: cumTpVol / cumVol };
    });
  }

  function destroyChart() {
    if (chartResizeObserver) {
      try { chartResizeObserver.disconnect(); } catch (e) { }
      chartResizeObserver = null;
    }
    if (candleChart) {
      try { candleChart.remove(); } catch (e) { }
      candleChart = null;
    }
    chartSeries = {};
    chartRawCandles = [];
    chartSnapshot = null;
  }

  function ensureChart(container) {
    if (candleChart && chartSeries.candles && chartSeries.volume) return;
    const isDark = root.getAttribute('data-theme') !== 'light';
    const bg = isDark ? '#111318' : '#ffffff';
    const textColor = isDark ? '#7880a0' : '#6470a0';
    const grid = isDark ? '#252932' : '#dde0ea';

    candleChart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 388,
      layout: { background: { type: 'solid', color: bg }, textColor },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: true },
    });

    chartSeries.candles = candleChart.addCandlestickSeries({
      upColor: '#26d47e', downColor: '#ff4b6e',
      borderUpColor: '#26d47e', borderDownColor: '#ff4b6e',
      wickUpColor: '#26d47e', wickDownColor: '#ff4b6e',
    });
    chartSeries.volume = candleChart.addHistogramSeries({
      color: '#26d47e',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    candleChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chartSeries.ema9 = candleChart.addLineSeries({ color: '#26d47e', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.ema21 = candleChart.addLineSeries({ color: '#00b4d8', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.vwap = candleChart.addLineSeries({ color: '#f3ba2f', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.support = candleChart.addLineSeries({ color: '#50e3c2', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.resistance = candleChart.addLineSeries({ color: '#ff9f3a', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    chartSeries.trend = candleChart.addLineSeries({ color: '#a259ff', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });

    chartResizeObserver = new ResizeObserver(() => {
      if (candleChart && container.clientWidth > 0) candleChart.applyOptions({ width: container.clientWidth });
    });
    chartResizeObserver.observe(container);
  }

  function updateChartOverlays() {
    if (!chartRawCandles.length || !chartSeries.candles) return;
    const closes = chartRawCandles.map(c => c.close);
    const ema9 = calcLineEMA(closes, 9).map((value, i) => ({ time: chartRawCandles[i].time, value }));
    const ema21 = calcLineEMA(closes, 21).map((value, i) => ({ time: chartRawCandles[i].time, value }));
    const vwap = calcLineVWAP(chartRawCandles);
    const recent = chartRawCandles.slice(-24);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const support = recent.length ? Math.min(...recent.map(c => c.low)) : null;
    const resistance = recent.length ? Math.max(...recent.map(c => c.high)) : null;
    const supportLine = support !== null ? [{ time: first.time, value: support }, { time: last.time, value: support }] : [];
    const resistanceLine = resistance !== null ? [{ time: first.time, value: resistance }, { time: last.time, value: resistance }] : [];
    const trendLine = recent.length ? [{ time: first.time, value: first.close }, { time: last.time, value: last.close }] : [];

    chartSeries.ema9.setData(chartIndicators.ema9 ? ema9 : []);
    chartSeries.ema21.setData(chartIndicators.ema21 ? ema21 : []);
    chartSeries.vwap.setData(chartIndicators.vwap ? vwap : []);
    chartSeries.support.setData(chartIndicators.support ? supportLine : []);
    chartSeries.resistance.setData(chartIndicators.resistance ? resistanceLine : []);
    chartSeries.trend.setData(chartIndicators.trend ? trendLine : []);
  }

  function updateChartMarketPanels() {
    const last = chartRawCandles[chartRawCandles.length - 1];
    const coin = WATCHLIST.find(c => c.instrument === chartCoin) || findCoinByInstrument(chartCoin);
    const t = chartSnapshot || tickers[chartCoin] || null;
    const ohlcRow = document.getElementById('ohlcRow');
    if (ohlcRow && last) {
      const recent = chartRawCandles.slice(-24);
      const support = recent.length ? Math.min(...recent.map(c => c.low)) : 0;
      const resistance = recent.length ? Math.max(...recent.map(c => c.high)) : 0;
      ohlcRow.innerHTML = `
        <div class="ohlc-item"><div class="ohlc-label">Open</div><div class="ohlc-val">${fmtPrice(last.open)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">High</div><div class="ohlc-val" style="color:var(--color-green)">${fmtPrice(last.high)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Low</div><div class="ohlc-val" style="color:var(--color-red)">${fmtPrice(last.low)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Close</div><div class="ohlc-val">${fmtPrice(last.close)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Change</div><div class="ohlc-val ${posneg(last.close - last.open)}">${fmtPct(((last.close - last.open) / last.open) * 100)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Support</div><div class="ohlc-val">${fmtPrice(support)}</div></div>
        <div class="ohlc-item"><div class="ohlc-label">Resistance</div><div class="ohlc-val">${fmtPrice(resistance)}</div></div>
        ${coin ? `<div class="ohlc-item"><div class="ohlc-label">Coin</div><div class="ohlc-val" style="color:${coinColor(coin.sym)}">${coin.sym}</div></div>` : ''}
        <div class="ohlc-item"><div class="ohlc-label">Feed</div><div class="ohlc-val">${t?.source === 'coingecko' ? 'Gecko' : 'CDC'}</div></div>
      `;
    }

    const ob = document.getElementById('orderBook');
    if (ob) {
      // Pull bid/ask from ticker; fall back to live OB book (HL WebSocket) if ticker has none
      const obBook = window.OB?.books?.[chartCoin || coin?.sym];
      const bid = parseFloat(t?.best_bid) || obBook?.bids?.[0]?.[0] || NaN;
      const ask = parseFloat(t?.best_ask) || obBook?.asks?.[0]?.[0] || NaN;
      const hasBook = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && t?.source !== 'coingecko';
      if (hasBook) {
        const spread = ((ask - bid) / bid * 100).toFixed(4);
        const bidSz = t?.best_bid_size || (obBook?.bids?.[0]?.[1]?.toFixed(2)) || '—';
        const askSz = t?.best_ask_size || (obBook?.asks?.[0]?.[1]?.toFixed(2)) || '—';
        ob.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12px;font-family:var(--font-mono)">
            <div style="color:var(--color-text-muted);font-size:10px;text-transform:uppercase">Ask</div>
            <div style="color:var(--color-text-muted);font-size:10px;text-transform:uppercase;text-align:right">Bid</div>
            <div style="color:var(--color-red)">${fmtPrice(ask)}</div>
            <div style="color:var(--color-green);text-align:right">${fmtPrice(bid)}</div>
            <div style="color:var(--color-text-muted);font-size:10px">${askSz}</div>
            <div style="color:var(--color-text-muted);font-size:10px;text-align:right">${bidSz}</div>
          </div>
          <div style="margin-top:10px;font-size:11px;color:var(--color-text-muted)">Spread: <span style="color:var(--color-gold)">${spread}%</span></div>
          <div style="font-size:11px;color:var(--color-text-muted);margin-top:4px">24h Vol: <span style="color:var(--color-text)">${fmtCompactUsd(volume(t))}</span></div>
        `;
      } else {
        const srcLabel = t?.source === 'coingecko' ? 'CoinGecko supplemental data'
          : (t?.source === 'pyth' || t?.source === 'hyperliquid') ? `${t.source} oracle (mid price only)`
            : 'this feed';
        ob.innerHTML = `
          <div class="empty-state" style="padding:20px 12px;text-align:left">
            <div style="font-size:12px;color:var(--color-text)">Order book unavailable for ${coin?.sym || chartCoin}</div>
            <div style="margin-top:6px">No bid/ask from ${srcLabel} — OB stream connecting…</div>
            <div style="margin-top:8px;font-size:11px;color:var(--color-text-muted)">24h Vol: <span style="color:var(--color-text)">${fmtCompactUsd(volume(t))}</span></div>
          </div>
        `;
      }
    }

    const rt = document.getElementById('recentTrades');
    if (rt && last) {
      const side = last.close >= last.open ? 'BUY' : 'SELL';
      rt.innerHTML = `
        <div style="font-size:11px;color:var(--color-text-muted);margin-bottom:8px">Latest market snapshot</div>
        <div class="token-row">
          <span class="token-sym" style="color:${side === 'BUY' ? 'var(--color-green)' : 'var(--color-red)'}">${side}</span>
          <span class="token-name">Last Trade</span>
          <span class="token-bal">${fmtPrice(t ? price(t) : last.close)}</span>
        </div>
        <div class="token-row">
          <span class="token-sym" style="color:var(--color-primary)">EMA</span>
          <span class="token-name">Overlay Stack</span>
          <span class="token-bal">${chartIndicators.ema9 || chartIndicators.ema21 ? 'ON' : 'OFF'}</span>
        </div>
        <div class="token-row">
          <span class="token-sym" style="color:var(--color-gold)">VWAP</span>
          <span class="token-name">Benchmark Line</span>
          <span class="token-bal">${chartIndicators.vwap ? 'ON' : 'OFF'}</span>
        </div>
        <div class="token-row">
          <span class="token-sym" style="color:var(--color-text-muted)">FEED</span>
          <span class="token-name">${t?.source === 'coingecko' ? 'CoinGecko fallback' : 'Market snapshot'}</span>
          <span class="token-bal">${t?.source === 'coingecko' ? 'GECKO' : 'CDC'}</span>
        </div>
        <div class="token-row">
          <span class="token-sym" style="color:var(--color-text-muted)">VOL</span>
          <span class="token-name">24h Volume</span>
          <span class="token-bal">${fmtCompactUsd(volume(t))}</span>
        </div>
      `;
    }
  }

  async function loadCandles(options = {}) {
    const stage = document.getElementById('chartStage');
    if (!stage) return;
    const showLoader = options.showLoader !== false;

    // Map our TF labels to CDC API values
    const tfMap = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1D': '1D', '1W': '1W' };
    const tf = tfMap[chartTf] || '1h';

    try {
      if (showLoader) setChartLoading(true);
      const candles = await fetchCandlesticks(chartCoin, tf);
      chartSnapshot = tickers[chartCoin] || null;
      const series = candles
        .map(c => ({
          time: Math.floor(c[0] / 1000),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5] || 0),
        }))
        .sort((a, b) => a.time - b.time);

      ensureChart(stage);
      chartRawCandles = series;
      chartSeries.candles.setData(series.map(({ volume, ...rest }) => rest));
      chartSeries.volume.setData(series.map(c => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,212,126,0.3)' : 'rgba(255,75,110,0.3)',
      })));
      updateChartOverlays();
      updateChartMarketPanels();

      // Zoom: short TFs show a tight window so candles are large and readable.
      // Longer TFs show all data (fitContent).
      // barSpacing is set explicitly per-TF so candle widths look right regardless of chart width.
      const ZOOM_WINDOW = { '1m': 60, '3m': 60, '5m': 80, '15m': 120 };
      const BAR_SPACING = { '1m': 5, '3m': 7, '5m': 9, '15m': 9 };
      const total = series.length;
      const show = ZOOM_WINDOW[chartTf];
      const bs = BAR_SPACING[chartTf];
      if (candleChart) {
        if (bs) candleChart.timeScale().applyOptions({ barSpacing: bs });
        if (show && total > show) {
          candleChart.timeScale().setVisibleLogicalRange({ from: total - show - 1, to: total - 1 });
        } else {
          candleChart.timeScale().fitContent();
        }
      }
      setChartLoading(false);

    } catch (err) {
      console.error('Candles error:', err);
      const container = document.getElementById('chartContainer');
      if (container && !candleChart) container.innerHTML = `<div class="error-notice">⚠ Could not load candles: ${err.message}</div>`;
      setChartLoading(false);
    }
  }

  // ================================================================
  // VIEW: ON-CHAIN (Blockscout + Live Blockchain Scanners)
  // ================================================================

  const CHAIN_COLORS = {
    BTC: '#f7931a', ETH: '#627eea', SOL: '#9945ff',
    XRP: '#00aae4', BNB: '#f3ba2f', DOGE: '#c2a633', HYPE: '#00d4aa',
  };

  function buildChainScanPlaceholders() {
    return ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'].map(sym => `
      <div class="chain-scan-card" id="chain-card-${sym}">
        <div class="chain-scan-header">
          <span class="chain-scan-sym" style="color:${CHAIN_COLORS[sym]}">${sym}</span>
          <span class="chain-scan-badge neutral">LOADING</span>
        </div>
        <div class="chain-scan-loading">Fetching on-chain data…</div>
      </div>
    `).join('');
  }

  function buildChainCard(d) {
    const color = CHAIN_COLORS[d.sym] || '#888';
    const sigCls = d.signal === 'BULLISH' ? 'bullish' : d.signal === 'BEARISH' ? 'bearish' : 'neutral';
    const ago = d.ts ? Math.round((Date.now() - d.ts) / 1000) : null;
    const agoStr = ago !== null ? (ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`) : '';
    if (d.error) {
      return `
        <div class="chain-scan-card" id="chain-card-${d.sym}">
          <div class="chain-scan-header">
            <span class="chain-scan-sym" style="color:${color}">${d.sym}</span>
            <span class="chain-scan-badge neutral">OFFLINE</span>
          </div>
          <div style="font-size:11px;color:var(--color-text-muted);padding:8px 0">${escapeHtml(d.error)}</div>
          <div class="chain-scan-footer">
            <span>${d.source || '—'}</span>
            ${d.explorerUrl && d.explorerUrl !== '#' ? `<a href="${d.explorerUrl}" target="_blank" class="chain-scan-link">Explorer ↗</a>` : ''}
            <span>${agoStr}</span>
          </div>
        </div>`;
    }
    const metricsHtml = (d.metrics || []).map(m => `
      <div class="chain-metric-row">
        <span class="chain-metric-key">${escapeHtml(m.k)}</span>
        <span class="chain-metric-val">${escapeHtml(m.v)}</span>
      </div>`).join('');
    return `
      <div class="chain-scan-card" id="chain-card-${d.sym}">
        <div class="chain-scan-header">
          <div>
            <span class="chain-scan-sym" style="color:${color}">${d.sym}</span>
            <span class="chain-scan-chain">${escapeHtml(d.chain)}</span>
          </div>
          <span class="chain-scan-badge ${sigCls}">${d.signal}</span>
        </div>
        <div class="chain-scan-metrics">${metricsHtml}</div>
        <div class="chain-scan-footer">
          <span>${escapeHtml(d.source)}</span>
          <a href="${d.explorerUrl}" target="_blank" class="chain-scan-link">Explorer ↗</a>
          <span>${agoStr}</span>
        </div>
      </div>`;
  }

  function refreshChainScanUI() {
    const grid = document.getElementById('chainScanGrid');
    const age = document.getElementById('chainScanAge');
    if (!grid) return;
    const all = window.BlockchainScan?.getAll() || {};
    const syms = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
    if (!Object.keys(all).length) {
      if (age) age.textContent = 'Waiting for data…';
      return;
    }
    // Update each card individually to avoid full re-render flicker
    syms.forEach(sym => {
      const d = all[sym];
      const slot = document.getElementById(`chain-card-${sym}`);
      if (!d || !slot) return;
      slot.outerHTML = buildChainCard(d);
    });
    if (age) {
      const oldest = Math.min(...syms.filter(s => all[s]?.ts).map(s => all[s].ts));
      const sec = Math.round((Date.now() - oldest) / 1000);
      age.textContent = sec < 60 ? `Updated ${sec}s ago` : `Updated ${Math.round(sec / 60)}m ago`;
    }
  }

  function renderOnChain() {
    content.innerHTML = `
      <div style="margin-bottom:14px">
        <div class="error-notice" style="background:var(--color-primary-dim);border-color:var(--color-primary);color:var(--color-primary)">
          ℹ Use wallet activity as a confirmation layer for narrative, treasury, and whale flow behind UP/DOWN calls.
        </div>
      </div>
      <div class="onchain-grid">
        <div class="card">
          <div class="card-title">Wallet Lookup — Ethereum</div>
          <div class="wallet-input-wrap">
            <input class="wallet-input" id="walletInput" placeholder="0x wallet address" type="text">
            <button class="btn-sm" id="lookupBtn">Lookup</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
            <span style="font-size:10px;color:var(--color-text-muted)">⚙ Etherscan key (optional, improves fallback):</span>
            <input id="etherscanKeyInput" type="password" placeholder="paste API key" value="${localStorage.getItem('etherscanApiKey') || ''}"
              style="flex:1;background:var(--color-surface-2);border:1px solid var(--color-border-dim);color:var(--color-text);border-radius:4px;padding:3px 6px;font-size:10px;font-family:var(--font-mono)">
            <button class="btn-sm" id="saveEsKey" style="font-size:10px;padding:3px 8px">Save</button>
          </div>
          <div id="walletResult">
            <div class="empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
              Enter a wallet address above
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Tracked Token Flows</div>
          <div id="tokenBalances">
            <div class="empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              Waiting for wallet lookup
            </div>
          </div>
        </div>

        <div class="card" style="grid-column:1/-1">
          <div class="card-title">Recent Flow</div>
          <div id="txHistory">
            <div class="empty-state">No transactions loaded</div>
          </div>
        </div>

        <!-- Live chain intelligence — full-width spanning section -->
        <div class="card" style="grid-column:1/-1">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <div class="card-title" style="margin-bottom:0">Live Chain Intelligence</div>
            <div style="display:flex;align-items:center;gap:10px">
              <span id="chainScanAge" style="font-size:10px;color:var(--color-text-muted)">Loading…</span>
              <button class="btn-sm" id="chainScanRefreshBtn" style="font-size:11px;padding:4px 10px">↻ Refresh</button>
            </div>
          </div>
          <div class="chain-scan-grid" id="chainScanGrid">
            ${buildChainScanPlaceholders()}
          </div>
        </div>
      </div>
    `;

    // Wallet lookup
    const lookupBtn = document.getElementById('lookupBtn');
    const walletInput = document.getElementById('walletInput');
    if (lookupBtn && walletInput) {
      const doLookup = async () => {
        const addr = walletInput.value.trim();
        if (!addr) return;
        window._walletDataDiagnostics = {};
        lookupBtn.textContent = 'Loading...';
        lookupBtn.disabled = true;
        try {
          const [tokenData, txData] = await Promise.all([
            fetchWalletTokens(addr),
            fetchWalletTxs(addr)
          ]);
          renderWalletResult(addr, tokenData, txData);
        } catch (err) {
          document.getElementById('walletResult').innerHTML = `<div class="error-notice">⚠ ${err.message}</div>`;
          document.getElementById('tokenBalances').innerHTML = `<div class="error-notice">⚠ Could not fetch token balances</div>`;
        }
        lookupBtn.textContent = 'Lookup';
        lookupBtn.disabled = false;
      };
      lookupBtn.addEventListener('click', doLookup);
      walletInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
    }

    // Etherscan key save
    const saveEsKey = document.getElementById('saveEsKey');
    if (saveEsKey) {
      saveEsKey.addEventListener('click', () => {
        const val = (document.getElementById('etherscanKeyInput')?.value || '').trim();
        if (val) { localStorage.setItem('etherscanApiKey', val); saveEsKey.textContent = 'Saved ✓'; }
        else { localStorage.removeItem('etherscanApiKey'); saveEsKey.textContent = 'Cleared'; }
        setTimeout(() => { saveEsKey.textContent = 'Save'; }, 1500);
      });
    }

    // Chain scan — show cached data immediately, then listen for live updates
    refreshChainScanUI();
    const chainRefreshBtn = document.getElementById('chainScanRefreshBtn');
    if (chainRefreshBtn) {
      chainRefreshBtn.addEventListener('click', () => {
        chainRefreshBtn.disabled = true;
        chainRefreshBtn.textContent = '…';
        window.BlockchainScan?.fetchAll().then(() => {
          chainRefreshBtn.disabled = false;
          chainRefreshBtn.textContent = '↻ Refresh';
        });
      });
    }
  }

  function renderWalletResult(addr, tokenData, txData) {
    const src = window._walletDataSource || 'blockscout';
    const srcLabel = { blockscout: 'Blockscout', ethplorer: 'Ethplorer', etherscan: 'Etherscan' }[src] || src;
    const diagnostics = window._walletDataDiagnostics || {};
    const tokenDiag = diagnostics.tokens;
    const txDiag = diagnostics.txs;
    const reasonItems = [tokenDiag, txDiag]
      .filter(d => d && d.reasonCode && d.reasonCode !== 'ok')
      .map(d => `<span class="wallet-source-badge" style="background:var(--color-surface-3);border-color:var(--color-warning);color:var(--color-warning)">${escapeHtml(d.type)}:${escapeHtml(d.reasonCode)}</span>`)
      .join('');
    const reasonDetails = [tokenDiag, txDiag]
      .filter(d => d && d.reasonCode && d.reasonCode !== 'ok' && d.reasonDetail)
      .map(d => `<div style="font-size:10px;color:var(--color-text-muted)">${escapeHtml(d.type)} → ${escapeHtml(d.reasonDetail)}</div>`)
      .join('');
    // Wallet summary
    const wResult = document.getElementById('walletResult');
    if (wResult) {
      wResult.innerHTML = `
        <div style="font-size:12px;color:var(--color-text-muted);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span>Address: <span style="font-family:var(--font-mono);color:var(--color-primary)">${escapeHtml(formatAddress(addr))}</span></span>
          <span class="wallet-source-badge ${src}">${srcLabel}</span>
          ${reasonItems}
          <a href="https://eth.blockscout.com/address/${encodeURIComponent(addr)}" target="_blank" style="font-size:10px;color:var(--color-primary)">Blockscout ↗</a>
          <a href="https://etherscan.io/address/${encodeURIComponent(addr)}" target="_blank" style="font-size:10px;color:var(--color-primary)">Etherscan ↗</a>
        </div>
        ${reasonDetails ? `<div style="margin:-2px 0 8px 0">${reasonDetails}</div>` : ''}
        <div style="font-size:13px">
          Found <strong>${Array.isArray(tokenData) ? tokenData.length : 0}</strong> ERC-20 tokens
          and <strong>${txData?.items?.length || 0}</strong> recent transactions
        </div>
      `;
    }

    // Token balances
    const tb = document.getElementById('tokenBalances');
    if (tb) {
      const tokens = Array.isArray(tokenData) ? tokenData.filter(t => t.token && parseFloat(t.value) > 0) : [];
      if (tokens.length === 0) {
        tb.innerHTML = '<div class="empty-state" style="padding:20px">No ERC-20 tokens found (or wallet is empty)</div>';
      } else {
        tb.innerHTML = tokens.slice(0, 20).map(t => {
          const decimals = parseInt(t.token?.decimals || 18);
          const bal = parseFloat(t.value) / Math.pow(10, decimals);
          const sym = t.token?.symbol || '?';
          const tickerKey = sym + 'USD';
          const livePrice = tickers[tickerKey] ? price(tickers[tickerKey]) : null;
          const usdVal = livePrice ? bal * livePrice : null;
          return `
            <div class="token-row">
              <span class="token-sym">${escapeHtml(sym)}</span>
              <span class="token-name">${t.token?.address ? `<a href="https://etherscan.io/token/${encodeURIComponent(t.token.address)}" target="_blank" style="color:inherit;text-decoration:none">${escapeHtml(t.token?.name || '—')}</a>` : escapeHtml(t.token?.name || '—')}</span>
              <span class="token-bal">${fmt(bal, 4)}</span>
              <span class="token-val">${usdVal ? '$' + fmt(usdVal, 2) : '—'}</span>
            </div>
          `;
        }).join('');
      }
    }

    // Transactions
    const txH = document.getElementById('txHistory');
    if (txH) {
      const txs = txData?.items || [];
      if (txs.length === 0) {
        txH.innerHTML = '<div class="empty-state">No recent transactions</div>';
      } else {
        txH.innerHTML = txs.slice(0, 10).map(tx => {
          const isIn = tx.to?.hash?.toLowerCase() === addr.toLowerCase();
          const val = tx.value ? (parseFloat(tx.value) / 1e18).toFixed(6) : '0';
          const age = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : '—';
          return `
            <div class="tx-row">
              <div class="tx-hash" onclick="window.open('https://etherscan.io/tx/${encodeURIComponent(tx.hash || '')}','_blank')">${tx.hash ? escapeHtml(tx.hash.slice(0, 10) + '...' + tx.hash.slice(-8)) : '—'}</div>
              <div class="tx-meta">${escapeHtml(age)} · ${escapeHtml(tx.method || 'transfer')} · Gas: ${escapeHtml(tx.gas_used || '—')}</div>
              <div class="tx-val ${isIn ? 'in' : 'out'}">${isIn ? '+ ' : '- '}${val} ETH</div>
              <div style="font-size:10px;color:var(--color-text-muted)"><a href="https://eth.blockscout.com/tx/${encodeURIComponent(tx.hash || '')}" target="_blank" style="color:var(--color-primary)">Blockscout</a> · <a href="https://etherscan.io/tx/${encodeURIComponent(tx.hash || '')}" target="_blank" style="color:var(--color-primary)">Etherscan</a></div>
            </div>
          `;
        }).join('');
      }
    }
  }

  // ================================================================
  // VIEW: SCREENER
  // ================================================================

  function sortScreenerCoins(coins) {
    return [...coins].sort((a, b) => {
      if (screenerSortBy === 'alpha') return screenerSortDir === -1 ? b.sym.localeCompare(a.sym) : a.sym.localeCompare(b.sym);
      const av = screenerSortBy === 'marketCap' ? marketCap(a.meta)
        : screenerSortBy === 'atomicWeight' ? atomicWeight(a.meta)
          : screenerSortBy === 'volume' ? (a.meta?.totalVolume || a.vol)
            : a.change;
      const bv = screenerSortBy === 'marketCap' ? marketCap(b.meta)
        : screenerSortBy === 'atomicWeight' ? atomicWeight(b.meta)
          : screenerSortBy === 'volume' ? (b.meta?.totalVolume || b.vol)
            : b.change;
      return compareNumbers(av, bv, screenerSortDir);
    });
  }

  async function renderScreener() {
    const _myRV = _rv; // capture version — bail after any await if stale
    if (!Object.keys(screenerMetaCache).length) {
      content.innerHTML = `<div class="loading-screen"><div class="loader-ring"></div><p>Loading market overview...</p></div>`;
      try { await fetchScreenerMeta(); } catch (e) { /* use stale cache or empty */ }
      if (_rv !== _myRV) return; // user navigated away during meta fetch
    } else {
      fetchScreenerMeta().catch(() => { });
    }

    const coins = sortScreenerCoins(WATCHLIST.map(c => {
      const t = tickers[c.instrument];
      const ch = change(t);
      const meta = screenerMetaCache[c.sym] || {};
      return { ...c, ticker: t, change: ch, price: price(t), vol: volume(t), meta };
    }));

    const gainers = coins.filter(c => c.change > 3);
    const losers = coins.filter(c => c.change < -3);
    const hot = coins.filter(c => (c.meta?.totalVolume || c.vol) > 100000);
    const topGravity = WATCHLIST
      .map(c => ({ ...c, meta: screenerMetaCache[c.sym] || {} }))
      .filter(c => atomicWeight(c.meta) > 0)
      .sort((a, b) => atomicWeight(b.meta) - atomicWeight(a.meta))
      .slice(0, 5);

    content.innerHTML = `
      <div class="kpi-bar" style="margin-bottom:20px">
        <div class="kpi-card"><div class="kpi-label">Signal Candidates</div><div class="kpi-val blue">${gainers.length + losers.length}</div><div class="kpi-sub">±3% tape expansion threshold</div></div>
        <div class="kpi-card"><div class="kpi-label">UP Bias >3%</div><div class="kpi-val green">${gainers.length}</div></div>
        <div class="kpi-card"><div class="kpi-label">DOWN Bias >3%</div><div class="kpi-val red">${losers.length}</div></div>
        <div class="kpi-card"><div class="kpi-label">High Activity Tape</div><div class="kpi-val gold">${hot.length}</div><div class="kpi-sub">>$100k daily volume</div></div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-title">Directory Controls</div>
        <div class="screener-toolbar">
          <div class="coin-select-wrap">
            <span class="ctrl-label">Sort</span>
            <select class="ctrl-select" id="screenerSortSelect">
              <option value="marketCap" ${screenerSortBy === 'marketCap' ? 'selected' : ''}>Market Cap</option>
              <option value="atomicWeight" ${screenerSortBy === 'atomicWeight' ? 'selected' : ''}>Atomic Weight</option>
              <option value="volume" ${screenerSortBy === 'volume' ? 'selected' : ''}>Volume</option>
              <option value="change" ${screenerSortBy === 'change' ? 'selected' : ''}>24h Change</option>
              <option value="alpha" ${screenerSortBy === 'alpha' ? 'selected' : ''}>Alphabetical</option>
            </select>
          </div>
          <div class="tf-btns">
            <button class="tf-btn ${screenerSortDir === -1 ? 'active' : ''}" data-screener-dir="-1">Desc</button>
            <button class="tf-btn ${screenerSortDir === 1 ? 'active' : ''}" data-screener-dir="1">Asc</button>
          </div>
          <div class="screener-summary-strip">
            ${topGravity.map(c => `<span class="screener-chip">${c.sym} ${c.meta?.classification ? '· ' + c.meta.classification : ''}</span>`).join('')}
          </div>
        </div>
      </div>

      <div class="section-header"><span class="section-title">All Monitored Markets</span><span style="font-size:11px;color:var(--color-text-muted)">Sorted by ${screenerSortBy === 'alpha' ? 'alphabetical order' : screenerSortBy === 'marketCap' ? 'market cap' : screenerSortBy === 'atomicWeight' ? 'atomic weight' : screenerSortBy === 'volume' ? 'daily volume' : '24h change'}</span></div>
      <div class="screener-grid">
        ${coins.map(c => screenerCard(c, c.change > 0 ? 'bullish' : 'bearish')).join('')}
      </div>
    `;

    const sortSelect = document.getElementById('screenerSortSelect');
    if (sortSelect) sortSelect.addEventListener('change', e => {
      screenerSortBy = e.target.value;
      renderScreener();
    });
    content.querySelectorAll('[data-screener-dir]').forEach(btn => {
      btn.addEventListener('click', () => {
        screenerSortDir = Number(btn.dataset.screenerDir);
        renderScreener();
      });
    });

    // Draw sparklines in screener cards
    requestAnimationFrame(() => {
      coins.forEach(c => {
        const canvas = document.getElementById(`sc-spark-${c.sym}`);
        if (!canvas) return;
        const data = sparkData[c.sym];
        if (!data || data.length < 2) return;
        const ctx = canvas.getContext('2d');
        const isUp = c.change >= 0;
        const color = isUp ? '#26d47e' : '#ff4b6e';
        const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        ctx.beginPath();
        data.forEach((v, i) => {
          const x = (i / (data.length - 1)) * W;
          const y = H - ((v - min) / range) * H;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    });

    // Click screener cards → navigate to charts
    content.querySelectorAll('[data-sc-chart]').forEach(card => {
      card.addEventListener('click', () => {
        chartCoin = card.dataset.scChart;
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('[data-view="charts"]').classList.add('active');
        currentView = 'charts';
        if (pageTitle) pageTitle.textContent = 'Market Structure';
        render();
      });
    });
  }

  function screenerCard(c, sentiment) {
    const inPortfolio = PORTFOLIO_HOLDINGS.some(h => h.sym === c.sym);
    const signalLabel = c.change > 5 ? 'UP' : c.change > 1 ? 'Lean UP' : c.change < -5 ? 'DOWN' : c.change < -1 ? 'Lean DOWN' : 'No Bet';
    const logo = c.meta?.image;
    return `
      <div class="screener-card ${sentiment}" data-sc-chart="${c.instrument}" style="cursor:pointer">
        <div class="sc-header-row">
          <div class="sc-token-wrap">
            <div class="sc-token-icon" style="background:${coinColor(c.sym)}22;color:${coinColor(c.sym)}">${coinIcon(c.sym)}</div>
            <div>
              <div class="sc-ticker" style="color:${coinColor(c.sym)}">${c.sym}</div>
              <div class="sc-name">${c.name}</div>
            </div>
          </div>
          ${inPortfolio ? '<span style="font-size:9px;color:var(--color-gold);font-weight:700">MODELED ●</span>' : ''}
        </div>
        <div class="sc-price">${c.price ? fmtPrice(c.price) : '—'}</div>
        <div class="sc-chg ${posneg(c.change)}">${c.ticker ? fmtPct(c.change) : '—'}</div>
        <div class="sc-meta-grid">
          <div class="sc-vol">MCap: ${fmtCompactUsd(c.meta?.marketCap)}</div>
          <div class="sc-vol">Atomic: ${fmtCompactUsd(c.meta?.atomicWeight || c.meta?.marketCap)}</div>
          <div class="sc-vol">TVL: ${fmtCompactUsd(c.meta?.tvlUsd)}</div>
          <div class="sc-vol">Vol: ${fmtCompactUsd(c.meta?.totalVolume || c.vol)}</div>
          <div class="sc-vol">Rank: ${c.meta?.rank || '—'}</div>
          <div class="sc-vol">Orbital: ${c.meta?.classification || c.meta?.orbitalFocus || '—'}</div>
        </div>
        <div class="signal-badge ${sentiment}">
          <span>${signalLabel}</span>
        </div>
        <div class="sc-sparkwrap">
          <canvas id="sc-spark-${c.sym}" width="200" height="40"></canvas>
        </div>
      </div>
    `;
  }

  // ================================================================
  // VIEW: CFM BENCHMARK
  // ================================================================

  let cfmStarted = false;
  let _cfmStarting = false;
  let _cfmRenderSeq = 0;
  let _cfmLastUserScrollTs = 0;
  let _cfmDeferredRefreshTimer = null;
  let _cfmRenderThrottleTimer = null;
  let _cfmLastRenderTs = 0;
  let _cfmScrollTrackerBound = false;
  const CFM_SCROLL_IDLE_MS = 900;
  const CFM_MIN_RENDER_GAP_MS = 1200;

  function ensureCFMScrollTracker() {
    if (_cfmScrollTrackerBound || !content) return;
    content.addEventListener('scroll', () => {
      if (currentView === 'cfm') _cfmLastUserScrollTs = Date.now();
    }, { passive: true });
    _cfmScrollTrackerBound = true;
  }

  function requestCFMRender(force = false) {
    if (currentView !== 'cfm') return;
    const sinceLast = Date.now() - _cfmLastRenderTs;
    if (!force && sinceLast < CFM_MIN_RENDER_GAP_MS) {
      if (!_cfmRenderThrottleTimer) {
        _cfmRenderThrottleTimer = setTimeout(() => {
          _cfmRenderThrottleTimer = null;
          if (currentView === 'cfm') requestCFMRender(true);
        }, Math.max(120, CFM_MIN_RENDER_GAP_MS - sinceLast));
      }
      return;
    }
    if (_cfmRenderThrottleTimer) {
      clearTimeout(_cfmRenderThrottleTimer);
      _cfmRenderThrottleTimer = null;
    }
    _cfmLastRenderTs = Date.now();
    renderCFM();
  }

  // ================================================================
  // SUBORBITAL PERIODIC TABLE — Element Definitions
  //
  // Like actual chemistry: heavier coins fill more electron shells.
  //   BTC/ETH = heavy elements (atomic mass ~80) → all 7 shells, 22 orbitals
  //   SOL/XRP/BNB = mid-weight (~40) → 5 shells, 18 orbitals
  //   DOGE/HYPE = light elements (~20) → 3 shells, 12 orbitals
  //
  // Shells:
  //   1s = Price Benchmarks (core — every element has these)
  //   2s = Momentum Oscillators
  //   2p = Trend Signals
  //   3s = Volume & Flow
  //   3p = Order Book Microstructure   (mid+heavy only)
  //   3d = Cross-Exchange Arbitrage    (mid+heavy only)
  //   4f = Deep Microstructure         (heavy only)
  // ================================================================

  const SUBORBITALS = [
    // ---- Shell 1s: Price Benchmarks (ALL coins) ----
    { num: 1, sym: 'CFM', name: 'CFM Rate', shell: '1s', key: 'cfmRate', fmt: 'price', desc: 'VWM partition average (CF Benchmarks method)', weight: 'all' },
    { num: 2, sym: 'VWP', name: 'VWAP-15', shell: '1s', key: 'vwap15', fmt: 'price', desc: 'Volume-weighted average price (15min)', weight: 'all' },
    { num: 3, sym: 'TWP', name: 'TWAP-15', shell: '1s', key: 'twap15', fmt: 'price', desc: 'Time-weighted average price (15min)', weight: 'all' },
    { num: 4, sym: 'SPT', name: 'Spot', shell: '1s', key: 'lastPrice', fmt: 'price', desc: 'Latest spot price across sources', weight: 'all' },

    // ---- Shell 2s: Momentum Oscillators (ALL coins) ----
    { num: 5, sym: 'RSI', name: 'RSI(14)', shell: '2s', key: '_rsi', fmt: 'num1', desc: 'Relative Strength Index — overbought/oversold', weight: 'all' },
    { num: 6, sym: 'MOM', name: 'Momentum', shell: '2s', key: 'momentum', fmt: 'pct3', desc: 'Rate of change over 5 polling cycles', weight: 'all' },
    { num: 7, sym: 'MCD', name: 'MACD', shell: '2s', key: '_macd', fmt: 'sign4', desc: 'VWAP-TWAP divergence (MACD proxy)', weight: 'all' },

    // ---- Shell 2p: Trend Signals (ALL coins) ----
    { num: 8, sym: 'EMA', name: 'EMA 9/21', shell: '2p', key: '_emaCross', fmt: 'pct3', desc: 'Fast/slow EMA crossover spread', weight: 'all' },
    { num: 9, sym: 'TRD', name: 'Trend', shell: '2p', key: 'trend', fmt: 'trend', desc: '15-min window direction', weight: 'all' },

    // ---- Shell 3s: Volume & Flow (ALL coins) ----
    { num: 10, sym: 'OBV', name: 'OBV Slope', shell: '3s', key: '_obvSlope', fmt: 'sign2', desc: 'On-Balance Volume — accumulation/distribution', weight: 'all' },
    { num: 11, sym: 'VDL', name: 'Vol Delta', shell: '3s', key: '_volRatio', fmt: 'ratio', desc: 'Buy vs sell volume ratio', weight: 'all' },
    { num: 12, sym: 'ATR', name: 'Volatility', shell: '3s', key: '_atrPct', fmt: 'pct2', desc: 'ATR as percentage of price', weight: 'all' },

    // ---- Shell 3p: Order Book Micro (MID + HEAVY only) ----
    { num: 13, sym: 'BAS', name: 'Bid-Ask', shell: '3p', key: 'bidAsk', fmt: 'pct4', desc: 'Bid-ask spread — market tightness', weight: 'mid' },
    { num: 14, sym: 'BKI', name: 'Book Imbal', shell: '3p', key: '_bookImbal', fmt: 'sign2', desc: 'Order book bid/ask weight imbalance', weight: 'mid' },
    { num: 15, sym: 'AGR', name: 'Aggressor', shell: '3p', key: '_aggrBuy', fmt: 'pct1', desc: 'Buy-side aggressor ratio from trade tape', weight: 'mid' },

    // ---- Shell 3d: Cross-Exchange Arbitrage (MID + HEAVY only) ----
    { num: 16, sym: 'XSP', name: 'X-Spread', shell: '3d', key: 'spread', fmt: 'pct3', desc: 'Cross-exchange price divergence', weight: 'mid' },
    { num: 17, sym: 'CVG', name: 'Convergence', shell: '3d', key: 'convergence', fmt: 'pct3', desc: 'How tightly sources agree (lower=better)', weight: 'mid' },
    { num: 18, sym: 'SRC', name: 'Sources', shell: '3d', key: 'sourceCount', fmt: 'of4', desc: 'Number of active constituent exchanges', weight: 'mid' },

    // ---- Shell 3d+: Derivatives (MID + HEAVY) ----
    { num: 19, sym: 'FND', name: 'Funding Rate', shell: '3d', key: '_funding', fmt: 'fundingRate', desc: 'Perp futures funding rate — +longs pay, -shorts pay', weight: 'mid' },
    { num: 20, sym: 'OI', name: 'Open Interest', shell: '3d', key: '_oi', fmt: 'compactUsd', desc: 'Total open interest in futures markets', weight: 'mid' },
    { num: 21, sym: 'SQZ', name: 'Squeeze Risk', shell: '3d', key: '_squeezeScore', fmt: 'squeeze', desc: 'Liquidation cascade / squeeze probability', weight: 'mid' },

    // ---- Shell 4s: CVD + Coinbase Premium (HEAVY only) ----
    { num: 22, sym: 'CVD', name: 'Cum Vol Delta', shell: '4s', key: '_cvdSlope', fmt: 'sign2', desc: 'CVD slope — buyer/seller exhaustion detector', weight: 'heavy' },
    { num: 23, sym: 'CBP', name: 'CB Premium', shell: '4s', key: '_cbPremium', fmt: 'pct3', desc: 'Coinbase price vs CFM rate — institutional flow proxy', weight: 'heavy' },
    { num: 24, sym: 'CBS', name: 'CB Spread', shell: '4s', key: 'cbSpread', fmt: 'pct4', desc: 'Coinbase buy-sell spread', weight: 'heavy' },

    // ---- Shell 4f: Deep Microstructure (HEAVY only) ----
    { num: 25, sym: 'DXV', name: 'DEX Vol', shell: '4f', key: '_dexVol', fmt: 'compactUsd', desc: 'On-chain DEX 24h volume', weight: 'heavy' },
    { num: 26, sym: 'DXL', name: 'DEX Liq', shell: '4f', key: '_dexLiq', fmt: 'compactUsd', desc: 'On-chain DEX liquidity depth', weight: 'heavy' },
  ];

  async function renderCFM() {
    ensureCFMScrollTracker();
    const _myRV = _rv; // capture version — bail after any await if stale
    const _myCFMSeq = ++_cfmRenderSeq; // invalidate older in-flight CFM async hydration
    const isStaleCFMRender = () => _rv !== _myRV || _myCFMSeq !== _cfmRenderSeq || currentView !== 'cfm';
    const scrollTopSnapshot = content?.scrollTop || 0;
    let latestScrollTop = scrollTopSnapshot;
    let userScrolledDuringRender = false;
    const onCFMScroll = () => {
      if (!content) return;
      userScrolledDuringRender = true;
      latestScrollTop = content.scrollTop;
    };
    content?.addEventListener('scroll', onCFMScroll, { passive: true });
    const cleanupCFMScrollListener = () => {
      try { content?.removeEventListener('scroll', onCFMScroll); } catch (_) { }
    };

    // Start engine in background if not started — DON'T await it blocking the render
    if (!cfmStarted && !_cfmStarting) {
      _cfmStarting = true;
      CFMEngine.start()
        .then(() => { cfmStarted = true; _cfmStarting = false; if (currentView === 'cfm') requestCFMRender(true); })
        .catch(e => { _cfmStarting = false; console.error('[CFM] engine start failed:', e); if (currentView === 'cfm') requestCFMRender(true); });
      // Also kick off predictions in background
      if (!predsLoaded) {
        startPredictionRun()
          .then(() => { predsLoaded = true; _lastPredictionRunTs = Date.now(); snapshotPredictions(); })
          .catch(() => { });
      }
    }
    // Start 15M market resolver
    if (window.MarketResolver && !window._resolverStarted) {
      window.MarketResolver.start();
      window._resolverStarted = true;
    }

    // Render immediately with whatever data we have (may be empty on first call)
    const cfmAll = CFMEngine.getAll();
    const predAll = PredictionEngine.getAll ? PredictionEngine.getAll() : {};
    const status = CFMEngine.getStatus ? CFMEngine.getStatus() : {};

    // Add a loading banner at the top if still loading
    const loadingBanner = (!cfmStarted)
      ? `<div style="display:flex;align-items:center;gap:10px;padding:8px 16px;background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.3);border-radius:6px;margin-bottom:12px;font-size:13px;color:#ffc107"><div style="width:16px;height:16px;border:2px solid rgba(255,193,7,0.3);border-top-color:#ffc107;border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0"></div><span>Assembling CFM benchmarks\u2026</span></div>`
      : '';

    if (isStaleCFMRender()) {
      cleanupCFMScrollListener();
      return; // guard: stale render version or superseded CFM render
    }

    const orchBarHTML = `
      <div class="cfm-orch-bar" id="cfm-orch-bar">
        <div class="cfm-orch-item"><span class="cfm-orch-dot ${status.running ? 'ok' : 'off'}"></span><span>${status.running ? 'Live' : 'Off'}</span></div>
        <div class="cfm-orch-item">Cycle <span class="cfm-orch-val">#${status.cycle ?? '—'}</span></div>
        <div class="cfm-orch-item">\u0394 <span class="cfm-orch-val">${status.lastMs != null ? status.lastMs + 'ms' : '—'}</span></div>
        <div class="cfm-orch-item">Poll <span class="cfm-orch-val">15s</span></div>
        <div style="margin-left:auto;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${Object.entries(status.sources || {}).map(([k, v]) => `
            <div class="cfm-orch-item" style="border-left:2px solid ${v.color};padding-left:6px">
              <span class="cfm-orch-dot ${v.pct > 80 ? 'warn' : 'ok'}"></span>
              <span>${v.label}</span>
              <span class="cfm-orch-val">${v.used}/${v.budget}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    const existingRoot = content.querySelector('.cfm-view-root');
    if (!existingRoot) {
      content.innerHTML = `
        <div class="cfm-view-root">
        ${loadingBanner}
        <div class="engine-hero">
          <div>
            <div class="engine-eyebrow">CFM Benchmark Orchestrator</div>
            <h2 class="engine-title">Constituent-driven benchmarks for short-horizon UP/DOWN calls</h2>
            <p class="engine-copy">This surface consolidates spot, venue premium, and on-chain liquidity into a defensible benchmark, then layers microstructure and derivatives context on top so each market can be staged as UP, DOWN, or NO BET.</p>
          </div>
          <div class="engine-meta-grid">
            <div class="engine-meta-card"><span>Targets</span><strong>${PREDICTION_COINS.length}</strong><small>benchmark markets</small></div>
            <div class="engine-meta-card"><span>Constituents</span><strong>4</strong><small>CDC · CB · GKO · DEX</small></div>
            <div class="engine-meta-card"><span>Cadence</span><strong>15s</strong><small>rolling 15m partitions</small></div>
            <div class="engine-meta-card"><span>Decision Horizon</span><strong>1-15m</strong><small>predictive UP/DOWN ladder</small></div>
          </div>
        </div>

        <!-- Orchestrator Status Bar -->
        ${orchBarHTML}

        <!-- Shell Legend + Weight Classes -->
        <div style="display:flex;gap:10px;margin-bottom:10px;font-size:10px;color:var(--color-text-muted);flex-wrap:wrap;align-items:center">
          <span style="font-weight:600;color:var(--color-text)">Shells:</span>
          <span><span class="cfm-shell s" style="position:static">1s</span> Price</span>
          <span><span class="cfm-shell s" style="position:static">2s</span> Momentum</span>
          <span><span class="cfm-shell p" style="position:static">2p</span> Trend</span>
          <span><span class="cfm-shell s" style="position:static">3s</span> Volume</span>
          <span><span class="cfm-shell p" style="position:static">3p</span> Book</span>
          <span><span class="cfm-shell d" style="position:static">3d</span> Arb</span>
          <span><span class="cfm-shell s" style="position:static">4s</span> CB Prem</span>
          <span><span class="cfm-shell f" style="position:static">4f</span> DEX Deep</span>
          <span style="border-left:1px solid var(--color-border);padding-left:8px;margin-left:4px">
            <span style="color:var(--color-gold)">\u25cf</span> Heavy (22)
            <span style="color:var(--color-primary)">\u25cf</span> Mid (18)
            <span style="color:var(--color-text-faint)">\u25cf</span> Light (12)
          </span>
          <span style="margin-left:auto;font-size:9px"><span style="color:#1a6eff">\u25cf</span> CDC <span style="color:#0052ff">\u25cf</span> CB <span style="color:#8dc63f">\u25cf</span> GKO <span style="color:#a259ff">\u25cf</span> DEX</span>
        </div>

        <!-- Opportunities Panel placeholder — filled async below -->
        <div id="cfm-opp-slot"></div>

        <!-- Per-coin periodic table placeholders — filled async below -->
        ${PREDICTION_COINS.map(coin => `<div id="cfm-coin-slot-${coin.sym}" class="cfm-coin-skeleton"><div class="cfm-coin-skel-bar" style="border-left:3px solid ${coin.color}"><span style="color:${coin.color};font-weight:700;font-size:13px">${coin.sym}</span><span style="color:var(--color-text-muted);font-size:11px;margin-left:8px">loading orbital data…</span><div style="width:18px;height:18px;border:2px solid rgba(255,255,255,0.15);border-top-color:${coin.color};border-radius:50%;animation:spin 0.8s linear infinite;margin-left:auto"></div></div></div>`).join('')}

        <!-- Methodology -->
        <div class="card" style="margin-top:8px" id="cfm-methodology">
          <div class="card-title">CFM Methodology</div>
          <div style="font-size:11px;color:var(--color-text-muted);line-height:1.5">
            Each coin's periodic table maps the benchmark, microstructure, and conviction layers used to issue short-horizon UP/DOWN calls.
            <strong>1s</strong> establishes the benchmark via <a href="https://docs.cfbenchmarks.com" target="_blank" style="color:var(--color-primary)">CF Benchmarks style VWM partitions</a>.
            <strong>2s / 2p</strong> score momentum and trend alignment.
            <strong>3s / 3p / 3d</strong> capture flow, book pressure, and cross-venue dispersion.
            <strong>4s / 4f</strong> add institutional premium, derivatives crowding, and DEX depth.
            The result is a benchmark-backed decision surface for UP, DOWN, or stand-aside execution.
          </div>
        </div>
        </div>
      `;
    } else {
      const existingOrchBar = document.getElementById('cfm-orch-bar');
      if (existingOrchBar) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = orchBarHTML;
        existingOrchBar.innerHTML = tempDiv.firstElementChild.innerHTML;
        existingOrchBar.className = tempDiv.firstElementChild.className;
      }
    }

    // ── Progressive async fill — opportunities panel then coins one-by-one ──
    // Yields to the browser between each heavy build so the page is responsive immediately.
    (async () => {
      try {
        // 1. Opportunities panel (medium weight)
        await new Promise(r => setTimeout(r, 0));
        if (isStaleCFMRender()) return;
        const oppSlot = document.getElementById('cfm-opp-slot');
        if (oppSlot) {
          try { oppSlot.innerHTML = buildOpportunitiesPanel(cfmAll, predAll) || ''; }
          catch (e) { console.warn('[CFM] opp panel error:', e); }
        }

        // 2. Each coin table (heavy — up to 22 suborbitals each)
        for (const coin of PREDICTION_COINS) {
          await new Promise(r => setTimeout(r, 0));
          if (isStaleCFMRender()) return;
          const cfm = cfmAll[coin.sym];
          const pred = predAll[coin.sym];
          const slot = document.getElementById(`cfm-coin-slot-${coin.sym}`);
          if (!slot) continue;
          if (!cfm || cfm.cfmRate === 0) { slot.style.display = 'none'; continue; }
          try {
            const h = slot.offsetHeight;
            if (h > 0) slot.style.minHeight = h + 'px'; // prevent collapse during replace
            const temp = document.createElement('div');
            temp.innerHTML = buildCoinPeriodicTable(coin, cfm, pred);
            const newEl = temp.firstElementChild;
            if (newEl) {
               slot.innerHTML = newEl.innerHTML;
               slot.className = newEl.className;
               slot.style.minHeight = '';
               slot.style.display = '';
            }
          } catch (e) {
            console.warn(`[CFM] coin table error ${coin.sym}:`, e);
            slot.style.display = 'none';
          }
        }

        // 3. Re-attach toggle listeners after all coins are in DOM
        if (isStaleCFMRender()) return;
        content.querySelectorAll('[data-cfm-toggle]').forEach(btn => {
          btn.addEventListener('click', () => {
            const sym = btn.dataset.cfmToggle;
            const block = btn.closest('[data-cfm-sym]');
            if (!block) return;
            const panel = block.querySelector('.cfm-expand-panel');
            const icon = block.querySelector('.cfm-expand-icon');
            const isOpen = panel?.classList.toggle('open');
            block.classList.toggle('expanded', isOpen);
            if (icon) icon.textContent = isOpen ? '\u2212' : '+';
            if (isOpen) cfmExpanded.add(sym); else cfmExpanded.delete(sym);
          });
        });

        // Preserve user position if they scrolled while async hydration was still filling slots.
        if (currentView === 'cfm' && content) {
          content.scrollTop = userScrolledDuringRender ? latestScrollTop : scrollTopSnapshot;
        }
      } finally {
        cleanupCFMScrollListener();
      }
      // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();
  }

  // ================================================================
  // NARRATIVE CALLOUTS — plain-English flagging of opportunities
  // ================================================================

  function buildNarrativeCallouts(verdicts, allSignals, cfmAll, predAll) {
    const alerts = []; // { type: 'opp'|'warn'|'info', icon, title, body, coin, color }

    PREDICTION_COINS.forEach(coin => {
      const pred = predAll[coin.sym];
      const cfm = cfmAll[coin.sym];
      if (!pred || !cfm || cfm.cfmRate === 0) return;

      const sym = coin.sym;
      const price = cfm.cfmRate;
      const deriv = pred.derivatives;
      const squeeze = pred.squeeze;
      const cvd = pred.cvd;
      const ind = pred.indicators || {};
      const rsi = ind.rsi?.value ?? 50;
      const mom = cfm.momentum || 0;
      const trend = cfm.trend;
      const volRatio = ind.volume?.ratio ?? 1;
      const obvSlope = ind.obv?.slope ?? 0;
      const emaCross = ind.ema?.value ?? 0;
      const verdict = verdicts.find(v => v.sym === sym);
      const confirming = verdict?.edge?.signalCount ?? 0;
      const funding = deriv?.funding ?? 0;
      const predDir = predictionDirection(pred, 0);
      const predDirLabel = predDir > 0 ? 'UP' : predDir < 0 ? 'DOWN' : 'NEUTRAL';
      const agreement = pred.diagnostics?.agreement ?? 0;
      const conflict = pred.diagnostics?.conflict ?? 0;
      const reliability = pred.diagnostics?.reliability ?? pred.backtest?.summary?.reliability ?? 0;
      const bullishSignals = pred.diagnostics?.bullishSignals ?? 0;
      const bearishSignals = pred.diagnostics?.bearishSignals ?? 0;

      // --- Squeeze alerts ---
      if (squeeze) {
        const dir = squeeze.type === 'short_squeeze' ? 'UP' : 'DOWN';
        const alignsWithPrediction = (dir === 'UP' && predDir > 0) || (dir === 'DOWN' && predDir < 0);
        const urgency = alignsWithPrediction && reliability >= 0.45 && conflict <= 0.4
          ? (squeeze.severity === 'high' ? 'opp' : 'warn')
          : 'info';
        alerts.push({
          type: urgency, coin: sym, color: coin.color,
          icon: squeeze.severity === 'high' ? '\u26a1' : '\u26a0',
          title: `${sym} ${squeeze.type === 'short_squeeze' ? 'Short Squeeze' : 'Long Squeeze'} Risk`,
          body: `Funding at ${funding.toFixed(3)}%. ${squeeze.desc} Prediction bias: ${predDirLabel}.${alignsWithPrediction && confirming >= 3 ? ' ' + confirming + ' indicators confirm.' : alignsWithPrediction ? '' : ' Treat as positioning context until price confirms.'}`,
        });
      }

      // --- RSI extremes ---
      if (rsi >= 75) {
        const aligned = predDir < 0 && reliability >= 0.45 && conflict <= 0.45;
        alerts.push({
          type: aligned ? 'warn' : 'info', coin: sym, color: coin.color, icon: '\ud83d\udcc9',
          title: `${sym} Overbought — RSI ${rsi.toFixed(0)}`,
          body: aligned
            ? `RSI above 75 signals buyer exhaustion. ${trend === 'rising' ? 'Trend still rising but reversal risk is elevated.' : 'Already weakening.'} Prediction bias stays DOWN — tighten stops.`
            : `RSI is stretched but the broader model is not cleanly bearish yet. Treat this as exhaustion context, not a standalone short trigger.`,
        });
      } else if (rsi <= 25) {
        const aligned = predDir > 0 && reliability >= 0.45 && conflict <= 0.45;
        alerts.push({
          type: aligned ? 'opp' : 'info', coin: sym, color: coin.color, icon: '\ud83d\udcc8',
          title: `${sym} Oversold — RSI ${rsi.toFixed(0)}`,
          body: aligned
            ? `RSI below 25 signals seller exhaustion. ${trend === 'falling' ? 'Trend is still down, but the bounce setup is supported by the broader model.' : 'Price is already stabilizing.'} Expect UP — bounce opportunity.`
            : `RSI is deeply oversold, but momentum/flow are still leaning against a clean reversal. Watch for confirmation before treating this as an UP call.`,
        });
      }

      // --- CVD divergence (the cue you missed on BTC) ---
      if (cvd && Math.abs(cvd.slope) > 20) {
        const cvdDir = cvd.slope > 0 ? 'rising' : 'falling';
        const priceDir = mom > 0 ? 'up' : mom < 0 ? 'down' : 'flat';
        if ((cvd.slope > 0 && mom < -0.05) || (cvd.slope < 0 && mom > 0.05)) {
          alerts.push({
            type: 'opp', coin: sym, color: coin.color, icon: '\ud83d\udd04',
            title: `${sym} CVD Divergence Detected`,
            body: `Price moving ${priceDir} but CVD ${cvdDir} — order flow disagrees with price action. ${cvd.slope > 0 ? 'Buyers still aggressive despite price drop → reversal up likely.' : 'Sellers still aggressive despite price rise → exhaustion incoming, take profit.'} This is an exit/entry timing signal.`,
          });
        }
      }

      // --- Multi-signal confluence (HIGH CONVICTION) ---
      if (confirming >= 4 && predDir !== 0 && agreement >= 0.72 && conflict <= 0.28) {
        alerts.push({
          type: 'opp', coin: sym, color: coin.color, icon: '\ud83c\udfaf',
          title: `${sym} High Confluence — ${confirming} Signals Aligned ${predDirLabel}`,
          body: `${bullishSignals} bullish vs ${bearishSignals} bearish components, agreement ${(agreement * 100).toFixed(0)}%, conflict ${(conflict * 100).toFixed(0)}%. EMA ${emaCross > 0 ? 'bull' : 'bear'} cross, OBV ${obvSlope > 0 ? 'accumulation' : 'distribution'}, Vol Delta ${volRatio.toFixed(2)}x, Trend ${trend}${deriv ? ', Funding ' + funding.toFixed(3) + '%' : ''}. ${reliability >= 0.55 ? 'Backtest quality supports this cluster.' : 'Live cluster is strong, but backtest quality is mixed.'}`,
        });
      }

      // --- Volume anomaly ---
      if (volRatio > 1.5) {
        alerts.push({
          type: 'info', coin: sym, color: coin.color, icon: '\ud83d\udcca',
          title: `${sym} Elevated Buy Volume — ${volRatio.toFixed(2)}x ratio`,
          body: `Buy-side volume significantly exceeds sell-side. ${obvSlope > 10 ? 'OBV confirms accumulation.' : 'But OBV not yet confirming — could be a trap.'} Watch for follow-through.`,
        });
      } else if (volRatio < 0.65) {
        alerts.push({
          type: 'warn', coin: sym, color: coin.color, icon: '\ud83d\udcca',
          title: `${sym} Heavy Sell Pressure — ${volRatio.toFixed(2)}x ratio`,
          body: `Sell-side dominating order flow. ${obvSlope < -10 ? 'OBV confirms distribution — expect DOWN.' : 'Volume dropping though, may not sustain.'}`,
        });
      }

      // --- Extreme funding (not squeeze level, but notable) ---
      if (Math.abs(funding) > 0.1 && !squeeze) {
        const side = funding > 0 ? 'longs' : 'shorts';
        alerts.push({
          type: 'info', coin: sym, color: coin.color, icon: '\ud83d\udcb0',
          title: `${sym} Funding Imbalance — ${side} paying ${Math.abs(funding).toFixed(3)}%`,
          body: `${side === 'longs' ? 'Bullish crowding' : 'Bearish crowding'} in perpetual futures. Not at squeeze level yet but positioning is skewed. Contrarian edge building.`,
        });
      }

      // --- Cross-exchange arb opportunity ---
      if (cfm.spread > 0.3) {
        const spreadType = cfm.spread > 5 ? 'warn' : 'info';
        alerts.push({
          type: spreadType, coin: sym, color: coin.color, icon: '\ud83d\udd00',
          title: `${sym} Cross-Exchange Spread ${cfm.spread.toFixed(2)}%`,
          body: spreadType === 'warn'
            ? `Venue disagreement is unusually large, so this is more likely a source mismatch or illiquid venue than a clean arb. Sources: ${Object.keys(cfm.sources || {}).join(', ')}${cfm.dexMeta?.pair ? ` · DEX ${cfm.dexMeta.pair}` : ''}.`
            : `Price diverging across sources. ${cfm.spread > 1 ? 'Significant arb window open.' : 'Mild divergence, watching for convergence trade.'} Sources: ${Object.keys(cfm.sources || {}).join(', ')}.`,
        });
      }
    });

    // --- Market-wide context ---
    const allFunding = PREDICTION_COINS.map(c => predAll[c.sym]?.derivatives?.funding ?? 0).filter(f => f !== 0);
    if (allFunding.length > 0) {
      const avgFunding = allFunding.reduce((a, b) => a + b, 0) / allFunding.length;
      const negCount = allFunding.filter(f => f < -0.1).length;
      const posCount = allFunding.filter(f => f > 0.1).length;
      if (negCount >= 3) {
        alerts.unshift({
          type: 'opp', coin: 'MKT', color: 'var(--color-primary)', icon: '\ud83c\udf0a',
          title: `Market-Wide Short Crowding — ${negCount}/${allFunding.length} coins negative funding`,
          body: `Multiple coins showing negative funding rates simultaneously. This often precedes a broad short squeeze / relief rally. Avg funding: ${fmtSignedPct(avgFunding, 3)}.`,
        });
      } else if (posCount >= 3) {
        alerts.unshift({
          type: 'warn', coin: 'MKT', color: 'var(--color-primary)', icon: '\ud83c\udf0a',
          title: `Market-Wide Long Crowding — ${posCount}/${allFunding.length} coins positive funding`,
          body: `Majority of coins showing positive funding. Leveraged longs are overcrowded. Correction risk elevated. Avg funding: ${fmtSignedPct(avgFunding, 3)}.`,
        });
      }
    }

    if (alerts.length === 0) {
      return `
        <div class="opp-panel" style="border-left:3px solid var(--color-text-faint)">
          <div class="card-title" style="color:var(--color-text-muted)">\ud83d\udce1 Market Read</div>
          <div style="font-size:12px;color:var(--color-text-muted);padding:8px 0;line-height:1.6">
            No strong signals firing. Market is in a neutral / range-bound state across all 7 tokens. The orchestrator is watching every 15 seconds and will flag the moment conviction builds on any coin. Sit tight.
          </div>
        </div>
      `;
    }

    // Sort: opp first, then warn, then info
    const typeOrder = { opp: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

    const oppCount = alerts.filter(a => a.type === 'opp').length;
    const warnCount = alerts.filter(a => a.type === 'warn').length;
    const infoCount = alerts.filter(a => a.type === 'info').length;

    return `
      <div class="opp-panel" style="border-left:3px solid ${oppCount > 0 ? 'var(--color-green)' : warnCount > 0 ? 'var(--color-orange)' : 'var(--color-primary)'}">
        <div class="card-title" style="color:var(--color-text)">
          \ud83d\udce1 Live Market Read \u2014 ${alerts.length} flags
          <span style="margin-left:auto;font-size:10px;font-weight:400;color:var(--color-text-muted)">
            ${oppCount > 0 ? '<span style="color:var(--color-green)">' + oppCount + ' opportunity</span> ' : ''}
            ${warnCount > 0 ? '<span style="color:var(--color-orange)">' + warnCount + ' warning</span> ' : ''}
            ${infoCount > 0 ? '<span style="color:var(--color-primary)">' + infoCount + ' info</span>' : ''}
          </span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
          ${alerts.map(a => {
      const bgColor = a.type === 'opp' ? 'var(--color-green-dim)' : a.type === 'warn' ? 'var(--color-orange-dim)' : 'var(--color-surface-2)';
      const borderColor = a.type === 'opp' ? 'var(--color-green)' : a.type === 'warn' ? 'var(--color-orange)' : 'var(--color-primary)';
      const typeLabel = a.type === 'opp' ? 'OPPORTUNITY' : a.type === 'warn' ? 'WARNING' : 'INTEL';
      const typeBadgeColor = a.type === 'opp' ? 'var(--color-green)' : a.type === 'warn' ? 'var(--color-orange)' : 'var(--color-primary)';
      return `
              <div style="padding:10px 14px;background:${bgColor};border-left:3px solid ${borderColor};border-radius:var(--radius-md)">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <span style="font-size:15px">${a.icon}</span>
                  <span style="font-size:13px;font-weight:700;color:${a.color}">${a.coin}</span>
                  <span style="font-size:12px;font-weight:700;color:var(--color-text)">${a.title}</span>
                  <span style="margin-left:auto;font-size:8px;padding:2px 6px;border-radius:9999px;background:${typeBadgeColor}22;color:${typeBadgeColor};font-weight:700;letter-spacing:0.06em">${typeLabel}</span>
                </div>
                <div style="font-size:11px;color:var(--color-text-muted);line-height:1.5">${a.body}</div>
              </div>
            `;
    }).join('')}
        </div>
      </div>
    `;
  }

  // ---- Volatility edge calculator: is the underlying moving enough for a confident binary? ----
  const FEE_PCT = 0;

  function calcEdge(coin, cfm, pred) {
    const price = cfm.cfmRate || cfm.lastPrice || 0;
    if (price === 0) return null;

    const atrPct = pred?.volatility?.atrPct ?? 0;
    const momentum = Math.abs(cfm.momentum || 0);
    const bidAsk = cfm.bidAsk || 0;
    const xSpread = cfm.spread || 0;

    const expected15m = atrPct * Math.sqrt(3);
    const expected60m = atrPct * Math.sqrt(12);

    const totalCostPct = bidAsk + 0.02;

    const edge15 = expected15m - totalCostPct;
    const edge60 = expected60m - totalCostPct;

    const dollarEdgePer100_15 = (edge15 / 100) * 100;
    const dollarEdgePer100_60 = (edge60 / 100) * 100;

    const signalCount = countConfirmingSignals(coin, cfm, pred);

    const pm = window.PredictionMarkets?.getCoin?.(coin?.sym);
    const kalshiYesPrice = pm?.kalshi15m?.probability ?? null;
    const entryIsTailRisk = kalshiYesPrice !== null && kalshiYesPrice >= 0.85; 
    const entryIsLeveraged = kalshiYesPrice !== null && kalshiYesPrice <= 0.15; 
    const lossErasesWins = entryIsTailRisk
      ? Math.round(kalshiYesPrice / (1 - kalshiYesPrice))   
      : null;

    let tier, tierColor, tierDesc;

    if (entryIsTailRisk) {
      tier = 'TAIL RISK'; tierColor = 'var(--color-red)';
      tierDesc = `YES at ${Math.round(kalshiYesPrice * 100)}¢ — 1 loss erases ${lossErasesWins} wins. Need overwhelming edge to justify.`;
    } else if (entryIsLeveraged) {
      tier = edge15 > 0.25 && signalCount >= 3 ? 'HIGH CONVICTION' : 'LEVERAGED';
      tierColor = edge15 > 0.25 && signalCount >= 3 ? 'var(--color-green)' : 'var(--color-orange)';
      tierDesc = `YES at ${Math.round(kalshiYesPrice * 100)}¢ — ${Math.round(1 / kalshiYesPrice)}x payout but high variance. ${signalCount} signals, need wider gap.`;
    } else if (edge15 > 0.25 && signalCount >= 3) {
      tier = 'HIGH CONVICTION'; tierColor = 'var(--color-green)';
      tierDesc = `${signalCount} indicators aligned — strong directional move expected, ${edge15.toFixed(2)}% edge`;
    } else if (edge15 > 0.08 && signalCount >= 2) {
      tier = 'MARGINAL'; tierColor = 'var(--color-orange)';
      tierDesc = `Thin edge — ${edge15.toFixed(2)}% expected move, ${signalCount} signals. Widen gap or wait for confirmation.`;
    } else if (edge15 < 0) {
      tier = 'LOW VOLATILITY'; tierColor = 'var(--color-red)';
      tierDesc = `Expected move ${expected15m.toFixed(2)}% < spread ${totalCostPct.toFixed(2)}% — underlying too quiet for a clear binary direction`;
    } else {
      tier = 'WATCH'; tierColor = 'var(--color-text-faint)';
      tierDesc = `Edge ~0 — market flat, no directional conviction yet`;
    }

    if (tier === 'HIGH CONVICTION' && (pred?.backtest?.summary?.reliability ?? 1) < 0.55) {
      tier = 'MARGINAL'; tierColor = 'var(--color-orange)';
      tierDesc = `Signals align but backtest reliability ${Math.round((pred.backtest.summary.reliability || 0) * 100)}% < 55% gate \u2014 wait for confirmation`;
    }

    const dirBias = predictionDirection(pred, (cfm.momentum || 0) >= 0 ? 1 : -1);
    const dir = dirBias >= 0 ? 'up' : 'down';
    const entryPrice = dir === 'up'
      ? price * (1 - atrPct / 200) 
      : price * (1 + atrPct / 200); 
    const stopLoss = dir === 'up'
      ? price * (1 - atrPct * 1.5 / 100) 
      : price * (1 + atrPct * 1.5 / 100);
    const takeProfit = dir === 'up'
      ? price * (1 + atrPct * 2 / 100) 
      : price * (1 - atrPct * 2 / 100);
    const riskReward = atrPct > 0 ? 2.0 : 0; 

    return {
      price, atrPct, expected15m, expected60m, totalCostPct, edge15, edge60,
      dollarEdgePer100_15, dollarEdgePer100_60,
      tier, tierColor, tierDesc, signalCount,
      dir, entryPrice, stopLoss, takeProfit, riskReward,
    };
  }

  function countConfirmingSignals(coin, cfm, pred) {
    const ind = pred?.indicators || {};
    let count = 0;
    const dir = predictionDirection(pred, (cfm.momentum || 0) >= 0 ? 1 : -1);
    if (dir === 0) return 0;

    const rsi = ind.rsi?.value ?? 50;
    if (dir > 0 && rsi < 40) count++; 
    if (dir < 0 && rsi > 60) count++; 
    if (dir > 0 && (ind.ema?.value ?? 0) > 0.1) count++;
    if (dir < 0 && (ind.ema?.value ?? 0) < -0.1) count++;
    if (dir > 0 && (ind.obv?.slope ?? 0) > 5) count++;
    if (dir < 0 && (ind.obv?.slope ?? 0) < -5) count++;
    if (dir > 0 && (ind.volume?.ratio ?? 1) > 1.2) count++;
    if (dir < 0 && (ind.volume?.ratio ?? 1) < 0.8) count++;
    if (dir > 0 && cfm.trend === 'rising') count++;
    if (dir < 0 && cfm.trend === 'falling') count++;
    if (Math.abs(cfm.momentum || 0) > 0.1) count++;
    const bookImbal = (ind.book?.imbalance ?? 0);
    if (dir > 0 && bookImbal > 0.2) count++;
    if (dir < 0 && bookImbal < -0.2) count++;
    const funding = pred?.derivatives?.funding ?? 0;
    if (dir > 0 && funding < -0.1) count++; 
    if (dir < 0 && funding > 0.1) count++; 
    const cvdSlope = pred?.cvd?.slope ?? 0;
    if (dir > 0 && cvdSlope > 10) count++;
    if (dir < 0 && cvdSlope < -10) count++;
    if (pred?.squeeze) {
      if (dir > 0 && pred.squeeze.type === 'short_squeeze') count++;
      if (dir < 0 && pred.squeeze.type === 'long_squeeze') count++;
    }

    return count;
  }

  function buildFifteenMinuteMovePlan(ki) {
    if (!ki || ki.action === 'skip') return null;
    const secsLeft = Number.isFinite(ki.secsLeft)
      ? ki.secsLeft
      : (Number.isFinite(ki.closeTimeMs) ? Math.max(0, (ki.closeTimeMs - Date.now()) / 1000) : null);

    let phase = 'UNTIMED';
    if (secsLeft != null) {
      if (secsLeft > 720) phase = 'OPENING';
      else if (secsLeft > 420) phase = 'SETUP';
      else if (secsLeft > 180) phase = 'PRIME';
      else if (secsLeft > 60) phase = 'LATE';
      else if (secsLeft > 5) phase = 'LAST_CALL';
      else phase = 'SETTLING';
    }
    if (ki.timingRegime === 'SCALP_EARLY') phase = 'SCALP';
    else if (ki.timingRegime === 'CLOSE_VALUE') phase = 'CLOSE_VALUE';

    const isTrade = ki.action === 'trade';
    const isHold = ki.action === 'hold';
    const isExit = ki.action === 'earlyExit';
    const isCrowdFade = ki.alignment === 'CROWD_FADE' || !!ki.crowdFade;
    const edge = Number.isFinite(ki.edgeCents) ? ki.edgeCents : null;
    const side = ki.side || '—';

    let title = 'Watch';
    let detail = 'No clean trade setup yet.';
    let tone = 'var(--color-text-muted)';

    if (isExit) {
      title = 'Stand aside';
      detail = 'Shell/early-exit gate is active for this contract.';
      tone = 'var(--color-red)';
    } else if (isHold) {
      title = 'Hold';
      detail = 'Router is collecting confirmation before allowing entry.';
      tone = 'var(--color-orange)';
    } else if (ki.crowdFadeSuggested && !ki.crowdFade) {
      title = 'Stalk fade';
      detail = `Wait ${ki.crowdFadeConfirmLeftSec ?? '?'}s for ${ki.crowdFadeTimingLabel || 'adaptive'} mispricing confirmation before entering ${side}${ki.crowdFadeWindowLabel ? ` (${ki.crowdFadeWindowLabel})` : ''}.`;
      tone = '#ffb74d';
    } else if (phase === 'SCALP') {
      title = isTrade ? `Scalp ${side}` : 'Stalk scalp';
      detail = isTrade
        ? (ki.exitPlan || 'Buy the early flip and sell into the probability expansion before book pressure fades.')
        : `Book/tape scanner is watching for a clean flip${(ki.blockedBy?.length || ki.timingBlocks?.length) ? ': ' + (ki.blockedBy?.length ? ki.blockedBy.slice(0, 2) : ki.timingBlocks.slice(0, 2)).join(', ') : '.'}`;
      tone = isTrade ? 'var(--color-green)' : '#ffb74d';
    } else if (phase === 'OPENING') {
      title = isTrade ? `Prepare ${side}` : 'Observe open';
      detail = isTrade
        ? 'Let the first minute print; avoid instant fills at contract open.'
        : 'Collect tape and flow before committing capital.';
      tone = isTrade ? 'var(--color-text)' : 'var(--color-text-muted)';
    } else if (phase === 'SETUP') {
      title = isTrade ? `Set up ${side}` : 'Watch setup';
      detail = isTrade
        ? `Edge ${edge != null ? (edge >= 0 ? '+' : '') + edge + 'c' : '?'} — queue entry plan, prefer better price into 7m→3m.`
        : 'Model and market are still forming; wait for clearer spread.';
      tone = isTrade ? 'var(--color-green)' : 'var(--color-text-muted)';
    } else if (phase === 'PRIME') {
      title = isTrade ? `Execute ${side}` : 'Prime window';
      detail = isTrade
        ? (isCrowdFade
          ? `Confirmed ${ki.crowdFadeTimingLabel || 'adaptive'} mispricing fade${ki.crowdFadeWindowLabel ? ` (${ki.crowdFadeWindowLabel})` : ''}; execute with disciplined sizing.`
          : 'Best 15m entry window (3m–7m left); execute if edge remains stable.')
        : 'Window is ideal but setup is not confirmed yet.';
      tone = isTrade ? (isCrowdFade ? '#e040fb' : 'var(--color-green)') : '#ffd700';
    } else if (phase === 'LATE') {
      title = isTrade ? `Manage ${side}` : 'Late phase';
      detail = isTrade
        ? 'Late-cycle trade: reduce size unless it upgrades into the 2-3m value window.'
        : 'Stalk only heavy payout skew or clear mispricing into the 2-3m close window.';
      tone = isTrade ? 'var(--color-orange)' : 'var(--color-text-muted)';
    } else if (phase === 'CLOSE_VALUE') {
      title = isTrade ? `Value ${side}` : 'Close-value scan';
      detail = isTrade
        ? (ki.exitPlan || '2-3m mispricing window is active; enter only while edge and book pressure stay aligned.')
        : `Hunting payout/mispricing skew${(ki.blockedBy?.length || ki.timingBlocks?.length) ? ': ' + (ki.blockedBy?.length ? ki.blockedBy.slice(0, 2) : ki.timingBlocks.slice(0, 2)).join(', ') : '.'}`;
      tone = isTrade ? 'var(--color-green)' : '#ffd700';
    } else if (phase === 'LAST_CALL') {
      title = 'Last call';
      detail = 'Final seconds: only exceptional fill-at-price entries; otherwise let the contract settle.';
      tone = 'var(--color-red)';
    } else if (phase === 'SETTLING') {
      title = 'Settling';
      detail = 'Contract is settling — no new entries.';
      tone = 'var(--color-red)';
    }

    if (ki.tailRisk && isTrade) {
      detail += ' Tail-risk pricing detected; keep size conservative.';
    }

    return { phase, title, detail, tone };
  }

  function renderFifteenMinuteMovePlan(ki, compact = false) {
    const plan = buildFifteenMinuteMovePlan(ki);
    if (!plan) return '';
    const phaseLabel = {
      OPENING: 'OPEN',
      SETUP: 'SETUP',
      PRIME: 'PRIME',
      SCALP: 'SCALP',
      CLOSE_VALUE: '2-3M VALUE',
      LATE: 'LATE',
      LAST_CALL: 'LAST CALL',
      SETTLING: 'SETTLING',
      UNTIMED: 'LIVE',
    }[plan.phase] || plan.phase;
    const lineFont = compact ? '10px' : '11px';
    return `
      <div style="margin-top:${compact ? 3 : 5}px;padding:${compact ? '4px 6px' : '6px 8px'};border-radius:4px;background:rgba(90,110,255,0.08);border:1px solid rgba(120,140,255,0.18);line-height:1.35">
        <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
          <span style="font-size:${compact ? '9px' : '10px'};font-weight:700;color:var(--color-text-faint);letter-spacing:.45px">15M MOVE · ${phaseLabel}</span>
          <span style="font-size:${lineFont};font-weight:800;color:${plan.tone}">${plan.title}</span>
        </div>
        <div style="font-size:${lineFont};color:var(--color-text-muted);margin-top:2px">${plan.detail}</div>
      </div>
    `;
  }

  function renderLiveCalibrationTelemetryStrip(telemetry) {
    if (!telemetry || typeof telemetry !== 'object') return '';
    const counts = telemetry.counts || {};
    const samples = Number(telemetry.samples || 0);
    if (samples <= 0) return '';
    const waitGuardBlocked = Number(counts.waitGuardBlocked || 0);
    const staleDataBlocked = Number(counts.staleDataBlocked || 0);
    const vetoBlocked = Number(counts.vetoBlocked || 0);
    const mctsOverrideUsed = Number(counts.mctsOverrideUsed || 0);
    const executedDirectionalIntents = Number(counts.executedDirectionalIntents || 0);
    const showCell = (label, value, color = 'var(--color-text)') => `
      <div style="background:var(--color-surface-3);padding:3px 7px;border-radius:4px;display:flex;gap:4px;align-items:center">
        <span style="font-size:9px;color:var(--color-text-faint)">${label}</span>
        <span style="font-size:11px;font-weight:800;color:${color}">${value}</span>
      </div>
    `;
    return `
      <div style="margin:6px 0 10px 0;padding:8px 9px;border-radius:5px;background:rgba(90,160,255,0.08);border:1px solid rgba(120,170,255,0.20)">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">
          <span style="font-size:10px;font-weight:700;color:var(--color-text-faint);letter-spacing:.4px">15M BTC/ETH LIVE CALIBRATION · LAST ${Number(telemetry.windowSize || samples)} EVENTS</span>
          <span style="font-size:10px;color:var(--color-text-faint)">samples ${samples}</span>
        </div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          ${showCell('wait-guard blocks', waitGuardBlocked, waitGuardBlocked > 0 ? 'var(--color-orange)' : 'var(--color-text)')}
          ${showCell('stale-data blocks', staleDataBlocked, staleDataBlocked > 0 ? 'var(--color-orange)' : 'var(--color-text)')}
          ${showCell('veto blocks', vetoBlocked, vetoBlocked > 0 ? '#ff8a8a' : 'var(--color-text)')}
          ${showCell('MCTS overrides', mctsOverrideUsed, mctsOverrideUsed > 0 ? '#caa7ff' : 'var(--color-text)')}
          ${showCell('executed intents', executedDirectionalIntents, executedDirectionalIntents > 0 ? 'var(--color-green)' : 'var(--color-text)')}
        </div>
      </div>
    `;
  }

  function buildOpportunitiesPanel(cfmAll, predAll) {
    const allSignals = [];
    const coinEdges = {};

    const kalshiIntents = window.KalshiOrchestrator?.update(predAll, cfmAll) ?? {};

    try {
      PREDICTION_COINS.forEach(coin => {
        const ki = kalshiIntents[coin.sym];
        if (!ki) return;
        maybePlayContractArrivalBell(coin.sym, ki);
        if (ki.action === 'skip') return;
        const prev = window._orchLog.length
          ? window._orchLog.filter(e => e.sym === coin.sym).slice(-1)[0] : null;
        const changed = !prev
          || prev.action !== ki.action
          || prev.side !== ki.side
          || prev.alignment !== ki.alignment;
        if (changed) {
          const setupType = maybePlayTradeSetupBell(coin.sym, ki);
          window._orchLog.push({
            sym: coin.sym,
            ts: Date.now(),
            action: ki.action,
            side: ki.side ?? null,
            direction: ki.direction ?? null,
            alignment: ki.alignment ?? null,
            edgeCents: ki.edgeCents ?? null,
            confidence: ki.confidence ?? null,
            modelScore: ki.modelScore ?? null,
            secsLeft: ki.secsLeft ?? null,
            minsLeft: ki.minsLeft ?? null,
            sweetSpot: ki.sweetSpot ?? false,
            timingRegime: ki.timingRegime ?? null,
            timingScore: ki.timingScore ?? null,
            closeValue: ki.closeValue ?? false,
            scalpFlip: ki.scalpFlip ?? false,
            missedOpportunityScore: ki.missedOpportunityScore ?? 0,
            crowdFade: ki.crowdFade ?? false,
            signalLocked: ki.signalLocked ?? false,
            setupType: setupType ?? null,
            contractTicker: ki.contractTicker ?? null,
            humanReason: ki.humanReason ?? null,
            regimeTag: ki.regimeTag ?? null,
            waitGuardDiagnostics: ki.waitGuardDiagnostics ?? null,
            mcts: ki.mcts ?? null,
          });
          if (window._orchLog.length > 300) window._orchLog.shift();
          saveOrchLog();
        }
      });
    } catch (orchLogErr) { console.warn('[orchLog]', orchLogErr.message); }

    if (window.DataLogger) {
      PREDICTION_COINS.forEach(coin => {
        const pred = predAll[coin.sym];
        const cfm = cfmAll[coin.sym];
        if (!pred || !cfm || cfm.cfmRate === 0) return;
        const ind = pred.indicators || {};
        const lastPred = window._lastPrediction?.[coin.sym];
        window.DataLogger.logPrediction(coin.sym, {
          dir: pred.direction ?? lastPred?.direction ?? null,
          score: pred.score ?? null,
          conf: pred.confidence ?? null,
          quality: pred.modelQuality ?? null,
          fit: pred.tradeFit ?? null,
          alignment: pred.signalAlignment ?? null,
          rsi: ind.rsi?.value ?? null,
          vwapDev: cfm.vwapDev ?? null,
        });
        const ki = kalshiIntents[coin.sym];
        if (ki) window.DataLogger.logDecision(coin.sym, ki);
      });
      window._cfmAll = cfmAll;
    }

    PREDICTION_COINS.forEach(coin => {
      const cfm = cfmAll[coin.sym];
      const pred = predAll[coin.sym];
      if (!cfm || cfm.cfmRate === 0) return;

      const edge = calcEdge(coin.sym, cfm, pred);
      if (edge) coinEdges[coin.sym] = edge;

      const wc = COIN_WEIGHT[coin.sym] || 'light';
      const rank = WEIGHT_RANK[wc];
      const ind = pred?.indicators || {};
      const dexMeta = cfm.dexMeta || {};
      const cbPrice = cfm.sources?.CB || 0;

      const vals = {
        ...cfm,
        _rsi: ind.rsi?.value ?? 50,
        _macd: computeQuickMACD(cfm),
        _emaCross: ind.ema?.value ?? 0,
        _obvSlope: ind.obv?.slope ?? 0,
        _volRatio: ind.volume?.ratio ?? 1,
        _atrPct: pred?.volatility?.atrPct ?? 0,
        _bookImbal: (ind.book || {}).imbalance ?? 0,
        _aggrBuy: (ind.flow || {}).buyRatio ?? 50,
        _cbPremium: cbPrice > 0 && cfm.cfmRate > 0 ? ((cbPrice - cfm.cfmRate) / cfm.cfmRate) * 100 : 0,
        _dexVol: dexMeta.vol ?? 0,
        _dexLiq: dexMeta.liq ?? 0,
        _funding: pred?.derivatives?.funding ?? 0,
        _oi: pred?.derivatives?.oi ?? 0,
        _squeezeScore: pred?.squeeze ? (pred.squeeze.severity === 'high' ? 2 : 1) : 0,
        _cvdSlope: pred?.cvd?.slope ?? 0,
      };

      const activeOrbs = SUBORBITALS.filter(orb => rank >= (ORBITAL_ACCESS[orb.weight] || 1));
      activeOrbs.forEach(orb => {
        const sig = evaluateSignal(orb, vals[orb.key], vals);
        if (sig.signal && sig.signal !== 'even') {
          allSignals.push({ coin: coin.sym, color: coin.color, orb: orb.sym, shell: orb.shell, signal: sig.signal, tag: sig.tag, reason: sig.reason });
        }
      });
    });

    const verdicts = PREDICTION_COINS
      .map(c => ({ sym: c.sym, color: c.color, edge: coinEdges[c.sym] }))
      .filter(v => v.edge)
      .sort((a, b) => b.edge.edge15 - a.edge.edge15);

    const highConv = verdicts.filter(v => v.edge.tier === 'HIGH CONVICTION');
    const marginal = verdicts.filter(v => v.edge.tier === 'MARGINAL');
    const notWorth = verdicts.filter(v => v.edge.tier === 'NOT WORTH IT' || v.edge.tier === 'BREAK EVEN');

    const scalpCount = allSignals.filter(s => s.signal === 'bull').length;
    const fadeCount = allSignals.filter(s => s.signal === 'bear').length;
    const dangerCount = allSignals.filter(s => s.signal === 'danger').length;

    const callouts = buildNarrativeCallouts(verdicts, allSignals, cfmAll, predAll);
    const liveCalibrationTelemetry = window.KalshiOrchestrator?.getCalibrationTelemetry?.() || null;

    return `
      ${callouts}
      ${renderLiveCalibrationTelemetryStrip(liveCalibrationTelemetry)}

      <div class="opp-panel" style="border-left:3px solid ${highConv.length > 0 ? 'var(--color-green)' : marginal.length > 0 ? 'var(--color-orange)' : 'var(--color-text-faint)'}">
        <div class="card-title" style="color:var(--color-gold)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Trade Verdicts \u2014 Kalshi Binary Contracts
        </div>

        ${verdicts.length === 0 ? '<div style="font-size:12px;color:var(--color-text-muted);padding:12px 0">Warming up \u2014 accumulating price data...</div>' : ''}

        <div class="opp-grid">
          ${verdicts.map(v => {
      const e = v.edge;
      const arrow = e.dir === 'up' ? '\u2191' : '\u2193';
      const dirLabel = e.dir === 'up' ? 'UP' : 'DOWN';
      return `
              <div class="opp-card ${e.tier === 'HIGH CONVICTION' ? 'scalp' : e.tier === 'MARGINAL' ? 'fade' : e.tier === 'NOT WORTH IT' ? 'danger' : 'even'}" style="padding:12px">
                <div class="opp-head">
                  <span style="color:${v.color};font-size:14px">${v.sym}</span>
                  <span style="font-size:16px;color:${e.dir === 'up' ? 'var(--color-green)' : 'var(--color-red)'}">${arrow}</span>
                  <span style="font-size:10px;color:var(--color-text-muted)">${dirLabel}</span>
                  <span style="margin-left:auto;font-size:9px;padding:2px 6px;border-radius:9999px;font-weight:700;background:${e.tierColor}22;color:${e.tierColor}">${e.tier}</span>
                </div>
                <div style="font-size:10px;color:var(--color-text-muted);margin:4px 0">${e.tierDesc}</div>

                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;font-family:var(--font-mono);margin-top:4px">
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">15m MOVE</div>
                    <div style="font-weight:700;color:${e.expected15m > e.totalCostPct ? 'var(--color-green)' : 'var(--color-red)'}">${e.expected15m.toFixed(2)}%</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">COST</div>
                    <div style="font-weight:700;color:var(--color-red)">${e.totalCostPct.toFixed(2)}%</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">EDGE</div>
                    <div style="font-weight:700;color:${e.edge15 > 0 ? 'var(--color-green)' : 'var(--color-red)'}">${e.edge15 > 0 ? '+' : ''}${e.edge15.toFixed(2)}%</div>
                  </div>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;font-family:var(--font-mono);margin-top:3px">
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">ENTRY</div>
                    <div style="font-weight:700">${fmtPrice(e.entryPrice)}</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">STOP</div>
                    <div style="font-weight:700;color:var(--color-red)">${fmtPrice(e.stopLoss)}</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">TARGET</div>
                    <div style="font-weight:700;color:var(--color-green)">${fmtPrice(e.takeProfit)}</div>
                  </div>
                </div>

                <div style="font-size:9px;color:var(--color-text-faint);margin-top:4px;display:flex;gap:8px">
                  <span>${e.signalCount} confirming signals</span>
                  <span>R:R ${e.riskReward.toFixed(1)}:1</span>
                  <span>ATR ${e.atrPct.toFixed(2)}%</span>
                  <span>${e.edge15 >= 0 ? '+' : ''}$${e.dollarEdgePer100_15.toFixed(2)} per $100</span>
                </div>

                ${(() => {
          const ki = kalshiIntents[v.sym];
          if (!ki || ki.action === 'skip') return '';
          const isExit = ki.action === 'earlyExit';
          const isHold = ki.action === 'hold';
          const isTrade = ki.action === 'trade';
          const isCrowdFade = ki.alignment === 'CROWD_FADE' || !!ki.crowdFade;
          const isDivergent = ki.alignment === 'DIVERGENT' || isCrowdFade;
          const bg = isExit ? 'rgba(255,80,80,0.07)'
            : isHold ? 'rgba(255,180,0,0.07)'
              : isCrowdFade ? 'rgba(224,64,251,0.08)'
                : isTrade ? 'rgba(0,200,100,0.08)'
                  : isDivergent ? 'rgba(255,140,0,0.07)'
                    : 'rgba(200,200,0,0.06)';
          const border = isExit ? 'rgba(255,80,80,0.25)'
            : isHold ? 'rgba(255,180,0,0.28)'
              : isCrowdFade ? 'rgba(224,64,251,0.26)'
                : isTrade ? 'rgba(0,200,100,0.22)'
                  : isDivergent ? 'rgba(255,140,0,0.28)'
                    : 'rgba(200,200,0,0.18)';
          const sideColor = ki.side === 'YES' ? 'var(--color-green)' : ki.side === 'NO' ? 'var(--color-red)' : 'var(--color-text-muted)';
          const sideBg = ki.side === 'YES' ? 'rgba(0,200,100,0.18)' : ki.side === 'NO' ? 'rgba(220,60,60,0.18)' : 'transparent';
          const alignColor = isCrowdFade ? '#e040fb' : isDivergent ? '#ff8c00' : isTrade ? 'var(--color-green)' : 'var(--color-text-muted)';
          const alignTagC = {
            ALIGNED: '✓ Aligned', DIVERGENT: '⚡ Divergent', CROWD_FADE: '🔄 Crowd fade', MODEL_LEADS: '→ Model leads',
            KALSHI_ONLY: '◇ Kalshi only', MODEL_ONLY: '◆ Model only',
            EARLY_EXIT: '✗ Early exit', SHELL_EVAL: '⏳ Evaluating',
          }[ki.alignment] || (ki.alignment || '');
          const strikeC = ki.strikeStr || (() => {
            const m = (ki.contractTicker || '').match(/T(\d+(?:\.\d+)?)$/);
            return m ? 'T' + Number(m[1]).toLocaleString() : '';
            // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();
          const msNow = ki.closeTimeMs ? Math.max(0, ki.closeTimeMs - Date.now()) : null;
          const secsNow = msNow != null ? msNow / 1000 : null;
          const timeStr = secsNow == null ? null
            : secsNow < 10 ? msNow.toFixed(0) + 'ms'
              : secsNow < 90 ? Math.round(secsNow) + 's'
                : (secsNow / 60).toFixed(1) + 'm';
          const isLastCall = msNow != null && msNow <= 60000;
          return `
                   <div style="margin-top:6px;padding:7px 9px;border-radius:5px;background:${bg};border:1px solid ${border}">
                     ${isExit
              ? `<div style="display:flex;align-items:center;gap:8px">
                            <span style="background:rgba(255,80,80,0.22);color:var(--color-red);padding:3px 12px;border-radius:4px;font-size:12px;font-weight:800;letter-spacing:.5px">STAND ASIDE</span>
                            <span style="font-size:11px;color:var(--color-text-muted)">CFM early-exit signal</span>
                          </div>`
              : isHold
                ? `<div style="display:flex;align-items:center;gap:8px">
                            <span style="background:rgba(255,180,0,0.22);color:var(--color-gold,#f90);padding:3px 12px;border-radius:4px;font-size:12px;font-weight:800;letter-spacing:.5px">⏳ EVALUATING</span>
                            <span style="font-size:11px;color:var(--color-text-muted)">Shell wall — collecting data</span>
                          </div>`
                : `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                            <span style="background:${sideBg};color:${sideColor};padding:3px 12px;border-radius:4px;font-size:14px;font-weight:800;letter-spacing:.7px">${ki.side}</span>
                            <span style="font-size:12px;font-weight:700;color:var(--color-text);font-family:var(--font-mono)">KALSHI${strikeC ? ' · ' + strikeC : ''}</span>
                            ${ki.isInversion ? '<span style="background:rgba(255,120,0,0.22);color:#ff8c00;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:800">🔥 INVERSION</span>' : ''}
                            ${ki.timingLabel ? `<span style="background:rgba(90,160,255,0.18);color:#7db7ff;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:800">${ki.timingLabel}</span>` : ''}
                            ${ki.mcts?.ran ? `<span style="background:rgba(170,110,255,0.18);color:#caa7ff;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:800">MCTS ${ki.mcts.voteAction || '?'} ${Number.isFinite(Number(ki.mcts.voteStrength)) ? Number(ki.mcts.voteStrength).toFixed(2) : ''}</span>` : ''}
                            ${isLastCall ? `<span id="kalshi-lc-${ki.sym}" data-close-ms="${ki.closeTimeMs}" style="background:rgba(255,40,40,0.22);color:var(--color-red);padding:2px 7px;border-radius:3px;font-size:11px;font-weight:800;font-family:var(--font-mono)">⚡ ${timeStr}</span>` : ''}
                            <span style="margin-left:auto;color:${alignColor};font-size:11px;font-weight:700">${alignTagC}</span>
                          </div>`}
                     ${!isExit && !isHold && ki.edgeCents != null ? `
                     <div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;align-items:stretch">
                       <div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:44px">
                         <div style="font-size:9px;color:var(--color-text-faint)">EDGE</div>
                         <div style="font-size:13px;font-weight:800;color:${ki.edgeCents >= 8 ? 'var(--color-green)' : ki.edgeCents >= 0 ? 'var(--color-text-muted)' : 'var(--color-red)'}">
                           ${ki.edgeCents >= 0 ? '+' : ''}${ki.edgeCents}¢</div>
                       </div>
                       ${ki.payoutMult != null ? `<div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:44px">
                         <div style="font-size:9px;color:var(--color-text-faint)">PAYOUT</div>
                         <div style="font-size:13px;font-weight:800;color:var(--color-text)">${ki.payoutMult.toFixed(1)}×</div></div>` : ''}
                       <div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:44px">
                         <div style="font-size:9px;color:var(--color-text-faint)">ENTRY</div>
                         <div style="font-size:13px;font-weight:800;color:${ki.thinBook ? 'var(--color-orange)' : ki.tailRisk ? '#ff6b6b' : 'var(--color-text)'}">
                           ${ki.entryPrice != null ? '$' + (ki.entryPrice * 100).toFixed(0) + '¢' : '—'}</div>
                       </div>
                       ${ki.breakEven != null ? `<div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:52px">
                         <div style="font-size:9px;color:var(--color-text-faint)">NEED WIN%</div>
                         <div style="font-size:13px;font-weight:800;color:var(--color-text)">${Math.round(ki.breakEven * 100)}%</div></div>` : ''}
                       ${ki.kellyPct > 0 ? `<div style="background:var(--color-surface-3);padding:3px 8px;border-radius:4px;text-align:center;min-width:44px">
                         <div style="font-size:9px;color:var(--color-text-faint)">KELLY</div>
                         <div style="font-size:13px;font-weight:800;color:var(--color-text)">${ki.kellyPct}%</div></div>` : ''}
                     </div>` : ''}
                     <div style="font-size:11px;color:var(--color-text-faint);margin-top:4px;display:flex;gap:10px;flex-wrap:wrap">
                       ${ki.modelProbUp != null ? `<span>Model <strong style="color:var(--color-text)">${Math.round(ki.modelProbUp * 100)}%</strong> ↑</span>` : ''}
                       ${ki.kalshiYesPrice != null ? `<span>Kalshi <strong style="color:var(--color-text)">${Math.round(ki.kalshiYesPrice * 100)}%</strong> YES</span>` : ''}
                       ${ki.targetPrice ? `<span>Strike <strong style="color:var(--color-text)">${ki.targetPrice}</strong></span>` : ''}
                       ${timeStr && !isLastCall ? `<span id="kalshi-min-${ki.sym}" data-close-ms="${ki.closeTimeMs}">⏱ <strong>${timeStr}</strong></span>` : ''}
                       <span style="color:${isTrade ? 'var(--color-green)' : 'var(--color-orange)'}"><strong>${ki.confidence}%</strong> conf</span>
                     </div>
                     ${ki.thinBook ? `<div style="font-size:11px;color:var(--color-orange);margin-top:3px">⚠ Thin book (${ki.entryPrice != null ? (ki.entryPrice * 100).toFixed(0) : '?'}¢ entry) — check spread before sizing</div>` : ''}
                     ${ki.tailRisk ? `<div style="font-size:11px;color:#ff6b6b;margin-top:3px">⚠ Tail risk ($${ki.entryPrice != null ? ki.entryPrice.toFixed(2) : '?'} entry)${ki.lossErasesWins ? ' — one loss erases ' + ki.lossErasesWins + ' wins' : ''}</div>` : ''}
                      ${isCrowdFade ? `<div style="font-size:11px;color:#e040fb;margin-top:3px">🔄 Mispricing hunter active — blockchain momentum is diverging from crowd pricing</div>`
              : isDivergent ? `<div style="font-size:11px;color:#ff8c00;margin-top:3px">⚡ Model vs house — buy the mispriced side, the edge IS the divergence</div>` : ''}
                     ${!isTrade && ki.waitGuardDiagnostics?.blocked ? `<div style="font-size:11px;color:var(--color-text-faint);margin-top:3px">Wait-guard: threshold ${ki.waitGuardDiagnostics.threshold ?? '?'} · conf ${ki.waitGuardDiagnostics.confidence ?? '?'} · regime ${ki.waitGuardDiagnostics.regime ?? 'n/a'} · MCTS ${ki.waitGuardDiagnostics.mctsVote ?? 'n/a'} ${Number.isFinite(Number(ki.waitGuardDiagnostics.mctsVoteStrength)) ? Number(ki.waitGuardDiagnostics.mctsVoteStrength).toFixed(3) : ''}</div>` : ''}
                      ${ki.exitPlan && isTrade ? `<div style="font-size:11px;color:#7db7ff;margin-top:3px">${ki.exitPlan}</div>` : ''}
                     ${(ki.blockedBy?.length || ki.timingBlocks?.length || ki.stageDiagnostics?.suppressionReasons?.length) && !isTrade ? `<div style="font-size:11px;color:var(--color-text-faint);margin-top:3px">Watching: ${((ki.blockedBy?.length ? ki.blockedBy : []).concat(ki.timingBlocks || []).concat(ki.stageDiagnostics?.suppressionReasons || []).filter(Boolean).slice(0, 4)).join(' · ')}</div>` : ''}
                      ${ki.humanReason ? `<div style="font-size:11px;color:var(--color-text-muted);margin-top:4px;line-height:1.4">${ki.humanReason}</div>` : ''}
                      ${renderFifteenMinuteMovePlan(ki, true)}
                    </div>`;
        })()}
                </div>
            `;
    }).join('')}
        </div>
      </div>

      ${allSignals.length > 0 ? `
        <div class="opp-panel">
          <div class="card-title" style="color:var(--color-gold)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Flashing Indicators \u2014 ${allSignals.length} active
            <span style="margin-left:auto;font-size:10px;font-weight:400;color:var(--color-text-muted)">
              ${scalpCount > 0 ? '<span style="color:var(--color-green)">' + scalpCount + ' up</span>' : ''}
              ${fadeCount > 0 ? ' <span style="color:var(--color-orange)">' + fadeCount + ' down</span>' : ''}
              ${dangerCount > 0 ? ' <span style="color:var(--color-red)">' + dangerCount + ' risk</span>' : ''}
            </span>
          </div>
          <div class="opp-grid">
            ${allSignals.slice(0, 12).map(s => `
              <div class="opp-card ${s.signal}">
                <div class="opp-head">
                  <span style="color:${s.color}">${s.coin}</span>
                  <span style="font-size:9px;color:var(--color-text-faint)">${s.orb} \u00b7 ${s.shell}</span>
                  <span style="margin-left:auto;font-size:9px;padding:1px 5px;border-radius:9999px;background:${s.signal === 'bull' ? 'var(--color-green-dim)' : s.signal === 'bear' ? 'var(--color-orange-dim)' : 'var(--color-red-dim)'};color:${s.signal === 'bull' ? 'var(--color-green)' : s.signal === 'bear' ? 'var(--color-orange)' : 'var(--color-red)'};font-weight:700;text-transform:uppercase">${s.tag || s.signal}</span>
                </div>
                <div class="opp-desc">${s.reason}</div>
              </div>
            `).join('')}
          </div>
          ${allSignals.length > 12 ? '<div style="font-size:10px;color:var(--color-text-faint);margin-top:6px">+ ' + (allSignals.length - 12) + ' more signals in the tables below</div>' : ''}
        </div>
      ` : `
        <div class="opp-panel">
          <div class="card-title" style="color:var(--color-text-faint)">\u26a1 Indicators</div>
          <div style="font-size:12px;color:var(--color-text-muted);padding:8px 0">No flashing indicators yet \u2014 market is break-even across all orbitals.</div>
        </div>
      `}
    `;
  }

  const COIN_WEIGHT = {
    BTC: 'heavy', ETH: 'heavy',
    SOL: 'mid', XRP: 'mid', BNB: 'mid',
    DOGE: 'light', HYPE: 'light',
  };

  const WEIGHT_RANK = { heavy: 3, mid: 2, light: 1 };
  const ORBITAL_ACCESS = { all: 1, mid: 2, heavy: 3 };

  function computeGroundState(vals, pred, weightClass) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const ind = pred?.indicators || {};

    let innerScore = 0;
    let innerCount = 0;

    function addInner(v, w) {
      if (v === null || v === undefined || !isFinite(v)) return;
      innerScore += v * w;
      innerCount += w;
    }

    const vwapDev = ind.vwap?.value ?? 0;
    addInner(clamp(vwapDev / 2, -1, 1), 0.18);

    const rsi = ind.rsi?.value ?? 50;
    addInner(clamp((rsi - 50) / 30, -1, 1), 0.14);

    const macdHist = ind.macd?.histogram ?? 0;
    addInner(clamp(macdHist * 50, -1, 1), 0.10);

    const emaCross = vals._emaCross ?? 0;
    addInner(clamp(emaCross / 0.5, -1, 1), 0.12);

    const trd = vals.trend;
    if (trd === 'rising') addInner(0.7, 0.10);
    else if (trd === 'falling') addInner(-0.7, 0.10);

    const obv = vals._obvSlope ?? 0;
    addInner(clamp(obv / 80, -1, 1), 0.10);

    const volR = vals._volRatio ?? 1;
    addInner(clamp((volR - 1) / 0.5, -1, 1), 0.08);

    if (weightClass !== 'light') {
      addInner(clamp((vals._bookImbal ?? 0) / 0.5, -1, 1), 0.09);
      addInner(clamp(((vals._aggrBuy ?? 50) - 50) / 30, -1, 1), 0.09);
    }

    if (weightClass !== 'light') {
      const fund = vals._funding ?? 0;
      addInner(clamp(-fund / 0.5, -1, 1), 0.08);
    }

    const rawInner = innerCount > 0 ? innerScore / innerCount : 0;
    const innerNorm = clamp(rawInner, -1, 1) * 0.7; 

    let outerBoost = 0;
    const triggers = [];

    const sqz = vals._squeezeScore ?? 0;
    if (sqz >= 1) {
      const dir = vals._squeezeType === 'short_squeeze' ? 1 : vals._squeezeType === 'long_squeeze' ? -1 : 0;
      const mag = sqz >= 2 ? 0.40 : 0.25;
      if (dir !== 0) {
        outerBoost += dir * mag;
        triggers.push({ sym: 'SQZ', dir: dir > 0 ? 'bull' : 'bear', label: sqz >= 2 ? 'HIGH' : 'MED', strength: sqz >= 2 ? 'strong' : 'medium' });
      }
    }

    const cvd = vals._cvdSlope ?? 0;
    if (Math.abs(cvd) > 10) {
      const boost = clamp(cvd / 80, -1, 1) * 0.20;
      outerBoost += boost;
      triggers.push({ sym: 'CVD', dir: boost > 0 ? 'bull' : 'bear', label: (cvd >= 0 ? '+' : '') + cvd.toFixed(0), strength: Math.abs(cvd) > 40 ? 'strong' : 'medium' });
    }

    const cbp = vals._cbPremium ?? 0;
    if (Math.abs(cbp) > 0.08) {
      const boost = clamp(cbp / 0.3, -1, 1) * 0.18;
      outerBoost += boost;
      triggers.push({ sym: 'CBP', dir: boost > 0 ? 'bull' : 'bear', label: (cbp >= 0 ? '+' : '') + cbp.toFixed(2) + '%', strength: Math.abs(cbp) > 0.2 ? 'strong' : 'medium' });
    }

    outerBoost = clamp(outerBoost, -0.30, 0.30);

    const raw = clamp(innerNorm + outerBoost, -1.0, 1.0);
    const abs = Math.abs(raw);
    const dir = raw > 0.08 ? 'up' : raw < -0.08 ? 'down' : 'flat';

    let stateLabel, stateClass;
    if (abs >= 0.80) { stateLabel = 'IONISED'; stateClass = 'ionised'; }
    else if (abs >= 0.60) { stateLabel = 'IONISING'; stateClass = 'ionising'; }
    else if (abs >= 0.35) { stateLabel = 'HIGH ENERGY'; stateClass = 'high'; }
    else if (abs >= 0.12) { stateLabel = 'EXCITED'; stateClass = 'excited'; }
    else { stateLabel = 'GROUND'; stateClass = 'ground'; }

    const conflicted = (
      Math.abs(outerBoost) >= 0.15 &&
      Math.sign(outerBoost) !== Math.sign(innerNorm) &&
      Math.abs(innerNorm) >= 0.10
    );

    const bullSignals = pred?.signals?.filter(s => s.dir > 0).length ?? 0;
    const bearSignals = pred?.signals?.filter(s => s.dir < 0).length ?? 0;
    const totalSignals = bullSignals + bearSignals;
    const shellsAligned = dir === 'up' ? bullSignals : dir === 'down' ? bearSignals : Math.min(bullSignals, bearSignals);
    const shellsTotal = Math.max(totalSignals, 1);

    return {
      score: raw,
      innerScore: innerNorm,
      outerBoost,
      dir,
      stateLabel,
      stateClass,
      conflicted,
      triggers,
      shellsAligned,
      shellsTotal,
    };
  }

  function detectMarketRegime(pred) {
    const ind = pred?.indicators || {};
    const adx = ind.adx?.adx ?? 0;
    const atr = pred?.volatility?.atrPct ?? 0;
    const bbWidth = ind.bands?.width ?? null;

    if (atr > 3.0) {
      return { type: 'volatile', label: 'VOLATILE', cls: 'volatile', desc: `ATR ${atr.toFixed(1)}% — wide swings, widen stops` };
    }
    if (adx > 25) {
      const trendDir = ind.adx?.trend > 0 ? ' ▲' : ind.adx?.trend < 0 ? ' ▼' : '';
      return { type: 'trending', label: 'TREND' + trendDir, cls: 'trending', desc: `ADX ${adx.toFixed(0)} — directional, ride momentum` };
    }
    if (bbWidth !== null && bbWidth < 0.04) {
      return { type: 'squeeze', label: 'SQUEEZE', cls: 'breakout', desc: `BB squeeze — breakout imminent, wait for direction` };
    }
    if (adx < 18 && atr < 1.2) {
      return { type: 'ranging', label: 'RANGING', cls: 'ranging', desc: `ADX ${adx.toFixed(0)} — consolidation, fade extremes` };
    }
    return { type: 'neutral', label: 'NEUTRAL', cls: 'neutral', desc: 'No dominant regime — mixed conditions' };
  }

  function computeEntryQuality(gs, regime, pred) {
    const abs = Math.abs(gs.score);
    const conf = gs.shellsTotal > 0 ? gs.shellsAligned / gs.shellsTotal : 0;
    const rel = pred?.backtest?.summary?.reliability ?? 0;

    if (gs.conflicted) {
      return { grade: 'D', label: 'WAIT', cls: 'wait', reason: 'Shell conflict — outer catalysts oppose inner state' };
    }
    if (abs >= 0.50 && conf >= 0.65 && rel >= 0.45) {
      return { grade: 'A', label: 'A-SETUP', cls: 'a', reason: 'High energy + strong confluence + reliable backtest' };
    }
    if (abs >= 0.35 && conf >= 0.55 && rel >= 0.40) {
      return { grade: 'B', label: 'B-SETUP', cls: 'b', reason: 'Good energy + majority aligned' };
    }
    if (abs >= 0.15 && conf >= 0.45) {
      return { grade: 'C', label: 'C-SETUP', cls: 'c', reason: 'Partial confluence — trade smaller size' };
    }
    return { grade: 'D', label: 'WAIT', cls: 'wait', reason: 'Low energy or insufficient confluence' };
  }

  function buildCoinPeriodicTable(coin, cfm, pred) {
    const trendColor = cfm.trend === 'rising' ? 'var(--color-green)' : cfm.trend === 'falling' ? 'var(--color-red)' : 'var(--color-text-muted)';
    const srcKeys = Object.keys(cfm.sources || {});
    const weightClass = COIN_WEIGHT[coin.sym] || 'light';
    const coinRank = WEIGHT_RANK[weightClass];

    const activeOrbitals = SUBORBITALS.filter(orb => {
      const required = ORBITAL_ACCESS[orb.weight] || 1;
      return coinRank >= required;
    });

    const shellCount = new Set(activeOrbitals.map(o => o.shell)).size;
    const atomicMass = activeOrbitals.length;

    const ind = pred?.indicators || {};
    const bookData = ind.book || {};
    const flowData = ind.flow || {};
    const dexMeta = cfm.dexMeta || {};
    const cbPrice = cfm.sources?.CB || 0;

    const vals = {
      ...cfm,
      _rsi: ind.rsi?.value ?? 50,
      _macd: computeQuickMACD(cfm),
      _emaCross: ind.ema?.value ?? 0,
      _obvSlope: ind.obv?.slope ?? 0,
      _volRatio: ind.volume?.ratio ?? 1,
      _atrPct: pred?.volatility?.atrPct ?? 0,
      _bookImbal: bookData.imbalance ?? 0,
      _aggrBuy: flowData.buyRatio ?? 50,
      _cbPremium: cbPrice > 0 && cfm.cfmRate > 0 ? ((cbPrice - cfm.cfmRate) / cfm.cfmRate) * 100 : 0,
      _dexVol: dexMeta.vol ?? 0,
      _dexLiq: dexMeta.liq ?? 0,
      _funding: pred?.derivatives?.funding ?? 0,
      _oi: pred?.derivatives?.oi ?? 0,
      _squeezeScore: pred?.squeeze ? (pred.squeeze.severity === 'high' ? 2 : 1) : 0,
      _squeezeType: pred?.squeeze?.type ?? null,
      _cvdSlope: pred?.cvd?.slope ?? 0,
    };

    const gs = computeGroundState(vals, pred, weightClass);
    const regime = detectMarketRegime(pred);
    const eq = computeEntryQuality(gs, regime, pred);

    const barPct = Math.abs(gs.score) * 50; 
    const barFill = `left:${gs.dir === 'down' ? 50 - barPct : 50}%;width:${barPct}%;`;

    const triggerBadges = gs.triggers.map(t =>
      `<span class="gs-trigger ${t.dir} ${t.strength}" title="${t.sym}">${t.sym} ${t.label}</span>`
    ).join('');

    const conflictHtml = gs.conflicted ? `
      <div class="gs-conflict-warn">⚠ Shell conflict — outer catalysts oppose inner state. Reduce size.</div>
    ` : '';

    const gsHtml = `
      <div class="gs-wrap" onclick="event.stopPropagation()">
        <div class="gs-header-row">
          <span class="gs-state-label ${gs.dir}">${gs.stateLabel}</span>
          <div class="gs-bar-outer">
            <div class="gs-bar-center"></div>
            <div class="gs-bar-fill ${gs.dir}" style="${barFill}"></div>
          </div>
          <span style="font-size:10px;font-family:var(--font-mono);color:${gs.dir === 'up' ? 'var(--color-green)' : gs.dir === 'down' ? 'var(--color-red)' : 'var(--color-text-muted)'}">
            ${gs.score >= 0 ? '+' : ''}${gs.score.toFixed(2)}
          </span>
          <span class="gs-grade ${eq.cls}" title="${eq.reason}">${eq.label}</span>
          <span class="gs-regime ${regime.cls}" title="${regime.desc}">${regime.label}</span>
        </div>
        <div class="gs-meta-row">
          ${triggerBadges}
          <span class="gs-confluence ${gs.shellsAligned / gs.shellsTotal < 0.45 ? 'warn' : ''}">${gs.shellsAligned}/${gs.shellsTotal} shells</span>
        </div>
        ${conflictHtml}
      </div>
    `;

    const weightLabel = { heavy: 'Heavy', mid: 'Mid', light: 'Light' }[weightClass];
    const weightBadgeColor = { heavy: 'var(--color-gold)', mid: 'var(--color-primary)', light: 'var(--color-text-faint)' }[weightClass];
    const expanded = cfmExpanded.has(coin.sym);
    const partitionCards = (cfm.partitions || []).map(part => `
      <div class="cfm-detail-card">
        <span class="cfm-detail-label">Partition ${part.i}</span>
        <strong>${part.vwm ? fmtPrice(part.vwm) : '—'}</strong>
        <small>${part.n} samples</small>
      </div>
    `).join('');
    const sourceCards = Object.entries(cfm.sources || {}).map(([src, value]) => `
      <div class="cfm-detail-card">
        <span class="cfm-detail-label">${src}</span>
        <strong>${fmtPrice(value)}</strong>
        <small>${src === 'DEX' && cfm.dexMeta?.pair ? cfm.dexMeta.pair : 'live source'}</small>
      </div>
    `).join('');

    return `
      <div id="cfm-coin-slot-${coin.sym}" class="cfm-coin-block ${expanded ? 'expanded' : ''}" data-cfm-sym="${coin.sym}">
        <button type="button" class="cfm-coin-header cfm-toggle" data-cfm-toggle="${coin.sym}" style="border-left:3px solid ${coin.color};flex-wrap:wrap">
          <div class="cfm-coin-icon" style="background:${coin.color}22;color:${coin.color}">${coinIcon(coin.sym)}</div>
          <div class="cfm-coin-meta">
            <div class="cfm-coin-sym">
              ${coin.sym}
              <span style="font-size:9px;padding:1px 6px;border-radius:9999px;background:${weightBadgeColor}22;color:${weightBadgeColor};font-weight:700;margin-left:6px;letter-spacing:0.04em">${weightLabel} · ${atomicMass} orbitals · ${shellCount} shells</span>
            </div>
            <div class="cfm-coin-name">${coin.name} · ${srcKeys.length}/4 sources · ${cfm.sampleCount} samples</div>
          </div>
          <div>
            <div class="cfm-coin-rate" style="color:${trendColor}">${fmtPrice(cfm.cfmRate)}</div>
            <div class="cfm-coin-sub">
              <span style="color:${cfm.momentum >= 0 ? 'var(--color-green)' : 'var(--color-red)'}">${cfm.momentum >= 0 ? '+' : ''}${cfm.momentum.toFixed(3)}%</span>
              · ${cfm.trend}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:3px;align-items:center">
            ${['CDC', 'CB', 'GKO', 'DEX'].map(src => {
      const has = srcKeys.includes(src);
      const c = src === 'CDC' ? '#1a6eff' : src === 'CB' ? '#0052ff' : src === 'GKO' ? '#8dc63f' : '#a259ff';
      return `<span title="${src}: ${cfm.sources?.[src] ? fmtPrice(cfm.sources[src]) : 'N/A'}" style="width:6px;height:6px;border-radius:50%;background:${has ? c : 'var(--color-border)'};opacity:${has ? 1 : 0.25}"></span>`;
    }).join('')}
            <span class="cfm-expand-icon">${expanded ? '−' : '+'}</span>
          </div>
          ${gsHtml}
        </button>
        <div class="cfm-table">
          ${activeOrbitals.map(orb => renderSuborbital(orb, vals, coin.color)).join('')}
        </div>
        <div class="cfm-expand-panel ${expanded ? 'open' : ''}">
          <div class="cfm-detail-grid">
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Cross Spread</span>
              <strong>${cfm.spread.toFixed(3)}%</strong>
              <small>venue dispersion</small>
            </div>
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Convergence</span>
              <strong>${cfm.convergence.toFixed(3)}%</strong>
              <small>lower is tighter</small>
            </div>
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Bid / Ask</span>
              <strong>${cfm.bidAsk.toFixed(4)}%</strong>
              <small>market tightness</small>
            </div>
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Backtest Quality</span>
              <strong>${pred?.backtest ? Math.round((pred.backtest.summary?.reliability || 0) * 100) + '%' : '—'}</strong>
              <small>${pred?.diagnostics?.qualityLabel || 'live only'}</small>
            </div>
            ${partitionCards}
            ${sourceCards}
          </div>
          ${cfm.dexMeta ? `
            <div class="cfm-detail-strip">
              <span class="screener-chip">${cfm.dexMeta.chain || 'dex'} / ${cfm.dexMeta.dex || 'aggregated'}</span>
              <span class="screener-chip">${cfm.dexMeta.pair || 'pair n/a'}</span>
              <span class="screener-chip">DEX Vol ${fmtCompactUsd(cfm.dexMeta.vol)}</span>
              <span class="screener-chip">DEX Liq ${fmtCompactUsd(cfm.dexMeta.liq)}</span>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  function evaluateSignal(orb, raw, vals = {}) {
    if (raw === undefined || raw === null) return { signal: null, reason: '', tag: '' };
    const mk = (signal, tag, reason) => ({ signal, tag, reason });
    switch (orb.sym) {
      case 'RSI':
        if (raw >= 78) return mk('bear', 'REV-DN', 'RSI ' + raw.toFixed(0) + ' \u2014 extreme overbought, expect DOWN');
        if (raw <= 22) return mk('bull', 'REV-UP', 'RSI ' + raw.toFixed(0) + ' \u2014 extreme oversold, expect UP');
        if (raw >= 70) return mk('bear', 'REV-DN', 'RSI ' + raw.toFixed(0) + ' \u2014 overbought, contrarian fade');
        if (raw <= 30) return mk('bull', 'REV-UP', 'RSI ' + raw.toFixed(0) + ' \u2014 oversold, bounce scalp');
        if (raw > 45 && raw < 55) return mk('even', 'EVEN', 'RSI neutral \u2014 no edge');
        return mk(null, '', '');
      case 'MOM':
        if (raw > 0.5) return mk('bull', 'TRD-UP', 'Momentum +' + raw.toFixed(2) + '% \u2014 ride the wave');
        if (raw < -0.5) return mk('bear', 'TRD-DN', 'Momentum ' + raw.toFixed(2) + '% \u2014 expect DOWN');
        if (raw > -0.05 && raw < 0.05) return mk('even', 'EVEN', 'Flat momentum \u2014 break-even zone');
        return mk(null, '', '');
      case 'MCD':
        if (raw > 0.005) return mk('bull', 'TRD-UP', 'MACD bullish divergence \u2014 VWAP > TWAP');
        if (raw < -0.005) return mk('bear', 'TRD-DN', 'MACD bearish \u2014 VWAP < TWAP, expect DOWN');
        return mk('even', 'EVEN', 'MACD flat \u2014 no divergence');
      case 'EMA':
        if (raw > 0.3) return mk('bull', 'TRD-UP', 'EMA bull cross +' + raw.toFixed(2) + '% \u2014 trending UP');
        if (raw < -0.3) return mk('bear', 'TRD-DN', 'EMA bear cross ' + raw.toFixed(2) + '% \u2014 trending DOWN');
        if (Math.abs(raw) < 0.05) return mk('even', 'EVEN', 'EMA converging \u2014 no trend');
        return mk(null, '', '');
      case 'OBV':
        if (raw > 50) return mk('bull', 'FLOW-UP', 'Heavy accumulation \u2014 buyers loading');
        if (raw < -50) return mk('bear', 'FLOW-DN', 'Distribution \u2014 smart money selling');
        if (Math.abs(raw) < 5) return mk('even', 'EVEN', 'OBV flat \u2014 no conviction');
        return mk(null, '', '');
      case 'VDL':
        if (raw > 1.4) return mk('bull', 'FLOW-UP', 'Buy pressure ' + raw.toFixed(2) + 'x \u2014 scalp with momentum');
        if (raw < 0.7) return mk('bear', 'FLOW-DN', 'Sell pressure ' + raw.toFixed(2) + 'x \u2014 expect DOWN');
        if (raw > 0.95 && raw < 1.05) return mk('even', 'EVEN', 'Volume balanced \u2014 coin flip');
        return mk(null, '', '');
      case 'ATR':
        if (raw > 3) return mk('danger', 'RISK', 'High vol ' + raw.toFixed(1) + '% \u2014 big moves, wide targets');
        if (raw < 0.3) return mk('even', 'EVEN', 'Low vol \u2014 not worth the spread');
        return mk(null, '', '');
      case 'BKI':
        if (raw > 0.35) return mk('bull', 'BOOK-UP', 'Bid wall \u2014 support below, expect UP');
        if (raw < -0.35) return mk('bear', 'BOOK-DN', 'Ask wall \u2014 resistance above, fade');
        return mk(null, '', '');
      case 'AGR':
        if (raw > 65) return mk('bull', 'TAPE-UP', 'Buy aggression ' + raw.toFixed(0) + '% \u2014 tape says UP');
        if (raw < 35) return mk('bear', 'TAPE-DN', 'Sell aggression ' + (100 - raw).toFixed(0) + '% \u2014 tape says DOWN');
        if (raw > 47 && raw < 53) return mk('even', 'EVEN', 'Trade flow 50/50 \u2014 no edge on tape');
        return mk(null, '', '');
      case 'XSP':
        if (raw > 2) return mk('danger', 'RISK', 'Wide spread ' + raw.toFixed(1) + '% \u2014 fragmented liquidity');
        if (raw > 0.5) return mk('danger', 'ARB?', 'Arb spread ' + raw.toFixed(2) + '% \u2014 cross-exchange opportunity');
        return mk(null, '', '');
      case 'CBP':
        if (raw > 0.1) return mk('bull', 'INST-UP', 'CB premium +' + raw.toFixed(2) + '% \u2014 institutional buying');
        if (raw < -0.1) return mk('bear', 'INST-DN', 'CB discount ' + raw.toFixed(2) + '% \u2014 institutional selling');
        return mk(null, '', '');
      case 'TRD':
        if (raw === 'rising') return mk('bull', 'TRND-UP', 'Trend rising \u2014 go with it');
        if (raw === 'falling') return mk('bear', 'TRND-DN', 'Trend falling \u2014 sell rallies');
        return mk('even', 'EVEN', 'Flat \u2014 range-bound, no directional edge');
      case 'FND':
        if (raw < -0.5) return mk('bull', 'POS-UP', 'Funding ' + raw.toFixed(3) + '% \u2014 shorts overcrowded, squeeze risk = expect UP');
        if (raw < -0.1) return mk('bull', 'POS-UP', 'Funding negative ' + raw.toFixed(3) + '% \u2014 bearish positioning, contrarian UP');
        if (raw > 0.3) return mk('bear', 'POS-DN', 'Funding +' + raw.toFixed(3) + '% \u2014 longs overcrowded, expect DOWN');
        if (raw > 0.1) return mk('bear', 'POS-DN', 'Funding elevated +' + raw.toFixed(3) + '% \u2014 longs paying, expect DOWN');
        return mk(null, '', '');
      case 'SQZ':
        if (raw >= 1) {
          if (vals._squeezeType === 'short_squeeze') return mk('bull', raw >= 2 ? 'SQZ-UP' : 'SQ-UP', raw >= 2 ? 'HIGH squeeze risk \u2014 liquidation cascade imminent, trade squeeze UP' : 'Medium squeeze risk \u2014 watch for upward cascade trigger');
          if (vals._squeezeType === 'long_squeeze') return mk('bear', raw >= 2 ? 'SQZ-DN' : 'SQ-DN', raw >= 2 ? 'HIGH squeeze risk \u2014 liquidation cascade imminent, trade squeeze DOWN' : 'Medium squeeze risk \u2014 watch for downward cascade trigger');
          return mk('danger', 'SQZ?', raw >= 2 ? 'HIGH squeeze risk \u2014 liquidation cascade imminent, direction unclear' : 'Medium squeeze risk \u2014 watch for cascade trigger');
        }
        return mk(null, '', '');
      case 'CVD':
        if (raw > 30) return mk('bull', 'FLOW-UP', 'CVD rising sharply \u2014 aggressive buying, momentum scalp');
        if (raw < -30) return mk('bear', 'FLOW-DN', 'CVD falling sharply \u2014 aggressive selling, expect DOWN');
        if (Math.abs(raw) < 5) return mk('even', 'EVEN', 'CVD flat \u2014 no aggressive order flow');
        return mk(null, '', '');
      case 'MKT':
        if (raw === null || raw === undefined) return mk(null, '', '');
        if (raw > 62) return mk('bull', 'MKT-UP', 'Markets imply ' + raw.toFixed(0) + '% UP — Kalshi consensus');
        if (raw < 38) return mk('bear', 'MKT-DN', 'Markets imply ' + (100 - raw).toFixed(0) + '% DOWN — prediction market consensus');
        if (raw > 47 && raw < 53) return mk('even', 'EVEN', 'Markets split ' + raw.toFixed(0) + '/50 — no prediction market edge');
        return mk(null, '', '');
      case 'SNT':
        if (raw === null || raw === undefined) return mk(null, '', '');
        if (raw >= 65) return mk('bull', 'SOC-UP', 'X crowd: +' + raw.toFixed(0) + ' — FOMO building, strong bullish sentiment');
        if (raw >= 35) return mk('bull', 'SOC-UP', 'X crowd: +' + raw.toFixed(0) + ' — positive social flow');
        if (raw <= -65) return mk('bear', 'SOC-DN', 'X crowd: ' + raw.toFixed(0) + ' — fear/panic spreading');
        if (raw <= -35) return mk('bear', 'SOC-DN', 'X crowd: ' + raw.toFixed(0) + ' — negative social flow');
        if (Math.abs(raw) < 15) return mk('even', 'EVEN', 'X crowd: ' + raw.toFixed(0) + ' — mixed, no edge');
        return mk(null, '', '');
      default:
        return mk(null, '', '');
    }
  }

  function renderSuborbital(orb, vals, coinColor) {
    const raw = vals[orb.key];
    const { display, sentiment } = formatSuborbital(orb, raw);
    const shellClass = orb.shell.replace(/[0-9]/g, '');
    const sig = evaluateSignal(orb, raw, vals);

    const flashClass = sig.signal === 'bull' ? 'flash-bull' : sig.signal === 'bear' ? 'flash-bear' : sig.signal === 'danger' ? 'flash-danger' : sig.signal === 'even' ? 'dead-flat' : '';
    const tagHtml = sig.signal ? `<span class="cfm-signal-tag ${sig.signal}">${sig.tag || sig.signal}</span>` : '';

    return `
      <div class="cfm-element ${sentiment} ${flashClass}" title="${orb.desc}${sig.reason ? '\n\u26a1 ' + sig.reason : ''}">
        <span class="cfm-atomic">${orb.num}</span>
        <span class="cfm-shell ${shellClass}">${orb.shell}</span>
        <div class="cfm-sym" style="color:${coinColor}">${orb.sym}</div>
        <div class="cfm-name">${orb.name}</div>
        <div class="cfm-rate" style="color:${sentiment === 'bull' ? 'var(--color-green)' : sentiment === 'bear' ? 'var(--color-red)' : 'var(--color-text)'}">${display}</div>
        <div class="cfm-pulse live"></div>
        ${tagHtml}
      </div>
    `;
  }

  function formatSuborbital(orb, raw) {
    if (raw === undefined || raw === null || (typeof raw === 'number' && !isFinite(raw))) return { display: '\u2014', sentiment: 'flat' };
    if (typeof raw === 'number') raw = Number(raw); // ensure clean number
    switch (orb.fmt) {
      case 'price': return { display: fmtPrice(raw), sentiment: 'flat' };
      case 'num1': {
        const s = raw > 70 ? 'bear' : raw < 30 ? 'bull' : raw > 55 ? 'bull' : raw < 45 ? 'bear' : 'flat';
        return { display: raw.toFixed(1), sentiment: s };
      }
      case 'pct2': return { display: raw.toFixed(2) + '%', sentiment: raw > 2 ? 'warn' : 'flat' };
      case 'pct3': return { display: (raw >= 0 ? '+' : '') + raw.toFixed(3) + '%', sentiment: raw > 0.03 ? 'bull' : raw < -0.03 ? 'bear' : 'flat' };
      case 'pct4': return { display: raw.toFixed(4) + '%', sentiment: raw > 0.05 ? 'warn' : 'flat' };
      case 'sign2': return { display: (raw >= 0 ? '+' : '') + raw.toFixed(2), sentiment: raw > 1 ? 'bull' : raw < -1 ? 'bear' : 'flat' };
      case 'sign4': return { display: (raw >= 0 ? '+' : '') + raw.toFixed(4), sentiment: raw > 0 ? 'bull' : raw < 0 ? 'bear' : 'flat' };
      case 'ratio': return { display: raw.toFixed(2) + 'x', sentiment: raw > 1.15 ? 'bull' : raw < 0.85 ? 'bear' : 'flat' };
      case 'trend': return { display: String(raw).charAt(0).toUpperCase() + String(raw).slice(1), sentiment: raw === 'rising' ? 'bull' : raw === 'falling' ? 'bear' : 'flat' };
      case 'of4': return { display: raw + '/4', sentiment: raw >= 3 ? 'bull' : raw <= 1 ? 'warn' : 'flat' };
      case 'pct1': {
        const s = raw > 60 ? 'bull' : raw < 40 ? 'bear' : 'flat';
        return { display: raw.toFixed(1) + '%', sentiment: s };
      }
      case 'prob1': {
        // Probability 0–1 stored in key, displayed as percentage
        const pct = raw * 100;
        const s = pct > 62 ? 'bull' : pct < 38 ? 'bear' : 'flat';
        return { display: pct.toFixed(0) + '%', sentiment: s };
      }
      case 'compactUsd': {
        if (raw >= 1e9) return { display: '$' + (raw / 1e9).toFixed(1) + 'B', sentiment: 'flat' };
        if (raw >= 1e6) return { display: '$' + (raw / 1e6).toFixed(1) + 'M', sentiment: 'flat' };
        if (raw >= 1e3) return { display: '$' + (raw / 1e3).toFixed(0) + 'K', sentiment: 'flat' };
        return { display: raw > 0 ? '$' + raw.toFixed(0) : '\u2014', sentiment: 'flat' };
      }
      case 'fundingRate': {
        const s = raw > 0.3 ? 'warn' : raw < -0.3 ? 'warn' : raw > 0.01 ? 'bull' : raw < -0.01 ? 'bear' : 'flat';
        return { display: (raw >= 0 ? '+' : '') + raw.toFixed(3) + '%', sentiment: s };
      }
      case 'squeeze': {
        if (raw >= 2) return { display: 'HIGH', sentiment: 'warn' };
        if (raw >= 1) return { display: 'MED', sentiment: 'warn' };
        return { display: 'LOW', sentiment: 'flat' };
      }
      case 'sentiment': {
        // X.com score: -100 to +100
        const s = raw >= 35 ? 'bull' : raw <= -35 ? 'bear' : 'flat';
        return { display: (raw >= 0 ? '+' : '') + Math.round(raw).toString(), sentiment: s };
      }
      default: return { display: String(raw), sentiment: 'flat' };
    }
  }

  // Quick MACD from cfm sample momentum (approximation from VWAP-TWAP divergence)
  function computeQuickMACD(cfm) {
    if (!cfm || !cfm.vwap15 || !cfm.twap15) return 0;
    return ((cfm.vwap15 - cfm.twap15) / cfm.twap15) * 100;
  }

  // ================================================================
  // VIEW: PREDICTIONS
  // ================================================================

  let predsLoaded = false;

  // ================================================================
  // QUICK DECISION PANEL — compact scannable strip at top of Predictions
  // ================================================================

  // Returns { primary, secondary } rationale strings for the decision band.
  // Priority: mean-reversion > strong trend > band stretch > VWAP > MACD > OBV > volume > market > generic
  function getDecisionRationale(pred) {
    const ind = pred?.indicators || {};
    const dir = predictionDirection(pred);
    const rsi = ind.rsi?.value;
    const adx = ind.adx?.adx;
    const bbPos = ind.bands?.position;
    const vwapDev = ind.vwap?.value;
    const stochK = ind.stochrsi?.k;
    const mfi = ind.mfi?.value;
    const obvSlope = ind.obv?.slope;
    const buyPct = ind.volume?.buyPct;

    let primary = '';
    let secondary = '';

    // ---- 0. Kalshi market odds — primary ground truth ────────────────────
    // YES price from Kalshi 15M series = crowd-implied probability price ≥ ref
    const _kCoinR = window.PredictionMarkets?.getCoin(pred?.sym);
    const _kProbR = _kCoinR?.kalshi15m?.probability ?? _kCoinR?.combinedProb ?? null;
    const _strikeR = _kCoinR?.kalshi15m?.strikeDir === 'below' ? 'below' : 'above';
    const _yesDirR = _strikeR === 'below' ? 'DOWN' : 'UP';
    const _noDirR = _yesDirR === 'UP' ? 'DOWN' : 'UP';
    if (_kProbR !== null) {
      const kp = Math.round(_kProbR * 100);
      if (_kProbR >= 0.68) primary = `Kalshi ${kp}% YES — crowd strongly pricing ${_yesDirR} for this strike`;
      else if (_kProbR <= 0.32) primary = `Kalshi ${100 - kp}% NO — crowd strongly pricing ${_noDirR}`;
      else if (_kProbR >= 0.55) primary = `Kalshi ${kp}% YES — market leans ${_yesDirR}`;
      else if (_kProbR <= 0.45) primary = `Kalshi ${100 - kp}% NO — market leans ${_noDirR}`;
      else primary = `Kalshi near 50/50 (${kp}%) — uncertain, model drives verdict`;
    }

    if (!primary) {
      if (rsi != null && rsi < 30 && dir >= 0) {
        primary = `Mean reversion — RSI ${rsi.toFixed(0)}, oversold bounce`;
      } else if (rsi != null && rsi > 70 && dir <= 0) {
        primary = `Mean reversion — RSI ${rsi.toFixed(0)}, overbought fade`;
      } else if (stochK != null && stochK < 15 && dir >= 0) {
        primary = `StochRSI oversold — ${stochK.toFixed(0)}, reversal setup`;
      } else if (stochK != null && stochK > 85 && dir <= 0) {
        primary = `StochRSI overbought — ${stochK.toFixed(0)}, pullback risk`;
      } else if (mfi != null && mfi < 20 && dir >= 0) {
        primary = `MFI oversold — money flow exhausted, bounce likely`;
      } else if (mfi != null && mfi > 80 && dir <= 0) {
        primary = `MFI overbought — smart money distributing`;

        // ---- 2. Strong trend (ADX > 25) ----
      } else if (adx != null && adx > 28) {
        if (dir > 0) primary = `Strong uptrend — ADX ${adx.toFixed(0)}, trend continuation`;
        else if (dir < 0) primary = `Strong downtrend — ADX ${adx.toFixed(0)}, trend continuation`;
        else primary = `Trending market — ADX ${adx.toFixed(0)}, direction unclear`;

        // ---- 3. Bollinger Band stretch ----
      } else if (bbPos != null && bbPos >= 0.88) {
        primary = dir <= 0 ? `Upper-band stretch — overextended, reversion risk` : `Upper-band breakout — momentum expanding`;
      } else if (bbPos != null && bbPos <= 0.12) {
        primary = dir >= 0 ? `Lower-band stretch — oversold, snap-back setup` : `Lower-band breakdown — momentum extending`;

        // ---- 4. VWAP deviation ----
      } else if (vwapDev != null && Math.abs(vwapDev) > 1.2) {
        if (vwapDev > 0 && dir <= 0) primary = `VWAP extended — ${vwapDev.toFixed(1)}% above, mean reversion`;
        else if (vwapDev < 0 && dir >= 0) primary = `VWAP discount — ${Math.abs(vwapDev).toFixed(1)}% below, reversion bid`;
        else if (vwapDev > 0) primary = `VWAP momentum — price ${vwapDev.toFixed(1)}% above, bulls in control`;
        else primary = `VWAP breakdown — price ${Math.abs(vwapDev).toFixed(1)}% below VWAP`;

        // ---- 5. MACD ----
      } else if (ind.macd?.sig != null) {
        const hist = ind.macd.histogram;
        if (ind.macd.sig > 0 && hist > 0) primary = `MACD bull cross — histogram expanding, momentum building`;
        else if (ind.macd.sig < 0 && hist < 0) primary = `MACD bear cross — histogram deepening, sellers in control`;
        else if (ind.macd.sig > 0) primary = `MACD bullish — signal line above zero`;
        else if (ind.macd.sig < 0) primary = `MACD bearish — signal line below zero`;

        // ---- 6. EMA ----
      } else if (ind.ema?.value != null) {
        if (ind.ema.value > 0.15) primary = `EMA bull cross — short above long, trend aligning`;
        else if (ind.ema.value < -0.15) primary = `EMA bear cross — short below long, trend falling`;
        else primary = `EMA converging — breakout pending`;

        // ---- Generic fallback ----
      } else {
        if (pred?.signal === 'strong_bull') primary = `Strong buy — multiple indicators aligned UP`;
        else if (pred?.signal === 'strong_bear') primary = `Strong sell — multiple indicators aligned DOWN`;
        else if (pred?.signal === 'bullish') primary = `Bullish bias — majority of signals positive`;
        else if (pred?.signal === 'bearish') primary = `Bearish bias — majority of signals negative`;
        else primary = `Mixed signals — insufficient confluence`;
      }
    } // end !primary

    // ---- Secondary: pick the next most relevant fact ----
    if (obvSlope != null) {
      secondary = obvSlope > 0 ? `OBV: accumulation in progress` : `OBV: distribution detected`;
    } else if (buyPct != null && buyPct > 62) {
      secondary = `Volume: ${buyPct.toFixed(0)}% buy-side pressure`;
    } else if (buyPct != null && buyPct < 38) {
      secondary = `Volume: ${(100 - buyPct).toFixed(0)}% sell-side pressure`;
    } else if (ind.ichimoku?.label) {
      secondary = `Ichimoku: ${ind.ichimoku.label}`;
    } else if (ind.mktSentiment?.combined != null) {
      const pct = Math.round(ind.mktSentiment.combined * 100);
      secondary = `Prediction markets: ${pct}% UP probability`;
    } else if (ind.adx?.adx != null && !primary.includes('ADX')) {
      const trending = ind.adx.adx > 20;
      secondary = trending ? `ADX ${ind.adx.adx.toFixed(0)} — ${ind.adx.label.toLowerCase()}` : `ADX ${ind.adx.adx.toFixed(0)} — ranging / consolidation`;
    } else if (rsi != null && !primary.includes('RSI')) {
      secondary = `RSI ${rsi.toFixed(0)} — ${ind.rsi.label}`;
    }

    return { primary, secondary };
  }

  function buildQuickDecisionPanel(predArr) {
    if (!predArr || predArr.length === 0) return '';

    const ordered = PREDICTION_COINS
      .map(c => predArr.find(p => p.sym === c.sym))
      .filter(Boolean);

    let upCount = 0, downCount = 0, neutralCount = 0;

    const cards = ordered.map(pred => {
      const dir = predictionDirection(pred);
      const dirClass = dir > 0 ? 'up' : dir < 0 ? 'down' : 'neutral';
      const arrow = dir > 0 ? '▲' : dir < 0 ? '▼' : '→';
      const label = dir > 0 ? 'UP' : dir < 0 ? 'DOWN' : 'FLAT';
      const score = Number.isFinite(pred.score) ? (pred.score > 0 ? '+' : '') + pred.score.toFixed(2) : '—';
      const horizon = pred.backtest?.summary?.preferredHorizon ? `${pred.backtest.summary.preferredHorizon}m` : '';
      const mkt = pred.indicators?.mktSentiment;
      const kPct = mkt?.kalshi != null ? Math.round(mkt.kalshi * 100) : null;
      const pPct = mkt?.poly != null ? Math.round(mkt.poly * 100) : null;
      const mktRow = (kPct != null || pPct != null) ? `
        <div class="dc-mkt-row">
          ${kPct != null ? `<span class="dc-badge-k">K:${kPct}%</span>` : ''}
          ${pPct != null ? `<span class="dc-badge-p">P:${pPct}%</span>` : ''}
        </div>` : '';

      // Ground state synthesis for this coin
      const coin = PREDICTION_COINS.find(c => c.sym === pred.sym);
      const wClass = COIN_WEIGHT[pred.sym] || 'light';
      const cfmSnap = window.CFMEngine?.getAll?.()?.[pred.sym];
      const gsVals = cfmSnap ? {
        ...cfmSnap,
        _emaCross: pred.indicators?.ema?.value ?? 0,
        _obvSlope: pred.indicators?.obv?.slope ?? 0,
        _volRatio: pred.indicators?.volume?.ratio ?? 1,
        _bookImbal: pred.indicators?.book?.imbalance ?? 0,
        _aggrBuy: pred.indicators?.flow?.buyRatio ?? 50,
        _funding: pred.derivatives?.funding ?? 0,
        _cvdSlope: pred.cvd?.slope ?? 0,
        _squeezeScore: pred.squeeze ? (pred.squeeze.severity === 'high' ? 2 : 1) : 0,
        _squeezeType: pred.squeeze?.type ?? null,
        _cbPremium: cfmSnap.sources?.CB > 0 && cfmSnap.cfmRate > 0 ? ((cfmSnap.sources.CB - cfmSnap.cfmRate) / cfmSnap.cfmRate) * 100 : 0,
        _mktConsensus: window.PredictionMarkets?.getCoin(pred.sym)?.combinedProb ?? null,
        _xSentiment: window.SocialSentiment?.getCoin(pred.sym)?.score ?? null,
      } : null;
      const gs = gsVals ? computeGroundState(gsVals, pred, wClass) : null;
      const eq = gs ? computeEntryQuality(gs, detectMarketRegime(pred), pred) : null;

      const gsRow = gs ? `
        <div class="dc-gs-row">
          <span class="dc-gs-score ${gs.dir}" title="Ground state: ${gs.stateLabel}">${gs.dir === 'up' ? '▲' : gs.dir === 'down' ? '▼' : '—'} ${gs.score >= 0 ? '+' : ''}${gs.score.toFixed(2)}</span>
          <span class="gs-grade ${eq?.cls || 'wait'}">${eq?.label || '—'}</span>
          ${gs.conflicted ? `<span class="dc-conflict">⚠ CONFLICT</span>` : ''}
        </div>` : '';

      const { primary, secondary } = getDecisionRationale(pred);

      if (dir > 0) upCount++; else if (dir < 0) downCount++; else neutralCount++;

      return `
        <div class="decision-card ${dirClass}${gs?.conflicted ? ' conflicted' : ''}" data-scroll-pred="${pred.sym}" title="${pred.sym} — ${label}  score ${score}">
          <span class="dc-sym">${pred.sym}</span>
          <span class="dc-arrow">${arrow}</span>
          <span class="dc-label">${label}</span>
          <span class="dc-score">${score}</span>
          ${horizon ? `<span class="dc-horizon">${horizon}</span>` : ''}
          ${mktRow}
          ${gsRow}
          ${primary ? `<span class="dc-rationale-primary">${primary}</span>` : ''}
          ${secondary ? `<span class="dc-rationale-secondary">${secondary}</span>` : ''}
          ${pred.llm?.narration ? `<span class="dc-rationale-llm" style="color:var(--color-primary); font-style:italic; font-size: 0.9em; display:block; margin-top:4px;">✨ ${pred.llm.narration}</span>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="decision-band">
        <div class="decision-band-header">
          <span class="decision-band-title">⚡ Market Calls</span>
          <div class="decision-band-tally">
            <span class="tally-up">${upCount} ▲ UP</span>
            <span class="tally-down">${downCount} ▼ DOWN</span>
            <span class="tally-flat">${neutralCount} → FLAT</span>
          </div>
        </div>
        <div class="decision-band-coins">
          ${cards}
        </div>
      </div>`;
  }

  // ── Kalshi Live Debug Panel ──────────────────────────────────────────────
  // Shows in the predictions view: per-coin contract state, last 5 errors,
  // last 5 resolutions. Collapsed by default, toggled by clicking the header.
  function buildKalshiDebugPanel() {
    try {
      const snaps = window._lastKalshiSnapshot || {};
      const log = (window._kalshiLog || []).slice(-20).reverse();
      const errors = (window._kalshiErrors || []).slice(-8).reverse();
      const resLog = (window._15mResolutionLog || []).slice(-10).reverse();
      const orchLog = (window._orchLog || []).slice(-15).reverse();

      const fmtPrice = v => v != null && v > 0 ? `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '–';
      const fmtPct = v => v != null ? `${v}%` : '–';
      const fmtTime = ms => ms ? new Date(ms).toISOString().slice(11, 19) : '–';
      const fmtScore = v => v != null ? (v > 0 ? '+' : '') + Number(v).toFixed(3) : '–';
      const fmtEdge = v => v != null ? (v >= 0 ? '+' : '') + v + '¢' : '–';
      const ok = v => v === true
        ? '<span style="color:#4caf50;font-weight:700">✓</span>'
        : v === false ? '<span style="color:#f44336;font-weight:700">✗</span>'
          : '<span style="color:#666">?</span>';
      const colDir = v => (v === 'UP' || v === 'up') ? 'color:#4caf50'
        : (v === 'DOWN' || v === 'down') ? 'color:#f44336' : 'color:#888';
      const colAct = a => a === 'trade' ? 'color:#4caf50;font-weight:700'
        : a === 'watch' ? 'color:#ffc107'
          : a === 'skip' ? 'color:#f44336'
            : a === 'hold' ? 'color:#80cbc4'
              : a === 'earlyExit' ? 'color:#e040fb' : 'color:#888';
      const alignColor = al => ({
        ALIGNED: '#4caf50', DIVERGENT: '#ff9800', MODEL_LEADS: '#4f9eff',
        CROWD_FADE: '#e040fb', MODEL_ONLY: '#80cbc4', KALSHI_ONLY: '#ffc107',
        SHELL_EVAL: '#ff5722', EARLY_EXIT: '#888',
      }[al] || '#aaa');

      const th = 'style="color:#888;font-size:10px;font-weight:600;padding:3px 6px;border-bottom:1px solid #2a2a2a;white-space:nowrap"';
      const tdBase = 'padding:3px 6px;font-size:11px;border-bottom:1px solid #1a1a1a';
      const td = `style="${tdBase}"`;
      const tbl = 'width:100%;border-collapse:collapse;margin-bottom:8px';

      // Orchestrator state is updated in the prediction render path. Keep this
      // panel read-only so frequent renders cannot recursively churn live state.

      // ── 1. ORCHESTRATOR LIVE ──────────────────────────────────────────────
      const suppressionCounts = {};
      const stageFailCounts = {};
      const actionCounts = { trade: 0, watch: 0, hold: 0, skip: 0, earlyExit: 0, other: 0 };
      const liveOrchRows = PREDICTION_COINS.map(coin => {
        try {
          const ki = window.KalshiOrchestrator?.getIntent?.(coin.sym);
          if (!ki) return `<tr><td style="${tdBase};color:#fff;font-weight:700">${coin.sym}</td>
            <td colspan="9" style="${tdBase};color:#555;font-size:10px">no data — waiting for first prediction cycle</td></tr>`;
          const actionKey = actionCounts[ki.action] != null ? ki.action : 'other';
          actionCounts[actionKey] += 1;
          const minsStr = ki.minsLeft != null ? ki.minsLeft.toFixed(1) + 'm'
            : ki.secsLeft != null ? ki.secsLeft.toFixed(0) + 's' : '–';
          const flags = (ki.sweetSpot ? '⭐' : '') + (ki.crowdFade ? '🔄' : '') + (ki.signalLocked ? '🔒' : '');
          const failedStages = Array.isArray(ki.stageDiagnostics?.stages)
            ? ki.stageDiagnostics.stages.filter(stage => stage && stage.passed === false)
            : [];
          failedStages.forEach(stage => {
            stageFailCounts[stage.name] = (stageFailCounts[stage.name] || 0) + 1;
          });
          const blockerReasons = []
            .concat(Array.isArray(ki.blockedBy) ? ki.blockedBy : [])
            .concat(Array.isArray(ki.stageDiagnostics?.suppressionReasons) ? ki.stageDiagnostics.suppressionReasons : []);
          blockerReasons.filter(Boolean).forEach(reason => {
            suppressionCounts[reason] = (suppressionCounts[reason] || 0) + 1;
          });
          const stageSummary = failedStages.length
            ? failedStages.map(stage => stage.name).slice(0, 2).join(', ')
            : 'pass';
          const blockerSummary = blockerReasons.length
            ? blockerReasons.slice(0, 2).join(' · ')
            : '—';
          return `<tr>
            <td style="${tdBase};color:#fff;font-weight:700">${coin.sym}</td>
            <td style="${tdBase};${colAct(ki.action)}">${(ki.action || '–').toUpperCase()}</td>
            <td style="${tdBase};${ki.side === 'YES' ? 'color:#4caf50' : ki.side === 'NO' ? 'color:#f44336' : 'color:#888'};font-weight:700">${ki.side ?? '–'}</td>
            <td style="${tdBase};color:${alignColor(ki.alignment)};font-size:10px">${ki.alignment ?? '–'}</td>
            <td style="${tdBase};color:${(ki.edgeCents ?? 0) >= 7 ? '#4caf50' : '#f44336'}">${fmtEdge(ki.edgeCents)}</td>
            <td style="${tdBase};${colDir(ki.direction)}">${fmtScore(ki.modelScore)}</td>
            <td style="${tdBase};color:#888">${minsStr}</td>
            <td style="${tdBase};font-size:12px">${flags || '–'}</td>
            <td style="${tdBase};font-size:10px;color:${failedStages.length ? '#ff9800' : '#4caf50'}">${stageSummary}</td>
            <td style="${tdBase};font-size:10px;color:#aaa;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${blockerSummary}</td>
          </tr>`;
        } catch (e) {
          return `<tr><td style="${tdBase};color:#fff">${coin.sym}</td><td colspan="9" style="${tdBase};color:#f44336;font-size:10px">render error: ${e.message}</td></tr>`;
        }
      }).join('');
      const topSuppressions = Object.entries(suppressionCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([reason, count]) => `<span style="padding:2px 6px;border:1px solid #2a2a2a;border-radius:9999px;font-size:10px;color:#aaa">${count}× ${escapeHtml(reason)}</span>`)
        .join('') || '<span style="font-size:10px;color:#666">No suppression reasons collected yet</span>';
      const topStageFailures = Object.entries(stageFailCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name}:${count}`)
        .join(' · ') || 'none';
      const suppressionSummary = `
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 8px">
          <span style="font-size:10px;color:#888">Actions → trade:${actionCounts.trade} watch:${actionCounts.watch} hold:${actionCounts.hold} skip:${actionCounts.skip} exit:${actionCounts.earlyExit}</span>
          <span style="font-size:10px;color:#888">Stage fails → ${escapeHtml(topStageFailures)}</span>
          ${topSuppressions}
        </div>
      `;

      // ── 2. ACCURACY SCORECARD ─────────────────────────────────────────────
      const scorecardRows = PREDICTION_COINS.map((coin, idx) => {
        try {
          // Count all contracts with outcome (resolved), not just those marked _settled
          const entries = (window._kalshiLog || []).filter(e => e.sym === coin.sym && e.outcome);
          const resE = (window._15mResolutionLog || []).filter(e => e.sym === coin.sym && e.modelCorrect !== null);

          // ADD HISTORICAL DATA FROM CALCULATOR
          const historical = (window.getHistoricalContracts?.() || [])
            .filter(h => h.symbol === coin.sym && (h.modelCorrect !== null || h.outcome));

          const total = entries.length + resE.length + historical.length;
          if (!total) return `<tr><td style="${tdBase};color:#fff;font-weight:700">${coin.sym}</td>
            <td colspan="5" style="${tdBase};color:#555;font-size:10px">no settled data yet</td></tr>`;
          const modelOk = entries.filter(e => e.modelCorrect === true).length + resE.filter(e => e.modelCorrect === true).length + historical.filter(h => h.modelCorrect === true).length;
          const mktOk = entries.filter(e => e.marketCorrect === true).length + resE.filter(e => e.marketCorrect === true).length;
          const fadeE = entries.filter(e => e.fadeActive && e.fadeCorrect !== null);
          const fadeOk = fadeE.filter(e => e.fadeCorrect === true).length;
          const modelPct = Math.round(modelOk / total * 100);
          const mktPct = Math.round(mktOk / total * 100);
          const fadePct = fadeE.length ? Math.round(fadeOk / fadeE.length * 100) : null;
          const last8 = [...entries, ...resE, ...historical].sort((a, b) => (b.settledTs || b.ts || 0) - (a.settledTs || a.ts || 0)).slice(0, 8);
          const l8ok = last8.filter(e => e.modelCorrect === true).length;
          const trend = last8.length >= 4 ? (l8ok / last8.length >= 0.6 ? '↑' : l8ok / last8.length <= 0.35 ? '↓' : '→') : '?';
          const tC = trend === '↑' ? '#4caf50' : trend === '↓' ? '#f44336' : '#ffc107';
          const mC = modelPct >= 55 ? '#4caf50' : modelPct >= 45 ? '#ffc107' : '#f44336';
          const fC = fadePct == null ? '#555' : fadePct >= 55 ? '#4caf50' : fadePct >= 45 ? '#ffc107' : '#f44336';

          // Build debug context: split last contracts by UP/DOWN
          const allContracts = [...entries, ...resE, ...historical].sort((a, b) => (b.ts || b.settledTs || 0) - (a.ts || a.settledTs || 0));
          const resolvedDir = (e) => e.actualOutcome || e.modelDir || e.direction || null;
          const ups = allContracts.filter(e => resolvedDir(e) === 'UP').slice(0, 3);
          const downs = allContracts.filter(e => resolvedDir(e) === 'DOWN').slice(0, 3);

          const detailsId = `scorecard-${coin.sym}-${idx}`;
          const debugHtml = `
            <div style="margin:6px 0;padding:8px;background:#0a0a0a;border-left:3px solid #80cbc4;font-size:10px;border-radius:4px">
              <div style="color:#80cbc4;font-weight:700;margin-bottom:6px">📊 Up/Down Debug Context for ${coin.sym}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div style="border-right:1px solid #222">
                  <div style="color:#4caf50;font-weight:600;margin-bottom:3px;font-size:9px">🔼 UP (${ups.length})</div>
                  ${ups.map(u => {
            const correct = u.modelCorrect === true ? '✓' : u.modelCorrect === false ? '✗' : '?';
            const dir = u.modelDir || u.direction || '?';
            const actual = u.actualOutcome || u._kalshiResult || u.kalshiResult || u.outcome || '?';
            const ts = new Date(u.ts || u.settledTs || 0).toISOString().slice(11, 19);
            return `<div style="font-size:9px;color:#aaa;margin:2px 0;padding:2px 4px;background:rgba(76,175,80,0.1);border-radius:2px">${correct} pred=${dir} result=${actual} <span style="color:#666">${ts}</span></div>`;
          }).join('')}
                  ${ups.length === 0 ? '<div style="font-size:9px;color:#555">—</div>' : ''}
                </div>
                <div>
                  <div style="color:#f44336;font-weight:600;margin-bottom:3px;font-size:9px">🔽 DOWN (${downs.length})</div>
                  ${downs.map(d => {
            const correct = d.modelCorrect === true ? '✓' : d.modelCorrect === false ? '✗' : '?';
            const dir = d.modelDir || d.direction || '?';
            const actual = d.actualOutcome || d._kalshiResult || d.kalshiResult || d.outcome || '?';
            const ts = new Date(d.ts || d.settledTs || 0).toISOString().slice(11, 19);
            return `<div style="font-size:9px;color:#aaa;margin:2px 0;padding:2px 4px;background:rgba(244,67,54,0.1);border-radius:2px">${correct} pred=${dir} result=${actual} <span style="color:#666">${ts}</span></div>`;
          }).join('')}
                  ${downs.length === 0 ? '<div style="font-size:9px;color:#555">—</div>' : ''}
                </div>
              </div>
            </div>
          `;

          return `<tr style="background:rgba(128,203,196,0.02)">
            <td style="${tdBase};color:#fff;font-weight:700;cursor:pointer;user-select:none;padding:6px;border-radius:4px 0 0 4px" 
                onclick="const d=document.getElementById('${detailsId}');d.style.display=d.style.display==='none'?'table-row':'none'">
              ${coin.sym} <span style="color:#666;font-size:9px">▸</span>
            </td>
            <td style="${tdBase};color:#888">${total}</td>
            <td style="${tdBase};color:${mC};font-weight:700">${modelPct}%</td>
            <td style="${tdBase};color:#888">${mktPct}%</td>
            <td style="${tdBase};color:${fC}">${fadePct != null ? fadePct + '% (' + fadeE.length + ')' : '–'}</td>
            <td style="${tdBase};color:${tC};font-weight:700;border-radius:0 4px 4px 0">${trend} ${last8.length}/${8}</td>
          </tr>
          <tr id="${detailsId}" style="display:none;background:#0a0a0a">
            <td colspan="6" style="padding:0 6px 6px 6px;border:1px solid #1a1a1a;border-radius:0 0 4px 4px">
              ${debugHtml}
            </td>
          </tr>`;
        } catch (e) {
          return `<tr><td style="${tdBase};color:#fff">${coin.sym}</td><td colspan="5" style="${tdBase};color:#f44336;font-size:10px">err: ${e.message}</td></tr>`;
        }
      }).join('');

      // ── 3. CURRENT SNAPSHOTS ──────────────────────────────────────────────
      const snapRows = Object.entries(snaps).map(([sym, s]) => {
        if (!s) return '';
        const conflict = s.dirConflict ? '⚠️' : '';
        const confCol = s.dirConflict ? 'color:#f44336;font-weight:700' : 'color:#4caf50';
        const fadeTag = s.fadeActive
          ? (s.fadeSolid ? '<span style="color:#ff9800;font-weight:700">🔥FADE</span>'
            : '<span style="color:#ffc107">~fade</span>') : '';
        return `<tr>
          <td style="${tdBase};color:#fff;font-weight:600">${sym}</td>
          <td style="${tdBase}">${fmtPrice(s.floorPrice || s.ref)}</td>
          <td style="${tdBase};${s.strikeDir === 'below' ? 'color:#f44336' : 'color:#4caf50'}">${s.strikeDir || 'above'}</td>
          <td style="${tdBase};${colDir(s.modelDir)}">${s.modelDir || '–'}</td>
          <td style="${tdBase}">${fmtPct(s.mYesPct)}</td>
          <td style="${tdBase}">${fmtPct(s.kYesPct)}</td>
          <td style="${tdBase};${confCol}">${conflict}${s.cdfImpliedDir || '–'}</td>
          <td style="${tdBase};font-size:10px">${fadeTag || '–'}</td>
          <td style="${tdBase};color:#888;font-size:10px">${fmtTime(s.closeTimeMs)}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="9" style="${tdBase};color:#666;text-align:center">No snapshots yet</td></tr>`;

      // ── 4. CONTRACT LOG ───────────────────────────────────────────────────
      const logRows = log.slice(0, 10).map(e => {
        if (!e) return '';
        const settled = e._settled
          ? `<span style="color:#4caf50">✓${e._kalshiResult || ''}</span>`
          : (e._pendingAuth ? '<span style="color:#ffc107">⏳</span>' : '–');
        const match = e._settled
          ? (e._proxyMismatch ? '<span style="color:#f44336">MM</span>' : '<span style="color:#4caf50">✓</span>') : '';
        const fadeCol = e.fadeActive
          ? (e.fadeCorrect === true ? '<span style="color:#4caf50">F✓</span>'
            : e.fadeCorrect === false ? '<span style="color:#f44336">F✗</span>'
              : '<span style="color:#ff9800">F?</span>')
          : '<span style="color:#555">–</span>';
        const mdivBadge = e.mdivPhase && e.mdivPhase !== 'STALE'
          ? `<span style="font-size:9px;color:#888">${e.mdivPhase}</span>` : '–';
        const betTag = e.betAction
          ? `<span style="color:${e.betAction === 'YES' ? '#4caf50' : '#f44336'};font-weight:700">${e.betAction}</span>` : '–';
        const flags = [e._wickStraddle ? '🔥' : '', e._nearRef ? '≈' : '', e._dirConflict ? '⚠️' : ''].filter(Boolean).join('');
        return `<tr>
          <td style="${tdBase};color:#fff;font-weight:700">${e.sym}</td>
          <td style="${tdBase};${e.outcome === 'YES' ? 'color:#4caf50' : 'color:#f44336'}">${e.outcome || '–'}</td>
          <td style="${tdBase};color:#888;font-size:10px">${fmtPrice(e.ref)}</td>
          <td style="${tdBase};color:#aaa;font-size:10px">${e.refDiffPct != null ? e.refDiffPct.toFixed(3) + '%' : '–'}</td>
          <td style="${tdBase};${colDir(e.modelDir)}">${fmtScore(e.modelScore)}</td>
          <td style="${tdBase}">${betTag}</td>
          <td style="${tdBase}">${fadeCol}</td>
          <td style="${tdBase};font-size:10px">${mdivBadge}</td>
          <td style="${tdBase}">${settled}${match}</td>
          <td style="${tdBase};color:#ffc107;font-size:10px">${flags || '–'}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="10" style="${tdBase};color:#666;text-align:center">No contract log entries yet</td></tr>`;

      // ── 5. SETTLED CONTRACTS ─────────────────────────────────────────────
      const resRows = resLog.map(r => {
        const missedTag = r.missedOpportunity
          ? '<span style="color:#e040fb;font-size:9px">MISSED</span>' : '';
        const orchTag = r.orchestratorAction === 'trade'
          ? '<span style="color:#4caf50;font-size:9px">TRADED</span>' : '';
        return `<tr>
          <td style="${tdBase};color:#fff;font-weight:700">${r.sym}</td>
          <td style="${tdBase};color:${r.actualOutcome === 'UP' ? '#4caf50' : '#f44336'};font-weight:700">${r.actualOutcome || '–'}</td>
          <td style="${tdBase};color:#888;font-size:10px">${r.kalshiResult || '–'}</td>
          <td style="${tdBase}">${r.modelDir || '–'} ${ok(r.modelCorrect)}</td>
          <td style="${tdBase};${colAct(r.orchestratorAction)};font-size:10px">${r.orchestratorAction || '–'} ${orchTag}${missedTag}</td>
          <td style="${tdBase};color:${(r.edgeCents ?? 0) >= 8 ? '#4caf50' : '#888'}">${fmtEdge(r.edgeCents)}</td>
          <td style="${tdBase};font-size:10px;color:#aaa">${r.cbSettlePrice ? '$' + Number(r.cbSettlePrice).toLocaleString() : fmtPrice(r.floorPrice || r.refPrice)}</td>
          <td style="${tdBase};color:${(r.confidence ?? 0) >= 90 ? '#4caf50' : '#ffc107'};font-size:10px">${r.confidence != null ? r.confidence + '%' : '–'}</td>
          <td style="${tdBase};color:#888;font-size:10px">${fmtTime(r.settledTs)}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="9" style="${tdBase};color:#666;text-align:center">No settled contracts yet — first settlement fires ~2 min after contract close_time</td></tr>`;

      // ── 6. ORCHESTRATOR HISTORY ──────────────────────────────────────────
      const orchLogRows = orchLog.slice(0, 12).map(e => {
        const flags = (e.sweetSpot ? '⭐' : '') + (e.crowdFade ? '🔄' : '') + (e.signalLocked ? '🔒' : '');
        return `<tr>
          <td style="${tdBase};color:#fff;font-weight:700">${e.sym}</td>
          <td style="${tdBase};${colAct(e.action)}">${(e.action || '–').toUpperCase()}</td>
          <td style="${tdBase};${e.side === 'YES' ? 'color:#4caf50' : e.side === 'NO' ? 'color:#f44336' : 'color:#888'}">${e.side ?? '–'}</td>
          <td style="${tdBase};color:${alignColor(e.alignment)};font-size:10px">${e.alignment ?? '–'}</td>
          <td style="${tdBase};color:${(e.edgeCents ?? 0) >= 8 ? '#4caf50' : '#888'}">${fmtEdge(e.edgeCents)}</td>
          <td style="${tdBase};${colDir(e.direction)}">${fmtScore(e.modelScore)}</td>
          <td style="${tdBase};color:#888;font-size:10px">${fmtTime(e.ts)}</td>
          <td style="${tdBase};font-size:12px">${flags || '–'}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="8" style="${tdBase};color:#666;text-align:center">No orchestrator history yet — logs on first actionable signal</td></tr>`;

      // ── 7. ERRORS ─────────────────────────────────────────────────────────
      const errRows = errors.map(e => {
        const typeCol = e.type === 'proxy_mismatch' ? '#f44336' : e.type === 'wick_straddle' ? '#ff9800' :
          e.type === 'dir_conflict' ? '#e040fb' : e.type === 'fetch_fail' ? '#f44336' : '#ffc107';
        return `<tr>
          <td style="${tdBase};color:${typeCol};font-weight:600;font-size:10px">${e.type}</td>
          <td style="${tdBase};color:#fff">${e.sym}</td>
          <td style="${tdBase};color:#888;font-size:10px">${e.tsIso?.slice(11, 19) || '–'}</td>
          <td style="${tdBase};font-size:10px">${e.proxy || ''}${e.proxy && e.authoritative ? ' → ' : ''}${e.authoritative || ''}</td>
          <td style="${tdBase};font-size:10px;color:#aaa">${e.refDiffPct != null ? e.refDiffPct.toFixed(3) + '%' : ''} ${e.wickStraddle ? '🔥' : ''} ${e.nearRef ? '≈' : ''}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="5" style="${tdBase};color:#4caf50;text-align:center">No errors 🎉</td></tr>`;

      const trailRows = Object.values(window._kalshiPredictionTrail || {})
        .sort((a, b) => (b.closeTimeMs || 0) - (a.closeTimeMs || 0))
        .slice(0, 10)
        .map(t => {
          const points = (t.points || [])
            .slice()
            .sort((a, b) => (a.stepIndex || 0) - (b.stepIndex || 0));
          const flips = points.slice(1).reduce((n, p, i) => {
            const prev = points[i];
            return n + ((prev?.modelDir && p?.modelDir && prev.modelDir !== p.modelDir) ? 1 : 0);
          }, 0);
          const seq = points.map(p => {
            const arrow = p.modelDir === 'UP' ? '▲' : p.modelDir === 'DOWN' ? '▼' : '•';
            const pct = p.modelYesPct != null ? `${p.modelYesPct}%` : '—';
            return `${p.minsFromOpen}m ${arrow}${pct}`;
          }).join(' · ');
          return `<tr>
            <td style="${tdBase};color:#fff;font-weight:700">${t.sym || '—'}</td>
            <td style="${tdBase};color:#aaa;font-size:10px">${t.ticker || '—'}</td>
            <td style="${tdBase};color:#888;font-size:10px">${fmtTime(t.closeTimeMs)}</td>
            <td style="${tdBase};color:${flips > 0 ? '#ff9800' : '#4caf50'}">${points.length}</td>
            <td style="${tdBase};color:${flips > 0 ? '#f44336' : '#888'}">${flips}</td>
            <td style="${tdBase};font-size:10px;color:#ddd;max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${seq || '—'}</td>
          </tr>`;
        }).join('') || `<tr><td colspan="6" style="${tdBase};color:#666;text-align:center">No 2-minute prediction trails yet</td></tr>`;

      const pendingN = window.MarketResolver?.getPending?.()?.length ?? 0;

      return `
      <details id="kalshi-debug-panel" style="margin:8px 0 14px;background:#111;border:1px solid #2a2a2a;border-radius:8px">
        <summary style="cursor:pointer;padding:8px 14px;font-size:12px;font-weight:700;color:#ffc107;letter-spacing:.5px;display:flex;align-items:center;gap:8px;user-select:none">
          🔬 KALSHI CONTRACT DEBUG
          <span style="font-size:10px;color:#666;font-weight:400;margin-left:auto">
            snap:${Object.keys(snaps).length} log:${(window._kalshiLog || []).length} trail:${Object.keys(window._kalshiPredictionTrail || {}).length} err:${errors.length} res:${resLog.length} pending:${pendingN} orch:${(window._orchLog || []).length}
          </span>
        </summary>
        <div style="padding:10px 14px;border-radius:0 0 8px 8px">

          <div style="font-size:10px;color:#e040fb;font-weight:700;margin-bottom:4px;letter-spacing:.5px">▸ ORCHESTRATOR — LIVE INTENTS</div>
          ${suppressionSummary}
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>ACTION</th><th ${th}>SIDE</th>
              <th ${th}>ALIGNMENT</th><th ${th}>EDGE</th><th ${th}>SCORE</th>
              <th ${th}>TIME LEFT</th><th ${th}>FLAGS</th><th ${th}>STAGE FAILS</th><th ${th}>BLOCKERS</th>
            </tr></thead>
            <tbody>${liveOrchRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#80cbc4;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ ACCURACY SCORECARD</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>N</th><th ${th}>MODEL%</th>
              <th ${th}>MKT%</th><th ${th}>FADE✓</th><th ${th}>TREND</th>
            </tr></thead>
            <tbody>${scorecardRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#ffc107;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ CURRENT SNAPSHOTS</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>FLOOR</th><th ${th}>STRIKE</th>
              <th ${th}>MODEL</th><th ${th}>mYes%</th><th ${th}>kYes%</th>
              <th ${th}>CDF</th><th ${th}>FADE</th><th ${th}>CLOSES</th>
            </tr></thead>
            <tbody>${snapRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#4fc3f7;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ CONTRACT LOG (last 10)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>OUTCOME</th><th ${th}>REF</th>
              <th ${th}>GAP%</th><th ${th}>SCORE</th><th ${th}>BET</th>
              <th ${th}>FADE</th><th ${th}>MDIV</th><th ${th}>AUTH</th><th ${th}>FLAGS</th>
            </tr></thead>
            <tbody>${logRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#26c6da;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ 2-MIN PREDICTION TRAIL (15m window)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>TICKER</th><th ${th}>CLOSES</th>
              <th ${th}>PTS</th><th ${th}>FLIPS</th><th ${th}>SEQUENCE</th>
            </tr></thead>
            <tbody>${trailRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#4caf50;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ SETTLED CONTRACTS (last 10)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>RESULT</th><th ${th}>RAW</th>
              <th ${th}>MODEL</th><th ${th}>ORCH</th><th ${th}>EDGE</th>
              <th ${th}>CB$</th><th ${th}>CONF</th><th ${th}>TIME</th>
            </tr></thead>
            <tbody>${resRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#7986cb;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ ORCHESTRATOR HISTORY (last 12 changes)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>ACTION</th><th ${th}>SIDE</th>
              <th ${th}>ALIGNMENT</th><th ${th}>EDGE</th><th ${th}>SCORE</th>
              <th ${th}>TIME</th><th ${th}>FLAGS</th>
            </tr></thead>
            <tbody>${orchLogRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#f44336;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ ERRORS / MISMATCHES (last 8)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>TYPE</th><th ${th}>SYM</th><th ${th}>TIME</th>
              <th ${th}>PROXY→AUTH</th><th ${th}>GAP</th>
            </tr></thead>
            <tbody>${errRows}</tbody>
          </table></div>

          <div style="margin-top:8px;font-size:10px;color:#555;font-family:monospace">
            DevTools: KalshiDebug.audit('ETH') · .errors() · .pending() · .suspects({topN:5}) · .replayIncident({topN:2}) · .contract('ETH') · .trail('ETH') · .orch('BTC') · .scorecard()
          </div>
        </div>
      </details>`;
    } catch (panelErr) {
      console.error('[KalshiDebug] panel render error:', panelErr);
      return `<details style="margin:8px 0 14px;background:#111;border:1px solid #f44336;border-radius:8px">
        <summary style="padding:8px 14px;color:#f44336;font-size:12px">🔬 KALSHI DEBUG — render error</summary>
        <div style="padding:10px 14px;color:#f44336;font-size:11px">${panelErr.message}<br><small style="color:#888">${panelErr.stack || ''}</small></div>
      </details>`;
    }
  }

  function getPredictionCoinMeta(sym) {
    const key = String(sym || '').toUpperCase();
    if (!key) return null;
    const configured = Array.isArray(window.PREDICTION_COINS)
      ? window.PREDICTION_COINS
      : (typeof PREDICTION_COINS !== 'undefined' && Array.isArray(PREDICTION_COINS) ? PREDICTION_COINS : []);
    const portfolio = typeof PORTFOLIO_HOLDINGS !== 'undefined' && Array.isArray(PORTFOLIO_HOLDINGS)
      ? PORTFOLIO_HOLDINGS
      : [];
    const watchlist = typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST)
      ? WATCHLIST
      : [];

    return configured.find(c => c?.sym === key)
      || portfolio.find(c => c?.sym === key)
      || watchlist.find(c => c?.sym === key)
      || null;
  }

  function normalizePredictionCardData(raw, fallbackSym = '') {
    const incoming = raw && typeof raw === 'object' ? raw : {};
    const sym = String(incoming.sym || incoming.symbol || incoming.coin || fallbackSym || '').toUpperCase();
    if (!sym) return { ...incoming, sym: '' };

    const meta = getPredictionCoinMeta(sym) || {};
    const color = incoming.color
      || meta.color
      || (typeof COIN_COLORS !== 'undefined' ? COIN_COLORS[sym] : null)
      || '#7880a0';
    const score = Number(incoming.score);
    const confidence = Number(incoming.confidence);
    const price = Number(incoming.price);
    const hasPayload = Object.keys(incoming).length > 0;

    return {
      ...incoming,
      sym,
      llm: window._llmIntegration?.lastInfluence?.[sym] || incoming.llm || null,
      name: incoming.name || meta.name || (typeof COIN_SHORT !== 'undefined' ? COIN_SHORT[sym] : null) || sym,
      instrument: incoming.instrument || meta.instrument || `${sym}USD`,
      geckoId: incoming.geckoId || meta.geckoId || null,
      icon: incoming.icon || meta.icon || sym.slice(0, 2),
      iconSources: Array.isArray(incoming.iconSources)
        ? incoming.iconSources
        : (Array.isArray(meta.iconSources) ? meta.iconSources : []),
      color,
      signal: incoming.signal || 'neutral',
      score: Number.isFinite(score) ? score : 0,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      price: Number.isFinite(price) ? price : 0,
      source: incoming.source || (hasPayload ? 'partial' : 'loading'),
      candleCount: incoming.candleCount ?? 0,
      candleCount1m: incoming.candleCount1m ?? 0,
      updatedAt: incoming.updatedAt || 'pending',
      indicators: incoming.indicators || {},
      diagnostics: incoming.diagnostics || {},
      projections: incoming.projections || {},
      volatility: incoming.volatility || { label: 'Unknown', atrPct: 0 },
      scalpSetups: Array.isArray(incoming.scalpSetups) ? incoming.scalpSetups : [],
    };
  }

  async function renderPredictions() {
    ensurePredictionsScrollTracker();
    const _myRV = _rv; // capture version — bail after any await if stale
    const nowTs = Date.now();
    const scrollTopSnapshot = content?.scrollTop || 0;
    let latestScrollTop = scrollTopSnapshot;
    let userScrolledDuringRender = false;
    const onPredScroll = () => {
      if (!content) return;
      userScrolledDuringRender = true;
      latestScrollTop = content.scrollTop;
    };
    content?.addEventListener('scroll', onPredScroll, { passive: true });
    const cleanupPredScrollListener = () => {
      try { content?.removeEventListener('scroll', onPredScroll); } catch (_) { }
    };

    const engine = window.PredictionEngine;
    const engineReady = !!engine?.getAll && !!engine?.getSession;
    if (!engineReady) {
      content.innerHTML = `<div class="card"><div class="card-body" style="padding:14px;color:var(--color-text-muted)">Prediction engine unavailable. Waiting for module load...</div></div>`;
      cleanupPredScrollListener();
      return;
    }

    // Fire-and-forget: start prediction engine in background if not yet loaded
    if (!predsLoaded && !predictionRunInFlight && nowTs >= _predictionEngineRetryAfterTs) {
      const predictionRun = startPredictionRun();
      predictionRun
        .then(() => {
          _lastPredictionRunTs = Date.now();
          _predictionEngineFailureCount = 0;
          _predictionEngineRetryAfterTs = 0;
          _predictionEngineLastError = '';
          if (_predictionEngineRetryTimer) {
            clearTimeout(_predictionEngineRetryTimer);
            _predictionEngineRetryTimer = null;
          }
          predsLoaded = true;
          snapshotPredictions();
          if (currentView === 'predictions') render();
        })
        .catch(e => {
          _predictionEngineFailureCount += 1;
          const delayMs = Math.min(60_000, 1000 * Math.pow(2, Math.max(0, _predictionEngineFailureCount - 1)));
          _predictionEngineRetryAfterTs = Date.now() + delayMs;
          _predictionEngineLastError = String(e?.message || e || 'unknown error');
          console.error(`[Predictions] engine error (retry in ${Math.round(delayMs / 1000)}s):`, e);

          if (_predictionEngineRetryTimer) clearTimeout(_predictionEngineRetryTimer);
          _predictionEngineRetryTimer = setTimeout(() => {
            _predictionEngineRetryTimer = null;
            if (currentView === 'predictions') render();
          }, delayMs + 50);

          if (currentView === 'predictions') {
            content.innerHTML = `<div class="card"><div class="card-body" style="padding:14px;color:var(--color-text-muted)">Prediction engine temporarily unavailable. Retrying in ${Math.max(1, Math.ceil(delayMs / 1000))}s.<br><small style="opacity:.75">${escapeHtml(_predictionEngineLastError)}</small></div></div>`;
          }
        });
    } else if (!predsLoaded && nowTs < _predictionEngineRetryAfterTs && currentView === 'predictions') {
      const secLeft = Math.max(1, Math.ceil((_predictionEngineRetryAfterTs - nowTs) / 1000));
      content.innerHTML = `<div class="card"><div class="card-body" style="padding:14px;color:var(--color-text-muted)">Prediction engine retry backoff active (${secLeft}s).<br><small style="opacity:.75">${escapeHtml(_predictionEngineLastError || 'waiting for recovery')}</small></div></div>`;
      cleanupPredScrollListener();
      return;
    }

    if (_rv !== _myRV) { cleanupPredScrollListener(); return; } // guard: stale render version
    let preds = {};
    let session = null;
    try {
      preds = engine.getAll() || {};
      session = engine.getSession?.() || null;
    } catch (err) {
      const msg = String(err?.message || err || 'unknown render error');
      console.error('[Predictions] getAll/getSession failed:', err);
      content.innerHTML = `<div class="card"><div class="card-body" style="padding:14px;color:var(--color-text-muted)">Prediction render failed: ${escapeHtml(msg)}</div></div>`;
      cleanupPredScrollListener();
      return;
    }
    const coinOrder = new Map(PREDICTION_COINS.map((coin, index) => [coin.sym, index]));
    const predBySym = new Map();
    PREDICTION_COINS.forEach(coin => {
      predBySym.set(
        coin.sym,
        normalizePredictionCardData({ ...coin, ...(preds?.[coin.sym] || {}), sym: coin.sym }, coin.sym)
      );
    });
    Object.entries(preds || {}).forEach(([key, pred]) => {
      const normalized = normalizePredictionCardData(pred, key);
      if (normalized.sym) predBySym.set(normalized.sym, normalized);
    });
    const predArr = Array.from(predBySym.values())
      .filter(p => p.sym)
      .sort((a, b) => {
        const ai = coinOrder.has(a.sym) ? coinOrder.get(a.sym) : Number.MAX_SAFE_INTEGER;
        const bi = coinOrder.has(b.sym) ? coinOrder.get(b.sym) : Number.MAX_SAFE_INTEGER;
        return (ai - bi) || String(a.sym).localeCompare(String(b.sym));
      });
    const bullCount = predArr.filter(p => p.signal === 'strong_bull' || p.signal === 'bullish').length;
    const bearCount = predArr.filter(p => p.signal === 'strong_bear' || p.signal === 'bearish').length;
    const backtests = predArr.map(p => p.backtest).filter(Boolean);
    const avgMetric = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const rankedBacktests = [...backtests].sort((a, b) => (b.summary?.reliability || 0) - (a.summary?.reliability || 0));
    const rankedTradeFit = [...backtests].sort((a, b) => ((b.summary?.tradeFit ?? b.summary?.reliability ?? 0)) - ((a.summary?.tradeFit ?? a.summary?.reliability ?? 0)));
    const bestBacktest = rankedBacktests[0] || null;
    const weakestBacktest = rankedBacktests[rankedBacktests.length - 1] || null;
    const bestTradeFit = rankedTradeFit[0] || null;
    const avgReliability = avgMetric(backtests.map(bt => (bt.summary?.reliability || 0.5) * 100));
    const avgTradeFit = avgMetric(backtests.map(bt => ((bt.summary?.tradeFit ?? bt.summary?.reliability ?? 0.5) * 100)));
    const advancedBacktests = backtests.map(bt => bt.advanced).filter(Boolean);
    const avgAdvancedQuality = avgMetric(advancedBacktests.map(bt => (bt.summary?.reliability || 0.5) * 100));
    const avgAdvancedFit = avgMetric(advancedBacktests.map(bt => (bt.summary?.tradeFit || bt.summary?.reliability || 0.5) * 100));
    const advancedVolSnapshots = advancedBacktests.map(bt => bt.volatility).filter(Boolean);
    const avgAdvancedVolPct = avgMetric(advancedVolSnapshots.map(v => Number(v.ewmaVolPct) || 0));
    const avgAdvancedVolPercentile = avgMetric(advancedVolSnapshots.map(v => Number(v.volPercentile) || 50));
    const avgAdvancedJumpRisk = avgMetric(advancedVolSnapshots.map(v => (Number(v.jumpRatio) || 0) * 100));
    const regimeCounts = advancedVolSnapshots.reduce((acc, v) => {
      const key = String(v.regime || 'UNKNOWN').toUpperCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const dominantAdvancedRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
    const preferredHorizonCounts = PREDICTION_HORIZONS.map(horizonMin => ({
      horizonMin,
      count: backtests.filter(bt => (bt.summary?.preferredHorizon || 5) === horizonMin).length,
    }));
    const preferredLeader = preferredHorizonCounts.slice().sort((a, b) => b.count - a.count)[0] || { horizonMin: 5, count: 0 };
    const horizonSummaries = PREDICTION_HORIZONS.map(horizonMin => {
      const key = `h${horizonMin}`;
      const active = backtests
        .map(bt => bt[key])
        .filter(stats => stats?.activeSignals);
      return {
        horizonMin,
        key,
        label: `${horizonMin}m`,
        hasData: active.length > 0,
        avgWin: avgMetric(active.map(stats => stats.winRate)),
        avgEdge: avgMetric(active.map(stats => stats.avgSignedReturn)),
        avgReturn: avgMetric(active.map(stats => stats.equity?.returnPct || 0)),
        avgDrawdown: avgMetric(active.map(stats => stats.equity?.maxDrawdownPct || 0)),
      };
    });
    const maxDrawdown = horizonSummaries.reduce((max, horizon) => Math.max(max, horizon.avgDrawdown || 0), 0);

    // Collect all scalp setups across all coins
    const allSetups = [];
    predArr.forEach(p => {
      (p.scalpSetups || []).forEach(s => {
        allSetups.push({ ...s, coin: p.sym, color: p.color, llm: p.llm });
      });
    });
    const highSetups = allSetups.filter(s => s.strength === 'high');
    const contrarian = allSetups.filter(s => s.type.startsWith('contrarian_'));

    // Save collapsible state before wiping DOM
    const _debugOpen = document.getElementById('kalshi-debug-panel')?.open ?? false;

    content.innerHTML = `
      ${!predsLoaded ? `<div style="display:flex;align-items:center;gap:10px;padding:8px 16px;background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.3);border-radius:6px;margin-bottom:12px;font-size:13px;color:#ffc107"><div style="width:16px;height:16px;border:2px solid rgba(255,193,7,0.3);border-top-color:#ffc107;border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0"></div><span>Scoring UP/DOWN markets\u2026</span></div>` : ''}
      ${buildQuickDecisionPanel(predArr)}
      <div id="pred-accuracy-badge" style="text-align:center;padding:4px 0 6px;font-size:12px;letter-spacing:.5px"></div>
      ${buildKalshiDebugPanel()}
      <div class="pred-disclaimer">
        \u26a0 <strong>Not financial advice.</strong> These UP/DOWN calls are 15-minute-window signals derived from RSI, VWAP deviation, EMA crosses, OBV, weighted 10/20-level book imbalance, imbalance velocity, liquidity depth, and trade flow. They represent statistical probabilities, not certainties. Always manage risk.
      </div>

      <!-- Session + Scalp Timing Bar -->
      <div class="kpi-bar" style="margin-bottom:14px">
        <div class="kpi-card" style="border-left:3px solid ${session.current.scalp ? 'var(--color-green)' : 'var(--color-text-faint)'}">
          <div class="kpi-label">Current Session</div>
          <div class="kpi-val ${session.current.scalp ? 'green' : ''}" style="font-size:15px">${session.current.label}</div>
          <div class="kpi-sub">${session.current.desc}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Next Scalp Window</div>
          <div class="kpi-val blue" style="font-size:15px">${session.nextScalp.label}</div>
          <div class="kpi-sub">in ${session.minsToNext} min &middot; ${session.nextScalp.desc.split('\u2014')[0]}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Market Sentiment</div>
          <div class="kpi-val ${bullCount > bearCount ? 'green' : bearCount > bullCount ? 'red' : ''}" style="font-size:15px">${bullCount > bearCount ? 'Leaning Bullish' : bearCount > bullCount ? 'Leaning Bearish' : 'Mixed'}</div>
          <div class="kpi-sub"><span style="color:var(--color-green)">${bullCount}\u2191</span> / <span style="color:var(--color-red)">${bearCount}\u2193</span> / ${predArr.length - bullCount - bearCount} neutral</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Active Setups</div>
          <div class="kpi-val gold" style="font-size:15px">${highSetups.length} High</div>
          <div class="kpi-sub">${contrarian.length} contrarian &middot; ${allSetups.length} total</div>
        </div>
      </div>

      ${backtests.length > 0 ? `
        <div class="card" style="margin-bottom:14px">
          <div class="card-title">Walk-Forward Backtest</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:10px">
            <div class="kpi-card">
              <div class="kpi-label">Model Reliability</div>
              <div class="kpi-val ${avgReliability >= 60 ? 'green' : avgReliability < 45 ? 'red' : 'gold'}">${Math.round(avgReliability)}%</div>
              <div class="kpi-sub">Broad walk-forward quality across ${backtests.length} coins</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Short-Term Trade Fit</div>
              <div class="kpi-val ${avgTradeFit >= 62 ? 'green' : avgTradeFit < 46 ? 'red' : 'gold'}">${Math.round(avgTradeFit)}%</div>
              <div class="kpi-sub">${preferredLeader.count}/${backtests.length} coins prefer ${preferredLeader.horizonMin}m timing · best ${bestTradeFit?.sym || '—'}</div>
            </div>
            ${horizonSummaries.map(horizon => `
              <div class="kpi-card">
                <div class="kpi-label">${horizon.label} Hit Rate</div>
                <div class="kpi-val ${horizon.avgWin >= 55 ? 'green' : horizon.avgWin < 45 ? 'red' : ''}">${horizon.hasData ? horizon.avgWin.toFixed(1) : '—'}%</div>
                <div class="kpi-sub">Avg edge ${horizon.hasData ? fmtPct(horizon.avgEdge) : '—'} · Eq ${horizon.hasData ? fmtPct(horizon.avgReturn) : '—'}</div>
              </div>
            `).join('')}
            <div class="kpi-card">
              <div class="kpi-label">1m / 5m / 10m / 15m Drawdown</div>
              <div class="kpi-val ${maxDrawdown <= 6 ? 'green' : maxDrawdown >= 10 ? 'red' : 'gold'}">${horizonSummaries.map(horizon => horizon.hasData ? `${horizon.avgDrawdown.toFixed(1)}%` : '—').join(' / ')}</div>
              <div class="kpi-sub">Compounded from $${bestBacktest?.summary?.startingEquity || 100} test equity</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Strongest / Weakest</div>
              <div class="kpi-val" style="font-size:14px">${bestBacktest ? bestBacktest.sym : '—'} / ${weakestBacktest ? weakestBacktest.sym : '—'}</div>
              <div class="kpi-sub">${bestBacktest ? Math.round((bestBacktest.summary?.reliability || 0) * 100) : '—'}% quality · ${bestTradeFit ? Math.round(((bestTradeFit.summary?.tradeFit ?? 0) * 100)) : '—'}% fit</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Advanced Backtest</div>
              <div class="kpi-val ${avgAdvancedQuality >= 58 ? 'green' : avgAdvancedQuality < 42 ? 'red' : 'gold'}">${advancedBacktests.length ? Math.round(avgAdvancedQuality) : '—'}%</div>
              <div class="kpi-sub">${advancedBacktests.length ? `${Math.round(avgAdvancedFit)}% fit · ${dominantAdvancedRegime} regime · EWMA ${avgAdvancedVolPct.toFixed(2)}%` : 'loading full-history tests'}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">7d Volatility Regime</div>
              <div class="kpi-val ${avgAdvancedVolPercentile >= 90 ? 'red' : avgAdvancedVolPercentile >= 75 ? 'gold' : avgAdvancedVolPercentile < 25 ? 'green' : ''}">${advancedVolSnapshots.length ? `${dominantAdvancedRegime} (${avgAdvancedVolPercentile.toFixed(0)}p)` : '—'}</div>
              <div class="kpi-sub">${advancedVolSnapshots.length ? `Jump risk ${avgAdvancedJumpRisk.toFixed(1)}% across ${advancedVolSnapshots.length} coins` : 'waiting for 7d volatility snapshot'}</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--color-text-muted);line-height:1.5">
            Signals now separate broad model quality from short-horizon trade fit. The backtest still grades the full walk-forward history, while the trade-fit score leans toward the 1m / 5m / 10m / 15m ladder you are actually trading.
          </div>
        </div>
      ` : ''}

      <!-- Scalp Timing + Contrarian Setups Section -->
      ${allSetups.length > 0 ? `
        <div class="card" style="margin-bottom:14px">
          <div class="card-title" style="color:var(--color-gold)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Live Scalp & Contrarian Setups
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px">
            ${allSetups.sort((a, b) => (b.strength === 'high' ? 2 : b.strength === 'medium' ? 1 : 0) - (a.strength === 'high' ? 2 : a.strength === 'medium' ? 1 : 0)).map(s => {
      const dirIcon = s.direction === 'long' || s.direction === 'up' ? '\u2191' : s.direction === 'short' || s.direction === 'down' ? '\u2193' : '\u2014';
      const dirColor = s.direction === 'long' || s.direction === 'up' ? 'var(--color-green)' : s.direction === 'short' || s.direction === 'down' ? 'var(--color-red)' : 'var(--color-text-muted)';
      const strengthColor = s.strength === 'high' ? 'var(--color-gold)' : s.strength === 'warning' ? 'var(--color-orange)' : 'var(--color-text-muted)';
      const isCon = s.type.startsWith('contrarian_');
      return `
                <div style="padding:10px 12px;background:var(--color-surface-2);border-radius:var(--radius-md);border-left:3px solid ${s.color || 'var(--color-border)'}">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                    <span style="font-size:13px;font-weight:700;color:${s.color}">${s.coin}</span>
                    ${isCon ? '<span style="font-size:8px;padding:2px 5px;background:var(--color-orange-dim);color:var(--color-orange);border-radius:9999px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Contrarian</span>' : ''}
                    ${s.strength === 'high' ? '<span style="font-size:8px;padding:2px 5px;background:var(--color-green-dim);color:var(--color-green);border-radius:9999px;font-weight:700;text-transform:uppercase">High</span>' : ''}
                    ${s.strength === 'warning' ? '<span style="font-size:8px;padding:2px 5px;background:var(--color-orange-dim);color:var(--color-orange);border-radius:9999px;font-weight:700;text-transform:uppercase">Warning</span>' : ''}
                    <span style="margin-left:auto;font-size:18px;color:${dirColor}">${dirIcon}</span>
                  </div>
                  <div style="font-size:12px;font-weight:600;margin-bottom:2px">${s.label}</div>
                  <div style="font-size:11px;color:var(--color-text-muted);line-height:1.4">
                    ${(() => {
                      const aiDesc = s.llm?.ai_wording?.scalp_setups?.find(x => x.label === s.label)?.ai_description;
                      return aiDesc ? `<span style="color:#8fa8ff"><span style="font-weight:700">✨ AI:</span> ${escapeHtml(aiDesc)}</span>` : s.desc;
                    })()}
                  </div>
                </div>
              `;
    }).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Prediction Cards Grid -->
      <div class="section-header"><span class="section-title">15-Minute UP / DOWN Window</span>
        <div style="display:flex;align-items:center;gap:8px">
          <button class="btn-sm" id="toggleHighConfidenceOverlay" style="font-size:10px;padding:4px 10px">HC Overlay: ${isHighConfidenceOverlayOn() ? 'ON' : 'OFF'}</button>
          <button class="btn-sm" id="rerunPreds" style="font-size:10px;padding:4px 10px">Refresh Analysis</button>
        </div>
      </div>
      <div class="pred-grid">
        ${predArr.map(p => {
      try { return predictionCard(p); }
      catch (cardErr) {
        console.error('[predictionCard] crash:', p?.sym, cardErr);
        return `<div class="pred-card" style="padding:20px 16px;border-left:4px solid var(--color-red,#ff4444)">
              <div style="font-weight:700;color:var(--color-red,#ff4444);font-size:13px">⚠ ${p?.sym || '?'} — Render Error</div>
              <div style="font-size:11px;color:var(--color-text-muted,#aaa);margin-top:6px;font-family:monospace;white-space:pre-wrap">${cardErr.message}</div>
            </div>`;
      }
    }).join('')}
      </div>
    `;
    _lastPredRenderTs = Date.now();

    // Populate accuracy badge immediately after render
    updateAccuracyBadge();

    // Restore Kalshi debug panel open state (lost on innerHTML replace)
    if (_debugOpen) {
      const _dp = document.getElementById('kalshi-debug-panel');
      if (_dp) _dp.open = true;
    }

    // Rerun button — clear stuck in-flight so refresh always works
    const rerunBtn = document.getElementById('rerunPreds');
    if (rerunBtn) {
      rerunBtn.addEventListener('click', async () => {
        resetPredictionRunState(); // cancel any stuck run
        predsLoaded = false;
        rerunBtn.textContent = 'Analyzing...';
        rerunBtn.disabled = true;
        content.innerHTML = `<div class="loading-screen"><div class="loader-ring"></div><p>Scoring UP/DOWN markets — routing inner shells first, then loading deeper confirmations...</p></div>`;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await renderPredictions();
      });
    }

    const hcToggleBtn = document.getElementById('toggleHighConfidenceOverlay');
    if (hcToggleBtn) {
      hcToggleBtn.addEventListener('click', () => {
        const next = !isHighConfidenceOverlayOn();
        setHighConfidenceOverlayOn(next);
        renderPredictions();
      });
    }

    content.querySelectorAll('[data-pred-toggle]').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.gs-wrap')) return;
        const sym = card.dataset.predToggle;
        if (predictionCollapsed.has(sym)) predictionCollapsed.delete(sym);
        else predictionCollapsed.add(sym);
        renderPredictions();
      });
    });

    // Quick Decision Panel: click chip → scroll to matching prediction card
    content.querySelectorAll('[data-scroll-pred]').forEach(chip => {
      chip.addEventListener('click', () => {
        const target = content.querySelector(`[data-testid="pred-${chip.dataset.scrollPred}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    requestAnimationFrame(() => {
      if (currentView === 'predictions' && content) {
        content.scrollTop = userScrolledDuringRender ? latestScrollTop : scrollTopSnapshot;
      }
    });
    cleanupPredScrollListener();
  }

  function predictionCard(p) {
    if (!p || !p.sym) {
      console.warn('[predictionCard] Missing prediction object or sym:', p);
      return `<div class="pred-card" style="padding:20px 16px;border-left:4px solid var(--color-red,#ff4444)">
        <div style="font-weight:700;color:var(--color-red,#ff4444);font-size:13px">⚠ Invalid Prediction</div>
        <div style="font-size:11px;color:var(--color-text-muted,#aaa);margin-top:6px">Prediction object missing sym field</div>
      </div>`;
    }
    if (!Number.isFinite(p.score)) {
      console.warn('[predictionCard] Missing score for:', p.sym);
      p.score = 0;
    }
    // ── Verdict ──────────────────────────────────────────────────────────────
    // Priority order:
    //   1. Kalshi certainty (≥90% / ≤10%) — trust near-certain market consensus, never fade
    //   2. CDF modelYesPct — P(close ≥ strike): correct metric for binary contracts (not raw score direction)
    //   3. Raw score direction — fallback when no Kalshi ref is set yet
    //   4. Kalshi tiebreak — when model is neutral and Kalshi has clear edge
    // Raw model score (UP/DOWN) = "will price move?" — WRONG basis for binary "close above strike" contracts.
    // modelYesPct = P(projected target ≥ strike) via normal CDF — this is the RIGHT metric.
    const _k15mCV = window.PredictionMarkets?.getCoin(p.sym);
    const _k15mV = _k15mCV?.kalshi15m ?? null;
    const kalshiProb = _k15mV?.probability ?? _k15mCV?.combinedProb ?? null;
    const kalshiPct = kalshiProb !== null ? Math.round(kalshiProb * 100) : null;
    const kalshiEdge = kalshiProb !== null ? Math.abs(kalshiProb - 0.5) : null;
    let _kAlignEarly = p.projections?.p15?.kalshiAlign ?? null;
    if (_kAlignEarly && _k15mV && _kAlignEarly.ticker && _k15mV.ticker && _kAlignEarly.ticker !== _k15mV.ticker) {
      _kAlignEarly = null;
    }
    const _strikeDirEarly = (_kAlignEarly?.strikeDir ?? _k15mV?.strikeDir) === 'below' ? 'below' : 'above';
    const _yesDirEarly = _strikeDirEarly === 'below' ? 'down' : 'up';
    const _noDirEarly = _yesDirEarly === 'up' ? 'down' : 'up';

    const modelDir = p.score > 0.12 ? 'up' : p.score < -0.12 ? 'down' : 'wait';
    const kalshiDir = kalshiProb !== null ? (kalshiProb >= 0.5 ? _yesDirEarly : _noDirEarly) : null;

    let verdictDir, verdictSource;
    // MODEL-AGNOSTIC PRINCIPLE: Verdict color reflects MODEL conviction ONLY, never Kalshi odds.
    // Kalshi is used for divergence awareness + comparison bar only (not verdict color override).

    if (_kAlignEarly?.modelYesPct != null) {
      // Use CDF P(close ≥ strike) — correct for binary contracts
      const myp = _kAlignEarly.modelYesPct;
      if (myp >= 58) { verdictDir = _yesDirEarly; verdictSource = 'model-cdf'; }
      else if (myp <= 42) { verdictDir = _noDirEarly; verdictSource = 'model-cdf'; }
      else { verdictDir = 'wait'; verdictSource = 'model-cdf-neutral'; }
    } else if (modelDir !== 'wait') {
      // Model has conviction (raw score > ±0.12) — USE IT for verdict color
      verdictDir = modelDir;
      verdictSource = 'model';
    } else {
      // Model has no conviction → show as WAIT (don't fade to Kalshi)
      verdictDir = 'wait';
      verdictSource = 'model-uncertain';
    }

    // Safety gate: avoid late/borderline calls that commonly flip wrong near settlement.
    const tickerAgeMs = Math.max(0, Date.now() - Number(window._lastTickerFetchTs || 0));
    const isTickerStale = tickerAgeMs > 8_000;
    const msToClose = _k15mV?.closeTime
      ? (new Date(_k15mV.closeTime).getTime() - Date.now())
      : null;
    const inSafetyWindow = Number.isFinite(msToClose)
      && msToClose >= 0
      && msToClose <= 5 * 60_000;
    const isBorderlineStrike = Number.isFinite(_kAlignEarly?.gapPct)
      ? Math.abs(_kAlignEarly.gapPct) < 0.08
      : false;
    const isWeakConviction = Math.abs(Number(p.score || 0)) < 0.18;
    if (verdictDir !== 'wait' && inSafetyWindow && (isTickerStale || isBorderlineStrike || isWeakConviction)) {
      verdictDir = 'wait';
      verdictSource = isTickerStale
        ? 'safety-stale-data'
        : isBorderlineStrike
          ? 'safety-borderline-strike'
          : 'safety-weak-conviction';
    }

    // Targeted guard (ultra-late only): keep aggressive mispricing capture intact,
    // but block semi-confidence crowd-conflict flips in the last seconds.
    const confNorm = _normalizeConfidence(p.confidence) ?? 0;
    const isSemiConfidence = confNorm >= 0.40 && confNorm < 0.70;
    const isCrowdConflict =
      kalshiDir !== null && modelDir !== 'wait' && modelDir !== kalshiDir;
    const isUltraLateWindow =
      Number.isFinite(msToClose) && msToClose >= 0 && msToClose <= 45_000;

    if (
      verdictDir !== 'wait' &&
      isSemiConfidence &&
      isCrowdConflict &&
      isUltraLateWindow
    ) {
      verdictDir = 'wait';
      verdictSource = 'safety-semi-confidence-ultra-late';
    }

    // Fade flag: raw price direction conflicts with Kalshi crowd (informational only — betAction does NOT use this)
    const _fadeActive = kalshiDir !== null && modelDir !== 'wait' && modelDir !== kalshiDir;
    const _fadeSolid = _fadeActive && Math.abs(p.score) >= 0.20;
    const _fadeSoft = _fadeActive && !_fadeSolid;
    // Bet action derived from verdictDir (Kalshi-certainty and CDF-aware — not raw score direction)
    const _betAction = verdictDir === _yesDirEarly ? 'YES' : verdictDir === _noDirEarly ? 'NO' : null;
    const compositeEdge = 0.75 * Math.abs(p.score) + 0.25 * (kalshiEdge ?? 0);

    const verdictMain = verdictDir === 'up' ? '▲ UP' : verdictDir === 'down' ? '▼ DOWN' : '◆ WAIT';
    const strength = verdictDir === 'wait' ? 'NEUTRAL'
      : compositeEdge >= 0.42 ? 'STRONG' : compositeEdge >= 0.22 ? 'MODERATE' : 'LIGHT';
    const scoreStr = Number.isFinite(p.score) ? (p.score > 0 ? '+' : '') + p.score.toFixed(2) : '—';

    // ── Pre-compute model probability (outer scope — used in verdict banner + comparison bar) ──
    const _modelUpPct = Math.round(Math.min(99, Math.max(1, 50 + (p.score || 0) * 50)));
    const _modelDownPct = 100 - _modelUpPct;
    const _modelYesPctCard = _kAlignEarly?.modelYesPct ?? (_strikeDirEarly === 'below' ? _modelDownPct : _modelUpPct);
    const _modelProbStr = verdictDir === 'up' ? `${_modelUpPct}% UP`
      : verdictDir === 'down' ? `${_modelDownPct}% DOWN` : 'NEUTRAL';
    const _modelProbColor = verdictDir === 'up' ? 'var(--color-green)'
      : verdictDir === 'down' ? 'var(--color-red)' : 'var(--color-text-muted)';
    const _liveKProbCard = window.PredictionMarkets?.getCoin?.(p.sym)?.kalshi15m?.probability ?? kalshiProb;
    const _liveKPctCard = _liveKProbCard != null ? Math.round(_liveKProbCard * 100) : null;
    const _edgePpCard = _liveKPctCard != null ? Math.abs(_modelYesPctCard - _liveKPctCard) : null;
    const _liveKDirCard = _liveKProbCard == null ? null : (_liveKProbCard >= 0.5 ? _yesDirEarly : _noDirEarly);
    const _liveKColorCard = _liveKProbCard == null ? 'var(--color-text-muted)'
      : _liveKDirCard === 'up' ? 'var(--color-green)' : 'var(--color-red)';

    // Session badge (informational only — session multipliers removed; all sessions treated equally)
    const _nowUTC = new Date().getUTCHours();
    const isLondonSession = _nowUTC >= 7 && _nowUTC < 12;
    const londonBadge = '';

    // Model calibration notices for problem coins
    const _uncalibrated = { HYPE: 'Limited data — extreme thresholds active', DOGE: 'Meme-coin regime — higher threshold required' };
    const calibBadge = _uncalibrated[p.sym]
      ? `<span class="pred-calib-warn" title="${_uncalibrated[p.sym]}">⚠ ${p.sym === 'HYPE' ? 'HYPE: low calibration' : 'DOGE: noisy regime'}</span>`
      : '';

    // Weak signal notice — light bucket (absScore <0.25) in model-only verdict has poor backtest WR
    const _isLightModel = verdictSource === 'model' && Math.abs(p.score) < 0.25 && verdictDir !== 'wait';
    const weakBadge = _isLightModel
      ? `<span class="pred-weak-warn" title="Low-conviction signal — backtest accuracy below 50%">⚡ WEAK</span>`
      : '';
    const safetyBadge = verdictSource.startsWith('safety-')
      ? `<span class="pred-weak-warn" title="Protected by safety gate (${verdictSource.replace('safety-', '')})">🛡 WAIT GUARD</span>`
      : '';
    const hcConfThreshold = 0.62;
    const hcEdgeThreshold = 0.20;
    const hcPass =
      verdictDir !== 'wait' &&
      !verdictSource.startsWith('safety-') &&
      confNorm >= hcConfThreshold &&
      compositeEdge >= hcEdgeThreshold;
    const hcBadge = isHighConfidenceOverlayOn()
      ? `<span class="pred-source-badge ${hcPass ? 'kalshi-align' : 'kalshi-fade'}" title="Advisory overlay only; does not alter model verdict routing">${hcPass ? '✅ HC PASS' : '⏸ HC HOLD'}</span>`
      : '';
    const hcRationale = (() => {
      if (!isHighConfidenceOverlayOn()) return '';
      if (hcPass) {
        return `High-confidence overlay: PASS (conf ${Math.round(confNorm * 100)}%, edge ${compositeEdge.toFixed(2)}).`;
      }
      if (verdictDir === 'wait') {
        return `High-confidence overlay: HOLD until model exits WAIT and clears confidence/edge thresholds.`;
      }
      if (verdictSource.startsWith('safety-')) {
        return `High-confidence overlay: HOLD due to active safety guard.`;
      }
      if (confNorm < hcConfThreshold) {
        return `High-confidence overlay: HOLD (confidence ${Math.round(confNorm * 100)}% < ${Math.round(hcConfThreshold * 100)}% threshold).`;
      }
      return `High-confidence overlay: HOLD (edge ${compositeEdge.toFixed(2)} < ${hcEdgeThreshold.toFixed(2)} threshold).`;
    })();
    const waitRationale = (() => {
      if (verdictDir !== 'wait') return '';

      const modelYesPct = Number(_kAlignEarly?.modelYesPct);
      if (verdictSource === 'model-cdf-neutral' && Number.isFinite(modelYesPct)) {
        return `Model thinking: CDF neutral at ${modelYesPct.toFixed(1)}% YES (needs >=58% for YES direction or <=42% for NO direction).`;
      }
      if (verdictSource === 'model-uncertain') {
        return `Model thinking: low conviction score ${scoreStr} (needs >+0.12 for UP or <-0.12 for DOWN).`;
      }
      if (verdictSource === 'safety-stale-data') {
        return `Model thinking: signal blocked by stale ticker data (${Math.round(tickerAgeMs / 1000)}s old) inside the 5-minute pre-close guard.`;
      }
      if (verdictSource === 'safety-borderline-strike') {
        const gap = Number(_kAlignEarly?.gapPct);
        return `Model thinking: strike gap too narrow (${Number.isFinite(gap) ? gap.toFixed(3) : 'n/a'}%) inside the 5-minute pre-close guard.`;
      }
      if (verdictSource === 'safety-weak-conviction') {
        return `Model thinking: weak score ${scoreStr} in the 5-minute pre-close guard (requires stronger than ±0.18).`;
      }
      if (verdictSource === 'safety-semi-confidence-ultra-late') {
        return `Model thinking: semi-confidence (${Math.round(confNorm * 100)}%) with crowd conflict in the last 45 seconds, so entry is blocked.`;
      }
      return `Model thinking: waiting for stronger directional confirmation.`;
    })();
    const llmRegime = p.llm?.regime || p.diagnostics?.llmRegime || null;
    const llmConfidence = Number(p.llm?.confidence || p.diagnostics?.llmConfidence || 0);
    const llmNotes = String(p.llm?.notes || p.diagnostics?.llmNotes || '').trim();
    let llmPatterns = p.llm?.market_patterns || p.diagnostics?.market_patterns || null;
    if (Array.isArray(llmPatterns)) llmPatterns = llmPatterns.join(', ');
    const llmBadge = llmRegime && llmRegime !== 'unknown'
      ? `<span class="pred-source-badge" style="border-color:rgba(143,168,255,0.45);color:#8fa8ff">🧠 LLM ${escapeHtml(llmRegime.replace(/_/g, ' '))}${llmConfidence ? ` ${Math.round(llmConfidence)}%` : ''}</span>`
      : '';
    const { primary: ratPrimary, secondary: ratSecondary } = getDecisionRationale(p);

    const arrow = p.score > 0.3 ? '\u2B06' : p.score < -0.3 ? '\u2B07' : p.score > 0 ? '\u2197' : p.score < 0 ? '\u2198' : '\u2194';
    const confClass = p.score > 0 ? 'bull' : p.score < 0 ? 'bear' : 'flat';
    const ind = p.indicators || {};
    const hasBacktest = !!p.backtest;
    const reliabilityPct = hasBacktest ? Math.round((p.backtest.summary?.reliability || 0) * 100) : 0;
    const tradeFitPct = hasBacktest ? Math.round(((p.backtest.summary?.tradeFit ?? p.backtest.summary?.reliability ?? 0) * 100)) : 0;
    const advanced = p.backtest?.advanced || null;
    const advancedVol = advanced?.volatility || null;
    const advancedQualityPct = advanced ? Math.round((advanced.summary?.reliability || 0) * 100) : 0;
    const advancedFitPct = advanced ? Math.round((advanced.summary?.tradeFit || advanced.summary?.reliability || 0) * 100) : 0;
    const agreementPct = Math.round((p.diagnostics?.agreement || 0.5) * 100);
    const conflictPct = Math.round((p.diagnostics?.conflict || 0) * 100);
    const qualityLabel = hasBacktest ? (p.diagnostics?.qualityLabel || 'Backtest mixed') : 'Backtest unavailable';
    const tradeFitLabel = hasBacktest ? (p.diagnostics?.tradeFitLabel || 'Timing mixed') : 'Timing unavailable';
    const preferredHorizon = p.diagnostics?.preferredHorizon || p.backtest?.summary?.preferredHorizon || 5;
    const fastTiming = p.diagnostics?.fastTiming || null;
    const driverSummary = p.diagnostics?.driverSummary || 'No dominant driver cluster';
    const topDrivers = Array.isArray(p.diagnostics?.topDrivers) ? p.diagnostics.topDrivers.slice(0, 3) : [];
    const vetoReason = p.diagnostics?.vetoReason || '';
    const inBufferZone = !!p.diagnostics?.inBufferZone;
    const routedAction = p.diagnostics?.routedAction || 'watch';
    const routedSummary = p.diagnostics?.routedSummary || driverSummary;
    const routedRiskFlags = Array.isArray(p.diagnostics?.routedRiskFlags) ? p.diagnostics.routedRiskFlags.slice(0, 3) : [];
    const mdt = p.mdt || null;
    const reversalFlags = Array.isArray(p.reversalFlags) ? p.reversalFlags : [];
    const mdtVerdict = mdt?.verdict || 'HOLD';
    const mdtBias = mdt?.bias || 'neutral';
    const mdtConf = mdt?.biasConf || 0;
    const mdtPreemptive = !!mdt?.preemptive;
    const mdtLayer = mdt?.layer || 6;
    const mdtRegimeLabel = mdt?.regimeLabel || 'Flat / Ranging';
    const mdtPath = Array.isArray(mdt?.path) ? mdt.path : [];
    const rfRow = reversalFlags.length ? `
      <div class="rf-row">
        ${reversalFlags.map(f => `
          <span class="rf-badge rf-${f.severity} rf-${f.bias}" title="${f.desc}">
            ${f.severity === 'critical' ? '🔴' : f.severity === 'alert' ? '🟠' : '🟡'}
            ${f.label}
          </span>
        `).join('')}
      </div>` : '';
    const expanded = !predictionCollapsed.has(p.sym);
    const horizonRows = PREDICTION_HORIZONS.map(horizonMin => ({
      horizonMin,
      label: `${horizonMin}m`,
      stats: p.backtest?.[`h${horizonMin}`] || null,
      projection: p.projections?.[`p${horizonMin}`] || null,
    }));
    const setup15 = (() => {
      const h15 = p.backtest?.h15 || null;
      if (!h15 || !h15.activeSignals) {
        return { label: '15m setup: pending', cls: 'flat', detail: 'waiting for h15 samples' };
      }
      const wr = Number(h15.winRate) || 0;
      const edge = Number(h15.avgSignedReturn) || 0;
      if (wr >= 55 && edge > 0) {
        return { label: '15m setup: ready', cls: 'bull', detail: `${wr.toFixed(1)}% hit · ${fmtPct(edge)} edge` };
      }
      if (wr < 45 || edge <= 0) {
        return { label: '15m setup: caution', cls: 'bear', detail: `${wr.toFixed(1)}% hit · ${fmtPct(edge)} edge` };
      }
      return { label: '15m setup: mixed', cls: 'flat', detail: `${wr.toFixed(1)}% hit · ${fmtPct(edge)} edge` };
    })();
    const depthMeta = ind.orderBookImbalance?.meta || null;
    const depth10 = depthMeta?.levels?.level10 || null;
    const depth20 = depthMeta?.levels?.level20 || null;
    const velocityMeta = ind.imbalanceVelocity?.meta || null;
    const liquidityMeta = ind.liquidityDepth?.meta || null;
    const fmtDepthImb = value => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(0)}%` : '—';
    const depthClass = value => Number(value) > 0.12 ? 'bull' : Number(value) < -0.12 ? 'bear' : 'flat';
    const depthRows = depthMeta ? `
      <div class="ind-item"><span class="ind-name">Depth 10/20</span><span class="ind-val ${depthClass(depthMeta.rawImbalance)}">10L ${fmtDepthImb(depth10?.imbalance)} / 20L ${fmtDepthImb(depth20?.imbalance)}</span></div>
      <div class="ind-item"><span class="ind-name">Imb Velocity</span><span class="ind-val ${depthClass(velocityMeta?.value)}">${velocityMeta?.band || 'stable'} · ${fmtDepthImb(velocityMeta?.value)}</span></div>
      <div class="ind-item"><span class="ind-name">Liquidity</span><span class="ind-val ${liquidityMeta?.band === 'fragile' || liquidityMeta?.band === 'thin' ? 'bear' : liquidityMeta?.band === 'deep' ? 'bull' : 'flat'}">${liquidityMeta?.band || 'unknown'} · 20L ${fmtCompactUsd(liquidityMeta?.notional20)}</span></div>
    ` : '';

    function indClass(sig) { return sig > 0.15 ? 'bull' : sig < -0.15 ? 'bear' : 'flat'; }
    function btClass(stats) {
      if (!stats || !stats.activeSignals) return 'flat';
      if (stats.winRate >= 55 && stats.avgSignedReturn > 0) return 'bull';
      if (stats.winRate < 45 && stats.avgSignedReturn < 0) return 'bear';
      return 'flat';
    }
    function routeClass(action) {
      return action === 'trade' ? 'bull' : action === 'invalidated' ? 'bear' : 'flat';
    }

    // Scalp setups count for this coin
    const mySetups = (p.scalpSetups || []);
    const scalpCount = mySetups.filter(s => s.type.startsWith('scalp_')).length;
    const contrarianCount = mySetups.filter(s => s.type.startsWith('contrarian_')).length;

    // ---- Kalshi 15M live market row ----
    // YES resolves if closePrice ≥ targetPriceNum (meet or exceed the reference).
    // NO  resolves if closePrice  < targetPriceNum (falls below the reference).
    // Show both sides: Kalshi YES/NO prices + model P(≥ ref) / P(< ref).
    const _k15mCoin = window.PredictionMarkets?.getCoin(p.sym);
    const _k15m = _k15mCoin?.kalshi15m ?? null;
    const _kProb = ind.mktSentiment?.kalshi ?? _k15m?.probability ?? _k15mCoin?.combinedProb ?? null;
    let _kAlign = p.projections?.p15?.kalshiAlign ?? null;
    if (_kAlign && _k15m && _kAlign.ticker && _k15m.ticker && _kAlign.ticker !== _k15m.ticker) {
      _kAlign = null;
    }

    // Debug: log data availability on first few renders
    const _debugKalshi = window._debugKalshiCount = (window._debugKalshiCount || 0) + 1;
    if (_debugKalshi <= 3) {
      console.log(`[kalshi15mRow] ${p.sym}: _k15mCoin=${!!_k15mCoin}, _k15m=${!!_k15m}, _kProb=${_kProb}, combinedProb=${_k15mCoin?.combinedProb}, mktSentiment.kalshi=${ind.mktSentiment?.kalshi}`);
    }

    const kalshi15mRow = (() => {
      if (_kProb === null) return '';

      // YES and NO are complementary — always sum to 100%
      const kYesPct = Math.round(_kProb * 100);
      const kNoPct = 100 - kYesPct;
      const _rowStrikeDir = (_kAlign?.strikeDir ?? _k15m?.strikeDir ?? _strikeDirEarly) === 'below' ? 'below' : 'above';
      const _rowYesDir = _rowStrikeDir === 'below' ? 'down' : 'up';
      const _rowNoDir = _rowYesDir === 'up' ? 'down' : 'up';
      const kDir = _kProb >= 0.5 ? _rowYesDir : _rowNoDir;
      const kCls = kDir === 'up' ? 'bull' : 'bear';

      let probLine;
      if (_kAlign?.modelYesPct != null) {
        // Reference price is set — show full YES/NO breakdown for both sides
        const mYesPct = _kAlign.modelYesPct;
        const mNoPct = 100 - mYesPct;
        const div = _kAlign.divergence;
        const status = _kAlign.status;

        const divBadge = status === 'divergent'
          ? `<span class="k15-divergent">⚡ ${div}pp</span>`
          : status === 'soft-split'
            ? `<span class="k15-soft-split">${div}pp</span>`
            : `<span class="k15-agree">✓</span>`;

        // K: YES 68% / NO 32%   M: YES 72% / NO 28%   ⚡badge
        // YES = price meets/exceeds ref = bullish = always green (k15-yes)
        // NO  = price stays below ref   = bearish = always red   (k15-no)
        probLine =
          `<span class="k15-side-label">K</span>` +
          `<span class="k15-yes">Y ${kYesPct}%</span>` +
          `<span class="k15-sep">/</span>` +
          `<span class="k15-no">N ${kNoPct}%</span>` +
          `  <span class="k15-side-label">M</span>` +
          `<span class="k15-yes">Y ${mYesPct}%</span>` +
          `<span class="k15-sep">/</span>` +
          `<span class="k15-no">N ${mNoPct}%</span>` +
          ` ${divBadge}`;
      } else {
        // Reference TBD — show direction + YES/NO split while waiting
        const agree = verdictDir !== 'wait' && verdictDir === kDir;
        const disagree = verdictDir !== 'wait' && verdictDir !== kDir;
        const agBadge = agree ? `<span class="k15-agree">✓ AGREE</span>`
          : disagree ? `<span class="k15-disagree">⚡ DIVERGENT</span>` : '';
        probLine =
          `<span class="k15-yes">Y ${kYesPct}%</span>` +
          `<span class="k15-sep">/</span>` +
          `<span class="k15-no">N ${kNoPct}%</span>` +
          ` ${agBadge}`;
      }

      // Reference threshold — "meets or exceeds $85.32"
      // Prefer the raw API string (targetPrice) to avoid rounding the Kalshi strike.
      const refLine = _kAlign?.ref != null
        ? ` <span class="k15-target">≥ ${_k15m?.targetPrice ?? fmtPrice(_kAlign.ref)}</span>`
        : (_k15m?.targetPrice ? ` <span class="k15-target">≥ ${_k15m.targetPrice}</span>` : '');

      // Gap from current price to reference — show dollar amount + % + BORDERLINE warning
      const _gapRaw = _kAlign?.gapPct ?? null;
      const _gapDollar = (_kAlign?.ref != null && p.price > 0)
        ? (_kAlign.ref - p.price) : null;
      const _borderline = _gapRaw !== null && Math.abs(_gapRaw) < 0.12; // within 0.12% of strike
      const gapLine = _gapRaw !== null && Math.abs(_gapRaw) > 0.001
        ? ` <span class="k15-gap ${_gapRaw > 0 ? 'k15-gap-up' : 'k15-gap-down'} ${_borderline ? 'k15-borderline' : ''}">` +
        `${_gapRaw > 0 ? '▲' : '▼'} ${_gapDollar !== null ? '$' + Math.abs(_gapDollar).toFixed(4) + ' ' : ''}` +
        `(${_gapRaw > 0 ? '+' : ''}${_gapRaw.toFixed(3)}%)` +
        `${_borderline ? ' ⚠ BORDERLINE' : ''}</span>`
        : (_gapRaw !== null ? ` <span class="k15-gap k15-gap-down k15-borderline">✓ AT STRIKE</span>` : '');

      // Countdown to settlement
      let countdown = '';
      if (_k15m?.closeTime) {
        const msl = new Date(_k15m.closeTime).getTime() - Date.now();
        const closeUtc4 = formatUtc4Time(_k15m.closeTime);
        if (msl > 0) {
          const ts = Math.floor(msl / 1000);
          countdown = ` <span class="k15-expiry" data-close-ms="${new Date(_k15m.closeTime).getTime()}">⏱ ${Math.floor(ts / 60)}m${String(ts % 60).padStart(2, '0')}s · UTC-4 ${closeUtc4}</span>`;
        } else {
          countdown = ` <span class="k15-expiry k15-settling">⏱ SETTLING</span>`;
        }
      }

      const cfmRow = (() => {
        const cfmData = window.CFMEngine?.getAll ? window.CFMEngine.getAll()[p.sym] : null;
        if (!cfmData || !cfmData.bias) return '';
        const dir = cfmData.bias === 'up' ? 'bull' : cfmData.bias === 'down' ? 'bear' : 'flat';
        const mktContext = window.tickers?.[p.sym] ? `5m Δ ${((window.tickers[p.sym].close - window.tickers[p.sym].open) / window.tickers[p.sym].open * 100).toFixed(2)}%` : '';
        return `<div class="ind-item"><span class="ind-name">CFM Context</span><span class="ind-val ${dir}">${String(cfmData.bias).toUpperCase()} · ${mktContext}</span></div>`;
      })();

      return `<div class="ind-item k15m-row"><span class="ind-name">Kalshi 15M</span><span class="ind-val ${kCls}">${probLine}${refLine}${gapLine}${countdown}</span></div>${cfmRow}`;
    })();

    const model5mRow = (() => {
      const p5 = p.projections?.p5;
      if (!p5) return '';
      const dir = p5.target > p.price ? 'UP' : 'DOWN';
      const cls = dir === 'UP' ? 'bull' : 'bear';
      const gapPct = ((p5.target - p.price) / p.price) * 100;
      const gapDollar = Math.abs(p5.target - p.price);
      const gapLine = ` <span class="k15-gap ${gapPct > 0 ? 'k15-gap-up' : 'k15-gap-down'}">${gapPct > 0 ? '▲' : '▼'} $${gapDollar.toFixed(4)} (${gapPct > 0 ? '+' : ''}${gapPct.toFixed(3)}%)</span>`;
      return `<div class="ind-item k15m-row" style="background:rgba(255,255,255,0.03); border-left:2px solid var(--color-${dir === 'UP' ? 'green' : 'red'}); padding-left: 6px;"><span class="ind-name">Model 5M</span><span class="ind-val ${cls}"><span class="k15-side-label" style="opacity:0.6">PROJ</span><span class="k15-${dir.toLowerCase()}" style="font-weight:700">${dir}</span><span class="k15-target"> ≥ $${fmtPrice(p5.target)}</span>${gapLine}</span></div>`;
    })();

    return `
      <div class="pred-card ${p.signal} ${expanded ? 'expanded' : ''}" data-testid="pred-${p.sym}" data-pred-toggle="${p.sym}"
           style="border-left: 4px solid ${verdictDir === 'up' ? 'var(--color-green)' : verdictDir === 'down' ? 'var(--color-red)' : 'var(--color-border)'}">

        ${llmNotes ? `
        <div class="ai-thoughts-popup" style="
          margin: 0 0 12px 0;
          padding: 16px;
          border-radius: 8px;
          background: linear-gradient(135deg, rgba(25, 30, 45, 0.95), rgba(15, 20, 30, 0.98));
          border: 1px solid rgba(143, 168, 255, 0.25);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
          font-family: 'Inter', 'Outfit', 'Segoe UI', sans-serif;
          position: relative;
        ">
          <div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#a5b4fc;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
            <span style="font-size:14px;">✨</span> <span>ASI1 THOUGHTS</span>
            <span style="font-size:9px;padding:2px 8px;border-radius:999px;background:rgba(165, 180, 252, 0.15);color:#c7d2fe;letter-spacing:0.5px;">${escapeHtml((llmRegime || 'Mixed Regime').replace(/_/g, ' '))}</span>
          </div>
          <div style="font-size:13px;color:#f8fafc;line-height:1.6;font-weight:400;white-space:pre-wrap;">${escapeHtml(llmNotes)}</div>
          ${llmPatterns ? `
          <div style="margin-top:10px;font-size:11px;color:#cbd5e1;background:rgba(165,180,252,0.08);padding:8px 12px;border-radius:6px;border-left:3px solid #a5b4fc;">
            <strong style="color:#a5b4fc;text-transform:uppercase;letter-spacing:0.5px;">Detected Patterns:</strong><br>
            <span style="font-family:var(--font-mono);">${escapeHtml(llmPatterns)}</span>
          </div>` : ''}
        </div>` : ''}

        <!-- Header: always visible -->
        <div class="pred-header">
          <div class="pred-coin-icon" style="background:${p.color}22;color:${p.color}">${coinIcon(p.sym)}</div>
          <div class="pred-coin-info">
            <div class="pred-coin-sym">${p.sym}</div>
            <div class="pred-coin-name">${p.name}</div>
          </div>
          <div>
            <div class="pred-coin-price">${fmtPrice(p.price)}</div>
            <div class="pred-coin-src">${p.source === 'error'
        ? `<span style="color:var(--color-orange,#f90);font-size:9px">⚠ ${p.error ? p.error.slice(0, 50) : 'compute error'} — will retry</span>`
        : p.source === 'loading'
          ? `<span style="color:var(--color-text-muted,#888);font-size:9px">⏳ loading candles…</span>`
          : `${p.source} &middot; ${p.candleCount || '?'} x 5m${p.candleCount1m ? ` · ${p.candleCount1m} x 1m` : ''}`
      }</div>
          </div>
          <div class="pred-expand-icon">${expanded ? '−' : '+'}</div>
        </div>

        <!-- Verdict Banner: always visible — this is the primary signal -->
        <div class="pred-verdict ${verdictDir}">
          <div class="pred-verdict-call">
            <span class="pred-verdict-main">${verdictMain}</span>
            <span class="pred-verdict-strength">${strength}</span>
          </div>
          <div class="pred-verdict-meta">
            <span class="pred-source-badge model">MODEL</span>
            ${llmBadge}
            ${_liveKPctCard !== null
        ? `<span class="pred-source-badge ${_fadeActive ? 'kalshi-fade' : 'kalshi-align'}">${_fadeActive ? '⚡ ' : ''}KALSHI ${_liveKPctCard}% YES</span>`
        : ''}
            <span style="color:${_modelProbColor};font-weight:700">${_modelProbStr}</span>
            <span>·</span>
            <span>${p.confidence}% conf</span>
            ${_edgePpCard != null && _edgePpCard >= 10 ? `<span style="color:${_edgePpCard >= 20 ? 'var(--color-green)' : '#ffd700'};font-weight:800;font-size:9px;padding:1px 5px;border-radius:3px;background:${_edgePpCard >= 20 ? 'rgba(38,212,126,0.12)' : 'rgba(255,215,0,0.12)'}">${_edgePpCard}pp ${_fadeActive ? 'FADE' : 'EDGE'}</span>` : ''}
            ${londonBadge}${calibBadge}${weakBadge}${safetyBadge}${hcBadge}
            <span style="font-size:9px;padding:2px 6px;border-radius:9999px;background:var(--color-surface-2);color:${setup15.cls === 'bull' ? 'var(--color-green)' : setup15.cls === 'bear' ? 'var(--color-red)' : 'var(--color-text-muted)'};font-weight:700;text-transform:uppercase">${setup15.label}</span>
          </div>
          ${(p.llm?.ai_wording?.wait_rationale) ? `<div class="pred-verdict-rationale" style="color:#8fa8ff"><span style="font-weight:700">✨ AI:</span> ${escapeHtml(p.llm.ai_wording.wait_rationale)}</div>` : waitRationale ? `<div class="pred-verdict-rationale">${waitRationale}</div>` : ''}
          ${(p.llm?.ai_wording?.high_confidence_rationale) ? `<div class="pred-verdict-rationale" style="color:#8fa8ff"><span style="font-weight:700">✨ AI:</span> ${escapeHtml(p.llm.ai_wording.high_confidence_rationale)}</div>` : hcRationale ? `<div class="pred-verdict-rationale">${hcRationale}</div>` : ''}
          ${(p.llm?.ai_wording?.primary_rationale) ? `<div class="pred-verdict-rationale" style="color:#8fa8ff"><span style="font-weight:700">✨ AI:</span> ${escapeHtml(p.llm.ai_wording.primary_rationale)}</div>` : ratPrimary ? `<div class="pred-verdict-rationale">${ratPrimary}</div>` : ''}
          <div class="pred-verdict-bar-wrap">
            <div class="pred-verdict-bar-fill ${verdictDir}" style="width:${p.confidence}%"></div>
          </div>
          <!-- Model vs Kalshi Comparison Bar -->
          ${_liveKPctCard !== null ? `
            <div class="pred-comparison-bar-wrap" title="Model vs Market: shows where model (top) differs from Kalshi crowd (bottom)">
              <div style="font-size:9px;color:var(--color-text-muted);margin-bottom:4px;display:flex;justify-content:space-between">
                <span>Model: ${_modelProbStr}</span>
                <span>Kalshi: ${_liveKPctCard}% YES</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <div style="flex:1;height:12px;background:rgba(0,0,0,0.1);border-radius:3px;position:relative;overflow:hidden">
                  <div style="height:100%;width:${_modelUpPct}%;background:${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'};border-radius:3px"></div>
                </div>
                <span style="font-size:9px;font-weight:700;min-width:35px;text-align:right;color:var(--color-text)">${_edgePpCard ?? '—'}pp</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                <div style="flex:1;height:12px;background:rgba(0,0,0,0.1);border-radius:3px;position:relative;overflow:hidden">
                  <div style="height:100%;width:${_liveKPctCard}%;background:${_liveKColorCard};border-radius:3px"></div>
                </div>
                <span style="font-size:9px;font-weight:700;min-width:35px;text-align:right;color:var(--color-text-muted)">crowd</span>
              </div>
            </div>
          ` : ''}
          ${model5mRow}
          ${kalshi15mRow}
          ${_k15mCoin ? renderFifteenMinuteMovePlan(_k15mCoin, true) : ''}
          ${(() => {
        // ── Market Divergence row ─────────────────────────────────────
        const _md = window._marketDivergence?.[p.sym];
        if (!_md?.active || _md.phase === 'STALE') return '';

        const phaseColors = {
          PRIME: ['rgba(38,212,126,0.10)', 'rgba(38,212,126,0.40)', 'var(--color-green)'],
          ACTIVE: ['rgba(0,150,255,0.09)', 'rgba(0,150,255,0.35)', '#4f9eff'],
          CATCHING: ['rgba(255,215,0,0.10)', 'rgba(255,215,0,0.40)', '#ffd700'],
          DIVERGING: ['rgba(220,60,60,0.09)', 'rgba(220,60,60,0.35)', 'var(--color-red)'],
          LATE: ['rgba(130,130,130,0.07)', 'rgba(130,130,130,0.25)', 'var(--color-text-muted)'],
        };
        const [bg, border, textColor] = phaseColors[_md.phase] || phaseColors.LATE;

        const phaseLabels = {
          PRIME: '🟢 PRIME WINDOW',
          ACTIVE: '🔵 ACTIVE',
          CATCHING: '🟡 CROWD CATCHING',
          DIVERGING: '🔴 CROWD DOUBLING DOWN',
          LATE: '⬜ LATE',
        };

        // Compute elapsed time live from firstDivTs (not from stale durationMs)
        const secElapsed = _md.firstDivTs ? Math.floor((Date.now() - _md.firstDivTs) / 1000) : 0;
        const minSec = secElapsed >= 60
          ? Math.floor(secElapsed / 60) + 'm ' + (secElapsed % 60) + 's'
          : secElapsed + 's';

        // Read live Kalshi probability directly — don't rely on stale snapshot value
        const liveKalshiPct = window.PredictionMarkets?.getCoin?.(p.sym)?.kalshi15m?.probability != null
          ? window.PredictionMarkets.getCoin(p.sym).kalshi15m.probability * 100
          : (_md.currentKalshiPct ?? null);

        // Recompute catchupDelta from live odds
        const liveCatchupDelta = (liveKalshiPct != null && _md.entryKalshiPct != null)
          ? (_md.entryModelDir === 'up' || _md.entryModelDir === 'UP'
            ? liveKalshiPct - _md.entryKalshiPct
            : _md.entryKalshiPct - liveKalshiPct)
          : (_md.catchupDelta ?? 0);

        const deltaStr = Math.abs(liveCatchupDelta) >= 0.5
          ? (liveCatchupDelta > 0
            ? `+${liveCatchupDelta.toFixed(1)}pp crowd → model`
            : `${liveCatchupDelta.toFixed(1)}pp crowd away`)
          : '';

        const entryHint = _md.phase === 'PRIME'
          ? 'Best entry window — model ahead of crowd'
          : _md.phase === 'ACTIVE'
            ? 'Divergence holding — monitor for catchup'
            : _md.phase === 'CATCHING'
              ? 'Crowd moving toward model — entry closing'
              : _md.phase === 'DIVERGING'
                ? 'Crowd opposing model — elevated risk'
                : 'Signal aging — verify before entry';

        return `
              <div style="margin-top:5px;padding:7px 10px;border-radius:4px;background:${bg};border:1px solid ${border};font-size:11px;font-family:var(--font-mono)">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span style="font-weight:900;letter-spacing:.3px;color:${textColor}">MKT DIV</span>
                  <span style="font-weight:800;color:${textColor}">${phaseLabels[_md.phase] ?? _md.phase}</span>
                  <span style="font-weight:700;color:var(--color-text)" data-mdiv-ts="${_md.firstDivTs ?? ''}">${minSec}</span>
                  ${deltaStr ? `<span style="margin-left:auto;color:var(--color-text-muted)">${deltaStr}</span>` : ''}
                </div>
                <div style="margin-top:3px;color:var(--color-text-muted);font-size:10px;font-family:var(--font-sans)">${entryHint}${_md.entryKalshiPct != null ? ` · Entry K: ${_md.entryKalshiPct.toFixed(0)}% → now ${liveKalshiPct != null ? liveKalshiPct.toFixed(0) : '?'}%` : ''}</div>
              </div>`;
      })()}
          ${(() => {
        const ki = window.KalshiOrchestrator?.getIntent?.(p.sym);
        if (!ki || ki.action === 'skip') return '';

        // ── Model probability: convert score (-1..+1) to directional % ───
        const modelUpPct = Math.round(Math.min(99, Math.max(1, 50 + (p.score || 0) * 50)));
        const modelDownPct = 100 - modelUpPct;
        const _strikeDirKi = (_k15mV?.strikeDir ?? _kAlignEarly?.strikeDir ?? 'above') === 'below' ? 'below' : 'above';
        const _yesDirKi = _strikeDirKi === 'below' ? 'down' : 'up';
        const _noDirKi = _yesDirKi === 'up' ? 'down' : 'up';
        const modelYesPct = Number.isFinite(_kAlignEarly?.modelYesPct)
          ? _kAlignEarly.modelYesPct
          : (_strikeDirKi === 'below' ? modelDownPct : modelUpPct);
        const modelLean = modelYesPct >= 58 ? _yesDirKi : modelYesPct <= 42 ? _noDirKi : 'neutral';
        const modelLeanStr = modelLean === 'up' ? `${modelUpPct}% UP`
          : modelLean === 'down' ? `${modelDownPct}% DOWN`
            : 'NEUTRAL';
        const modelColor = modelLean === 'up' ? 'var(--color-green)'
          : modelLean === 'down' ? 'var(--color-red)'
            : 'var(--color-text-muted)';

        // ── Live Kalshi probability (always fresh from PredictionMarkets) ─
        const _pmCoin = window.PredictionMarkets?.getCoin?.(p.sym);
        const _pmK15 = _pmCoin?.kalshi15m ?? null;
        const liveKProb = _pmK15?.probability ?? kalshiProb;
        const liveKPct = liveKProb != null ? Math.round(liveKProb * 100) : null;
        const kalshiLean = liveKProb != null ? (liveKProb >= 0.5 ? _yesDirKi : _noDirKi) : null;
        const kalshiLeanStr = liveKProb == null ? '—'
          : liveKProb >= 0.5 ? `${liveKPct}% YES`
            : `${100 - liveKPct}% NO`;
        const kalshiColor = liveKProb == null ? 'var(--color-text-muted)'
          : kalshiLean === 'up' ? 'var(--color-green)' : 'var(--color-red)';

        // ── Alignment badge ───────────────────────────────────────────────
        const proAgree = modelLean !== 'neutral' && kalshiLean !== null && modelLean === kalshiLean;
        const proFade = modelLean !== 'neutral' && kalshiLean !== null && modelLean !== kalshiLean;
        const edgePp = liveKPct != null ? Math.abs(modelUpPct - liveKPct) : null;
        const alignBadge = proAgree ? `<span style="color:var(--color-green);font-weight:800">✓ AGREE</span>`
          : proFade ? `<span style="color:#ff9800;font-weight:800">⚡ FADE</span>`
            : `<span style="color:var(--color-text-muted)">—</span>`;

        // ── Styling ───────────────────────────────────────────────────────
        const isExit = ki.action === 'earlyExit';
        const isHold = ki.action === 'hold';
        const isTrade = ki.action === 'trade';
        const isCrowdFade = ki.alignment === 'CROWD_FADE' || !!ki.crowdFade;
        const isDivergent = ki.alignment === 'DIVERGENT';
        const rowBg = isExit ? 'rgba(255,80,80,0.07)' : isHold ? 'rgba(255,180,0,0.07)'
          : isCrowdFade ? 'rgba(224,64,251,0.08)'
            : isTrade ? 'rgba(0,200,100,0.07)' : 'rgba(200,200,0,0.05)';
        const rowBdr = isExit ? 'rgba(255,80,80,0.2)' : isHold ? 'rgba(255,180,0,0.25)'
          : isCrowdFade ? 'rgba(224,64,251,0.25)'
            : isTrade ? 'rgba(0,200,100,0.2)' : 'rgba(200,200,0,0.15)';

        // ── Contract expiry guard ─────────────────────────────────────────
        // ki is stale cache — if closeTimeMs is in the past, new contract not yet listed.
        const contractExpired = ki.closeTimeMs && (Date.now() - ki.closeTimeMs) > 5_000;
        if (contractExpired) {
          // ── Build rotating insight carousel ──────────────────────────────
          const _ins = [];

          // 1. Model direction + score
          _ins.push({
            label: 'MODEL SIGNAL',
            icon: modelLean === 'up' ? '▲' : modelLean === 'down' ? '▼' : '◆',
            value: modelLeanStr,
            color: modelColor,
            detail: `score ${(p.score > 0 ? '+' : '') + (p.score?.toFixed(2) ?? '—')}`,
          });

          // 2. Agree / Fade alignment vs Kalshi
          if (liveKPct != null) {
            _ins.push({
              label: proAgree ? 'AGREE W/ KALSHI' : proFade ? 'FADE SIGNAL' : 'NEUTRAL',
              icon: proAgree ? '✓' : proFade ? '⚡' : '—',
              value: `Model ${modelLeanStr}  ↔  Kalshi ${kalshiLeanStr}`,
              color: proAgree ? 'var(--color-green)' : proFade ? '#ff9800' : 'var(--color-text-muted)',
              detail: edgePp != null ? edgePp + 'pp gap' : '',
            });
          }

          // 3. Last settled contract for this coin
          const _lastRes = window._resolutionMap?.[p.sym];
          if (_lastRes) {
            const _icon = _lastRes.modelCorrect === true ? '✅' : _lastRes.modelCorrect === false ? '❌' : '—';
            _ins.push({
              label: 'LAST CONTRACT',
              icon: _icon,
              value: (_lastRes.actualOutcome ?? '—') + '  ·  K: ' + (_lastRes.kalshiResult?.toUpperCase() ?? '—'),
              color: _lastRes.modelCorrect === true ? 'var(--color-green)' : _lastRes.modelCorrect === false ? 'var(--color-red)' : 'var(--color-text-muted)',
              detail: _lastRes.wickedOut ? '⚡ wicked out' : `entry K: ${Math.round((_lastRes.entryProb ?? 0) * 100)}%`,
            });
          }

          // 4. Session accuracy for this coin
          const _resLog = (window._15mResolutionLog || []).filter(e => e.sym === p.sym);
          if (_resLog.length >= 2) {
            const _corr = _resLog.filter(e => e.modelCorrect === true).length;
            const _wr = Math.round(_corr / _resLog.length * 100);
            const _trd = _resLog.filter(e => e.orchestratorAction === 'trade');
            const _tWr = _trd.length ? Math.round(_trd.filter(e => e.modelCorrect).length / _trd.length * 100) : null;
            _ins.push({
              label: 'SESSION ACCURACY',
              icon: _wr >= 55 ? '📈' : _wr >= 45 ? '📊' : '📉',
              value: `${_wr}%  (${_corr}/${_resLog.length} calls)`,
              color: _wr >= 55 ? 'var(--color-green)' : _wr >= 45 ? '#ffd700' : 'var(--color-red)',
              detail: _tWr != null ? `Traded WR: ${_tWr}%` : '',
            });
          }

          // 5. CFM momentum
          const _cfm = (window._cfmAll || window._lastCfm || {})[p.sym];
          if (_cfm?.momentum != null) {
            const _mom = _cfm.momentum;
            _ins.push({
              label: 'CFM MOMENTUM',
              icon: _mom > 0.008 ? '⚡' : _mom < -0.008 ? '⬇' : '◆',
              value: (_mom > 0 ? '+' : '') + _mom.toFixed(4) + '  ·  ' + (_cfm.trend ?? 'neutral'),
              color: _mom > 0.004 ? 'var(--color-green)' : _mom < -0.004 ? 'var(--color-red)' : 'var(--color-text-muted)',
              detail: (_cfm.sourceCount ?? 0) + ' sources',
            });
          }

          // 6. Wick warning if recent wicks exist
          const _wicks = _resLog.filter(e => e.wickedOut).length;
          if (_wicks > 0) {
            _ins.push({
              label: 'WICK ALERT',
              icon: '⚡',
              value: `${_wicks} wick${_wicks > 1 ? 's' : ''} this session — enter early`,
              color: '#ff9800',
              detail: 'last-45s price manipulation risk',
            });
          }

          // 7. Sweet spot window hint
          _ins.push({
            label: 'SWEET SPOT WINDOW',
            icon: '⭐',
            value: '3 – 6 min after contract opens',
            color: '#ffd700',
            detail: 'payout ≥1.65×  ·  best entry window',
          });

          // 8. Trade recommendation preview
          if (modelLean !== 'neutral' && (proAgree || proFade)) {
            const modelSide = modelLean === _yesDirKi ? 'YES' : modelLean === _noDirKi ? 'NO' : '—';
            const _rec = proFade
              ? `Fade the crowd — bet ${modelSide} when contract opens`
              : `${modelSide} side favoured — watch for entry`;
            _ins.push({
              label: proFade ? 'FADE OPPORTUNITY' : 'ENTRY WATCH',
              icon: proFade ? '🔄' : '👁',
              value: _rec,
              color: proFade ? '#ff9800' : 'var(--color-text)',
              detail: `confidence ready when contract lists`,
            });
          }

          // Store in global map for the rotation interval to read
          window._kiInsights = window._kiInsights || {};
          window._kiInsights[p.sym] = _ins;

          const _insFirst = _ins[0];
          return `<div id="ki-await-${p.sym}" style="margin-top:6px;padding:8px 10px;border-radius:5px;background:rgba(100,100,100,0.06);border:1px solid rgba(120,120,120,0.15);font-family:var(--font-mono);transition:opacity 0.25s ease">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span style="font-size:9px;font-weight:700;color:var(--color-text-faint);letter-spacing:.5px;text-transform:uppercase;min-width:110px">${_insFirst.label}</span>
                  <strong style="font-size:13px;color:${_insFirst.color}">${_insFirst.icon} ${_insFirst.value}</strong>
                  ${_insFirst.detail ? `<span style="margin-left:auto;font-size:10px;color:var(--color-text-faint)">${_insFirst.detail}</span>` : ''}
                </div>
                <div style="display:flex;gap:3px;margin-top:4px">${_ins.map((_, j) => `<span style="width:16px;height:2px;border-radius:1px;background:${j === 0 ? 'var(--color-primary,#7c6aff)' : 'rgba(255,255,255,0.12)'}" id="ki-dot-${p.sym}-${j}"></span>`).join('')}</div>
              </div>`;
        }

        // ── Active contract ───────────────────────────────────────────────
        const sideColor = ki.side === 'YES' ? 'var(--color-green)' : ki.side === 'NO' ? 'var(--color-red)' : 'var(--color-orange)';
        const sideBg = ki.side === 'YES' ? 'rgba(0,200,100,0.18)' : ki.side === 'NO' ? 'rgba(220,60,60,0.18)' : 'transparent';
        const actionLabel = isTrade ? '🟢 TRADE' : isExit ? '🔴 EXIT' : isHold ? '⏳ HOLD' : '👁 WATCH';
        const strikeLabel = (() => { const m = ki.contractTicker?.match(/T(\d+(?:\.\d+)?)$/); return m ? 'T' + Number(m[1]).toLocaleString() : '';   // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();
        const liveSecsLeft = ki.closeTimeMs ? Math.max(0, (ki.closeTimeMs - Date.now()) / 1000) : null;
        const fmtSecsLeft = s => s == null ? null : s < 60 ? Math.round(s) + 's' : (s / 60).toFixed(1) + 'm';
        const minsStr = fmtSecsLeft(liveSecsLeft);
        const alignTag = {
          ALIGNED: '✓ Both agree',
          DIVERGENT: '⚡ Model vs crowd',
          CROWD_FADE: '🔄 Mispricing fade',
          MODEL_LEADS: 'Model leads',
          KALSHI_ONLY: 'Kalshi only',
          MODEL_ONLY: 'Model only',
          EARLY_EXIT: 'Early exit',
          SHELL_EVAL: 'Evaluating',
        }[ki.alignment] ?? (ki.alignment ?? '');
        return `
            <div style="margin-top:6px;padding:8px 10px;border-radius:5px;background:${rowBg};border:1px solid ${rowBdr};font-family:var(--font-mono)">
              ${isExit
            ? `<div style="display:flex;align-items:center;gap:8px">
                     <span style="background:rgba(255,80,80,0.22);color:var(--color-red);padding:4px 14px;border-radius:4px;font-size:13px;font-weight:800;letter-spacing:.6px">STAND ASIDE</span>
                     <span style="font-size:11px;color:var(--color-text-muted)">CFM early-exit — do not enter</span>
                   </div>`
            : isHold
              ? `<div style="display:flex;align-items:center;gap:8px">
                     <span style="background:rgba(255,180,0,0.22);color:var(--color-gold,#f90);padding:4px 14px;border-radius:4px;font-size:13px;font-weight:800;letter-spacing:.6px">⏳ EVALUATING WALL</span>
                     <span style="font-size:11px;color:var(--color-text-muted)">Collecting sell-pressure data…</span>
                   </div>`
              : `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                     <span style="background:${sideBg};color:${sideColor};padding:4px 14px;border-radius:4px;font-size:15px;font-weight:800;letter-spacing:.8px">${ki.side}</span>
                     <span style="font-size:12px;font-weight:700;color:var(--color-text)">KALSHI${strikeLabel ? ' · ' + strikeLabel : ''}</span>
                     <span style="margin-left:auto;background:${isTrade ? 'rgba(0,200,100,0.15)' : 'rgba(200,200,0,0.12)'};color:${isTrade ? 'var(--color-green)' : 'var(--color-orange)'};padding:3px 10px;border-radius:3px;font-size:12px;font-weight:700">${actionLabel}</span>
                   </div>`}
              <!-- Model vs Kalshi probability — the primary insight -->
              <div style="margin-top:6px;padding:6px 8px;border-radius:4px;background:rgba(0,0,0,0.12);font-size:12px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:${liveKPct != null ? '5px' : '0'}">
                  <span style="color:var(--color-text-muted);font-size:10px;font-weight:600;letter-spacing:.4px">MODEL</span>
                  <strong style="font-size:14px;color:${modelColor}">${modelLeanStr}</strong>
                  <span style="color:var(--color-text-faint);font-size:16px;font-weight:300">↔</span>
                  <span style="color:var(--color-text-muted);font-size:10px;font-weight:600;letter-spacing:.4px">KALSHI</span>
                  <strong style="font-size:14px;color:${kalshiColor}">${kalshiLeanStr}</strong>
                  <span style="margin-left:auto;display:flex;align-items:center;gap:6px">
                    ${alignBadge}
                    ${edgePp != null ? `<span style="color:${edgePp >= 20 ? 'var(--color-green)' : edgePp >= 10 ? '#ffd700' : 'var(--color-text-faint)'};font-size:10px;font-weight:${edgePp >= 15 ? '800' : '600'}">${edgePp}pp${edgePp >= 20 ? ' ⚡' : edgePp >= 10 ? ' ▲' : ''}</span>` : ''}
                  </span>
                </div>
                ${liveKPct != null ? `
                <div style="display:grid;grid-template-columns:44px 1fr;row-gap:3px;align-items:center;font-size:9px">
                  <span style="color:var(--color-text-muted);text-align:right;padding-right:5px">MDL</span>
                  <div style="height:5px;border-radius:2px;background:rgba(255,255,255,0.07);position:relative;overflow:hidden">
                    <div style="position:absolute;inset:0 ${100 - modelUpPct}% 0 0;background:${modelColor};border-radius:2px"></div>
                    <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.18)"></div>
                  </div>
                  <span style="color:var(--color-text-muted);text-align:right;padding-right:5px">KAL</span>
                  <div style="height:5px;border-radius:2px;background:rgba(255,255,255,0.07);position:relative;overflow:hidden">
                    <div style="position:absolute;inset:0 ${100 - liveKPct}% 0 0;background:${kalshiColor};border-radius:2px"></div>
                    <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.18)"></div>
                  </div>
                </div>` : ''}
              </div>
              <div style="display:flex;gap:12px;font-size:11px;color:var(--color-text-faint);margin-top:5px;flex-wrap:wrap;align-items:center">
                ${ki.closeTimeMs ? `<span id="kalshi-min-${p.sym}" data-close-ms="${ki.closeTimeMs}">⏱ <strong>${minsStr ?? '…'}</strong> left</span>` : minsStr ? `<span>⏱ <strong>${minsStr}</strong> left</span>` : ''}
                ${ki.suggestedEntry != null ? `<span>Entry ~<strong>$${ki.suggestedEntry.toFixed(2)}</strong></span>` : ''}
                <span style="color:${isTrade ? 'var(--color-green)' : isDivergent ? 'var(--color-orange)' : 'var(--color-text-muted)'}">${alignTag} · <strong>${ki.confidence}%</strong></span>
              </div>
              ${ki.humanReason ? `<div style="font-size:11px;color:var(--color-text-muted);margin-top:5px;line-height:1.4;font-family:var(--font-sans)">${ki.humanReason}</div>` : ''}
              ${renderFifteenMinuteMovePlan(ki)}
              ${ki.sweetSpot ? `<div style="font-size:12px;color:#ffd700;font-weight:800;margin-top:5px;letter-spacing:.4px">⭐ SWEET SPOT — <span id="kalshi-ss-${p.sym}" data-close-ms="${ki.closeTimeMs ?? ''}">${minsStr ?? '?'}</span> until close · ${ki.payoutMult?.toFixed(2)}x payout · best entry window (3–6 min)</div>` : ''}
              ${ki.crowdFade ? `<div style="font-size:12px;color:#ff9800;font-weight:800;margin-top:5px;letter-spacing:.4px">🔄 CROWD FADE — ${ki.crowdFadeTimingLabel || 'adaptive'} timing${ki.crowdFadeWindowLabel ? ` · ${ki.crowdFadeWindowLabel}` : ''} · going ${ki.direction}</div>` : ''}
              ${ki.crowdFadeSuggested && !ki.crowdFade ? `<div style="font-size:11px;color:#ffb74d;font-weight:700;margin-top:4px">⏳ CROWD FADE SETUP — mispricing persisting (${ki.crowdFadeMispricingPp ?? '?'}pp), confirm in ${ki.crowdFadeConfirmLeftSec ?? '?'}s${ki.crowdFadeTimingLabel ? ` · ${ki.crowdFadeTimingLabel}` : ''}${ki.crowdFadeWindowLabel ? ` · ${ki.crowdFadeWindowLabel}` : ''}</div>` : ''}
              ${ki.signalLocked ? `<div style="font-size:11px;color:var(--color-text-muted);margin-top:4px">🔒 Signal locked (${ki.humanReason?.match(/\d+s/)?.[0] || '?'} ago) — holding position</div>` : ''}
              ${ki.illiquid ? `<div style="font-size:11px;color:var(--color-orange);margin-top:4px">⚠ Low liquidity ($${ki.liquidity?.toFixed(0)}) — size carefully</div>` : ''}
              ${!isTrade && isDivergent ? `<div style="font-size:11px;color:var(--color-orange);margin-top:4px">⚠ Kalshi vs model disagree — watch only, do not trade</div>` : ''}
              ${!isTrade && (ki.stageDiagnostics?.suppressionReasons?.length || ki.blockedBy?.length) ? `<div style="font-size:11px;color:var(--color-text-faint);margin-top:4px">Gate trace: ${((ki.stageDiagnostics?.suppressionReasons || []).concat(ki.blockedBy || []).filter(Boolean).slice(0, 4)).join(' · ')}</div>` : ''}
            </div>`;
      })()}
        </div>

        ${rfRow}
        <!-- Expanded detail: hidden until card is clicked -->
        <div class="pred-expand-panel ${expanded ? 'open' : ''}">

          <div class="ind-grid" style="margin-bottom:12px">
            <div class="ind-item"><span class="ind-name">Model Quality</span><span class="ind-val ${reliabilityPct >= 60 ? 'bull' : reliabilityPct < 45 ? 'bear' : 'flat'}">${hasBacktest ? `${qualityLabel} (${reliabilityPct}%)` : qualityLabel}</span></div>
            <div class="ind-item"><span class="ind-name">Trade Fit</span><span class="ind-val ${tradeFitPct >= 62 ? 'bull' : tradeFitPct < 45 ? 'bear' : 'flat'}">${hasBacktest ? `${tradeFitLabel} (${tradeFitPct}%)` : tradeFitLabel}</span></div>
            <div class="ind-item"><span class="ind-name">Signal Alignment</span><span class="ind-val ${agreementPct >= 70 ? 'bull' : conflictPct >= 35 ? 'bear' : 'flat'}">${agreementPct}% aligned / ${conflictPct}% conflict</span></div>
            ${horizonRows.map(horizon => `<div class="ind-item"><span class="ind-name">UP/DOWN ${horizon.label}</span><span class="ind-val ${btClass(horizon.stats)}">${horizon.stats && horizon.stats.activeSignals ? `${horizon.stats.winRate.toFixed(0)}% win · ${fmtPct(Math.min(Math.max(horizon.stats.equity?.returnPct || 0, -9999), 9999))}` : 'Not enough signals'}</span></div>`).join('')}
            <div class="ind-item"><span class="ind-name">Decision Gate</span><span class="ind-val ${vetoReason ? 'bear' : inBufferZone ? 'flat' : 'bull'}">${vetoReason || (inBufferZone ? 'Buffer zone' : 'Clear to trade')}</span></div>
            <div class="ind-item ind-mdt">
              <span class="ind-name">Bias Gate</span>
              <span class="ind-val ${mdtBias === 'bullish' ? 'bull' : mdtBias === 'bearish' ? 'bear' : 'flat'}">
                ${mdtRegimeLabel}
                ${mdtPreemptive ? '<span class="mdt-pre-tag">PRE</span>' : ''}
                · ${mdtConf}% conf
                ${mdtVerdict !== 'HOLD' ? `· <strong>${mdtVerdict}</strong>` : ''}
              </span>
            </div>
            <div class="ind-item"><span class="ind-name">Router</span><span class="ind-val ${routeClass(routedAction)}">${routedAction}</span></div>
            <div class="ind-item"><span class="ind-name">Long-range Context</span><span class="ind-val ${advancedQualityPct >= 58 ? 'bull' : advancedQualityPct < 42 ? 'bear' : 'flat'}">${advanced ? `${advancedQualityPct}% quality · ${advancedFitPct}% fit${advancedVol ? ` · ${advancedVol.regime}` : ''}` : 'Loading full history'}</span></div>
          </div>

          <div class="ind-grid" style="margin-bottom:12px">
            <div class="ind-item"><span class="ind-name">RSI(14)</span><span class="ind-val ${indClass(ind.rsi?.signal || 0)}">${ind.rsi?.value?.toFixed(1) ?? '—'} ${ind.rsi?.label ?? ''}</span></div>
            <div class="ind-item"><span class="ind-name">EMA 9/21</span><span class="ind-val ${indClass(ind.ema?.signal || 0)}">${ind.ema?.label ?? '—'}</span></div>
            <div class="ind-item"><span class="ind-name">VWAP</span><span class="ind-val ${indClass(ind.vwap?.signal || 0)}">${Number.isFinite(ind.vwap?.value) ? `${ind.vwap.value > 0 ? '+' : ''}${ind.vwap.value.toFixed(2)}%` : '—'} ${ind.vwap?.label ?? ''}</span></div>
            <div class="ind-item"><span class="ind-name">OBV</span><span class="ind-val ${indClass(ind.obv?.signal || 0)}">${ind.obv?.label ?? '—'}</span></div>
            <div class="ind-item"><span class="ind-name">Vol Flow</span><span class="ind-val ${indClass(ind.volume?.signal || 0)}">${ind.volume?.label ?? '—'}</span></div>
            <div class="ind-item"><span class="ind-name">Momentum</span><span class="ind-val ${indClass(ind.momentum?.signal || 0)}">${Number.isFinite(ind.momentum?.value) ? `${ind.momentum.value > 0 ? '+' : ''}${ind.momentum.value.toFixed(2)}%` : '—'}</span></div>
            ${depthRows}
            ${ind.bands ? `<div class="ind-item"><span class="ind-name">Bands</span><span class="ind-val ${indClass(ind.bands.signal)}">${ind.bands.label}</span></div>` : ''}
            ${ind.persistence ? `<div class="ind-item"><span class="ind-name">Persistence</span><span class="ind-val ${indClass(ind.persistence.signal)}">${ind.persistence.label}</span></div>` : ''}
            ${ind.structure ? `<div class="ind-item"><span class="ind-name">Structure</span><span class="ind-val ${indClass(ind.structure.signal)}">${ind.structure.label}</span></div>` : ''}
            ${ind.book ? `<div class="ind-item"><span class="ind-name">Book</span><span class="ind-val ${ind.book.imbalance > 0.2 ? 'bull' : ind.book.imbalance < -0.2 ? 'bear' : 'flat'}">${(ind.book.label || "—").split('\u2014')[0]}</span></div>` : ''}
            ${ind.flow ? `<div class="ind-item"><span class="ind-name">Tape</span><span class="ind-val ${ind.flow.aggressor === 'buyers' ? 'bull' : ind.flow.aggressor === 'sellers' ? 'bear' : 'flat'}">${(ind.flow.label || "—").split('(')[0]}</span></div>` : ''}
            ${fastTiming ? `<div class="ind-item"><span class="ind-name">Pooled 1m</span><span class="ind-val ${fastTiming.score > 0.12 ? 'bull' : fastTiming.score < -0.12 ? 'bear' : 'flat'}">${fastTiming.label}</span></div>` : ''}
          </div>

          <div class="proj-section">
            <div class="proj-title">Why it fired</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">
              ${topDrivers.map(driver => `<span style="font-size:9px;padding:3px 6px;background:var(--color-surface-2);border-radius:9999px;color:${driver.direction === 'up' ? 'var(--color-green)' : 'var(--color-red)'}">${driver.label}: ${driver.detail}</span>`).join('')}
              ${fastTiming ? `<span style="font-size:9px;padding:3px 6px;background:var(--color-surface-2);border-radius:9999px;color:${fastTiming.score > 0 ? 'var(--color-green)' : fastTiming.score < 0 ? 'var(--color-red)' : 'var(--color-text-muted)'}">1m pulse: ${fastTiming.label}</span>` : ''}
              ${routedRiskFlags.map(flag => `<span style="font-size:9px;padding:3px 6px;background:var(--color-red-dim);border-radius:9999px;color:var(--color-red)">${flag}</span>`).join('')}
              ${mdtPath.slice(0, 5).map(step => `
                <span style="font-size:9px;padding:3px 6px;background:var(--color-surface-2);border-radius:9999px;color:${step.pass === false ? 'var(--color-text-faint)' : mdtBias === 'bullish' ? 'var(--color-green)' : mdtBias === 'bearish' ? 'var(--color-red)' : 'var(--color-text-muted)'}">
                  MDT/${step.node}${step.result ? ': ' + step.result : ''}
                </span>`).join('')}
            </div>
            <div style="font-size:11px;color:var(--color-text-muted);line-height:1.45">${routedSummary}</div>
          </div>

          <div class="proj-section">
            <div class="proj-title">Resolution Range</div>
            ${horizonRows.filter(horizon => horizon.projection).map(horizon => `
              <div class="proj-row">
                <span class="proj-label">${horizon.label}</span>
                <span style="color:var(--color-red);font-size:10px">${fmtPrice(horizon.projection.low)}</span>
                <div class="proj-range">
                  <div class="proj-target ${confClass}" style="left:50%"></div>
                </div>
                <span style="color:var(--color-green);font-size:10px">${fmtPrice(horizon.projection.high)}</span>
                <span class="proj-val" style="color:${p.score >= 0 ? 'var(--color-green)' : 'var(--color-red)'}">${fmtPrice(horizon.projection.target)}</span>
              </div>
            `).join('')}
          </div>

          <div class="pred-detail-grid" style="margin-top:10px">
            <div class="cfm-detail-card"><span class="cfm-detail-label">Consensus</span><strong>${p.diagnostics?.consensusLabel || 'Balanced'}</strong><small>${agreementPct}% aligned</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Raw Score</span><strong>${(p.rawScore ?? p.score).toFixed(3)}</strong><small>pre-calibration</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Trade Horizon</span><strong>${preferredHorizon}m bias</strong><small>${tradeFitLabel}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">15m Window Setup</span><strong>${setup15.label.replace('15m setup: ', '').toUpperCase()}</strong><small>${setup15.detail}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Decision Buffer</span><strong>${inBufferZone ? 'Inside buffer' : 'Outside buffer'}</strong><small>${vetoReason || `score ±${((p.diagnostics?.scoreBuffer || 0) * 100).toFixed(0)}bp gate`}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Router Verdict</span><strong>${routedAction}</strong><small>${routedRiskFlags.length ? routedRiskFlags.join(', ') : 'clean packet flow'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Funding</span><strong>${p.derivatives ? fmtPct(p.derivatives.funding) : '—'}</strong><small>${p.derivatives?.exchange || 'no perp feed'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">CVD Slope</span><strong>${p.cvd?.slope ? fmtPct(p.cvd.slope) : '—'}</strong><small>${p.cvd?.slope > 0 ? 'buyers leading' : p.cvd?.slope < 0 ? 'sellers leading' : 'flat flow'}</small></div>
            ${horizonRows.map(horizon => `<div class="cfm-detail-card"><span class="cfm-detail-label">${horizon.label} Filter</span><strong>${horizon.stats?.entryThreshold ? horizon.stats.entryThreshold.toFixed(2) : '—'} / ${horizon.stats?.minAgreement ? Math.round(horizon.stats.minAgreement * 100) + '%' : '—'}</strong><small>score / agreement gate</small></div>`).join('')}
            <div class="cfm-detail-card"><span class="cfm-detail-label">Advanced Span</span><strong>${advanced ? `${advanced.startDate} → ${advanced.endDate}` : '—'}</strong><small>${advanced ? `${advanced.candleCount} daily candles` : 'full-history loading'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Advanced 1d / 7d</span><strong>${advanced?.d1?.activeSignals ? `${advanced.d1.winRate.toFixed(0)}%` : '—'} / ${advanced?.d7?.activeSignals ? `${advanced.d7.winRate.toFixed(0)}%` : '—'}</strong><small>${advanced ? `${advancedQualityPct}% quality · ${advancedFitPct}% fit` : 'no data yet'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Advanced Vol (7d)</span><strong>${advancedVol ? `${advancedVol.regime} · ${Number(advancedVol.volPercentile || 0).toFixed(0)}p` : '—'}</strong><small>${advancedVol ? `EWMA ${Number(advancedVol.ewmaVolPct || 0).toFixed(2)}% · Jump ${((Number(advancedVol.jumpRatio) || 0) * 100).toFixed(1)}%` : 'volatility snapshot pending'}</small></div>
            ${horizonRows.map(horizon => `<div class="cfm-detail-card"><span class="cfm-detail-label">${horizon.label} Strong Bucket</span><strong>${horizon.stats?.buckets?.strong?.trades ?? 0}</strong><small>${horizon.stats?.buckets?.strong ? horizon.stats.buckets.strong.winRate.toFixed(0) + '% win · DD ' + (horizon.stats.equity?.maxDrawdownPct || 0).toFixed(1) + '%' : 'no data'}</small></div>`).join('')}
          </div>

          ${(p.scalpSetups || []).length ? `
            <div class="pred-setup-list">
              ${(p.scalpSetups || []).slice(0, 4).map(s => `
                <div class="pred-setup-item"><strong>${s.label}</strong><span>${s.desc}</span></div>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <!-- Footer: always visible -->
        <div class="pred-footer">
          <div>
            <span class="vol-badge ${(p.volatility?.label || 'unknown').toLowerCase()}">Vol: ${p.volatility?.label || 'Unknown'} (${(p.volatility?.atrPct || 0).toFixed(2)}%)</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${scalpCount > 0 ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-green-dim);color:var(--color-green);border-radius:9999px;font-weight:700">${scalpCount} scalp</span>` : ''}
            ${contrarianCount > 0 ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-orange-dim);color:var(--color-orange);border-radius:9999px;font-weight:700">${contrarianCount} contrarian</span>` : ''}
            ${fastTiming ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:${fastTiming.score > 0 ? 'var(--color-green)' : fastTiming.score < 0 ? 'var(--color-red)' : 'var(--color-text-muted)'};border-radius:9999px;font-weight:700">1m ${fastTiming.label}</span>` : ''}
            ${p.backtest ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:var(--color-text-muted);border-radius:9999px;font-weight:700">${reliabilityPct}% quality</span>` : ''}
            ${p.backtest ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:var(--color-text-muted);border-radius:9999px;font-weight:700">${tradeFitPct}% fit</span>` : ''}
            ${vetoReason ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-red-dim);color:var(--color-red);border-radius:9999px;font-weight:700">${vetoReason}</span>` : inBufferZone ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:var(--color-orange);border-radius:9999px;font-weight:700">Buffer zone</span>` : ''}
          </div>
          <span>${p.updatedAt}</span>
        </div>
      </div>
    `;
  }

  // ================================================================
  // ORDER BOOK DEPTH — View, Live Updates, Liquidity Map, HUD
  // ================================================================

  function renderDepth() {
    const syms = PREDICTION_COINS.map(c => c.sym);
    let selSym = window._depthSelectedSym || syms[0];
    if (!syms.includes(selSym)) selSym = syms[0];
    window._depthSelectedSym = selSym;
    const coin = PREDICTION_COINS.find(c => c.sym === selSym);
    const book = window.OB?.books?.[selSym] || { bids: [], asks: [], mid: 0, spread: 0, spreadPct: 0 };
    const fmtQty = (q) => window.OB?.formatQty?.(selSym, q) ?? q.toFixed(2);

    const coinTabs = syms.map(s => {
      const c = PREDICTION_COINS.find(x => x.sym === s);
      const active = s === selSym ? 'active' : '';
      const connected = window.OB?.getConnected?.()?.includes(s);
      return `<button class="depth-coin-tab ${active}" data-depth-sym="${s}">
        <span class="dtab-dot" style="background:${c.color}"></span>
        ${s}
        <span class="dtab-ws ${connected ? 'on' : 'off'}"></span>
      </button>`;
    }).join('');

    // Build order book ladder
    const MAX_LEVELS = 15;
    const allQtys = [...book.bids.slice(0, MAX_LEVELS), ...book.asks.slice(0, MAX_LEVELS)].map(([, q]) => q);
    const maxQty = allQtys.length > 0 ? Math.max(...allQtys) : 1;
    const minQty = window.OB?.WALL_MIN_QTY?.[selSym] || 0;
    const avgQty = allQtys.length > 0 ? allQtys.reduce((a, b) => a + b, 0) / allQtys.length : 1;
    const wallThresh = Math.max(minQty, avgQty * (window.OB?.WALL_MULTI || 3.5));

    const fmtPrice = (p) => {
      if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (p >= 1) return p.toFixed(4);
      return p.toFixed(6);
    };

    const askRows = book.asks.slice(0, MAX_LEVELS).reverse().map(([price, qty]) => {
      const pct = (qty / maxQty) * 100;
      const isWall = qty >= wallThresh;
      return `<div class="ob-row ask ${isWall ? 'ob-wall' : ''}">
        <span class="ob-price">${fmtPrice(price)}</span>
        <div class="ob-bar-wrap"><div class="ob-bar ask" style="width:${pct.toFixed(1)}%"></div></div>
        <span class="ob-qty">${fmtQty(qty)}</span>
        ${isWall ? '<span class="ob-wall-badge">WALL</span>' : ''}
      </div>`;
    }).join('');

    const spreadRow = `<div class="ob-spread-row">
      <span>Spread: ${book.spread ? fmtPrice(book.spread) : '—'}</span>
      <span>${book.spreadPct ? book.spreadPct.toFixed(4) + '%' : ''}</span>
      <span class="ob-mid">${book.mid ? '$' + fmtPrice(book.mid) : '—'}</span>
    </div>`;

    const bidRows = book.bids.slice(0, MAX_LEVELS).map(([price, qty]) => {
      const pct = (qty / maxQty) * 100;
      const isWall = qty >= wallThresh;
      return `<div class="ob-row bid ${isWall ? 'ob-wall' : ''}">
        <span class="ob-price">${fmtPrice(price)}</span>
        <div class="ob-bar-wrap"><div class="ob-bar bid" style="width:${pct.toFixed(1)}%"></div></div>
        <span class="ob-qty">${fmtQty(qty)}</span>
        ${isWall ? '<span class="ob-wall-badge">WALL</span>' : ''}
      </div>`;
    }).join('');

    // Recent alerts for this coin (last 20)
    const coinAlerts = (window.OB?.wallAlerts || []).filter(a => a.sym === selSym).slice(0, 20);
    const alertRows = coinAlerts.length === 0
      ? `<div class="ob-alert-empty">No wall events yet — monitoring live</div>`
      : coinAlerts.map(a => {
        const ago = Math.round((Date.now() - a.ts) / 1000);
        const agoStr = ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`;
        return `<div class="ob-alert-row ${a.bias.toLowerCase()}">
            <span class="ob-alert-dot ${a.bias.toLowerCase()}"></span>
            <span class="ob-alert-text">${a.side}-WALL <strong>${a.type}</strong> @ $${fmtPrice(a.price)}</span>
            <span class="ob-alert-qty">qty: ${fmtQty(a.qty)}</span>
            <span class="ob-alert-age">${agoStr}</span>
          </div>`;
      }).join('');

    const el = document.getElementById('content');
    el.innerHTML = `
      <div class="depth-wrap">
        <div class="depth-coin-tabs">${coinTabs}</div>
        <div class="depth-main">
          <div class="depth-book-panel">
            <div class="depth-panel-title">
              <span style="color:${coin.color}">●</span> ${coin.name} Live Order Book
              <span class="ob-live-badge">LIVE</span>
            </div>
            <div class="ob-ladder">
              <div class="ob-section-label ask">ASK / RESISTANCE</div>
              ${askRows || '<div class="ob-empty">Connecting…</div>'}
              ${spreadRow}
              <div class="ob-section-label bid">BID / SUPPORT</div>
              ${bidRows || '<div class="ob-empty">Connecting…</div>'}
            </div>
          </div>
          <div class="depth-map-panel">
            <div class="depth-panel-title">Liquidity Map <span style="font-size:11px;color:var(--color-text-muted)">(15m rolling)</span></div>
            <canvas id="liq-map-canvas" class="liq-map-canvas"></canvas>
            <div class="liq-map-legend">
              <span class="liq-legend-bid">■ Bids</span>
              <span class="liq-legend-ask">■ Asks</span>
              <span class="liq-legend-wall">◆ Wall event</span>
            </div>
          </div>
        </div>
        <div class="depth-alerts-panel">
          <div class="depth-panel-title">Wall Events — ${coin.name}</div>
          <div class="ob-alerts-list">${alertRows}</div>
        </div>
        <div class="depth-raw-panel">
          <div class="depth-panel-title">Raw Wall Data — Standing Walls (live)</div>
          <div id="depth-raw-walls" class="depth-raw-walls">Loading…</div>
          <div class="depth-panel-title" style="margin-top:6px;">Depth Balance Analyzer</div>
          <div id="depth-balance-analyzer" class="depth-raw-walls">Loading…</div>
        </div>
      </div>`;

    // Attach coin tab handlers
    el.querySelectorAll('[data-depth-sym]').forEach(btn => {
      btn.addEventListener('click', () => {
        window._depthSelectedSym = btn.dataset.depthSym;
        renderDepth();
      });
    });

    // Start live order book updates
    startDepthLive(selSym);

    // Draw liquidity map and initial raw wall data
    requestAnimationFrame(() => drawLiqMap(selSym));
    setTimeout(() => updateDepthRawWalls(selSym), 500);
    setTimeout(() => updateDepthAnalyzer(selSym), 500);
  }

  let _depthLiveCleanup = null;
  let _depthBookSym = null, _depthBookFn = null;
  function startDepthLive(sym) {
    if (_depthLiveCleanup) { _depthLiveCleanup(); _depthLiveCleanup = null; }
    if (!window.OB) return;

    // Remove any previously registered listener to prevent accumulation
    if (_depthBookSym && _depthBookFn) window.OB.offBook?.(_depthBookSym, _depthBookFn);

    const handler = () => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      // Re-render book ladder only (not full re-render, for perf)
      updateDepthBook(sym);
    };

    _depthBookSym = sym;
    _depthBookFn = handler;
    window.OB.onBook(sym, handler);

    // Also redraw liquidity map every 2s
    const mapTimer = setInterval(() => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      requestAnimationFrame(() => drawLiqMap(sym));
    }, 2000);

    // Also update alert list every 5s
    const alertTimer = setInterval(() => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      updateDepthAlerts(sym);
    }, 5000);

    // Also refresh raw wall data every 3s
    const rawWallTimer = setInterval(() => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      updateDepthRawWalls(sym);
    }, 3000);

    _depthLiveCleanup = () => {
      clearInterval(mapTimer);
      clearInterval(alertTimer);
      clearInterval(rawWallTimer);
      window.OB.offBook?.(_depthBookSym, _depthBookFn);
      _depthBookSym = null; _depthBookFn = null;
    };
  }

  function updateDepthBook(sym) {
    const book = window.OB?.books?.[sym];
    if (!book) return;
    const ladder = document.querySelector('.ob-ladder');
    if (!ladder) return;
    // Full re-render of the book section only — simpler than diffing
    const MAX_LEVELS = 15;
    const allQtys = [...book.bids.slice(0, MAX_LEVELS), ...book.asks.slice(0, MAX_LEVELS)].map(([, q]) => q);
    const maxQty = allQtys.length > 0 ? Math.max(...allQtys) : 1;
    const avgQty = allQtys.length > 0 ? allQtys.reduce((a, b) => a + b, 0) / allQtys.length : 1;
    const minQty = window.OB?.WALL_MIN_QTY?.[sym] || 0;
    const wallThresh = Math.max(minQty, avgQty * (window.OB?.WALL_MULTI || 3.5));

    const fmtPrice = (p) => {
      if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (p >= 1) return p.toFixed(4);
      return p.toFixed(6);
    };
    const fmtQty = (q) => window.OB?.formatQty?.(sym, q) ?? q.toFixed(2);

    const makeRow = (price, qty, side) => {
      const pct = (qty / maxQty) * 100;
      const isWall = qty >= wallThresh;
      return `<div class="ob-row ${side} ${isWall ? 'ob-wall' : ''}">
        <span class="ob-price">${fmtPrice(price)}</span>
        <div class="ob-bar-wrap"><div class="ob-bar ${side}" style="width:${pct.toFixed(1)}%"></div></div>
        <span class="ob-qty">${fmtQty(qty)}</span>
        ${isWall ? '<span class="ob-wall-badge">WALL</span>' : ''}
      </div>`;
    };

    const askHTML = book.asks.slice(0, MAX_LEVELS).reverse().map(([p, q]) => makeRow(p, q, 'ask')).join('');
    const bidHTML = book.bids.slice(0, MAX_LEVELS).map(([p, q]) => makeRow(p, q, 'bid')).join('');
    const spreadHTML = `<div class="ob-spread-row">
      <span>Spread: ${fmtPrice(book.spread || 0)}</span>
      <span>${book.spreadPct?.toFixed(4) || ''}%</span>
      <span class="ob-mid">$${fmtPrice(book.mid || 0)}</span>
    </div>`;

    ladder.innerHTML = `
      <div class="ob-section-label ask">ASK / RESISTANCE</div>
      ${askHTML || '<div class="ob-empty">Connecting…</div>'}
      ${spreadHTML}
      <div class="ob-section-label bid">BID / SUPPORT</div>
      ${bidHTML || '<div class="ob-empty">Connecting…</div>'}`;

    updateDepthAnalyzer(sym);
  }

  function updateDepthAlerts(sym) {
    const container = document.querySelector('.ob-alerts-list');
    if (!container) return;
    const alerts = (window.OB?.wallAlerts || []).filter(a => a.sym === sym).slice(0, 20);
    if (alerts.length === 0) { container.innerHTML = '<div class="ob-alert-empty">No wall events yet</div>'; return; }
    const fmtP = (p) => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(4) : p.toFixed(6);
    container.innerHTML = alerts.map(a => {
      const ago = Math.round((Date.now() - a.ts) / 1000);
      return `<div class="ob-alert-row ${a.bias.toLowerCase()}">
        <span class="ob-alert-dot ${a.bias.toLowerCase()}"></span>
        <span class="ob-alert-text">${a.side}-WALL <strong>${a.type}</strong> @ $${fmtP(a.price)}</span>
        <span class="ob-alert-qty">qty: ${window.OB?.formatQty?.(sym, a.qty) ?? a.qty.toFixed(2)}</span>
        <span class="ob-alert-age">${ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm'}</span>
      </div>`;
    }).join('');
  }

  function updateDepthRawWalls(sym) {
    const container = document.getElementById('depth-raw-walls');
    if (!container) return;
    const tracker = window.OB?.wallTracker?.[sym];
    if (!tracker) { container.innerHTML = '<span style="color:var(--color-text-faint);font-size:0.8em;">Waiting for data…</span>'; return; }
    const fmtP = (p) => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(4) : p.toFixed(6);
    const fmtQ = (q) => window.OB?.formatQty?.(sym, q) ?? q.toFixed(2);
    const now = Date.now();

    const bidWalls = [...(tracker.bids || new Map()).entries()]
      .map(([price, d]) => ({ price: +price, qty: d.qty, age: Math.round((now - d.firstTs) / 1000) }))
      .sort((a, b) => b.qty - a.qty).slice(0, 7);
    const askWalls = [...(tracker.asks || new Map()).entries()]
      .map(([price, d]) => ({ price: +price, qty: d.qty, age: Math.round((now - d.firstTs) / 1000) }))
      .sort((a, b) => b.qty - a.qty).slice(0, 7);

    const makeRows = (walls, side) => walls.length === 0
      ? `<div style="color:var(--color-text-faint);font-size:0.78em;padding:4px 0;">None detected</div>`
      : walls.map(w => `
          <div style="display:grid;grid-template-columns:100px 1fr 56px;gap:6px;align-items:center;padding:3px 0;font-size:0.78em;font-family:var(--font-mono);">
            <span style="color:${side === 'bid' ? 'var(--color-green)' : 'var(--color-red)'};font-weight:600;">$${fmtP(w.price)}</span>
            <span style="color:var(--color-text-muted);">${fmtQ(w.qty)}</span>
            <span style="color:var(--color-text-faint);">${w.age < 60 ? w.age + 's' : Math.round(w.age / 60) + 'm'}</span>
          </div>`).join('');

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:8px 14px;">
        <div>
          <div style="font-size:0.68em;color:var(--color-green);text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:6px;">BID WALLS — Support</div>
          ${makeRows(bidWalls, 'bid')}
        </div>
        <div>
          <div style="font-size:0.68em;color:var(--color-red);text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:6px;">ASK WALLS — Resistance</div>
          ${makeRows(askWalls, 'ask')}
        </div>
      </div>`;

    updateDepthAnalyzer(sym);
  }

  function updateDepthAnalyzer(sym) {
    const container = document.getElementById('depth-balance-analyzer');
    if (!container) return;

    const metrics = window.OB?.getBalanceMetrics?.(sym) || window.OB?.balanceMetrics?.[sym] || null;
    if (!metrics) {
      container.innerHTML = '<span style="color:var(--color-text-faint);font-size:0.8em;">Waiting for balance metrics…</span>';
      return;
    }

    const fmtMoney = (v) => {
      if (!Number.isFinite(v)) return '—';
      if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + 'B';
      if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
      if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
      return v.toFixed(0);
    };

    const fmtMid = (v) => {
      if (!Number.isFinite(v)) return '—';
      if (v >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (v >= 1) return v.toFixed(4);
      return v.toFixed(6);
    };

    const imb = metrics.imbalance?.value || 0;
    const band = metrics.imbalance?.band || 'balanced';
    const weighted = metrics.weighted || {};
    const depth10 = weighted.level10 || null;
    const depth20 = weighted.level20 || null;
    const velocity = metrics.velocity || {};
    const liquidity = metrics.liquidity || {};
    const wall = metrics.walls || {};
    const dom = wall.dominantWallSide || 'none';
    const ageSec = Math.max(0, Math.round((Date.now() - (metrics.ts || 0)) / 1000));
    const totalNotional = (metrics.bidNotional || 0) + (metrics.askNotional || 0);
    const confidence = totalNotional >= 50_000_000 ? 'high'
      : totalNotional >= 10_000_000 ? 'medium'
        : 'low';

    const bandLabel = ({
      balanced: 'balanced',
      lean_bid: 'lean bid',
      strong_bid: 'strong bid',
      extreme_bid: 'extreme bid',
      lean_ask: 'lean ask',
      strong_ask: 'strong ask',
      extreme_ask: 'extreme ask',
    })[band] || band;

    let read = 'Balanced book, no clear side dominance.';
    if (band.includes('bid') && dom === 'bid') read = 'Bid pressure and support walls align (bullish microstructure).';
    else if (band.includes('ask') && dom === 'ask') read = 'Ask pressure and resistance walls align (bearish microstructure).';
    else if (band.includes('bid')) read = 'Bid pressure present, but wall structure is mixed.';
    else if (band.includes('ask')) read = 'Ask pressure present, but wall structure is mixed.';
    if (Math.abs(velocity.value || 0) >= 0.25) read += ` Imbalance velocity is ${velocity.direction || 'active'} (${velocity.band || 'moving'}).`;
    if (liquidity.band === 'fragile' || liquidity.band === 'thin') read += ` ${liquidity.band} 20-level liquidity; size carefully.`;
    if (confidence === 'low') read += ' Low depth notional, treat signal as tentative.';
    if (ageSec > 6) read += ' Data slightly stale; awaiting fresh ladder updates.';

    const sig = [
      sym,
      fmtMid(metrics.mid),
      (metrics.spreadPct || 0).toFixed(4),
      fmtMoney(metrics.bidNotional),
      fmtMoney(metrics.askNotional),
      imb.toFixed(3),
      band,
      (wall.bidWallConcentration || 0).toFixed(2),
      (wall.askWallConcentration || 0).toFixed(2),
      dom,
      (depth10?.imbalance || 0).toFixed(3),
      (depth20?.imbalance || 0).toFixed(3),
      (velocity.value || 0).toFixed(3),
      liquidity.band || '',
      liquidity.notional20 || 0,
      confidence,
      ageSec,
    ].join('|');
    if (container.dataset.sig === sig) return;
    container.dataset.sig = sig;

    container.innerHTML = `
      <div style="padding:8px 14px;font-family:var(--font-mono);font-size:0.78em;line-height:1.5;color:var(--color-text-muted);">
        <div>BALANCE ${sym}  mid ${fmtMid(metrics.mid)}  spr ${(metrics.spreadPct || 0).toFixed(4)}%  age ${ageSec}s</div>
        <div>NOTIONAL  bid ${fmtMoney(metrics.bidNotional)}  ask ${fmtMoney(metrics.askNotional)}  skew ${imb >= 0 ? '+' : ''}${imb.toFixed(3)}</div>
        <div>WEIGHTED  10L ${depth10?.imbalance >= 0 ? '+' : ''}${(depth10?.imbalance || 0).toFixed(3)}  20L ${depth20?.imbalance >= 0 ? '+' : ''}${(depth20?.imbalance || 0).toFixed(3)}  vel ${velocity.value >= 0 ? '+' : ''}${(velocity.value || 0).toFixed(3)} (${velocity.band || 'stable'})</div>
        <div>LIQUIDITY  10L ${fmtMoney(liquidity.notional10 || 0)}  20L ${fmtMoney(liquidity.notional20 || 0)}  band ${liquidity.band || 'unknown'}  expansion ${(liquidity.depthExpansion || 0).toFixed(2)}x</div>
        <div>BAND  ${bandLabel}  conf ${confidence}</div>
        <div>WALL CONC  bid ${(wall.bidWallConcentration || 0).toFixed(2)}  ask ${(wall.askWallConcentration || 0).toFixed(2)}  dom ${dom}</div>
        <div>READ  ${read}</div>
      </div>`;
  }

  let _drawLiqRetryPending = false;
  function drawLiqMap(sym) {
    const canvas = document.getElementById('liq-map-canvas');
    if (!canvas) { _drawLiqRetryPending = false; return; }

    // Use getBoundingClientRect for reliable CSS dimensions in flex containers
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(rect.width || canvas.offsetWidth || canvas.parentElement?.clientWidth || 400, 200);
    const H = Math.max(rect.height || canvas.offsetHeight || 280, 200);

    // If canvas has no layout dimensions yet, defer — only one retry chain at a time
    if (rect.width === 0 || rect.height === 0) {
      if (!_drawLiqRetryPending) {
        _drawLiqRetryPending = true;
        setTimeout(() => { _drawLiqRetryPending = false; if (document.getElementById('liq-map-canvas')) drawLiqMap(sym); }, 150);
      }
      return;
    }
    _drawLiqRetryPending = false;

    canvas.width = W;
    canvas.height = H;

    const snaps = window.OB?.liquiditySnaps?.[sym];
    if (!snaps || snaps.length < 2) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Collecting data…', W / 2, H / 2);
      return;
    }

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#070d1a';
    ctx.fillRect(0, 0, W, H);

    const PRICE_AXIS_W = 56;
    const TIME_AXIS_H = 18;
    const mapW = W - PRICE_AXIS_W;
    const mapH = H - TIME_AXIS_H;

    const displaySnaps = snaps.slice(-Math.min(snaps.length, Math.floor(mapW)));
    const nCols = displaySnaps.length;
    if (nCols < 2) return;

    const currentMid = displaySnaps[displaySnaps.length - 1].mid || 1;
    const PRICE_RANGE = 0.015; // ±1.5%
    const N_BUCKETS = 80;
    const priceLo = currentMid * (1 - PRICE_RANGE);
    const priceHi = currentMid * (1 + PRICE_RANGE);
    const bucketSize = (priceHi - priceLo) / N_BUCKETS;

    // Build intensity grid [col][bucket]
    const grid = new Float32Array(nCols * N_BUCKETS);
    const isBid = new Uint8Array(nCols * N_BUCKETS); // 1=bid, 0=ask, 2=both

    for (let col = 0; col < nCols; col++) {
      const snap = displaySnaps[col];
      for (const [price, qty] of snap.bids) {
        const bucket = Math.floor((price - priceLo) / bucketSize);
        if (bucket >= 0 && bucket < N_BUCKETS) {
          grid[col * N_BUCKETS + bucket] += qty;
          isBid[col * N_BUCKETS + bucket] = 1;
        }
      }
      for (const [price, qty] of snap.asks) {
        const bucket = Math.floor((price - priceLo) / bucketSize);
        if (bucket >= 0 && bucket < N_BUCKETS) {
          grid[col * N_BUCKETS + bucket] += qty;
          isBid[col * N_BUCKETS + bucket] = isBid[col * N_BUCKETS + bucket] === 1 ? 2 : 0;
        }
      }
    }

    // 95th percentile max for color scale
    const nonZero = [];
    for (let i = 0; i < grid.length; i++) { if (grid[i] > 0) nonZero.push(grid[i]); }
    nonZero.sort((a, b) => a - b);
    const p95 = nonZero[Math.floor(nonZero.length * 0.95)] || 1;

    // Draw columns
    const colW = mapW / nCols;
    const rowH = mapH / N_BUCKETS;

    for (let col = 0; col < nCols; col++) {
      for (let b = 0; b < N_BUCKETS; b++) {
        const val = grid[col * N_BUCKETS + b];
        if (val === 0) continue;
        const intensity = Math.min(val / p95, 1);
        const side = isBid[col * N_BUCKETS + b];
        let r, g, bl;
        if (side === 1) { // bid = blue/cyan
          r = Math.round(0 * intensity); g = Math.round(150 * intensity); bl = Math.round(255 * intensity);
        } else if (side === 0) { // ask = red/orange
          r = Math.round(255 * intensity); g = Math.round(60 * intensity); bl = 0;
        } else { // both = purple
          r = Math.round(140 * intensity); g = 0; bl = Math.round(200 * intensity);
        }
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        // Y: bucket 0 = priceLo (bottom), flip so higher price = higher on canvas
        const y = mapH - (b + 1) * rowH;
        ctx.fillRect(PRICE_AXIS_W + col * colW, y, Math.max(colW, 1), rowH + 0.5);
      }
    }

    // Mid price line
    const midBucket = (currentMid - priceLo) / bucketSize;
    const midY = mapH - midBucket * rowH;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(PRICE_AXIS_W, midY);
    ctx.lineTo(W, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Wall event markers
    const events = window.OB?.wallEventLog?.[sym] || [];
    const firstSnapTs = displaySnaps[0].ts;
    const lastSnapTsVal = displaySnaps[displaySnaps.length - 1].ts;
    const tsRange = lastSnapTsVal - firstSnapTs || 1;

    for (const ev of events) {
      if (ev.ts < firstSnapTs || ev.ts > lastSnapTsVal + 5000) continue;
      const xFrac = (ev.ts - firstSnapTs) / tsRange;
      const x = PRICE_AXIS_W + xFrac * mapW;
      const priceBucket = (ev.price - priceLo) / bucketSize;
      const y = mapH - priceBucket * rowH;
      // Draw diamond
      const color = ev.bias === 'BULL' ? '#00ff88' : '#ff4466';
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x, y + 5);
      ctx.lineTo(x - 4, y);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Price axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    const fmtP = (p) => p >= 1000 ? '$' + (p / 1000).toFixed(1) + 'K' : p >= 1 ? '$' + p.toFixed(2) : '$' + p.toFixed(4);
    for (let i = 0; i <= 4; i++) {
      const price = priceLo + (i / 4) * (priceHi - priceLo);
      const y = mapH - (i / 4) * mapH;
      ctx.fillText(fmtP(price), PRICE_AXIS_W - 2, y + 3);
    }

    // Time axis
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('now', W - 10, H - 3);
    const minutesBack = Math.round((tsRange / 1000) / 60);
    if (minutesBack > 0) ctx.fillText(`-${minutesBack}m`, PRICE_AXIS_W + 20, H - 3);
  }

  function initOBHud() {
    const hud = document.getElementById('ob-hud');
    if (!hud) return;
    let minimized = false;
    let hudFilter = 'ALL';
    let soundOn = isTradeBellOn();

    function renderHud() {
      const all = window.OB?.wallAlerts || [];
      const alerts = hudFilter === 'ALL' ? all : all.filter(a => a.sym === hudFilter);
      const shown = alerts.slice(0, 15);

      const syms = PREDICTION_COINS.map(c => c.sym);
      const filterPills = ['ALL', ...syms].map(s => {
        const active = s === hudFilter ? 'active' : '';
        return `<button class="hud-pill ${active}" data-hud-filter="${s}">${s}</button>`;
      }).join('');

      const fmtP = (p) => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(3) : p.toFixed(5);

      const rows = shown.map(a => {
        const ago = Math.round((Date.now() - a.ts) / 1000);
        const agoStr = ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`;
        return `<div class="hud-row ${a.bias.toLowerCase()} ${Date.now() - a.ts < 2000 ? 'hud-new' : ''}">
          <span class="hud-dot ${a.bias.toLowerCase()}"></span>
          <span class="hud-sym">${a.sym}</span>
          <span class="hud-msg">${a.side} ${a.type}</span>
          <span class="hud-price">$${fmtP(a.price)}</span>
          <span class="hud-age">${agoStr}</span>
        </div>`;
      }).join('');

      const connCount = window.OB?.getConnected?.()?.length || 0;

      hud.innerHTML = `
        <div class="hud-header">
          <span class="hud-title">⚡ WALL ALERTS <span class="hud-conn">${connCount}/7</span></span>
          <div class="hud-header-btns">
            <button class="hud-icon-btn" id="hud-sound-btn" title="Toggle signal alerts">
              ${soundOn ? '🔔' : '🔕'}
            </button>
            <button class="hud-icon-btn" id="hud-min-btn" title="Minimize">
              ${minimized ? '▲' : '▼'}
            </button>
          </div>
        </div>
        ${!minimized ? `
          <div class="hud-filters">${filterPills}</div>
          <div class="hud-rows">${rows || '<div class="hud-empty">Monitoring for wall events…</div>'}</div>
        ` : ''}`;

      // Attach handlers
      hud.querySelector('#hud-min-btn')?.addEventListener('click', () => {
        minimized = !minimized; renderHud();
      });
      hud.querySelector('#hud-sound-btn')?.addEventListener('click', () => {
        soundOn = !soundOn;
        setTradeBellOn(soundOn);
        renderHud();
      });
      hud.querySelectorAll('[data-hud-filter]').forEach(btn => {
        btn.addEventListener('click', () => { hudFilter = btn.dataset.hudFilter; renderHud(); });
      });
    }

    // Re-render HUD every 3 seconds
    setInterval(renderHud, 3000);
    renderHud();

    // Live Market Divergence timer — update elapsed time on cards every 3s
    setInterval(() => {
      document.querySelectorAll('[data-mdiv-ts]').forEach(el => {
        const ts = parseInt(el.dataset.mdivTs, 10);
        if (!ts || isNaN(ts)) return;
        const sec = Math.floor((Date.now() - ts) / 1000);
        el.textContent = sec >= 60
          ? Math.floor(sec / 60) + 'm ' + (sec % 60) + 's'
          : sec + 's';
      });
    }, 3000);

    // Live countdown for all Kalshi contract close times — ticks every 1s
    setInterval(() => {
      document.querySelectorAll('[data-close-ms]').forEach(el => {
        const closeMs = parseInt(el.dataset.closeMs, 10);
        if (!closeMs || isNaN(closeMs)) return;
        const msLeft = closeMs - Date.now();
        if (msLeft <= 0) {
          if (el.classList.contains('k15-expiry')) {
            el.classList.add('k15-settling');
            el.textContent = '⏱ SETTLING';
          } else {
            el.innerHTML = '⏱ <strong>SETTLING</strong>';
            el.style.color = 'var(--color-text-muted)';
          }
          return;
        }
        const s = Math.floor(msLeft / 1000);
        const m = Math.floor(s / 60);
        const sec = s % 60;
        if (el.classList.contains('k15-expiry')) {
          el.textContent = `⏱ ${m}m${String(sec).padStart(2, '0')}s`;
          el.style.color = s < 60 ? 'var(--color-red)' : s < 180 ? '#ffd700' : '';
        } else {
          const str = m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
          el.innerHTML = `⏱ <strong>${str}</strong> left`;
          el.style.color = s < 60 ? 'var(--color-red)' : s < 180 ? '#ffd700' : '';
        }
      });
    }, 1000);

    // Re-render immediately on alert
    window.OB?.onAlert(() => renderHud());
  }

  // ================================================================
  // VIEW: MARKET UNIVERSE (Periodic Table + Orbital Canvas)
  // ================================================================

  function renderUniverse() {
    const _t = _universeActiveTab;
    content.innerHTML = `
      <div class="universe-header">
        <h2 style="font-size:18px;font-weight:700;color:var(--color-text)">Market Universe</h2>
        <div class="universe-toggle">
          <button class="universe-tab ${_t === 'table' ? 'active' : ''}"   data-tab="table">Periodic Table</button>
          <button class="universe-tab ${_t === 'orbital' ? 'active' : ''}" data-tab="orbital">Orbital View</button>
          <button class="universe-tab ${_t === 'cex' ? 'active' : ''}"     data-tab="cex">CEX Flows</button>
        </div>
      </div>
      <div id="universe-table"   class="universe-panel" style="${_t !== 'table' ? 'display:none' : ''}"></div>
      <div id="universe-orbital" class="universe-panel" style="${_t === 'orbital' ? 'display:block' : 'display:none'}">
        <canvas id="orbital-canvas" width="900" height="620" style="max-width:100%;display:block;margin:0 auto"></canvas>
      </div>
      <div id="universe-cex" class="universe-panel" style="${_t === 'cex' ? 'display:block' : 'display:none'}"></div>
    `;

    document.querySelectorAll('.universe-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        _universeActiveTab = tab.dataset.tab; // persist across re-renders
        document.querySelectorAll('.universe-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabName = tab.dataset.tab;
        document.getElementById('universe-table').style.display = tabName === 'table' ? 'block' : 'none';
        document.getElementById('universe-orbital').style.display = tabName === 'orbital' ? 'block' : 'none';
        document.getElementById('universe-cex').style.display = tabName === 'cex' ? 'block' : 'none';
        if (orbitalAnimationFrame) { cancelAnimationFrame(orbitalAnimationFrame); orbitalAnimationFrame = null; }
        if (tabName === 'orbital') setTimeout(drawOrbital, 50);
        if (tabName === 'cex') renderCexFlow();
      });
    });

    renderPeriodicTable();
    // Restore the correct panel on re-render
    if (_universeActiveTab === 'orbital') setTimeout(drawOrbital, 50);
    if (_universeActiveTab === 'cex') renderCexFlow();
  }

  function renderPeriodicTable() {
    const el = document.getElementById('universe-table');
    if (!el) return;

    // Map each PREDICTION_COIN to its universe group
    const grouped = {
      core: PREDICTION_COINS.filter(c => ['BTC', 'ETH', 'BNB'].includes(c.sym)),
      platform: PREDICTION_COINS.filter(c => ['SOL', 'XRP', 'HYPE'].includes(c.sym)),
      meme: PREDICTION_COINS.filter(c => ['DOGE'].includes(c.sym)),
    };

    let html = `<div class="periodic-table">`;

    Object.entries(grouped).forEach(([groupKey, coins]) => {
      if (!coins.length) return;
      const grp = UNIVERSE_GROUPS[groupKey];
      html += `<div class="period-row">
        <div class="group-label" style="color:${grp.color}">${grp.emoji} ${grp.name}</div>`;

      coins.forEach(coin => {
        const cfm = window._cfmAll?.[coin.sym] || {};
        const pred = window._predictions?.[coin.sym] || {};
        const rawSig = pred.signal || 'neutral';
        // Map prediction engine signals → display direction
        const sigDir = ['strong_bull', 'bullish'].includes(rawSig) ? 'up'
          : ['strong_bear', 'bearish'].includes(rawSig) ? 'down' : 'neutral';
        const conf = pred.confidence || 0;
        const cfmLabel = cfm.cfmRate != null ? (cfm.cfmRate >= 0 ? '+' : '') + cfm.cfmRate.toFixed(2) + '%' : '—';
        const arrow = sigDir === 'up' ? '↑' : sigDir === 'down' ? '↓' : '—';

        html += `
          <div class="element ${sigDir}" style="--el-color:${grp.color}">
            <div class="element-header">
              <span class="element-icon">${coinIcon(coin.sym)}</span>
              <span class="element-sym">${coin.sym}</span>
            </div>
            <div class="element-name">${coin.name}</div>
            <div class="element-cfm">${cfmLabel}</div>
            <div class="element-signal ${sigDir}">${arrow}</div>
            <div class="element-conf">${conf ? conf + '%' : '—'}</div>
          </div>`;
      });
      html += `</div>`;
    });

    html += `</div>`;
    el.innerHTML = html;
  }

  function drawOrbital() {
    const canvas = document.getElementById('orbital-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;

    ctx.clearRect(0, 0, W, H);

    // Background glow
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, 30, cx, cy, Math.max(W, H) * 0.7);
    grad.addColorStop(0, 'rgba(79,158,255,0.12)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Orbital rings
    [0, 1, 2].forEach(i => {
      const r = 110 + i * 95;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(120,130,160,${0.28 - i * 0.06})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 7]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Nucleus
    ctx.save();
    ctx.shadowBlur = 22;
    ctx.shadowColor = 'rgba(79,158,255,0.55)';
    ctx.fillStyle = 'rgba(79,158,255,0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,158,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(130,150,200,0.9)';
    ctx.font = 'bold 10px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CFM', cx, cy);
    ctx.restore();

    // Coin nodes
    PREDICTION_COINS.forEach((coin, index) => {
      const pred = window._predictions?.[coin.sym] || {};
      const score = pred.score || 0;
      const angle = (index * (Math.PI * 2 / PREDICTION_COINS.length)) + (Date.now() / 8000);
      const orbitIdx = ['BTC', 'ETH', 'BNB'].includes(coin.sym) ? 0 : ['SOL', 'XRP'].includes(coin.sym) ? 1 : 2;
      const r = 110 + orbitIdx * 95;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      const hue = score > 0.1 ? 150 : score < -0.1 ? 340 : 210;

      ctx.save();
      ctx.shadowBlur = 14;
      ctx.shadowColor = `hsl(${hue}, 88%, 60%)`;
      ctx.fillStyle = `hsl(${hue}, 88%, 58%)`;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.fill();

      // Coin icon text
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(coin.icon || coin.sym[0], x, y + 1);

      // Ticker label below node
      ctx.font = '500 10px monospace';
      ctx.fillText(coin.sym, x, y + 32);
      ctx.restore();
    });

    orbitalAnimationFrame = requestAnimationFrame(drawOrbital);
  }

  // ================================================================
  // CEX FLOW PANEL
  // ================================================================

  let _cexActiveSym = 'BTC';

  function renderCexFlow() {
    const el = document.getElementById('universe-cex');
    if (!el) return;
    refreshCexFlow(_cexActiveSym, el);
  }

  function refreshCexFlow(sym, el) {
    if (!el) el = document.getElementById('universe-cex');
    if (!el) return;
    _cexActiveSym = sym;

    const data = window.CexFlow?.get(sym) ?? null;
    const chain = window.ChainRouter?.get(sym) ?? null;
    const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
    const loading = !data;

    // Coin selector tabs
    const coinTabs = COINS.map(c =>
      `<button class="cex-coin-tab ${c === sym ? 'active' : ''}" data-cex-coin="${c}">${c}</button>`
    ).join('');

    // Aggregate bar
    const agg = data?.aggregate;
    const aggColor = agg
      ? agg.score < -0.2 ? 'var(--color-red)' : agg.score > 0.2 ? 'var(--color-green)' : 'var(--color-text-muted)'
      : 'var(--color-text-muted)';
    const aggLabel = agg?.label ?? '—';
    const sAgo = data?.ts ? Math.round((Date.now() - data.ts) / 1000) : null;
    const staleTag = sAgo != null && sAgo > 60
      ? `<span style="color:var(--color-orange);font-size:10px">⚠ ${sAgo}s ago</span>`
      : sAgo != null ? `<span style="color:var(--color-text-faint);font-size:10px">↻ ${sAgo}s ago</span>` : '';

    // Chain velocity row
    let chainRow = '';
    if (chain) {
      const vel = chain.velocity?.score ?? 0;
      const velLabel = chain.velocityLabel ?? 'Stable';
      const velColor = vel > 0.15 ? 'var(--color-green)' : vel < -0.10 ? 'var(--color-red)' : 'var(--color-text-muted)';
      chainRow = `
        <div class="cex-chain-row">
          <span class="cex-chain-label">On-Chain (${chain.source})</span>
          <span style="color:${velColor};font-weight:700">${velLabel}</span>
          <span style="color:var(--color-text-muted);font-size:11px">velocity ${vel > 0 ? '+' : ''}${(vel * 100).toFixed(0)}%</span>
          <span style="color:${aggColor};font-size:11px">${chain.congestion} congestion · Leading: ${(chain.leadingScore ?? chain.score ?? 0) > 0 ? '↑ bullish' : (chain.leadingScore ?? chain.score ?? 0) < 0 ? '↓ bearish' : '—'}</span>
        </div>`;
    }

    // Exchange rows
    const exchanges = data?.exchanges ?? [];
    const exRows = exchanges.length
      ? exchanges.map(ex => {
        if (!ex.available) {
          return `<tr class="cex-row cex-na">
              <td class="cex-name">${ex.exchange}</td>
              <td colspan="4" style="color:var(--color-text-faint);font-size:11px">${ex.reason ?? 'Not listed'}</td>
            </tr>`;
        }
        const sigColor = ex.color === 'red' ? 'var(--color-red)' : ex.color === 'green' ? 'var(--color-green)' : ex.color === 'orange' ? 'var(--color-orange)' : 'var(--color-text-muted)';
        const sigDot = ex.color === 'red' ? '🔴' : ex.color === 'green' ? '🟢' : ex.color === 'orange' ? '🟠' : '⚪';
        const fundStr = ex.fundingPct != null ? `${ex.fundingPct > 0 ? '+' : ''}${ex.fundingPct.toFixed(3)}%` : '—';
        const volStr = ex.volMult != null ? `${ex.volMult.toFixed(1)}×` : '—';
        const volColor = ex.volMult != null && ex.volMult > 2 ? 'var(--color-orange)' : ex.volMult != null && ex.volMult > 1.4 ? 'var(--color-gold)' : 'var(--color-text-muted)';
        return `<tr class="cex-row">
            <td class="cex-name">${ex.exchange}</td>
            <td class="cex-buysell">
              <span style="color:var(--color-green)">${ex.buyPct.toFixed(0)}%B</span>
              <span style="color:var(--color-text-faint)">/</span>
              <span style="color:var(--color-red)">${ex.sellPct.toFixed(0)}%S</span>
            </td>
            <td style="color:${volColor}">${volStr}</td>
            <td style="color:${ex.fundingPct != null && ex.fundingPct > 0.02 ? 'var(--color-red)' : ex.fundingPct != null && ex.fundingPct < -0.02 ? 'var(--color-green)' : 'var(--color-text-muted)'}">${fundStr}</td>
            <td><span style="color:${sigColor};font-weight:700">${sigDot} ${ex.signal}</span></td>
          </tr>`;
      }).join('')
      : `<tr><td colspan="5" style="text-align:center;color:var(--color-text-faint);padding:24px">
          ${loading ? 'Loading exchange data…' : 'No data available'}
         </td></tr>`;

    // Aggregate summary row
    const aggSummaryRow = agg ? `
      <tr class="cex-agg-row">
        <td colspan="5">
          <span style="color:${aggColor};font-weight:800">${aggLabel}</span>
          <span style="color:var(--color-text-muted);font-size:11px;margin-left:10px">
            ${agg.distributing} dist · ${agg.accumulating} accum · ${agg.volatile} volatile
          </span>
          ${agg.maxFunding ? `<span style="color:var(--color-orange);font-size:11px;margin-left:8px">⚡ Max funding: ${agg.maxFunding.exchange} ${agg.maxFunding.pct > 0 ? '+' : ''}${agg.maxFunding.pct.toFixed(3)}%</span>` : ''}
        </td>
      </tr>` : '';

    el.innerHTML = `
      <div class="cex-flow-panel">
        <div class="cex-header">
          <div class="cex-coin-tabs">${coinTabs}</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:11px;color:var(--color-text-muted)">CEX FLOW MONITOR</span>
            ${staleTag}
            <button class="cex-refresh-btn" onclick="window.CexFlow?.fetchAll()">↻</button>
          </div>
        </div>
        ${chainRow}
        <div class="cex-table-wrap">
          <table class="cex-table">
            <thead>
              <tr>
                <th>Exchange</th>
                <th>Buy / Sell</th>
                <th>Vol ×Avg</th>
                <th>Funding</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              ${exRows}
              ${aggSummaryRow}
            </tbody>
          </table>
        </div>
        <div class="cex-footnote">
          Buy/Sell from last 200–500 trades · Funding from perpetuals · Vol = current 24h vs rolling avg
        </div>
      </div>`;

    // Wire coin tab clicks
    el.querySelectorAll('[data-cex-coin]').forEach(btn => {
      btn.addEventListener('click', () => refreshCexFlow(btn.dataset.cexCoin, el));
    });
  }

  // ── Hourly Ranges Panel render handler ─────────────────────────
  function renderHourlyRanges() {
    if (!window.HourlyRangesPanel) {
      content.innerHTML = `<div class="card"><div class="card-body" style="padding:14px;color:var(--color-text-muted)">Loading hourly ranges panel…</div></div>`;
      if (!window._hourlyRangesPanelLoading) {
        window._hourlyRangesPanelLoading = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = '../src/ui/hourly-ranges-panel.js?v=' + Date.now();
          script.defer = true;
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        }).finally(() => {
          window._hourlyRangesPanelLoading = null;
          if (currentView === 'hourly-ranges') renderHourlyRanges();
        });
      }
      return;
    }
    // Stop any existing auto-load to prevent interval stacking
    window.HourlyRangesPanel.stopAutoLoad?.();
    // Start fresh auto-load (30 second refresh)
    window.HourlyRangesPanel.startAutoLoad?.(30000);
  }

  // ================================================================
  // RENDER DISPATCH
  // ================================================================

  function showPanelRenderError(view, token, error) {
    if (token !== _rv || currentView !== view) return;
    const message = error?.message || String(error || 'Unknown panel error');
    console.error('[render] Panel error:', error);
    content.innerHTML = `<div class="error-notice">⚠ Panel error: ${escapeHtml(message)}<br><small>${escapeHtml(error?.stack || '')}</small></div>`;
  }

  function runPanelRender(view, fn, token = _rv) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        result.catch(error => showPanelRenderError(view, token, error));
      }
      return result;
    } catch (error) {
      showPanelRenderError(view, token, error);
      return null;
    }
  }

  function render() {
    _rv++; // invalidate any in-flight async renders from previous navigation
    const renderToken = _rv;
    const view = currentView;
    window.__weCurrentView = currentView;
    if (currentView !== 'hourly-ranges') {
      window.HourlyRangesPanel?.stopAutoLoad?.();
    }
    if (candleChart && currentView !== 'charts') destroyChart();
    // Cancel orbital animation whenever leaving (or re-entering) universe
    if (orbitalAnimationFrame) { cancelAnimationFrame(orbitalAnimationFrame); orbitalAnimationFrame = null; }
    syncPredictionRefresh();

    const bootGateViews = new Set(['cfm', 'predictions', 'universe', 'markets', 'markets5m']);
    const bootGateActive =
      !_fetchAttempted &&
      !_userInteractedWithNav &&
      Object.keys(tickers).length === 0 &&
      bootGateViews.has(currentView) &&
      (Date.now() - _appBootTs) < 6000;

    if (bootGateActive) {
      updateHeaderSummary();
      content.innerHTML = `<div class="loading-screen">
        <div class="loader-ring"></div>
        <p>Booting benchmark feeds…</p>
        <p style="font-size:11px;color:var(--color-muted);margin-top:8px">Connecting to Crypto.com &amp; CoinGecko</p>
        <button onclick="window._fetchAllNow?.()" style="margin-top:16px;padding:6px 18px;background:var(--color-accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px">Retry</button>
      </div>`;
      return;
    }

    updateHeaderSummary();

    try {
      switch (view) {
        case 'markets': runPanelRender(view, renderMarkets, renderToken); break;
        case 'markets5m': runPanelRender(view, renderMarkets5M, renderToken); break;
        case 'debuglog': runPanelRender(view, renderDebugLog, renderToken); break;
        case 'observability': runPanelRender(view, renderObservability, renderToken); break;
        case 'portfolio': runPanelRender(view, renderPortfolio, renderToken); break;
        case 'charts': runPanelRender(view, renderCharts, renderToken); break;
        case 'onchain': runPanelRender(view, renderOnChain, renderToken); break;
        case 'cfm': runPanelRender(view, renderCFM, renderToken); break;
        case 'predictions': runPanelRender(view, renderPredictions, renderToken); break;
        case 'screener': runPanelRender(view, renderScreener, renderToken); break;
        case 'depth': runPanelRender(view, renderDepth, renderToken); break;
        case 'universe': runPanelRender(view, renderUniverse, renderToken); break;
        case 'hourly-ranges': renderHourlyRanges(); break;
        case 'log':
          content.innerHTML = renderContractLog();
          break;
        default:
          currentView = 'cfm';
          activateNav(currentView);
          runPanelRender(currentView, renderCFM, renderToken);
      }
    } catch (e) {
      console.error('[render] Panel error:', e);
      content.innerHTML = `<div class="error-notice">⚠ Panel error: ${e.message}<br><small>${e.stack || ''}</small></div>`;
    }
  }

  // ── Contract Log gallery view ──────────────────────────────────────────────
  // Shows settled 15M contracts with accuracy stats, wick detection, and
  // close-time snapshots. Data sourced from window._15mResolutionLog and
  // localStorage cache (wc_contract_log) for prior sessions.
  function renderContractLog() {
    const normalizeContractEntry = (e = {}, source = 'runtime') => {
      const sym = String(e.sym || e.symbol || e.coin || e.market || 'UNK').toUpperCase();
      const settledTs = e.settledTs || e.resolved_at || e.resolvedAt || e.timestamp || e.ts || 0;
      const modelDirRaw = e.modelDir || e.direction || e.prediction || e.predictedDirection || e.side || e.betDirection || null;
      const modelDir = modelDirRaw != null ? String(modelDirRaw).toUpperCase() : null;
      const outcomeRaw = e.actualOutcome || e.outcome || e.result || e.kalshiResult || e.settlement || e.authOutcome || null;
      const outcome = outcomeRaw != null ? String(outcomeRaw).toUpperCase() : null;
      const orchestratorAction = e.orchestratorAction || e.action || e.orchAction || e.tradeAction || null;
      const modelCorrect = typeof e.modelCorrect === 'boolean'
        ? e.modelCorrect
        : typeof e.correct === 'boolean'
          ? e.correct
          : typeof e.isCorrect === 'boolean'
            ? e.isCorrect
            : typeof e.hit === 'boolean'
              ? e.hit
              : null;
      const sweetSpot = !!(e.sweetSpot || e.sweet_spot || e.bestEntry || e.best_entry);
      const crowdFade = !!(e.crowdFade || e.crowd_fade || e.fade || e.fadeSignal);
      const missedOpportunity = !!(e.missedOpportunity || e.missed_opportunity || e.missedOpportunityScore > 0);
      const wickedOut = !!(e.wickedOut || e.wickOut || e.wick_out || e._wickStraddle);
      const entryProb = e.entryProb != null
        ? e.entryProb
        : e.modelProbUp != null
          ? e.modelProbUp
          : e.modelYesPct != null
            ? Number(e.modelYesPct) / 100
            : e.kalshiProb != null
              ? e.kalshiProb
              : null;
      const modelProbUp = e.modelProbUp != null
        ? e.modelProbUp
        : e.modelYesPct != null
          ? Number(e.modelYesPct) / 100
          : e.modelScore != null
            ? Math.max(0, Math.min(1, 0.5 + Number(e.modelScore) / 2))
            : null;
      const kalshiProb = e.kalshiProb != null
        ? e.kalshiProb
        : e.entryProb != null
          ? e.entryProb
          : e.kYesPct != null
            ? Number(e.kYesPct) / 100
            : null;

      return {
        ...e,
        sym,
        settledTs,
        ts: e.ts || settledTs,
        modelDir,
        actualOutcome: outcome,
        orchestratorAction: orchestratorAction ? String(orchestratorAction).toLowerCase() : null,
        modelCorrect,
        sweetSpot,
        crowdFade,
        missedOpportunity,
        wickedOut,
        entryProb,
        modelProbUp,
        kalshiProb,
        _source: source,
      };
    };

    // Pull from ALL sources: runtime log, Kalshi log, multi-drive cache
    const runtimeLog = (window._15mResolutionLog || []).map(e => normalizeContractEntry(e, 'runtime')).slice().reverse();
    const kalshiLog = (window._kalshiLog || [])
      .filter(e => e._settled)
      .map(e => normalizeContractEntry({
        ...e,
        actualOutcome: e.actualOutcome || _actualFromYNWithStrike(_normOutcomeYN(e.outcome), _normStrikeDir(e._strikeDir ?? e.strikeDir ?? e.apiStrikeDir ?? e.strikeType)),
      }, 'kalshi'))
      .slice().reverse();
    const cacheSettlements = (window.MultiDriveCache?.data?.settlements || [])
      .map(e => normalizeContractEntry({
        ...e,
        actualOutcome: e.outcome?.toUpperCase(),
        modelCorrect: typeof e.modelCorrect === 'boolean' ? e.modelCorrect : null,
      }, 'cache'))
      .slice().reverse();

    const contractId = (e) => {
      const sym = (e.sym || e.symbol || e.coin || 'UNK').toUpperCase();
      const ts = e.settledTs || e.timestamp || e.resolved_at || e.ts || 0;
      return `${sym}-${ts}`;
    };

    // Load localStorage cache
    let lsLog = [];
    try { lsLog = JSON.parse(localStorage.getItem('wc_contract_log') || '[]'); } catch (_) { }

    // Merge all sources (dedupe by ID)
    const seenIds = new Set();
    const allContracts = [];

    // Add runtime log first (most recent)
    runtimeLog.forEach(e => {
      const id = contractId(e);
      if (!seenIds.has(id)) {
        allContracts.push(e);
        seenIds.add(id);
      }
    });

    // Add Kalshi log (Kalshi API data)
    kalshiLog.forEach(e => {
      const id = contractId(e);
      if (!seenIds.has(id)) {
        allContracts.push({
          ...normalizeContractEntry(e, 'kalshi'),
          kalshiResult: e._kalshiResult || e.kalshiResult || null,
        });
        seenIds.add(id);
      }
    });

    // Add cache settlements
    cacheSettlements.forEach(e => {
      const id = contractId(e);
      if (!seenIds.has(id)) {
        allContracts.push({
          ...normalizeContractEntry({
            ...e,
            settledTs: e.timestamp,
            actualOutcome: e.outcome?.toUpperCase(),
          }, 'cache'),
        });
        seenIds.add(id);
      }
    });

    // Add localStorage cache
    lsLog.forEach(e => {
      const id = contractId(e);
      if (!seenIds.has(id)) {
        allContracts.push(normalizeContractEntry(e, 'localStorage'));
        seenIds.add(id);
      }
    });

    const log = allContracts.sort((a, b) => {
      const aTs = a.settledTs || a.resolved_at || a.ts || 0;
      const bTs = b.settledTs || b.resolved_at || b.ts || 0;
      return bTs - aTs;
    });
    const resolved = log.filter(e => e.modelCorrect === true || e.modelCorrect === false);
    const traded = log.filter(e => e.orchestratorAction === 'trade');
    const correct = resolved.filter(e => e.modelCorrect === true).length;
    const wr = resolved.length ? Math.round(correct / resolved.length * 100) : null;
    const tradeCorrect = traded.filter(e => e.modelCorrect === true).length;
    const tradeWr = traded.length ? Math.round(tradeCorrect / traded.length * 100) : null;
    const wickCount = log.filter(e => e.wickedOut).length;
    const sweetTrades = log.filter(e => e.sweetSpot);
    const sweetWr = sweetTrades.length ? Math.round(sweetTrades.filter(e => e.modelCorrect === true).length / sweetTrades.length * 100) : null;
    const fadeTrades = log.filter(e => e.crowdFade);
    const fadeWr = fadeTrades.length ? Math.round(fadeTrades.filter(e => e.modelCorrect === true).length / fadeTrades.length * 100) : null;
    const missed = log.filter(e => e.missedOpportunity).length;
    const kalshiOnly = log.filter(e => e._source === 'kalshi' && e.modelCorrect != null).length;
    const cacheOnly = log.filter(e => e._source === 'cache' && e.modelCorrect != null).length;
    const lsOnly = log.filter(e => e._source === 'localStorage' && e.modelCorrect != null).length;
    const runtimeOnly = log.filter(e => e._source === 'runtime' && e.modelCorrect != null).length;

    const statBar = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px">
        ${[
        ['Total Contracts', log.length, 'var(--color-text)'],
        ['Overall WR', wr != null ? wr + '%' : '—', wr >= 55 ? 'var(--color-green)' : wr >= 45 ? '#ffd700' : 'var(--color-red)'],
        ['Trade WR', tradeWr != null ? tradeWr + '%' : '—', tradeWr >= 55 ? 'var(--color-green)' : tradeWr >= 45 ? '#ffd700' : 'var(--color-red)'],
        ['Sweet Spot WR', sweetWr != null ? sweetWr + '%' : '—', sweetWr >= 55 ? 'var(--color-green)' : '#ffd700'],
        ['Fade WR', fadeWr != null ? fadeWr + '%' : '—', fadeWr >= 55 ? 'var(--color-green)' : '#ffd700'],
        ['Wick-outs', wickCount + (traded.length ? '/' + traded.length : ''), wickCount > 2 ? 'var(--color-red)' : 'var(--color-text-muted)'],
        ['Missed Opps', missed, missed > 0 ? '#ff9800' : 'var(--color-text-muted)'],
        ['Trades', traded.length, 'var(--color-text)'],
        ['Resolved', resolved.length, 'var(--color-text-muted)'],
        ['By Source', `R${runtimeOnly} K${kalshiOnly} C${cacheOnly} L${lsOnly}`, 'var(--color-text-muted)'],
      ].map(([lbl, val, col]) => `
          <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:6px;padding:8px 14px;min-width:90px">
            <div style="font-size:10px;color:var(--color-text-muted);font-weight:600;letter-spacing:.5px;text-transform:uppercase">${lbl}</div>
            <div style="font-size:20px;font-weight:800;color:${col};font-family:var(--font-mono)">${val}</div>
          </div>`).join('')}
        <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
          <button onclick="window._exportContractLog()" style="padding:7px 14px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,200,100,0.10);color:var(--color-green);font-size:12px;font-weight:700;cursor:pointer">☁ Export to Drive</button>
        </div>
      </div>`;

    const rows = log.slice(0, 200).map(e => {
      const timeSource = e.settledTs || e.resolved_at || e.ts;
      const time = timeSource ? new Date(timeSource).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      const dir = e.modelDir ?? '—';
      const dirColor = dir === 'up' ? 'var(--color-green)' : dir === 'down' ? 'var(--color-red)' : 'var(--color-text-muted)';
      const outcome = e.actualOutcome ?? e.outcome ?? '—';
      const outcomeColor = outcome === 'UP' ? 'var(--color-green)' : outcome === 'DOWN' ? 'var(--color-red)' : 'var(--color-text-muted)';
      const correct = e.modelCorrect === true ? '✅' : e.modelCorrect === false ? '❌' : '—';
      const wick = e.wickedOut ? '<span style="color:var(--color-red);font-weight:800">⚡WICK</span>' : '';
      const sweet = e.sweetSpot ? '⭐' : '';
      const fade = e.crowdFade ? '🔄' : '';
      const align = e.orchestratorAlign ?? e.alignment ?? '—';
      const kalshiPct = e.entryProb != null ? Math.round(e.entryProb * 100) + '%' : '—';
      const modelPct = e.modelProbUp != null ? Math.round(e.modelProbUp * 100) + '%' : (e.modelScore != null ? Math.round(50 + e.modelScore * 50) + '%' : '—');
      const tradedStr = e.orchestratorAction === 'trade' ? '<span style="color:var(--color-green)">TRADE</span>' : `<span style="color:var(--color-text-muted)">${e.orchestratorAction ?? 'skip'}</span>`;
      const snap60 = (e.closeSnapshots || []).find(s => s.secsLeft >= 30 && s.secsLeft <= 90);
      const snapStr = snap60 ? `K@T-${snap60.secsLeft}s: ${Math.round(snap60.kalshiProb * 100)}%` : '';
      const sourceTag = `<span style="font-size:9px;color:var(--color-text-faint);background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:3px">${e._source || '?'}</span>`;
      return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04)">
        <td style="padding:7px 8px;font-weight:700;color:var(--color-text)">${e.sym}</td>
        <td style="padding:7px 8px;color:var(--color-text-muted);font-size:10px">${time}</td>
        <td style="padding:7px 8px;color:${dirColor};font-weight:700">${dir.toUpperCase()}</td>
        <td style="padding:7px 8px;color:${outcomeColor};font-weight:700">${outcome}</td>
        <td style="padding:7px 8px;text-align:center;font-size:14px">${correct}</td>
        <td style="padding:7px 8px;font-family:var(--font-mono);font-size:11px">${modelPct}</td>
        <td style="padding:7px 8px;font-family:var(--font-mono);font-size:11px">${kalshiPct}</td>
        <td style="padding:7px 8px;font-size:11px;color:var(--color-text-muted)">${align}</td>
        <td style="padding:7px 8px">${tradedStr}</td>
        <td style="padding:7px 8px;font-size:11px;color:var(--color-text-muted)">${sweet}${fade}</td>
        <td style="padding:7px 8px;font-size:11px">${wick}</td>
        <td style="padding:7px 8px;font-size:10px;color:var(--color-text-faint);font-family:var(--font-mono)">${snapStr}</td>
        <td style="padding:7px 8px">${sourceTag}</td>
      </tr>`;
    }).join('');

    return `
      <div style="padding:16px;max-width:1600px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <span style="font-size:18px;font-weight:800">📋 Contract Log (All Sources)</span>
          <span style="font-size:11px;color:var(--color-text-muted)">
            Runtime: ${runtimeLog.length} | Kalshi: ${kalshiLog.length} | Cache: ${cacheSettlements.length} | localStorage: ${lsLog.length}
          </span>
        </div>
        <div style="background:rgba(100,200,100,0.08);border:1px solid rgba(100,200,100,0.2);border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:11px;color:var(--color-text-muted)">
          <strong>📂 Storage Locations:</strong> Z:\\ (network) | D:\\ (local) | F:\\ (backup) | C:\\Users\\user\\AppData\\Local\\WE-CRYPTO-CACHE (local cache) | OneDrive (cloud) | localStorage (browser)
          <br><strong>Data Sources:</strong> runtime (in-memory), kalshi (Kalshi API), cache (multi-drive), localStorage (browser storage)
        </div>
        ${statBar}
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="border-bottom:2px solid rgba(255,255,255,0.1)">
                ${['Sym', 'Time', 'Model Dir', 'Outcome', '✓', 'Model%', 'Kalshi%', 'Align', 'Action', 'Flags', 'Wick', 'Snap', 'Source'].map(h =>
      `<th style="padding:6px 8px;text-align:left;font-size:10px;font-weight:700;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.5px">${h}</th>`
    ).join('')}
              </tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="13" style="padding:20px;color:var(--color-text-muted);text-align:center">No contracts found in any source</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }

  // ── Export contract log to all discovered drives + local ──────────────────
  window._exportContractLog = async function () {
    const log = window._15mResolutionLog || [];
    const content = log.map(e => JSON.stringify(e)).join('\n');
    // Use DataLogger's discovered paths so we always write everywhere
    const paths = window.DataLogger?.getWritePaths('contract-export') || [];
    if (!paths.length) {
      alert('DataLogger not ready — try again in a moment');
      return;
    }
    let written = 0;
    for (const p of paths) {
      try {
        const ok = await window.dataStore.writeFile(p, content);
        if (ok) written++;
      } catch (_) { }
    }
    alert(`Exported ${log.length} contracts to ${written}/${paths.length} paths`);
  };

  // ================================================================
  // BOOT
  // ================================================================

  // Start Coinbase Advanced Trade WebSocket for live 15-min candle buckets
  if (window.CandleWS) {
    CandleWS.start();
    window.addEventListener('candleWS:connected', () => {
      const el = document.getElementById('feedStatusText');
      if (el) el.textContent = 'Live · WS connected';
    });
    window.addEventListener('candleWS:disconnected', () => {
      const el = document.getElementById('feedStatusText');
      if (el) el.textContent = 'WS reconnecting…';
    });
  }

  // ── CFM Floating Router — start early exit polling ─────────────
  if (window.CFMRouter) {
    CFMRouter.startExitPolling();
  }

  // ── CFM Early Exit Toast ────────────────────────────────────────
  // DISABLED: cfm:earlyExit listener
  // Early exit toasts were firing too frequently (flips + macro moves in last 2-4 min)
  // Re-enable after stabilizing MIN_FLIP_STREAK and macro consensus thresholds
  /*
  window.addEventListener('cfm:earlyExit', (e) => {
    const { sym, reason, strength, prediction, type } = e.detail || {};
    if (!sym) return;
    showEarlyExitToast(sym, prediction, reason, strength, type, e.detail || {});
  });
  */

  // ── Shell Router Veto Toasts ────────────────────────────────────
  window.addEventListener('shell:vetoConfirmed', (e) => {
    const { sym, amplifiedEnergy } = e.detail || {};
    if (!sym) return;
    const coin = (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []).find(c => c.sym === sym);
    const icon = coin?.icon || sym;
    const pct = Math.round((amplifiedEnergy || 0) * 100 * 10) / 10;
    showEarlyExitToast(sym, 'current', `Shell energy ${pct}% — stand aside`, Math.min((amplifiedEnergy || 0) * 8, 1), 'coordinated_sell');
    console.log(`[ShellRouter] Toast: ${sym} wall CONFIRMED`);
  });

  window.addEventListener('shell:vetoReleased', (e) => {
    const { sym, reason } = e.detail || {};
    if (!sym) return;
    // Show a brief green "wall absorbed" notification
    if (activeToasts.has(sym)) {
      activeToasts.get(sym).remove();
      activeToasts.delete(sym);
    }
    const coin = (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []).find(c => c.sym === sym);
    const icon = coin?.icon || sym;
    const toast = document.createElement('div');
    toast.setAttribute('data-exit-toast', sym + '-released');
    toast.style.cssText = [
      'position:fixed', 'top:68px', 'right:16px', 'z-index:9999',
      'background:var(--color-surface,#12192e)', 'border:1px solid rgba(0,200,100,0.35)',
      'border-radius:10px', 'padding:10px 14px', 'min-width:200px', 'max-width:280px',
      'box-shadow:0 4px 20px rgba(0,0,0,.45)', 'animation:fadeInRight .25s ease', 'cursor:pointer',
    ].join(';');
    toast.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">${icon}</span>
        <span style="font-weight:700;color:var(--color-green)">✅ ${sym} — wall absorbed</span>
      </div>
      <div style="font-size:11px;color:var(--color-text-muted);margin-top:3px">
        ${reason ?? 'Wall pressure resolved — prediction resumes'}
      </div>`;
    toast.addEventListener('click', () => toast.remove());
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 25000);
    console.log(`[ShellRouter] Toast: ${sym} wall released (${reason})`);
  });

  // ── 15M Market Resolution listener ─────────────────────────────────
  // Kalshi 15M settled result fed back into CFM calibration and debug panel.
  window.addEventListener('market15m:resolved', (e) => {
    const { sym, outcome, modelCorrect, prob, orchestratorAction, edgeCents } = e.detail || {};
    if (!sym) return;
    const icon = modelCorrect === true ? '✅' : modelCorrect === false ? '❌' : '❓';
    const coin = (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []).find(c => c.sym === sym);
    const label = coin?.icon ? coin.icon + ' ' + sym : sym;
    const orchStr = orchestratorAction ? ` orch:${orchestratorAction}` : '';
    const edgeStr = edgeCents != null ? ` edge:${edgeCents}¢` : '';
    console.log('[Resolver] ' + label + ' 15M ' + outcome + ' ' + icon + ' | prob:' + Math.round((prob || 0.5) * 100) + '%' + orchStr + edgeStr);
    if (currentView === 'predictions' && predsLoaded) {
      updateAccuracyBadge();
      // Refresh the debug panel so settled contracts appear immediately
      const panel = document.getElementById('kalshi-debug-panel');
      if (panel) {
        const open = panel.hasAttribute('open');
        panel.outerHTML = buildKalshiDebugPanel();
        if (open) {
          const np = document.getElementById('kalshi-debug-panel');
          if (np) np.setAttribute('open', '');
        }
      }
    }
    if (currentView === 'log' || currentView === 'debuglog') render();
  });

  // ── Real-time ms countdown for last-call Kalshi contracts ────────────────
  // Updates every 100ms so traders see sub-second precision when < 10s left.
  // Targets elements with data-close-ms attribute — set during render.
  setInterval(() => {
    const now = Date.now();
    // Scope to the active view to avoid scanning the entire document on every 100ms tick
    const activeView = document.querySelector('.view.active') || document.body;
    activeView.querySelectorAll('[data-close-ms]').forEach(el => {
      const closeMs = parseInt(el.getAttribute('data-close-ms'), 10);
      const msLeft = Math.max(0, closeMs - now);
      const secsLeft = msLeft / 1000;
      let label;
      if (secsLeft < 10) label = msLeft.toFixed(0) + 'ms';
      else if (secsLeft < 90) label = Math.round(secsLeft) + 's';
      else label = (secsLeft / 60).toFixed(1) + 'm';
      if (el.id && el.id.startsWith('kalshi-lc-')) {
        el.textContent = '⚡ ' + label;
        // Pulse red when < 10s
        el.style.opacity = secsLeft < 10 && Math.floor(now / 300) % 2 === 0 ? '0.5' : '1';
      } else if (el.id && el.id.startsWith('kalshi-min-')) {
        if (closeMs && (now - closeMs) > 5_000) { el.innerHTML = '⏱ <strong>—</strong>'; return; } // contract expired — new one pending
        el.innerHTML = '⏱ <strong' + (secsLeft < 30 ? ' style="color:var(--color-red)"' : '') + '>' + label + '</strong>';
      }
    });
    // Live-tick sweet-spot countdown (kalshi-ss-* elements)
    activeView.querySelectorAll('[data-close-ms][id^="kalshi-ss-"]').forEach(el => {
      const closeMs = parseInt(el.getAttribute('data-close-ms'), 10);
      if (!closeMs) return;
      const msLeft = closeMs - now;
      if (msLeft <= 0) { el.textContent = '—'; return; } // contract expired — new one pending
      const secsLeft = msLeft / 1000;
      el.textContent = secsLeft < 60 ? Math.round(secsLeft) + 's' : (secsLeft / 60).toFixed(1) + 'm';
    });
    // Live-tick Market Divergence timers without requiring a full re-render
    activeView.querySelectorAll('[data-mdiv-ts]').forEach(el => {
      const firstDivTs = parseInt(el.getAttribute('data-mdiv-ts'), 10);
      if (!firstDivTs) return;
      const sec = Math.floor((now - firstDivTs) / 1000);
      el.textContent = sec >= 60
        ? Math.floor(sec / 60) + 'm ' + (sec % 60) + 's'
        : sec + 's';
    });

    // ── Capture close-time snapshots for contract accuracy analysis ──────────
    // Records Kalshi prob + model score at key seconds-to-close thresholds.
    if (window.MarketResolver?.addCloseSnapshot) {
      const SNAP_THRESHOLDS = [300, 180, 120, 60, 30, 10];
      window._snapThresholdsFired = window._snapThresholdsFired || {};
      const PREDICTION_COINS = window.PREDICTION_COINS || [];
      for (const coin of PREDICTION_COINS) {
        const pm = window.PredictionMarkets?.getCoin?.(coin.sym);
        const k15 = pm?.kalshi15m;
        if (!k15?.closeTime) continue;
        const closeMs = new Date(k15.closeTime).getTime();
        const secsLeft = (closeMs - now) / 1000;
        if (secsLeft < 0 || secsLeft > 320) continue;
        for (const thresh of SNAP_THRESHOLDS) {
          const key = `${coin.sym}_${k15.ticker}_${thresh}`;
          if (!window._snapThresholdsFired[key] && secsLeft <= thresh + 5 && secsLeft >= thresh - 10) {
            window._snapThresholdsFired[key] = true;
            const kalshiProb = k15.probability;
            const modelScore = window._lastPrediction?.[coin.sym]?.score ?? null;
            window.MarketResolver.addCloseSnapshot(coin.sym, Math.round(secsLeft), kalshiProb, modelScore);
          }
        }
      }
      // Clean fired keys every 15 minutes to avoid unbounded growth
      if (!window._snapKeyCleanTs || now - window._snapKeyCleanTs > 900_000) {
        window._snapKeyCleanTs = now;
        window._snapThresholdsFired = {};
      }
    }
  }, 100);


  // ── Awaiting-card insight carousel (3s rotation) ──────────────────────────
  setInterval(() => {
    const map = window._kiInsights;
    if (!map) return;
    document.querySelectorAll('[id^="ki-await-"]').forEach(el => {
      const sym = el.id.replace('ki-await-', '');
      const ins = map[sym];
      if (!ins?.length) return;
      let idx = ((el._awaitIdx ?? -1) + 1) % ins.length;
      el._awaitIdx = idx;
      const cur = ins[idx];
      // Fade out → swap content → fade in
      el.style.opacity = '0.15';
      setTimeout(() => {
        try {
          const dots = ins.map((_, j) =>
            `<span style="width:16px;height:2px;border-radius:1px;background:${j === idx ? 'var(--color-primary,#7c6aff)' : 'rgba(255,255,255,0.12)'}" id="ki-dot-${sym}-${j}"></span>`
          ).join('');
          el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:9px;font-weight:700;color:var(--color-text-faint);letter-spacing:.5px;text-transform:uppercase;min-width:110px">${cur.label}</span>
            <strong style="font-size:13px;color:${cur.color}">${cur.icon} ${cur.value}</strong>
            ${cur.detail ? `<span style="margin-left:auto;font-size:10px;color:var(--color-text-faint)">${cur.detail}</span>` : ''}
          </div>
          <div style="display:flex;gap:3px;margin-top:4px">${dots}</div>`;
          el.style.opacity = '1';
        } catch (_) { }
      }, 220);
    });
  }, 3000);

  // ── Market Divergence live refresh (every 5s) ────────────────────────────
  // Keeps _marketDivergence state fresh between prediction engine cycles using
  // live Kalshi odds from PredictionMarkets — fixes stale %, catchupDelta, phase.
  setInterval(() => {
    if (!window._marketDivergence || !window._lastPrediction) return;
    try {
      PREDICTION_COINS.forEach(coin => {
        const buf = window._marketDivergence[coin.sym];
        if (!buf?.active || !buf.firstDivTs) return; // only refresh active divergence windows
        const pm = window.PredictionMarkets?.getCoin?.(coin.sym);
        const liveProb = pm?.kalshi15m?.probability;
        if (liveProb == null) return;
        const liveKalshiPct = liveProb * 100;
        const lastPred = window._lastPrediction[coin.sym];
        if (!lastPred) return;
        const predObj = window._predictions?.[coin.sym] ?? null;
        const modelScore = predObj?.score ?? 0;
        const strikeDir = pm?.kalshi15m?.strikeDir === 'below' ? 'below' : 'above';
        const yesDir = strikeDir === 'below' ? 'down' : 'up';
        const noDir = yesDir === 'up' ? 'down' : 'up';
        const modelYesPct = predObj?.projections?.p15?.kalshiAlign?.modelYesPct;
        const modelDir = Number.isFinite(modelYesPct)
          ? (modelYesPct >= 58 ? yesDir : modelYesPct <= 42 ? noDir : 'wait')
          : (modelScore > 0.12 ? 'up' : modelScore < -0.12 ? 'down' : 'wait');
        const kalshiDir = liveKalshiPct >= 50 ? yesDir : noDir;
        updateMarketDivergence(coin.sym, modelDir, kalshiDir, liveKalshiPct, modelScore);
      });
    } catch (e) { /* non-critical */ }
  }, 5000);

  // ── Blockchain scan live updates ──────────────────────────────────
  window.addEventListener('blockchain-scan-update', () => {
    if (currentView === 'onchain') refreshChainScanUI();
    scheduleWebStatePublish('blockchain-scan', 150);
  });

  window.addEventListener('cex-flow-update', () => {
    if (currentView === 'universe') {
      const cexEl = document.getElementById('universe-cex');
      if (cexEl && cexEl.style.display !== 'none') refreshCexFlow(_cexActiveSym, cexEl);
    }
  });

  // Boot guard — if all sources take >8s something is very wrong; force a render
  const _bootGuard = setTimeout(() => {
    if (Object.keys(tickers).length === 0) {
      console.warn('[boot] fetchAll timed out after 8s — forcing render with empty tickers');
      _fetchAttempted = true;
      setFeedStatus('error');
      render();
    }
  }, 20000);

  window._fetchAllNow = () => fetchAll(true).then(() => { clearTimeout(_bootGuard); resetTimer(); });

  // Prewarm coin icons — populates browser HTTP cache before first render
  (function prewarmCoinIcons() {
    const syms = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'DOGE', 'BNB'];
    const cgBase = 'https://assets.coingecko.com/coins/images';
    const cgIds = {
      BTC: '1/large/bitcoin.png', ETH: '279/large/ethereum.png', SOL: '4128/large/solana.png',
      XRP: '44/large/xrp-symbol-white-128.png', HYPE: '39198/large/hyperliquid.png',
      DOGE: '5/large/dogecoin.png', BNB: '825/large/bnb-icon2_2x.png'
    };
    syms.forEach(sym => {
      const img = new Image();
      img.src = `${cgBase}/${cgIds[sym]}`;
      img.onerror = () => {
        const fb = new Image();
        fb.src = `https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons/128/color/${sym.toLowerCase()}.png`;
      };
    });
    // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();

  // ── Staggered boot — unlock nav immediately, populate panels as data arrives ──
  // Set _fetchAttempted now so render() never blocks on the loading screen gate.
  // Panels render with empty state first; refreshActiveView() fills them as each
  // source resolves.
  _fetchAttempted = true;
  startWebStateHeartbeat();
  scheduleWebStatePublish('boot', 0);
  render(); // skeleton — nav is live before any network call completes

  // Fire data fetch after a single paint frame so the skeleton renders first
  requestAnimationFrame(() => {
    fetchAll().then(() => {
      clearTimeout(_bootGuard);
      resetTimer();
      startCountdownTicker();
      startLastUpdateTicker();
      startAsyncRefreshEngine();
      // Stagger heavy background modules so they don't contend with first render
      startPythLazerStream();   // wire Lazer WS live ticker overlay
      setTimeout(() => { if (window.PredictionMarkets) window.PredictionMarkets.start(); }, 500); // +0.5s
      setTimeout(() => { if (window.BlockchainScan) window.BlockchainScan.start(); }, 2000); // +2s
      setTimeout(() => { if (window.CexFlow) window.CexFlow.start(); }, 4000); // +4s
      // ── Settlement pulse: big coordinated blast at every :00/:15/:30/:45 ──
      // Regular streaming via resetTimer() keeps running between pulses.
      setTimeout(() => {
        if (!window._asyncRefreshEngine?.running) {
          scheduleOnQuarterHours(settlementPull);
          console.info('[WE] ⚡ Settlement pulse scheduler armed — fires at :00/:15/:30/:45');
        } else {
          console.info('[WE] ⚡ Async refresh engine active — settlement pulses handled in background');
        }
      }, 4500); // arm after all modules are up
      // Start high-precision 15m coordinator to prefetch and confirm predictions
      setTimeout(() => { if (window.Coordinator15m) { window.Coordinator15m.start(); console.info('[WE] Coordinator15m started'); } }, 6000);
    });
  });

  // ── 5M Markets auto-refresh: re-render the view when prediction data arrives ──
  // PredictionMarkets fetches async; if the user opens the 5M view before the
  // first fetch completes, the cards show "No active contract". This listener
  // re-renders the view as soon as fresh data is available.
  window.addEventListener('predictionmarketsready', () => {
    if (currentView === 'markets5m') renderMarkets5M();
    // Re-render prediction cards when Kalshi data arrives — ensures new contracts
    // appear immediately when the burst-retry fetches them instead of waiting
    // for the next PredictionEngine.runAll() cycle (up to 15s later).
    if (['predictions', 'cfm', 'universe'].includes(currentView) && predsLoaded && !predictionRunInFlight) {
      try {
        if (currentView === 'predictions') refreshActiveView();
        else refreshActiveView();
      } catch (_) { }
    }
    scheduleWebStatePublish('predictionmarkets', 100);
  });

  // Prediction live-stream watchdog — keeps cards updated between manual refreshes.
  // Important: snapshotPredictions() stability lock assumes ~15s snapshots (see MIN_FLIP_STREAK comment).
  setInterval(async () => {
    if (window._asyncRefreshEngine?.running) return;
    if (!['predictions', 'cfm', 'universe'].includes(currentView) || document.hidden) return;
    if (predictionRunInFlight) return;
    try {
      const now = Date.now();
      const liveRunCadenceMs = currentView === 'predictions'
        ? Math.max(15000, (refreshSecs || 15) * 1000)
        : 30000;
      const renderAge = now - (_lastPredRenderTs || 0);
      if (currentView === 'predictions' && _lastPredRenderTs && renderAge > 20000) {
        refreshActiveView();
      }
      const runAge = now - (_lastPredictionRunTs || 0);
      if ((predsLoaded && !_lastPredictionRunTs) || (_lastPredictionRunTs && runAge > liveRunCadenceMs)) {
        const predictionRun = startPredictionRun();
        await predictionRun;
        _lastPredictionRunTs = Date.now();
        predsLoaded = true;
        snapshotPredictions();
        if (currentView === 'predictions') refreshActiveView();
        else refreshActiveView();
      }
    } catch (_) { }
  }, 20000);

  // ── Order Book HUD — initialise after DOM is ready ──────────────
  initOBHud();

  // ── Load Birdeye API Key (Electron IPC) ──────────────────────────
  (async function loadBirdeyeKey() {
    try {
      if (typeof window.desktopApp?.loadBirdeyeApiKey === 'function') {
        const res = await window.desktopApp.loadBirdeyeApiKey();
        if (res.success && res.apiKey) {
          window.BIRDEYE_API_KEY = res.apiKey;
          console.log('[Birdeye] API key loaded from secrets/BIRDEYE-API-KEY.txt');
        } else {
          console.warn('[Birdeye] Failed to load API key:', res.error);
        }
      }
    } catch (err) {
      console.warn('[Birdeye] Error loading API key:', err.message);
    }
    // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();

  // ── Initialize Adaptive Tuning Modules ────────────────────────────
  (function initializeAdaptiveModules() {
    try {
      if (typeof AdaptiveTuner !== 'undefined') {
        window._adaptiveTuner = new AdaptiveTuner();
        console.log('[App] AdaptiveTuner initialized');

        const adaptiveCoinSymbols = () => {
          if (window._adaptiveTuner?.getTuningCoins) return window._adaptiveTuner.getTuningCoins();
          return (window.PREDICTION_COINS || []).map(c => c && c.sym).filter(Boolean);
        };
        const secsToClose = (sym) => {
          const close = window.PredictionMarkets?.getCoin?.(sym)?.kalshi15m?.closeTime;
          if (!close) return null;
          const ms = new Date(close).getTime() - Date.now();
          return Number.isFinite(ms) ? ms / 1000 : null;
        };
        window._runAdaptiveLiveRetune = (reason = 'continuous') => {
          if (!window._adaptiveTuner?.observeLiveMarketState) return null;
          const touched = [];
          for (const sym of adaptiveCoinSymbols()) {
            try {
              const pred = window._predictions?.[sym] || window._lastPrediction?.[sym] || null;
              const cfm = window._cfmAll?.[sym] || window.CFMEngine?.getAll?.()?.[sym] || null;
              const balance = window.OB?.getBalanceMetrics?.(sym) || null;
              const state = window._adaptiveTuner.observeLiveMarketState(sym, {
                pred,
                cfm,
                secsLeft: secsToClose(sym),
                bookImbalance: balance?.imbalance?.value,
                buyRatio: balance?.flow?.buyRatio,
                reason,
              });
              if (state) touched.push(sym);
            } catch (err) {
              console.warn('[AdaptiveTuner] live retune failed for', sym, err.message);
            }
          }
          return touched;
        };

        setTimeout(async () => {
          try {
            window._runAdaptiveLiveRetune?.('startup');
            await window._adaptiveTuner.runTuningCycle({ validatePyth: false, dryRun: false, reason: 'startup-live-retune' });
          } catch (err) {
            console.warn('[AdaptiveTuner] startup retune failed:', err.message);
          }
        }, 5000);

        // Continuous live adaptation: cheap, all-coin threshold pressure.
        setInterval(() => {
          try { window._runAdaptiveLiveRetune?.('continuous-live-retune'); } catch (_) {}
        }, 5000);

        // Outcome/indicator retune checks run on the tuner cadence instead of waiting 15m.
        setInterval(async () => {
          try {
            const trigger = window._adaptiveTuner.shouldRetune?.() || { shouldRetune: true, trigger: 'scheduled' };
            if (!trigger.shouldRetune) return;
            const result = await window._adaptiveTuner.runTuningCycle({
              validatePyth: true,
              dryRun: false,
              reason: trigger.trigger || 'continuous-scheduled',
            });
            if (result.totalAdjustments > 0) {
              console.log(`[AdaptiveTuner] ${result.totalAdjustments} thresholds adjusted at ${new Date().toLocaleTimeString()}`);
            }
          } catch (err) {
            console.warn('[AdaptiveTuner] Cycle failed:', err.message);
          }
        }, 60 * 1000);

        console.log('[App] AdaptiveTuner continuous live retune enabled + cycle checks every 60 seconds');
      }
      if (typeof PythSettlementValidator !== 'undefined') {
        window._pythSettlementValidator = new PythSettlementValidator();
        console.log('[App] PythSettlementValidator initialized');

        // Feed Pyth volatility data to adaptive tuner every 60 seconds
        setInterval(async () => {
          if (!window._pythSettlementValidator || !window._adaptiveTuner) return;
          try {
            const TRACKING_COINS = window._adaptiveTuner?.getTuningCoins?.() || ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
            for (const sym of TRACKING_COINS) {
              const priceData = await window._pythSettlementValidator.getCurrentPrice(sym);
              window._pythSettlementValidator.recordPrice(sym, priceData.price);
              const vol = window._pythSettlementValidator.getVolatility(sym);
              window._adaptiveTuner.volatilityRegime[sym] = vol;
            }
          } catch (err) {
            // Silently skip if Pyth API unavailable
          }
        }, 60000); // Every 60 seconds

        console.log('[App] PythSettlementValidator tracking volatility every 60s');
      }
      if (typeof HolderMetrics !== 'undefined') {
        window.HolderMetrics.start();
        console.log('[App] HolderMetrics initialized and auto-refreshing');
      }
      // Initialize Panel Data Monitor
      if (typeof PanelDataMonitor !== 'undefined') {
        // Register prediction data channel
        PanelDataMonitor.register(
          'predictions',
          async () => window._predictions || {},
          null,
          { interval: 20000, critical: true }
        );

        // Register hourly kalshi tracker channel
        if (window.HourlyKalshiTracker) {
          PanelDataMonitor.register(
            'kalshi-tracker',
            async () => window.HourlyKalshiTracker.stats?.() || {},
            null,
            { interval: 15000, critical: false }
          );
        }

        PanelDataMonitor.start();
        console.log('[App] PanelDataMonitor initialized');
      }
    } catch (err) {
      console.warn('[App] Failed to initialize adaptive modules:', err.message);
    }
    // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();

  // ── KalshiDebug console API ──────────────────────────────────────
  // Accessible from DevTools console for live inspection.
  window.KalshiDebug = {
    audit: sym => (window._kalshiLog || []).filter(e => !sym || e.sym === sym),
    errors: () => (window._kalshiErrors || []),
    pending: () => window.MarketResolver?.getPending?.() ?? [],
    last: sym => (window._lastKalshiSnapshot || {})[sym] ?? null,
    contract: sym => (window._kalshiLog || []).filter(e => e.sym === sym).slice(-1)[0] ?? null,
    trail: sym => Object.values(window._kalshiPredictionTrail || {}).filter(t => !sym || t.sym === sym),
    orch: sym => sym ? (window._orchLog || []).filter(e => e.sym === sym).slice(-5)
      : (window._orchLog || []).slice(-20),
    liveOrch: sym => window.KalshiOrchestrator?.getIntent?.(sym) ?? null,
    scorecard: () => {
      const out = {};
      (typeof PREDICTION_COINS !== 'undefined' ? PREDICTION_COINS : []).forEach(c => {
        // Check BOTH _kalshiLog AND multi-drive cache
        const kalshiSettlements = (window._kalshiLog || []).filter(x => x.sym === c.sym && x._settled);
        const cacheSettlements = window.MultiDriveCache?.data?.settlements?.filter(s => s.coin === c.sym) || [];

        const allSettlements = [...kalshiSettlements, ...cacheSettlements];

        if (!allSettlements.length) {
          out[c.sym] = { n: 0, source: 'none' };
          return;
        }

        // Count correct predictions from both sources
        const mOk = allSettlements.filter(x => {
          // Check modelCorrect from Kalshi log or cache settlement
          return x.modelCorrect === true || (x.modelCorrect !== false && x.modelCorrect !== null);
        }).length;

        const fE = kalshiSettlements.filter(x => x.fadeActive && x.fadeCorrect !== null);
        const fOk = fE.filter(x => x.fadeCorrect === true).length;

        out[c.sym] = {
          n: allSettlements.length,
          kalshiN: kalshiSettlements.length,
          cacheN: cacheSettlements.length,
          modelPct: Math.round(mOk / allSettlements.length * 100),
          fadePct: fE.length ? Math.round(fOk / fE.length * 100) : null,
          fadeN: fE.length,
          source: 'kalshi+cache'
        };
      });
      return out;
    },
    cacheStatus: () => {
      // Show comprehensive cache status
      const status = window.MultiDriveCache?.getStatus?.() ?? {};
      const accuracy = window.MultiDriveCache?.getAccuracyByCoins?.() ?? {};
      return { status, accuracy };
    },
    missedOpps: () => window.MarketResolver?.getMissedOpps?.() ?? [],
    suspects: (opts = {}) => window.KalshiForensics?.identifySuspects?.(opts)
      ?? { error: 'KalshiForensics unavailable' },
    replayIncident: (opts = {}) => window.KalshiForensics?.replay?.(opts)
      ?? { error: 'KalshiForensics unavailable' },
    replayTrade: (suspect, opts = {}) => window.KalshiForensics?.replayTrade?.(suspect, opts)
      ?? { error: 'KalshiForensics unavailable' },
    classifyTrade: suspect => window.KalshiForensics?.classify?.(suspect)
      ?? { error: 'KalshiForensics unavailable' },
    clearOrch: () => { window._orchLog = []; saveOrchLog(); console.log('[KalshiDebug] _orchLog cleared'); },
    clearTrail: () => { window._kalshiPredictionTrail = {}; saveKalshiTrail(); console.log('[KalshiDebug] 2m prediction trail cleared'); },
    dump: sym => ({
      snapshot: (window._lastKalshiSnapshot || {})[sym],
      log: (window._kalshiLog || []).filter(e => e.sym === sym).slice(-5),
      trail: Object.values(window._kalshiPredictionTrail || {}).filter(t => t.sym === sym).slice(-5),
      orch: (window._orchLog || []).filter(e => e.sym === sym).slice(-5),
      resolved: (window._15mResolutionLog || []).filter(e => e.sym === sym).slice(-3),
      cache: {
        predictions: window.MultiDriveCache?.data?.predictions?.filter(p => p.coin === sym).slice(-5) || [],
        settlements: window.MultiDriveCache?.data?.settlements?.filter(s => s.coin === sym).slice(-5) || [],
        errors: window.MultiDriveCache?.data?.errors?.filter(e => e.context?.sym === sym).slice(-3) || []
      }
    }),
  };
  console.log('[KalshiDebug] API ready — KalshiDebug.audit(sym) .trail(sym) .orch(sym) .scorecard() .suspects(opts) .replayIncident(opts) .dump(sym)');

  // ── ContractCacheDebug console API (NEW) ─────────────────────────────
  window.ContractCacheDebug = {
    status: () => window._contractCache?.getStatus?.() ?? { error: 'Cache not initialized' },
    accuracy: () => window._contractCache?.getAllAccuracy?.() ?? null,
    byCoins: () => {
      const coins = new Set((window._contractCache?.predictions || []).map(p => p.coin));
      const result = {};
      for (const coin of coins) {
        result[coin] = window._contractCache?.getCoinAccuracy?.(coin) ?? null;
      }
      return result;
    },
    recent: (minutes = 60) => ({
      predictions: window._contractCache?.getRecentPredictions?.(null, minutes) ?? [],
      settlements: window._contractCache?.getRecentSettlements?.(null, minutes) ?? [],
      errors: window._contractCache?.getRecentErrors?.(null, minutes) ?? []
    }),
    errors: (type = null) => window._contractCache?.getRecentErrors?.(type, 120) ?? [],
    print: () => window._contractCache?.printReport?.() ?? console.log('Cache not initialized'),
    export: () => window._contractCache?.exportJSON?.() ?? null,
    exportCSV: () => window._contractCache?.exportCSV?.() ?? null,
    clear: () => {
      localStorage.removeItem('contract-cache-2h');
      console.log('[ContractCacheDebug] Cleared cache from localStorage');
    }
  };
  console.log('[ContractCacheDebug] API ready — ContractCacheDebug.status() .accuracy() .byCoins() .recent(minutes)');

  // =========================================================================
  // RL Weights Synchronization
  // =========================================================================
  setTimeout(() => {
    if (window.wecryp?.getSystemWeights) {
      window.wecryp.getSystemWeights()
        .then(res => {
          if (res.success && res.weights) {
            console.log('[RL Loop] ?? Fetched system_weights from Firebase on startup');
            if (window.PredictionMarkets?.setAdaptiveWeights) {
              const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']; 
              symbols.forEach(sym => {
                window.PredictionMarkets.setAdaptiveWeights(sym, res.weights);
              });
            }
          }
        })
        .catch(err => console.warn('[RL Loop] Failed to sync startup weights:', err));
    }
  }, 3000); 
})();

