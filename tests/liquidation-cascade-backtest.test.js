import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateLiquidationTestDataset,
  runLiquidationCascadeBacktest,
} from '../backtest/liquidation-cascade-backtest.js';

test('runLiquidationCascadeBacktest handles empty dataset', () => {
  const result = runLiquidationCascadeBacktest([]);
  assert.equal(result.error, 'empty_dataset');
});

test('runLiquidationCascadeBacktest correlates burst with tail arrival and tunes threshold', () => {
  const dataset = generateLiquidationTestDataset(24);
  assert.equal(dataset.length, 24);

  const report = runLiquidationCascadeBacktest(dataset);
  assert.equal(report.status, 'ok');
  assert.equal(report.total_hours_evaluated, 24);
  assert.ok(typeof report.correlation_metrics.correlation_coefficient === 'number');
  assert.ok(report.threshold_tuning.candidates.length >= 4);
  assert.ok(report.threshold_tuning.optimal_threshold_usd > 0);
});
