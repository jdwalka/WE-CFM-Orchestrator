const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const PANEL_PATH = path.join(__dirname, '..', 'src', 'ui', 'hourly-ranges-panel.js');

test('hourly ranges cards do not render Kalshi 15m status', () => {
  const source = fs.readFileSync(PANEL_PATH, 'utf8');
  assert.equal(source.includes('Kalshi 15m market pending'), false);
  assert.equal(source.includes('hr-kalshi15m'), false);
  assert.equal(source.includes('${kalshi15mHtml'), false);
});
