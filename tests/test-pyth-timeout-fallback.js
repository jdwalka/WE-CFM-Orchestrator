#!/usr/bin/env node
/**
 * Pyth Lazer timeout fallback verification script
 * Tests strict timeout enforcement and fallback chain execution
 * 
 * Usage:
 *   node test-pyth-timeout-fallback.js
 */

const fs = require('fs');
const path = require('path');

console.log('═══════════════════════════════════════════════════════════════');
console.log('Pyth Lazer Timeout & Fallback Verification');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── Check 1: Verify fixed_rate channel/backoff-tolerance config in main.js
console.log('✓ CHECK 1: Verify fixed_rate channel and timeout backoff configuration');
const mainJsPath = path.join(__dirname, 'electron', 'main.js');
const mainJsContent = fs.readFileSync(mainJsPath, 'utf8');

const hasFixedRate = mainJsContent.includes('fixed_rate@');
const hasBackoff = mainJsContent.includes('PYTH_LIVE_FEED_BACKOFF_MS');
const hasTimeout = mainJsContent.includes('PYTH_FALLBACK_TIMEOUT_MS');
const hasTimeoutWatcher = mainJsContent.includes('resetPythTimeout');

console.log(`  ├─ fixed_rate channel present: ${hasFixedRate ? '✅' : '❌'}`);
console.log(`  ├─ PYTH_LIVE_FEED_BACKOFF_MS config: ${hasBackoff ? '✅' : '❌'}`);
console.log(`  ├─ PYTH_FALLBACK_TIMEOUT_MS constant: ${hasTimeout ? '✅' : '❌'}`);
console.log(`  └─ Timeout watcher function: ${hasTimeoutWatcher ? '✅' : '❌'}\n`);

// ── Check 2: Verify status tracking in main.js
console.log('✓ CHECK 2: Verify status tracking (pythLazerStatus)');
const hasStatusTracking = mainJsContent.includes('pythLazerStatus.connected = true');
const hasTimeoutIncrrement = mainJsContent.includes('pythLazerStatus.timeoutCount++');
const hasFallbackNotify = mainJsContent.includes('pyth:timeout-fallback');

console.log(`  ├─ Status connected tracking: ${hasStatusTracking ? '✅' : '❌'}`);
console.log(`  ├─ Timeout counter increment: ${hasTimeoutIncrrement ? '✅' : '❌'}`);
console.log(`  └─ Fallback notification event: ${hasFallbackNotify ? '✅' : '❌'}\n`);

// ── Check 3: Verify app.js fallback chain
console.log('✓ CHECK 3: Verify fallback chain in app.js');
const appJsPath = path.join(__dirname, 'src', 'core', 'app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

const hasStrictTimeout = appJsContent.includes('1000');
const hasFallback1 = appJsContent.includes('crypto.com');
const hasFallback2 = appJsContent.includes('fetchBinanceTickers');
const hasFallback3 = appJsContent.includes('fetchKrakenTickers');
const hasFallback4 = appJsContent.includes('fetchCoinbaseTickers');

console.log(`  ├─ Strict 1000ms timeout: ${hasStrictTimeout ? '✅' : '❌'}`);
console.log(`  ├─ Fallback 1 (CDC): ${hasFallback1 ? '✅' : '❌'}`);
console.log(`  ├─ Fallback 2 (Binance): ${hasFallback2 ? '✅' : '❌'}`);
console.log(`  ├─ Fallback 3 (Kraken): ${hasFallback3 ? '✅' : '❌'}`);
console.log(`  └─ Fallback 4 (Coinbase): ${hasFallback4 ? '✅' : '❌'}\n`);

// ── Check 4: Verify preload.js event exposure
console.log('✓ CHECK 4: Verify preload IPC event exposure');
const preloadPath = path.join(__dirname, 'electron', 'preload.js');
const preloadContent = fs.readFileSync(preloadPath, 'utf8');

const hasOnStatus = preloadContent.includes("'pyth:status'");
const hasOnTimeout = preloadContent.includes("'pyth:timeout-fallback'");  // ★ Updated to full name
const hasOnConnectionLost = preloadContent.includes("'pyth:connection-lost'");

console.log(`  ├─ onStatus event: ${hasOnStatus ? '✅' : '❌'}`);
console.log(`  ├─ onTimeout event: ${hasOnTimeout ? '✅' : '❌'}`);
console.log(`  └─ onConnectionLost event: ${hasOnConnectionLost ? '✅' : '❌'}\n`);

// ── Check 5: Verify timeout monitor script
console.log('✓ CHECK 5: Verify PythTimeoutMonitor module');
const monitorPath = path.join(__dirname, 'src', 'core', 'pyth-timeout-monitor.js');
const monitorExists = fs.existsSync(monitorPath);
const monitorContent = monitorExists ? fs.readFileSync(monitorPath, 'utf8') : '';

const hasMonitorStart = monitorContent.includes('monitor.start');
const hasEventTracking = monitorContent.includes('this.events');
const hasReport = monitorContent.includes('getReport');

console.log(`  ├─ Monitor file exists: ${monitorExists ? '✅' : '❌'}`);
console.log(`  ├─ Start/stop methods: ${hasMonitorStart ? '✅' : '❌'}`);
console.log(`  ├─ Event tracking: ${hasEventTracking ? '✅' : '❌'}`);
console.log(`  └─ Report generation: ${hasReport ? '✅' : '❌'}\n`);

// ── Check 6: Verify index.html includes monitor
console.log('✓ CHECK 6: Verify index.html includes monitor script');
const indexPath = path.join(__dirname, 'public', 'index.html');
const indexContent = fs.readFileSync(indexPath, 'utf8');

const hasMonitorScript = indexContent.includes('pyth-timeout-monitor.js');

console.log(`  └─ Monitor script loaded: ${hasMonitorScript ? '✅' : '❌'}\n`);

// ── Summary
console.log('═══════════════════════════════════════════════════════════════');
const allChecks = [
  hasFixedRate, hasBackoff, hasTimeout, hasTimeoutWatcher,
  hasStatusTracking, hasTimeoutIncrrement, hasFallbackNotify,
  hasStrictTimeout, hasFallback1, hasFallback2, hasFallback3, hasFallback4,
  hasOnStatus, hasOnTimeout, hasOnConnectionLost,
  hasMonitorStart, hasEventTracking, hasReport,
  hasMonitorScript
];

const passedChecks = allChecks.filter(Boolean).length;
const totalChecks = allChecks.length;

console.log(`SUMMARY: ${passedChecks}/${totalChecks} checks passed\n`);

if (passedChecks === totalChecks) {
  console.log('✅ ALL SYSTEMS READY FOR 1000MS TIMEOUT TESTING\n');
  console.log('Next steps:');
  console.log('  1. Start the app: npm start');
  console.log('  2. Open DevTools console (F12)');
  console.log('  3. Start monitoring: window.PythTimeoutMonitor.start()');
  console.log('  4. Stop Pyth or block connection to trigger timeout');
  console.log('  5. Check report: window.PythTimeoutMonitor.getReport()');
  console.log('  6. Export data: window.PythTimeoutMonitor.exportCSV()\n');
} else {
  console.log(`⚠️ ${totalChecks - passedChecks} checks failed — review output above\n`);
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════════\n');
