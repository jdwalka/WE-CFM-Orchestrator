const { workerData, parentPort } = require('worker_threads');
const WebSocket = require('ws');

// The SharedArrayBuffer passed from the main process
const sab = workerData.sab;
const floatView = new Float64Array(sab);

// Basic Schema:
// index 0: BTCUSDT Price
// index 1: ETHUSDT Price
// index 2: SOLUSDT Price
// index 3: XRPUSDT Price
// index 4: DOGEUSDT Price
// index 5: BNBUSDT Price

const symbolMap = {
  'btcusdt': 0,
  'ethusdt': 1,
  'solusdt': 2,
  'xrpusdt': 3,
  'dogeusdt': 4,
  'bnbusdt': 5
};

console.log('[Worker] Started High-Frequency WebSocket OS Thread.');

function connectBinance() {
  const ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');

  ws.on('open', () => {
    console.log('[Worker] Connected to Binance MiniTicker Stream');
  });

  ws.on('message', (data) => {
    try {
      const payload = JSON.parse(data);
      for (const tick of payload) {
        const symbol = tick.s.toLowerCase();
        const price = parseFloat(tick.c);
        
        const idx = symbolMap[symbol];
        if (idx !== undefined) {
          // Write directly to the SharedArrayBuffer (Physical Memory)
          // The UI thread can read this instantly without any GC or serialization overhead
          floatView[idx] = price;
        }
      }
    } catch (e) {
      // Ignore parse errors from malformed frames
    }
  });

  ws.on('close', () => {
    console.warn('[Worker] Binance WS disconnected. Reconnecting in 2s...');
    setTimeout(connectBinance, 2000);
  });
  
  ws.on('error', (err) => {
    console.error('[Worker] Binance WS Error:', err);
  });
}

connectBinance();
