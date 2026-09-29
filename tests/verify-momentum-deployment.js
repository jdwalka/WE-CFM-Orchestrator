/**
 * Momentum Exit Deployment Verification
 * 
 * Run this in DevTools console after launching the new exe:
 * 
 *   window.verifyMomentumDeployment()
 */

window.verifyMomentumDeployment = function() {
  console.log('\n🔍 MOMENTUM EXIT DEPLOYMENT VERIFICATION\n');
  
  const checks = [];
  
  // Check 1: Core module loaded
  const hasCore = window.PYTHMomentumExit !== undefined;
  checks.push({
    name: 'PYTHMomentumExit module',
    pass: hasCore,
    detail: hasCore ? '✅ Loaded' : '❌ Missing'
  });
  
  // Check 2: Integration module loaded
  const hasIntegration = window.integrateMomentumExit !== undefined;
  checks.push({
    name: 'Momentum Integration wrapper',
    pass: hasIntegration,
    detail: hasIntegration ? '✅ Loaded' : '❌ Missing'
  });
  
  // Check 3: Diagnostics API available
  const hasDiagnostics = typeof window.getMomentumDiagnostics === 'function';
  checks.push({
    name: 'Diagnostics API',
    pass: hasDiagnostics,
    detail: hasDiagnostics ? '✅ Available' : '❌ Missing'
  });
  
  // Check 4: Dashboard renderer available
  const hasDashboard = typeof window.renderMomentumDashboard === 'function';
  checks.push({
    name: 'Dashboard renderer',
    pass: hasDashboard,
    detail: hasDashboard ? '✅ Available' : '❌ Missing'
  });
  
  // Check 5: Core functions
  let coreOk = true;
  const requiredFuncs = ['initPosition', 'updateMomentum', 'shouldExit', 'exitPosition', 'getAllPositions'];
  requiredFuncs.forEach(fn => {
    if (typeof window.PYTHMomentumExit[fn] !== 'function') {
      coreOk = false;
    }
  });
  checks.push({
    name: 'Core functions (init/update/exit/etc)',
    pass: coreOk,
    detail: coreOk ? '✅ All present' : `❌ Missing: ${requiredFuncs.filter(f => !window.PYTHMomentumExit[f]).join(', ')}`
  });
  
  // Check 6: CFM data available
  const hasCFM = window._cfm !== undefined && Object.keys(window._cfm || {}).length > 0;
  checks.push({
    name: 'CFM price data',
    pass: hasCFM,
    detail: hasCFM ? `✅ ${Object.keys(window._cfm).length} coins` : '❌ Empty'
  });
  
  // Check 7: Log storage initialized
  const logExists = Array.isArray(window._momentumExitLog);
  checks.push({
    name: 'Momentum exit log',
    pass: logExists,
    detail: logExists ? `✅ ${window._momentumExitLog.length} entries` : '❌ Not initialized'
  });
  
  // Print results
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║          DEPLOYMENT VERIFICATION RESULTS              ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
  
  let allPass = true;
  checks.forEach(check => {
    const status = check.pass ? '✅' : '❌';
    console.log(`${status} ${check.name.padEnd(40)} ${check.detail}`);
    if (!check.pass) allPass = false;
  });
  
  console.log('\n' + '═'.repeat(55));
  if (allPass) {
    console.log('✅ ALL CHECKS PASSED — System is ready');
  } else {
    console.log('⚠️  SOME CHECKS FAILED — Review errors above');
  }
  console.log('═'.repeat(55) + '\n');
  
  // Print active diagnostics
  if (hasDiagnostics) {
    const diag = window.getMomentumDiagnostics();
    console.log('📊 LIVE DIAGNOSTICS:');
    console.log(`   Active Positions: ${diag.activePositions}`);
    console.log(`   Total Exits: ${diag.totalExits}`);
    console.log(`   Recent Exits: ${diag.recentExits.length}`);
    console.log('\n');
  }
  
  return {
    allPass,
    checks,
    timestamp: new Date().toISOString()
  };
};

// Also make this available as a shorthand
window['🚀MomentumCheck'] = window.verifyMomentumDeployment;

// Auto-run on load if in dev mode
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
  console.log('🔍 Momentum Exit deployment detected. Run window.verifyMomentumDeployment() to verify.');
}
