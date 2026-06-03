/**
 * Specialized LLM Prompt Generator
 *
 * Converts generic regime analysis into deep quant meta-analysis
 * Teaches LLM the mechanics of your 9-indicator engine
 */

const INDICATOR_SPECS = {
  RSI: {
    name: "Relative Strength Index",
    period: 14,
    range: [0, 100],
    thresholds: {
      overbought: 70,
      overbought_extreme: 80,
      oversold_extreme: 20,
      oversold: 30,
      neutral_high: 55,
      neutral_low: 45,
    },
    interpretation: `
RSI > 70: Overbought (short/reversal bias)
RSI > 80: Extreme overbought (strong reversal signal)
RSI 55-70: Bullish momentum (sustained uptrend)
RSI 45-55: Neutral (no directional bias)
RSI 30-45: Bearish momentum (sustained downtrend)
RSI < 30: Oversold (long/reversal bias)
RSI < 20: Extreme oversold (strong reversal signal)

DIVERGENCES: If price makes new high but RSI doesn't = bearish divergence (short)
If price makes new low but RSI doesn't = bullish divergence (long)
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.62,
      mean_reversion: 0.58,
      chop_noise: 0.51,
      breakout_volatility: 0.65,
    },
  },

  MACD: {
    name: "Moving Average Convergence Divergence",
    params: "12/26/9",
    interpretation: `
MACD > Signal Line AND MACD > 0: Bullish (buy signal)
MACD < Signal Line AND MACD < 0: Bearish (sell signal)
MACD > Signal Line BUT MACD < 0: Bullish crossover (early entry)
MACD < Signal Line BUT MACD > 0: Bearish crossover (early exit)
MACD Histogram increasing: Momentum strengthening
MACD Histogram decreasing: Momentum weakening
MACD Histogram reversal: Possible trend change coming

STRENGTH: Larger histogram = stronger momentum
Small histogram = weak momentum, likely reversal zone
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.54,
      mean_reversion: 0.52,
      chop_noise: 0.49,
      breakout_volatility: 0.58,
    },
  },

  CCI: {
    name: "Commodity Channel Index",
    period: 20,
    thresholds: {
      bullish_extreme: 100,
      bearish_extreme: -100,
      bullish_moderate: 0,
      bearish_moderate: 0,
    },
    interpretation: `
CCI > 100: Extreme bullish cycle (overbought, mean reversion risk)
CCI 0-100: Moderate bullish cycle (sustained uptrend)
CCI -100 to 0: Moderate bearish cycle (sustained downtrend)
CCI < -100: Extreme bearish cycle (oversold, mean reversion risk)
CCI oscillating around 0: Choppy/ranging market (low signal quality)
CCI breakout above/below ±100: Strong trend reversal signal

CYCLICAL NATURE: CCI is mean-reverting by design
Extreme readings often precede reversals
Use CCI divergences same as RSI
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.58,
      mean_reversion: 0.61,
      chop_noise: 0.50,
      breakout_volatility: 0.59,
    },
  },

  Fisher: {
    name: "Fisher Transform",
    range: [-3, 3],
    interpretation: `
Fisher > 0.5: Bullish reversal signal (price likely to turn up)
Fisher > 1.0: Strong bullish reversal
Fisher < -0.5: Bearish reversal signal (price likely to turn down)
Fisher < -1.0: Strong bearish reversal
Fisher between -0.5 and 0.5: Neutral (no reversal signal)
Fisher crosses zero: Potential trend change (weak signal alone)
Fisher divergence: If price makes extreme but Fisher doesn't = strong signal

TIMING: Fisher is a LEADING indicator (turns before price)
Best used in mean reversion or chop regimes
Can be early/wrong in strong trends
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.60,
      mean_reversion: 0.64,
      chop_noise: 0.56,
      breakout_volatility: 0.62,
    },
  },

  ADX: {
    name: "Average Directional Index",
    range: [0, 100],
    thresholds: {
      strong_trend: 40,
      moderate_trend: 25,
      weak_trend: 15,
      no_trend: 0,
    },
    interpretation: `
ADX > 40: Very strong trending market (directional confidence high)
ADX 25-40: Strong trend in progress (good direction signal)
ADX 15-25: Weak to moderate trend (mixed signals)
ADX < 15: Choppy/ranging (trend absent, mean reversion bias)
ADX rising: Trend strengthening (momentum accelerating)
ADX falling: Trend weakening (consolidation coming)

+DI > -DI: Uptrend dominant (favor long bias)
-DI > +DI: Downtrend dominant (favor short bias)
ADX extreme (>50): Overextended move, reversal possible soon
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.59,
      mean_reversion: 0.52,
      chop_noise: 0.48,
      breakout_volatility: 0.61,
    },
  },

  ATR: {
    name: "Average True Range",
    period: 14,
    interpretation: `
ATR is VOLATILITY measure, not direction
High ATR: Large price swings (use wider stops, lower leverage)
Low ATR: Small price swings (use tight stops, can scale up)
ATR expanding: Volatility increasing (breakout risk)
ATR contracting: Volatility decreasing (consolidation)
ATR near 52-week high: Market very active (momentum strong)
ATR near 52-week low: Market quiet (range-bound)

USE: To scale position size and gates, NOT for direction
Pair with directional indicators (RSI, MACD, CCI)
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.55,
      mean_reversion: 0.54,
      chop_noise: 0.53,
      breakout_volatility: 0.68,
    },
  },

  OrderBook: {
    name: "Order Book Imbalance",
    range: [0, 1],
    interpretation: `
Imbalance 0.0-0.5: Balanced (near 50/50 buy/sell volume)
Imbalance 0.5-0.6: Slight bullish bias (weak buy pressure)
Imbalance 0.6-0.75: Strong bullish bias (sustained buying)
Imbalance > 0.75: Extreme bullish (all-in buyers, exhaustion risk)
Imbalance 0.4-0.5: Slight bearish bias (weak sell pressure)
Imbalance 0.25-0.4: Strong bearish bias (sustained selling)
Imbalance < 0.25: Extreme bearish (all-in sellers, reversal likely)

INTERPRETATION:
Near 0.5 = noise, low signal quality
Extreme (>0.75 or <0.25) = potential reversal (mean reversion setup)
Sustained 0.6-0.75 or 0.25-0.4 = trend confirmation
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.61,
      mean_reversion: 0.55,
      chop_noise: 0.50,
      breakout_volatility: 0.64,
    },
  },

  KalshiPercent: {
    name: "Kalshi Market Probability",
    range: [0, 1],
    interpretation: `
Kalshi % is the CROWD's aggregate probability
Kalshi % > 0.65: Crowd strongly bullish (YES votes concentrated)
Kalshi % 0.55-0.65: Crowd moderately bullish
Kalshi % 0.45-0.55: Crowd indecisive (near 50/50)
Kalshi % 0.35-0.45: Crowd moderately bearish
Kalshi % < 0.35: Crowd strongly bearish (NO votes concentrated)

DIVERGENCE: If model says UP but Kalshi <45% = major conflict
If model says DOWN but Kalshi >55% = major conflict
These conflicts often signal reversal or model error

USE: Cross-check model predictions
High Kalshi alignment = high confidence trade
Low Kalshi alignment = hedge or reduce size
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.58,
      mean_reversion: 0.52,
      chop_noise: 0.50,
      breakout_volatility: 0.60,
    },
  },

  CrowdFade: {
    name: "Crowd Fade (Contrarian)",
    interpretation: `
Crowd Fade = opposite of crowd bias
High Fade signal when Kalshi extreme but price stalled
Example: Kalshi 85% YES, but price near open → potential SHORT

THEORY: Crowds cluster at extremes, then markets reverse
Strongest in mean reversion regimes
Weakest in strong trending markets
Avoid in breakout volatility

USE: Secondary signal, not primary
Combine with RSI/MACD/CCI for confirmation
    `.trim(),
    historicalWinRate: {
      trend_continuation: 0.48,
      mean_reversion: 0.63,
      chop_noise: 0.55,
      breakout_volatility: 0.44,
    },
  },
};

