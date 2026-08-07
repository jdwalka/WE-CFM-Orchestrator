/**
 * ================================================================
 * WECRYPTO Startup Loader
 * 
 * Fast app initialization sequence
 * Restores cached calibration in <100ms, app is immediately functional
 * Background refresh happens in parallel
 * ================================================================
 */

(function () {
  'use strict';

  const STARTUP_LOG = [];
  function log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    STARTUP_LOG.push(`[${ts}] ${msg}`);
    console.log(`[STARTUP] ${msg}`);
  }

  // ── Phase 1: Fast Restore (synchronous, <50ms) ──────────────────
  async function phaseRestoreCalibration() {
    log('Phase 1: Restoring calibration from cache...');

    if (typeof window === 'undefined' || !window.AdaptiveWeightRestorer) {
      log('⚠ AdaptiveWeightRestorer not loaded');
      return false;
    }

    const restorer = window.__AdaptiveWeightRestorer || new window.AdaptiveWeightRestorer();
    const result = await restorer.initialize();

    if (result.success) {
      log(`✓ Calibration restored (source: ${result.source})`);
      return true;
    } else {
      log('⚠ No calibration to restore (first run?)');
      return false;
    }
  }

  // ── Phase 2b: RL stack model (optional pre-trained bundle) ─────────
  async function phaseLoadRLStack() {
    if (!window.TradingRLAgent?.loadModel) return false;
    try {
      const ok = await window.TradingRLAgent.loadModel('models/rl-stack-bundle.json');
      if (ok) log('✓ RL stack model loaded (DQN+MCTS+CFR+mispricing)');
      else log('ℹ RL stack using online-learned defaults (no bundle yet)');
      return ok;
    } catch (err) {
      log(`ℹ RL stack model skip: ${err.message}`);
      return false;
    }
  }

  // ── Phase 2: Load Cached Historical Data (fast, <100ms) ─────────
  async function phaseLoadHistoricalCache() {
    log('Phase 2: Loading historical contract cache...');

    try {
      if (typeof window === 'undefined' || !window.electron) {
        log('ℹ Not in Electron, skipping cache load');
        return false;
      }

      const result = await window.electron.invoke('storage:readContractCache');
      if (result.success) {
        log(`✓ Loaded ${result.count} contracts from cache (${result.source})`);

        // Keep cache-manager object intact; store imported settlements separately
        window._driveContractSettlements = Array.isArray(result.data) ? result.data : [];
        window._driveContractCacheMeta = {
          source: result.source || null,
          count: result.count || window._driveContractSettlements.length,
          loadedAt: Date.now(),
        };
        return true;
      }
    } catch (err) {
      log(`⚠ Cache load failed: ${err.message}`);
    }

    return false;
  }

  // ── Phase 3: Load CSV Historical Data (parallelized, non-blocking) ──────────
  async function phaseDisplayDebugPanel() {
    const phase3Start = Date.now();
    log('Phase 3: Loading CSV historical contracts with resolution data...');

    if (typeof window === 'undefined') {
      log('ℹ Not in browser - skipping debug panel');
      return false;
    }

    try {
      // ★ OPTIMIZATION: Parallelize resolution log restore + calculator init
      // These don't depend on each other, so fire both simultaneously
      const [resolutionLog, calc] = await Promise.all([
        // Parallel task 1: Restore resolution log
        (async () => {
          if (window._15mResolutionLog?.length > 0) {
            log(`  ✓ Resolution log already loaded (${window._15mResolutionLog.length} records)`);
            return window._15mResolutionLog;
          }
          try {
            const stored = localStorage.getItem('beta1_15m_resolution_log');
            if (stored) {
              const parsed = JSON.parse(stored);
              window._15mResolutionLog = parsed;
              log(`  ✓ Resolved ${parsed.length} settlement records from localStorage`);
              return parsed;
            }
          } catch (e) {
            log(`  ⚠ Resolution log restore failed: ${e.message}`);
          }
          log('  ℹ No resolution log found (first run?)');
          return [];
        })(),
        // Parallel task 2: Initialize or retrieve calculator
        (async () => {
          if (window.__WinRateCalculatorInstance) {
            log('  ✓ Calculator instance already ready');
            return window.__WinRateCalculatorInstance;
          }
          if (!window.ContractWinRateCalculator) {
            log('⚠ ContractWinRateCalculator class not loaded');
            return null;
          }
          window.__WinRateCalculatorInstance = new window.ContractWinRateCalculator();
          log('  ✓ Calculator instance created');
          return window.__WinRateCalculatorInstance;
        })()
      ]);

      if (!calc) return false;

      // Load CSV trades with merged resolution data
      log('  → Loading CSV trades with settlement outcomes...');
      const csvTrades = await calc.loadFromKalshiCSV(resolutionLog || []);

      if (csvTrades.length === 0) {
        log('✓ Phase 3 complete (no historical data yet)');
        return true;
      }

      log(`  ✓ Loaded ${csvTrades.length} CSV trades`);
      const withOutcome = csvTrades.filter(t => t.outcome || t.modelCorrect !== null).length;
      log(`  ✓ ${withOutcome}/${csvTrades.length} trades have outcomes`);

      // Set and calculate accuracy
      calc.contracts = csvTrades;
      calc.calculateAccuracy();
      log(`  ✓ Accuracy: ${calc.stats.overall.wins}W/${calc.stats.overall.losses}L (${Math.round(calc.stats.overall.winRate)}%)`);

      // Expose getter + broadcast
      if (!window.getHistoricalContracts) {
        window.getHistoricalContracts = () => window.__WinRateCalculatorInstance?.contracts || [];
      }
      calc.broadcastStats();
      calc.persistToStorage();

      const phase3Elapsed = Date.now() - phase3Start;
      log(`✓ Phase 3 complete (${phase3Elapsed}ms)`);
      return true;
    } catch (err) {
      log(`⚠ Phase 3 failed: ${err.message}`);
      return false;
    }
  }

  // ── Phase 4: Background Persistence (async, non-blocking) ────────
  async function phaseBackgroundPersistence() {
    log('Phase 4: Caching weights for next startup...');

    if (typeof window === 'undefined' || !window.__AdaptiveWeightRestorer) {
      return;
    }

    try {
      window.__AdaptiveWeightRestorer.cacheCurrentWeights();
      log('✓ Weights cached');
    } catch (err) {
      log(`⚠ Weight caching failed: ${err.message}`);
    }
  }

  // ── Main Startup Sequence ───────────────────────────────────────
  async function startup() {
    const startTime = Date.now();
    log('═══════════════════════════════════════════════════════════');
    log('WECRYPTO Startup Sequence — Optimized for <150ms boot');
    log('═══════════════════════════════════════════════════════════');

    try {
      // Critical path: Phase 1 + 2 must complete before UI is tradeable
      const phase1Start = Date.now();
      await phaseRestoreCalibration();
      log(`  Phase 1 took ${Date.now() - phase1Start}ms`);

      const phase2Start = Date.now();
      await phaseLoadHistoricalCache();
      log(`  Phase 2 took ${Date.now() - phase2Start}ms`);

      phaseLoadRLStack().catch(() => {});

      // Phase 3: Non-blocking (app is live at this point)
      // Fires in background to populate accuracy scorecard
      const phase3Promise = phaseDisplayDebugPanel()
        .catch(err => log(`⚠ Phase 3 background load failed: ${err.message}`));

      const elapsedMs = Date.now() - startTime;
      log(`✅ STARTUP READY in ${elapsedMs}ms (app is live)`);
      log('═══════════════════════════════════════════════════════════');

      // Phase 4: Background persistence (async, doesn't block)
      phaseBackgroundPersistence();

      // Phase 5: Background feed wiring (non-blocking)
      try {
        if (window.EthereumWSConnectors?.start) {
          const wsStatus = window.EthereumWSConnectors.start({
            enablePending: true,
            enableLogs: false,
          });
          if (wsStatus?.success) log('✓ Ethereum WS connectors started');
          else log(`ℹ Ethereum WS connectors not started: ${wsStatus?.error || 'not configured'}`);
        }
        if (window.MempoolTelemetryNormalizer?.start) {
          window.MempoolTelemetryNormalizer.start();
          log('✓ Mempool telemetry normalizer started');
        }
        if (window.DatasetReplayCapture?.start) {
          const replay = window.DatasetReplayCapture.start();
          log(`✓ Dataset replay capture started (${replay?.loaded || 0} records loaded)`);
        }
        if (window.FeedQualityMonitor?.start) {
          window.FeedQualityMonitor.start();
          log('✓ Feed quality monitor started');
        }
      } catch (e) {
        log(`⚠ Feed wiring background start failed: ${e.message}`);
      }

      // Expose logs + timeline for debugging
      window.__STARTUP_LOG = STARTUP_LOG;
      window.__STARTUP_TIMELINE = {
        startMs: startTime,
        readyMs: elapsedMs,
        criticalPathMs: elapsedMs
      };

      // Dispatch ready event (Phase 3 may still be running)
      window.dispatchEvent(new CustomEvent('wecrypto:startupComplete', {
        detail: { elapsedMs, log: STARTUP_LOG, readyTime: elapsedMs }
      }));

      // Wait for Phase 3 in background for completeness
      await phase3Promise;

    } catch (err) {
      log(`❌ STARTUP FAILED: ${err.message}`);
      console.error('[STARTUP]', err);

      window.dispatchEvent(new CustomEvent('wecrypto:startupFailed', {
        detail: { error: err.message, log: STARTUP_LOG }
      }));
    }
  }

  // ── Auto-start on DOM ready ──────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startup);
  } else {
    setTimeout(startup, 100);
  }

  // Expose for manual trigger if needed
  window.__WECRYPTO_STARTUP = { startup, getLog: () => STARTUP_LOG };
})();
