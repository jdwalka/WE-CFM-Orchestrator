#!/usr/bin/env node
// ================================================================
// WECRYPTO — Derivatives / Options / Prediction-Edge Backtest
//
// Joins the forward-collected signal spools written by the new feeds
//   derivatives.jsonl       (src/feeds/derivatives-feed.js)
//   options.jsonl           (src/feeds/options-gamma-feed.js)
//   prediction_edge.jsonl   (src/kalshi/prediction-market-edge.js)
// against settled Kalshi outcomes
//   resolver_outcomes.jsonl (preferred) / hourly_kalshi.jsonl (fallback)
// using an as-of join (latest signal snapshot at-or-before each entry,
// within a staleness window), then grades each signal's directional
// lean vs the realized up/down outcome.
//
// These signals are real-time-only — no historical store exists, so this
// harness becomes meaningful only after the live app has collected a few
// days of spools. With no data yet it prints a READINESS CHECK (where it
// looked, what it found) and exits 0.
//
// Usage:
//   node backtest/derivatives-edge-backtest.js
//   node backtest/derivatives-edge-backtest.js --days 14 --coins BTC,ETH,SOL,XRP
//   node backtest/derivatives-edge-backtest.js --data-root "H:\\My Drive\\WECRYP\\data" --staleness 20
//   node backtest/derivatives-edge-backtest.js --json > deriv-edge-report.json
// ================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── CLI ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { days: 30, coins: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'], staleness: 15, minSamples: 20, json: false, dataRoot: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') a.days = parseInt(argv[++i], 10);
    else if (arg === '--coins') a.coins = String(argv[++i]).toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--staleness') a.staleness = parseFloat(argv[++i]);     // minutes
    else if (arg === '--min-samples') a.minSamples = parseInt(argv[++i], 10);
    else if (arg === '--data-root') a.dataRoot = argv[++i];
    else if (arg === '--json') a.json = true;
  }
  return a;
}

// ── data root discovery (mirrors src/core/data-logger.js spool paths) ──
function candidateRoots(explicit) {
  const roots = [];
  if (explicit) roots.push(explicit);
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  roots.push(path.join(localAppData, 'WECRYP', 'data-spool'));
  roots.push('C:\\WECRYP\\data-spool');
  // Google Drive mirrors used by DataLogger
  for (const drive of ['H:', 'I:', 'G:', 'J:']) {
    roots.push(`${drive}\\My Drive\\WECRYP\\data`);
  }
  // repo-local fallback (useful for tests / copied datasets)
  roots.push(path.join(__dirname, '..', 'WECRYP0-data', 'data-spool'));
  return [...new Set(roots)].filter(r => { try { return fs.existsSync(r); } catch { return false; } });
}

function dayFolders(root, days) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const cutoff = Date.now() - days * 86400_000;
  return entries
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .filter(e => {
      const t = Date.parse(e.name + 'T00:00:00Z');
      return Number.isFinite(t) && t >= cutoff - 86400_000; // include boundary day
    })
    .map(e => path.join(root, e.name))
    .sort();
}

function loadJsonl(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* tolerate partial trailing line */ }
  }
  return out;
}

