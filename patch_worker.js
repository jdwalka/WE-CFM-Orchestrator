const fs = require('fs');
let content = fs.readFileSync('cloudflare/scalper-market-data/src/index.js', 'utf8');

// Add collector_timestamp to jsonResponse
content = content.replace(
  /function jsonResponse\(data, status = 200\) \{/,
  `function jsonResponse(data, status = 200) {
  if (data && typeof data === 'object' && !data.collector_timestamp) {
    data.collector_timestamp = new Date().toISOString();
  }`
);

fs.writeFileSync('cloudflare/scalper-market-data/src/index.js', content);
