/**
 * ================================================================
 * PROXY ORCHESTRATOR INTEGRATION GUIDE
 * ================================================================
 *
 * The Proxy Orchestrator is a critical infrastructure layer that prevents
 * rate-limit data loss across all API calls in the WE|||CRYPTO trading system.
 *
 * ================================================================
 * QUICK START
 * ================================================================
 *
 * 1. The proxy orchestrator is auto-initialized in src/core/app.js (line ~180)
 *    - Accessible via: window._proxyOrchestrator
 *
 * 2. Existing API calls have been automatically integrated:
 *    - Kalshi Market Fetch (prediction-markets.js, line 98+)
 *    - CMC Quotes (coinmarketcap-pro-feed.js, line 52+)
 *    - Kalshi Settlement Resolution (market-resolver.js, line 275+)
 *
 * 3. Check health status at any time:
 *    ```javascript
 *    console.log(window._proxyOrchestrator.getHealthStatus());
 *    ```
 *
 * ================================================================
 * ARCHITECTURE
 * ================================================================
 *
 * The system consists of 4 coordinated layers:
 *
 * LAYER 1: REQUEST DEDUPLICATION (RequestBatcher)
 * ─────────────────────────────────────────────────
 * • Coalesces identical requests within 500ms window
 * • Deduplicates by URL + params hash
 * • Result broadcasted to all subscribers
 * • Saves bandwidth and rate limit quota
 * Example: 3 simultaneous BTC price requests → 1 API call
 *
 * LAYER 2: RATE LIMITING & BACKOFF (RateLimiter)
 * ──────────────────────────────────────────────
 * • Per-endpoint rate tracking
 * • Exponential backoff: 2s → 4s → 8s → 16s → 32s
 * • Circuit breaker: stops after 3 failures for 60s
 * • Prevents cascade failures
 *
 * LAYER 3: FALLBACK CHAINS (FallbackRouter)
 * ────────────────────────────────────────
 * When primary source fails:
 *   Kalshi Markets (429) → Polymarket Markets → Cache → Null
 *   CMC Quotes (429) → PYTH Prices → Cache → Zero
 *   Kalshi Settlement → Polymarket Settlement → Cache → Unresolved
 *
 * LAYER 4: MULTI-LAYER CACHE (CacheOrchestrator)
 * ──────────────────────────────────────────────
 * L1: In-memory promises (fastest, < 1ms)
 * L2: localStorage (persistent, < 10ms)
 * L3: Multi-drive (F:\WECRYP\data, available via Tauri bridge)
 * TTL: Smart per-cache-type (5s prices, 30s markets, 1h settlement)
 *
 * ================================================================
 * API REFERENCE
 * ================================================================
 *
 * PROXY ORCHESTRATOR
 * ──────────────────
 *
 * async fetch(url, options = {})
 *   Main fetch interface with all resilience layers.
 *   
 *   Options:
 *     endpoint: string        - API source identifier (e.g., 'kalshi', 'cmc')
 *     cacheType: string       - TTL category (e.g., 'price-quotes', 'market-data')
 *     skipCache: boolean      - Bypass cache (default: false)
 *     fallbackChain: string[] - Custom fallback sequence (default: auto)
 *     retries: number         - Retry attempts on failure (default: 2)
 *
 *   Returns: Promise<any>    - API response data
 *
 *   Example:
 *     const markets = await window._proxyOrchestrator.fetch(
 *       'https://gamma-api.polymarket.com/markets',
 *       { endpoint: 'kalshi-markets', cacheType: 'market-data' }
 *     );
 *
 * getHealthStatus()
 *   Get comprehensive system diagnostics.
 *
 *   Returns:
 *     {
 *       uptime: ms,
 *       endpoints: {
 *         kalshi: { healthy, circuitOpen, failures, nextRetry, safeInterval },
 *         cmc: { ... },
 *         ...
 *       },
 *       cache: { l1Size, hitRate, hitStats },
 *       requests: { total, byEndpoint },
 *       failures: { total, byEndpoint },
 *       latency: { average, min, max },
 *       batcher: { activeBatches, windowMs },
 *       fallback: { sources: { endpoint: { healthy, successCount, failureCount } } }
 *     }
 *
 * shutdown()
 *   Gracefully terminate orchestrator (clear timers, cache).
 *
 * ================================================================
 * RATE LIMIT CONFIGURATION
 * ================================================================
 *
 * Endpoint configurations (src/infra/proxy-orchestrator.js):
 *
 *   kalshi: { reqs_per_min: 100, burst: 0, backoff_start: 2000, backoff_max: 32000 }
 *   cmc: { credits_per_month: 10000, per_request: 1, burst: 0, backoff_start: 5000 }
 *   polymarket: { reqs_per_second: 50, reqs_per_minute: 1000, burst: 1000, backoff_start: 1000 }
 *   coinbase: { reqs_per_second: 15, burst: 100, backoff_start: 1000 }
 *   pyth: { reqs_per_second: Infinity, burst: Infinity, backoff_start: 0 }
 *   coingecko: { reqs_per_minute: 50, burst: 0, backoff_start: 2000 }
 *
 * To adjust for your deployment, edit RATE_LIMITS object at top of
 * src/infra/proxy-orchestrator.js and rebuild.
 *
 * ================================================================
 * FALLBACK CHAINS
 * ================================================================
 *
 * The system defines intelligent fallback sequences:
 *
 *   KALSHI-MARKETS (15M/5M contracts)
 *   ├─ Primary: Kalshi API
 *   ├─ Fallback: Polymarket Gamma API
 *   └─ Cache: Last known value
 *
 *   CMC-QUOTES (real-time prices)
 *   ├─ Primary: CoinMarketCap Pro API
 *   ├─ Fallback: PYTH Hermes prices
 *   └─ Cache: Last known value (reload)
 *
 *   KALSHI-SETTLEMENT (post-market outcomes)
 *   ├─ Primary: Kalshi API
 *   ├─ Fallback: Polymarket resolution
 *   └─ Cache: Last known value
 *
 * The router automatically health-checks each source every 30s
 * and skips unhealthy sources in the chain.
 *
 * ================================================================
 * MONITORING & METRICS
 * ================================================================
 *
 * Metrics are collected every 30 seconds and output to console.
 * For file export, implement window.tauriExportMetrics() function.
 *
 * Metrics include:
 *   - Requests/failures per endpoint
 *   - Cache hit rate
 *   - Average/min/max latency
 *   - Circuit breaker state
 *   - Fallback chain usage
 *
 * Sample output format (JSON Lines):
 *   {
 *     "timestamp": "2026-05-03T14:23:45.123Z",
 *     "uptime": 3600000,
 *     "endpoints": { "kalshi": { healthy: true, ... }, ... },
 *     "cache": { "l1Size": 42, "hitRate": 78, ... },
 *     ...
 *   }
 *
 * ================================================================
 * TESTING & VALIDATION
 * ================================================================
 *
 * 1. CHECK INITIALIZATION
 *    Open browser console and run:
 *    ```javascript
 *    window._proxyOrchestrator // Should not be undefined
 *    window._proxyOrchestrator.getHealthStatus() // Full status
 *    ```
 *
 * 2. TEST DEDUPLICATION
 *    ```javascript
 *    const start = Date.now();
 *    const r1 = await window._proxyOrchestrator.fetch(url, { endpoint: 'kalshi' });
 *    const t1 = Date.now() - start;
 *    
 *    const start2 = Date.now();
 *    const r2 = await window._proxyOrchestrator.fetch(url, { endpoint: 'kalshi' });
 *    const t2 = Date.now() - start2;
 *    
 *    console.log(`First call: ${t1}ms, Second call: ${t2}ms (expected <5ms)`);
 *    // Results should be identical: r1 === r2 (same reference)
 *    ```
 *
 * 3. TEST FALLBACK (Simulate 429)
 *    ```javascript
 *    // Mock a 429 response on kalshi endpoint
 *    // Verify fallback to polymarket succeeds
 *    // Check logs for: "[ProxyOrchestrator] Trying polymarket..."
 *    ```
 *
 * 4. TEST CACHE
 *    ```javascript
 *    const status = window._proxyOrchestrator.getHealthStatus();
 *    console.log(`Cache hit rate: ${status.cache.hitRate}%`);
 *    // Should improve over time as requests repeat
 *    ```
 *
 * 5. VIEW METRICS
 *    ```javascript
 *    const status = window._proxyOrchestrator.getHealthStatus();
 *    console.table(status);
 *    // Pretty-print all diagnostics
 *    ```
 *
 * ================================================================
 * TROUBLESHOOTING
 * ================================================================
 *
 * PROBLEM: \"ProxyOrchestrator not loaded yet\"
 * SOLUTION: Ensure src/infra/proxy-orchestrator.js loads before app.js
 *           Check HTML script loading order in build output.
 *
 * PROBLEM: \"Circuit breaker OPEN for kalshi\"
 * SOLUTION: You're getting rate-limited. The system will auto-recover in 60s.
 *           Check rate limit config and endpoint quota.
 *           Consider spacing requests further apart.
 *
 * PROBLEM: \"All endpoints exhausted: kalshi → polymarket → cache\"
 * SOLUTION: No data available anywhere. Network issue or rate-limited on all sources.
 *           Check console logs for \"HTTP 429\" or network errors.
 *           Try manually clearing cache: window._proxyOrchestrator.cache.clear()
 *
 * PROBLEM: Cache hit rate is 0%
 * SOLUTION: Normal for first run. Requires time to build up cache.
 *           After 5+ minutes of operation, should see 60-80% hit rate.
 *           Check localStorage is enabled (not in private mode).
 *
 * PROBLEM: Deduplication not working (same request takes 200ms twice)
 * SOLUTION: Requests are being made with different URLs or params.
 *           Check if URL is deterministic (no random query params).
 *           Use console: window._proxyOrchestrator.batcher.getStatus()
 *
 * ================================================================
 * MIGRATION GUIDE (For Existing Code)
 * ================================================================
 *
 * If you have existing fetch calls outside the integrated modules:
 *
 * OLD (Direct fetch):
 *   const res = await fetch(url, options);
 *   const data = await res.json();
 *
 * NEW (Via Proxy Orchestrator):
 *   const data = await window._proxyOrchestrator.fetch(url, {
 *     endpoint: 'my-api',
 *     cacheType: 'market-data',
 *     retries: 2,
 *   });
 *
 * Benefits gained:
 *   ✓ Automatic deduplication
 *   ✓ Rate limit protection with exponential backoff
 *   ✓ Circuit breaker prevents cascade failures
 *   ✓ Fallback chains for resilience
 *   ✓ Multi-layer caching (memory → storage)
 *   ✓ Request metrics and health diagnostics
 *
 * ================================================================
 * PERFORMANCE IMPACT
 * ================================================================
 *
 * Expected overhead per request:
 *   - Cache hit (L1): < 1ms
 *   - Cache hit (L2): < 10ms
 *   - Network fetch + cache write: + 5-10ms
 *   - Deduplication: Saves entire request
 *   - Fallback chain: Only used on 429 (saves data loss)
 *
 * Memory footprint:
 *   - In-memory cache: ~5-20MB (depends on API response size)
 *   - Batcher: ~1-5MB (1000 request promises max)
 *   - Rate limiters: ~1KB per endpoint
 *   - Total: ~10-30MB typical
 *
 * ================================================================
 * SUPPORT & DEBUGGING
 * ================================================================
 *
 * For detailed troubleshooting:
 *   1. Check browser console (F12) for [ProxyOrchestrator] log entries
 *   2. Run: window._proxyOrchestrator.getHealthStatus()
 *   3. Check localStorage usage: 
 *      Object.keys(localStorage).filter(k => k.startsWith('po_cache_')).length
 *   4. File a bug with console output + health status JSON
 *
 * ================================================================
 */

// This file is documentation only. The actual implementation is in:
//   src/infra/proxy-orchestrator.js
