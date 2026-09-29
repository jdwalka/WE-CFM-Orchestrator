/**
 * INTEGRATION: How to wire kalshi-sustenance-filter.js + kalshi-entry-logic.js into app.js
 * 
 * Replace the old ionization shell model with:
 * 1. CFM monitoring (you already have this)
 * 2. Sustenance tracking (new: detects reversals)
 * 3. Entry decision (new: CFM edge + sustenance only)
 */

// ============================================================================
// IN: app.js polling loop (or floating-orchestrator.js)
// ============================================================================

// 1. Load the new modules (add to HTML or app.js imports)
// <script src="kalshi-sustenance-filter.js"></script>
// <script src="kalshi-entry-logic.js"></script>

/**
 * When contract opens: START tracking
 */
function onContractOpened(contract) {
  const marketId = contract.marketId;
  const ticker = contract.ticker; // KXBTC15M-26APR260630-30
  
  // Get current CFM price
  const cfmData = window._cfm[ticker.slice(0, 7)]; // Extract KXBTC from full ticker
  if (!cfmData) return; // No CFM data yet
  
  // Get current Kalshi market odds
  const kalshiOdds = contract.currentOdds; // 0-100
  
  // Analyze divergence
  const signal = window.KalshiEntryLogic.analyzeDivergence(
    { price: cfmData.cfmRate },
    { odds: kalshiOdds }
  );
  
  // Only start tracking if there's a real divergence
  if (signal.shouldWatch) {
    console.log(`[Entry] Contract ${ticker} opened: CFM=${signal.cfm}, Kalshi=${signal.kalshi}, edge=${signal.edge.toFixed(2)}¢`);
    
    window.KalshiSustenance.initTracker(
      marketId,
      signal.cfm,
      signal.kalshi,
      signal.direction,
      signal.edge
    );
  }
}

/**
 * Every 15 seconds: UPDATE tracker with current price
 */
function onPollingCycle(timestamp) {
  const activeTrackers = window.KalshiSustenance.getAllTrackers();
  
  for (const marketId in activeTrackers) {
    const tracker = activeTrackers[marketId];
    const contract = getContractById(marketId); // Helper to find contract
    
    if (!contract) continue;
    
    // Current market odds
    const currentOdds = contract.currentOdds;
    
    // Time elapsed since contract opening
    const elapsedSeconds = (Date.now() - tracker.createdAt) / 1000;
    
    // Update sustenance filter
    window.KalshiSustenance.updateSample(
      marketId,
      currentOdds,
      elapsedSeconds
    );
    
    // Get current recommendation
    const recommendation = window.KalshiSustenance.getRecommendation(
      marketId,
      elapsedSeconds
    );
    
    // Make entry decision
    const signal = window.KalshiEntryLogic.analyzeDivergence(
      { price: tracker.cfmPrice },
      { odds: currentOdds }
    );
    
    const decision = window.KalshiEntryLogic.makeEntryDecision(
      signal,
      recommendation
    );
    
    // Handle decision
    if (decision.trade === true) {
      // ✅ EXECUTE
      console.log(`[✅ EXECUTE] ${contract.ticker}: direction=${decision.direction}, quantity=${decision.action.quantity}, confidence=${decision.finalConfidence}%`);
      
      executeKalshiOrder(
        marketId,
        decision.direction,
        decision.action.quantity,
        decision.finalConfidence
      );
      
      // Clean up tracker
      window.KalshiSustenance.cleanup(marketId);
      
    } else if (decision.trade === false) {
      // ❌ REJECT
      console.log(`[❌ REJECT] ${contract.ticker}: ${decision.reason}`);
      
      // Log reversal for circuit breaker
      if (decision.reason.includes('reversal')) {
        window.KalshiEntryLogic.onReversalDetected();
      }
      
      // Clean up tracker
      window.KalshiSustenance.cleanup(marketId);
      
    } else if (decision.trade === null) {
      // ⏳ PENDING — still collecting data
      // Do nothing, wait for next cycle
      
      // UI logging (verbose)
      if (elapsedSeconds % 30 === 0) {
        console.log(`[⏳ PENDING] ${contract.ticker}: ${decision.reason} (${elapsedSeconds}s, ${decision.directionMoveCount} up, ${decision.reversalMoveCount} down)`);
      }
    }
  }
}

