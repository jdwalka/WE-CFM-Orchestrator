#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const getArg = (flag, fallback = null) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : fallback;
};

const splitCoins = (v) => String(v || '')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

const SUPPORTED_COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
const requestedCoins = splitCoins(getArg('--coins', SUPPORTED_COINS.join(',')));
const coins = requestedCoins.filter((c) => SUPPORTED_COINS.includes(c));
const skippedCoins = requestedCoins.filter((c) => !SUPPORTED_COINS.includes(c));

const retuneDays = parseInt(getArg('--retune-days', getArg('--days', '60')), 10);
const advancedDays = parseInt(getArg('--advanced-days', getArg('--days', '30')), 10);
const walkDays = parseInt(getArg('--walk-days', getArg('--days', '30')), 10);
const foldSize = parseInt(getArg('--fold-size', '400'), 10);
const testBars = parseInt(getArg('--test', '100'), 10);
const stepBars = parseInt(getArg('--step', '50'), 10);
const maxWindows = getArg('--max', null);
const writeWeights = hasFlag('--write-weights');

function runStep(title, scriptName, scriptArgs) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${title}`);
  console.log(`${'='.repeat(72)}`);
  console.log(`node ${scriptName} ${scriptArgs.join(' ')}`);

  const startedAt = Date.now();
  const result = spawnSync('node', [scriptName, ...scriptArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (result.status !== 0) {
    throw new Error(`${title} failed (exit ${result.status ?? 1}, ${elapsedSec}s)`);
  }
  console.log(`\n[OK] ${title} completed in ${elapsedSec}s`);
}

function runPerCoin(titlePrefix, scriptName, baseArgs) {
  for (const coin of coins) {
    runStep(`${titlePrefix} (${coin})`, scriptName, [...baseArgs, '--coin', coin]);
  }
}

function validateInputs() {
  if (!coins.length) {
    throw new Error(`No supported coins selected. Supported: ${SUPPORTED_COINS.join(', ')}`);
  }
  const numericPairs = [
    ['retune-days', retuneDays],
    ['advanced-days', advancedDays],
    ['walk-days', walkDays],
    ['fold-size', foldSize],
    ['test', testBars],
    ['step', stepBars],
  ];
  for (const [name, value] of numericPairs) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid --${name}: ${value}`);
    }
  }
}

async function main() {
  validateInputs();

  console.log('\nWECRYPTO Recalibration + Backtest Pipeline');
  console.log(`Coins: ${coins.join(', ')}`);
  if (skippedCoins.length) {
    console.warn(`Skipping unsupported coins: ${skippedCoins.join(', ')}`);
  }
  console.log(`Retune days: ${retuneDays} | Advanced days: ${advancedDays} | Walk-forward days: ${walkDays}`);
  console.log(`Walk-forward config: train=${foldSize}, test=${testBars}, step=${stepBars}`);

  if (!hasFlag('--skip-retune')) {
    const retuneArgs = ['backtest/outcome-retuner.js', '--days', String(retuneDays), '--coins', coins.join(',')];
    if (maxWindows) retuneArgs.push('--max', String(maxWindows));
    if (writeWeights) retuneArgs.push('--write-weights');
    runStep('1) Outcome recalibration', retuneArgs[0], retuneArgs.slice(1));
  } else {
    console.log('\n[SKIP] Outcome recalibration');
  }

  if (!hasFlag('--skip-advanced')) {
    runPerCoin('2) Advanced backtest', 'backtest/advanced-backtest.js', ['--days', String(advancedDays)]);
  } else {
    console.log('[SKIP] Advanced backtest');
  }

  if (!hasFlag('--skip-walkforward')) {
    runPerCoin(
      '3) Walk-forward backtest',
      'backtest/walk-forward-backtest.js',
      ['--days', String(walkDays), '--fold-size', String(foldSize), '--test', String(testBars), '--step', String(stepBars)]
    );
  } else {
    console.log('[SKIP] Walk-forward backtest');
  }

  console.log('\nPipeline complete.');
}

main().catch((err) => {
  console.error(`\nPipeline failed: ${err.message}`);
  process.exit(1);
});
