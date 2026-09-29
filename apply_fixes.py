import os
import re

file_path = "src/core/app.js"
with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# Fix 1: Properly close the IIFE for strikeC
strikeC_broken = """          const strikeC = ki.strikeStr || (() => {
            const m = (ki.contractTicker || '').match(/T(\\d+(?:\\.\\d+)?)$/);
            return m ? 'T' + Number(m[1]).toLocaleString() : '';
          
          const msNow = ki.closeTimeMs ? Math.max(0, ki.closeTimeMs - Date.now()) : null;"""

strikeC_fixed = """          const strikeC = ki.strikeStr || (() => {
            const m = (ki.contractTicker || '').match(/T(\\d+(?:\\.\\d+)?)$/);
            return m ? 'T' + Number(m[1]).toLocaleString() : '';
          })();
          
          const msNow = ki.closeTimeMs ? Math.max(0, ki.closeTimeMs - Date.now()) : null;"""

content = content.replace(strikeC_broken, strikeC_fixed)

# Fix 2: Refactor renderCFM()
# To avoid matching too broadly, we first isolate renderCFM function block
start_idx = content.find("async function renderCFM()")
end_idx = content.find("function renderContractLog()", start_idx)
render_cfm_block = content[start_idx:end_idx]

orch_bar_inner = """
        <div class="cfm-orch-item"><span class="cfm-orch-dot ${status.running ? 'ok' : 'off'}"></span><span>${status.running ? 'Live' : 'Off'}</span></div>
        <div class="cfm-orch-item">Cycle <span class="cfm-orch-val">#${status.cycle ?? '—'}</span></div>
        <div class="cfm-orch-item">\\u0394 <span class="cfm-orch-val">${status.lastMs != null ? status.lastMs + 'ms' : '—'}</span></div>
        <div class="cfm-orch-item">Poll <span class="cfm-orch-val">15s</span></div>
        <div style="margin-left:auto;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${Object.entries(status.sources || {}).map(([k, v]) => `
            <div class="cfm-orch-item" style="border-left:2px solid ${v.color};padding-left:6px">
              <span class="cfm-orch-dot ${v.pct > 80 ? 'warn' : 'ok'}"></span>
              <span>${v.label}</span>
              <span class="cfm-orch-val">${v.used}/${v.budget}</span>
            </div>
          `).join('')}
        </div>
"""

# Now search within render_cfm_block
match = re.search(r'content\.innerHTML\s*=\s*`([^`]*?<div class="cfm-orch-bar">)([^`]*?)(</div>\s*<!-- Shell Legend)', render_cfm_block)
if match:
    prefix = match.group(1)
    suffix = match.group(3)
    
    old_full_assignment = match.group(0)
    
    new_assignment = """    const existingRoot = content.querySelector('.cfm-view-root');
    const orchBarInner = `""" + orch_bar_inner + """`;
    
    if (!existingRoot) {
      content.innerHTML = `
        <div class="cfm-view-root">
""" + prefix.replace('content.innerHTML = `\n', '').replace('content.innerHTML = `', '') + """
        ${orchBarInner}
""" + suffix + """
      `;
    } else {
      const existingOrchBar = document.getElementById('cfm-orch-bar');
      if (existingOrchBar) {
         existingOrchBar.innerHTML = orchBarInner;
      }
    }"""
    
    render_cfm_block = render_cfm_block.replace(old_full_assignment, new_assignment)
    render_cfm_block = render_cfm_block.replace('<div class="cfm-orch-bar">', '<div class="cfm-orch-bar" id="cfm-orch-bar">')

render_cfm_block = render_cfm_block.replace('content.scrollTop = 0;', '/* content.scrollTop = 0; (Removed to prevent 15s scroll resets) */')

content = content[:start_idx] + render_cfm_block + content[end_idx:]

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)

print("Applied fixes safely.")
