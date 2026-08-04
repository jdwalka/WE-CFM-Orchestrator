#!/usr/bin/env node
/**
 * Verify secrets/XAI_API_KEY.txt (or XAI_API_KEY env) against api.x.ai
 * Usage: node tools/verify-xai-key.js
 *        node tools/verify-xai-key.js --model grok-4.5
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const modelArg = (() => {
  const i = process.argv.indexOf('--model');
  return i >= 0 ? process.argv[i + 1] : (process.env.XAI_MODEL || 'grok-4.5');
})();

function loadKey() {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY.trim();
  if (process.env.GROK_API_KEY) return process.env.GROK_API_KEY.trim();
  const file = path.join(root, 'secrets', 'XAI_API_KEY.txt');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const matches = [...raw.matchAll(/xai-[A-Za-z0-9_-]+/gi)].map((m) => m[0]);
  // Prefer last key in multi-key files
  return matches.length ? matches[matches.length - 1] : null;
}

async function main() {
  const key = loadKey();
  if (!key) {
    console.error('FAIL: no xai- key found in secrets/XAI_API_KEY.txt or XAI_API_KEY env');
    process.exit(1);
  }
  console.log('key_prefix:', key.slice(0, 8) + '…', 'len:', key.length);
  console.log('model:', modelArg);

  const modelsRes = await fetch('https://api.x.ai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  const modelsBody = await modelsRes.text();
  console.log('GET /v1/models →', modelsRes.status);
  if (modelsRes.status !== 200) {
    console.log(modelsBody.slice(0, 400));
    if (modelsRes.status === 403 && /credits/i.test(modelsBody)) {
      console.error('Team has no API credits — fund https://console.x.ai');
    } else if (modelsRes.status === 400 || modelsRes.status === 401) {
      console.error('Key rejected — create a new key at console.x.ai and replace secrets/XAI_API_KEY.txt');
    }
    process.exit(1);
  }
  console.log('models: OK');

  const chatRes = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelArg,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly: GROK_OK' }],
    }),
  });
  const chatBody = await chatRes.text();
  console.log('POST /v1/chat/completions →', chatRes.status);
  if (chatRes.status !== 200) {
    console.log(chatBody.slice(0, 500));
    process.exit(1);
  }
  let content = '';
  try {
    content = JSON.parse(chatBody)?.choices?.[0]?.message?.content || '';
  } catch (_) {
    content = chatBody.slice(0, 120);
  }
  console.log('reply:', String(content).slice(0, 120));
  console.log('SUCCESS — key + credits + model work. Hard-restart Electron to load into WECRYPTO.');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
