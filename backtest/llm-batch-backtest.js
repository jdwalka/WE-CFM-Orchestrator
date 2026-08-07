#!/usr/bin/env node
// ================================================================
// WECRYPTO — Offline xAI Batch Backtest for the LLM Signal (15m/60m)
//
// Submits historical 15-minute and hourly market snapshots to xAI's
// Batch API (https://docs.x.ai/developers/advanced-api-usage/batch-api)
// to score whether Grok's regime/confidence call adds signal beyond
// raw indicators. Batch completion is best-effort / not guaranteed
// (usually within 24h) — this is OFFLINE SCORING ONLY, never used to
// drive live trades. Live 5m/15m/hourly predictions stay on the
// synchronous path in src/llm/llm_signal_assistant.js.
//
// NEUTRAL SNAPSHOT — the snapshot fed to generateUserPrompt() below
// carries real OHLCV-derived indicators but NEUTRAL placeholders for
// the fields that come from the live app's composite scoring engine
// (compositeEdge/verdictDir/market.*/setups) — that engine only lives
// inside src/core/predictions.js behind Electron IPC and isn't
// reusable here. Placeholder values are deliberate, not a bug: they
// isolate "does Grok add edge on top of raw indicators" rather than
// re-implementing (and inevitably drifting from) the live composite
// engine and silently testing something else instead.
//
// Usage:
//   node backtest/llm-batch-backtest.js submit --coins BTC,ETH --days 14 --horizons 15,60 --dry-run
//   node backtest/llm-batch-backtest.js submit --coins BTC,ETH --days 14 --horizons 15,60
//   node backtest/llm-batch-backtest.js score --latest --wait
//   node backtest/llm-batch-backtest.js score --batch-id <id>
// ================================================================
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
} catch (_) { /* dotenv optional; env vars may already be set */ }

const { generateSystemPrompt, generateUserPrompt } = require('../src/llm/specialized_prompt');

// ── CLI args ────────────────────────────────────────────────────
function parseArgs(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const getArg = (flag) => { const i = rest.indexOf(flag); return i !== -1 ? rest[i + 1] : null; };
  const hasFlag = (flag) => rest.includes(flag);

  const coinsRaw = getArg('--coins');
  const horizonsRaw = getArg('--horizons') || '15,60';

  return {
    cmd,
    coins: coinsRaw ? coinsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
    days: parseInt(getArg('--days') || '7', 10),
    horizons: horizonsRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0),
    step: parseInt(getArg('--step') || '', 10) || null,
    model: getArg('--model') || process.env.XAI_BATCH_MODEL || process.env.XAI_MODEL_FAST || process.env.XAI_MODEL || 'grok-4.5',
    name: getArg('--name') || `wecrypto-llm-bt-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
    maxRequests: parseInt(getArg('--max-requests') || '5000', 10),
    outDir: getArg('--out-dir') || path.resolve(__dirname, 'llm-batch-backtest-runs'),
    dryRun: hasFlag('--dry-run'),
    batchId: getArg('--batch-id'),
    sidecarPath: getArg('--sidecar'),
    latest: hasFlag('--latest'),
    wait: hasFlag('--wait'),
    pollIntervalSec: parseInt(getArg('--poll-interval') || '30', 10),
    waitTimeoutMin: parseInt(getArg('--wait-timeout') || '60', 10),
    limit: parseInt(getArg('--limit') || '100', 10),
    outReport: getArg('--out'),
  };
}

function printUsage() {
  console.log(`
Usage:
  node backtest/llm-batch-backtest.js submit --coins BTC,ETH,SOL,XRP --days 14 --horizons 15,60 [--step 15] [--model grok-4.3] [--name my-batch] [--max-requests 5000] [--out-dir path] [--dry-run]
  node backtest/llm-batch-backtest.js score  (--batch-id <id> | --latest) [--wait] [--poll-interval 30] [--wait-timeout 60] [--limit 100] [--sidecar path] [--out report.json]
`.trim());
}

// ── Coins (matches PREDICTION_COINS in backtest-runner.js / data.js) ─
const PREDICTION_COINS = [
  { sym: 'BTC', binSym: 'BTCUSDT', geckoId: 'bitcoin', color: '🟠' },
  { sym: 'ETH', binSym: 'ETHUSDT', geckoId: 'ethereum', color: '🔵' },
  { sym: 'SOL', binSym: 'SOLUSDT', geckoId: 'solana', color: '🟣' },
  { sym: 'XRP', binSym: 'XRPUSDT', geckoId: 'ripple', color: '🔷' },
  { sym: 'HYPE', binSym: 'HYPEUSDT', geckoId: 'hyperliquid', color: '🟢' },
  { sym: 'DOGE', binSym: 'DOGEUSDT', geckoId: 'dogecoin', color: '🟡' },
  { sym: 'BNB', binSym: 'BNBUSDT', geckoId: 'binancecoin', color: '💛' },
];

// ── Data fetch (copied from backtest/backtest-runner.js — same fallback chain) ─
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : require('http');
    lib.get(url, { headers: { 'User-Agent': 'WECRYPTO-LLM-Batch-Backtest/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGet(res.headers.location)); return;
      }
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

const KRAKEN_PAIR = { BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLUSD', XRP: 'XXRPZUSD', DOGE: 'XDGUSD', BNB: 'BNBUSD', HYPE: 'HYPEUSD' };
const CB_PRODUCT = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD' };

async function fetchKrakenCandles(sym, limit = 1000) {
  const pair = KRAKEN_PAIR[sym]; if (!pair) throw new Error(`No Kraken pair for ${sym}`);
  const since = Math.floor((Date.now() - (limit * 5 * 60 * 1000)) / 1000);
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=5&since=${since}`;
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`Kraken HTTP ${status}`);
  const json = JSON.parse(body);
  if (json.error && json.error.length) throw new Error(`Kraken error: ${json.error[0]}`);
  const key = Object.keys(json.result).find((k) => k !== 'last');
  const rows = json.result[key];
  if (!Array.isArray(rows) || !rows.length) throw new Error(`No Kraken data for ${sym}`);
  return rows.map((r) => ({
    t: Number(r[0]) * 1000,
    o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[6]),
  }));
}

