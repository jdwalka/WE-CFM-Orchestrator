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
function generateSystemPrompt(horizonMinutes = 15) {
  const horizon = Number(horizonMinutes) > 0 ? Number(horizonMinutes) : 15;
  return `You are an elite crypto trading regime analyst for the WE CFM Orchestrator.
Analyze the market snapshot in the context of a ${horizon}-minute Kalshi contract window, not a multi-hour swing trade.

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
- Confidence must describe the ${horizon}-minute contract outcome / repricing window, not a longer spot thesis.
- Use indicator names from the provided current weights map.
- Keep suggestions conservative (small per-cycle nudges only).
- This layer is advisory only: do not override, rename, or replace the model's final direction.
- In suggestions.notes, explicitly mention:
  1. whether the house / Kalshi price looks mispriced, fairly priced, or has no edge,
  2. whether the play is contrarian to the crowd, aligned with crowd momentum, or too crowded to chase,
  3. whether the entry is fresh, mature, or late for this ${horizon}-minute window,
  4. the best play right now: buy YES, buy NO, wait, crowd-fade, scalp, or buy then sell early into repricing,
  5. if an early exit before settlement is attractive, say that directly,
  6. any alternate advantageous play if the primary setup is blocked.
- If uncertain, keep increase_weight/decrease_weight empty and explain in notes.
- Use ai_wording.primary_rationale and ai_wording.high_confidence_rationale to talk about the ${horizon}-minute window, contract repricing, early-sale opportunity, and house mispricing when relevant.
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

  switch (indicatorName) {
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
Algorithmic Regime Estimate: ${algoRegime} (Confidence: ${(algoRegimeConfidence * 100).toFixed(0)}%)
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

On-chain side-scan (BTC/ETH/SOL compressed — not raw txs):
${(() => {
  const oc = snapshot.onChainSideScan || snapshot.onChainRecent || null;
  if (!oc) return 'NONE — no OnChainFlow packet';
  try { return JSON.stringify(oc).slice(0, 520); } catch (_) { return 'NONE'; }
})()}

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
 * 5-MINUTE BINARY PTB (polycool.app / Polymarket) PRICE-TO-BEAT PROMPTS (powered by Grok/xAI)
 * Distinct from the 15-minute Kalshi prompts: these frame the task as a 5-minute
 * binary UP/DOWN settlement against an immutable Chainlink-backed price-to-beat.
 * Same JSON schema so normalizeResponse() consumes both identically.
 */

/** Polymarket-published contract PTB only — never RTDS/title/spot proxies. */
const POLY_PTB_CANONICAL_SOURCES = new Set([
  'polymarket-event-page',
  'polymarket-chainlink-candles',
  'gamma-market',
  'gamma-event-metadata',
  'gamma-price-to-beat',
  'polymarket', // oracle-snapshot default label when field locked on market
]);

function _numPtb(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Display decimals for quote prices / PTB (avoid float trails like 62814.80096237142).
 * BTC/ETH/BNB/SOL/HYPE → 2 (cents); XRP/DOGE → 4; else by magnitude.
 */
function priceDecimalsForCoin(coinOrSlug, value) {
  const raw = String(coinOrSlug || '');
  const key = raw.toUpperCase();
  // slug like btc-updown-15m-… or plain BTC
  const fromSlug = (raw.match(/^(btc|eth|sol|xrp|doge|bnb|hype)/i) || [])[1];
  const sym = (fromSlug || key.replace(/[^A-Z]/g, '').slice(0, 5) || key).toUpperCase();
  if (sym === 'BTC' || sym === 'ETH' || sym === 'BNB' || sym === 'SOL' || sym === 'HYPE') return 2;
  if (sym === 'XRP' || sym === 'DOGE') return 4;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && n < 1) return 4;
  return 2;
}

function roundPriceForCoin(coinOrSlug, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const d = priceDecimalsForCoin(coinOrSlug, n);
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Human USD string with fixed decimals (no float garbage). */
function formatUsdForCoin(coinOrSlug, value) {
  const n = roundPriceForCoin(coinOrSlug, value);
  if (n == null) return null;
  const d = priceDecimalsForCoin(coinOrSlug, n);
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
    useGrouping: true,
  });
}

function _coinFromSnapshot(snapshot, slugHint) {
  const trySym = (v) => {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s || /^the\s+asset$/i.test(s)) return '';
    const up = s.toUpperCase();
    if (/^(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)$/.test(up)) return up;
    const m = up.match(/\b(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)\b/);
    return m ? m[1] : '';
  };
  const direct = trySym(snapshot?.coin) || trySym(snapshot?.sym) || trySym(snapshot?.symbol);
  if (direct) return direct;
  const slug = slugHint
    || snapshot?.slug
    || snapshot?.poly5m?.slug
    || snapshot?.poly15m?.slug
    || snapshot?.activeContract?.slug
    || '';
  const m = String(slug).match(/^(btc|eth|sol|xrp|doge|bnb|hype)/i);
  return m ? m[1].toUpperCase() : '';
}

/**
 * Rewrite long float money in model prose: $75.44527553043135 → $75.45 (SOL)
 * Also bare multi-dp numbers after PTB/price wording.
 */
function scrubMoneyFloatsInText(text, coinOrSlug) {
  let s = String(text || '');
  if (!s) return s;
  const coin = String(coinOrSlug || '');
  const reformat = (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return formatUsdForCoin(coin, n);
  };
  // $75.44527553043135 or $62,814.80 or $62814.80096237142
  // Prefer ungrouped full digits; avoid matching only first 3 digits of 62814.
  s = s.replace(/\$([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]+\.[0-9]+|[0-9]+)/g, (full, body) => {
    const frac = (String(body).split('.')[1] || '');
    const want = priceDecimalsForCoin(coin, Number(String(body).replace(/,/g, '')));
    if (!frac) return full; // bare $75 — leave alone
    if (frac.length <= want && !/0{4,}$/.test(frac)) return full;
    return reformat(String(body).replace(/,/g, '')) || full;
  });
  // bare "PTB of 75.44527553043135" (no dollar)
  s = s.replace(
    /\b(PTB|price-to-beat|price to beat)\b([^0-9$]{0,12})([0-9]{1,7}\.[0-9]{3,})/gi,
    (full, label, mid, num) => {
      const fmt = reformat(num);
      return fmt ? `${label}${mid}${fmt}` : full;
    }
  );
  return s;
}

function _sourceOk(src) {
  if (src == null || src === '') return true; // field present on poly market object, no tag
  const s = String(src).toLowerCase();
  if (s.startsWith('rejected:')) return false;
  if (/rtds|twap30|title|provisional|coinbase|binance|gecko|rti|pyth.*proxy|crypto-price|boundary/.test(s)) {
    return false;
  }
  if (POLY_PTB_CANONICAL_SOURCES.has(s)) return true;
  // gamma / chainlink / poly / event / candle / lock / twap (market) tags
  return /poly|gamma|chainlink|clob|candle|lock|event|openprice|pricetobeat/.test(s)
    && !/rtds|title|provisional/.test(s);
}

/**
 * Resolve Polymarket-only price-to-beat for prompts.
 * Prefer poly5m / poly15m / activeContract / polymarketOracle — never invent from spot.
 * @returns {{ ptb: number|null, source: string|null, slug: string|null, pending: boolean }}
 */
function resolvePolymarketPtb(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ptb: null, source: null, slug: null, pending: true, coin: null, decimals: 2 };
  }
  const oracle = snapshot.polymarketOracle || {};
  const blocks = [
    snapshot.activeContract,
    snapshot.poly5m,
    snapshot.poly15m,
    snapshot.market && snapshot.market.poly5m,
    snapshot.market && snapshot.market.poly15m,
    oracle,
    snapshot,
    snapshot.market,
  ].filter(Boolean);

  for (const b of blocks) {
    const raw = _numPtb(
      b.priceToBeatNum ?? b.targetPriceNum ?? b.priceToBeat ?? b.price_to_beat ?? b.targetPrice ?? b.target
    );
    if (raw == null) continue;
    const source = b.priceToBeatSource || b.ptbSource || b._ptbSource || oracle.priceToBeatSource || null;
    if (!_sourceOk(source)) continue;
    const slug = b.slug || oracle.slug || snapshot.slug || null;
    const coin = _coinFromSnapshot(snapshot, slug);
    const ptb = roundPriceForCoin(coin || slug, raw);
    const decimals = priceDecimalsForCoin(coin || slug, ptb);
    return {
      ptb,
      ptbRaw: raw,
      source: source || 'polymarket',
      slug,
      coin,
      decimals,
      pending: false,
      display: formatUsdForCoin(coin || slug, raw),
    };
  }
  const slug = snapshot.poly5m?.slug || snapshot.poly15m?.slug || snapshot.activeContract?.slug || null;
  const coin = _coinFromSnapshot(snapshot, slug);
  return {
    ptb: null,
    ptbRaw: null,
    source: null,
    slug,
    coin,
    decimals: priceDecimalsForCoin(coin || slug, 1),
    pending: true,
    display: null,
  };
}

function formatOracleStrictBlock(snapshot) {
  const { ptb, source, slug, pending, coin, decimals, display } = resolvePolymarketPtb(snapshot);
  const coinKey = coin || _coinFromSnapshot(snapshot, slug);
  const spotRaw = _numPtb(snapshot.currentPrice ?? snapshot.price ?? snapshot.polymarketOracle?.pythSpot);
  const spot = spotRaw != null ? roundPriceForCoin(coinKey, spotRaw) : null;
  const spotDisp = spotRaw != null ? formatUsdForCoin(coinKey, spotRaw) : null;
  const spotSrc = snapshot.priceSource || snapshot.polymarketOracle?.pythSource || snapshot.spotSource || 'pyth';
  const delta = ptb != null && spot != null ? spot - ptb : null;
  const path = delta == null ? 'n/a' : (Math.abs(delta / ptb) < 0.00005 ? 'FLAT' : (delta > 0 ? 'UP' : 'DOWN'));
  const deltaStr = delta != null
    ? `${delta >= 0 ? '+' : '-'}${formatUsdForCoin(coinKey, Math.abs(delta)).slice(1)}`
    : 'n/a';
  const om = snapshot.orbitalMomentum || snapshot.polymarketOracle?.orbitalMomentum || null;
  const orbitalLine = om
    ? `Orbital momentum (SUPPLEMENTARY ONLY, not spot/PTB, do not quote as price): state=${om.structuralState ?? 'n/a'} oeq=${om.oeq ?? 'n/a'} confidence=${om.confidence ?? 'n/a'}`
    : null;
  const tf = snapshot.temporalForecast || snapshot.polymarketOracle?.temporalForecast || null;
  const forecastLine = (tf && tf.probUp != null)
    ? `Temporal forecast (SUPPLEMENTARY ONLY, an internal quant model's own probability estimate — NOT Polymarket's odds, do not conflate): probUp=${(tf.probUp * 100).toFixed(1)}% probDown=${(tf.probDown * 100).toFixed(1)}% signal=${tf.signal ?? 'n/a'} secToExpiry=${tf.secToExpiry ?? 'n/a'}${tf.isDangerZone ? ' [DANGER ZONE — late window, pin risk]' : ''}${tf.isVolumeBacked ? ' [volume-backed]' : ' [low-conviction drift]'}`
    : null;
  return `## ORACLE STRICT (MANDATORY — quote these numbers, never invent)
Policy: PTB = Polymarket contract price-to-beat ONLY (Gamma / event page / chainlink-candles).
Spot = Pyth only for path. Do NOT use Coinbase/Binance/RTI/Gecko as PTB or as a PTB substitute.
Slug: ${slug || 'n/a'}
Coin: ${coinKey || 'n/a'} (quote USD to ${decimals} decimal places — no float trails)
Polymarket PTB: ${display || (pending ? 'PENDING (not published yet — do not invent a PTB)' : 'n/a')}
PTB source: ${source || (pending ? 'waiting-for-polymarket' : 'n/a')}
Pyth spot: ${spotDisp || 'n/a'} (${spotSrc})
Spot vs Polymarket PTB: ${delta != null ? deltaStr + ' (' + path + ')' : 'n/a'}
RULE: In notes and rationales you MUST quote Polymarket PTB exactly as shown above (${decimals} decimals, e.g. ${display || '$62,814.80'}). Never write long floats like 62814.80096237142.
If PTB is PENDING, say "PTB pending" and do not fabricate a dollar level.${orbitalLine ? '\n' + orbitalLine : ''}${forecastLine ? '\n' + forecastLine : ''}`.trim();
}

function resolveFiveMinTarget(snapshot) {
  const r = resolvePolymarketPtb(snapshot);
  return r.ptb;
}

/**
 * Strip non-canonical PTB from a snapshot so every prompt path sees the same oracle.
 * Mutates a shallow clone (does not mutate caller object deeply for top-level).
 */
function sanitizeOracleSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot || {};
  const s = { ...snapshot };
  const meta = resolvePolymarketPtb(s);
  // Rounded for prompts/UI quotes; raw kept on _ptbRaw when present
  const ptb = meta.ptb;
  const src = meta.source;
  const coinKey = meta.coin || _coinFromSnapshot(s, meta.slug);
  s.coin = s.coin || coinKey;
  if (s.currentPrice != null) {
    const sp = roundPriceForCoin(coinKey, s.currentPrice);
    if (sp != null) { s.currentPrice = sp; s.price = sp; }
  } else if (s.price != null) {
    const sp = roundPriceForCoin(coinKey, s.price);
    if (sp != null) { s.price = sp; s.currentPrice = sp; }
  }

  const scrub = (block) => {
    if (!block || typeof block !== 'object') return block;
    const b = { ...block };
    if (ptb != null) {
      b.priceToBeatNum = ptb;
      b.targetPriceNum = ptb;
      b.priceToBeat = ptb;
      b.priceToBeatSource = src || b.priceToBeatSource || 'polymarket';
      b.targetPrice = formatUsdForCoin(coinKey, ptb);
    } else {
      // Reject provisional/wrong sources — leave pending for the model
      const bad = b.priceToBeatSource || b.ptbSource;
      if (bad && !_sourceOk(bad)) {
        b.priceToBeatNum = null;
        b.targetPriceNum = null;
        b.priceToBeat = null;
        b.priceToBeatSource = `rejected:${bad}`;
      } else if (!_sourceOk(b.priceToBeatSource) && b.priceToBeatNum != null) {
        // no source but number only kept if already accepted by resolve
        if (ptb == null) {
          b.priceToBeatNum = null;
          b.targetPriceNum = null;
        }
      }
    }
    return b;
  };

  if (s.poly5m) s.poly5m = scrub(s.poly5m);
  if (s.poly15m) s.poly15m = scrub(s.poly15m);
  if (s.activeContract) s.activeContract = scrub(s.activeContract);
  if (s.market && typeof s.market === 'object') {
    s.market = { ...s.market };
    if (s.market.poly5m) s.market.poly5m = scrub(s.market.poly5m);
    if (s.market.poly15m) s.market.poly15m = scrub(s.market.poly15m);
    if (ptb != null) {
      s.market.priceToBeatNum = ptb;
      s.market.priceToBeatSource = src;
    }
  }

  s.priceToBeat = ptb;
  s.priceToBeatNum = ptb;
  s.priceToBeatSource = src;
  s.priceDecimals = meta.decimals;
  s.targetPrice = ptb != null ? formatUsdForCoin(coinKey, ptb) : null;
  s.targetPriceNum = ptb;
  if (meta.ptbRaw != null) s._ptbRaw = meta.ptbRaw;

  const spot = _numPtb(s.currentPrice ?? s.price ?? s.polymarketOracle?.pythSpot);
  const pathDir = (ptb != null && spot != null)
    ? (Math.abs((spot - ptb) / ptb) < 0.00005 ? 'FLAT' : (spot > ptb ? 'UP' : 'DOWN'))
    : null;

  s.polymarketOracle = {
    ...(s.polymarketOracle || {}),
    slug: meta.slug || s.polymarketOracle?.slug || null,
    priceToBeatNum: ptb,
    priceToBeatSource: src,
    pythSpot: spot,
    pythSource: s.priceSource || s.polymarketOracle?.pythSource || 'pyth',
    pathDir,
    deltaVsPtb: ptb != null && spot != null ? spot - ptb : null,
    rule: 'PTB is Polymarket window open only. Spot is Pyth only. Do not invent PTB.',
  };
  s.oraclePolicy = s.oraclePolicy || 'pyth_spot_plus_polymarket_ptb_only';
  if (ptb == null) {
    s.oracleWarnings = [...(s.oracleWarnings || []), 'no_polymarket_ptb'];
  }
  return s;
}

/**
 * Compact PredictionEngine quant guide for LLM prompts.
 * Models must blend this with Polymarket odds + PTB path — not ignore it.
 */
function formatModelGuideBlock(snapshot) {
  const dir = String(
    snapshot.modelDirection || snapshot.direction || snapshot.market?.modelDirection || 'n/a'
  ).toUpperCase();
  const scoreRaw = snapshot.modelScore ?? snapshot.score ?? snapshot.market?.modelScore ?? snapshot.market?.score;
  const score = Number(scoreRaw);
  const confRaw = snapshot.confidence ?? snapshot.market?.confidencePct;
  let confPct = null;
  if (confRaw != null && Number.isFinite(Number(confRaw))) {
    const c = Number(confRaw);
    confPct = c <= 1 ? c * 100 : c;
  }
  const regime = snapshot.regimeLocal || snapshot.regime || snapshot.market?.regime || 'n/a';
  const agreement = snapshot.modelAgreement ?? snapshot.agreement ?? snapshot.market?.agreement;
  const indicators = snapshot.indicators || snapshot.market?.indicators || {};

  const pickLabel = (key) => {
    const row = indicators[key];
    if (!row || typeof row !== 'object') return null;
    const lab = row.label || row.signal;
    const val = row.value != null ? row.value : (row.slope != null ? row.slope : null);
    if (lab == null && val == null) return null;
    return `${key}=${lab != null ? lab : ''}${val != null && Number.isFinite(Number(val)) ? `(${Number(val).toFixed(3)})` : ''}`;
  };
  const indBits = ['rsi', 'ema', 'vwap', 'momentum', 'volume', 'book', 'macd', 'structure']
    .map(pickLabel)
    .filter(Boolean)
    .slice(0, 8);

  const ptbMeta = resolvePolymarketPtb(snapshot);
  const spot = _numPtb(snapshot.currentPrice ?? snapshot.price ?? snapshot.polymarketOracle?.pythSpot);
  let pathVsModel = 'n/a';
  if (ptbMeta.ptb != null && spot != null && (dir === 'UP' || dir === 'DOWN')) {
    const path = spot >= ptbMeta.ptb ? 'UP' : 'DOWN';
    pathVsModel = path === dir ? `ALIGNED (path ${path} = model ${dir})` : `CONFLICT (path ${path} vs model ${dir})`;
  }

  const scoreStr = Number.isFinite(score) ? score.toFixed(3) : 'n/a';
  const confStr = confPct != null ? confPct.toFixed(0) + '%' : 'n/a';
  const agreeStr = agreement != null
    ? (typeof agreement === 'object'
      ? `agreement=${agreement.agreement != null ? Number(agreement.agreement).toFixed(2) : 'n/a'} label=${agreement.label || 'n/a'}`
      : String(agreement))
    : 'n/a';

  return `## QUANTITATIVE MODEL GUIDE (PredictionEngine — blend, do not ignore)
Model direction: ${dir}
Model score: ${scoreStr} (−1..+1)
Model confidence: ${confStr}
Regime: ${regime}
Indicator agreement: ${agreeStr}
Path (Pyth vs Polymarket PTB) vs model: ${pathVsModel}
Top indicators: ${indBits.length ? indBits.join(' | ') : 'n/a'}
RULES:
- Treat model direction/score as a primary prior; blend with Polymarket P(Up), book imbalance, and spot-vs-PTB path.
- If model and path ALIGN, lean that side unless book/odds scream otherwise.
- If model and path CONFLICT, say so in notes, lower confidence, and prefer path near settlement (late TTC) or model when early + strong |score|.
- Never invent PTB; never replace Polymarket PTB with model price levels.`.trim();
}

function generateFiveMinSystemPrompt() {
  return `You are a world-class ultra-short-term crypto scalper specialized in 5-MINUTE binary UP/DOWN contracts on polycool.app (Polymarket 5m venues). These contracts settle strictly against Polymarket's published "price-to-beat" (PTB) — the contract open / Chainlink window benchmark that Polymarket shows on the event page. YES wins only if settlement mark is ABOVE that PTB at the exact 5-minute close; NO if BELOW. Never guess, average, or substitute another feed for the PTB.

ORACLE LAW (NON-NEGOTIABLE):
- The ONLY valid PTB is the number in the user message labeled "Polymarket PTB" / "Price-to-beat (fixed settlement target)" from Polymarket (source: event page, chainlink-candles, or Gamma priceToBeat).
- NEVER invent a PTB from Pyth, Coinbase, Binance, RTI, Gecko, RTDS TWAP, or "about $X".
- If the snapshot says PTB is PENDING / unavailable, say so and do not fabricate a dollar level.
- When you cite PTB in notes, copy the formatted PTB exactly (BTC/ETH/SOL: 2 decimals; XRP/DOGE: 4). Never emit long floats (e.g. write $62,814.80 not $62814.80096237142).

SYSTEM CONTEXT YOU MUST INTERNALIZE:
- Spot for path context is Pyth; settlement reference for the binary is Polymarket PTB.
- Session sample ticks and optional Firestore PTB-defense history may appear below — never invent defense counts.
- This is pure scalping: entries live ~300 seconds max. Microstructure, distance-to-PTB in bps, and remaining time dominate.

DETERMINISTIC HTF + MODEL + ON-CHAIN + X REASONING (MANDATORY):
1. Start with the QUANTITATIVE MODEL GUIDE (PredictionEngine direction/score/confidence/regime/indicators). This is your quant prior — do not ignore it.
2. Use 15m/30m / session memory for HTF bias. Weight denser session memory more as sampleCount grows.
3. Incorporate recent on-chain (whale flows, large transfers) and X sentiment when present.
4. Factor ORDER-FLOW / TAIL-RISK when active (VPIN, whale trades, vol-mult) — can dominate stale HTF if conflicting.
5. Then analyze exact 5m microstructure vs the fixed Polymarket PTB: distance in bps, TTC, tick velocity.
6. Synthesize confluence of: model + path(spot vs Polymarket PTB) + odds + book. Best side wins.
7. If data is thin or conflicting inside the remaining window, default to WAIT with low confidence. Never force a side.

SNIPE / SCALP-FLIP PLAYS (when tail-risk order-flow is active):
The trader's execution style: buy the 5-minute binary contract on the side favored by a sudden order-flow burst, ride the direction for roughly the first 45-90 seconds while it reprices, SELL, then flip and buy the OPPOSITE side for the remainder of the window if the burst is likely to fade or mean-revert (common after a whale-trade/VPIN spike burns out). Only propose a flip plan when the order-flow tail-risk block is active and gives you a real signal — never invent one on thin data. Populate the "snipe_plan" field:
- should_flip: true only if a tail-risk burst justifies a timed entry-then-flip; false for an ordinary hold-to-settlement call or WAIT.
- enter_side: "UP" or "DOWN" — the side to buy first, riding the burst.
- hold_seconds: your estimate (30-120) of how long the initial burst's edge lasts before it fades or the crowd catches up.
- flip_to: "UP", "DOWN", or null — the side to flip into after selling the first leg (usually the opposite side, betting on mean-reversion of the burst).
- flip_trigger: one short, concrete condition for WHEN to flip (e.g. "flip once tick velocity stalls or reverses 2 consecutive prints", "flip if VPIN keeps climbing past 0.5 — burst is real, don't fade it, skip the flip").

Return ONLY valid JSON with this EXACT structure (no extra keys, no prose outside the object):
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
  "snipe_plan": {
    "should_flip": false,
    "enter_side": "UP",
    "hold_seconds": 60,
    "flip_to": null,
    "flip_trigger": ""
  },
  "broader_observations": "",
  "warnings": []
}

