/**
 * Pyth Lazer WebSocket Handler (Official SDK)
 * Real-time price feeds via Pyth Lazer with redundant endpoint pool
 * 200ms fixed-rate updates, proper connection pooling
 */

const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
} catch (_) { }

const fs = require('fs');
const pathMod = path;

function readPythSecretFromFile() {
  const secretDirs = [
    pathMod.resolve(process.cwd(), 'secrets'),
    pathMod.resolve(__dirname, '../../secrets'),
    pathMod.resolve(__dirname, '../../../secrets'),
  ];
  // Newest first: user upgraded → secrets/PYTH_API (+ PYTH_NEW)
  const candidates = [
    'PYTH_API',
    'PYTH_API.txt',
    'PYTH_NEW',
    'PYTH_NEW.txt',
    'PYTH_NEW_API',
    'PYTH_NEW_API.txt'
  ];
  for (const dir of secretDirs) {
    for (const name of candidates) {
      try {
        const p = pathMod.join(dir, name);
        if (!fs.existsSync(p)) continue;
        // The file may hold a bare token, a label line followed by the token,
        // or KEY=value. Parse line-wise — never return multi-line content.
        const lines = fs.readFileSync(p, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        for (const line of lines) {
          const kv = line.match(/^[A-Za-z0-9_.-]+\s*=\s*(.+)$/);
          if (kv) return kv[1].trim().replace(/^["']|["']$/g, '');
        }
        // Token = longest whitespace-free line (skips short label lines),
        // matching readSecretScalar in electron/main.js.
        const best = lines.filter((l) => !/\s/.test(l))
          .reduce((a, b) => (b.length > a.length ? b : a), '');
        if (best) return best.replace(/^["']|["']$/g, '');
      } catch (_) {}
    }
  }
  return '';
}

const { PythLazerClient } = require("@pythnetwork/pyth-lazer-sdk");

let LAZER_TOKEN = process.env.PYTH_LAZER_TOKEN || process.env.PYTH_API_KEY || process.env.PYTH_API || process.env.PYTH_NEW || process.env.PYTH_NEW_API || process.env.LAZER_TOKEN || '';
const fromSecret = readPythSecretFromFile();
if (fromSecret) {
  LAZER_TOKEN = fromSecret;
  process.env.PYTH_API = fromSecret;
  process.env.PYTH_NEW = fromSecret;
  process.env.PYTH_NEW_API = fromSecret;
  process.env.PYTH_LAZER_TOKEN = fromSecret;
  process.env.PYTH_API_KEY = fromSecret;
  process.env.LAZER_TOKEN = fromSecret;
  console.log('[PythLazerWS] Using token from secrets/PYTH_API or env for realtime');
} else if (process.env.PYTH_LAZER_TOKEN || process.env.PYTH_API_KEY || process.env.PYTH_API || process.env.PYTH_NEW || process.env.PYTH_NEW_API) {
  LAZER_TOKEN = process.env.PYTH_LAZER_TOKEN || process.env.PYTH_API_KEY || process.env.PYTH_API || process.env.PYTH_NEW || process.env.PYTH_NEW_API || process.env.LAZER_TOKEN;
}

const PRICE_FEED_IDS = {
  BTC: 1,
  ETH: 2,
  SOL: 6,
  DOGE: 10,
  XRP: 14,
  BNB: 15,
};
const EXTRA_PRICE_FEED_IDS = [13, 110];
const SUBSCRIPTION_PRICE_FEED_IDS = Array.from(new Set([
  ...Object.values(PRICE_FEED_IDS),
  ...EXTRA_PRICE_FEED_IDS,
]));

class PythLazerWebSocketHandler {
  constructor() {
    this.client = null;
    this.clients = new Set();
    this.connected = false;
    this.subscriptionId = 1;
  }

  /**
   * Initialize and connect to Pyth Lazer WebSocket pool
   */
  async connect() {
    try {
      if (!LAZER_TOKEN) {
        throw new Error("PYTH_NEW_API not set");
      }
      console.log("[PythLazerWS] Initializing official SDK client...");

      const endpoints = [
        "wss://pyth-lazer-0.dourolabs.app/v1/stream",
        "wss://pyth-lazer-1.dourolabs.app/v1/stream",
        "wss://pyth-lazer-2.dourolabs.app/v1/stream",
      ];
      this.client = await PythLazerClient.create({
        token: LAZER_TOKEN,
        webSocketPoolConfig: { urls: endpoints }
      });

      console.log("[PythLazerWS] ✅ Client created, subscribing to price feeds...");

      // --- Network Health Reporting ---
      if (typeof window !== 'undefined' && window.NetworkHealth) {
        window.NetworkHealth.update('Pyth', {
          status: 'healthy',
          lastFetch: Date.now(),
          fallback: false,
          reason: '',
        });
      }

      // Subscribe to all price feeds with enhanced properties
      this.client.subscribe({
        type: "subscribe",
        subscriptionId: this.subscriptionId,
        priceFeedIds: SUBSCRIPTION_PRICE_FEED_IDS,
        properties: [
          "price",
          "marketSession",
          "fundingRateInterval",
          "feedUpdateTimestamp",
          "confidence",
          "fundingRate",
          "bestAskPrice",
          "publisherCount",
          "bestBidPrice",
          "exponent",
          "fundingTimestamp",
        ],
        formats: ["solana", "leUnsigned", "leEcdsa", "evm"], // Multiple encoding formats
        channel: "real_time", // Real-time updates (no 200ms throttle)
        deliveryFormat: "json",
        jsonBinaryEncoding: "hex",
        parsed: true,
        ignoreInvalidFeeds: true,
      });

      console.log(`[PythLazerWS] Subscribed to price feeds: ${SUBSCRIPTION_PRICE_FEED_IDS.join(',')} (real-time)`);

      // Listen for price updates
      this.client.addMessageListener((message) => {
        if (message.type === "json") {
          this.handlePriceUpdate(message.value);
        }
      });

      // Handle connection failures
      this.client.addAllConnectionsDownListener(() => {
        console.error("[PythLazerWS] ⚠️ A WebSocket connection went down, reconnecting...");
        // If all 3 go down, we consider it disconnected.
        // SDK handles reconnection automatically
        if (typeof window !== 'undefined' && window.NetworkHealth) {
          window.NetworkHealth.update('Pyth', {
            status: 'down',
            lastFetch: Date.now(),
            fallback: true,
            reason: 'Connection down',
          });
        }
      });

      this.connected = true;
      console.log("[PythLazerWS] 🟢 Connected to Pyth Lazer (3x endpoint pool)");
    } catch (err) {
      console.error(`[PythLazerWS] ❌ Connection failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Handle price update and relay to all clients with enhanced data
   */
  handlePriceUpdate(data) {
    try {
      const feeds = data?.parsed?.priceFeeds || data?.parsed?.priceFeedUpdates;
      if (!Array.isArray(feeds) || !feeds.length) {
        return;
      }

      feeds.forEach((feed) => {
        // Convert feed ID back to symbol
        const symbol = Object.entries(PRICE_FEED_IDS).find(
          ([_, id]) => id === feed.priceFeedId
        )?.[0];

        if (!symbol) return;
        const exponent = feed.exponent ?? feed.price?.expo ?? -8;
        const rawPrice = feed.price?.price ?? feed.price ?? 0;
        const rawConf = feed.price?.conf ?? feed.confidence ?? 0;
        const feedTs = Number(feed.feedUpdateTimestamp || 0);
        const publishTime = feed.publishTime
          || (feedTs ? (feedTs > 20_000_000_000 ? Math.floor(feedTs / 1000) : Math.floor(feedTs)) : Math.floor(Date.now() / 1000));

        // Convert to Pyth standard format with all enhanced properties
        const update = {
          type: "price_update",
          account: `Crypto.${symbol}/USD`,
          price: {
            price: rawPrice,
            conf: rawConf,
            expo: exponent,
            publish_time: publishTime,
          },
          // Enhanced Lazer properties
          marketSession: feed.marketSession || null,
          fundingRateInterval: feed.fundingRateInterval || null,
          feedUpdateTimestamp: feed.feedUpdateTimestamp || null,
          confidence: feed.confidence || null,
          fundingRate: feed.fundingRate || null,
          bestAskPrice: feed.bestAskPrice || null,
          publisherCount: feed.publisherCount || null,
          bestBidPrice: feed.bestBidPrice || null,
          exponent,
        };

        const msg = JSON.stringify(update);
        this.clients.forEach((ws) => {
          if (ws.readyState === 1) { // WebSocket.OPEN
            try { ws.send(msg); } catch (e) {}
          }
        });
      });
    } catch (e) {
      console.error("[PythLazerWS] Error handling price update:", e);
    }
  }

  addClient(ws) {
    this.clients.add(ws);
  }

  removeClient(ws) {
    this.clients.delete(ws);
  }

  async disconnect() {
    if (this.client) {
      try { this.client.close(); } catch (e) {}
    }
    this.connected = false;
  }

  status() {
    return {
      connected: this.connected,
      clients: this.clients.size,
      updateRate: "real-time (lowest latency)",
      endpoints: 3,
      priceFeedsCount: Object.keys(PRICE_FEED_IDS).length,
    };
  }
}

module.exports = PythLazerWebSocketHandler;
