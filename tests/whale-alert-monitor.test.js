'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'feeds', 'whale-alert-monitor.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'whale-alert-monitor.js' });

test('unsupported chains resolve safely without null transactions', async () => {
  const result = await sandbox.window.WhaleAlertMonitor.getWhaleTransactions('NOT_A_CHAIN');
  assert.equal(result.txs.length, 0);
  assert.strictEqual(result.count, 0);
  assert.strictEqual(result.largest, null);
});
