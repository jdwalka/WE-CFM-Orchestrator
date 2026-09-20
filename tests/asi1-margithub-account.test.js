const assert = require('assert');
const fs = require('fs');
const os = require('os');
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

test('only margithub@icloud.com is configured', () => {
  assert.deepStrictEqual(
    Asi1.ASI1_ACCOUNTS.map((account) => ({ id: account.id, email: account.email })),
    [{ id: 'margithub', email: 'margithub@icloud.com' }],
  );
});

test('margithub key roles split 5m, 15m, and overall inference', () => {
  const token5m = `sk_${'f'.repeat(64)}`;
  const token15m = `sk_${'e'.repeat(64)}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asi1-margithub-'));
  const previousCwd = process.cwd();
  const previousEnv = process.env.ASI1_API_KEY_MARGITHUB;
  fs.mkdirSync(path.join(tempDir, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'secrets', 'ASI1_MARGITHUB.txt'), [
    '# account: margithub',
    '# email: margithub@icloud.com',
    '# role: 5m',
    token5m,
    '# role: 15m,overall',
    token15m,
    '',
  ].join('\n'));
  try {
    process.chdir(tempDir);
    process.env.ASI1_API_KEY_MARGITHUB = token5m;
    const rows = Asi1.resolveAsi1ApiKeys(true)
      .filter(row => row.value === token5m || row.value === token15m);
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows[0], { env: 'file:ASI1_MARGITHUB.txt', value: token5m, account: 'margithub', email: 'margithub@icloud.com', roles: ['5m'] });
    assert.deepStrictEqual(rows[1].roles, ['15m', 'overall']);
    for (const row of rows) {
      assert.strictEqual(row.account, 'margithub');
      assert.strictEqual(row.email, 'margithub@icloud.com');
    }
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) delete process.env.ASI1_API_KEY_MARGITHUB;
    else process.env.ASI1_API_KEY_MARGITHUB = previousEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
    Asi1.resolveAsi1ApiKeys(true);
  }
});

test('model roster and candidates remain valid', () => {
  assert.deepStrictEqual(Asi1.ASI1_OFFICIAL_MODELS, ['asi1-ultra', 'asi1', 'asi1-mini']);
  assert.ok(Asi1.ASI1_ALL_MODELS.includes('asi1-fast'));
  assert.strictEqual(Asi1.resolveModelForTier('ultra'), 'asi1-ultra');
  assert.deepStrictEqual(Asi1.defaultCandidateModels('asi1-mini', 'quick'), ['asi1-mini', 'asi1']);
  assert.strictEqual(orch.rosterFor({ model: 'asi1-ultra' })[0], 'asi1-ultra');
});

test('diagnostics expose the single account without leaking key material', () => {
  const diagnostics = Asi1.getDiagnostics();
  const serialized = JSON.stringify(diagnostics);
  assert.ok(!serialized.includes('sk_'));
  assert.ok(Array.isArray(diagnostics.officialModels));
  assert.strictEqual(typeof diagnostics.plannerMode, 'boolean');
  if (diagnostics.keysConfigured >= 1) assert.ok(diagnostics.configured);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
