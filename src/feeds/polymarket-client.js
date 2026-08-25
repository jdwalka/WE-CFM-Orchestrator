// polymarket-client.js — Complete Polymarket Predictions API Suite
// Integrates: Gamma API, CLOB API (with Per-Signer Token-Bucket Rate Limiting),
//             Data API, Relayer v2, Bridge API & Polygon RPC
// WalkerEnterprise WE|||CRYPTO Engine
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  // Direct Base URLs
  const GAMMA_BASE_URL   = 'https://gamma-api.polymarket.com';
  const CLOB_BASE_URL    = 'https://clob.polymarket.com';
  const DATA_BASE_URL    = 'https://data-api.polymarket.com';
  const RELAYER_BASE_URL = 'https://relayer-v2.polymarket.com';
  const BRIDGE_BASE_URL  = 'https://bridge.polymarket.com';
  const POLYGON_RPC_URL  = 'https://polygon-rpc.com';

  // Local Proxy URLs (CORS bypass fallback for browser/Electron)
  const PROXY_ORIGIN     = (typeof window !== 'undefined' && window.__PROXY_PORT__) ? `http://127.0.0.1:${window.__PROXY_PORT__}` : 'http://127.0.0.1:3010';
  const PROXY_GAMMA_URL   = `${PROXY_ORIGIN}/polymarket`;
  const PROXY_CLOB_URL    = `${PROXY_ORIGIN}/polymarket-clob`;
  const PROXY_DATA_URL    = `${PROXY_ORIGIN}/polymarket-data`;
  const PROXY_RELAYER_URL = `${PROXY_ORIGIN}/polymarket-relayer`;
  const PROXY_BRIDGE_URL  = `${PROXY_ORIGIN}/polymarket-bridge`;
  // Proxy URLs (CORS bypass for browser/Electron)
  function getProxyOrigin() {
    const p = (typeof window !== 'undefined' && window.__PROXY_PORT__) || 3010;
    return `http://127.0.0.1:${p}`;
  }
  const PROXY_GAMMA_URL   = `${getProxyOrigin()}/gamma`;
  const PROXY_CLOB_URL    = `${getProxyOrigin()}/polymarket-clob`;
  const PROXY_DATA_URL    = `${getProxyOrigin()}/polymarket-data`;
  const PROXY_RELAYER_URL = `${getProxyOrigin()}/polymarket-relayer`;
  const PROXY_BRIDGE_URL  = `${getProxyOrigin()}/polymarket-bridge`;

  // Auth secrets live ONLY in Electron main (secrets/POLYMARKET_API.txt) via IPC.
  // Never hardcode keys/secrets in the renderer — public Gamma/Data GETs need none.
  const CREDENTIALS = {
    apiKey: '',
    secret: '',
    passphrase: '',
    address: '',
    builderKey: '',
    builderSecret: '',
    builderPassphrase: '',
    relayerApiKey: '',
    relayerAddress: '',
  };

  /** Non-secret status from main process (address, liveTrading, ready). */
  let _authStatus = { ready: false, address: '', liveTrading: false };

  async function _refreshAuthStatus() {
    try {
      if (window.electron?.invoke) {
        const st = await window.electron.invoke('poly:status');
        if (st && !st.error) {
          _authStatus = {
            ready: !!st.ready,
            address: st.address || '',
            liveTrading: !!st.liveTrading,
          };
          if (_authStatus.address) CREDENTIALS.address = _authStatus.address;
          if (st.relayerAddress) CREDENTIALS.relayerAddress = st.relayerAddress;
        }
      }
    } catch (_) { /* main may not be ready yet */ }
    return _authStatus;
  }
  _refreshAuthStatus();

  // ── Per-Signer Token-Bucket Rate Limiter (Official Polymarket Spec) ────────
  // Standard Tier: Order: 40 tokens/s (burst 60); Cancel: 80 tokens/s (burst 120)
  class SignerTokenBucket {
    constructor(rate, burst, allowNegative = true) {
      this.rate = rate;             // tokens refilled per second
      this.burst = burst;           // maximum capacity
      this.tokens = burst;          // current available tokens
      this.allowNegative = allowNegative;
      this.lastRefill = Date.now();
      this.currentTier = 'Standard';
    }

    refill() {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
      this.lastRefill = now;
    }

    canSpend(cost = 1) {
      this.refill();
      return this.tokens >= cost;
    }

    async acquire(cost = 1) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return true;
      }
      // Calculate wait time
      const needed = cost - this.tokens;
      const waitMs = Math.ceil((needed / this.rate) * 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refill();
      this.tokens -= cost;
      return true;
    }

    updateFromHeaders(headers) {
      if (!headers) return;
      const remaining = headers.get('poly-ratelimit-remaining');
      const tier = headers.get('poly-ratelimit-tier');
      const warning = headers.get('poly-ratelimit-warning');

      if (remaining !== null && !isNaN(Number(remaining))) {
        this.tokens = Number(remaining);
      }
      if (tier) {
        this.currentTier = tier;
      }
      if (warning === 'true') {
        console.warn(`[PolymarketCLOB] Poly-RateLimit-Warning: approaching signer tier limit!`);
      }
    }
  }

  const orderBucket = new SignerTokenBucket(40, 60, true);
  const cancelBucket = new SignerTokenBucket(80, 120, true);

  const ASSET_SLUG_MAP = {
    BTC: ['bitcoin', 'btc'],
    ETH: ['ethereum', 'eth'],
    SOL: ['solana', 'sol'],
    XRP: ['xrp', 'ripple'],
    DOGE: ['doge', 'dogecoin'],
    BNB: ['bnb', 'binance'],
    HYPE: ['hype', 'hyperliquid'],
  };

  const cache = new Map();
  const CACHE_TTL_MS = 3_500;

  async function _fetchWithFallback(proxyUrl, directUrl, options = {}) {
    const cacheKey = proxyUrl || directUrl;
    const isGet = !options.method || options.method === 'GET';
    if (isGet) {
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return cached.data;
      }
    }

    const headers = {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      ...(options.headers || {}),
    };

    // Public market data does not require L2 headers. Signed CLOB ops go through
    // electron poly:* IPC so secrets never leave the main process.

    let response = null;

    // Try proxy first
    if (proxyUrl) {
      try {
        const res = await fetch(proxyUrl, { ...options, headers });
        if (res.ok) {
          response = res;
        }
      } catch (_) {}
    }

    // Direct fallback
    if (!response) {
      const res = await fetch(directUrl, { ...options, headers });
      if (!res.ok) {
        const retryAfter = res.headers?.get('retry-after');
        if (res.status === 429 && retryAfter) {
          console.warn(`[PolymarketCLOB] 429 Too Many Requests. Retry-After: ${retryAfter}s`);
        }
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${res.statusText} ${errText}`);
      }
      response = res;
    }

    // Update rate limit state from headers
    if (response?.headers) {
      orderBucket.updateFromHeaders(response.headers);
      cancelBucket.updateFromHeaders(response.headers);
    }

    const data = await response.json();
    if (isGet) {
      cache.set(cacheKey, { data, ts: Date.now() });
    }
    return data;
  }

  const PolymarketClient = {
    /** Public status only — never exposes apiKey/secret/passphrase. */
    getAuthStatus() { return { ..._authStatus, address: CREDENTIALS.address || _authStatus.address }; },
    refreshAuthStatus: _refreshAuthStatus,
    orderBucket,
    cancelBucket,

    // ── 1. Gamma API (Market & Event Discovery) ──────────────────────────────
    async getMarkets(params = {}) {
      const q = new URLSearchParams();
      q.set('closed', params.closed !== undefined ? String(params.closed) : 'false');
      if (params.limit !== undefined) q.set('limit', String(params.limit));
      if (params.offset !== undefined) q.set('offset', String(params.offset));
      if (params.order) q.set('order', params.order);
      if (params.ascending !== undefined) q.set('ascending', String(params.ascending));
      if (params.tag) q.set('tag', params.tag);
      if (params.tag_id !== undefined) q.set('tag_id', String(params.tag_id));
      if (params.slug) {
        if (Array.isArray(params.slug)) params.slug.forEach(s => q.append('slug', s));
        else q.set('slug', params.slug);
      }
      if (params.clob_token_ids) {
        if (Array.isArray(params.clob_token_ids)) params.clob_token_ids.forEach(t => q.append('clob_token_ids', t));
        else q.set('clob_token_ids', params.clob_token_ids);
      }
      if (params.condition_ids) {
        if (Array.isArray(params.condition_ids)) params.condition_ids.forEach(c => q.append('condition_ids', c));
        else q.set('condition_ids', params.condition_ids);
      }
      if (params.liquidity_num_min !== undefined) q.set('liquidity_num_min', String(params.liquidity_num_min));
      if (params.liquidity_num_max !== undefined) q.set('liquidity_num_max', String(params.liquidity_num_max));
      if (params.volume_num_min !== undefined) q.set('volume_num_min', String(params.volume_num_min));
      if (params.volume_num_max !== undefined) q.set('volume_num_max', String(params.volume_num_max));
      if (params.include_tag !== undefined) q.set('include_tag', String(params.include_tag));

      const qs = q.toString();
      return _fetchWithFallback(`${PROXY_GAMMA_URL}/markets?${qs}`, `${GAMMA_BASE_URL}/markets?${qs}`);
    },

    async listMarkets(params = {}) {
      return this.getMarkets(params);
    },

    async getMarketById(id, options = {}) {
      if (!id) return null;
      const qs = new URLSearchParams({
        ...(options.include_tag !== undefined ? { include_tag: String(options.include_tag) } : {}),
      }).toString();
      const queryStr = qs ? `?${qs}` : '';
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/markets/${encodeURIComponent(id)}${queryStr}`,
        `${GAMMA_BASE_URL}/markets/${encodeURIComponent(id)}${queryStr}`
      );
    },

    async getMarketBySlug(slug, options = {}) {
      if (!slug) return null;
      const qs = new URLSearchParams({
        ...(options.include_tag !== undefined ? { include_tag: String(options.include_tag) } : {}),
      }).toString();
      const queryStr = qs ? `?${qs}` : '';
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/markets/slug/${encodeURIComponent(slug)}${queryStr}`,
        `${GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}${queryStr}`
      );
    },

    async getMarketTags(id) {
      if (!id) return [];
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/markets/${encodeURIComponent(id)}/tags`,
        `${GAMMA_BASE_URL}/markets/${encodeURIComponent(id)}/tags`
      );
    },

    /** GET /public-profile — Gamma: fetch a user's public profile by wallet address */
    async getPublicProfile(address) {
      if (!address) return null;
      const qs = `?address=${encodeURIComponent(address)}`;
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/public-profile${qs}`,
        `${GAMMA_BASE_URL}/public-profile${qs}`
      );
    },

    /** GET /public-search — Gamma: full-text search across events, markets, tags, profiles */
    async publicSearch(params = {}) {
      if (!params.q) throw new Error('q (search query) is required');
      const qp = { q: params.q };
      if (params.cache              !== undefined) qp.cache              = String(params.cache);
      if (params.events_status)                   qp.events_status      = params.events_status;
      if (params.limit_per_type     !== undefined) qp.limit_per_type     = String(params.limit_per_type);
      if (params.page               !== undefined) qp.page               = String(params.page);
      if (params.events_tag)                       qp.events_tag         = Array.isArray(params.events_tag) ? params.events_tag.join(',') : params.events_tag;
      if (params.keep_closed_markets !== undefined) qp.keep_closed_markets = String(params.keep_closed_markets);
      if (params.sort)                             qp.sort               = params.sort;
      if (params.ascending          !== undefined) qp.ascending          = String(params.ascending);
      if (params.search_tags        !== undefined) qp.search_tags        = String(params.search_tags);
      if (params.search_profiles    !== undefined) qp.search_profiles    = String(params.search_profiles);
      if (params.recurrence)                       qp.recurrence         = params.recurrence;
      if (params.exclude_tag_id)                   qp.exclude_tag_id     = Array.isArray(params.exclude_tag_id) ? params.exclude_tag_id.join(',') : params.exclude_tag_id;
      if (params.optimized          !== undefined) qp.optimized          = String(params.optimized);
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/public-search?${qs}`,
        `${GAMMA_BASE_URL}/public-search?${qs}`
      );
    },

    /** GET /tags — Gamma: list all tags with optional filters */
    async getTags(params = {}) {
      const qp = {};
      if (params.limit    !== undefined) qp.limit            = String(params.limit);
      if (params.offset   !== undefined) qp.offset           = String(params.offset);
      if (params.order)                  qp.order            = params.order;
      if (params.ascending !== undefined) qp.ascending       = String(params.ascending);
      if (params.include_template !== undefined) qp.include_template = String(params.include_template);
      if (params.is_carousel !== undefined)      qp.is_carousel      = String(params.is_carousel);
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/tags${qs ? `?${qs}` : ''}`,
        `${GAMMA_BASE_URL}/tags${qs ? `?${qs}` : ''}`
      );
    },

    /** GET /tags/:id — Gamma: fetch a single tag by numeric ID */
    async getTagById(id, includeTemplate) {
      if (!id) throw new Error('id is required');
      const qs = includeTemplate !== undefined ? `?include_template=${includeTemplate}` : '';
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/tags/${encodeURIComponent(id)}${qs}`,
        `${GAMMA_BASE_URL}/tags/${encodeURIComponent(id)}${qs}`
      );
    },

    /** GET /tags/slug/:slug — Gamma: fetch a single tag by slug */
    async getTagBySlug(slug, includeTemplate) {
      if (!slug) throw new Error('slug is required');
      const qs = includeTemplate !== undefined ? `?include_template=${includeTemplate}` : '';
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/tags/slug/${encodeURIComponent(slug)}${qs}`,
        `${GAMMA_BASE_URL}/tags/slug/${encodeURIComponent(slug)}${qs}`
      );
    },

    /** GET /tags/:id/related-tags — Gamma: fetch related tag relationships */
    async getTagRelatedTags(id, params = {}) {
      if (!id) throw new Error('id is required');
      const qp = {};
      if (params.omit_empty !== undefined) qp.omit_empty = String(params.omit_empty);
      if (params.status)                   qp.status     = params.status;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/tags/${encodeURIComponent(id)}/related-tags${qs ? `?${qs}` : ''}`,
        `${GAMMA_BASE_URL}/tags/${encodeURIComponent(id)}/related-tags${qs ? `?${qs}` : ''}`
      );
    },

    /** GET /tags/slug/:slug/related-tags — Gamma: related tag relationships by slug */
    async getTagRelatedTagsBySlug(slug, params = {}) {
      if (!slug) throw new Error('slug is required');
      const qp = {};
      if (params.omit_empty !== undefined) qp.omit_empty = String(params.omit_empty);
      if (params.status)                   qp.status     = params.status;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/tags/slug/${encodeURIComponent(slug)}/related-tags${qs ? `?${qs}` : ''}`,
        `${GAMMA_BASE_URL}/tags/slug/${encodeURIComponent(slug)}/related-tags${qs ? `?${qs}` : ''}`
      );
    },

    /** GET /tags/:id/related-tags/tags — Gamma: full Tag objects related to a tag ID */
    async getTagsRelatedToTagById(id, params = {}) {
      if (!id) throw new Error('id is required');
      const qp = {};
      if (params.omit_empty !== undefined) qp.omit_empty = String(params.omit_empty);
      if (params.status)                   qp.status     = params.status;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/tags/${encodeURIComponent(id)}/related-tags/tags${qs ? `?${qs}` : ''}`,
        `${GAMMA_BASE_URL}/tags/${encodeURIComponent(id)}/related-tags/tags${qs ? `?${qs}` : ''}`
      );
    },

    /** GET /tags/slug/:slug/related-tags/tags — Gamma: full Tag objects related to a tag slug */
    async getTagsRelatedToTagBySlug(slug, params = {}) {
      if (!slug) throw new Error('slug is required');
      const qp = {};
      if (params.omit_empty !== undefined) qp.omit_empty = String(params.omit_empty);
      if (params.status)                   qp.status     = params.status;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/tags/slug/${encodeURIComponent(slug)}/related-tags/tags${qs ? `?${qs}` : ''}`,
        `${GAMMA_BASE_URL}/tags/slug/${encodeURIComponent(slug)}/related-tags/tags${qs ? `?${qs}` : ''}`
      );
    },







    /** GET /series — Gamma: list series with full filter support */
    async listSeries(params = {}) {
      const qp = {};
      if (params.limit    !== undefined) qp.limit           = String(params.limit);
      if (params.offset   !== undefined) qp.offset          = String(params.offset);
      if (params.order)                  qp.order           = params.order;
      if (params.ascending !== undefined) qp.ascending      = String(params.ascending);
      if (params.slug)      qp.slug             = Array.isArray(params.slug) ? params.slug.join(',') : params.slug;
      if (params.categories_ids)   qp.categories_ids   = Array.isArray(params.categories_ids) ? params.categories_ids.join(',') : params.categories_ids;
      if (params.categories_labels) qp.categories_labels = Array.isArray(params.categories_labels) ? params.categories_labels.join(',') : params.categories_labels;
      if (params.closed    !== undefined) qp.closed         = String(params.closed);
      if (params.include_chat !== undefined) qp.include_chat = String(params.include_chat);
      if (params.recurrence)              qp.recurrence     = params.recurrence;
      if (params.exclude_events !== undefined) qp.exclude_events = String(params.exclude_events);
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/series${qs ? `?${qs}` : ''}`,
        `${GAMMA_BASE_URL}/series${qs ? `?${qs}` : ''}`
      );
    },

    /** GET /series/:id — Gamma: fetch a single series by numeric ID */
    async getSeriesById(id, includeChat) {
      if (!id) throw new Error('id is required');
      const qs = includeChat !== undefined ? `?include_chat=${includeChat}` : '';
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/series/${encodeURIComponent(id)}${qs}`,
        `${GAMMA_BASE_URL}/series/${encodeURIComponent(id)}${qs}`
      );
    },

    /** GET /comments — Gamma: list comments with filter/pagination support */
    async listComments(params = {}) {
      const qp = {};
      if (params.limit    !== undefined) qp.limit              = String(params.limit);
      if (params.offset   !== undefined) qp.offset             = String(params.offset);
      if (params.order)                  qp.order              = params.order;
      if (params.ascending !== undefined) qp.ascending         = String(params.ascending);
      if (params.parent_entity_type)     qp.parent_entity_type = params.parent_entity_type;
      if (params.parent_entity_id !== undefined) qp.parent_entity_id = String(params.parent_entity_id);
      if (params.get_positions !== undefined) qp.get_positions = String(params.get_positions);
      if (params.holders_only  !== undefined) qp.holders_only  = String(params.holders_only);
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/comments${qs ? `?${qs}` : ''}`,
        `${GAMMA_BASE_URL}/comments${qs ? `?${qs}` : ''}`
      );
    },

    /** GET /comments/:id — Gamma: fetch thread for a comment ID (returns array) */
    async getCommentsById(id, getPositions) {
      if (!id) throw new Error('id is required');
      const qs = getPositions !== undefined ? `?get_positions=${getPositions}` : '';
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/comments/${encodeURIComponent(id)}${qs}`,
        `${GAMMA_BASE_URL}/comments/${encodeURIComponent(id)}${qs}`
      );
    },

    /** GET /comments/user_address/:user_address — Gamma: comments posted by a wallet address */
    async getCommentsByUserAddress(userAddress, params = {}) {
      if (!userAddress) throw new Error('userAddress is required');
      const qp = {};
      if (params.limit    !== undefined) qp.limit     = String(params.limit);
      if (params.offset   !== undefined) qp.offset    = String(params.offset);
      if (params.order)                  qp.order     = params.order;
      if (params.ascending !== undefined) qp.ascending = String(params.ascending);
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/comments/user_address/${encodeURIComponent(userAddress)}${qs ? `?${qs}` : ''}`,
        `${GAMMA_BASE_URL}/comments/user_address/${encodeURIComponent(userAddress)}${qs ? `?${qs}` : ''}`
      );
    },



    async getEvents(params = {}) {


      const qs = new URLSearchParams({
        closed: 'false',
        limit: String(params.limit || 20),
        ...(params.slug ? { slug: params.slug } : {}),
        ...(params.tag_slug ? { tag_slug: params.tag_slug } : {}),
        ...(params.offset !== undefined ? { offset: String(params.offset) } : {}),
        ...(params.order ? { order: params.order } : {}),
        ...(params.ascending !== undefined ? { ascending: String(params.ascending) } : {}),
      }).toString();

      return _fetchWithFallback(`${PROXY_GAMMA_URL}/events?${qs}`, `${GAMMA_BASE_URL}/events?${qs}`);
    },

    async listEvents(params = {}) {
      return this.getEvents(params);
    },

    async getEventById(id, options = {}) {
      if (!id) return null;
      const qs = new URLSearchParams({
        ...(options.include_chat ? { include_chat: 'true' } : {}),
        ...(options.include_template ? { include_template: 'true' } : {}),
      }).toString();
      const queryStr = qs ? `?${qs}` : '';
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/events/${encodeURIComponent(id)}${queryStr}`,
        `${GAMMA_BASE_URL}/events/${encodeURIComponent(id)}${queryStr}`
      );
    },

    async getEventBySlug(slug, options = {}) {
      if (!slug) return null;
      const qs = new URLSearchParams({
        ...(options.include_chat ? { include_chat: 'true' } : {}),
        ...(options.include_template ? { include_template: 'true' } : {}),
      }).toString();
      const queryStr = qs ? `?${qs}` : '';
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/events/slug/${encodeURIComponent(slug)}${queryStr}`,
        `${GAMMA_BASE_URL}/events/slug/${encodeURIComponent(slug)}${queryStr}`
      );
    },

    async getEventTags(id) {
      if (!id) return [];
      return _fetchWithFallback(
        `${PROXY_GAMMA_URL}/events/${encodeURIComponent(id)}/tags`,
        `${GAMMA_BASE_URL}/events/${encodeURIComponent(id)}/tags`
      );
    },

    async listMarketsKeyset(params = {}) {
      const qs = new URLSearchParams({
        limit: String(params.limit || 20),
        ...(params.after_cursor ? { after_cursor: params.after_cursor } : {}),
        ...(params.order ? { order: params.order } : {}),
        ...(params.ascending !== undefined ? { ascending: String(params.ascending) } : {}),
        ...(params.closed !== undefined ? { closed: String(params.closed) } : {}),
        ...(params.include_tag !== undefined ? { include_tag: String(params.include_tag) } : {}),
        ...(params.tag_match ? { tag_match: params.tag_match } : {}),
        ...(params.rfq_enabled !== undefined ? { rfq_enabled: String(params.rfq_enabled) } : {}),
      }).toString();

      return _fetchWithFallback(`${PROXY_GAMMA_URL}/markets/keyset?${qs}`, `${GAMMA_BASE_URL}/markets/keyset?${qs}`);
    },

    async listEventsKeyset(params = {}) {
      const qs = new URLSearchParams({
        limit: String(params.limit || 20),
        ...(params.after_cursor ? { after_cursor: params.after_cursor } : {}),
        ...(params.order ? { order: params.order } : {}),
        ...(params.ascending !== undefined ? { ascending: String(params.ascending) } : {}),
        ...(params.tag_slug ? { tag_slug: params.tag_slug } : {}),
        ...(params.closed !== undefined ? { closed: String(params.closed) } : {}),
        ...(params.live !== undefined ? { live: String(params.live) } : {}),
        ...(params.title_search ? { title_search: params.title_search } : {}),
      }).toString();

      return _fetchWithFallback(`${PROXY_GAMMA_URL}/events/keyset?${qs}`, `${GAMMA_BASE_URL}/events/keyset?${qs}`);
    },

    async fetchCryptoMarkets(sym = 'BTC') {
      const symbol = String(sym).toUpperCase();
      const keywords = ASSET_SLUG_MAP[symbol] || [symbol.toLowerCase()];
      const markets = await this.getMarkets({ limit: 100 });

      if (!Array.isArray(markets)) return [];

      return markets.filter((m) => {
        const question = String(m.question || '').toLowerCase();
        const slug = String(m.slug || '').toLowerCase();
        return keywords.some((kw) => question.includes(kw) || slug.includes(kw));
      });
    },

    async getLiveOdds(sym = 'BTC') {
      try {
        const markets = await this.fetchCryptoMarkets(sym);
        if (!markets.length) return null;

        const primary = markets[0];
        let yesPrice = 0.5;
        let noPrice = 0.5;

        try {
          const prices = typeof primary.outcomePrices === 'string'
            ? JSON.parse(primary.outcomePrices)
            : primary.outcomePrices;
          if (Array.isArray(prices)) {
            yesPrice = parseFloat(prices[0]) || 0.5;
            noPrice = parseFloat(prices[1]) || (1 - yesPrice);
          }
        } catch (_) {}

        return {
          sym,
          question: primary.question || '',
          slug: primary.slug || '',
          yesPrice,
          noPrice,
          yesProbability: Math.round(yesPrice * 100),
          noProbability: Math.round(noPrice * 100),
          volume: parseFloat(primary.volume || primary.volume24hr || 0),
          liquidity: parseFloat(primary.liquidity || 0),
          updatedAt: Date.now(),
        };
      } catch (err) {
        console.warn(`[PolymarketClient] Failed to fetch odds for ${sym}:`, err?.message);
        return null;
      }
    },

    // ── 2. CLOB Market Data API ──────────────────────────────────────────────
    async getMarketByToken(tokenId) {
      if (!tokenId) return null;
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/markets-by-token/${encodeURIComponent(tokenId)}`,
        `${CLOB_BASE_URL}/markets-by-token/${encodeURIComponent(tokenId)}`
      );
    },

    async getSimplifiedMarkets(nextCursor) {
      const qs = nextCursor ? `?next_cursor=${encodeURIComponent(nextCursor)}` : '';
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/simplified-markets${qs}`,
        `${CLOB_BASE_URL}/simplified-markets${qs}`
      );
    },

    async getSamplingMarkets(nextCursor) {
      const qs = nextCursor ? `?next_cursor=${encodeURIComponent(nextCursor)}` : '';
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/sampling-markets${qs}`,
        `${CLOB_BASE_URL}/sampling-markets${qs}`
      );
    },

    async getSamplingSimplifiedMarkets(nextCursor) {
      const qs = nextCursor ? `?next_cursor=${encodeURIComponent(nextCursor)}` : '';
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/sampling-simplified-markets${qs}`,
        `${CLOB_BASE_URL}/sampling-simplified-markets${qs}`
      );
    },

    async getOrderBook(tokenId) {
      if (!tokenId) return null;
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/book?token_id=${encodeURIComponent(tokenId)}`,
        `${CLOB_BASE_URL}/book?token_id=${encodeURIComponent(tokenId)}`
      );
    },

    async getOrderBooks(tokenRequests = []) {
      const payload = tokenRequests.map((req) =>
        typeof req === 'string' ? { token_id: req } : req
      );
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/books`,
        `${CLOB_BASE_URL}/books`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
    },

    async getPrice(tokenId, side = 'BUY') {
      if (!tokenId) return null;
      const s = String(side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      const qs = new URLSearchParams({ token_id: tokenId, side: s }).toString();
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/price?${qs}`,
        `${CLOB_BASE_URL}/price?${qs}`
      );
    },

    async getMarketPrices(tokenIds, sides = 'BUY') {
      const ids = Array.isArray(tokenIds) ? tokenIds.join(',') : String(tokenIds || '');
      const s = Array.isArray(sides) ? sides.join(',') : String(sides || 'BUY');
      if (!ids) return {};
      const qs = new URLSearchParams({ token_ids: ids, sides: s }).toString();
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/prices?${qs}`,
        `${CLOB_BASE_URL}/prices?${qs}`
      );
    },

    async postMarketPrices(priceRequests = []) {
      const payload = priceRequests.map((req) => ({
        token_id: req.token_id || req.tokenId,
        side: (req.side || 'BUY').toUpperCase(),
      }));
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/prices`,
        `${CLOB_BASE_URL}/prices`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
    },

    async getMidpoint(tokenId) {
      if (!tokenId) return null;
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/midpoint?token_id=${encodeURIComponent(tokenId)}`,
        `${CLOB_BASE_URL}/midpoint?token_id=${encodeURIComponent(tokenId)}`
      );
    },

    async getLastTradePrice(tokenId) {
      if (!tokenId) return null;
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`,
        `${CLOB_BASE_URL}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`
      );
    },

    async getMidpoints(tokenIds) {
      const ids = Array.isArray(tokenIds) ? tokenIds.join(',') : String(tokenIds || '');
      if (!ids) return {};
      const qs = new URLSearchParams({ token_ids: ids }).toString();
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/midpoints?${qs}`,
        `${CLOB_BASE_URL}/midpoints?${qs}`
      );
    },

    async postMidpoints(tokenIds = []) {
      const payload = tokenIds.map((id) =>
        typeof id === 'string' ? { token_id: id } : id
      );
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/midpoints`,
        `${CLOB_BASE_URL}/midpoints`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
    },

    async getSpreads(tokenIds = []) {
      const payload = tokenIds.map((id) =>
        typeof id === 'string' ? { token_id: id } : id
      );
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/spreads`,
        `${CLOB_BASE_URL}/spreads`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
    },

    async getLastTradesPrices(tokenIds) {
      const ids = Array.isArray(tokenIds) ? tokenIds.slice(0, 500).join(',') : String(tokenIds || '');
      if (!ids) return [];
      const qs = new URLSearchParams({ token_ids: ids }).toString();
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/last-trades-prices?${qs}`,
        `${CLOB_BASE_URL}/last-trades-prices?${qs}`
      );
    },

    async postLastTradesPrices(tokenIds = []) {
      const payload = tokenIds.slice(0, 500).map((id) =>
        typeof id === 'string' ? { token_id: id } : id
      );
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/last-trades-prices`,
        `${CLOB_BASE_URL}/last-trades-prices`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
    },

    async getPricesHistory(market, params = {}) {
      const { interval = '1m', startTs, endTs, fidelity } = typeof params === 'string'
        ? { interval: params } : params;
      const qp = { market };
      if (interval) qp.interval = interval;
      if (startTs) qp.startTs = startTs;
      if (endTs) qp.endTs = endTs;
      if (fidelity) qp.fidelity = fidelity;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/prices-history?${qs}`,
        `${CLOB_BASE_URL}/prices-history?${qs}`
      );
    },

    async getBatchPricesHistory(markets = [], params = {}) {
      const { interval, start_ts, end_ts, fidelity } = params;
      const payload = { markets: markets.slice(0, 20) };
      if (interval) payload.interval = interval;
      if (start_ts) payload.start_ts = start_ts;
      if (end_ts) payload.end_ts = end_ts;
      if (fidelity) payload.fidelity = fidelity;
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/batch-prices-history`,
        `${CLOB_BASE_URL}/batch-prices-history`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
    },

    async getFeeRate(tokenId) {
      const qs = tokenId ? `?token_id=${encodeURIComponent(tokenId)}` : '';
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/fee-rate${qs}`,
        `${CLOB_BASE_URL}/fee-rate${qs}`
      );
    },

    async getTickSize(tokenId) {
      const qs = tokenId ? `?token_id=${encodeURIComponent(tokenId)}` : '';
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/tick-size${qs}`,
        `${CLOB_BASE_URL}/tick-size${qs}`
      );
    },

    async getClobMarketInfo(conditionId) {
      if (!conditionId) return null;
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/clob-markets/${encodeURIComponent(conditionId)}`,
        `${CLOB_BASE_URL}/clob-markets/${encodeURIComponent(conditionId)}`
      );
    },

    async getServerTime() {
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/time`,
        `${CLOB_BASE_URL}/time`
      );
    },

    // ── 3. CLOB Trading & Order Management (Per-Signer Token-Bucket Protected) ─


    /**
     * Submit an order to the CLOB orderbook
     * Costs 1 Order Token
     */
    async createOrder(orderPayload) {
      await orderBucket.acquire(1);

      const headers = {
        'Content-Type': 'application/json',
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };

      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/order`,
        `${CLOB_BASE_URL}/order`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(orderPayload),
        }
      );
    },

    /**
     * Batch submit multiple orders
     * Splits into chunks if batch size exceeds tier burst capacity
     */
    async createOrders(orderBatch) {
      if (!Array.isArray(orderBatch) || !orderBatch.length) return [];
      const batchSize = Math.min(orderBatch.length, orderBucket.burst);
      await orderBucket.acquire(batchSize);

      const headers = {
        'Content-Type': 'application/json',
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };

      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/orders`,
        `${CLOB_BASE_URL}/orders`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(orderBatch),
        }
      );
    },

    /**
     * Cancel an open order by ID
     * Costs 1 Cancel Token
     */
    async cancelOrder(orderId) {
      await cancelBucket.acquire(1);

      const headers = {
        'Content-Type': 'application/json',
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };

      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/order`,
        `${CLOB_BASE_URL}/order`,
        {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ orderID: orderId }),
        }
      );
    },

    /**
     * Cancel all open orders for the signer
     * Costs 1 token + number of canceled orders
     */
    async cancelAllOrders() {
      await cancelBucket.acquire(1);

      const headers = {
        'Content-Type': 'application/json',
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };

      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/cancel-all`,
        `${CLOB_BASE_URL}/cancel-all`,
        {
          method: 'DELETE',
          headers,
        }
      );
    },

    /**
     * Cancel all open orders for a specific market
     */
    async cancelMarketOrders(marketId) {
      await cancelBucket.acquire(1);

      const headers = {
        'Content-Type': 'application/json',
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };

      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/cancel-market-orders`,
        `${CLOB_BASE_URL}/cancel-market-orders`,
        {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ market: marketId }),
        }
      );
    },

    async getOpenOrders(market) {
      const qs = market ? `?market=${encodeURIComponent(market)}` : '';
      const headers = {
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/data/orders${qs}`,
        `${CLOB_BASE_URL}/data/orders${qs}`,
        { headers }
      );
    },

    /** GET /data/order/{orderID} — fetch a single order by hash */
    async getOrder(orderId) {
      if (!orderId) return null;
      const headers = {
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/data/order/${encodeURIComponent(orderId)}`,
        `${CLOB_BASE_URL}/data/order/${encodeURIComponent(orderId)}`,
        { headers }
      );
    },

    /** GET /data/orders — paginated user orders with optional filters */
    async getUserOrders(params = {}) {
      const qp = {};
      if (params.id)          qp.id          = params.id;
      if (params.market)      qp.market      = params.market;
      if (params.asset_id)    qp.asset_id    = params.asset_id;
      if (params.next_cursor) qp.next_cursor = params.next_cursor;
      const qs = Object.keys(qp).length
        ? `?${new URLSearchParams(qp).toString()}`
        : '';
      const headers = {
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/data/orders${qs}`,
        `${CLOB_BASE_URL}/data/orders${qs}`,
        { headers }
      );
    },

    /** GET /order-scoring — check if an order is scoring for maker rewards */
    async getOrderScoringStatus(orderId) {
      if (!orderId) return null;
      const qs = `?order_id=${encodeURIComponent(orderId)}`;
      const headers = {
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/order-scoring${qs}`,
        `${CLOB_BASE_URL}/order-scoring${qs}`,
        { headers }
      );
    },

    /** POST /heartbeats — keep-alive to prevent auto-cancel of open orders */
    async sendHeartbeat() {
      const headers = {
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/heartbeats`,
        `${CLOB_BASE_URL}/heartbeats`,
        { method: 'POST', headers }
      );
    },


    /** GET /positions — full Data API spec with all filter/sort params */
    async getPositions(params = {}) {
      const userAddress = typeof params === 'string' ? params : (params.user || CREDENTIALS.address);
      if (!userAddress) return [];
      const qp = { user: userAddress };
      if (params.market)         qp.market         = Array.isArray(params.market) ? params.market.join(',') : params.market;
      if (params.eventId)        qp.eventId        = Array.isArray(params.eventId) ? params.eventId.join(',') : params.eventId;
      if (params.sizeThreshold !== undefined) qp.sizeThreshold = String(params.sizeThreshold);
      if (params.redeemable !== undefined)    qp.redeemable    = String(params.redeemable);
      if (params.mergeable !== undefined)     qp.mergeable     = String(params.mergeable);
      if (params.includeArchived !== undefined) qp.includeArchived = String(params.includeArchived);
      if (params.limit !== undefined)         qp.limit         = String(params.limit);
      if (params.offset !== undefined)        qp.offset        = String(params.offset);
      if (params.sortBy)         qp.sortBy         = params.sortBy;
      if (params.sortDirection)  qp.sortDirection  = params.sortDirection;
      if (params.title)          qp.title          = params.title;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/positions?${qs}`,
        `${DATA_BASE_URL}/positions?${qs}`
      );
    },

    /** GET /closed-positions — Data API closed/resolved position history */
    async getClosedPositions(params = {}) {
      const userAddress = typeof params === 'string' ? params : (params.user || CREDENTIALS.address);
      if (!userAddress) return [];
      const qp = { user: userAddress };
      if (params.market)        qp.market        = Array.isArray(params.market) ? params.market.join(',') : params.market;
      if (params.eventId)       qp.eventId       = Array.isArray(params.eventId) ? params.eventId.join(',') : params.eventId;
      if (params.title)         qp.title         = params.title;
      if (params.limit !== undefined)  qp.limit  = String(params.limit);
      if (params.offset !== undefined) qp.offset = String(params.offset);
      if (params.sortBy)        qp.sortBy        = params.sortBy;
      if (params.sortDirection) qp.sortDirection = params.sortDirection;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/closed-positions?${qs}`,
        `${DATA_BASE_URL}/closed-positions?${qs}`
      );
    },

    /** GET /data/trades — paginated trades with full filter support */
    async getTrades(params = {}) {
      const makerAddress = params.maker_address || CREDENTIALS.address;
      const qp = {};
      if (makerAddress)       qp.maker_address = makerAddress;
      if (params.id)          qp.id            = params.id;
      if (params.market)      qp.market        = params.market;
      if (params.asset_id)    qp.asset_id      = params.asset_id;
      if (params.before)      qp.before        = String(params.before);
      if (params.after)       qp.after         = String(params.after);
      if (params.next_cursor) qp.next_cursor   = params.next_cursor;
      const qs = new URLSearchParams(qp).toString();
      const headers = {
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/data/trades${qs ? `?${qs}` : ''}`,
        `${CLOB_BASE_URL}/data/trades${qs ? `?${qs}` : ''}`,
        { headers }
      );
    },

    /** GET /builder/trades — trades attributed to a builder code */
    async getBuilderTrades(params = {}) {
      if (!params.builder_code) throw new Error('builder_code is required');
      const qp = { builder_code: params.builder_code };
      if (params.id)          qp.id          = params.id;
      if (params.market)      qp.market      = params.market;
      if (params.asset_id)    qp.asset_id    = params.asset_id;
      if (params.before)      qp.before      = String(params.before);
      if (params.after)       qp.after       = String(params.after);
      if (params.next_cursor) qp.next_cursor = params.next_cursor;
      const qs = new URLSearchParams(qp).toString();
      const headers = {
        'POLY_API_KEY': CREDENTIALS.apiKey,
        'POLY_PASSPHRASE': CREDENTIALS.passphrase,
      };
      return _fetchWithFallback(
        `${PROXY_CLOB_URL}/builder/trades?${qs}`,
        `${CLOB_BASE_URL}/builder/trades?${qs}`,
        { headers }
      );
    },


    /** GET /activity — full Data API spec with all filter, pagination, and sort params */
    async getActivity(params = {}) {
      const userAddress = typeof params === 'string' ? params : (params.user || CREDENTIALS.address);
      if (!userAddress) return [];
      const qp = { user: userAddress };
      if (params.market)    qp.market  = Array.isArray(params.market)  ? params.market.join(',')  : params.market;
      if (params.eventId)   qp.eventId = Array.isArray(params.eventId) ? params.eventId.join(',') : params.eventId;
      if (params.type)      qp.type    = Array.isArray(params.type)    ? params.type.join(',')    : params.type;
      if (params.excludeDepositsWithdrawals !== undefined) qp.excludeDepositsWithdrawals = String(params.excludeDepositsWithdrawals);
      if (params.start  !== undefined) qp.start  = String(params.start);
      if (params.end    !== undefined) qp.end    = String(params.end);
      if (params.limit  !== undefined) qp.limit  = String(params.limit);
      if (params.offset !== undefined) qp.offset = String(params.offset);
      if (params.sortBy)        qp.sortBy        = params.sortBy;
      if (params.sortDirection) qp.sortDirection = params.sortDirection;
      if (params.side)          qp.side          = params.side;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/activity?${qs}`,
        `${DATA_BASE_URL}/activity?${qs}`
      );
    },

    /** GET /value — total current value of a user's positions */
    async getUserValue(params = {}) {
      const userAddress = typeof params === 'string' ? params : (params.user || CREDENTIALS.address);
      if (!userAddress) return null;
      const qp = { user: userAddress };
      if (params.market) qp.market = Array.isArray(params.market) ? params.market.join(',') : params.market;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/value?${qs}`,
        `${DATA_BASE_URL}/value?${qs}`
      );
    },

    /** GET /trades — Data API public trades by user or market with full filter support */
    async getDataTrades(params = {}) {
      const qp = {};
      if (params.user)         qp.user         = params.user;
      if (params.market)       qp.market        = Array.isArray(params.market)  ? params.market.join(',')  : params.market;
      if (params.eventId)      qp.eventId       = Array.isArray(params.eventId) ? params.eventId.join(',') : params.eventId;
      if (params.side)         qp.side          = params.side;
      if (params.takerOnly !== undefined) qp.takerOnly = String(params.takerOnly);
      if (params.filterType)   qp.filterType    = params.filterType;
      if (params.filterAmount !== undefined) qp.filterAmount = String(params.filterAmount);
      if (params.start !== undefined) qp.start  = String(params.start);
      if (params.end   !== undefined) qp.end    = String(params.end);
      if (params.limit  !== undefined) qp.limit = String(params.limit);
      if (params.offset !== undefined) qp.offset = String(params.offset);
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/trades${qs ? `?${qs}` : ''}`,
        `${DATA_BASE_URL}/trades${qs ? `?${qs}` : ''}`
      );
    },

    /** GET /traded — total number of markets a user has traded */
    async getUserTraded(userAddress) {
      const addr = userAddress || CREDENTIALS.address;
      if (!addr) return null;
      const qs = `user=${encodeURIComponent(addr)}`;
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/traded?${qs}`,
        `${DATA_BASE_URL}/traded?${qs}`
      );
    },

    /** GET /v1/market-positions — all holder positions for a single market */
    async getMarketPositions(params = {}) {
      if (!params.market) throw new Error('market (conditionId) is required');
      const qp = { market: params.market };
      if (params.user)          qp.user          = params.user;
      if (params.status)        qp.status        = params.status;
      if (params.sortBy)        qp.sortBy        = params.sortBy;
      if (params.sortDirection) qp.sortDirection = params.sortDirection;
      if (params.limit  !== undefined) qp.limit  = String(params.limit);
      if (params.offset !== undefined) qp.offset = String(params.offset);
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/v1/market-positions?${qs}`,
        `${DATA_BASE_URL}/v1/market-positions?${qs}`
      );
    },

    /** GET /v1/accounting/snapshot — download ZIP of positions.csv + equity.csv for a user.
     *  Returns raw Response so the caller can handle the binary blob. */
    async getAccountingSnapshot(userAddress) {
      const addr = userAddress || CREDENTIALS.address;
      if (!addr) return null;
      const qs = `user=${encodeURIComponent(addr)}`;
      // Return the raw fetch response so the caller can .blob() / .arrayBuffer() as needed
      const proxyUrl  = `${PROXY_DATA_URL}/v1/accounting/snapshot?${qs}`;
      const directUrl = `${DATA_BASE_URL}/v1/accounting/snapshot?${qs}`;
      try {
        const r = await fetch(proxyUrl);
        if (r.ok) return r;
        const r2 = await fetch(directUrl);
        return r2;
      } catch (_) {
        return fetch(directUrl);
      }
    },

    /** GET /v1/leaderboard — trader PnL / volume rankings with full filter support */
    async getLeaderboard(params = {}) {
      const qp = {};
      if (params.category)   qp.category   = params.category;
      if (params.timePeriod) qp.timePeriod = params.timePeriod;
      if (params.orderBy)    qp.orderBy    = params.orderBy;
      if (params.limit  !== undefined) qp.limit  = String(params.limit);
      if (params.offset !== undefined) qp.offset = String(params.offset);
      if (params.user)     qp.user     = params.user;
      if (params.userName) qp.userName = params.userName;
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/v1/leaderboard${qs ? `?${qs}` : ''}`,
        `${DATA_BASE_URL}/v1/leaderboard${qs ? `?${qs}` : ''}`
      );
    },

    /** GET /v1/builders/leaderboard — builder volume/active-user rankings */
    async getBuilderLeaderboard(params = {}) {
      const qp = {};
      if (params.timePeriod) qp.timePeriod = params.timePeriod;
      if (params.limit  !== undefined) qp.limit  = String(params.limit);
      if (params.offset !== undefined) qp.offset = String(params.offset);
      const qs = new URLSearchParams(qp).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/v1/builders/leaderboard${qs ? `?${qs}` : ''}`,
        `${DATA_BASE_URL}/v1/builders/leaderboard${qs ? `?${qs}` : ''}`
      );
    },

    /** GET /v1/builders/volume — daily builder volume time-series */
    async getBuilderVolume(timePeriod) {
      const qs = timePeriod ? `?timePeriod=${encodeURIComponent(timePeriod)}` : '';
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/v1/builders/volume${qs}`,
        `${DATA_BASE_URL}/v1/builders/volume${qs}`
      );
    },

    async getTopHolders(markets, options = {}) {

      const marketList = Array.isArray(markets) ? markets.join(',') : String(markets || '');
      if (!marketList) return [];
      const qs = new URLSearchParams({
        market: marketList,
        limit: String(options.limit || 20),
        minBalance: String(options.minBalance || 1),
      }).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/holders?${qs}`,
        `${DATA_BASE_URL}/holders?${qs}`
      );
    },

    async getOpenInterest(markets) {
      const marketList = Array.isArray(markets) ? markets.join(',') : String(markets || '');
      if (!marketList) return [];
      const qs = new URLSearchParams({ market: marketList }).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/oi?${qs}`,
        `${DATA_BASE_URL}/oi?${qs}`
      );
    },

    async getLiveVolume(eventId) {
      if (!eventId) return [];
      const qs = new URLSearchParams({ id: String(eventId) }).toString();
      return _fetchWithFallback(
        `${PROXY_DATA_URL}/live-volume?${qs}`,
        `${DATA_BASE_URL}/live-volume?${qs}`
      );
    },

    // ── 5. Relayer API v2 (Gasless Transactions) ─────────────────────────────
    async submitRelayerTransaction(submitPayload) {
      const headers = {
        'Content-Type': 'application/json',
        'RELAYER_API_KEY': CREDENTIALS.relayerApiKey,
        'RELAYER_API_KEY_ADDRESS': CREDENTIALS.relayerAddress,
        'POLY_BUILDER_API_KEY': CREDENTIALS.builderKey,
      };

      const body = JSON.stringify(submitPayload);

      try {
        const res = await fetch(`${PROXY_RELAYER_URL}/submit`, { method: 'POST', headers, body });
        if (res.ok) return await res.json();
      } catch (_) {}

      const res = await fetch(`${RELAYER_BASE_URL}/submit`, { method: 'POST', headers, body });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Relayer submit error (${res.status}): ${errText}`);
      }
      return res.json();
    },

    async getRelayerTransaction(transactionID) {
      if (!transactionID) return null;
      const headers = {
        'RELAYER_API_KEY': CREDENTIALS.relayerApiKey,
        'RELAYER_API_KEY_ADDRESS': CREDENTIALS.relayerAddress,
      };

      try {
        const res = await fetch(`${PROXY_RELAYER_URL}/transaction?id=${encodeURIComponent(transactionID)}`, { headers });
        if (res.ok) return await res.json();
      } catch (_) {}

      const res = await fetch(`${RELAYER_BASE_URL}/transaction?id=${encodeURIComponent(transactionID)}`, { headers });
      if (!res.ok) throw new Error(`Relayer status error (${res.status})`);
      return res.json();
    },

    // ── 6. Bridge API (Deposits & Withdrawals) ───────────────────────────────
    async getDepositAddress(userAddress = CREDENTIALS.address) {
      if (!userAddress) return null;
      return _fetchWithFallback(
        `${PROXY_BRIDGE_URL}/deposit-address?address=${encodeURIComponent(userAddress)}`,
        `${BRIDGE_BASE_URL}/deposit-address?address=${encodeURIComponent(userAddress)}`
      );
    },

    async getSupportedBridgeAssets() {
      return _fetchWithFallback(
        `${PROXY_BRIDGE_URL}/supported-assets`,
        `${BRIDGE_BASE_URL}/supported-assets`
      );
    },

    // ── 7. Polygon RPC Execution ─────────────────────────────────────────────
    async rpcCall(method, params = []) {
      const res = await fetch(POLYGON_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    },

    // ── 8. Geoblock & Compliance Verification ────────────────────────────────
    /**
     * Check geographic eligibility for order placement
     * @returns {Promise<{ blocked: boolean, ip: string, country: string, region: string, status: 'UNRESTRICTED'|'CLOSE_ONLY'|'BLOCKED_COMPLETELY' }>}
     */
    async checkGeoblock() {
      const PROXY_GEO_URL = `${PROXY_ORIGIN}/polymarket-geo/geoblock`;
      const DIRECT_GEO_URL = 'https://polymarket.com/api/geoblock';

      let geo = null;
      try {
        const res = await fetch(PROXY_GEO_URL);
        if (res.ok) geo = await res.json();
      } catch (_) {}

      if (!geo) {
        try {
          const res = await fetch(DIRECT_GEO_URL);
          if (res.ok) geo = await res.json();
        } catch (_) {}
      }

      if (!geo) {
        return {
          blocked: false,
          ip: 'unknown',
          country: 'US',
          region: '',
          status: 'UNRESTRICTED',
          warning: 'Geoblock API unreachable, fallback to simulation mode',
        };
      }

      const country = String(geo.country || '').toUpperCase();
      const region = String(geo.region || '').toUpperCase();
      const subCode = region ? `${country}-${region}` : country;

      // OFAC-Sanctioned (Block Completely)
      const OFAC_BLOCKED = ['IR', 'SY', 'CU', 'KP', 'UA-43', 'UA-14', 'UA-09'];
      // Regulatory-Restricted (Close-Only)
      const REGULATORY_CLOSE_ONLY = [
        'AU', 'BY', 'BE', 'BI', 'BR', 'CA-BC', 'CA-ON', 'CA-AB', 'CA-QC',
        'CF', 'CD', 'ET', 'FR', 'DE', 'IQ', 'IT', 'LB', 'LY', 'MM', 'NI',
        'PL', 'RU', 'SG', 'SO', 'SK', 'SS', 'SD', 'TW', 'TH', 'GB', 'US',
        'UM', 'VE', 'YE', 'ZW', 'IE', 'JP', 'MT', 'NL'
      ];

      let status = 'UNRESTRICTED';
      if (OFAC_BLOCKED.includes(country) || OFAC_BLOCKED.includes(subCode)) {
        status = 'BLOCKED_COMPLETELY';
      } else if (REGULATORY_CLOSE_ONLY.includes(country) || REGULATORY_CLOSE_ONLY.includes(subCode) || geo.blocked) {
        status = 'CLOSE_ONLY';
      }

      return {
        ...geo,
        status,
        canOpenPositions: status === 'UNRESTRICTED',
        canClosePositions: status !== 'BLOCKED_COMPLETELY',
      };
    },

    // ── Rate Limit Status Inspector ──────────────────────────────────────────
    getRateLimitStatus() {
      orderBucket.refill();
      cancelBucket.refill();
      return {
        order: {
          tokens: Math.round(orderBucket.tokens * 10) / 10,
          burstCapacity: orderBucket.burst,
          refillRate: orderBucket.rate,
          tier: orderBucket.currentTier,
        },
        cancel: {
          tokens: Math.round(cancelBucket.tokens * 10) / 10,
          burstCapacity: cancelBucket.burst,
          refillRate: cancelBucket.rate,
          tier: cancelBucket.currentTier,
        },
      };
    },
  };

  window.PolymarketClient = PolymarketClient;
  console.info('[WE] PolymarketClient v4.0 live: Complete Predictions, CLOB, Geoblock & Compliance Suite ✓');

  // ─── Relayer v2 ─────────────────────────────────────────────────────────────
  // Uses RELAYER_BASE_URL / PROXY_RELAYER_URL defined at top of IIFE
  const PROXY_RELAYER_URL_ALT = '/api/relayer';

  /** Build Relayer auth headers from an { builderApiKey, … } or { relayerApiKey, … } object. */
  function _relayerHeaders(auth = {}, extra = {}) {
    const h = { ...extra };
    if (auth.builderApiKey)        h['POLY_BUILDER_API_KEY']    = auth.builderApiKey;
    if (auth.builderTimestamp)     h['POLY_BUILDER_TIMESTAMP']  = auth.builderTimestamp;
    if (auth.builderPassphrase)    h['POLY_BUILDER_PASSPHRASE'] = auth.builderPassphrase;
    if (auth.builderSignature)     h['POLY_BUILDER_SIGNATURE']  = auth.builderSignature;
    if (auth.relayerApiKey)        h['RELAYER_API_KEY']         = auth.relayerApiKey;
    if (auth.relayerApiKeyAddress) h['RELAYER_API_KEY_ADDRESS'] = auth.relayerApiKeyAddress;
    return h;
  }

  /** Generic fallback fetch helper for the Relayer. */
  async function _relayerFetch(path, options = {}) {
    const tryFetch = (base) => fetch(`${base}${path}`, options).then(async (r) => {
      if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw e; }
      return r.json();
    });
    try { return await tryFetch(PROXY_RELAYER_URL); }
    catch (_) {
      try { return await tryFetch(PROXY_RELAYER_URL_ALT); }
      catch (__) { return tryFetch(RELAYER_BASE_URL); }
    }
  }

  /**
   * POST /submit — Submit a gasless transaction to the Relayer.
   * Returns { transactionID, state: 'STATE_NEW' } immediately.
   * Poll relayerGetTransaction(id) for the onchain hash.
   *
   * @param {object} body   SubmitRequest (from, to, proxyWallet, data, nonce, signature, signatureParams, type)
   * @param {object} auth   Builder or Relayer API key credentials
   */
  PolymarketClient.relayerSubmit = (body, auth = {}) =>
    _relayerFetch('/submit', {
      method: 'POST',
      headers: _relayerHeaders(auth, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });

  /**
   * GET /transaction?id= — Poll for a submitted transaction by its ID.
   * Returns RelayerTransaction[] once the tx is broadcast.
   *
   * @param {string} transactionID  UUID from relayerSubmit
   */
  PolymarketClient.relayerGetTransaction = (transactionID) => {
    if (!transactionID) throw new Error('transactionID is required');
    return _relayerFetch(`/transaction?id=${encodeURIComponent(transactionID)}`);
  };

  /**
   * GET /transactions — Get recent transactions for the authenticated user.
   * Requires Builder or Relayer API key auth.
   *
   * @param {object} auth  Builder or Relayer API key credentials
   */
  PolymarketClient.relayerGetTransactions = (auth = {}) =>
    _relayerFetch('/transactions', { headers: _relayerHeaders(auth) });

  /**
   * GET /nonce?address=&type= — Get the current Safe or Proxy nonce for a signer.
   *
   * @param {string} address  0x-prefixed signer address
   * @param {'PROXY'|'SAFE'} type
   */
  PolymarketClient.relayerGetNonce = (address, type) => {
    if (!address) throw new Error('address is required');
    if (!type)    throw new Error('type is required (PROXY or SAFE)');
    return _relayerFetch(`/nonce?address=${encodeURIComponent(address)}&type=${encodeURIComponent(type)}`);
  };

  /**
   * GET /relay-payload?address=&type= — Get the relayer address and current nonce for a signer.
   * Returns { address: relayerAddress, nonce } which is needed to construct the Safe/Proxy tx payload.
   *
   * @param {string} address  0x-prefixed signer address
   * @param {'PROXY'|'SAFE'} type
   */
  PolymarketClient.relayerGetRelayPayload = (address, type) => {
    if (!address) throw new Error('address is required');
    if (!type)    throw new Error('type is required (PROXY or SAFE)');
    return _relayerFetch(`/relay-payload?address=${encodeURIComponent(address)}&type=${encodeURIComponent(type)}`);
  };

  /**
   * GET /relayer/api/keys — List all Relayer API keys for the authenticated address.
   * Auth: Gamma session OR { relayerApiKey + relayerApiKeyAddress }.
   *
   * @param {object} auth  { relayerApiKey, relayerApiKeyAddress } or Gamma cookie (no extra headers)
   */
  PolymarketClient.relayerGetApiKeys = (auth = {}) =>
    _relayerFetch('/relayer/api/keys', { headers: _relayerHeaders(auth) });

  /**
   * GET /deployed?address=&type= — Check if a Polymarket wallet (Safe or Deposit Wallet) is deployed onchain.
   *
   * @param {string} address  0x-prefixed wallet address to check
   * @param {'SAFE'|'WALLET'} [type='SAFE']  Wallet type; defaults to SAFE
   * @returns {Promise<{ deployed: boolean }>}
   */
  PolymarketClient.relayerCheckDeployed = (address, type = 'SAFE') => {
    if (!address) throw new Error('address is required');
    return _relayerFetch(`/deployed?address=${encodeURIComponent(address)}&type=${encodeURIComponent(type)}`);
  };

  // ─── Combinatorial RFQ API ──────────────────────────────────────────────────
  const COMBOS_RFQ_BASE_URL  = 'https://combos-rfq-api.polymarket.com';
  const PROXY_COMBOS_RFQ_URL = '/api/combos-rfq';

  async function _combosRfqFetch(path, options = {}) {
    const tryFetch = (base) => fetch(`${base}${path}`, options).then(async (r) => {
      if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw e; }
      return r.json();
    });
    try { return await tryFetch(PROXY_COMBOS_RFQ_URL); }
    catch (_) { return tryFetch(COMBOS_RFQ_BASE_URL); }
  }

  /**
   * GET /v1/rfq/combo-markets — Public catalog of markets usable as combo legs.
   * Ordered by volume descending. Keyset-paginated via `next_cursor`.
   *
   * @param {object} [params]
   * @param {number} [params.limit=50]    Page size (1–100)
   * @param {string} [params.cursor]      Opaque cursor from previous `next_cursor`
   * @param {string} [params.exclude]     Comma-separated condition IDs to omit
   * @returns {Promise<{ markets: ComboMarket[], next_cursor: string|null }>}
   */
  PolymarketClient.getComboMarkets = (params = {}) => {
    const qp = {};
    if (params.limit   !== undefined) qp.limit  = String(params.limit);
    if (params.cursor)                qp.cursor = params.cursor;
    if (params.exclude)               qp.exclude = params.exclude;
    const qs = new URLSearchParams(qp).toString();
    return _combosRfqFetch(`/v1/rfq/combo-markets${qs ? `?${qs}` : ''}`);
  };

  /**
   * POST /v1/maker/quotes — Submit a signed maker quote for an active RFQ.
   * Requires CLOB L2 authentication (POLY_API_KEY, POLY_ADDRESS, POLY_SIGNATURE,
   * POLY_PASSPHRASE, POLY_TIMESTAMP).
   *
   * Generate `quote_id` client-side (e.g. `quote_${crypto.randomUUID()}`).
   *
   * @param {object} quote      Full Quote payload (see OpenAPI schema)
   * @param {object} clobAuth   { apiKey, address, signature, passphrase, timestamp }
   * @returns {Promise<RFQSnapshot>}
   */
  PolymarketClient.submitMakerQuote = (quote, clobAuth = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (clobAuth.apiKey)      headers['POLY_API_KEY']    = clobAuth.apiKey;
    if (clobAuth.address)     headers['POLY_ADDRESS']    = clobAuth.address;
    if (clobAuth.signature)   headers['POLY_SIGNATURE']  = clobAuth.signature;
    if (clobAuth.passphrase)  headers['POLY_PASSPHRASE'] = clobAuth.passphrase;
    if (clobAuth.timestamp)   headers['POLY_TIMESTAMP']  = clobAuth.timestamp;
    return _combosRfqFetch('/v1/maker/quotes', {
      method: 'POST',
      headers,
      body: JSON.stringify(quote),
    });
  };

  /**
   * POST /v1/maker/confirmations — Respond to a last-look confirmation (CONFIRM or DECLINE).
   * Requires CLOB L2 auth. Returns { snapshot?, execution? }.
   *
   * @param {object} confirmation  MakerConfirmationRequest payload
   * @param {object} clobAuth      { apiKey, address, signature, passphrase, timestamp }
   * @returns {Promise<MakerConfirmationResult>}
   */
  PolymarketClient.submitMakerConfirmation = (confirmation, clobAuth = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (clobAuth.apiKey)      headers['POLY_API_KEY']    = clobAuth.apiKey;
    if (clobAuth.address)     headers['POLY_ADDRESS']    = clobAuth.address;
    if (clobAuth.signature)   headers['POLY_SIGNATURE']  = clobAuth.signature;
    if (clobAuth.passphrase)  headers['POLY_PASSPHRASE'] = clobAuth.passphrase;
    if (clobAuth.timestamp)   headers['POLY_TIMESTAMP']  = clobAuth.timestamp;
    return _combosRfqFetch('/v1/maker/confirmations', {
      method: 'POST',
      headers,
      body: JSON.stringify(confirmation),
    });
  };

  // ─── Polymarket Data API ────────────────────────────────────────────────────
  // Uses DATA_BASE_URL / PROXY_DATA_URL from top of IIFE; optional /api/data path for app proxy
  const PROXY_DATA_URL_ALT = '/api/data';

  async function _dataApiFetch(path, options = {}) {
    const tryFetch = (base) => fetch(`${base}${path}`, options).then(async (r) => {
      if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw e; }
      return r.json();
    });
    try { return await tryFetch(PROXY_DATA_URL); }
    catch (_) {
      try { return await tryFetch(PROXY_DATA_URL_ALT); }
      catch (__) { return tryFetch(DATA_BASE_URL); }
    }
  }

  /**
   * GET /v1/positions/combos — Combinatorial positions held by a user, with per-leg breakdown.
   * Open positions with shares_balance < 0.001 are omitted (dust floor).
   *
   * @param {object} params
   * @param {string}   params.user           Required: 0x wallet address
   * @param {string[]} [params.status]       Filter: OPEN | PARTIAL | RESOLVED_PARTIAL | RESOLVED_WIN | RESOLVED_LOSS
   * @param {string}   [params.sort]         current_value_desc | first_entry_desc | entry_cost_desc | resolved_at_desc | updated_asc
   * @param {string[]} [params.market_id]    Comma-separated combo_condition_id values
   * @param {number}   [params.limit=20]     0–1000
   * @param {number}   [params.offset=0]     0–100000
   * @param {number}   [params.updatedAfter] Epoch seconds (inclusive watermark)
   * @param {number}   [params.updatedBefore] Epoch seconds (inclusive upper bound)
   * @param {string}   [params.cursor]       Opaque cursor from pagination.next_cursor
   */
  PolymarketClient.getUserComboPositions = (params = {}) => {
    if (!params.user) throw new Error('user address is required');
    const qp = { user: params.user };
    if (params.status)        qp.status        = Array.isArray(params.status) ? params.status.join(',') : params.status;
    if (params.sort)          qp.sort          = params.sort;
    if (params.market_id)     qp.market_id     = Array.isArray(params.market_id) ? params.market_id.join(',') : params.market_id;
    if (params.limit   !== undefined) qp.limit  = String(params.limit);
    if (params.offset  !== undefined) qp.offset = String(params.offset);
    if (params.updatedAfter  !== undefined) qp.updatedAfter  = String(params.updatedAfter);
    if (params.updatedBefore !== undefined) qp.updatedBefore = String(params.updatedBefore);
    if (params.cursor)        qp.cursor        = params.cursor;
    const qs = new URLSearchParams(qp).toString();
    return _dataApiFetch(`/v1/positions/combos?${qs}`);
  };

  /**
   * GET /v1/activity/combos — Combo lifecycle & redeem events for a user (split/merge/convert/…/redeem).
   *
   * @param {object} params
   * @param {string}   params.user        Required: 0x wallet address
   * @param {string[]} [params.market_id] Comma-separated combo_condition_id values
   * @param {number}   [params.limit=50]  0–500
   * @param {number}   [params.offset=0]  0–10000
   * @param {string}   [params.cursor]    Opaque cursor from pagination.next_cursor
   */
  PolymarketClient.getUserComboActivity = (params = {}) => {
    if (!params.user) throw new Error('user address is required');
    const qp = { user: params.user };
    if (params.market_id) qp.market_id = Array.isArray(params.market_id) ? params.market_id.join(',') : params.market_id;
    if (params.limit  !== undefined) qp.limit  = String(params.limit);
    if (params.offset !== undefined) qp.offset = String(params.offset);
    if (params.cursor)               qp.cursor = params.cursor;
    const qs = new URLSearchParams(qp).toString();
    return _dataApiFetch(`/v1/activity/combos?${qs}`);
  };

  // ─── Bridge API ─────────────────────────────────────────────────────────────
  // Uses BRIDGE_BASE_URL defined at top of IIFE

  async function _bridgeFetch(path, options = {}) {
    const r = await fetch(`${BRIDGE_BASE_URL}${path}`, options);
    if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw e; }
    return r.json();
  }

  /**
   * GET /supported-assets — List assets supported for bridge deposits/withdrawals,
   * with per-chain minCheckoutUsd amounts.
   * @returns {Promise<{supportedAssets: SupportedAsset[]}>}
   */
  PolymarketClient.bridgeSupportedAssets = () => _bridgeFetch('/supported-assets');

  /**
   * POST /deposit — Create per-chain bridge deposit addresses for a Polymarket wallet.
   *
   * @param {string} address       0x-prefixed Polymarket wallet address (required)
   * @param {string} [builderCode] Optional bytes32 hex builder attribution code
   * @returns {Promise<DepositResponse>}  { address: { evm, svm, btc, tron }, note }
   */
  PolymarketClient.bridgeCreateDeposit = (address, builderCode) => {
    if (!address) throw new Error('address is required');
    const headers = { 'Content-Type': 'application/json' };
    if (builderCode) headers['X-Builder-Code'] = builderCode;
    return _bridgeFetch('/deposit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ address }),
    });
  };

  /**
   * POST /quote — Get a cross-chain swap quote before bridging.
   *
   * @param {object} params
   * @param {string} params.fromAmountBaseUnit  Amount in token base units (e.g. '10000000')
   * @param {string} params.fromChainId         Source chain ID (e.g. '137')
   * @param {string} params.fromTokenAddress    Source token contract address
   * @param {string} params.recipientAddress    Recipient wallet address
   * @param {string} params.toChainId           Destination chain ID
   * @param {string} params.toTokenAddress      Destination token contract address
   * @returns {Promise<QuoteResponse>}  { quoteId, estInputUsd, estOutputUsd, estToTokenBaseUnit, estCheckoutTimeMs, estFeeBreakdown }
   */
  PolymarketClient.bridgeGetQuote = (params = {}) => {
    const required = ['fromAmountBaseUnit','fromChainId','fromTokenAddress','recipientAddress','toChainId','toTokenAddress'];
    for (const k of required) if (!params[k]) throw new Error(`${k} is required`);
    return _bridgeFetch('/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  };

  /**
   * GET /status/{address} — Cursor-paginated list of deposits & withdrawals for a bridge address.
   * Poll the first page (no cursor) to track recent activity, or walk nextCursor until null
   * to read full history.
   *
   * @param {string}  bridgeAddress  EVM / Solana / Tron / BTC bridge address from /deposit or /withdraw
   * @param {object}  [opts]
   * @param {number}  [opts.limit=50]    1–100 transactions per page
   * @param {string}  [opts.cursor]      Opaque nextCursor from previous response (URL-encode before use)
   * @returns {Promise<{transactions: Transaction[], nextCursor: string|null}>}
   */
  PolymarketClient.bridgeGetTransactionStatus = (bridgeAddress, opts = {}) => {
    if (!bridgeAddress) throw new Error('bridgeAddress is required');
    const qp = {};
    if (opts.limit  !== undefined) qp.limit  = String(opts.limit);
    if (opts.cursor)               qp.cursor = opts.cursor;
    const qs = Object.keys(qp).length ? `?${new URLSearchParams(qp)}` : '';
    return _bridgeFetch(`/status/${encodeURIComponent(bridgeAddress)}${qs}`);
  };

  /**
   * POST /withdraw — Create per-chain bridge withdrawal addresses (pUSD → external chain/token).
   *
   * @param {object} params
   * @param {string} params.address          Source Polymarket wallet (0x on Polygon)
   * @param {string} params.toChainId        Destination chain ID ('1', '8453', '1151111081099710', …)
   * @param {string} params.toTokenAddress   Destination token contract address
   * @param {string} params.recipientAddr    Recipient wallet on the destination chain
   * @param {string} [builderCode]           Optional bytes32 hex X-Builder-Code header
   * @returns {Promise<DepositResponse>}  { address: { evm, svm, btc, tron }, note }
   */
  PolymarketClient.bridgeCreateWithdrawal = (params = {}, builderCode) => {
    const required = ['address','toChainId','toTokenAddress','recipientAddr'];
    for (const k of required) if (!params[k]) throw new Error(`${k} is required`);
    const headers = { 'Content-Type': 'application/json' };
    if (builderCode) headers['X-Builder-Code'] = builderCode;
    return _bridgeFetch('/withdraw', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
  };


  // ─── WebSocket Channel Managers ─────────────────────────────────────────────
  /**
   * Creates and manages the public Market channel WebSocket.
   * wss://ws-subscriptions-clob.polymarket.com/ws/market
   *
   * @param {string[]} assetIds       Token IDs to subscribe to
   * @param {object}   handlers       { onBook, onPriceChange, onLastTrade, onTickSize,
   *                                    onBestBidAsk, onNewMarket, onMarketResolved,
   *                                    onError, onOpen, onClose }
   * @param {object}   [opts]
   * @param {boolean}  [opts.initialDump=true]
   * @param {number}   [opts.level=2]           1 | 2 | 3
   * @param {boolean}  [opts.customFeatures=false]
   * @returns {{ send, subscribe, unsubscribe, close, ws }}
   */
  PolymarketClient.createMarketWS = (assetIds = [], handlers = {}, opts = {}) => {
    const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    const ws = new WebSocket(WS_URL);
    let pingInterval = null;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'market',
        assets_ids: assetIds,
        initial_dump: opts.initialDump !== false,
        level: opts.level ?? 2,
        custom_feature_enabled: opts.customFeatures ?? false,
      }));
      pingInterval = setInterval(() => { if (ws.readyState === 1) ws.send('PING'); }, 10000);
      handlers.onOpen?.();
    };

    ws.onmessage = ({ data }) => {
      if (data === 'PONG') return;
      let msg; try { msg = JSON.parse(data); } catch { return; }
      switch (msg.event_type) {
        case 'book':              return handlers.onBook?.(msg);
        case 'price_change':      return handlers.onPriceChange?.(msg);
        case 'last_trade_price':  return handlers.onLastTrade?.(msg);
        case 'tick_size_change':  return handlers.onTickSize?.(msg);
        case 'best_bid_ask':      return handlers.onBestBidAsk?.(msg);
        case 'new_market':        return handlers.onNewMarket?.(msg);
        case 'market_resolved':   return handlers.onMarketResolved?.(msg);
      }
    };

    ws.onerror = (e) => handlers.onError?.(e);
    ws.onclose = (e) => { clearInterval(pingInterval); handlers.onClose?.(e); };

    const api = {
      ws,
      send: (payload) => ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload)),
      subscribe: (ids, level) => ws.send(JSON.stringify({ operation: 'subscribe', assets_ids: ids, ...(level ? { level } : {}) })),
      unsubscribe: (ids) => ws.send(JSON.stringify({ operation: 'unsubscribe', assets_ids: ids })),
      close: () => { clearInterval(pingInterval); ws.close(); },
    };
    return api;
  };

  /**
   * Creates and manages the authenticated User channel WebSocket.
   * wss://ws-subscriptions-clob.polymarket.com/ws/user
   *
   * @param {object}   auth         { apiKey, secret, passphrase }
   * @param {object}   handlers     { onOrder, onTrade, onError, onOpen, onClose }
   * @param {string[]} [markets]    Optional condition IDs to filter events
   * @returns {{ send, subscribeMarkets, unsubscribeMarkets, close, ws }}
   */
  PolymarketClient.createUserWS = (auth = {}, handlers = {}, markets = []) => {
    const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
    const ws = new WebSocket(WS_URL);
    let pingInterval = null;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'user', auth, ...(markets.length ? { markets } : {}) }));
      pingInterval = setInterval(() => { if (ws.readyState === 1) ws.send('PING'); }, 10000);
      handlers.onOpen?.();
    };

    ws.onmessage = ({ data }) => {
      if (data === 'PONG') return;
      let msg; try { msg = JSON.parse(data); } catch { return; }
      switch (msg.event_type) {
        case 'order': return handlers.onOrder?.(msg);
        case 'trade': return handlers.onTrade?.(msg);
      }
    };

    ws.onerror = (e) => handlers.onError?.(e);
    ws.onclose = (e) => { clearInterval(pingInterval); handlers.onClose?.(e); };

    const api = {
      ws,
      send: (payload) => ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload)),
      subscribeMarkets:   (ids) => ws.send(JSON.stringify({ operation: 'subscribe',   markets: ids })),
      unsubscribeMarkets: (ids) => ws.send(JSON.stringify({ operation: 'unsubscribe', markets: ids })),
      close: () => { clearInterval(pingInterval); ws.close(); },
    };
    return api;
  };

  /**
   * Creates and manages the authenticated Quoter Gateway WebSocket (Combinatorial RFQ).
   * wss://combos-rfq-gateway-quoter.polymarket.com/ws/rfq
   *
   * Server → client: RFQ_REQUEST, ACK_RFQ_QUOTE, ACK_RFQ_QUOTE_CANCEL,
   *                   RFQ_CONFIRMATION_REQUEST, ACK_RFQ_CONFIRMATION_RESPONSE,
   *                   RFQ_EXECUTION_UPDATE, RFQ_TRADE, RFQ_ERROR, auth response.
   *
   * @param {object} auth       { apiKey, secret, passphrase }
   * @param {object} identity   { signer_address, maker_address, signature_type }
   * @param {object} handlers   { onAuthResult, onRfqRequest, onAckQuote,
   *                              onAckCancel, onConfirmationRequest,
   *                              onAckConfirmation, onExecutionUpdate,
   *                              onTrade, onRfqError, onError, onOpen, onClose }
   * @returns {{ submitQuote, cancelQuote, confirmQuote, declineQuote, close, ws }}
   */
  PolymarketClient.createQuoterWS = (auth = {}, identity = {}, handlers = {}) => {
    const WS_URL = 'wss://combos-rfq-gateway-quoter.polymarket.com/ws/rfq';
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      // Auth MUST be sent within 30 s
      ws.send(JSON.stringify({ type: 'auth', auth, identity }));
      handlers.onOpen?.();
    };

    ws.onmessage = ({ data }) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      switch (msg.type) {
        case 'auth':                        return handlers.onAuthResult?.(msg);
        case 'RFQ_REQUEST':                 return handlers.onRfqRequest?.(msg);
        case 'ACK_RFQ_QUOTE':               return handlers.onAckQuote?.(msg);
        case 'ACK_RFQ_QUOTE_CANCEL':        return handlers.onAckCancel?.(msg);
        case 'RFQ_CONFIRMATION_REQUEST':    return handlers.onConfirmationRequest?.(msg);
        case 'ACK_RFQ_CONFIRMATION_RESPONSE': return handlers.onAckConfirmation?.(msg);
        case 'RFQ_EXECUTION_UPDATE':        return handlers.onExecutionUpdate?.(msg);
        case 'RFQ_TRADE':                   return handlers.onTrade?.(msg);
        case 'RFQ_ERROR':                   return handlers.onRfqError?.(msg);
      }
    };

    ws.onerror = (e) => handlers.onError?.(e);
    ws.onclose = (e) => handlers.onClose?.(e);

    const send = (payload) => ws.send(JSON.stringify(payload));

    return {
      ws,
      /** Submit a signed quote in response to an RFQ_REQUEST */
      submitQuote: ({ rfq_id, price_e6, size_e6, signed_order }) =>
        send({ type: 'RFQ_QUOTE', rfq_id, price_e6, size_e6, signed_order }),
      /** Cancel an active quote before it is selected */
      cancelQuote: ({ rfq_id, quote_id }) =>
        send({ type: 'RFQ_QUOTE_CANCEL', rfq_id, quote_id,
               signer_address: identity.signer_address,
               maker_address: identity.maker_address }),
      /** Confirm last-look for a selected quote */
      confirmQuote: ({ rfq_id, quote_id }) =>
        send({ type: 'RFQ_CONFIRMATION_RESPONSE', rfq_id, quote_id, decision: 'CONFIRM' }),
      /** Decline last-look for a selected quote */
      declineQuote: ({ rfq_id, quote_id }) =>
        send({ type: 'RFQ_CONFIRMATION_RESPONSE', rfq_id, quote_id, decision: 'DECLINE' }),
      close: () => ws.close(),
    };
  };

  console.info('[WE] PolymarketClient extensions loaded (relayer/data/bridge/RFQ)');
})();
