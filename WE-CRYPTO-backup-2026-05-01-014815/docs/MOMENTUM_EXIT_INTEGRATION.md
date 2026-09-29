/**
 * Complete Trading Loop Integration
 * 
 * Shell Entry + PYTH Momentum Exit
 * 
 * 1. Entry: Shell ±2+ signals with CFM divergence
 * 2. Monitoring: PYTH samples every 15 sec
 * 3. Exit: Momentum break detected, auto-exit
 */

// ============================================================================
// COMPLETE WORKFLOW
// ============================================================================

/**
 * STEP 1: Shell signal detected, execute trade
 */
async function onShellSignal(coin, marketId, direction, shellState, confidence, kalshiOdds) {
  console.log(`[Shell Signal] ${coin} ${direction} @ Shell${shellState}, Conf=${confidence}%, Odds=${kalshiOdds}¢`);
  
  // Enter position
  const order = await executeKalshiOrder(marketId, direction, 1, confidence);
  if (!order) return;
  
  // Initialize momentum tracker
  const cfmPrice = window._cfm[coin]?.cfmRate || 50; // Get CFM price
  window.PYTHMomentumExit.initPosition(
    marketId,
    kalshiOdds,  // Entry odds (proxy for price)
    direction,
    1,           // quantity
    confidence
  );
  
  console.log(`[Entered] Position initialized for momentum tracking`);
}

/**
 * STEP 2: Every 15 seconds, update PYTH samples
 */
async function onPYTHSample(pythData) {
  // Get all coins' PYTH prices
  const prices = {
    BTC: pythData.prices?.bitcoin,
    ETH: pythData.prices?.ethereum,
    SOL: pythData.prices?.solana,
    XRP: pythData.prices?.ripple,
    BNB: pythData.prices?.binance,
    DOGE: pythData.prices?.dogecoin,
    HYPE: pythData.prices?.hyperliquid
  };
  
  // Update all active positions
  const activePositions = window.PYTHMomentumExit.getAllPositions();
  
  for (const marketId in activePositions) {
    const pos = activePositions[marketId];
    const coin = marketId.substring(2, 5); // Extract KXBTC → BTC
    const currentPrice = prices[coin];
    
    if (currentPrice === undefined) continue;
    
    // Update momentum tracker
    window.PYTHMomentumExit.updateMomentum(marketId, currentPrice);
    
    // Check if exit signal triggered
    if (window.PYTHMomentumExit.shouldExit(marketId)) {
      console.log(`[Exit Signal] ${marketId} momentum break detected`);
      
      // Execute market exit
      const exitResult = await exitKalshiPosition(marketId);
      
      // Log exit
      const posResult = window.PYTHMomentumExit.exitPosition(marketId);
      logTradeResult(posResult);
    }
  }
}

/**
 * STEP 3: Exit handler
 */
async function exitKalshiPosition(marketId) {
  // Get current market odds
  const market = await getKalshiMarket(marketId);
  const currentOdds = market.last_trade_price;
  
  // Determine direction (YES/NO)
  const pos = window.PYTHMomentumExit.getPosition(marketId);
  const sellDirection = pos.direction === 'YES' ? 'NO' : 'YES'; // Sell to close
  
  // Place exit order (market sell)
  const order = await executeKalshiOrder(
    marketId,
    sellDirection,
    pos.quantity,
    100  // Market order (any price)
  );
  
  return order;
}

/**
 * STEP 4: Log results
 */
function logTradeResult(posResult) {
  const status = posResult.success ? '✅' : '❌';
  console.log(`
    ${status} ${posResult.marketId}
    Direction: ${posResult.direction}
    Entry: ${posResult.entryPrice}¢ → Exit: ${posResult.exitPrice}¢
    Reason: ${posResult.exitReason}
    P&L: ${posResult.profitPercentage.toFixed(2)}%
    Elapsed: ${posResult.elapsedSeconds.toFixed(1)}s (${posResult.samples} samples)
  `);
  
  // Send to analytics/dashboard
  window.TradeLog = window.TradeLog || [];
  window.TradeLog.push({
    timestamp: Date.now(),
    ...posResult
  });
}

// ============================================================================
// INTEGRATION WITH EXISTING POLLING LOOP
// ============================================================================

/**
 * Modify your existing polling cycle to include PYTH momentum updates
 */

// OLD:
// async function pollKalshiCycle() {
//   const markets = await fetchOpenKalshiMarkets();
//   // ... existing logic
// }

