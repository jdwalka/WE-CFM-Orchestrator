import sys
with open('src/core/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """              <!-- Model vs Kalshi probability — the primary insight -->
              <div style="margin-top:6px;padding:6px 8px;border-radius:4px;background:rgba(0,0,0,0.12);font-size:12px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:${liveKPct != null ? '5px' : '0'}">
                  <span style="color:var(--color-text-muted);font-size:10px;font-weight:600;letter-spacing:.4px">MODEL</span>
                  <strong style="font-size:14px;color:${modelColor}">${modelLeanStr}</strong>
                  <span style="font-size:10px;font-weight:800;color:${modelDirectionColor};padding:1px 6px;border-radius:999px;background:rgba(125,183,255,0.10)">${modelLean === 'up' ? 'UP' : modelLean === 'down' ? 'DOWN' : 'WAIT'}</span>
                  <span style="color:var(--color-text-faint);font-size:16px;font-weight:300">↔</span>
                  <span style="color:var(--color-text-muted);font-size:10px;font-weight:600;letter-spacing:.4px">KALSHI</span>
                  <strong style="font-size:14px;color:${kalshiColor}">${kalshiLeanStr}</strong>
                  <span style="margin-left:auto;display:flex;align-items:center;gap:6px">
                    ${alignBadge}
                    ${edgePp != null ? `<span style="color:${edgePp >= 20 ? 'var(--color-green)' : edgePp >= 10 ? '#ffd700' : 'var(--color-text-faint)'};font-size:10px;font-weight:${edgePp >= 15 ? '800' : '600'}">${edgePp}pp${edgePp >= 20 ? ' ⚡' : edgePp >= 10 ? ' ▲' : ''}</span>` : ''}
                  </span>
                </div>"""

replacement = """              <!-- Model vs Kalshi probability — the primary insight -->
              <div style="margin-top:4px;padding:4px 6px;border-radius:4px;background:rgba(0,0,0,0.12);font-size:11px;overflow:hidden">
                <div style="display:flex;align-items:center;gap:4px;margin-bottom:${liveKPct != null ? '4px' : '0'};white-space:nowrap">
                  <span style="color:var(--color-text-muted);font-size:9px;font-weight:600;letter-spacing:.4px">MODEL</span>
                  <strong style="font-size:12px;color:${modelColor}">${modelLeanStr}</strong>
                  <span style="font-size:9px;font-weight:800;color:${modelDirectionColor};padding:1px 4px;border-radius:999px;background:rgba(125,183,255,0.10)">${modelLean === 'up' ? 'UP' : modelLean === 'down' ? 'DN' : 'WAIT'}</span>
                  <span style="color:var(--color-text-faint);font-size:12px;font-weight:300;margin:0 2px">↔</span>
                  <span style="color:var(--color-text-muted);font-size:9px;font-weight:600;letter-spacing:.4px">KALSHI</span>
                  <strong style="font-size:12px;color:${kalshiColor}">${kalshiLeanStr}</strong>
                  <span style="margin-left:auto;display:flex;align-items:center;gap:4px;overflow:hidden">
                    ${alignBadge}
                    ${edgePp != null ? `<span style="color:${edgePp >= 20 ? 'var(--color-green)' : edgePp >= 10 ? '#ffd700' : 'var(--color-text-faint)'};font-size:9px;font-weight:${edgePp >= 15 ? '800' : '600'}">${edgePp}pp</span>` : ''}
                  </span>
                </div>"""

target2 = """                <div style="display:grid;grid-template-columns:44px 1fr;row-gap:3px;align-items:center;font-size:9px">"""
rep2 = """                <div style="display:grid;grid-template-columns:36px 1fr;row-gap:3px;align-items:center;font-size:9px">"""

c1 = content.replace(target, replacement)
c2 = c1.replace(target.replace('\n', '\r\n'), replacement.replace('\n', '\r\n'))
c3 = c2.replace(target2, rep2)
c4 = c3.replace(target2.replace('\n', '\r\n'), rep2.replace('\n', '\r\n'))

with open('src/core/app.js', 'w', encoding='utf-8') as f:
    f.write(c4)

if c4 != content:
    print("Patched successfully")
else:
    print("Patch failed, target string not found")
