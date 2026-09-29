#!/usr/bin/env node
'use strict';
const sp = require('../src/llm/specialized_prompt');

const cases = [
  ['SOL', 'above the Polymarket PTB of $75.44527553043135. With only 197 seconds', '$75.45'],
  ['BTC', 'Live direction reads UP against Polymarket PTB $62814.80096237142 with 257s', '$62,814.80'],
  ['XRP', 'XRP PTB of 2.123456789 holds', '$2.1235'],
  ['SOL', 'clean already $75.45 stays', '$75.45'],
];

let failed = 0;
for (const [coin, dirty, expect] of cases) {
  const out = sp.scrubMoneyFloatsInText(dirty, coin);
  const ok = out.includes(expect) && !/\.\d{5,}/.test(out.replace(/,/g, ''));
  console.log(ok ? 'OK ' : 'FAIL', coin, '→', out);
  if (!ok) failed++;
}

const snap = sp.sanitizeOracleSnapshot({
  coin: 'SOL',
  fiveMinute: true,
  horizonMinutes: 5,
  currentPrice: 75.50123456,
  poly5m: {
    slug: 'sol-updown-5m-1',
    priceToBeatNum: 75.44527553043135,
    priceToBeatSource: 'polymarket-chainlink-candles',
  },
});
console.log('sanitize', snap.priceToBeatNum, snap.targetPrice);
if (snap.priceToBeatNum !== 75.45) failed++;

process.exit(failed ? 1 : 0);
