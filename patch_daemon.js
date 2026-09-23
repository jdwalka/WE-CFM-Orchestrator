const fs = require('fs');
let code = fs.readFileSync('/home/mauro/leaksnipe-mcp-agent/kodak-collector.js', 'utf8');

// I will insert daemon logic at the bottom instead of just the one-shot.
// Lane 3: liq feed health & reconnect logic
const daemonCode = `
// ---------- DAEMON MODE ----------
async function runDaemon() {
  console.log("Starting liquidation websocket daemon...");
  let ws;
  let isAlive = false;
  
  function connect() {
    console.log("Connecting to Binance WS...");
    try {
      const wsOptions = {};
      if (SWEDEN_LOCAL_ADDRESS) {
        wsOptions.agent = new (require('https')).Agent({ localAddress: SWEDEN_LOCAL_ADDRESS, family: 4 });
      }
      ws = new WsClass('wss://fstream.binance.com/ws/!forceOrder@arr', wsOptions);
    } catch (e) {
      console.error("WS Create Error:", e.message);
      setTimeout(connect, 5000);
      return;
    }
    
    ws.on('open', () => {
      console.log("WS Connected.");
      isAlive = true;
    });
    
    ws.on('ping', () => { ws.pong(); });
    ws.on('pong', () => { isAlive = true; });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        const o = msg?.o;
        if (!o || o.s !== SYMBOL) return;
        const p = num(o.p);
        const q = num(o.q);
        if (!p || !q) return;
        
        const ev = {
          side: o.S === 'SELL' ? 'SELL' : 'BUY',
          price: p,
          qty: q,
          time: num(o.T),
          notional_usd: p * q,
          venue: 'binance',
        };
        
        const cached = loadCachedLiquidations();
        cached.push(ev);
        // keep last 1000 or recent 15m
        saveCachedLiquidations(cached);
      } catch (e) {
        console.error("Message parse error:", e);
      }
    });
    
    ws.on('close', () => {
      console.log("WS Closed. Reconnecting in 2s...");
      setTimeout(connect, 2000);
    });
    
    ws.on('error', (err) => {
      console.error("WS Error:", err.message);
      ws.close();
    });
  }
  
  connect();
  
  setInterval(() => {
    if (ws && ws.readyState === WsClass.OPEN) {
      if (!isAlive) {
        console.log("WS Connection dead. Terminating to trigger reconnect.");
        ws.terminate();
      }
      isAlive = false;
      ws.ping();
    }
  }, 30000);
}

if (process.argv.includes('--daemon')) {
  runDaemon();
} else {
  (async () => {
    await Promise.all([pullBooks(), pullDerivs(), pullSpot(), pullLiquidations()]);
    await pullContracts();
    computeDerived();
    console.log(JSON.stringify(out, null, 2));
  })().catch(e => { console.error('FATAL', e); process.exit(1); });
}
`;

code = code.replace(/\(async \(\) => \{[\s\S]*?\}\)\(\)\.catch\(e => \{ console\.error\('FATAL', e\); process\.exit\(1\); \}\);/, daemonCode);

fs.writeFileSync('/home/mauro/leaksnipe-mcp-agent/kodak-collector.js', code);
