// Binance gRPC (optional): do not block orchestrator startup when gRPC globals
// are unavailable in the renderer/browser runtime.
if (
  typeof window !== 'undefined' &&
  typeof grpc !== 'undefined' &&
  typeof protoLoader !== 'undefined'
) {
  try {
    const binancePackageDef = protoLoader.loadSync('protos/binance.proto', {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    const binanceProto = grpc.loadPackageDefinition(binancePackageDef).binance.marketdata;
    const binanceClient = new binanceProto.MarketData('binance.grpc.public:443', grpc.credentials.createSsl());
    window.grpcBinanceHandler = async function grpcBinanceHandler(context, endpoint) {
      // context: { url, options }
      // Example: expects context.options to have { symbol, interval, startTime, endTime, limit }
      return new Promise((resolve, reject) => {
        binanceClient.GetKlines(context.options, (err, response) => {
          if (err) return reject(err);
          resolve(response);
        });
      });
    };
  } catch (err) {
    console.warn('[ProxyOrchestrator] gRPC bootstrap unavailable:', err && err.message ? err.message : err);
  }
}
/**
 * ================================================================
 * PROXY ORCHESTRATOR — Rate-limit resilience for trading APIs
 * ================================================================
 *
 * Prevents rate-limit data loss through:
 * 1. Request deduplication (coalesce identical requests within 500ms)
 * 2. Adaptive backoff (exponential 2s → 32s on 429/503)
 * 3. Circuit breaker (stop after 3 failures, recover after 60s)
 * 4. Fallback chains (primary → fallback → cache)
 * 5. Multi-layer cache (in-memory → localStorage → disk → network)
 *
 * Usage:
 *   window._proxyOrchestrator = new ProxyOrchestrator(config);
 *   const data = await _proxyOrchestrator.fetch(url, { endpoint: 'kalshi' });
 *   console.log(_proxyOrchestrator.getHealthStatus());
 *
 * Export metrics every 30s to: F:\WECRYPTO\data\{date}\proxy-metrics.jsonl
 * ================================================================
 */

(function () {
  'use strict';

  // ── RATE LIMIT CONFIGURATION ────────────────────────────────────
  const RATE_LIMITS = {
    kalshi: { reqs_per_min: 100, burst: 0, backoff_start: 2000, backoff_max: 32000 },
    polymarket: { reqs_per_second: 4, reqs_per_minute: 180, burst: 8, backoff_start: 2500, backoff_max: 45000 },
    cmc: { credits_per_month: 20000, per_request: 1, burst: 0, backoff_start: 5000 },

    coinbase: { reqs_per_second: 4, burst: 15, backoff_start: 3000, backoff_max: 20000 },
    okx: { reqs_per_second: 12, reqs_per_minute: 700, burst: 30, backoff_start: 1000, backoff_max: 25000 },
    okc: { reqs_per_second: 12, reqs_per_minute: 700, burst: 30, backoff_start: 1000, backoff_max: 25000 },
    bitstamp: { reqs_per_second: 8, reqs_per_minute: 400, burst: 25, backoff_start: 1200, backoff_max: 30000 },
    kraken: { reqs_per_second: 10, reqs_per_minute: 500, burst: 20, backoff_start: 1200, backoff_max: 30000 },
    bybit: { reqs_per_second: 20, reqs_per_minute: 900, burst: 60, backoff_start: 800, backoff_max: 20000 },
    binance: { reqs_per_second: 20, reqs_per_minute: 1200, burst: 100, backoff_start: 800, backoff_max: 15000 },
    kucoin: { reqs_per_second: 12, reqs_per_minute: 700, burst: 30, backoff_start: 1200, backoff_max: 25000 },
    mexc: { reqs_per_second: 10, reqs_per_minute: 600, burst: 30, backoff_start: 1500, backoff_max: 25000 },
    bitfinex: { reqs_per_second: 10, reqs_per_minute: 600, burst: 25, backoff_start: 1500, backoff_max: 25000 },
    cryptocom: { reqs_per_second: 10, reqs_per_minute: 600, burst: 25, backoff_start: 1400, backoff_max: 25000 },
    pyth: { reqs_per_second: 20, burst: 50, backoff_start: 1000, backoff_max: 20000 },
    coingecko: { reqs_per_minute: 20, burst: 10, backoff_start: 3000, backoff_max: 90000 },
    blockchainraw: { reqs_per_second: 10, reqs_per_minute: 500, burst: 20, backoff_start: 1000, backoff_max: 20000 },
    default: { reqs_per_second: 5, reqs_per_minute: 240, burst: 10, backoff_start: 1500, backoff_max: 30000 },
  };

  // Provider timing audit matrix (operational min/max bounds used by cascade timer).
  const PROVIDER_TIMING_AUDIT = {
    coingecko: {
      hostPatterns: ['coingecko.com'],
      minRpm: 300, maxRpm: 600,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 550000,
    },
    coinbase: {
      hostPatterns: ['exchange.coinbase.com', 'coinbase.com'],
      minRps: 4, maxRps: 15,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 650000,
    },
    okx: {
      hostPatterns: ['okx.com', 'okcoin.com'],
      minRps: 5, maxRps: 12,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 700000,
    },
    okc: {
      hostPatterns: ['okx.com', 'okcoin.com'],
      minRps: 5, maxRps: 12,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 700000,
    },
    bitstamp: {
      hostPatterns: ['bitstamp.net'],
      minRps: 3, maxRps: 8,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 600000,
    },
    binance: {
      hostPatterns: ['binance.com', 'binance.vision'],
      minRps: 8, maxRps: 20,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 800000,
    },
    bybit: {
      hostPatterns: ['bybit.com'],
      minRps: 8, maxRps: 20,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 800000,
    },
    kraken: {
      hostPatterns: ['kraken.com'],
      minRps: 5, maxRps: 15,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 700000,
    },
    kucoin: {
      hostPatterns: ['kucoin.com'],
      minRps: 5, maxRps: 12,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 700000,
    },
    mexc: {
      hostPatterns: ['mexc.com'],
      minRps: 4, maxRps: 10,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 700000,
    },
    bitfinex: {
      hostPatterns: ['bitfinex.com'],
      minRps: 4, maxRps: 10,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 700000,
    },
    cryptocom: {
      hostPatterns: ['crypto.com'],
      minRps: 4, maxRps: 10,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 700000,
    },
    kalshi: {
      hostPatterns: ['kalshi.com', 'elections.kalshi.com'],
      minRps: 3, maxRps: 12,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 120, maxIntervalMs: 2500,
      maxPayloadBytes: 900000,
    },
    polymarket: {
      hostPatterns: ['polymarket.com', 'clob.polymarket.com', 'gamma-api.polymarket.com'],
      minRps: 2, maxRps: 6,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 180, maxIntervalMs: 3000,
      maxPayloadBytes: 900000,
    },
    pyth: {
      hostPatterns: ['pyth.network', 'pythnet', 'hermes'],
      minRps: 8, maxRps: 20,
      minTimeoutMs: 8000, maxTimeoutMs: 25000,
      minIntervalMs: 50, maxIntervalMs: 1000,
      maxPayloadBytes: 600000,
    },

    blockchainraw: {
      hostPatterns: ['mempool.space', 'blockchair.com', 'etherscan.io', 'blockscout.com', 'xrplcluster.com', 'solana.com'],
      minRps: 2, maxRps: 6,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 160, maxIntervalMs: 2500,
      maxPayloadBytes: 600000,
    },
    default: {
      hostPatterns: [],
      minRps: 2, maxRps: 8,
      minTimeoutMs: 15000, maxTimeoutMs: 45000,
      minIntervalMs: 60000, maxIntervalMs: 300000,
      maxPayloadBytes: 500000,
    },
  };

  // ── DYNAMIC RATE LIMITS MAPPING ─────────────────────────────────
  Object.keys(PROVIDER_TIMING_AUDIT).forEach((key) => {
    const audit = PROVIDER_TIMING_AUDIT[key];
    const limits = RATE_LIMITS[key] || {};
    if (audit.minRps && audit.maxRps) {
      limits.reqs_per_minute = Math.floor(((audit.minRps + audit.maxRps) / 2) * 60);
      limits.backoff_start = Math.max(1000, Math.round(audit.maxIntervalMs * (audit.maxRps / audit.minRps)));
    } else if (audit.minRpm && audit.maxRpm) {
      limits.reqs_per_minute = Math.floor((audit.minRpm + audit.maxRpm) / 2);
      limits.backoff_start = Math.max(1000, Math.round(audit.maxIntervalMs * (audit.maxRpm / audit.minRpm)));
    }
    RATE_LIMITS[key] = limits;
  });

  // ── FALLBACK CHAINS ─────────────────────────────────────────────
  const FALLBACK_CHAINS = {
    'kalshi-markets': ['kalshi', 'cache'],
    'kalshi-markets-legacy': ['kalshi', 'cache'],
    'cmc-quotes': ['cmc', 'cache'],
    'cmc': ['cmc', 'cache'],
    'pyth': ['pyth', 'cache'],
    'polymarket': ['polymarket', 'kalshi', 'cache'],
    'kalshi': ['kalshi', 'cache'],
    'kalshi-settlement': ['kalshi', 'cache'],
    'polymarket-markets': ['kalshi', 'cache'],
    'market-data': ['coinbase', 'okx', 'binance', 'blockchainraw', 'cache'],
    'coingecko': ['coingecko', 'cache'],
  };

  // ── CACHE TTL CONFIGURATION ────────────────────────────────────
  const CACHE_TTL = {
    'price-quotes': 5000,           // 5s for prices
    'market-data': 30000,           // 30s for market metadata
    'settlement': 3600000,          // 1h for settlement (never changes)
    'fear-greed': 3600000,          // 1h for macro sentiment
    'global-metrics': 300000,       // 5min for global metrics
    'coingecko': 120000,            // 2min for CoinGecko
  };

  // ── METRICS COLLECTION ────────────────────────────────────────
  const metrics = {
    requests: {},          // endpoint → count
    failures: {},          // endpoint → count
    cacheHits: 0,
    cacheMisses: 0,
    fallbackUsage: {},     // endpoint → count of fallback activations
    latencies: [],         // circular buffer of request latencies
    events: [],
    startTime: Date.now(),
  };

  const LATENCY_BUFFER_SIZE = 1000; // keep last 1000 measurements
  const OUTCOME_BUFFER_SIZE = 500;
  const HEALTH_ROLLING_WINDOW_MS = 120000;

  // ── RATE LIMITER CLASS ──────────────────────────────────────────
  /**
   * RateLimiter: Per-endpoint rate tracking with exponential backoff
   * and circuit breaker pattern.
   */
  class RateLimiter {
    constructor(endpoint, config = {}) {
      this.endpoint = endpoint;
      this.config = { ...RATE_LIMITS[endpoint] || {}, ...config };
      this.failures = 0;
      this.circuitOpen = false;
      this.circuitOpenUntil = 0;
      this.authLockUntil = 0;
      this.backoffUntil = 0;
      this.backoffMultiplier = 1;
      this.lastRequestTime = 0;
      this.failureHistory = [];
      this.CIRCUIT_BREAK_THRESHOLD = 3;
      this.CIRCUIT_RECOVERY_MS = 60000;
      this.FAILURE_WINDOW_MS = 60000;
    }

    /**
     * Check if we can make a request now
     */
    canRequest() {
      const now = Date.now();

      // Circuit breaker check
      if (this.circuitOpen) {
        if (now >= this.circuitOpenUntil) {
          // Try to recover
          this.circuitOpen = false;
          this.failures = 0;
          this.backoffMultiplier = 1;
          console.log(`[ProxyOrchestrator] Circuit breaker recovered for ${this.endpoint}`);
        } else {
          return false;
        }
      }

      // Provider auth rejection lock (401/403) to avoid hot-loop retries.
      if (now < this.authLockUntil) {
        return false;
      }

      // Backoff check
      if (now < this.backoffUntil) {
        return false;
      }

      const minInterval = this.getSafeInterval();
      if (minInterval > 0 && (now - this.lastRequestTime) < minInterval) {
        return false;
      }

      return true;
    }

    /**
     * Calculate safe wait time before next request
     */
    getSafeInterval() {
      if (Number.isFinite(this.config.reqs_per_second) && this.config.reqs_per_second > 0) {
        return (1000 / this.config.reqs_per_second) * this.backoffMultiplier;
      }
      const rpm = this.config.reqs_per_minute || this.config.reqs_per_min;
      if (Number.isFinite(rpm) && rpm > 0) {
        return (60000 / rpm) * this.backoffMultiplier;
      }
      const minInterval = this.config.backoff_start || 1000;
      return minInterval * this.backoffMultiplier;
    }

    getWaitMs() {
      const now = Date.now();
      if (this.circuitOpen && now < this.circuitOpenUntil) return this.circuitOpenUntil - now;
      if (now < this.authLockUntil) return this.authLockUntil - now;
      if (now < this.backoffUntil) return this.backoffUntil - now;
      const minInterval = this.getSafeInterval();
      return Math.max(0, minInterval - (now - this.lastRequestTime));
    }

    /**
     * Record a success — reset backoff counter
     */
    recordSuccess() {
      this.failures = 0;
      this.backoffMultiplier = 1;
      this.backoffUntil = 0;
      this.lastRequestTime = Date.now();
      this.failureHistory = [];
    }

    recordAuthFailure(lockMs = 15 * 60_000, status = 401) {
      const now = Date.now();
      this.lastRequestTime = now;
      this.failures += 1;
      this.authLockUntil = Math.max(this.authLockUntil || 0, now + Math.max(60_000, lockMs));
      this.backoffUntil = Math.max(this.backoffUntil || 0, now + Math.min(lockMs, this.config.backoff_max || 300000));
      console.warn(
        `[ProxyOrchestrator] ${this.endpoint} HTTP ${status}: auth lock ${Math.round((this.authLockUntil - now) / 1000)}s`
      );
      return this.authLockUntil - now;
    }

    /**
     * Record a 429/503 failure — enter backoff or open circuit
     */
    recordFailure(status = 'network') {
      const now = Date.now();
      this.lastRequestTime = now;
      // Immediate circuit break on gateway errors
      if (status === 502 || status === 503 || status === '502' || status === '503') {
        this.failures = Math.max(this.failures, this.CIRCUIT_BREAK_THRESHOLD);
      } else {
        this.failures++;
      }
      this.failureHistory.push(now);

      // Prune old failures outside window
      this.failureHistory = this.failureHistory.filter(t => now - t < this.FAILURE_WINDOW_MS);

      // Calculate backoff
      const backoffMs = Math.min(
        this.config.backoff_max || 32000,
        (this.config.backoff_start || 2000) * (2 ** (this.failures - 1))
      );
      this.backoffUntil = now + backoffMs;
      this.backoffMultiplier = Math.pow(2, this.failures - 1);

      // Check circuit breaker threshold
      if (this.failures >= this.CIRCUIT_BREAK_THRESHOLD) {
        this.circuitOpen = true;
        this.circuitOpenUntil = now + this.CIRCUIT_RECOVERY_MS;
        console.warn(
          `[ProxyOrchestrator] Circuit breaker OPEN for ${this.endpoint} ` +
          `(${this.failures} failures in ${Math.round((now - this.failureHistory[0]) / 1000)}s)`
        );
      }

      console.warn(
        `[ProxyOrchestrator] ${this.endpoint} HTTP ${status}: ` +
        `backoff ${backoffMs}ms, failures=${this.failures}`
      );

      return backoffMs;
    }

    /**
     * Get limiter health status
     */
    getStatus() {
      const now = Date.now();
      return {
        endpoint: this.endpoint,
        healthy: this.canRequest() && !this.circuitOpen,
        circuitOpen: this.circuitOpen,
        failures: this.failures,
        authLockUntil: this.authLockUntil,
        authLockRemaining: Math.max(0, this.authLockUntil - now),
        backoffUntil: this.backoffUntil,
        nextRetry: Math.max(0, this.backoffUntil - now),
        safeInterval: this.getSafeInterval(),
      };
    }
  }

  class CascadingTimer {
    constructor(policies = {}) {
      this.policies = policies;
      this.state = {}; // endpoint => adaptive stats
    }

    _policy(endpoint) {
      return this.policies[endpoint] || this.policies.default || {};
    }

    _ensure(endpoint) {
      if (!this.state[endpoint]) {
        this.state[endpoint] = {
          failures: 0,
          consecutiveTimeouts: 0,
          lastLatencyMs: 0,
          avgLatencyMs: 0,
          lastStatus: 'idle',
          lastError: '',
          lastSuccessTs: 0,
          lastFailureTs: 0,
          cascadeLevel: 0,
        };
      }
      return this.state[endpoint];
    }

    _deriveBaseInterval(policy) {
      if (Number.isFinite(policy.maxRps) && policy.maxRps > 0) {
        return 1000 / policy.maxRps;
      }
      if (Number.isFinite(policy.maxRpm) && policy.maxRpm > 0) {
        return 60000 / policy.maxRpm;
      }
      return Number.isFinite(policy.minIntervalMs) ? policy.minIntervalMs : 250;
    }

    _jitter(ms, pct = 0.12) {
      const spread = Math.max(25, Math.round(ms * pct));
      return Math.max(1, Math.round(ms + ((Math.random() * 2 - 1) * spread)));
    }

    getWindow(endpoint) {
      const policy = this._policy(endpoint);
      const s = this._ensure(endpoint);
      const baseInterval = this._deriveBaseInterval(policy);
      const minInterval = Number.isFinite(policy.minIntervalMs) ? policy.minIntervalMs : baseInterval;
      const maxInterval = Number.isFinite(policy.maxIntervalMs) ? policy.maxIntervalMs : Math.max(minInterval * 8, 4000);
      const level = Math.max(0, Math.min(6, s.cascadeLevel));
      const adaptiveInterval = Math.min(maxInterval, minInterval + (Math.pow(1.7, level) * minInterval * 0.35));

      const minTimeout = Number.isFinite(policy.minTimeoutMs) ? policy.minTimeoutMs : 25000;
      const maxTimeout = Number.isFinite(policy.maxTimeoutMs) ? policy.maxTimeoutMs : 30000;
      const latencyFactor = s.avgLatencyMs > 0 ? Math.min(2.5, Math.max(0.8, s.avgLatencyMs / Math.max(1, minTimeout))) : 1;
      const adaptiveTimeout = Math.max(minTimeout, Math.min(maxTimeout, Math.round(minTimeout * (1 + level * 0.3) * latencyFactor)));

      return {
        endpoint,
        intervalMs: Math.round(adaptiveInterval),
        timeoutMs: adaptiveTimeout,
        minTimeoutMs: minTimeout,
        maxTimeoutMs: maxTimeout,
        maxPayloadBytes: Number.isFinite(policy.maxPayloadBytes) ? policy.maxPayloadBytes : 500000,
        cascadeLevel: level,
      };
    }

    getAttemptTimeout(endpoint, attempt = 0) {
      const window = this.getWindow(endpoint);
      const level = Math.max(0, Math.min(6, window.cascadeLevel || 0));
      const stage = Math.max(0, Math.min(3, Number(attempt) || 0));
      const stageFactor = [1.0, 1.25, 1.55, 1.85][stage];
      const failureFactor = 1 + (level * 0.12);
      const raw = Math.round(window.minTimeoutMs * stageFactor * failureFactor);
      const clamped = Math.max(window.minTimeoutMs, Math.min(window.maxTimeoutMs, raw));
      return this._jitter(clamped, 0.08);
    }

    recordSuccess(endpoint, latencyMs = 0, payloadBytes = 0) {
      const s = this._ensure(endpoint);
      const now = Date.now();
      s.lastSuccessTs = now;
      s.lastStatus = 'ok';
      s.lastError = '';
      s.failures = Math.max(0, s.failures - 1);
      s.consecutiveTimeouts = 0;
      s.cascadeLevel = Math.max(0, s.cascadeLevel - 1);
      s.lastLatencyMs = Number(latencyMs) || 0;
      if (s.avgLatencyMs <= 0) s.avgLatencyMs = s.lastLatencyMs;
      else s.avgLatencyMs = Math.round((s.avgLatencyMs * 0.82) + (s.lastLatencyMs * 0.18));
      s.lastPayloadBytes = Number(payloadBytes) || 0;
    }

    recordFailure(endpoint, errLike) {
      const s = this._ensure(endpoint);
      const now = Date.now();
      const msg = String(errLike && errLike.message ? errLike.message : errLike || '');
      s.lastFailureTs = now;
      s.lastStatus = 'fail';
      s.lastError = msg;
      s.failures += 1;
      if (/timeout|abort|timed out/i.test(msg)) {
        s.consecutiveTimeouts += 1;
      }
      const growth = /429|503|timeout|abort|timed out/i.test(msg) ? 2 : 1;
      s.cascadeLevel = Math.min(6, s.cascadeLevel + growth);
    }

    getStatus() {
      return Object.keys(this.state).reduce((acc, endpoint) => {
        acc[endpoint] = {
          ...this.state[endpoint],
          window: this.getWindow(endpoint),
        };
        return acc;
      }, {});
    }
  }

  function inferEndpointFromUrl(url) {
    try {
      const host = new URL(String(url), (typeof window !== 'undefined' ? window.location.href : 'http://localhost')).hostname.toLowerCase();
      for (const [endpoint, policy] of Object.entries(PROVIDER_TIMING_AUDIT)) {
        if (!policy || !Array.isArray(policy.hostPatterns)) continue;
        if (policy.hostPatterns.some((p) => host.includes(String(p).toLowerCase()))) return endpoint;
      }
    } catch (_) { }
    return 'default';
  }

  function truncateJsonPayload(value, limits = {}, depth = 0) {
    const maxDepth = Number.isFinite(limits.maxDepth) ? limits.maxDepth : 5;
    const maxArray = Number.isFinite(limits.maxArray) ? limits.maxArray : 250;
    const maxString = Number.isFinite(limits.maxString) ? limits.maxString : 2000;
    if (depth > maxDepth) return null;
    if (value == null) return value;
    if (typeof value === 'string') {
      return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      const sliced = value.slice(0, maxArray).map((item) => truncateJsonPayload(item, limits, depth + 1));
      if (value.length > maxArray) sliced.push({ _truncated: value.length - maxArray });
      return sliced;
    }
    if (typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach((k) => {
        out[k] = truncateJsonPayload(value[k], limits, depth + 1);
      });
      return out;
    }
    return null;
  }

  // ── REQUEST BATCHER CLASS ────────────────────────────────────────
  /**
   * RequestBatcher: Coalesce identical requests within a time window
   * Deduplicates by URL + params hash, returns same result to all subscribers.
   */
  class RequestBatcher {
    constructor(windowMs = 500) {
      this.windowMs = windowMs;
      this.batches = new Map(); // key → { promise, subscribers, createdAt }
      this.pendingCleanup = new Set();
    }

    /**
     * Create hash key from URL and params
     */
    _makeKey(url, params = {}) {
      const paramStr = JSON.stringify(params);
      return `${url}::${paramStr}`;
    }

    /**
     * Queue a request or return existing batch
     */
    async batch(url, params, executor) {
      const key = this._makeKey(url, params);
      const now = Date.now();

      // Check if we have a recent batch for this key
      if (this.batches.has(key)) {
        const batch = this.batches.get(key);
        if (now - batch.createdAt < this.windowMs) {
          // Reuse existing batch
          return batch.promise;
        } else {
          // Old batch, cleanup
          this.batches.delete(key);
        }
      }

      // Create new batch
      const promise = executor();
      const batch = {
        promise,
        createdAt: now,
      };

      this.batches.set(key, batch);

      // Schedule cleanup after window
      setTimeout(() => this.batches.delete(key), this.windowMs + 100);

      return promise;
    }

    /**
     * Get batcher health status
     */
    getStatus() {
      return {
        activeBatches: this.batches.size,
        windowMs: this.windowMs,
      };
    }
  }

  // ── FALLBACK ROUTER CLASS ────────────────────────────────────────
  /**
   * FallbackRouter: Primary → Fallback chain with circuit breaker per source
   */

  class FallbackRouter {
    constructor() {
      this.sources = {};           // endpoint → { handler, type, healthy, lastCheck }
      this.healthCheckInterval = 30000;
      this.healthCheckTimer = null;
    }

    /**
     * Register a fetch handler for a source
     * @param {string} endpoint
     * @param {function} handler
     * @param {string} type - 'http' or 'grpc'
     */
    registerSource(endpoint, handler, type = 'http') {
      this.sources[endpoint] = {
        endpoint,
        handler,
        type,
        healthy: true,
        lastCheck: Date.now(),
        successCount: 0,
        failureCount: 0,
      };
    }

    /**
     * Try a chain of endpoints until one succeeds
     * Supports both HTTP and gRPC handlers
     */
    async tryChain(chain, executor, context = {}) {
      for (const endpoint of chain) {
        const source = this.sources[endpoint];
        if (!source) {
          console.warn(`[ProxyOrchestrator] Unknown endpoint: ${endpoint}`);
          continue;
        }
        if (!source.healthy) {
          console.log(`[ProxyOrchestrator] Skipping unhealthy source: ${endpoint}`);
          continue;
        }
        try {
          console.log(`[ProxyOrchestrator] Trying ${endpoint} (${source.type})...`);
          let result;
          if (source.type === 'grpc') {
            // gRPC handler: pass context and endpoint
            result = await source.handler(context, endpoint);
          } else {
            // HTTP handler: use executor
            result = await executor(endpoint);
          }
          source.successCount++;
          source.healthy = true;
          return { endpoint, result, fallback: endpoint !== chain[0] };
        } catch (err) {
          source.failureCount++;
          console.warn(`[ProxyOrchestrator] ${endpoint} failed:`, err.message);
          // Continue to next in chain
        }
      }
      return Promise.reject(new Error(`All endpoints exhausted: ${chain.join(' → ')}`));
    }

    /**
     * Perform periodic health checks on registered sources
     */
    startHealthChecks() {
      if (this.healthCheckTimer) return;

      this.healthCheckTimer = setInterval(() => {
        const now = Date.now();
        Object.values(this.sources).forEach(source => {
          // Simple health check: mark unhealthy if too many recent failures
          if (source.failureCount > 3 && now - source.lastCheck < 60000) {
            source.healthy = false;
          } else if (source.failureCount === 0 && source.successCount > 0) {
            source.healthy = true;
          }
          source.lastCheck = now;
        });
      }, this.healthCheckInterval);
    }

    /**
     * Stop health checks
     */
    stopHealthChecks() {
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }
    }

    /**
     * Get router health status
     */
    getStatus() {
      return {
        sources: Object.entries(this.sources).reduce((acc, [endpoint, source]) => {
          acc[endpoint] = {
            healthy: source.healthy,
            successCount: source.successCount,
            failureCount: source.failureCount,
          };
          return acc;
        }, {}),
      };
    }
  }

  const MAX_IDLE_TTL = {
    kalshi: 20000,
    pyth: 30000,
    polymarket: 300000,
    binance: 180000,
    coinbase: 120000,
    bybit: 25000,
    kraken: 65000,
    bitstamp: 65000,
    okx: 45000,
    cryptocom: 60000,
    bitfinex: 60000,
    mexc: 60000,
    coingecko: 60000,
    cmc: 60000,
    blockchainraw: 60000,
    default: 120000
  };

  // No retry limit or queue depth cap previously existed here: a genuinely
  // dead shared transport (not just one slow request) meant a single
  // request retried forever and everything else queued behind it,
  // indefinitely -- see the fix in enqueue()/_processQueue() below.
  const MAX_ENDPOINT_RETRIES = 3;
  const MAX_QUEUE_DEPTH = 10;

  // ── TIMEOUT ORCHESTRATOR CLASS ───────────────────────────────────
  /**
   * TimeoutOrchestrator: Manages long-running connection stability (9+ hours overnight)
   * Detects hanging transports, queues requests to prevent drop, automatically refreshes connections.
   */
  class TimeoutOrchestrator {
    constructor() {
      this.queues = {}; // endpoint -> array of pending requests
      this.health = {}; // endpoint -> { state: 'active' | 'recovering', lastSuccess: ts }
      this.refreshIntervals = {};
      this.heartbeatTimer = setInterval(() => this._checkZombies(), 60000);
    }

    scheduleRefresh(endpoint, intervalMs = 6 * 3600 * 1000) { // default 6 hours
      if (this.refreshIntervals[endpoint]) clearInterval(this.refreshIntervals[endpoint]);
      this.refreshIntervals[endpoint] = setInterval(() => {
        this._triggerRefresh(endpoint, 'proactive_refresh');
      }, intervalMs);
    }

    _triggerRefresh(endpoint, reason, delayMs = 3000) {
      console.log(`[TimeoutOrchestrator] Refreshing connection for ${endpoint} due to ${reason} (${delayMs}ms)`);
      this.health[endpoint] = { ...this.health[endpoint], state: 'recovering' };
      // Simulate connection drop & revival, pausing queue
      setTimeout(() => this.revive(endpoint), delayMs);
    }

    _checkZombies() {
      const now = Date.now();
      Object.keys(this.health).forEach(endpoint => {
        const h = this.health[endpoint];
        const maxTtlMs = MAX_IDLE_TTL[endpoint] || MAX_IDLE_TTL.default;
        // If a request was queued but connection has been inactive for maxTtlMs, revive
        if (h && h.state === 'active' && (now - h.lastSuccess > maxTtlMs) && this.queues[endpoint]?.length > 0) {
           this._triggerRefresh(endpoint, 'zombie_detection');
        }
      });
    }

    recordActivity(endpoint, isSuccess) {
      if (!this.health[endpoint]) this.health[endpoint] = { state: 'active', lastSuccess: Date.now() };
      if (isSuccess) {
        this.health[endpoint].lastSuccess = Date.now();
        if (this.health[endpoint].state === 'recovering') this.revive(endpoint);
      }
    }

    async enqueue(endpoint, executor) {
      if (!this.queues[endpoint]) this.queues[endpoint] = [];
      if (!this.health[endpoint]) this.health[endpoint] = { state: 'active', lastSuccess: Date.now() };

      // Bound the queue: an endpoint stuck retrying a dead shared transport
      // would otherwise accumulate every subsequent poll forever. Drop the
      // oldest queued requests first -- for live market data, a fresher
      // request superseding a stale one is correct; blocking on stale data
      // is not.
      const q = this.queues[endpoint];
      while (q.length >= MAX_QUEUE_DEPTH) {
        const dropped = q.shift();
        dropped.reject(new Error(`[TimeoutOrchestrator] queue overflow for ${endpoint}, dropping stale request`));
      }

      return new Promise((resolve, reject) => {
        const req = { executor, resolve, reject, timestamp: Date.now(), attempts: 0 };
        q.push(req);
        this._processQueue(endpoint);
      });
    }

    async _processQueue(endpoint) {
      if (this.health[endpoint]?.state === 'recovering') return; // Wait for revival
      const q = this.queues[endpoint];
      if (!q || q.length === 0) return;

      const req = q.shift();
      try {
        const result = await req.executor();
        req.resolve(result);
        this.recordActivity(endpoint, true);
      } catch (err) {
        req.attempts += 1;
        if (/timeout|abort/i.test(err.message) && req.attempts < MAX_ENDPOINT_RETRIES) {
          // Pause and trigger revival, put req back at the front to retry --
          // but only up to MAX_ENDPOINT_RETRIES. Without a cap, a genuinely
          // dead shared transport (not just one slow request) means this
          // single request retries forever and every subsequent request to
          // this endpoint queues up behind it indefinitely -- which is what
          // "18 unrelated providers degrade at once" actually was: one dead
          // proxy, not 18 real outages.
          console.warn(
            `[TimeoutOrchestrator] Timeout for ${endpoint} ` +
            `(attempt ${req.attempts}/${MAX_ENDPOINT_RETRIES}), retrying...`
          );
          q.unshift(req);
          const backoffMs = Math.min(3000 * (2 ** (req.attempts - 1)), 30000);
          this._triggerRefresh(endpoint, 'timeout_error', backoffMs);
        } else {
          if (req.attempts >= MAX_ENDPOINT_RETRIES) {
            console.error(
              `[TimeoutOrchestrator] ${endpoint} exceeded ${MAX_ENDPOINT_RETRIES} retries, ` +
              `marking degraded and dropping request`
            );
            this.health[endpoint] = { state: 'active', lastSuccess: this.health[endpoint]?.lastSuccess || 0 };
          }
          req.reject(err);
        }
      }

      if (q.length > 0) setTimeout(() => this._processQueue(endpoint), 10);
    }

    revive(endpoint) {
      if (this.health[endpoint]) {
        this.health[endpoint].state = 'active';
        this.health[endpoint].lastSuccess = Date.now();
      }
      console.log(`[TimeoutOrchestrator] Connection revived for ${endpoint}, processing queue...`);
      this._processQueue(endpoint);
    }
  }

  // ── CACHE ORCHESTRATOR CLASS ────────────────────────────────────
  /**
   * CacheOrchestrator: Multi-layer cache
   * L1: In-memory (promises, 1s)
   * L2: localStorage (5min)
   * L3: Disk persistence (F:\WECRYPTO\data)
   * L4: Network (with backoff)
   */
  class CacheOrchestrator {
    constructor() {
      this.l1 = new Map();           // url → { data, expiresAt }
      this.l2Prefix = 'po_cache_';
      this.hitStats = { l1: 0, l2: 0, l3: 0, l4: 0 };
    }

    /**
     * Generate cache key
     */
    _cacheKey(url, endpoint) {
      return `${endpoint}:${url}`;
    }

    /**
     * Get TTL for a cache type
     */
    _getTTL(cacheType) {
      return CACHE_TTL[cacheType] || 30000;
    }

    /**
     * Check if cached data is valid
     */
    _isValid(data) {
      if (!data) return false;
      const now = Date.now();
      return data.expiresAt && data.expiresAt > now;
    }

    /**
     * Try L1 cache (in-memory, fastest)
     */
    getL1(key) {
      const data = this.l1.get(key);
      if (this._isValid(data)) {
        this.hitStats.l1++;
        return data.value;
      }
      if (data && data.expiresAt <= Date.now()) {
        this.l1.delete(key);
      }
      return null;
    }

    /**
     * Try L2 cache (localStorage)
     */
    getL2(key) {
      try {
        const stored = localStorage.getItem(this.l2Prefix + key);
        if (stored) {
          const data = JSON.parse(stored);
          if (this._isValid(data)) {
            this.hitStats.l2++;
            return data.value;
          }
          localStorage.removeItem(this.l2Prefix + key);
        }
      } catch (err) {
        console.warn('[ProxyOrchestrator] L2 cache error:', err.message);
      }
      return null;
    }

    /**
     * Retrieve from cache with fallback through layers
     */
    get(key, cacheType = 'market-data') {
      // L1: In-memory (fastest)
      let value = this.getL1(key);
      if (value) return value;

      // L2: localStorage
      value = this.getL2(key);
      if (value) {
        // Promote to L1
        this.setL1(key, value, cacheType);
        return value;
      }

      return null;
    }

    /**
     * Store in L1 cache
     */
    setL1(key, value, cacheType = 'market-data') {
      const ttl = this._getTTL(cacheType);
      this.l1.set(key, {
        value,
        expiresAt: Date.now() + ttl,
      });
    }

    /**
     * Store in L2 cache
     */
    setL2(key, value) {
      try {
        const data = {
          value,
          expiresAt: Date.now() + CACHE_TTL['market-data'],
        };
        localStorage.setItem(this.l2Prefix + key, JSON.stringify(data));
      } catch (err) {
        console.warn('[ProxyOrchestrator] L2 cache write error:', err.message);
      }
    }

    /**
     * Store in cache (both layers)
     */
    set(key, value, cacheType = 'market-data') {
      this.setL1(key, value, cacheType);
      this.setL2(key, value);
    }

    /**
     * Clear cache
     */
    clear() {
      this.l1.clear();
      try {
        Object.keys(localStorage)
          .filter(k => k.startsWith(this.l2Prefix))
          .forEach(k => localStorage.removeItem(k));
      } catch (err) {
        console.warn('[ProxyOrchestrator] Cache clear error:', err.message);
      }
    }

    /**
     * Get cache statistics
     */
    getStats() {
      return {
        l1Size: this.l1.size,
        hitStats: { ...this.hitStats },
        hitRate: this._calculateHitRate(),
      };
    }

    /**
     * Calculate cache hit rate
     */
    _calculateHitRate() {
      const total = Object.values(this.hitStats).reduce((a, b) => a + b, 0);
      if (total === 0) return 0;
      const hits = this.hitStats.l1 + this.hitStats.l2 + this.hitStats.l3;
      return Math.round((hits / total) * 100);
    }
  }

  // ── MAIN PROXY ORCHESTRATOR CLASS ────────────────────────────────
  /**
   * ProxyOrchestrator: Main interface coordinating all layers
   */

  class ProxyOrchestrator {
    constructor(config = {}) {
      this.config = config;
      this.rateLimiters = {};       // endpoint → RateLimiter
      this.cascadeTimer = new CascadingTimer(PROVIDER_TIMING_AUDIT);
      this.batcher = new RequestBatcher(500);
      this.fallback = new FallbackRouter();
      this.cache = new CacheOrchestrator();
      this.timeoutOrchestrator = new TimeoutOrchestrator();

      // Schedule proactive refreshes every 6 hours for critical endpoints
      ['kalshi', 'polymarket', 'pyth', 'coingecko', 'cmc'].forEach(ep => {
        this.timeoutOrchestrator.scheduleRefresh(ep, 6 * 3600 * 1000);
      });

      // Initialize rate limiters for known endpoints
      Object.keys(RATE_LIMITS).forEach(endpoint => {
        this.rateLimiters[endpoint] = new RateLimiter(endpoint);
      });

      // Register HTTP endpoints (default)
      Object.keys(RATE_LIMITS).forEach(endpoint => {
        this.fallback.registerSource(endpoint, null, 'http');
      });

      // Register pseudo-endpoints
      this.fallback.registerSource('cache', null, 'http');

      // Register gRPC endpoints
      if (typeof window.grpcKalshiHandler === 'function') {
        this.fallback.registerSource('grpc-kalshi', window.grpcKalshiHandler, 'grpc');
      }
      if (typeof window.grpcBinanceHandler === 'function') {
        this.fallback.registerSource('grpc-binance', window.grpcBinanceHandler, 'grpc');
      }

      // Start health checks
      this.fallback.startHealthChecks();

      // Start metrics collection
      this.startMetricsCollection();

      console.log('[ProxyOrchestrator] Initialized (gRPC support enabled)');
    }

    /**
     * Main fetch interface: Unified logic with all layers
     */
    async fetch(url, options = {}) {
      const pPort = window.__PROXY_PORT__ || 3010;
      // ---- BACKEND PROXY ROUTING DISABLED ----
      // All these are now natively routed through Tor via Chromium PAC script.

      const {
        endpoint: endpointOpt = null,
        cacheType = 'market-data',
        skipCache = false,
        fallbackChain = null,
        retries = 2,
        requestOptions = {},
      } = options;
      const endpoint = endpointOpt || inferEndpointFromUrl(url);

      const startTime = Date.now();
      const cacheKey = this.cache._cacheKey(url, endpoint);

      // 1. Check cache
      if (!skipCache) {
        const cached = this.cache.get(cacheKey, cacheType);
        if (cached) {
          console.log(`[ProxyOrchestrator] Cache hit (${endpoint}): ${url}`);
          metrics.cacheHits++;
          return cached;
        }
      }

      metrics.cacheMisses++;

      // 2. Get rate limiter
      const limiter = this.rateLimiters[endpoint] || this.rateLimiters.default;
      const cascadeWindow = this.cascadeTimer.getWindow(endpoint);
      if (!limiter.canRequest()) {
        const waitMs = Math.max(limiter.getWaitMs(), cascadeWindow.intervalMs);
        const canWait = waitMs > 0 && waitMs <= Math.max(20000, cascadeWindow.timeoutMs) && !limiter.circuitOpen;
        if (canWait) {
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          console.warn(`[ProxyOrchestrator] Rate limited (${endpoint}), using cache...`);
          const cached = this.cache.get(cacheKey, cacheType);
          if (cached) {
            return cached;
          } else {
            return Promise.reject(new Error(`Rate limited and no cache available: ${endpoint}`));
          }
        }
      }

      // 3. Execute fetch (with deduplication, fallback, and timeout queueing)
      let result;
      const chain = fallbackChain || (FALLBACK_CHAINS[endpoint] || [endpoint]);

      try {
        result = await this.timeoutOrchestrator.enqueue(endpoint, async () => {
          let innerResult;
          if (chain.length === 1) {
            // Direct fetch without fallback chain
            if (this.fallback.sources[endpoint] && this.fallback.sources[endpoint].type === 'grpc') {
              // gRPC endpoint
              innerResult = await this.fallback.sources[endpoint].handler({ url, options }, endpoint);
            } else {
              // HTTP endpoint
              innerResult = await this._executeFetch(url, endpoint, limiter, retries, requestOptions);
            }
          } else {
            // Use fallback chain (mixed HTTP/gRPC)
            innerResult = await this.fallback.tryChain(chain, async (ep) => {
              if (ep === 'cache') {
                const cached = this.cache.get(cacheKey, cacheType);
                if (!cached) {
                  return Promise.reject(new Error('Cache miss'));
                }
                return cached;
              }
              if (this.fallback.sources[ep] && this.fallback.sources[ep].type === 'grpc') {
                return await this.fallback.sources[ep].handler({ url, options }, ep);
              } else {
                return await this._executeFetch(url, ep, this.rateLimiters[ep], retries, requestOptions);
              }
            }, { url, options });
            innerResult = innerResult.result;
          }
          return innerResult;
        });

        if (limiter) limiter.recordSuccess();
        this.cache.set(cacheKey, result, cacheType);

        const latency = Date.now() - startTime;
        this._recordLatency(latency);
        this._recordOutcome(endpoint, true, latency);
        const payloadBytes = (() => {
          try { return JSON.stringify(result).length; } catch (_) { return 0; }
        })();
        this.cascadeTimer.recordSuccess(endpoint, latency, payloadBytes);

        console.log(`[ProxyOrchestrator] Success (${endpoint}): ${url} (${latency}ms)`);
        metrics.requests[endpoint] = (metrics.requests[endpoint] || 0) + 1;

        return result;
      } catch (err) {
        const latency = Date.now() - startTime;
        this._recordLatency(latency);
        this._recordOutcome(endpoint, false, latency, err?.message || err);
        if (limiter) limiter.recordFailure();
        this.cascadeTimer.recordFailure(endpoint, err);
        metrics.failures[endpoint] = (metrics.failures[endpoint] || 0) + 1;

        console.error(`[ProxyOrchestrator] Failed (${endpoint}): ${err.message}`);
        throw err;
      }
    }

    /**
     * Internal: Execute fetch with rate limiting and retry
     */
    async _executeFetch(url, endpoint, limiter, retries = 2, requestOptions = {}) {
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const cascadeWindow = this.cascadeTimer.getWindow(endpoint);
          // Use batcher to deduplicate
          return await this.batcher.batch(url, { endpoint }, async () => {
            if (limiter) {
              limiter.lastRequestTime = Date.now();
            }
            let fetchUrl = (endpoint === 'coingecko' || /coingecko/i.test(String(url))) && typeof window !== 'undefined' && typeof window.coinGeckoUrl === 'function'
              ? window.coinGeckoUrl(url)
              : url;
            const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const dynamicTimeoutMs = this.cascadeTimer.getAttemptTimeout(endpoint, attempt);

            const timer = setTimeout(() => {
              try {
                if (controller) {
                  controller.abort(new DOMException(
                    `[ProxyOrchestrator] ${endpoint} timeout after ${dynamicTimeoutMs}ms (Attempt ${attempt + 1})`,
                    'TimeoutError'
                  ));
                }
              } catch (_) {
                try { if (controller) controller.abort(); } catch (_) { }
              }
            }, dynamicTimeoutMs);
            let res;
            try {
              const isGecko = endpoint === 'coingecko' || /coingecko/i.test(String(url));
              const isBinanceSpot = /api\.binance\.com|data-api\.binance\.vision/i.test(String(fetchUrl));
              const isFapi = /fapi\.binance\.com/i.test(String(fetchUrl));
              const isBybit = endpoint === 'bybit' || /bybit\.com|bytick\.com/i.test(String(fetchUrl));
              const pPort = (typeof window !== 'undefined' && window.__PROXY_PORT__) || 3010;

              const headers = { Accept: 'application/json' };
              if (requestOptions.headers) {
                if (typeof Headers !== 'undefined' && requestOptions.headers instanceof Headers) {
                  for (const [k, v] of requestOptions.headers.entries()) headers[k] = v;
                } else if (typeof requestOptions.headers.entries === 'function') {
                  for (const [k, v] of requestOptions.headers.entries()) headers[k] = v;
                } else {
                  Object.assign(headers, requestOptions.headers);
                }
              }

              // Enforce SOCKS5 / local proxy routing to circumvent US geo-block (HTTP 451/403)
              if (isFapi && !fetchUrl.includes(`:${pPort}/`)) {
                try {
                  const parsed = new URL(fetchUrl);
                  fetchUrl = `http://127.0.0.1:${pPort}/binance-f${parsed.pathname}${parsed.search}`;
                } catch (_) {}
              } else if (isBinanceSpot && !fetchUrl.includes(`:${pPort}/`)) {
                try {
                  const parsed = new URL(fetchUrl);
                  fetchUrl = `http://127.0.0.1:${pPort}/binance${parsed.pathname}${parsed.search}`;
                } catch (_) {}
              } else if (isBybit && !fetchUrl.includes(`:${pPort}/`)) {
                try {
                  const parsed = new URL(fetchUrl);
                  fetchUrl = `http://127.0.0.1:${pPort}/bybit${parsed.pathname}${parsed.search}`;
                } catch (_) {}
              }

              // Enforce browser TLS headers on Bybit to prevent Cloudflare WAF 403 bot detection
              if (isBybit) {
                headers['User-Agent'] = headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
                headers['Accept-Language'] = headers['Accept-Language'] || 'en-US,en;q=0.9';
                headers['sec-ch-ua'] = headers['sec-ch-ua'] || '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"';
                headers['sec-ch-ua-mobile'] = '?0';
                headers['sec-ch-ua-platform'] = '"Windows"';
              }

              if (endpoint === 'binance' || /binance/i.test(String(url))) {
                const binanceKey = window.resolveRuntimeKey('BINANCE_API_KEY');
                if (binanceKey) headers['X-MBX-APIKEY'] = binanceKey;
              } else if ((endpoint === 'cmc' || /coinmarketcap/i.test(String(url))) && !/\/trial-pro-api\//i.test(String(fetchUrl))) {
                const cmcKey = window.resolveRuntimeKey('CMC_PRO_API_KEY') || window.resolveRuntimeKey('COINMARKETCAP_API_KEY');
                if (cmcKey && !headers['X-CMC_PRO_API_KEY'] && !headers['x-cmc_pro-api-key']) {
                  headers['X-CMC_PRO_API_KEY'] = cmcKey;
                }
              }
              const requestWithAuth = isGecko && typeof window !== 'undefined' && typeof window.withCoinGeckoAuth === 'function'
                ? window.withCoinGeckoAuth(fetchUrl, { headers })
                : { headers };

              res = await fetch(fetchUrl, {
                ...requestOptions,
                headers: requestWithAuth.headers || headers,
                signal: controller ? controller.signal : undefined,
              });
            } finally {
              clearTimeout(timer);
            }

            // Fallback for Binance HTTP 451 (Geo-block) -> fallback to api.binance.us
            if (res.status === 451 || (isFapi && res.status === 403)) {
              console.warn(`[ProxyOrchestrator] fapi.binance.com geo-blocked (HTTP ${res.status}). Attempting fallback to api.binance.us...`);
              try {
                const usUrl = String(url).replace('fapi.binance.com', 'api.binance.us').replace('/fapi/v1/', '/api/v3/');
                const usRes = await fetch(usUrl, { headers: { Accept: 'application/json' } });
                if (usRes.ok) return await usRes.json();
              } catch (_) {}
              if (limiter) limiter.recordAuthFailure(15 * 60_000, res.status);
              return Promise.reject(new Error(`HTTP 451: Binance US geo-block (proxy and US fallback exhausted)`));
            }

            // Fallback for Bybit HTTP 403 (Cloudflare WAF) -> route through proxy server
            if (isBybit && res.status === 403 && !fetchUrl.includes(`:${pPort}/bybit`)) {
              console.warn(`[ProxyOrchestrator] bybit HTTP 403 WAF trip. Routing via Rust proxy server...`);
              try {
                const bybitProxyUrl = `http://127.0.0.1:${pPort}/bybit` + new URL(url).pathname + new URL(url).search;
                const proxyRes = await fetch(bybitProxyUrl, { headers: { Accept: 'application/json' } });
                if (proxyRes.ok) return await proxyRes.json();
              } catch (_) {}
            }

            if (res.status === 429 || res.status === 503) {
              if (limiter) limiter.recordFailure(res.status);
              return Promise.reject(new Error(`HTTP ${res.status}: upstream reject`));
            }

            if (res.status === 401 || res.status === 403) {
              const isGecko = endpoint === 'coingecko' || /coingecko/i.test(String(url));
              const lockMs = isGecko ? 60 * 60_000 : 15 * 60_000;
              if (limiter) limiter.recordAuthFailure(lockMs, res.status);
              return Promise.reject(new Error(`HTTP ${res.status}: auth rejection (${endpoint})`));
            }

            if (!res.ok) {
              return Promise.reject(new Error(`HTTP ${res.status}: ${res.statusText}`));
            }
            const raw = await res.text();
            let parsed = JSON.parse(raw);
            if (raw.length > cascadeWindow.maxPayloadBytes) {
              parsed = truncateJsonPayload(parsed, { maxDepth: 5, maxArray: 200, maxString: 2000 });
              console.warn(`[ProxyOrchestrator] Truncated oversized payload (${endpoint}) at ${raw.length}B`);
            }
            return parsed;
          });
        } catch (err) {
          lastErr = err;
          if (/HTTP 401|HTTP 403|HTTP 429|HTTP 503|auth rejection|upstream reject/i.test(String(err?.message || err || ''))) {
            // Hard rejects (auth or rate limit) should instantly break to trigger the FallbackRouter
            break;
          }
          if (attempt < retries) {
            const cascadeWindow = this.cascadeTimer.getWindow(endpoint);
            const baseBackoff = limiter?.getSafeInterval?.() || this.config.backoff_start || 2000;
            const backoffMs = Math.min(
              cascadeWindow.intervalMs * 8,
              Math.max(cascadeWindow.intervalMs, baseBackoff * Math.pow(1.6, attempt))
            );
            console.log(`[ProxyOrchestrator] Retry ${attempt + 1}/${retries} after ${Math.round(backoffMs)}ms`);
            await new Promise(r => setTimeout(r, backoffMs));
          }
        }
      }

      throw lastErr || new Error('Fetch failed after retries');
    }

    /**
     * Record request latency
     */
    _recordLatency(ms) {
      metrics.latencies.push(ms);
      if (metrics.latencies.length > LATENCY_BUFFER_SIZE) {
        metrics.latencies.shift();
      }
    }

    _recordOutcome(endpoint, ok, latencyMs = 0, error = '') {
      metrics.events.push({
        endpoint,
        ok: !!ok,
        latencyMs: Number(latencyMs) || 0,
        error: String(error || ''),
        ts: Date.now(),
      });
      if (metrics.events.length > OUTCOME_BUFFER_SIZE) {
        metrics.events.splice(0, metrics.events.length - OUTCOME_BUFFER_SIZE);
      }
    }

    /**
     * Get average latency
     */
    _getAverageLatency() {
      if (metrics.latencies.length === 0) return 0;
      const sum = metrics.latencies.reduce((a, b) => a + b, 0);
      return Math.round(sum / metrics.latencies.length);
    }

    /**
     * Get comprehensive health status
     */
    getHealthStatus() {
      const rateLimiterStatus = {};
      Object.entries(this.rateLimiters).forEach(([ep, limiter]) => {
        rateLimiterStatus[ep] = limiter.getStatus();
      });

      const cacheStats = this.cache.getStats();
      const uptime = Date.now() - metrics.startTime;
      const cutoff = Date.now() - HEALTH_ROLLING_WINDOW_MS;
      const recentEvents = metrics.events.filter((event) => Number(event.ts || 0) >= cutoff);
      const recentByEndpoint = {};
      const recentFailuresByEndpoint = {};
      for (const event of recentEvents) {
        recentByEndpoint[event.endpoint] = (recentByEndpoint[event.endpoint] || 0) + 1;
        if (!event.ok) {
          recentFailuresByEndpoint[event.endpoint] = (recentFailuresByEndpoint[event.endpoint] || 0) + 1;
        }
      }

      return {
        uptime,
        endpoints: rateLimiterStatus,
        cache: {
          l1Size: cacheStats.l1Size,
          hitRate: cacheStats.hitRate,
          hitStats: cacheStats.hitStats,
        },
        requests: {
          total: Object.values(metrics.requests).reduce((a, b) => a + b, 0),
          byEndpoint: metrics.requests,
        },
        failures: {
          total: Object.values(metrics.failures).reduce((a, b) => a + b, 0),
          byEndpoint: metrics.failures,
        },
        rolling: {
          windowMs: HEALTH_ROLLING_WINDOW_MS,
          requests: recentEvents.length,
          failures: recentEvents.filter((event) => !event.ok).length,
          byEndpoint: recentByEndpoint,
          failuresByEndpoint: recentFailuresByEndpoint,
        },
        latency: {
          average: this._getAverageLatency(),
          min: Math.min(...metrics.latencies || [0]),
          max: Math.max(...metrics.latencies || [0]),
        },
        batcher: this.batcher.getStatus(),
        fallback: this.fallback.getStatus(),
        providerTiming: this.cascadeTimer.getStatus(),
      };
    }

    /**
     * Start periodic metrics collection
     */
    startMetricsCollection() {
      this.metricsTimer = setInterval(() => {
        this._collectMetrics();
      }, 30000); // Every 30 seconds
    }

    /**
     * Collect and export metrics
     */
    _collectMetrics() {
      const status = this.getHealthStatus();
      const timestamp = new Date().toISOString();
      const metricsLine = {
        timestamp,
        ...status,
      };

      // Log to console
      console.log('[ProxyOrchestrator] Metrics:', JSON.stringify(metricsLine, null, 2));

      // Try to export to file (if available via Tauri or Node.js)
      try {
        if (typeof window.tauriExportMetrics === 'function') {
          window.tauriExportMetrics(metricsLine);
        }
      } catch (err) {
        // Silently fail if not available
      }
    }

    /**
     * Stop metrics collection
     */
    stopMetricsCollection() {
      if (this.metricsTimer) {
        clearInterval(this.metricsTimer);
      }
    }

    /**
     * Shutdown orchestrator
     */
    shutdown() {
      this.stopMetricsCollection();
      this.fallback.stopHealthChecks();
      this.cache.clear();
      console.log('[ProxyOrchestrator] Shutdown complete');
    }
  }

  // ── EXPORT ──────────────────────────────────────────────────────
  // ── Robust ProxyOrchestrator Initialization with Retry ──
  (function initializeProxyOrchestratorWithRetry() {
    const MAX_RETRIES = 5;
    let attempt = 0;
    let backoff = 2000;

    async function tryInit() {
      try {
        window._proxyOrchestrator = new ProxyOrchestrator(window._proxyOrchestratorConfig || {});
        console.log('[ProxyOrchestrator] Initialization successful');
      } catch (err) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          console.error('[ProxyOrchestrator] Failed to initialize after', MAX_RETRIES, 'attempts:', err.message);
          return;
        }
        console.warn(`[ProxyOrchestrator] Initialization failed (attempt ${attempt}): ${err.message}. Retrying in ${backoff}ms...`);
        setTimeout(tryInit, backoff);
        backoff = Math.min(backoff * 2, 30000); // Exponential backoff, max 30s
      }
    }
    tryInit();
  })();

  window.ProxyOrchestrator = ProxyOrchestrator;
  window.RateLimiter = RateLimiter;
  window.RequestBatcher = RequestBatcher;
  window.FallbackRouter = FallbackRouter;
  window.CacheOrchestrator = CacheOrchestrator;

  console.log('[ProxyOrchestrator] Module loaded');
})();