const REGIME_RULES = {
  trend_continuation: {
    description: "Strong directional bias, aligned signals, high momentum",
    strongSignals: ["RSI", "MACD", "ADX", "OrderBook"],
    weakSignals: ["CrowdFade", "Fisher"],
    tips: `
Focus on: RSI, MACD, ADX, OrderBook imbalance
Boost weights: RSI (+10%), MACD (+8%), ADX (+5%)
Reduce weights: CrowdFade (-15%), Fisher (-10%)
Confidence gates: STANDARD (75%)
Avoid mean reversion trades
Follow the trend until ADX peaks then reverses
    `.trim(),
  },

  mean_reversion: {
    description: "Indicators diverge from price, exhaustion, choppy reversals",
    strongSignals: ["Fisher", "CCI", "CrowdFade", "RSI_extreme"],
    weakSignals: ["MACD", "ADX"],
    tips: `
Focus on: RSI extremes, CCI reversals, Fisher turns, CrowdFade
Boost weights: Fisher (+15%), CCI (+12%), CrowdFade (+10%), RSI (+8%)
Reduce weights: MACD (-15%), ADX (-20%)
Confidence gates: LOOSE (60%)
Watch for RSI/CCI divergences (price new high/low, indicator doesn't)
Fade extreme Kalshi readings (>85% or <15%)
    `.trim(),
  },

  chop_noise: {
    description: "Low momentum, conflicting signals, ranging market",
    strongSignals: ["ATR_low", "OrderBook_near_50"],
    weakSignals: ["all_momentum"],
    tips: `
Focus on: ATR (low), OrderBook (near 0.5)
Reduce all weights equally: -5% across board
Confidence gates: VERY LOOSE (50%) or skip entirely
Avoid trading in chop - wait for breakout setup
Monitor ATR expansion for exit signal
Use tighter stops, lower size
    `.trim(),
  },

  breakout_volatility: {
    description: "Very high volatility, strong directional bias, extreme swings",
    strongSignals: ["RSI", "OrderBook", "ADX", "ATR_high"],
    weakSignals: ["Fisher", "CrowdFade"],
    tips: `
Focus on: RSI, OrderBook extremes, ADX strength, ATR expansion
Boost weights: RSI (+8%), OrderBook (+10%), ADX (+10%)
Reduce weights: Fisher (-20%), CrowdFade (-25%)
Confidence gates: STANDARD (75%)
Use wider stops (ATR-based)
Scale size DOWN (volatility risk high)
Watch for false breakouts (RSI >90 often reverses)
    `.trim(),
  },
};