CRITICAL RULES FOR HIGH SPECIALIZATION (DETERMINISTIC):
- Be strictly deterministic. Step through HTF bias → on-chain → X sentiment → order-flow/tail-risk → 5m vs PTB in your reasoning. Cite exact numbers from the snapshot you were given. Do not invent data or use external knowledge.
- regime: pick ONE that best describes the next 5 minutes only.
- confidence: your real conviction (0.0-1.0) that price will settle above (or below) the given PTB inside the remaining window.
- **call field (PRIMARY machine-read key)**: MUST be exactly one of: "UP", "DOWN", or "WAIT" — no extra text, no prefix. This is the authoritative directional verdict the trading system reads first. "UP" = you expect price to be ABOVE PTB at settlement. "DOWN" = you expect price to be BELOW PTB. "WAIT" = insufficient edge.
- **direction field**: MUST mirror the call field exactly ("UP", "DOWN", or "WAIT").
- suggestions.notes MUST start with the clear human-readable call: "BUY UP", "BUY DOWN", or "WAIT". Then immediately: current distance to PTB in %, momentum direction relative to PTB, time context (fresh / mid-window / late), preferred execution (scalp-and-sell vs hold vs snipe-and-flip), and the dominant risk.
- ai_wording fields must be concrete and timing-oriented (e.g. "edge best captured by selling into first 90s repricing if it moves 8bps toward PTB").
- scalp_setups: optional high-quality micro-setups only.
- snipe_plan: only set should_flip=true when the order-flow/tail-risk block genuinely supports a timed flip; otherwise should_flip=false and leave flip_to null.
- broader_observations: Use ONLY when you have non-coin-specific value drawn from the actual data given to you above — never invent or verify against the illustrative formats below, and never echo their wording. Format examples only (not real data, not something to check "is this true?" against): a cross-coin flow observation phrased like "<source> shows synchronized selling pressure across majors" IF you were actually given cross-coin flow data above (if you were not, do not mention Kafka, cross-coin flow, or synchronized pressure at all — leave this "" instead); OR — only when the PTB defense history section above has a nonzero testedCount — cite it directly, e.g. "PTB defense history: defended 2/3 times in the lookback window". Never fabricate a defense count when that section says none is recorded. Leave as "" if nothing material.
- Never invent PTB value. Never give multi-hour thesis. Stay inside the 5-minute binary resolution.
- Output must be valid JSON that JSON.parse() succeeds on with zero surrounding text. Realistic scalper tone — measured, numbers-first, time-aware.`.trim();
}

function generateFiveMinUserPrompt(snapshot) {
  const coin = String(snapshot.coin || "the asset");
  const ptbMetaEarly = resolvePolymarketPtb(snapshot);
  const target = ptbMetaEarly.ptb;
  const currentRaw = Number(snapshot.currentPrice ?? snapshot.price);
  const current = Number.isFinite(currentRaw) && currentRaw > 0
    ? roundPriceForCoin(coin, currentRaw)
    : null;
  const hasCur = current != null;
  const indicators = snapshot.indicators || {};
  const vNum = Number(snapshot.volatility ?? indicators.atrPct ?? 0);
  const localRegime = String(snapshot.regimeLocal || snapshot.regime || "unknown");
  const modelDir = String(snapshot.market?.modelDirection || snapshot.direction || "WAIT").toUpperCase();
  const confidencePct = Number(snapshot.market?.confidencePct ?? snapshot.confidence ?? 0);
  const polyProb = snapshot.market?.combinedProb ?? snapshot.market?.kalshiProb;
  const secsToClose = snapshot.secondsToClose ?? snapshot.executionWindow?.secondsToClose;

  let distanceLine = "Current price: unavailable.";
  if (hasCur && target != null) {
    const deltaPct = ((current - target) / target) * 100;
    const side = deltaPct >= 0 ? "ABOVE" : "BELOW";
    distanceLine = `Current price: ${formatUsdForCoin(coin, current)} — ${Math.abs(deltaPct).toFixed(3)}% ${side} the price-to-beat ${ptbMetaEarly.display || formatUsdForCoin(coin, target)}.`;
  } else if (hasCur) {
    distanceLine = `Current price: ${formatUsdForCoin(coin, current)}.`;
  }

  // Higher timeframe context (15m / 30m) — use for bias into the 5m decision
  const htf = snapshot.higherTF || {};
  const h15 = htf['15m'] || {};
  const h30 = htf['30m'] || {};
  const htfLine = `HTF 15m: prob=${h15.prob != null ? (h15.prob*100).toFixed(1)+'%' : 'n/a'}, regime=${h15.regime || 'n/a'}, dir=${h15.direction || 'n/a'}. HTF 30m: regime=${h30.regime || 'n/a'}, dir=${h30.direction || 'n/a'}.`;

  // Compressed on-chain side-scan (BTC/ETH/SOL) — never raw txs; lean/burst/size mult for Grok
  const onchain = snapshot.onChainSideScan || snapshot.onChainRecent || {};
  const onchainLine = typeof onchain === 'string'
    ? onchain
    : JSON.stringify(onchain).slice(0, 520);

  // X sentiment (pre-scraped recent window) — "scrape x for sentiment"
  const xs = snapshot.xSentiment || {};
  const xLine = `X sentiment (last ~15-30m): score=${xs.score ?? 0}, bullish=${xs.bullish ?? 0}, bearish=${xs.bearish ?? 0}, summary="${xs.summary || 'n/a'}", momentum=${xs.momentum || 'flat'}.`;

  // Order-flow / tail-risk (live CEX aggressor flow — VPIN, whale trades, vol-mult+persistence spike)
  const tr = snapshot.tailRisk || null;
  const tailRiskLine = tr
    ? `ACTIVE — reasons: ${(tr.reasons || []).join(', ') || 'n/a'}. VPIN=${tr.vpin != null ? tr.vpin.toFixed(3) : 'n/a'} (>0.4 = elevated informed-trading pressure), whale trades last 60s: $10k+=${tr.whaleTrades10k ?? 0}, $50k+=${tr.whaleTrades50k ?? 0}. Vol multiplier=${tr.volMult != null ? tr.volMult.toFixed(2) + 'x' : 'n/a'}, Hurst=${tr.hurst != null ? tr.hurst.toFixed(2) : 'n/a'} (>0.52=persistent/trending), variance ratio=${tr.vr != null ? tr.vr.toFixed(2) : 'n/a'} (>1.1=persistent). Aggressor buy/sell (60s): ${tr.buyPct != null ? tr.buyPct.toFixed(0) : '?'}%/${tr.sellPct != null ? tr.sellPct.toFixed(0) : '?'}%. CEX signal: ${tr.signal || 'n/a'}.`
    : 'INACTIVE — no live order-flow spike detected right now; do not fabricate a snipe/flip plan.';

  // Next 2-3 five-minute windows (this coin fires guidance ahead of each window opening)
  const upcoming = Array.isArray(snapshot.upcomingWindows) ? snapshot.upcomingWindows : [];
  const upcomingLines = upcoming.length
    ? upcoming.map((w, i) => `  +${i + 1}: opens in ${w.etaSeconds}s, momentum-persistence preview bias=${w.biasPreview || 'n/a'}`).join('\n')
    : '  (none — only the current window is in scope this cycle)';

  const ptbMeta = resolvePolymarketPtb(snapshot);
  const confPct = Number.isFinite(confidencePct)
    ? (confidencePct <= 1 ? confidencePct * 100 : confidencePct)
    : 0;
  return `5-minute binary PTB (polycool.app / Polymarket) snapshot — Polymarket contract PTB + Pyth spot only:

