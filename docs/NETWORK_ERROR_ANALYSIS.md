# Network Debug Analysis Report
**File**: `netdebug.05.07.2026.har`  
**Date**: 2026-05-07  
**Session Duration**: 10m 12s  
**Total Requests**: 7,945  
**Failed Requests**: 853 (10.7%)

---

## Critical Issues Found

### 🔴 BYBIT EXCHANGE - 472 FAILURES (55.3% of errors)
**Status Code: 403 Forbidden**

**Affected Endpoints:**
- `api.bybit.com/v5/market/kline` — 288 failures
- `api.bybit.com/v5/market/orderbook` — 92 failures
- `api.bybit.com/v5/market/recent-trade` — 92 failures

**Root Cause:**
- IP-based geographic restriction (user likely in restricted region)
- OR invalid/expired API credentials
- OR Bybit account not activated for API access

**Impact:**
- 🔴 CRITICAL: Cannot fetch real-time candle data (KLINE)
- Cannot fetch order book depth
- Cannot fetch recent trade history for volume analysis

**Fix Required:**
```javascript
// In src/feeds/bybit-connector.js
// Add fallback to alternative exchanges when 403 detected
const BYBIT_FALLBACK = [
  'https://api.binance.com',      // Binance (if available)
  'https://api.kraken.com',       // Kraken
  'https://api.crypto.com/v2'     // Crypto.com
];

// Implement automatic failover
async function fetchWithFallback(exchanges) {
  for (const exchange of exchanges) {
    try {
      const data = await fetchCandles(exchange);
      return data;  // Success
    } catch (err) {
      if (err.status === 403) {
        console.warn(`[Bybit Connector] 403 Forbidden, trying next exchange...`);
        continue;  // Try next exchange
      }
      throw err;
    }
  }
}
```

**Action Items:**
- [ ] Check Bybit account IP allowlist settings
- [ ] Verify API key credentials
- [ ] Contact Bybit support if IP is whitelisted
- [ ] Implement automatic exchange failover

---

### 🔴 BINANCE FUTURES - 216 FAILURES (25.3% of errors)
**Status Code: 451 Unavailable for Legal Reasons**

**Affected Endpoint:**
- `fapi.binance.com/fapi/v1/premiumIndex` — 216 failures

**Root Cause:**
- Geographical restrictions (Binance futures unavailable in your region)
- Regulatory compliance blocks
- VPN or proxy detection

**Impact:**
- 🔴 CRITICAL: Cannot fetch funding rates
- Cannot calculate leverage/funding impact on signals
- Missing component in multi-exchange analysis

**Fix Required:**
```javascript
// In src/feeds/binance-connector.js
// Detect geo-blocking and implement region-aware routing
async function fetchPremiumIndex(symbol) {
  try {
    // Try Binance Futures first
    return await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
  } catch (err) {
    if (err.status === 451) {
      console.warn('[Binance] 451 Geo-block detected, using alternative funding rate source');
      // Fall back to derivatives.dydx.exchange or other sources
      return await fetchAlternativeFundingRate(symbol);
    }
    throw err;
  }
}

// Alternative funding rate sources
async function fetchAlternativeFundingRate(symbol) {
  // Try dYdX, Bybit, or Kraken perpetuals
  const sources = [
    fetchFromDydx(symbol),
    fetchFromBybit(symbol),
    fetchFromKraken(symbol)
  ];
  
  for (const source of sources) {
    try {
      return await source;
    } catch (e) {
      continue;  // Try next source
    }
  }
}
```

**Action Items:**
- [ ] Identify user's geographic region
- [ ] Implement region-aware endpoint routing
- [ ] Add alternative funding rate sources (Bybit, dYdX)
- [ ] Update documentation about regional limitations

---

### 🟠 COINGECKO - 28 FAILURES (3.3% of errors)
**Status Code: 429 Too Many Requests**

**Affected Endpoints:**
- `api.coingecko.com/api/v3/coins/bitcoin/market_chart` — 8 failures
- `api.coingecko.com/api/v3/coins/ripple/market_chart` — 8 failures
- `api.coingecko.com/api/v3/coins/solana/market_chart` — 7 failures
- `api.coingecko.com/api/v3/coins/ethereum/market_chart` — 5 failures

**Root Cause:**
- Exceeding 10 requests/second rate limit
- Polling frequency too aggressive
- No request queuing or backoff

**Impact:**
- 🟠 HIGH: Intermittent gaps in historical price data
- Fear & Greed Index fetching occasionally fails
- Backtesting data collection interrupted

