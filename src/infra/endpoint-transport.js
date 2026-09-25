// endpoint-transport.js — Unified endpoint ingestion bus + health-aware coordinator.
// Keeps legacy API (`fetchKalshiMarkets`, `fetchKalshiMarket`, `fetchWithPriority`) intact.
(function () {
  'use strict';

  const PRIORITY = ['wss', 'grpc', 'rpc', 'http'];
  const TRANSPORT_WEIGHT = {
    wss: 0,
    grpc: 1,
    rpc: 2,
    http: 3,
    direct: 4,
    ipc: 5,
    supp: 6,
    proxyOrchestrator: 7,
  };
  const stats = {};
  // Kalshi network disabled (Polymarket-only). Keep constants empty so no accidental fetch.
  const KALSHI_BASE = '';
  const KALSHI_WORKER_URL = '';
  const WS_STALE_MS = 75_000;
  const WS_STALE_GRACE_MS = 15_000;
  const SOURCE_STALE_MS = 60_000;
  const WSS_STALE_CONFIRM_WINDOWS = 2;
  const WSS_STALE_DEMOTE_MIN_MS = 20_000;
  const WSS_DEMOTION_COOLDOWN_MS = 12_000;
  const WSS_REPROMOTE_STABLE_MS = 15_000;
  const WSS_MAX_DEMOTE_HOLD_MS = 60_000;
  const WSS_RECOVERY_WINDOW_MS = 120_000;
  const WSS_RECOVERY_MAX_ATTEMPTS = 8;
  const HEALTHY_OK_MAX_AGE_MS = 90_000;
  const PROVIDER_ROLE = {
    polymarket: 'critical',
    pyth: 'critical',
    binance: 'optional',
    generic: 'optional',
    localproxy: 'optional',
  };
  const ROLE_ORDER = {
    // HTTP-leg sub-order. Top-level transport priority stays WSS → gRPC →
    // RPC → HTTP (see PRIORITY + chooseTransportOrder). Within the HTTP leg,
    // CF-protected hosts MUST try the proxy (supp/proxyOrchestrator) before
    // direct — direct fails at the Cloudflare edge and used to wedge the
    // global bypass. Open hosts prefer direct (lower latency).
    critical: ['supp', 'proxyOrchestrator', 'direct', 'ipc'],
    optional: ['supp', 'proxyOrchestrator', 'direct', 'ipc'],
  };
  // Hosts that REQUIRE the local proxy (Cloudflare Bot Mgmt / geo-block).
  // Direct-first for these burns a doomed attempt every poll and fed the old
  // global-bypass storm. Keep in sync with proxy-fetch.js CF_PROTECTED.
  const CF_PROTECTED_HOSTS = new Set([
    'api.binance.com', 'fapi.binance.com', 'dapi.binance.com',
    'data-api.binance.vision', 'api.bybit.com', 'api.bytick.com',
    'api.kraken.com', 'www.kraken.com',
    'api.bitstamp.net', 'www.bitstamp.net', 'www.okx.com', 'api.okx.com',
    'api-pub.bitfinex.com', 'api.kucoin.com', 'api.mexc.com',
    'api.crypto.com', 'api.bitvavo.com', 'api.upbit.com',
  ]);

  function _hostOf(url) {
    try { return new URL(String(url)).hostname.toLowerCase(); } catch (_) { return ''; }
  }
  const routeCircuit = {};
  const CIRCUIT_THRESHOLD = 3;
  const CIRCUIT_COOLDOWN_MS = 20_000;
  let transportSyncTimer = null;
  let transportPulseTimer = null;
  let busPollTimer = null;
  let lastTransportEventTs = 0;
  let lastWsActivityTs = 0;
  let lastRouteChangeReason = '';
  let lastRouteChangeTs = 0;
  let lastKalshiWsRecoveryTs = 0;
  let lastKalshiRouteRecoveryTs = 0;
  let lastKalshiDecisionKey = '';
  let lastKalshiDecisionTs = 0;
  let lastKalshiDemoteReason = '';
  let kalshiDemotedSinceTs = 0;
  let kalshiRecoveryWindowStartTs = 0;
  let kalshiRecoveryAttemptsInWindow = 0;
  const kalshiWssStability = {
    staleWindows: 0,
    staleSince: 0,
    healthySince: 0,
    demoted: false,
    lastDemoteTs: 0,
  };

  function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function _jitter(baseMs) {
    const jitter = Math.floor(Math.random() * Math.max(50, Math.floor(baseMs * 0.35)));
    return baseMs + jitter;
  }

  function _isTransientError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      msg.includes('abort') ||
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('failed to fetch') ||
      msg.includes('networkchanged') ||
      msg.includes('network changed')
    );
  }

  const providerRateLimit = {};
  const PROVIDER_RATE_LIMIT_MAX_MS = 60_000;

  function _isRateLimitError(err) {
    return /(?:^|\b)(?:http\s*)?429\b|too many requests|rate limit/i.test(String(err?.message || err || ''));
  }

  function _markProviderRateLimited(provider, err) {
    if (provider === 'pyth' || provider === 'pyth-lazer') {
      return 500; // Pyth bypasses exponential backoff to maintain live tracking (orchestrator handles burst)
    }
    if (err && typeof err === 'object' && err._endpointRateLimitMarked) {
      return _providerRateLimitRemaining(provider);
    }
    const now = Date.now();
    const state = providerRateLimit[provider] || { count: 0, until: 0 };
    state.count = now < state.until ? state.count + 1 : 1;
    // Exponential backoff with a higher cap and a lower base for smoother retry
    const baseMs = 15000;
    const wait = Math.min(PROVIDER_RATE_LIMIT_MAX_MS, baseMs * (2 ** Math.max(0, state.count - 1)));
    state.until = now + wait;
    providerRateLimit[provider] = state;
    if (err && typeof err === 'object') {
      try { err._endpointRateLimitMarked = true; } catch (_) { }
    }
    console.warn(`[EndpointTransport] ${provider} rate-limited; cooling down ${wait}ms (${String(err?.message || err || '429')})`);
    return wait;
  }

  function _providerRateLimitRemaining(provider) {
    const until = providerRateLimit[provider]?.until || 0;
    return Math.max(0, until - Date.now());
  }
  function _classifyTransportBucket(err, provider, transport) {
    const text = String(err?.message || err || '').toLowerCase();
    if (/browser websocket cannot send|requires node ws|credential|crypto unavailable|signature generation|kalshi-api-key\.txt not found|auth-header-failed|auth-config-fail/.test(text)) {
      return {
        bucket: 'app/logic',
        bucketReason: String(err?.message || err || `${provider}:${transport} local auth capability/configuration issue`),
      };
    }
    if (/http\s*(401|403|404|429|5\d\d)|unauthorized|forbidden|not found|rate limit|upstream/.test(text)) {
      return {
        bucket: 'provider/api',
        bucketReason: String(err?.message || err || 'upstream API reject'),
      };
    }
    if (/stale[-\s]*watchdog|demote|hysteresis|scheduler|circuit|oscillat|internal|reconnect|lifecycle|ipc/.test(text)) {
      return {
        bucket: 'app/logic',
        bucketReason: String(err?.message || err || `${provider}:${transport} internal handling issue`),
      };
    }
    if (/event:error/.test(text) && /readystate=3/.test(text)) {
      return {
        bucket: 'network/transport',
        bucketReason: 'websocket connect failure (readyState=3 before open)',
      };
    }
    let finalReason = String(err?.message || err || `${provider}:${transport} transport failure`);
    if (finalReason.includes('signal is aborted without reason')) {
      finalReason = `${provider}:${transport} timed out`;
    }

    return {
      bucket: 'network/transport',
      bucketReason: finalReason,
    };
  }

  function providerRole(provider) {
    return PROVIDER_ROLE[provider] || 'optional';
  }

  function getProxyState() {
    try {
      return window.ProxyTransport?.getState?.() || {};
    } catch (_) {
      return {};
    }
  }

  function getWsState() {
    return window.KalshiWS?.getState?.() || {};
  }

  function circuitKey(provider, transport) {
    return `${provider}:${transport}`;
  }

  function canUseTransport(provider, transport) {
    const row = routeCircuit[circuitKey(provider, transport)];
    if (!row || !row.openUntil) return true;
    if (Date.now() >= row.openUntil) {
      row.openUntil = 0;
      row.failures = 0;
      return true;
    }
    return false;
  }

  function markTransportOutcome(provider, transport, ok, err) {
    const key = circuitKey(provider, transport);
    if (!routeCircuit[key]) routeCircuit[key] = { failures: 0, openUntil: 0 };
    const row = routeCircuit[key];
    if (ok) {
      row.failures = 0;
      row.openUntil = 0;
      return;
    }
    row.failures += 1;
    if (row.failures >= CIRCUIT_THRESHOLD) {
      row.openUntil = Date.now() + _jitter(CIRCUIT_COOLDOWN_MS);
      row.failures = 0;
      console.warn(`[EndpointTransport] Circuit open ${provider}:${transport} (${String(err?.message || err || 'error')})`);
    }
  }

  function shouldBypassProxy(provider, opts = {}) {
    if (opts.forceProxy) return false;
    const state = getProxyState();
    // Global bypass ONLY while the proxy process is down. A stale
    // mode==='bypass' with an expired window + available proxy must NOT
    // bypass — otherwise one 3s proxy-down event sticks every later request
    // to direct forever (sticky bypass). Per-host upstream rejects never set
    // global bypass anymore (see tauri-bridge.js), they demote via circuit.
    if (state.available === false) return true;
    if (state.bypassActive) return true;
    if (state.healthy === false && state.available === false) return true;
    return false;
  }

  async function readJsonPayload(payload) {
    if (!payload) return null;
    if (typeof Response !== 'undefined' && payload instanceof Response) {
      if (!payload.ok) throw new Error(`HTTP ${payload.status}`);
      return payload.json();
    }
    if (typeof payload === 'string') return JSON.parse(payload);
    if (payload && typeof payload.json === 'function' && typeof payload.ok === 'boolean') {
      if (!payload.ok) throw new Error(`HTTP ${payload.status}`);
      return payload.json();
    }
    return payload;
  }

  function bump(provider, transport, ok) {
    const key = `${provider}:${transport}`;
    if (!stats[key]) stats[key] = { ok: 0, fail: 0, lastOk: 0, lastFail: 0, lastError: null };
    const row = stats[key];
    if (ok) {
      row.ok += 1;
      row.lastOk = Date.now();
    } else {
      row.fail += 1;
      row.lastFail = Date.now();
    }
  }

  const sourceState = new Map();
  const domainState = new Map();
  const busEvents = [];
  const BUS_EVENT_MAX = 100;

  function pushBusEvent(evt) {
    busEvents.push(evt);
    if (busEvents.length > BUS_EVENT_MAX) busEvents.shift();
    try {
      window.dispatchEvent(new CustomEvent('endpoint-bus-update', { detail: evt }));
    } catch (_) { }
  }

  function sourceKey(provider, transport, domain) {
    return `${provider}:${transport}:${domain || 'default'}`;
  }

  function updateSourceHealth(provider, transport, domain, ok, meta = {}) {
    const key = sourceKey(provider, transport, domain);
    const now = Date.now();
    if (!sourceState.has(key)) {
      sourceState.set(key, {
        provider,
        transport,
        domain,
        ok: 0,
        fail: 0,
        failures: 0,
        lastOk: 0,
        lastFail: 0,
        lastError: '',
        stale: false,
        staleSince: null,
      });
    }
    const row = sourceState.get(key);
    if (ok) {
      row.ok += 1;
      row.failures = 0;
      row.lastOk = now;
      row.lastError = '';
      row.stale = !!meta.stale;
      row.staleSince = row.stale ? (row.staleSince || now) : null;
    } else {
      row.fail += 1;
      row.failures += 1;
      row.lastFail = now;
      row.lastError = String(meta.error || '');
      if (meta.stale) {
        row.stale = true;
        row.staleSince = row.staleSince || now;
      }
    }
    return row;
  }

  function getDomainTier(domain, provider) {
    if (/kalshi|settlement|market/i.test(String(domain || ''))) return 'critical';
    return providerRole(provider);
  }

  function getCandidatePenalty(provider, transport, domain) {
    const row = sourceState.get(sourceKey(provider, transport, domain)) || null;
    const now = Date.now();
    const base = TRANSPORT_WEIGHT[transport] ?? 10;
    let penalty = base * 10;

    if (row) {
      penalty += row.failures * 25;
      const staleAge = row.lastOk ? (now - row.lastOk) : Number.POSITIVE_INFINITY;
      if (staleAge > SOURCE_STALE_MS) penalty += 120;
      if (row.stale) penalty += 90;
    } else {
      penalty += 10;
    }

    if (!canUseTransport(provider, transport)) penalty += 300;

    if (provider === 'kalshi' && transport === 'wss') {
      const ws = getWsState();
      if (!ws.connected) penalty += 160;
      if (ws.stale) {
        const staleAgeMs = ws.lastMessageTs ? Math.max(0, now - ws.lastMessageTs) : Number.POSITIVE_INFINITY;
        if (staleAgeMs > (WS_STALE_MS + WS_STALE_GRACE_MS)) {
          penalty += 220;
        } else {
          penalty += 55;
        }
      }
    }

    if (transport === 'proxyOrchestrator' || transport === 'supp') {
      const proxy = getProxyState();
      if (proxy.healthy === false || proxy.mode === 'bypass' || proxy.bypassActive) {
        penalty += 140;
      }
    }

    const tier = getDomainTier(domain, provider);
    if (tier === 'critical' && (transport === 'proxyOrchestrator' || transport === 'supp')) {
      penalty += 45;
    }

    return penalty;
  }

  function chooseTransportOrder(provider, chain, domain) {
    const transports = Object.keys(chain).filter((t) => typeof chain[t] === 'function');
    const scored = transports
      .map((transport) => ({ transport, score: getCandidatePenalty(provider, transport, domain) }))
      .sort((a, b) => a.score - b.score);
    return scored.map((item) => item.transport);
  }

  function evaluateKalshiWssStability(wsState = {}) {
    const now = Date.now();
    const connected = !!wsState.connected;
    const stale = !!wsState.stale;
    const lastMessageTs = Number(wsState.lastMessageTs || 0);
    const staleAgeMs = lastMessageTs ? Math.max(0, now - lastMessageTs) : Number.POSITIVE_INFINITY;

    if (!connected) {
      kalshiWssStability.staleWindows = 0;
      kalshiWssStability.staleSince = 0;
      kalshiWssStability.healthySince = 0;
      kalshiWssStability.demoted = true;
      kalshiWssStability.lastDemoteTs = now;
      return {
        connected: false,
        stale,
        staleAgeMs,
        shouldDemote: true,
        shouldPromote: false,
        demoted: true,
      };
    }

    if (stale) {
      kalshiWssStability.staleWindows += 1;
      kalshiWssStability.staleSince = kalshiWssStability.staleSince || now;
      kalshiWssStability.healthySince = 0;
      const staleForMs = now - kalshiWssStability.staleSince;
      const enoughWindows = kalshiWssStability.staleWindows >= WSS_STALE_CONFIRM_WINDOWS;
      const enoughDuration = staleForMs >= WSS_STALE_DEMOTE_MIN_MS;
      const demotionCooldownDone = (now - kalshiWssStability.lastDemoteTs) >= WSS_DEMOTION_COOLDOWN_MS;
      const shouldDemote = (enoughWindows || enoughDuration) && demotionCooldownDone;
      if (shouldDemote) {
        kalshiWssStability.demoted = true;
        kalshiWssStability.lastDemoteTs = now;
      }
      return {
        connected: true,
        stale: true,
        staleAgeMs,
        staleWindows: kalshiWssStability.staleWindows,
        staleForMs,
        shouldDemote,
        shouldPromote: false,
        demoted: kalshiWssStability.demoted,
      };
    }

    kalshiWssStability.staleWindows = 0;
    kalshiWssStability.staleSince = 0;
    kalshiWssStability.healthySince = kalshiWssStability.healthySince || now;
    const stableForMs = now - kalshiWssStability.healthySince;
    const shouldPromote = kalshiWssStability.demoted && stableForMs >= WSS_REPROMOTE_STABLE_MS;
    if (shouldPromote) kalshiWssStability.demoted = false;

    return {
      connected: true,
      stale: false,
      staleAgeMs,
      stableForMs,
      shouldDemote: false,
      shouldPromote,
      demoted: kalshiWssStability.demoted,
    };
  }

  function logKalshiWsDecision(decision, details = {}) {
    try {
      const now = Date.now();
      const key = `${decision}:${String(details.reason || '')}:${String(details.reconnectAttempts || '')}:${String(details.staleWindows || '')}`;
      if (key === lastKalshiDecisionKey && (now - lastKalshiDecisionTs) < 20_000) return;
      lastKalshiDecisionKey = key;
      lastKalshiDecisionTs = now;
      console.info('[EndpointTransport] Kalshi WSS decision', {
        decision,
        ts: now,
        ...details,
      });
    } catch (_) { }
  }

  function shouldAttemptKalshiWsRecovery(reason) {
    const now = Date.now();
    if (!kalshiRecoveryWindowStartTs || (now - kalshiRecoveryWindowStartTs) > WSS_RECOVERY_WINDOW_MS) {
      kalshiRecoveryWindowStartTs = now;
      kalshiRecoveryAttemptsInWindow = 0;
    }
    if (kalshiRecoveryAttemptsInWindow >= WSS_RECOVERY_MAX_ATTEMPTS) {
      logKalshiWsDecision('recovery-skipped-bounded', {
        reason,
        attemptsInWindow: kalshiRecoveryAttemptsInWindow,
        windowMs: WSS_RECOVERY_WINDOW_MS,
      });
      return false;
    }
    kalshiRecoveryAttemptsInWindow += 1;
    return true;
  }

  function updateDomainSelection(domain, selected, reason) {
    if (!domain) return;
    const now = Date.now();
    const prev = domainState.get(domain) || { selected: '', ts: 0, reason: '' };
    if (prev.selected !== selected) {
      domainState.set(domain, { selected, ts: now, reason: reason || 'rebalance' });
      try {
        window.dispatchEvent(new CustomEvent('endpoint-coordination-update', {
          detail: { domain, selected, previous: prev.selected, ts: now, reason: reason || 'rebalance' },
        }));
      } catch (_) { }
    } else {
      domainState.set(domain, { ...prev, ts: now, reason: reason || prev.reason || '' });
    }
  }

  function summarizeCoordinator() {
    const domains = {};
    for (const [domain, row] of domainState.entries()) {
      domains[domain] = { ...row };
    }
    const sources = {};
    for (const [key, row] of sourceState.entries()) {
      sources[key] = { ...row };
    }
    return {
      domains,
      sources,
      recentEvents: [...busEvents],
    };
  }

  function summarizeStats() {
    const byKey = {};
    for (const [key, row] of Object.entries(stats)) {
      byKey[key] = { ...row };
    }
    const preferred = {};
    for (const provider of ['kalshi', 'binance', 'pyth', 'generic']) {
      for (const transport of PRIORITY) {
        const row = stats[`${provider}:${transport}`];
        if (!row) continue;
        if (row.ok > 0 && row.lastOk >= (row.lastFail || 0)) {
          preferred[provider] = transport;
          break;
        }
      }
    }
    const wsState = getWsState();
    if (wsState.connected && !wsState.stale) {
      preferred.kalshi = 'wss';
    }
    return {
      byKey,
      preferred,
      priority: PRIORITY,
      lastSync: lastTransportEventTs || lastWsActivityTs || Date.now(),
      policy: {
        providerRole: { ...PROVIDER_ROLE },
        roleOrder: {
          critical: [...ROLE_ORDER.critical],
          optional: [...ROLE_ORDER.optional],
        },
      },
      proxy: getProxyState(),
      ws: {
        connected: !!wsState.connected,
        stale: !!wsState.stale,
        suspended: !!wsState.suspended,
        suspendUntil: wsState.suspendUntil || null,
        suspendInMs: wsState.suspendInMs || 0,
        suspendReason: wsState.suspendReason || '',
        suspendLevel: wsState.suspendLevel || 0,
        reconnectAttempts: wsState.reconnectAttempts || 0,
        reconnectInMs: wsState.reconnectInMs || 0,
        lastMessageTs: wsState.lastMessageTs || null,
        lastCloseReason: wsState.lastCloseReason || '',
        lastError: wsState.lastError || '',
        lastFailureClass: wsState.lastFailureClass || '',
        lastDemoteReason: lastKalshiDemoteReason || '',
        lastConnectAttempt: wsState.lastConnectAttempt || null,
        lastConnectAttemptResult: wsState.lastConnectAttempt?.status || '',
        lastAuthStatus: wsState.lastAuthStatus || '',
        lastAuthError: wsState.lastAuthError || '',
        lastHandshakeStatus: wsState.lastHandshakeStatus || '',
        lastHandshakeError: wsState.lastHandshakeError || '',
        lastIssueBucket: wsState.lastIssueBucket || '',
        lastIssueReason: wsState.lastIssueReason || '',
      },
      route: {
        reason: lastRouteChangeReason,
        ts: lastRouteChangeTs || null,
      },
      bus: summarizeBus(),
      coordination: summarizeCoordinator(),
    };
  }

  function scheduleTransportHealthSync() {
    if (transportSyncTimer) return;
    transportSyncTimer = setTimeout(() => {
      transportSyncTimer = null;
      try {
        window.NetworkHealth?.updateTransport?.(summarizeStats());
      } catch (_) { }
    }, 400);
  }

  function record(provider, transport, ok, err, domain = '') {
    bump(provider, transport, ok);
    updateSourceHealth(provider, transport, domain || `${provider}-default`, ok, {
      error: err ? String(err.message || err) : '',
    });
    lastTransportEventTs = Date.now();
    if (!ok && err && stats[`${provider}:${transport}`]) {
      stats[`${provider}:${transport}`].lastError = String(err.message || err);
    }
    scheduleTransportHealthSync();
    try {
      const bucketMeta = err ? _classifyTransportBucket(err, provider, transport) : { bucket: 'unknown', bucketReason: '' };
      window.NetworkLog?.record?.(ok ? 'TRANSPORT_OK' : 'TRANSPORT_FAIL', {
        url: `${provider}://${transport}`,
        error: err ? String(err.message || err) : '',
        provider,
        bucket: bucketMeta.bucket,
        bucketReason: bucketMeta.bucketReason,
      });
    } catch (_) { }
  }

  async function httpFetchJson(url, opts = {}, provider = 'generic', domain = '') {
    const retries = Number.isFinite(opts.retries) ? Math.max(0, opts.retries) : 2;
    let lastErr = null;
    const bypassProxy = shouldBypassProxy(provider, opts);
    const role = providerRole(provider);
    const order = ROLE_ORDER[role] || ROLE_ORDER.optional;
    const attempts = [];

    if (order.includes('direct')) {
      attempts.push({
        transport: 'direct',
        run: async () => {
          const res = await fetch(url, { headers: { Accept: 'application/json' }, ...opts });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        },
      });
    }
    if (order.includes('ipc')) {
      attempts.push({
        transport: 'ipc',
        run: async () => {
          if (!window.electron?.ipcFetch) throw new Error('ipc unavailable');
          const r = await window.electron.ipcFetch(url, opts);
          if (!r.ok) throw new Error(`HTTP ${r.status || 0}${r.error ? ` ${r.error}` : ''}`);
          return typeof r.text === 'string' ? JSON.parse(r.text) : r.text;
        },
      });
    }
    if (!bypassProxy && order.includes('supp')) {
      attempts.push({
        transport: 'supp',
        run: async () => {
          if (typeof window.suppFetch !== 'function') throw new Error('supp unavailable');
          return readJsonPayload(await window.suppFetch(url, opts));
        },
      });
    }
    if (!bypassProxy && order.includes('proxyOrchestrator')) {
      attempts.push({
        transport: 'proxyOrchestrator',
        run: async () => {
          if (typeof window._proxyOrchestrator === 'undefined' || !window._proxyOrchestrator) {
            throw new Error('proxy orchestrator unavailable');
          }
          return window._proxyOrchestrator.fetch(url, {
            endpoint: opts.endpoint || 'kalshi-markets-legacy',
            cacheType: opts.cacheType || 'market-data',
            fallbackChain: opts.fallbackChain || ['polymarket', 'kalshi', 'cache'],
          });
        },
      });
    }

    if (!attempts.length) throw new Error('no transport attempts available');

    // WSS → gRPC → RPC → HTTP is enforced at fetchWithPriority level. Within
    // the HTTP leg, CF-protected hosts must try proxy legs (supp /
    // proxyOrchestrator) before direct — direct is doomed at the CF edge.
    // Apply a penalty bonus so the generic penalty sort can't reorder direct
    // ahead of the proxy for those hosts.
    const cfProtected = CF_PROTECTED_HOSTS.has(_hostOf(url));
    const ordered = attempts
      .map((entry) => {
        let score = getCandidatePenalty(provider, entry.transport, domain || `${provider}-http`);
        if (cfProtected && (entry.transport === 'supp' || entry.transport === 'proxyOrchestrator')) {
          score -= 100;
        }
        return { ...entry, score };
      })
      .sort((a, b) => a.score - b.score);

    // Global provider cool-down (set after 429) — fail fast without hammering more routes
    const coolLeft = _providerRateLimitRemaining(provider);
    if (coolLeft > 0) {
      throw new Error(`HTTP 429 (cooling ${coolLeft}ms)`);
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        for (const route of ordered) {
          if (!canUseTransport(provider, route.transport)) continue;
          try {
            const payload = await route.run();
            markTransportOutcome(provider, route.transport, true);
            record(provider, route.transport, true, null, domain || `${provider}-http`);
            updateDomainSelection(domain || `${provider}-http`, `${provider}:${route.transport}`, 'http-success');
            return payload;
          } catch (err) {
            lastErr = err;
            markTransportOutcome(provider, route.transport, false, err);
            record(provider, route.transport, false, err, domain || `${provider}-http`);
            console.warn(`[EndpointTransport] ${route.transport} failed:`, err?.message || err);
            // 429: trip provider cool-down and STOP trying more routes/retries
            if (_isRateLimitError(err)) {
              _markProviderRateLimited(provider, err);
              throw err;
            }
          }
        }
        throw lastErr || new Error('all transport attempts failed');
      } catch (err) {
        lastErr = err;
        if (_isRateLimitError(err)) throw err;
        if (attempt < retries && _isTransientError(err)) {
          await _sleep(_jitter(250 * (2 ** attempt)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('httpFetchJson failed');
  }

  async function rpcKalshiMarket(_ctx) {
    return null; // Kalshi disabled
  }

  function _unwrapKalshiMarketsPayload(root) {
    if (!root || typeof root !== 'object') return null;
    // Walk: ipc {data:{success,data:{markets}}} or worker {success,data:{markets}} or {markets}
    let cur = root;
    for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
      if (Array.isArray(cur.markets)) return { markets: cur.markets, cursor: cur.cursor };
      if (Array.isArray(cur)) return { markets: cur };
      if (cur.data != null) { cur = cur.data; continue; }
      break;
    }
    return null;
  }

  async function rpcKalshiMarkets(_ctx) {
    return { markets: [] }; // Kalshi disabled — body retained below unreachable after early return
    const q = new URLSearchParams();
    if (_ctx.series_ticker) q.set('series_ticker', _ctx.series_ticker);
    if (_ctx.status) q.set('status', _ctx.status);
    q.set('limit', String(_ctx.limit || 500));

    if (window.electron?.invoke) {
      const ipc = await window.electron.invoke('kalshi:markets', {
        series_ticker: _ctx.series_ticker,
        status: _ctx.status,
        limit: _ctx.limit || 25,
      });
      if (ipc && (ipc.status === 429 || /429|rate.?limit/i.test(String(ipc.error || ipc.data?.error || '')))) {
        throw new Error('IPC HTTP 429');
      }
      const unwrapped = _unwrapKalshiMarketsPayload(ipc);
      if (unwrapped) return unwrapped; // may be empty markets — caller handles
      if (ipc?.success === false) {
        throw new Error(ipc.error || ipc.data?.error || `IPC markets failed (${ipc.status || 0})`);
      }
    }

    const coolLeft = _providerRateLimitRemaining('kalshi');
    if (coolLeft > 0) throw new Error(`HTTP 429 (cooling ${coolLeft}ms)`);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => {
      try {
        controller.abort(new DOMException('Kalshi RPC markets timed out after 8000ms', 'TimeoutError'));
      } catch (_) {
        try { controller.abort(); } catch (_) { }
      }
    }, 20000) : null;
    try {
      // Unreachable with empty worker URL; left for structure until full delete
      const res = await fetch(`${KALSHI_WORKER_URL}/markets?${q}`, {
        signal: controller ? controller.signal : undefined,
        headers: { Accept: 'application/json' },
      });
      if (res.status === 429) throw new Error('Worker HTTP 429');
      if (!res.ok) throw new Error(`Worker HTTP ${res.status}`);
      const envelope = await res.json();
      if (envelope?.success === false) {
        if (/429|rate/i.test(String(envelope.error || ''))) throw new Error('HTTP 429');
        throw new Error(envelope.error || 'worker markets failed');
      }
      const unwrapped = _unwrapKalshiMarketsPayload(envelope);
      if (unwrapped) return unwrapped;
      const payload = envelope?.data ?? envelope;
      if (payload?.markets) return payload;
      return payload;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function grpcBinanceKlines(ctx) {
    if (typeof window.grpcBinanceHandler !== 'function') return null;
    return window.grpcBinanceHandler(ctx, 'binance-grpc');
  }

  const providers = {
    kalshi: {
      async wss(ctx) {
        const ws = window.KalshiWS;
        const wsState = ws?.getState?.() || {};
        const domain = ctx.domain || 'kalshi-market-stream';
        const staleAgeMs = wsState.lastMessageTs ? Math.max(0, Date.now() - wsState.lastMessageTs) : Number.POSITIVE_INFINITY;
        if (!wsState.connected) {
          updateSourceHealth('kalshi', 'wss', domain, false, { error: 'wss disconnected', stale: true });
          return null;
        }
        if (wsState.stale && staleAgeMs > (WS_STALE_MS + WS_STALE_GRACE_MS)) {
          updateSourceHealth('kalshi', 'wss', domain, false, { error: 'wss stale', stale: true });
          return null;
        }
        const snap = ws.getSnapshot?.() || ws.store;
        const tickers = snap?.tickers || {};
        const want = ctx.market_ticker;
        if (want && tickers[want]) {
          const t = tickers[want];
          if (Date.now() - (t.ts || 0) > WS_STALE_MS) {
            updateSourceHealth('kalshi', 'wss', domain, false, { error: 'ticker stale', stale: true });
            return null;
          }
          return { transport: 'wss', ticker: want, tick: t };
        }
        return null;
      },
      rpc: (ctx) => (ctx.market_ticker ? rpcKalshiMarket(ctx) : rpcKalshiMarkets(ctx)),
      http: (ctx) => httpFetchJson(ctx.url, ctx.opts || {}, 'kalshi', ctx.domain || 'kalshi-markets'),
    },

    binance: {
      grpc: grpcBinanceKlines,
      http: (ctx) => httpFetchJson(ctx.url, ctx.opts || {}, 'binance', ctx.domain || 'binance-feed'),
    },
    pyth: {
      http: (ctx) => httpFetchJson(ctx.url, ctx.opts || {}, 'pyth', ctx.domain || 'pyth-feed'),
    },
    generic: {
      http: (ctx) => httpFetchJson(ctx.url, ctx.opts || {}, 'generic', ctx.domain || 'generic-feed'),
    },
  };

  async function fetchWithPriority(provider, ctx = {}) {
    const chain = providers[provider] || providers.generic;
    const domain = ctx.domain || `${provider}-default`;
    const coolLeft = _providerRateLimitRemaining(provider);
    if (coolLeft > 0) {
      return null; // fail soft while rate-limited
    }
    const orderedTransports = chooseTransportOrder(provider, chain, domain);
    for (const transport of orderedTransports) {
      const fn = chain[transport];
      if (typeof fn !== 'function') continue;
      if (!canUseTransport(provider, transport)) continue;
      try {
        const result = await fn({ ...ctx, domain });
        if (result != null) {
          record(provider, transport, true, null, domain);
          updateDomainSelection(domain, `${provider}:${transport}`, 'success');
          pushBusEvent({
            type: 'source-update',
            provider,
            transport,
            domain,
            ts: Date.now(),
            ok: true,
          });
          return { data: result, transport, provider, domain };
        }
      } catch (err) {
        record(provider, transport, false, err, domain);
        pushBusEvent({
          type: 'source-update',
          provider,
          transport,
          domain,
          ts: Date.now(),
          ok: false,
          error: String(err?.message || err || ''),
        });
        // Don't cascade 429 across rpc→http→orchestrator — one reject is enough
        if (_isRateLimitError(err)) {
          _markProviderRateLimited(provider, err);
          return null;
        }
      }
    }
    return null;
  }

  async function fetchKalshiMarket(ticker, opts = {}) {
    return null;
  }

  async function fetchKalshiMarkets(params = {}) {
    return { markets: [] };
  }

  function ensureKalshiWs(opts = {}) {
    return;
  }

  function subscribeKalshiMarketTickers(tickers) {
    return;
  }

  function notePolymarketWsActivity() {
    lastWsActivityTs = Date.now();
    lastTransportEventTs = lastWsActivityTs;
    bump('polymarket', 'wss', true);
    updateSourceHealth('polymarket', 'wss', 'polymarket-market-stream', true, { stale: false });
    updateDomainSelection('polymarket-market-stream', 'polymarket:wss', 'wss-activity');
    pushBusEvent({
      type: 'stream-update',
      provider: 'polymarket',
      transport: 'wss',
      domain: 'polymarket-market-stream',
      ts: lastWsActivityTs,
      ok: true,
    });
    scheduleTransportHealthSync();
  }

  function handleRouteChange(event) {
    const detail = event?.detail || {};
    const failureClass = String(detail.failureClass || '');
    const routeHint = String(detail.routeHint || '');
    const reasonRaw = String(detail.reason || detail.stage || 'route-change');
    const reasonWithClass = failureClass ? `${reasonRaw}:${failureClass}` : reasonRaw;
    lastRouteChangeReason = routeHint ? `${reasonWithClass}:${routeHint}` : reasonWithClass;
    lastRouteChangeTs = Date.now();
    const stage = String(detail.stage || '');
    if (stage === 'network-failure') {
      updateSourceHealth('localproxy', 'proxyOrchestrator', 'proxy-transport', false, {
        stale: false,
        error: `proxy-${lastRouteChangeReason}`,
      });
    }
    scheduleTransportHealthSync();
  }

  const busConfig = [
    {
      id: 'polymarket-ws-state',
      provider: 'polymarket',
      transport: 'wss',
      domain: 'polymarket-market-stream',
      intervalMs: 5_000,
      poll: async () => {
        const polyWs = window.PolymarketWS;
        const st = polyWs?.getStatus?.() || {};
        if (!st.clobConnected && !st.rtdsConnected) {
          throw new Error('Polymarket WS connecting');
        }
        return {
          clobConnected: !!st.clobConnected,
          rtdsConnected: !!st.rtdsConnected,
          feeds: st.subscribedAssetsCount || 0,
        };
      },
    },
    {
      id: 'local-proxy-state',
      provider: 'localproxy',
      transport: 'proxyOrchestrator',
      domain: 'proxy-transport',
      intervalMs: 8_000,
      poll: async () => {
        const p = getProxyState();
        if (!p || Object.keys(p).length === 0) throw new Error('proxy state unavailable');
        // DEGRADED only when the proxy process is down. A short per-request
        // bypass with a live proxy is healthy+fallback, not a bus error —
        // otherwise the bus flaps LocalProxy DEGRADED every 8s during the
        // old 20s global bypass window.
        if (p.available === false) throw new Error('proxy degraded');
        if (p.healthy === false && p.available === false) throw new Error('proxy degraded');
        return {
          mode: p.mode || 'unknown',
          healthy: p.healthy !== false && p.available !== false,
          bypassActive: !!p.bypassActive,
          failures: Number(p.failures || 0),
        };
      },
    },
  ];

  const busState = {
    endpoints: {},
    lastEventTs: 0,
    updates: 0,
    errors: 0,
  };
  for (const cfg of busConfig) {
    busState.endpoints[cfg.id] = {
      provider: cfg.provider,
      transport: cfg.transport,
      domain: cfg.domain,
      intervalMs: cfg.intervalMs,
      lastOk: null,
      lastFail: null,
      stale: false,
      failures: 0,
      lastError: '',
      sample: null,
    };
  }

  async function pollBusEndpoint(cfg) {
    const row = busState.endpoints[cfg.id];
    const now = Date.now();
    try {
      const sample = await cfg.poll();
      row.lastOk = now;
      row.stale = false;
      row.failures = 0;
      row.lastError = '';
      row.sample = sample;
      busState.lastEventTs = now;
      busState.updates += 1;
      updateSourceHealth(cfg.provider, cfg.transport, cfg.domain, true, { stale: false });
      updateDomainSelection(cfg.domain, `${cfg.provider}:${cfg.transport}`, 'bus-poll-ok');
      pushBusEvent({
        type: 'ingest-update',
        endpointId: cfg.id,
        provider: cfg.provider,
        transport: cfg.transport,
        domain: cfg.domain,
        ts: now,
        sample,
      });
    } catch (err) {
      row.lastFail = now;
      row.failures += 1;
      row.lastError = String(err?.message || err || 'poll failed');
      row.stale = true;
      busState.lastEventTs = now;
      busState.errors += 1;
      updateSourceHealth(cfg.provider, cfg.transport, cfg.domain, false, {
        stale: true,
        error: row.lastError,
      });
      pushBusEvent({
        type: 'ingest-error',
        endpointId: cfg.id,
        provider: cfg.provider,
        transport: cfg.transport,
        domain: cfg.domain,
        ts: now,
        error: row.lastError,
      });
    } finally {
      scheduleTransportHealthSync();
    }
  }

  function effectiveBusIntervalMs(cfg, row) {
    const base = Number(cfg.intervalMs || 30000);
    const failures = Math.max(0, Number(row?.failures || 0));
    if (!failures) return base;
    const lastError = String(row?.lastError || '').toLowerCase();
    const authOrReject = /401|403|unauthorized|forbidden/.test(lastError);
    const maxBackoff = authOrReject ? 15 * 60_000 : 5 * 60_000;
    return Math.min(maxBackoff, base * Math.pow(2, Math.min(5, failures)));
  }

  function ensureIngestionBus() {
    if (busPollTimer) return;
    busPollTimer = setInterval(() => {
      for (const cfg of busConfig) {
        const row = busState.endpoints[cfg.id];
        const now = Date.now();
        const lastTs = Math.max(row.lastOk || 0, row.lastFail || 0);
        if (!lastTs || now - lastTs >= effectiveBusIntervalMs(cfg, row)) {
          pollBusEndpoint(cfg);
        }
      }
    }, 1000);
  }

  function summarizeBus() {
    return {
      lastEventTs: busState.lastEventTs || null,
      updates: busState.updates,
      errors: busState.errors,
      endpoints: { ...busState.endpoints },
    };
  }

  function ensureTransportPulse() {
    if (transportPulseTimer) return;
    transportPulseTimer = setInterval(() => {
      try {
        const polyWs = window.PolymarketWS;
        const st = polyWs?.getStatus?.() || {};
        const connected = !!(st.clobConnected || st.rtdsConnected);
        updateSourceHealth('polymarket', 'wss', 'polymarket-market-stream', connected, {
          stale: !connected,
          error: connected ? '' : 'ws connecting',
        });
        updateDomainSelection('polymarket-market-stream', connected ? 'polymarket:wss' : 'polymarket:http', connected ? 'wss-live' : 'http-fallback');
      } catch (_) { }
      scheduleTransportHealthSync();
    }, 5_000);
  }

  function transportLikelyHealthy(provider, transport) {
    const row = stats[`${provider}:${transport}`];
    if (!row) return false;
    if ((row.ok || 0) <= 0) return false;
    const lastOk = Number(row.lastOk || 0);
    const lastFail = Number(row.lastFail || 0);
    if (!lastOk || (Date.now() - lastOk) > HEALTHY_OK_MAX_AGE_MS) return false;
    return lastOk >= lastFail;
  }

  ensureIngestionBus();
  ensureTransportPulse();

  if (typeof window !== 'undefined') {
    window.addEventListener('polymarket:tick', notePolymarketWsActivity);
    window.addEventListener('polymarket:book', notePolymarketWsActivity);
    window.addEventListener('proxy-route-change', handleRouteChange);
  }

  window.EndpointTransport = {
    PRIORITY,
    fetchWithPriority,
    fetchKalshiMarket,
    fetchKalshiMarkets,
    httpFetchJson,
    ensureKalshiWs,
    subscribeKalshiMarketTickers,
    notePolymarketWsActivity,
    summarizeStats,
    summarizeBus,
    summarizeCoordinator,
    markProviderRateLimited: _markProviderRateLimited,
    isProviderRateLimited: (provider) => _providerRateLimitRemaining(provider) > 0,
    getStats: () => ({ ...stats }),
    getSourceState: () => {
      const out = {};
      for (const [key, row] of sourceState.entries()) out[key] = { ...row };
      return out;
    },
  };
})();
