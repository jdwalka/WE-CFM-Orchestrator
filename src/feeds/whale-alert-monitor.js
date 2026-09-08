// ================================================================
// whale-alert-monitor.js — Real-time whale transaction tracking
// ================================================================
// Monitors large transactions across BTC, ETH, BNB using Whale Alert API
// Exposes: window.WhaleAlertMonitor
//   .getWhaleTransactions(chain, opts) → Promise<{ txs, count, largest }>
//   .startMonitoring(chains, callback)  → void
//   .stopMonitoring()                   → void
//   .stats()                            → { monitored, alerts, sources }
// ================================================================

(function () {
  'use strict';

  const WHALE_ALERT_BASE = 'https://api.whale-alert.io/v1';

  // Resolved lazily from secrets/WHALE_ALERT_API.txt, env, localStorage.
  // (Old code only checked localStorage — key sat unused in secrets/ → 401s.)
  let _apiKey = '';
  let _apiKeyResolved = false;
  let _apiKeyResolveInFlight = null;
  let _authRejectedUntil = 0; // backoff after 401/403 so we don't hot-loop
  let _rateLimitedUntil = 0; // backoff after 429 -- whale-alert.io's limit is per API key
                              // (shared across chains), so this is global, not per-chain.
  const RATE_LIMIT_BACKOFF_MS = 60_000; // used when the API doesn't send Retry-After

  const CHAIN_MAP = {
    BTC: 'bitcoin',
    ETH: 'ethereum',
    SOL: 'solana',
    BNB: 'binance',
  };

  const THRESHOLDS = {
    BTC: 5000000,     // $5M USD minimum
    ETH: 2000000,     // $2M USD minimum
    SOL: 1500000,     // $1.5M USD minimum
    BNB: 1000000,     // $1M USD minimum
  };

  // ── In-memory tracking ────────────────────────────────────────
  const _monitored = new Map(); // chain → { active, startTime, count }
  const _whaleCache = new Map(); // chain → { txs[], timestamp }
  const _listeners = [];

  // ── Rate limiting ────────────────────────────────────────────
  const _rateLimits = {
    lastFetch: {},    // chain → timestamp
    minInterval: 20000, // 20s minimum between requests per chain
  };

  // ── Health tracking ──────────────────────────────────────────
  const _health = {
    whaleAlert: { fails: 0, lastFail: 0, lastSuccess: 0, lastStatus: null, lastReason: '' },
  };

  function _extractKeyFromRaw(raw) {
    if (!raw) return '';
    const text = String(raw);
    // Prefer KEY=value style, else last bare non-comment line that looks like a key
    const kv = text.match(/(?:WHALE_ALERT(?:_API)?(?:_KEY)?|API_KEY)\s*[=:]\s*([A-Za-z0-9_-]{16,})/i);
    if (kv && kv[1]) return kv[1].trim();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].replace(/^[A-Za-z0-9_.-]+\s*[=:]\s*/, '').trim();
      // Whale keys are typically 32-char alphanumerics (not xai-/sk-)
      if (/^[A-Za-z0-9_-]{16,64}$/.test(line) && !/^xai-/i.test(line) && !/^sk-/i.test(line)) {
        return line;
      }
    }
    return '';
  }

  function _readKeySyncSources() {
    try {
      if (typeof window !== 'undefined' && window.__env) {
        const k = window.__env.WHALE_ALERT_KEY
          || window.__env.WHALE_ALERT_API_KEY
          || window.__env.WHALE_ALERT_API
          || '';
        if (k) return String(k).trim();
      }
    } catch (_) {}
    try {
      if (typeof localStorage !== 'undefined') {
        const k = localStorage.getItem('whaleAlertApiKey')
          || localStorage.getItem('WHALE_ALERT_KEY')
          || localStorage.getItem('WHALE_ALERT_API_KEY')
          || '';
        if (k) return String(k).trim();
      }
    } catch (_) {}
    try {
      if (typeof process !== 'undefined' && process.env) {
        const k = process.env.WHALE_ALERT_KEY
          || process.env.WHALE_ALERT_API_KEY
          || process.env.WHALE_ALERT_API
          || '';
        if (k) return String(k).trim();
      }
    } catch (_) {}
    return '3QdbUuaagCfzZuUBOxeeMNvqeQsp1RwE';
  }

  async function resolveApiKey(force = false) {
    if (!force && _apiKeyResolved && _apiKey) return _apiKey;
    if (_apiKeyResolveInFlight) return _apiKeyResolveInFlight;

    _apiKeyResolveInFlight = (async () => {
      let key = _readKeySyncSources();

      // secrets/WHALE_ALERT_API.txt (and aliases) via Electron
      if (!key && window.electron && typeof window.electron.readFile === 'function') {
        const candidates = [
          'secrets/WHALE_ALERT_API.txt',
          'secrets/WHALE_ALERT_API_KEY.txt',
          'secrets/WHALE_ALERT_KEY.txt',
          'secrets/WHALE-ALERT-API.txt',
        ];
        for (const rel of candidates) {
          try {
            const txt = await window.electron.readFile(rel);
            const extracted = _extractKeyFromRaw(txt);
            if (extracted) {
              key = extracted;
              break;
            }
          } catch (_) { /* next */ }
        }
      }

      _apiKey = key || '';
      _apiKeyResolved = true;
      if (_apiKey) {
        try {
          if (typeof localStorage !== 'undefined' && !localStorage.getItem('whaleAlertApiKey')) {
            localStorage.setItem('whaleAlertApiKey', _apiKey);
          }
        } catch (_) {}
        console.log('[WhaleAlert] API key loaded (len=' + _apiKey.length + ')');
      } else {
        console.warn('[WhaleAlert] No API key — put key in secrets/WHALE_ALERT_API.txt (calls will 401)');
      }
      return _apiKey;
    })().finally(() => {
      _apiKeyResolveInFlight = null;
    });

    return _apiKeyResolveInFlight;
  }

  function _reportHealth(ok, status, reason) {
    try {
      const provider = 'Whale Alert';
      if (ok) {
        if (typeof window.NetworkHealth?.markSuccess === 'function') {
          window.NetworkHealth.markSuccess(provider, {
            lastFetch: Date.now(),
            reason: reason || 'HTTP OK',
          });
        } else if (typeof window.NetworkHealth?.update === 'function') {
          window.NetworkHealth.update(provider, {
            status: 'healthy',
            lastFetch: Date.now(),
            optional: true,
            fallback: false,
            reason: reason || 'HTTP OK',
          });
        }
      } else if (typeof window.NetworkHealth?.update === 'function') {
        window.NetworkHealth.update(provider, {
          status: 'degraded',
          lastFetch: Date.now(),
          optional: true,
          fallback: true,
          transient: status === 429 || (status >= 500),
          reason: reason || `HTTP ${status || '?'}`,
          bucket: 'provider/api',
        });
      }
    } catch (_) {}
  }

  function _markFail(src) {
    if (_health[src]) {
      _health[src].fails++;
      _health[src].lastFail = Date.now();
    }
  }

  function _markOk(src) {
    if (_health[src]) {
      _health[src].fails = 0;
      _health[src].lastFail = 0;
      _health[src].lastSuccess = Date.now();
    }
  }

  // ── Fetching ──────────────────────────────────────────────────

  async function _fetchWhaleTransactions(chain) {
    const whaleChain = CHAIN_MAP[chain];
    if (!whaleChain) return [];

    const threshold = THRESHOLDS[chain];

    try {
      // Auth rejection backoff — avoid 401 spam
      if (Date.now() < _authRejectedUntil) {
        return _whaleCache.get(chain)?.txs || [];
      }

      // 429 backoff — avoid re-triggering the rate limit every 20s poll tick
      if (Date.now() < _rateLimitedUntil) {
        return _whaleCache.get(chain)?.txs || [];
      }

      // Rate limit check
      const lastFetch = _rateLimits.lastFetch[chain] || 0;
      if (Date.now() - lastFetch < _rateLimits.minInterval) {
        return _whaleCache.get(chain)?.txs || [];
      }

      const apiKey = await resolveApiKey();
      if (!apiKey) {
        _markFail('whaleAlert');
        _health.whaleAlert.lastReason = 'missing_api_key';
        _reportHealth(false, 401, 'missing API key (secrets/WHALE_ALERT_API.txt)');
        _authRejectedUntil = Date.now() + 5 * 60_000;
        return _whaleCache.get(chain)?.txs || [];
      }

      const url = new URL(`${WHALE_ALERT_BASE}/transactions`);
      url.searchParams.set('blockchain', whaleChain);
      url.searchParams.set('min_value', threshold);
      url.searchParams.set('limit', 50);
      url.searchParams.set('api_key', apiKey);

      const ctrl = new AbortController();
      const tid = setTimeout(() => {
        try {
          ctrl.abort(new DOMException('Whale Alert fetch timed out after 30000ms', 'TimeoutError'));
        } catch (_) {
          try { ctrl.abort(); } catch (_) { }
        }
      }, 30000);

      const res = await fetch(url.toString(), { signal: ctrl.signal });
      clearTimeout(tid);

      if (!res.ok) {
        _markFail('whaleAlert');
        _health.whaleAlert.lastStatus = res.status;
        _health.whaleAlert.lastReason = `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) {
          // Bad key or plan — stop hammering for 15 min; force re-resolve next time
          _authRejectedUntil = Date.now() + 15 * 60_000;
          _apiKeyResolved = false;
          _apiKey = '';
          _reportHealth(false, res.status, `upstream API reject ${res.status} — check secrets/WHALE_ALERT_API.txt`);
          console.warn(`[WhaleAlert] ${res.status} auth reject — backoff 15m`);
        } else if (res.status === 429) {
          // Was previously unhandled: no cooldown meant every chain re-hit the same
          // rate limit on the next 20s poll tick, indefinitely. whale-alert.io's
          // limit is per API key (shared across all chains), so back off globally.
          const retryAfterSec = Number(res.headers.get('Retry-After'));
          const backoffMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : RATE_LIMIT_BACKOFF_MS;
          _rateLimitedUntil = Date.now() + backoffMs;
          _reportHealth(false, res.status, `rate limited — backoff ${Math.round(backoffMs / 1000)}s`);
          console.warn(`[WhaleAlert] 429 rate limited — backoff ${Math.round(backoffMs / 1000)}s`);
        } else {
          _reportHealth(false, res.status, `HTTP ${res.status}`);
        }
        return _whaleCache.get(chain)?.txs || [];
      }

      const data = await res.json();
      _rateLimits.lastFetch[chain] = Date.now();
      _markOk('whaleAlert');
      _reportHealth(true, 200, 'transactions OK');

      // `(data.result || [])` used to fall through as truthy on a non-array
      // result (e.g. a 200 response carrying an error string/object instead
      // of transactions), then throw "(...).map is not a function" -- seen
      // live on every BTC/ETH/SOL cycle. Guard with Array.isArray instead.
      if (data.result != null && !Array.isArray(data.result)) {
        console.warn(`[WhaleAlert] ${chain} unexpected result shape:`, data.result);
      }
      const txs = (Array.isArray(data.result) ? data.result : []).map(tx => ({
        hash: tx.blockchain_tx_hash || tx.tx_hash || tx.hash,
        timestamp: tx.timestamp,
        amount: tx.amount,
        amount_usd: tx.amount_usd,
        from: tx.from?.address,
        to: tx.to?.address,
        from_label: tx.from?.owner_type,
        to_label: tx.to?.owner_type,
        chain,
        score: tx.amount_usd || 0,
        direction: tx.to?.owner_type === 'exchange' ? 'sell' : 
                   tx.from?.owner_type === 'exchange' ? 'buy' : 'transfer',
      }));

      _whaleCache.set(chain, { txs, timestamp: Date.now() });
      return txs;

    } catch (err) {
      _markFail('whaleAlert');
      console.error(`[WhaleAlert] ${chain} fetch failed:`, err.message);
      return _whaleCache.get(chain)?.txs || [];
    }
  }

  // ── Monitoring ────────────────────────────────────────────────

  async function _monitorCycle(chains, callback) {
    const allTxs = [];

    for (const chain of chains) {
      const txs = await _fetchWhaleTransactions(chain);
      if (txs.length > 0) {
        allTxs.push(...txs);
        const mon = _monitored.get(chain);
        if (mon) mon.count += txs.length;
      }
    }

    if (allTxs.length > 0) {
      allTxs.sort((a, b) => b.score - a.score);
      callback?.({ txs: allTxs, count: allTxs.length, largest: allTxs[0] });
    }
  }

  let _monitorInterval = null;

  // ── Public API ────────────────────────────────────────────────

  const WhaleAlertMonitor = {

    /**
     * Fetch whale transactions for a single chain.
     * Returns Promise<{ txs, count, largest }>
     */
    async getWhaleTransactions(chain, opts = {}) {
      const txs = await _fetchWhaleTransactions(chain);
      return {
        txs: txs.slice(0, opts.limit || 20),
        count: txs.length,
        largest: txs[0] || null,
        chain,
        timestamp: Date.now(),
      };
    },

    /** Sync cache read for OnChainFlow compressor (no network). */
    getCached(chain) {
      const key = String(chain || '').toUpperCase();
      const row = _whaleCache.get(key);
      if (!row) return null;
      return { txs: row.txs || [], timestamp: row.timestamp || 0, chain: key };
    },

    /**
     * Get synchronous accumulation score (-1.0 to 1.0) based on cached transactions.
     * buy = outflow from exchange (accumulation)
     * sell = inflow to exchange (distribution)
     */
    getAccumulationScore(chain) {
      const txs = _whaleCache.get(chain)?.txs || [];
      if (txs.length === 0) return 0;
      
      let buyVol = 0;
      let sellVol = 0;
      
      for (const tx of txs) {
        if (tx.direction === 'buy') buyVol += tx.score;
        else if (tx.direction === 'sell') sellVol += tx.score;
      }
      
      const total = buyVol + sellVol;
      return total > 0 ? (buyVol - sellVol) / total : 0;
    },

    /**
     * Start monitoring multiple chains for whale activity.
     * Calls callback every 20s with latest whales.
     */
    startMonitoring(chains = ['BTC', 'ETH', 'SOL'], callback) {
      if (_monitorInterval) return; // Already running

      chains.forEach(c => {
        _monitored.set(c, { active: true, startTime: Date.now(), count: 0 });
      });

      // Resolve secrets key before first cycle (fixes 401 when key only in secrets/)
      resolveApiKey().then((key) => {
        if (!key) {
          console.warn('[WhaleAlert] Monitoring started without key — optional feed degraded');
        }
        _monitorCycle(chains, callback);
      }).catch(() => {
        _monitorCycle(chains, callback);
      });

      _monitorInterval = setInterval(() => {
        _monitorCycle(chains, callback);
      }, 20000); // 20s polling

      console.log(`[WhaleAlert] Monitoring started: ${chains.join(', ')}`);
    },

    /** Force re-read secrets/env (e.g. after user drops a new key). */
    async reloadKey() {
      _apiKeyResolved = false;
      _apiKey = '';
      _authRejectedUntil = 0;
      return resolveApiKey(true);
    },

    hasKey() {
      return !!_apiKey;
    },

    /**
     * Stop all monitoring.
     */
    stopMonitoring() {
      if (_monitorInterval) {
        clearInterval(_monitorInterval);
        _monitorInterval = null;
        _monitored.clear();
        console.log('[WhaleAlert] Monitoring stopped');
      }
    },

    /**
     * Get current stats.
     */
    stats() {
      const monitored = {};
      for (const [chain, info] of _monitored) {
        monitored[chain] = {
          ...info,
          uptime: Date.now() - info.startTime,
        };
      }
      return {
        monitored,
        cacheSize: _whaleCache.size,
        health: _health.whaleAlert,
      };
    },

    /**
     * Clear caches.
     */
    flush() {
      _whaleCache.clear();
      _monitored.clear();
      this.stopMonitoring();
    },
  };

  // ── Expose globally ──────────────────────────────────────────
  window.WhaleAlertMonitor = WhaleAlertMonitor;

})();
