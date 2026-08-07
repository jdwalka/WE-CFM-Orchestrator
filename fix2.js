const fs = require('fs');
const path = require('path');

const file = path.join('g:', 'WECRYP', 'src', 'core', 'ui', 'render-layer.js');
let code = fs.readFileSync(file, 'utf8');

// I need to repair the damage from the multi_replace tool.
// I will just revert the file to backup, then inject my string safely.

const backupFile = path.join('g:', 'WECRYP', 'src', 'core', 'app.js.backup.v2.13.19');
let backupCode = fs.readFileSync(backupFile, 'utf8');

// The multi_replace damaged render-layer.js, but I have git or I can just fix the HTML string manually.
// Wait, I can just fix the string.

// Let's find the Model Odds block
const startIdx = code.indexOf('<div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px;">Model Odds</div>');

const endIdx = code.indexOf('const borderCol = scalpSig.color;');

if (startIdx !== -1 && endIdx !== -1) {
    const replacement = `<div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px;">Model Odds</div>
              \${(() => {
          const modelOdds = _modelOdds(sym);
          if (modelOdds == null) return \`<span style="color:var(--color-text-faint);font-size:11px">Run predictions</span>\`;
          const action = modelOdds >= 0.55 ? '▲ BUY YES' : modelOdds <= 0.45 ? '▼ BUY NO' : '◆ WAIT';
          const actionColor = modelOdds >= 0.55 ? 'var(--color-green)' : modelOdds <= 0.45 ? 'var(--color-red)' : 'var(--color-text-faint)';
          return modelOdds != null ? \`
                  <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:4px;">
                    <span style="color:\${actionColor};font-size:14px;font-weight:700">\${Math.round(modelOdds * 100)}%</span>
                    <span style="font-size:12px;color:var(--color-text-muted)">YES</span>
                  </div>
                  <div style="font-size:11px;color:var(--color-text-faint);margin-top:3px;">\${action}</div>
                \` : \`<span style="color:var(--color-text-faint);font-size:11px">—</span>\`;
        })()}
            </div>

          </div>

          <!-- Market Trajectory (Upcoming 5M) -->
          \${displayPolyMkts.length > 1 ? \`
          <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;margin-top:8px;">
            <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Market Momentum (Next 15m)</div>
            <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;">
              \${displayPolyMkts.map(m => {
                const isCurrent = m.slug === p5?.slug;
                const activeColor = isCurrent ? 'var(--color-primary)' : 'var(--color-border)';
                const probColor = m.yes >= 0.5 ? 'var(--color-green)' : 'var(--color-red)';
                const timeLabel = m.endDate ? new Date(m.endDate).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Next';
                return \`
                <div style="flex:1;min-width:60px;padding:6px;border-radius:4px;background:var(--color-surface);border:1px solid \${activeColor};text-align:center;">
                  <div style="font-size:9px;color:var(--color-text-muted);margin-bottom:2px;">\${timeLabel}</div>
                  <div style="font-size:13px;font-weight:700;color:\${probColor}">\${Math.round(m.yes * 100)}%</div>
                </div>\`;
              }).join('')}
            </div>
          </div>
          \` : ''}

          <!-- Scalp & Exit Timing -->
          \${(() => {
          const scalpSig = _scalpSignal(sym);
          if (!scalpSig) return '';
          const bgColor = scalpSig.color === '#4caf50' ? 'rgba(76,175,80,0.15)' : scalpSig.color === '#ff9800' ? 'rgba(255,152,0,0.15)' : 'rgba(244,67,54,0.15)';
          `;
    
    code = code.substring(0, startIdx) + replacement + code.substring(endIdx);
    fs.writeFileSync(file, code, 'utf8');
} else {
    console.error("COULD NOT FIND INDEXES!");
}
