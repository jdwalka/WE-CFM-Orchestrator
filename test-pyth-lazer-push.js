/**
 * Standalone test for Pyth Lazer WS push (SDK).
 * Run with: node test-pyth-lazer-push.js
 *
 * It uses ONLY the PYTH_NEW_API secret (same as the app).
 * It subscribes and logs every message for 15 seconds.
 * If you see "streamUpdated" with priceFeeds that have numeric priceFeedId 1/2/6/10 etc,
 * then the push works and the problem is inside the Electron main listener.
 */

const fs = require('fs');
const path = require('path');

function readNewKey() {
  const dirs = [
    'secrets',
    path.resolve(__dirname, 'secrets'),
    path.resolve(process.cwd(), 'secrets'),
  ];
  for (const d of dirs) {
    for (const n of ['PYTH_NEW_API', 'PYTH_NEW_API.txt']) {
      const p = path.join(d, n);
      try {
        if (fs.existsSync(p)) {
          let r = fs.readFileSync(p, 'utf8').trim();
          if (r) {
            const m = r.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/m);
            const val = m ? m[2].trim() : r.replace(/^\s*["']|["']\s*$/g, '').trim();
            if (val && !val.startsWith('#')) return val;
          }
        }
      } catch (_) {}
    }
  }
  return process.env.PYTH_NEW_API || process.env.PYTH_LAZER_TOKEN || '';
}

const token = readNewKey();
if (!token) {
  console.error('❌ No PYTH_NEW_API token found in secrets/ or env');
  process.exit(2);
}
console.log('[TEST] Token loaded (len=' + token.length + ')');

const { PythLazerClient } = require('@pythnetwork/pyth-lazer-sdk');

const FEEDS = [1, 2, 6, 10, 14, 15];
const MAP = { 1: 'BTC', 2: 'ETH', 6: 'SOL', 10: 'DOGE', 14: 'XRP', 15: 'BNB' };

(async () => {
  let client;
  try {
    console.log('[TEST] Creating client...');
    client = await PythLazerClient.create({
      token,
      webSocketPoolConfig: {
        urls: [
          'wss://pyth-lazer-0.dourolabs.app/v1/stream',
          'wss://pyth-lazer-1.dourolabs.app/v1/stream',
          'wss://pyth-lazer-2.dourolabs.app/v1/stream',
        ],
      },
    });
    console.log('[TEST] Client created');

    client.subscribe({
      type: 'subscribe',
      subscriptionId: 1,
      priceFeedIds: FEEDS,
      properties: ['price', 'bestBidPrice', 'bestAskPrice', 'exponent'],
      formats: ['evm', 'solana'],
      channel: 'real_time',
      deliveryFormat: 'json',
      parsed: true,
      ignoreInvalidFeedIds: true,
      jsonBinaryEncoding: 'hex',
    });
    console.log('[TEST] Subscribed. Listening for 15s...');

    let count = 0;
    client.addMessageListener((msg) => {
      if (msg.type !== 'json') {
        console.log('[TEST] non-json:', msg.type);
        return;
      }
      const v = msg.value || {};
      console.log('[TEST] msg type:', v.type || 'unknown', 'keys:', Object.keys(v));

      if (v.type === 'subscribed' || v.type === 'subscribedWithInvalidFeedIdsIgnored') {
        console.log('[TEST] SUB OK:', v);
        return;
      }

      const feeds = (v.parsed && (v.parsed.priceFeeds || v.parsed.priceFeedUpdates)) || [];
      if (feeds.length) {
        count++;
        console.log('[TEST] streamUpdated with', feeds.length, 'feeds');
        for (const f of feeds.slice(0, 3)) {
          const id = f.priceFeedId;
          const sym = MAP[id] || id;
          const raw = f.price;
          const expo = f.exponent;
          console.log('  ', sym, 'raw=', raw, 'expo=', expo);
        }
      }
    });

    setTimeout(() => {
      console.log('[TEST] Done. Got', count, 'updates with feeds.');
      try { client.shutdown(); } catch (_) {}
      process.exit(count > 0 ? 0 : 1);
    }, 15000);

  } catch (e) {
    console.error('[TEST] ERROR:', e && e.message || e);
    process.exit(1);
  }
})();
