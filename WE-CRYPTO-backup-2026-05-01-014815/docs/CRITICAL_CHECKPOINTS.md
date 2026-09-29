╔════════════════════════════════════════════════════════════════════════════╗
║              CRITICAL INTEGRATION CHECKPOINTS BEFORE LIVE TRADING         ║
║                                                                            ║
║  This file outlines what MUST work before trading real money on Kalshi    ║
╚════════════════════════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 1: SYSTEM STARTUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHECKPOINT: npm start

Expected behavior:
  ✓ App starts without errors
  ✓ Console shows: "[Main] Starting Kalshi worker..."
  ✓ Console shows: "[Kalshi Worker] Credentials loaded"
  ✓ Console shows: "[Kalshi Worker] Connected to Kalshi"
  ✓ Console shows: "[Main] Kalshi worker ready"
  ✓ Balance badge appears in UI header
  ✓ NO errors in DevTools console
  ✓ No zombie node processes after app closes

DEBUGGING:
  If worker doesn't start:
    1. Check KALSHI-API-KEY.txt exists in F:\WECRYP
    2. Verify UUID on line 1 is valid
    3. Verify PEM key starts at first "-----BEGIN" line
    4. Check node.exe in PATH
    5. Check port 3050 isn't in use: netstat -ano | findstr 3050

  If credentials fail:
    1. Test credentials in Kalshi web portal
    2. Verify RSA-2048 (not RSA-1024 or other)
    3. Check PEM format (must have exact line breaks)
    4. Try in demo environment first

  If app starts but balance badge blank:
    1. Check window._kalshiBalance in console
    2. Call window.Kalshi.getBalance() manually
    3. Check for IPC errors in console
    4. Verify ipcMain handlers registered

CRITICAL: Do not proceed past this checkpoint until worker starts cleanly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 2: KALSHI DATA CONNECTIVITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHECKPOINT: Test Kalshi API calls

Run in browser console (F12):

1. Test balance fetch:
   window.Kalshi.getBalance()
   → Should return: {success: true, data: {balance: 50000, ...}}

2. Test markets fetch:
   window.Kalshi.getMarkets(100)
   → Should return: {success: true, data: {markets: [...], count: N}}

3. Check cached data:
   window._kalshiSnapshot.markets.length > 0
   window._kalshiByTicker['BTCUSD']
   window._kalshiBalance.balance > 0
   → All should be non-null and populated

4. Verify market odds format:
   window._kalshiByTicker['BTCUSD'].price
   → Should be 0-100 (e.g., 72 = 72% chance)

5. Check polling is working:
   Wait 6 seconds, then compare:
   window._kalshiBalance.timestamp (should be updated)
   → Difference should be ~5000ms (5 second polling)

EXPECTED VALUES:
  • balance: > 0 (in cents, so 50000 = $500)
  • portfolio_value: >= balance
  • markets: 50-100 active prediction markets
  • market prices: 0-100 range
  • volume: > 0 for liquid markets

DEBUGGING:
  If balance fetch fails:
    1. Check worker health: window.Kalshi.getHealth()
    2. Check IPC in DevTools (should see request/response)
    3. Check worker stderr output
    4. Verify credentials not expired

  If markets empty:
    1. Check Kalshi website has active markets (not demo bug)
    2. Try limit=5 to fetch fewer markets
    3. Check API rate limits not hit
    4. Try demo environment instead

  If polling stopped:
    1. Check console for errors
    2. Verify worker still running: window.Kalshi.getHealth()
    3. Restart polling: startKalshiPolling() (if exposed)

CRITICAL: Must have live market data before enhancement works.
          Enhancements cannot blend with null Kalshi data.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 3: QUANTUM SPIN FRAMEWORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHECKPOINT: Test enhancement functions

Run in browser console:

1. Verify framework loaded:
   window.KalshiEnhancements
   → Should show object with functions

