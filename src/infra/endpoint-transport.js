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
  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const KALSHI_WORKER_URL = 'http://127.0.0.1:3050';
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
    kalshi: 'critical',
    pyth: 'critical',
    binance: 'optional',
    generic: 'optional',
    localproxy: 'optional',
  };
  const ROLE_ORDER = {
    // Critical domains now prefer direct/API paths first; proxy is fallback transport.
    critical: ['direct', 'ipc', 'supp', 'proxyOrchestrator'],
    optional: ['direct', 'ipc', 'supp', 'proxyOrchestrator'],
  };
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
    if (/browser websocket cannot send|requires node ws|credential|crypto unavailable|signature generation|kalshi-api-key\.txt not found|auth-header-failed/.test(text)) {
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
    if (/stale[-\s]*watchdog|demote|hysteresis|scheduler|circuit|oscillat|internal/.test(text)) {
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
    const role = providerRole(provider);
    if (state.mode === 'bypass' || state.bypassActive) return true;
    if (role === 'optional' && state.healthy === false) return true;
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
            fallbackChain: opts.fallbackChain || ['kalshi', 'cache'],
          });
        },
      });
    }

    if (!attempts.length) throw new Error('no transport attempts available');

    const ordered = attempts
      .map((entry) => ({ ...entry, score: getCandidatePenalty(provider, entry.transport, domain || `${provider}-http`) }))
      .sort((a, b) => a.score - b.score);

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
          }
        }
        throw lastErr || new Error('all transport attempts failed');
      } catch (err) {
        lastErr = err;
        if (attempt < retries && _isTransientError(err)) {
          await _sleep(_jitter(250 * (2 ** attempt)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('httpFetchJson failed');
  }

  async function rpcKalshiMarket(ctx) {
    const ticker = ctx.market_ticker;
    if (!ticker) return null;
    const url = `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`;

    if (window.electron?.ipcFetch) {
      const r = await window.electron.ipcFetch(url, ctx.opts || {});
      if (r.ok) {
        return typeof r.text === 'string' ? JSON.parse(r.text) : r.text;
      }
      throw new Error(r.error || `IPC HTTP ${r.status || 0}`);
    }

    return null;
  }

  async function rpcKalshiMarkets(ctx) {
    const q = new URLSearchParams();
    if (ctx.series_ticker) q.set('series_ticker', ctx.series_ticker);
    if (ctx.status) q.set('status', ctx.status);
    q.set('limit', String(ctx.limit || 500));

    if (window.electron?.invoke) {
      const ipc = await window.electron.invoke('kalshi:markets', {
        series_ticker: ctx.series_ticker,
        status: ctx.status,
        limit: ctx.limit || 25,
      });
      if (ipc?.success && ipc.data) {
        const envelope = ipc.data;
        const payload = envelope?.data ?? envelope;
        if (payload?.markets) return payload;
        if (Array.isArray(payload)) return { markets: payload };
      }
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => {
      try {
        controller.abort(new DOMException('Kalshi RPC markets timed out after 8000ms', 'TimeoutError'));
      } catch (_) {
        try { controller.abort(); } catch (_) { }
      }
    }, 20000) : null;
    try {
      const res = await fetch(`${KALSHI_WORKER_URL}/markets?${q}`, {
        signal: controller ? controller.signal : undefined,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Worker HTTP ${res.status}`);
      const envelope = await res.json();
      if (envelope?.success === false) throw new Error(envelope.error || 'worker markets failed');
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
      }
    }
    return null;
  }

  async function fetchKalshiMarket(ticker, opts = {}) {
    if (!ticker) return null;
    const url = `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`;
    return fetchWithPriority('kalshi', {
      domain: 'kalshi-settlement',
      market_ticker: ticker,
      url,
      opts: {
        endpoint: 'kalshi-settlement',
        cacheType: 'settlement',
        fallbackChain: ['kalshi', 'cache'],
        ...opts,
      },
    });
  }

  async function fetchKalshiMarkets(params = {}) {
    const q = new URLSearchParams();
    if (params.series_ticker) q.set('series_ticker', params.series_ticker);
    if (params.status) q.set('status', params.status);
    q.set('limit', String(params.limit || 500));
    const url = `${KALSHI_BASE}/markets?${q}`;
    const hit = await fetchWithPriority('kalshi', {
      domain: 'kalshi-markets',
      url,
      ...params,
      opts: { endpoint: 'kalshi-markets', cacheType: 'market-data' },
    });
    if (hit?.data && typeof hit.data === 'object') {
      hit.data._transport = hit.transport;
      hit.data._domain = 'kalshi-markets';
    }
    return hit?.data ?? null;
  }

  function ensureKalshiWs(opts = {}) {
    const ws = window.KalshiWS;
    if (!ws?.connect) return;
    const reason = String(opts.reason || 'ensure');
    const st = ws.getState?.();
    if (opts.force && ws.reconnectNow) {
      if (ws.forceRetry && st?.suspended) {
        ws.forceRetry(reason);
        return;
      }
      logKalshiWsDecision('force-reconnect', {
        reason,
        reconnectAttempts: st?.reconnectAttempts || 0,
        connected: !!st?.connected,
        stale: !!st?.stale,
        suspended: !!st?.suspended,
        suspendInMs: st?.suspendInMs || 0,
        connecting: !!st?.connecting,
      });
      ws.reconnectNow(reason);
      return;
    }
    if (st?.connecting && (st.connectingForMs || 0) > 25_000 && ws.reconnectNow) {
      logKalshiWsDecision('connecting-timeout-reset', {
        reason,
        connectingForMs: st.connectingForMs,
      });
      ws.reconnectNow(`connect-hung:${reason}`);
      return;
    }
    if (st?.connected && !st?.stale) return;
    if (st?.suspended) {
      logKalshiWsDecision('connect-skipped-suspended', {
        reason,
        suspendInMs: st.suspendInMs || 0,
        suspendReason: st.suspendReason || '',
      });
      scheduleTransportHealthSync();
      return;
    }
    logKalshiWsDecision('connect-attempt', {
      reason,
      connected: !!st?.connected,
      stale: !!st?.stale,
      reconnectAttempts: st?.reconnectAttempts || 0,
      lastConnectAttempt: st?.lastConnectAttempt?.status || '',
    });
    ws.connect({ reason }).then(() => {
      console.log('[EndpointTransport] Kalshi WSS connected');
      logKalshiWsDecision('connect-success', {
        reason,
        reconnectAttempts: ws.getState?.()?.reconnectAttempts || 0,
      });
      updateSourceHealth('kalshi', 'wss', 'kalshi-market-stream', true, { stale: false });
      scheduleTransportHealthSync();
    }).catch(err => {
      console.warn('[EndpointTransport] Kalshi WSS connect failed:', err?.message || err);
      logKalshiWsDecision('connect-failed', {
        reason,
        error: String(err?.message || err || 'connect failed'),
        reconnectAttempts: ws.getState?.()?.reconnectAttempts || 0,
      });
      updateSourceHealth('kalshi', 'wss', 'kalshi-market-stream', false, {
        stale: true,
        error: String(err?.message || err || 'connect failed'),
      });
      scheduleTransportHealthSync();
    });
  }

  function subscribeKalshiMarketTickers(tickers) {
    const list = (Array.isArray(tickers) ? tickers : []).filter(Boolean);
    if (!list.length) return;
    window._kalshiActiveMarkets = list;
    const ws = window.KalshiWS;
    if (ws?.subscribeMarkets) ws.subscribeMarkets(list);
    scheduleTransportHealthSync();
  }

  function noteKalshiWsActivity() {
    lastWsActivityTs = Date.now();
    lastTransportEventTs = lastWsActivityTs;
    bump('kalshi', 'wss', true);
    updateSourceHealth('kalshi', 'wss', 'kalshi-market-stream', true, { stale: false });
    updateDomainSelection('kalshi-market-stream', 'kalshi:wss', 'wss-activity');
    pushBusEvent({
      type: 'stream-update',
      provider: 'kalshi',
      transport: 'wss',
      domain: 'kalshi-market-stream',
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
    const proxied = String(detail.proxied || '').toLowerCase();
    const reason = String(detail.reason || '').toLowerCase();
    const provider = String(detail.provider || '').toLowerCase();
    const wsState = getWsState();
    const kalshiScoped = provider === 'kalshi' || proxied.includes('/kalshi') || reason.includes('kalshi');
    const now = Date.now();
    const canForceRecovery = (now - lastKalshiRouteRecoveryTs) > 12_000;

    // Route churn from optional providers should never flap Kalshi WSS.
    if ((stage === 'reinit-done' || stage === 'route-error') && kalshiScoped && canForceRecovery) {
      lastKalshiRouteRecoveryTs = now;
      console.info(`[EndpointTransport] Route churn recovery (${lastRouteChangeReason})`);
      ensureKalshiWs({ force: true, reason: `route:${lastRouteChangeReason}` });
    }

    if (!kalshiScoped && stage === 'network-failure') {
      updateSourceHealth('localproxy', 'proxyOrchestrator', 'proxy-transport', false, {
        stale: false,
        error: `non-kalshi-${lastRouteChangeReason}`,
      });
    }
    scheduleTransportHealthSync();
  }

  const busConfig = [
    {
      id: 'kalshi-wss-state',
      provider: 'kalshi',
      transport: 'wss',
      domain: 'kalshi-market-stream',
      intervalMs: 5_000,
      poll: async () => {
        const ws = getWsState();
        const stale = !ws.connected || !!ws.stale;
        if (stale) throw new Error(ws.connected ? 'kalshi wss stale' : 'kalshi wss disconnected');
        return {
          connected: !!ws.connected,
          stale: !!ws.stale,
          tickers: ws.tickers || 0,
          lastMessageTs: ws.lastMessageTs || null,
        };
      },
    },
    {
      id: 'kalshi-rpc-markets',
      provider: 'kalshi',
      transport: 'rpc',
      domain: 'kalshi-markets',
      intervalMs: 18_000,
      poll: async () => {
        const payload = await rpcKalshiMarkets({ status: 'open', limit: 500 });
        const markets = Array.isArray(payload?.markets) ? payload.markets : [];
        return { marketCount: markets.length };
      },
    },
    {
      id: 'kalshi-http-markets',
      provider: 'kalshi',
      transport: 'http',
      domain: 'kalshi-markets',
      intervalMs: 30_000,
      poll: async () => {
        const payload = await httpFetchJson(
          `${KALSHI_BASE}/markets?limit=500&status=open`,
          { endpoint: 'kalshi-markets', cacheType: 'market-data', retries: 0 },
          'kalshi',
          'kalshi-markets',
        );
        const markets = Array.isArray(payload?.markets) ? payload.markets : [];
        return { marketCount: markets.length };
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
        if (p.healthy === false && p.mode !== 'proxy') throw new Error('proxy degraded');
        return {
          mode: p.mode || 'unknown',
          healthy: p.healthy !== false,
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
        const ws = getWsState();
        const stability = evaluateKalshiWssStability(ws);
        const streamFallback = selectKalshiStreamFallback();
        if (!stability.connected) {
          kalshiDemotedSinceTs = kalshiDemotedSinceTs || Date.now();
          updateSourceHealth('kalshi', 'wss', 'kalshi-market-stream', false, {
            stale: true,
            error: 'wss disconnected',
          });
          const demoteReason = `wss-disconnected-demote:${streamFallback.reason}`;
          lastKalshiDemoteReason = demoteReason;
          updateDomainSelection('kalshi-market-stream', `kalshi:${streamFallback.transport}`, demoteReason);
          logKalshiWsDecision('demote-disconnected', {
            selected: `kalshi:${streamFallback.transport}`,
            demoteReason,
            stale: !!ws.stale,
            suspended: !!ws.suspended,
            suspendInMs: ws.suspendInMs || 0,
            suspendReason: ws.suspendReason || '',
            reconnectAttempts: ws.reconnectAttempts || 0,
            reconnectInMs: ws.reconnectInMs || 0,
            lastCloseReason: ws.lastCloseReason || '',
            lastError: ws.lastError || '',
          });
          if (!ws.suspended && (Date.now() - lastKalshiWsRecoveryTs) > 20_000 && shouldAttemptKalshiWsRecovery('disconnect')) {
            lastKalshiWsRecoveryTs = Date.now();
            ensureKalshiWs({ force: true, reason: 'disconnect-pulse-recovery' });
          }
        } else if (!stability.stale) {
          updateSourceHealth('kalshi', 'wss', 'kalshi-market-stream', true, { stale: false });
          const demotedForMs = kalshiDemotedSinceTs ? Math.max(0, Date.now() - kalshiDemotedSinceTs) : 0;
          const forcePromote = stability.demoted && demotedForMs >= WSS_MAX_DEMOTE_HOLD_MS;
          if (stability.shouldPromote || !stability.demoted || forcePromote) {
            const reason = forcePromote
              ? 'wss-max-demote-hold-repromote'
              : (stability.shouldPromote ? 'wss-stable-repromote' : 'wss-healthy');
            updateDomainSelection('kalshi-market-stream', 'kalshi:wss', reason);
            kalshiDemotedSinceTs = 0;
            lastKalshiDemoteReason = '';
            logKalshiWsDecision('promote-wss', {
              reason,
              stableForMs: stability.stableForMs || 0,
              demotedForMs,
              reconnectAttempts: ws.reconnectAttempts || 0,
              tickers: ws.tickers || 0,
            });
          }
        } else if (stability.shouldDemote || stability.demoted) {
          kalshiDemotedSinceTs = kalshiDemotedSinceTs || Date.now();
          updateSourceHealth('kalshi', 'wss', 'kalshi-market-stream', false, {
            stale: true,
            error: `wss stale (${stability.staleWindows || 0} windows)`,
          });
          const baseReason = stability.shouldDemote ? 'wss-stale-demote-hysteresis' : 'wss-stale-held';
          const reason = `${baseReason}:${streamFallback.reason}`;
          lastKalshiDemoteReason = reason;
          updateDomainSelection('kalshi-market-stream', `kalshi:${streamFallback.transport}`, reason);
          logKalshiWsDecision('demote-stale', {
            reason,
            selected: `kalshi:${streamFallback.transport}`,
            staleWindows: stability.staleWindows || 0,
            staleForMs: stability.staleForMs || 0,
            staleAgeMs: stability.staleAgeMs || 0,
          });
          if (stability.shouldDemote && (Date.now() - lastKalshiWsRecoveryTs) > 20_000 && shouldAttemptKalshiWsRecovery('stale')) {
            if (ws.suspended) {
              logKalshiWsDecision('recovery-skipped-suspended', {
                reason: 'stale',
                suspendInMs: ws.suspendInMs || 0,
              });
              return;
            }
            lastKalshiWsRecoveryTs = Date.now();
            ensureKalshiWs({ force: true, reason: 'stale-pulse-recovery' });
          }
        } else {
          // Grace period: stale seen, but not enough windows/duration to demote.
          updateSourceHealth('kalshi', 'wss', 'kalshi-market-stream', true, { stale: false });
          logKalshiWsDecision('grace-hold', {
            staleWindows: stability.staleWindows || 0,
            staleForMs: stability.staleForMs || 0,
          });
        }
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

  function transportHasRecentDomainSuccess(provider, transport, domainHints = [], maxAgeMs = HEALTHY_OK_MAX_AGE_MS) {
    const now = Date.now();
    const hints = (Array.isArray(domainHints) ? domainHints : []).map((h) => String(h || '').toLowerCase()).filter(Boolean);
    for (const row of sourceState.values()) {
      if (!row || row.provider !== provider || row.transport !== transport) continue;
      const domain = String(row.domain || '').toLowerCase();
      if (hints.length && !hints.some((hint) => domain.includes(hint))) continue;
      const lastOk = Number(row.lastOk || 0);
      const lastFail = Number(row.lastFail || 0);
      if (!lastOk) continue;
      if ((now - lastOk) > maxAgeMs) continue;
      if (lastOk < lastFail) continue;
      return true;
    }
    return false;
  }

  function selectKalshiStreamFallback() {
    const httpHealthy = transportLikelyHealthy('kalshi', 'http');
    const rpcHealthy = transportLikelyHealthy('kalshi', 'rpc');
    const httpRecentSuccess = transportHasRecentDomainSuccess('kalshi', 'http', ['kalshi-markets', 'kalshi-settlement', 'kalshi-market']);
    const rpcRecentSuccess = transportHasRecentDomainSuccess('kalshi', 'rpc', ['kalshi-markets', 'kalshi-settlement', 'kalshi-market']);

    // If WSS is unavailable, avoid defaulting to RPC when RPC has no recent success
    // and HTTP has proven recent success on Kalshi domains.
    if (!rpcHealthy && !rpcRecentSuccess && httpRecentSuccess) {
      return { transport: 'http', reason: 'http-recent-success-rpc-unhealthy' };
    }
    if (httpHealthy && !rpcHealthy) {
      return { transport: 'http', reason: 'http-healthy-rpc-unhealthy' };
    }
    if (rpcHealthy) {
      return { transport: 'rpc', reason: rpcRecentSuccess ? 'rpc-healthy-recent-success' : 'rpc-healthy' };
    }
    if (httpHealthy) {
      return { transport: 'http', reason: httpRecentSuccess ? 'http-healthy-recent-success' : 'http-healthy' };
    }
    if (httpRecentSuccess && !rpcRecentSuccess) {
      return { transport: 'http', reason: 'http-recent-success-no-rpc-success' };
    }
    return { transport: 'rpc', reason: rpcRecentSuccess ? 'rpc-recent-success-default' : 'rpc-default-no-recent-http-success' };
  }

  ensureIngestionBus();
  ensureTransportPulse();

  if (typeof window !== 'undefined') {
    window.addEventListener('kalshi:ticker', noteKalshiWsActivity);
    window.addEventListener('kalshi:trade', noteKalshiWsActivity);
    window.addEventListener('kalshi:ws-state', () => {
      const ws = getWsState();
      const staleAgeMs = ws.lastMessageTs ? Math.max(0, Date.now() - ws.lastMessageTs) : Number.POSITIVE_INFINITY;
      if (!ws.connected || (ws.stale && staleAgeMs > (WS_STALE_MS + WS_STALE_GRACE_MS))) {
        updateSourceHealth('kalshi', 'wss', 'kalshi-market-stream', false, {
          stale: true,
          error: ws.stale ? 'wss stale' : 'wss disconnected',
        });
      }
      if (ws.connected && !ws.stale) {
        logKalshiWsDecision('ws-state-healthy', {
          reconnectAttempts: ws.reconnectAttempts || 0,
          tickers: ws.tickers || 0,
          auth: ws.lastAuthStatus || '',
        });
      }
      scheduleTransportHealthSync();
    });
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
    noteKalshiWsActivity,
    summarizeStats,
    summarizeBus,
    summarizeCoordinator,
    getStats: () => ({ ...stats }),
    getSourceState: () => {
      const out = {};
      for (const [key, row] of sourceState.entries()) out[key] = { ...row };
      return out;
    },
  };
})();
