/**
 * orbital-ingestor-daemon.js
 * Ingestion layer for the Orbital Matrix.
 *
 * Maintains persistent connections to 4 data sources and pushes
 * orbital ticks to Redpanda:
 *
 *   CoinGecko   WS  → s-orbital (price_usd_coingecko)
 *   Coinbase    WS  → s-orbital (price_usd_coinbase_val)
 *                  → p-orbital (vwap_20, price_momentum, volume)  ← NEW
 *   Hyperliquid WS  → d-orbital (open_interest_usd, funding_rate)
 *   Kalshi    poll  → f-orbital (kalshi_yes_pct, volume, OI)      ← NEW
 *
 * Auto-reconnects on all WebSocket connections (5 s backoff).
 */

const WebSocket = require('ws');
const http = require('http');
const { enrichOrbitalPayload, produceOrbitalTick } = require('../infra/orbital-redpanda-bridge');
const DualSourceValidationLoop = require('./dual-source-validation-loop');
const OracleRedundancyIntegrator = require('./oracle-redundancy-integrator');
const Redis = require('ioredis');

let redisReady = false;
const redisPub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    retryStrategy(times) {
        return Math.min(1000 * times, 5000);
    }
});
redisPub.on('ready', () => { redisReady = true; });
redisPub.on('close', () => { redisReady = false; });
redisPub.on('end', () => { redisReady = false; });
redisPub.on('error', (err) => {
    // Suppress unhandled error events that crash the process
});

function publishTickToRedis(orbitalType, asset, payload) {
    if (!redisReady) return false;
    const channel = `orbital:ticks:${orbitalType}:${asset}`;
    redisPub.publish(channel, JSON.stringify(payload)).catch(err => {
        // suppress verbose logs unless in debug mode, but catch errors
    });
    return true;
}

function publishOrbitalTick(orbitalType, asset, payload) {
    const enrichedPayload = enrichOrbitalPayload(orbitalType, asset, payload, payload?.ts || Date.now());
    const produced = produceOrbitalTick(orbitalType, asset, enrichedPayload);
    publishTickToRedis(orbitalType, asset, enrichedPayload);
    return produced;
}

const COINGECKO_WS_URL   = 'wss://stream.coingecko.com/v1/stream';
const COINBASE_WS_URL    = 'wss://advanced-trade-ws.coinbase.com';
const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';

// Kalshi worker HTTP endpoint (spawned by Electron, always localhost:3050)
const KALSHI_WORKER_URL  = process.env.KALSHI_WORKER_URL || 'http://localhost:3050';

// Kalshi sentiment poll interval (30 s — fast enough to track rapid contract price moves)
const KALSHI_POLL_INTERVAL_MS = 30_000;

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const COINBASE_PRODUCTS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'HYPE-USD'];
const COINBASE_ASSETS = COINBASE_PRODUCTS.map(product => product.split('-')[0]);

// --- p-orbital: Rolling VWAP state ---
// Maintains a per-asset circular buffer of the last 20 Coinbase ticks
// (price × volume pairs) to compute a volume-weighted average price.
const VWAP_WINDOW = 20;
const vwapState = {};
for (const asset of ASSETS) {
    vwapState[asset] = {
        samples: new Array(VWAP_WINDOW),
        index: 0,
        count: 0,
        totalVol: 0,
        totalPxVol: 0
    };
}

/**
 * Update the VWAP buffer for an asset and return the current VWAP value.
 * If the tick has no volume data, falls back to price as a neutral weight.
 */
function updateVwap(asset, price, volume = 1) {
    const state = vwapState[asset];
    if (!state) return price;

    const safeVolume = Number.isFinite(volume) && volume > 0 ? volume : 1;
    const old = state.samples[state.index];
    if (old) {
        state.totalVol -= old.volume;
        state.totalPxVol -= old.price * old.volume;
    } else {
        state.count += 1;
    }

    state.samples[state.index] = { price, volume: safeVolume };
    state.totalVol += safeVolume;
    state.totalPxVol += price * safeVolume;
    state.index = (state.index + 1) % VWAP_WINDOW;

    const vwap = state.totalVol > 0
        ? state.totalPxVol / state.totalVol
        : price;

    return vwap;
}

// --- f-orbital: simple HTTP GET helper ---
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
            });
        }).on('error', reject);
    });
}

// --- Main class ---

class OrbitalIngestor {
    constructor() {
        this.connections = new Map();
        this._kalshiPollTimer = null;
        this._stopped = false;

        // Initialize Validation & Oracle Feedback Loops
        this.validationLoop = new DualSourceValidationLoop();
        this.oracleIntegrator = new OracleRedundancyIntegrator(this.validationLoop);

        this.oracleIntegrator.on('data_integrity_ok', (data) => {
            if (data.source === 'DECENTRALIZED') {
                const payload = {
                    source: 'decentralized_oracle',
                    price_usd: data.price,
                    ts: data.timestamp
                };
                publishOrbitalTick('s', data.asset, payload);
            }
        });
    }