/**
 * Generate specialized system prompt for LLM
 */
function generateSystemPrompt() {
  return `You are an elite crypto trading regime analyst for the WE CFM Orchestrator.
Analyze the market snapshot in the context of a 15-minute Kalshi contract window, not a multi-hour swing trade.

Return ONLY valid JSON with this exact structure:
{
  "regime": "trend_continuation|mean_reversion|chop_noise|breakout_volatility",
  "confidence": 0.0,
  "analysis": {
    "strongest_signal": "",
    "weakest_signal": "",
    "key_conflict": "",
    "reversal_risk": "",
    "anomalies": []
  },
  "suggestions": {
    "increase_weight": [],
    "decrease_weight": [],
    "notes": ""
  },
  "ai_wording": {
    "primary_rationale": "",
    "wait_rationale": "",
    "high_confidence_rationale": "",
    "market_patterns": "",
    "scalp_setups": [
      { "label": "", "ai_description": "" }
    ]
  },
  "warnings": []
}

Rules:
- Pick exactly one regime.
- confidence must be a number from 0.0 to 1.0.
- Confidence must describe the 15-minute contract outcome / repricing window, not a longer spot thesis.
- Use indicator names from the provided current weights map.
- Keep suggestions conservative (small per-cycle nudges only).
- This layer is advisory only: do not override, rename, or replace the model's final direction.
- In suggestions.notes, explicitly mention:
  1. whether the house / Kalshi price looks mispriced, fairly priced, or has no edge,
  2. whether the play is contrarian to the crowd, aligned with crowd momentum, or too crowded to chase,
  3. whether the entry is fresh, mature, or late for this 15-minute window,
  4. the best play right now: buy YES, buy NO, wait, crowd-fade, scalp, or buy then sell early into repricing,
  5. if an early exit before settlement is attractive, say that directly,
  6. any alternate advantageous play if the primary setup is blocked.
- If uncertain, keep increase_weight/decrease_weight empty and explain in notes.
- Use ai_wording.primary_rationale and ai_wording.high_confidence_rationale to talk about the 15-minute window, contract repricing, early-sale opportunity, and house mispricing when relevant.
- Do not output markdown, code fences, or extra commentary.
- Output must parse with JSON.parse exactly as returned.`.trim();
}

