import re
import sys

def clean_app_js():
    with open('src/core/app.js', 'r', encoding='utf-8') as f:
        text = f.read()

    # 1. Remove Fail-Safe Engine
    start_str = "      // --- PROPRIETARY LIVE MARKET FAIL-SAFE & MISPRICING ENGINE ---"
    end_str = "        console.warn('[Live Fail-Safe] Error', e);\n      }"
    
    if start_str in text and end_str in text:
        start_idx = text.find(start_str)
        end_idx = text.find(end_str) + len(end_str)
        text = text[:start_idx] + text[end_idx:]
        print("Removed Fail-Safe Engine from app.js")
    
    # 2. Restore UI Probability String
    old_ui = """      const _actualUpPct = _kAlignEarly?.modelYesPct != null ? (_strikeDirEarly === 'below' ? 100 - _kAlignEarly.modelYesPct : _kAlignEarly.modelYesPct) : _modelUpPct;
      const _actualDownPct = 100 - _actualUpPct;
      const _modelProbStr = verdictDir === 'up' ? `${_actualUpPct}% UP` : verdictDir === 'down' ? `${_actualDownPct}% DOWN` : 'NEUTRAL';"""
      
    new_ui = """      const _modelProbStr = verdictDir === 'up' ? `${_modelUpPct}% UP`
        : verdictDir === 'down' ? `${_modelDownPct}% DOWN` : 'NEUTRAL';"""
        
    if old_ui in text:
        text = text.replace(old_ui, new_ui)
        print("Restored original UI Probability mapping in app.js")

    with open('src/core/app.js', 'w', encoding='utf-8') as f:
        f.write(text)

def clean_predictions_js():
    with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
        text = f.read()

    # 1. Remove LVN/CVD/VWAP calculations from vwap block
    start_inst = "    // --- PHASE 1: CVD (Cumulative Volume Delta) ---"
    end_inst = "    vwapWeight *= 2.5;\n    return (baseScore + (vwapSig * vwapWeight)) / (1 + vwapWeight);"
    
    if start_inst in text and end_inst in text:
        start_idx = text.find(start_inst)
        end_idx = text.find(end_inst) + len(end_inst)
        
        original_vwap_return = "    return (baseScore + (vwapSig * vwapWeight)) / (1 + vwapWeight);"
        text = text[:start_idx] + original_vwap_return + text[end_idx:]
        print("Removed Institutional Overlays from predictions.js")

    # 2. Re-comment the CDF block
    cdf_logic = """        if (target) {
           const vol = effectiveCache.volatility?.atrPct || 0.4;
           
           // Time Decay scaling (Root-time scale for Volatility)
           const minutesLeft = kData.closeTimeMs ? Math.max(0.1, (kData.closeTimeMs - Date.now()) / 60000) : 15;
           const timeScale = Math.max(0.4, Math.sqrt(minutesLeft / 15)); 
           const stdDev = target * (vol / 100) * timeScale;
           
           const z = stdDev > 0 ? (target - strike) / stdDev : (target >= strike ? 10 : -10);
           const pAbove = normalCDF(z) * 100;
           const strikeDir = kData.strikeDir || 'above';
           const modelYesPct = strikeDir === 'below' ? 100 - pAbove : pAbove;
           
           p15.kalshiAlign = {
             strike,
             strikeDir,
             modelYesPct: Math.round(modelYesPct),
             closeTimeMs: kData.closeTimeMs,
             gapPct: ((target - strike) / strike) * 100
           };
        }"""
        
    cdf_rollback = """/* NORMAL CDF ROLLBACK BY USER REQUEST
        if (target) {
           const vol = effectiveCache.volatility?.atrPct || 0.4;
           const stdDev = target * (vol / 100);
           const z = stdDev > 0 ? (target - strike) / stdDev : 0;
           const pAbove = normalCDF(z) * 100;
           const strikeDir = kData.strikeDir || 'above';
           const modelYesPct = strikeDir === 'below' ? 100 - pAbove : pAbove;
           
           p15.kalshiAlign = {
             strike,
             strikeDir,
             modelYesPct,
             closeTimeMs: kData.closeTimeMs,
             gapPct: ((target - strike) / strike) * 100
           };
        }
*/"""
    if cdf_logic in text:
        text = text.replace(cdf_logic, cdf_rollback)
        print("Restored CDF Rollback Comments in predictions.js")
        
    # 3. Remove Helper Functions
    helper_block = """function calcCandleCVD(candles, period) {
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
  if (!candles || candles.length === 0) return profile;
  const step = candles[candles.length-1].c * 0.001;
  if (step === 0) return profile;
  for (const c of candles) {
    const bucket = Math.round(c.c / step) * step;
    profile[bucket] = (profile[bucket] || 0) + (c.v || 0);
  }
  return profile;
}

  function calcVWAP"""

    if helper_block in text:
        text = text.replace(helper_block, "  function calcVWAP")
        print("Removed Helper Functions from predictions.js")

    with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
        f.write(text)

clean_app_js()
clean_predictions_js()
