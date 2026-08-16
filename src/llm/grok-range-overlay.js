/**
 * Grok Range Overlay — xAI predictions for 15m and hourly ranges.
 *
 * Depends on window.GrokAnalyticsMemory (session accumulator). The longer the
 * app stays open, the more samples/closed windows Grok sees in each prompt.
 *
 * Exposes window.GrokRangeGrok / window.GrokRangeOverlay
 */
(function () {
  'use strict';

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
  const TICK_MS = 30_000;
  const MIN_GAP_15M_MS = 6 * 60_000;   // min spacing between 15m Grok calls per coin
  const MIN_GAP_1H_MS = 18 * 60_000;   // min spacing for hourly
  const FLOOR_15M_MS = 12 * 60_000;    // guarantee ~1 call per 12–15m window
  const FLOOR_1H_MS = 50 * 60_000;     // guarantee ~1 call per hour
  const WARMUP_MS = 45_000;            // allow first fires after 45s of memory sampling
  const STALE_15M_MS = 15 * 60_000;    // hard age cap for 15m guidance with no contract closeTime
  const REQUEST_TIMEOUT_MS = Number(
    (typeof window !== 'undefined' && window.__env && window.__env.GROK_RANGE_TIMEOUT_MS) || 55_000
  );
  const _startedAt = Date.now();

  const _lastTs = { '15m': {}, '60m': {} };
  const _inFlight = { '15m': {}, '60m': {} };
  const _guidance = { '15m': {}, '60m': {} };

  // Cold-start: restore last range guidance from localStorage
  try {
    const restored = window.InferenceStateStore?.loadGuidance?.();
    if (restored) {
      if (restored['15m']) _guidance['15m'] = { ...(_guidance['15m'] || {}), ...restored['15m'] };
      if (restored['60m']) _guidance['60m'] = { ...(_guidance['60m'] || {}), ...restored['60m'] };
      console.info('[GrokRange] restored guidance from localStorage', {
        m15: Object.keys(_guidance['15m'] || {}).length,
        m60: Object.keys(_guidance['60m'] || {}).length,
      });
    }
  } catch (_) { /* */ }

  function _persistGuidance() {
    try {
      window.InferenceStateStore?.saveGuidance?.({
        '15m': _guidance['15m'],
        '60m': _guidance['60m'],
      });
    } catch (_) { /* */ }
  }
  let _timer = null;

  function mem() {
    return (typeof window !== 'undefined' && window.GrokAnalyticsMemory) || null;
  }

  const GUIDANCE_CACHE_STORAGE_KEY = 'wecrypto:grokRangeGuidanceCache';

  // Persists _guidance so the panel isn't blank immediately after a reload.
  // Was previously called but never defined, throwing "saveGuidanceCache is
  // not defined" on every tick.
  function saveGuidanceCache() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(GUIDANCE_CACHE_STORAGE_KEY, JSON.stringify(_guidance));
      }
    } catch (_) {
      // Storage unavailable/full — guidance simply won't survive a reload.
    }
  }

  function resolvePrice(coin) {
    // AI path: Pyth only (never RTI/CEX as spot-for-PTB confusion)
    try {
      if (window.OracleSnapshot?.getPythSpot) {
        const p = window.OracleSnapshot.getPythSpot(coin);
        if (p?.price > 0) return p.price;
      }
    } catch (_) {}
    try {
      if (window.PythBrowser?.getPrice) {
        const p = Number(window.PythBrowser.getPrice(coin));
        if (p > 0) return p;
      }
    } catch (_) {}
    try {
      if (window._pythPrices && window._pythPrices[coin] > 0) return Number(window._pythPrices[coin]);
    } catch (_) {}
    return null;
  }

  function isCanonicalPtbSource(src) {
    const s = String(src || '').toLowerCase();
    if (!s) return true;
    if (/rtds|twap30|title|provisional|coinbase|binance|gecko|rti|crypto-price|boundary|rejected:/.test(s)) {
      return false;
    }
    return /poly|gamma|chainlink|clob|candle|lock|event|openprice|pricetobeat/.test(s);
  }

  function resolvePred(coin) {
    try {
      if (typeof window !== 'undefined') {
        if (window._predictions && window._predictions[coin]) return window._predictions[coin];
        if (window.PredictionEngine && typeof window.PredictionEngine.get === 'function') {
          const p = window.PredictionEngine.get(coin);
          if (p) return p;
        }
        if (window.PredictionEngine && typeof window.PredictionEngine.getAll === 'function') {
          const all = window.PredictionEngine.getAll();
          if (all && all[coin]) return all[coin];
        }
        if (window.Predictions && window.Predictions[coin]) return window.Predictions[coin];
      }
    } catch (_) {}
    return null;
  }

  /** Trim PredictionEngine fields for LLM model-guide blocks */
  function packPredForLlm(pred) {
    if (!pred) return null;
    const score = Number(pred.score);
    const conf = Number(pred.confidence);
    let dir = String(pred.direction || pred.signal || '').toUpperCase();
    if (dir !== 'UP' && dir !== 'DOWN') {
      dir = Number.isFinite(score)
        ? (score > 0.05 ? 'UP' : score < -0.05 ? 'DOWN' : null)
        : null;
    }
    let indicators = null;
    try {
      const raw = pred.indicators || pred.diagnostics?.components || null;
      if (raw && typeof raw === 'object') {
        indicators = {};
        for (const k of Object.keys(raw).slice(0, 16)) {
          const row = raw[k];
          if (row && typeof row === 'object') {
            indicators[k] = {
              label: row.label || null,
              value: row.value != null ? row.value : (row.signal != null ? row.signal : null),
              signal: row.signal != null ? row.signal : null,
            };
          }
        }
      }
    } catch (_) { indicators = null; }
    return {
      direction: dir,
      signal: pred.signal || dir,
      score: Number.isFinite(score) ? score : null,
      confidence: Number.isFinite(conf) ? (conf > 1 ? conf / 100 : conf) : null,
      regime: pred.regime || null,
      agreement: pred.agreement || pred.coreAgreement || null,
      indicators,
    };
  }

  function resolveMarket(coin) {
    try {
      if (window.PredictionMarkets && window.PredictionMarkets.getCoin) {
        return window.PredictionMarkets.getCoin(coin);
      }
    } catch (_) {}
    return null;
  }

  function shouldFire(horizonKey, coin, now) {
    if (_inFlight[horizonKey][coin]) return false;
    if (now - _startedAt < WARMUP_MS) return false;
    const last = Number(_lastTs[horizonKey][coin] || 0);
    const since = last ? (now - last) : Infinity;
    const pack = mem() && mem().memoryPackForPrompt ? mem().memoryPackForPrompt(coin) : null;
    const samples = pack && pack.sampleCount != null ? pack.sampleCount : 0;

    if (horizonKey === '15m') {
      // First call after warmup with any price samples; then floor / min-gap
      if (!last && samples >= 2) return true;
      if (since >= FLOOR_15M_MS) return true;
      if (since >= MIN_GAP_15M_MS && samples >= 4) return true;
      return false;
    }
    // 60m / hourly
    if (!last && samples >= 4) return true;
    if (since >= FLOOR_1H_MS) return true;
    if (since >= MIN_GAP_1H_MS && samples >= 10) return true;
    return false;
  }

  const POLY_15M_COIN_SLUGS = {
    BTC: 'btc', ETH: 'eth', SOL: 'sol', XRP: 'xrp', DOGE: 'doge', HYPE: 'hype', BNB: 'bnb',
  };

  /**
   * Bind 15m Grok to the *active* Polymarket 15m Up/Down market only.
   * Polymarket's "Up" outcome token IS "price finishes up over the window" --
   * unlike Kalshi there's no floor_price/strike_type to interpret, and no
   * inverted-contract case (strikeDir='below'). The window's own open price
   * (priceToBeatNum, itself TWAP-sourced) is the reference, not a strike.
   */
  function buildPoly15m(coin, market) {
    let p = (market && market.poly15m) || null;
    if (!p || !p.slug) {
      try {
        const c = window.PredictionMarkets?.getCoin?.(coin);
        if (c?.poly15m?.slug) p = c.poly15m;
      } catch (_) {}
    }
    if (!p || !p.slug) {
      try {
        const live15 = window.HourlyRangesPanel?.get15mMarket?.(coin);
        if (live15?.slug) p = live15;
      } catch (_) {}
    }

    const now = Date.now();
    let closeMs = p && p.closeTime ? Date.parse(p.closeTime) : NaN;

    // Instant transition to the NEXT 15m window if missing or expired.
    // Pending (no live data yet) rather than fabricating a price -- there's
    // no synthetic PTB to fall back on the way Kalshi's floor_price allowed.
    if (!p || !p.slug || !Number.isFinite(closeMs) || closeMs <= now) {
      let next15mMs = Math.ceil(now / (15 * 60 * 1000)) * (15 * 60 * 1000);
      if (next15mMs <= now) next15mMs += 15 * 60 * 1000;
      const closeIso = new Date(next15mMs).toISOString();
      const prefix = POLY_15M_COIN_SLUGS[coin];
      const slug = prefix ? `${prefix}-updown-15m-${Math.floor(next15mMs / 1000)}` : null;

      p = {
        slug,
        closeTime: closeIso,
        probability: p?.probability ?? null,
        priceToBeatNum: null,
        title: `${coin} Up or Down 15M`,
      };
      closeMs = next15mMs;
    }

    const secondsToClose = Math.max(0, Math.round((closeMs - Date.now()) / 1000));
    const yesProb = Number.isFinite(Number(p.probability)) ? Number(p.probability) : null;
    const rawPtb = Number.isFinite(Number(p.priceToBeatNum)) ? Number(p.priceToBeatNum) : null;
    const ptbSource = p.priceToBeatSource || p.ptbSource || null;
    // AI must only see Polymarket-published PTB — not RTDS/title proxies
    const ptbOk = rawPtb != null && rawPtb > 0 && isCanonicalPtbSource(ptbSource);
    const dec = /^DOGE$/i.test(coin) ? 6 : /^XRP$/i.test(coin) ? 4 : 2;
    const ptb = ptbOk ? Math.round(rawPtb * (10 ** dec)) / (10 ** dec) : null;

    return {
      live: !!(p.slug && yesProb != null),
      slug: p.slug,
      eventTicker: p.slug,
      yesProb: yesProb ?? 0.50,
      noProb: yesProb != null ? Math.max(0.01, Math.min(0.99, 1 - yesProb)) : 0.50,
      closeTime: p.closeTime,
      secondsToClose,
      title: p.title || `${coin} Up or Down 15M`,
      priceToBeatNum: ptb,
      priceToBeatSource: ptbOk ? (ptbSource || 'polymarket') : null,
      targetPrice: ptb != null ? (p.targetPrice || `$${ptb}`) : null,
      targetPriceNum: ptb,
      volume: p.volume != null ? Number(p.volume) : null,
      tradable: true,
      settlementRule: `Polymarket resolves "Up" if ${coin} finishes above Polymarket's published price-to-beat at 15m close.`,
    };
  }

  function buildHourlyLadder(coin, spot) {
    // Polymarket has no live multi-strike hourly-range market today (unlike
    // Kalshi's KX* series), so HourlyRangesPanel always returns its
    // spot-centered synthetic distribution here -- see hourly-ranges-panel.js.
    let ranges = null;
    try {
      if (window.HourlyRangesPanel && typeof window.HourlyRangesPanel.getRanges === 'function') {
        ranges = window.HourlyRangesPanel.getRanges(coin);
      }
    } catch (_) {}
    if (!Array.isArray(ranges) || !ranges.length) return { ladder: [], spotBucket: null };

    const price = Number(spot);
    const ladder = ranges.slice(0, 24).map((r) => ({
      low: Number(r.low),
      high: Number(r.high),
      yesProb: Number(r.prob ?? r.yesAsk ?? r.yesBid) || null,
      yesBid: r.yesBid != null ? Number(r.yesBid) : null,
      yesAsk: r.yesAsk != null ? Number(r.yesAsk) : null,
      ticker: r.ticker || null,
      closeTime: r.closeTime || null,
      isSpot: Number.isFinite(price) && price >= Number(r.low) && price <= Number(r.high),
    }));
    const spotBucket = ladder.find((b) => b.isSpot) || null;
    return { ladder, spotBucket };
  }

  function buildRangeSnapshot(coin, horizonMinutes) {
    const rawPred = resolvePred(coin) || {};
    const pack = packPredForLlm(rawPred) || {};
    const market = resolveMarket(coin) || {};
    const current = resolvePrice(coin);
    const poly15m = buildPoly15m(coin, market);
    // ptb must be computed before memoryPackForPrompt() so ptbDefenseStats can
    // actually query for this level — it silently returns null without it,
    // which meant "PTB defense history: none recorded" regardless of whether
    // the underlying Firestore data existed.
    const sessionMemory = mem()
      ? mem().memoryPackForPrompt(coin, { ptb: poly15m.priceToBeatNum })
      : { sampleCount: 0, sessionMinutes: 0 };
    const { ladder, spotBucket } = buildHourlyLadder(coin, current);
    let xSent = { score: 0, summary: 'n/a', momentum: 'flat' };
    try {
      if (window.SocialSentiment && window.SocialSentiment.getTrend) {
        xSent = window.SocialSentiment.getTrend(coin, 0.5) || xSent;
      }
    } catch (_) {}
    let onChain = null;
    try {
      if (window.OnChainFlow && window.OnChainFlow.packetForGrok) {
        onChain = window.OnChainFlow.packetForGrok(coin);
      }
    } catch (_) {}

    const is15 = Number(horizonMinutes) === 15;
    const modelDir = pack.direction
      || rawPred.direction
      || rawPred.signal
      || (Number.isFinite(Number(rawPred.score)) ? (rawPred.score > 0.05 ? 'UP' : rawPred.score < -0.05 ? 'DOWN' : null) : null);
    const modelScore = Number.isFinite(Number(pack.score ?? rawPred.score)) ? Number(pack.score ?? rawPred.score) : 0;
    const confidence = pack.confidence != null
      ? pack.confidence
      : (rawPred.confidence != null ? Number(rawPred.confidence) : null);
    const conf01 = confidence != null && confidence > 1 ? confidence / 100 : confidence;

    const ptb = poly15m.priceToBeatNum;
    const deltaVsPtb = (current != null && ptb != null) ? current - ptb : null;
    return {
      coin,
      horizonMinutes,
      rangeHorizonMinutes: horizonMinutes,
      rangePrediction: true,
      rangeHorizon: true,
      // Explicit product flags for LLM routing / prompts
      poly15mContract: is15,
      hourlyRanges: !is15,
      venue: is15 ? 'polymarket-15m' : 'polymarket-hourly',
      currentPrice: current,
      price: current,
      priceSource: 'pyth',
      oraclePolicy: 'pyth_spot_plus_polymarket_ptb_only',
      oracleWarnings: is15 && ptb == null ? ['no_polymarket_ptb'] : [],
      direction: modelDir,
      modelDirection: modelDir,
      score: modelScore,
      modelScore: modelScore,
      confidence: conf01,
      regimeLocal: pack.regime || rawPred.regime || null,
      regime: pack.regime || rawPred.regime || null,
      modelAgreement: pack.agreement || null,
      agreement: pack.agreement || null,
      indicators: pack.indicators || rawPred.indicators || null,
      sessionMemory,
      analyticsMemory: sessionMemory,
      // THE contract Grok/ASI1 must analyze for 15m
      poly15m,
      activeContract: is15 ? poly15m : null,
      rangeLadder: ladder,
      spotBucket,
      polymarketOracle: {
        slug: poly15m.slug,
        priceToBeatNum: ptb,
        priceToBeatSource: poly15m.priceToBeatSource || null,
        pythSpot: current,
        pythSource: 'pyth',
        pathDir: deltaVsPtb == null ? null : (Math.abs(deltaVsPtb / (ptb || 1)) < 0.00005 ? 'FLAT' : (deltaVsPtb > 0 ? 'UP' : 'DOWN')),
        deltaVsPtb,
        yesProb: poly15m.yesProb,
        secondsToClose: poly15m.secondsToClose,
        rule: 'PTB is Polymarket window open only. Spot is Pyth only. Do not invent PTB.',
      },
      higherTF: {
        '15m': {
          prob: poly15m.yesProb ?? null,
          slug: poly15m.slug,
          live: poly15m.live,
          priceToBeatNum: poly15m.priceToBeatNum,
          priceToBeatSource: poly15m.priceToBeatSource,
          secondsToClose: poly15m.secondsToClose,
          open: sessionMemory.open15m || null,
          closed: sessionMemory.windows15m || null,
        },
        '60m': {
          open: sessionMemory.open1h || null,
          closed: sessionMemory.windows1h || null,
          accuracy: sessionMemory.predAccuracy1h || null,
          ladderSize: ladder.length,
          spotBucket,
        },
      },
      xSentiment: xSent,
      onChainSideScan: onChain || { note: 'none' },
      market: {
        modelDirection: modelDir,
        modelScore: modelScore,
        score: modelScore,
        confidencePct: conf01 != null ? Math.round(conf01 * 100) : null,
        regime: pack.regime || rawPred.regime || null,
        agreement: pack.agreement || null,
        indicators: pack.indicators || null,
        poly15mYes: poly15m.yesProb,
        poly15mSlug: poly15m.slug,
        priceToBeatNum: ptb,
        priceToBeatSource: poly15m.priceToBeatSource,
      },
      xaiMaxTokens: 1400,
    };
  }

  /** Map price direction UP/DOWN → the Polymarket outcome token to buy */
  function priceDirToYesSide(priceDir) {
    return String(priceDir).toUpperCase() === 'UP' ? 'Up' : 'Down';
  }

  /** Polymarket's Up-token probability IS P(price goes up) -- no inversion. */
  function yesProbToPriceUpProb(yesProb) {
    const y = Number(yesProb);
    return Number.isFinite(y) ? y : null;
  }

  function clamp01(x) {
    return Math.max(0.01, Math.min(0.99, x));
  }

  /**
   * Deterministic 15m call from live contract + model prediction + momentum.
   * Blends quantitative model directional prediction, market YES odds, and spot vs floor.
   */
  function decide15mMechanically(snapshot) {
    const k = snapshot.poly15m || {};
    const spot = Number(snapshot.currentPrice);
    const floor = Number(k.priceToBeatNum);
    const pUpMkt = yesProbToPriceUpProb(k.yesProb);
    const path = Number(snapshot.sessionMemory && snapshot.sessionMemory.pathReturnPct);
    const open15 = snapshot.sessionMemory && snapshot.sessionMemory.open15m;
    const modelDir = snapshot.direction || snapshot.modelDirection;
    const modelScore = Number(snapshot.score ?? snapshot.modelScore ?? 0);
    const modelConf = Number.isFinite(Number(snapshot.confidence)) ? Number(snapshot.confidence) : 0.55;
    let score = 0; // >0 → UP
    const reasons = [];

    // 1. Quantitative Model directional prediction (primary factor: 40% weight)
    if (modelDir === 'UP' || modelDir === 'DOWN') {
      const dirSign = modelDir === 'UP' ? 1 : -1;
      const weight = Math.max(0.3, Math.min(1.0, (modelConf - 0.5) * 2 + Math.abs(modelScore)));
      score += dirSign * weight * 1.5;
      reasons.push(`model=${modelDir} conf=${(modelConf * 100).toFixed(0)}% score=${modelScore.toFixed(3)}`);
    }

    // 2. Polymarket Up-token Probability (35% weight)
    if (Number.isFinite(pUpMkt)) {
      const edge = (pUpMkt - 0.5) * 2; // -1..1
      score += edge * 1.2;
      reasons.push(`mktP(up)=${(pUpMkt * 100).toFixed(1)}%`);
    }

    // 3. Spot vs Price-to-Beat Distance
    if (Number.isFinite(spot) && Number.isFinite(floor) && floor > 0) {
      const bps = ((spot - floor) / floor) * 10000;
      score += Math.max(-0.5, Math.min(0.5, bps / 30));
      reasons.push(`spotVsFloor=${bps.toFixed(1)}bps`);
    }

    // 4. Session Momentum
    if (open15 && Number.isFinite(open15.o) && Number.isFinite(open15.c) && open15.o > 0) {
      const winRet = ((open15.c - open15.o) / open15.o) * 100;
      score += Math.max(-0.4, Math.min(0.4, winRet / 0.15));
      reasons.push(`open15ret=${winRet.toFixed(3)}%`);
    } else if (Number.isFinite(path)) {
      score += Math.max(-0.3, Math.min(0.3, path / 0.2));
      reasons.push(`path=${path.toFixed(3)}%`);
    }

    // Late window: lean harder into market odds (less time for mean reversion)
    const ttc = Number(k.secondsToClose);
    if (Number.isFinite(ttc) && ttc < 180 && Number.isFinite(pUpMkt)) {
      score += (pUpMkt - 0.5) * 0.8;
      reasons.push('late-window-mkt-weight');
    }

    const call = score >= 0 ? 'UP' : 'DOWN';
    const conf = clamp01(0.52 + Math.min(0.38, Math.abs(score) * 0.30));
    return { call, confidence: conf, reasons, score };
  }

  /**
   * Hourly: pick ladder bucket by market YES * proximity * model prediction.
   */
  function decideHourlyMechanically(snapshot) {
    let ladder = Array.isArray(snapshot.rangeLadder) ? snapshot.rangeLadder.slice() : [];
    const spot = Number(snapshot.currentPrice);
    const open1h = snapshot.sessionMemory && snapshot.sessionMemory.open1h;
    const path = Number(snapshot.sessionMemory && snapshot.sessionMemory.pathReturnPct);
    const modelDir = snapshot.direction || snapshot.modelDirection;
    const modelConf = Number.isFinite(Number(snapshot.confidence)) ? Number(snapshot.confidence) : 0.55;

    // Filter out misaligned buckets that are >10% away from current spot price
    if (Number.isFinite(spot) && spot > 0 && ladder.length) {
      const aligned = ladder.filter(b => {
        const mid = (Number(b.low) + Number(b.high)) / 2;
        return Math.abs(mid - spot) <= spot * 0.10;
      });
      if (aligned.length) ladder = aligned;
    }

    if (!ladder.length) {
      const call = modelDir === 'DOWN' ? 'DOWN' : (modelDir === 'UP' ? 'UP' : (Number.isFinite(path) && path < 0 ? 'DOWN' : 'UP'));
      return { call, confidence: 0.52, preferredRange: null, reasons: ['no-ladder'] };
    }

    let best = null;
    let bestScore = -Infinity;
    for (const b of ladder) {
      const mid = (Number(b.low) + Number(b.high)) / 2;
      const width = Math.max(1e-9, Number(b.high) - Number(b.low));
      const yes = Number(b.yesProb);
      const mkt = Number.isFinite(yes) ? yes : 0.15;
      let prox = 1;
      if (Number.isFinite(spot) && Number.isFinite(mid)) {
        const distBuckets = Math.abs(spot - mid) / width;
        prox = Math.exp(-distBuckets * 0.85); // prefer near spot
      }
      let mom = 1;
      if (Number.isFinite(path) && Number.isFinite(spot) && Number.isFinite(mid)) {
        mom = 1 + Math.max(-0.15, Math.min(0.15, (path / 0.5) * (mid >= spot ? 1 : -1) * 0.12));
      }
      // Model direction alignment boost
      let modelBoost = 1.0;
      if (modelDir === 'UP' && Number.isFinite(spot) && Number.isFinite(mid)) {
        modelBoost = mid >= spot ? (1 + (modelConf - 0.5) * 0.4) : (1 - (modelConf - 0.5) * 0.3);
      } else if (modelDir === 'DOWN' && Number.isFinite(spot) && Number.isFinite(mid)) {
        modelBoost = mid <= spot ? (1 + (modelConf - 0.5) * 0.4) : (1 - (modelConf - 0.5) * 0.3);
      }
      const score = mkt * prox * mom * modelBoost;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }

    const hourOpen = open1h && Number.isFinite(open1h.o) ? open1h.o : spot;
    const mid = best ? (Number(best.low) + Number(best.high)) / 2 : spot;
    let call = Number.isFinite(mid) && Number.isFinite(hourOpen) && mid < hourOpen ? 'DOWN' : 'UP';
    if (modelDir === 'UP' || modelDir === 'DOWN') {
      if (modelConf >= 0.65) call = modelDir;
    }
    const conf = clamp01(0.52 + Math.min(0.3, (Number(best && best.yesProb) || 0.2) * 0.4));
    return {
      call,
      confidence: conf,
      preferredRange: best ? {
        low: Number(best.low),
        high: Number(best.high),
        yesProb: best.yesProb != null ? Number(best.yesProb) : null,
        ticker: best.ticker || null,
      } : null,
      reasons: [`bestBucket=${best ? best.low + '-' + best.high : 'n/a'} yes=${best && best.yesProb != null ? (best.yesProb * 100).toFixed(0) + '%' : '?'} model=${modelDir || 'none'}`],
    };
  }

  /** Blend Grok text call with mechanical signal — market structure wins on conflict. */
  function finalizeCall(horizonMinutes, grokCall, snapshot) {
    if (horizonMinutes === 15) {
      const mech = decide15mMechanically(snapshot);
      let call = grokCall === 'UP' || grokCall === 'DOWN' ? grokCall : mech.call;
      // If Grok fights strong market ( |pUp-0.5| > 0.12 ), trust market/mech
      const k = snapshot.poly15m || {};
      const pUp = yesProbToPriceUpProb(k.yesProb);
      if (Number.isFinite(pUp) && Math.abs(pUp - 0.5) >= 0.12) {
        const mktCall = pUp >= 0.5 ? 'UP' : 'DOWN';
        if (call !== mktCall && call !== mech.call) call = mech.call;
        else if (call !== mktCall && Math.abs(pUp - 0.5) >= 0.18) call = mktCall;
      } else if (call !== mech.call && mech.confidence >= 0.62) {
        call = mech.call;
      }
      let conf = Math.max(mech.confidence, 0.52);
      let nullified = false;
      let truthReason = null;
      // Source-of-truth guard: raw PTB path / CLOB / book can hard-nullify AI mid-window
      if (window.InferenceTruthGuard?.evaluate && (grokCall === 'UP' || grokCall === 'DOWN')) {
        const truth = window.InferenceTruthGuard.evaluate({
          call: grokCall,
          confidence: conf,
          sym: snapshot.coin || snapshot.sym,
          horizon: '15m',
          market: {
            sym: snapshot.coin || snapshot.sym,
            horizon: '15m',
            slug: k.slug,
            spot: snapshot.currentPrice || snapshot.price,
            ptb: k.priceToBeatNum,
            yesProb: k.yesProb ?? k.probability,
            mid: k.mid,
            depthImbalance: k.depthImbalance,
            secondsToClose: k.secondsToClose,
            liveDirection: k.liveDirection,
          },
          modelScore: snapshot.score ?? snapshot.modelScore,
        });
        if (truth.nullified) {
          nullified = true;
          call = truth.effectiveCall || mech.call || call;
          conf = Math.max(truth.confidence, 0.55);
          truthReason = truth.reason;
        } else if (truth.soft) {
          conf = Math.max(0.4, conf * (truth.weight || 0.25));
          truthReason = truth.reason;
        }
      }
      return { call, confidence: conf, mech, nullified, truthReason };
    }
    const mech = decideHourlyMechanically(snapshot);
    let call = grokCall === 'UP' || grokCall === 'DOWN' ? grokCall : mech.call;
    if (mech.preferredRange && Number(mech.preferredRange.yesProb) >= 0.22) {
      // stick with scored bucket direction when market is clear on a bucket
      call = mech.call;
    }
    return { call, confidence: Math.max(mech.confidence, 0.52), mech, nullified: false, truthReason: null };
  }

  function parseGrokPriceDir(output, strikeDir = 'above') {
    // The prompt schema REQUIRES structured "call"/"direction" fields ("UP"|"DOWN")
    // — see specialized_prompt.js. Trust those FIRST.
    //
    // Previously this scanned suggestions.notes for the words UP/DOWN/BULL/BEAR/
    // LONG/SHORT *anywhere* in the prose and only consulted output.call as a last
    // resort. Rationale text routinely mentions the opposite side ("momentum is UP
    // but the risk is to the DOWN side", "no SHORT setup here"), and DOWN was tested
    // before UP, so mixed prose silently flipped the card against the model's own
    // call. Keyword-scraping free text cannot see negation or hypotheticals; the
    // structured field can't be misread. Anything unresolved returns null so
    // finalizeCall() falls back to the mechanical market-structure signal, which is
    // a defined fallback rather than a coin flip from prose.
    const structured = String(
      (output && output.call) || (output && output.direction) || ''
    ).trim().toUpperCase();
    if (structured === 'UP' || structured === 'DOWN') return structured;

    const notes = String(
      (output && output.suggestions && output.suggestions.notes) ||
      (output && output.ai_wording && output.ai_wording.primary_rationale) || ''
    ).trim().toUpperCase();
    const isBelow = String(strikeDir).toLowerCase() === 'below';
    // Prefix forms only — the prompt mandates notes START with the call
    // ("BUY UP" / "BUY DOWN" / "WAIT", or UP/DOWN for the range horizons).
    if (/^BUY\s+YES\b/.test(notes)) return isBelow ? 'DOWN' : 'UP';
    if (/^BUY\s+NO\b/.test(notes)) return isBelow ? 'UP' : 'DOWN';
    if (/^(?:BUY\s+)?UP\b/.test(notes)) return 'UP';
    if (/^(?:BUY\s+)?DOWN\b/.test(notes)) return 'DOWN';
    return null;
  }

  function resolvePreferredRange(output, snapshot, call, mech) {
    if (mech && mech.preferredRange) return mech.preferredRange;
    const pr = (output && output.preferredRange) || null;
    const ladder = (snapshot && snapshot.rangeLadder) || [];
    if (pr && Number.isFinite(Number(pr.low)) && Number.isFinite(Number(pr.high))) {
      // Only accept if it matches a ladder row (within $1)
      const match = ladder.find((b) =>
        Math.abs(Number(b.low) - Number(pr.low)) < 1 && Math.abs(Number(b.high) - Number(pr.high)) < 1
      );
      if (match) {
        return {
          low: Number(match.low),
          high: Number(match.high),
          yesProb: match.yesProb != null ? Number(match.yesProb) : (pr.yesProb != null ? Number(pr.yesProb) : null),
          ticker: match.ticker || pr.ticker || null,
        };
      }
    }
    const scored = decideHourlyMechanically(snapshot);
    return scored.preferredRange;
  }

  function _withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error((label || 'request') + ' timeout')), ms)),
    ]);
  }

  async function fire(coin, horizonMinutes) {
    const key = horizonMinutes === 60 ? '60m' : '15m';
    if (!window.electron || typeof window.electron.invoke !== 'function') return;
    if (_inFlight[key][coin]) return;
    _inFlight[key][coin] = true;
    const now = Date.now();
    _lastTs[key][coin] = now;

    try {
      const snapshot = buildRangeSnapshot(coin, horizonMinutes);
      // ASI1 leads pre-contract 15m/60m market analysis (cascade + flags)
      snapshot.preContract = true;
      snapshot.preferAsi1 = true;
      snapshot.rangePrediction = true;
      const sc = snapshot.sessionMemory && snapshot.sessionMemory.sampleCount;

      // 15m: only analyze when we have a live Polymarket 15m market
      if (horizonMinutes === 15) {
        const c = snapshot.poly15m;
        if (!c || !c.slug || !c.live) {
          console.warn(`[GrokRange] skip ${coin} 15m — no live Polymarket 15m market (need PredictionMarkets.getCoin().poly15m)`);
          _guidance[key][coin] = {
            ts: now,
            horizonMinutes: 15,
            error: 'no-live-poly-15m-market',
            poly15m: c || null,
          };
          return;
        }
        console.log(
          `[GrokRange] firing ${coin} 15m (ASI1-primary) ON ${c.slug} yes=${c.yesProb != null ? (c.yesProb * 100).toFixed(1) + '%' : '?'} ttc=${c.secondsToClose}s ptb=${c.priceToBeatNum ?? 'n/a'}`
        );
      } else {
        console.log(`[GrokRange] firing ${coin} ${key} ASI1-primary samples=${sc ?? 0} ladder=${(snapshot.rangeLadder || []).length}`);
      }

      const res = await _withTimeout(
        window.electron.invoke('llm:analyzeSnapshot', snapshot),
        REQUEST_TIMEOUT_MS,
        'range' + key + ':' + coin
      );

      if (res && res.success && res.output) {
        const o = res.output;
        const grokDir = parseGrokPriceDir(o);
        const finalized = finalizeCall(horizonMinutes, grokDir, snapshot);
        let call = finalized.call;
        if (call !== 'UP' && call !== 'DOWN') {
          // Was: call = 'UP' — an unresolved direction rendered as a confident green
          // UP, which is indistinguishable from a real bullish call and made the UI's
          // neutral 'WAIT' state (orange ◆ in render-layer _oneBlock) unreachable.
          // Prefer the mechanical call; only show WAIT when there is genuinely nothing.
          const mechCall = finalized.mech && finalized.mech.call;
          call = (mechCall === 'UP' || mechCall === 'DOWN') ? mechCall : 'WAIT';
        }
        const preferredRange = horizonMinutes === 60
          ? resolvePreferredRange(o, snapshot, call, finalized.mech)
          : null;
        const confRaw = Number(o.confidence);
        const grokConf = Number.isFinite(confRaw)
          ? (confRaw <= 1 ? confRaw : confRaw / 100)
          : null;
        let confidence = clamp01(Math.max(finalized.confidence, grokConf != null ? grokConf : 0));
        if (finalized.nullified) confidence = clamp01(Math.max(finalized.confidence, 0.55));
        const k15 = snapshot.poly15m || {};
        // A non-directional call has no side — emitting Up/Down here would
        // assert a trade the model never made.
        const side = call === 'WAIT' ? null : (horizonMinutes === 15 ? priceDirToYesSide(call) : (call === 'UP' ? 'Up' : 'Down'));
        const polyPeg = horizonMinutes === 15
          ? {
              slug: k15.slug,
              side,
              priceDirection: call,
              yesProb: k15.yesProb,
              priceUpProb: yesProbToPriceUpProb(k15.yesProb),
              priceToBeatNum: k15.priceToBeatNum,
              closeTime: k15.closeTime,
              secondsToClose: k15.secondsToClose,
              settlementRule: k15.settlementRule,
              rationale: finalized.nullified
                ? `TruthGuard nullified AI → price ${call} (${finalized.truthReason || 'raw data'})`
                : `Price ${call} → buy ${side} on ${k15.slug}`,
              mechReasons: (finalized.mech && finalized.mech.reasons) || [],
            }
          : {
              slug: preferredRange && preferredRange.ticker,
              side,
              priceDirection: call,
              rationale: (finalized.mech && finalized.mech.reasons || []).join('; '),
            };
        const notesBase = (o.suggestions && o.suggestions.notes) || '';
        let notes = horizonMinutes === 15
          ? (`${call} ${k15.slug || ''} → ${side}`.trim()
            + ` · mktUp ${k15.yesProb != null ? (k15.yesProb * 100).toFixed(0) + '%' : '?'}`
            + ` · ttc ${k15.secondsToClose ?? '?'}s`
            + (notesBase ? ` — ${notesBase.replace(/^\s*(UP|DOWN)\b\s*/i, '').slice(0, 120)}` : ''))
          : (`${call}`
            + (preferredRange ? ` · bucket $${preferredRange.low}–$${preferredRange.high}` : '')
            + (preferredRange && preferredRange.yesProb != null ? ` · YES ${(preferredRange.yesProb * 100).toFixed(0)}%` : '')
            + (notesBase ? ` — ${notesBase.replace(/^\s*(UP|DOWN)\b\s*/i, '').slice(0, 100)}` : ''));
        if (finalized.nullified) {
          notes = `⛔ NULLIFIED — ${finalized.truthReason || 'raw data'} · effective ${call}. ${notes}`.slice(0, 400);
        }
        const guidance = {
          ts: now,
          // Stamped so render-layer can tell model output from the mechanical
          // fallback (which sets provider:'mechanical'). Note this reports the
          // CONFIGURED provider, not necessarily the one that answered inside the
          // assistant's fallback cascade.
          provider: finalized.nullified
            ? 'raw_data'
            : ((res && res.providerStatus && res.providerStatus.provider) || 'asi1'),
          horizonMinutes,
          call,
          direction: call,
          confidence,
          regime: o.regime || 'unknown',
          range: o.range || preferredRange,
          preferredRange,
          polyPeg,
          poly15m: k15,
          contractSlug: horizonMinutes === 15 ? k15.slug : (preferredRange && preferredRange.ticker),
          notes,
          nullified: !!finalized.nullified,
          truthReason: finalized.truthReason || null,
          aiCallOriginal: (grokDir === 'UP' || grokDir === 'DOWN') ? grokDir : null,
          rationale: (o.ai_wording && o.ai_wording.primary_rationale) || '',
          marketPatterns: (o.ai_wording && o.ai_wording.market_patterns) || '',
          memory: {
            sampleCount: sc,
            sessionMinutes: snapshot.sessionMemory && snapshot.sessionMemory.sessionMinutes,
          },
          raw: o,
        };
        _guidance[key][coin] = guidance;
        _persistGuidance();
        if (mem() && typeof mem().recordPrediction === 'function') {
          mem().recordPrediction(coin, horizonMinutes, {
            call,
            direction: call,
            confidence,
            range: preferredRange || guidance.range,
            suggestions: { notes: guidance.notes },
          });
        }
        try {
          window._grokLive = window._grokLive || {};
          window._grokLive[coin] = {
            ts: now,
            confidence: Math.round(confidence * 100),
            call,
            horizonMinutes,
            preferredRange,
            source: 'polymarket-range-' + key,
          };
        } catch (_) {}
        console.log(`[GrokRange] ${coin} ${key} → ${call} conf=${confidence.toFixed(2)} samples=${sc} peg=${preferredRange ? preferredRange.low + '-' + preferredRange.high : 'n/a'}`);
        try {
          if (typeof window.renderHourlyRanges === 'function' && (window.__weCurrentView === 'hourly-ranges' || document.querySelector('.nav-btn.active')?.dataset?.view === 'hourly-ranges')) {
            window.renderHourlyRanges();
          }
        } catch (_) {}
      } else {
        // LLM failed — still emit a mechanical Polymarket-tied call (no WAIT)
        const finalized = finalizeCall(horizonMinutes, null, snapshot);
        const call = finalized.call === 'DOWN' ? 'DOWN' : 'UP';
        const preferredRange = horizonMinutes === 60
          ? resolvePreferredRange(null, snapshot, call, finalized.mech)
          : null;
        const k15 = snapshot.poly15m || {};
        const side = horizonMinutes === 15 ? priceDirToYesSide(call) : (call === 'UP' ? 'Up' : 'Down');
        _guidance[key][coin] = {
          ts: now,
          horizonMinutes,
          call,
          direction: call,
          confidence: finalized.confidence,
          preferredRange,
          poly15m: k15,
          polyPeg: horizonMinutes === 15 ? {
            slug: k15.slug,
            side,
            priceDirection: call,
            yesProb: k15.yesProb,
            settlementRule: k15.settlementRule,
            rationale: 'mechanical (LLM empty)',
            mechReasons: (finalized.mech && finalized.mech.reasons) || [],
          } : { slug: preferredRange && preferredRange.ticker, side },
          contractSlug: horizonMinutes === 15 ? k15.slug : (preferredRange && preferredRange.ticker),
          notes: horizonMinutes === 15
            ? `${call} ${k15.slug || ''} → ${side} · mechanical (${(res && res.error) || 'empty-llm'})`
            : `${call} · mechanical hourly`,
          provider: 'mechanical',
        };
        console.log(`[GrokRange] ${coin} ${key} mechanical fallback → ${call}`);
      }
    } catch (e) {
      try {
        const snapshot = buildRangeSnapshot(coin, horizonMinutes);
        const finalized = finalizeCall(horizonMinutes, null, snapshot);
        const call = finalized.call === 'DOWN' ? 'DOWN' : 'UP';
        _guidance[key][coin] = {
          ts: now,
          horizonMinutes,
          call,
          direction: call,
          confidence: finalized.confidence,
          notes: `${call} · mechanical after error: ${e && e.message}`,
          provider: 'mechanical',
          poly15m: snapshot.poly15m,
          polyPeg: horizonMinutes === 15 ? {
            slug: snapshot.poly15m && snapshot.poly15m.slug,
            side: priceDirToYesSide(call),
            priceDirection: call,
          } : null,
        };
      } catch (_) {
        _guidance[key][coin] = { ts: now, horizonMinutes, error: e && e.message };
      }
      console.warn('[GrokRange] fire failed', coin, key, e && e.message);
    } finally {
      _inFlight[key][coin] = false;
    }
  }

  async function tick() {
    if (!window.electron) return;
    const m = mem();
    if (m && typeof m.start === 'function') {
      try { m.start(); } catch (_) {}
    }
    const now = Date.now();
    for (const coin of COINS) {
      if (shouldFire('15m', coin, now)) {
        // stagger coins slightly
        await fire(coin, 15);
      }
      if (shouldFire('60m', coin, now)) {
        await fire(coin, 60);
      }
    }
  }

  function getGuidance(coin, horizonMinutes) {
    const key = horizonMinutes === 60 ? '60m' : '15m';
    const g = _guidance[key][coin] || null;
    const now = Date.now();

    // Instant Drop & Transition for expired 15m contract guidance
    if (key === '15m' && g) {
      const k15 = g.polyPeg || g.poly15m;
      const closeMs = k15 && k15.closeTime ? Date.parse(k15.closeTime) : NaN;
      // Age fallback: guidance built when no Polymarket market could be resolved has
      // k15 = {} → closeTime undefined → closeMs NaN, so the close check below can
      // never fire and the entry would live forever, rendering its original call and
      // colour indefinitely. A 15m call cannot outlive its own window.
      const ageMs = now - (Number(g.ts) || 0);
      const expiredByAge = !Number.isFinite(closeMs) && ageMs > STALE_15M_MS;
      if (expiredByAge || (Number.isFinite(closeMs) && closeMs <= now)) {
        delete _guidance['15m'][coin];
        setTimeout(() => { fire(coin, 15).catch(() => {}); }, 50);
        return null;
      }
    }

    if (!g) return null;

    // Sanity check 60m range against live spot price
    if (key === '60m') {
      const spot = resolvePrice(coin);
      if (spot && Number.isFinite(spot) && spot > 0) {
        const rangeObj = g.preferredRange || g.range;
        const low = rangeObj ? Number(rangeObj.low) : NaN;
        const high = rangeObj ? Number(rangeObj.high || low) : NaN;
        const mid = (low + high) / 2;
        if (!Number.isFinite(mid) || Math.abs(mid - spot) > spot * 0.05) {
          // Cached range is misaligned with spot — recalculate from current spot-centered ladder
          try {
            const snapshot = buildRangeSnapshot(coin, 60);
            const mech = decideHourlyMechanically(snapshot);
            if (mech && mech.preferredRange) {
              g.range = mech.preferredRange;
              g.preferredRange = mech.preferredRange;
              g.call = mech.call;
              g.contractTicker = mech.preferredRange.ticker || null;
              g.notes = `${mech.call} · bucket $${mech.preferredRange.low}–$${mech.preferredRange.high}`;
            }
          } catch (_) {}
        }
      }
    }
    return g;
  }

  function getAll() {
    return JSON.parse(JSON.stringify(_guidance));
  }

  // ── Pyth Live Price Queue Engine (Self-Checking Grok Monitor) ────
  const _pythLastPrices = {};
  const _queueJobs = [];
  let _queueProcessing = false;

  class PythGrokCheckQueue {
    constructor() {
      this.initialized = false;
    }

    start() {
      if (this.initialized) return;
      this.initialized = true;

      if (typeof window !== 'undefined') {
        window.addEventListener('pyth:tick', (e) => this.onPythTick(e.detail));
        window.addEventListener('ticker:update', (e) => this.onPythTick(e.detail));
        setInterval(() => this.checkPythPrices(), 1000);
      }
      console.log('[PythGrokCheckQueue] ⚡ Live Pyth Price Queue Engine Active');
    }

    checkPythPrices() {
      for (const coin of COINS) {
        const spot = resolvePrice(coin);
        if (!spot || spot <= 0) continue;
        const last = _pythLastPrices[coin];
        if (!last) {
          _pythLastPrices[coin] = spot;
          continue;
        }

        const diffPct = Math.abs(spot - last) / last;
        const bucketChanged = Math.floor(spot / 100) !== Math.floor(last / 100);

        if (diffPct >= 0.0001 || bucketChanged) {
          _pythLastPrices[coin] = spot;
          this.pushJob(coin, spot, diffPct, bucketChanged);
        }
      }
    }

    onPythTick(updated) {
      if (!updated) return;
      this.checkPythPrices();
    }

    pushJob(coin, spot, diffPct, bucketChanged) {
      if (_queueJobs.length > 5) {
        _queueJobs.splice(0, _queueJobs.length - 5);
      }
      _queueJobs.push({ coin, spot, diffPct, bucketChanged, ts: Date.now() });
      this.processQueue();
    }

    async processQueue() {
      if (_queueProcessing || !_queueJobs.length) return;
      _queueProcessing = true;

      while (_queueJobs.length > 0) {
        const job = _queueJobs.shift();
        try {
          await this.evaluateJob(job);
        } catch (e) {
          console.warn('[PythGrokCheckQueue] job error:', e && e.message);
        }
      }

      _queueProcessing = false;
    }

    async evaluateJob(job) {
      const { coin, spot } = job;
      const snapshot15 = buildRangeSnapshot(coin, 15);
      const k15 = snapshot15.poly15m || {};
      const floor = k15.priceToBeatNum;
      const ttc = Number(k15.secondsToClose);

      // Self-check 15m contract guidance telemetry against live Pyth spot price vs target strike
      const g15 = _guidance['15m'][coin];
      if (g15 && floor && Number.isFinite(floor)) {
        const distToStrike = spot - floor;
        const distPct = (distToStrike / floor) * 100;
        const isAbove = spot >= floor;
        const isBelowContract = String(k15.strikeDir).toLowerCase() === 'below';
        const spotDir = isBelowContract ? (isAbove ? 'DOWN' : 'UP') : (isAbove ? 'UP' : 'DOWN');

        // Only override call in final 15 seconds of expiry if settlement is imminent
        if (Number.isFinite(ttc) && ttc <= 15 && Math.abs(distPct) >= 0.05) {
          g15.call = spotDir;
          g15.confidence = 0.95;
          g15.notes = `⚡ Expiry Lock: Spot $${spot.toFixed(2)} vs Strike $${floor.toFixed(2)} (${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%) → ${spotDir}`;
        } else {
          // Update live telemetry in notes without destroying the AI / model call
          const currentCall = g15.call || spotDir;
          g15.notes = `${currentCall} ${k15.ticker || ''} · Spot $${spot.toFixed(2)} vs Strike $${floor.toFixed(2)} (${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%)`;
        }
      }

      // Self-check 1h Range guidance against live Pyth spot price
      const g60 = _guidance['60m'][coin];
      if (g60) {
        const snapshot60 = buildRangeSnapshot(coin, 60);
        const mech = decideHourlyMechanically(snapshot60);
        if (mech && mech.preferredRange) {
          g60.range = mech.preferredRange;
          g60.preferredRange = mech.preferredRange;
          if (!g60.call) g60.call = mech.call;
          g60.contractTicker = mech.preferredRange.ticker || null;
          g60.notes = `${g60.call} · Spot $${spot.toFixed(2)} → bucket $${mech.preferredRange.low}–$${mech.preferredRange.high}`;
        }
      }

      saveGuidanceCache();
      if (typeof window !== 'undefined' && window.HourlyRangesPanel && typeof window.HourlyRangesPanel.render === 'function') {
        window.HourlyRangesPanel.render();
      }
    }
  }

  const _pythQueue = new PythGrokCheckQueue();
  _pythQueue.start();

  function start() {
    if (_timer) return;
    if (mem() && mem().start) mem().start();
    // Zero cold start: fire immediate tick pass (500ms warmup instead of 50,000ms delay!)
    setTimeout(() => { tick().catch(() => {}); saveGuidanceCache(); }, 500);
    _timer = setInterval(() => { tick().catch(() => {}); saveGuidanceCache(); }, TICK_MS);
    console.log('[GrokRange] ACTIVE — Zero cold start enabled. Coins:', COINS.join(','));
  }

  const api = {
    start,
    tick,
    fire,
    getGuidance,
    getAll,
    buildRangeSnapshot,
  };

  if (typeof window !== 'undefined') {
    window.GrokRangeOverlay = api;
    window.GrokRangeGrok = api;
    if (window.electron) {
      setTimeout(() => {
        try { start(); } catch (e) {
          console.warn('[GrokRange] auto-start failed', e && e.message);
        }
      }, 300);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
