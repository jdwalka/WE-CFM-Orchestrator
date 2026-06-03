const fs = require('fs');
let content = fs.readFileSync('src/core/app.js', 'utf8');

// 1. Comment out HOLD GUARD
const holdGuardTarget = '// Safety gate: avoid late/borderline calls';
const holdGuardStart = content.indexOf(holdGuardTarget);
if (holdGuardStart !== -1) {
  const holdGuardEnd = content.indexOf('// ── Verdict', holdGuardStart);
  if (holdGuardEnd !== -1) {
    const originalGuard = content.substring(holdGuardStart, holdGuardEnd);
    if (!originalGuard.includes('HOLD GUARD DISABLED')) {
      const commentedGuard = '/* HOLD GUARD DISABLED BY USER REQUEST\n' + originalGuard + '*/\n    const confNorm = _normalizeConfidence(p.confidence) ?? 0;\n    ';
      content = content.replace(originalGuard, commentedGuard);
      console.log('Hold guard patched');
    }
  }
}

// 2. Inject AI DIRECTIVE override & UI
// We will look for where verdictDir is set to 'wait' due to isWaitBlock
const verdictTarget = "verdictDir = isWaitBlock ? 'wait' : (p.score > 0 ? 'up' : p.score < 0 ? 'down' : 'wait');";
if (content.includes(verdictTarget)) {
  const replacement = `verdictDir = p.score > 0 ? 'up' : p.score < 0 ? 'down' : 'wait'; // bypass isWaitBlock natively

    // --- AI VERDICT OVERRIDE ---
    if (p.llm?.ai_verdict?.direction) {
      const aiDir = p.llm.ai_verdict.direction.toLowerCase();
      if (aiDir === 'up' || aiDir === 'down' || aiDir === 'wait') {
        verdictDir = aiDir;
        if (aiDir === 'wait') {
          waitRationale = p.llm.ai_verdict.logic_recheck_summary || 'AI synthesized data and concluded WAIT is optimal.';
        }
      }
    }`;
  content = content.replace(verdictTarget, replacement);
  console.log('Verdict override patched');
}

// 3. Inject AI UI block into prediction card rationale
const rationaleTarget = '          ${waitRationale ? `<div class="pred-verdict-rationale">${waitRationale}</div>` : \'\'}';
if (content.includes(rationaleTarget)) {
  const replacementUI = `          \${(p.llm?.ai_wording?.wait_rationale) ? \`<div class="pred-verdict-rationale"><span style="font-weight:700">✨ AI:</span> \${escapeHtml(p.llm.ai_wording.wait_rationale)}</div>\` : waitRationale ? \`<div class="pred-verdict-rationale">\${waitRationale}</div>\` : ''}
          
          \${(verdictDir !== 'wait') ? \`
            <div class="ai-insights-block" style="margin-top:14px;margin-bottom:8px;padding:16px;border-radius:12px;background:\${verdictDir === 'up' ? 'rgba(38,212,126,0.1)' : 'rgba(255,68,102,0.1)'};border:2px solid \${verdictDir === 'up' ? 'rgba(38,212,126,0.4)' : 'rgba(255,68,102,0.4)'};box-shadow: 0 4px 15px rgba(0,0,0,0.15);">
              <div style="font-size:18px;font-weight:900;color:\${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'};margin-bottom:10px;text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;justify-content:space-between">
                <span>⚡ AI DIRECTIVE: BUY \${verdictDir === 'up' ? 'YES' : 'NO'}</span>
              </div>
              \${(p.llm?.ai_wording?.primary_rationale) ? \`<div style="font-size:14px;color:rgba(255,255,255,0.85);font-style:italic;padding-left:10px;border-left:3px solid \${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'}">"\${escapeHtml(p.llm.ai_wording.primary_rationale)}"</div>\` : ''}
              \${(p.llm?.ai_wording?.high_confidence_rationale) ? \`<div style="font-size:14px;color:rgba(255,255,255,0.85);font-style:italic;padding-left:10px;border-left:3px solid \${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'};margin-top:6px">"\${escapeHtml(p.llm.ai_wording.high_confidence_rationale)}"</div>\` : ''}
            </div>
          \` : ''}`;
  content = content.replace(rationaleTarget, replacementUI);
  console.log('UI block patched');
}

fs.writeFileSync('src/core/app.js', content);
