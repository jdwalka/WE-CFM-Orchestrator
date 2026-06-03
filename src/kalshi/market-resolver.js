// ================================================================
// WE|||CRYPTO — 15M Market Resolver v1
//
// Watches active Kalshi 15M market snapshots before expiry.
// After close_time passes, polls Kalshi for the settled result.
// Polymarket: resolved state detected via outcomePrices reaching 0/1.
//
// Writes:
//   window._15mResolutionLog — array of settled market outcomes
//   window._resolutionMap    — sym → latest resolution (quick lookup)
//
// Dispatches:
//   CustomEvent 'market15m:resolved' — { sym, outcome, modelCorrect, prob, pctMove }
//
// Used by:
//   signal-router-cfm.js → buildOutcomeCalibration()
//     Kalshi settlement data is 1.5× weighted vs candle log —
//     it is a clean external binary oracle, not intra-bar noise.
//
// Load order: after prediction-markets.js, before app.js
// ================================================================

(function () {
  'use strict';

  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const POLY_GAMMA = 'https://gamma-api.polymarket.com';
  const CB_BASE = 'https://api.exchange.coinbase.com';

  // Coinbase product IDs — used for post-settlement divergence diagnostics.
  const CB_PRODUCTS = {
    BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD',
    XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD',
  };

  const LOG_MAX = 300;   // max entries in _15mResolutionLog
  const SETTLE_GRACE = 120_000; // 2 min after close_time before we poll
  const POLL_INTERVAL = 60_000;  // poll for settlements every 60s
  const MAX_PENDING = 50;      // max pending snapshots queued at once
  const PERSIST_KEY = 'beta1_15m_resolution_log';
  const AUDIT_KEY = 'beta1_contract_audit';
  const AUDIT_MAX = 300;

  // ── State ────────────────────────────────────────────────────────
  // Pending: markets we've snapshotted and are waiting to settle
  const _pending = new Map();
  let _pollTimer = null;

  // Initialise global stores
  window._15mResolutionLog = window._15mResolutionLog || [];
  window._resolutionMap = window._resolutionMap || {};
  window._contractAuditLog = window._contractAuditLog || [];

  // Restore persisted logs
  try { const s = localStorage.getItem(PERSIST_KEY); if (s) window._15mResolutionLog = JSON.parse(s); } catch (_) { }
  try { const s = localStorage.getItem(AUDIT_KEY); if (s) window._contractAuditLog = JSON.parse(s); } catch (_) { }

  function saveLog() {
    try { localStorage.setItem(PERSIST_KEY, JSON.stringify(window._15mResolutionLog.slice(-LOG_MAX))); } catch (_) { }
  }
  function saveAudit() {
    try { localStorage.setItem(AUDIT_KEY, JSON.stringify(window._contractAuditLog.slice(-AUDIT_MAX))); } catch (_) { }
  }

  // Per-contract audit trail — every snapshot, poll, settle, and error is recorded.
  // Inspect via: KalshiDebug.audit(sym) or KalshiDebug.audit() for all entries.
  function addAudit(ticker, event, data) {
    window._contractAuditLog.push({ ticker, event, ts: Date.now(), tsIso: new Date().toISOString(), ...data });
    if (window._contractAuditLog.length > AUDIT_MAX) window._contractAuditLog.shift();
    saveAudit();
  }

  function getRtiDiagnostics(sym, closeTimeMs = null) {
    const r = window._rtiPrices?.[sym];
    if (!r) return null;
    const now = Date.now();
    return {
      price: r.price ?? null,
      openAvg: r.openAvg ?? null,
      closeAvg: r.closeAvg ?? null,
      delta: r.delta ?? null,
      deltaDir: r.deltaDir ?? null,
      stale: !!r.stale,
      sampleTs: r.ts ?? null,
      sampleAgeSec: Number.isFinite(r.ts) ? Math.round((now - r.ts) / 1000) : null,
      closeLagSec: Number.isFinite(closeTimeMs) && Number.isFinite(r.ts) ? Math.round((r.ts - closeTimeMs) / 1000) : null,
      meta: r.meta ?? null,
    };
  }

  // ── Fetch helpers ────────────────────────────────────────────────
  function fetchWithTimeout(url, ms = 7000) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => {
      try {
        ctrl.abort(new DOMException(`Market resolver timed out after ${ms}ms`, 'TimeoutError'));
      } catch (_) {
        try { ctrl.abort(); } catch (_) { }
      }
    }, ms);
    return fetch(url, { signal: ctrl.signal })
      .then(r => { clearTimeout(tid); return r; })
      .catch(e => { clearTimeout(tid); throw e; });
  }

  async function kalshiFetch(url) {
    const tickerMatch = url.match(/\/markets\/([^/?]+)/);
    const ticker = tickerMatch ? decodeURIComponent(tickerMatch[1]) : null;
    if (ticker && window.EndpointTransport?.fetchKalshiMarket) {
      const hit = await window.EndpointTransport.fetchKalshiMarket(ticker, {
        endpoint: 'kalshi-settlement',
        cacheType: 'settlement',
      });
      if (hit?.data) return hit.data;
    }
    try {
      const r = await fetchWithTimeout(url);
      if (!r.ok) return null;
      return r.json();
    } catch { return null; }
  }

  // ── Coinbase settlement price ────────────────────────────────────
  // Fetches the 1-min candle that covers the Kalshi close_time.
  // CF Benchmarks = 60-second avg at T+15 → we want the close of the
  // candle whose open is at closeTimeMs-60s.
  async function fetchCoinbaseSettlement(sym, closeTimeMs) {
    const product = CB_PRODUCTS[sym];
    if (!product) return null;
    // Fetch a 2-candle window centred on close_time
    const endSec = Math.ceil(closeTimeMs / 1000) + 5;
    const startSec = endSec - 180;
    try {
      const url = `${CB_BASE}/products/${product}/candles?start=${startSec}&end=${endSec}&granularity=60`;
      const r = await fetchWithTimeout(url, 20000);
      if (!r.ok) return null;
      const candles = await r.json();
      if (!Array.isArray(candles) || !candles.length) return null;
      // candles: [[time, low, high, open, close, volume], ...] descending
      // Find candle whose close_time (time+60s) is at or just after closeTimeMs
      const target = candles
        .map(c => ({ timeMs: c[0] * 1000, close: parseFloat(c[4]) }))
        .filter(c => c.timeMs <= closeTimeMs + 5_000)
        .sort((a, b) => b.timeMs - a.timeMs)[0];
      return target ? target.close : null;
    } catch { return null; }
  }

  // ── 1. SNAPSHOT CAPTURE ─────────────────────────────────────────
  // Called on 'predictionmarketsready'. Captures active 15M markets
  // as pending resolutions — we need to know what was predicted NOW
  // so we can evaluate correctness when the market settles.

  function captureSnapshot(pmData) {
    const now = Date.now();

    for (const [sym, coin] of Object.entries(pmData || {})) {
      const k15 = coin?.kalshi15m;
      if (!k15?.ticker || !k15?.closeTime) continue;

      const closeMs = new Date(k15.closeTime).getTime();
      // Skip markets already closed or closing within 90s (too late to track)
      if (closeMs < now + 90_000) continue;
      // Skip if already in pending
      if (_pending.has(k15.ticker)) continue;
      // Trim if too many pending
      if (_pending.size >= MAX_PENDING) {
        const oldest = [..._pending.entries()]
          .sort((a, b) => a[1].snapshotTs - b[1].snapshotTs)[0];
        if (oldest) _pending.delete(oldest[0]);
      }

      // Capture what the model currently predicts for this coin
      const pred = window._lastPrediction?.[sym];
      const intent = window.KalshiOrchestrator?.getIntent?.(sym) || null;
      const modelDir = pred?.direction ?? null;
      const entryProb = k15.probability ?? null;

      _pending.set(k15.ticker, {
        sym,
        ticker: k15.ticker,
        type: '15m',
        snapshotTs: now,
        closeTimeMs: closeMs,
        entryProb,
        modelDir,
        title: k15.title ?? null,
        subtitle: k15.subtitle ?? null,
        // Structured contract fields — from Kalshi API directly, not text-parsed
        targetPrice: k15.targetPriceNum ?? null,   // resolved ref (floorPrice preferred)
        floorPrice: k15.floorPrice ?? null,   // direct numeric API field
        capPrice: k15.capPrice ?? null,
        strikeDir: k15.strikeDir ?? 'above', // 'above'|'below' — YES direction
        strikeType: k15.strikeType ?? null,    // raw API strike_type
        edgeCents: intent?.edgeCents ?? null,
        entryPrice: intent?.entryPrice ?? null,
        side: intent?.side ?? null,
        modelProbUp: intent?.modelProbUp ?? null,
        orchestratorAction: intent?.action ?? null,
        orchestratorAlign: intent?.alignment ?? null,
        // Close-snapshot and orchestrator enrichment
        closeSnapshots: [],
        modelScore: window._lastPrediction?.[sym]?.score ?? null,
        sweetSpot: intent?.sweetSpot ?? false,
        confidence: intent?.confidence ?? null,
        crowdFade: intent?.crowdFade ?? false,
        crowdFadeDir: intent?.direction ?? null,
        timingRegime: intent?.timingRegime ?? null,
        timingLabel: intent?.timingLabel ?? null,
        timingScore: intent?.timingScore ?? null,
        timingReasons: intent?.timingReasons ?? [],
        timingBlocks: intent?.timingBlocks ?? [],
        timingAdaptive: intent?.timingAdaptive ?? null,
        closeValue: intent?.closeValue ?? false,
        closeValueCandidate: intent?.closeValueCandidate ?? false,
        scalpFlip: intent?.scalpFlip ?? false,
        scalpCandidate: intent?.scalpCandidate ?? false,
        missedOpportunityScore: intent?.missedOpportunityScore ?? 0,
        microFlowScore: intent?.microFlowScore ?? null,
        scalpSetupScore: intent?.scalpSetupScore ?? null,
        microToxicity: intent?.microToxicity ?? null,
        exitPlan: intent?.exitPlan ?? null,
      });

      const secsToClose = Math.round((closeMs - now) / 1000);
      addAudit(k15.ticker, 'captured', {
        sym, closeTime: k15.closeTime, secsToClose, entryProb, modelDir,
        floorPrice: k15.floorPrice, strikeDir: k15.strikeDir, strikeType: k15.strikeType,
        targetPrice: k15.targetPriceNum, title: k15.title,
      });
      console.log(
        `[Resolver] 📸 captured ${sym} ${k15.ticker} | ` +
        `closes in ${Math.floor(secsToClose / 60)}m${secsToClose % 60}s | ` +
        `ref=$${k15.targetPriceNum} (floor_price=${k15.floorPrice}) ` +
        `strike=${k15.strikeDir ?? 'above'} prob=${entryProb != null ? (entryProb * 100).toFixed(0) + '%' : 'n/a'} model=${modelDir}`
      );
    }
  }

  // ── Wick detection — did the crowd predict correctly at T-60s but result flipped? ──
  function detectWick(entry, actualOutcome) {
    const snaps = entry.closeSnapshots || [];
    const snap = snaps
      .filter(s => s.secsLeft >= 30 && s.secsLeft <= 90)
      .sort((a, b) => Math.abs(a.secsLeft - 60) - Math.abs(b.secsLeft - 60))[0];
    if (!snap || snap.kalshiProb == null || !actualOutcome) return false;
    const yesDir = entry.strikeDir === 'below' ? 'DOWN' : 'UP';
    const noDir = yesDir === 'UP' ? 'DOWN' : 'UP';
    const kalshiDir = snap.kalshiProb >= 0.5 ? yesDir : noDir;
    return kalshiDir !== actualOutcome && Math.abs(snap.kalshiProb - 0.5) >= 0.10;
  }

  // ── Close-time snapshots — called from app.js 100ms tick ────────────────────
  // Records Kalshi probability at key time thresholds before contract closes.
  function addCloseSnapshot(sym, secsLeft, kalshiProb, modelScore) {
    for (const entry of _pending.values()) {
      if (entry.sym === sym) {
        if (!entry.closeSnapshots) entry.closeSnapshots = [];
        const already = entry.closeSnapshots.some(s => Math.abs(s.secsLeft - secsLeft) < 15);
        if (!already) {
          entry.closeSnapshots.push({ secsLeft, kalshiProb, modelScore, ts: Date.now() });
        }
        break;
      }
    }
  }

  // ── 2. RESOLUTION POLLER ─────────────────────────────────────────
  // Checks pending markets. For those past close_time + grace, fetches
  // the Kalshi market to check settlement.

  async function checkPending() {
    const now = Date.now();
    const expired = [..._pending.values()]
      .filter(e => now >= e.closeTimeMs + SETTLE_GRACE);

    for (const entry of expired) {
      const secsPast = Math.round((now - entry.closeTimeMs) / 1000);
      console.log(`[Resolver] ⏳ polling ${entry.sym} ${entry.ticker} (${secsPast}s past close)`);
      addAudit(entry.ticker, 'poll_attempt', {
        sym: entry.sym,
        secsPast,
        closeTimeMs: entry.closeTimeMs,
        rti: getRtiDiagnostics(entry.sym, entry.closeTimeMs),
      });

      const settled = await resolveKalshiMarket(entry);
      if (settled) {
        _pending.delete(entry.ticker);
        recordResolution(settled);
      } else {
        if (now - entry.closeTimeMs > 10 * 60_000) {
          console.warn(`[Resolver] ⚠️ ${entry.sym} ${entry.ticker} timed out 10m+ — dropping`);
          addAudit(entry.ticker, 'dropped', { sym: entry.sym, reason: 'timeout_10min' });
          _pending.delete(entry.ticker);
        } else {
          console.log(`[Resolver] 🔄 ${entry.sym} ${entry.ticker} not settled yet — retry next cycle`);
        }
      }
    }
  }

  // ── 3. KALSHI SETTLEMENT FETCH ───────────────────────────────────
  // Returns a resolution record or null if not yet settled.
  // Routes through ProxyOrchestrator for:
  //   - Rate limiting with fallback to Polymarket if Kalshi 429s
  //   - Deduplication of identical settlement queries
  //   - 3 automatic retries with exponential backoff before giving up

  async function resolveKalshiMarket(entry) {
    const url = `${KALSHI_BASE}/markets/${entry.ticker}`;
    const retryDelays = [2000, 4000, 20000];
    let d = null;
    let viaTransport = null;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (window.EndpointTransport?.fetchKalshiMarket) {
        const hit = await window.EndpointTransport.fetchKalshiMarket(entry.ticker, {
          endpoint: 'kalshi-settlement',
          cacheType: 'settlement',
        });
        if (hit?.data) {
          d = hit.data;
          viaTransport = hit.transport || 'rpc/http';
          break;
        }
      } else {
        d = await kalshiFetch(url);
        if (d) {
          viaTransport = 'http';
          break;
        }
      }

      if (attempt < retryDelays.length) {
        const delay = retryDelays[attempt];
        console.warn(`[Resolver] ⚠️ Retry ${attempt + 1} for ${entry.sym} ${entry.ticker} — ${delay}ms`);
        addAudit(entry.ticker, 'fetch_retry', { sym: entry.sym, attempt: attempt + 1, nextDelayMs: delay });
        await new Promise(r => setTimeout(r, delay));
      }
    }

    if (!d) {
      console.error(`[Resolver] ❌ ${entry.sym} ${entry.ticker} — settlement fetch failed after retries`);
      addAudit(entry.ticker, 'fetch_failed_all_retries', {
        sym: entry.sym,
        url,
        attempts: retryDelays.length + 1,
      });
      try {
        window.NetworkHealth?.update?.('Kalshi', {
          status: 'down',
          lastFetch: Date.now(),
          fallback: false,
          reason: 'settlement fetch failed',
        });
      } catch (_) { }
      return null;
    }

    if (viaTransport) {
      addAudit(entry.ticker, 'transport_fetch_success', { sym: entry.sym, transport: viaTransport });
    }

    return await processKalshiSettlement(d, entry);
  }

  // ── Helper: Process Kalshi settlement response ───────────────────
  async function processKalshiSettlement(d, entry) {
    const m = d?.market;
    if (!m) {
      console.error(`[Resolver] ❌ ${entry.sym} ${entry.ticker} — no 'market' key in response`, Object.keys(d));
      addAudit(entry.ticker, 'no_market_key', { sym: entry.sym, responseKeys: Object.keys(d) });
      return null;
    }
    const statusNorm = String(m.status || '').toLowerCase();
    if (statusNorm !== 'settled' && statusNorm !== 'finalized') {
      console.log(`[Resolver] ⏳ ${entry.sym} ${entry.ticker} status='${m.status}' result='${m.result}' — not settled yet`);
      addAudit(entry.ticker, 'awaiting_settlement', {
        sym: entry.sym,
        status: m.status,
        result: m.result ?? null,
        closeTimeMs: entry.closeTimeMs,
        nowMs: Date.now(),
        secsPastClose: Math.round((Date.now() - entry.closeTimeMs) / 1000),
        rti: getRtiDiagnostics(entry.sym, entry.closeTimeMs),
      });
      return null;
    }
    if (!m.result) {
      console.warn(`[Resolver] ⚠️ ${entry.sym} ${entry.ticker} settled but result is empty — status=${m.status}`);
      addAudit(entry.ticker, 'empty_result', { sym: entry.sym, status: m.status });
      return null;
    }

    // ── Authoritative contract details from Kalshi API─────────────────────
    // Use the actual structured fields — floor_price, strike_type, result.
    // strikeDir determines which side of floor_price makes YES win:
    //   'above' (default for KXBTC15M): YES = close >= floor_price → UP
    //   'below':                        YES = close <  floor_price → DOWN
    const apiFloorPriceRaw = m.floor_price != null ? parseFloat(m.floor_price) : null;
    const apiFloorStrike = m.floor_strike != null ? parseFloat(m.floor_strike) : null;
    const apiCapPriceRaw = m.cap_price != null ? parseFloat(m.cap_price) : null;
    const apiCapStrike = m.cap_strike != null ? parseFloat(m.cap_strike) : null;
    const apiFloorPrice = (Number.isFinite(apiFloorStrike) && apiFloorStrike > 0)
      ? apiFloorStrike
      : (Number.isFinite(apiFloorPriceRaw) && apiFloorPriceRaw > 0 ? apiFloorPriceRaw : null);
    const apiCapPrice = (Number.isFinite(apiCapStrike) && apiCapStrike > 0)
      ? apiCapStrike
      : (Number.isFinite(apiCapPriceRaw) && apiCapPriceRaw > 0 ? apiCapPriceRaw : null);
    // Normalize strike_type — handle all Kalshi variants
    const apiStrikeType = m.strike_type ? String(m.strike_type).toLowerCase() : null;
    const apiStrikeDir = (() => {
      if (apiStrikeType === 'below' || apiStrikeType === 'under') return 'below';
      if (apiStrikeType === 'above' || apiStrikeType === 'over' || apiStrikeType === 'at_least' || apiStrikeType === 'greater_or_equal') return 'above';
      return entry.strikeDir ?? 'above'; // fall back to snapshot value
    })();

    // Resolved reference price: API floor_price takes priority over snapshot's targetPrice
    const refPrice = (Number.isFinite(apiFloorPrice) && apiFloorPrice > 0)
      ? apiFloorPrice
      : entry.targetPrice ?? null;

    // Confidence: 92 when we have structured floor_price; 65 when falling back to snapshot ref
    const confidence = (Number.isFinite(apiFloorPrice) && apiFloorPrice > 0) ? 92 : 65;

    // Map Kalshi result → UP/DOWN using the contract's actual strike direction
    // YES on an 'above' contract = price rose above ref = UP
    // YES on a 'below' contract = price stayed below ref = DOWN
    const resultNorm = String(m.result || '').toLowerCase();
    const yesResult = resultNorm === 'yes';
    const actualOutcome = yesResult
      ? (apiStrikeDir === 'below' ? 'DOWN' : 'UP')
      : (apiStrikeDir === 'below' ? 'UP' : 'DOWN');

    // Market direction: prob >= 50% says market thinks YES will win
    // Translate to UP/DOWN via same strikeDir logic
    const entryProb = entry.entryProb ?? 0.5;
    const yesWins = entryProb >= 0.50;
    const marketDir = yesWins
      ? (apiStrikeDir === 'below' ? 'DOWN' : 'UP')
      : (apiStrikeDir === 'below' ? 'UP' : 'DOWN');

    const modelDir = entry.modelDir;
    const modelCorrect = modelDir && modelDir !== 'FLAT' ? modelDir === actualOutcome : null;
    const marketCorrect = marketDir === actualOutcome;

    // Full contract audit — raw Kalshi API fields + derived values
    const rtiDiagnostics = getRtiDiagnostics(entry.sym, entry.closeTimeMs);
    addAudit(entry.ticker, 'contract_settled', {
      sym: entry.sym,
      // Raw Kalshi API fields
      result: m.result,
      status: m.status,
      floor_price: m.floor_price,
      cap_price: m.cap_price,
      strike_type: m.strike_type,
      close_time: m.close_time,
      title: m.title,
      yes_sub_title: m.yes_sub_title,
      // Derived
      apiStrikeDir,
      confidence,
      refPrice,
      actualOutcome,
      marketDir,
      modelDir,
      modelCorrect,
      marketCorrect,
      entryProb,
      // Proxy cross-check — what did the bucket-close proxy call?
      proxyOutcome: entry.proxyOutcome ?? null,
      proxyMismatch: entry.proxyOutcome ? entry.proxyOutcome !== actualOutcome : null,
      rtiDiagnostics,
    });

    console.log(
      `[Resolver] ✅ ${entry.sym} ${entry.ticker} | result=${m.result} → ${actualOutcome} | ` +
      `floor_price=${m.floor_price ?? 'null'} strike=${apiStrikeDir} conf=${confidence} | ` +
      `snapshot_ref=${entry.targetPrice} | model=${modelDir} ${modelCorrect ? '✓' : modelCorrect === false ? '✗' : '?'} | ` +
      `mktProb=${(entryProb * 100).toFixed(0)}% mktOk=${marketCorrect}`
    );

    const cbSettlePrice = await fetchCoinbaseSettlement(entry.sym, entry.closeTimeMs);
    if (cbSettlePrice != null && refPrice != null) {
      const cbSide = cbSettlePrice >= refPrice ? 'UP' : 'DOWN';
      if (cbSide !== actualOutcome) {
        console.warn(
          `[Resolver] ⚠️ CB price diverges from Kalshi result for ${entry.sym}: ` +
          `CB=${cbSettlePrice} vs ref=${refPrice} → ${cbSide} but Kalshi=${actualOutcome} (wick/TWAP spread)`
        );
        addAudit(entry.ticker, 'cb_divergence', {
          sym: entry.sym, cbSettlePrice, refPrice, cbSide, kalshiResult: actualOutcome,
        });
      }
    }

    // ── PYTH Backup Verification ─────────────────────────────────────────
    // Check if PYTH price exists for this coin
    const pythData = window._pythPrices ? window._pythPrices[entry.sym] : null;
    if (pythData && refPrice != null) {
      const pythPrice = pythData.price;
      const divergence = Math.abs((pythPrice - refPrice) / refPrice);
      const pythSide = pythPrice >= refPrice ? 'UP' : 'DOWN';

      if (divergence > 0.005) { // 0.5% threshold
        console.warn(
          `[Resolver] ⚠️ PRICE_DIVERGENCE: ${entry.sym} ${entry.ticker} | ` +
          `PYTH=${pythPrice} vs Kalshi=${refPrice} (${(divergence * 100).toFixed(2)}% diff) → PYTH=${pythSide} vs Kalshi=${actualOutcome}`
        );
        addAudit(entry.ticker, 'pyth_divergence', {
          sym: entry.sym,
          pythPrice,
          kalshiRefPrice: refPrice,
          divergencePct: divergence * 100,
          pythSide,
          kalshiResult: actualOutcome,
          mismatch: pythSide !== actualOutcome,
        });
      } else {
        addAudit(entry.ticker, 'pyth_verified', {
          sym: entry.sym,
          pythPrice,
          kalshiRefPrice: refPrice,
          divergencePct: divergence * 100,
          pythSide,
          kalshiResult: actualOutcome,
          match: pythSide === actualOutcome,
        });
      }
    }

    return {
      sym: entry.sym,
      ticker: entry.ticker,
      type: '15m',
      snapshotTs: entry.snapshotTs,
      closeTimeMs: entry.closeTimeMs,
      settledTs: Date.now(),
      settleLatencyMs: Math.max(0, Date.now() - entry.closeTimeMs),
      settleLatencySec: Math.max(0, Math.round((Date.now() - entry.closeTimeMs) / 1000)),
      entryProb,
      marketDir,
      actualOutcome,
      kalshiResult: m.result,          // raw 'yes'/'no' from Kalshi API
      refPrice,                         // authoritative ref from floor_price
      floorPrice: apiFloorPrice,
      capPrice: apiCapPrice,
      strikeDir: apiStrikeDir,
      strikeType: apiStrikeType,
      confidence,                       // 92 = structured floor_price, 65 = fallback
      cbSettlePrice,
      rtiAtResolve: rtiDiagnostics,
      proxyOutcome: entry.proxyOutcome ?? null,  // what bucket-close proxy called
      modelDir: modelDir ?? null,
      modelCorrect,
      marketCorrect,
      correct: modelCorrect,
      edgeCents: entry.edgeCents ?? null,
      entryPrice: entry.entryPrice ?? null,
      side: entry.side ?? null,
      modelProbUp: entry.modelProbUp ?? null,
      orchestratorAction: entry.orchestratorAction ?? null,
      orchestratorAlign: entry.orchestratorAlign ?? null,
      timingRegime: entry.timingRegime ?? null,
      timingLabel: entry.timingLabel ?? null,
      timingScore: entry.timingScore ?? null,
      timingReasons: entry.timingReasons ?? [],
      timingBlocks: entry.timingBlocks ?? [],
      timingAdaptive: entry.timingAdaptive ?? null,
      closeValue: entry.closeValue ?? false,
      closeValueCandidate: entry.closeValueCandidate ?? false,
      scalpFlip: entry.scalpFlip ?? false,
      scalpCandidate: entry.scalpCandidate ?? false,
      missedOpportunityScore: entry.missedOpportunityScore ?? 0,
      microFlowScore: entry.microFlowScore ?? null,
      scalpSetupScore: entry.scalpSetupScore ?? null,
      microToxicity: entry.microToxicity ?? null,
      exitPlan: entry.exitPlan ?? null,
      missedOpportunity: (
        modelCorrect === true &&
        (entry.orchestratorAction === 'skip' || entry.orchestratorAction === 'watch')
      ) ? {
        action: entry.orchestratorAction,
        alignment: entry.orchestratorAlign ?? null,
        edgeCents: entry.edgeCents ?? null,
        timingRegime: entry.timingRegime ?? null,
        timingScore: entry.timingScore ?? null,
        closeValueCandidate: entry.closeValueCandidate ?? false,
        scalpCandidate: entry.scalpCandidate ?? false,
      } : null,
      // Enhanced contract analysis fields
      closeSnapshots: entry.closeSnapshots ?? [],
      modelScore: entry.modelScore ?? null,
      sweetSpot: entry.sweetSpot ?? false,
      crowdFade: entry.crowdFade ?? false,
      crowdFadeDir: entry.crowdFadeDir ?? null,
      wickedOut: detectWick(entry, actualOutcome),
      lateEntry: entry.closeSnapshots?.some(s => s.secsLeft < 60) ?? false,
      entrySecsLeft: Math.round((entry.closeTimeMs - entry.snapshotTs) / 1000),
    };
  }

  // ── 4. RECORD + DISPATCH ─────────────────────────────────────────

  function recordResolution(res) {
    window._15mResolutionLog.push(res);
    if (window._15mResolutionLog.length > LOG_MAX) {
      window._15mResolutionLog.shift();
    }
    // Quick lookup by coin
    window._resolutionMap[res.sym] = res;
    saveLog();

    // Log to DataLogger (writes to local + Z:\ + W:\ Drive paths + localStorage cache)
    if (window.DataLogger?.logResolverOutcome) {
      window.DataLogger.logResolverOutcome(res.sym, res);
    }

    // Notify the app (UI can show toast, update accuracy badge)
    try {
      window.dispatchEvent(new CustomEvent('market15m:resolved', {
        detail: {
          sym: res.sym,
          outcome: res.actualOutcome,   // 'UP' | 'DOWN'
          kalshiResult: res.kalshiResult,    // raw 'yes' | 'no' from Kalshi API
          proxyMismatch: res.proxyMismatch ?? null,
          settlementAuthority: 'kalshi_api',
          canonical: true,
          schemaVersion: 'resolver.v1',
          modelCorrect: res.modelCorrect,
          marketCorrect: res.marketCorrect,
          prob: res.entryProb,
          ticker: res.ticker,
          refPrice: res.refPrice,        // authoritative floor_price
          floorPrice: res.floorPrice,
          strikeDir: res.strikeDir,
          cbSettlePrice: res.cbSettlePrice,
          rtiAtResolve: res.rtiAtResolve,
          settleLatencyMs: res.settleLatencyMs,
          settleLatencySec: res.settleLatencySec,
        },
      }));
    } catch (_) { }

    const icon = res.modelCorrect === true ? '\u2705'
      : res.modelCorrect === false ? '\u274c'
        : '\u2753';
    console.log(
      `[Resolver] ${res.sym} 15M settled result=${res.kalshiResult} → ${res.actualOutcome} ${icon} ` +
      `| model=${res.modelDir ?? 'N/A'} | ref=$${res.refPrice} floor_price=${res.floorPrice} ` +
      `| mktProb:${(res.entryProb * 100).toFixed(0)}% mktOk:${res.marketCorrect} ` +
      `| cbSettle=${res.cbSettlePrice}`
    );
  }

  // ── 5. ACCURACY SUMMARY ──────────────────────────────────────────
  // Returns a per-coin summary from the resolution log.
  // Used by signal-router-cfm.js and optionally the UI.

  function getResolutionAccuracy(sym, n = 30) {
    const log = (window._15mResolutionLog || [])
      .filter(e => e.sym === sym && e.modelCorrect !== null);
    const recent = log.slice(-n);
    if (recent.length < 2) return null;

    const correct = recent.filter(e => e.modelCorrect).length;
    const accuracy = correct / recent.length;

    // Trend: last 8 vs prior 8
    const last8 = recent.slice(-8);
    const prior8 = recent.slice(-16, -8);
    const l8acc = last8.length ? last8.filter(e => e.modelCorrect).length / last8.length : accuracy;
    const p8acc = prior8.length ? prior8.filter(e => e.modelCorrect).length / prior8.length : accuracy;

    // Streak
    let streak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const ok = recent[i].modelCorrect;
      if (streak === 0) { streak = ok ? 1 : -1; continue; }
      if ((streak > 0) === ok) streak += ok ? 1 : -1;
      else break;
    }

    return {
      accuracy,
      correct,
      total: recent.length,
      streak,
      trend: (l8acc - p8acc) > 0.10 ? 'improving' : (l8acc - p8acc) < -0.10 ? 'declining' : 'stable',
      // Calibration multiplier for CFM: market-settled data is clean
      // accuracy 35% → 0.78x  |  50% → 1.0x  |  70% → 1.18x
      calibMultiplier: Math.max(0.76, Math.min(1.22, 0.76 + accuracy * 0.92)),
    };
  }

  // ── 6. START ─────────────────────────────────────────────────────

  function start() {
    // Listen for new market data — capture snapshots
    window.addEventListener('predictionmarketsready', e => {
      captureSnapshot(e.detail || {});
    });

    // Poll every 60s for settlements
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
      if (!document.hidden) checkPending();
    }, POLL_INTERVAL);

    // Also do an immediate pass in case of app restart with stale pending
    setTimeout(checkPending, 5000);

    console.log('[Resolver] 15M market resolver started');
  }

  // ── PUBLIC API ───────────────────────────────────────────────────
  window.MarketResolver = {
    start,
    getPending: () => [..._pending.values()],
    getLog: () => window._15mResolutionLog,
    getResolutionAccuracy,
    getLatest: sym => window._resolutionMap[sym] ?? null,
    addCloseSnapshot,
    buildCalibration(sym, n = 30) { return getResolutionAccuracy(sym, n); },
    getMissedOpps(n = 50) {
      return (window._15mResolutionLog || []).filter(e => e.missedOpportunity != null).slice(-n);
    },
    getBufferZones(n = 100) {
      const log = (window._15mResolutionLog || [])
        .filter(e => e.edgeCents != null && e.modelCorrect !== null).slice(-n);
      const buckets = [
        { label: 'Neg edge', min: -Infinity, max: 0 },
        { label: '0–5¢', min: 0, max: 5 },
        { label: '5–10¢', min: 5, max: 10 },
        { label: '10–20¢', min: 10, max: 20 },
        { label: '20–30¢', min: 20, max: 30 },
        { label: '30¢+', min: 30, max: Infinity },
      ];
      return buckets.map(b => {
        const entries = log.filter(e => e.edgeCents >= b.min && e.edgeCents < b.max);
        const wins = entries.filter(e => e.modelCorrect);
        return {
          label: b.label, trades: entries.length, wins: wins.length,
          winRate: entries.length ? +(wins.length / entries.length * 100).toFixed(1) : null,
          avgEdge: entries.length ? +(entries.reduce((s, e) => s + e.edgeCents, 0) / entries.length).toFixed(1) : null,
        };
      });
    },
  };

  // ── DEBUG API ─────────────────────────────────────────────────────
  // Available from the DevTools console:
  //   KalshiDebug.audit('ETH')     — step-by-step contract audit trail
  //   KalshiDebug.errors()         — proxy mismatches, wick, dir_conflict events
  //   KalshiDebug.pending()        — contracts currently waiting to settle
  //   KalshiDebug.last('ETH')      — latest authoritative resolution for ETH
  //   KalshiDebug.log('ETH')       — raw _kalshiLog entries for ETH
  //   KalshiDebug.snap('ETH')      — current snapshot for ETH
  //   KalshiDebug.contract('ETH')  — full state: snap + pending + resolved
  //   KalshiDebug.conflicts()      — all entries where model dir ≠ CDF direction
  //   KalshiDebug.summary()        — accuracy summary across all coins
  window.KalshiDebug = {
    audit(sym) {
      const log = window._contractAuditLog || [];
      const rows = sym ? log.filter(e => e.sym === sym || (e.ticker || '').includes(sym)) : log;
      console.table(rows.map(e => ({
        time: e.tsIso?.slice(11, 19), ticker: e.ticker, event: e.event,
        sym: e.sym, result: e.result, outcome: e.actualOutcome,
        floor_price: e.floor_price, strike: e.apiStrikeDir ?? e.strikeDir,
        confidence: e.confidence, modelDir: e.modelDir, modelOk: e.modelCorrect,
      })));
      return rows;
    },
    errors() {
      const errs = window._kalshiErrors || [];
      console.table(errs.map(e => ({
        time: e.tsIso?.slice(11, 19), type: e.type, sym: e.sym,
        ticker: e.ticker, proxy: e.proxy, auth: e.authoritative,
        ref: e.refPrice, close: e.proxyClosePrice, cbSettle: e.cbSettlePrice,
        gap: e.refDiffPct, wick: e.wickStraddle, nearRef: e.nearRef,
        dirConflict: e.dirConflict, momentumDir: e.momentumDir, cdfDir: e.cdfImpliedDir,
      })));
      return errs;
    },
    pending() {
      const p = [..._pending.values()];
      console.table(p.map(e => ({
        sym: e.sym, ticker: e.ticker,
        closesAt: new Date(e.closeTimeMs).toISOString().slice(11, 19),
        secsLeft: Math.round((e.closeTimeMs - Date.now()) / 1000),
        floorPrice: e.floorPrice, strikeDir: e.strikeDir,
        model: e.modelDir, prob: e.entryProb != null ? `${(e.entryProb * 100).toFixed(0)}%` : null,
      })));
      return p;
    },
    last(sym) {
      const r = window._resolutionMap?.[sym];
      if (!r) { console.log(`No resolution yet for ${sym}`); return null; }
      console.table([{
        sym: r.sym, ticker: r.ticker, result: r.kalshiResult,
        outcome: r.actualOutcome, strikeDir: r.strikeDir,
        floor_price: r.floorPrice, ref: r.refPrice, cbSettle: r.cbSettlePrice,
        model: r.modelDir, modelOk: r.modelCorrect, mktOk: r.marketCorrect,
        confidence: r.confidence, settledAt: new Date(r.settledTs).toISOString().slice(11, 19),
      }]);
      return r;
    },
    log(sym) {
      const entries = (window._kalshiLog || []).filter(e => !sym || e.sym === sym);
      console.table(entries.slice(-20).map(e => ({
        sym: e.sym, outcome: e.outcome, proxy: e.proxyOutcome, conf: e.proxyConfidence,
        ref: e.ref, close: e.closePrice, gap: e.refDiffPct,
        modelDir: e.modelDir, mYes: e.mYesPct, kYes: e.kYesPct,
        settled: e._settled, mismatch: e._proxyMismatch,
        wick: e._wickStraddle, nearRef: e._nearRef, conflict: e._dirConflict,
      })));
      return entries;
    },
    snap(sym) {
      const snaps = window._lastKalshiSnapshot || {};
      const s = sym ? snaps[sym] : snaps;
      console.log(sym ? `=== ${sym} snapshot ===` : '=== all snapshots ===', s);
      return s;
    },
    contract(sym) {
      const snap = window._lastKalshiSnapshot?.[sym];
      const pend = [..._pending.values()].find(e => e.sym === sym);
      const res = window._resolutionMap?.[sym];
      const errs = (window._kalshiErrors || []).filter(e => e.sym === sym).slice(-5);
      console.log(`\n=== ${sym} FULL CONTRACT STATE ===`);
      console.log('📸 snapshot:', snap ?? 'NONE');
      console.log('⏳ pending: ', pend ?? 'NONE');
      console.log('✅ resolved:', res ?? 'NONE');
      errs.length && console.log('❌ errors:  ', errs);
      return { snap, pend, res, errs };
    },
    conflicts() {
      const entries = (window._kalshiLog || []).filter(e => e._dirConflict || e.dirConflict);
      console.table(entries.map(e => ({
        sym: e.sym, modelDir: e.modelDir, cdfDir: e.cdfImpliedDir,
        mYes: e.mYesPct, outcome: e.outcome, settled: e._settled,
        kalshiAuth: e._kalshiResult, mismatch: e._proxyMismatch,
      })));
      return entries;
    },
    summary() {
      const coins = [...new Set((window._kalshiLog || []).map(e => e.sym))];
      const rows = coins.map(sym => {
        const entries = (window._kalshiLog || []).filter(e => e.sym === sym && e._settled);
        const correct = entries.filter(e => !e._proxyMismatch).length;
        const conflicts = entries.filter(e => e._dirConflict).length;
        const wicks = entries.filter(e => e._wickStraddle).length;
        return { sym, settled: entries.length, correct, accuracy: entries.length ? `${(correct / entries.length * 100).toFixed(0)}%` : '–', conflicts, wicks };
      });
      console.table(rows);
      return rows;
    },
    tune() {
      const log = window._15mResolutionLog || [];
      if (log.length === 0) { console.log('❌ No settlement data available'); return null; }

      const coins = [...new Set(log.map(e => e.sym))];
      const tuneReport = {};

      coins.forEach(sym => {
        const entries = log.filter(e => e.sym === sym);
        if (entries.length < 3) return; // skip coins with < 3 trades

        // Per-coin accuracy
        const correct = entries.filter(e => e.modelCorrect === true).length;
        const accuracy = (correct / entries.length * 100).toFixed(1);

        // Edge threshold analysis — bucket by edgeCents
        const edgeBuckets = [
          { min: 0, max: 5, label: '0-5¢' },
          { min: 5, max: 10, label: '5-10¢' },
          { min: 10, max: 20, label: '10-20¢' },
          { min: 20, max: 999, label: '20+¢' },
        ];

        const edgeAnalysis = edgeBuckets.map(bucket => {
          const inBucket = entries.filter(e => e.edgeCents != null && e.edgeCents >= bucket.min && e.edgeCents < bucket.max);
          const wins = inBucket.filter(e => e.modelCorrect === true).length;
          const rate = inBucket.length > 0 ? (wins / inBucket.length * 100).toFixed(1) : '—';
          return { ...bucket, trades: inBucket.length, wins, rate };
        });

        // Volatility impact
        const volBuckets = ['low', 'medium', 'high'];
        const volAnalysis = volBuckets.map(vol => {
          const inVol = entries.filter(e => (e.volatility?.toLowerCase() || 'medium') === vol);
          const wins = inVol.filter(e => e.modelCorrect === true).length;
          const rate = inVol.length > 0 ? (wins / inVol.length * 100).toFixed(1) : '—';
          return { volatility: vol, trades: inVol.length, wins, rate };
        });

        // Time bias — early vs late entries
        const early = entries.filter(e => (e.entrySecsLeft ?? 300) > 60);
        const late = entries.filter(e => (e.entrySecsLeft ?? 300) <= 60);
        const earlyRate = early.length > 0 ? (early.filter(e => e.modelCorrect).length / early.length * 100).toFixed(1) : '—';
        const lateRate = late.length > 0 ? (late.filter(e => e.modelCorrect).length / late.length * 100).toFixed(1) : '—';

        // Fade analysis — when model disagrees with crowd
        const fadeEntries = entries.filter(e => e.crowdFade === true);
        const fadeWins = fadeEntries.filter(e => e.modelCorrect === true).length;
        const fadeRate = fadeEntries.length > 0 ? (fadeWins / fadeEntries.length * 100).toFixed(1) : '—';

        tuneReport[sym] = {
          total: entries.length,
          accuracy: `${accuracy}%`,
          edgeAnalysis,
          volAnalysis,
          timeOfEntry: { early: `${earlyRate}% (${early.length})`, late: `${lateRate}% (${late.length})` },
          fadePerf: { trades: fadeEntries.length, rate: fadeRate, wins: fadeWins },
        };
      });

      console.log('\n╔══════════════════════════════════════════════════════╗');
      console.log('║            DEEP MODEL TUNING ANALYSIS                ║');
      console.log('║          (Last ' + log.length + ' settled markets)                ║');
      console.log('╚══════════════════════════════════════════════════════╝\n');

      coins.forEach(sym => {
        const t = tuneReport[sym];
        if (!t) return;
        console.log(`\n📊 ${sym.padEnd(6)} — ${t.total} trades, ${t.accuracy} accuracy`);
        console.log('  ├─ Edge Thresholds:');
        t.edgeAnalysis.forEach(e => {
          const indicator = e.rate !== '—' ? (parseFloat(e.rate) >= 55 ? '✅' : parseFloat(e.rate) >= 50 ? '⚠️ ' : '❌') : '—';
          console.log(`  │  ${indicator} ${e.label.padEnd(7)} → ${e.rate.padEnd(5)}% (${e.trades} trades)`);
        });
        console.log('  ├─ Volatility Impact:');
        t.volAnalysis.forEach(v => {
          const rate = v.rate !== '—' ? parseFloat(v.rate).toFixed(0) : '—';
          console.log(`  │  ${v.volatility.padEnd(8)} → ${rate.padEnd(3)}% (${v.trades} trades)`);
        });
        console.log(`  ├─ Entry Timing: Early=${t.timeOfEntry.early} | Late=${t.timeOfEntry.late}`);
        console.log(`  └─ Fade Performance: ${t.fadePerf.wins}/${t.fadePerf.trades} (${t.fadePerf.rate}% win rate)`);
      });

      console.log('\n💡 RECOMMENDATIONS:');
      Object.entries(tuneReport).forEach(([sym, t]) => {
        const lowEdge = t.edgeAnalysis.find(e => e.label === '0-5¢');
        const highEdge = t.edgeAnalysis.find(e => e.label === '20+¢');
        const lowRate = lowEdge?.rate !== '—' ? parseFloat(lowEdge.rate) : 50;
        const highRate = highEdge?.rate !== '—' ? parseFloat(highEdge.rate) : 50;

        if (lowRate < 50 && highRate > 55) {
          console.log(`  • ${sym}: RAISE minimum edge threshold (high-edge trades ~${highRate}% vs low ~${lowRate}%)`);
        }
        if (parseFloat(t.fadePerf.rate || 0) > 55 && t.fadePerf.trades > 2) {
          console.log(`  • ${sym}: Crowd-fade strategy working well (${t.fadePerf.rate}%) — consider scaling`);
        }
      });

      return tuneReport;
    },
  };

})();
