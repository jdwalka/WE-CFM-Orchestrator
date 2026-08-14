#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const keyRaw = fs.readFileSync(path.join(__dirname, '..', 'secrets', 'tokenmix_api_key.txt'), 'utf8');
const key = (keyRaw.match(/sk-tm-[A-Za-z0-9_-]+/) || [])[0];
if (!key) {
  console.error('no tokenmix key');
  process.exit(1);
}

const sys = `You are DeepSeek for Polymarket. Return ONLY valid JSON:
{"call":"UP|DOWN","confidence":0.55,"regime":"chop_noise","suggestions":{"notes":"UP or DOWN then guidance"},"preContract":{"action":"BUY_UP","sizeHint":"half"}}
Rules: notes start with UP or DOWN. Bind to slug.`;

const user = `Coin: BTC
Spot (Pyth): 97432.12
PTB (Polymarket only): 97380.50 source=polymarket-chainlink
P(Up): 0.58
TTC: 412
depthImbalance: 0.12
spread: 0.02
bestBid/ask: 0.57/0.59
slug: btc-updown-15m-1786710600
Model score: 0.08
Hourly ladder top: [{"low":97000,"high":97500,"yesProb":0.22}]
Decide UP/DOWN for this 15m window. JSON only.`;

async function tryOnce(label, body) {
  const t0 = Date.now();
  const res = await fetch('https://api.tokenmix.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  console.log('\n==', label, 'status', res.status, 'ms', ms, 'bodyLen', text.length);
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.log('not json', text.slice(0, 300));
    return;
  }
  console.log('keys', Object.keys(data));
  const ch = data.choices && data.choices[0];
  console.log('choice keys', ch ? Object.keys(ch) : null, 'finish', ch && ch.finish_reason);
  const msg = ch && ch.message;
  console.log('msg keys', msg ? Object.keys(msg) : null);
  const c = msg && msg.content;
  console.log(
    'content type',
    c === null ? 'null' : typeof c,
    'len',
    c == null ? null : String(c).length,
    'preview',
    c == null ? null : String(c).slice(0, 200),
  );
  if (msg && msg.reasoning_content) {
    console.log('reasoning len', String(msg.reasoning_content).length);
  }
  if (msg && msg.reasoning) {
    console.log('reasoning(alt) len', String(msg.reasoning).length);
  }
}

(async () => {
  // Default production path: thinking OFF (avoids empty content when
  // reasoning_tokens exhaust max_tokens on large specialized prompts).
  await tryOnce('no_thinking', {
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_tokens: 1600,
    stream: false,
    enable_thinking: false,
  });
  await tryOnce('json_mode_no_think', {
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_tokens: 1600,
    stream: false,
    response_format: { type: 'json_object' },
    enable_thinking: false,
  });
  await tryOnce('thinking_on_budget', {
    model: 'deepseek/deepseek-v4-flash',
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_tokens: 4500,
    stream: false,
  });
  await tryOnce('short_id', {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: `${user}\nJSON only.` }],
    temperature: 0.1,
    max_tokens: 800,
    stream: false,
    enable_thinking: false,
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
