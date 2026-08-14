// ================================================================
// WE|||CRYPTO — Polymarket 5M/15M Market Resolver v2
//
// Watches active Polymarket Up/Down market snapshots (5m + 15m) before
// expiry. Settlements resolve via two paths (both write the same log):
//
//   1. PUSH (preferred): CLOB WS `market_resolved` → CustomEvent
//      `polymarket:market_resolved` (emitted by polymarket-ws.js). Match
//      pending by slug or conditionId and settle immediately.
//   2. POLL (fallback): After close + grace, Gamma API by slug for
//      outcomePrices (UMA-oracle-backed). Unchanged from v2 baseline.
//
// Idempotent by slug: each slug is recorded at most once (push vs poll
// race cannot double-write). 5m and 15m share _15mResolutionLog (name is
// historical; type field distinguishes horizons).
//
// Coinbase is used ONLY as a non-authoritative, informational sanity
// note in the audit trail -- never as a resolution input. Polymarket's
// crypto Up/Down markets resolve against a TWAP window (see Polymarket's
// Chainlink TWAP feeds), not a raw spot tick, so a Coinbase candle can
// legitimately disagree with the resolved outcome near a close boundary
// without either being "wrong". Treat any CB/Pyth note here as macro
// context, not a correctness check.
//
// Writes:
//   window._15mResolutionLog — array of settled market outcomes (5m + 15m)
//   window._resolutionMap    — sym → latest resolution (quick lookup)
//
// Dispatches:
//   CustomEvent 'market15m:resolved' — { sym, outcome, type, slug,
//     settlementAuthority, modelCorrect, ... }  (shape preserved for consumers)
//
// Used by:
//   signal-router-cfm.js → buildOutcomeCalibration()
//     Market-settled data is 1.5× weighted vs candle log —
//     it is a clean external binary oracle, not intra-bar noise.
//
// Companion (separate log, do not merge):
//   poly5m-resolution-tracker.js grades model calls via chainlink candles
//   into window._5mResolutionLog — candle-based, not Polymarket-oracle.
//
// Load order: after prediction-markets.js / polymarket-ws.js, before app.js
// ================================================================

