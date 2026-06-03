// ================================================================
// wallet-cache.js  — Smart caching & batching layer for wallet + chain data
// ================================================================
// Architecture:
//   L1: In-memory LRU (instant, session-scoped, max 100 entries)
//   L2: localStorage (survives restarts, max 50 entries, 24h TTL)
//   Dedup: in-flight Map — identical concurrent requests share one Promise
//   Stale-while-revalidate: serve L1/L2 hit immediately, refresh in BG
//   Source health: per-API failure counters with exponential backoff
//   Batch coordinator: caps concurrent outbound requests to avoid throttling
//   ChainCache: per-chain TTL keyed by `chain:wallet` (triangulates sources)
// ================================================================
// Exposes: window.WalletCache
//   .getTokens(addr, opts?)            → Promise<{ data, source, ts, stale }>
//   .getTxs(addr, opts?)               → Promise<{ data, source, ts, stale }>
//   .prefetch(addr)                    → void (background, low priority)
//   .prefetchBatch(addrs[])            → void
//   .invalidate(addr)                  → void (evict from all tiers)
//   .stats()                           → { hits, misses, inflight, sources }
//   .chain.get(chain, wallet, fetchFn) → Promise<data>  ← multi-chain layer
//   .chain.invalidate(chain, wallet)   → void
//   .chain.flush(chain?)               → void (flush one chain or all)
// ================================================================

