/**
 * strip-data-fetching.js
 * AMD Ryzen 9 7950X3D — single-pass, in-memory transformation of predictions.js.
 *
 * Removes duplicate code now provided by data-fetchers.js scaffold:
 *   1. CDC circuit-breaker cluster  (cdcProviderHealth … fetchCdcResponse)
 *   2. Inline Fear & Greed helpers  (_fngCache, fetchAnalyticsWithRoute, fetchFearGreed)
 *   3. Full DATA FETCHING section   (normCandle, fetchWithTimeout … anchoredPoolCandles)
 *      — preserves wait() and withSoftTimeout() which are still used below loadCoinData
 *
 * Inserts window.PREDICTIONS_DATA_FETCHERS destructuring after the existing
 * PREDICTIONS_KALSHI_ROUTING import so all the removed names stay in scope.
 *
 * Usage: node scripts/strip-data-fetching.js [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'core', 'predictions.js');
const BACKUP = FILE + '.bak';
const DRY_RUN = process.argv.includes('--dry-run');

// ── 1. Read source ─────────────────────────────────────────────────────────
let src = fs.readFileSync(FILE, 'utf8');
const hasCRLF = src.includes('\r\n');
// Normalize to LF so all regex anchors use \n consistently
if (hasCRLF) src = src.replace(/\r\n/g, '\n');
const originalLines = src.split('\n').length;

// ── 2. Helper: remove a block matched by start/end anchor regexes ──────────
function removeBlock(text, startRe, endRe, label) {
    const si = text.search(startRe);
    if (si === -1) { console.warn(`  [SKIP] ${label}: start anchor not found`); return text; }
    // Search for end anchor AFTER the start position
    const tail = text.slice(si);
    const em = endRe.exec(tail);
    if (!em) { console.warn(`  [SKIP] ${label}: end anchor not found`); return text; }
    const ei = si + em.index + em[0].length;
    const removed = text.slice(si, ei);
    const lineCount = removed.split('\n').length - 1;
    console.log(`  [DEL]  ${label}: ${lineCount} lines removed`);
    return text.slice(0, si) + text.slice(ei);
}

// ── 3. Remove CDC circuit-breaker cluster ──────────────────────────────────
// Starts: function cdcProviderHealth()
// Ends:   closing } of fetchCdcResponse, followed by blank line then BT cache comment
src = removeBlock(
    src,
    /\n  function cdcProviderHealth\(\)/,
    /\n  }\n(?=\n  \/\/ ── Backtest localStorage cache)/,
    'CDC circuit-breaker cluster',
);

// ── 4. Remove _fngCache + fetchAnalyticsWithRoute + fetchFearGreed ─────────
// Starts: // Fear & Greed Index cache
// Ends:   closing } of fetchFearGreed followed by COMPOSITE_WEIGHTS comment
src = removeBlock(
    src,
    /\n  \/\/ Fear & Greed Index cache/,
    /\n  }\n(?=\n  \/\/ ={3,}\n  \/\/ COMPOSITE_WEIGHTS)/,
    '_fngCache + fetchAnalyticsWithRoute + fetchFearGreed',
);

// ── 5. Remove DATA FETCHING header + normCandle (keep wait & withSoftTimeout)
src = removeBlock(
    src,
    /\n  \/\/ ={3,}\n  \/\/ DATA FETCHING\n  \/\/ ={3,}\n\n  function normCandle\(c\)/,
    /\n  }\n(?=\n  function wait\(ms\))/,
    'DATA FETCHING header + normCandle',
);

// ── 6. Remove fetchWithTimeout through anchoredPoolCandles ─────────────────
// Starts immediately after closing } of withSoftTimeout
// Ends at end of anchoredPoolCandles }
src = removeBlock(
    src,
    /(?<=\n  }\n)\n  async function fetchWithTimeout\(/,
    /\n  function anchoredPoolCandles\(cbSeries[^)]*\) \{\n    return poolMinuteCandles[^\n]+\n  \}\n/,
    'fetchWithTimeout … anchoredPoolCandles',
);

// ── 7. Insert PREDICTIONS_DATA_FETCHERS import after KALSHI_ROUTING block ──
const IMPORT_ANCHOR = /(?<=\s} = window\.PREDICTIONS_KALSHI_ROUTING;\n)/;
const DATA_FETCHERS_IMPORT = `
  // ── Exchange data fetchers — provided by data-fetchers.js scaffold ─────────
  const {
    fetchWithTimeout, fetchAnalyticsWithRoute, fetchFearGreed,
    fetchCDCCandles, fetchCDCBook, fetchCDCTrades,
    fetchGeckoJSON, fetchGeckoCandles, fetchGeckoTicker, fetchGeckoMaxHistory,
    fetchBINCandles, fetchBINBook, fetchBINTrades,
    fetchMEXCCandles, fetchMEXCBook, fetchMEXCTrades,
    fetchBybitCandles, fetchBybitBook, fetchBybitTrades,
    fetchKucoinCandles, fetchKucoinBook, fetchKucoinTrades,
    fetchBitfinexCandles, fetchBitfinexBook, fetchBitfinexTrades,
    fetchCBExchCandles, fetchCBExchBook, fetchCBExchTrades,
    fetchKrakenCandles, fetchKrakenBook, fetchKrakenTrades,
    anchoredPoolCandles, bucketCandles,
  } = window.PREDICTIONS_DATA_FETCHERS;
`;

if (IMPORT_ANCHOR.test(src)) {
    src = src.replace(IMPORT_ANCHOR, DATA_FETCHERS_IMPORT);
    console.log('  [ADD]  PREDICTIONS_DATA_FETCHERS import injected');
} else {
    console.warn('  [SKIP] PREDICTIONS_DATA_FETCHERS anchor not found — import NOT added');
}

// ── 8. Report ───────────────────────────────────────────────────────────────
const newLines = src.split('\n').length;
console.log(`\n  Lines: ${originalLines} → ${newLines} (Δ ${originalLines - newLines} removed)`);

if (DRY_RUN) {
    console.log('  [DRY-RUN] No files written.');
    process.exit(0);
}

// ── 9. Backup + write ───────────────────────────────────────────────────────
fs.writeFileSync(BACKUP, fs.readFileSync(FILE));
// Restore original line endings if file had CRLF
const outSrc = hasCRLF ? src.replace(/\n/g, '\r\n') : src;
fs.writeFileSync(FILE, outSrc, 'utf8');
console.log(`  Backup → ${path.basename(BACKUP)}`);
console.log(`  Written → ${path.relative(ROOT, FILE)}`);

// ── 10. Syntax check ────────────────────────────────────────────────────────
try {
    execSync(`node --check "${FILE}"`, { stdio: 'pipe' });
    console.log('  [OK] Syntax check passed ✓');
} catch (e) {
    console.error('  [ERR] Syntax check FAILED:', e.stderr?.toString()?.slice(0, 400));
    console.error('  Restoring backup …');
    fs.writeFileSync(FILE, fs.readFileSync(BACKUP));
    process.exit(1);
}
