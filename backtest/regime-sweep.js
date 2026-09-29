const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// Sweep injects ofi/microPrice values into the REGIME_WEIGHT_MULTS block that
// lives in regime-weights.js — NOT predictions.js.
const REGIME_PATH = path.join(ROOT, 'src', 'core', 'predictions', 'regime-weights.js');
const WEIGHTS_PATH = path.join(ROOT, 'src', 'core', 'predictions-weights.json');
const SCRIPT_PATH = path.resolve(__dirname, 'walk-forward-backtest.js');
const LOGS_DIR = path.resolve(__dirname, '../backtest-logs');

const originalFile = fs.readFileSync(REGIME_PATH, 'utf8');

const OFI_MULTS_VOL = [1.5, 3.5];
const MICRO_MULTS_VOL = [1.5, 3.5];
const OFI_MULTS_CHOP = [0.5, 2.0];
const MICRO_MULTS_CHOP = [0.5, 2.0];

async function runBacktest() {
  return new Promise((resolve) => {
    const proc = spawn('node', [
      SCRIPT_PATH,
      '--coins=BTC,ETH,SOL,XRP',
      '--days=3',
      '--adaptive-switching'
    ], { cwd: path.resolve(__dirname, '..') });

    let stdout = '';
    proc.stdout.on('data', d => stdout += d);

    proc.on('close', code => {
      const wrMatches = [...stdout.matchAll(/Avg OOS WR:\s*(\d+\.\d+)%/gi)];
      let avgOosWr = 0;
      if (wrMatches.length > 0) {
        avgOosWr = wrMatches.reduce((acc, match) => acc + parseFloat(match[1]), 0) / wrMatches.length;
      }
      resolve(avgOosWr);
    });
  });
}

function injectMultipliers(ofiVol, microVol, ofiChop, microChop) {
  const volatileRegex = /trending_volatile:\s*\{([^}]+)\}/;
  const choppyRegex = /choppy:\s*\{([^}]+)\}/;

  let newFile = originalFile;

  // Replace trending_volatile
  const volatileMatch = newFile.match(volatileRegex);
  if (volatileMatch) {
    let inner = volatileMatch[1];
    // Remove old if present
    inner = inner.replace(/,\s*ofi:\s*[\d.]+/, '').replace(/,\s*microPrice:\s*[\d.]+/, '');
    inner += `, ofi: ${ofiVol}, microPrice: ${microVol}`;
    newFile = newFile.replace(volatileRegex, `trending_volatile: {${inner}}`);
  }

  // Replace choppy
  const choppyMatch = newFile.match(choppyRegex);
  if (choppyMatch) {
    let inner = choppyMatch[1];
    inner = inner.replace(/,\s*ofi:\s*[\d.]+/, '').replace(/,\s*microPrice:\s*[\d.]+/, '');
    inner += `, ofi: ${ofiChop}, microPrice: ${microChop}`;
    newFile = newFile.replace(choppyRegex, `choppy: {${inner}}`);
  }

  fs.writeFileSync(REGIME_PATH, newFile, 'utf8');
}

async function runSweep() {
  console.log('Starting Regime Hyperparameter Sweep (3-day adaptive)...');

  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

  let results = [];

  try {
    for (const o_vol of OFI_MULTS_VOL) {
      for (const m_vol of MICRO_MULTS_VOL) {
        for (const o_chop of OFI_MULTS_CHOP) {
          for (const m_chop of MICRO_MULTS_CHOP) {
            console.log(`\nTesting configuration: Volatile(ofi=${o_vol}, micro=${m_vol}) | Choppy(ofi=${o_chop}, micro=${m_chop})`);

            injectMultipliers(o_vol, m_vol, o_chop, m_chop);

            const start = Date.now();
            const wr = await runBacktest();
            const duration = ((Date.now() - start) / 1000).toFixed(1);

            console.log(`  -> Average OOS Win Rate: ${wr.toFixed(2)}% (took ${duration}s)`);

            results.push({ o_vol, m_vol, o_chop, m_chop, wr });
          }
        }
      }
    }
  } finally {
    // Always restore!
    fs.writeFileSync(REGIME_PATH, originalFile, 'utf8');
    console.log('\nRestored original regime-weights.js');
  }

  results.sort((a, b) => b.wr - a.wr);

  console.log('\nTop 3 Configurations:');
  for (let i = 0; i < 3 && i < results.length; i++) {
    const r = results[i];
    console.log(`  #${i + 1}: Volatile(ofi=${r.o_vol}, micro=${r.m_vol}) Choppy(ofi=${r.o_chop}, micro=${r.m_chop}) -> WR: ${r.wr.toFixed(2)}%`);
  }

  fs.writeFileSync(path.join(LOGS_DIR, `sweep-${Date.now()}.json`), JSON.stringify(results, null, 2));

  // Commit best ofi/microPrice values to predictions-weights.json then sync
  if (results.length > 0) {
    const best = results[0];
    const json = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
    if (!json.REGIME_WEIGHT_MULTS.trending_volatile) json.REGIME_WEIGHT_MULTS.trending_volatile = {};
    if (!json.REGIME_WEIGHT_MULTS.choppy) json.REGIME_WEIGHT_MULTS.choppy = {};
    json.REGIME_WEIGHT_MULTS.trending_volatile.ofi = best.o_vol;
    json.REGIME_WEIGHT_MULTS.trending_volatile.microPrice = best.m_vol;
    json.REGIME_WEIGHT_MULTS.choppy.ofi = best.o_chop;
    json.REGIME_WEIGHT_MULTS.choppy.microPrice = best.m_chop;
    fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(json, null, 2), 'utf8');
    try {
      execSync(`node "${path.join(ROOT, 'scripts', 'sync-weights.js')}"`, { stdio: 'inherit', cwd: ROOT });
    } catch (e) {
      console.error('sync-weights.js failed:', e.message);
    }
    console.log(`\nBest committed: Volatile(ofi=${best.o_vol}, micro=${best.m_vol}) | Choppy(ofi=${best.o_chop}, micro=${best.m_chop})`);
  }
}

runSweep().catch(console.error);
