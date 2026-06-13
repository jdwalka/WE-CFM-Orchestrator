#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'backtest-logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) { }

const SERIES_BY_COIN = {
  BTC: 'KXBTC15M',
  ETH: 'KXETH15M',
  SOL: 'KXSOL15M',
  XRP: 'KXXRP15M',
};

const args = process.argv.slice(2);
const getArg = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const coins = String(getArg('--coins', 'BTC,ETH,SOL,XRP'))
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter((s) => SERIES_BY_COIN[s]);
const daysBack = Math.max(1, parseInt(getArg('--days', '7'), 10));
const trainSize = Math.max(20, parseInt(getArg('--train', '120'), 10));
const testSize = Math.max(10, parseInt(getArg('--test', '40'), 10));
const stepSize = Math.max(5, parseInt(getArg('--step', '20'), 10));
const minTradesPerFold = Math.max(5, parseInt(getArg('--min-trades', '12'), 10));
const maxPages = Math.max(1, parseInt(getArg('--max-pages', '8'), 10));

const EDGES = Array.from({ length: 20 }, (_, i) => +(0.01 * (i + 1)).toFixed(2)); // 0.01..0.20

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const avg = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function fetchJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'WECRYPTO-KalshiOddsWalkForward/1.0',
      },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout ${timeoutMs}ms ${url}`));
    });
  });
}

function buildUrl(pathname, params = {}) {
  const u = new URL(`${KALSHI_BASE}${pathname}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') u.searchParams.set(k, String(v));
  });
  return u.toString();
}

function parseMs(ts) {
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : null;
}

function mapStrikeDir(market) {
  const raw = String(market.strike_type || '').toLowerCase();
  if (raw === 'below' || raw === 'under') return 'below';
  if (raw === 'above' || raw === 'over' || raw === 'at_least' || raw === 'greater_or_equal') return 'above';
  const txt = String(market.yes_sub_title || market.title || '').toLowerCase();
  return (txt.includes('below') || txt.includes('under')) ? 'below' : 'above';
}

function marketOutcomeDirection(market) {
  const strikeDir = mapStrikeDir(market);
  const yesDir = strikeDir === 'below' ? 'DOWN' : 'UP';
  const res = String(market.result || '').toLowerCase();
  if (res !== 'yes' && res !== 'no') return null;
  return res === 'yes' ? yesDir : (yesDir === 'UP' ? 'DOWN' : 'UP');
}

function getMarketMidProb(market) {
  const pyb = parseFloat(market.previous_yes_bid_dollars || 0);
  const pya = parseFloat(market.previous_yes_ask_dollars || 0);
  const yb = parseFloat(market.yes_bid_dollars || 0);
  const ya = parseFloat(market.yes_ask_dollars || 0);
  const lp = parseFloat(market.last_price_dollars || 0);
  if (pyb > 0 && pya > 0) return (pyb + pya) / 2;
  if (pya > 0) return pya;
  if (pyb > 0) return pyb;
  if (yb > 0 && ya > 0) return (yb + ya) / 2;
  if (ya > 0) return ya;
  if (yb > 0) return yb;
  if (lp > 0) return lp;
  return null;
}

async function fetchLastTradeYesProb(ticker) {
  try {
    const url = buildUrl('/markets/trades', { ticker, limit: 1 });
    const data = await fetchJson(url, 10000);
    const t = (data.trades || [])[0];
    if (!t) return null;
    const y = parseFloat(t.yes_price_dollars || 0);
    return y > 0 ? y : null;
  } catch (_) {
    return null;
  }
}

