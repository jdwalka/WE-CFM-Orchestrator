#!/usr/bin/env node
'use strict';

const assistant = require('../src/llm/llm_signal_assistant');

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

// Also stress with a fat system prompt (production-sized) that used to empty content
const fatSys = `${sys}\n\n${'Context pad: use only Polymarket PTB + Pyth. '.repeat(40)}`;

(async () => {
  const t0 = Date.now();
  const res = await assistant.callTokenMixAPI(fatSys, user, {});
  console.log('OK ms', Date.now() - t0);
  console.log(JSON.stringify({
    call: res.call,
    confidence: res.confidence,
    provider: res._provider,
    model: res._model,
    thinking: res._tokenmixThinking,
    notes: String(res.suggestions?.notes || '').slice(0, 200),
  }, null, 2));
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