(function () {
  'use strict';

  // ── Per-chain TTLs (ms) — tuned to each chain's block time ───────
  // BUG FIX: original snippet compared `TTLs` (the object) instead of
  // `TTLs[chain]` — object reference is always truthy → cache never expired.
  const CHAIN_TTL = {
    solana: 15_000,   // ~0.4s blocks — refresh aggressively
    ethereum: 30_000,   // ~12s blocks
    base: 25_000,   // L2 on ETH, slightly faster
    arbitrum: 25_000,
    polygon: 20_000,   // ~2s blocks
    bsc: 20_000,   // ~3s blocks
    bitcoin: 60_000,   // ~10min blocks — no rush
    xrp: 15_000,   // ~3-5s ledgers
    doge: 60_000,   // ~1min blocks
    hype: 15_000,   // Hyperliquid L1 ~1s finality
    default: 30_000,   // fallback for unknown chains
  };

  // ── Wallet-data TTL config (ms) ──────────────────────────────────
  const TTL = {
    tokens: 5 * 60 * 1000,      // 5m  — balances stable
    txs: 2 * 60 * 1000,      // 2m  — new txs appear quickly
    stale: 15 * 60 * 1000,      // 15m — serve stale beyond this, show badge
    ls: 24 * 60 * 60 * 1000, // 24h — localStorage eviction
  };

  const LS_KEY = 'wecrypto_wallet_cache_v2';
  const L1_MAX = 100;   // max in-memory entries
  const LS_MAX = 50;    // max localStorage entries
  const CONCUR = 4;     // max simultaneous outbound requests

  // ── In-memory LRU ────────────────────────────────────────────────
  // Map preserves insertion order; we use it as an LRU by
  // delete-then-re-insert on every access.
  const _l1 = new Map(); // addr → { tokens?, txs? }

  // ── In-flight dedup ──────────────────────────────────────────────
  // key = `${addr}:${type}` → Promise
  const _inflight = new Map();

  // ── Batch concurrency semaphore ──────────────────────────────────
  let _active = 0;
  const _queue = []; // { fn, resolve, reject }

  function _acquire() {
    return new Promise((resolve, reject) => {
      if (_active < CONCUR) { _active++; resolve(); }
      else _queue.push({ fn: null, resolve, reject });
    });
  }

  function _release() {
    if (_queue.length) {
      const { resolve } = _queue.shift();
      resolve();
    } else {
      _active--;
    }
  }

  async function _throttled(fn) {
    await _acquire();
    try { return await fn(); }
    finally { _release(); }
  }

  // ── Source health tracker ────────────────────────────────────────
  const _health = {
    blockscout: { fails: 0, lastFail: 0 },
    ethplorer: { fails: 0, lastFail: 0 },
    etherscan: { fails: 0, lastFail: 0 },
    bscscan: { fails: 0, lastFail: 0 },
    blockcypher: { fails: 0, lastFail: 0 },
    blockchair: { fails: 0, lastFail: 0 },
  };

  function _markFail(src) {
    const h = _health[src];
    if (!h) return;
    h.fails++;
    h.lastFail = Date.now();
  }

  function _markOk(src) {
    const h = _health[src];
    if (h) { h.fails = 0; h.lastFail = 0; }
  }

  // Exponential backoff: after N fails wait 2^N * 10s (capped at 5m)
  function _isBackedOff(src) {
    const h = _health[src];
    if (!h || h.fails === 0) return false;
    const backoffMs = Math.min(Math.pow(2, h.fails) * 20000, 300000);
    return (Date.now() - h.lastFail) < backoffMs;
  }

  // ── Stats ────────────────────────────────────────────────────────
  const _stats = { hits: 0, misses: 0 };

  // ── localStorage helpers ─────────────────────────────────────────
  function _lsLoad() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed.v !== 2) return {};   // version bump clears old cache
      return parsed.entries || {};
    } catch (_) { return {}; }
  }

  function _lsSave(entries) {
    try {
      // Evict oldest entries if over LS_MAX
      const keys = Object.keys(entries);
      if (keys.length > LS_MAX) {
        // Sort by most-recently-used (max ts across tokens+txs)
        keys.sort((a, b) => {
          const mru = e => Math.max(e.tokens?.ts || 0, e.txs?.ts || 0);
          return mru(entries[b]) - mru(entries[a]);
        });
        keys.slice(LS_MAX).forEach(k => delete entries[k]);
      }
      localStorage.setItem(LS_KEY, JSON.stringify({ v: 2, entries }));
    } catch (_) { }
  }

  function _lsGet(addr) {
    const entries = _lsLoad();
    const e = entries[addr.toLowerCase()];
    if (!e) return null;
    return e;
  }

  function _lsSet(addr, type, payload) {
    const entries = _lsLoad();
    const key = addr.toLowerCase();
    if (!entries[key]) entries[key] = {};
    entries[key][type] = payload;
    _lsSave(entries);
  }

  function _lsDel(addr) {
    const entries = _lsLoad();
    delete entries[addr.toLowerCase()];
    _lsSave(entries);
  }

  // ── L1 LRU helpers ───────────────────────────────────────────────
  function _l1Get(addr) {
    const key = addr.toLowerCase();
    const v = _l1.get(key);
    if (v) { _l1.delete(key); _l1.set(key, v); } // LRU promote
    return v || null;
  }

  function _l1Set(addr, type, payload) {
    const key = addr.toLowerCase();
    const existing = _l1.get(key) || {};
    existing[type] = payload;
    _l1.delete(key);
    _l1.set(key, existing);
    // Evict oldest if over limit
    if (_l1.size > L1_MAX) {
      const oldest = _l1.keys().next().value;
      _l1.delete(oldest);
    }
  }

  function _l1Del(addr) {
    _l1.delete(addr.toLowerCase());
  }

  // ── Cache lookup (L1 → L2) ───────────────────────────────────────
  function _cacheGet(addr, type) {
    // L1
    const l1 = _l1Get(addr);
    if (l1?.[type]) {
      const age = Date.now() - l1[type].ts;
      if (age < TTL[type]) { _stats.hits++; return { ...l1[type], stale: false }; }
      if (age < TTL.stale) { _stats.hits++; return { ...l1[type], stale: true }; }
    }
    // L2
    const l2 = _lsGet(addr);
    if (l2?.[type]) {
      const age = Date.now() - l2[type].ts;
      if (age < TTL.ls) {
        // Warm L1 from L2
        _l1Set(addr, type, l2[type]);
        _stats.hits++;
        return { ...l2[type], stale: age > TTL[type] };
      }
    }
    _stats.misses++;
    return null;
  }

  function _cachePut(addr, type, data, source) {
    const payload = { data, source, ts: Date.now() };
    _l1Set(addr, type, payload);
    _lsSet(addr, type, payload);
  }

  function _buildDiagnostics(type, result) {
    const source = result?.source || 'unknown';
    const stale = !!result?.stale;
    const tokens = Array.isArray(result?.data) ? result.data : [];
    const txs = Array.isArray(result?.data?.items) ? result.data.items : [];

    let reasonCode = 'ok';
    let reasonDetail = 'Live data available';

    if (source === 'none') {
      reasonCode = 'source_none';
      reasonDetail = 'No live provider returned data; using empty fallback';
    } else if (stale) {
      reasonCode = 'stale_cache';
      reasonDetail = 'Serving cached data while source refresh is pending';
    } else if (type === 'tokens' && tokens.length === 0) {
      reasonCode = 'empty_tokens';
      reasonDetail = 'Provider returned no token balances for this address';
    } else if (type === 'txs' && txs.length === 0) {
      reasonCode = 'empty_txs';
      reasonDetail = 'Provider returned no recent transactions for this address';
    }

    return {
      type,
      source,
      stale,
      reasonCode,
      reasonDetail,
      generatedAt: Date.now(),
    };
  }

  // ── Fetch implementation ──────────────────────────────────────────

  async function _fetchTokensRaw(addr) {
    // Tier 1: Blockscout (free, no key)
    if (!_isBackedOff('blockscout')) {
      try {
        const r = await _timedFetch(
          `https://eth.blockscout.com/api/v2/addresses/${addr}/token-balances`
        );
        if (r.ok) {
          _markOk('blockscout');
          return { data: await r.json(), source: 'blockscout' };
        }
        if (r.status === 429) _markFail('blockscout');
      } catch (e) { _markFail('blockscout'); }
    }

    // Tier 2: Ethplorer (freekey)
    if (!_isBackedOff('ethplorer')) {
      try {
        const r = await _timedFetch(
          `https://api.ethplorer.io/getAddressInfo/${addr}?apiKey=freekey`
        );
        if (r.ok) {
          const d = await r.json();
          if (!d.error) {
            _markOk('ethplorer');
            return { data: _normalizeEthplorerTokens(d), source: 'ethplorer' };
          }
        }
      } catch (e) { _markFail('ethplorer'); }
    }

    // Tier 3: Etherscan (user API key)
    const esKey = localStorage.getItem('etherscanApiKey') || '';
    if (esKey && !_isBackedOff('etherscan')) {
      try {
        const r = await _timedFetch(
          `https://api.etherscan.io/api?module=account&action=tokenlist&address=${addr}&apikey=${esKey}`
        );
        if (r.ok) {
          const d = await r.json();
          if (d.status === '1') {
            _markOk('etherscan');
            return { data: _normalizeEtherscanTokens(d), source: 'etherscan' };
          }
          if (d.status === '0' && d.message === 'NOTOK') _markFail('etherscan');
        }
      } catch (e) { _markFail('etherscan'); }
    }

    throw new Error('All token sources unavailable — check connection or add Etherscan API key');
  }

  async function _fetchTxsRaw(addr) {
    // Tier 1: Blockscout
    if (!_isBackedOff('blockscout')) {
      try {
        const r = await _timedFetch(
          `https://eth.blockscout.com/api/v2/addresses/${addr}/transactions`
        );
        if (r.ok) {
          _markOk('blockscout');
          return { data: await r.json(), source: 'blockscout' };
        }
        if (r.status === 429) _markFail('blockscout');
      } catch (e) { _markFail('blockscout'); }
    }

    // Tier 2: Etherscan
    const esKey = localStorage.getItem('etherscanApiKey') || '';
    if (esKey && !_isBackedOff('etherscan')) {
      try {
        const r = await _timedFetch(
          `https://api.etherscan.io/api?module=account&action=txlist&address=${addr}&sort=desc&page=1&offset=10&apikey=${esKey}`
        );
        if (r.ok) {
          const d = await r.json();
          if (d.status === '1') {
            _markOk('etherscan');
            return { data: _normalizeEtherscanTxs(d, addr), source: 'etherscan' };
          }
        }
      } catch (e) { _markFail('etherscan'); }
    }

    // Tier 3: empty (ethplorer has no tx list on freekey)
    return { data: { items: [] }, source: 'none' };
  }

  // ── Public fetch with dedup + SWR ────────────────────────────────

  async function _getWithDedup(addr, type, fetchFn) {
    const normalAddr = addr.toLowerCase().trim();
    const dedupKey = `${normalAddr}:${type}`;

    // Serve from cache immediately
    const cached = _cacheGet(normalAddr, type);
    if (cached && !cached.stale) return cached;

    // Deduplicate: if already fetching, return same Promise
    if (_inflight.has(dedupKey)) {
      const result = await _inflight.get(dedupKey);
      return result;
    }

    // Stale-while-revalidate: if stale, return stale now and refresh in background
    if (cached?.stale) {
      _backgroundRefresh(normalAddr, type, fetchFn, dedupKey);
      return cached;
    }

    // Full fetch
    const p = _throttled(() => fetchFn(normalAddr))
      .then(({ data, source }) => {
        _cachePut(normalAddr, type, data, source);
        window._walletDataSource = source; // compat with existing app.js
        return { data, source, ts: Date.now(), stale: false };
      })
      .finally(() => _inflight.delete(dedupKey));

    _inflight.set(dedupKey, p);
    return p;
  }

  function _backgroundRefresh(addr, type, fetchFn, dedupKey) {
    if (_inflight.has(dedupKey)) return;
    const p = _throttled(() => fetchFn(addr))
      .then(({ data, source }) => {
        _cachePut(addr, type, data, source);
        // Fire event so UI can update without explicit poll
        window.dispatchEvent(new CustomEvent('wallet-cache-update', {
          detail: { addr, type, source }
        }));
        return { data, source, ts: Date.now(), stale: false };
      })
      .catch(e => console.warn(`[WalletCache] BG refresh ${addr}:${type} failed:`, e.message))
      .finally(() => _inflight.delete(dedupKey));
    _inflight.set(dedupKey, p);
  }

  // ── Utilities ────────────────────────────────────────────────────

  function _timedFetch(url, opts = {}, ms = 30000) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => {
      try {
        ctrl.abort(new DOMException(`Wallet cache fetch timed out after ${ms}ms`, 'TimeoutError'));
      } catch (_) {
        try { ctrl.abort(); } catch (_) { }
      }
    }, ms);

    // Try resilientFetch first for GET requests (adds automatic retry + fallback)
    if ((!opts.method || opts.method === 'GET') && window.resilientFetch) {
      return window.resilientFetch(url)
        .catch(err => {
          // Fall back to standard fetch if resilientFetch fails
          return fetch(url, { ...opts, signal: ctrl.signal });
        })
        .finally(() => clearTimeout(tid));
    }

    return fetch(url, { ...opts, signal: ctrl.signal })
      .finally(() => clearTimeout(tid));
  }

  function _normalizeEthplorerTokens(data) {
    const out = [];
    if (data.ETH?.balance) {
      out.push({
        token: { symbol: 'ETH', name: 'Ether', decimals: '18', address: '' },
        value: String(Math.round(data.ETH.balance * 1e18)),
      });
    }
    (data.tokens || []).forEach(t => {
      if (!t.tokenInfo) return;
      out.push({
        token: {
          symbol: t.tokenInfo.symbol || '?',
          name: t.tokenInfo.name || '?',
          decimals: String(t.tokenInfo.decimals ?? 18),
          address: t.tokenInfo.address || '',
        },
        value: String(t.balance ?? 0),
      });
    });
    return out;
  }

  function _normalizeEtherscanTokens(data) {
    return (data.result || []).map(t => ({
      token: {
        symbol: t.tokenSymbol || '?',
        name: t.tokenName || '?',
        decimals: String(t.tokenDecimal ?? 18),
        address: t.contractAddress || '',
      },
      value: t.value || '0',
    }));
  }

  function _normalizeEtherscanTxs(data, addr) {
    return {
      items: (data.result || []).map(tx => ({
        hash: tx.hash,
        to: { hash: tx.to },
        from: { hash: tx.from },
        value: tx.value,
        timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
        method: tx.functionName ? tx.functionName.split('(')[0] : 'transfer',
        gas_used: tx.gasUsed,
      })),
    };
  }

  // ── ChainCache — multi-chain keyed cache (your chainCache.js pattern) ──
  // Fixes the TTLs bug: `TTLs[chain]` not `TTLs` (object ref is always truthy).
  // Adds: deduplication, stale-while-revalidate, cross-source triangulation.
  const _chainL1 = new Map();   // `chain:wallet` → { data, ts, sources[] }
  const _chainInflight = new Map(); // `chain:wallet` → Promise

  const ChainCache = {

    /**
     * Drop-in replacement for your getCachedChainData(chain, wallet, fetchFn).
     * Returns fresh data from cache if within TTL, otherwise calls fetchFn().
     * Bug fix: uses CHAIN_TTL[chain] not CHAIN_TTL (object).
     *
     * opts.force   = true  → bypass cache, always fetch fresh
     * opts.sources = [...] → array of { name, fetchFn } for triangulation
     */
    async get(chain, wallet, fetchFn, opts = {}) {
      const chainLower = (chain || 'default').toLowerCase();
      const walletKey = (wallet || 'global').toLowerCase();
      const key = `${chainLower}:${walletKey}`;
      const ttl = CHAIN_TTL[chainLower] ?? CHAIN_TTL.default;
      const now = Date.now();

      // Serve from L1 if within TTL (unless forced)
      if (!opts.force) {
        const cached = _chainL1.get(key);
        if (cached && (now - cached.ts) < ttl) {
          return cached.data;
        }
        // Stale-while-revalidate: if slightly expired but inflight already, return stale
        if (cached && _chainInflight.has(key)) {
          return cached.data;
        }
      }

      // Dedup: return same Promise if already fetching
      if (_chainInflight.has(key)) {
        return _chainInflight.get(key);
      }

      // Multi-source triangulation (optional)
      let fetchPromise;
      if (opts.sources && opts.sources.length > 1) {
        fetchPromise = this._triangulate(key, opts.sources);
      } else {
        fetchPromise = Promise.resolve().then(() => fetchFn());
      }

      const p = fetchPromise
        .then(data => {
          _chainL1.set(key, { data, ts: Date.now(), chain: chainLower, wallet: walletKey });
          window.dispatchEvent(new CustomEvent('chain-cache-update', {
            detail: { chain: chainLower, wallet: walletKey, key }
          }));
          return data;
        })
        .catch(err => {
          // On failure, return stale cache if available rather than throwing
          const stale = _chainL1.get(key);
          if (stale) {
            console.warn(`[ChainCache] ${key} fetch failed, serving stale:`, err.message);
            return stale.data;
          }
          throw err;
        })
        .finally(() => _chainInflight.delete(key));

      _chainInflight.set(key, p);
      return p;
    },

    /**
     * Triangulate: fire all sources in parallel, cross-check values,
     * return the median/majority result. Discards outliers > 5% from median.
     * Used to catch stale or bad data from a single source.
     */
    async _triangulate(key, sources) {
      const results = await Promise.allSettled(
        sources.map(s => _throttled(() => s.fetchFn()).then(d => ({ name: s.name, data: d })))
      );
      const fulfilled = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      if (!fulfilled.length) throw new Error(`All sources failed for ${key}`);
      if (fulfilled.length === 1) return fulfilled[0].data;

      // If data has a numeric `value` or `price` field, find median and filter outliers
      const nums = fulfilled
        .map(r => parseFloat(r.data?.value ?? r.data?.price ?? r.data?.rate ?? NaN))
        .filter(n => Number.isFinite(n));

      if (nums.length >= 2) {
        const sorted = [...nums].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const good = fulfilled.filter(r => {
          const v = parseFloat(r.data?.value ?? r.data?.price ?? r.data?.rate ?? NaN);
          return !Number.isFinite(v) || Math.abs(v - median) / median < 0.05;
        });
        if (good.length) {
          // Return data from the most reliable (first non-outlier) source
          const best = good[0];
          console.log(`[ChainCache] ${key} triangulated: ${good.map(g => g.name).join(', ')} ✓`);
          return { ...best.data, _sources: good.map(g => g.name), _triangulated: true };
        }
      }

      // Fall back to first fulfilled result
      return fulfilled[0].data;
    },

    /** Evict a specific chain:wallet entry. */
    invalidate(chain, wallet) {
      const key = `${(chain || 'default').toLowerCase()}:${(wallet || 'global').toLowerCase()}`;
      _chainL1.delete(key);
    },

    /** Flush all entries for a chain, or the entire cache. */
    flush(chain) {
      if (chain) {
        const prefix = chain.toLowerCase() + ':';
        for (const key of _chainL1.keys()) {
          if (key.startsWith(prefix)) _chainL1.delete(key);
        }
      } else {
        _chainL1.clear();
      }
    },

    /** How old is this entry? Returns ms, or Infinity if not cached. */
    age(chain, wallet) {
      const key = `${(chain || 'default').toLowerCase()}:${(wallet || 'global').toLowerCase()}`;
      const e = _chainL1.get(key);
      return e ? Date.now() - e.ts : Infinity;
    },

    /** List all cached chain:wallet keys with their age. */
    dump() {
      const out = {};
      for (const [k, v] of _chainL1) {
        out[k] = { ageMs: Date.now() - v.ts, ttl: CHAIN_TTL[v.chain] ?? CHAIN_TTL.default };
      }
      return out;
    },
  };

  // ── Public API ────────────────────────────────────────────────────

  const WalletCache = {

    /**
     * Get token balances for an ETH address.
     * Returns { data, source, ts, stale } — always resolves (throws on hard fail).
     */
    getTokens(addr, opts = {}) {
      if (!addr) return Promise.reject(new Error('No address'));
      return _getWithDedup(addr, 'tokens', _fetchTokensRaw)
        .then(result => ({
          ...result,
          diagnostics: _buildDiagnostics('tokens', result),
        }));
    },

    /**
     * Get recent transactions for an ETH address.
     */
    getTxs(addr, opts = {}) {
      if (!addr) return Promise.reject(new Error('No address'));
      return _getWithDedup(addr, 'txs', _fetchTxsRaw)
        .then(result => ({
          ...result,
          diagnostics: _buildDiagnostics('txs', result),
        }));
    },

    /**
     * Prefetch both tokens + txs for an address in the background.
     * Useful for pre-warming cache for tracked wallets.
     */
    prefetch(addr) {
      if (!addr) return;
      const n = addr.toLowerCase().trim();
      const tokenKey = `${n}:tokens`;
      const txKey = `${n}:txs`;
      if (!_inflight.has(tokenKey)) _backgroundRefresh(n, 'tokens', _fetchTokensRaw, tokenKey);
      if (!_inflight.has(txKey)) _backgroundRefresh(n, 'txs', _fetchTxsRaw, txKey);
    },

    /**
     * Evict an address from all cache tiers, forcing a fresh fetch next time.
     */
    invalidate(addr) {
      if (!addr) return;
      const n = addr.toLowerCase().trim();
      _l1Del(n);
      _lsDel(n);
    },

    /**
     * Batch prefetch multiple addresses (respects CONCUR limit).
     */
    prefetchBatch(addrs = []) {
      addrs.forEach(a => this.prefetch(a));
    },

    /**
     * Debug stats.
     */
    stats() {
      return {
        hits: _stats.hits,
        misses: _stats.misses,
        l1Size: _l1.size,
        inflight: _inflight.size,
        active: _active,
        queued: _queue.length,
        chainL1: _chainL1.size,
        chainInFl: _chainInflight.size,
        sources: Object.fromEntries(
          Object.entries(_health).map(([k, v]) => [k, {
            fails: v.fails,
            backoff: _isBackedOff(k),
            lastFail: v.lastFail ? new Date(v.lastFail).toLocaleTimeString() : null,
          }])
        ),
      };
    },

    /**
     * Clear entire cache (L1 + L2 + chain).
     */
    clear() {
      _l1.clear();
      _chainL1.clear();
      try { localStorage.removeItem(LS_KEY); } catch (_) { }
      console.log('[WalletCache] Cleared all tiers');
    },

    // ── Multi-chain caching layer ────────────────────────────────────
    // Drop-in for chainCache.js with the TTLs[chain] bug fixed.
    //
    // Usage (matches your snippet exactly):
    //   const data = await WalletCache.chain.get(
    //     'solana', walletAddress, () => fetchSolanaWallet(walletAddress)
    //   );
    //
    // Multi-source triangulation:
    //   const data = await WalletCache.chain.get('ethereum', addr, null, {
    //     sources: [
    //       { name: 'blockscout', fetchFn: () => fetchBlockscout(addr) },
    //       { name: 'etherscan',  fetchFn: () => fetchEtherscan(addr)  },
    //       { name: 'ethplorer',  fetchFn: () => fetchEthplorer(addr)  },
    //     ]
    //   });
    chain: ChainCache,

    // ── Whale & DEX integration ──────────────────────────────
    /**
     * Get whale transactions for a wallet/chain.
     * Requires whale-alert-monitor.js loaded.
     */
    async getWhales(wallet, chain = 'ETH') {
      if (!window.WhaleAlertMonitor) {
        throw new Error('WhaleAlertMonitor not loaded');
      }
      const result = await window.WhaleAlertMonitor.getWhaleTransactions(chain);
      return result.txs.filter(t =>
        (t.from?.toLowerCase?.() === wallet.toLowerCase()) ||
        (t.to?.toLowerCase?.() === wallet.toLowerCase())
      );
    },

    /**
     * Get DEX swaps for a wallet.
     * Requires dex-activity-monitor.js loaded.
     */
    async getSwaps(wallet, chain = 'ETH') {
      if (!window.DexActivityMonitor) {
        throw new Error('DexActivityMonitor not loaded');
      }
      const result = await window.DexActivityMonitor.getSwaps(chain);
      return result.swaps.filter(s =>
        s.user?.toLowerCase?.() === wallet.toLowerCase()
      );
    },

    /**
     * Get full portfolio analysis for a wallet.
     * Requires portfolio-intel.js loaded.
     */
    async analyzePortfolio(wallet, chains = ['ETH', 'BNB']) {
      if (!window.PortfolioIntel) {
        throw new Error('PortfolioIntel not loaded');
      }
      return window.PortfolioIntel.analyze([wallet], { chains });
    },

    /**
     * Start real-time monitoring of a wallet across all intel sources.
     */
    trackPortfolio(wallet, callback, chains = ['ETH', 'BNB']) {
      if (!window.PortfolioIntel) {
        throw new Error('PortfolioIntel not loaded');
      }
      return window.PortfolioIntel.trackWallet(wallet, callback, chains);
    },

    /**
     * Stop tracking a wallet.
     */
    stopTracking(wallet) {
      if (window.PortfolioIntel) {
        window.PortfolioIntel.untrackWallet(wallet);
      }
    },

    /**
     * Combined stats across all intel sources.
     */
    statsIntel() {
      return {
        whales: window.WhaleAlertMonitor?.stats?.() || {},
        dex: window.DexActivityMonitor?.stats?.() || {},
        portfolio: window.PortfolioIntel?.stats?.() || {},
      };
    },
  };

  window.WalletCache = WalletCache;

})();
