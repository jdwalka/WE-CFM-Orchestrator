import os

file_path = "src/core/app.js"
with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Restore the missing grid
missing_grid = """                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;font-family:var(--font-mono);margin-top:4px">
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">15m MOVE</div>
                    <div style="font-weight:700;color:${e.expected15m > e.totalCostPct ? 'var(--color-green)' : 'var(--color-red)'}">${e.expected15m.toFixed(2)}%</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">COST</div>
                    <div style="font-weight:700;color:var(--color-red)">${e.totalCostPct.toFixed(2)}%</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">EDGE</div>
                    <div style="font-weight:700;color:${e.edge15 > 0 ? 'var(--color-green)' : 'var(--color-red)'}">${e.edge15 > 0 ? '+' : ''}${e.edge15.toFixed(2)}%</div>
                  </div>
                </div>

"""

target_marker = """                <div style="font-size:10px;color:var(--color-text-muted);margin:4px 0">${e.tierDesc}</div>

"""

if target_marker in content and missing_grid not in content:
    content = content.replace(target_marker, target_marker + missing_grid)
    print("Restored missing grid.")

# 2. Fix the syntax error at strikeC
syntax_error = """          const strikeC = ki.strikeStr || (() => {
            const m = (ki.contractTicker || '').match(/T(\\d+(?:\\.\\d+)?)$/);
            return m ? 'T' + Number(m[1]).toLocaleString() : '';
          
          const msNow = ki.closeTimeMs ? Math.max(0, ki.closeTimeMs - Date.now()) : null;"""

syntax_fix = """          const strikeC = ki.strikeStr || (() => {
            const m = (ki.contractTicker || '').match(/T(\\d+(?:\\.\\d+)?)$/);
            return m ? 'T' + Number(m[1]).toLocaleString() : '';
          })();
          
          const msNow = ki.closeTimeMs ? Math.max(0, ki.closeTimeMs - Date.now()) : null;"""

if syntax_error in content:
    content = content.replace(syntax_error, syntax_fix)
    print("Fixed syntax error.")
else:
    print("Syntax error not found exactly. Searching for variations...")
    syntax_error_var = "const strikeC = ki.strikeStr || (() => {\\n            const m = (ki.contractTicker || '').match(/T(\\d+(?:\\.\\d+)?)$/);\\n            return m ? 'T' + Number(m[1]).toLocaleString() : '';\\n          \\n          const msNow = ki.closeTimeMs"
    
    if syntax_error_var in content:
        print("Found variation.")

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)

print("Done.")
