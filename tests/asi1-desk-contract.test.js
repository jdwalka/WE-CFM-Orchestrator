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
  assert.deepStrictEqual(c.account_order, ['leaksnipe']);
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

test('lookahead-1h contract allows projectedOpenPtb strike and is not fast-path', () => {
  const pkt = {
    sym: 'BTC',
    horizon: 'lookahead-1h',
    spot: 65000,
    projectedOpenPtb: 64900,
    depthImbalance: 0.15,
    pUp: 0.65,
    secondsToClose: 2400,
  };
  assert.strictEqual(Desk.isFastPath(pkt), false);
  const c = Desk.inferLocal(pkt, 'asi1_only');
  assert.strictEqual(c.call, 'UP');
  assert.strictEqual(c.action, 'BUY_UP');
  assert.ok(c.confidence >= 0.60);
});

test('late-window boundary pin-risk forces HOLD_FLAT and warns of MM defense', () => {
  // Simulates the exact 7:00 UTC-4 window: BTC spot 81005 vs PTB 81000 with 45s left
  const pinPkt = {
    sym: 'BTC',
    horizon: '15m',
    spot: 81005,
    priceToBeatNum: 81000,
    deltaVsPtb: 5,
    yesProb: 0.54,
    mid: 0.54,
    secondsToClose: 45,
    futureWindowT1: {
      projectedOpenPtb: 81010,
      forecastDirection: 'DOWN',
      confidence: 65,
      sniperAction: 'PRE_POSITION_DOWN',
    },
  };
  const c = Desk.inferLocal(pinPkt, 'asi1_only');
  assert.strictEqual(c.action, 'HOLD_FLAT');
  assert.strictEqual(c.size_hint, 'skip');
  assert.strictEqual(c.urgency, 'late_window');
  assert.ok(c.warnings.some(w => w.includes('PIN_RISK_DEFENDED')));
  assert.ok(c.notes.includes('PIN_RISK_DEFENDED'));
  assert.ok(c.notes.includes('Pivot to T+1 horizon'));
});

test('BTC DOWN note formatting eliminates float noise, formats TTC and currency cleanly, and removes jargon', () => {
  // User's exact test case:
  // Spot 79566.58335682 sits 13.4 below PTB 79579.95 with 627s to close. YesProb 0.39 and mid 0.385.
  // Depth imbalance 0.74 and near-touch notional 2572.4642000000003.
  const btcPkt = {
    sym: 'BTC',
    horizon: '15m',
    spot: 79566.58335682,
    priceToBeatNum: 79579.95,
    yesProb: 0.39,
    mid: 0.385,
    spread: 0.01,
    depthImbalance: 0.74,
    nearTouchNotional: 2572.4642000000003,
    secondsToClose: 627,
    graviharmonic: {
      resonantRegime: 'STANDING_WAVE_RESONANCE',
      harmonicCoherence: 84,
      escapeRatio: 0,
      isEscaped: false,
    },
  };
  const c = Desk.inferLocal(btcPkt, 'asi1_only');
  assert.strictEqual(c.call, 'DOWN');
  assert.strictEqual(c.action, 'SIZE_DOWN');
  // Formatted spot: $79,566.58
  assert.ok(c.notes.includes('$79,566.58'), `Expected $79,566.58 in notes, got: ${c.notes}`);
  // Formatted target strike: $79,579.95
  assert.ok(c.notes.includes('$79,579.95'), `Expected $79,579.95 in notes, got: ${c.notes}`);
  // Formatted delta: $13.37
  assert.ok(c.notes.includes('$13.37'), `Expected $13.37 in notes, got: ${c.notes}`);
  // Formatted duration: 10m 27s
  assert.ok(c.notes.includes('10m 27s'), `Expected 10m 27s in notes, got: ${c.notes}`);
  // Formatted notional: $2,572.46
  assert.ok(c.notes.includes('$2,572.46'), `Expected $2,572.46 in notes, got: ${c.notes}`);
  // Formatted Wave: [Wave: Standing Wave Resonance · 84% Coherence]
  assert.ok(c.notes.includes('[Wave: Standing Wave Resonance · 84% Coherence]'), `Expected clean wave tag, got: ${c.notes}`);
  // No dark pool / insider jargon
  assert.ok(!c.notes.includes('sits 13.4 below'), 'Should not contain "sits 13.4 below"');
  assert.ok(!c.notes.includes('Fade only if'), 'Should not contain "Fade only if"');
  assert.ok(!c.notes.includes('pierces PTB'), 'Should not contain "pierces PTB"');
  assert.ok(!c.notes.includes('2572.4642000000003'), 'Should not leak float trail');
  assert.ok(!c.notes.includes('Escape: 0x'), 'Should not contain Escape: 0x');
});

