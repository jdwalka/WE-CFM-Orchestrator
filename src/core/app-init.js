// ================================================================
// Application Initialization
// ================================================================

window.__env = window.__env || {};

try {
    if (window.desktopApp?.publicEnv && typeof window.desktopApp.publicEnv === 'object') {
      Object.assign(window.__env, window.desktopApp.publicEnv);
    }
  } catch (err) { console.error('[Error caught]', err);  }

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

window._lastPrediction = window._lastPrediction || {};

window._predLog = window._predLog || [];

window._kalshiLog = window._kalshiLog || [];

window._lastKalshiSnapshot = window._lastKalshiSnapshot || {};

window._kalshiPredictionTrail = window._kalshiPredictionTrail || {};

window._kalshiErrors = window._kalshiErrors || [];

window._marketDivergence = window._marketDivergence || {};

window._orchLog = window._orchLog || [];

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

})();

syncRLWeightsOnce();

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

})();

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


      console.log('[ProxyOrchestrator] ✓ Initialized successfully');
      console.log('[ProxyOrchestrator] Health:', window._proxyOrchestrator.getHealthStatus());
    } catch (e) {
      console.warn('[ProxyOrchestrator] Initialization failed:', e.message);
      // Graceful degradation — app continues to work with direct fetch
    }

})();

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

})();

window._journalPending = window._journalPending || {};

bindTradeBellUnlock();

window.KalshiForensics = {
    parseCsv: parseForensicsCsv,
    identifySuspects: identifySuspectContracts,
    replay: replayCollapsedContractsIncident,
    classify: classifyForensicTrade,
    replayTrade: replaySuspectTimeline,
  };

if (uiState.currentView) currentView = uiState.currentView;

if (Number.isFinite(uiState.refreshSecs)) refreshSecs = uiState.refreshSecs;

if (uiState.theme === 'light' || uiState.theme === 'dark') theme = uiState.theme;

root.setAttribute('data-theme', theme);

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

if (menuBtn) menuBtn.addEventListener('click', () => $('#sidebar').classList.toggle('open'));

if (refreshBtn) refreshBtn.addEventListener('click', () => fetchAll(true));

if (refreshSel) refreshSel.addEventListener('change', e => {
    refreshSecs = parseInt(e.target.value, 10);
    persistUIState();
    resetTimer();
  });

if (refreshSel) refreshSel.value = String(refreshSecs);

window._sharedTickerCache = { data: null, age: 0 };

startKalshiPolling();

startHistoricalPolling();

if (typeof KalshiAccuracyDebug !== 'undefined' && KalshiAccuracyDebug.syncDriveCacheToMemory) {
    setTimeout(() => {
      KalshiAccuracyDebug.syncDriveCacheToMemory().catch(err =>
        console.warn('[App] Drive cache sync failed:', err.message)
      );
    }, 2000); // defer slightly to let app settle
  }

window.addEventListener('predictionadvancedready', () => {
    if (currentView !== 'predictions' || !predsLoaded || predictionRunInFlight) return;
    refreshActiveView();
  });

window.addEventListener('predictionsEnriched', () => {
    snapshotPredictions();
    if (currentView !== 'predictions' || !predsLoaded || predictionRunInFlight) return;
    refreshActiveView();
  });

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
    scheduleWebStatePublish('microstructure-prediction', 50);
    if (!predsLoaded || predictionRunInFlight) return;
    if (['predictions', 'cfm', 'universe'].includes(currentView)) {
      scheduleAsyncUiRefresh('microstructure');
    }
  });

if (!window._predLock) window._predLock = {};

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
        if (kCloseMs < bucketOpen - 120_000) {
          delete window._lastKalshiSnapshot[sym];
          console.warn(`[KalshiTracker] ${sym} deleted deeply stale snapshot to prevent log spam.`);
        }
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
          yesAsk: kSnap.yesAsk ?? null,
          yesBid: kSnap.yesBid ?? null,
          noAsk: kSnap.noAsk ?? null,
          noBid: kSnap.noBid ?? null,
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

window.addEventListener('candleWS:1mTick', (e) => { if (e.detail) _push1mToChart(e.detail.sym, e.detail.bucket); });

window.addEventListener('candleWS:1mClosed', (e) => { if (e.detail) _push1mToChart(e.detail.sym, e.detail.bucket); });

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
          } catch (err) { console.error('[Error caught]', err);  /* non-blocking */ }
        }
      }

      saveKalshiLog();
      if (currentView === 'predictions' && predsLoaded) updateAccuracyBadge();
      break;
    }
  });

loadKalshiHistoricalContracts();