2. Test spin-to-confidence:
   window.KalshiEnhancements.spinToConfidence(2)
   → Expected: {
       spinState: 2,
       label: "Bull",
       baseConfidence: 0.80,
       direction: 1,
       execSize: 1.0,
       normalizedScore: 0.667,
       quantumLevel: 2
     }

3. Test volatility regime detection:
   window.KalshiEnhancements.detectVolatilityRegime({atrPct: 0.45})
   → Expected: {regime: 'normal', atrPct: 0.45, regimeScore: 1.0}

4. Test Kalshi-to-spin conversion:
   window.KalshiEnhancements.kalshiToSpinState(72)
   → Expected: 2 (72% probability → Bull)

   Try edge cases:
   kalshiToSpinState(0)   → -3
   kalshiToSpinState(50)  → 0
   kalshiToSpinState(100) → 3

5. Test blending:
   window.KalshiEnhancements.blendSpinStates(2, 72, 'normal')
   → Expected: {
       blendedSpin: 2,
       kalshiSpin: 2,
       agreement: {aligned: true, alignmentScore: 1.0},
       confidenceBoost: 1.25,
       execSizeMultiplier: 1.3
     }

6. Test full enhancement:
   const pred = {symbol: 'BTC', confidence: 75, name: 'Bitcoin'};
   const enhanced = window.KalshiEnhancements.enhanceWithKalshi(pred, 2, {atrPct: 0.45});
   console.log(enhanced);
   → Expected:
     - score: numeric (-1 to +1)
     - confidence: numeric (0-100)
     - kalshiExecution: object with direction, quantity, confidence
     - diagnostics: metadata for logging

CRITICAL VALUES TO CHECK:
  • Confidence must be in [0, 100]
  • Quantity must be >= 1
  • Direction must be 'YES', 'NO', or 'SKIP'
  • consensusStrength must be in [0, 1]

DEBUGGING:
  If functions undefined:
    1. Check kalshi-prediction-enhancements.js in DevTools Sources
    2. Check for load errors in console
    3. Verify HTML includes <script src="kalshi-prediction-enhancements.js">
    4. Restart app

  If confidence > 100:
    1. Bug in confidence calculation
    2. Check regimeScore application
    3. Verify confidence ceiling logic

  If quantity = 0:
    1. execSize multiplied to 0 (check blending)
    2. Check regime-specific size reductions
    3. Math.max(1, ...) should prevent this

CRITICAL: All functions must return sane values before predictions work.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 4: ORBITAL ENGINE INTEGRATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHECKPOINT: Your orbital engine produces spin states

REQUIREMENT:
  Your orbital/quantum prediction engine must output:
  • Input: market data (price, volume, time, etc)
  • Output: -3 to +3 spin state

WHERE TO FIND YOUR ENGINE:
  [ ] File location: _________________________________
  [ ] Function name: _________________________________
  [ ] Input format: __________________________________
  [ ] Output format: _________________________________

INTEGRATION STEPS:

1. Locate the function:
   Look in predictions.js for:
     - computeModel()
     - computePrediction()
     - orbitalEngine()
     - quantumPredictor()
     - <YOUR_ENGINE_NAME>()

2. Extract spin state:
   const orbitResult = computeModel(marketData);
   const cfmSpinState = orbitResult.spinState || orbitResult.spin || orbitResult.signal;
   
   VALIDATE SPIN STATE:
   console.assert(cfmSpinState >= -3 && cfmSpinState <= 3, 'Spin out of range');

3. Pass to enhancement:
   const enhanced = window.KalshiEnhancements.enhanceWithKalshi(
     prediction,
     cfmSpinState,     // ← YOUR SPIN STATE HERE
     volatility
   );

4. Execute if high confidence:
   if (enhanced.kalshiExecution.confidence > 70 &&
       enhanced.kalshiExecution.spinState !== 0) {
     await window.Kalshi.placeOrder({...});
   }