/**
 * When contract expires: CLEANUP
 */
function onContractExpired(marketId) {
  window.KalshiSustenance.cleanup(marketId);
}

// ============================================================================
// EXAMPLE: Complete polling cycle
// ============================================================================

async function pollKalshiWithNewLogic() {
  // 1. Get open markets
  const markets = await fetchOpenKalshiMarkets();
  
  // 2. Get CFM rates (already polling this)
  const cfmData = window._cfm;
  
  // 3. For each market: init tracker if new
  for (const market of markets) {
    if (!window.KalshiSustenance.getAllTrackers()[market.marketId]) {
      onContractOpened(market);
    }
  }
  
  // 4. Update all active trackers
  onPollingCycle(Date.now());
  
  // 5. Check circuit breakers
  if (!window.KalshiEntryLogic.canTrade()) {
    console.warn('[Circuit Breaker] Trading paused — too many reversals');
    return;
  }
  
  // 6. Schedule next cycle (15-30 seconds)
  setTimeout(() => pollKalshiWithNewLogic(), 30000);
}

// ============================================================================
// REPLACE OLD IONIZATION SHELL CALLS with above
// ============================================================================

// OLD (remove):
// const spinState = window.KalshiEnhancements.spinToConfidence(prediction.score);
// const enhanced = window.KalshiEnhancements.enhancePredictionFromSpinState(...);

// NEW (add):
// const signal = window.KalshiEntryLogic.analyzeDivergence(cfmData, kalshiData);
// const decision = window.KalshiEntryLogic.makeEntryDecision(signal, recommendation);

// ============================================================================
// UI DIAGNOSTIC PANEL (for debugging)
// ============================================================================

function renderSustenanceStatus() {
  const trackers = window.KalshiSustenance.getAllTrackers();
  
  let html = `
    <div style="background: #1a1a1a; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 11px;">
      <div style="color: #4caf50; font-weight: bold; margin-bottom: 8px;">
        Active Trackers: ${Object.keys(trackers).length}
      </div>
  `;
  
  for (const marketId in trackers) {
    const t = trackers[marketId];
    const decision = window.KalshiEntryLogic.makeEntryDecision(
      window.KalshiEntryLogic.analyzeDivergence(
        { price: t.cfmPrice },
        { odds: t.samples[t.samples.length - 1].price }
      ),
      window.KalshiSustenance.getRecommendation(marketId, (Date.now() - t.createdAt) / 1000)
    );
    
    const stateColor = {
      'sustained': '#4caf50',
      'weakening': '#ffc107',
      'reversed': '#f44336',
      'init': '#2196f3'
    }[t.state] || '#fff';
    
    html += `
      <div style="margin: 8px 0; padding: 6px; background: rgba(255,255,255,0.05); border-left: 3px solid ${stateColor};">
        <div>${t.marketId.slice(0, 12)}...</div>
        <div style="color: #aaa; font-size: 10px;">
          State: <span style="color: ${stateColor};">${t.state}</span>
          Edge: ${(t.edge * 100).toFixed(1)}¢
          Move: ${t.directionMoveCount} up, ${t.reversalMoveCount} down
          Decision: ${decision.trade === true ? '✅ EXEC' : decision.trade === false ? '❌ SKIP' : '⏳ PENDING'}
        </div>
      </div>
    `;
  }
  
  html += `</div>`;
  return html;
}

// ============================================================================
// RISK STATE (monitor circuit breakers)
// ============================================================================

function renderRiskState() {
  const rs = window.KalshiEntryLogic.riskState;
  const canTrade = window.KalshiEntryLogic.canTrade();
  
  return `
    <div style="background: ${canTrade ? '#1a1a1a' : '#5f2c2c'}; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 11px;">
      <div style="color: ${canTrade ? '#4caf50' : '#f44336'}; font-weight: bold;">
        Trading: ${canTrade ? '✅ ACTIVE' : '❌ PAUSED'}
      </div>
      <div style="color: #aaa; font-size: 10px; margin-top: 4px;">
        Reversals (30min): ${rs.reversalCount}/3
        ${rs.shouldPause ? `Pause until: ${new Date(rs.pauseUntil).toLocaleTimeString()}` : 'No pause active'}
      </div>
    </div>
  `;
}
