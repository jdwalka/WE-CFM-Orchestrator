const assert = require('assert');
const path = require('path');

const Desk = require(path.join(__dirname, '..', 'src', 'llm', 'asi1-desk-contract.js'));
const orch = require(path.join(__dirname, '..', 'src', 'llm', 'asi1-credit-orchestrator.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (err) { failed += 1; console.error(`FAIL ${name}`); console.error(err); }
}

test('sample packet is UP / BUY_UP / ~0.62 / with_crowd / now / half', () => {
  const c = Desk.inferLocal(Desk.SAMPLE_PACKET, 'asi1_only');
  assert.strictEqual(c.call, 'UP');
  assert.strictEqual(c.action, 'BUY_UP');
  assert.strictEqual(c.regime, 'trend_continuation');
  assert.strictEqual(c.edge_vs_crowd, 'with_crowd');
  assert.strictEqual(c.urgency, 'now');
  assert.strictEqual(c.size_hint, 'half');
  assert.strictEqual(c.confidence, 0.62);
  assert.strictEqual(c.planner_on_5m, false);
  assert.ok(String(c.notes).startsWith('UP'));
  assert.deepStrictEqual(c.account_order, ['mauro', 'icloud', 'gitgoin']);
});

test('missing fields hold flat', () => {
  const c = Desk.inferLocal({ sym: 'ETH' }, 'asi1_only');
  assert.strictEqual(c.action, 'HOLD_FLAT');
  assert.strictEqual(c.size_hint, 'skip');
  assert.ok(c.warnings.length >= 1);
});

test('5m is mini and planner stays off', () => {
  const pkt = { ...Desk.SAMPLE_PACKET, horizon: '5m', secondsToClose: 40 };
  assert.strictEqual(Desk.selectModel(pkt, 'planner'), 'asi1-mini');
  assert.strictEqual(Desk.plannerAllowed(pkt, 'planner'), false);
  assert.strictEqual(Desk.selectModel(Desk.SAMPLE_PACKET, 'planner'), 'asi1');
  assert.strictEqual(Desk.plannerAllowed(Desk.SAMPLE_PACKET, 'planner'), true);
});

test('normalizeContract rejects illegal actions', () => {
  const c = Desk.normalizeContract({ action: 'YOLO', call: 'MAYBE', confidence: 80 }, 'asi1_only', Desk.SAMPLE_PACKET);
  assert.ok(Desk.ACTIONS.includes(c.action));
  assert.ok(['UP', 'DOWN', '—'].includes(c.call));
  assert.ok(c.confidence <= 1);
});

test('planner mode enables reasoning off 5m only; asi1_only never does', () => {
  const prev = orch.getMode();
  try {
    orch.setMode('asi1_only');
    assert.strictEqual(orch.plannerEnabled('5m'), false);
    assert.strictEqual(orch.plannerEnabled('15m'), false);
    orch.setMode('planner');
    assert.strictEqual(orch.plannerEnabled('5m'), false);
    assert.strictEqual(orch.plannerEnabled('15m'), true);
  } finally {
    orch.setMode(prev);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
