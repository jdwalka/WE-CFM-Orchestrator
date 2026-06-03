const fs = require('fs');

const file = 'G:\\WECRYP\\src\\core\\app.js';
let content = fs.readFileSync(file, 'utf8');

const targetRegex = /function renderFifteenMinuteMovePlan\(ki, compact = false\) \{[\s\S]*?return `\n\s*<div style="margin-top:\$\{compact \? 3 : 5\}px;padding:\$\{compact \? '4px 6px' : '6px 8px'\};border-radius:4px;background:rgba\(90,110,255,0\.08\);border:1px solid rgba\(120,140,255,0\.18\);line-height:1\.35\">\n\s*<div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">\n\s*<span style="font-size:\$\{compact \? '9px' : '10px'\};font-weight:700;color:var\(--color-text-faint\);letter-spacing:\.45px\">15M MOVE[^<]*?<\/span>\n\s*<span style="font-size:\$\{lineFont\};font-weight:800;color:\$\{plan\.tone\}">\$\{plan\.title\}<\/span>\n\s*<\/div>\n\s*<div style="font-size:\$\{lineFont\};color:var\(--color-text-muted\);margin-top:2px">\$\{plan\.detail\}<\/div>\n\s*<\/div>\n\s*`;\n\s*\}/m;

const replacement = `function renderFifteenMinuteMovePlan(ki, compact = false) {
      const plan = buildFifteenMinuteMovePlan(ki);
      if (!plan) return '';
      const phaseLabel = {
        OPENING: 'OPEN',
        SETUP: 'SETUP',
        PRIME: 'PRIME',
        SCALP: 'SCALP',
        CLOSE_VALUE: '2-3M VALUE',
        LATE: 'LATE',
        LAST_CALL: 'LAST CALL',
        SETTLING: 'SETTLING',
        UNTIMED: 'LIVE',
      }[plan.phase] || plan.phase;
      const lineFont = compact ? '10px' : '11px';
      
      const modelScoreHtml = Number.isFinite(ki.modelScore) 
        ? \`<span style="margin-left:8px;font-size:9px;color:var(--color-text-faint);border:1px solid rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px">Score: \${ki.modelScore.toFixed(3)}</span>\` : '';
      const modelProbHtml = Number.isFinite(ki.modelProbYes) 
        ? \`<span style="margin-left:4px;font-size:9px;color:var(--color-text-faint);border:1px solid rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px">Model: \${(ki.modelProbYes * 100).toFixed(1)}% YES</span>\` : '';
      const aiReasoningHtml = (!compact && ki.humanReason)
        ? \`<div style="margin-top:5px;font-size:10px;color:#aab0c0;border-left:2px solid var(--color-accent);padding-left:6px">\${ki.humanReason}</div>\` : '';

      return \`
        <div style="margin-top:\${compact ? 3 : 5}px;padding:\${compact ? '4px 6px' : '6px 8px'};border-radius:4px;background:rgba(90,110,255,0.08);border:1px solid rgba(120,140,255,0.18);line-height:1.35">
          <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
            <span style="font-size:\${compact ? '9px' : '10px'};font-weight:700;color:var(--color-text-faint);letter-spacing:.45px">15M MOVE &middot; \${phaseLabel}</span>
            <span style="font-size:\${lineFont};font-weight:800;color:\${plan.tone}">\${plan.title}</span>
            \${modelScoreHtml}
            \${modelProbHtml}
          </div>
          <div style="font-size:\${lineFont};color:var(--color-text-muted);margin-top:2px">\${plan.detail}</div>
          \${aiReasoningHtml}
        </div>
      \`;
    }`;

if (targetRegex.test(content)) {
    content = content.replace(targetRegex, replacement);
    fs.writeFileSync(file, content, 'utf8');
    console.log("Patched successfully via node.");
} else {
    console.log("Match not found via node.");
}
