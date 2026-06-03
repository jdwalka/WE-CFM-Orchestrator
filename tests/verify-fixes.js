#!/usr/bin/env node

/**
 * WE|||CRYPTO Deployment Verification Script
 * Dynamic checks for current 15m architecture (line-number independent).
 *
 * Run: node verify-fixes.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

const CHECKS = [
  {
    name: 'CCI neutral-zone inversion fixed',
    file: 'src/core/predictions.js',
    mustMatch: [/^\s*else\s+cciSig\s*=\s*clamp\(cciVal\s*\/\s*200,\s*-0\.3,\s*0\.3\)/m],
    mustNotMatch: [/^\s*else\s+cciSig\s*=\s*clamp\(\s*-\s*cciVal\s*\/\s*200/m],
    description: 'CCI neutral mapping should preserve sign (no negation).',
  },
  {
    name: 'Fisher inversion fixed',
    file: 'src/core/predictions.js',
    mustMatch: [/^\s*const\s+fisherSig\s*=\s*clamp\(fisherVal\s*\/\s*2\.5,\s*-1,\s*1\)/m],
    mustNotMatch: [/^\s*const\s+fisherSig\s*=\s*clamp\(\s*-\s*fisherVal\s*\/\s*2\.5/m],
    description: 'Fisher signal should preserve sign (no negation).',
  },
  {
    name: '15m baseline gate calibrated',
    file: 'src/core/adaptive-tuner.js',
    mustMatch: [/BTC:\s*\{\s*minAbsScore:\s*0\.42/],
    description: 'BTC 15m baseline should stay at 0.42.',
  },
  {
    name: 'Multi-cycle tuner active (3m/7m/12m + trades)',
    file: 'src/core/adaptive-tuner.js',
    mustMatch: [
      /TUNING_CYCLES_MS\s*=\s*\[\s*3\s*,\s*7\s*,\s*12\s*\]\.map/,
      /TUNING_CYCLE_TRADES\s*=\s*10/,
      /slice\(-50\)/,
    ],
    description: 'Adaptive tuning should use 3/7/12-minute and 10-trade triggers with 50-trade history.',
  },
  {
    name: 'Prediction card 15m move guidance wired',
    file: 'src/core/app.js',
    mustMatch: [
      /function\s+buildFifteenMinuteMovePlan\s*\(/,
      /function\s+renderFifteenMinuteMovePlan\s*\(/,
      /renderFifteenMinuteMovePlan\(ki,\s*true\)/,
      /renderFifteenMinuteMovePlan\(ki\)/,
    ],
    description: 'Card should expose explicit move guidance by 15m phase.',
  },
  {
    name: 'Crowd-fade is momentum-led divergence',
    file: 'src/ui/floating-orchestrator.js',
    mustMatch: [
      /function\s+crowdFadeDir\s*\(\s*kalshiYesPrice,\s*secsLeft,\s*dirs,\s*modelDir\s*\)/,
      /if\s*\(!kalshiDir\s*\|\|\s*kalshiDir\s*===\s*modelDir\)\s*return null;/,
      /return\s+modelDir;/,
    ],
    description: 'Fade direction should follow model momentum when crowd disagrees.',
  },
];

console.log('\n╔════════════════════════════════════════════════════════╗');
console.log('║   WE|||CRYPTO Kalshi 15m Validation                   ║');
console.log('║   Dynamic Consistency + Deployment Checks             ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

let passed = 0;
let failed = 0;

for (let i = 0; i < CHECKS.length; i++) {
  const check = CHECKS[i];
  const filePath = path.join(ROOT, check.file);

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const mustMatch = check.mustMatch || [];
    const mustNotMatch = check.mustNotMatch || [];

    const missing = mustMatch.filter((rx) => !rx.test(content));
    const forbidden = mustNotMatch.filter((rx) => rx.test(content));

    if (missing.length === 0 && forbidden.length === 0) {
      console.log(`✅ CHECK ${i + 1}: ${check.name}`);
      console.log(`   File: ${check.file}`);
      console.log(`   ${check.description}\n`);
      passed++;
      continue;
    }

    console.log(`❌ CHECK ${i + 1}: ${check.name}`);
    console.log(`   File: ${check.file}`);
    if (missing.length) {
      console.log(`   Missing patterns:`);
      missing.forEach((rx) => console.log(`   - ${rx}`));
    }
    if (forbidden.length) {
      console.log(`   Forbidden patterns present:`);
      forbidden.forEach((rx) => console.log(`   - ${rx}`));
    }
    console.log('');
    failed++;
  } catch (err) {
    console.log(`❌ CHECK ${i + 1}: ${check.name} — ERROR READING FILE`);
    console.log(`   File: ${check.file}`);
    console.log(`   Error: ${err.message}\n`);
    failed++;
  }
}

console.log('╔════════════════════════════════════════════════════════╗');
if (failed === 0) {
  console.log(`║  ✅ ALL CHECKS PASSED (${passed}/${CHECKS.length})             ║`);
  console.log('║                                                        ║');
  console.log('║  Ready for build/deployment.                          ║');
} else {
  console.log(`║  ❌ SOME CHECKS FAILED (${passed} passed, ${failed} failed)    ║`);
  console.log('║                                                        ║');
  console.log('║  Review failed checks before shipping.                ║');
}
console.log('╚════════════════════════════════════════════════════════╝\n');

process.exit(failed === 0 ? 0 : 1);
