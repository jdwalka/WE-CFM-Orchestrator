/**
 * api-rate-limiter.js — Global rate limiter with token bucket algorithm
 *
 * Provides token bucket rate limiting for APIs to prevent 429 errors.
 * Each API has configurable requests-per-second limit.
 *
 * Usage:
 *   const limiter = new RateLimiter('coingecko', 0.33);  // ~20 req/min
 *   await limiter.acquire();
 *   const response = await fetch(url);
 */

(function () {
  'use strict';

  class RateLimiter {
    constructor(name, requestsPerSecond) {
      this.name = name;
      this.rps = requestsPerSecond || 10;
      this.capacity = Math.max(1, Math.ceil(this.rps));
      this.tokens = this.capacity;
      this.lastRefill = Date.now();
      this.waitQueue = [];
      this.drainTimer = null;
    }

    _refill() {
      const now = Date.now();
      const timePassed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + timePassed * this.rps);
      this.lastRefill = now;
    }

    _scheduleDrain() {
      if (this.drainTimer || this.waitQueue.length === 0) return;
      const waitTime = this.tokens >= 1 ? 0 : ((1 - this.tokens) * 1000 / this.rps);
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        this._refill();
        while (this.tokens >= 1 && this.waitQueue.length > 0) {
          const entry = this.waitQueue.shift();
          if (entry.signal && entry.signal.aborted) continue;
          this.tokens -= 1;
          entry.resolve();
        }
        this._scheduleDrain();
      }, Math.max(0, Math.ceil(waitTime)));
    }

    /**
     * Acquire a token, waiting if necessary
     * @param {AbortSignal} [signal]
     * @returns {Promise<void>}
     */
    async acquire(signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        this._refill();

        if (this.tokens >= 1) {
          // Immediate acquisition
          this.tokens -= 1;
          resolve();
        } else {
          const entry = { resolve, reject, signal };
          this.waitQueue.push(entry);
          
          if (signal) {
            const onAbort = () => {
              signal.removeEventListener('abort', onAbort);
              const idx = this.waitQueue.indexOf(entry);
              if (idx !== -1) {
                this.waitQueue.splice(idx, 1);
                reject(signal.reason || new DOMException('Aborted', 'AbortError'));
              }
            };
            signal.addEventListener('abort', onAbort);
          }
          this._scheduleDrain();
        }
      });
    }

    /**
     * Get current queue length
     */
    getQueueLength() {
      return this.waitQueue.length;
    }

    /**
     * Get available tokens
     */
    getAvailableTokens() {
      return Math.max(0, Math.floor(this.tokens));
    }

    /**
     * Reset limiter
     */
    reset() {
      this.tokens = this.capacity;
      this.lastRefill = Date.now();
      this.waitQueue = [];
      if (this.drainTimer) clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  // Registry of all limiters by name
  const limiters = {
    'coingecko': new RateLimiter('coingecko', 0.33), // ~20 req/min (1 every 3s) matches 20s queue timeout
    'coinbase': new RateLimiter('coinbase', 4),        // adaptive floor/ceiling handled by orchestrator
    'okx': new RateLimiter('okx', 10),
    'okc': new RateLimiter('okc', 10),
    'bitstamp': new RateLimiter('bitstamp', 5),
    'coinmarketcap': new RateLimiter('coinmarketcap', 0.45), // ~27 req/min
    'binance': new RateLimiter('binance', 10),         // 1200 req/min = 20 req/sec
    'bybit': new RateLimiter('bybit', 10),             // 50 req/sec
    'kraken': new RateLimiter('kraken', 15),           // 15 req/sec public
    'kucoin': new RateLimiter('kucoin', 10),
    'mexc': new RateLimiter('mexc', 8),
    'bitfinex': new RateLimiter('bitfinex', 8),
    'cryptocom': new RateLimiter('cryptocom', 8),
    'polymarket': new RateLimiter('polymarket', 30),
    'polymarket-gamma': new RateLimiter('polymarket-gamma', 30), // 300 req / 10s
    'polymarket-clob': new RateLimiter('polymarket-clob', 150),  // 1500 req / 10s
    'polymarket-data': new RateLimiter('polymarket-data', 15),   // 150 req / 10s
    'polymarket-relayer': new RateLimiter('polymarket-relayer', 0.4), // 24 req / min (<25/min)
    'polymarket-bridge': new RateLimiter('polymarket-bridge', 5), // 50 req / 10s
    'blockchainraw': new RateLimiter('blockchainraw', 8),
    'blockcypher': new RateLimiter('blockcypher', 0.05), // 180 req/hr, below 200 req/hr free
    'blockscout': new RateLimiter('blockscout', 3),    // conservative public API pacing
    'chainso': new RateLimiter('chainso', 1),          // conservative fallback pacing
    'default': new RateLimiter('default', 5),          // Conservative default
  };

  /**
   * Get or create a rate limiter for an API
   * @param {string} apiName - Name of API
   * @param {number} rps - Requests per second (optional)
   * @returns {RateLimiter}
   */
  function getLimiter(apiName, rps) {
    if (!limiters[apiName]) {
      limiters[apiName] = new RateLimiter(apiName, rps || 5);
    }
    return limiters[apiName];
  }

  /**
   * Acquire token from limiter, with automatic API name detection
   * @param {string} apiName - Name of API
   * @param {AbortSignal} [signal] - Optional abort signal
   * @returns {Promise<void>}
   */
  async function acquireToken(apiName, signal) {
    const limiter = getLimiter(apiName);
    await limiter.acquire(signal);
  }

  /**
   * Get status of all limiters (for debugging)
   */
  function getStatus() {
    const status = {};
    Object.entries(limiters).forEach(([name, limiter]) => {
      status[name] = {
        availableTokens: limiter.getAvailableTokens(),
        rps: limiter.rps,
        queueLength: limiter.getQueueLength(),
      };
    });
    return status;
  }

  // ─── Export to window ───────────────────────────────────────────────────
  window.ApiRateLimiter = {
    getLimiter,
    acquireToken,
    getStatus,
    RateLimiter,
  };

  console.info('[ApiRateLimiter] Loaded: Token bucket rate limiter for all APIs');
})();
