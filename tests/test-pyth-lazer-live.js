#!/usr/bin/env node
/**
 * Pyth Lazer Real-Time Feed Test
 * Validates that Pyth Lazer WebSocket connects and receives data
 * Uses fixed_rate@1000ms by default (or override via PYTH_LAZER_CHANNEL)
 * 
 * Usage:
 *   node test-pyth-lazer-live.js
 */

require('dotenv').config();

const token = process.env.PYTH_LAZER_TOKEN;
if (!token) {
  console.error('❌ PYTH_LAZER_TOKEN not found in .env');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════════');
const PYTH_TEST_CHANNEL = process.env.PYTH_LAZER_CHANNEL || 'fixed_rate@1000ms';

console.log(`Pyth Lazer Live WebSocket Test (${PYTH_TEST_CHANNEL})`);
console.log('═══════════════════════════════════════════════════════════════\n');

const LAZER_FEED_IDS = [1, 2, 6, 10, 13, 14, 15, 110]; // BTC,ETH,SOL,DOGE,F13,XRP,BNB,F110
const LAZER_ID_MAP   = { 1:'BTCUSD', 2:'ETHUSD', 6:'SOLUSD', 10:'DOGEUSD', 14:'XRPUSD', 15:'BNBUSD' };

(async () => {
  try {
    console.log('[TEST] Loading Pyth Lazer SDK...');
    const { PythLazerClient } = require('@pythnetwork/pyth-lazer-sdk');

    console.log('[TEST] Creating Pyth Lazer client...');
    const client = await PythLazerClient.create({
      token,
      webSocketPoolConfig: {
        urls: [
          'wss://pyth-lazer-0.dourolabs.app/v1/stream',
          'wss://pyth-lazer-1.dourolabs.app/v1/stream',
          'wss://pyth-lazer-2.dourolabs.app/v1/stream',
        ],
      },
    });

    console.log(`[TEST] Subscribing to ${PYTH_TEST_CHANNEL} channel...\n`);

    client.subscribe({
      type:               'subscribe',
      subscriptionId:     1,
      priceFeedIds:       LAZER_FEED_IDS,
      properties:         ['price', 'bestBidPrice', 'bestAskPrice', 'confidence'],
      formats:            ['solana'],
      channel:            PYTH_TEST_CHANNEL,
      deliveryFormat:     'json',
      parsed:             true,
      ignoreInvalidFeeds: true,
    });

    let updateCount = 0;
    let lastUpdateTs = Date.now();
    let timeoutCheck = null;

    // ★ TIMEOUT CHECK: If no data in 5 seconds, fail
    function resetTimeoutCheck() {
      if (timeoutCheck) clearTimeout(timeoutCheck);
      timeoutCheck = setTimeout(() => {
        console.error('\n❌ TIMEOUT: No data received in 5 seconds');
        console.error('Check network connectivity and PYTH_LAZER_TOKEN validity');
        process.exit(1);
      }, 5000);
    }
    resetTimeoutCheck();

    client.addMessageListener((message) => {
      if (message.type !== 'json') return;
      const feeds = message.value?.parsed?.priceFeeds;
      if (!feeds?.length) return;

      updateCount++;
      const now = Date.now();
      const timeSinceLastUpdate = now - lastUpdateTs;
      lastUpdateTs = now;

      resetTimeoutCheck();

      const prices = {};
      for (const f of feeds) {
        const instr = LAZER_ID_MAP[f.priceFeedId];
        if (!instr) continue;
        const exp = f.exponent ?? -8;
        const scale = Math.pow(10, exp);
        const px = Number(f.price) * scale;
        if (!px || px <= 0 || isNaN(px)) continue;
        prices[instr] = {
          price: px.toFixed(2),
          bid: f.bestBidPrice != null ? (Number(f.bestBidPrice) * scale).toFixed(2) : 'N/A',
          ask: f.bestAskPrice != null ? (Number(f.bestAskPrice) * scale).toFixed(2) : 'N/A',
        };
      }

      if (Object.keys(prices).length > 0) {
        console.log(`[${updateCount}] Prices received in ${timeSinceLastUpdate}ms:`);
        for (const [sym, p] of Object.entries(prices)) {
          console.log(`  ${sym}: ${p.price} (bid: ${p.bid}, ask: ${p.ask})`);
        }
        console.log();
      }

      // Success after 3 updates
      if (updateCount >= 3) {
        clearTimeout(timeoutCheck);
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(`✅ SUCCESS: Pyth Lazer is working!`);
        console.log(`  Updates received: ${updateCount}`);
        console.log(`  Channel: ${PYTH_TEST_CHANNEL}`);
        console.log(`  Status: Connected and receiving real-time data`);
        console.log('═══════════════════════════════════════════════════════════════\n');
        process.exit(0);
      }
    });

    client.addAllConnectionsDownListener(() => {
      console.error('\n❌ All WebSocket connections down');
      process.exit(1);
    });

  } catch (e) {
    console.error('\n❌ ERROR:', e.message);
    console.error('\nTroubleshooting:');
    console.error('  1. Verify PYTH_LAZER_TOKEN is set in .env');
    console.error('  2. Check network connectivity');
    console.error('  3. Verify token is valid (not expired)');
    console.error('  4. Check Pyth Lazer service status at https://status.pyth.network/');
    process.exit(1);
  }
})();