(function () {
  'use strict';

  const POLY_GAMMA = 'https://gamma-api.polymarket.com';
  const CB_BASE = 'https://api.exchange.coinbase.com';

  // Coinbase product IDs — used for post-settlement context notes only.
  const CB_PRODUCTS = {
    BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD',
    XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD',
  };

  const LOG_MAX = 300;   // max entries in _15mResolutionLog
  const SETTLE_GRACE = 90_000;   // grace after close before first poll (UMA proposal can land within ~2min, but often takes longer)
  const POLL_INTERVAL = 60_000;  // poll for settlements every 60s
  const MAX_PENDING = 60;      // max pending snapshots queued at once (5m + 15m combined)
  const PERSIST_KEY = 'beta1_15m_resolution_log';
  const AUDIT_KEY = 'beta1_contract_audit';
  const AUDIT_MAX = 300;
  const RESOLVED_THRESHOLD = 0.98; // outcomePrice at/above this (or at/below 1-this) counts as resolved

  // ── State ────────────────────────────────────────────────────────
  // Pending: markets we've snapshotted and are waiting to settle. Keyed by slug.
  const _pending = new Map();
  // Slugs already written to _15mResolutionLog this session (push/poll dedupe).
  // Seeded from persisted log so restarts also stay idempotent.
  const _settledSlugs = new Set();
  let _pollTimer = null;
  let _pushInFlight = new Set(); // slugs currently being finalized via push

  // Initialise global stores
  window._15mResolutionLog = window._15mResolutionLog || [];
  window._resolutionMap = window._resolutionMap || {};
  window._contractAuditLog = window._contractAuditLog || [];

  // Restore persisted logs
  try { const s = localStorage.getItem(PERSIST_KEY); if (s) window._15mResolutionLog = JSON.parse(s); } catch (_) { }
  try { const s = localStorage.getItem(AUDIT_KEY); if (s) window._contractAuditLog = JSON.parse(s); } catch (_) { }

  // Seed slug dedupe set from restored log (5m + 15m)
  try {
    for (const e of window._15mResolutionLog || []) {
      if (e?.slug) _settledSlugs.add(e.slug);
    }
  } catch (_) { }

  function saveLog() {
    try { localStorage.setItem(PERSIST_KEY, JSON.stringify(window._15mResolutionLog.slice(-LOG_MAX))); } catch (_) { }
  }
  function saveAudit() {
    try { localStorage.setItem(AUDIT_KEY, JSON.stringify(window._contractAuditLog.slice(-AUDIT_MAX))); } catch (_) { }
  }

  // Per-contract audit trail — every snapshot, poll, settle, and error is recorded.
  // Inspect via: MarketDebug.audit(sym) or MarketDebug.audit() for all entries.
  function addAudit(slug, event, data) {
    window._contractAuditLog.push({ ticker: slug, slug, event, ts: Date.now(), tsIso: new Date().toISOString(), ...data });
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

  async function gammaFetchJson(url, ms = 8000) {
    try {
      const r = await fetchWithTimeout(url, ms);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // Fetch the Polymarket Gamma market object for an exact known slug. This
  // module stays self-contained (prediction-markets.js doesn't expose its
  // internal slug-fetch helpers on window.PredictionMarkets), so it mirrors
  // the same gamma markets?slug= / events?slug= fallback pattern locally.
  async function fetchPolymarketMarketBySlug(slug) {
    const byMarket = await gammaFetchJson(`${POLY_GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
    const marketsArr = Array.isArray(byMarket) ? byMarket : (Array.isArray(byMarket?.markets) ? byMarket.markets : []);
    const direct = marketsArr.find(m => (m?.slug || m?.market_slug) === slug);
    if (direct) return direct;

    const byEvent = await gammaFetchJson(`${POLY_GAMMA}/events?slug=${encodeURIComponent(slug)}`);
    const eventsArr = Array.isArray(byEvent) ? byEvent : (Array.isArray(byEvent?.events) ? byEvent.events : []);
    for (const ev of eventsArr) {
      const evMarkets = Array.isArray(ev?.markets) ? ev.markets : [];
      const hit = evMarkets.find(m => (m?.slug || m?.market_slug) === slug);
      if (hit) return hit;
    }
    return null;
  }

  // Parses a market's outcomes/outcomePrices (Gamma may return either as
  // JSON-encoded strings or native arrays) and locates the "Up" side.
  function _parseOutcomeArrays(m) {
    let outcomes = m?.outcomes;
    if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; } }
    let prices = m?.outcomePrices;
    if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = null; } }
    if (!Array.isArray(outcomes) || !Array.isArray(prices) || !outcomes.length || outcomes.length !== prices.length) return null;
    let upIndex = outcomes.findIndex(o => String(o || '').trim().toLowerCase() === 'up');
    if (upIndex < 0) upIndex = 0; // fall back to index 0 if the market doesn't literally label "Up"/"Down"
    return { outcomes, prices: prices.map(p => parseFloat(p)), upIndex };
  }

  // A Polymarket Up/Down market is resolved once trading has closed AND one
  // side's price has settled at (or extremely close to) 1. There is no
  // floor_price/strike_type to interpret here -- the resolved outcomePrices
  // ARE the answer, straight from Polymarket's UMA-oracle-backed resolution.
  function _resolveFromMarket(m) {
    const parsed = _parseOutcomeArrays(m);
    if (!parsed) return null;
    const { prices, upIndex } = parsed;
    const upPrice = prices[upIndex];
    if (!Number.isFinite(upPrice)) return null;
    const closed = m.closed === true || m.active === false;
    const settled = closed && (upPrice >= RESOLVED_THRESHOLD || upPrice <= (1 - RESOLVED_THRESHOLD));
    if (!settled) return null;
    return { actualOutcome: upPrice >= RESOLVED_THRESHOLD ? 'UP' : 'DOWN', upPrice };
  }

  // ── Coinbase context (never authoritative) ────────────────────────
  // Fetches the 1-min candle nearest the window close, purely as a macro/
  // micro sanity note in the audit trail -- see the file header for why
  // this can legitimately disagree with a TWAP-resolved outcome.
  async function fetchCoinbaseContext(sym, closeTimeMs) {
    const product = CB_PRODUCTS[sym];
    if (!product) return null;
    const endSec = Math.ceil(closeTimeMs / 1000) + 5;
    const startSec = endSec - 180;
    try {
      const url = `${CB_BASE}/products/${product}/candles?start=${startSec}&end=${endSec}&granularity=60`;
      const r = await fetchWithTimeout(url, 20000);
      if (!r.ok) return null;
      const candles = await r.json();
      if (!Array.isArray(candles) || !candles.length) return null;
      // candles: [[time, low, high, open, close, volume], ...] descending
      const target = candles
        .map(c => ({ timeMs: c[0] * 1000, close: parseFloat(c[4]) }))
        .filter(c => c.timeMs <= closeTimeMs + 5_000)
        .sort((a, b) => b.timeMs - a.timeMs)[0];
      return target ? target.close : null;
    } catch { return null; }
  }

  // ── 1. SNAPSHOT CAPTURE ─────────────────────────────────────────
  // Called on 'predictionmarketsready'. Captures active Polymarket 5m/15m
  // windows as pending resolutions — we need to know what was predicted NOW
  // so we can evaluate correctness when the market settles.

  function _captureWindow(sym, coin, poly, type) {
    if (!poly?.slug || !poly?.closeTime) return;
    const now = Date.now();
    const closeMs = new Date(poly.closeTime).getTime();
    if (!Number.isFinite(closeMs)) return;
    // Skip windows already closed or closing within 20% of their own length (too late to track)
    const minLeadMs = type === '5m' ? 60_000 : 90_000;
    if (closeMs < now + minLeadMs) return;
    if (_pending.has(poly.slug)) return;
    // Already settled this slug (session or restored log) — never re-queue
    if (_settledSlugs.has(poly.slug)) return;
    if (window._15mResolutionLog?.some(e => e.slug === poly.slug)) {
      _settledSlugs.add(poly.slug);
      return;
    }
    if (_pending.size >= MAX_PENDING) {
      const oldest = [..._pending.entries()].sort((a, b) => a[1].snapshotTs - b[1].snapshotTs)[0];
      if (oldest) _pending.delete(oldest[0]);
    }

    const pred = window._lastPrediction?.[sym];
    const intent = window.KalshiOrchestrator?.getIntent?.(sym) || null;
    const modelDir = pred?.direction ?? null;
    const entryProb = poly.probability ?? null;
    const conditionId = poly.clobConditionId || poly.conditionId || poly.condition_id || null;
    const tokenIds = Array.isArray(poly.clobTokenIds) ? poly.clobTokenIds.map(String) : [];

    _pending.set(poly.slug, {
      sym,
      slug: poly.slug,
      type,
      snapshotTs: now,
      closeTimeMs: closeMs,
      entryProb,
      modelDir,
      title: poly.title ?? null,
      priceToBeatNum: poly.priceToBeatNum ?? null,
      priceToBeatSource: poly.priceToBeatSource ?? null,
      conditionId,
      tokenIds,
      clobUpAssetId: poly.clobUpAssetId ? String(poly.clobUpAssetId) : (tokenIds[0] || null),
      clobDownAssetId: poly.clobDownAssetId ? String(poly.clobDownAssetId) : (tokenIds[1] || null),
      edgeCents: intent?.edgeCents ?? null,
      entryPrice: intent?.entryPrice ?? null,
      side: intent?.side ?? null,
      modelProbUp: intent?.modelProbUp ?? null,
      orchestratorAction: intent?.action ?? null,
      orchestratorAlign: intent?.alignment ?? null,
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

    // Ensure CLOB WS is subscribed so market_resolved can arrive for this window
    if (tokenIds.length && window.PolymarketWS?.subscribeAssets) {
      try { window.PolymarketWS.subscribeAssets(tokenIds); } catch (_) { }
    }

    const secsToClose = Math.round((closeMs - now) / 1000);
    addAudit(poly.slug, 'captured', {
      sym, type, closeTime: poly.closeTime, secsToClose, entryProb, modelDir,
      priceToBeatNum: poly.priceToBeatNum, title: poly.title, conditionId,
    });
    console.log(
      `[Resolver] 📸 captured ${sym} ${type} ${poly.slug} | ` +
      `closes in ${Math.floor(secsToClose / 60)}m${secsToClose % 60}s | ` +
      `PTB=$${poly.priceToBeatNum ?? 'pending'} prob=${entryProb != null ? (entryProb * 100).toFixed(0) + '%' : 'n/a'} model=${modelDir}`
    );
  }

  function captureSnapshot(pmData) {
    for (const [sym, coin] of Object.entries(pmData || {})) {
      if (coin?.poly15m) _captureWindow(sym, coin, coin.poly15m, '15m');
      if (coin?.poly5m) _captureWindow(sym, coin, coin.poly5m, '5m');
    }
  }

  // ── Wick detection — did the crowd predict correctly at T-60s but result flipped? ──
  function detectWick(entry, actualOutcome) {
    const snaps = entry.closeSnapshots || [];
    const snap = snaps
      .filter(s => s.secsLeft >= 30 && s.secsLeft <= 90)
      .sort((a, b) => Math.abs(a.secsLeft - 60) - Math.abs(b.secsLeft - 60))[0];
    if (!snap || snap.mktProb == null || !actualOutcome) return false;
    const mktDir = snap.mktProb >= 0.5 ? 'UP' : 'DOWN';
    return mktDir !== actualOutcome && Math.abs(snap.mktProb - 0.5) >= 0.10;
  }

  // ── Close-time snapshots — called from app.js tick ────────────────────
  // Records the market's Up probability at key time thresholds before close.
  function addCloseSnapshot(sym, secsLeft, mktProb, modelScore) {
    for (const entry of _pending.values()) {
      if (entry.sym === sym) {
        if (!entry.closeSnapshots) entry.closeSnapshots = [];
        const already = entry.closeSnapshots.some(s => Math.abs(s.secsLeft - secsLeft) < 15);
        if (!already) {
          entry.closeSnapshots.push({ secsLeft, mktProb, modelScore, ts: Date.now() });
        }
        break;
      }
    }
  }

  // ── 2. RESOLUTION POLLER ─────────────────────────────────────────
  // Checks pending markets. For those past close_time + grace, fetches the
  // exact Polymarket market by slug to check for a resolved outcome.

  async function checkPending() {
    const now = Date.now();
    const expired = [..._pending.values()]
      .filter(e => now >= e.closeTimeMs + SETTLE_GRACE)
      .filter(e => !_settledSlugs.has(e.slug) && !_pushInFlight.has(e.slug));

    for (const entry of expired) {
      // Race: push path may have settled while we were iterating
      if (!_pending.has(entry.slug) || _settledSlugs.has(entry.slug)) continue;

      const secsPast = Math.round((now - entry.closeTimeMs) / 1000);
      console.log(`[Resolver] ⏳ polling ${entry.sym} ${entry.type} ${entry.slug} (${secsPast}s past close)`);
      addAudit(entry.slug, 'poll_attempt', {
        sym: entry.sym,
        type: entry.type,
        secsPast,
        closeTimeMs: entry.closeTimeMs,
        rti: getRtiDiagnostics(entry.sym, entry.closeTimeMs),
      });

      const settled = await resolvePolymarketMarket(entry);
      if (settled) {
        _pending.delete(entry.slug);
        recordResolution(settled);
      } else {
        if (now - entry.closeTimeMs > 15 * 60_000) {
          console.warn(`[Resolver] ⚠️ ${entry.sym} ${entry.slug} timed out 15m+ — dropping`);
          addAudit(entry.slug, 'dropped', { sym: entry.sym, reason: 'timeout_15min' });
          _pending.delete(entry.slug);
        } else {
          console.log(`[Resolver] 🔄 ${entry.sym} ${entry.slug} not settled yet — retry next cycle`);
        }
      }
    }
  }

  // ── 3. POLYMARKET SETTLEMENT FETCH ───────────────────────────────
  // Returns a resolution record or null if not yet settled.

  async function resolvePolymarketMarket(entry) {
    const retryDelays = [3000, 8000, 20000];
    let m = null;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      m = await fetchPolymarketMarketBySlug(entry.slug);
      if (m) break;
      if (attempt < retryDelays.length) {
        const delay = retryDelays[attempt];
        console.warn(`[Resolver] ⚠️ Retry ${attempt + 1} for ${entry.sym} ${entry.slug} — ${delay}ms`);
        addAudit(entry.slug, 'fetch_retry', { sym: entry.sym, attempt: attempt + 1, nextDelayMs: delay });
        await new Promise(r => setTimeout(r, delay));
      }
    }

    if (!m) {
      console.error(`[Resolver] ❌ ${entry.sym} ${entry.slug} — market fetch failed after retries`);
      addAudit(entry.slug, 'fetch_failed_all_retries', { sym: entry.sym, attempts: retryDelays.length + 1 });
      return null;
    }

    return await processPolymarketSettlement(m, entry);
  }

  // Map CLOB/WS winning_outcome (and token-id fallbacks) → UP | DOWN | null
  // Accepts Batch-2 polymarket-ws detail (camelCase) and raw wire snake_case.
  function mapPushOutcome(detail, entry) {
    const raw = detail?.winning_outcome || detail?.winningOutcome || null;
    if (raw != null) {
      const s = String(raw).trim().toLowerCase();
      if (s === 'up' || s === 'yes') return 'UP';
      if (s === 'down' || s === 'no') return 'DOWN';
    }
    // Fallback: match winning asset to Up token (index 0 / clobUpAssetId)
    const winId = String(
      detail?.winning_asset_id ||
      detail?.winningAssetId ||
      detail?.winningTokenId ||
      detail?.winning_token_id ||
      ''
    );
    if (winId && entry) {
      const upId = entry.clobUpAssetId ? String(entry.clobUpAssetId) : null;
      const downId = entry.clobDownAssetId ? String(entry.clobDownAssetId) : null;
      if (upId && winId === upId) return 'UP';
      if (downId && winId === downId) return 'DOWN';
      if (Array.isArray(entry.tokenIds) && entry.tokenIds.length >= 2) {
        if (winId === String(entry.tokenIds[0])) return 'UP';
        if (winId === String(entry.tokenIds[1])) return 'DOWN';
      }
    }
    return null;
  }

  function findPendingForPush(detail) {
    if (!detail) return null;
    const slug =
      detail.slug ||
      detail.event_message?.slug ||
      detail.eventMessage?.slug ||
      detail.raw?.slug ||
      null;
    if (slug && _pending.has(slug)) return _pending.get(slug);

    const conditionId = String(
      detail.conditionId || detail.condition_id || detail.market || detail.raw?.market || ''
    );
    if (conditionId) {
      for (const e of _pending.values()) {
        if (e.conditionId && String(e.conditionId) === conditionId) return e;
      }
    }

    // Batch-2 WS emits assetIds; wire uses assets_ids
    const assets =
      detail.assetIds ||
      detail.assets_ids ||
      detail.tokenIds ||
      detail.token_ids ||
      detail.raw?.assets_ids ||
      [];
    if (Array.isArray(assets) && assets.length) {
      const assetSet = new Set(assets.map(String));
      for (const e of _pending.values()) {
        if (e.clobUpAssetId && assetSet.has(String(e.clobUpAssetId))) return e;
        if (e.clobDownAssetId && assetSet.has(String(e.clobDownAssetId))) return e;
        if (Array.isArray(e.tokenIds) && e.tokenIds.some(t => assetSet.has(String(t)))) return e;
      }
    }
    return null;
  }

  // ── Helper: Process a Polymarket market's settlement state ───────
  // settleSource: 'gamma_poll' | 'ws_push'
  async function processPolymarketSettlement(m, entry, settleSource = 'gamma_poll') {
    const resolved = _resolveFromMarket(m);
    if (!resolved) {
      addAudit(entry.slug, 'awaiting_settlement', {
        sym: entry.sym,
        closed: m.closed === true,
        outcomePrices: m.outcomePrices ?? null,
        closeTimeMs: entry.closeTimeMs,
        nowMs: Date.now(),
        secsPastClose: Math.round((Date.now() - entry.closeTimeMs) / 1000),
        rti: getRtiDiagnostics(entry.sym, entry.closeTimeMs),
      });
      console.log(`[Resolver] ⏳ ${entry.sym} ${entry.slug} closed=${m.closed === true} outcomePrices=${JSON.stringify(m.outcomePrices)} — not settled yet`);
      return null;
    }

    return await buildResolutionRecord(entry, resolved.actualOutcome, resolved.upPrice, {
      settleSource,
      outcomePrices: m.outcomePrices,
      closed: m.closed === true,
    });
  }

  // Build the canonical resolution record shared by push + poll paths.
  async function buildResolutionRecord(entry, actualOutcome, upPrice, meta = {}) {
    const settleSource = meta.settleSource || 'gamma_poll';
    const entryProb = entry.entryProb ?? 0.5;
    const marketDir = entryProb >= 0.50 ? 'UP' : 'DOWN';
    const modelDir = entry.modelDir;
    const modelCorrect = modelDir && modelDir !== 'FLAT' ? modelDir === actualOutcome : null;
    const marketCorrect = marketDir === actualOutcome;

    const rtiDiagnostics = getRtiDiagnostics(entry.sym, entry.closeTimeMs);
    addAudit(entry.slug, 'contract_settled', {
      sym: entry.sym,
      type: entry.type,
      settleSource,
      closed: meta.closed ?? true,
      outcomePrices: meta.outcomePrices ?? null,
      upPrice,
      actualOutcome,
      marketDir,
      modelDir,
      modelCorrect,
      marketCorrect,
      entryProb,
      priceToBeatNum: entry.priceToBeatNum,
      rtiDiagnostics,
    });

    console.log(
      `[Resolver] ✅ ${entry.sym} ${entry.type} ${entry.slug} | → ${actualOutcome} (up=${Number(upPrice).toFixed(3)}) ` +
      `[${settleSource}] | PTB=$${entry.priceToBeatNum ?? 'n/a'} | model=${modelDir} ${modelCorrect ? '✓' : modelCorrect === false ? '✗' : '?'} | ` +
      `mktProb=${(entryProb * 100).toFixed(0)}% mktOk=${marketCorrect}`
    );

    // ── Coinbase context note (informational only, never authoritative) ──
    const cbContextPrice = await fetchCoinbaseContext(entry.sym, entry.closeTimeMs);
    let cbContextNote = null;
    if (cbContextPrice != null && entry.priceToBeatNum != null) {
      const cbDir = cbContextPrice >= entry.priceToBeatNum ? 'UP' : 'DOWN';
      cbContextNote = { cbContextPrice, priceToBeatNum: entry.priceToBeatNum, cbDir, agrees: cbDir === actualOutcome };
      if (cbDir !== actualOutcome) {
        // Not a warning: Polymarket resolves on a TWAP window, CB here is a
        // single spot candle. Divergence near a boundary is expected, not an error.
        console.log(
          `[Resolver] ℹ️ CB spot vs Polymarket TWAP resolution for ${entry.sym}: ` +
          `CB=${cbContextPrice} vs PTB=${entry.priceToBeatNum} → ${cbDir} (spot) while Polymarket resolved ${actualOutcome} (TWAP) — informational only`
        );
        addAudit(entry.slug, 'cb_context_note', { sym: entry.sym, ...cbContextNote });
      }
    }

    // ── PYTH context note (informational only, never authoritative) ──
    const pythData = window._pythPrices ? window._pythPrices[entry.sym] : null;
    if (pythData && entry.priceToBeatNum != null) {
      const pythPrice = pythData.price;
      const divergence = Math.abs((pythPrice - entry.priceToBeatNum) / entry.priceToBeatNum);
      const pythDir = pythPrice >= entry.priceToBeatNum ? 'UP' : 'DOWN';
      addAudit(entry.slug, 'pyth_context_note', {
        sym: entry.sym,
        pythPrice,
        priceToBeatNum: entry.priceToBeatNum,
        divergencePct: divergence * 100,
        pythDir,
        actualOutcome,
        agrees: pythDir === actualOutcome,
      });
    }

    const settlementAuthority = settleSource === 'ws_push' ? 'polymarket_ws' : 'polymarket_gamma';

    return {
      sym: entry.sym,
      ticker: entry.slug, // kept for consumer field-compat; Polymarket has no separate ticker, slug IS the id
      slug: entry.slug,
      type: entry.type,
      snapshotTs: entry.snapshotTs,
      closeTimeMs: entry.closeTimeMs,
      settledTs: Date.now(),
      settleLatencyMs: Math.max(0, Date.now() - entry.closeTimeMs),
      settleLatencySec: Math.max(0, Math.round((Date.now() - entry.closeTimeMs) / 1000)),
      settleSource,
      settlementAuthority,
      entryProb,
      marketDir,
      actualOutcome,
      upPrice,
      refPrice: entry.priceToBeatNum,        // Polymarket's own TWAP-based price-to-beat
      priceToBeatNum: entry.priceToBeatNum,
      priceToBeatSource: entry.priceToBeatSource,
      confidence: settleSource === 'ws_push' ? 95 : 92,
      cbContextPrice,
      cbContextNote,
      rtiAtResolve: rtiDiagnostics,
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

  // ── PUSH path: CLOB WS market_resolved → immediate settle ───────
  async function handleMarketResolvedPush(detail) {
    const entry = findPendingForPush(detail);
    if (!entry) {
      // Not one of our tracked 5m/15m windows — ignore quietly
      return;
    }
    if (_settledSlugs.has(entry.slug) || !_pending.has(entry.slug)) return;
    if (_pushInFlight.has(entry.slug)) return;
    _pushInFlight.add(entry.slug);

    try {
      addAudit(entry.slug, 'push_market_resolved', {
        sym: entry.sym,
        type: entry.type,
        slug: entry.slug,
        conditionId: detail?.conditionId || detail?.market || null,
        winning_outcome: detail?.winning_outcome || detail?.winningOutcome || null,
        winning_asset_id:
          detail?.winning_asset_id ||
          detail?.winningAssetId ||
          detail?.winningTokenId ||
          null,
      });

      let actualOutcome = mapPushOutcome(detail, entry);
      let upPrice = actualOutcome === 'UP' ? 1 : actualOutcome === 'DOWN' ? 0 : null;

      // If WS payload lacks a clear Up/Down, fall back to Gamma once (still push-triggered)
      if (!actualOutcome) {
        console.log(`[Resolver] 📡 push matched ${entry.sym} ${entry.slug} but outcome unclear — Gamma confirm`);
        const m = await fetchPolymarketMarketBySlug(entry.slug);
        if (m) {
          const settled = await processPolymarketSettlement(m, entry, 'ws_push');
          if (settled) {
            _pending.delete(entry.slug);
            recordResolution(settled);
            return;
          }
        }
        console.log(`[Resolver] 📡 push ${entry.slug} not ready — leave for poll fallback`);
        return;
      }

      console.log(
        `[Resolver] 📡 push-resolve ${entry.sym} ${entry.type} ${entry.slug} → ${actualOutcome}`
      );
      const record = await buildResolutionRecord(entry, actualOutcome, upPrice, {
        settleSource: 'ws_push',
        closed: true,
        outcomePrices: actualOutcome === 'UP' ? [1, 0] : [0, 1],
      });
      _pending.delete(entry.slug);
      recordResolution(record);
    } catch (err) {
      console.warn(`[Resolver] push handler error for ${entry.slug}:`, err?.message || err);
      addAudit(entry.slug, 'push_error', { sym: entry.sym, error: String(err?.message || err) });
    } finally {
      _pushInFlight.delete(entry.slug);
    }
  }

  // ── 4. RECORD + DISPATCH ─────────────────────────────────────────
  // Idempotent by slug: push vs poll (or double events) never double-write.

  function recordResolution(res) {
    if (!res?.slug) return;
    if (_settledSlugs.has(res.slug)) {
      console.log(`[Resolver] ⏭ skip duplicate slug ${res.slug} (already recorded)`);
      addAudit(res.slug, 'dedupe_skip', { sym: res.sym, settleSource: res.settleSource });
      return;
    }
    if (window._15mResolutionLog.some(e => e.slug === res.slug)) {
      _settledSlugs.add(res.slug);
      console.log(`[Resolver] ⏭ skip duplicate slug ${res.slug} (already in log)`);
      return;
    }

    _settledSlugs.add(res.slug);
    window._15mResolutionLog.push(res);
    if (window._15mResolutionLog.length > LOG_MAX) {
      window._15mResolutionLog.shift();
    }
    // Quick lookup by coin (latest across both 5m and 15m)
    window._resolutionMap[res.sym] = res;
    saveLog();

    // Log to DataLogger (writes to local + Z:\ + W:\ Drive paths + localStorage cache)
    if (window.DataLogger?.logResolverOutcome) {
      window.DataLogger.logResolverOutcome(res.sym, res);
    }

    // Notify the app (UI can show toast, update accuracy badge)
    // settlementAuthority: polymarket_ws (push) | polymarket_gamma (poll)
    const settlementAuthority = res.settlementAuthority
      || (res.settleSource === 'ws_push' ? 'polymarket_ws' : 'polymarket_gamma');
    try {
      window.dispatchEvent(new CustomEvent('market15m:resolved', {
        detail: {
          sym: res.sym,
          outcome: res.actualOutcome,   // 'UP' | 'DOWN'
          type: res.type,               // '5m' | '15m'
          settlementAuthority,
          canonical: true,
          schemaVersion: 'resolver.v2',
          modelCorrect: res.modelCorrect,
          marketCorrect: res.marketCorrect,
          prob: res.entryProb,
          ticker: res.ticker,
          slug: res.slug,
          refPrice: res.refPrice,
          cbContextPrice: res.cbContextPrice,
          rtiAtResolve: res.rtiAtResolve,
          settleLatencyMs: res.settleLatencyMs,
          settleLatencySec: res.settleLatencySec,
          settleSource: res.settleSource || null,
        },
      }));
    } catch (_) { }

    const icon = res.modelCorrect === true ? '\u2705'
      : res.modelCorrect === false ? '\u274c'
        : '\u2753';
    console.log(
      `[Resolver] ${res.sym} ${res.type} settled → ${res.actualOutcome} ${icon} ` +
      `| ${settlementAuthority} | model=${res.modelDir ?? 'N/A'} | PTB=$${res.refPrice} ` +
      `| mktProb:${(res.entryProb * 100).toFixed(0)}% mktOk:${res.marketCorrect} ` +
      `| cbContext=${res.cbContextPrice}`
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

    // PUSH path: CLOB WS market_resolved (via polymarket-ws CustomEvent)
    window.addEventListener('polymarket:market_resolved', e => {
      try {
        handleMarketResolvedPush(e.detail || {});
      } catch (err) {
        console.warn('[Resolver] polymarket:market_resolved handler error:', err?.message || err);
      }
    });

    // Poll every 60s for settlements (fallback if WS push missed / delayed)
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
      if (!document.hidden) checkPending();
    }, POLL_INTERVAL);

    // Also do an immediate pass in case of app restart with stale pending
    setTimeout(checkPending, 5000);

    console.log('[Resolver] Polymarket 5M/15M market resolver started (push+poll)');
  }

  // ── PUBLIC API ───────────────────────────────────────────────────
  window.MarketResolver = {
    start,
    getPending: () => [..._pending.values()],
    getLog: () => window._15mResolutionLog,
    getResolutionAccuracy,
    getLatest: sym => window._resolutionMap[sym] ?? null,
    addCloseSnapshot,
    /** Test/debug: inject a market_resolved detail object */
    handlePush: handleMarketResolvedPush,
    hasSettledSlug: (slug) => _settledSlugs.has(slug),
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
  //   MarketDebug.audit('ETH')     — step-by-step contract audit trail
  //   MarketDebug.pending()        — contracts currently waiting to settle
  //   MarketDebug.last('ETH')      — latest authoritative resolution for ETH
  //   MarketDebug.snap(sym)        — (unused, kept for API compat)
  //   MarketDebug.contract('ETH')  — full state: pending + resolved
  //   MarketDebug.summary()        — accuracy summary across all coins
  // window.KalshiDebug is kept as an alias — cosmetic name only, several
  // renderer files still call it by that name; functionally identical.
  const MarketDebug = {
    audit(sym) {
      const log = window._contractAuditLog || [];
      const rows = sym ? log.filter(e => e.sym === sym || (e.slug || '').includes(sym)) : log;
      console.table(rows.map(e => ({
        time: e.tsIso?.slice(11, 19), slug: e.slug, event: e.event,
        sym: e.sym, outcome: e.actualOutcome, upPrice: e.upPrice,
        modelDir: e.modelDir, modelOk: e.modelCorrect,
      })));
      return rows;
    },
    pending() {
      const p = [..._pending.values()];
      console.table(p.map(e => ({
        sym: e.sym, type: e.type, slug: e.slug,
        closesAt: new Date(e.closeTimeMs).toISOString().slice(11, 19),
        secsLeft: Math.round((e.closeTimeMs - Date.now()) / 1000),
        priceToBeatNum: e.priceToBeatNum,
        model: e.modelDir, prob: e.entryProb != null ? `${(e.entryProb * 100).toFixed(0)}%` : null,
      })));
      return p;
    },
    last(sym) {
      const r = window._resolutionMap?.[sym];
      if (!r) { console.log(`No resolution yet for ${sym}`); return null; }
      console.table([{
        sym: r.sym, type: r.type, slug: r.slug,
        outcome: r.actualOutcome, ref: r.refPrice, upPrice: r.upPrice,
        model: r.modelDir, modelOk: r.modelCorrect, mktOk: r.marketCorrect,
        confidence: r.confidence, settledAt: new Date(r.settledTs).toISOString().slice(11, 19),
      }]);
      return r;
    },
    contract(sym) {
      const pend = [..._pending.values()].find(e => e.sym === sym);
      const res = window._resolutionMap?.[sym];
      console.log(`\n=== ${sym} FULL CONTRACT STATE ===`);
      console.log('⏳ pending: ', pend ?? 'NONE');
      console.log('✅ resolved:', res ?? 'NONE');
      return { pend, res };
    },
    summary() {
      const coins = [...new Set((window._15mResolutionLog || []).map(e => e.sym))];
      const rows = coins.map(sym => {
        const acc = getResolutionAccuracy(sym, 100);
        return {
          sym,
          settled: (window._15mResolutionLog || []).filter(e => e.sym === sym).length,
          accuracy: acc ? `${(acc.accuracy * 100).toFixed(0)}%` : '–',
          trend: acc ? acc.trend : '–',
        };
      });
      console.table(rows);
      return rows;
    },
  };
  window.MarketDebug = MarketDebug;
  window.KalshiDebug = MarketDebug; // legacy name, several renderer files still reference this

})();