// Add dynamic regime detection
function detectRegime(snapshot) {
  const indicators = snapshot.indicators || {};
  const volatility = Number(snapshot.volatility || 0);
  const adx = indicators.ADX?.value || 0;
  const rsi = indicators.RSI?.value || 50;
  
  if (volatility > 1.5) return 'breakout_volatility';
  if (adx < 15) return 'chop_noise';
  if (rsi > 70 || rsi < 30) return 'mean_reversion';
  return 'trend_continuation';
}

// Add signal strength helper
function isSignalStrong(snapshot, indicatorName) {
  const indicators = snapshot.indicators || {};
  const orderbook = snapshot.orderbook || {};
  const volatility = Number(snapshot.volatility || 0);
  
  switch(indicatorName) {
    case 'RSI':
      const rsi = indicators.RSI?.value;
      return rsi && (rsi > 60 || rsi < 40);
    case 'RSI_extreme':
      const rsiExt = indicators.RSI?.value;
      return rsiExt && (rsiExt > 70 || rsiExt < 30);
    case 'MACD':
      const macd = indicators.MACD?.value;
      const sig = indicators.MACD?.signal;
      return typeof macd === 'number' && typeof sig === 'number' && Math.abs(macd - sig) > 0.001;
    case 'ADX':
      return indicators.ADX?.value > 25;
    case 'Fisher':
      const fish = indicators.FisherTransform?.value;
      return fish && Math.abs(fish) > 1.5;
    case 'CCI':
      const cci = indicators.CCI?.value;
      return cci && Math.abs(cci) > 100;
    case 'OrderBook':
      const imb = orderbook.imbalance;
      return imb && (imb > 0.65 || imb < 0.35);
    case 'OrderBook_near_50':
      const imb50 = orderbook.imbalance;
      return imb50 && (imb50 >= 0.45 && imb50 <= 0.55);
    case 'ATR_high':
      return volatility > 1.5;
    case 'ATR_low':
      return volatility < 0.5;
    case 'CrowdFade':
      return snapshot.market?.confidencePct > 80;
    default:
      return false;
  }
}

// Add confidence scoring
function calculateRegimeConfidence(snapshot, regime) {
  const rules = REGIME_RULES[regime];
  if (!rules || !rules.strongSignals || !rules.strongSignals.length) return 0;
  const strongCount = rules.strongSignals.filter(sig => 
    isSignalStrong(snapshot, sig)
  ).length;
  
  return Math.min(strongCount / rules.strongSignals.length, 1.0);
}

/**
 * Generate specialized user prompt with full indicator context
 */
