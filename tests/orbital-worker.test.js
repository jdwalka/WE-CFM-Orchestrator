const test = require('node:test');
const assert = require('node:assert/strict');
const WorkerModule = require('../src/orbital/orbital-worker');

test('Orbital Worker: GARCH(1,1) volatility and residuals', () => {
  const state = { sigma2: null };
  const res1 = WorkerModule.garchUpdate(state, 0.01);
  assert.ok(res1.sigma2 > 0, 'sigma2 should be initialized and positive');
  assert.ok(res1.condVol > 0, 'conditional volatility should be positive');
  assert.ok(Number.isFinite(res1.residual), 'residual should be finite');

  const res2 = WorkerModule.garchUpdate(state, -0.02);
  assert.ok(res2.sigma2 > 0);
  assert.ok(res2.condVol > 0);
  assert.ok(res2.residual < 0, 'negative return yields negative residual');
});

test('Orbital Worker: BBWidth(20) calculation', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 2) * 5);
  const bb = WorkerModule.calculateBBWidth(closes, 20);
  assert.ok(bb.width > 0, 'Bollinger Band width should be positive');
  assert.ok(bb.upper > bb.middle, 'upper band should exceed middle');
  assert.ok(bb.middle > bb.lower, 'middle band should exceed lower');
  assert.ok(bb.std > 0, 'standard deviation should be positive');
});

test('Orbital Worker: z_vwap calculation', () => {
  const prices = Array.from({ length: 25 }, (_, i) => 100 + i * 0.5);
  const volumes = Array.from({ length: 25 }, () => 10);
  const zv = WorkerModule.calculateZVwap(prices, volumes, 20);
  assert.ok(zv.vwap > 100, 'VWAP should reflect prices');
  assert.ok(Number.isFinite(zv.zVwap), 'zVwap should be finite');
  assert.ok(zv.zVwap > 0, 'latest price above average should have positive z-score');
});

test('Orbital Worker: Jacobi eigenvalues and Schrodinger Orbitals', () => {
  const closes = [100, 101, 99.5, 102, 101.5, 103, 102.5, 104, 103.5, 105];
  const orbitals = WorkerModule.computeSchrodingerOrbitals(closes, 3);
  assert.ok(Array.isArray(orbitals), 'orbitals should be an array');
  assert.ok(orbitals.length > 0, 'should return at least one orbital level');
  orbitals.forEach((lvl) => {
    assert.ok(Number.isFinite(lvl.energy), 'energy should be finite');
    assert.ok(Number.isFinite(lvl.center), 'center should be finite');
    assert.ok(Number.isFinite(lvl.width), 'width should be finite');
    assert.ok(lvl.persistence >= 0 && lvl.persistence <= 1, 'persistence in [0,1]');
  });
});

test('Orbital Worker: Message Handler Dispatch', () => {
  const closes = [100, 102, 101, 103, 102, 104, 105, 104, 106, 107, 106, 108];
  const reply = WorkerModule.handleMessage({
    data: {
      type: 'COMPUTE_MICROSTRUCTURE',
      reqId: 'test-1',
      sym: 'BTC',
      closes: closes,
      computeOrbitals: true,
    }
  });

  assert.equal(reply.type, 'MICROSTRUCTURE_RESULT');
  assert.equal(reply.sym, 'BTC');
  assert.ok(reply.rv > 0, 'realized volatility should be positive');
  assert.ok(reply.garch && reply.garch.condVol > 0, 'garch condVol should be positive');
  assert.ok(Number.isFinite(reply.zVwap), 'zVwap should be finite');
});
