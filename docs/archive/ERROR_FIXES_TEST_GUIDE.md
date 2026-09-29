# WECRYPTO Error Fixes - Test & Verification Guide

## Quick Verification (No Code Changes Needed)

### Test 1: Kalshi IPC Bridge ✅
**What to verify:** Kalshi balance polling works without "Cannot read properties of undefined"

**Steps:**
1. Start the app with Electron
2. Wait 5 seconds for Kalshi polling to start
3. Check browser console for: `[Kalshi] Renderer bridge loaded. Use window.Kalshi.*`
4. After ~5 seconds, should see: `[Kalshi] Balance: $XXX` (or error if credentials missing)

**Success criteria:**
- ✓ No "Cannot read properties of undefined (reading 'invoke')" error
- ✓ Either balance shown OR specific "Kalshi API error", not IPC error
- ✓ Polling continues every 5 seconds

**If fails:**
- Check that preload.js is loaded before kalshi-renderer-bridge.js
- Verify `window.electron.invoke` exists: `console.log(window.electron?.invoke)`

---

### Test 2: Gecko Rate Limit Handling ✅
**What to verify:** When CoinGecko rate-limits, app continues gracefully

**Steps:**
1. Make multiple requests to CoinGecko within short time window
   ```javascript
   // In browser console:
   for(let i = 0; i < 10; i++) {
     fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd')
       .then(r => r.status === 429 ? console.log('429!') : console.log('OK'))
   }
   ```
2. Trigger prediction engine to fetch Gecko data: `window.PredictionEngine?.runAll()`
3. Check console for rate limit messages

**Success criteria:**
- ✓ See log: `[Gecko] Rate limited (429) for bitcoin, skipping candles fallback`
- ✓ Predictions still generate (using fallback data)
- ✓ No uncaught errors in console

**If fails:**
- Check Network tab in DevTools for 429 responses
- Verify error includes "429" in message

---

### Test 3: Chain Router Fallback (BNB) ✅
**What to verify:** BSC data tries Ankr → BSCScan → Blockscout on failures

**Steps:**
1. Open DevTools Network tab
2. Go to "Orbital" or "Chain Router" section in app
3. Check BNB metrics update (Gas Price, Block number)
4. Watch console for endpoint selection messages

**Success criteria:**
- ✓ BNB metrics display (Gas, Block, Txs)
- ✓ Console shows which source was used: `[ChainRouter] BNB handler: Ankr RPC`
- ✓ No "Ankr BSC RPC empty" error (or only briefly, then succeeds with fallback)

**If fails:**
- Check Network tab - see what endpoints are being called
- Verify JSON responses in Network tab aren't null/empty
- Check if all three handlers are present in ROUTES array

---

### Test 4: Blockscout Data Validation ✅
**What to verify:** Empty Blockscout responses trigger fallback

**Simulate empty response:**
```javascript
// In browser console, before app fetches:
// Add network mock (requires service worker or proxy)
// Or manually test in node:
const response = { stats: {}, gasOracle: {} };  // Empty
// Handler should reject and fallback
```

**Success criteria:**
- ✓ If Blockscout returns empty, logs fallback: `[ChainRouter] BNB handler failed: Blockscout BSC empty`
- ✓ App tries BSCScan next
- ✓ Final result uses working source (not stale cache with stale flag)

---

### Test 5: Etherscan Proxy Validation ✅
**What to verify:** Invalid Etherscan responses trigger fallback to Blockscout

**Steps:**
1. Monitor ETH metrics in app
2. Check Network tab for Etherscan calls
3. Verify response has valid `result` field

**Success criteria:**
- ✓ ETH metrics display (Gas Price, Block)
- ✓ If Etherscan fails, Blockscout is tried next
- ✓ Error logs show which handler succeeded: `source: 'Blockscout'` or `'Etherscan'`

---

## Automated Testing (For Developers)

### Unit Test Template
```javascript
// Test: bnbAnkrRpc handles null response
async function testBnbAnkrRpcNullResponse() {
  // Mock timedFetch to return null
  const originalFetch = global.timedFetch;
  global.timedFetch = async () => ({
    json: async () => null
  });
  
  try {
    await bnbAnkrRpc();
    console.error('❌ Should have thrown "Ankr BSC RPC empty"');
  } catch (e) {
    if (e.message.includes('Ankr BSC RPC empty')) {
      console.log('✓ Correctly throws on null response');
    } else {
      console.error('❌ Wrong error:', e.message);
    }
  } finally {
    global.timedFetch = originalFetch;
  }
}

// Test: Gecko 429 returns empty data
async function testGecko429Handling() {
  // Mock fetchGeckoJSON to throw 429
  const result = await fetchGeckoCandles('bitcoin');
  
  if (Array.isArray(result) && result.length === 0) {
    console.log('✓ 429 error returns empty array gracefully');
  } else {
    console.error('❌ Should return empty array on 429');
  }
}
```

