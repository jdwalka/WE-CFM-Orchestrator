import re
import sys

def patch_predictions():
    with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
        text = f.read()
        
    target_str = "    let consensusComposite = (composite * adxGate * 1.8 * mdtScoreMult * _sessMult);"
    
    breakout_logic = """    let consensusComposite = (composite * adxGate * 1.8 * mdtScoreMult * _sessMult);

    // --- PURE BREAKOUT RIDER ---
    function calcBreakoutState(candles) {
      if (!candles || candles.length < 5) return { riding: false };
      const current = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      
      const pumpMom = ((current.c - prev.c) / (prev.c || 1)) * 100;
      const isUpPump = pumpMom > 0.08;
      const isDownPump = pumpMom < -0.08;
      
      const avgVol = (candles.slice(-10, -1).reduce((sum, c) => sum + (c.v||0), 0) / 9) || 1;
      const volSpike = (current.v || 0) > avgVol * 2.0;
      
      if (!window._breakoutState) window._breakoutState = {};
      if (!window._breakoutState[options.sym]) window._breakoutState[options.sym] = { active: false };
      
      const state = window._breakoutState[options.sym];
      
      // Trigger new breakout
      if (volSpike && (isUpPump || isDownPump)) {
        state.active = true;
        state.dir = isUpPump ? 'up' : 'down';
        state.initVol = current.v || 0;
        state.high = current.h;
        state.low = current.l;
        state.ticksStalled = 0;
      }
      
      // Check Exhaustion
      if (state.active) {
        const volCrash = (current.v || 0) < state.initVol * 0.3;
        const range = (current.h - current.l) || 0.0001;
        const wick = state.dir === 'up' ? (current.h - current.c) / range : (current.c - current.l) / range;
        const wickRejection = wick > 0.60;
        
        if (state.dir === 'up' && current.h > state.high) { state.high = current.h; state.ticksStalled = 0; }
        else if (state.dir === 'down' && current.l < state.low) { state.low = current.l; state.ticksStalled = 0; }
        else state.ticksStalled++;
        
        const timeStall = state.ticksStalled >= 3; 
        
        // "ALL" Rule: Exhaustion requires all 3 conditions
        if (volCrash && wickRejection && timeStall) {
          state.active = false;
        }
      }
      return { riding: state.active, dir: state.dir };
    }
    
    const breakout = calcBreakoutState(typeof window !== 'undefined' && window.candleCache ? window.candleCache?.[options.sym]?.candles1m || candles : candles);
    if (breakout.riding) {
      consensusComposite = breakout.dir === 'up' ? 0.90 : -0.90;
    }
    // ---------------------------"""
    
    if target_str in text:
        text = text.replace(target_str, breakout_logic)
        with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
            f.write(text)
        print("Patched predictions.js with Breakout Rider")

def patch_app():
    with open('src/core/app.js', 'r', encoding='utf-8') as f:
        text = f.read()
        
    old_wait = """      // Model has no conviction +' show as WAIT (don't fade to Kalshi)
      verdictDir = 'wait';
      verdictSource = 'model-uncertain';
    }"""
    
    new_wait = """      // Model has no conviction +' show as WAIT (don't fade to Kalshi)
      verdictDir = 'wait';
      verdictSource = 'model-uncertain';
      
      // --- EDGE HUNTER (CHOP EXPLOITATION) ---
      if (kalshiProb !== null) {
        if (kalshiProb < 0.35) { // Crowd is too bearish on YES
          verdictDir = _yesDirEarly; 
          verdictSource = 'edge-hunter-chop-up';
        } else if (kalshiProb > 0.65) { // Crowd is too bullish on YES
          verdictDir = _noDirEarly;
          verdictSource = 'edge-hunter-chop-down';
        }
      }
    }"""
    
    # Handle potentially different character encodings in source (like +')
    text_clean = text.replace("+'", "->")
    old_wait_clean = old_wait.replace("+'", "->")
    new_wait_clean = new_wait.replace("+'", "->")

    text_clean = text_clean.replace("Model has no conviction -> show as WAIT (don't fade to Kalshi)\n      verdictDir = 'wait';\n      verdictSource = 'model-uncertain';\n    }", new_wait_clean)

    # Use regex for robust replacement
    text = re.sub(
        r"verdictDir = 'wait';\s*verdictSource = 'model-uncertain';\s*}",
        "verdictDir = 'wait';\n      verdictSource = 'model-uncertain';\n\n      // --- EDGE HUNTER (CHOP EXPLOITATION) ---\n      if (kalshiProb !== null) {\n        if (kalshiProb < 0.35) {\n          verdictDir = _yesDirEarly;\n          verdictSource = 'edge-hunter-chop-up';\n        } else if (kalshiProb > 0.65) {\n          verdictDir = _noDirEarly;\n          verdictSource = 'edge-hunter-chop-down';\n        }\n      }\n    }",
        text
    )

    with open('src/core/app.js', 'w', encoding='utf-8') as f:
        f.write(text)
    print("Patched app.js with Edge Hunter")

patch_predictions()
patch_app()
