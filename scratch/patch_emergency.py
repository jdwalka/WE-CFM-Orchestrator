import sys

def patch_app_js():
    with open('src/core/app.js', 'r', encoding='utf-8') as f:
        text = f.read()
    
    # 1. Fix Edge Hunter Routing
    old_routing = """          if (isRapidPump && kalshiProb !== null && kalshiProb < 0.45) {
            verdictDir = _yesDirEarly; 
            verdictSource = 'mispricing-edge-hunter-up';
          } else if (isRapidDump && kalshiProb !== null && kalshiProb > 0.55) {
            verdictDir = _noDirEarly;
            verdictSource = 'mispricing-edge-hunter-down';
          }"""
    
    new_routing = """          if (isRapidPump && kalshiProb !== null && kalshiProb < 0.45) {
            verdictDir = 'up'; 
            verdictSource = 'mispricing-edge-hunter-up';
          } else if (isRapidDump && kalshiProb !== null && kalshiProb > 0.55) {
            verdictDir = 'down';
            verdictSource = 'mispricing-edge-hunter-down';
          }"""
          
    if old_routing in text:
        text = text.replace(old_routing, new_routing)
        print("Patched app.js edge hunter routing")
    else:
        print("Could not find edge hunter routing in app.js")
        
    # 2. Fix UI Text Mapping
    old_ui = """      const _modelProbStr = verdictDir === 'up' ? `${_modelUpPct}% UP`
        : verdictDir === 'down' ? `${_modelDownPct}% DOWN` : 'NEUTRAL';"""
        
    new_ui = """      const _actualUpPct = _kAlignEarly?.modelYesPct != null 
        ? (_strikeDirEarly === 'below' ? 100 - _kAlignEarly.modelYesPct : _kAlignEarly.modelYesPct) 
        : _modelUpPct;
      const _actualDownPct = 100 - _actualUpPct;
      const _modelProbStr = verdictDir === 'up' ? `${_actualUpPct}% UP`
        : verdictDir === 'down' ? `${_actualDownPct}% DOWN` : 'NEUTRAL';"""
        
    if old_ui in text:
        text = text.replace(old_ui, new_ui)
        print("Patched app.js UI text mapping")
    else:
        print("Could not find UI text mapping in app.js")

    with open('src/core/app.js', 'w', encoding='utf-8') as f:
        f.write(text)

def patch_predictions_js():
    with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
        text = f.read()
        
    # 3. Fix CDF Time-Decay
    old_cdf = "const timeScale = Math.sqrt(minutesLeft / 15);"
    new_cdf = "const timeScale = Math.max(0.4, Math.sqrt(minutesLeft / 15));"
    
    if old_cdf in text:
        text = text.replace(old_cdf, new_cdf)
        print("Patched predictions.js Time-Decay scaler")
    else:
        print("Could not find Time-Decay scaler in predictions.js")
        
    # 4. Fix VWAP Deviation
    old_vwap = """    if (Math.abs(vwapZScore) > 2.5) { 
      vwapSig = vwapZScore > 0 ? -0.8 : 0.8; // Extreme mean-reversion
    } else if (Math.abs(vwapZScore) > 1.5) {
      vwapSig = vwapZScore > 0 ? -0.4 : 0.4;
    }"""
    
    new_vwap = """    if (Math.abs(vwapZScore) > 2.5) { 
      vwapSig = vwapZScore > 0 ? -0.4 : 0.4; // Softened mean-reversion
    } else if (Math.abs(vwapZScore) > 1.5) {
      vwapSig = vwapZScore > 0 ? -0.2 : 0.2;
    }"""
    
    if old_vwap in text:
        text = text.replace(old_vwap, new_vwap)
        print("Patched predictions.js VWAP Deviation logic")
    else:
        print("Could not find VWAP Deviation logic in predictions.js")
        
    with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
        f.write(text)

patch_app_js()
patch_predictions_js()
