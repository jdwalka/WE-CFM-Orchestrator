const fs = require('fs');
const path = require('path');

const dataDirs = [
    path.join(__dirname, '..', 'data'),
    'E:\\WECRYPTO-data',
    'E:\\WECRYPTO\\data',
    'D:\\WECRYPTO\\data'
];
const loaderFile = path.join(__dirname, '..', 'src', 'kalshi', 'cloud-data-loader.js');

let allLogs = [];

for (const dataDir of dataDirs) {
    if (!fs.existsSync(dataDir)) continue;
    const dirs = fs.readdirSync(dataDir);
    for (const d of dirs) {
        const dPath = path.join(dataDir, d);
        if (fs.statSync(dPath).isDirectory()) {
            const jsonlPath = path.join(dPath, 'contract-export.jsonl');
            if (fs.existsSync(jsonlPath)) {
                const content = fs.readFileSync(jsonlPath, 'utf8');
                const lines = content.split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const parsed = JSON.parse(line);
                        parsed._settled = true; // IMPORTANT: Required for app.js filter
                        allLogs.push(parsed);
                    } catch (e) {}
                }
            }
        }
    }
}

// deduplicate by sym + ts
const uniqueLogs = [];
const seenIds = new Set();
for (const e of allLogs) {
    const sym = String(e.sym || e.symbol || e.coin || e.market || 'UNK').toUpperCase();
    const ts = e.settledTs || e.timestamp || e.resolved_at || e.ts || 0;
    const id = `${sym}-${ts}`;
    if (!seenIds.has(id)) {
        seenIds.add(id);
        uniqueLogs.push(e);
    }
}

const jsContent = `(function() {
  'use strict';
  window._INJECTED_KALSHI_LOG = ${JSON.stringify(uniqueLogs)};
  window.CloudDataLoader = {
    load: function() {
      console.log('[CloudDataLoader] Loaded ${uniqueLogs.length} historical logs');
      if (typeof window.render === 'function') {
        try { window.render(); } catch (e) {}
      }
    }
  };
  window.CloudDataLoader.load();
})();
`;

fs.writeFileSync(loaderFile, jsContent, 'utf8');
console.log(`Successfully injected ${uniqueLogs.length} logs into cloud-data-loader.js!`);
