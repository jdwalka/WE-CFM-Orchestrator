import sys

with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_block = """/* NORMAL CDF ROLLBACK BY USER REQUEST
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

new_block = """        if (target) {
           const vol = effectiveCache.volatility?.atrPct || 0.4;
           
           // Time Decay scaling (Root-time scale for Volatility)
           const minutesLeft = kData.closeTimeMs ? Math.max(0.1, (kData.closeTimeMs - Date.now()) / 60000) : 15;
           const timeScale = Math.sqrt(minutesLeft / 15); 
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

if old_block in text:
    text = text.replace(old_block, new_block)
    with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
        f.write(text)
    print("Successfully restored normalCDF and added Time-Decay logic.")
else:
    print("Could not find the rollback block in predictions.js")
