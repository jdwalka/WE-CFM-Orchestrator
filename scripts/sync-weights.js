/**
 * sync-weights.js
 * Propagates predictions-weights.json back into the JS source files so that
 * the Electron renderer (which cannot directly require Node.js files) and
 * backtest-runner.js always reflect the latest tuned values.
 *
 * Run after any backtest tuning pass:
 *   node scripts/sync-weights.js
 *
 * What it updates:
 *   • src/core/predictions.js                — COMPOSITE_WEIGHTS + PER_COIN_INDICATOR_BIAS blocks
 *   • src/core/predictions/regime-weights.js — REGIME_WEIGHT_MULTS block
 *   • backtest/backtest-runner.js            — COMPOSITE_WEIGHTS + PER_COIN_INDICATOR_BIAS blocks
 *   • backtest/walk-forward-backtest.js      — COMPOSITE_WEIGHTS + PER_COIN_INDICATOR_BIAS blocks
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'src', 'core', 'predictions-weights.json');
const PREDS_PATH = path.join(ROOT, 'src', 'core', 'predictions.js');
const REGIME_PATH = path.join(ROOT, 'src', 'core', 'predictions', 'regime-weights.js');
const BT_PATH = path.join(ROOT, 'backtest', 'backtest-runner.js');
const WFB_PATH = path.join(ROOT, 'backtest', 'walk-forward-backtest.js');

const weights = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

// ── serializers ────────────────────────────────────────────────────────────

/** Flat { key: value, ... } → JS object literal string (no nesting). */
function serializeFlat(obj, indent) {
    const pad = ' '.repeat(indent);
    const lines = Object.entries(obj).map(([k, v]) => `${pad}  ${k}: ${v},`);
    return `{\n${lines.join('\n')}\n${pad}}`;
}

/** Nested { regime: { key: value } } → JS object literal string. */
function serializeRegimes(obj, indent) {
    const pad = ' '.repeat(indent);
    const blocks = Object.entries(obj).map(([regime, mults]) => {
        if (!mults || Object.keys(mults).length === 0) {
            return `${pad}  ${regime}: {},`;
        }
        const inner = Object.entries(mults).map(([k, v]) => `${k}: ${v}`).join(', ');
        return `${pad}  ${regime}: { ${inner} },`;
    });
    return `{\n${blocks.join('\n')}\n${pad}}`;
}

/** Deep { coin: { key: value } } → JS object literal string. */
function serializeBias(obj, indent) {
    const pad = ' '.repeat(indent);
    const coinBlocks = Object.entries(obj).map(([coin, bias]) => {
        const innerPad = ' '.repeat(indent + 4);
        const lines = Object.entries(bias).map(([k, v]) => `${innerPad}${k}: ${v},`);
        return `${pad}  ${coin}: {\n${lines.join('\n')}\n${pad}  },`;
    });
    return `{\n${coinBlocks.join('\n')}\n${pad}}`;
}

// ── patch helpers ──────────────────────────────────────────────────────────

/**
 * Replaces the body of a `const/let/var VARNAME = { ... };` declaration
 * in `src` with `newBody`, using brace-depth counting to find the exact span.
 */
function patchBlock(src, varName, newBody) {
    const assignRe = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`);
    const m = assignRe.exec(src);
    if (!m) {
        console.warn(`  WARN: ${varName} not found — skipping`);
        return src;
    }
    const braceStart = m.index + m[0].lastIndexOf('{');
    let depth = 0, braceEnd = -1;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
    }
    if (braceEnd === -1) { console.warn(`  WARN: closing brace for ${varName} not found — skipping`); return src; }

    const before = src.slice(0, braceStart);
    const after = src.slice(braceEnd + 1);
    return before + newBody + after;
}

// ── detect indentation of each target variable ────────────────────────────

function detectIndent(src, varName) {
    const re = new RegExp(`^(\\s*)(?:const|let|var)\\s+${varName}\\s*=`, 'm');
    const m = re.exec(src);
    return m ? m[1].length : 2;
}

// ── patch predictions.js ──────────────────────────────────────────────────

let predsSrc = fs.readFileSync(PREDS_PATH, 'utf8');

const compIndent = detectIndent(predsSrc, 'COMPOSITE_WEIGHTS');
const biasIndent = detectIndent(predsSrc, 'PER_COIN_INDICATOR_BIAS');

predsSrc = patchBlock(predsSrc, 'COMPOSITE_WEIGHTS', serializeFlat(weights.COMPOSITE_WEIGHTS, compIndent));
predsSrc = patchBlock(predsSrc, 'PER_COIN_INDICATOR_BIAS', serializeBias(weights.PER_COIN_INDICATOR_BIAS, biasIndent));

fs.writeFileSync(PREDS_PATH, predsSrc, 'utf8');
console.log('✔ src/core/predictions.js — COMPOSITE_WEIGHTS + PER_COIN_INDICATOR_BIAS synced');

// ── patch regime-weights.js ───────────────────────────────────────────────

let regimeSrc = fs.readFileSync(REGIME_PATH, 'utf8');
const regimeIndent = detectIndent(regimeSrc, 'REGIME_WEIGHT_MULTS');
regimeSrc = patchBlock(regimeSrc, 'REGIME_WEIGHT_MULTS', serializeRegimes(weights.REGIME_WEIGHT_MULTS, regimeIndent));
fs.writeFileSync(REGIME_PATH, regimeSrc, 'utf8');
console.log('✔ src/core/predictions/regime-weights.js — REGIME_WEIGHT_MULTS synced');

// ── patch backtest-runner.js ───────────────────────────────────────────────

let btSrc = fs.readFileSync(BT_PATH, 'utf8');
const btCompIndent = detectIndent(btSrc, 'COMPOSITE_WEIGHTS');
const btBiasIndent = detectIndent(btSrc, 'PER_COIN_INDICATOR_BIAS');

btSrc = patchBlock(btSrc, 'COMPOSITE_WEIGHTS', serializeFlat(weights.COMPOSITE_WEIGHTS, btCompIndent));
btSrc = patchBlock(btSrc, 'PER_COIN_INDICATOR_BIAS', serializeBias(weights.PER_COIN_INDICATOR_BIAS, btBiasIndent));

fs.writeFileSync(BT_PATH, btSrc, 'utf8');
console.log('✔ backtest/backtest-runner.js — COMPOSITE_WEIGHTS + PER_COIN_INDICATOR_BIAS synced');

// ── patch walk-forward-backtest.js ────────────────────────────────────────

let wfbSrc = fs.readFileSync(WFB_PATH, 'utf8');
const wfbCompIndent = detectIndent(wfbSrc, 'COMPOSITE_WEIGHTS');
const wfbBiasIndent = detectIndent(wfbSrc, 'PER_COIN_INDICATOR_BIAS');

wfbSrc = patchBlock(wfbSrc, 'COMPOSITE_WEIGHTS', serializeFlat(weights.COMPOSITE_WEIGHTS, wfbCompIndent));
wfbSrc = patchBlock(wfbSrc, 'PER_COIN_INDICATOR_BIAS', serializeBias(weights.PER_COIN_INDICATOR_BIAS, wfbBiasIndent));

fs.writeFileSync(WFB_PATH, wfbSrc, 'utf8');
console.log('✔ backtest/walk-forward-backtest.js — COMPOSITE_WEIGHTS + PER_COIN_INDICATOR_BIAS synced');

console.log('\nDone. Run `npm start` or reload the Electron app to apply changes.');
