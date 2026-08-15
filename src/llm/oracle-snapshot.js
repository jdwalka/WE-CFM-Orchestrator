/**
 * Oracle Snapshot — STRICT sources for LLM inference
 * --------------------------------------------------
 * Spot  = Pyth only (Lazer / Hermes / _pythPrices / PythBrowser)
 * PTB   = Polymarket only (poly5m / poly15m priceToBeatNum from Gamma/chainlink-candles)
 * Odds  = Polymarket CLOB/Gamma only
 * Hourly = HourlyRangesPanel ladder when available
 *
 * Never use Coinbase/Binance/RTI/Gecko as PTB or as primary spot for AI prompts.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.OracleSnapshot = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** BTC/ETH/SOL/BNB/HYPE → 2dp; XRP/DOGE → 4dp. No float trails for AI/UI. */
  function priceDecimals(sym, value) {
    const s = String(sym || '').toUpperCase();
    if (s === 'BTC' || s === 'ETH' || s === 'BNB' || s === 'SOL' || s === 'HYPE') return 2;
    if (s === 'XRP' || s === 'DOGE') return 4;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && n < 1) return 4;
    return 2;
  }

  function roundPrice(sym, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const d = priceDecimals(sym, n);
    const f = 10 ** d;
    return Math.round(n * f) / f;
  }

  function formatUsd(sym, value) {
    const n = roundPrice(sym, value);
    if (n == null) return null;
    const d = priceDecimals(sym, n);
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
      useGrouping: true,
    });
  }

  /**
   * Strict Pyth spot. Returns { price, source, ts } or null.
   */
  function getPythSpot(sym) {
    const key = String(sym || '').toUpperCase();
    if (!key || typeof window === 'undefined') return null;

    // 1) PythBrowser helper
    try {
      if (window.PythBrowser?.getPrice) {
        const p = num(window.PythBrowser.getPrice(key));
        if (p != null && p > 0) {
          return { price: p, source: 'pyth-browser', ts: Date.now() };
        }
      }
    } catch (_) { /* */ }

    // 2) Live tick map from Hermes/Lazer bridge
    try {
      const raw = window._pythPrices?.[key];
      if (typeof raw === 'number' && raw > 0) {
        const meta = window._pythPythMetadata?.[key];
        return {
          price: raw,
          source: 'pyth-hermes',
          ts: meta?.publishTime || Date.now(),
        };
      }
      if (raw && typeof raw === 'object') {
        const p = num(raw.price ?? raw.value);
        if (p != null && p > 0) {
          return {
            price: p,
            source: raw.source || 'pyth-object',
            ts: raw.timestamp || raw.publishTime || Date.now(),
          };
        }
      }
    } catch (_) { /* */ }

    // 3) PredictionMarkets Pyth accessor only (must be pyth-tagged)
    try {
      if (window.PredictionMarkets?.getPythPrice) {
        const r = window.PredictionMarkets.getPythPrice(key);
        const p = num(r?.price ?? r);
        if (p != null && p > 0) {
          return { price: p, source: r?.source || 'prediction-markets-pyth', ts: r?.timestamp || Date.now() };
        }
      }
      // getFresh style snapshot if exposed
      if (window.PredictionMarkets?.getFreshPyth) {
        const r = window.PredictionMarkets.getFreshPyth(key);
        const p = num(r?.price);
        if (p != null && p > 0) {
          return { price: p, source: r?.source || 'pyth-fresh', ts: r?.timestamp || Date.now() };
        }
      }
    } catch (_) { /* */ }

    // 4) pythLazer last tick
    try {
      const tick = window.pythLazer?.getLatestTickers?.()?.[key]
        || window.pythLazer?.last?.[key];
      const p = num(tick?.price ?? tick);
      if (p != null && p > 0) {
        return { price: p, source: 'pyth-lazer', ts: tick?.timestamp || Date.now() };
      }
    } catch (_) { /* */ }

    return null;
  }

  /**
   * Polymarket window only — never invent PTB.
   * @param {'5m'|'15m'} horizon
   */
  function getPolymarketWindow(sym, horizon) {
    const key = String(sym || '').toUpperCase();
    const coin = (typeof window !== 'undefined' && window.PredictionMarkets?.getCoin?.(key)) || {};
    const m = horizon === '5m' ? (coin.poly5m || null) : (coin.poly15m || null);
    if (!m || !m.slug) return null;

    // PTB: only explicit Polymarket fields (chainlink-candles / gamma lock)
    const ptbRaw = num(m.priceToBeatNum ?? m.targetPriceNum);
    const ptb = ptbRaw != null ? roundPrice(key, ptbRaw) : null;
    const yes = num(m.probability ?? m.upProbability ?? m.yesProb ?? m.clobProbability);
    const closeMs = m.closeTime ? Date.parse(m.closeTime) : NaN;
    const ttc = Number.isFinite(closeMs)
      ? Math.max(0, Math.round((closeMs - Date.now()) / 1000))
      : (num(m.secondsToClose) != null ? Math.max(0, Math.round(num(m.secondsToClose))) : null);

    // Reject expired windows for inference (stale PTB is the usual bug)
    if (Number.isFinite(closeMs) && closeMs <= Date.now() - 5_000) {
      return {
        valid: false,
        reason: 'window_expired',
        slug: m.slug,
        horizon,
        priceToBeatNum: null,
        priceToBeatSource: null,
      };
    }

    // Canonical Polymarket PTB only. Reject RTDS TWAP / title / provisional proxies
    // that are NOT what Polymarket's UI labels "Price to Beat".
    const ptbSource = String(m.priceToBeatSource || m.ptbSource || m._ptbSource || '').toLowerCase();
    const rejected = /rtds|twap30|title|provisional|coinbase|binance|gecko|rti|crypto-price|boundary|rejected:/.test(ptbSource);
    const allowedSource = !rejected && (
      !ptbSource
      || /poly|gamma|chainlink|clob|candle|lock|event|openprice|pricetobeat/.test(ptbSource)
    );

    const ptbOk = ptb != null && ptb > 0 && allowedSource;

    return {
      valid: true,
      horizon,
      slug: m.slug,
      title: m.title || null,
      live: m.live !== false && yes != null,
      yesProb: yes,
      priceToBeatNum: ptbOk ? ptb : null,
      priceToBeatRaw: ptbOk ? ptbRaw : null,
      priceToBeatSource: ptbOk
        ? (ptbSource || 'polymarket')
        : (ptbRaw != null ? `rejected:${ptbSource || 'unknown'}` : null),
      targetPrice: ptbOk ? formatUsd(key, ptb) : null,
      priceDecimals: priceDecimals(key, ptb || 1),
      secondsToClose: ttc,
      closeTime: m.closeTime || null,
      bestBid: num(m.bestBid),
      bestAsk: num(m.bestAsk),
      mid: num(m.mid),
      spread: num(m.spread),
      depthImbalance: num(m.depthImbalance),
      nearTouchNotional: num(m.nearTouchNotional),
      bidDepthNotional: num(m.bidDepthNotional),
      askDepthNotional: num(m.askDepthNotional),
      liveDirection: m.liveDirection || null,
      clobUpAssetId: m.clobUpAssetId || null,
      clobDownAssetId: m.clobDownAssetId || null,
      settlementRule: `Polymarket ${horizon}: Up if ${key} finishes above window open (price-to-beat / TWAP) at close.`,
    };
  }

  /**
   * Hourly range ladder from HourlyRangesPanel (spot-centered Polymarket-era synthetic).
   */
  function getHourlyLadder(sym, pythSpot) {
    const key = String(sym || '').toUpperCase();
    let ranges = null;
    try {
      if (typeof window !== 'undefined' && window.HourlyRangesPanel?.getRanges) {
        ranges = window.HourlyRangesPanel.getRanges(key);
      }
    } catch (_) { /* */ }
    if (!Array.isArray(ranges) || !ranges.length) {
      return { ladder: [], spotBucket: null, source: 'none' };
    }
    const price = num(pythSpot);
    const ladder = ranges.slice(0, 16).map((r) => ({
      low: num(r.low),
      high: num(r.high),
      yesProb: num(r.prob ?? r.yesAsk ?? r.yesBid),
      yesBid: num(r.yesBid),
      yesAsk: num(r.yesAsk),
      ticker: r.ticker || null,
      closeTime: r.closeTime || null,
      isSpot: price != null && price >= Number(r.low) && price <= Number(r.high),
    }));
    return {
      ladder,
      spotBucket: ladder.find((b) => b.isSpot) || null,
      source: 'hourly-ranges-panel',
    };
  }

  /**
   * Full oracle-strict packet for ASI1 / TokenMix / relay.
   */
  /**
   * Non-authoritative supplementary momentum signal from the Redpanda/Kafka
   * orbital pipeline (server-side, Firestore-bridged). Never spot/PTB — those
   * stay Pyth-only / Polymarket-only. Returns null when the pipeline isn't
   * running or has nothing recent, which is a normal state, not an error.
   */
  function getOrbitalMomentum(sym) {
    try {
      if (typeof window === 'undefined' || !window.OrbitalSignal?.get) return null;
      const s = window.OrbitalSignal.get(sym);
      if (!s) return null;
      return {
        structuralState: s.latest_state ?? null,
        oeq: s.latest_oeq ?? null,
        confidence: s.latest_confidence ?? null,
        quantumState: s.quantum_state ?? null,
        updatedAt: s.updated_at ?? null,
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Forward-looking probUp forecast from OrbitalEngine/TemporalEdge — a
   * z-score/normal-CDF model of the 15m window's likely settlement direction
   * that accounts for time-remaining decay (danger-zone/pin-risk tagging in
   * the final 2min/30s). Runs entirely in-renderer (orbital-engine-driver.js),
   * no Firestore round-trip. Non-authoritative supplementary signal — never
   * spot/PTB, and distinct from both Polymarket's own odds and the AI's call.
   */
  function getTemporalForecast(sym) {
    try {
      if (typeof window === 'undefined' || !window.OrbitalEngine?.getState) return null;
      const s = window.OrbitalEngine.getState(sym);
      const te = s?.temporalEdge;
      if (!te) return null;
      return {
        probUp: te.probUp ?? null,
        probDown: te.probUp != null ? Math.round((1 - te.probUp) * 10000) / 10000 : null,
        signal: te.metadataSignal ?? null,
        secToExpiry: te.secToExpiry ?? null,
        isDangerZone: !!te.isDangerZone,
        isVolumeBacked: !!te.isVolumeBacked,
        tags: te.tags || [],
        oeq: s.oeq ?? null,
        engineState: s.state ?? null,
        updatedAt: s.ts ?? null,
      };
    } catch (_) {
      return null;
    }
  }

  function buildOraclePacket(sym, preferHorizon) {
    const key = String(sym || '').toUpperCase();
    const pyth = getPythSpot(key);
    const spot = pyth?.price ?? null;

    const poly5 = getPolymarketWindow(key, '5m');
    const poly15 = getPolymarketWindow(key, '15m');

    // A specific preferHorizon means the caller wants THAT window, or nothing —
    // never silently substitute the other horizon's data. Doing so used to
    // relabel the result's own .horizon field to whatever DID resolve, which
    // made 5m requests come back tagged '15m' whenever poly5 was momentarily
    // invalid (common right around a 5m rollover, since 5m windows churn 3x
    // more often than 15m) — and callers that key briefs by ctx.horizon (e.g.
    // asi1-precontract-advisor.js) would then write into the wrong bucket,
    // leaving the 5m slot silently empty forever. Only fall back across
    // horizons when no specific one was requested.
    let primary = null;
    if (preferHorizon === '5m') primary = (poly5?.valid && poly5.slug) ? poly5 : null;
    else if (preferHorizon === '15m') primary = (poly15?.valid && poly15.slug) ? poly15 : null;
    else if (poly15?.valid && poly15.slug) primary = poly15;
    else if (poly5?.valid && poly5.slug) primary = poly5;

    const hourly = getHourlyLadder(key, spot);

    let deltaVsPtb = null;
    if (spot != null && primary?.priceToBeatNum) {
      deltaVsPtb = spot - primary.priceToBeatNum;
    }

    // Path direction from Pyth vs Polymarket PTB only
    let pathDir = null;
    if (deltaVsPtb != null && primary?.priceToBeatNum) {
      const pct = deltaVsPtb / primary.priceToBeatNum;
      if (Math.abs(pct) >= 0.00005) pathDir = deltaVsPtb > 0 ? 'UP' : 'DOWN';
      else pathDir = 'FLAT';
    }

    return {
      coin: key,
      ts: Date.now(),
      // STRICT
      spot,
      spotSource: pyth?.source || null,
      spotTs: pyth?.ts || null,
      oraclePolicy: 'pyth_spot_plus_polymarket_ptb_only',
      poly5m: poly5,
      poly15m: poly15,
      active: primary,
      horizon: primary?.horizon || preferHorizon || null,
      priceToBeatNum: primary?.priceToBeatNum ?? null,
      priceToBeatSource: primary?.priceToBeatSource || null,
      slug: primary?.slug || null,
      yesProb: primary?.yesProb ?? null,
      secondsToClose: primary?.secondsToClose ?? null,
      deltaVsPtb,
      pathDir,
      hourlyLadder: hourly.ladder,
      spotBucket: hourly.spotBucket,
      hourlySource: hourly.source,
      // Supplementary only — never treated as spot/PTB/authoritative.
      orbitalMomentum: getOrbitalMomentum(key),
      temporalForecast: getTemporalForecast(key),
      warnings: [
        ...(spot == null ? ['no_pyth_spot'] : []),
        ...(primary && primary.priceToBeatNum == null ? ['no_polymarket_ptb'] : []),
        ...(primary && !primary.valid ? [primary.reason || 'invalid_window'] : []),
      ],
    };
  }

  /**
   * Snapshot shape expected by llm:analyzeSnapshot / specialized prompts.
   */
  function buildLlmSnapshot(sym, preferHorizon, extras = {}) {
    const o = buildOraclePacket(sym, preferHorizon);
    const pred = extras.pred || null;
    const is5 = o.horizon === '5m';

    const polyBlock = (w) => {
      if (!w || !w.slug) return null;
      return {
        slug: w.slug,
        live: !!w.live,
        yesProb: w.yesProb,
        probability: w.yesProb,
        priceToBeatNum: w.priceToBeatNum,
        priceToBeatSource: w.priceToBeatSource,
        targetPriceNum: w.priceToBeatNum,
        targetPrice: w.targetPrice,
        secondsToClose: w.secondsToClose,
        closeTime: w.closeTime,
        bestBid: w.bestBid,
        bestAsk: w.bestAsk,
        mid: w.mid,
        spread: w.spread,
        depthImbalance: w.depthImbalance,
        nearTouchNotional: w.nearTouchNotional,
        liveDirection: w.liveDirection || o.pathDir,
        settlementRule: w.settlementRule,
        oracle: {
          spot: o.spot,
          spotSource: o.spotSource,
          ptbSource: w.priceToBeatSource,
          policy: o.oraclePolicy,
        },
      };
    };

    const p5 = polyBlock(o.poly5m);
    const p15 = polyBlock(o.poly15m);

    return {
      coin: o.coin,
      preContract: true,
      preferAsi1: true,
      rangePrediction: true,
      rangeHorizonMinutes: preferHorizon === '60' || preferHorizon === 60 ? 60 : 15,
      horizonMinutes: is5 ? 5 : (preferHorizon === 60 || preferHorizon === '60m' ? 60 : 15),
      horizon: is5 ? '5m' : (preferHorizon === 60 || preferHorizon === '60m' ? '60m' : '15m'),
      venue: is5 ? 'polymarket-5m' : 'polymarket-15m',
      // STRICT spot
      currentPrice: o.spot,
      price: o.spot,
      priceSource: o.spotSource,
      oraclePolicy: o.oraclePolicy,
      oracleWarnings: o.warnings,
      direction: pred?.signal || pred?.direction || o.pathDir || null,
      modelDirection: pred?.signal || pred?.direction || null,
      score: pred?.score ?? null,
      modelScore: pred?.score ?? null,
      confidence: pred?.confidence != null ? pred.confidence / (pred.confidence > 1 ? 100 : 1) : null,
      poly5m: p5,
      poly15m: p15,
      activeContract: is5 ? p5 : p15,
      rangeLadder: o.hourlyLadder,
      spotBucket: o.spotBucket,
      hourlyRanges: true,
      // Supplementary momentum context from the orbital pipeline — never
      // spot/PTB, may be null (pipeline not running is a normal state).
      orbitalMomentum: o.orbitalMomentum,
      // Forward-looking probUp/probDown forecast (OrbitalEngine/TemporalEdge)
      // — supplementary, never spot/PTB, distinct from Polymarket's own odds.
      temporalForecast: o.temporalForecast,
      // Explicit PTB block so models cannot invent
      polymarketOracle: {
        slug: o.slug,
        priceToBeatNum: o.priceToBeatNum,
        priceToBeatSource: o.priceToBeatSource,
        pythSpot: o.spot,
        pythSource: o.spotSource,
        pathDir: o.pathDir,
        deltaVsPtb: o.deltaVsPtb,
        yesProb: o.yesProb,
        secondsToClose: o.secondsToClose,
        rule: 'PTB is Polymarket window open only. Spot is Pyth only. Do not invent PTB.',
      },
      sessionMemory: extras.sessionMemory || null,
      analyticsMemory: extras.sessionMemory || null,
    };
  }

  return {
    getPythSpot,
    getPolymarketWindow,
    getHourlyLadder,
    buildOraclePacket,
    buildLlmSnapshot,
  };
}));