async function fetchCoinbaseCandles(sym, limit = 300) {
  const product = CB_PRODUCT[sym]; if (!product) throw new Error(`No Coinbase product for ${sym}`);
  const end = Math.floor(Date.now() / 1000);
  const start = end - limit * 5 * 60;
  const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${product}/candles?start=${start}&end=${end}&granularity=FIVE_MINUTE&limit=${limit}`;
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`Coinbase HTTP ${status}`);
  const json = JSON.parse(body);
  const rows = json.candles;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`No Coinbase data for ${sym}`);
  return rows.reverse().map((r) => ({
    t: Number(r.start) * 1000,
    o: parseFloat(r.open), h: parseFloat(r.high), l: parseFloat(r.low), c: parseFloat(r.close), v: parseFloat(r.volume),
  }));
}

async function fetchBinanceUSCandles(symbol, limit = 1000) {
  const PAGE = 1000;
  if (limit <= PAGE) {
    const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`;
    const { status, body } = await httpGet(url);
    if (status !== 200) throw new Error(`Binance.US HTTP ${status}`);
    const rows = JSON.parse(body);
    if (!Array.isArray(rows)) throw new Error(`Bad response: ${body.slice(0, 100)}`);
    return rows.map((r) => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
  }
  const pages = [];
  let endTime = null;
  let remaining = limit;
  while (remaining > 0) {
    const fetchCount = Math.min(PAGE, remaining);
    const url = endTime
      ? `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=5m&limit=${fetchCount}&endTime=${endTime}`
      : `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=5m&limit=${fetchCount}`;
    const { status, body } = await httpGet(url);
    if (status !== 200) throw new Error(`Binance.US HTTP ${status}`);
    const rows = JSON.parse(body);
    if (!Array.isArray(rows) || rows.length === 0) break;
    pages.unshift(rows);
    endTime = Number(rows[0][0]) - 1;
    remaining -= rows.length;
    if (rows.length < fetchCount) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const all = pages.flat();
  return all.map((r) => ({ t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
}

async function fetchCandles(coin, limit) {
  const errors = [];
  try { return await fetchBinanceUSCandles(coin.binSym, limit); } catch (e) { errors.push(`BinanceUS: ${e.message}`); }
  try { return await fetchKrakenCandles(coin.sym, limit); } catch (e) { errors.push(`Kraken: ${e.message}`); }
  try { return await fetchCoinbaseCandles(coin.sym, Math.min(300, limit)); } catch (e) { errors.push(`Coinbase: ${e.message}`); }
  throw new Error(errors.join(' | '));
}

// ── Indicator math (copied verbatim from backtest-runner.js, itself copied from predictions.js) ─
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signalPeriod);
  const lastMACD = macdLine[macdLine.length - 1];
  const lastSig = signalLine[signalLine.length - 1];
  return { macd: lastMACD, signal: lastSig, histogram: lastMACD - lastSig };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return { adx: 25, pdi: 25, mdi: 25 };
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    const up = c.h - p.h, down = p.l - c.l;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
  }
  const wilderSmooth = (arr, p) => {
    if (arr.length < p) return [arr.reduce((s, v) => s + v, 0)];
    let s = arr.slice(0, p).reduce((a, v) => a + v, 0);
    const out = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
    return out;
  };
  const atrS = wilderSmooth(trs, period);
  const pdiS = wilderSmooth(plusDMs, period);
  const mdiS = wilderSmooth(minusDMs, period);
  const dxArr = atrS.map((atr, i) => {
    const pdi = atr > 0 ? (pdiS[i] / atr) * 100 : 0;
    const mdi = atr > 0 ? (mdiS[i] / atr) * 100 : 0;
    const sum = pdi + mdi;
    return sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0;
  });
  const adxArr = wilderSmooth(dxArr, period);
  const li = adxArr.length - 1;
  const lastATR = atrS[li];
  return { adx: adxArr[li], pdi: lastATR > 0 ? (pdiS[li] / lastATR) * 100 : 0, mdi: lastATR > 0 ? (mdiS[li] / lastATR) * 100 : 0 };
}

function calcCCI(candles, period) {
  period = period || 14;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const tps = slice.map((c) => (c.h + c.l + c.c) / 3);
  const mean = tps.reduce((s, v) => s + v, 0) / period;
  const meanDev = tps.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
  return meanDev > 0 ? (tps[tps.length - 1] - mean) / (0.015 * meanDev) : 0;
}

function calcFisher(candles, period) {
  period = period || 10;
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const hh = Math.max(...slice.map((c) => c.h));
  const ll = Math.min(...slice.map((c) => c.l));
  const close = candles[candles.length - 1].c;
  const range = hh - ll;
  let value = range > 0 ? 2 * ((close - ll) / range) - 1 : 0;
  value = Math.max(-0.999, Math.min(0.999, value));
  return 0.5 * Math.log((1 + value) / (1 - value));
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
  }
  return sum / period;
}

