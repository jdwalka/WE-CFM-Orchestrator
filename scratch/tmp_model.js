  function buildSignalModel(candles, book, trades, options = {}) {
    if (!candles || candles.length < 20) return null;

    // Gate: coins with no statistical edge pending external feed integration
    if (options.sym && SIGNAL_DISABLED_COINS.has(options.sym.toUpperCase())) {
      return {
        score: 0, confidence: 0, direction: 'NEUTRAL', disabled: true,
        disabledReason: `${options.sym} signal disabled — pending Birdeye/Dexscreener feed`
      };
    }

    const includeMicrostructure = options.includeMicrostructure !== false;
    const includeSetups = options.includeSetups !== false;
    const closes = candles.map(c => c.c);
    const lastPrice = closes[closes.length - 1];
    const session = options.session || getSessionInfo();

    // --- QuantCore Kalman Filter ---
    let kalmanVelocity = 0;
    if (window.QuantCore?.kalman) {
      try {
        const kalmanResult = window.QuantCore.kalman.process(closes);
        if (kalmanResult && kalmanResult.length > 0) {
          kalmanVelocity = kalmanResult[kalmanResult.length - 1].velocity;
        }
      } catch (err) {}
    }

    // --- QuantCore Hurst Exponent ---
    let hurstRegime = 'chop';
    if (window.QuantCore?.hurst) {
      try {
        const h_exp = window.QuantCore.hurst.rolling(closes, 50);
        hurstRegime = window.QuantCore.hurst.classify(h_exp).signal_gate;
      } catch (err) {}
    }

    // --- Indicators ---
    const rsi = calcRSI(closes);
    let rsiSig = 0;
    if (rsi > 70) rsiSig = clamp(-0.6 - ((rsi - 70) / 30) * 0.4, -1, -0.2);
    else if (rsi < 30) rsiSig = clamp(0.6 + ((30 - rsi) / 30) * 0.4, 0.2, 1);
    else rsiSig = (rsi - 50) / 50 * 0.3;

    // RSI(7) fast signal for 15m responsiveness — 2026 research: faster period better for scalping
    const rsi7 = calcRSI(closes, 7);
    let rsi7Sig = 0;
    if (rsi7 > 70) rsi7Sig = clamp(-0.6 - ((rsi7 - 70) / 30) * 0.4, -1, -0.2);
    else if (rsi7 < 30) rsi7Sig = clamp(0.6 + ((30 - rsi7) / 30) * 0.4, 0.2, 1);
    else rsi7Sig = (rsi7 - 50) / 50 * 0.3;
    // Blend 70% RSI(14) + 30% RSI(7) for stability with responsiveness
    rsiSig = rsiSig * 0.70 + rsi7Sig * 0.30;

    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const emaCross = (ema9[ema9.length - 1] - ema21[ema21.length - 1]) / (ema21[ema21.length - 1] || 1) * 100;
    const emaSig = clamp(emaCross * 5, -1, 1);

    const sma9 = calcSMA(closes, 9);
    const sma21 = calcSMA(closes, 21);
    const smaCross = (sma9[sma9.length - 1] - sma21[sma21.length - 1]) / (sma21[sma21.length - 1] || 1) * 100;
    const smaSig = clamp(smaCross * 5, -1, 1);

    const vwap = calcVWAP(candles);
    const vwapLast = vwap[vwap.length - 1];
    const vwapDev = ((lastPrice - vwapLast) / (vwapLast || 1)) * 100;
    const vwapStd = calcStdDev(closes, 20);
    const vwapBands = { upper: vwapLast + vwapStd * 2, lower: vwapLast - vwapStd * 2 };
    let vwapSig = 0;
    // Use a rolling 80-candle VWAP for deviation check so the signal
    // doesn't fire on session-level drift that has nothing to do with
    // short-term over-extension.
    const vwapRolling = calcVWAP(candles.slice(-80));
    const vwapRollingLast = vwapRolling[vwapRolling.length - 1];
    const vwapDevRolling = ((lastPrice - vwapRollingLast) / (vwapRollingLast || 1)) * 100;
    if (Math.abs(vwapDevRolling) < 0.3) vwapSig = 0;
    else if (vwapDevRolling > 1.5) vwapSig = -0.5;
    else if (vwapDevRolling < -1.5) vwapSig = 0.5;
    else vwapSig = vwapDevRolling > 0 ? 0.3 : -0.3;

    const obv = calcOBV(candles);
    const obvSlope = slope(obv, 8);
    const obvSig = clamp(obvSlope / 5, -1, 1);

    // Volume delta from candle body position
    const recent = candles.slice(-12);
    let buyV = 0, sellV = 0;
    recent.forEach(c => {
      const range = c.h - c.l || 0.0001;
      const bodyPos = (c.c - c.l) / range;
      const vol = c.v || 1;
      buyV += vol * bodyPos;
      sellV += vol * (1 - bodyPos);
    });
    const volRatio = buyV / (sellV || 1);
    const volSig = clamp((volRatio - 1) * 0.5, -1, 1);

    const mom = closes.length > 6 ? ((closes[closes.length - 1] - closes[closes.length - 7]) / (closes[closes.length - 7] || 1)) * 100 : 0;
    const momSig = clamp(mom / 2, -1, 1);

    // DIAGNOSTIC: RTI dampening analysis for weak coins
    const isWeakCoin = options.sym && ['DOGE', 'BNB'].includes(options.sym.toUpperCase());
    if (isWeakCoin && candles && candles.length > 0) {
      const rawClose = candles[candles.length - 1].c;
      // RTI dampening analysis (rtiCandles not currently available in this context)
    }

    const atr = calcATR(candles);
    const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
    const bands = calcBollinger(closes);
    const bandDistance = bands.position - 0.5;
    let bandSig = 0;
    if (bands.position >= 0.88) bandSig = -clamp((bands.position - 0.88) / 0.12, 0, 1);
    else if (bands.position <= 0.12) bandSig = clamp((0.12 - bands.position) / 0.12, 0, 1);
    else bandSig = clamp(-bandDistance * 0.45, -0.22, 0.22);
    const persistence = calcTrendPersistence(closes, ema21);
    const structure = calcStructureBias(candles, atrPct);

    // --- Extended Indicators ---
    const macdResult = calcMACD(closes);
    const macdHistNorm = lastPrice > 0 ? (macdResult.histogram / lastPrice) * 1000 : 0;
    const macdCross = macdResult.macd > macdResult.signal ? 0.18 : macdResult.macd < macdResult.signal ? -0.18 : 0;
    const macdSig = clamp(macdHistNorm * 2.5 + macdCross, -1, 1);

    const stochRsiResult = calcStochRSI(closes);
    // Simple K-line position with cross confirmation
    const kdCross = stochRsiResult.k > stochRsiResult.d ? 1 : stochRsiResult.k < stochRsiResult.d ? -1 : 0;
    let stochSig = 0;
    if (stochRsiResult.k > 80) {
      stochSig = -0.6 - ((stochRsiResult.k - 80) / 20) * 0.4;
    } else if (stochRsiResult.k < 20) {
      stochSig = 0.6 + ((20 - stochRsiResult.k) / 20) * 0.4;
    } else {
      stochSig = (stochRsiResult.k - 50) / 50 * 0.35;
    }
    stochSig = clamp(stochSig + kdCross * 0.12, -1, 1);

    const adxResult = calcADX(candles);
    const diDiff = (adxResult.pdi - adxResult.mdi) / Math.max(adxResult.pdi + adxResult.mdi, 1);
    const adxStrength = clamp(adxResult.adx / 50, 0, 1);
    const adxSig = clamp(diDiff * adxStrength * 1.2, -1, 1);

    const ichimoku = calcIchimoku(candles);
    let ichiSig = 0;
    if (ichimoku.cloudPos === 'above') ichiSig = 0.5 + (ichimoku.tenkan > ichimoku.kijun ? 0.2 : 0);
    else if (ichimoku.cloudPos === 'below') ichiSig = -0.5 - (ichimoku.tenkan < ichimoku.kijun ? 0.2 : 0);
    else ichiSig = ichimoku.tenkan > ichimoku.kijun ? 0.12 : ichimoku.tenkan < ichimoku.kijun ? -0.12 : 0;
    ichiSig = clamp(ichiSig, -1, 1);

    const wR = calcWilliamsR(candles);
    let wRSig = 0;
    if (wR > -20) wRSig = -0.6 - ((wR + 20) / 20) * 0.4;
    else if (wR < -80) wRSig = 0.6 + ((-80 - wR) / 20) * 0.4;
    else wRSig = clamp((-wR - 50) / 50 * 0.6, -1, 1);
    wRSig = clamp(wRSig, -1, 1);

    const mfi = calcMFI(candles);
    let mfiSig = 0;
    if (mfi > 80) mfiSig = -0.6 - ((mfi - 80) / 20) * 0.4;
    else if (mfi < 20) mfiSig = 0.6 + ((20 - mfi) / 20) * 0.4;
    else mfiSig = (mfi - 50) / 50 * 0.35;
    mfiSig = clamp(mfiSig, -1, 1);

    // --- Hull MA signal (primary trend filter) ---
    const hmaLine = calcHMA(closes, 16);
    const hmaCurr = hmaLine[hmaLine.length - 1];
    const hmaPrev = hmaLine[hmaLine.length - 2] ?? hmaCurr;
    const hmaPrev2 = hmaLine[hmaLine.length - 3] ?? hmaPrev;
    const hmaSlope = (hmaCurr - hmaPrev2) / (Math.abs(hmaPrev2) || 1) * 100;
    const hmaDevPct = (lastPrice - hmaCurr) / (Math.abs(hmaCurr) || 1) * 100;
    let hmaSig = clamp(hmaSlope * 8, -0.7, 0.7);
    if (Math.abs(hmaDevPct) > 0.4) hmaSig += clamp(hmaDevPct * 0.28, -0.3, 0.3);
    // Boost trend signal with Kalman true velocity
    if (kalmanVelocity > 0.001) hmaSig += clamp(kalmanVelocity * 10, 0, 0.3);
    else if (kalmanVelocity < -0.001) hmaSig += clamp(kalmanVelocity * 10, -0.3, 0);
    hmaSig = clamp(hmaSig, -1, 1);

    // --- VWMA signal (volume-weighted trend confirmation) ---
    const vwmaLine = calcVWMA(candles, 20);
    const vwmaCurr = vwmaLine[vwmaLine.length - 1];
    const vwmaPrev = vwmaLine[vwmaLine.length - 3] ?? vwmaCurr;
    const vwmaSlope = (vwmaCurr - vwmaPrev) / (Math.abs(vwmaPrev) || 1) * 100;
    const vwmaDevPct = (lastPrice - vwmaCurr) / (Math.abs(vwmaCurr) || 1) * 100;
    let vmaSig = clamp(vwmaSlope * 6, -0.6, 0.6);
    vmaSig += clamp(vwmaDevPct * 0.35, -0.4, 0.4);
    vmaSig = clamp(vmaSig, -1, 1);

    // --- Trend Regime Modulation ---
    // In a strong trend, oscillator "overbought/oversold" signals are continuation
    // cues, not reversal cues. Suppress contrarian oscillator signals proportionally
    // to trend strength so they don't cancel out the trend-following signals.
    // HMA slope used as primary trend confirmation — more lag-free than emaCross
    const isBullTrend = (hmaSlope > 0.04 && adxResult.pdi > adxResult.mdi && adxResult.adx > 22) || (hurstRegime === 'trend' && kalmanVelocity > 0);
    const isBearTrend = (hmaSlope < -0.04 && adxResult.mdi > adxResult.pdi && adxResult.adx > 22) || (hurstRegime === 'trend' && kalmanVelocity < 0);
    if (isBullTrend || isBearTrend) {
      const suppressFactor = clamp((adxResult.adx - 22) / 28, 0, 0.80);
      if (isBullTrend) {
        // Dampen bearish readings from contrarian oscillators during bull trends
        if (rsiSig < 0) rsiSig *= (1 - suppressFactor);
        if (stochSig < 0) stochSig *= (1 - suppressFactor);
        if (wRSig < 0) wRSig *= (1 - suppressFactor);
        if (bandSig < 0) bandSig *= (1 - suppressFactor * 0.75);
        if (mfiSig < 0) mfiSig *= (1 - suppressFactor * 0.75);
        if (vwapSig < 0) vwapSig *= (1 - suppressFactor * 0.70);
      } else {
        // Dampen bullish readings from contrarian oscillators during bear trends
        if (rsiSig > 0) rsiSig *= (1 - suppressFactor);
        if (stochSig > 0) stochSig *= (1 - suppressFactor);
        if (wRSig > 0) wRSig *= (1 - suppressFactor);
        if (bandSig > 0) bandSig *= (1 - suppressFactor * 0.75);
        if (mfiSig > 0) mfiSig *= (1 - suppressFactor * 0.75);
        if (vwapSig > 0) vwapSig *= (1 - suppressFactor * 0.70);
      }
    }

    // --- Book & Trade Flow ---
    const bookAnalysis = analyzeBook(book);
    const tradeFlow = analyzeTradeFlow(trades);
    const microstructure = (() => {
      try {
        if (window.MicrostructureEngine?.analyze && options.sym) {
          return window.MicrostructureEngine.analyze(options.sym, book, trades, {
            horizon: options.horizon || 15,
          });
        }
      } catch (_) { }
      return null;
    })();
    const bookFresh = book && (Date.now() - (book.timestamp || 0)) < 30000;
    const bookSigBase = bookFresh ? clamp((bookAnalysis.imbalance || 0) * 1.5, -1, 1) : 0;
    let flowSigBase = 0;
    if (tradeFlow.aggressor === 'buyers') flowSigBase = Math.min(1, (tradeFlow.buyRatio - 50) / 30);
    else if (tradeFlow.aggressor === 'sellers') flowSigBase = Math.max(-1, -(tradeFlow.sellRatio - 50) / 30);

    // Conservative microstructure blend to preserve existing book/flow semantics.
    const microstructureComposite = clamp(microstructure?.composite || 0, -1, 1);
    const sweepScore = clamp(microstructure?.sweep?.score || 0, -1, 1);
    const vacuumPenalty = clamp(microstructure?.vacuum?.severity || 0, 0, 1);
    const toxicityPenalty = clamp((microstructure?.toxicity?.tox ?? microstructure?.toxicity?.proxy ?? 0), 0, 1);
    const spoofScore = clamp(microstructure?.spoofing?.score || 0, 0, 1);
    const spoofDir = clamp(microstructure?.spoofing?.direction || 0, -1, 1);
    const icebergScore = clamp(microstructure?.iceberg?.score || 0, 0, 1);
    const icebergDir = clamp(microstructure?.iceberg?.direction || 0, -1, 1);
    const toxicitySig = -toxicityPenalty;
    const spoofSig = clamp(spoofDir * spoofScore, -1, 1);
    const icebergSig = clamp(icebergDir * icebergScore, -1, 1);
    const bookSig = clamp(bookSigBase * 0.86 + microstructureComposite * 0.14, -1, 1);
    let flowSig = clamp(flowSigBase * 0.84 + sweepScore * 0.16, -1, 1);
    const bookSigAdj = clamp(bookSig + spoofSig * 0.12, -1, 1);
    flowSig = clamp(flowSig + icebergSig * 0.16, -1, 1);
    if (vacuumPenalty > 0.55) {
      flowSig *= (1 - vacuumPenalty * 0.35);
    }
    if (toxicityPenalty > 0.60) {
      flowSig *= (1 - (toxicityPenalty - 0.60) * 0.35);
    }

    // --- Prediction Market Sentiment (Kalshi + Polymarket) ---
    const mktData = options.sym ? (window.PredictionMarkets?.getCoin(options.sym) ?? null) : null;
    let mktSig = 0;
    if (mktData && mktData.combinedProb !== null) {
      const p = mktData.combinedProb;
      if (p > 0.62) mktSig = Math.min(1, (p - 0.62) / 0.38);
      else if (p < 0.38) mktSig = -Math.min(1, (0.38 - p) / 0.38);
    }
    const mktModelSig = KALSHI_VERIFY_ONLY ? 0 : mktSig;

    // Supertrend
    const stR = calcSupertrend(candles, 10, 3.0);
    const supertrendSig = stR.signal;

    // CCI
    // FIX (2026-05-04 CRITICAL): Remove sign inversion in neutral zone (line 3406)
    // BEFORE: else cciSig = clamp(-cciVal / 200, ...);  // ← Inverted CCI signal 100% of time in neutral zone
    // AFTER: else cciSig = clamp(cciVal / 200, ...);   // ← Correct: +CCI → +signal (bullish)
    const cciVal = calcCCI(candles, 14);
    let cciSig = 0;
    if (cciVal > 150) cciSig = -clamp((cciVal - 100) / 150, 0, 1);
    else if (cciVal < -150) cciSig = clamp((-100 - cciVal) / 150, 0, 1);
    else cciSig = clamp(cciVal / 200, -0.3, 0.3);  // ✅ FIXED: Removed negation
    cciSig = clamp(cciSig, -1, 1);

    // CMF — Chaikin Money Flow
    const cmfVal = calcCMF(candles, 20);
    const cmfSig = clamp(cmfVal * 2.5, -1, 1);

    // Fisher Transform
    // FIX (2026-05-04 CRITICAL): Remove negation that inverts Fisher signal 100% of the time
    // BEFORE: const fisherSig = clamp(-fisherVal / 2.5, -1, 1);  // ← Inverted always
    // AFTER: const fisherSig = clamp(fisherVal / 2.5, -1, 1);   // ← Correct: +Fisher → +signal (bullish)
    const fisherVal = calcFisher(candles, 10);
    const fisherSig = clamp(fisherVal / 2.5, -1, 1);  // ✅ FIXED: Removed negation

    // Keltner Channels
    const kelt = calcKeltner(candles, 20, 2.0);
    let keltSig = 0;
    if (kelt.position >= 0.88) keltSig = -clamp((kelt.position - 0.88) / 0.12, 0, 1);
    else if (kelt.position <= 0.12) keltSig = clamp((0.12 - kelt.position) / 0.12, 0, 1);
    else keltSig = clamp(-(kelt.position - 0.5) * 0.45, -0.22, 0.22);

    // Use cached Fear & Greed (non-blocking, updates in background)
    const fng = _fngCache.value;
    let fngSig = 0;
    if (fng !== null) {
      if (fng < 30) fngSig = clamp((30 - fng) / 30 * 0.4, 0, 0.4);      // Extreme Fear → bullish
      else if (fng > 70) fngSig = clamp(-(fng - 70) / 30 * 0.4, -0.4, 0); // Extreme Greed → bearish
    }
    fetchFearGreed(); // kick off background refresh (non-blocking)

    // --- Advanced Market Microstructure Signals ────────────────────────────
    // Funding rate pressure, order book imbalance (10-20 levels), liquidity vacuum
    let fundingRateSig = 0;
    let orderBookImbalanceSig = 0;
    let imbalanceVelocitySig = 0;
    let liquidityDepthSig = 0;
    let liquidityVacuumSig = 0;
    let microStructureMeta = { funding: null, imbalance: null, velocity: null, liquidity: null, vacuum: null };

    if (window.MicrostructureSignals) {
      // ★ Funding Rate: Long/short positioning imbalance on perpetuals
      // High positive rate = long overheated → bearish pressure
      // High negative rate = short overheated → bullish pressure
      if (window._fundingRateCache && window._fundingRateCache[options.sym]) {
        const fundRate = window._fundingRateCache[options.sym];
        const fundAnalysis = window.MicrostructureSignals.analyzeFundingPressure(fundRate.rate);
        fundingRateSig = fundAnalysis.signal * 0.45;  // Weight: 45% of a single indicator
        microStructureMeta.funding = fundAnalysis;
        if (Math.abs(fundRate.rate) > 0.001) {
          predictionDebugLog(`micro-funding:${options.sym}`, 'log', () => `[MicroSignals] ${options.sym} funding rate=${(fundRate.rate * 100).toFixed(3)}% -> sig=${fundAnalysis.signal.toFixed(3)}`, 15000);
        }
      }

      // ★ Order Book Imbalance: Weighted bid/ask depth across 10-20 levels
      // Heavy buy walls = bullish setup (buying absorption capacity)
      // Heavy sell walls = bearish setup (selling pressure)
      if (book && book.bids && book.asks) {
        const balanceMetrics = options.sym ? window.OB?.getBalanceMetrics?.(options.sym) : null;
        const imbalanceData = window.MicrostructureSignals.analyzeOrderBookImbalance(book, {
          levels: [10, 20],
          balance: balanceMetrics,
        });
        if (!imbalanceData.error) {
          const imbalanceSigData = window.MicrostructureSignals.imbalanceToSignal(
            imbalanceData,
            imbalanceData.distribution
          );
          orderBookImbalanceSig = imbalanceSigData.signal * 0.58;
          imbalanceVelocitySig = clamp((imbalanceData.velocity?.value || 0) * 0.42, -0.42, 0.42);
          const liquidity = imbalanceData.liquidity || {};
          const liqScore = Number.isFinite(Number(liquidity.score)) ? Number(liquidity.score) : 0.65;
          const liqDirection = Math.sign(imbalanceSigData.signal || imbalanceData.imbalance || 0);
          const liqRisk = liqScore < 0.38 ? -0.18 : liqScore < 0.58 ? -0.08 : liqScore > 0.78 ? 0.04 : 0;
          liquidityDepthSig = clamp(liqDirection * liqRisk, -0.22, 0.08);
          microStructureMeta.imbalance = {
            ...imbalanceSigData,
            rawImbalance: imbalanceData.imbalance,
            levels: imbalanceData.levels,
          };
          microStructureMeta.velocity = imbalanceData.velocity;
          microStructureMeta.liquidity = liquidity;
          if (Math.abs(imbalanceData.imbalance) > 0.25) {
            const vel = imbalanceData.velocity?.value || 0;
            predictionDebugLog(`micro-book:${options.sym}`, 'log', () => `[MicroSignals] ${options.sym} book imbalance=${imbalanceData.imbalance.toFixed(3)} vel=${vel.toFixed(3)} type=${imbalanceSigData.type} -> sig=${imbalanceSigData.signal.toFixed(3)}`, 7000);
          }
        }
      }

      // ★ Liquidity Vacuum: Detect price levels with sparse order density
      // Bull vacuums (gaps above bids) = likely upside run
      // Bear vacuums (gaps below asks) = likely downside run
      if (book && book.bids && book.asks && lastPrice > 0) {
        const vacuumData = window.MicrostructureSignals.detectLiquidityVacuum(
          book,
          lastPrice,
          30  // Check 30 levels
        );
        if (vacuumData.vacuumFound && vacuumData.zones.length > 0) {
          const vacuumSigData = window.MicrostructureSignals.vacuumToSignal(vacuumData);
          liquidityVacuumSig = vacuumSigData.signal * 0.35;  // Weight: 35% of a single indicator
          microStructureMeta.vacuum = vacuumSigData;
          predictionDebugLog(`micro-vacuum:${options.sym}`, 'log', () => `[MicroSignals] ${options.sym} vacuum risk=${vacuumData.risk.toFixed(3)} type=${vacuumSigData.type} zones=${vacuumData.zonesCount} -> sig=${vacuumSigData.signal.toFixed(3)}`, 7000);
        }
      }
    }

    // --- CoinMarketCap Pro Macro Sentiment (global dominance + volume flux) ---
    let cmcMacroSig = 0;
    if (window._cmcProFeed) {
      const cmcQuote = window._cmcProFeed.getCachedQuote(options.sym?.toUpperCase());
      const cmcGlobal = window._cmcProFeed.globalMetrics?.();
      // Coin dominance trend: if BTC dominance rising → risk-off, bearish micro-cap sentiment
      if (cmcGlobal && cmcGlobal.btcDominance) {
        const btcDom = cmcGlobal.btcDominance || 0;
        if (btcDom > 55) cmcMacroSig -= 0.15;  // BTC dominance high → alts struggle
        else if (btcDom < 42) cmcMacroSig += 0.12;  // BTC dominance low → alts favored
      }
      // Volume anomaly: surge in coin volume relative to 24h avg
      if (cmcQuote && options.sym && (lastPrice || 1) > 0) {
        const vol24h = cmcQuote.volume24h || 0;
        const volPrice = vol24h / Math.max(lastPrice, 0.001);
        if (volPrice > 1e6) cmcMacroSig += 0.08;  // Breakout volume signature
        else if (volPrice < 1e5) cmcMacroSig -= 0.06;  // Anemic volume
      }
      cmcMacroSig = clamp(cmcMacroSig, -0.25, 0.25);
    }
    if (window._cmcProFeed && window._cmcProFeed.startPolling) {
      // Lazy-start polling on first prediction run (non-blocking)
      if (!window._cmcProFeed._pollingStarted) {
        window._cmcProFeed.startPolling(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'], 3600000);
        window._cmcProFeed._pollingStarted = true;
      }
    }

    const signalVector = {
      hma: hmaSig,
      vwma: vmaSig,
      rsi: rsiSig,
      ema: emaSig,
      sma: smaSig,
      vwap: vwapSig,
      obv: obvSig,
      volume: volSig,
      momentum: momSig,
      bands: bandSig,
      persistence: persistence.signal,
      structure: structure.signal,
      book: includeMicrostructure ? bookSigAdj : 0,
      flow: includeMicrostructure ? flowSig : 0,
      toxicity: includeMicrostructure ? toxicitySig : 0,
      spoof: includeMicrostructure ? spoofSig : 0,
      iceberg: includeMicrostructure ? icebergSig : 0,
      // ★ NEW: Advanced microstructure signals (2026-05-15)
      fundingRate: fundingRateSig,         // Perpetual market positioning pressure
      orderBookImbalance: orderBookImbalanceSig,  // Weighted bid/ask depth (10-20 levels)
      imbalanceVelocity: imbalanceVelocitySig,  // 15m rolling change in weighted imbalance
      liquidityDepth: liquidityDepthSig,  // Thin/deep 10/20-level liquidity regime
      liquidityVacuum: liquidityVacuumSig,  // Price levels with sparse order density
      macd: macdSig,
      stochrsi: stochSig,
      adx: adxSig,
      ichimoku: ichiSig,
      williamsR: wRSig,
      mfi: mfiSig,
      mktSentiment: mktModelSig,
      supertrend: supertrendSig,
      cci: cciSig,
      cmf: cmfSig,
      fisher: fisherSig,
      keltner: keltSig,
      fearGreed: fngSig,
      cmcMacro: cmcMacroSig,  // ★ CoinMarketCap Pro: BTC dominance + global volume
    };

    // --- SPDF QUANTUM DEADBAND INTERCEPT ---
    // Force all active continuous signals into discrete integer spin states (+1, 0, -1)
    for (const key of Object.keys(signalVector)) {
      const val = signalVector[key];
      if (typeof val === 'number') {
        if (val > 0.15) signalVector[key] = 1;
        else if (val < -0.15) signalVector[key] = -1;
        else signalVector[key] = 0;
      }
    }

    // ── PATCH1.11: Wall Absorption Signal Suppression ──────────────────────
    // When a bid/ask wall absorption event is detected on 1m candles,
    // noisy indicators (momentum, OBV, stochrsi) fire in the wick direction.
    // Suppress them and inject counter-bias via persistence.
    const wallAbs = detectWallAbsorption(options.candles1m || null);
    if (wallAbs.detected) {
      const sup = wallAbs.strength;
      signalVector.momentum = signalVector.momentum * (1 - sup * 0.88); // most noisy
      signalVector.obv = signalVector.obv * (1 - sup * 0.68); // wrong-dir accumulation
      signalVector.stochrsi = signalVector.stochrsi * (1 - sup * 0.52); // reacts to wick overshoots
      // Inject absorption counter-bias via persistence (highest-quality weight)
      const absorbBias = wallAbs.dir * sup * 0.65;
      signalVector.persistence = clamp(signalVector.persistence * 0.4 + absorbBias, -1, 1);
    }
    // ── MDT: Momentum Decision Tree (preemptive bias engine) ──────────────
    const reversalFlags = detectReversalFlags(candles, rsi, macdResult, adxResult, obvSlope, mom);
    const mdt = runMomentumDecisionTree(candles, {
      rsi, emaCross, mom, vwapDevRolling, obvSlope,
      adxResult, macdResult, stochRsiResult, persistence, structure, reversalFlags,
    });
    // Apply bias filter BEFORE composite is computed
    const biasedVector = applyBiasFilter(signalVector, mdt);
    Object.assign(signalVector, biasedVector);
    const activeKeys = Object.keys(signalVector).filter(key => includeMicrostructure || !MICRO_SIGNAL_KEYS.includes(key));
    const modelActiveKeys = KALSHI_VERIFY_ONLY
      ? activeKeys.filter(key => key !== 'mktSentiment')
      : activeKeys;
    // Regime detection BEFORE composite — adaptiveWeights must affect actual score computation
    const _tapeNorm = tradeFlow ? { buyRatio: tradeFlow.buyRatio / 100 } : null;
    const liveRegime = detectLiveRegime(candles, bookAnalysis, _tapeNorm);
    const regimeWeights = applyRegimeMults(COMPOSITE_WEIGHTS, liveRegime.regime);
    const adaptiveWeights = applyOnlineWeightOverlay(options.sym, regimeWeights);

    // H15-TUNING: Apply h15-specific indicator weights if available and horizon is h15
    let coinBias = PER_COIN_INDICATOR_BIAS[options.sym?.toUpperCase()] ?? {};
    if (options.horizon === 15 && window._h15Tuner) {
      const baseBias = coinBias;
      coinBias = window._h15Tuner.getTunedBias(15, options.sym?.toUpperCase(), baseBias);
    }
    const weightedComposite = keys => {
      const effW = key => ((adaptiveWeights[key] ?? OUTER_ORBITAL_WEIGHTS[key] ?? 0) * (coinBias[key] ?? 1.0));
      const totalWeight = keys.reduce((sum, key) => sum + effW(key), 0) || 1;
      return keys.reduce((sum, key) => sum + signalVector[key] * effW(key), 0) / totalWeight;
    };
    const coreComposite = weightedComposite(CORE_SIGNAL_KEYS);
    const microComposite = includeMicrostructure ? weightedComposite(MICRO_SIGNAL_KEYS) : 0;
    const rawComposite = weightedComposite(modelActiveKeys);
    const tapeVelocity = buildTapeVelocityProfile(candles, tradeFlow, liveRegime, rawComposite);

    // ADX gate: suppress signal in flat/ranging markets (ADX < 20 = noise).
    // Proportional — dead-flat market (ADX=5) dampens composite by 75%.
    const adxGate = adxResult.adx < 10
      ? Math.max(0.05, adxResult.adx / 10 * 0.25)
      : adxResult.adx < 20
        ? Math.max(0.25, adxResult.adx / 20)
        : 1.0;

    // Amplify: realistic composite range is 0–0.45 → stretch to 0–0.9 so
    // high-agreement signals reach meaningful confidence levels in the UI.
    const composite = rawComposite; // keep raw for downstream use
    const mdtScoreMult = (() => {
      if (!mdt || Math.abs(mdt.biasScore) < 0.18 || mdt.biasConf < 35) return 1;
      const aligns = Math.sign(rawComposite) === Math.sign(mdt.biasScore) || rawComposite === 0;
      const strength = Math.abs(mdt.biasScore) * (mdt.biasConf / 95);
      const maxEffect = mdt.preemptive ? 0.18 : 0.11;
      return aligns ? (1 + strength * maxEffect) : (1 - strength * maxEffect * 0.65);
    })();
    const _sessMult = 1.0; // session multipliers removed — crypto is 24/7

    // CRITICAL FIX 2026-05-06: Detect bearish divergence (uptrend + negative momentum = reversal imminent)
    // Signal: price trending up but momentum falling = exhaustion = reverse is coming
    // Use REAL-TIME CFM momentum (from window._cfm) not stale 6-bar ROC — CFM has live tick momentum
    // SAFE: Fallback to candle ROC if CFM not available (prevents crashes if CFM loads late)
    let liveRealtimeMomentum = mom;  // Start with candle ROC as safe default
    try {
      const cfmData = window._cfm?.[options.sym?.toUpperCase()];
      if (cfmData && typeof cfmData.momentum === 'number') {
        liveRealtimeMomentum = cfmData.momentum;  // Override with real-time CFM only if valid
      }
    } catch (e) {
      // Silently fall back to mom if CFM access fails — don't crash
    }

    const modelCompositeDir = rawComposite > 0.05 ? 1 : rawComposite < -0.05 ? -1 : 0;
    const liveMomentumDir = liveRealtimeMomentum > 0.02 ? 1 : liveRealtimeMomentum < -0.02 ? -1 : 0;
    const liveMomentumDivergence = modelCompositeDir !== 0 && liveMomentumDir !== 0 && modelCompositeDir !== liveMomentumDir;
    const divergenceSuppression = liveMomentumDivergence
      ? (options.sym?.toUpperCase() === 'SOL' ? 0.42 : 0.58)
      : 1.0;

    // ★ NEW (2026-05-15): Microstructure Consensus Logic
    // FINDING: Momentum alone shows 47% directional accuracy (worse than random)
    // STRATEGY: Use microstructure signals to validate/override momentum direction
    // RULE: Fire signal only if 2+ signals agree (funding+book+vacuum+momentum)
    let consensusDirection = 0;  // -1=bearish, 0=conflict, +1=bullish
    let consensusConfidence = 0;  // 0-1 scale
    const microSignals = [
      { name: 'funding', sig: fundingRateSig, strength: Math.abs(fundingRateSig) * 0.45 },
      { name: 'book', sig: orderBookImbalanceSig, strength: Math.abs(orderBookImbalanceSig) * 0.50 },
      { name: 'imbalanceVelocity', sig: imbalanceVelocitySig, strength: Math.abs(imbalanceVelocitySig) * 0.40 },
      { name: 'vacuum', sig: liquidityVacuumSig, strength: Math.abs(liquidityVacuumSig) * 0.35 },
    ];

    // Count agreements (2+ signals pointing same direction = consensus)
    const bullCount = microSignals.filter(s => s.sig > 0.05).length + (momSig > 0.05 ? 1 : 0);
    const bearCount = microSignals.filter(s => s.sig < -0.05).length + (momSig < -0.05 ? 1 : 0);

    if (bullCount >= 2) {
      consensusDirection = 1;  // Bullish consensus
      consensusConfidence = Math.min(1, bullCount * 0.35);  // 2 signals → 70%, 3 → 95%, 4 → 100%
    } else if (bearCount >= 2) {
      consensusDirection = -1;  // Bearish consensus
      consensusConfidence = Math.min(1, bearCount * 0.35);
    }
    // else: consensusDirection = 0 (conflict, no consensus)

    // Apply consensus override as a directional blend. The previous multiplier
    // could amplify the wrong sign when consensus and raw composite disagreed.
    let consensusComposite = rawComposite;
    let consensusAdjustment = 0;
    if (consensusDirection !== 0 && consensusConfidence > 0.5) {
      const consensusTarget = consensusDirection * clamp(consensusConfidence * 0.44, 0.18, 0.44);
      const compositeConflicts = Math.sign(rawComposite) !== 0 && Math.sign(rawComposite) !== consensusDirection;
      const blend = compositeConflicts ? 0.68 : 0.24;
      consensusComposite = clamp(rawComposite * (1 - blend) + consensusTarget * blend, -1, 1);
      consensusAdjustment = consensusComposite - rawComposite;
    }

    // Log consensus (only if meaningful)
    if ((bullCount >= 2 || bearCount >= 2) && Math.abs(liveRealtimeMomentum) > 0.05) {
      predictionDebugLog(`consensus:${options.sym}`, 'log', () => `[CONSENSUS] ${options.sym}: direction=${consensusDirection > 0 ? 'BULL' : 'BEAR'} conf=${(consensusConfidence*100).toFixed(0)}% (${bullCount+bearCount} signals), mom=${momSig.toFixed(2)}`, 10000);
    }

    // --- QuantCore HMM Regime Gating ---
    let hmmConfidenceMult = 1.0;
    if (window.QuantCore?.hmm && options.sym) {
      try {
        const obsSeq = [];
        // Generate observations for the last 5 periods to feed the HMM
        for(let i = 5; i > 0; i--) {
          const p1 = closes[closes.length - i];
          const p0 = closes[closes.length - i - 1] || p1;
          obsSeq.push({
             returns: (p1 - p0) / (p0 || 1),
             vol: calcStdDev(closes.slice(-15 - i, -i || undefined), 10) / p1,
             orderflow: orderBookImbalanceSig || 0,
             fundingRate: fundingRateSig || 0
          });
        }
        const hmmResult = window.QuantCore.hmm.classify(obsSeq);
        if (hmmResult.regime === 'CASCADE') {
           hmmConfidenceMult = 0.5; // Moderate penalty for cascade (free-fall)
        } else if (hmmResult.regime === 'CHOP') {
           // In chop, we only trade strong breakouts. If raw signal is weak, penalize it.
           // If the signal is very strong, let it ride.
           if (Math.abs(consensusComposite) < 0.25) {
             hmmConfidenceMult = 0.6; 
           } else {
             hmmConfidenceMult = 0.9; // Allow strong signals through chop
           }
        }
      } catch (err) {}
    }

    // 🌟 PHASE INVERSION: Flipped score output to capitalize on 45% systematic loss rate
    const score = -1 * clamp(consensusComposite * 1.6 * adxGate * divergenceSuppression * hmmConfidenceMult * (ENABLE_MDT_SCORE_MULT ? mdtScoreMult : 1) * _sessMult * (tapeVelocity.scoreBoostMult || 1), -1, 1);
    const agreement = summarizeAgreement(Object.fromEntries(modelActiveKeys.map(key => [key, signalVector[key]])));
    const coreAgreement = summarizeAgreement(Object.fromEntries(CORE_SIGNAL_KEYS.map(key => [key, signalVector[key]])));

    const indicatorsPack = { rsi, emaCross, vwapDev: vwapDevRolling, vwapBands };
    const scalpSetups = includeSetups ? detectScalpSetups(candles, indicatorsPack, bookAnalysis, tradeFlow, session) : [];

    const indicatorsSummary = {
      rsi: { value: rsi, signal: rsiSig, label: rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : rsi > 55 ? 'Bullish' : rsi < 45 ? 'Bearish' : 'Neutral' },
      ema: { value: emaCross, signal: emaSig, label: emaCross > 0.1 ? 'Bull Cross' : emaCross < -0.1 ? 'Bear Cross' : 'Converging', ema9: ema9[ema9.length - 1], ema21: ema21[ema21.length - 1] },
      vwap: { value: vwapDevRolling, signal: vwapSig, price: vwapRollingLast, bands: vwapBands, label: Math.abs(vwapDevRolling) < 0.3 ? 'At VWAP' : vwapDevRolling > 0 ? 'Above VWAP' : 'Below VWAP' },
      obv: { slope: obvSlope, signal: obvSig, label: obvSlope > 2 ? 'Accumulation' : obvSlope < -2 ? 'Distribution' : 'Flat' },
      volume: { buyPct: buyV / ((buyV + sellV) || 1) * 100, sellPct: sellV / ((buyV + sellV) || 1) * 100, ratio: volRatio, signal: volSig, label: volRatio > 1.2 ? 'Buy Pressure' : volRatio < 0.8 ? 'Sell Pressure' : 'Balanced' },
      momentum: { value: mom, signal: momSig, label: mom > 0.5 ? 'Rising' : mom < -0.5 ? 'Falling' : 'Flat' },
      bands: { position: bands.position, widthPct: bands.widthPct, signal: bandSig, upper: bands.upper, lower: bands.lower, label: bands.position >= 0.88 ? 'Upper-band stretch' : bands.position <= 0.12 ? 'Lower-band stretch' : 'Inside bands' },
      persistence,
      structure,
      book: bookAnalysis,
      flow: { ...tradeFlow, signal: flowSig },
      microstructure: microstructure || {
        composite: 0,
        sweep: { score: 0, label: 'No tape' },
        vacuum: { active: false, severity: 0, label: 'Unknown' },
        toxicity: { available: false, proxy: 0, vpin: 0, tox: 0, label: 'Unavailable' },
        spoofing: { score: 0, direction: 0, side: 'none', label: 'Unavailable' },
        iceberg: { score: 0, direction: 0, side: 'none', label: 'Unavailable' },
      },
      macd: { macd: macdResult.macd, signal: macdResult.signal, histogram: macdResult.histogram, sig: macdSig, label: macdResult.histogram > 0 ? (macdResult.macd > macdResult.signal ? 'Bull MACD' : 'Bullish') : (macdResult.macd < macdResult.signal ? 'Bear MACD' : 'Bearish') },
      stochrsi: { k: stochRsiResult.k, d: stochRsiResult.d, signal: stochSig, label: stochRsiResult.k > 80 ? 'Overbought' : stochRsiResult.k < 20 ? 'Oversold' : stochRsiResult.k > stochRsiResult.d ? 'Bull cross' : 'Bear cross' },
      ichimoku: { ...ichimoku, signal: ichiSig, label: ichimoku.cloudPos === 'above' ? 'Above cloud' : ichimoku.cloudPos === 'below' ? 'Below cloud' : 'In cloud' },
      williamsR: { value: wR, signal: wRSig, label: wR > -20 ? 'Overbought' : wR < -80 ? 'Oversold' : 'Neutral' },
      mfi: { value: mfi, signal: mfiSig, label: mfi > 80 ? 'Overbought' : mfi < 20 ? 'Oversold' : mfi > 55 ? 'Bullish' : mfi < 45 ? 'Bearish' : 'Neutral' },
      hma: { value: hmaCurr, slope: hmaSlope, signal: hmaSig, label: hmaSlope > 0.04 ? 'Rising' : hmaSlope < -0.04 ? 'Falling' : 'Flat' },
      vwma: { value: vwmaCurr, slope: vwmaSlope, dev: vwmaDevPct, signal: vmaSig, label: vwmaDevPct > 0.3 ? 'Price above VWMA' : vwmaDevPct < -0.3 ? 'Price below VWMA' : 'At VWMA' },
      mktSentiment: {
        kalshi: mktData?.kalshi ?? null,
        poly: mktData?.poly ?? null,
        combined: mktData?.combinedProb ?? null,
        signal: mktSig,
        label: mktSig > 0.3 ? 'Markets say UP' : mktSig < -0.3 ? 'Markets say DOWN' : 'Markets neutral',
      },
      tapeVelocity: {
        state: tapeVelocity.state,
        label: tapeVelocity.label,
        rangeExpansion: tapeVelocity.rangeExpansion,
        bodyExpansion: tapeVelocity.bodyExpansion,
        volumeBurst: tapeVelocity.volumeBurst,
        directionalConsistency: tapeVelocity.directionalConsistency,
        targetDriftMult: tapeVelocity.targetDriftMult,
        rangeExpansionMult: tapeVelocity.rangeExpansionMult,
      },
      cmcMacro: {
        signal: cmcMacroSig,
        label: cmcMacroSig > 0.15 ? 'CMC: Alts favored' : cmcMacroSig < -0.15 ? 'CMC: BTC dominance' : 'CMC: Neutral',
      },
      // ★ NEW: Advanced market microstructure signals (2026-05-15)
      fundingRate: {
        signal: fundingRateSig,
        meta: microStructureMeta.funding,
        label: microStructureMeta.funding
          ? `Funding: ${microStructureMeta.funding.pressure} (${(microStructureMeta.funding.signal * 100).toFixed(1)}%)`
          : 'Funding: N/A',
      },
      orderBookImbalance: {
        signal: orderBookImbalanceSig,
        meta: microStructureMeta.imbalance,
        label: microStructureMeta.imbalance
          ? `Book 10/20: ${microStructureMeta.imbalance.type} (${(microStructureMeta.imbalance.signal * 100).toFixed(1)}%)`
          : 'Book: Neutral',
      },
      imbalanceVelocity: {
        signal: imbalanceVelocitySig,
        meta: microStructureMeta.velocity,
        label: microStructureMeta.velocity
          ? `Imbalance velocity: ${microStructureMeta.velocity.band || 'stable'} (${(microStructureMeta.velocity.value * 100).toFixed(1)}%)`
          : 'Imbalance velocity: stable',
      },
      liquidityDepth: {
        signal: liquidityDepthSig,
        meta: microStructureMeta.liquidity,
        label: microStructureMeta.liquidity
          ? `Liquidity: ${microStructureMeta.liquidity.band || 'normal'} (${Math.round((microStructureMeta.liquidity.score || 0) * 100)} score)`
          : 'Liquidity: unknown',
      },
      liquidityVacuum: {
        signal: liquidityVacuumSig,
        meta: microStructureMeta.vacuum,
        label: microStructureMeta.vacuum
          ? `Vacuum: ${microStructureMeta.vacuum.type} risk=${(microStructureMeta.vacuum.risk * 100).toFixed(1)}%`
          : 'Vacuum: None detected',
      },
      // ★ NEW: Consensus model metrics (2026-05-15)
      microstructureConsensus: {
        direction: consensusDirection,  // -1/0/+1
        confidence: consensusConfidence,  // 0-1 scale
        signalCount: bullCount + bearCount,  // How many signals agreed
        adjustedComposite: consensusComposite,
        adjustment: consensusAdjustment,
        label: consensusDirection > 0
          ? `Consensus BULL (${(consensusConfidence*100).toFixed(0)}% confidence)`
          : consensusDirection < 0
            ? `Consensus BEAR (${(consensusConfidence*100).toFixed(0)}% confidence)`
            : 'No consensus (conflict)',
      },
    };
    const driverSummary = summarizeSignalDrivers(signalVector, indicatorsSummary);
    const dir = directionFromScore(score);

    // DIAGNOSTIC: Signal composition analysis for weak coins
    if (isWeakCoin && Math.abs(score) > 0.20) {  // Interesting signals only
      const topIndicators = Object.entries(signalVector)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 5)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`);
      const conf = confidenceFromScore(Math.abs(score));
      console.debug(`[SIGNAL-COMP] ${options.sym}: score=${score.toFixed(3)} conf=${conf}% dir=${dir} bull=${agreement.bulls}/${agreement.active} top: ${topIndicators.join(' ')}`);
    }

    // Build sigVec for rationale(named signal contributions, using adaptive weights)
    const _sigVec = [];
    if (typeof rsiSig !== 'undefined') _sigVec.push({ name: 'rsi', value: rsiSig, weight: adaptiveWeights.rsi ?? COMPOSITE_WEIGHTS.rsi ?? 0.06 });
    if (typeof macdSig !== 'undefined') _sigVec.push({ name: 'macd', value: macdSig, weight: adaptiveWeights.macd ?? COMPOSITE_WEIGHTS.macd ?? 0.07 });
    if (typeof emaSig !== 'undefined') _sigVec.push({ name: 'ema', value: emaSig, weight: adaptiveWeights.ema ?? COMPOSITE_WEIGHTS.ema ?? 0.05 });
    if (typeof hmaSig !== 'undefined') _sigVec.push({ name: 'hma', value: hmaSig, weight: adaptiveWeights.hma ?? COMPOSITE_WEIGHTS.hma ?? 0.07 });
    if (typeof bandSig !== 'undefined') _sigVec.push({ name: 'bands', value: bandSig, weight: adaptiveWeights.bands ?? COMPOSITE_WEIGHTS.bands ?? 0.08 });
    if (typeof stochSig !== 'undefined') _sigVec.push({ name: 'stochrsi', value: stochSig, weight: adaptiveWeights.stochrsi ?? COMPOSITE_WEIGHTS.stochrsi ?? 0.04 });
    if (typeof wRSig !== 'undefined') _sigVec.push({ name: 'williamsR', value: wRSig, weight: adaptiveWeights.williamsR ?? COMPOSITE_WEIGHTS.williamsR ?? 0.07 });
    if (typeof bookSigAdj !== 'undefined') _sigVec.push({ name: 'book', value: bookSigAdj, weight: adaptiveWeights.book ?? COMPOSITE_WEIGHTS.book ?? 0.25 });
    if (typeof obvSig !== 'undefined') _sigVec.push({ name: 'obv', value: obvSig, weight: adaptiveWeights.obv ?? COMPOSITE_WEIGHTS.obv ?? 0.07 });
    if (typeof cciSig !== 'undefined') _sigVec.push({ name: 'cci', value: cciSig, weight: adaptiveWeights.cci ?? COMPOSITE_WEIGHTS.cci ?? 0.05 });
    if (typeof fngSig !== 'undefined') _sigVec.push({ name: 'fearGreed', value: fngSig, weight: adaptiveWeights.fearGreed ?? COMPOSITE_WEIGHTS.fearGreed ?? 0.12 });
    if (typeof vwapSig !== 'undefined') _sigVec.push({ name: 'vwap', value: vwapSig, weight: adaptiveWeights.vwap ?? OUTER_ORBITAL_WEIGHTS.vwap ?? 0.05 });
    if (typeof flowSig !== 'undefined') _sigVec.push({ name: 'flow', value: flowSig, weight: adaptiveWeights.flow ?? COMPOSITE_WEIGHTS.flow ?? 0.22 });
    if (typeof toxicitySig !== 'undefined') _sigVec.push({ name: 'toxicity', value: toxicitySig, weight: adaptiveWeights.toxicity ?? COMPOSITE_WEIGHTS.toxicity ?? 0.06 });
    if (typeof spoofSig !== 'undefined') _sigVec.push({ name: 'spoof', value: spoofSig, weight: adaptiveWeights.spoof ?? COMPOSITE_WEIGHTS.spoof ?? 0.07 });
    if (typeof icebergSig !== 'undefined') _sigVec.push({ name: 'iceberg', value: icebergSig, weight: adaptiveWeights.iceberg ?? COMPOSITE_WEIGHTS.iceberg ?? 0.08 });
    if (typeof volSig !== 'undefined') _sigVec.push({ name: 'volume', value: volSig, weight: adaptiveWeights.volume ?? COMPOSITE_WEIGHTS.volume ?? 0.10 });
    if (!KALSHI_VERIFY_ONLY && typeof mktSig !== 'undefined') _sigVec.push({ name: 'mktSentiment', value: mktSig, weight: adaptiveWeights.mktSentiment ?? COMPOSITE_WEIGHTS.mktSentiment ?? 0.18 });
    // ★ NEW: Microstructure signals (higher priority due to real-time market data)
    if (typeof fundingRateSig !== 'undefined' && Math.abs(fundingRateSig) > 0.01) _sigVec.push({ name: 'fundingRate', value: fundingRateSig, weight: adaptiveWeights.fundingRate ?? 0.15 });
    if (typeof orderBookImbalanceSig !== 'undefined' && Math.abs(orderBookImbalanceSig) > 0.01) _sigVec.push({ name: 'orderBookImbalance', value: orderBookImbalanceSig, weight: adaptiveWeights.orderBookImbalance ?? 0.16 });
    if (typeof imbalanceVelocitySig !== 'undefined' && Math.abs(imbalanceVelocitySig) > 0.01) _sigVec.push({ name: 'imbalanceVelocity', value: imbalanceVelocitySig, weight: adaptiveWeights.imbalanceVelocity ?? 0.12 });
    if (typeof liquidityDepthSig !== 'undefined' && Math.abs(liquidityDepthSig) > 0.01) _sigVec.push({ name: 'liquidityDepth', value: liquidityDepthSig, weight: adaptiveWeights.liquidityDepth ?? 0.08 });
    if (typeof liquidityVacuumSig !== 'undefined' && Math.abs(liquidityVacuumSig) > 0.01) _sigVec.push({ name: 'liquidityVacuum', value: liquidityVacuumSig, weight: adaptiveWeights.liquidityVacuum ?? 0.12 });

    // Resolve kalshi probability for alignment check
    const _kalshiProb = mktData?.combinedProb ?? null;
    const rationale = buildRationale(_sigVec, liveRegime, _kalshiProb, options.sym || '');
    const projectionTargetDriftMult = tapeVelocity.targetDriftMult || 1;
    const projectionRangeExpansionMult = tapeVelocity.rangeExpansionMult || 1;

    return {
      price: lastPrice,
      score,
      signal: signalFromScore(score),
      confidence: Math.round(clamp(confidenceFromScore(Math.abs(score)) * (tapeVelocity.confidenceBoostMult || 1), 0, 95)),
      indicators: indicatorsSummary,
      projections: SHORT_HORIZON_MINUTES.reduce((acc, horizonMin) => {
        let targetScale = horizonMin / 60;
        let rangeScale = Math.max(0.12, Math.sqrt(horizonMin / 15) * 0.5) * projectionRangeExpansionMult;
        let target = lastPrice * (1 + mom / 100 * targetScale * projectionTargetDriftMult);
        const entry = projectionKey(horizonMin);

        if (horizonMin === 15) {
          const ns = getNextCandleSession();
          targetScale = ns.minsRemaining / 60;
          rangeScale = Math.max(0.05, Math.sqrt(ns.minsRemaining / 15) * 0.5) * projectionRangeExpansionMult;
          target = lastPrice * (1 + mom / 100 * targetScale * projectionTargetDriftMult);
          acc[entry] = { horizonMin, target, high: target + atr * rangeScale, low: target - atr * rangeScale };
          acc[entry].nextSession = {
            target: target,
            high: target + atr * rangeScale,
            low: target - atr * rangeScale,
            opensIn: ns.minsRemaining,
            isPivoted: ns.isPivoted,
            open: ns.nextOpen,
            close: ns.nextClose,
            maturity: ns.maturity,
            freshEntry: ns.freshEntry,
            lateEntry: ns.lateEntry,
          };
        } else {
          acc[entry] = { horizonMin, target, high: target + atr * rangeScale, low: target - atr * rangeScale };
        }
        return acc;
      }, {}),
      volatility: { atr, atrPct, label: atrPct > 2 ? 'High' : atrPct > 0.8 ? 'Medium' : 'Low' },
      session,
      nextCandleSession: getNextCandleSession(),
      scalpSetups,
      mdt,
      reversalFlags,
      rationale,
      liveRegime,
      adaptiveWeights,
      adaptiveWeightState: JSON.parse(JSON.stringify(_ensureOnlineState(options.sym))),
      diagnostics: {
        agreement: agreement.agreement,
        conflict: agreement.conflict,
        activeSignals: agreement.active,
        bullishSignals: agreement.bulls,
        bearishSignals: agreement.bears,
        consensusLabel: agreement.label,
        tapeVelocity,
        components: signalVector,
        coreScore: clamp(coreComposite, -1, 1),
        microScore: clamp(microComposite, -1, 1),
        consensusComposite,
        consensusAdjustment,
        liveMomentumDivergence,
        liveRealtimeMomentum,
        coreAgreement: coreAgreement.agreement,
        persistenceScore: persistence.signal,
        structureBias: structure.signal,
        structureZone: structure.zone,
        topDrivers: driverSummary.topDrivers,
        driverSummary: driverSummary.driverSummary,
        microstructure: indicatorsSummary.microstructure,
        wallAbsorption: wallAbs,
        mdt,
        reversalFlags,
        mdtScoreMult,
      },
    };
  }
