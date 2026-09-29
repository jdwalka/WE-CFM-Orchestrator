/**
 * extract-weights.js
 * One-shot bootstrap: reads COMPOSITE_WEIGHTS, PER_COIN_INDICATOR_BIAS from
 * src/core/predictions.js and REGIME_WEIGHT_MULTS from
 * src/core/predictions/regime-weights.js, then writes an authoritative
 * predictions-weights.json that all backtest scripts will use going forward.
 *
 * Usage: node scripts/extract-weights.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PREDS_PATH = path.join(ROOT, 'src', 'core', 'predictions.js');
const REGIME_PATH = path.join(ROOT, 'src', 'core', 'predictions', 'regime-weights.js');
const OUT_PATH = path.join(ROOT, 'src', 'core', 'predictions-weights.json');

// ── helpers ────────────────────────────────────────────────────────────────
function evalObj(src) {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${src})`)();
}

function extractBlock(src, varName) {
    // Matches:  const VARNAME = { ... };  or  var VARNAME = { ...
    // Uses a regex to find the actual assignment (not a comment reference),
    // then brace-depth counting to handle nested objects.
    const assignRe = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`);
    const m = assignRe.exec(src);
    if (!m) return null;
    // braceStart is the index of the opening `{` in the assignment
    const braceStart = m.index + m[0].lastIndexOf('{');
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                return src.slice(braceStart, i + 1);
            }
        }
    }
    return null;
}

// ── extract ────────────────────────────────────────────────────────────────
const predsSrc = fs.readFileSync(PREDS_PATH, 'utf8');
const regimeSrc = fs.readFileSync(REGIME_PATH, 'utf8');

const compositeBlock = extractBlock(predsSrc, 'COMPOSITE_WEIGHTS');
const biasBlock = extractBlock(predsSrc, 'PER_COIN_INDICATOR_BIAS');
const regimeBlock = extractBlock(regimeSrc, 'REGIME_WEIGHT_MULTS');

if (!compositeBlock) { console.error('ERROR: COMPOSITE_WEIGHTS not found in predictions.js'); process.exit(1); }
if (!biasBlock) { console.error('ERROR: PER_COIN_INDICATOR_BIAS not found in predictions.js'); process.exit(1); }
if (!regimeBlock) { console.error('ERROR: REGIME_WEIGHT_MULTS not found in regime-weights.js'); process.exit(1); }

const COMPOSITE_WEIGHTS = evalObj(compositeBlock);
const PER_COIN_INDICATOR_BIAS = evalObj(biasBlock);
const REGIME_WEIGHT_MULTS = evalObj(regimeBlock);

// ── preserve SHORT_HORIZON_FILTERS if already in the JSON ─────────────────
let SHORT_HORIZON_FILTERS = {};
if (fs.existsSync(OUT_PATH)) {
    try {
        const existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
        if (existing.SHORT_HORIZON_FILTERS) SHORT_HORIZON_FILTERS = existing.SHORT_HORIZON_FILTERS;
    } catch (_) { /* ignore */ }
}

const output = {
    COMPOSITE_WEIGHTS,
    REGIME_WEIGHT_MULTS,
    PER_COIN_INDICATOR_BIAS,
    SHORT_HORIZON_FILTERS,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf8');
console.log(`✔ predictions-weights.json written to ${path.relative(ROOT, OUT_PATH)}`);
console.log(`  COMPOSITE_WEIGHTS keys:       ${Object.keys(COMPOSITE_WEIGHTS).length}`);
console.log(`  REGIME_WEIGHT_MULTS regimes:  ${Object.keys(REGIME_WEIGHT_MULTS).join(', ')}`);
console.log(`  PER_COIN_INDICATOR_BIAS coins: ${Object.keys(PER_COIN_INDICATOR_BIAS).join(', ')}`);