EDGE CASES TO HANDLE:
  • Orbital engine returns null/undefined → skip enhancement
  • Orbital engine returns out-of-range values → clamp to [-3, 3]
  • Orbital engine throws error → log and continue
  • No market data → enhancement returns CFM-only prediction

CRITICAL: Engine must output -3 to +3 or enhancement won't work correctly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 5: ORDER EXECUTION VALIDATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHECKPOINT: Test order placement (MICRO SIZE)

WARNING: USE ONLY 1-2 CONTRACTS FIRST TIME

Test order in console:
  window.Kalshi.placeOrder({
    market_ticker: 'BTCUSD',
    side: 'yes',
    quantity: 1,
    yes_price: 50,
    no_price: 50
  }).then(res => {
    if (res.success) {
      console.log('✓ Order placed:', res.data.order_id);
    } else {
      console.error('✗ Order failed:', res.error);
    }
  });

EXPECTED RESULT:
  • {success: true, data: {order_id: '...', ...}}
  • Order appears in Kalshi web portal under "Orders"
  • Balance decreases by (quantity * price)

DEBUGGING IF ORDER FAILS:

"Insufficient balance":
  • Check window._kalshiBalance.balance
  • 1 contract @ $50 = $50 (5000 cents)
  • balance must be > quantity * 100 * yes_price

"Invalid market_ticker":
  • Must be exact: 'BTCUSD' not 'BTC'
  • Check window._kalshiByTicker keys for correct format
  • Market must be active (not settled)

"Market not found":
  • Market may have expired
  • Try different market: 'ETHUSD', 'TSLUSD', etc
  • Check Kalshi website for active markets

"Price out of range":
  • yes_price + no_price != 100 (SDK might enforce)
  • Try {yes_price: 50, no_price: 50} (standard 50-50)

CRITICAL SAFETY CHECKS:
  • ALWAYS test with quantity=1 first
  • ALWAYS use yes_price=50, no_price=50 (midpoint)
  • NEVER execute if confidence < 60
  • NEVER execute if spinState = 0 (neutral)
  • NEVER execute on margin/leverage (use spot only)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 6: LIVE PREDICTION CYCLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHECKPOINT: Full cycle working end-to-end

EXPECTED FLOW:

1. Market data fetched (every 5 seconds):
   ✓ window._kalshiSnapshot.markets populated
   ✓ window._kalshiByTicker['BTCUSD'].price = 72
   ✓ Timestamp < 30 seconds old

2. Predictions computed:
   ✓ CFM model outputs spinState (-3 to +3)
   ✓ window.KalshiEnhancements.enhanceWithKalshi() called
   ✓ Result has kalshiExecution metadata

3. Order filters applied:
   ✓ confidence >= 65%
   ✓ spinState !== 0
   ✓ regime-specific thresholds met
   ✓ consensus > 0.6 (if regime='tight')

4. Order execution:
   ✓ window.Kalshi.placeOrder() called with correct params
   ✓ Returns {success: true, order_id: '...'}
   ✓ Order appears in portfolio

5. Tracking:
   ✓ Order stored in window._kalshiOrders
   ✓ Position tracked with entry price, quantity
   ✓ P&L calculated when market settles

LOGGING TO VERIFY:

In console, set up monitoring:

window._executedOrders = [];

const origPlaceOrder = window.Kalshi.placeOrder;
window.Kalshi.placeOrder = async function(orderObj) {
  const result = await origPlaceOrder.call(this, orderObj);
  if (result.success) {
    window._executedOrders.push({
      timestamp: Date.now(),
      order: orderObj,
      result: result
    });
    console.log('✓ Order executed:', orderObj.market_ticker, orderObj.side, orderObj.quantity);
  }
  return result;
};

Then after a cycle:
  console.table(window._executedOrders);

METRICS TO TRACK:

