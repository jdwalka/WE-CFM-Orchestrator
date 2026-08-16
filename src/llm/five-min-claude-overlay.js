/**
 * Five-Minute Grok (xAI) Overlay — producer for the 5-minute binary PTB markets (polycool.app / Polymarket).
 *
 * These 5min contracts use Chainlink for the price-to-beat settlement oracle and are binary (UP/DOWN vs fixed PTB).
 *
 * Runs in the renderer. For BTC/ETH/SOL/XRP (independently, so 2-4 coins can fire in the
 * same 5-minute window) it watches the live 5-minute price-to-beat markets and asks Grok/xAI
 * for guidance (replaces prior Claude path), gated on:
 *   - "trickier" market regimes (chop / mean-reversion / high-vol, near the
 *     price-to-beat, low model confidence, or model-vs-price direction conflict),
 *   - a live TAIL-RISK order-flow burst from window.CexFlow (VPIN spike, whale
 *     trades, persistent vol-mult spike — see engines/cex_flow_monitor.py +
 *     cex_high_freq_monitor.py), which shortens the cadence so a real burst gets
 *     capitalized on immediately instead of waiting out the normal gap,
 *   - with a guaranteed floor of at least one inference per coin every 15 min
 *     (which also satisfies the hourly cadence), and a minimum gap between
 *     tricky-triggered calls so a single coin can't spam the API.
 *
 * When tail risk is active, also computes a mechanical SNIPE/SCALP-FLIP plan
 * (enter the momentum side, hold ~45-90s while it reprices, sell, flip to the
 * other side) and merges it with the model's own snipe_plan judgment. Each fire
 * also carries a forward preview of the next 2-3 five-minute windows (momentum
 * persistence only — a window's own price-to-beat isn't set until it opens; the
 * normal tick loop promotes it to a firm call the moment it locks).
 *
 * Inference is routed via LLMSignalAssistant (xAI/rex primary for 5m; fallback asi1→openai→claude→gemini)
 * when a 5m PTB snapshot is provided. Guidance is stored per-coin and read by renderMarkets5M().
 *
 * Pure decision helpers are exported for unit testing; the live loop only starts
 * inside an Electron renderer (window.electron present).
 */
