# Pyth Lazer Network Integration Diagnostic & Setup

**Date:** May 9, 2026  
**Status:** ⚠️ PARTIAL - Real-time prices configured, but predictions.js not using Pyth data

## Current Wiring Status

### ✅ What's Working

1. **Main Process (electron/main.js:51-150)**
   - Pyth Lazer WebSocket client initialized with 3 endpoints (redundant pool)
   - 3 retry attempts with 2-second delays on connection failures
   - IPC event `pyth:tickers` broadcasts price updates to renderer
   - Connection pooling with `wss://pyth-lazer-*.dourolabs.app/v1/stream`
   - Subscribes to 8 feed IDs: BTC(1), ETH(2), SOL(6), DOGE(10), XRP(14), BNB(15), F13(13), F110(110)
   - Properties: price, bid, ask, confidence, exponent, volume, funding rates

2. **Preload Bridge (electron/preload.js:46-50)**
   - Exposes `window.pythLazer` API:
     - `onTickers(cb)` - callback on `pyth:tickers` IPC event
     - `offTickers()` - cleanup listener
     - `getCandles(opts)` - fetch historical candlesticks
     - `getProxyLatest(feedIds)` - fetch latest prices via proxy

3. **App Layer (src/core/app.js:1274-1282)**
   - `fetchPythTickers()` function attempts to use real-time stream
   - Waits up to 3 seconds for data
   - Maps Pyth prices to ticker format

### ❌ What's Missing

1. **Predictions Engine (src/core/predictions.js)**
   - ❌ NOT using Pyth real-time prices for candlestick data
   - ❌ Still fetching from Crypto.com, Binance, CoinGecko only
   - ❌ No integration with Pyth History API for OHLCV data
   - Effect: Predictions miss Pyth's sub-100ms price accuracy

2. **Environment Variable**
   - ❌ PYTH_LAZER_TOKEN not documented in setup
   - Status: Falls back to hardcoded token if missing

3. **Real-Time Integration Gap**
   - Pyth Lazer WS provides tickers only (last price, bid/ask)
   - Predictions need candlestick data (OHLC + volume + time buckets)
   - Current: WS → IPC → ticker only (no 1m/5m/15m OHLCV buckets)

4. **Monitoring & Observability**
   - No health check dashboard showing Pyth connection status
   - Limited diagnostics in DevTools
   - No fallback recovery logging

---

## Configuration Requirements

### 1. Environment Setup

Set the Pyth Lazer access token:

```bash
# In .env (next to executable or repo root)
PYTH_LAZER_TOKEN=YOUR_TOKEN_HERE
```

Get token from: https://dourolabs.app (Pyth Lazer dashboard)

### 2. Token Validation

Check if token is loaded:

```javascript
// In DevTools console
window.electron?.invoke?.('env:get', 'PYTH_LAZER_TOKEN')
// or
process.env.PYTH_LAZER_TOKEN
```

### 3. Connection Monitoring

Check connection status in DevTools:

```javascript
// Monitor IPC messages
window.addEventListener('pyth:tickers', (e) => console.log('Pyth data:', e.detail));

// Check last received
window.__WECRYPTO_STARTUP?.pythLazerStatus?.()

// View connection errors
window.__WECRYPTO_DEBUG?.getPythStatus?.()
```

---

## Real-Time Feed Gaps & Solutions

### Gap 1: Candlestick Data
**Problem:** Pyth Lazer WS sends tickers (price, bid, ask) but predictions need OHLCV candles

**Current Workaround:** Predictions still use Crypto.com/Binance historical candles

**Solution:** Integrate Pyth History API for 1m/5m/15m OHLCV
```javascript
// Proposed in src/feeds/pyth-candle-fetcher.js
async function fetchPythCandles(instrument, tf, count = 300) {
  // Call https://pyth.dourolabs.app for OHLCV
  // Map Crypto.BTC/USD → OHLCV candles
}
```

### Gap 2: Real-Time Candle Buckets
**Problem:** Pyth Lazer WS pushes individual price updates, not time-bucketed candles

**Current Workaround:** App.js CandleWS aggregates 1m/5m/15m from exchange streams

**Solution:** Create local candle aggregator for Pyth prices
```javascript
// Proposed in src/feeds/pyth-realtime-candles.js
class PythRealtimeCandleAggregator {
  constructor() {
    this.buckets = new Map(); // tf → candles
  }
  
  onPrice(feed, price, timestamp) {
    // Bucket price into 1m/5m/15m candles
    // Emit 'candleClose' when bucket fills
  }
}
```

### Gap 3: Prediction Engine Integration
**Problem:** predictions.js.loadCoinData() only checks Coinbase/Binance

**Solution:** Add Pyth as primary source before fallback
```javascript
// In predictions.js loadCoinData()
const pythCandles = await loadPythCandles(coin, '5m', 300);
const candles = pythCandles.length > 60 
  ? pythCandles 
  : anchoredPoolCandles(cb5m, bin5m); // fallback
```

---

## Health Check Procedure

### 1. Verify Pyth WS Connection

**Terminal:**
```powershell
# Check if Pyth Lazer SDK is installed
npm list @pythnetwork/pyth-lazer-sdk

# Expected output
# @pythnetwork/pyth-lazer-sdk@~X.X.X
```

