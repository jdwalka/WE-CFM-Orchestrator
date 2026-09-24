/**
 * Range Overlay — ASI1 (asi1.ai) predictions for 15m and hourly ranges.
 *
 * Depends on window.GrokAnalyticsMemory (session accumulator, name kept for
 * compatibility). The longer the app stays open, the more samples/closed
 * windows ASI1 sees in each prompt.
 *
 * Exposes window.GrokRangeGrok / window.GrokRangeOverlay (names kept for
 * compatibility with existing consumers -- inference itself is ASI1-only,
 * routed through LLMSignalAssistant).
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

  /**
   * Bind 15m Grok/ASI1 to the active Kalshi 15m Up/Down contract.
   * Kalshi supplies the strike, strike direction, book, and venue settlement
   * rule directly; no synthetic Polymarket PTB is invented here.
   */
  function buildKalshi15m(coin, market) {
    let p = (market && market.kalshi15m) || null;
    if (!p || !p.ticker) {
      try {
        const coinData = window.PredictionMarkets?.getCoin?.(coin);
        if (coinData?.kalshi15m?.ticker) p = coinData.kalshi15m;
      } catch (_) {}
    }
    if (!p || !p.ticker) {
      try {
        const live15 = window.HourlyRangesPanel?.get15mMarket?.(coin);
        if (live15?.ticker) p = live15;
      } catch (_) {}
    }

    const now = Date.now();
    const closeMs = p?.closeTime ? Date.parse(p.closeTime) : NaN;
    const secondsToClose = Number.isFinite(closeMs)
      ? Math.max(0, Math.round((closeMs - now) / 1000))
      : null;
    const yesProb = Number.isFinite(Number(p?.probability)) ? Number(p.probability) : null;
    const targetPriceNum = Number.isFinite(Number(p?.targetPriceNum)) ? Number(p.targetPriceNum) : null;
    const targetPrice = p?.targetPrice
      || (targetPriceNum != null
        ? (window.CoinPrecision?.formatCoinStrike
          ? window.CoinPrecision.formatCoinStrike(coin, targetPriceNum)
          : `$${targetPriceNum}`)
        : null);

    return {
      live: !!(p?.ticker && yesProb != null && Number.isFinite(closeMs) && closeMs > now),
      venue: 'kalshi',
      ticker: p?.ticker || null,
      slug: p?.ticker || null,
      eventTicker: p?.ticker || null,
      yesProb: yesProb ?? 0.50,
      noProb: yesProb != null ? Math.max(0.01, Math.min(0.99, 1 - yesProb)) : 0.50,
      closeTime: p?.closeTime || null,
      secondsToClose,
      title: p?.title || `${coin} Up or Down 15M`,
      strikeDir: p?.strikeDir || null,
      strikeType: p?.strikeType || null,
      floorPrice: p?.floorPrice ?? null,
      capPrice: p?.capPrice ?? null,
      targetPrice,
      targetPriceNum,
      bestBid: p?.yesBid ?? p?.bestBid ?? null,
      bestAsk: p?.yesAsk ?? p?.bestAsk ?? null,
      volume: p?.volume != null ? Number(p.volume) : null,
      liquidity: p?.liquidity != null ? Number(p.liquidity) : null,
      tradable: p?.tradable !== false,
      settlementVenue: 'CF Benchmarks RTI',
      settlementRule: 'Kalshi 15m settles against the 60-second CF Benchmarks RTI average before expiry.',
    };
  }
  /**
   * Bind 15m Grok/ASI1 to the active Kalshi 15m Up/Down contract.
   * Kalshi supplies the strike, strike direction, book, and venue settlement
   * rule directly; no synthetic Polymarket PTB is invented here.
   */
  function buildKalshi15m(coin, market) {
    let p = (market && market.kalshi15m) || null;
    if (!p || !p.ticker) {
      try {
        const coinData = window.PredictionMarkets?.getCoin?.(coin);
        if (coinData?.kalshi15m?.ticker) p = coinData.kalshi15m;
      } catch (_) {}
    }

    const now = Date.now();
    const closeMs = p?.closeTime ? Date.parse(p.closeTime) : NaN;
    const secondsToClose = Number.isFinite(closeMs)
      ? Math.max(0, Math.round((closeMs - now) / 1000))
      : null;
    const yesProb = Number.isFinite(Number(p?.probability)) ? Number(p.probability) : null;
    const targetPriceNum = Number.isFinite(Number(p?.targetPriceNum)) ? Number(p.targetPriceNum) : null;
    const targetPrice = p?.targetPrice
      || (targetPriceNum != null
        ? (window.CoinPrecision?.formatCoinStrike
          ? window.CoinPrecision.formatCoinStrike(coin, targetPriceNum)
          : `$${targetPriceNum}`)
        : null);

    return {
      live: !!(p?.ticker && yesProb != null && Number.isFinite(closeMs) && closeMs > now),
      venue: 'kalshi',
      ticker: p?.ticker || null,
      slug: p?.ticker || null,
      eventTicker: p?.ticker || null,
      yesProb: yesProb ?? 0.50,
      noProb: yesProb != null ? Math.max(0.01, Math.min(0.99, 1 - yesProb)) : 0.50,
      closeTime: p?.closeTime || null,
      secondsToClose,
      title: p?.title || `${coin} Up or Down 15M`,
      strikeDir: p?.strikeDir || null,
      strikeType: p?.strikeType || null,
      floorPrice: p?.floorPrice ?? null,
      capPrice: p?.capPrice ?? null,
      targetPrice,
      targetPriceNum,
      bestBid: p?.yesBid ?? p?.bestBid ?? null,
      bestAsk: p?.yesAsk ?? p?.bestAsk ?? null,
      volume: p?.volume != null ? Number(p.volume) : null,
      liquidity: p?.liquidity != null ? Number(p.liquidity) : null,
      tradable: p?.tradable !== false,
      settlementVenue: 'CF Benchmarks RTI',
      settlementRule: 'Kalshi 15m settles against the 60-second CF Benchmarks RTI average before expiry.',
    };
  }
  function buildHourlyLadder(coin, spot) {
    // Kalshi owns the hourly/15m product surface. HourlyRangesPanel supplies
    // the synthetic range distribution used for the hourly pre-contract view;
    // live 15m venue quotes come from PredictionMarkets.kalshi15m.
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

  function _normalCdf(value) {
    const sign = value < 0 ? -1 : 1;
    const x = Math.abs(value) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
  }

  function estimateKalshi15mFair(contract, currentPrice, prediction) {
    if (!contract || !contract.ticker) return null;
    const isLive = contract.live !== false && (contract.live === true || contract.status === 'open' || contract.status === 'active' || !contract.status);
    if (!isLive) return null;

    let current = Number(currentPrice);
    if (!Number.isFinite(current) || current <= 0) {
      const sym = contract.coin || contract.sym || (contract.ticker ? contract.ticker.slice(2, 5) : null);
      if (sym) current = resolvePrice(sym);
    }

    let target = Number(contract.targetPriceNum || contract.priceToBeatNum || contract.floorPrice || contract.floor_strike || contract.strike);
    if (!Number.isFinite(target) || target <= 0) {
      if (contract.targetPrice) {
        const numMatch = String(contract.targetPrice).replace(/[$,]/g, '').match(/\d+\.?\d*/);
        if (numMatch) target = parseFloat(numMatch[0]);
      }
    }

    let secondsToClose = Number(contract.secondsToClose);
    if (!Number.isFinite(secondsToClose) || secondsToClose <= 0) {
      if (contract.closeTime) {
        secondsToClose = (new Date(contract.closeTime).getTime() - Date.now()) / 1000;
      }
    }
    secondsToClose = Math.max(5, secondsToClose || 5);

    if (!Number.isFinite(current) || current <= 0
      || !Number.isFinite(target) || target <= 0
      || !Number.isFinite(secondsToClose) || secondsToClose <= 0) {
      return null;
    }

    const atrPctRaw = Number(prediction?.volatility?.atrPct);
    const atrPct = Number.isFinite(atrPctRaw) && atrPctRaw > 0
      ? atrPctRaw / 100
      : 0.0055;
    const remainingFraction = Math.max(0.02, Math.min(1, secondsToClose / 900));
    const sigma = current * atrPct * Math.sqrt(remainingFraction);
    const z = (current - target) / (sigma || 1);
    const pAbove = _normalCdf(z);
    const strikeDir = String(contract.strikeDir || '').toLowerCase();
    const probability = strikeDir === 'below' ? 1 - pAbove : pAbove;
    const fairCents = Math.max(1, Math.min(99, probability * 100));
    const rawAsk = contract.bestAsk != null ? contract.bestAsk : contract.yesAsk;
    const askCents = Number.isFinite(Number(rawAsk))
      ? (Number(rawAsk) <= 1.0 ? Number(rawAsk) * 100 : Number(rawAsk))
      : null;
    const residualCents = askCents != null ? askCents - fairCents : null;

    return {
      model_fair_cents: Math.round(fairCents * 10) / 10,
      residual_cents: residualCents == null ? null : Math.round(residualCents * 10) / 10,
      flagged: residualCents != null && residualCents > 5,
      fair_status: askCents != null ? 'ok' : 'fair_only',
      p_up: Math.round(probability * 1000) / 1000,
      sigma_points: sigma,
      seconds_to_close: Math.round(secondsToClose),
      settlement_venue: 'CF Benchmarks RTI',
      settlement_rule: '60-second CF Benchmarks RTI average before expiry',
    };
  }

  function buildRangeSnapshot(coin, horizonMinutes) {
    const rawPred = resolvePred(coin) || {};
    const pack = packPredForLlm(rawPred) || {};
    const market = resolveMarket(coin) || {};
    const current = resolvePrice(coin);
    const is15 = Number(horizonMinutes) === 15;
    // Backward-compatible alias for legacy 15m consumers only.
    const kalshi15m = buildKalshi15m(coin, market);
    kalshi15m.model_fair = estimateKalshi15mFair(kalshi15m, current, rawPred);
    // Backward-compatible alias for legacy consumers. 15m is a Kalshi venue;
    // new code must read `kalshi15m`.
    const poly15m = kalshi15m;
    // ptb must be computed before memoryPackForPrompt() so ptbDefenseStats can
    // actually query for this level — it silently returns null without it,
    // which meant "PTB defense history: none recorded" regardless of whether
    // the underlying Firestore data existed.
    const sessionMemory = mem()
      ? mem().memoryPackForPrompt(coin, {
      ptb: is15 ? poly15m.priceToBeatNum : null,
      ptb15: is15 ? poly15m.priceToBeatNum : null,
      ptb: is15 ? poly15m.priceToBeatNum : null,
      ptb15: is15 ? poly15m.priceToBeatNum : null,
        ptb5: Number(market.poly5m && (market.poly5m.priceToBeatNum || market.poly5m.targetPriceNum)) || null,
      })
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

    const modelDir = pack.direction
      || rawPred.direction
      || rawPred.signal
      || (Number.isFinite(Number(rawPred.score)) ? (rawPred.score > 0.05 ? 'UP' : rawPred.score < -0.05 ? 'DOWN' : null) : null);
    const modelScore = Number.isFinite(Number(pack.score ?? rawPred.score)) ? Number(pack.score ?? rawPred.score) : 0;
    const confidence = pack.confidence != null
      ? pack.confidence
      : (rawPred.confidence != null ? Number(rawPred.confidence) : null);
    const conf01 = confidence != null && confidence > 1 ? confidence / 100 : confidence;

    const ptb = is15 ? poly15m.priceToBeatNum : null;
    const deltaVsPtb = (current != null && ptb != null) ? current - ptb : null;
    return {
      coin,
      horizonMinutes,
      rangeHorizonMinutes: horizonMinutes,
      rangePrediction: true,
      rangeHorizon: true,
      // Explicit product flags for LLM routing / prompts
      kalshi15mContract: is15,
      poly15mContract: is15,
      hourlyRanges: !is15,
      fixedIntervalMinutes: is15 ? 15 : 60,
      fixedInterval: true,
      fixedIntervalRule: 'Price is bucketed to a fixed 60-minute interval; do not reinterpret it as an arbitrary range.',
      hourlyBuckets: ladder,
      activeBucket: spotBucket,
      venue: is15 ? 'kalshi-15m' : 'kalshi-hourly',
      kalshi15mContract: is15,
      poly15mContract: is15,
      hourlyRanges: !is15,
      fixedIntervalMinutes: is15 ? 15 : 60,
      fixedInterval: true,
      fixedIntervalRule: 'Price is bucketed to a fixed 60-minute interval; do not reinterpret it as an arbitrary range.',
      hourlyBuckets: ladder,
      activeBucket: spotBucket,
      venue: is15 ? 'kalshi-15m' : 'kalshi-hourly',
      currentPrice: current,
      price: current,
      priceSource: 'pyth',
      oraclePolicy: 'pyth_spot_plus_kalshi_rti_strike_only',
      oracleWarnings: is15 && ptb == null ? ['no_kalshi_strike'] : [],
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
      kalshi15m,
      poly15m,
      activeContract: is15 ? kalshi15m : null,
      rangeLadder: ladder,
      spotBucket,
      kalshiOracle: is15 ? {
        ticker: kalshi15m.ticker,
        targetPriceNum: ptb,
        strikeDir: kalshi15m.strikeDir,
        pythSpot: current,
        pythSource: 'pyth',
        pathDir: deltaVsPtb == null ? null : (Math.abs(deltaVsPtb / (ptb || 1)) < 0.00005 ? 'FLAT' : (deltaVsPtb > 0 ? 'UP' : 'DOWN')),
        deltaVsPtb,
        yesProb: kalshi15m.yesProb,
        secondsToClose: kalshi15m.secondsToClose,
        settlementVenue: kalshi15m.settlementVenue,
        model_fair: kalshi15m.model_fair,
        rule: 'Kalshi strike/RTI is authoritative. Spot is Pyth only. Do not invent the strike.',
      } : null,
      higherTF: {
        '5m': {
          carry: sessionMemory.ptbCarry15m || null,
          lastSample: sessionMemory.lastSample || null,
          defense: sessionMemory.localPtbDefense5m || null,
          fiveMinCall: (function () {
            try {
              return window.FiveMinGrok?.getGuidance?.(coin)
                || window.FiveMinClaude?.getGuidance?.(coin)
                || null;
            } catch (_) { return null; }
          })(),
        },
        '15m': is15 ? {
          prob: kalshi15m.yesProb ?? null,
          ticker: kalshi15m.ticker,
          slug: kalshi15m.ticker,
          live: kalshi15m.live,
          targetPriceNum: kalshi15m.targetPriceNum,
          priceToBeatNum: kalshi15m.targetPriceNum,
          strikeDir: kalshi15m.strikeDir,
          secondsToClose: kalshi15m.secondsToClose,
          open: sessionMemory.open15m || null,
          closed: sessionMemory.windows15m || null,
        } : null,
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
        priceToBeatNum: ptb,
        kalshi15mYes: kalshi15m.yesProb,
        kalshi15mTicker: kalshi15m.ticker,
        kalshi15mModelFairCents: kalshi15m.model_fair?.model_fair_cents ?? null,
        kalshi15mResidualCents: kalshi15m.model_fair?.residual_cents ?? null,
        poly15mYes: kalshi15m.yesProb,
        poly15mSlug: kalshi15m.ticker,
        priceToBeatNum: ptb,
        strikeDir: kalshi15m.strikeDir,
        priceToBeatNum: ptb,
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
  function livePathFromSnapshot(snapshot) {
    const api = (typeof window !== 'undefined' && window.LivePath15m) || null;
    if (!api) return null;
    if (typeof api.fromAny === 'function') return api.fromAny(snapshot);
    if (typeof api.resolve !== 'function') return null;
    const k = snapshot.poly15m || {};
    return api.resolve(snapshot.coin || snapshot.sym, {
      spot: snapshot.currentPrice || snapshot.price,
      poly15m: k,
      open15: snapshot.sessionMemory && snapshot.sessionMemory.open15m,
      modelScore: snapshot.score ?? snapshot.modelScore,
      liveDirection: k.liveDirection,
      settlementLiveDirection: k.settlementLiveDirection,
    });
  }

  function attachLivePathToGuidance(coin, g) {
    if (!g) return g;
    try {
      const snap = buildRangeSnapshot(coin, 15);
      const live = livePathFromSnapshot(snap);
      if (!live) return g;
      g.livePath = live;
      if (live.dir) {
        if (!g.aiCall && (g.call === 'UP' || g.call === 'DOWN')) g.aiCall = g.call;
        g.displayCall = live.dir;
        g.call = live.dir;
      }
    } catch (_) { /* */ }
    return g;
  }

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

    const live = livePathFromSnapshot(snapshot);
    if (live && live.dir) {
      const liveSign = live.dir === 'UP' ? 1 : -1;
      score += liveSign * Math.max(1.1, (live.confidence || 0.6) * 2.2);
      reasons.push(`livePath=${live.dir} ${live.reason}`);
    }

    // Settlement path (spot vs PTB) dominates. Old weights let the model
    // (×1.5) drown a ±0.5 capped PTB term, so the painted color only
    // flipped on extreme swings.
    if (Number.isFinite(spot) && Number.isFinite(floor) && floor > 0) {
      const bps = ((spot - floor) / floor) * 10000;
      score += Math.max(-1.8, Math.min(1.8, bps / 8));
      reasons.push(`spotVsFloor=${bps.toFixed(1)}bps`);
    }

    if (open15 && Number.isFinite(open15.o) && Number.isFinite(open15.c) && open15.o > 0) {
      const winRet = ((open15.c - open15.o) / open15.o) * 100;
      score += Math.max(-0.6, Math.min(0.6, winRet / 0.12));
      reasons.push(`open15ret=${winRet.toFixed(3)}%`);
    } else if (Number.isFinite(path)) {
      score += Math.max(-0.4, Math.min(0.4, path / 0.18));
      reasons.push(`path=${path.toFixed(3)}%`);
    }

    if (Number.isFinite(pUpMkt)) {
      const edge = (pUpMkt - 0.5) * 2;
      score += edge * 0.55;
      reasons.push(`mktP(up)=${(pUpMkt * 100).toFixed(1)}%`);
    }

    if (modelDir === 'UP' || modelDir === 'DOWN') {
      const dirSign = modelDir === 'UP' ? 1 : -1;
      const weight = Math.max(0.15, Math.min(0.45, (modelConf - 0.5) + Math.abs(modelScore) * 0.3));
      score += dirSign * weight;
      reasons.push(`model=${modelDir} (weak)`);
    }

    const ttc = Number(k.secondsToClose);
    if (Number.isFinite(ttc) && ttc < 180 && Number.isFinite(spot) && Number.isFinite(floor) && floor > 0) {
      const bps = ((spot - floor) / floor) * 10000;
      score += Math.max(-0.8, Math.min(0.8, bps / 6));
      reasons.push('late-window-path-weight');
    }

    if (live && live.dir && Math.abs(live.bps || 0) >= 0.8) {
      return { call: live.dir, confidence: live.confidence, reasons, score, livePath: live };
    }
    const call = score >= 0 ? 'UP' : 'DOWN';
    const conf = clamp01(0.52 + Math.min(0.38, Math.abs(score) * 0.30));
    return { call, confidence: conf, reasons, score, livePath: live };
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
      return {
        call,
        confidence: 0.52,
        preferredBucket: null,
        preferredRange: null,
        reasons: ['no-hourly-bucket'],
      };
      return {
        call,
        confidence: 0.52,
        preferredBucket: null,
        preferredRange: null,
        reasons: ['no-hourly-bucket'],
      };
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
      preferredBucket: best ? {
        low: Number(best.low),
        high: Number(best.high),
        yesProb: best.yesProb != null ? Number(best.yesProb) : null,
        ticker: best.ticker || null,
      } : null,
      preferredRange: best ? {
        low: Number(best.low),
        high: Number(best.high),
        yesProb: best.yesProb != null ? Number(best.yesProb) : null,
        ticker: best.ticker || null,
      } : null,
      preferredBucket: best ? {
        low: Number(best.low),
        high: Number(best.high),
        yesProb: best.yesProb != null ? Number(best.yesProb) : null,
        ticker: best.ticker || null,
      } : null,
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
      const live = mech.livePath || livePathFromSnapshot(snapshot);
      // Live settlement path paints the label. Grok/model is a lean, not a lock.
      let call = (live && live.dir) || mech.call || ((grokCall === 'UP' || grokCall === 'DOWN') ? grokCall : null);
      const k = snapshot.poly15m || {};
      const pUp = yesProbToPriceUpProb(k.yesProb);
      if (!(live && live.dir) && Number.isFinite(pUp) && Math.abs(pUp - 0.5) >= 0.08) {
        call = pUp >= 0.5 ? 'UP' : 'DOWN';
      } else if (!(live && live.dir) && call !== mech.call && mech.confidence >= 0.58) {
        call = mech.call;
      }
      if (!call) call = grokCall === 'DOWN' ? 'DOWN' : 'UP';
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
    if (mech.preferredBucket && Number(mech.preferredBucket.yesProb) >= 0.22) {
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
    if (mech && mech.preferredBucket) return mech.preferredBucket;
    const pr = (output && (output.preferredBucket || output.preferredRange)) || null;
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
    return decideHourlyMechanically(snapshot).preferredBucket;
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

      // 15m: only analyze when we have a live Kalshi 15m market
      if (horizonMinutes === 15) {
        const c = snapshot.kalshi15m;
        if (!c || !c.ticker || !c.live) {
          console.warn(`[GrokRange] skip ${coin} 15m — no live Kalshi 15m market (need PredictionMarkets.getCoin().kalshi15m)`);
          _guidance[key][coin] = {
            ts: now,
            horizonMinutes: 15,
            error: 'no-live-kalshi-15m-market',
            kalshi15m: c || null,
            poly15m: c || null,
          };
          return;
        }
        console.log(
          `[GrokRange] firing ${coin} 15m (ASI1-primary) ON ${c.ticker} yes=${c.yesProb != null ? (c.yesProb * 100).toFixed(1) + '%' : '?'} ttc=${c.secondsToClose}s strike=${c.targetPriceNum ?? 'n/a'}`
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
          aiCall: (grokDir === 'UP' || grokDir === 'DOWN') ? grokDir : null,
          direction: call,
          confidence,
          regime: o.regime || 'unknown',
          range: o.range || preferredRange,
          preferredBucket: preferredRange,
          preferredRange,
          regime: o.regime || 'unknown',
          range: o.range || preferredRange,
          preferredBucket: preferredRange,
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
          preferredBucket: preferredRange,
          preferredRange,
          direction: call,
          confidence: finalized.confidence,
          preferredBucket: preferredRange,
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
          preferredBucket: horizonMinutes === 60 ? (finalized.mech && finalized.mech.preferredBucket) : null,
          confidence: finalized.confidence,
          notes: `${call} · mechanical after error: ${e && e.message}`,
          provider: 'mechanical',
          preferredBucket: horizonMinutes === 60 ? (finalized.mech && finalized.mech.preferredBucket) : null,
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
    if (key === '15m') attachLivePathToGuidance(coin, g);

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
            if (mech && mech.preferredBucket) {
              g.range = mech.preferredBucket;
              g.preferredBucket = mech.preferredBucket;
              g.preferredRange = mech.preferredBucket;
              g.call = mech.call;
              g.contractTicker = mech.preferredBucket.ticker || null;
              g.notes = `${mech.call} · fixed 60m bucket $${mech.preferredBucket.low}–$${mech.preferredBucket.high}`;
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

        if (!g15.aiCall && (g15.call === 'UP' || g15.call === 'DOWN')) g15.aiCall = g15.call;
        const live = livePathFromSnapshot(snapshot15);
        const paint = (live && live.dir) || spotDir;
        g15.livePath = live;
        g15.displayCall = paint;
        g15.call = paint;
        const aiBit = g15.aiCall && g15.aiCall !== paint ? ` · grok ${g15.aiCall}` : '';
        if (Number.isFinite(ttc) && ttc <= 15 && Math.abs(distPct) >= 0.03) {
          g15.confidence = 0.95;
          g15.notes = `⚡ Expiry Lock: Spot $${spot.toFixed(2)} vs Strike $${floor.toFixed(2)} (${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%) → ${paint}${aiBit}`;
        } else {
          g15.notes = `LIVE ${paint}${aiBit} · Spot $${spot.toFixed(2)} vs Strike $${floor.toFixed(2)} (${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%)`;
        }
      }

      // Self-check 1h Range guidance against live Pyth spot price
      const g60 = _guidance['60m'][coin];
      if (g60) {
        const snapshot60 = buildRangeSnapshot(coin, 60);
        const mech = decideHourlyMechanically(snapshot60);
        if (mech && mech.preferredBucket) {
          g60.range = mech.preferredBucket;
          g60.preferredBucket = mech.preferredBucket;
          g60.preferredRange = mech.preferredBucket;
          if (!g60.call) g60.call = mech.call;
          g60.contractTicker = mech.preferredBucket.ticker || null;
          g60.notes = `${g60.call} · Spot $${spot.toFixed(2)} → fixed 60m bucket $${mech.preferredBucket.low}–$${mech.preferredBucket.high}`;
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
    livePathFromSnapshot,
    get15mModelFair(contract, currentPrice, prediction) {
      return estimateKalshi15mFair(contract, currentPrice, prediction || resolvePred(contract?.coin));
    },
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