function generateUserPrompt(snapshot) {
  const {
    coin,
    volatility,
    indicators,
    weights,
    recentAccuracy,
    orderbook,
    conflicts,
  } = snapshot;

  const vNum = Number(volatility || 0);
  const obImbalance = Number(orderbook?.imbalance || 0);
  const obBuyPressure = Number(orderbook?.buyPressure || 0);
  const verdictDir = String(snapshot.verdictDir || 'wait');
  const compositeEdge = Number(snapshot.compositeEdge || 0);
  const horizonMinutes = Number(snapshot.horizonMinutes || 15);
  const preferredHorizonMinutes = Number(snapshot.preferredHorizonMinutes || horizonMinutes || 15);
  const marketDirection = String(snapshot.market?.modelDirection || verdictDir || 'WAIT').toUpperCase();
  const confidencePct = Number(snapshot.market?.confidencePct || 0);
  const kalshiProb = Number(snapshot.market?.kalshiProb || 0);
  const combinedProb = Number(snapshot.market?.combinedProb || kalshiProb || 0);
  const marketScore = Number(snapshot.market?.score || 0);
  const executionWindow = snapshot.executionWindow || {};
  const projectedMovePct = Number(executionWindow.projectedMovePct || 0);
  const setupsText = (snapshot.setups || []).map(s => `- ${s.label} (${s.cls}): ${s.desc}`).join('\n') || "NONE";
  const contrarianSetupsText = (snapshot.contrarianSetups || []).map(s => `- ${s.label} (${s.cls}): ${s.desc}`).join('\n') || "NONE";

  const algoRegime = detectRegime(snapshot);
  const algoRegimeConfidence = calculateRegimeConfidence(snapshot, algoRegime);

  let prompt = `Current market snapshot:
Coin: ${coin}
Algorithmic Regime Estimate: ${algoRegime} (Confidence: ${(algoRegimeConfidence*100).toFixed(0)}%)
Verdict: ${verdictDir.toUpperCase()} (Edge: ${compositeEdge.toFixed(3)})
Contract horizon: ${horizonMinutes}m primary window (preferred: ${preferredHorizonMinutes}m)
Model direction for contract: ${marketDirection}
Model confidence: ${confidencePct.toFixed(0)}%
Kalshi / house probability: ${(kalshiProb * 100).toFixed(1)}%
Combined market probability: ${(combinedProb * 100).toFixed(1)}%
Score bias: ${marketScore.toFixed(3)}
Volatility: ${vNum.toFixed(3)} (${classifyVolatilityRegime(vNum)})
Timestamp: ${new Date().toISOString()}

Orderbook:
- Imbalance: ${obImbalance.toFixed(3)}
- Buy pressure: ${(obBuyPressure * 100).toFixed(1)}%

15-minute execution window:
- Current underlying price: ${Number(executionWindow.currentPrice || 0).toFixed(4)}
- Projected target into window: ${Number(executionWindow.projectedTargetPrice || 0).toFixed(4)}
- Projected high / low: ${Number(executionWindow.projectedHighPrice || 0).toFixed(4)} / ${Number(executionWindow.projectedLowPrice || 0).toFixed(4)}
- Projected move: ${(projectedMovePct * 100).toFixed(2)}%
- Seconds to contract close: ${executionWindow.secondsToClose != null ? executionWindow.secondsToClose : 'n/a'}
- Fresh entry: ${executionWindow.freshEntry ? 'yes' : 'no'}
- Late entry: ${executionWindow.lateEntry ? 'yes' : 'no'}

Indicators:
${JSON.stringify(indicators || {}, null, 2)}

Current weights:
${JSON.stringify(weights || {}, null, 2)}

Recent accuracy:
${JSON.stringify(recentAccuracy || {}, null, 2)}

Live Scalp Setups Fired:
${setupsText}

Contrarian Setups Fired:
${contrarianSetupsText}

Conflicts:
${(conflicts && conflicts.length) ? conflicts.join(", ") : "NONE"}

Task:
1. Determine the dominant regime.
2. Set confidence (0.0-1.0) for the 15-minute contract window.
3. Recommend conservative weight nudges only.
4. Flag anomalies and reversal risk.
5. Explain whether the house price is mispriced versus the model.
6. Explain whether the setup is contrarian-to-crowd, crowd-following, or too crowded to chase.
7. Explain whether this is a fresh entry, mature setup, or late entry for the remaining 15-minute window.
8. Explain whether the best play is hold-to-settlement, buy-and-sell-early into repricing, wait, crowd-fade, or scalp.
9. If the model implies the contract should reprice in our favor before settlement, explicitly say that an early exit / sell-early path is available.
10. Provide specific AI UI wording for the primary rationale, wait rationale (if applicable), and rewrite the descriptions for the triggered Scalp/Contrarian setups to give real-time advice.
11. Treat the current model direction as authoritative; if you disagree, describe the conflict as risk, not as a replacement verdict.

Return strict JSON only in the required schema.`;

  return prompt.trim();
}