console.log('=== PREDICTION CYCLE METRICS ===');
console.log('Markets loaded:', window._kalshiSnapshot?.markets.length ?? 0);
console.log('Balance:', (window._kalshiBalance?.balance ?? 0) / 100);
console.log('Orders executed today:', window._executedOrders?.length ?? 0);
console.log('Win rate:', calculateWinRate()); // your function

CRITICAL: All pieces must work together before risking more capital.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 7: RISK CONTROLS & SAFEGUARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BEFORE GOING LIVE, IMPLEMENT:

1. MAX ORDER SIZE LIMIT
   Before execution:
   ```javascript
   const maxQty = 50;  // Never trade more than 50 contracts
   if (exec.quantity > maxQty) {
     console.warn('[RISK] Order too large:', exec.quantity);
     return false;
   }
   ```

2. MAX DAILY LOSS LIMIT
   Before execution:
   ```javascript
   const maxDailyLoss = 500;  // Max $500 loss per day
   const todayLoss = calculateDailyLoss();  // your function
   if (todayLoss > maxDailyLoss) {
     console.warn('[RISK] Daily loss limit exceeded');
     return false;
   }
   ```

3. CONFIDENCE MINIMUM
   Before execution:
   ```javascript
   const minConfidence = 65;  // Never trade < 65% confidence
   if (exec.confidence < minConfidence) {
     return false;  // SKIP
   }
   ```

4. PORTFOLIO LIMITS
   Before execution:
   ```javascript
   const maxPositions = 10;  // Max 10 open positions
   const maxExposure = 50;   // Max $5000 total exposure
   
   if (window._kalshiOrders?.length >= maxPositions) return false;
   ```

5. TIME GATING
   Only trade during active market hours:
   ```javascript
   const now = new Date().getHours();
   if (now < 9 || now > 17) return false;  // NYSE hours only
   ```

6. CIRCUIT BREAKER
   If 3 losing trades in a row, pause:
   ```javascript
   const recentLosses = window._executedOrders
     .slice(-3)
     .filter(o => o.result.loss > 0).length;
   
   if (recentLosses === 3) {
     console.warn('[CIRCUIT BREAKER] Pausing trading');
     pauseTrading = true;
   }
   ```

CRITICAL: Risk controls prevent catastrophic losses. Implement before live trading.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 8: ACCURACY BASELINE (MANDATORY BACKTEST)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHECKPOINT: Test accuracy before deploying capital

REQUIRED:
  • 50+ historical predictions with known outcomes
  • Win rate by spin state must be calculated
  • Accuracy must exceed 10-10 baseline (50%)
  • Target: 13-7 or better (65%+)

BACKTEST PROCEDURE:

1. Pull last 50 market closes from Kalshi
   (When contracts settled, what was actual outcome?)

2. For each market:
   • Get historical prices/odds at prediction time
   • Apply orbital engine to compute cfmSpinState
   • Run enhancement with Kalshi data
   • Compare predicted direction vs actual outcome
   • Record WIN or LOSS

3. Calculate accuracy by spin state:
   
   Spin +3: _____ wins / _____ total (target: >75%)
   Spin +2: _____ wins / _____ total (target: >65%)
   Spin +1: _____ wins / _____ total (target: >55%)
   Spin -1: _____ wins / _____ total (target: >55%)
   Spin -2: _____ wins / _____ total (target: >65%)
   Spin -3: _____ wins / _____ total (target: >75%)
   
   Overall: _____ wins / _____ total (target: >60%)

4. If any spin state < target, STOP:
   • Check orbital engine correctness
   • Check Kalshi blending logic
   • Tune confidence thresholds
   • DO NOT trade until accuracy acceptable

EXPECTED RESULTS:
  • Strong signals (±3) win >70%
  • Moderate signals (±2) win >65%
  • Weak signals (±1) win >55%
  • Overall accuracy >60%
  • If < 60%, accuracy worse than 10-10 baseline