    start() {
        console.log('[OrbitalIngestor] Starting high-velocity ingestion layer...');
        this._stopped = false;
        
        // Start validation loop for primary asset tracking (e.g., BTC)
        this.validationLoop.start('BTC');
        
        this.startCoinGeckoRESTPolling();
        this.connectCoinbase();
        this.connectHyperliquid();
        this.startKalshiPoll();
    }

    stop() {
        console.log('[OrbitalIngestor] Stopping...');
        this._stopped = true;
        this.validationLoop.stop();
        if (this._kalshiPollTimer) {
            clearInterval(this._kalshiPollTimer);
            this._kalshiPollTimer = null;
        }
        if (this._coingeckoPollTimer) {
            clearInterval(this._coingeckoPollTimer);
            this._coingeckoPollTimer = null;
        }
        for (const [, ws] of this.connections) {
            if (ws && typeof ws.close === 'function') ws.close();
        }
        this.connections.clear();
    }

    // ─── s-orbital: CoinGecko WebSocket ────────────────────────────────────────

    startCoinGeckoRESTPolling() {
        if (this._stopped) return;
        
        const pollIntervalMs = 30000;
        console.log(`[OrbitalIngestor] Starting CoinGecko REST polling (${pollIntervalMs}ms interval).`);
        
        this._coingeckoPollTimer = setInterval(async () => {
            if (this._stopped || this.oracleIntegrator.activeSource === 'DECENTRALIZED') return;
            
            try {
                const baseApiUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,dogecoin,hyperliquid&vs_currencies=usd';
                let url = baseApiUrl;
                if (typeof window !== 'undefined' && typeof window.coinGeckoUrl === 'function') {
                    url = window.coinGeckoUrl(baseApiUrl);
                } else if (typeof process !== 'undefined' && process.env && process.env.COINGECKO_API_KEY) {
                    url = `${baseApiUrl}&x_cg_demo_api_key=${process.env.COINGECKO_API_KEY}`;
                }

                let fetchOptions = {};
                if (typeof window !== 'undefined' && typeof window.withCoinGeckoAuth === 'function') {
                    fetchOptions = window.withCoinGeckoAuth(url) || {};
                }
                
                const fetchFn = typeof window !== 'undefined' && window.throttledFetch 
                    ? window.throttledFetch 
                    : fetch;
                    
                const res = await fetchFn(fetchOptions.url || url, fetchOptions);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                
                const data = await res.json();
                
                const idMap = {
                    'bitcoin': 'BTC',
                    'ethereum': 'ETH',
                    'solana': 'SOL',
                    'ripple': 'XRP',
                    'dogecoin': 'DOGE',
                    'hyperliquid': 'HYPE'
                };
                
                for (const [cgId, cgData] of Object.entries(data)) {
                    const asset = idMap[cgId];
                    if (asset && cgData && cgData.usd) {
                        const payload = {
                            source: 'coingecko',
                            price_usd: parseFloat(cgData.usd),
                            ts: Date.now()
                        };
                        publishOrbitalTick('s', asset, payload);
                    }
                }
            } catch (err) {
                console.warn('[OrbitalIngestor] CoinGecko REST error:', err.message);
            }
        }, pollIntervalMs);
    }

    // ─── s + p orbital: Coinbase WebSocket ─────────────────────────────────────

    connectCoinbase() {
        if (this._stopped) return;
        const ws = new WebSocket(COINBASE_WS_URL);
        this.connections.set('coinbase', ws);

        ws.on('open', () => {
            console.log('[OrbitalIngestor] Coinbase connected.');
            ws.send(JSON.stringify({
                type: 'subscribe',
                channel: 'heartbeats'
            }));
            ws.send(JSON.stringify({
                type: 'subscribe',
                product_ids: COINBASE_PRODUCTS,
                channel: 'ticker'
            }));
            ws.send(JSON.stringify({
                type: 'subscribe',
                product_ids: COINBASE_PRODUCTS,
                channel: 'market_trades'
            }));
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                // Coinbase Advanced Trade WS sends channel='ticker' or type='ticker'
                const isTicker = msg.type === 'ticker' || msg.channel === 'ticker';
                if (!isTicker) return;

                const asset = msg.product_id
                    ? msg.product_id.split('-')[0]
                    : (msg.events?.[0]?.tickers?.[0]?.product_id?.split('-')[0]);

                if (!asset || !COINBASE_ASSETS.includes(asset)) return;

                const price  = parseFloat(msg.price  || msg.events?.[0]?.tickers?.[0]?.price  || 0);
                const volume = parseFloat(msg.volume  || msg.events?.[0]?.tickers?.[0]?.volume || 0);

                if (!price) return;

                // Prevent ingesting primary API data if we're in decentralized fallback mode
                if (this.oracleIntegrator.activeSource === 'DECENTRALIZED') {
                    return;
                }

                // s-orbital: raw Coinbase price tick
                const sPayload = {
                    source: 'coinbase',
                    price_usd: price,
                    ts: Date.now()
                };
                publishOrbitalTick('s', asset, sPayload);

                // p-orbital: rolling 20-tick VWAP momentum
                const vwap = updateVwap(asset, price, volume);
                const momentum = vwap > 0 ? (price - vwap) / vwap : 0;

                const pPayload = {
                    source: 'coinbase',
                    vwap_20: vwap,
                    price_momentum: momentum,  // positive = price above VWAP (bullish pressure)
                    price: price,
                    volume: volume,
                    ts: Date.now()
                };
                publishOrbitalTick('p', asset, pPayload);
            } catch (err) { /* ignore malformed frames */ }
        });

