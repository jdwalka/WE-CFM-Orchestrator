import sys

with open('src/core/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 4. Inject AI DIRECTIVE UI block
old_ui = "${waitRationale ? `<div class=\"pred-verdict-rationale\">${waitRationale}</div>` : ''}"
new_ui = """${(p.llm?.ai_wording?.wait_rationale) ? `<div class="pred-verdict-rationale"><span style="font-weight:700">✨ AI:</span> ${escapeHtml(p.llm.ai_wording.wait_rationale)}</div>` : waitRationale ? `<div class="pred-verdict-rationale">${waitRationale}</div>` : ''}
          
          ${(verdictDir !== 'wait') ? `
            <div class="ai-insights-block" style="margin-top:14px;margin-bottom:8px;padding:16px;border-radius:12px;background:${verdictDir === 'up' ? 'rgba(38,212,126,0.1)' : 'rgba(255,68,102,0.1)'};border:2px solid ${verdictDir === 'up' ? 'rgba(38,212,126,0.4)' : 'rgba(255,68,102,0.4)'};box-shadow: 0 4px 15px rgba(0,0,0,0.15);">
              <div style="font-size:18px;font-weight:900;color:${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'};margin-bottom:10px;text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;justify-content:space-between">
                <span>⚡ AI DIRECTIVE: BUY ${verdictDir === 'up' ? 'YES' : 'NO'}</span>
              </div>
              ${(p.llm?.ai_wording?.primary_rationale) ? `<div style="font-size:14px;color:rgba(255,255,255,0.85);font-style:italic;padding-left:10px;border-left:3px solid ${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'}">"${escapeHtml(p.llm.ai_wording.primary_rationale)}"</div>` : ''}
              ${(p.llm?.ai_wording?.high_confidence_rationale) ? `<div style="font-size:14px;color:rgba(255,255,255,0.85);font-style:italic;padding-left:10px;border-left:3px solid ${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'};margin-top:6px">"${escapeHtml(p.llm.ai_wording.high_confidence_rationale)}"</div>` : ''}
            </div>
          ` : ''}"""

content = content.replace(old_ui, new_ui)

with open('src/core/app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("SUCCESS")