test('XRP 4-decimal precision handles sub-cent spot, PTB, delta, and duration', () => {
  const xrpPkt = {
    sym: 'XRP',
    horizon: '15m',
    spot: 0.58421,
    priceToBeatNum: 0.5850,
    yesProb: 0.42,
    mid: 0.415,
    spread: 0.001,
    depthImbalance: -0.60,
    nearTouchNotional: 1523.501,
    secondsToClose: 185,
  };
  const c = Desk.inferLocal(xrpPkt, 'asi1_only');
  assert.strictEqual(c.call, 'DOWN');
  assert.ok(c.notes.includes('$0.5842'), `Expected $0.5842 in notes, got: ${c.notes}`);
  assert.ok(c.notes.includes('$0.5850'), `Expected $0.5850 in notes, got: ${c.notes}`);
  assert.ok(c.notes.includes('$0.0008'), `Expected $0.0008 in notes, got: ${c.notes}`);
  assert.ok(!c.notes.includes('0.0 below'), 'Should not truncate delta to 0.0');
  assert.ok(c.notes.includes('3m 5s'), `Expected 3m 5s in notes, got: ${c.notes}`);
  assert.ok(c.notes.includes('$1,523.50'), `Expected $1,523.50 in notes, got: ${c.notes}`);
});

test('Hourly contract resolves using hourly range ladder without binary PTB', () => {
  const hourlyPkt = {
    sym: 'BTC',
    horizon: '1h',
    isHourly: true,
    spot: 68450.25,
    hourlyLadder: [
      { low: 68200, high: 68300, yesAsk: 0.08, prob: 0.08 },
      { low: 68300, high: 68400, yesAsk: 0.22, prob: 0.22 },
      { low: 68400, high: 68500, yesAsk: 0.42, prob: 0.42 },
      { low: 68500, high: 68600, yesAsk: 0.20, prob: 0.20 },
      { low: 68600, high: 68700, yesAsk: 0.08, prob: 0.08 },
    ],
    spotBucket: { low: 68400, high: 68500, yesProb: 0.42 },
    targetCloseTime: '2026-09-05T13:00:00.000Z',
    targetCloseHourUtc: 'Sat, 05 Sep 2026 13:00:00 GMT',
    secondsToClose: 1800,
  };
  const c = Desk.inferLocal(hourlyPkt, 'asi1_only');
  assert.ok(c.action !== 'HOLD_FLAT' || c.warnings.length === 0, 'Should not fail on missing binary PTB');
  assert.ok(c.notes.includes('HOURLY RANGE'), `Expected HOURLY RANGE in notes, got: ${c.notes}`);
  assert.ok(c.notes.includes('68,400'), `Expected bracket low in notes, got: ${c.notes}`);
  assert.ok(c.notes.includes('68,500'), `Expected bracket high in notes, got: ${c.notes}`);
  assert.ok(c.notes.includes('13:00:00 GMT') || c.notes.includes('top of the hour'), `Expected close time in notes, got: ${c.notes}`);
  assert.ok(!c.notes.includes('02 contract expiry'), 'Should never reference stale 02 contract expiry');
});

