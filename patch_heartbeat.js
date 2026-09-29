const fs = require('fs');
let code = fs.readFileSync('/home/mauro/leaksnipe-mcp-agent/kodak-collector.js', 'utf8');

// Update daemon setInterval to update cache file mtime
code = code.replace(
  "isAlive = false;\n      ws.ping();\n    }",
  `isAlive = false;\n      ws.ping();\n    }\n    // Heartbeat touch\n    try { const now = new Date(); fs.utimesSync(LIQ_CACHE_FILE, now, now); } catch(e){}`
);

fs.writeFileSync('/home/mauro/leaksnipe-mcp-agent/kodak-collector.js', code);
