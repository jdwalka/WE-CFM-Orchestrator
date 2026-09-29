#!/usr/bin/env node
// ================================================================
// WECRYPTO Adaptive Backtest Harness
//
// Tests adaptive regime switching against historical Kalshi data.
// Compares:
//   - Static weights (baseline: post-outcome-retuned)
//   - Regime-adaptive weights (per-snapshot regime detection)
//
// Output: Win rate lift, regime distribution, per-regime performance
// ================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BACKTEST_DIR = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(BACKTEST_DIR, 'backtest-logs');

// ── Configuration ───────────────────────────────────────────────

const DEFAULT_ARGS = {
  days: 7,
  coins: 'BTC,ETH,SOL,XRP',
  'compare-static': true,
  'adaptive-mode': true,
  'output-csv': true,
};

// ── Utilities ───────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { ...DEFAULT_ARGS };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextVal = args[i + 1];
      if (nextVal && !nextVal.startsWith('--')) {
        parsed[key] = nextVal === 'false' ? false : nextVal === 'true' ? true : nextVal;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }

  return parsed;
}

// ── Main Test Runner ────────────────────────────────────────────

async function runAdaptiveBacktest() {
  const args = parseArgs();

  console.log('\n' + '═'.repeat(80));
  console.log('WECRYPTO Adaptive Backtest Harness');
  console.log('═'.repeat(80));
  console.log(`\nConfiguration:
  Days: ${args.days}
  Coins: ${args.coins}
  Compare Static: ${args['compare-static']}
  Adaptive Mode: ${args['adaptive-mode']}
  Output CSV: ${args['output-csv']}`);
  console.log('═'.repeat(80) + '\n');

  // Ensure logs directory exists
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  const coins = args.coins.split(',');
  const results = {
    timestamp: new Date().toISOString(),
    config: args,
    baseline: {},
    adaptive: {},
    per_regime: {},
    comparison: {},
  };

  // ── Phase 1: Run baseline (static weights) ──────────────────
  if (args['compare-static']) {
    console.log('Phase 1: Running BASELINE (static weights)...\n');
    for (const coin of coins) {
      try {
        const baselineResult = await runKalshiWalkForward({
          coins: coin,
          days: args.days,
          mode: 'static',
          adaptive: false,
        });
        results.baseline[coin] = baselineResult;
        console.log(`  ${coin}: ${baselineResult.wr_pct.toFixed(1)}% WR (${baselineResult.windows} windows)\n`);
      } catch (err) {
        console.error(`  ${coin}: ERROR - ${err.message}\n`);
        results.baseline[coin] = { error: err.message };
      }
    }
  }

  // ── Phase 2: Run adaptive (regime-switching) ────────────────
  if (args['adaptive-mode']) {
    console.log('\nPhase 2: Running ADAPTIVE (regime-switching)...\n');
    for (const coin of coins) {
      try {
        const adaptiveResult = await runKalshiWalkForward({
          coins: coin,
          days: args.days,
          mode: 'adaptive',
          adaptive: true,
        });
        results.adaptive[coin] = adaptiveResult;
        console.log(`  ${coin}: ${adaptiveResult.wr_pct.toFixed(1)}% WR (${adaptiveResult.windows} windows)\n`);
      } catch (err) {
        console.error(`  ${coin}: ERROR - ${err.message}\n`);
        results.adaptive[coin] = { error: err.message };
      }
    }
  }

  // ── Phase 3: Compute comparison metrics ─────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log('Comparison Results');
  console.log('═'.repeat(80) + '\n');

  coins.forEach(coin => {
    const base = results.baseline[coin];
    const adapt = results.adaptive[coin];

    if (base && adapt && !base.error && !adapt.error) {
      const lift = adapt.wr_pct - base.wr_pct;
      const liftBps = lift * 100;

      console.log(`${coin}:`);
      console.log(`  Baseline:     ${base.wr_pct.toFixed(1)}% (${base.windows} windows)`);
      console.log(`  Adaptive:     ${adapt.wr_pct.toFixed(1)}% (${adapt.windows} windows)`);
      console.log(`  Lift:         ${lift > 0 ? '+' : ''}${lift.toFixed(1)}pp (~${liftBps.toFixed(0)} bps)`);
      if (adapt.regime_distribution) {
        console.log(`  Regimes:      ${Object.entries(adapt.regime_distribution)
          .map(([r, pct]) => `${r}: ${pct.toFixed(1)}%`)
          .join(' | ')}`);
      }
      console.log('');

      results.comparison[coin] = {
        baseline_wr: base.wr_pct,
        adaptive_wr: adapt.wr_pct,
        lift_pp: lift,
        lift_bps: liftBps,
        regime_dist: adapt.regime_distribution,
      };
    }
  });

  // ── Phase 4: Export results ───────────────────────────────────
  const outPath = path.join(LOGS_DIR, `adaptive-backtest-${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n✅ Results exported to: ${outPath}\n`);

  // ── Summary ─────────────────────────────────────────────────
  if (Object.keys(results.comparison).length > 0) {
    const avgLift = Object.values(results.comparison)
      .reduce((sum, r) => sum + r.lift_pp, 0) / Object.keys(results.comparison).length;

    console.log('═'.repeat(80));
    console.log(`Summary: Average Lift ${avgLift > 0 ? '+' : ''}${avgLift.toFixed(2)}pp across all coins`);
    console.log('═'.repeat(80) + '\n');
  }
}