// ── Snapshot construction ──────────────────────────────────────
const WINDOW_BARS = 80; // enough history for MACD(26+9) / ADX(14*2+1) with margin
const WARMUP_BARS = 80; // decision points only start once this much history exists

function buildIndicatorBlock(windowCandles) {
  const closes = windowCandles.map((c) => c.c);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes, 12, 26, 9);
  const adx = calcADX(windowCandles, 14);
  const cci = calcCCI(windowCandles, 14);
  const fisher = calcFisher(windowCandles, 10);
  return {
    RSI: { value: rsi },
    MACD: { value: macd.macd, signal: macd.signal },
    ADX: { value: adx.adx },
    CCI: { value: cci },
    FisherTransform: { value: fisher },
  };
}

// ATR expressed as a PERCENT of last close (e.g. 1.8 = 1.8%), matching
// classifyVolatilityRegime's thresholds (1.5 / 0.5) in specialized_prompt.js —
// NOT a fraction (0.018). Confirmed by reading that function directly.
function computeVolatilityPct(windowCandles) {
  const atr = calcATR(windowCandles, 14);
  const lastClose = windowCandles[windowCandles.length - 1].c;
  return lastClose > 0 ? (atr / lastClose) * 100 : 0;
}

function buildNeutralSnapshot(coin, windowCandles, entryPrice, horizonMinutes) {
  return {
    coin: coin.sym,
    horizon: `h${horizonMinutes}`,
    horizonMinutes,
    preferredHorizonMinutes: horizonMinutes,
    volatility: computeVolatilityPct(windowCandles),
    indicators: buildIndicatorBlock(windowCandles),
    market: { modelDirection: 'WAIT', confidencePct: 0, kalshiProb: 0, combinedProb: 0, score: 0 },
    verdictDir: 'wait',
    compositeEdge: 0,
    setups: [],
    contrarianSetups: [],
    orderbook: { imbalance: 0.5, buyPressure: 0.5 },
    weights: {},
    recentAccuracy: {},
    conflicts: [],
    executionWindow: {
      currentPrice: entryPrice,
      secondsToClose: horizonMinutes * 60,
    },
  };
}

