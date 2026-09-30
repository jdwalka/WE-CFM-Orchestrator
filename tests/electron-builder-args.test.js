'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { builderArgsFor } = require('../scripts/electron-builder-args');

test('electron-builder never publishes implicitly in CI', () => {
  const args = builderArgsFor(new Set(['portable', 'installer']), 'builder.json');

  assert.deepEqual(args, [
    '--config',
    'builder.json',
    '--win',
    '--publish',
    'never',
  ]);
});

test('electron-builder keeps the selected single build target', () => {
  const args = builderArgsFor(new Set(['portable']), 'builder.json');

  assert.deepEqual(args, [
    '--config',
    'builder.json',
    '--win',
    'portable',
    '--publish',
    'never',
  ]);
});