**DevTools (after app startup):**
```javascript
// Console
console.log('[PythLazer]', window.__WECRYPTO_STARTUP?.pythStatus || 'No status available');

// Logs should show:
// [PythLazer] Connecting (attempt 1/3)...
// [PythLazer] ✅ Client started — feeds: 1,2,6,10,13,14,15,110
```

### 2. Monitor Ticker Flow

```javascript
// Listen for incoming prices
let priceCount = 0;
window.pythLazer?.onTickers?.((prices) => {
  priceCount++;
  console.log(`[Pyth] Received batch #${priceCount}:`, Object.keys(prices));
  // Should print: BTCUSD, ETHUSD, SOLUSD, DOGEUSD, XRPUSD, BNBUSD
});

// Check after 5 seconds
setTimeout(() => console.log(`[Pyth] Batches received: ${priceCount}`), 5000);
```

### 3. Verify Fallback Chain

```javascript
// app.js fetchPythTickers flow
window.PredictionMarkets?.getCoin?.('BTC')
// Should include:
// { ..., kalshi15m: 0.58, kalshi5m: 0.61, poly: 0.54, pyth: 0.575 }
```

### 4. Check Prediction Data Source

```javascript
// See where predictions.js gets its candlestick data
candleCache.BTC
// .source should include: "coinbase + binance" or "pyth + ..." (after fix)
// .ts should be recent (< 2 seconds old)
```

---

## Recommended Production Fixes

### Priority 1: Enable Pyth History API for Candles
**File:** `src/feeds/pyth-candle-fetcher.js` (create new)

```javascript
async function fetchPythCandles(instrument, tf, count = 300) {
  const symbol = INSTR_TO_PYTH_SYM[instrument]; // 'Crypto.BTC/USD'
  if (!symbol) return [];
  
  const end = Math.floor(Date.now() / 1000);
  const tfSecs = { '1m': 60, '5m': 300, '15m': 900 }[tf] || 900;
  const start = end - (tfSecs * count);
  
  const url = `https://pyth.dourolabs.app/api/get_candles?symbol=${symbol}&start=${start}&end=${end}&interval=${tfSecs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pyth candles HTTP ${res.status}`);
  
  const data = await res.json();
  return (data.candles || []).map(c => ({
    t: c.t * 1000, // timestamp in ms
    o: c.o, // open
    h: c.h, // high
    l: c.l, // low
    c: c.c, // close
    v: c.v, // volume
  }));
}
```

### Priority 2: Wire Pyth into predictions.js
**File:** `src/core/predictions.js` loadCoinData()

```javascript
// Add at start of loadCoinData():
const pythCandles = await fetchPythCandles(coin.sym, '5m', 300).catch(() => []);
const pythCandles15m = await fetchPythCandles(coin.sym, '15m', 300).catch(() => []);

// Use as primary source:
const candles = pythCandles.length > 60 ? pythCandles : anchoredPoolCandles(...);
```

### Priority 3: Add Health Monitoring
**File:** `src/core/pyth-health-monitor.js` (create new)

```javascript
window.PythHealthMonitor = {
  status: {
    connected: false,
    lastUpdate: 0,
    feedCount: 0,
    errorCount: 0,
  },
  
  init() {
    window.pythLazer?.onTickers?.((prices) => {
      this.status.connected = true;
      this.status.lastUpdate = Date.now();
      this.status.feedCount = Object.keys(prices).length;
      this.status.errorCount = 0;
    });
  },
  
  getStatus() { return this.status; },
  isHealthy() { 
    return this.status.connected && 
           (Date.now() - this.status.lastUpdate) < 5000;
  },
};
```

---

## Verification Checklist

- [ ] Token set: `echo $PYTH_LAZER_TOKEN` (Windows) or `echo $env:PYTH_LAZER_TOKEN` (PowerShell)
- [ ] SDK installed: `npm list @pythnetwork/pyth-lazer-sdk`
- [ ] App starts: `npm start` shows `[PythLazer] ✅ Client started`
- [ ] Prices flow: DevTools shows `[Pyth] Batches received: >0`
- [ ] Predictions use it: `candleCache.BTC.source` includes 'pyth' or fallback works
- [ ] Fallback tested: Stop Pyth, verify predictions still work with Binance/Coinbase

---

## Troubleshooting

### Pyth Connection Fails
```
[PythLazer] Connection failed: ENOTFOUND pyth-lazer-0.dourolabs.app
```
**Fix:** Check network/DNS, verify `PYTH_LAZER_TOKEN` is set

### Token Validation Error
```
[PythLazer] Connection failed: 401 Unauthorized
```
**Fix:** Get fresh token from https://dourolabs.app

### No Data Received
```
[Pyth] Batches received: 0
```
**Fix:** 
1. Verify token is set
2. Check firewall (WSS port 443 required)
3. Monitor `pyth:connection-lost` IPC event

### Predictions Still Using Old Data
```
candleCache.BTC.source = "coinbase + binance"  // not including pyth
```
**Fix:** Run Priority 2 above, then restart app

---

## Next Steps

1. **Set PYTH_LAZER_TOKEN** in `.env` or environment
2. **Restart app** and confirm `[PythLazer] ✅` message
3. **Run health check** in DevTools
4. **Implement Priority 1-3 fixes** for full integration
5. **Test fallback chain** with Pyth offline