/**
 * HELPER CLASSIFICATION FUNCTIONS
 */

function classifyVolatilityRegime(vol) {
  if (vol < 0.3) return "low (stable)";
  if (vol < 0.8) return "moderate (normal)";
  if (vol < 1.5) return "high (choppy)";
  return "extreme (whipsaw)";
}

function classifyRSI(rsi) {
  if (!rsi) return "N/A";
  if (rsi > 80) return "EXTREME OVERBOUGHT (strong reversal risk)";
  if (rsi > 70) return "Overbought (short/reversal bias)";
  if (rsi > 55) return "Bullish momentum (sustained uptrend)";
  if (rsi > 45) return "Neutral";
  if (rsi > 30) return "Bearish momentum (sustained downtrend)";
  if (rsi > 20) return "Oversold (long/reversal bias)";
  return "EXTREME OVERSOLD (strong reversal signal)";
}

function classifyMACD(macd, signal) {
  if (!macd || !signal) return "N/A";
  if (macd > signal && macd > 0) return "Bullish (buy signal)";
  if (macd < signal && macd < 0) return "Bearish (sell signal)";
  if (macd > signal && macd < 0) return "Bullish crossover (early entry)";
  if (macd < signal && macd > 0) return "Bearish crossover (early exit)";
  return "Neutral";
}

function classifyCCI(cci) {
  if (!cci) return "N/A";
  if (cci > 100) return "EXTREME BULLISH (overbought, reversal risk)";
  if (cci > 0) return "Moderate bullish cycle";
  if (cci > -100) return "Moderate bearish cycle";
  return "EXTREME BEARISH (oversold, reversal risk)";
}

function classifyFisher(fisher) {
  if (!fisher) return "N/A";
  if (fisher > 1.0) return "Strong bullish reversal";
  if (fisher > 0.5) return "Bullish reversal signal";
  if (fisher > -0.5 && fisher <= 0.5) return "Neutral (no reversal)";
  if (fisher > -1.0) return "Bearish reversal signal";
  return "Strong bearish reversal";
}

function classifyADX(adx) {
  if (!adx) return "N/A";
  if (adx > 40) return "VERY STRONG TREND (high directional confidence)";
  if (adx > 25) return "Strong trend in progress";
  if (adx > 15) return "Weak to moderate trend";
  return "Choppy/ranging market (no trend)";
}

function estimateRSIWinRate(rsi, regime) {
  // Stub: would query historical data
  return 58;
}

function checkCCIDivergence(cci, rsi) {
  if (!cci || !rsi) return "Unknown";
  // Simple divergence check
  return "None detected";
}

function calculateCrowdFade(kalshiPercent) {
  if (!kalshiPercent) return "Unknown";
  if (kalshiPercent > 0.75 || kalshiPercent < 0.25) return "STRONG (fade this)";
  if (kalshiPercent > 0.65 || kalshiPercent < 0.35) return "MODERATE";
  return "WEAK (near 50/50, ignore)";
}

// ══════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════

module.exports = {
  INDICATOR_SPECS,
  REGIME_RULES,
  generateSystemPrompt,
  generateUserPrompt,
};

console.log("[SpecializedPrompt] Module loaded");