// Ground truth is computed directly from already-fetched historical candles —
// no dependency on live settlement/spool files, no waiting.
function computeGroundTruth(candles, decisionIdx, horizonBars) {
  const entryPrice = candles[decisionIdx].c;
  const futurePrice = candles[decisionIdx + horizonBars].c;
  const realizedReturnPct = ((futurePrice - entryPrice) / entryPrice) * 100;
  const realizedDirection = realizedReturnPct > 0 ? 'up' : realizedReturnPct < 0 ? 'down' : 'flat';
  return { entryPrice, futurePrice, realizedReturnPct, realizedDirection };
}

function enumerateDecisionPoints(candles, stepBars, horizonBars) {
  const indices = [];
  const lastUsable = candles.length - 1 - horizonBars;
  for (let i = WARMUP_BARS; i <= lastUsable; i += stepBars) indices.push(i);
  return indices;
}

function buildRequestForDecisionPoint(coin, candles, decisionIdx, horizonMinutes, model) {
  const horizonBars = horizonMinutes / 5;
  const windowStart = Math.max(0, decisionIdx - WINDOW_BARS + 1);
  const windowCandles = candles.slice(windowStart, decisionIdx + 1);
  const groundTruth = computeGroundTruth(candles, decisionIdx, horizonBars);
  const snapshot = buildNeutralSnapshot(coin, windowCandles, groundTruth.entryPrice, horizonMinutes);
  const systemPrompt = generateSystemPrompt(horizonMinutes);
  const userPrompt = generateUserPrompt(snapshot);
  const batchRequestId = `${coin.sym}-h${horizonMinutes}-${candles[decisionIdx].t}`;

  return {
    batchRequestId,
    batchRequest: {
      responses: {
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model,
      },
    },
    sidecarEntry: {
      coin: coin.sym,
      horizonMinutes,
      decisionTs: candles[decisionIdx].t,
      entryPrice: groundTruth.entryPrice,
      futurePrice: groundTruth.futurePrice,
      realizedReturnPct: groundTruth.realizedReturnPct,
      realizedDirection: groundTruth.realizedDirection,
    },
  };
}

