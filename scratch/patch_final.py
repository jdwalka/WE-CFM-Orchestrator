import sys

with open('src/core/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Disable the 5-minute pre-close safety guard
old_guard1 = "if (verdictDir !== 'wait' && inSafetyWindow && (isTickerStale || isBorderlineStrike || isWeakConviction)) {"
new_guard1 = "if (false && verdictDir !== 'wait' && inSafetyWindow && (isTickerStale || isBorderlineStrike || isWeakConviction)) { // DISABLED BY USER"
content = content.replace(old_guard1, new_guard1)

# 2. Disable the 45-second ultra-late safety guard
old_guard2 = """    if (
      verdictDir !== 'wait' &&
      isSemiConfidence &&
      isCrowdConflict &&
      isUltraLateWindow
    ) {"""
new_guard2 = """    if (
      false && verdictDir !== 'wait' &&
      isSemiConfidence &&
      isCrowdConflict &&
      isUltraLateWindow
    ) { // DISABLED BY USER"""
content = content.replace(old_guard2, new_guard2)

# 3. Inject AI VERDICT OVERRIDE natively
old_target = "    const _fadeActive = kalshiDir !== null && modelDir !== 'wait' && modelDir !== kalshiDir;"
new_target = """
    // --- AI VERDICT OVERRIDE ---
    if (p.llm?.ai_verdict?.direction) {
      const aiDir = p.llm.ai_verdict.direction.toLowerCase();
      if (aiDir === 'up' || aiDir === 'down' || aiDir === 'wait') {
        verdictDir = aiDir;
        if (aiDir === 'wait') {
          waitRationale = p.llm.ai_verdict.logic_recheck_summary || 'AI synthesized data and concluded WAIT is optimal.';
        }
      }
    }

    const _fadeActive = kalshiDir !== null && modelDir !== 'wait' && modelDir !== kalshiDir;"""
content = content.replace(old_target, new_target)

with open('src/core/app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("SUCCESS")