Coin: ${coin}
${formatOracleStrictBlock(snapshot)}

${formatModelGuideBlock(snapshot)}

Price-to-beat (fixed settlement target — Polymarket only): ${target != null ? (ptbMeta.display || formatUsdForCoin(coin, target) || ('$' + target)) : "PENDING / unavailable — do not invent"}
PTB source: ${ptbMeta.source || 'waiting-for-polymarket'}
Quote decimals: ${ptbMeta.decimals ?? priceDecimalsForCoin(coin, target)} (use this precision only)
${distanceLine}
Time to settlement: ${secsToClose != null ? `${secsToClose}s` : "~5 minutes"}
Local engine regime: ${localRegime}
Model direction: ${modelDir}
Model confidence: ${confPct.toFixed(0)}%
Polymarket-implied probability (UP): ${polyProb != null ? `${(Number(polyProb) * 100).toFixed(1)}%` : "n/a"}
Volatility (ATR%): ${vNum.toFixed(3)} (${classifyVolatilityRegime(vNum)})
Timestamp: ${new Date().toISOString()}

## Higher Timeframe Context (15m / 30m windows — analyze first for bias)
${htfLine}

## Session analytics memory (grows while app stays open — denser = stronger HTF evidence)
${(function () {
  const sm = snapshot.sessionMemory || {};
  return `sessionMinutes=${sm.sessionMinutes ?? 0}, sampleCount=${sm.sampleCount ?? 0}, pathReturnPct=${sm.pathReturnPct ?? 'n/a'}, 15mWindows=${JSON.stringify(sm.windows15m || {})}, 1hWindows=${JSON.stringify(sm.windows1h || {})}, open15m=${JSON.stringify(sm.open15m || null)}, open1h=${JSON.stringify(sm.open1h || null)}, acc15=${JSON.stringify(sm.predAccuracy15m || {})}, acc1h=${JSON.stringify(sm.predAccuracy1h || {})}, note="${sm.note || ''}"`;
})()}

