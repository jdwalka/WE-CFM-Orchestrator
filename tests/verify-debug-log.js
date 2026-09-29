/**
 * ================================================================
 * Market Debug Log Verification Script
 *
 * Run this in console to verify the debug log is capturing data
 * ================================================================
 */

console.log(`
╔════════════════════════════════════════════════════════════════╗
║         MARKET DEBUG LOG VERIFICATION                          ║
╚════════════════════════════════════════════════════════════════╝
`);

// Check 1: Is the debug panel HTML present?
const debugPanel = document.getElementById('market-debug-panel');
console.log(`\n✓ Debug Panel HTML:`, debugPanel ? '✅ FOUND' : '❌ NOT FOUND');

// Check 2: Is data being captured?
console.log(`\n✓ Data Capture Status:`);
console.log(`  • _marketSettlementLog entries: ${(window._marketSettlementLog || []).length}`);
console.log(`  • _15mResolutionLog entries:  ${(window._15mResolutionLog || []).length}`);
console.log(`  • _kalshiErrors entries:      ${(window._kalshiErrors || []).length}`);
console.log(`  • _orchLog entries:           ${(window._orchLog || []).length}`);

// Check 3: Is the debug API available?
console.log(`\n✓ Debug API Status:`);
console.log(`  • window.MarketDebug:         ${window.MarketDebug ? '✅ AVAILABLE' : '❌ NOT LOADED'}`);
console.log(`  • window.MarketResolver:      ${window.MarketResolver ? '✅ AVAILABLE' : '❌ NOT LOADED'}`);

// Check 4: Scorecard-specific data
console.log(`\n✓ Accuracy Scorecard Data:`);
const marketSettled = (window._marketSettlementLog || []).filter(e => e._settled).length;
const resLogWithModel = (window._15mResolutionLog || []).filter(e => e.modelCorrect !== null).length;
const totalForScorecard = marketSettled + resLogWithModel;
console.log(`  • Settled market contracts:   ${marketSettled}`);
console.log(`  • Resolution log (with model): ${resLogWithModel}`);
console.log(`  • Total for scorecard:        ${totalForScorecard}`);

if (totalForScorecard === 0) {
  console.log(`  ⚠️  No settled contracts yet — scorecard will populate after first settlement`);
} else {
  console.log(`  ✅ Scorecard will display accuracy data`);
}

// Check 5: Test the debug commands
console.log(`\n✓ Test Commands (paste in console):`);
console.log(`
  MarketDebug.summary()                 — Accuracy summary
  MarketDebug.audit('BTC')              — BTC contract audit trail
  MarketDebug.pending()                 — Pending settlements
  MarketDebug.errors()                  — Recent errors
  PolymarketAccuracyDebug.scorecard('BTC')  — BTC accuracy %
  PolymarketAccuracyDebug.healthCheck()     — Data capture status
  PolymarketAccuracyDebug.findInversions()  — Find wrong predictions
`);

// Check 6: Panel rendering
console.log(`\n✓ Panel Rendering:`);
if (debugPanel) {
  const tables = debugPanel.querySelectorAll('table');
  console.log(`  • Tables in panel:   ${tables.length} (should be 7)`);
  console.log(`  • Panel open:        ${debugPanel.open ? '✅ YES' : '❌ NO (click to expand)'}`);
} else {
  console.log(`  ❌ Panel not in DOM — check if app.js buildMarketDebugPanel() is running`);
}

console.log(`
════════════════════════════════════════════════════════════════

📊 SUMMARY:
${totalForScorecard > 0 ? '✅ Debug log is WORKING — data being captured' : '⏳ Waiting for first contract to settle'}

Next:
${debugPanel ? '1. Click "🔬 POLYMARKET CONTRACT DEBUG" to expand panel\n2. Look for "▸ ACCURACY SCORECARD" section' : '1. Refresh the page\n2. Check browser console for errors'}
`);

// Auto-try to run summary if available
console.log('\n📋 Running summary...\n');
if (window.MarketDebug?.summary) {
  window.MarketDebug.summary();
} else {
  console.log('⏳ MarketDebug not ready yet');
}