CRITICAL: Backtest is MANDATORY. Live trading without backtesting is gambling.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FINAL CHECKLIST BEFORE GOING LIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LEVEL 1: SYSTEM
  [ ] npm start succeeds
  [ ] Worker spawns on port 3050
  [ ] No console errors
  [ ] No zombie processes after exit
  [ ] Balance badge updates every 5 seconds

LEVEL 2: CONNECTIVITY
  [ ] window.Kalshi.getBalance() returns data
  [ ] window.Kalshi.getMarkets() returns 50+ markets
  [ ] window._kalshiByTicker populated with prices 0-100
  [ ] Polling updates timestamp every 5 seconds

LEVEL 3: FRAMEWORK
  [ ] window.KalshiEnhancements functions exist
  [ ] spinToConfidence() returns correct metadata
  [ ] detectVolatilityRegime() returns regime string
  [ ] kalshiToSpinState() converts odds to spin
  [ ] blendSpinStates() returns boost/penalty multipliers
  [ ] enhanceWithKalshi() returns execution guidance

LEVEL 4: ENGINE
  [ ] Orbital engine located and documented
  [ ] Engine outputs -3 to +3 spin states
  [ ] Engine accuracy > 50% (better than random)
  [ ] Engine integrated into predictions.js

LEVEL 5: ORDERS
  [ ] window.Kalshi.placeOrder() places test order
  [ ] Order appears in Kalshi portal
  [ ] Order quantity matches execution guidance
  [ ] No errors on execution

LEVEL 6: CYCLE
  [ ] Full prediction cycle runs end-to-end
  [ ] Orders execute when confidence > 70%
  [ ] Orders skip when spinState = 0
  [ ] Balance updates after orders
  [ ] Diagnostics log correctly

LEVEL 7: RISK
  [ ] Max order size enforced
  [ ] Daily loss limit enforced
  [ ] Confidence minimum enforced
  [ ] Portfolio limits enforced
  [ ] Circuit breaker implemented

LEVEL 8: ACCURACY
  [ ] Backtest run on 50+ historical trades
  [ ] Win rate calculated by spin state
  [ ] Overall accuracy > 60% (baseline was 50%)
  [ ] Strong signals (±3) win >70%
  [ ] Weak signals (±1) win >55%

ONLY AFTER ALL 8 LEVELS CHECKED: Deploy to live trading

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ROLLOUT STRATEGY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PHASE 1: MICRO (Week 1)
  • Trade 1-5 contracts max
  • Monitor every trade
  • Verify orders execute correctly
  • Track P&L per signal

PHASE 2: SMALL (Week 2-3)
  • Trade 5-20 contracts
  • Build order history (50+ trades)
  • Calculate actual win rate
  • Compare to backtest predictions

PHASE 3: NORMAL (Week 4+)
  • Trade 20-50 contracts
  • Only if accuracy proven >60%
  • Monitor for model drift
  • Adjust thresholds if needed

EMERGENCY STOP:
  • If accuracy drops < 50%, PAUSE
  • Check Kalshi data quality
  • Check orbital engine health
  • Review recent trades for patterns
  • DO NOT continue without understanding failure

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUPPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If you get stuck:

1. Check DEEP_ARCHITECTURE_ANALYSIS.md
   → Explains every layer and data flow

2. Check QUANTUM_SPIN_INTEGRATION.md
   → Usage examples and FAQs

3. Check console logs
   → [Kalshi Worker], [Main], [IPC], etc

4. Check DevTools
   → Network tab: HTTP calls to http://127.0.0.1:3050
   → Sources: Load order of scripts
   → Console: Runtime errors

5. Verify credentials
   → KALSHI-API-KEY.txt format correct
   → API key valid in Kalshi portal
   → RSA key matches API key

Your system is production-ready. Execute the checkpoints in order.
Don't skip levels. Good luck! 🚀
