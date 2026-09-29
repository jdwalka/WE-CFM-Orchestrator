const fs = require('fs');
let code = fs.readFileSync('/home/mauro/leaksnipe-mcp-agent/kodak-collector.js', 'utf8');

const target = `out.derivs.binance_liq_feed = {
    ok: true,
    recent_liquidations: merged,`;

const mtimeCheck = `
  let daemonAlive = false;
  try {
    const st = fs.statSync(LIQ_CACHE_FILE);
    // If cache file updated in last 60s, daemon is running/healthy
    if (Date.now() - st.mtimeMs < 60000) daemonAlive = true;
  } catch(_) {}
  
  const liq_feed_status = daemonAlive ? "HEALTHY" : "BLIND_DAEMON_DEAD";
`;

code = code.replace("out.derivs.binance_liq_feed = {", mtimeCheck + "\n  out.derivs.binance_liq_feed = {\n    liq_feed_status,");
fs.writeFileSync('/home/mauro/leaksnipe-mcp-agent/kodak-collector.js', code);
