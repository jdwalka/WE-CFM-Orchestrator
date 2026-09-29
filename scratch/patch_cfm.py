import os

file_path = "src/core/app.js"
with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

orch_bar_def = """    const orchBarInner = `
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
`;
"""

# Find where to insert it: right before "if (isStaleCFMRender()) {"
insertion_point = "    if (isStaleCFMRender()) {"
if orch_bar_def not in content:
    content = content.replace(insertion_point, orch_bar_def + "\n" + insertion_point)

broken_orch_html = """      ${orchBarHTML}
        <div class="cfm-orch-item"><span class="cfm-orch-dot ${status.running ? 'ok' : 'off'}"></span><span>${status.running ? 'Live' : 'Off'}</span></div>
        <div class="cfm-orch-item">Cycle <span class="cfm-orch-val">#${status.cycle ?? '—'}</span></div>
        <div class="cfm-orch-item">\\u0394 <span class="cfm-orch-val">${status.lastMs != null ? status.lastMs + 'ms' : '—'}</span></div>
        <div class="cfm-orch-item">Poll <span class="cfm-orch-val">15s</span></div>
        <div style="margin-left:auto;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${Object.entries(status.sources || {}).map(([k, v]) => `
            <div class="cfm-orch-item" style="border-left:2px solid ${v.color};padding-left:6px">
              <span class="cfm-orch-dot ${v.pct > 80 ? 'warn' : 'ok'}</span>
              <span>${v.label}</span>
              <span class="cfm-orch-val">${v.used}/${v.budget}</span>
            </div>
          `).join('')}
        </div>
      </div>"""

# actually, it's easier to regex replace lines 8214 to 8228
import re

content = re.sub(r'\$\{orchBarHTML\}[\s\S]*?</div>\n\s*</div>', '<div class="cfm-orch-bar" id="cfm-orch-bar">\n${orchBarInner}\n      </div>', content)

# Then fix the else block
else_block_old = """    } else {
      const existingOrchBar = document.getElementById('cfm-orch-bar');
      if (existingOrchBar) {
         // Re-build just the inner HTML of the orchestrator bar
         const tempDiv = document.createElement('div');
         tempDiv.innerHTML = orchBarHTML + '</div>';
         existingOrchBar.innerHTML = tempDiv.firstElementChild.innerHTML;
         existingOrchBar.className = tempDiv.firstElementChild.className;
      }
    }"""

else_block_new = """    } else {
      const existingOrchBar = document.getElementById('cfm-orch-bar');
      if (existingOrchBar) {
         existingOrchBar.innerHTML = orchBarInner;
      }
    }"""

content = content.replace(else_block_old, else_block_new)

# Also ensure content.scrollTop is NEVER touched.
# At line 8269, there's "/* Removed scroll reset */", we'll check if content.scrollTop = 0 exists anywhere in renderCFM.
# Since it says "Removed scroll reset", it seems the user already removed it. But let's verify.
content = content.replace("content.scrollTop = 0;", "/* content.scrollTop = 0; removed for 15s refresh cycle */")

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)

print("Patched renderCFM.")
