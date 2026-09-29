/**
 * aggregator.js
 * Standalone CLI aggregator for real-time price validation.
 * Coinbase Advanced Trade WS (live ticks) × CoinGecko REST (baseline snapshots).
 *
 * Usage:
 *   node aggregator.js
 *   node aggregator.js > tide_feed_log.txt
 *
 * Modify ASSET_ID / COINGECKO_ID to track any supported token.
 */

const WebSocket = require('ws');
const axios = require('axios');

// --- CONFIGURATION ---
const ASSET_ID            = 'SOL-USD';   // Coinbase Advanced Trade product ID
const COINGECKO_ID        = 'solana';    // CoinGecko coin ID
const COINGECKO_POLL_MS   = 60_000;      // Poll CoinGecko every 60s to stretch the 10k credits
const HIGH_VARIANCE_PCT   = 1.0;         // Flag divergences > 1%

// NOTE: wss://ws-feed.exchange.coinbase.com (Coinbase Pro) is DEPRECATED and shut down.
// The correct Advanced Trade endpoint is used below.
const COINBASE_WS_URL = 'wss://advanced-trade-ws.coinbase.com';

// --- State ---
let latestCoinbasePrice = null;
let latestCoinGeckoPrice = null;
let tickCount = 0;

// --- 1. COINBASE WEBSOCKET (LIVE TICK DATA) ---
function connectCoinbase() {
    const ws = new WebSocket(COINBASE_WS_URL);

    ws.on('open', () => {
        console.log(`[Coinbase] Connected to Advanced Trade WS. Subscribing to ${ASSET_ID}...`);
        ws.send(JSON.stringify({
            type: 'subscribe',
            product_ids: [ASSET_ID],
            channel: 'ticker'   // Advanced Trade uses 'channel', not 'channels'
        }));
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            // Advanced Trade WS wraps events in msg.events[].tickers[]
            let price = null;
            if (msg.channel === 'ticker' && Array.isArray(msg.events)) {
                for (const event of msg.events) {
                    if (Array.isArray(event.tickers)) {
                        for (const ticker of event.tickers) {
                            if (ticker.product_id === ASSET_ID && ticker.price) {
                                price = parseFloat(ticker.price);
                            }
                        }
                    }
                }
            }
            // Also handle legacy ticker format (fallback)
            if (!price && msg.type === 'ticker' && msg.price) {
                price = parseFloat(msg.price);
            }

            if (price) {
                latestCoinbasePrice = price;
                tickCount++;
                processPriceValidation();
            }
        } catch (e) { /* ignore parse errors */ }
    });

    ws.on('error', (err) => console.error('[Coinbase] WebSocket Error:', err.message));
    ws.on('close', () => {
        console.log('[Coinbase] Connection closed. Reconnecting in 3 seconds...');
        setTimeout(connectCoinbase, 3000);
    });
}

// --- 2. COINGECKO REST API (BASELINE VALIDATION) ---
async function fetchCoinGeckoPrice() {
    try {
        const response = await axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_ID}&vs_currencies=usd&x_cg_demo_api_key=${process.env.COINGECKO_API_KEY || ''}`,
            { timeout: 8000 }
        );
        const price = response.data?.[COINGECKO_ID]?.usd;
        if (price) {
            latestCoinGeckoPrice = parseFloat(price);
            console.log(`\n[CoinGecko] Baseline Snapshot Updated: $${latestCoinGeckoPrice.toFixed(4)} | Ticks since last snapshot: ${tickCount}`);
            tickCount = 0; // Reset tick counter per snapshot window
        }
    } catch (err) {
        console.error('[CoinGecko] Fetch Error:', err.message);
    }
}

// --- 3. CROSS-REFERENCE & ORBITAL SIGNAL OUTPUT ---
function processPriceValidation() {
    if (!latestCoinbasePrice || !latestCoinGeckoPrice) return;

    const priceDelta      = Math.abs(latestCoinbasePrice - latestCoinGeckoPrice);
    const percentageDelta = (priceDelta / latestCoinGeckoPrice) * 100;
    const timestamp       = new Date().toISOString();
    const alertFlag       = percentageDelta > HIGH_VARIANCE_PCT ? ' [!] HIGH VARIANCE' : '';

    console.log(
        `[${timestamp}] Live: $${latestCoinbasePrice.toFixed(4)} | ` +
        `Ref: $${latestCoinGeckoPrice.toFixed(4)} | ` +
        `Diff: ${percentageDelta.toFixed(3)}%${alertFlag}`
    );

    // --> INJECTION POINT FOR FIREBASE / TIDE / Redpanda <--
    // Route validated payload to orbital-redpanda-bridge.js:
    //   produceOrbitalTick('s', 'SOL', { source: 'coinbase', price_usd: latestCoinbasePrice, ts: Date.now() });
    //   if (divergence is acceptable) produceOrbitalTick('s', 'SOL', ...baseline...)
}

// --- INITIALIZE ---
console.log('='.repeat(60));
console.log('  WECRYPTO High-Frequency Aggregator (Standalone CLI)');
console.log(`  Asset: ${ASSET_ID} | CoinGecko: ${COINGECKO_ID}`);
console.log(`  Coinbase WS: ${COINBASE_WS_URL}`);
console.log('='.repeat(60));

connectCoinbase();
fetchCoinGeckoPrice(); // Run immediately
setInterval(fetchCoinGeckoPrice, COINGECKO_POLL_MS);
