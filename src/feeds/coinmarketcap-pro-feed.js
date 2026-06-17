/**
 * coinmarketcap-pro-feed.js — CoinMarketCap Pro API Integration
 *
 * Provides real-time market data via CoinMarketCap Pro API:
 * - Latest quotes (price, market cap, volume, change %)
 * - Fear & Greed Index (macro sentiment)
 * - Global market metrics
 *
 * ★ PRO MODE: Enabled only when a valid API key is provided.
 * Without a valid key, this module serves cache and free fallback sources.
 *
 * Trial Docs: https://pro-api.coinmarketcap.com/trial-pro-api
 * Pro Docs: https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest
 */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────
  const CMC_PRO_QUOTES_BASE_URL = 'https://pro-api.coinmarketcap.com/v1';  // Requires API key
  const CMC_PRO_GLOBAL_BASE_URL = 'https://pro-api.coinmarketcap.com/v1';  // Requires API key
  const CMC_PRO_FNG_BASE_URL = 'https://pro-api.coinmarketcap.com/v3';  // Requires API key
  const CMC_QUOTES_PATH = '/cryptocurrency/quotes/latest';
  const CMC_GLOBAL_PATH = '/global-metrics/quotes/latest';
  const CMC_FEAR_INDEX_PATH = '/fear-and-greed/latest';
  const CACHE_TTL_MS = 60 * 60 * 1000;  // 1-hour cache to save credits
  const CMC_QUOTES_MIN_INTERVAL_MS = 6 * 60 * 1000;  // ~7.2K quote calls/month at 30d uptime
  const CMC_GLOBAL_MIN_INTERVAL_MS = 60 * 60 * 1000; // ~720 global calls/month
  const CMC_MIN_POLL_MS = CMC_QUOTES_MIN_INTERVAL_MS;
  const POLL_MS = CMC_MIN_POLL_MS;
  const CMC_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
  const CMC_AUTH_COOLDOWN_MS = 30 * 60 * 1000;
  const CMC_FNG_PRO_ENABLED = false; // Alternative.me avoids burning CMC monthly quota.
  const FNG_CACHE_TTL_MS = 15 * 60 * 1000;
  const FNG_TIMEOUT_MS = 5000;
  const cache = {};   // sym → { price, marketCap, volume24h, change24h, ts }
  const globalMetrics = {}; // { dominance, totalMarketCap, totalVolume24h, ts }
  const fearGreed = {}; // { value, label, ts }
  let cmcFearGreedUnsupported = false;
  let cmcRateLimitedUntil = 0;
  let cmcProDisabledUntil = 0;
  let lastQuotesCmcRequestTs = 0;
  let lastGlobalCmcRequestTs = 0;

  // ── Credential helpers ──────────────────────────────────────────────────────
  function getApiKey() {
    try {
      const env = window.__env?.CMC_PRO_API_KEY || window.__env?.COINMARKETCAP_API_KEY || window.desktopApp?.publicEnv?.CMC_PRO_API_KEY || window.desktopApp?.publicEnv?.COINMARKETCAP_API_KEY;
      if (env && String(env).trim()) return String(env).trim();
    } catch (_) { }
    try {
      const stored = localStorage.getItem('cmc_pro_api_key');
      if (stored && stored.trim()) return stored.trim();
    } catch (_) { }
    return '';
  }

  function setApiKey(key) {
    const normalized = String(key || '').trim();
    if (normalized) localStorage.setItem('cmc_pro_api_key', normalized);
    else localStorage.removeItem('cmc_pro_api_key');
    cmcProDisabledUntil = 0;
  }

  function hasApiKey() { return !!getApiKey() && Date.now() >= cmcProDisabledUntil; }
  function getBaseUrl() { return hasApiKey() ? CMC_PRO_QUOTES_BASE_URL : ''; }

  function cmcUnavailableReason() {
    if (!getApiKey()) return 'missing CMC API key';
    if (Date.now() < cmcProDisabledUntil) return 'CMC API key rejected; cooldown active';
    if (Date.now() < cmcRateLimitedUntil) return 'CMC rate-limit cooldown active';
    return '';
  }

  function markCmcUnavailable(reason) {
    try {
      window.NetworkHealth?.update('CoinMarketCap', {
        status: 'degraded',
        fallback: true,
        transient: true,
        reason,
        bucket: 'provider/api',
        bucketReason: reason,
        lastFetch: Date.now(),
      });
    } catch (_) {}
  }

  function symbolList(symbols) {
    return Array.isArray(symbols)
      ? symbols.map(s => String(s).trim()).filter(Boolean)
      : String(symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  function cachedQuotes(symbols) {
    const out = {};
    symbolList(symbols).forEach(sym => {
      const cached = getCachedQuote(sym);
      if (cached) out[sym] = cached;
    });
    return out;
  }

  function cmcPayloadError(json) {
    const raw = json?.status?.error_code;
    const code = raw == null ? 0 : Number(raw);
    return Number.isFinite(code) && code !== 0
      ? json?.status?.error_message || `CMC status error ${raw}`
      : '';
  }

  function handleCmcFailure(status, message) {
    if (status === 429 || /rate|limit|quota/i.test(message || '')) {
      cmcRateLimitedUntil = Date.now() + CMC_RATE_LIMIT_COOLDOWN_MS;
      console.warn(`[CMC] Rate limited; cooling down until ${new Date(cmcRateLimitedUntil).toLocaleTimeString()}`);
    }
    if (status === 401 || /api key|unauthorized/i.test(message || '')) {
      cmcProDisabledUntil = Date.now() + CMC_AUTH_COOLDOWN_MS;
      console.warn('[CMC] Pro key rejected; disabling CMC Pro for this session window.');
      try {
        localStorage.removeItem('cmc_pro_api_key');
      } catch (_) { }
    }
  }

  function isCoolingDown() {
    return Date.now() < cmcRateLimitedUntil;
  }

  // ── Short-term limiter; monthly quota is enforced by endpoint-level freshness gates. ───────
  let _lastRequestTime = 0;
  let _fetchQueue = Promise.resolve();
  let _fetchQueueLength = 0;
  const REQUEST_MIN_GAP_MS = 2000;

  async function _rateLimitedFetch(url, options) {
    if (_fetchQueueLength > 10) {
      return Promise.reject(new Error('Rate limit queue too long, rejecting CMC fetch'));
    }
    _fetchQueueLength++;
    const p = _fetchQueue.then(async () => {
      const now = Date.now();
      const gap = now - _lastRequestTime;
      if (gap < REQUEST_MIN_GAP_MS) {
        await new Promise(r => setTimeout(r, REQUEST_MIN_GAP_MS - gap));
      }
      _lastRequestTime = Date.now();
      return fetch(url, options);
    });
    _fetchQueue = p.catch(() => {}).finally(() => {
      _fetchQueueLength--;
    });
    return p;
  }

  // ── Latest quotes (multi-symbol) ────────────────────────────────────────────
  async function getLatestQuotes(symbols) {
    const apiKey = getApiKey();
    const symbolStr = symbolList(symbols).join(',');
    const isProMode = hasApiKey();
    const cached = cachedQuotes(symbols);
    const now = Date.now();

    if (!symbolStr) return {};
    if (lastQuotesCmcRequestTs && (now - lastQuotesCmcRequestTs) < CMC_QUOTES_MIN_INTERVAL_MS) {
      return cached;
    }
    if (!isProMode) {
      const reason = cmcUnavailableReason();
      markCmcUnavailable(reason);
      return cached;
    }
    if (isCoolingDown()) return cached;

    try {
      lastQuotesCmcRequestTs = Date.now();
      const buildUrl = (mode) => {
        if (mode !== 'pro') throw new Error('CMC requires a valid API key');
        return `${CMC_PRO_QUOTES_BASE_URL}${CMC_QUOTES_PATH}?symbol=${encodeURIComponent(symbolStr)}&convert=USD`;
      };
      const buildHeaders = (mode) => {
        const headers = { Accept: 'application/json' };
        if (mode === 'pro' && apiKey) headers['X-CMC_PRO_API_KEY'] = apiKey;
        return headers;
      };

      // Try ProxyOrchestrator if available for deduplication and caching
      if (typeof window.ProxyOrchestrator !== 'undefined' && window._proxyOrchestrator) {
        try {
          const result = await window._proxyOrchestrator.fetch(buildUrl(isProMode ? 'pro' : 'trial'), {
            endpoint: 'cmc',
            cacheType: 'price-quotes',
            retries: 0,
            fallbackChain: ['cmc', 'coingecko', 'coinbase', 'cache'],
            requestOptions: { headers: buildHeaders(isProMode ? 'pro' : 'trial') },
          });

          // Cache result in local cache for backwards compatibility
          const payloadError = cmcPayloadError(result);
          if (payloadError) {
            handleCmcFailure(200, payloadError);
            console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes payload error: ${payloadError}`);
            return cachedQuotes(symbols);
          }

          if (result && result.data) {
            Object.entries(result.data).forEach(([sym, data]) => {
              const usd = data.quote?.USD || {};
              cache[sym] = {
                price: usd.price || 0,
                marketCap: usd.market_cap || 0,
                volume24h: usd.volume_24h || 0,
                change24h: usd.percent_change_24h || 0,
                ts: Date.now()
              };
            });
          }

          console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes via proxy: ${Object.keys(result?.data || {}).length} coins ✓`);
          return result?.data || {};
        } catch (err) {
          if (/401|403|unauthorized|forbidden|api key/i.test(err?.message || '')) {
            handleCmcFailure(401, err?.message || '');
            markCmcUnavailable(cmcUnavailableReason());
            return cachedQuotes(symbols);
          }
          console.warn(`[CMC] ProxyOrchestrator failed, falling back:`, err.message);
        }
      }

      // Fallback: direct fetch with rate limiting
      // Add rate limiter call before fetch
      if (window.ApiRateLimiter) {
        const limiter = window.ApiRateLimiter.getLimiter('coinmarketcap');
        await limiter.acquire();
      }

      const tryFetch = (mode) => _rateLimitedFetch(buildUrl(mode), { method: 'GET', headers: buildHeaders(mode) });
      let resp = await tryFetch('pro');

      let errText = '';
      if (!resp.ok) {
        errText = await resp.text().catch(() => '');
        if (isProMode && (resp.status === 401 || resp.status === 403)) {
          handleCmcFailure(resp.status, errText);
          markCmcUnavailable(cmcUnavailableReason());
          return cachedQuotes(symbols);
        }
      }

      if (!resp.ok) {
        handleCmcFailure(resp.status, errText);
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes (${resp.status}):`, errText.slice(0, 100));
        return cachedQuotes(symbols);
      }

      const json = await resp.json();
      const payloadError = cmcPayloadError(json);
      if (payloadError) {
        handleCmcFailure(200, payloadError);
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes payload error: ${payloadError}`);
        return cachedQuotes(symbols);
      }
      if (!json.data) return cachedQuotes(symbols);

      const result = {};
      Object.entries(json.data).forEach(([sym, data]) => {
        const usd = data.quote?.USD || {};
        result[sym] = {
          price: usd.price || 0,
          marketCap: usd.market_cap || 0,
          volume24h: usd.volume_24h || 0,
          change24h: usd.percent_change_24h || 0,
          ts: Date.now()
        };
        cache[sym] = result[sym];
      });

      console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes: ${Object.keys(result).length} coins ✓`);
      return result;
    } catch (e) {
      console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes error:`, e.message);
      return cachedQuotes(symbols);
    }
  }

  // ── Global market metrics ────────────────────────────────────────────────────
  async function getGlobalMetrics() {
    const isProMode = hasApiKey();
    const apiKey = getApiKey();
    const now = Date.now();

    if ((globalMetrics.ts && (now - globalMetrics.ts) < CMC_GLOBAL_MIN_INTERVAL_MS)
      || (lastGlobalCmcRequestTs && (now - lastGlobalCmcRequestTs) < CMC_GLOBAL_MIN_INTERVAL_MS)) {
      return globalMetrics;
    }
    if (!isProMode) {
      markCmcUnavailable(cmcUnavailableReason());
      return globalMetrics;
    }
    if (isCoolingDown()) return globalMetrics;

    try {
      lastGlobalCmcRequestTs = Date.now();
      const buildUrl = (mode) => {
        if (mode !== 'pro') throw new Error('CMC requires a valid API key');
        return `${CMC_PRO_GLOBAL_BASE_URL}${CMC_GLOBAL_PATH}?convert=USD`;
      };
      const buildHeaders = (mode) => {
        const headers = { Accept: 'application/json' };
        if (mode === 'pro' && apiKey) headers['X-CMC_PRO_API_KEY'] = apiKey;
        return headers;
      };
      let resp = await _rateLimitedFetch(buildUrl('pro'), { method: 'GET', headers: buildHeaders('pro') });

      let errText = '';
      if (!resp.ok) {
        errText = await resp.text().catch(() => '');
        if (isProMode && (resp.status === 401 || resp.status === 403)) {
          handleCmcFailure(resp.status, errText);
          markCmcUnavailable(cmcUnavailableReason());
          return globalMetrics;
        }
      }

      if (!resp.ok) {
        handleCmcFailure(resp.status, errText);
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics (${resp.status})`);
        return globalMetrics;
      }

      const json = await resp.json();
      const payloadError = cmcPayloadError(json);
      if (payloadError) {
        handleCmcFailure(200, payloadError);
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics payload error: ${payloadError}`);
        return globalMetrics;
      }
      if (!json.data) return globalMetrics;

      const data = json.data;
      globalMetrics.totalMarketCap = data.quote?.USD?.total_market_cap || 0;
      globalMetrics.totalVolume24h = data.quote?.USD?.total_volume_24h || 0;
      globalMetrics.btcDominance = data.btc_dominance || 0;
      globalMetrics.cryptoCount = data.active_cryptocurrencies || 0;
      globalMetrics.ts = Date.now();

      console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics (BTC dom: ${globalMetrics.btcDominance.toFixed(1)}%) ✓`);
      return globalMetrics;
    } catch (e) {
      console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics error:`, e.message);
      return globalMetrics;
    }
  }

  // ── Fear & Greed Index ────────────────────────────────────────────────────
  async function getFearGreedIndex() {
    try {
      if (fearGreed.ts && (Date.now() - fearGreed.ts) < FNG_CACHE_TTL_MS) return fearGreed;

      // Primary: CoinMarketCap (if available)
      if (CMC_FNG_PRO_ENABLED && !isCoolingDown() && !cmcFearGreedUnsupported) {
        const usePro = hasApiKey();
        const cmcUrl = usePro ? `${CMC_PRO_FNG_BASE_URL}${CMC_FEAR_INDEX_PATH}` : '';
        const cmcHeaders = { Accept: 'application/json' };
        if (usePro) cmcHeaders['X-CMC_PRO_API_KEY'] = getApiKey();
        try {
          if (!usePro) throw new Error(cmcUnavailableReason());
          let resp = await _rateLimitedFetch(cmcUrl, { method: 'GET', headers: cmcHeaders });
          if (!resp.ok && usePro && (resp.status === 401 || resp.status === 403)) {
            handleCmcFailure(resp.status, await resp.text().catch(() => ''));
            markCmcUnavailable(cmcUnavailableReason());
            throw new Error(cmcUnavailableReason());
          }
          if (resp.ok) {
            // Add rate limiter call before processing response
            if (window.ApiRateLimiter) {
              const limiter = window.ApiRateLimiter.getLimiter('coinmarketcap');
              await limiter.acquire();
            }

            const json = await resp.json();
            const payloadError = cmcPayloadError(json);
            if (payloadError) {
              handleCmcFailure(200, payloadError);
              console.info('[CMC] F&G payload unavailable; using Alternative.me.');
            } else if (json.data) {
              const data = Array.isArray(json.data) ? json.data[0] : json.data;
              fearGreed.value = data.value || null;
              fearGreed.label = data.value_classification || 'N/A';
              fearGreed.ts = Date.now();
              console.info(`[CMC] F&G: ${fearGreed.value} (${fearGreed.label}) ✓`);
              return fearGreed;
            }
          } else if (resp.status === 404) {
            cmcFearGreedUnsupported = true;
            console.info('[CMC] F&G endpoint unsupported (404); using Alternative.me only for this session.');
          } else if (resp.status === 401) {
            handleCmcFailure(resp.status, await resp.text().catch(() => ''));
            console.error('[CMC] 401 Unauthorized - Invalid or missing API key');
            console.info('[CMC] Falling back to Alternative.me...');
          } else if (resp.status === 429) {
            handleCmcFailure(resp.status, await resp.text().catch(() => ''));
            console.info('[CMC] F&G rate limited; using Alternative.me.');
          }
        } catch (cmcErr) {
          console.debug('[CMC] F&G failed, trying Alternative.me:', cmcErr.message);
        }
      }

      // Fallback: Alternative.me (free, no auth required)
      // Timeout: 5s (still non-blocking, less noisy on slow routes)
      const altUrl = 'https://api.alternative.me/fng/';
      const altResp = await fetch(altUrl, { signal: AbortSignal.timeout(FNG_TIMEOUT_MS) });
      if (altResp.ok) {
        const json = await altResp.json();
        const data = json.data?.[0] || json;
        fearGreed.value = parseInt(data.value, 10);
        fearGreed.label = data.value_classification || 'NEUTRAL';
        fearGreed.ts = Date.now();
        console.info(`[Alternative.me] F&G: ${fearGreed.value} (${fearGreed.label}) ✓`);
        return fearGreed;
      }

      console.warn('[F&G] Both CMC and Alternative.me failed - using cached value');
      return fearGreed;
    } catch (e) {
      console.warn(`[F&G] Timeout/error after ${FNG_TIMEOUT_MS / 1000}s: ${e.message} - using cached value`);
      return fearGreed;  // Return cached value on timeout/error
    }
  }

  // ── Cached quote accessor ──────────────────────────────────────────────────────
  function getCachedQuote(symbol) {
    const cached = cache[symbol];
    if (!cached) return null;
    const age = Date.now() - cached.ts;
    if (age > CACHE_TTL_MS) return null;
    return cached;
  }

  // ── Poll handler (auto-refresh on interval) ──────────────────────────────────
  let _pollTimer = null;

  function startPolling(symbols, interval = POLL_MS) {
    if (_pollTimer) return;
    const requestedInterval = Number(interval) || POLL_MS;
    const effectiveInterval = Math.max(requestedInterval, CMC_MIN_POLL_MS);
    const pollFn = async () => {
      const mode = hasApiKey() ? 'Pro' : 'Trial';
      console.debug(`[CMC ${mode}] Poll (${symbols.length} coins)…`);
      await getLatestQuotes(symbols);
      await getGlobalMetrics();
      await getFearGreedIndex();
    };
    pollFn().catch(e => console.warn('[CMC] Poll init failed:', e.message));
    _pollTimer = setInterval(pollFn, effectiveInterval);
    if (effectiveInterval !== requestedInterval) {
      console.warn(`[CMC] Requested poll ${requestedInterval}ms clamped to ${effectiveInterval}ms for monthly quota protection.`);
    }
    console.info(`[CMC ${hasApiKey() ? 'Pro' : 'Trial'}] Polling: ${effectiveInterval}ms (${symbols.length} coins)`);
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      console.info('[CMC] Polling stopped');
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window._cmcProFeed = {
    setApiKey,
    getApiKey,
    hasApiKey,
    getLatestQuotes,
    getGlobalMetrics,
    getFearGreedIndex,
    getCachedQuote,
    startPolling,
    stopPolling,
    cache: () => cache,
    globalMetrics: () => globalMetrics,
    fearGreed: () => fearGreed
  };

  console.info(`[CMC] Stack initialized: ${hasApiKey() ? 'Pro mode' : 'cache/fallback mode (no valid key)'}`);
})();