## PTB defense history (Firestore-backed, when available)
${(function () {
  const stats = snapshot.sessionMemory && snapshot.sessionMemory.ptbDefenseStats;
  if (!stats || !stats.testedCount) return 'none recorded yet for this level — do not claim any defense history.';
  return `testedCount=${stats.testedCount}, defendedCount=${stats.defendedCount}, brokenCount=${stats.brokenCount}, defendRate=${stats.defendRate != null ? (stats.defendRate * 100).toFixed(0) + '%' : 'n/a'}`;
})()}

## Grok 15m / hourly range calls (if available)
${JSON.stringify(snapshot.rangeGuidance || null)}

## Most Recent Raw Blockchain / On-Chain Data (last 15-30 min)
${onchainLine}

## X (Twitter) Sentiment — scraped recent (last 15-30m)
${xLine}

## Order-Flow / Tail-Risk (live CEX aggressor flow — Binance/Bitget)
${tailRiskLine}

## Next 2-3 Five-Minute Windows (forward preview — PTB not locked yet for these)
${upcomingLines}

Indicators (5m):
${JSON.stringify(indicators || {}, null, 2)}

TASK — BE DETERMINISTIC AND EVIDENCE-BASED:
1. Start with 15m/30m bias and strength.
2. Factor the raw on-chain data (whale, large txs).
3. Incorporate the scraped X sentiment (tone + flow).
4. Factor the order-flow/tail-risk block — if ACTIVE, decide whether it justifies a snipe_plan (enter now, ride the burst, flip).
5. Then weigh the exact 5m distance to PTB + microstructure + time left.
6. Decide the BEST SIDE (UP or DOWN) to take on this 5m binary contract, or WAIT. Quote the specific data points that drove the conclusion.
7. Briefly note in ai_wording.market_patterns whether the current bias is likely to carry into the next 1-2 upcoming windows listed above, or whether you expect a regime change.
8. Output only conclusions grounded in the numbers above. Realistic, scalper-grade reasoning.