// Collect a category across all roots+days, deduped loosely by (sym|ts).
function collectCategory(roots, days, category) {
  const rows = [];
  const seen = new Set();
  for (const root of roots) {
    for (const folder of dayFolders(root, days)) {
      for (const r of loadJsonl(path.join(folder, `${category}.jsonl`))) {
        const ts = Number(r.ts ?? r.closeTimeMs ?? 0);
        const key = `${r.sym || r.symbol || '?'}|${ts}|${category}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(r);
      }
    }
  }
  return rows;
}

// ── outcome normalization → realized direction (+1 up / -1 down) ──
function realizedDirection(o) {
  // resolver_outcomes: { outcome: 'yes'|'no'|'up'|'down', strikeDir: 'above'|'below' }
  // hourly_kalshi:     { outcome: 'yes'|'no'|..., kalshiYes }
  let v = o.outcome ?? o.actualOutcome ?? o.result;
  if (v == null) return 0;
  v = String(v).toLowerCase();
  let up;
  if (v === 'yes' || v === 'up' || v === 'true' || v === 'win') up = true;
  else if (v === 'no' || v === 'down' || v === 'false' || v === 'loss') up = false;
  else return 0;
  // A "below" strike resolving YES means price stayed under → bearish realized direction.
  if (String(o.strikeDir || '').toLowerCase() === 'below') up = !up;
  return up ? 1 : -1;
}
function outcomeEntryTs(o) {
  // Prefer the signal-relevant entry time; close time is the resolution moment.
  return Number(o.entryTs ?? o.ts ?? o.closeTimeMs ?? 0);
}

// ── as-of join: latest signal at-or-before entryTs within staleness ──
function indexBySym(rows) {
  const m = new Map();
  for (const r of rows) {
    const sym = r.sym || r.symbol;
    if (!sym) continue;
    const ts = Number(r.ts ?? 0);
    if (!ts) continue;
    if (!m.has(sym)) m.set(sym, []);
    m.get(sym).push({ ts, r });
  }
  for (const arr of m.values()) arr.sort((a, b) => a.ts - b.ts);
  return m;
}
function asOf(index, sym, entryTs, stalenessMs) {
  const arr = index.get(sym);
  if (!arr || !arr.length) return null;
  // binary search for last ts <= entryTs
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts <= entryTs) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  if (entryTs - arr[best].ts > stalenessMs) return null;
  return arr[best].r;
}

// ── feature extractors: each returns a directional lean (+1/-1/0) ──
// Sign conventions match the signal packets added in predictions.js.
const FEATURES = [
  { name: 'deriv_pressure',   src: 'deriv', lean: r => sign(r.pressure, 0.15) },
  { name: 'liq_imbalance',    src: 'deriv', lean: r => sign(r.liqImbalance, 0.6) },     // short liq → up
  { name: 'oi_delta',         src: 'deriv', lean: r => sign(r.oiDeltaPct, 1.5) },        // exploratory (not inherently directional)
  { name: 'options_rr25',     src: 'opt',   lean: r => sign(r.riskReversal25, 1.5) },    // call skew → up
  { name: 'pm_divergence',    src: 'edge',  lean: r => -sign(r.divergencePp, 4) },        // fade richer venue
];
function sign(v, thresh) {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(v) < thresh) return 0;
  return v > 0 ? 1 : -1;
}

// Wilson lower bound (95%) — penalizes small samples so noise doesn't look like edge.
function wilsonLB(wins, n) {
  if (n === 0) return 0;
  const z = 1.96, p = wins / n;
  const denom = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return (centre - margin) / denom;
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }

// ── main ─────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  const roots = candidateRoots(args.dataRoot);
  const stalenessMs = args.staleness * 60_000;

  if (!roots.length) {
    return readiness(args, [], { deriv: 0, opt: 0, edge: 0, outcomes: 0 }, 'No WECRYP data-spool root found.');
  }

  const deriv = collectCategory(roots, args.days, 'derivatives');
  const opt = collectCategory(roots, args.days, 'options');
  const edge = collectCategory(roots, args.days, 'prediction_edge');
  let outcomes = collectCategory(roots, args.days, 'resolver_outcomes');
  if (!outcomes.length) outcomes = collectCategory(roots, args.days, 'hourly_kalshi');

  const counts = { deriv: deriv.length, opt: opt.length, edge: edge.length, outcomes: outcomes.length };

  if (!outcomes.length || (!deriv.length && !opt.length && !edge.length)) {
    return readiness(args, roots, counts, 'Not enough collected data yet to score.');
  }

  const idx = { deriv: indexBySym(deriv), opt: indexBySym(opt), edge: indexBySym(edge) };

  // tally[feature] = { wins, total, byStrength: {...} }
  const tally = {};
  for (const f of FEATURES) tally[f.name] = { wins: 0, total: 0, neutral: 0 };

  let graded = 0;
  for (const o of outcomes) {
    const sym = o.sym || o.symbol;
    if (!sym || !args.coins.includes(sym)) continue;
    const dir = realizedDirection(o);
    if (dir === 0) continue;
    const entryTs = outcomeEntryTs(o);
    if (!entryTs) continue;

    const snaps = {
      deriv: asOf(idx.deriv, sym, entryTs, stalenessMs),
      opt: asOf(idx.opt, sym, entryTs, stalenessMs),
      edge: asOf(idx.edge, sym, entryTs, stalenessMs),
    };
    let used = false;
    for (const f of FEATURES) {
      const snap = snaps[f.src];
      if (!snap) continue;
      const lean = f.lean(snap);
      if (lean === 0) { tally[f.name].neutral++; continue; }
      tally[f.name].total++;
      if (lean === dir) tally[f.name].wins++;
      used = true;
    }
    if (used) graded++;
  }

  // ── report ──
  const rows = FEATURES.map(f => {
    const t = tally[f.name];
    const hit = t.total ? t.wins / t.total : 0;
    return {
      feature: f.name,
      samples: t.total,
      neutral: t.neutral,
      hitRate: hit,
      wilsonLB: wilsonLB(t.wins, t.total),
      edgePp: t.total ? (hit - 0.5) * 100 : 0,
      verdict: t.total < args.minSamples ? 'INSUFFICIENT' : wilsonLB(t.wins, t.total) > 0.5 ? 'EDGE' : 'no edge',
    };
  });

  if (args.json) {
    process.stdout.write(JSON.stringify({ args: { days: args.days, coins: args.coins, stalenessMin: args.staleness }, roots, counts, gradedOutcomes: graded, features: rows }, null, 2) + '\n');
    return;
  }

  console.log('\n  WECRYPTO — Derivatives / Options / Edge Backtest');
  console.log('  ' + '─'.repeat(70));
  console.log(`  roots          : ${roots.length} (${roots[0]}${roots.length > 1 ? ' …' : ''})`);
  console.log(`  window         : last ${args.days}d   coins: ${args.coins.join(',')}   staleness: ${args.staleness}m`);
  console.log(`  spool rows     : derivatives=${counts.deriv}  options=${counts.opt}  edge=${counts.edge}  outcomes=${counts.outcomes}`);
  console.log(`  graded entries : ${graded}`);
  console.log('  ' + '─'.repeat(70));
  console.log('  feature           samples  hit-rate   WilsonLB   edge(pp)  verdict');
  for (const r of rows) {
    console.log(
      '  ' + r.feature.padEnd(17) +
      String(r.samples).padStart(6) + '   ' +
      pct(r.hitRate).padStart(7) + '   ' +
      pct(r.wilsonLB).padStart(7) + '   ' +
      (r.edgePp >= 0 ? '+' : '') + r.edgePp.toFixed(1).padStart(5) + '   ' +
      r.verdict
    );
  }
  console.log('  ' + '─'.repeat(70));
  console.log('  WilsonLB > 50% = directional edge survives small-sample skepticism.');
  console.log('  oi_delta is exploratory (not inherently directional) — read as a covariate.\n');
}

function readiness(args, roots, counts, reason) {
  if (args.json) {
    process.stdout.write(JSON.stringify({ status: 'readiness', reason, roots, counts }, null, 2) + '\n');
    return;
  }
  console.log('\n  WECRYPTO — Derivatives / Options / Edge Backtest — READINESS CHECK');
  console.log('  ' + '─'.repeat(70));
  console.log(`  ${reason}`);
  console.log('  This is expected before the live app has collected spool history.\n');
  console.log('  Searched roots:');
  if (roots.length) roots.forEach(r => console.log(`    • ${r}`));
  else {
    console.log('    (none found) — expected one of:');
    console.log(`    • ${path.join(process.env.LOCALAPPDATA || '%LOCALAPPDATA%', 'WECRYP', 'data-spool')}`);
    console.log('    • H:\\My Drive\\WECRYP\\data');
  }
  console.log('\n  Rows found so far:');
  console.log(`    derivatives=${counts.deriv}  options=${counts.opt}  prediction_edge=${counts.edge}  outcomes=${counts.outcomes}`);
  console.log('\n  Next: run the live app for a few days, then re-run this script.\n');
}

main();