(function () {
  'use strict';

  // 5m Grok analysis for Polymarket binary PTB contracts.
  // Enabled: fires per-coin inference against live polycool.app / Polymarket 5m windows.
  const FIVE_MIN_GROK_ENABLED = true;

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];

  // ── Cadence ────────────────────────────────────────────────────────────────
  const TICK_MS = 30_000;            // evaluate the gate every 30s
  const MIN_GAP_MS = 4 * 60_000;     // min spacing between tricky-triggered calls per coin
  const TAIL_RISK_GAP_MS = 45_000;   // min spacing when a live tail-risk burst is firing — "capitalize on that"
  const FLOOR_MS = 15 * 60_000;      // guarantee >= 1 inference per coin every 15 min
  const HOURLY_MS = 60 * 60_000;     // explicit hourly heartbeat (subsumed by the floor; logged)
  // Grok-4.5 via OpenAI SDK (main process) often needs 25–40s under load; 20s caused
  // "Unavailable: grok5m:BTC timeout". Align with XAI_TIMEOUT_MS (default 45s) + headroom.
  const REQUEST_TIMEOUT_MS = Number(
    (typeof process !== 'undefined' && process.env && process.env.GROK_5M_TIMEOUT_MS)
      || (typeof window !== 'undefined' && window.__env && window.__env.GROK_5M_TIMEOUT_MS)
      || 55_000
  );

  // ── Trickiness thresholds ────────────────────────────────────────────────────
  const NEAR_PTB_PCT = 0.12;         // within 0.12% of the price-to-beat = coin-flip
  const LOW_CONF_PCT = 60;           // model confidence below this = uncertain

  // ── Pure helpers (testable) ──────────────────────────────────────────────────

  function normConf(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n <= 1 ? n * 100 : n;     // accept 0-1 or 0-100, return percent
  }

  function pctDistanceToTarget(current, target) {
    if (!(current > 0) || !(target > 0)) return null;
    return ((current - target) / target) * 100; // percentage points
  }

  // classifyMarketRegime() produces `${trend}_${vol}` — trend ∈ bull|bear|range|
  // meanrev, vol ∈ low|mid|high. Tricky = no clean trend, or high volatility.
  function isTrickyRegimeLabel(regime) {
    const r = String(regime || '').toLowerCase();
    if (!r) return false;
    const [trend, vol] = r.split('_');
    return trend === 'range' || trend === 'meanrev' || vol === 'high';
  }

  function normDir(dir) {
    const d = String(dir == null ? '' : dir).toLowerCase();
    if (d.includes('up') || d.includes('bull') || d === '1' || d === '+1') return 'up';
    if (d.includes('down') || d.includes('bear') || d === '-1') return 'down';
    return null;
  }

  // Returns the list of trickiness reasons (empty = a clean, skippable regime).
  function assessTrickiness(pred, current, target) {
    const reasons = [];
    if (isTrickyRegimeLabel(pred && pred.regime)) reasons.push('regime:' + pred.regime);

    const conf = normConf(pred && pred.confidence);
    if (conf != null && conf < LOW_CONF_PCT) reasons.push('low-conf');

    const dist = pctDistanceToTarget(current, target);
    if (dist != null && Math.abs(dist) < NEAR_PTB_PCT) reasons.push('near-ptb');

    if (dist != null) {
      const priceSide = dist >= 0 ? 'up' : 'down';
      const md = normDir(pred && (pred.direction != null ? pred.direction : pred.signal));
      if (md && md !== priceSide) reasons.push('dir-conflict');
    }
    return reasons;
  }

  // Decide whether to fire for a coin given when it last fired, trickiness, and
  // whether a live tail-risk burst is active (shorter gap so we "capitalize" on
  // it — multiple coins can each fire independently within the same 5m window).
  function decideFire(now, lastTs, isTricky, tailRiskActive) {
    const since = now - (Number(lastTs) || 0);
    if (since >= FLOOR_MS) return { fire: true, reason: 'floor-15m' };
    if (tailRiskActive && since >= TAIL_RISK_GAP_MS) return { fire: true, reason: 'tail-risk' };
    if (isTricky && since >= MIN_GAP_MS) return { fire: true, reason: 'tricky' };
    return { fire: false, reason: null };
  }

  function isCanonicalPtbSource(src) {
    const s = String(src || '').toLowerCase();
    if (!s) return true;
    if (/rtds|twap30|title|provisional|coinbase|binance|gecko|rti|crypto-price|boundary|rejected:/.test(s)) {
      return false;
    }
    return /poly|gamma|chainlink|clob|candle|lock|event|openprice|pricetobeat/.test(s);
  }

  function resolvePriceToBeat(market) {
    const p5 = market && market.poly5m;
    if (!p5) return null;
    const t = Number(p5.priceToBeatNum != null ? p5.priceToBeatNum : p5.targetPriceNum);
    if (!(Number.isFinite(t) && t > 0)) return null;
    // Only Polymarket-published PTB for AI — never RTDS/title proxies
    if (!isCanonicalPtbSource(p5.priceToBeatSource || p5.ptbSource)) return null;
    return t;
  }

  function resolveCurrentPrice(pred, market) {
    // Prefer Pyth for AI path
    try {
      if (window.OracleSnapshot?.getPythSpot) {
        const p = window.OracleSnapshot.getPythSpot(market?.sym || market?.coin || pred?.coin);
        if (p?.price > 0) return p.price;
      }
    } catch (_) {}
    try {
      const coin = (pred && pred.coin) || null;
      if (coin && window._pythPrices && window._pythPrices[coin] > 0) return Number(window._pythPrices[coin]);
    } catch (_) {}
    const p5 = market && market.poly5m;
    const cands = [p5 && p5.currentPriceNum, pred && pred.price, pred && pred.currentPrice];
    for (const c of cands) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  function resolvePolyUpProb(market) {
    const p5 = market && market.poly5m;
    if (!p5) return null;
    const cands = [p5.upProb, p5.probUp, p5.yesProb, p5.impliedProb];
    for (const c of cands) {
      const n = Number(c);
      if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    }
    return null;
  }

  // ── Tail-risk order-flow (window.CexFlow — VPIN, whale trades, vol-mult spike) ──
  // "if theres a tail risk claude needs to capitilize on that": a live burst in
  // aggressor flow (informed trading / whale prints / a persistent vol spike)
  // should override the slow 15m-floor cadence and get evaluated right away.
  const VPIN_ELEVATED = 0.4;       // VPIN above this = elevated informed-trading pressure
  const VOL_MULT_SPIKE = 2.0;      // matches cex_flow_monitor.py's own spawn trigger
  const HURST_PERSISTENT = 0.52;   // matches cex_flow_monitor.py
  const VR_PERSISTENT = 1.1;       // matches cex_flow_monitor.py

  function assessTailRisk(cexEntry, coin) {
    const reasons = [];
    const agg = (cexEntry && cexEntry.aggregate) || {};
    const hf = (cexEntry && cexEntry.hf) || {};

    const vpin = Number(hf.vpin);
    const whale10k = Number(hf.whaleTrades10k) || 0;
    const whale50k = Number(hf.whaleTrades50k) || 0;
    const volMult = Number(agg.volMult);
    const hurst = Number(agg.hurst_v);
    const vr = Number(agg.vr_v);

    if (Number.isFinite(vpin) && vpin >= VPIN_ELEVATED) reasons.push('vpin-elevated');
    if (whale50k > 0) reasons.push('whale-50k');
    else if (whale10k >= 3) reasons.push('whale-cluster-10k');
    const isSpike = Number.isFinite(volMult) && volMult >= VOL_MULT_SPIKE;
    const isPersistent = (Number.isFinite(hurst) && hurst > HURST_PERSISTENT) || (Number.isFinite(vr) && vr > VR_PERSISTENT);
    if (isSpike && isPersistent) reasons.push('vol-spike-persistent');
    if (agg.label === 'STRONG BUY PRESSURE' || agg.label === 'STRONG SELL PRESSURE') reasons.push('strong-cex-pressure');

    // On-chain side-scan (BTC/ETH/SOL) — compressed features, not raw txs
    let onChainBurst = null;
    try {
      if (window.OnChainFlow && typeof window.OnChainFlow.get === 'function') {
        const p = window.OnChainFlow.get(coin);
        if (p && p.burst && Array.isArray(p.burstReasons)) {
          onChainBurst = p;
          for (const r of p.burstReasons) reasons.push('chain:' + r);
        }
      }
    } catch (_) { onChainBurst = null; }

    return {
      active: reasons.length > 0,
      reasons,
      vpin: Number.isFinite(vpin) ? vpin : null,
      whaleTrades10k: whale10k,
      whaleTrades50k: whale50k,
      volMult: Number.isFinite(volMult) ? volMult : null,
      hurst: Number.isFinite(hurst) ? hurst : null,
      vr: Number.isFinite(vr) ? vr : null,
      buyPct: Number.isFinite(hf.buyPct) ? hf.buyPct : null,
      sellPct: Number.isFinite(hf.sellPct) ? hf.sellPct : null,
      signal: agg.label || null,
      hfActive: !!hf.active,
      hfConnected: !!hf.connected,
      onChain: onChainBurst ? {
        lean: onChainBurst.lean,
        leanScore: onChainBurst.leanScore,
        burstReasons: onChainBurst.burstReasons,
        whale: onChainBurst.whale,
        chain: onChainBurst.chain,
      } : null,
    };
  }

  // ── Snipe / scalp-flip plan ──────────────────────────────────────────────────
  // "buy a 5 min contract ride direction for a minute then sell it and buy the
  // other side" — mechanical fallback plan built from tail-risk + momentum, used
  // when present, and merged with (not blindly trusting) the model's own
  // snipe_plan judgment once guidance returns.
  function buildSnipePlan(tailRisk, dist, momentumDir, secsToClose) {
    if (!tailRisk || !tailRisk.active) return null;
    const enterSide = momentumDir || (Number.isFinite(dist) ? (dist >= 0 ? 'up' : 'down') : null);
    if (!enterSide) return null;

    // Don't propose a flip if there isn't enough window left to ride + flip + settle.
    if (Number.isFinite(secsToClose) && secsToClose < 90) return null;

    const holdSeconds = tailRisk.reasons.includes('vol-spike-persistent') ? 75 : 45;
    return {
      shouldFlip: true,
      enterSide: enterSide.toUpperCase(),
      holdSeconds,
      flipTo: enterSide === 'up' ? 'DOWN' : 'UP',
      flipTrigger: 'tick velocity stalls or reverses, or the burst reasons (' + tailRisk.reasons.join(', ') + ') fade',
      source: 'mechanical',
    };
  }

  // Merge the model's own snipe_plan (if it returned one) over the mechanical
  // fallback — the model sees more context (HTF/on-chain/X) and can veto a flip
  // (should_flip:false) even when tail risk is technically active.
  function mergeSnipePlan(mechanicalPlan, modelPlan) {
    if (!modelPlan || typeof modelPlan !== 'object') return mechanicalPlan;
    if (modelPlan.should_flip === false) return null;
    if (modelPlan.should_flip !== true) return mechanicalPlan;
    const side = String(modelPlan.enter_side || '').toUpperCase();
    if (side !== 'UP' && side !== 'DOWN') return mechanicalPlan;
    const hold = Number(modelPlan.hold_seconds);
    return {
      shouldFlip: true,
      enterSide: side,
      holdSeconds: Number.isFinite(hold) ? Math.max(15, Math.min(150, hold)) : (mechanicalPlan ? mechanicalPlan.holdSeconds : 60),
      flipTo: (side === 'UP' ? 'DOWN' : 'UP'),
      flipTrigger: String(modelPlan.flip_trigger || (mechanicalPlan ? mechanicalPlan.flipTrigger : '')),
      source: 'model',
    };
  }

  // ── Next 2-3 five-minute windows (forward lookahead) ─────────────────────────
  // Polymarket 5m windows sit on a fixed 300s UTC grid. Their price-to-beat isn't
  // set until each window opens, so this gives a momentum/regime-persistence
  // PREVIEW for the next N windows rather than a firm call — "give me inference
  // on the next 2 to 3 5 min markets" without fabricating certainty on an
  // unresolved PTB. Each window is promoted to a firm call automatically by the
  // normal tick loop the moment its own PTB locks.
  const WINDOW_MS = 5 * 60_000;
  function nextWindowStarts(nowMs, count) {
    const n = Math.max(1, Number(count) || 1);
    const currentWindowStart = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
    const out = [];
    for (let i = 1; i <= n; i++) out.push(currentWindowStart + i * WINDOW_MS);
    return out;
  }

  function buildUpcomingWindowsPreview(nowMs, trickyReasons, tailRisk, momentumDir) {
    const starts = nextWindowStarts(nowMs, 2); // "next 2 to 3" — current + these 2 = 3 total in scope
    const persistenceLikely = trickyReasons.some(r => r.startsWith('regime:')) || (tailRisk && tailRisk.active);
    const biasPreview = momentumDir
      ? (persistenceLikely ? `${momentumDir}-continuation likely` : `${momentumDir}-lean, low conviction`)
      : 'no clear lean yet';
    return starts.map((ts) => ({
      windowStart: ts,
      etaSeconds: Math.max(0, Math.round((ts - nowMs) / 1000)),
      biasPreview,
    }));
  }

  function buildSnapshot(coin, pred, market, current, target, tailRisk, upcomingWindows) {
    const pmCoin = market || {};
    const k15 = pmCoin.kalshi15m || pmCoin['15m'] || {};
    const poly15 = pmCoin.poly15m || pmCoin.poly || {};
    // crude 30m proxy from 15m if no direct; in real run pull from 30m candles/pred if exposed
    const h30 = (pred && (pred.h30 || pred.horizon30)) || {};

    // recent X sentiment (pre-scraped by SocialSentiment feed; refreshed on fire)
    let xSent = null;
    try {
      if (window.SocialSentiment) {
        const s = window.SocialSentiment.getTrend ? window.SocialSentiment.getTrend(coin, 0.5) : null;
        xSent = s || (window.SocialSentiment[coin] || null);
      }
    } catch (_) {}

    // Compressed on-chain side-scan (BTC/ETH/SOL) for Grok — never raw txs
    let onChain = null;
    try {
      if (window.OnChainFlow && typeof window.OnChainFlow.packetForGrok === 'function') {
        onChain = window.OnChainFlow.packetForGrok(coin);
      } else {
        onChain = (pred && (pred.onChain || pred.blockchain || pred.whaleFlow || pred.recentLargeTxs)) ||
                  (pmCoin.onChainRecent || pmCoin.whaleRecent) || null;
        if (!onChain && window.BlockchainScan && typeof window.BlockchainScan.getRecent === 'function') {
          onChain = window.BlockchainScan.getRecent(coin, 30);
        }
        if (!onChain && window.Birdeye && typeof window.Birdeye.getWhaleFlow === 'function') {
          onChain = window.Birdeye.getWhaleFlow(coin, 30);
        }
      }
    } catch (_) {}

    const p5 = pmCoin.poly5m || {};
    const ptbSource = (target != null)
      ? (p5.priceToBeatSource || p5.ptbSource || 'polymarket')
      : null;
    return {
      coin,
      horizonMinutes: 5,
      venue: 'polymarket',
      fiveMinute: true,
      priceToBeat: target,
      priceToBeatNum: target,
      priceToBeatSource: ptbSource,
      currentPrice: current,
      price: current,
      priceSource: 'pyth',
      oraclePolicy: 'pyth_spot_plus_polymarket_ptb_only',
      poly5m: {
        slug: p5.slug || null,
        yesProb: p5.probability ?? p5.upProbability ?? p5.yesProb ?? null,
        priceToBeatNum: target,
        priceToBeatSource: ptbSource,
        secondsToClose: p5.secondsToClose != null ? Number(p5.secondsToClose) : null,
        bestBid: p5.bestBid ?? null,
        bestAsk: p5.bestAsk ?? null,
        depthImbalance: p5.depthImbalance ?? null,
        liveDirection: p5.liveDirection ?? null,
      },
      polymarketOracle: {
        slug: p5.slug || null,
        priceToBeatNum: target,
        priceToBeatSource: ptbSource,
        pythSpot: current,
        pythSource: 'pyth',
        rule: 'PTB is Polymarket window open only. Spot is Pyth only. Do not invent PTB.',
      },
      direction: pred && (pred.direction != null ? pred.direction : pred.signal) || null,
      modelDirection: pred && (pred.direction != null ? pred.direction : pred.signal) || null,
      score: pred && Number.isFinite(Number(pred.score)) ? Number(pred.score) : null,
      modelScore: pred && Number.isFinite(Number(pred.score)) ? Number(pred.score) : null,
      confidence: normConf(pred && pred.confidence),
      regimeLocal: (pred && pred.regime) || null,
      regime: (pred && pred.regime) || null,
      modelAgreement: pred && (pred.agreement || pred.coreAgreement) || null,
      agreement: pred && (pred.agreement || pred.coreAgreement) || null,
      indicators: (pred && (pred.indicators || (pred.diagnostics && pred.diagnostics.components))) || {},
      volatility: Number((pred && pred.volatility && pred.volatility.atrPct) != null
        ? pred.volatility.atrPct
        : (pred && pred.volatility) || 0),
      secondsToClose: (pmCoin.poly5m && pmCoin.poly5m.secondsToClose) != null
        ? Number(pmCoin.poly5m.secondsToClose) : null,

      // higher timeframes for bias into the 5m decision
      higherTF: {
        '15m': {
          prob: k15.probability ?? poly15.probability ?? null,
          regime: k15.regime || poly15.regime || (pred && pred.h15 && pred.h15.regime) || null,
          direction: k15.direction || (pred && pred.h15 && pred.h15.direction) || null,
          closeTime: k15.closeTime || null,
        },
        '30m': {
          regime: h30.regime || null,
          direction: h30.direction || null,
          strength: h30.strength || null,
        }
      },

      // compressed chain + whale + CEX packet for Grok interpretation
      onChainRecent: onChain || { note: 'no on-chain side-scan packet yet' },
      onChainSideScan: onChain,

      // scraped X sentiment (last ~15-30m)
      xSentiment: xSent || { score: 0, summary: 'no recent X data', momentum: 'flat' },

      // Session analytics memory (grows the longer the app stays open — 15m/1h ranges)
      sessionMemory: (function () {
        try {
          if (window.GrokAnalyticsMemory && typeof window.GrokAnalyticsMemory.memoryPackForPrompt === 'function') {
            return window.GrokAnalyticsMemory.memoryPackForPrompt(coin, { ptb: target, ptb5: target });
          }
        } catch (_) {}
        return { sampleCount: 0, sessionMinutes: 0, note: 'memory not started' };
      })(),
      // Latest Grok 15m / hourly range calls (if range overlay has fired)
      rangeGuidance: (function () {
        try {
          const api = window.GrokRangeOverlay || window.GrokRangeGrok;
          if (!api || typeof api.getGuidance !== 'function') return null;
          return {
            '15m': api.getGuidance(coin, 15),
            '60m': api.getGuidance(coin, 60),
          };
        } catch (_) { return null; }
      })(),

      // live CEX order-flow tail-risk (window.CexFlow — VPIN, whale trades, vol-mult spike)
      tailRisk: (tailRisk && tailRisk.active) ? tailRisk : null,

      // forward preview for the next 2-3 five-minute windows (PTB not locked yet)
      upcomingWindows: Array.isArray(upcomingWindows) ? upcomingWindows : [],

      market: {
        modelDirection: pred && (pred.direction != null ? pred.direction : pred.signal) || null,
        confidencePct: normConf(pred && pred.confidence),
        combinedProb: resolvePolyUpProb(market),
      },
      indicators: (pred && (pred.indicators || (pred.diagnostics && pred.diagnostics.components))) || {},
    };
  }

  // Parse the directional call from Grok/xAI output.
  // Priority order:
  //   1. Top-level `call` or `direction` field (most reliable — primary machine-read key)
  //   2. snipe_plan.enter_side when a tail-risk flip plan is active
  //   3. Regex scrape of notes/rationale text (legacy fallback)
  //   4. Distance from current price to price-to-beat (last resort lean)
  //
  // Always returns a binary UP/DOWN direction (falling through to step 4's
  // price-distance lean when nothing else resolves it) rather than collapsing
  // to WAIT on a coin-flip/no-edge situation -- previously, coin-flip language
  // in the model's own notes (step 3) short-circuited straight to 'WAIT',
  // hiding the directional lean entirely instead of just flagging it as low
  // conviction. coinFlip is set whenever that language was detected, so
  // callers can label the call "UP (coin flip)" instead of losing it.
  // The one case that still yields a real WAIT is an explicit top-level
  // WAIT/NO_EDGE/HOLD from the schema (step 1) -- the model refusing to call
  // it at all is a different, honest signal from "it's close but I'll lean."
  function parseCall(output, current, target) {
    let coinFlip = false;

    // 1. Top-level schema keys Grok is instructed to emit directly
    const topCall = String((output && (output.call || output.direction)) || '').toUpperCase().trim();
    if (topCall === 'UP' || topCall === 'DOWN') return { direction: topCall, coinFlip };
    if (topCall === 'WAIT' || topCall === 'NO_EDGE' || topCall === 'HOLD') return { direction: 'WAIT', coinFlip };

    // 2. snipe_plan.enter_side when tail-risk flip plan is active
    if (output && output.snipe_plan && output.snipe_plan.should_flip === true) {
      const snipeSide = String(output.snipe_plan.enter_side || '').toUpperCase().trim();
      if (snipeSide === 'UP' || snipeSide === 'DOWN') return { direction: snipeSide, coinFlip };
    }

    // 3. Regex text-scrape of notes / primary_rationale (legacy fallback)
    const text = String(
      (output && output.suggestions && output.suggestions.notes) ||
      (output && output.ai_wording && output.ai_wording.primary_rationale) || ''
    ).toUpperCase();
    if (/COIN.?FLIP|NO\s*EDGE|TOO\s*CLOSE/.test(text)) coinFlip = true;
    if (/BUY\s*UP|SETTLE[S]?\s*ABOVE|\bUP\b|\bLONG\b|\bYES\b/.test(text)) return { direction: 'UP', coinFlip };
    if (/BUY\s*DOWN|SETTLE[S]?\s*BELOW|\bDOWN\b|\bSHORT\b|\bNO\b/.test(text)) return { direction: 'DOWN', coinFlip };
    if (/\bWAIT\b/.test(text)) coinFlip = true; // bare "wait" with no direction word -- still fall through to the lean below

    // 4. Final lean: distance of current price from price-to-beat
    const dist = pctDistanceToTarget(current, target);
    if (dist != null) return { direction: dist >= 0 ? 'UP' : 'DOWN', coinFlip };
    return { direction: 'WAIT', coinFlip: false }; // truly nothing to lean on (no target/current price at all)
  }

  // ── Live state + loop (renderer only) ────────────────────────────────────────

  const _lastTs = {};       // coin -> last fire ts
  const _inFlight = {};      // coin -> bool
  const _guidance = {};      // coin -> guidance object for rendering
  let _lastHourlyLog = 0;
  let _timer = null;

  function _withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error((label || 'request') + ' timeout')), ms)),
    ]);
  }

  async function _fireCoin(coin, pred, market, current, target, fireReason, trickyReasons, now, tailRisk, upcoming) {
    if (_inFlight[coin]) return;
    _inFlight[coin] = true;
    _lastTs[coin] = now; // count the attempt so cadence holds even if it errors

    // Fresh scrape X for sentiment right before the Grok 5m call (as requested)
    try {
      if (window.SocialSentiment && typeof window.SocialSentiment.fetchCoin === 'function') {
        await window.SocialSentiment.fetchCoin(coin).catch(() => {});
      } else if (window.SocialSentiment && typeof window.SocialSentiment.fetchAll === 'function') {
        await window.SocialSentiment.fetchAll().catch(() => {});
      }
    } catch (_) {}

    const secsToClose = (market && market.poly5m && market.poly5m.secondsToClose) != null
      ? Number(market.poly5m.secondsToClose) : null;
    const dist = pctDistanceToTarget(current, target);
    const momentumDir = normDir(pred && (pred.direction != null ? pred.direction : pred.signal));
    const mechanicalSnipePlan = buildSnipePlan(tailRisk, dist, momentumDir, secsToClose);

    const snapshot = buildSnapshot(coin, pred, market, current, target, tailRisk, upcoming);
    // Budget for full 5m JSON schema via xAI SDK (too low → truncated JSON / retries)
    try {
      snapshot.xaiMaxTokens = Number(
        (typeof window !== 'undefined' && window.__env && window.__env.XAI_5M_MAX_TOKENS) || 1600
      );
    } catch (_) {}
    try {
      const res = await _withTimeout(
        window.electron.invoke('llm:analyzeSnapshot', snapshot),
        REQUEST_TIMEOUT_MS,
        'grok5m:' + coin
      );
      if (res && res.success && res.output) {
        const o = res.output;
        const { direction: resolvedCall, coinFlip } = parseCall(o, current, target);
        console.log(
          `[FiveMinGrok] ${coin} Grok response → call=${resolvedCall}${coinFlip ? ' (coin flip)' : ''}` +
          ` raw.call=${o.call || 'n/a'} raw.dir=${o.direction || 'n/a'}` +
          ` conf=${o.confidence != null ? (Number(o.confidence) * 100).toFixed(0) + '%' : '?'}` +
          ` regime=${o.regime || '?'}`
        );
        _guidance[coin] = {
          ts: now,
          fireReason,
          trickyReasons,
          call: resolvedCall,
          direction: resolvedCall,          // alias so consumers have both
          coinFlip,                         // true = binary call above is a low-conviction lean, not a strong signal
          confidence: Number(o.confidence) || 0,
          regime: o.regime || 'unknown',
          notes: (o.suggestions && o.suggestions.notes) || '',
          rationale: (o.ai_wording && o.ai_wording.primary_rationale) || '',
          reversalRisk: (o.analysis && o.analysis.reversal_risk) || '',
          broaderObservations: (o.broader_observations || o.extra_commentary || o.systemic_note || '').trim(),
          marketPatterns: (o.ai_wording && o.ai_wording.market_patterns) || '',
          scalpSetups: (o.ai_wording && o.ai_wording.scalp_setups) || [],
          provider: (res.providerStatus && res.providerStatus.provider) || res.diagnostics?.fiveMinuteProvider || 'xai',
          target,
          current,
          degraded: !!res.degraded,
          tailRisk,
          snipePlan: mergeSnipePlan(mechanicalSnipePlan, o.snipe_plan),
          upcoming,
        };
        if (typeof window !== 'undefined' && window.currentView === 'markets5m'
          && typeof window.renderMarkets5M === 'function') {
          try { window.renderMarkets5M(); } catch (_) { }
        }
      } else {
        _guidance[coin] = Object.assign({}, _guidance[coin], {
          ts: now, error: (res && res.error) || 'empty-response', fireReason, trickyReasons,
          tailRisk, snipePlan: mechanicalSnipePlan, upcoming,
        });
      }
    } catch (err) {
      _guidance[coin] = Object.assign({}, _guidance[coin], {
        ts: now, error: (err && err.message) || 'inference-failed', fireReason, trickyReasons,
        tailRisk, snipePlan: mechanicalSnipePlan, upcoming,
      });
    } finally {
      _inFlight[coin] = false;
    }
  }

  function tick() {
    if (!FIVE_MIN_GROK_ENABLED) return;
    if (typeof window === 'undefined' || !window.electron || !window.electron.invoke) return;
    const pm = (window.PredictionMarkets && window.PredictionMarkets.getAll && window.PredictionMarkets.getAll()) || {};
    const pe = (window.PredictionEngine && window.PredictionEngine.getAll && window.PredictionEngine.getAll()) || {};
    const now = Date.now();

    if (now - _lastHourlyLog >= HOURLY_MS) {
      _lastHourlyLog = now;
      console.log('[FiveMinGrok] heartbeat — 5m binary PTB analysis active for', COINS.join(', '));
    }

    // Concurrent per-coin evaluation — "all within 5 min on 2-4 coins at once":
    // each coin's fire decision is independent, so a tail-risk burst on BTC and
    // ETH simultaneously both fire this same tick without blocking each other.
    for (const coin of COINS) {
      const market = pm[coin];
      const pred = pe[coin];
      const target = resolvePriceToBeat(market);
      const current = resolveCurrentPrice(pred, market);
      if (target == null || current == null) continue; // no live 5m market / price-to-beat yet

      const cexEntry = (window.CexFlow && typeof window.CexFlow.get === 'function') ? window.CexFlow.get(coin) : null;
      const tailRisk = assessTailRisk(cexEntry, coin);
      const trickyReasons = assessTrickiness(pred, current, target).concat(tailRisk.active ? tailRisk.reasons.map(r => 'tail:' + r) : []);
      const { fire, reason } = decideFire(now, _lastTs[coin], trickyReasons.length > 0, tailRisk.active);
      if (!fire) continue;

      const momentumDir = normDir(pred && (pred.direction != null ? pred.direction : pred.signal));
      const upcoming = buildUpcomingWindowsPreview(now, trickyReasons, tailRisk, momentumDir);

      _fireCoin(coin, pred, market, current, target, reason, trickyReasons, now, tailRisk, upcoming);
    }
  }

  function start() {
    if (!FIVE_MIN_GROK_ENABLED) {
      stop();
      console.log('[FiveMinGrok] DISABLED — 5m analysis off; use 15m + hourly GrokRangeOverlay');
      return;
    }
    if (_timer) return;
    _timer = setInterval(tick, TICK_MS);
    setTimeout(tick, 5_000); // first pass shortly after load
    console.log('[FiveMinGrok] started — 5m binary PTB Polymarket/Chainlink Grok analysis for', COINS.join(', '),
      '| cadence floor=15m tricky=4m tailRisk=45s');
  }

  function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  const api = {
    COINS,
    ENABLED: FIVE_MIN_GROK_ENABLED,
    start,
    stop,
    tick,
    getGuidance(coin) {
      if (!FIVE_MIN_GROK_ENABLED) return null;
      const g = _guidance[String(coin).toUpperCase()] || null;
      // Normalise: ensure .call and .direction are always present and consistent
      if (g && g.call && !g.direction) g.direction = g.call;
      if (g && g.direction && !g.call) g.call = g.direction;
      return g;
    },
    getAllGuidance() {
      if (!FIVE_MIN_GROK_ENABLED) return {};
      return Object.assign({}, _guidance);
    },
    // Exposed for tests / tuning:
    _internals: {
      normConf, pctDistanceToTarget, isTrickyRegimeLabel, normDir,
      assessTrickiness, decideFire, resolvePriceToBeat, resolveCurrentPrice,
      buildSnapshot, parseCall,
      assessTailRisk, buildSnipePlan, mergeSnipePlan,
      nextWindowStarts, buildUpcomingWindowsPreview,
      MIN_GAP_MS, TAIL_RISK_GAP_MS, FLOOR_MS, NEAR_PTB_PCT, LOW_CONF_PCT,
      VPIN_ELEVATED, VOL_MULT_SPIKE, HURST_PERSISTENT, VR_PERSISTENT,
    },
  };

  if (typeof window !== 'undefined') {
    window.FiveMinGrok = api;
    window.FiveMinClaude = api;
    if (FIVE_MIN_GROK_ENABLED && window.electron && window.electron.invoke) {
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(start, 8_000);
      } else {
        window.addEventListener('DOMContentLoaded', () => setTimeout(start, 8_000));
      }
    } else if (!FIVE_MIN_GROK_ENABLED) {
      console.log('[FiveMinGrok] 5m analysis OFF — Grok runs 15m + hourly via GrokRangeOverlay');
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