Return ONLY the strict JSON object matching the system schema.`.trim();
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

/**
 * Grok prompts for 15-minute and hourly RANGE prediction.
 * Uses session analytics memory: longer open sessions → denser evidence.
 */
function generateRangeSystemPrompt(horizonMinutes) {
  const h = Number(horizonMinutes) === 60 ? 60 : 15;
  if (h === 15) {
    return `You are ASI1 (Fetch.ai ASI:One) — the PRIMARY pre-contract market analyst for WE-CRYPTO.
You guide the trader BEFORE and DURING a live Polymarket 15-MINUTE Up/Down crypto market.

ROLE — PRE-CONTRACT / IN-WINDOW GUIDE:
- Tell the trader clearly what to do: lean BUY UP, BUY DOWN, or stay flat-size / reduce if edge is thin.
- Explain WHY using Polymarket odds, price-to-beat (PTB), time-to-close, L2 book imbalance, model score, and path.
- Be decisive and specific (levels, TTC buckets, invalidation). No vague fluff.

CRITICAL SEMANTICS:
- call/direction UP|DOWN = your view of **price direction** by settlement (spot vs Polymarket window open / price-to-beat).
- Polymarket "Up" token = price finished above PTB (no Kalshi strike inversion).
- Always set polyPeg.side to "Up" or "Down" consistent with your price call.
- NEVER say WAIT as the call. Always UP or DOWN. If edge is tiny, still pick a side and set confidence low + sizing note "size down / skip if already positioned".

