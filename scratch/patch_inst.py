import sys

with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Add Helper Functions (calcCVD, calcVolumeProfile) near calcVWAP
calc_vwap_str = "function calcVWAP(candles) {"
helpers = """function calcCVD(candles, period) {
  const recent = candles.slice(-period);
  let cvd = 0;
  for (const c of recent) {
    const range = (c.h - c.l) || 0.0001;
    const body = c.c - c.o;
    const delta = (c.v || 0) * (body / range);
    cvd += delta;
  }
  return cvd;
}

function calcVolumeProfile(candles) {
  const profile = {};
  if (candles.length === 0) return profile;
  const step = candles[candles.length-1].c * 0.001;
  if (step === 0) return profile;
  for (const c of candles) {
    const bucket = Math.round(c.c / step) * step;
    profile[bucket] = (profile[bucket] || 0) + (c.v || 0);
  }
  return profile;
}

"""

if 'function calcCVD' not in text:
    text = text.replace(calc_vwap_str, helpers + calc_vwap_str)

# 2. Modify VWAP logic and insert CVD & LVN in the main compute function
old_vwap_block = """    const vwapRollingLast = vwapRolling[vwapRolling.length - 1];
    const vwapDevRolling = ((lastPrice - vwapRollingLast) / (vwapRollingLast || 1)) * 100;
    if (Math.abs(vwapDevRolling) < 0.3) vwapSig = 0;
    else if (vwapDevRolling > 1.5) vwapSig = -0.5;
    else if (vwapDevRolling < -1.5) vwapSig = 0.5;
    else vwapSig = vwapDevRolling > 0 ? 0.3 : -0.3;"""

new_vwap_and_inst_block = """    const vwapRollingLast = vwapRolling[vwapRolling.length - 1];
    const vwapDevRolling = ((lastPrice - vwapRollingLast) / (vwapRollingLast || 1)) * 100;
    
    // --- PHASE 2: VWAP Deviation (Standard Deviation z-score) ---
    const vwapRollingStdDev = (vwapStd / (vwapRollingLast || 1)) * 100;
    const vwapZScore = vwapRollingStdDev > 0 ? vwapDevRolling / vwapRollingStdDev : 0;
    if (Math.abs(vwapZScore) > 2.5) { 
      vwapSig = vwapZScore > 0 ? -0.8 : 0.8; // Extreme mean-reversion
    } else if (Math.abs(vwapZScore) > 1.5) {
      vwapSig = vwapZScore > 0 ? -0.4 : 0.4;
    } else {
      vwapSig = vwapZScore > 0 ? 0.2 : -0.2; // Trend following inside 1.5 SD
    }

    // --- PHASE 1: Cumulative Volume Delta (CVD) ---
    const cvd15 = calcCVD(candles, 15);
    const avgVol15 = average(candles.slice(-15).map(c=>c.v||0)) || 1;
    const cvdSig = clamp(cvd15 / (avgVol15 * 5), -1, 1);

    // --- PHASE 3: LVN Vacuum Detection ---
    const profile = calcVolumeProfile(candles.slice(-100));
    const step = lastPrice * 0.001;
    const currentBucket = step > 0 ? Math.round(lastPrice / step) * step : lastPrice;
    const nodeVol = profile[currentBucket] || 0;
    const avgProfileVol = average(Object.values(profile)) || 1;
    let lvnSig = 0;
    if (nodeVol < avgProfileVol * 0.3) {
      // In a vacuum, price accelerates with momentum
      lvnSig = Math.sign(mom) * 0.6;
    }"""

if old_vwap_block in text:
    text = text.replace(old_vwap_block, new_vwap_and_inst_block)
else:
    print("Could not find old_vwap_block")

# 3. Add to signalVector
old_sigvec_vwap = "if (typeof vwapSig !== 'undefined') _sigVec.push({ name: 'vwap', value: vwapSig, weight: adaptiveWeights.vwap ?? OUTER_ORBITAL_WEIGHTS.vwap ?? 0.05 });"
new_sigvec_inst = """if (typeof vwapSig !== 'undefined') _sigVec.push({ name: 'vwap', value: vwapSig, weight: adaptiveWeights.vwap ?? OUTER_ORBITAL_WEIGHTS.vwap ?? 0.05 });
    if (typeof cvdSig !== 'undefined') _sigVec.push({ name: 'cvd', value: cvdSig, weight: 0.80 }); // High weight for CVD
    if (typeof lvnSig !== 'undefined' && lvnSig !== 0) _sigVec.push({ name: 'lvn', value: lvnSig, weight: 0.60 });"""

if old_sigvec_vwap in text:
    text = text.replace(old_sigvec_vwap, new_sigvec_inst)
else:
    print("Could not find old_sigvec_vwap")

# 4. Add 'cvd' and 'lvn' to CORE_SIGNAL_KEYS so they get evaluated in the composite
old_core_keys = "const CORE_SIGNAL_KEYS = ['hma', 'vwma', 'rsi', 'ema', 'sma', 'obv', 'volume', 'momentum', 'bands', 'persistence', 'structure', 'macd', 'stochrsi', 'adx', 'ichimoku', 'williamsR', 'mfi', 'vwap', 'supertrend', 'cci', 'cmf', 'fisher', 'keltner'];"
new_core_keys = "const CORE_SIGNAL_KEYS = ['hma', 'vwma', 'rsi', 'ema', 'sma', 'obv', 'volume', 'momentum', 'bands', 'persistence', 'structure', 'macd', 'stochrsi', 'adx', 'ichimoku', 'williamsR', 'mfi', 'vwap', 'supertrend', 'cci', 'cmf', 'fisher', 'keltner', 'cvd', 'lvn'];"

if old_core_keys in text:
    text = text.replace(old_core_keys, new_core_keys)
else:
    print("Could not find old_core_keys")

with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
    f.write(text)

print("Patching complete.")
