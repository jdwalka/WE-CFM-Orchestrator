'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuantumStateTracker } = require('../src/orbital/quantum-state');

test('encodes positive and negative electron charge in subatomic orbitals', () => {
  const tracker = createQuantumStateTracker();
  const positive = tracker.enrich('p', 'BTC', { price_momentum: 0.004 }, 1000).quantum_state;
  const negative = tracker.enrich('p', 'BTC', { price_momentum: -0.006 }, 2000).quantum_state;

  assert.equal(positive.ion_charge, '+');
  assert.equal(negative.ion_charge, '-');
  assert.equal(positive.electron_count, 1);
  assert.equal(positive.subatomic_orbital_count, 1);
  assert.equal(positive.subshells[0].subatomic_orbitals[0].occupancy, 1);
  assert.equal(positive.subshells[0].subatomic_orbitals[0].electrons[0].charge, '+');
  assert.equal(negative.subshells[0].subatomic_orbitals[0].electrons[0].charge, '-');
});

test('uses spin to encode signal transition direction', () => {
  const tracker = createQuantumStateTracker();
  const first = tracker.enrich('f', 'ETH', { kalshi_yes_pct: 60 }, 1000).quantum_state;
  const strengthening = tracker.enrich('f', 'ETH', { kalshi_yes_pct: 70 }, 2000).quantum_state;
  const weakening = tracker.enrich('f', 'ETH', { kalshi_yes_pct: 55 }, 3000).quantum_state;

  const electron = (state) => state.subshells[0].subatomic_orbitals[0].electrons[0];
  assert.equal(electron(first).spin, '+1/2');
  assert.equal(electron(strengthening).spin, '+1/2');
  assert.equal(electron(weakening).spin, '-1/2');
});

test('derives relative charge for raw price electrons after the first observation', () => {
  const tracker = createQuantumStateTracker();
  const initial = tracker.enrich('s', 'SOL', { price_usd: 100 }, 1000).quantum_state;
  const next = tracker.enrich('s', 'SOL', { price_usd: 101 }, 2000).quantum_state;

  assert.equal(initial.electron_count, 0);
  assert.equal(next.ion_charge, '+');
  assert.equal(next.subshells[0].subatomic_orbitals[0].electrons[0].basis, 'relative-change');
});