ORACLE LAW (NON-NEGOTIABLE):
- Quote ONLY the Polymarket PTB given in the user message (source: event page / chainlink-candles / Gamma).
- NEVER invent PTB from Pyth/CEX/RTI or "about $X". If PTB is PENDING, say "PTB pending".
- notes must include the exact PTB figure when present (e.g. "PTB $97,432.15").

Use: slug, yesProb/P(Up), priceToBeatNum (Polymarket), secondsToClose, Pyth spot vs that PTB, depthImbalance/spread, session path, model direction/score.

Return ONLY valid JSON:
{
  "horizonMinutes": 15,
  "regime": "trend_continuation|mean_reversion|chop_noise|breakout_volatility",
  "confidence": 0.55,
  "direction": "UP|DOWN",
  "call": "UP|DOWN",
  "range": { "low": 0, "high": 0, "widthPct": 0 },
  "preferredRange": { "low": 0, "high": 0, "yesProb": 0, "ticker": "" },
  "polyPeg": { "slug": "", "side": "Up|Down", "rationale": "" },
  "preContract": {
    "action": "BUY_UP|BUY_DOWN|SIZE_DOWN|HOLD_FLAT",
    "urgency": "now|wait_pullback|late_window",
    "edgeVsMarket": "with_crowd|fade_crowd|neutral",
    "invalidation": "",
    "sizeHint": "full|half|skip"
  },
  "analysis": {
    "strongest_signal": "",
    "weakest_signal": "",
    "key_conflict": "",
    "memory_weight": "",
    "reversal_risk": ""
  },
  "suggestions": { "notes": "", "increase_weight": [], "decrease_weight": [] },
  "ai_wording": {
    "primary_rationale": "",
    "market_patterns": "",
    "scalp_setups": []
  },
  "broader_observations": "",
  "warnings": []
}