async function fetchSettledContracts(coin, sinceMs) {
  const series = SERIES_BY_COIN[coin];
  const contracts = [];
  let cursor = null;
  let stalePages = 0;

  for (let page = 0; page < maxPages; page++) {
    const url = buildUrl('/markets', {
      series_ticker: series,
      status: 'settled',
      limit: 200,
      cursor,
    });
    const data = await fetchJson(url);
    const markets = Array.isArray(data.markets) ? data.markets : [];
    if (!markets.length) break;

    let inRangeCount = 0;
    for (const m of markets) {
      const closeMs = parseMs(m.close_time);
      if (!closeMs || closeMs < sinceMs) continue;
      inRangeCount++;

      const actual = marketOutcomeDirection(m);
      if (!actual) continue;
      const strikeDir = mapStrikeDir(m);
      let yesProb = getMarketMidProb(m);
      if (yesProb == null) {
        yesProb = await fetchLastTradeYesProb(m.ticker);
      }
      if (yesProb == null) continue;

      yesProb = clamp(yesProb, 0.01, 0.99);
      const probUp = strikeDir === 'below' ? 1 - yesProb : yesProb;

      contracts.push({
        coin,
        series,
        ticker: m.ticker,
        closeTime: m.close_time,
        closeMs,
        strikeDir,
        result: m.result,
        actual,
        yesProb,
        probUp,
        volume: parseFloat(m.volume_fp || 0),
        liquidity: parseFloat(m.liquidity_dollars || 0),
      });
    }

    if (inRangeCount === 0) stalePages++;
    else stalePages = 0;
    if (stalePages >= 2) break;

    if (!data.cursor) break;
    cursor = data.cursor;
  }

  contracts.sort((a, b) => a.closeMs - b.closeMs);
  return contracts;
}

function evaluateContracts(contracts, edge) {
  const active = contracts.filter((c) => Math.abs(c.probUp - 0.5) >= edge);
  if (!active.length) {
    return { edge, count: 0, wins: 0, winRate: 0, coverage: 0 };
  }
  let wins = 0;
  for (const c of active) {
    const pred = c.probUp >= 0.5 ? 'UP' : 'DOWN';
    if (pred === c.actual) wins++;
  }
  return {
    edge,
    count: active.length,
    wins,
    winRate: (wins / active.length) * 100,
    coverage: (active.length / contracts.length) * 100,
  };
}

function calibrateEdge(trainContracts) {
  let best = null;
  for (const edge of EDGES) {
    const s = evaluateContracts(trainContracts, edge);
    if (s.count < minTradesPerFold) continue;
    const score = (s.winRate - 50) * 2 + Math.log(Math.max(s.count, 1));
    if (!best || score > best.score) best = { ...s, score };
  }
  if (best) return best;
  const fallback = evaluateContracts(trainContracts, 0.05);
  return { ...fallback, score: -Infinity };
}

function walkForwardRetune(contracts) {
  if (contracts.length < trainSize + testSize + stepSize) return null;
  const folds = [];
  for (let start = 0; start + trainSize + testSize <= contracts.length; start += stepSize) {
    const train = contracts.slice(start, start + trainSize);
    const test = contracts.slice(start + trainSize, start + trainSize + testSize);
    const cal = calibrateEdge(train);
    const isStats = evaluateContracts(train, cal.edge);
    const oosStats = evaluateContracts(test, cal.edge);
    folds.push({
      start,
      trainStart: train[0].closeTime,
      trainEnd: train[train.length - 1].closeTime,
      testStart: test[0].closeTime,
      testEnd: test[test.length - 1].closeTime,
      edge: cal.edge,
      is: isStats,
      oos: oosStats,
      gap: isStats.winRate - oosStats.winRate,
    });
  }
  const valid = folds.filter((f) => f.oos.count >= minTradesPerFold);
  if (!valid.length) return null;
  return {
    foldCount: folds.length,
    validFoldCount: valid.length,
    medianEdge: +median(valid.map((f) => f.edge)).toFixed(3),
    avgIS: +avg(valid.map((f) => f.is.winRate)).toFixed(2),
    avgOOS: +avg(valid.map((f) => f.oos.winRate)).toFixed(2),
    avgGap: +(avg(valid.map((f) => f.gap))).toFixed(2),
    folds,
  };
}

function fmt(v, d = 1) {
  return Number.isFinite(v) ? v.toFixed(d) : '0.0';
}

