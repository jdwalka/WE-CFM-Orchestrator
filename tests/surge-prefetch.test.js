'use strict';
const assert = require('assert');
const path = require('path');
const surge = require(path.join(__dirname, '..', 'src', 'feeds', 'surge-prefetch.js'));

function ticksFromReturns(startPx, steps) {
  // steps: [{dt, ret}] sequential from t=0
  const out = [{ t: 1_000_000, px: startPx }];
  let t = 1_000_000;
  let px = startPx;
  for (const s of steps) {
    t += s.dt;
    px = px * (1 + s.ret);
    out.push({ t, px });
  }
  return { ticks: out, now: t };
}

// Quiet tape — no surge
{
  const ctx = ticksFromReturns(4000, [
    { dt: 2000, ret: 0.00005 },
    { dt: 2000, ret: -0.00004 },
    { dt: 2000, ret: 0.00003 },
    { dt: 2000, ret: -0.00002 },
    { dt: 2000, ret: 0.00004 },
  ]);
  const v = surge.evaluate('ETH', ctx);
  assert.strictEqual(v.active, false, 'quiet tape should not flag');
}

// Vertical lift while still under PTB — the fade-DOWN trap
{
  const ctx = ticksFromReturns(3998, [
    { dt: 5000, ret: 0.00005 },
    { dt: 5000, ret: 0.00008 },
    { dt: 3000, ret: 0.00012 },
    { dt: 3000, ret: 0.00045 },
    { dt: 3000, ret: 0.00080 },
    { dt: 3000, ret: 0.00110 },
  ]);
  ctx.spot = ctx.ticks[ctx.ticks.length - 1].px;
  ctx.ptb = 4008; // still below floor
  const v = surge.evaluate('ETH', ctx);
  assert.ok(v.active, 'expansion must be active');
  assert.strictEqual(v.side, 'UP', 'lift is UP');
  const fight = surge.against('DOWN', 'ETH', ctx);
  assert.ok(fight.action === 'flip' || fight.action === 'wait', `must veto fade, got ${fight.action}`);
}

// Short-squeeze tag alone is enough to lean UP
{
  const ctx = ticksFromReturns(2500, [
    { dt: 4000, ret: 0.0002 },
    { dt: 4000, ret: 0.0003 },
  ]);
  ctx.squeeze = { type: 'short_squeeze', severity: 'high', direction: 'up' };
  const v = surge.evaluate('ETH', ctx);
  assert.ok(v.score > 0, 'squeeze should score UP');
}

// Prefetched bid wall + negative funding should lean UP before a fade
{
  const ctx = ticksFromReturns(2400, [
    { dt: 4000, ret: 0.00015 },
    { dt: 4000, ret: 0.00020 },
  ]);
  ctx.desk = {
    book: {
      imbalance: 0.42,
      bidWall: { qty: 800, price: 2399 },
      askWall: { qty: 80, price: 2401 },
    },
    funding: -0.04,
    oiDeltaPct: -0.8,
  };
  ctx.bookImb = 0.42;
  const v = surge.evaluate('ETH', ctx);
  assert.ok(v.score > 0, 'prefetched book+funding must lean UP');
}

console.log('surge-prefetch.test.js ok');