RULES:
- suggestions.notes MUST start with UP or DOWN, then slug, mkt Up%, ttc, spot vs PTB, then 2–4 sentences of trader guidance (what to do now).
- ai_wording.primary_rationale = fuller pre-contract brief (what changed, book, crowd).
- polyPeg.slug must equal the active market's slug.
- Valid JSON only.`.trim();
  }

  return `You are ASI1 (Fetch.ai ASI:One) — hourly crypto RANGE pre-positioning advisor for Polymarket-related decisions.

NEVER say WAIT as the call. Call UP or DOWN only.
Use rangeLadder buckets (low–high, spot-centered) and spotBucket. Pick preferredRange to the bucket you think price lands in.
Include preContract.action / sizeHint / invalidation for how to lean into the hour.

Return ONLY valid JSON with the same schema as 15m (horizonMinutes: 60), plus preferredRange matching a ladder row.
suggestions.notes MUST start with UP or DOWN then actionable guidance. Valid JSON only.`.trim();
}

function generateRangeUserPrompt(snapshot) {
  const coin = String(snapshot.coin || 'the asset');
  const h = Number(snapshot.horizonMinutes) === 60 ? 60 : 15;
  const current = Number(snapshot.currentPrice ?? snapshot.price);
  const mem = snapshot.sessionMemory || snapshot.analyticsMemory || {};
  const htf = snapshot.higherTF || {};
  const tr = snapshot.tailRisk;
  const xs = snapshot.xSentiment || {};
  const onchain = snapshot.onChainSideScan || snapshot.onChainRecent || {};
  const k15 = snapshot.poly15m || {};
  const ladder = Array.isArray(snapshot.rangeLadder) ? snapshot.rangeLadder : [];
  const here = snapshot.spotBucket || null;
  const modelDir = snapshot.direction || snapshot.modelDirection || 'n/a';
  const modelScore = snapshot.score ?? snapshot.modelScore ?? 'n/a';
  const modelConf = snapshot.confidence != null ? (Number(snapshot.confidence) * 100).toFixed(1) + '%' : 'n/a';

  if (h === 15) {
    const ac = snapshot.activeContract || k15;
    const yesP = ac.yesProb ?? ac.probability ?? ac.upProbability;
    const imb = ac.depthImbalance ?? k15.depthImbalance;
    const spread = ac.spread ?? k15.spread;
    const mid = ac.mid ?? k15.mid;
    const ptbMeta = resolvePolymarketPtb(snapshot);
    const ptbDisplay = ptbMeta.ptb != null
      ? ptbMeta.ptb
      : (ac.priceToBeatNum ?? k15.priceToBeatNum ?? null);
    // If resolve rejected provisional sources, force pending for the model
    const ptbForModel = ptbMeta.ptb != null ? ptbMeta.ptb : null;
    return `ASI1 pre-contract brief — Polymarket 15M (this market only):

