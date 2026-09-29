const WebSocket = require('ws');
const axios = require('axios');

// --- CONFIGURATION ---
const ASSET_ID = 'SOL-USD'; // Coinbase pairing
const COINGECKO_ID = 'solana'; // CoinGecko pairing
const COINGECKO_POLL_INTERVAL = 15000; // Poll CoinGecko every 15 seconds to avoid rate limits

// State variables to hold the latest prices
let latestCoinbasePrice = null;
let latestCoinGeckoPrice = null;

// --- 1. COINBASE WEBSOCKET (LIVE TICK DATA) ---
function connectCoinbase() {
    const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');

    ws.on('open', () => {
        console.log(`[Coinbase] Connected. Subscribing to tick data for ${ASSET_ID}...`);
        const subscribeMessage = {
            type: 'subscribe',
            product_ids: [ASSET_ID],
            channels: ['ticker']
        };
        ws.send(JSON.stringify(subscribeMessage));
    });

    ws.on('message', (data) => {
        const parsed = JSON.parse(data);
        if (parsed.type === 'ticker' && parsed.price) {
            latestCoinbasePrice = parseFloat(parsed.price);
            processPriceValidation();
        }
    });

    ws.on('error', (err) => console.error('[Coinbase] WebSocket Error:', err));
    
    // Auto-reconnect if the connection drops
    ws.on('close', () => {
        console.log('[Coinbase] Connection closed. Reconnecting in 3 seconds...');
        setTimeout(connectCoinbase, 3000);
    });
}

// --- 2. COINGECKO REST API (BASELINE VALIDATION) ---
async function fetchCoinGeckoPrice() {
    try {
        const response = await axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_ID}&vs_currencies=usd`
        );
        if (response.data && response.data[COINGECKO_ID] && response.data[COINGECKO_ID].usd) {
            latestCoinGeckoPrice = parseFloat(response.data[COINGECKO_ID].usd);
            console.log(`\n[CoinGecko] Baseline Snapshot Updated: $${latestCoinGeckoPrice.toFixed(4)}`);
        }
    } catch (error) {
        console.error('[CoinGecko] Fetch Error (Rate limit or network issue):', error.message);
    }
}

// --- 3. CROSS-REFERENCE & ORBITAL SIGNAL OUTPUT ---
function processPriceValidation() {
    // We only validate if we have data from both sources
    if (!latestCoinbasePrice || !latestCoinGeckoPrice) return;

    // Calculate the delta (divergence) between the live feed and the macro snapshot
    const priceDelta = Math.abs(latestCoinbasePrice - latestCoinGeckoPrice);
    const percentageDelta = (priceDelta / latestCoinGeckoPrice) * 100;

    // Output formatted directly for the CLI / Log parsing
    const timestamp = new Date().toISOString();
    
    // Check for massive variance (potential manipulation, flash crash, or massive volatility)
    let alertFlag = percentageDelta > 1.0 ? " [!] HIGH VARIANCE" : "";

    console.log(`[${timestamp}] Live: $${latestCoinbasePrice.toFixed(4)} | Ref: $${latestCoinGeckoPrice.toFixed(4)} | Diff: ${percentageDelta.toFixed(3)}%${alertFlag}`);

    // --> INJECTION POINT FOR FIREBASE / TIDE <--
    // Here is where you will route the validated 'latestCoinbasePrice' payload 
    // to your internal TIDE storage for the 15-minute prediction windows.
}

// --- INITIALIZE SYSTEM ---
console.log('Starting WECRYPTO High-Frequency Aggregator...');
connectCoinbase();
fetchCoinGeckoPrice();

// Set interval to continuously refresh the CoinGecko baseline
setInterval(fetchCoinGeckoPrice, COINGECKO_POLL_INTERVAL);