setInterval(async () => {
      try {
        let diag = null;
        let qStats = 0;
        if (window.electron && typeof window.electron.invoke === 'function') {
          const rawDiag = await window.electron.invoke('llm:getStats');
          diag = rawDiag?.diagnostics || rawDiag;
          qStats = window._signalScheduler?.getHealthStatus()?.lanes?.validation?.queued || 0;
        } else {
          const response = await fetch('/api/llm-diagnostics');
          if (response.ok) {
            const rawDiag = await response.json();
            diag = rawDiag?.diagnostics || rawDiag;
          }
        }
        if (diag && diag.stats) {
          _llmObsStats.completions = diag.stats.successes || diag.stats.total_calls || diag.stats.calls || 0;
          _llmObsStats.accepted = diag.stats.successes || 0;
          _llmObsStats.rejected = diag.stats.failures || diag.stats.errors || 0;
          _llmObsStats.provider = diag.provider || 'none';
          _llmObsStats.model = diag.model || 'none';
          _llmObsStats.enabled = diag.enabled || false;
        } else if (diag) {
          _llmObsStats.completions = diag.successes || diag.calls || 0;
          _llmObsStats.accepted = diag.successes || 0;
          _llmObsStats.rejected = diag.failures || diag.errors || 0;
          _llmObsStats.provider = diag.provider || 'none';
          _llmObsStats.model = diag.model || 'none';
          _llmObsStats.enabled = diag.enabled || false;
        }
        _llmObsStats.queues = qStats;

        const sEl = document.getElementById('llm-obs-status');
        if (sEl) sEl.innerHTML = _llmObsStats.enabled ? `🟢 ${_llmObsStats.provider.toUpperCase()} | ${_llmObsStats.model}` : '🔴 Offline';
        const qEl = document.getElementById('llm-obs-queues');
        if (qEl) {
          qEl.innerText = _llmObsStats.queues;
          qEl.style.color = _llmObsStats.queues > 0 ? 'var(--color-orange)' : 'var(--color-green)';
        }
        const aEl = document.getElementById('llm-obs-accepted');
        if (aEl) aEl.innerText = _llmObsStats.accepted;
        const rEl = document.getElementById('llm-obs-rejected');
        if (rEl) {
          rEl.innerText = _llmObsStats.rejected;
          rEl.style.color = _llmObsStats.rejected > 0 ? 'var(--color-red)' : 'var(--color-text-faint)';
        }
      } catch(e) { console.error('[LLMObs] Update Error:', e); }
    }, 2000);

window.addEventListener('predictionmarketsready', () => {
    if (_pmReadyDebounceTimer) return; // Prevent clearing the timer so it actually fires

    // Throttle UI redraws to at most once every 5 seconds to prevent "frozen/unclickable" UI
    // caused by Kalshi WebSocket ticks constantly wiping the DOM.
    const now = Date.now();
    const timeSinceLast = now - (_lastPmReadyRefresh || 0);
    const waitTime = timeSinceLast >= 5000 ? 0 : 5000 - timeSinceLast;

    _pmReadyDebounceTimer = setTimeout(() => {
      _pmReadyDebounceTimer = null;
      _lastPmReadyRefresh = Date.now();

      if (currentView === 'markets5m') renderMarkets5M();
      // Re-render prediction cards when Kalshi data arrives - ensures new contracts
      // appear immediately when the burst-retry fetches them instead of waiting
      // for the next PredictionEngine.runAll() cycle (up to 15s later).
      if (['predictions', 'cfm', 'universe'].includes(currentView) && predsLoaded && !predictionRunInFlight) {
        try {
          if (currentView === 'predictions') refreshActiveView();
          else refreshActiveView();
        } catch (err) { console.error('[Error caught]', err);  }
      }
      scheduleWebStatePublish('predictionmarkets', 100);
    }, waitTime);
  });

window.addEventListener('blockchain-scan-update', () => {
    if (currentView === 'onchain') refreshChainScanUI();
  });

window.addEventListener('cex-flow-update', () => {
    if (currentView === 'universe') {
      const cexEl = document.getElementById('universe-cex');
      if (cexEl && cexEl.style.display !== 'none') refreshCexFlow(_cexActiveSym, cexEl);
    }
  });

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
    } catch (err) { console.error('[Error caught]', err);  }
  }, 20000);