async function main() {
  const now = Date.now();
  const sinceMs = now - daysBack * 24 * 60 * 60 * 1000;
  const runIso = new Date().toISOString();

  console.log(`\nKalshi Odds 7D Pull + Walk-Forward Retune`);
  console.log(`Coins: ${coins.join(', ')}`);
  console.log(`Window: last ${daysBack} days`);
  console.log(`WF config: train=${trainSize}, test=${testSize}, step=${stepSize}, minTrades=${minTradesPerFold}\n`);

  const byCoin = {};
  const summaryRows = [];

  for (const coin of coins) {
    console.log(`Fetching settled Kalshi contracts for ${coin}...`);
    const contracts = await fetchSettledContracts(coin, sinceMs);
    if (!contracts.length) {
      console.log(`  ${coin}: no in-range contracts with odds data`);
      byCoin[coin] = { contracts: [], baseline: null, wf: null };
      continue;
    }

    const baseline = evaluateContracts(contracts, 0.05);
    const wf = walkForwardRetune(contracts);
    const retunedEdge = wf?.medianEdge ?? 0.05;
    const retunedAll = evaluateContracts(contracts, retunedEdge);

    byCoin[coin] = {
      contracts,
      baseline,
      retunedEdge,
      retunedAll,
      wf,
    };

    summaryRows.push({
      coin,
      contracts: contracts.length,
      baselineEdge: 0.05,
      baselineWR: baseline.winRate,
      baselineN: baseline.count,
      retunedEdge,
      retunedWR: retunedAll.winRate,
      retunedN: retunedAll.count,
      wfAvgOOS: wf?.avgOOS ?? 0,
      wfAvgIS: wf?.avgIS ?? 0,
      wfGap: wf?.avgGap ?? 0,
      wfValidFolds: wf?.validFoldCount ?? 0,
    });

    console.log(
      `  ${coin}: contracts=${contracts.length}, baseline(5¢)=${fmt(baseline.winRate)}% n=${baseline.count}, ` +
      `retuned(edge=${retunedEdge})=${fmt(retunedAll.winRate)}% n=${retunedAll.count}, wfOOS=${fmt(wf?.avgOOS ?? 0)}% folds=${wf?.validFoldCount ?? 0}`
    );
  }

  const stamp = runIso.replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(LOG_DIR, `kalshi-odds-wf-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: runIso,
    daysBack,
    trainSize,
    testSize,
    stepSize,
    minTradesPerFold,
    summary: summaryRows,
    byCoin,
  }, null, 2));

  const csvPath = path.join(LOG_DIR, `kalshi-odds-wf-summary-${stamp}.csv`);
  const header = [
    'coin',
    'contracts',
    'baselineEdge',
    'baselineWR',
    'baselineN',
    'retunedEdge',
    'retunedWR',
    'retunedN',
    'wfAvgOOS',
    'wfAvgIS',
    'wfGap',
    'wfValidFolds',
  ];
  const csvLines = [
    header.join(','),
    ...summaryRows.map((r) => [
      r.coin,
      r.contracts,
      r.baselineEdge,
      fmt(r.baselineWR, 2),
      r.baselineN,
      r.retunedEdge,
      fmt(r.retunedWR, 2),
      r.retunedN,
      fmt(r.wfAvgOOS, 2),
      fmt(r.wfAvgIS, 2),
      fmt(r.wfGap, 2),
      r.wfValidFolds,
    ].join(',')),
  ];
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  console.log('\nSummary table:');
  for (const r of summaryRows) {
    console.log(
      `  ${r.coin}: baseline=${fmt(r.baselineWR, 2)}% (n=${r.baselineN}) -> ` +
      `retuned=${fmt(r.retunedWR, 2)}% edge=${r.retunedEdge} | wf OOS=${fmt(r.wfAvgOOS, 2)}%`
    );
  }
  console.log(`\nSaved: ${jsonPath}`);
  console.log(`Saved: ${csvPath}`);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

