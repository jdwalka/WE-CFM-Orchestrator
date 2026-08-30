/**
 * Oracle Snapshot — STRICT sources for LLM inference
 * --------------------------------------------------
 * Spot  = Pyth only (Lazer / Hermes / _pythPrices / PythBrowser)
 * PTB   = Polymarket only (poly5m / poly15m / poly60m opening strike locked at T0)
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

  // Push-driven Pyth Lazer ticker cache, mirrored from the working pattern in
  // prediction-markets.js. window.pythLazer.getLatestTickers() is an async IPC call
  // (ipcRenderer.invoke) and can never be read synchronously the way getPythSpot()
  // below needs, so subscribe once here instead. Keys are '<SYM>USD' (e.g. 'BTCUSD')
  // and the live price field is `.last`, not `.price` -- see electron/main.js pmap
  // construction and prediction-markets.js's getFreshPythLazerPrice().
  let _lazerPushCache = null;
  try {
    if (typeof window !== 'undefined' && window.pythLazer?.onTickers) {
      window.pythLazer.onTickers((prices) => { _lazerPushCache = prices || null; });
    }
  } catch (_) { /* */ }

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

    // 4) pythLazer push-cache (see _lazerPushCache subscription above)
    try {
      const pairKey = `${key}USD`;
      const tick = (_lazerPushCache && typeof pairKey === 'string' && Object.prototype.hasOwnProperty.call(_lazerPushCache, pairKey)) ? _lazerPushCache[pairKey] : null;
      const p = num(tick?.last);
      if (p != null && p > 0) {
        return { price: p, source: tick?.source || 'pyth-lazer', ts: tick?.timestamp || Date.now() };
      }
    } catch (_) { /* */ }

    // 5) PredictionEngine live spot price
    try {
      const pred = window.PredictionEngine?.get?.(key) || (window._predictions && typeof key === 'string' && Object.prototype.hasOwnProperty.call(window._predictions, key) ? window._predictions[key] : null);
      const p = num(pred?.price || pred?.currentPrice);
      if (p != null && p > 0) {
        return { price: p, source: 'prediction-engine', ts: Date.now() };
      }
    } catch (_) { /* */ }

    // 6) Candle cache last price
    try {
      const cache = (window.candleCache && typeof key === 'string' && Object.prototype.hasOwnProperty.call(window.candleCache, key)) ? window.candleCache[key] : null;
      const p = num(cache?.ticker?.usd || cache?.candles?.[cache?.candles?.length - 1]?.c);
      if (p != null && p > 0) {
        return { price: p, source: 'candle-cache', ts: Date.now() };
      }
    } catch (_) { /* */ }

    return null;
  }

  /**
   * Polymarket window only — never invent PTB.
   * @param {'5m'|'15m'|'60m'|'1h'} horizon
   */
  function getPolymarketWindow(sym, horizon) {
    const key = String(sym || '').toUpperCase();
    const coin = (typeof window !== 'undefined' && window.PredictionMarkets?.getCoin?.(key)) || {};
    const h = String(horizon || '').toLowerCase();
    const m = (h === '5m') ? (coin.poly5m || null)
      : (h === '60m' || h === '1h' || h === 'hourly') ? (coin.poly60m || null)
      : (coin.poly15m || null);
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
    const rejected = /rtds|twap|title|provisional|coinbase|binance|gecko|rti|crypto-price|boundary|rejected:|chainlink-candles/.test(ptbSource);
    const allowedSource = !rejected && (
      !ptbSource
      || /poly|gamma|lock|event|openprice|pricetobeat|contract/.test(ptbSource)
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
  // Supplementary only, same as orbitalMomentum/temporalForecast below --
  // window.DerivativesFeed (src/feeds/derivatives-feed.js) has been running
  // since app boot (started in app-init.js) collecting cross-venue funding,
  // OI delta/velocity, and live liquidation-cascade data, but nothing in
  // src/llm/ ever read it before this -- the LLM packet never saw crowded
  // leveraged positioning at all, even though the feed computing it was
  // already live. pressure/label are that feed's own precomputed directional
  // read (liquidation cascade > funding crowding > OI build/unwind, in that
  // priority); never spot/PTB and must never be treated as authoritative.
  function getDerivativesPositioning(sym) {
    try {
      if (typeof window === 'undefined' || !window.DerivativesFeed?.get) return null;
      const s = window.DerivativesFeed.get(sym);
      if (!s || !s.available) return null;
      return {
        fundingRate: s.funding ?? null,
        fundingVelocity: s.fundingVelocity ?? null,
        openInterestUsd: s.oiUsd ?? null,
        oiDeltaPct: s.oiDeltaPct ?? null,
        oiTrend: s.oiTrend || null,
        liqImbalance: s.liquidations?.imbalance ?? null,
        pressure: Number.isFinite(s.pressure) ? s.pressure : null,
        label: s.label || null,
        ageMs: Number.isFinite(s.ts) ? Date.now() - s.ts : null,
      };
    } catch (_) { return null; }
  }

  function getOrbitalMomentum(sym) {
    try {
      if (typeof window === 'undefined' || !window.OrbitalSignal?.get) return null;
      const s = window.OrbitalSignal.get(sym);
      if (!s) return null;
      let liveFeedAgeMs = null;
      try {
        const tick = window.OrbitalSignal.getLiveTick?.(sym, 's');
        if (tick?.ts) liveFeedAgeMs = Date.now() - tick.ts;
      } catch (_) { /* live Redis feed optional — Firestore-bridged fields above remain authoritative */ }
      return {
        structuralState: s.latest_state ?? null,
        oeq: s.latest_oeq ?? null,
        confidence: s.latest_confidence ?? null,
        quantumState: s.quantum_state ?? null,
        updatedAt: s.updated_at ?? null,
        liveFeedAgeMs,
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
    const poly60 = getPolymarketWindow(key, '60m');
    if (preferHorizon === '5m') primary = (poly5?.valid && poly5.slug) ? poly5 : null;
    else if (preferHorizon === '15m') primary = (poly15?.valid && poly15.slug) ? poly15 : null;
    else if (preferHorizon === '60m' || preferHorizon === '1h' || preferHorizon === 'hourly') primary = (poly60?.valid && poly60.slug) ? poly60 : null;
    else if (poly15?.valid && poly15.slug) primary = poly15;
    else if (poly5?.valid && poly5.slug) primary = poly5;
    else if (poly60?.valid && poly60.slug) primary = poly60;

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
      poly60m: poly60,
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
      derivativesPositioning: getDerivativesPositioning(key),
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
    const p60 = polyBlock(o.poly60m);
    const is60 = o.horizon === '60m' || o.horizon === '1h' || preferHorizon === 60 || preferHorizon === '60m';

    return {
      coin: o.coin,
      preContract: true,
      preferAsi1: true,
      rangePrediction: true,
      rangeHorizonMinutes: is60 ? 60 : 15,
      horizonMinutes: is5 ? 5 : (is60 ? 60 : 15),
      horizon: is5 ? '5m' : (is60 ? '60m' : '15m'),
      venue: is5 ? 'polymarket-5m' : (is60 ? 'polymarket-60m' : 'polymarket-15m'),
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
      poly60m: p60,
      activeContract: is5 ? p5 : (is60 ? p60 : p15),
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