initOBHud();

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
  })();

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
          try { window._runAdaptiveLiveRetune?.('continuous-live-retune'); } catch (err) { console.error('[Error caught]', err); }
        }, 5000);

        // Outcome/indicator retune checks run on the tuner cadence instead of waiting 15m.
        setInterval(() => {
          try {
            const trigger = window._adaptiveTuner.shouldRetune?.();
            if (!trigger?.shouldRetune) return;
            const runCycle = async () => {
              try {
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
            };
            if (typeof requestIdleCallback === 'function') {
              requestIdleCallback(() => { void runCycle(); }, { timeout: 8000 });
            } else {
              setTimeout(() => { void runCycle(); }, 50);
            }
          } catch (err) {
            console.warn('[AdaptiveTuner] retune scheduling failed:', err.message);
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

})();

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

window._exportContractLog = async function() {
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
      } catch (err) { console.error('[Error caught]', err); }
    }
    alert(`Exported ${log.length} contracts to ${written}/${paths.length} paths`);
  };

if (window.electron && window.electron.telegram) {
    window.electron.telegram.status().then(status => {
      _telegramStatus = status;
      if (currentView === 'observability') renderObservability();
    }).catch(err => {
      console.error('[Telegram] Failed to check status:', err);
    });

    window.electron.telegram.onAuthRequest((data) => {
      console.log('[Telegram] Auth request received:', data);
      _telegramAuthRequest = data;
      if (currentView === 'observability') renderObservability();
    });

    window.electron.telegram.onMessage((msg) => {
      console.log('[Telegram] Live message received:', msg);
      _telegramFeeds.unshift(msg);
      if (_telegramFeeds.length > 30) _telegramFeeds.pop();
      if (currentView === 'observability') {
        const feedEl = document.getElementById('tg-signals-feed');
        if (feedEl) feedEl.innerHTML = renderTelegramFeedsHtml();
      }
    });
  }

window.addEventListener('coingecko:markets', (e) => {
    const rows = e.detail;
    if (!Array.isArray(rows)) return;
    
    const targets = trackedMarketCoins().filter(c => c.geckoId);
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    
    const mapped = targets.map(c => {
      const row = byId[c.geckoId];
      if (!row) return null;
      
      const sym = GECKO_ID_TO_SYMBOL[row.id];
      if (sym && typeof screenerMetaCache !== 'undefined') {
        const orbital = window.ShellRouter?.getAtomicProfile?.(sym) || null;
        screenerMetaCache[sym] = {
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
      }
      
      return {
        instrument_name: c.instrument,
        last: String(row.current_price),
        bid: String(row.current_price),
        ask: String(row.current_price),
        change: String(row.price_change_percentage_24h),
        vol24h: String(row.total_volume || 0),
        baseVolume: String(row.total_volume || 0),
        quoteVolume: String(row.total_volume || 0),
        source: 'coingecko'
      };
    }).filter(Boolean);
    
    _lastGeckoSupplementalResult = mapped;
    _lastGeckoSupplementalTs = Date.now() + 60 * 60_000; // Block HTTP fetches for 1h since WS is live
    if (typeof screenerMetaAge !== 'undefined') screenerMetaAge = Date.now();
    
    if (window._appTickers) {
      let updated = false;
      mapped.forEach(t => { 
        if (!window._appTickers[t.instrument_name]) {
          window._appTickers[t.instrument_name] = t; 
          updated = true;
        }
      });
      if (updated && typeof render === 'function') render();
    }
  });

window.fetchAll = fetchAll;

window._fetchAllNow = () => fetchAll(true).then(() => {
    clearTimeout(_bootGuard);
    startAsyncRefreshEngine();
    if (!_asyncRefreshEngineBooted) resetTimer();
  });

(function prewarmCoinIcons() {
    const syms = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'DOGE', 'BNB'];
    const cgBase = 'https://assets.coingecko.com/coins/images';
    const cgIds = {
      BTC: '1/large/bitcoin.png', ETH: '279/large/ethereum.png', SOL: '4128/large/solana.png',
      XRP: '44/large/xrp-symbol-white-128.png', HYPE: '39198/large/hyperliquid.png',
      DOGE: '5/large/dogecoin.png', BNB: '825/large/bnb-icon2_2x.png',
    };
    syms.forEach(sym => {
      const img = new Image();
      img.src = `${cgBase}/${cgIds[sym]}`;
      img.onerror = () => {
        const fb = new Image();
        fb.src = `https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons/128/color/${sym.toLowerCase()}.png`;
      };
    });
  })();

render();

fetchAll().then(() => {
    clearTimeout(_bootGuard);
    startAsyncRefreshEngine();
    if (!_asyncRefreshEngineBooted) resetTimer();
    if (window.PredictionMarkets) window.PredictionMarkets.start();
    setTimeout(() => { if (window.BlockchainScan) window.BlockchainScan.start(); }, 1500);
    setTimeout(() => { if (window.CexFlow) window.CexFlow.start(); }, 3000);
  }).catch(err => {
    console.warn('[boot] initial fetchAll failed:', err.message);
    clearTimeout(_bootGuard);
    _fetchAttempted = true;
    render();
  });