// ── xAI key resolution (copied from src/llm/llm_signal_assistant.js) ─
function extractKeyFromRaw(raw, patterns) {
  if (!raw) return '';
  const text = String(raw);
  // Prefer last match so multi-key secret files keep the newest key at the bottom.
  for (const p of patterns) {
    const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
    let re;
    try { re = new RegExp(p.source, flags); } catch (_) { re = p; }
    const matches = [];
    if (re.global) {
      for (const m of text.matchAll(re)) {
        if (m && m[0]) matches.push(m[0]);
      }
    } else {
      const m = text.match(re);
      if (m && m[0]) matches.push(m[0]);
    }
    if (matches.length) return matches[matches.length - 1];
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const line = lines.length ? lines[lines.length - 1] : '';
  if (line) return line.replace(/^[A-Za-z0-9_.-]+\s*=\s*/, '').trim();
  return '';
}

function getLlmSecretDirCandidates() {
  const candidates = [
    path.join(__dirname, '..', 'secrets'),
    path.resolve(process.cwd(), 'secrets'),
    'G:\\WECRYPTO\\secrets',
    'F:\\WECRYPTO\\secrets',
    'E:\\WECRYPTO\\secrets',
    'G:\\WECRYP\\secrets',
  ];
  const seen = new Set();
  const existing = [];
  for (const c of candidates) {
    try {
      const resolved = path.resolve(c);
      const key = resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (fs.existsSync(resolved)) existing.push(resolved);
    } catch (_) { /* ignore unresolvable candidate */ }
  }
  return existing;
}

function readXaiKeyFromSecrets() {
  const fileNames = ['XAI_API_KEY.txt', 'GROK_API_KEY.txt', 'xai_api_key.txt', 'grok_api_key.txt'];
  const patterns = [/xai-[A-Za-z0-9_-]+/i, /sk-[A-Za-z0-9_-]+/i];
  for (const dir of getLlmSecretDirCandidates()) {
    for (const name of fileNames) {
      try {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        const val = extractKeyFromRaw(raw, patterns);
        if (val) return val;
      } catch (_) { /* try next candidate */ }
    }
  }
  return '';
}

function resolveXaiApiKey() {
  return process.env.XAI_API_KEY
    || process.env.GROK_API_KEY
    || process.env.XAI_KEY
    || readXaiKeyFromSecrets()
    || '';
}

// ── xAI Batch REST client ──────────────────────────────────────
const XAI_API_BASE = 'https://api.x.ai/v1';

function httpsJson(method, url, apiKey, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* leave null, raw body still in error */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`xAI API ${method} ${url} -> HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function xaiCreateBatch(apiKey, name) {
  const { json } = await httpsJson('POST', `${XAI_API_BASE}/batches`, apiKey, { name });
  const batchId = json?.batch_id || json?.id || json?.batch?.id;
  if (!batchId) throw new Error(`xAI create-batch response missing batch id: ${JSON.stringify(json)}`);
  return batchId;
}

async function xaiAddRequests(apiKey, batchId, batchRequestsChunk) {
  return httpsJson('POST', `${XAI_API_BASE}/batches/${batchId}/requests`, apiKey, { batch_requests: batchRequestsChunk });
}

async function xaiGetBatch(apiKey, batchId) {
  const { json } = await httpsJson('GET', `${XAI_API_BASE}/batches/${batchId}`, apiKey);
  return json?.state || { num_requests: 0, num_pending: 0, num_success: 0, num_error: 0, num_cancelled: 0 };
}

async function xaiGetBatchResultsPage(apiKey, batchId, { limit = 100, paginationToken = null } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (paginationToken) qs.set('pagination_token', paginationToken);
  const { json } = await httpsJson('GET', `${XAI_API_BASE}/batches/${batchId}/results?${qs.toString()}`, apiKey);
  return { results: json?.results || [], paginationToken: json?.pagination_token || null };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function rateLimitedBatchAdd(apiKey, batchId, allRequests, chunkSize = 200, delayMs = 350) {
  const chunks = chunkArray(allRequests, chunkSize);
  for (let i = 0; i < chunks.length; i++) {
    await xaiAddRequests(apiKey, batchId, chunks[i]);
    console.log(`[submit] added chunk ${i + 1}/${chunks.length} (${chunks[i].length} requests)`);
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
}

// ── Submit mode ─────────────────────────────────────────────────
async function runSubmit(opts) {
  const apiKey = resolveXaiApiKey();
  if (!apiKey && !opts.dryRun) {
    throw new Error('No xAI API key found (XAI_API_KEY / GROK_API_KEY env var or secrets/XAI_API_KEY.txt). Use --dry-run to build prompts without calling the API.');
  }

  const coinSyms = opts.coins || PREDICTION_COINS.map((c) => c.sym);
  const coins = PREDICTION_COINS.filter((c) => coinSyms.includes(c.sym));
  if (!coins.length) throw new Error(`No matching coins for --coins ${coinSyms.join(',')}`);
  if (!opts.horizons.length) throw new Error('No valid --horizons given (expected e.g. --horizons 15,60)');

  const smallestHorizon = Math.min(...opts.horizons);
  const stepMinutes = opts.step || smallestHorizon;
  const stepBars = Math.max(1, Math.round(stepMinutes / 5));

  const allRequests = [];
  const sidecarMap = {};
  let capped = false;

  outer:
  for (const coin of coins) {
    console.log(`[submit] fetching ${opts.days}d of 5m candles for ${coin.sym}...`);
    const candles = await fetchCandles(coin, opts.days * 288);
    console.log(`[submit] ${coin.sym}: ${candles.length} candles fetched`);

    for (const horizonMinutes of opts.horizons) {
      const horizonBars = horizonMinutes / 5;
      const decisionIndices = enumerateDecisionPoints(candles, stepBars, horizonBars);
      for (const idx of decisionIndices) {
        if (allRequests.length >= opts.maxRequests) { capped = true; break outer; }
        const built = buildRequestForDecisionPoint(coin, candles, idx, horizonMinutes, opts.model);
        allRequests.push({ batchRequestId: built.batchRequestId, batchRequest: built.batchRequest });
        sidecarMap[built.batchRequestId] = built.sidecarEntry;
      }
    }
  }

  if (capped) console.warn(`[submit] WARNING: hit --max-requests ${opts.maxRequests}, some decision points were skipped`);
  console.log(`[submit] built ${allRequests.length} requests across ${coins.length} coin(s) × horizons [${opts.horizons.join(',')}]`);

  if (opts.dryRun) {
    const sample = allRequests[0];
    console.log('\n[dry-run] sample request id:', sample?.batchRequestId);
    console.log('[dry-run] sample system prompt:\n' + sample?.batchRequest.responses.input[0].content);
    console.log('\n[dry-run] sample user prompt:\n' + sample?.batchRequest.responses.input[1].content);
    console.log('\n[dry-run] no API calls made, no batch created.');
    return;
  }

  console.log(`[submit] creating batch "${opts.name}"...`);
  const batchId = await xaiCreateBatch(apiKey, opts.name);
  console.log(`[submit] batch created: ${batchId}`);

  const requestBodies = allRequests.map((r) => ({ batch_request_id: r.batchRequestId, batch_request: r.batchRequest }));
  await rateLimitedBatchAdd(apiKey, batchId, requestBodies);

  const sidecarPath = writeSidecarFile(opts.outDir, batchId, opts, sidecarMap);
  console.log(`\n[submit] done. batchId=${batchId} requests=${allRequests.length}`);
  console.log(`[submit] sidecar written to ${sidecarPath}`);
  console.log('[submit] reminder: batch completion is best-effort, not guaranteed (usually within 24h). Run `score --latest --wait` later.');
}

function writeSidecarFile(outDir, batchId, opts, sidecarMap) {
  fs.mkdirSync(outDir, { recursive: true });
  const filename = `submit-${batchId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filePath = path.join(outDir, filename);
  const payload = {
    batchId,
    batchName: opts.name,
    model: opts.model,
    createdAt: new Date().toISOString(),
    coins: opts.coins || PREDICTION_COINS.map((c) => c.sym),
    horizons: opts.horizons,
    days: opts.days,
    step: opts.step,
    requestCount: Object.keys(sidecarMap).length,
    requests: sidecarMap,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

// ── Score mode ──────────────────────────────────────────────────
function findLatestSidecarFile(outDir) {
  if (!fs.existsSync(outDir)) return null;
  const files = fs.readdirSync(outDir)
    .filter((f) => f.startsWith('submit-') && f.endsWith('.json'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(outDir, files[0].f) : null;
}

function loadSidecarFile(opts) {
  if (opts.sidecarPath) {
    return JSON.parse(fs.readFileSync(opts.sidecarPath, 'utf8'));
  }
  if (opts.batchId) {
    if (!fs.existsSync(opts.outDir)) throw new Error(`No sidecar dir at ${opts.outDir} for --batch-id ${opts.batchId}`);
    const match = fs.readdirSync(opts.outDir)
      .filter((f) => f.startsWith('submit-') && f.endsWith('.json'))
      .map((f) => path.join(opts.outDir, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).batchId === opts.batchId; } catch (_) { return false; } });
    if (!match) throw new Error(`No sidecar file found for --batch-id ${opts.batchId} in ${opts.outDir}. Pass --sidecar explicitly if it moved.`);
    return JSON.parse(fs.readFileSync(match, 'utf8'));
  }
  if (opts.latest) {
    const latest = findLatestSidecarFile(opts.outDir);
    if (!latest) throw new Error(`No sidecar files found in ${opts.outDir}`);
    return JSON.parse(fs.readFileSync(latest, 'utf8'));
  }
  throw new Error('score mode requires --batch-id <id>, --latest, or --sidecar <path>');
}

async function pollBatchOnce(apiKey, batchId) {
  const state = await xaiGetBatch(apiKey, batchId);
  console.log(`[score] batch ${batchId}: pending=${state.num_pending} success=${state.num_success} error=${state.num_error} cancelled=${state.num_cancelled} total=${state.num_requests}`);
  return state;
}

async function waitForBatchCompletion(apiKey, batchId, pollIntervalSec, timeoutMin) {
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  let state = await pollBatchOnce(apiKey, batchId);
  while (state.num_pending > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalSec * 1000));
    state = await pollBatchOnce(apiKey, batchId);
  }
  if (state.num_pending > 0) console.warn(`[score] wait-timeout (${timeoutMin}m) reached with ${state.num_pending} still pending — batch completion has no SLA, try again later`);
  return state;
}

async function fetchAllResults(apiKey, batchId, limit) {
  const all = [];
  let paginationToken = null;
  do {
    const page = await xaiGetBatchResultsPage(apiKey, batchId, { limit, paginationToken });
    all.push(...page.results);
    paginationToken = page.paginationToken;
  } while (paginationToken);
  return all;
}

// Copied from src/llm/llm_signal_assistant.js extractJsonContent
function extractJsonContent(rawText) {
  const content = String(rawText || '').trim();
  if (!content) throw new Error('Empty LLM response');
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1];
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) return content.slice(firstBrace, lastBrace + 1);
  return content;
}

