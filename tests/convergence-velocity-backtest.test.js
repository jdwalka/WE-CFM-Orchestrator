import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runConvergenceBacktest } from '../backtest/convergence-velocity-backtest.js';

test('runConvergenceBacktest returns error on insufficient candles', () => {
  const res = runConvergenceBacktest([]);
  assert.equal(res.error, 'insufficient_candles');
});

test('runConvergenceBacktest computes valid metrics with synthetic series', () => {
  const candles = [];
  let price = 75000;
  const now = Math.floor(Date.now() / 60000) * 60;
  for (let i = 100; i >= 0; i--) {
    const t = now - i * 60;
    const drift = (Math.random() - 0.49) * 30;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + 15;
    const low = Math.min(open, close) - 15;
    price = close;
    candles.push({ time: t, open, high, low, close, volume: 20 });
  }

  const report = runConvergenceBacktest(candles);
  assert.equal(report.status, 'ok');
  assert.ok(report.tested_intervals >= 100);
  assert.ok(report.convergence_up_backtest != null);
  assert.ok(report.diverging_backtest != null);
  assert.ok(typeof report.diverging_backtest.range_widening_ratio === 'number');
});
