const fs = require('fs');
const path = require('path');

const file = path.join('g:', 'WECRYP', 'src', 'core', 'ui', 'render-layer.js');
let code = fs.readFileSync(file, 'utf8');

const backupFile = path.join('g:', 'WECRYP', 'src', 'core', 'app.js.backup.v2.13.19');
let backupCode = fs.readFileSync(backupFile, 'utf8');

// The backup contains a very similar structure, but it's an old backup of `app.js` which might not have the exact same contents.
// Wait, `app.js.backup.v2.13.19` is the only backup I saw. Let's see if I can find the Polymarket + Model row in `code`.

const searchTarget = `<!-- Polymarket + Model row -->`;
const startIdx = code.indexOf(searchTarget);

const endTarget = `<!-- Scalp & Exit Timing -->`;
const endIdx = code.indexOf(endTarget);

if (startIdx !== -1 && endIdx !== -1) {
    const replacement = `<!-- Polymarket + Model row -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">

            <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;">
              <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px;">
                Polymarket 5M
              </div>
              \${p5 ? \`
                <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:4px;">
                  <span style="color:var(--color-green);font-size:14px;font-weight:700">\${_pct(p5prob)}</span>
                  <span style="font-size:12px;color:var(--color-text-muted)">UP odds</span>
                </div>
                <div style="font-size:11px;color:var(--color-text-faint);margin-top:3px;" id="p5cd-\${sym}" data-close="\${p5.closeTime || p5.endDate || ''}">⏱ \${_countdown(p5.closeTime || p5.endDate)}</div>
                \${liveCurrentLabel ? \`<div style="font-size:11px;color:var(--color-text-muted);margin-top:4px;">Current (\${String(liveCurrentSource).startsWith('pyth-lazer') ? 'Pyth' : 'Chainlink'}) <strong style="color:var(--color-text)">\${liveCurrentLabel}</strong></div>\` : ''}
                \${p5.targetPrice ? \`<div style="font-size:11px;color:var(--color-text);margin-top:4px;">Price to beat <strong>\${p5.targetPriceApprox ? '~' : ''}\${p5.targetPrice}</strong></div>\` : ''}
                \${live5m ? \`<div style="font-size:11px;color:\${live5m.dir === 'UP' ? 'var(--color-green)' : 'var(--color-red)'};margin-top:4px;">\${live5m.state} by <strong>\${_fmtSignedPriceDelta(live5m.delta)}</strong></div>\` : \`<div style="font-size:11px;color:var(--color-orange);margin-top:4px;">Waiting for Polymarket price-to-beat baseline</div>\`}
                \${Number.isFinite(liveOracleBasis) ? \`<div style="font-size:10px;color:var(--color-text-faint);margin-top:3px;">Pyth/Chainlink basis \${_fmtSignedPriceDelta(liveOracleBasis)} · settlement \${p5.settlementLiveDirection || 'pending'}</div>\` : ''}
                <div style="font-size:10px;color:var(--color-text-faint);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="\${p5.slug || ''}">\${p5.slug || 'poly5m'}</div>
                \${p5.currentPriceJustification ? \`<div style="font-size:10px;color:var(--color-text-faint);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="\${p5.currentPriceJustification}">\${p5.currentPriceJustification}</div>\` : ''}
                \${(p5.priceToBeatSource || p5.discoverySource) ? \`<div style="font-size:10px;color:var(--color-text-faint);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="\${p5.fallbackJustification || ''}">PTB \${p5.priceToBeatSource || 'pending'} · \${p5.discoverySource || p5._source || 'poly5m'}</div>\` : ''}
                <div style="margin-top:5px">\${_liveSide(live5m, false)}</div>
              \` : \`<div style="color:var(--color-text-faint);font-size:11px">No Poly 5M market</div>\`}
            </div>

            <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;">
              <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px;">Model Odds</div>
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

          <!-- Scalp & Exit Timing -->`;
    code = code.substring(0, startIdx) + replacement + code.substring(endIdx + "<!-- Scalp & Exit Timing -->".length);
    fs.writeFileSync(file, code, 'utf8');
} else {
    console.error("NOT FOUND");
}
