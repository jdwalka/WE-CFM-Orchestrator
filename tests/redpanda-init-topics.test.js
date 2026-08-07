const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Structural/static checks only — deliberately does NOT require() the module,
// since it imports kafkajs (a real npm dependency, not always installed in
// every environment this test runs in) and needs no live broker to verify
// the Grok tick topic is defined correctly and kept separate from the
// existing orbital s/p/d/f topics (different signal types, see the module's
// own comments).
const modulePath = path.join(__dirname, '..', 'scripts', 'redpanda-init-topics.js');
const src = fs.readFileSync(modulePath, 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

console.log('\n[redpanda-init-topics] structural checks');

test('exports createOrbitalTopics, createGrokTopics, and createAllTopics', () => {
  const exportsMatch = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(exportsMatch, 'could not locate module.exports block');
  const exported = exportsMatch[1];
  for (const name of ['createOrbitalTopics', 'createGrokTopics', 'createAllTopics']) {
    assert.ok(exported.includes(name), `expected module.exports to include ${name}`);
    assert.ok(src.includes(`async function ${name}`), `expected an async function ${name} to be defined`);
  }
});

test('grok tick topic is separate from the 4 orbital s/p/d/f topics', () => {
  assert.ok(src.includes("'wecrypto.grok.ticks'"), 'expected the Grok tick topic name to be present');
  assert.ok(src.includes("'wecrypto.orbital.s'"), 'orbital topics should be untouched');
  assert.ok(src.includes("'wecrypto.orbital.p'"), 'orbital topics should be untouched');
  assert.ok(src.includes("'wecrypto.orbital.d'"), 'orbital topics should be untouched');
  assert.ok(src.includes("'wecrypto.orbital.f'"), 'orbital topics should be untouched');

  const orbitalArrayMatch = src.match(/const ORBITAL_TOPICS = \[([\s\S]*?)\n\];/);
  assert.ok(orbitalArrayMatch, 'could not locate ORBITAL_TOPICS array in source');
  assert.ok(!orbitalArrayMatch[1].includes('wecrypto.grok.ticks'), 'grok topic must not be inside ORBITAL_TOPICS');

  const grokArrayMatch = src.match(/const GROK_TOPICS = \[([\s\S]*?)\n\];/);
  assert.ok(grokArrayMatch, 'could not locate GROK_TOPICS array in source');
  assert.ok(grokArrayMatch[1].includes('wecrypto.grok.ticks'), 'GROK_TOPICS should define the grok tick topic');
  for (const orbitalTopic of ['wecrypto.orbital.s', 'wecrypto.orbital.p', 'wecrypto.orbital.d', 'wecrypto.orbital.f']) {
    assert.ok(!grokArrayMatch[1].includes(orbitalTopic), `GROK_TOPICS must not include ${orbitalTopic}`);
  }
});

test('standalone execution block calls createAllTopics (not just createOrbitalTopics)', () => {
  const mainBlockMatch = src.match(/if \(require\.main === module\) \{([\s\S]*?)\n\}/);
  assert.ok(mainBlockMatch, 'could not locate require.main === module block');
  assert.ok(mainBlockMatch[1].includes('createAllTopics()'), 'standalone execution should create both orbital and grok topics');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