### Integration Test
```javascript
// Full chain router test
async function testChainRouterFallback() {
  const results = await ChainRouter.fetchAll();
  
  const checks = {
    btc: results.BTC?.sym === 'BTC' && results.BTC?.metrics?.length > 0,
    eth: results.ETH?.sym === 'ETH' && results.ETH?.metrics?.length > 0,
    bnb: results.BNB?.sym === 'BNB' && results.BNB?.metrics?.length > 0,
  };
  
  Object.entries(checks).forEach(([coin, ok]) => {
    console.log(`${ok ? '✓' : '❌'} ${coin}: ${ok ? 'OK' : 'FAILED'}`);
  });
  
  return Object.values(checks).every(v => v);
}
```

---

## Production Verification Checklist

- [ ] App starts without IPC undefined errors
- [ ] Kalshi balance updates every 5 seconds (or shows specific error)
- [ ] Chain router displays metrics for all 7 coins
- [ ] No "empty" errors appear in console during normal operation
- [ ] If one endpoint fails, next in fallback chain is tried
- [ ] Stale cache is used with "stale: true" flag when all handlers fail
- [ ] Predictions generate successfully even if some data sources fail
- [ ] CoinGecko rate limits are logged explicitly
- [ ] Error logs follow pattern: `[ComponentName] issue: specific reason`

---

## Troubleshooting

### "Cannot read properties of undefined (reading 'invoke')"
**Problem:** Kalshi bridge still using wrong API  
**Solution:** Verify preload.js is using `contextBridge.exposeInMainWorld('electron', ...)`

### "Ankr BSC RPC empty" appears but nothing happens
**Problem:** Fallback isn't being invoked  
**Solution:** Check runRoute() function in chain-router.js - confirm it catches error and tries next handler

### Stale cache always shown for BNB
**Problem:** All three handlers failing consistently  
**Solution:** Check Network tab - verify Ankr, BSCScan, and Blockscout endpoints are reachable

### Gecko rate limit errors but no message
**Problem:** 429 detection not working  
**Solution:** Verify fetchGeckoJSON throws error with "Gecko 429" text included

---

## Expected Behavior After Fix

### Normal Operation
```
[Kalshi] Renderer bridge loaded. Use window.Kalshi.*
[Kalshi] Balance: $10,234.56
[ChainRouter] BTC from mempool.space OK
[ChainRouter] ETH from Blockscout OK
[ChainRouter] BNB from Ankr RPC OK
[Predictions] runAll: 7 coins analyzed, 2 trades signaled
```

### Graceful Degradation (One Source Down)
```
[ChainRouter] BNB handler failed: Ankr BSC RPC empty
[ChainRouter] BNB handler succeeded from BSCScan
[ChainRouter] BNB data: stale=false, source='BSCScan'
```

### Complete Fallback Chain
```
[ChainRouter] BNB handler failed: Ankr BSC RPC empty
[ChainRouter] BNB handler failed: BSCScan proxy empty
[ChainRouter] BNB handler succeeded from Blockscout
[ChainRouter] BNB data: stale=false, source='Blockscout'
```

### Rate Limit Handling
```
[Gecko] market_chart failed for bitcoin: Gecko 429
[Gecko] Rate limited (429) for bitcoin, skipping candles fallback
[Predictions] Bitcoin using 1h data from Binance (Gecko failed)
```

---

## Known Limitations (Not in Scope)

⚠️ These are existing limitations, not introduced by these fixes:
- No retry with exponential backoff (fixed 1.5s flat backoff)
- No distributed proxy (single IP still rate-limited on CoinGecko)
- No local cache of historical data (fetches fresh each time)
- BTC uses only mempool.space (blockchain.info deprecated)

---

## Support & Questions

If any test fails:
1. Check browser console for full error stack
2. Check Network tab to see actual API responses
3. Verify endpoint URLs are correct
4. Check if endpoints are geo-blocked or rate-limited
5. Review logs in app's dev console with `[ComponentName]` prefix

All fixes maintain backward compatibility - if you're not seeing errors, they're working correctly!
