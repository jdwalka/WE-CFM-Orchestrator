/**
 * Pyth Lazer HTTP Poller
 * Polls Pyth Lazer REST API and emits WebSocket-like messages
 * Integrates with ws-proxy-server.js to provide price updates
 */

const https = require('https');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
} catch (_) { }

const PYTH_LAZER_URL = 'https://pyth-lazer.dourolabs.app/v1/latest_price';
const PYTH_API_KEY = process.env.PYTH_LAZER_TOKEN || process.env.PYTH_API_KEY || process.env.LAZER_TOKEN || '';

const SYMBOLS = [
  'Crypto.BTC/USD',
  'Crypto.ETH/USD',
  'Crypto.SOL/USD',
  'Crypto.XRP/USD',
  'Crypto.DOGE/USD',
  'Crypto.BNB/USD',
  'Crypto.HYPE/USD',
];

class PythLazerPoller {
  constructor() {
    this.clients = new Set();
    this.pollInterval = null;
    this.lastUpdate = null;
    this.connected = false;
  }

  /**
   * Start polling Pyth Lazer API
   */
  start(intervalMs = 1000) {
    if (this.pollInterval) {
      console.log('[PythLazer] Poller already running');
      return;
    }

    console.log(`[PythLazer] Starting poller (${intervalMs}ms interval)`);
    this.connected = true;

    // Initial poll
    this.poll();

    // Set interval for continuous polling
    this.pollInterval = setInterval(() => {
      this.poll();
    }, intervalMs);
  }

  /**
   * Stop polling
   */
  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.connected = false;
      console.log('[PythLazer] Poller stopped');
    }
  }

  /**
   * Register a client to receive updates
   */
  addClient(client) {
    this.clients.add(client);
    console.log(`[PythLazer] Client added (total: ${this.clients.size})`);
  }

  /**
   * Unregister a client
   */
  removeClient(client) {
    this.clients.delete(client);
    console.log(`[PythLazer] Client removed (total: ${this.clients.size})`);
  }

  /**
   * Poll Pyth Lazer API and emit updates
   */
  poll() {
    if (!PYTH_API_KEY) {
      if (!this._warnedMissingToken) {
        this._warnedMissingToken = true;
        console.warn('[PythLazer] PYTH_LAZER_TOKEN not set; poller disabled');
      }
      this.connected = false;
      return;
    }

    const payload = JSON.stringify({
      channel: 'real_time',
      formats: ['evm'],
      properties: ['price'],
      symbols: SYMBOLS,
      parsed: true,
      jsonBinaryEncoding: 'hex',
    });

    const options = {
      hostname: 'pyth-lazer.dourolabs.app',
      port: 443,
      path: '/v1/latest_price',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PYTH_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'WE-CRYPTO/2.4.8',
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const response = JSON.parse(data);
            this.handlePriceUpdate(response);
          } catch (e) {
            console.error(`[PythLazer] JSON parse error: ${e.message}`);
          }
        } else {
          console.warn(`[PythLazer] API returned ${res.statusCode}`);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[PythLazer] Request error: ${err.message}`);
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn('[PythLazer] Request timeout');
    });

    req.write(payload);
    req.end();
  }

  /**
   * Process price updates and emit to clients
   */
  handlePriceUpdate(response) {
    // Pyth Lazer returns: { parsed: { priceFeeds: [...] }, evm: { data: "..." } }
    if (!response.parsed || !response.parsed.priceFeeds) {
      return;
    }

    const feeds = response.parsed.priceFeeds;
    const timestamp = Date.now();

    // Map feed IDs to symbols (based on Pyth product IDs)
    const symbolMap = {
      '0': 'Crypto.BTC/USD',
      '1': 'Crypto.ETH/USD',
      '2': 'Crypto.ETH/USD', // priceFeedId 2 = ETH
      '3': 'Crypto.SOL/USD',
      '4': 'Crypto.XRP/USD',
      '5': 'Crypto.DOGE/USD',
      '6': 'Crypto.BNB/USD',
      '7': 'Crypto.HYPE/USD',
    };

    feeds.forEach((feed) => {
      const symbol = symbolMap[feed.priceFeedId.toString()] || `Crypto.UNKNOWN${feed.priceFeedId}`;
      const price = parseInt(feed.price);

      // Convert Lazer format to Pyth standard format
      const update = {
        type: 'price_update',
        account: symbol,
        price: {
          price: price,
          conf: 0,
          expo: -8, // Pyth standard exponent
          publish_time: Math.floor(timestamp / 1000),
        },
      };

      // Emit to all connected clients
      this.clients.forEach((client) => {
        try {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(JSON.stringify(update));
          }
        } catch (e) {
          console.error(`[PythLazer] Send error: ${e.message}`);
        }
      });
    });

    this.lastUpdate = timestamp;
  }
}

module.exports = PythLazerPoller;