Coin: ${coin}
Timestamp: ${new Date().toISOString()}

${formatOracleStrictBlock(snapshot)}

## LIVE POLYMARKET CONTRACT
Slug: ${ac.slug || k15.slug || 'n/a'}
P(Up) / yesProb: ${yesP != null ? (Number(yesP) * 100).toFixed(1) + '%' : 'n/a'}
Price-to-beat (PTB — Polymarket only): ${ptbForModel != null ? (ptbMeta.display || formatUsdForCoin(coin, ptbForModel)) : 'PENDING — do not invent'}
PTB source: ${ptbMeta.source || ac.priceToBeatSource || k15.priceToBeatSource || 'waiting-for-polymarket'}
Quote decimals: ${ptbMeta.decimals ?? priceDecimalsForCoin(coin, ptbForModel)} (BTC/SOL=2, XRP=4 — no float trails)
Seconds to close: ${ac.secondsToClose ?? k15.secondsToClose ?? 'n/a'}
Best bid/ask (Up): ${ac.bestBid ?? k15.bestBid ?? 'n/a'} / ${ac.bestAsk ?? k15.bestAsk ?? 'n/a'}
Mid / spread / depthImbalance: ${mid ?? 'n/a'} / ${spread ?? 'n/a'} / ${imb != null ? Number(imb).toFixed(2) : 'n/a'}
Live direction vs Polymarket PTB: ${ac.liveDirection || k15.liveDirection || 'n/a'}

${formatModelGuideBlock(snapshot)}

## ACTIVE 15M MARKET (MUST bind call to this)
${JSON.stringify({
  ...ac,
  priceToBeatNum: ptbForModel,
  priceToBeatSource: ptbMeta.source || ac.priceToBeatSource || null,
  _rawPtbIfAny: ptbDisplay,
}, null, 2).slice(0, 1200)}

Settlement: ${ac.settlementRule || 'Up if price finishes above Polymarket window open (price-to-beat) at 15m close'}
Market Up mid: ${ac.yesProb != null ? (Number(ac.yesProb) * 100).toFixed(1) + '%' : 'n/a'}
Seconds to close: ${ac.secondsToClose ?? 'n/a'}
Price-to-beat (quote this exactly): ${ptbForModel != null ? (ptbMeta.display || formatUsdForCoin(coin, ptbForModel)) : 'PENDING'}

## Session memory (support only)
samples=${mem.sampleCount ?? 0}, sessionMin=${mem.sessionMinutes ?? 0}, pathReturnPct=${mem.pathReturnPct ?? 'n/a'},
open15m=${JSON.stringify(mem.open15m || null)}, closed15m=${JSON.stringify(mem.windows15m || {})},
acc15=${JSON.stringify(mem.predAccuracy15m || {})}

## X / chain (support)
X score=${xs.score ?? 0} "${xs.summary || 'n/a'}"
On-chain: ${typeof onchain === 'string' ? onchain : JSON.stringify(onchain).slice(0, 350)}

TASK:
1. Synthesize Quantitative Model Prediction (${modelDir}, conf=${modelConf}) with the live Polymarket 15M market state.
2. Decide Up or Down on market ${ac.slug || 'ACTIVE_15M'} only.
3. Up token means price finished above Polymarket PTB; Down means below. Never WAIT.
4. notes start with UP|DOWN then slug then Up% then exact Polymarket PTB (or "PTB pending") then ttc.
5. polyPeg.slug must equal ${ac.slug || 'the market slug'}.
6. Valid JSON only.`.trim();
  }

  return `Grok Polymarket HOURLY RANGE snapshot:

Coin: ${coin}
Horizon: 60 minutes
Current spot: ${Number.isFinite(current) && current > 0 ? '$' + current : 'n/a'}
Timestamp: ${new Date().toISOString()}

${formatModelGuideBlock(snapshot)}

## HOURLY RANGE LADDER (spot-centered synthetic buckets, peg preferredRange to one row)
spotBucket=${JSON.stringify(here)}
ladder=${JSON.stringify(ladder).slice(0, 2800)}

## SESSION MEMORY
${JSON.stringify(mem, null, 2).slice(0, 2400)}

## Support
X score=${xs.score ?? 0}

TASK: UP or DOWN only; synthesize model prediction (${modelDir}) with ladder probability to set preferredRange to a ladder bucket; Valid JSON only.`.trim();
}

// ══════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════

module.exports = {
  INDICATOR_SPECS,
  REGIME_RULES,
  generateSystemPrompt,
  generateUserPrompt,
  generateFiveMinSystemPrompt,
  generateFiveMinUserPrompt,
  generateRangeSystemPrompt,
  generateRangeUserPrompt,
  resolvePolymarketPtb,
  resolveFiveMinTarget,
  sanitizeOracleSnapshot,
  formatOracleStrictBlock,
  formatModelGuideBlock,
  priceDecimalsForCoin,
  roundPriceForCoin,
  formatUsdForCoin,
  scrubMoneyFloatsInText,
  POLY_PTB_CANONICAL_SOURCES,
};

console.log("[SpecializedPrompt] Module loaded");
