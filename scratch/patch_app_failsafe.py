import sys

# 1. Patch predictions.js to expose candleCache to the global scope
with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
    pred_text = f.read()

if 'window.candleCache = candleCache;' not in pred_text:
    pred_text = pred_text.replace('window._predictions = {};', 'window._predictions = {};\n  window.candleCache = candleCache;')
    with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
        f.write(pred_text)
    print("Patched predictions.js to expose candleCache")

# 2. Patch app.js to inject Live Fail-Safe
with open('src/core/app.js', 'r', encoding='utf-8') as f:
    app_text = f.read()

insert_point = """    // --- AI VERDICT OVERRIDE ---
    if (p.llm?.ai_verdict?.direction) {
      const aiDir = p.llm.ai_verdict.direction.toLowerCase();
      if (aiDir === 'up' || aiDir === 'down' || aiDir === 'wait') {
        verdictDir = aiDir;
        if (aiDir === 'wait') {
          waitRationale = p.llm.ai_verdict.logic_recheck_summary || 'AI synthesized data and concluded WAIT is optimal.';
        }
      }
    }"""

fail_safe_logic = """
    // --- PROPRIETARY LIVE MARKET FAIL-SAFE & MISPRICING ENGINE ---
    try {
      const c1m = window.candleCache?.[p.sym]?.candles1m || [];
      if (c1m.length >= 2) {
        const cNow = c1m[c1m.length - 1].c;
        const c1mAgo = c1m[c1m.length - 2].c;
        const c3mAgo = c1m.length >= 4 ? c1m[c1m.length - 4].c : c1mAgo;
        
        const delta1m = ((cNow - c1mAgo) / c1mAgo) * 100;
        const delta3m = ((cNow - c3mAgo) / c3mAgo) * 100;
        
        // Rapid surge threshold (e.g. >0.08% in 1m or >0.15% in 3m)
        const isRapidPump = delta1m > 0.08 || delta3m > 0.15; 
        const isRapidDump = delta1m < -0.08 || delta3m < -0.15;
        
        // 1. Anti-Knife Guard (Block suicidal fades)
        if (isRapidPump && verdictDir === 'down') {
          verdictDir = 'wait';
          waitRationale = `🔥 LIVE FAIL-SAFE: Blocked DOWN call. Price is violently surging (+${delta1m.toFixed(2)}% 1m).`;
          verdictSource = 'safety-live-pump';
        } else if (isRapidDump && verdictDir === 'up') {
          verdictDir = 'wait';
          waitRationale = `🔥 LIVE FAIL-SAFE: Blocked UP call. Price is violently crashing (${delta1m.toFixed(2)}% 1m).`;
          verdictSource = 'safety-live-dump';
        }
        
        // 2. EDGE HUNTER: Contract Mispricing 
        // If market is violently surging UP but Kalshi YES is < 45% (massively mispriced edge)
        if (isRapidPump && kalshiProb !== null && kalshiProb < 0.45) {
          verdictDir = _yesDirEarly; 
          verdictSource = 'mispricing-edge-hunter-up';
        } else if (isRapidDump && kalshiProb !== null && kalshiProb > 0.55) {
          verdictDir = _noDirEarly;
          verdictSource = 'mispricing-edge-hunter-down';
        }
      }
    } catch (e) {
      console.warn('[Live Fail-Safe] Error', e);
    }
"""

if insert_point in app_text and 'PROPRIETARY LIVE MARKET FAIL-SAFE & MISPRICING ENGINE' not in app_text:
    app_text = app_text.replace(insert_point, insert_point + fail_safe_logic)
    with open('src/core/app.js', 'w', encoding='utf-8') as f:
        f.write(app_text)
    print("Patched app.js with Live Fail-Safe")
elif 'PROPRIETARY LIVE MARKET FAIL-SAFE & MISPRICING ENGINE' in app_text:
    print("app.js already patched.")
else:
    print("Could not find insert point in app.js")
