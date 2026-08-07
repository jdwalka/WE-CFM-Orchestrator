#!/usr/bin/env node
/**
 * Pyth Lazer standalone test (matches your latest subscription snippet)
 * Uses the exact same token loading as the app.
 *
 * Run:
 *   node test-pyth-lazer-50ms.js
 *
 * It will:
 * - Load token from secrets/PYTH_NEW_API (or .txt)
 * - Connect with the pool
 * - Subscribe with fixed_rate@50ms + your properties/formats
 * - Log every message (including full JSON for streamUpdated)
 * - Exit after 15s or on first data
 */

const fs = require('fs');
const path = require('path');

function readPythToken() {
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
          let raw = fs.readFileSync(p, 'utf8').trim();
          if (raw) {
            const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/m);
            const v = m ? m[2].trim() : raw.replace(/^\s*["']|["']\s*$/g, '').trim();
            if (v && !v.startsWith('#')) return v;
          }
        }
      } catch (_) {}
    }
  }
  return process.env.LAZER_TOKEN || process.env.PYTH_NEW_API || '';
}

const token = readPythToken();
if (!token) {
  console.error('❌ No token found. Put it in secrets/PYTH_NEW_API or set LAZER_TOKEN');
  process.exit(1);
}
console.log('[TEST] Token loaded (len=' + token.length + ')');

(async () => {
  let client;
  try {
    const { PythLazerClient } = require('@pythnetwork/pyth-lazer-sdk');

    console.log('[TEST] Creating client...');
    client = await PythLazerClient.create({
      token,
      webSocketPoolConfig: {
        urls: [
          "wss://pyth-lazer-0.dourolabs.app/v1/stream",
          "wss://pyth-lazer-1.dourolabs.app/v1/stream",
          "wss://pyth-lazer-2.dourolabs.app/v1/stream",
        ],
      },
    });
    console.log('[TEST] Client created');

    // Exactly the subscription from your last message
    client.subscribe({
      type: "subscribe",
      subscriptionId: 1,
      priceFeedIds: [1, 2, 6, 13, 14],
      properties: ["price", "bestBidPrice", "publisherCount", "fundingRate", "confidence", "bestAskPrice", "marketSession", "fundingRateInterval", "exponent", "fundingTimestamp"],
      formats: ["solana", "leEcdsa", "leUnsigned", "evm"],
      channel: "fixed_rate@50ms",
      deliveryFormat: "json",
      jsonBinaryEncoding: "hex",
      parsed: true,
      // ignoreInvalidFeeds: true,
    });
    console.log('[TEST] Subscribed. Listening for up to 15s...');

    let gotData = false;
    client.addMessageListener((message) => {
      if (message.type === "json") {
        const v = message.value || {};
        if (v.type === 'streamUpdated' && v.parsed?.priceFeeds?.length) {
          gotData = true;
          console.log('[TEST] ✅ GOT PRICE DATA!');
          console.log('Full update:', JSON.stringify(v, null, 2).slice(0, 800));
        } else {
          console.log('[TEST] JSON msg type:', v.type || 'unknown', 'keys:', Object.keys(v));
        }
      } else if (message.type === 'binary') {
        console.log('[TEST] Binary message with parsed?', !!message.value?.parsed);
      } else {
        console.log('[TEST] Other message:', message);
      }
    });

    client.addAllConnectionsDownListener(() => {
      console.error('[TEST] All connections down');
    });

    // Timeout
    setTimeout(() => {
      console.log(gotData ? '[TEST] Success (got data)' : '[TEST] No streamUpdated price data in 15s');
      if (client) {
        try { client.unsubscribe(1); } catch (_) {}
        try { client.shutdown(); } catch (_) {}
      }
      process.exit(gotData ? 0 : 1);
    }, 15000);

  } catch (e) {
    console.error('[TEST] ERROR:', e && e.message || e);
    if (client) {
      try { await client.shutdown(); } catch (_) {}
    }
    process.exit(1);
  }
})();