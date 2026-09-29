const fs = require('fs');
let content = fs.readFileSync('src/core/app.js', 'utf8');

// 1. Comment out ALL execution guards (Safety gate + Ultra-late window)
const guardStart = content.indexOf('// Safety gate: avoid late/borderline calls');
if (guardStart !== -1) {
  const guardEndStr = "verdictSource = 'safety-semi-confidence-ultra-late';\n    }";
  let guardEnd = content.indexOf(guardEndStr, guardStart);
  if (guardEnd !== -1) {
    guardEnd += guardEndStr.length;
    const originalGuard = content.substring(guardStart, guardEnd);
    if (!originalGuard.includes('GUARDS DISABLED')) {
      const commentedGuard = '/* ALL ORCHESTRATOR GUARDS DISABLED BY USER REQUEST\n' + originalGuard + '\n*/';
      content = content.replace(originalGuard, commentedGuard);
      console.log('Orchestrator guards patched');
    }
  } else {
    console.log('Could not find end of guard block');
  }
}

// 2. Inject AI DIRECTIVE override & clean waitRationale
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

// 3. Clean waitRationale (remove references to undefined guard variables)
const rationaleStart = content.indexOf('const waitRationale = (() => {');
if (rationaleStart !== -1) {
  const rationaleEndStr = 'return `Model thinking: waiting for stronger directional confirmation.`;\n    })();';
  let rationaleEnd = content.indexOf(rationaleEndStr, rationaleStart);
  if (rationaleEnd !== -1) {
    rationaleEnd += rationaleEndStr.length;
    const originalRationale = content.substring(rationaleStart, rationaleEnd);
    const cleanRationale = `const waitRationale = (() => {
      if (verdictDir !== 'wait') return '';

      // Check if overridden by AI
      if (p.llm?.ai_verdict?.direction === 'wait') {
        return p.llm.ai_verdict.logic_recheck_summary || 'AI synthesized data and concluded WAIT is optimal.';
      }

      if (verdictSource) {
        if (verdictSource === 'model-cdf-neutral') {
          return \`Model thinking: CDF neutral at \${modelYesPct.toFixed(1)}% YES (needs >=58% for YES direction or <=42% for NO direction).\`;
        }
        if (verdictSource === 'model-uncertain') {
          return \`Model thinking: low conviction score \${scoreStr} (needs >+0.12 for UP or <-0.12 for DOWN).\`;
        }
        if (verdictSource === 'kalshi-fade') {
          return \`Kalshi edge (\${kalshiPct}% probability) is dominating the model score — taking a neutral stance.\`;
        }
      }
      return \`Model thinking: waiting for stronger directional confirmation.\`;
    })();`;
    content = content.replace(originalRationale, cleanRationale);
    console.log('waitRationale cleaned');
  }
}

// 4. Inject AI UI block into prediction card rationale
const rationaleUITarget = '          ${waitRationale ? `<div class="pred-verdict-rationale">${waitRationale}</div>` : \'\'}';
if (content.includes(rationaleUITarget)) {
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
  content = content.replace(rationaleUITarget, replacementUI);
  console.log('UI block patched');
} else {
  console.log('UI block target NOT FOUND');
}

fs.writeFileSync('src/core/app.js', content);
