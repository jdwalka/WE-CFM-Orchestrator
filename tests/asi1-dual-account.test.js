const assert = require('assert');
const path = require('path');

const clientPath = path.join(__dirname, '..', 'src', 'infra', 'asi1-client.js');
delete require.cache[require.resolve(clientPath)];
const Asi1 = require(clientPath);
const orch = require(path.join(__dirname, '..', 'src', 'llm', 'asi1-credit-orchestrator.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (err) { failed += 1; console.error(`FAIL ${name}`); console.error(err); }
}

test('official docs roster is ultra + asi1 + mini; fast is extra', () => {
  assert.deepStrictEqual(Asi1.ASI1_OFFICIAL_MODELS, ['asi1-ultra', 'asi1', 'asi1-mini']);
  assert.ok(Asi1.ASI1_ALL_MODELS.includes('asi1-fast'));
  assert.ok(Asi1.ASI1_ACCOUNTS.some((a) => a.email === 'mauro_fanelli@icloud.com'));
  assert.ok(Asi1.ASI1_ACCOUNTS.some((a) => a.email === 'maurofanellijr@gmail.com'));
  assert.ok(Asi1.ASI1_ACCOUNTS.some((a) => a.email === 'gitgoin87@gmail.com'));
  assert.strictEqual(Asi1.ASI1_ACCOUNTS[0].id, 'mauro');
});

test('secret labels map to the two Gmail accounts', () => {
  assert.deepStrictEqual(Asi1.inferAccountFromLabel('GITGOIN87_2026-08-14'), {
    account: 'gitgoin',
    email: 'gitgoin87@gmail.com',
  });
  assert.deepStrictEqual(Asi1.inferAccountFromLabel('# account=maurofanellijr@gmail.com'), {
    account: 'mauro',
    email: 'maurofanellijr@gmail.com',
  });
  assert.strictEqual(Asi1.inferAccountFromLabel('prompt_TEACHING'), null);
  assert.ok(Asi1.extractAsi1KeyValue('ASI1_API=sk_abc123').startsWith('sk_'));
});

test('deep tier prefers ultra; quick prefers mini', () => {
  assert.strictEqual(Asi1.resolveModelForTier('ultra'), 'asi1-ultra');
  assert.strictEqual(Asi1.resolveModelForTier('mini'), process.env.ASI1_QUICK_TICK_MODEL || 'asi1-mini');
});

test('default candidates put requested model first then the rest of the roster', () => {
  const list = Asi1.defaultCandidateModels('asi1-mini', 'quick');
  assert.strictEqual(list[0], 'asi1-mini');
  assert.ok(list.includes('asi1-ultra') && list.includes('asi1'));
});

test('orchestrator roster matches client all-models', () => {
  const r = orch.rosterFor({ model: 'asi1-ultra' });
  assert.strictEqual(r[0], 'asi1-ultra');
  for (const m of Asi1.ASI1_ALL_MODELS) assert.ok(r.includes(m));
});

test('diagnostics expose accounts without leaking key material', () => {
  const d = Asi1.getDiagnostics();
  assert.ok(!JSON.stringify(d).includes('sk_'));
  assert.ok(Array.isArray(d.officialModels));
  assert.strictEqual(typeof d.plannerMode, 'boolean');
  if (d.keysConfigured >= 1) {
    assert.ok(d.configured);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