const VALID_REGIMES = ['trend_continuation', 'mean_reversion', 'chop_noise', 'breakout_volatility'];

function parseGrokResult(entry) {
  const batchRequestId = entry.batch_request_id;
  const content = entry.batch_result?.response?.chat_get_completion?.choices?.[0]?.message?.content
    ?? entry.batch_result?.response?.choices?.[0]?.message?.content;
  if (!content) return { batchRequestId, parseError: 'missing response content' };
  try {
    const raw = JSON.parse(extractJsonContent(content));
    const regime = VALID_REGIMES.includes(raw.regime) ? raw.regime : 'unknown';
    const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
    return { batchRequestId, regime, confidence };
  } catch (err) {
    return { batchRequestId, parseError: err.message };
  }
}

function joinResultsWithSidecar(parsedResults, sidecarMap) {
  const joined = [];
  let parseFailures = 0;
  let missingSidecar = 0;
  for (const r of parsedResults) {
    if (r.parseError) { parseFailures++; continue; }
    const truth = sidecarMap[r.batchRequestId];
    if (!truth) { missingSidecar++; continue; }
    joined.push({
      coin: truth.coin,
      horizonMinutes: truth.horizonMinutes,
      decisionTs: truth.decisionTs,
      regime: r.regime,
      confidence: r.confidence,
      realizedReturnPct: truth.realizedReturnPct,
      realizedDirection: truth.realizedDirection,
    });
  }
  return { joined, parseFailures, missingSidecar };
}