**Fix Required:**
```javascript
// In src/feeds/coingecko-connector.js
// Implement token bucket rate limiter
class RateLimiter {
  constructor(rps = 10) {  // 10 req/sec
    this.rps = rps;
    this.tokens = rps;
    this.lastRefill = Date.now();
  }

  async acquire() {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.rps, this.tokens + timePassed * this.rps);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitTime = (1 - this.tokens) * 1000 / this.rps;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.acquire();  // Retry after waiting
    }

    this.tokens -= 1;
  }
}

const limiter = new RateLimiter(8);  // Conservative: 8 req/sec for CoinGecko

async function fetchMarketChart(coinId) {
  await limiter.acquire();  // Wait if needed
  return fetch(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`);
}
```

**Action Items:**
- [ ] Implement request queue/rate limiter
- [ ] Reduce polling frequency by 20%
- [ ] Add exponential backoff on 429 errors
- [ ] Consider CoinGecko Pro API for higher limits

---

### 🟠 BLOCKCYPHER - 10 FAILURES (1.2% of errors)
**Status Code: 429 Too Many Requests**

**Affected Endpoint:**
- `api.blockcypher.com/v1/doge/main` — 10 failures

**Root Cause:**
- Rate limit quota exhausted
- DOGE-specific rate limit stricter than other chains

**Impact:**
- 🟠 MEDIUM: Cannot fetch on-chain DOGE metrics
- DOGE signal weakness during heavy polling

**Fix:**
- Upgrade BlockCypher tier (free = 200 req/hr)
- Switch to Blockchain.com or Chain.so for DOGE data
- Implement caching (1-hour TTL for on-chain metrics)

---

### 🟠 COINMARKETCAP - 11 FAILURES (1.3% of errors)
**Status Code: 401 Unauthorized**

**Affected Endpoint:**
- `pro-api.coinmarketcap.com/v1/fear-and-greed/latest` — 11 failures

**Root Cause:**
- Invalid, expired, or missing API key
- API key not permitted for this endpoint

**Impact:**
- 🟠 MEDIUM: Market sentiment signal unavailable
- Reduces signal diversity

**Fix:**
- Verify CoinMarketCap API key in environment
- Check API key permissions include Fear & Greed endpoint
- Regenerate if expired

**Check:**
```bash
echo $COINMARKETCAP_API_KEY
# Should output a valid API key, not empty
```

---

### 🟡 BLOCKSCOUT - 56 FAILURES (6.6% of errors)
**Status Code: 400 Bad Request**

**Affected Endpoints:**
- `eth.blockscout.com/api/v2/gas-price-oracle` — 37 failures
- `bsc.blockscout.com/api/v2/stats` — 19 failures

**Root Cause:**
- Invalid query parameters
- Endpoint API changed
- Missing required headers

**Impact:**
- 🟡 LOW: Cannot fetch gas fees (not critical for predictions)
- Affects transaction cost estimates only

**Fix:**
- Update query parameters to match Blockscout v2 API
- Or switch to ETH gas-tracker.com or Binance gas API

---

## Summary Table

| Rank | API | Errors | Code | Severity | Root Cause | Fix Priority |
|------|-----|--------|------|----------|-----------|--------------|
| 1 | Bybit | 472 | 403 | 🔴 CRITICAL | Access blocked (IP/creds) | 24h |
| 2 | Binance Futures | 216 | 451 | 🔴 CRITICAL | Geo-blocking | 24h |
| 3 | CoinGecko | 28 | 429 | 🟠 HIGH | Rate limit (10 req/s) | 48h |
| 4 | CoinMarketCap | 11 | 401 | 🟠 HIGH | Invalid API key | 48h |
| 5 | Blockscout | 56 | 400 | 🟡 MEDIUM | Bad query params | 1 week |
| 6 | BlockCypher | 10 | 429 | 🟠 HIGH | Rate limit (200/hr) | 48h |
| 7 | Chain.so | 19 | 404 | 🟡 LOW | Endpoint deprecated | 1 week |

---

## Implementation Roadmap

### Phase 1: Critical Fixes (24h)
- [ ] Fix Bybit 403 with automatic fallback to alternative exchanges
- [ ] Detect Binance 451 geo-block and route to alternative funding rate sources
- [ ] Verify CoinMarketCap API key

### Phase 2: Rate Limit Handling (48h)
- [ ] Implement global rate limiter for all APIs
- [ ] Add exponential backoff for 429 errors
- [ ] Queue requests when hitting limits

### Phase 3: Resilience (1 week)
- [ ] Add circuit breaker pattern for failing APIs
- [ ] Implement multi-exchange fallback hierarchy
- [ ] Update documentation for regional limitations

### Phase 4: Monitoring (ongoing)
- [ ] Add APM metrics for API health
- [ ] Set up alerts for >5% error rates
- [ ] Weekly API status review

---

## No Pyth Lazer Errors Detected ✅

**Important Finding**: This HAR file contains **zero Pyth Lazer API errors**.

This could mean:
1. Pyth was not tested during this debugging session
2. Pyth requests were not captured in this dump
3. Pyth is working correctly (OR temporarily unavailable requests failed silently before capture)

**Recommendation**: Run separate Pyth-specific debugging session to verify Pyth Lazer resilience (retry logic) is working correctly.

---

## Files to Modify

1. **src/feeds/bybit-connector.js** — Add 403 fallback, exchange failover
2. **src/feeds/binance-connector.js** — Add 451 detection, region-aware routing
3. **src/feeds/coingecko-connector.js** — Add rate limiter
4. **src/feeds/request-limiter.js** (NEW) — Global rate limiting utility
5. **src/feeds/circuit-breaker.js** (NEW) — Circuit breaker pattern
6. **.env.example** — Document all API key requirements

---

**Status**: Analysis Complete  
**Next Step**: Implement Phase 1 fixes for Bybit 403 and Binance 451 errors
