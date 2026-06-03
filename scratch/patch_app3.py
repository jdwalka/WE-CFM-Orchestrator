import sys

with open('src/core/app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 1. Comment out 10684 to 10722
for i in range(10684-1, 10722):
    if i == 10684-1:
        lines[i] = '    // ALL ORCHESTRATOR GUARDS DISABLED BY USER REQUEST\n    /* ' + lines[i].lstrip()
    elif i == 10722-1:
        lines[i] = lines[i] + '    */\n    const confNorm = _normalizeConfidence(p.confidence) ?? 0;\n'

# 2. Inject AI VERDICT OVERRIDE
for i in range(10723, 10735):
    if "verdictDir = isWaitBlock ? 'wait' : (p.score > 0 ? 'up' : p.score < 0 ? 'down' : 'wait');" in lines[i]:
        lines[i] = '''    verdictDir = p.score > 0 ? 'up' : p.score < 0 ? 'down' : 'wait'; // bypass isWaitBlock natively

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
'''
        break

# 3. Clean waitRationale (10818 to 10842)
rationale_start = -1
for i in range(10800, 10900):
    if 'const waitRationale = (() => {' in lines[i]:
        rationale_start = i
        break
if rationale_start != -1:
    rationale_end = -1
    for i in range(rationale_start, rationale_start+100):
        if '})();' in lines[i]:
            rationale_end = i
            break
    
    clean_rationale = '''    const waitRationale = (() => {
      if (verdictDir !== 'wait') return '';

      // Check if overridden by AI
      if (p.llm?.ai_verdict?.direction === 'wait') {
        return p.llm.ai_verdict.logic_recheck_summary || 'AI synthesized data and concluded WAIT is optimal.';
      }

      if (verdictSource) {
        if (verdictSource === 'model-cdf-neutral') {
          return `Model thinking: CDF neutral at ${modelYesPct.toFixed(1)}% YES (needs >=58% for YES direction or <=42% for NO direction).`;
        }
        if (verdictSource === 'model-uncertain') {
          return `Model thinking: low conviction score ${scoreStr} (needs >+0.12 for UP or <-0.12 for DOWN).`;
        }
        if (verdictSource === 'kalshi-fade') {
          return `Kalshi edge (${kalshiPct}% probability) is dominating the model score — taking a neutral stance.`;
        }
      }
      return `Model thinking: waiting for stronger directional confirmation.`;
    })();
'''
    # Replace chunk
    lines[rationale_start:rationale_end+1] = [clean_rationale]

# 4. AI DIRECTIVE UI
ui_target = -1
for i, line in enumerate(lines):
    if '${waitRationale ? `<div class="pred-verdict-rationale">${waitRationale}</div>` : \'\'}' in line:
        ui_target = i
        break

if ui_target != -1:
    lines[ui_target] = '''          ${(p.llm?.ai_wording?.wait_rationale) ? `<div class="pred-verdict-rationale"><span style="font-weight:700">✨ AI:</span> ${escapeHtml(p.llm.ai_wording.wait_rationale)}</div>` : waitRationale ? `<div class="pred-verdict-rationale">${waitRationale}</div>` : ''}
          
          ${(verdictDir !== 'wait') ? `
            <div class="ai-insights-block" style="margin-top:14px;margin-bottom:8px;padding:16px;border-radius:12px;background:${verdictDir === 'up' ? 'rgba(38,212,126,0.1)' : 'rgba(255,68,102,0.1)'};border:2px solid ${verdictDir === 'up' ? 'rgba(38,212,126,0.4)' : 'rgba(255,68,102,0.4)'};box-shadow: 0 4px 15px rgba(0,0,0,0.15);">
              <div style="font-size:18px;font-weight:900;color:${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'};margin-bottom:10px;text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;justify-content:space-between">
                <span>⚡ AI DIRECTIVE: BUY ${verdictDir === 'up' ? 'YES' : 'NO'}</span>
              </div>
              ${(p.llm?.ai_wording?.primary_rationale) ? `<div style="font-size:14px;color:rgba(255,255,255,0.85);font-style:italic;padding-left:10px;border-left:3px solid ${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'}">"${escapeHtml(p.llm.ai_wording.primary_rationale)}"</div>` : ''}
              ${(p.llm?.ai_wording?.high_confidence_rationale) ? `<div style="font-size:14px;color:rgba(255,255,255,0.85);font-style:italic;padding-left:10px;border-left:3px solid ${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'};margin-top:6px">"${escapeHtml(p.llm.ai_wording.high_confidence_rationale)}"</div>` : ''}
            </div>
          ` : ''}
'''

with open('src/core/app.js', 'w', encoding='utf-8') as f:
    f.writelines(lines)
print("SUCCESS")