        ws.on('error', (err) => console.warn('[OrbitalIngestor] Coinbase error:', err.message));
        ws.on('close', () => {
            this.connections.delete('coinbase');
            if (!this._stopped) setTimeout(() => this.connectCoinbase(), 5000);
        });
    }

    // ─── d-orbital: Hyperliquid WebSocket ──────────────────────────────────────

    connectHyperliquid() {
        if (this._stopped) return;
        const ws = new WebSocket(HYPERLIQUID_WS_URL);
        this.connections.set('hyperliquid', ws);

        ws.on('open', () => {
            console.log('[OrbitalIngestor] Hyperliquid connected.');
            ASSETS.forEach(asset => {
                ws.send(JSON.stringify({
                    method: 'subscribe',
                    subscription: { type: 'l2Book', coin: asset }
                }));
            });
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                const asset = msg.coin || msg.data?.coin;
                if (!asset || !ASSETS.includes(asset)) return;

                if (msg.data?.levels) {
                    const dPayload = {
                        source: 'hyperliquid',
                        open_interest_usd: msg.data.oi    || 0,
                        funding_rate:      msg.data.funding || 0,
                        ts: Date.now()
                    };
                    publishOrbitalTick('d', asset, dPayload);
                }
            } catch (err) { /* ignore malformed frames */ }
        });

        ws.on('error', (err) => console.warn('[OrbitalIngestor] Hyperliquid error:', err.message));
        ws.on('close', () => {
            this.connections.delete('hyperliquid');
            if (!this._stopped) setTimeout(() => this.connectHyperliquid(), 5000);
        });
    }

    // ─── f-orbital: Kalshi sentiment poll ──────────────────────────────────────

    startKalshiPoll() {
        console.log(`[OrbitalIngestor] Kalshi f-orbital poll started (every ${KALSHI_POLL_INTERVAL_MS / 1000}s).`);
        // Run immediately, then on interval
        this._pollKalshi();
        this._kalshiPollTimer = setInterval(() => this._pollKalshi(), KALSHI_POLL_INTERVAL_MS);
    }

        async _pollKalshi() {
        if (this._stopped) return;
        try {
            for (const asset of ASSETS) {
                const seriesTicker = "KX" + asset + "D";
                const url = `${KALSHI_WORKER_URL}/markets?series_ticker=${seriesTicker}&limit=10`;
                const response = await httpGet(url);
                
                if (!response || !response.success || !Array.isArray(response.data?.markets) || response.data.markets.length === 0) {
                    continue;
                }

                const assetMarkets = response.data.markets;
                const contract   = assetMarkets[0];
                const yesBid     = parseFloat(contract.yes_bid  ?? contract.yes_price ?? 50);
                const yesAsk     = parseFloat(contract.yes_ask  ?? contract.yes_price ?? 50);
                const yesMid     = (yesBid + yesAsk) / 2;
                const volume     = parseFloat(contract.volume          ?? 0);
                const openInterest = parseFloat(contract.open_interest ?? 0);

                const fPayload = {
                    source: 'kalshi',
                    kalshi_yes_pct: yesMid,
                    kalshi_yes_bid: yesBid,
                    kalshi_yes_ask: yesAsk,
                    kalshi_volume: volume,
                    kalshi_open_interest: openInterest,
                    contract_ticker: contract.ticker || '',
                    ts: Date.now()
                };
                publishOrbitalTick('f', asset, fPayload);
            }
        } catch (err) {
            if (process.env.NODE_ENV !== 'production') {
                console.warn('[OrbitalIngestor] Kalshi f-orbital poll error:', err.message);
            }
        }
    }
}

module.exports = new OrbitalIngestor();

