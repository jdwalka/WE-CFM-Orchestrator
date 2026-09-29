/**
 * Signal Logic Audit (static)
 * Verifies key indicator sign logic remains correct without requiring browser globals.
 */

const fs = require('fs');
const path = require('path');

const predictionsPath = path.join(__dirname, 'src', 'core', 'predictions.js');
const code = fs.readFileSync(predictionsPath, 'utf8');

const checks = [
  {
    name: 'CCI neutral signal keeps sign',
    mustMatch: /^\s*else\s+cciSig\s*=\s*clamp\(cciVal\s*\/\s*200,\s*-0\.3,\s*0\.3\)/m,
    mustNotMatch: /^\s*else\s+cciSig\s*=\s*clamp\(\s*-\s*cciVal\s*\/\s*200/m,
  },
  {
    name: 'Fisher signal keeps sign',
    mustMatch: /^\s*const\s+fisherSig\s*=\s*clamp\(fisherVal\s*\/\s*2\.5,\s*-1,\s*1\)/m,
    mustNotMatch: /^\s*const\s+fisherSig\s*=\s*clamp\(\s*-\s*fisherVal\s*\/\s*2\.5/m,
  },
];

console.log('=== Signal Logic Audit (Static) ===\n');

let failed = 0;
checks.forEach((check, idx) => {
  const hasRequired = check.mustMatch.test(code);
  const hasForbidden = check.mustNotMatch.test(code);
  if (hasRequired && !hasForbidden) {
    console.log(`✅ CHECK ${idx + 1}: ${check.name}`);
  } else {
    console.log(`❌ CHECK ${idx + 1}: ${check.name}`);
    if (!hasRequired) console.log(`   Missing required pattern: ${check.mustMatch}`);
    if (hasForbidden) console.log(`   Forbidden pattern found: ${check.mustNotMatch}`);
    failed++;
  }
});

console.log('');
process.exit(failed === 0 ? 0 : 1);
