'use strict';

/**
 * poker-watcher — tails poker hand-history dirs, sends completed hands to
 * the Cloudflare analyzer, pushes results to the HUD window.
 *
 * Egress: SOCKS5 bridge via proxy-session (strict = fail closed to protect
 * the geo-fence). Poker analysis hits our own global worker, so clearnet
 * fallback is ALLOWED here (HUD freshness wins; no geo-fenced upstream).
 * Exchange feeds stay strict in proxy-session defaults / http-socks5-bridge.
 */

const fs = require('fs');
const path = require('path');

let chokidar = null;
try {
  // eslint-disable-next-line global-require
  chokidar = require('chokidar');
} catch (_) { /* optional dep — watcher stays dormant without it */ }

const { fetchWithRetry } = require('./proxy-session');

const ANALYZE_URL = process.env.POKER_ANALYZE_URL || 'https://analyze.leaksnipe.win/';
const DEFAULT_DIRS = [
  process.env.POKER_HAND_DIR || null,
  'C:/ACR Poker/handHistory',
  'C:\\ACR Poker\\handHistory',
].filter(Boolean);

const _tails = new Map(); // filePath -> { offset, buffer }

async function analyzeHand(handHistory, gameType = 'NLH') {
  const result = await fetchWithRetry(
    ANALYZE_URL,
    { method: 'POST', allowClearnetFallback: true },
    { gameType, handHistory },
    3,
    1000
  );
  return result && result.analysis ? result.analysis : JSON.stringify(result).slice(0, 4000);
}

function pumpFile(filePath, onHand) {
  const st = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!st) return;
  const prev = _tails.get(filePath) || { offset: 0, buffer: '' };
  if (st.size < prev.offset) prev.offset = 0; // rotated/truncated
  if (st.size === prev.offset) return;
  const stream = fs.createReadStream(filePath, { start: prev.offset, encoding: 'utf8' });
  let chunk = '';
  stream.on('data', (d) => { chunk += d; });
  stream.on('end', () => {
    prev.offset = st.size;
    prev.buffer += chunk;
    const parts = prev.buffer.split(/\n\s*\n/);
    prev.buffer = parts.pop() || '';
    _tails.set(filePath, prev);
    for (const part of parts) {
      if (part.trim().length > 50) onHand(part.trim());
    }
  });
  stream.on('error', () => {});
}

function startHandWatcher(hudWindowOrGetter, handHistoryDirs = DEFAULT_DIRS) {
  const hud = () => (typeof hudWindowOrGetter === 'function' ? hudWindowOrGetter() : hudWindowOrGetter);
  if (!chokidar) {
    console.warn('[PokerWatcher] chokidar not installed — watcher dormant (npm i chokidar).');
    return null;
  }
  const dirs = handHistoryDirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
  if (!dirs.length) {
    console.warn('[PokerWatcher] no hand-history dirs found — watcher dormant.');
    return null;
  }
  const watcher = chokidar.watch(dirs.map((d) => path.join(d, '**/*.txt')), {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 500 },
  });
  const onHand = async (rawHand) => {
    try {
      const _w0 = hud();
      if (_w0 && !_w0.isDestroyed()) {
        _w0.webContents.send('hud:processing-start', {});
      }
      const analysis = await analyzeHand(rawHand);
      const _w1 = hud();
      if (_w1 && !_w1.isDestroyed()) {
        _w1.webContents.send('hud:update-analysis', { rawHand: rawHand.slice(0, 2000), analysis });
      }
    } catch (err) {
      console.error('[PokerWatcher] pipeline failed:', err.message);
      const _w2 = hud();
      if (_w2 && !_w2.isDestroyed()) {
        _w2.webContents.send('hud:update-analysis', { rawHand: '', analysis: `Error: ${err.message}` });
      }
    }
  };
  watcher.on('add', (fp) => pumpFile(fp, onHand));
  watcher.on('change', (fp) => pumpFile(fp, onHand));
  console.log('[PokerWatcher] watching:', dirs.join(', '));
  return watcher;
}

module.exports = { startHandWatcher, analyzeHand, ANALYZE_URL };