// ── Sub-process: Run Kalshi Walk-Forward ────────────────────────

function runKalshiWalkForward(options) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(BACKTEST_DIR, 'backtest', 'walk-forward-backtest.js');
    const args = [
      scriptPath,
      `--days=${options.days}`,
      `--coins=${options.coins}`,
    ];

    if (options.adaptive) {
      args.push('--adaptive-switching');
    }

    const proc = spawn('node', args, { cwd: BACKTEST_DIR });
    let stdout = '', stderr = '';

    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr += data; });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`walk-forward-backtest.js exited with code ${code}`));
        return;
      }

      // Parse output for metrics from walk-forward-backtest.js
      try {
        // Average OOS WR across horizons can represent the overall WR
        const wrMatches = [...stdout.matchAll(/Avg OOS WR:\s*(\d+\.\d+)%/gi)];
        let avgOosWr = 50;
        if (wrMatches.length > 0) {
            avgOosWr = wrMatches.reduce((acc, match) => acc + parseFloat(match[1]), 0) / wrMatches.length;
        }

        const windowsMatch = stdout.match(/\[(\d+)\s+valid\s+folds\]/i);

        const result = {
          mode: options.adaptive ? 'adaptive' : 'static',
          wr_pct: avgOosWr,
          windows: windowsMatch ? parseInt(windowsMatch[1]) : 0,
          raw_output: stdout.slice(-500),
        };

        // Regimes are found in the table rows under the "Regime" column
        const regimeDistribution = {};
        const regimeMatches = [...stdout.matchAll(/^\s*\d+\s*\|\s*([a-z_]+)\s*\|/gmi)];
        if (regimeMatches.length > 0) {
            regimeMatches.forEach(m => {
                const regime = m[1];
                regimeDistribution[regime] = (regimeDistribution[regime] || 0) + 1;
            });
            // Convert to percentages
            const total = Object.values(regimeDistribution).reduce((a, b) => a + b, 0);
            for (let k in regimeDistribution) {
                regimeDistribution[k] = (regimeDistribution[k] / total) * 100;
            }
            result.regime_distribution = regimeDistribution;
        }

        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ── Entry Point ─────────────────────────────────────────────────

runAdaptiveBacktest().catch(err => {
  console.error('Fatal Error:', err.message);
  process.exit(1);
});