// NEW:
async function pollKalshiWithMomentumExit() {
  // 1. Get new shell signals (existing logic)
  const markets = await fetchOpenKalshiMarkets();
  const cfmData = window._cfm;
  
  for (const market of markets) {
    const shellSignal = generateShellSignal(market);
    if (shellSignal && shellSignal.trade) {
      onShellSignal(
        shellSignal.coin,
        market.marketId,
        shellSignal.direction,
        shellSignal.shellState,
        shellSignal.confidence,
        market.last_trade_price
      );
    }
  }
  
  // 2. Get PYTH data (every 15 sec)
  const pythData = await getPYTHPrices();
  onPYTHSample(pythData);
  
  // 3. Log active positions (UI diagnostics)
  const statusHTML = window.PYTHMomentumExit.getStatusHTML();
  updatePositionMonitorPanel(statusHTML);
  
  // 4. Next cycle in 15 sec
  setTimeout(() => pollKalshiWithMomentumExit(), 15000);
}

// ============================================================================
// UI DASHBOARD PANEL
// ============================================================================

function renderMomentumDashboard() {
  const positions = window.PYTHMomentumExit.getAllPositions();
  const tradeLog = window.TradeLog || [];
  
  // Current positions
  let html = `
    <div style="background: #0a0a0a; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 11px;">
      <div style="color: #4caf50; font-weight: bold; margin-bottom: 12px;">
        🚀 MOMENTUM EXIT SYSTEM
      </div>
      
      <div style="margin-bottom: 12px;">
        <div style="color: #aaa; font-size: 10px; margin-bottom: 6px;">ACTIVE POSITIONS (${Object.keys(positions).length})</div>
        ${window.PYTHMomentumExit.getStatusHTML()}
      </div>
      
      <div style="border-top: 1px solid #333; padding-top: 12px;">
        <div style="color: #aaa; font-size: 10px; margin-bottom: 6px;">RECENT EXITS (${tradeLog.length})</div>
        ${tradeLog.slice(-5).map((t, i) => `
          <div style="font-size: 9px; margin: 4px 0; color: ${t.success ? '#4caf50' : '#f44336'};">
            ${i + 1}. ${t.marketId} ${t.exitReason}: ${t.profitPercentage.toFixed(1)}% (${t.elapsedSeconds.toFixed(1)}s)
          </div>
        `).join('')}
      </div>
      
      <div style="border-top: 1px solid #333; padding-top: 12px; margin-top: 12px;">
        <div style="color: #aaa; font-size: 10px;">Win Rate: ${tradeLog.filter(t => t.success).length}/${tradeLog.length} (${tradeLog.length > 0 ? (tradeLog.filter(t => t.success).length / tradeLog.length * 100).toFixed(0) : 0}%)</div>
        <div style="color: #aaa; font-size: 10px;">Avg Exit Time: ${tradeLog.length > 0 ? (tradeLog.reduce((a, t) => a + t.elapsedSeconds, 0) / tradeLog.length).toFixed(1) : 0}s</div>
        <div style="color: #aaa; font-size: 10px;">Avg P&L: ${tradeLog.length > 0 ? (tradeLog.reduce((a, t) => a + t.profitPercentage, 0) / tradeLog.length).toFixed(2) : 0}%</div>
      </div>
    </div>
  `;
  
  return html;
}

// ============================================================================
// KEY METRICS TO WATCH
// ============================================================================

/**
 * Success = Momentum break detected BEFORE reversal completes
 * 
 * Example sequence:
 * 
 * T+0s:   Entry @ 0.30¢ odds, Shell+2, 65% confidence
 * T+15s:  PYTH sample 1: +0.5% → momentum = +0.5
 * T+30s:  PYTH sample 2: +1.2% → momentum = +0.7 (accelerating)
 * T+45s:  PYTH sample 3: +1.8% → momentum = +0.8 (still strong)
 * T+60s:  PYTH sample 4: +1.5% → momentum = -0.3 (BREAK!) ← EXIT HERE
 * T+75s:  PYTH sample 5: +0.8% (reversing)
 * T+90s:  PYTH sample 6: -0.1% (fully reversed)
 * 
 * Without exit: Expiry at T+900s = LOSS
 * With exit at T+60s: +1.5-0.30 = +1.2¢ profit on 0.30¢ entry = +400% PROFIT
 */

// ============================================================================
// CONFIGURATION TUNING
// ============================================================================

/**
 * If exits are triggering too early (exiting winners prematurely):
 * → Increase momentum break threshold from -0.5 to -1.0
 * → Require 4 samples instead of 3
 * → Require profit > 2% instead of > 1%
 * 
 * If exits are triggering too late (missing reversals):
 * → Decrease momentum break threshold to -0.2
 * → Exit on acceleration drop (even if still positive momentum)
 * → Consider 3-sample momentum instead of recent trend
 * 
 * If exits are cutting too many winners:
 * → Only exit on momentum break if in small profit (<2%)
 * → Let big winners run until momentum reversal is confirmed (2 consecutive negative samples)
 */