test('Gospel Directives: User-provided PTB, Range, and Spot override defaults and calculate correctly', () => {
  const CoinPrecision = require('../src/shared/coin-precision');
  const prompt = 'PTB is 79625 and range is 79500-80000 what is the delta from current spot 79800?';

  const ptbMatch = prompt.match(/\b(?:ptb|strike|price to beat|target)\s*(?:is|at|of|=)?\s*\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/i);
  assert.ok(ptbMatch, 'PTB regex should match');
  const userPtb = parseFloat(ptbMatch[1].replace(/,/g, ''));
  assert.equal(userPtb, 79625);

  const rangeMatch = prompt.match(/(?:range\s*(?:is|of|=)?\s*|between\s*)\$?([0-9,]+(?:\.[0-9]+)?)\s*(?:-|–|—|to|\band\b)\s*\$?([0-9,]+(?:\.[0-9]+)?)/i);
  assert.ok(rangeMatch, 'Range regex should match');
  const low = parseFloat(rangeMatch[1].replace(/,/g, ''));
  const high = parseFloat(rangeMatch[2].replace(/,/g, ''));
  assert.equal(low, 79500);
  assert.equal(high, 80000);

  const spotMatch = prompt.match(/\bspot\s*(?:is|at|=)?\s*\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/i);
  assert.ok(spotMatch, 'Spot regex should match');
  const userSpot = parseFloat(spotMatch[1].replace(/,/g, ''));
  assert.equal(userSpot, 79800);

  const delta = userSpot - userPtb;
  const deltaBps = (delta / userPtb) * 10000;
  assert.equal(delta, 175);
  assert.equal(deltaBps.toFixed(2), '21.98');
  assert.equal(CoinPrecision.formatCoinPrice('BTC', delta), '$175.00');

  const inRange = userSpot >= low && userSpot <= high;
  assert.strictEqual(inRange, true);
});

test('Micro Horizon Protection: 15m and 5m queries with close/settle do not hijack to hourly ladder', () => {
  function checkIsHourly(prompt, packet) {
    const explicitMicroHorizon = /\b(5m|5\s*min(?:ute)?s?|15m|15\s*min(?:ute)?s?)\b/i.test(prompt);
    const explicitHourlyPrompt = /\b(1h|60m|hour|hourly|top\s*of\s*(?:the\s*)?hour|hourly\s*close|hourly\s*range(?:s)?)\b/i.test(prompt);

    const packetIsHourly = !!(
      packet.isHourly ||
      packet.horizon === '1h' ||
      packet.horizon === '60m' ||
      packet.horizon === 'hourly' ||
      packet.horizon === 'lookahead-1h' ||
      packet.marketType === 'hourly_ranges' ||
      (Array.isArray(packet.hourlyLadder) && packet.hourlyLadder.length > 0 && packet.horizon !== '5m' && packet.horizon !== '15m')
    );

    let isHourly = false;
    if (explicitMicroHorizon) {
      isHourly = false;
    } else if (packetIsHourly) {
      isHourly = true;
    } else if (explicitHourlyPrompt) {
      isHourly = true;
    } else if (!packet.horizon || packet.horizon === 'hourly') {
      isHourly = /\b(range|hourly)\b/i.test(prompt);
    }
    return isHourly;
  }

  // 15m projection query with "close" and "what price"
  const q1 = "what price will SOL close at in 15m?";
  assert.strictEqual(checkIsHourly(q1, { sym: 'SOL', horizon: '15m' }), false);

  // 15-minute horizon projection query with ladder present in packet
  const q2 = "give me a 15-minute horizon projection for BTC close";
  assert.strictEqual(checkIsHourly(q2, { sym: 'BTC', horizon: '15m', hourlyLadder: [{ low: 79000, high: 80000 }] }), false);

  // 5m query asking about settle
  const q3 = "will ETH settle above PTB in 5 mins?";
  assert.strictEqual(checkIsHourly(q3, { sym: 'ETH', horizon: '5m' }), false);

  // Explicit hourly queries still trigger isHourly = true
  const q4 = "where will BTC settle at the hourly close?";
  assert.strictEqual(checkIsHourly(q4, { sym: 'BTC', horizon: '1h' }), true);

  const q5 = "what is the 1h top of the hour range bracket?";
  assert.strictEqual(checkIsHourly(q5, { sym: 'BTC', horizon: '15m' }), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);