// NOTE ON SCORING: the JSON schema Grok returns here is regime (4-value enum)
// + confidence — there is NO explicit up/down field (confirmed by reading
// generateSystemPrompt's schema). "Hit rate" below means REGIME-CONDITIONAL
// CONSISTENCY with the realized move, not literal long/short correctness —
// see the legend printed with the report.
const NOISE_THRESHOLD_PCT = 0.05; // 5bp — below this, a move counts as "no move" for chop_noise scoring
const CONFIDENCE_BUCKETS = [
  { label: 'low(0-0.4)', min: 0, max: 0.4 },
  { label: 'med(0.4-0.7)', min: 0.4, max: 0.7 },
  { label: 'high(0.7-1.0)', min: 0.7, max: 1.01 },
];

function isConsistent(regime, realizedReturnPct) {
  const magnitude = Math.abs(realizedReturnPct);
  if (regime === 'chop_noise') return magnitude < NOISE_THRESHOLD_PCT;
  if (regime === 'trend_continuation' || regime === 'breakout_volatility' || regime === 'mean_reversion') {
    return magnitude >= NOISE_THRESHOLD_PCT;
  }
  return null; // 'unknown' — excluded from consistency scoring
}

function confidenceBucketFor(confidence) {
  return CONFIDENCE_BUCKETS.find((b) => confidence >= b.min && confidence < b.max)?.label || 'unknown';
}

function computeAccuracyReport(joined, parseFailures, missingSidecar, requestCount) {
  const groups = {};
  for (const rec of joined) {
    const key = `${rec.coin}|h${rec.horizonMinutes}`;
    if (!groups[key]) {
      groups[key] = {
        coin: rec.coin, horizonMinutes: rec.horizonMinutes,
        total: 0, scored: 0, consistent: 0,
        avgRealizedReturnPctByRegime: {}, countByRegime: {},
        buckets: Object.fromEntries(CONFIDENCE_BUCKETS.map((b) => [b.label, { count: 0, consistent: 0 }])),
      };
    }
    const g = groups[key];
    g.total++;
    const consistent = isConsistent(rec.regime, rec.realizedReturnPct);
    g.countByRegime[rec.regime] = (g.countByRegime[rec.regime] || 0) + 1;
    g.avgRealizedReturnPctByRegime[rec.regime] = (g.avgRealizedReturnPctByRegime[rec.regime] || 0) + rec.realizedReturnPct;
    if (consistent !== null) {
      g.scored++;
      if (consistent) g.consistent++;
      const bucketLabel = confidenceBucketFor(rec.confidence);
      if (g.buckets[bucketLabel]) {
        g.buckets[bucketLabel].count++;
        if (consistent) g.buckets[bucketLabel].consistent++;
      }
    }
  }
  for (const g of Object.values(groups)) {
    for (const regime of Object.keys(g.avgRealizedReturnPctByRegime)) {
      g.avgRealizedReturnPctByRegime[regime] /= g.countByRegime[regime];
    }
    g.hitRatePct = g.scored > 0 ? (g.consistent / g.scored) * 100 : null;
  }
  return { groups: Object.values(groups), parseFailures, missingSidecar, requestCount, totalJoined: joined.length };
}

function bar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
}

function printAccuracyReport(report) {
  const divider = '─'.repeat(72);
  console.log(`\n${divider}`);
  console.log(' LLM BATCH BACKTEST — REGIME/CONFIDENCE CONSISTENCY REPORT');
  console.log(divider);
  console.log(' Legend: "hit rate" = % of scored calls where regime was CONSISTENT with the');
  console.log(' realized move magnitude (chop_noise=small move, others=notable move).');
  console.log(' This is NOT a literal long/short win rate — the model\'s output schema has');
  console.log(' no explicit direction field, only regime + confidence.');
  console.log(` Requests in sidecar: ${report.requestCount} | Results joined: ${report.totalJoined} | Parse failures: ${report.parseFailures} | Missing sidecar match: ${report.missingSidecar}`);

  for (const g of report.groups.sort((a, b) => a.coin.localeCompare(b.coin) || a.horizonMinutes - b.horizonMinutes)) {
    console.log(`\n${divider}`);
    console.log(` ${g.coin}  h${g.horizonMinutes}m  (${g.total} snapshots, ${g.scored} scorable)`);
    console.log(divider);
    if (g.hitRatePct != null) {
      console.log(` Hit rate: ${g.hitRatePct.toFixed(1)}%  ${bar(g.hitRatePct)}`);
    } else {
      console.log(' Hit rate: n/a (no scorable regimes)');
    }
    const regimeLines = Object.entries(g.countByRegime)
      .map(([regime, count]) => `${regime}: ${count} (avg ${g.avgRealizedReturnPctByRegime[regime].toFixed(3)}%)`)
      .join(' │ ');
    console.log(` Regime distribution: ${regimeLines}`);
    const bucketLines = Object.entries(g.buckets)
      .filter(([, v]) => v.count > 0)
      .map(([label, v]) => `${label}: ${v.count} @ ${((v.consistent / v.count) * 100).toFixed(0)}%`)
      .join(' │ ');
    if (bucketLines) console.log(` Confidence buckets: ${bucketLines}`);
  }
  console.log(`\n${divider}\n`);
}

async function runScore(opts) {
  const sidecar = loadSidecarFile(opts);
  const apiKey = resolveXaiApiKey();
  if (!apiKey) throw new Error('No xAI API key found (XAI_API_KEY / GROK_API_KEY env var or secrets/XAI_API_KEY.txt)');

  const state = opts.wait
    ? await waitForBatchCompletion(apiKey, sidecar.batchId, opts.pollIntervalSec, opts.waitTimeoutMin)
    : await pollBatchOnce(apiKey, sidecar.batchId);

  if (state.num_pending > 0) {
    console.log('[score] batch not yet complete. Re-run later (or with --wait) — completion is best-effort, not guaranteed.');
    return;
  }

  console.log('[score] batch complete, fetching results...');
  const results = await fetchAllResults(apiKey, sidecar.batchId, opts.limit);
  console.log(`[score] fetched ${results.length} results`);

  const parsed = results.map(parseGrokResult);
  const { joined, parseFailures, missingSidecar } = joinResultsWithSidecar(parsed, sidecar.requests);
  const report = computeAccuracyReport(joined, parseFailures, missingSidecar, sidecar.requestCount);
  printAccuracyReport(report);

  if (opts.outReport) {
    fs.writeFileSync(opts.outReport, JSON.stringify(report, null, 2));
    console.log(`[score] report written to ${opts.outReport}`);
  }
}

// ── Entry point ─────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd !== 'submit' && opts.cmd !== 'score') {
    printUsage();
    process.exit(1);
  }
  if (opts.cmd === 'submit') await runSubmit(opts);
  else await runScore(opts);
}

// Guard against firing (and possibly submitting a REAL, billed xAI batch)
// just from being require()'d — this only runs when invoked directly via
// `node backtest/llm-batch-backtest.js ...`.
if (require.main === module) {
  main().catch((err) => {
    console.error('[llm-batch-backtest] FAILED:', err.message);
    process.exit(1);
  });
}
