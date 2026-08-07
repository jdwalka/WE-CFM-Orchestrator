/**
 * Kalshi WebSocket Handler — Real-time prediction market feeds
 *
 * Public market-data channels:
 *   - ticker: Market price snapshots
 *   - trade: Recent trades
 *   - market_lifecycle_v2: Market open/close events
 *
 * Private channels (auth required):
 *   - orderbook_delta: Live order book updates
 *   - fill: Your filled orders
 *   - market_positions: Your positions
 *   - order_group_updates: Batch order status
 *
 * Authentication:
 *   Uses RSA private key to sign: timestamp + "GET" + "/trade-api/ws/v2"
 *   Signature sent as HTTP header during WebSocket upgrade
 */

(function () {
  'use strict';

  const PUBLIC_WS_URL = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
  const DEMO_WS_URL = 'wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2';

  // Use demo by default; set to false for production trading
  const USE_DEMO = false;
  const WS_URL = USE_DEMO ? DEMO_WS_URL : PUBLIC_WS_URL;
  const WS_PATH = '/trade-api/ws/v2';

  // Heartbeat: Kalshi closes idle connections; ping every 20 s
  const HEARTBEAT_INTERVAL_MS = 20_000;
  const RECONNECT_BASE_MS = 1_000;
  const RECONNECT_MAX_MS = 120_000;
  const PERSISTENT_FAIL_WINDOW_MS = 120_000;
  const PERSISTENT_FAIL_THRESHOLD = 6;
  const SUSPEND_BASE_MS = 3 * 60_000;
  const SUSPEND_MAX_MS = 30 * 60_000;
  const CONNECT_ATTEMPT_TIMEOUT_MS = 20_000;
  const STALE_MESSAGE_MS = 75_000;
  const STALE_CHECK_MS = 12_000;
  const STALE_CONFIRM_WINDOWS = 2;
  const STALE_RECONNECT_MIN_MS = 24_000;
  const STATUS_EMIT_MIN_MS = 1_000;
  const MESSAGE_STATUS_EMIT_MIN_MS = 5_000;
  const LOG_THROTTLE_MS = 5_000;
  const TRANSPORT_FAIL_LOG_THROTTLE_MS = 60_000;
  let _heartbeatTimer = null;
  let _staleTimer = null;
  let _lastStatusEmitTs = 0;
  let _lastStatusReason = '';
  const _throttledLogTs = new Map();

  // ─────────────────────────────────────────────────────────────────────────────
  // Authentication (RSA signature for HTTP header during WS upgrade)
  // ─────────────────────────────────────────────────────────────────────────────

  // Fallback signer for non-Electron environments. Electron signs in main over IPC.
  const crypto = (typeof window !== 'undefined' && window.desktopApp) ? window.desktopApp.crypto : null;
  let credentialPromise = null;
  let credentialCache = null;

  // Clock-skew compensation for the fallback signing path below (the primary
  // path signs via IPC in electron/kalshi-credentials.js, which calibrates
  // separately). This machine's clock can drift by tens of seconds, which
  // Kalshi rejects as an expired timestamp — measure and correct for it.
  let _fallbackClockOffsetMs = 0;
  let _fallbackClockCalibration = null;
  function _calibrateFallbackClock() {
    if (_fallbackClockCalibration) return _fallbackClockCalibration;
    _fallbackClockCalibration = (async () => {
      try {
        const sentAt = Date.now();
        const res = await fetch('https://api.elections.kalshi.com/trade-api/v2/exchange/status');
        const dateHeader = res.headers.get('date');
        if (dateHeader) {
          const rttMs = Date.now() - sentAt;
          _fallbackClockOffsetMs = Date.parse(dateHeader) + Math.round(rttMs / 2) - Date.now();
        }
      } catch (_) {}
      return _fallbackClockOffsetMs;
    })();
    return _fallbackClockCalibration;
  }

  /**
   * Generate RSA signature for Kalshi auth header
   * Message format: timestamp + "GET" + "/trade-api/ws/v2"
   */
  function generateSignature(timestamp, privateKeyPem) {
    const message = `${timestamp}GET${WS_PATH}`;
    try {
      if (!crypto || typeof crypto.createSign !== 'function') {
        return Promise.reject(new Error('node crypto unavailable for Kalshi WSS signing'));
      }
      if (!crypto.constants?.RSA_PKCS1_PSS_PADDING || !crypto.constants?.RSA_PSS_SALTLEN_DIGEST) {
        return Promise.reject(new Error('node crypto RSA-PSS constants unavailable'));
      }
      const signature = crypto
        .createSign('RSA-SHA256')
        .update(message)
        .sign({
          key: privateKeyPem,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        });
      return signature.toString('base64');
    } catch (err) {
      console.error('[KalshiWS] Signature generation failed:', err.message);
      return null;
    }
  }

  async function loadKalshiCredentials() {
    if (credentialCache?.apiKeyId && credentialCache?.privateKeyPem) return credentialCache;
    if (credentialPromise) return credentialPromise;
    credentialPromise = (async () => {
      if (typeof window !== 'undefined' && typeof window.desktopApp?.loadKalshiCredentials === 'function') {
        const res = await window.desktopApp.loadKalshiCredentials();
        if (!res?.success) throw new Error(res?.error || 'Kalshi credentials unavailable');
        credentialCache = {
          apiKeyId: String(res.apiKeyId || '').trim(),
          privateKeyPem: String(res.privateKeyPem || '').trim(),
        };
      } else if (typeof process !== 'undefined' && process?.env?.KALSHI_API_KEY_ID && process?.env?.KALSHI_PRIVATE_KEY_PEM) {
        credentialCache = {
          apiKeyId: String(process.env.KALSHI_API_KEY_ID || '').trim(),
          privateKeyPem: String(process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n').trim(),
        };
      } else {
        throw new Error('Kalshi credentials bridge unavailable');
      }

      if (!credentialCache.apiKeyId || !credentialCache.privateKeyPem.includes('-----BEGIN')) {
        credentialCache = null;
        throw new Error('Invalid Kalshi credential payload');
      }
      return credentialCache;
    })().finally(() => {
      credentialPromise = null;
    });
    return credentialPromise;
  }

  async function buildHandshakeHeaders() {
    lastAuthStatus = 'loading-credentials';
    lastAuthError = '';
    _emitStatusUpdate('auth-loading-credentials');
    const bridge = (typeof window !== 'undefined') ? window.desktopApp : null;
    if (typeof bridge?.getKalshiWsAuthHeaders === 'function') {
      const res = await bridge.getKalshiWsAuthHeaders();
      if (!res?.success || !res.headers) {
        throw new Error(res?.error || 'Kalshi WSS auth headers unavailable');
      }
      lastAuthStatus = 'handshake-ready';
      lastAuthError = '';
      return res.headers;
    }

    const credentials = await loadKalshiCredentials();
    await _calibrateFallbackClock();
    const timestamp = String(Date.now() + _fallbackClockOffsetMs);
    const signature = generateSignature(timestamp, credentials.privateKeyPem);
    if (!signature) {
      return Promise.reject(new Error('Kalshi WSS signature generation failed'));
    }
    lastAuthStatus = 'handshake-ready';
    lastAuthError = '';
    return {
      'KALSHI-ACCESS-KEY': credentials.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────────

  const store = {
    // Market tickers: market_ticker → {yes_bid, yes_ask, no_bid, no_ask, last_traded, ts}
    tickers: {},
    // Recent trades: market_ticker → [{timestamp, yes_price, no_price, size}, ...]
    trades: {},
    // Order book snapshots: market_ticker → {yes_bids: [...], yes_asks: [...], no_bids: [...], no_asks: [...]}
    orderbooks: {},
    // Filled orders and open positions (populated on auth)
    fills: [],
    positions: {},
    // Error log: [{code, msg, ts}, ...]
    errors: [],
  };

  let ws = null;
  let connected = false;
  let authenticated = false;
  let reconnectAttempts = 0;
  let messageId = 1;
  let messageQueue = [];
  let readyToSend = false;
  let connectPromise = null;
  let reconnectTimer = null;
  let reconnectDueAt = 0;
  let intentionalDisconnect = false;
  let connecting = false;
  let connectStartedAt = 0;
  let connectAttemptSeq = 0;
  let lastConnectAttempt = null;
  let lastMessageTs = 0;
  let lastConnectTs = 0;
  let lastCloseReason = '';
  let lastCloseCode = null;
  let lastError = '';
  let lastRouteEventReason = '';
  let lastRouteReconnectTs = 0;
  let staleWindowCount = 0;
  let staleSinceTs = 0;
  let lastAuthStatus = 'not-attempted';
  let lastAuthError = '';
  let lastHandshakeStatus = 'idle';
  let lastHandshakeError = '';
  let lastFailureClass = '';
  let lastWsCtorSource = 'unknown';
  let lastIssueBucket = 'unknown';
  let lastIssueReason = '';
  let suspendLevel = 0;
  let suspendedUntil = 0;
  let suspendReason = '';
  let suspendTimer = null;
  const connectFailTs = [];
  const pendingSubscriptions = new Map();
  const desiredMarketTickers = new Set();
  let lastSubscriptionSignature = '';

  // Markets to subscribe to — resolved dynamically by market-resolver.js.
  // Falls back to these if resolver hasn't run yet.
  // Series tickers for active BTC/ETH/SOL/XRP 15-min contracts on Kalshi.
  // Series tickers — resolved to live market_tickers via market-resolver / PredictionMarkets
  const DEFAULT_SERIES = ['KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M'];

  // ─────────────────────────────────────────────────────────────────────────────
  // Connection Management
  // ─────────────────────────────────────────────────────────────────────────────

  function _jitter(ms) {
    const extra = Math.floor(Math.random() * Math.max(80, Math.floor(ms * 0.35)));
    return ms + extra;
  }

  function _logThrottled(key, level, ...args) {
    const now = Date.now();
    const last = _throttledLogTs.get(key) || 0;
    if ((now - last) < LOG_THROTTLE_MS) return;
    _throttledLogTs.set(key, now);
    const writer = console[level] || console.log;
    writer.apply(console, args);
  }

  function _logTransport(type, detail = {}) {
    try {
      if (/ok|success/i.test(String(type || ''))) return;
      const errorText = String(detail.error || '');
      const normalizedError = errorText
        .replace(/\b\d{1,6}\b/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      const throttleKey = `transport:${type}:${detail.failureClass || ''}:${normalizedError}`;
      const now = Date.now();
      const last = _throttledLogTs.get(throttleKey) || 0;
      if ((now - last) < TRANSPORT_FAIL_LOG_THROTTLE_MS) return;
      _throttledLogTs.set(throttleKey, now);
      window.NetworkLog?.record?.(type, {
        provider: 'Kalshi',
        url: 'kalshi://wss',
        ...detail,
      });
    } catch (_) { }
  }

  function _isStale() {
    if (!connected) return true;
    if (!lastMessageTs) return false;
    return (Date.now() - lastMessageTs) > STALE_MESSAGE_MS;
  }

  function _resetStaleCounters() {
    staleWindowCount = 0;
    staleSinceTs = 0;
  }

  function _emitStatusUpdate(reason = '') {
    try {
      const now = Date.now();
      const minInterval = reason === 'message' ? MESSAGE_STATUS_EMIT_MIN_MS : STATUS_EMIT_MIN_MS;
      if (reason === _lastStatusReason && (now - _lastStatusEmitTs) < minInterval) return;
      if (reason === 'message' && (now - _lastStatusEmitTs) < minInterval) return;
      _lastStatusEmitTs = now;
      _lastStatusReason = reason;
      window.dispatchEvent(new CustomEvent('kalshi:ws-state', {
        detail: {
          connected,
          reconnectAttempts,
          stale: _isStale(),
          suspended: _isSuspended(),
          suspendInMs: _isSuspended() ? Math.max(0, suspendedUntil - Date.now()) : 0,
          suspendUntil: _isSuspended() ? suspendedUntil : 0,
          suspendReason,
          suspendLevel,
          issueBucket: lastIssueBucket,
          issueReason: lastIssueReason,
          reason: reason || lastCloseReason || '',
          ts: Date.now(),
        },
      }));
    } catch (_) { }
  }

  function _formatError(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (err instanceof Error) {
      return err.message || String(err);
    }
    if (typeof Event !== 'undefined' && err instanceof Event) {
      const target = err.target || err.currentTarget || null;
      const readyState = target && typeof target.readyState === 'number' ? target.readyState : null;
      const url = target && target.url ? String(target.url) : '';
      const reason = err.reason ? String(err.reason) : '';
      const code = Number.isFinite(err.code) ? err.code : null;
      const nested = err.error ? _formatError(err.error) : '';
      const eventMsg = [
        `event:${err.type || 'unknown'}`,
        code !== null ? `code=${code}` : '',
        reason ? `reason=${reason}` : '',
        readyState !== null ? `readyState=${readyState}` : '',
        url ? `url=${url}` : '',
        nested ? `cause=${nested}` : '',
      ].filter(Boolean).join(' ');
      if (eventMsg) return eventMsg;
    }
    if (err.message) return String(err.message);
    if (typeof err === 'object') {
      const out = [];
      if (err.type) out.push(`type=${String(err.type)}`);
      if (Number.isFinite(err.code)) out.push(`code=${err.code}`);
      if (err.reason) out.push(`reason=${String(err.reason)}`);
      if (err.statusCode) out.push(`status=${err.statusCode}`);
      if (err.statusMessage) out.push(`statusText=${String(err.statusMessage)}`);
      if (out.length) return out.join(' ');
      try {
        return JSON.stringify(err);
      } catch (_) { }
    }
    return String(err);
  }

  function _isConstructable(fn) {
    if (typeof fn !== 'function') return false;
    try {
      Reflect.construct(String, [], fn);
      return true;
    } catch (_) {
      return false;
    }
  }

  function _shouldFallbackToBrowserWebSocket(errLike) {
    const msg = _formatError(errLike).toLowerCase();
    return msg.includes('cannot be invoked without') || msg.includes('is not a constructor');
  }

  function _isNodeWsCtor(fn) {
    if (typeof fn !== 'function') return false;
    const proto = fn.prototype || null;
    return !!(proto && typeof proto.on === 'function' && typeof proto.once === 'function');
  }

  function _resolveWebSocketCtor() {
    const bridge = (typeof window !== 'undefined') ? window.desktopApp : null;
    const bridgeWs = bridge?.ws || null;
    const candidates = [];

    if (typeof bridge?.createWebSocket === 'function') {
      return {
        factory: bridge.createWebSocket,
        ctor: null,
        source: 'desktopApp.createWebSocket',
        usingNodeWs: true,
      };
    }

    if (bridgeWs && typeof bridgeWs.WebSocket === 'function') {
      candidates.push({
        factory: null,
        ctor: bridgeWs.WebSocket,
        source: 'desktopApp.ws.WebSocket',
        usingNodeWs: _isNodeWsCtor(bridgeWs.WebSocket),
      });
    }
    if (typeof bridgeWs === 'function') {
      candidates.push({
        factory: null,
        ctor: bridgeWs,
        source: 'desktopApp.ws',
        usingNodeWs: _isNodeWsCtor(bridgeWs),
      });
    }
    if (typeof WebSocket === 'function') {
      candidates.push({
        factory: null,
        ctor: WebSocket,
        source: 'globalThis.WebSocket',
        usingNodeWs: _isNodeWsCtor(WebSocket),
      });
    }

    const rejected = [];
    for (const candidate of candidates) {
      if (_isConstructable(candidate.ctor)) return candidate;
      rejected.push(candidate.source);
    }

    if (rejected.length) {
      console.warn('[KalshiWS] WebSocket constructor guard rejected candidate(s):', rejected.join(', '));
    }

    return { factory: null, ctor: null, source: 'unresolved', usingNodeWs: false };
  }

  function _classifyFailure(errLike) {
    const msg = _formatError(errLike).toLowerCase();
    if (msg.includes('credential') || msg.includes('kalshi-api-key') || msg.includes('crypto unavailable') || msg.includes('signature generation') || msg.includes('requires node ws') || msg.includes('browser websocket cannot send')) return 'auth-config-fail';
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('403')) return 'auth-config-fail';
    if (msg.includes('stale')) return 'stale-reconnect';
    if (msg.includes('code=1000') || msg.includes('code=1001') || msg.includes('code=1005') || msg.includes('route')) return 'lifecycle-reconnect';
    if (msg.includes('name_not_resolved') || msg.includes('enotfound') || msg.includes('eai_again') || msg.includes('dns')) return 'dns-fail';
    if (msg.includes('cert') || msg.includes('ssl') || msg.includes('tls') || msg.includes('self signed')) return 'tls-fail';
    if (msg.includes('unexpected-response') || msg.includes('handshake') || msg.includes('upgrade')) return 'handshake-fail';
    if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('abort')) return 'timeout';
    if (msg.includes('network changed') || msg.includes('err_network_changed')) return 'route-change';
    if (msg.includes('econnreset') || msg.includes('socket hang up')) return 'socket-reset';
    return 'network-fail';
  }

  function _classifyIssueBucket(errLike, failureClass = '') {
    const msg = _formatError(errLike).toLowerCase();
    const fc = String(failureClass || '').toLowerCase();
    if (fc === 'stale-reconnect' || fc === 'lifecycle-reconnect' || /stale[-\s]*watchdog|demote|hysteresis|scheduler|circuit|oscillat|internal|code=1000|code=1001|code=1005/.test(msg)) {
      return {
        bucket: 'app/logic',
        reason: 'internal WSS lifecycle/watchdog reconnect',
      };
    }
    if (/browser websocket cannot send|requires node ws|credential|crypto unavailable|signature generation|kalshi-api-key\.txt not found|auth-header-failed|auth-config-fail/.test(msg) || fc === 'auth-config-fail') {
      return {
        bucket: 'app/logic',
        reason: 'local WebSocket auth capability/configuration issue',
      };
    }
    if (/http\s*(401|403|404|429|5\d\d)|unauthorized|forbidden|not found|rate limit|upstream/.test(msg)) {
      return {
        bucket: 'provider/api',
        reason: 'upstream API reject',
      };
    }
    if (/event:error/.test(msg) && /readystate=3/.test(msg)) {
      return {
        bucket: 'network/transport',
        reason: 'websocket connect failure (readyState=3 before open)',
      };
    }
    if (
      ['dns-fail', 'tls-fail', 'handshake-fail', 'timeout', 'route-change', 'socket-reset', 'network-fail'].includes(fc) ||
      /dns|tls|ssl|cert|handshake|upgrade|timeout|abort|route|network|websocket|wss/.test(msg)
    ) {
      return {
        bucket: 'network/transport',
        reason: 'network transport/connectivity failure',
      };
    }
    return {
      bucket: 'unknown',
      reason: _formatError(errLike) || '',
    };
  }

  function _isSuspended() {
    return suspendedUntil > Date.now();
  }

  function _clearSuspendTimer() {
    if (suspendTimer) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
  }

  function _scheduleSuspendProbe() {
    _clearSuspendTimer();
    if (!_isSuspended()) return;
    const waitMs = Math.max(500, suspendedUntil - Date.now());
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      if (_isSuspended() || connected || connecting || intentionalDisconnect) return;
      reconnect('suspend-probe');
    }, waitMs);
  }

  function _resetSuspendState() {
    suspendLevel = 0;
    suspendedUntil = 0;
    suspendReason = '';
    connectFailTs.length = 0;
    _clearSuspendTimer();
  }

  function _activateSuspend(failureClass, reasonText) {
    suspendLevel += 1;
    const cooldown = _jitter(Math.min(SUSPEND_MAX_MS, SUSPEND_BASE_MS * Math.pow(2, Math.max(0, suspendLevel - 1))));
    suspendedUntil = Date.now() + cooldown;
    suspendReason = `${failureClass || 'network-fail'}: ${reasonText || 'persistent connect failure'}`.trim();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectDueAt = 0;
    }
    console.warn(`[KalshiWS] WSS suspended for ${Math.round(cooldown / 1000)}s (${suspendReason})`);
    _emitStatusUpdate('suspended');
    _scheduleSuspendProbe();
  }

  function _recordConnectFailure(failureClass, reasonText) {
    const now = Date.now();
    while (connectFailTs.length && (now - connectFailTs[0]) > PERSISTENT_FAIL_WINDOW_MS) connectFailTs.shift();
    connectFailTs.push(now);
    if (connectFailTs.length >= PERSISTENT_FAIL_THRESHOLD) {
      _activateSuspend(failureClass, reasonText);
    }
  }

  function _setConnectAttemptStatus(status, extra = {}) {
    if (!lastConnectAttempt) return;
    lastConnectAttempt = {
      ...lastConnectAttempt,
      status,
      endedAt: Date.now(),
      ...extra,
    };
  }

  function _attachSocketHandlers(socket, handlers) {
    if (!socket) return;
    const add = (eventName, fn) => {
      if (typeof socket.on === 'function') {
        socket.on(eventName, fn);
      } else if (typeof socket.addEventListener === 'function') {
        socket.addEventListener(eventName, fn);
      }
    };

    add('open', (...args) => handlers.onOpen?.(socket, ...args));
    add('message', (...args) => {
      const first = args[0];
      const payload = first && typeof first === 'object' && Object.prototype.hasOwnProperty.call(first, 'data')
        ? first.data
        : first;
      handlers.onMessage?.(payload, socket);
    });
    add('pong', (...args) => {
      handlers.onPong?.(socket, ...args);
    });
    add('error', (...args) => {
      const first = args[0];
      const payload = first && typeof first === 'object' && first.error ? first.error : first;
      handlers.onError?.(payload, socket);
    });
    add('close', (...args) => {
      const first = args[0];
      if (first && typeof first === 'object' && Object.prototype.hasOwnProperty.call(first, 'code')) {
        handlers.onClose?.(first.code, first.reason, socket);
      } else {
        handlers.onClose?.(first, args[1], socket);
      }
    });
  }

  function _onceSocketEvent(socket, eventName, handler) {
    if (!socket) return () => { };
    if (typeof socket.once === 'function') {
      socket.once(eventName, handler);
      return () => { };
    }
    if (typeof socket.addEventListener === 'function') {
      const wrapped = (...args) => {
        try {
          socket.removeEventListener(eventName, wrapped);
        } catch (_) { }
        handler(...args);
      };
      socket.addEventListener(eventName, wrapped);
      return () => {
        try {
          socket.removeEventListener(eventName, wrapped);
        } catch (_) { }
      };
    }
    return () => { };
  }

  function _currentDesiredMarkets() {
    if (desiredMarketTickers.size) return [...desiredMarketTickers];
    const active = Array.isArray(window._kalshiActiveMarkets) ? window._kalshiActiveMarkets.filter(Boolean) : [];
    if (active.length) return active;
    try {
      const pm = window.PredictionMarkets?.getAll?.() || {};
      const inferred = Object.values(pm)
        .map((coin) => coin?.kalshi15m?.ticker)
        .filter(Boolean);
      return inferred;
    } catch (_) {
      return [];
    }
  }

  function _normalizeMarketTickers(marketTickers) {
    return Array.from(new Set((Array.isArray(marketTickers) ? marketTickers : []).filter(Boolean))).sort();
  }

  function _marketSubscriptionSignature(marketTickers) {
    const list = _normalizeMarketTickers(marketTickers);
    return list.length ? list.join('|') : 'global';
  }

  function _startStaleWatchdog() {
    _stopStaleWatchdog();
    _staleTimer = setInterval(() => {
      if (!connected) {
        _resetStaleCounters();
        return;
      }
      if (!_isStale()) {
        _resetStaleCounters();
        return;
      }
      staleWindowCount += 1;
      if (!staleSinceTs) staleSinceTs = Date.now();
      const ageSec = Math.round((Date.now() - lastMessageTs) / 1000);
      const staleForMs = Date.now() - staleSinceTs;
      const staleForSec = Math.round(staleForMs / 1000);
      const hasEnoughWindows = staleWindowCount >= STALE_CONFIRM_WINDOWS;
      const hasEnoughDuration = staleForMs >= STALE_RECONNECT_MIN_MS;
      if (!hasEnoughWindows && !hasEnoughDuration) {
        _emitStatusUpdate(`stale-pending:${ageSec}s`);
        return;
      }
      const reason = `stale stream (${ageSec}s without messages)`;
      console.warn(`[KalshiWS] ${reason}; forcing reconnect`);
      _logTransport('TRANSPORT_FAIL', { error: `${reason}; confirmed ${staleWindowCount} window(s), stale ${staleForSec}s` });
      _resetStaleCounters();
      reconnect('stale-watchdog');
    }, STALE_CHECK_MS);
  }

  function _stopStaleWatchdog() {
    if (_staleTimer) {
      clearInterval(_staleTimer);
      _staleTimer = null;
    }
  }

  function _closeSocketSafely() {
    if (!ws) return;
    ws = null;
  }

  function _resubscribeAfterConnect() {
    const activeMarkets = _currentDesiredMarkets();
    lastSubscriptionSignature = '';
    messageQueue.length = 0;
    pendingSubscriptions.clear();
    subscribeToTicker(activeMarkets);
    if (activeMarkets.length) {
      subscribeToOrderbook(activeMarkets);
      subscribeToTrades(activeMarkets);
      lastSubscriptionSignature = _marketSubscriptionSignature(activeMarkets);
    }
  }

  async function connect(meta = {}) {
    if (connected && ws) return ws;
    if (connectPromise) return connectPromise;
    const force = !!meta.force;
    if (!force && _isSuspended()) {
      const waitMs = Math.max(0, suspendedUntil - Date.now());
      const err = new Error(`WSS suspended (${Math.ceil(waitMs / 1000)}s remaining)`);
      lastError = err.message;
      _emitStatusUpdate('connect-skipped-suspended');
      return Promise.reject(err);
    }
    connectPromise = (async () => {
      connecting = true;
      connectStartedAt = Date.now();
      const attemptId = ++connectAttemptSeq;
      lastConnectAttempt = {
        id: attemptId,
        status: 'signing',
        reason: String(meta.reason || 'manual-connect'),
        startedAt: connectStartedAt,
        endedAt: null,
        error: '',
      };
      lastHandshakeStatus = 'signing';
      lastHandshakeError = '';

      let handshakeHeaders = null;
      try {
        handshakeHeaders = await buildHandshakeHeaders();
      } catch (err) {
        connecting = false;
        connectStartedAt = 0;
        const fc = _classifyFailure(err);
        const issue = _classifyIssueBucket(err, fc);
        const errorText = _formatError(err);
        lastError = errorText;
        lastFailureClass = fc;
        lastIssueBucket = issue.bucket;
        lastIssueReason = issue.reason || errorText;
        lastHandshakeStatus = 'auth-header-failed';
        lastHandshakeError = errorText;
        lastAuthStatus = 'failed';
        lastAuthError = errorText;
        _setConnectAttemptStatus('failed', { error: errorText, failureClass: fc });
        _recordConnectFailure(fc, errorText);
        _emitStatusUpdate(`connect-auth-failed:${errorText}`);
        return Promise.reject(err);
      }

      _setConnectAttemptStatus('connecting', { error: '' });
      lastHandshakeStatus = 'connecting';

      return new Promise((resolve, reject) => {
        try {
        const why = meta.reason ? ` (${meta.reason})` : '';
        console.log(`[KalshiWS] Connecting to ${WS_URL}${why} [attempt ${attemptId}]`);
        const wsCtorInfo = _resolveWebSocketCtor();
        let WebSocketClass = wsCtorInfo.ctor;
        let usingNodeWs = !!wsCtorInfo.usingNodeWs;
        lastWsCtorSource = wsCtorInfo.source;
        if (wsCtorInfo.factory) {
          ws = wsCtorInfo.factory(WS_URL, {
            handshakeTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
            perMessageDeflate: false,
            headers: handshakeHeaders,
          });
        } else if (!WebSocketClass) {
          return reject(new Error('No constructable WebSocket constructor available'));
        } else if (!usingNodeWs) {
          return reject(new Error('Kalshi WSS requires Node ws with handshake headers; browser WebSocket cannot send KALSHI-ACCESS headers'));
        } else {
          ws = new WebSocketClass(WS_URL, {
            handshakeTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
            perMessageDeflate: false,
            headers: handshakeHeaders,
          });
        }
        const attemptSocket = ws;
        _attachSocketHandlers(attemptSocket, { onOpen, onMessage, onPong, onError, onClose });

        let settled = false;
        const settle = (ok, err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          stopOpenOnce();
          stopErrorOnce();
          stopCloseOnce();
          connecting = false;
          if (ok) {
            lastHandshakeStatus = 'open';
            lastHandshakeError = '';
            _setConnectAttemptStatus('connected', { error: '' });
            resolve();
          } else {
            const errorText = _formatError(err) || 'connect attempt failed';
            const failureClass = _classifyFailure(err);
            const issue = _classifyIssueBucket(err, failureClass);
            lastFailureClass = failureClass;
            lastIssueBucket = issue.bucket;
            lastIssueReason = issue.reason || errorText;
            lastHandshakeStatus = 'failed';
            lastHandshakeError = errorText;
            _setConnectAttemptStatus('failed', { error: errorText, failureClass });
            _recordConnectFailure(failureClass, errorText);
            if (attemptSocket && typeof attemptSocket.close === 'function') {
              try { attemptSocket.close(); } catch (_) { }
            }
            if (ws === attemptSocket) {
              ws = null;
            }
            if (!intentionalDisconnect && !connected && !reconnectTimer && !_isSuspended()) {
              setTimeout(() => reconnect(`connect-failed:${failureClass}`), 0);
            }
            reject(err instanceof Error ? err : new Error(errorText));
          }
          _emitStatusUpdate(ok ? 'connect-open' : `connect-failed:${_formatError(err)}`);
        };

        const timeout = setTimeout(() => {
          settle(false, new Error(`Connection timeout (${Math.round(CONNECT_ATTEMPT_TIMEOUT_MS / 1000)}s)`));
          try { attemptSocket?.close?.(); } catch (_) { }
        }, CONNECT_ATTEMPT_TIMEOUT_MS);

        const stopOpenOnce = _onceSocketEvent(attemptSocket, 'open', () => settle(true));
        const stopErrorOnce = _onceSocketEvent(attemptSocket, 'error', (err) => settle(false, err));
        const stopCloseOnce = _onceSocketEvent(attemptSocket, 'close', (...args) => {
          if (connected) return;
          const first = args[0];
          const closeCode = first && typeof first === 'object' && Object.prototype.hasOwnProperty.call(first, 'code')
            ? first.code
            : first;
          const closeReason = first && typeof first === 'object' && Object.prototype.hasOwnProperty.call(first, 'reason')
            ? first.reason
            : args[1];
          settle(false, new Error(`closed-before-open code=${closeCode || 'n/a'} reason=${String(closeReason || '').trim() || 'none'}`));
        });
        if (typeof attemptSocket.on === 'function') {
          attemptSocket.once('unexpected-response', (_req, res) => {
            const code = res?.statusCode || 'n/a';
            const text = res?.statusMessage || 'unexpected response';
            lastHandshakeStatus = 'unexpected-response';
            lastHandshakeError = `${code} ${text}`;
            settle(false, new Error(`unexpected-response ${code} ${text}`));
          });
        }
      } catch (err) {
        connecting = false;
        connectStartedAt = 0;
        const fc = _classifyFailure(err);
        const issue = _classifyIssueBucket(err, fc);
        const errorText = _formatError(err);
        lastError = errorText;
        lastFailureClass = fc;
        lastIssueBucket = issue.bucket;
        lastIssueReason = issue.reason || errorText;
        lastHandshakeStatus = 'constructor-error';
        lastHandshakeError = errorText;
        _setConnectAttemptStatus('failed', { error: errorText, failureClass: fc });
        _recordConnectFailure(fc, errorText);
        _emitStatusUpdate(`connect-constructor-failed:${errorText}`);
        reject(err);
      }
      });
    })().finally(() => {
      connectPromise = null;
    });
    return connectPromise;
  }

  function onOpen(socket) {
    const readyState = socket && typeof socket.readyState === 'number' ? socket.readyState : null;
    console.log('[KalshiWS] Connected', {
      attempt: lastConnectAttempt?.id || null,
      ctor: lastWsCtorSource,
      readyState: readyState !== null ? readyState : 'n/a',
    });
    connected = true;
    intentionalDisconnect = false;
    reconnectAttempts = 0;
    readyToSend = true;
    connecting = false;
    connectStartedAt = 0;
    lastConnectTs = Date.now();
    lastMessageTs = Date.now();
    lastCloseCode = null;
    lastCloseReason = '';
    lastError = '';
    lastFailureClass = '';
    lastIssueBucket = 'unknown';
    lastIssueReason = '';
    _resetSuspendState();
    _resetStaleCounters();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectDueAt = 0;
    }

    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      ws.send(JSON.stringify(msg));
    }

    _startHeartbeat();
    _startStaleWatchdog();
    authenticated = true;
    lastAuthStatus = 'handshake-authenticated';
    lastAuthError = '';
    lastHandshakeStatus = 'open';
    lastHandshakeError = '';
    _emitStatusUpdate('open-handshake-authenticated');
    _resubscribeAfterConnect();
    _logTransport('TRANSPORT_OK', { error: 'kalshi-wss-connected' });
    _emitStatusUpdate('connected');
  }

  function onMessage(data) {
    lastMessageTs = Date.now();
    _resetStaleCounters();
    _emitStatusUpdate('message');
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch (err) {
      console.error('[KalshiWS] Parse error:', err.message);
    }
  }

  function onPong() {
    lastMessageTs = Date.now();
    _resetStaleCounters();
  }

  function onError(err) {
    lastError = _formatError(err) || 'unknown';
    lastFailureClass = _classifyFailure(err);
    const issue = _classifyIssueBucket(err, lastFailureClass);
    lastIssueBucket = issue.bucket;
    lastIssueReason = issue.reason || lastError;
    console.error('[KalshiWS] Error:', lastFailureClass, lastError);
    _emitStatusUpdate(`socket-error:${lastFailureClass}:${lastError}`);
  }

  function onClose(code, reason, socket) {
    if (socket && ws && socket !== ws && !connected) return;
    lastCloseCode = Number.isFinite(code) ? code : null;
    lastCloseReason = String(reason || '').trim() || lastError || 'socket closed';
    if (!lastFailureClass) {
      lastFailureClass = _classifyFailure(lastCloseReason || `code-${lastCloseCode || 'unknown'}`);
    }
    if (!lastIssueReason) {
      const issue = _classifyIssueBucket(lastCloseReason || `code=${lastCloseCode || 'unknown'}`, lastFailureClass);
      lastIssueBucket = issue.bucket;
      lastIssueReason = issue.reason || lastCloseReason;
    }
    console.log('[KalshiWS] Disconnected', lastCloseCode || '', lastCloseReason);
    connected = false;
    authenticated = false;
    readyToSend = false;
    connecting = false;
    lastSubscriptionSignature = '';
    pendingSubscriptions.clear();
    connectStartedAt = 0;
    _resetStaleCounters();
    _stopHeartbeat();
    _stopStaleWatchdog();
    _closeSocketSafely();
    _logTransport('TRANSPORT_FAIL', {
      error: `kalshi-wss-closed ${lastCloseCode || ''} ${lastCloseReason}`.trim(),
      failureClass: lastFailureClass || '',
    });
    _emitStatusUpdate(lastCloseReason);
    if (!intentionalDisconnect && !_isSuspended()) reconnect('close');
  }

  function reconnect(reason = 'unknown') {
    if (intentionalDisconnect) return;
    if (_isSuspended()) {
      _scheduleSuspendProbe();
      _emitStatusUpdate(`reconnect-suspended:${reason}`);
      return;
    }
    if (reconnectTimer) return;
    if (connected && ws) {
      try {
        ws.close();
      } catch (_) { }
      connected = false;
      readyToSend = false;
      _emitStatusUpdate(`reconnect-closing:${reason}`);
    }
    reconnectAttempts++;
    const expMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.max(0, reconnectAttempts - 1)));
    const delay = _jitter(expMs);
    console.warn(`[KalshiWS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}, reason: ${reason})`);
    _emitStatusUpdate(`reconnecting:${reason}`);
    reconnectDueAt = Date.now() + delay;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDueAt = 0;
      connect({ reason: `reconnect:${reason}` }).catch((err) => {
        lastError = String(err?.message || err || 'connect failed');
        console.error('[KalshiWS] Reconnect failed:', lastError);
        reconnect(`connect-failed:${lastError}`);
      });
    }, delay);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────────────────────

  function authenticatePrivate() {
    return authenticated && lastAuthStatus === 'handshake-authenticated';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Handling
  // ─────────────────────────────────────────────────────────────────────────────

  function handleMessage(msg) {
    const { type, msg: payload } = msg;

    switch (type) {
      case 'subscribed':
        // Server confirmed subscription on the authenticated WS session.
        if (!authenticated) {
          authenticated = true;
          lastAuthStatus = 'handshake-authenticated';
          lastAuthError = '';
          lastHandshakeStatus = 'authenticated';
          console.log('[KalshiWS] Authenticated ✓');
        }
        {
          const subPayload = payload && typeof payload === 'object' ? payload : {};
          const ackId = subPayload.id ?? subPayload.request_id ?? null;
          const pending = ackId ? pendingSubscriptions.get(ackId) : null;
          if (ackId) pendingSubscriptions.delete(ackId);
          const ackChannels = subPayload.channels || subPayload.channel || pending?.channels || [];
          console.info('[KalshiWS] Subscription ack', {
            ackId,
            channels: Array.isArray(ackChannels) ? ackChannels : [ackChannels].filter(Boolean),
            sid: subPayload.sid ?? null,
            marketTickers: subPayload.market_tickers || pending?.marketTickers || [],
          });
          _emitStatusUpdate('auth-subscribed');
          _emitStatusUpdate('subscription-ack');
        }
        break;
      case 'ticker':
        handleTicker(payload);
        break;
      case 'orderbook_snapshot':
        handleOrderbookSnapshot(payload);
        break;
      case 'orderbook_delta':
        handleOrderbookDelta(payload);
        break;
      case 'trade':
        handleTrade(payload);
        break;
      case 'market_lifecycle_v2':
      case 'market_lifecycle':
        handleMarketLifecycle(payload);
        break;
      case 'pong':
        // Heartbeat acknowledged — nothing to do
        break;
      case 'error':
        if (payload?.code === 9) {
          lastAuthStatus = 'failed';
          lastAuthError = String(payload?.msg || 'authentication required');
          authenticated = false;
        }
        handleError(payload);
        break;
      default:
        _logThrottled(`unknown:${type || 'unknown'}`, 'debug', '[KalshiWS] Unknown message type:', type, msg);
    }
  }

  function toFiniteDecimal(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function clamp01(value) {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(1, value));
  }

  function normalizeL2Levels(levels) {
    if (!Array.isArray(levels)) return [];
    const out = [];
    for (const level of levels) {
      let priceRaw = null;
      let sizeRaw = null;
      if (Array.isArray(level)) {
        priceRaw = level[0];
        sizeRaw = level[1];
      } else if (level && typeof level === 'object') {
        priceRaw = level.price_dollars ?? level.price ?? level.yes_price ?? level.no_price;
        sizeRaw = level.count_fp ?? level.size ?? level.quantity_fp ?? level.count;
      }
      const price = clamp01(toFiniteDecimal(priceRaw));
      const size = toFiniteDecimal(sizeRaw);
      if (price == null || size == null) continue;
      out.push([price, size]);
    }
    return out;
  }

  function synthesizeAsksFromOpposingBids(opposingBids) {
    return (Array.isArray(opposingBids) ? opposingBids : [])
      .map(([price, size]) => {
        const p = clamp01(1 - Number(price));
        const s = toFiniteDecimal(size);
        return (p == null || s == null) ? null : [p, s];
      })
      .filter(Boolean)
      .sort((a, b) => a[0] - b[0]);
  }

  function deriveYesAsk(yesAskRaw, noBidRaw) {
    const yesAsk = clamp01(toFiniteDecimal(yesAskRaw));
    if (yesAsk != null) return yesAsk;
    const noBid = clamp01(toFiniteDecimal(noBidRaw));
    return noBid != null ? clamp01(1 - noBid) : null;
  }

  function deriveNoAsk(noAskRaw, yesBidRaw) {
    const noAsk = clamp01(toFiniteDecimal(noAskRaw));
    if (noAsk != null) return noAsk;
    const yesBid = clamp01(toFiniteDecimal(yesBidRaw));
    return yesBid != null ? clamp01(1 - yesBid) : null;
  }

  function handleTicker(payload) {
    const { market_ticker, yes_bid_dollars, yes_ask_dollars, no_bid_dollars, no_ask_dollars, last_traded_price } = payload;
    if (!market_ticker) return;

    const yesBid = clamp01(toFiniteDecimal(yes_bid_dollars ?? payload?.yes_bid));
    const noBid = clamp01(toFiniteDecimal(no_bid_dollars ?? payload?.no_bid));
    const yesAsk = deriveYesAsk(yes_ask_dollars ?? payload?.yes_ask, noBid);
    const noAsk = deriveNoAsk(no_ask_dollars ?? payload?.no_ask, yesBid);
    const lastTraded = clamp01(toFiniteDecimal(last_traded_price ?? payload?.last_traded_price_dollars ?? payload?.last_traded));

    store.tickers[market_ticker] = {
      yes_bid: yesBid,
      yes_ask: yesAsk,
      no_bid: noBid,
      no_ask: noAsk,
      last_traded: lastTraded,
      ts: Date.now(),
    };

    // Emit event for app.js
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:ticker', {
          detail: {
            market_ticker,
            yes_bid: yesBid,
            yes_ask: yesAsk,
            no_bid: noBid,
            no_ask: noAsk,
            last_traded: lastTraded,
            ts: Date.now(),
          },
        })
      );
      try {
        if (window._orbitalBroadcaster && typeof window._orbitalBroadcaster.pushTick === 'function') {
          window._orbitalBroadcaster.pushTick({
            market_id: market_ticker,
            market_ticker,
            price: lastTraded != null ? lastTraded : yesBid,
            vol: payload?.volume != null ? Number(payload.volume) : null,
            yes_bid: yesBid,
            yes_ask: yesAsk,
            no_bid: noBid,
            no_ask: noAsk,
            ts: Date.now(),
            stream_status: 'active',
            source: 'kalshi-ws',
          });
        }
      } catch (_) {}
    }
  }

  function handleOrderbookSnapshot(payload) {
    const {
      market_ticker,
      yes_bid_levels, yes_ask_levels, no_bid_levels, no_ask_levels,
      yes_dollars, no_dollars
    } = payload;
    if (!market_ticker) return;

    const yesBids = normalizeL2Levels(yes_bid_levels || yes_dollars);
    const noBids = normalizeL2Levels(no_bid_levels || no_dollars);
    let yesAsks = normalizeL2Levels(yes_ask_levels);
    let noAsks = normalizeL2Levels(no_ask_levels);
    if (!yesAsks.length && noBids.length) yesAsks = synthesizeAsksFromOpposingBids(noBids);
    if (!noAsks.length && yesBids.length) noAsks = synthesizeAsksFromOpposingBids(yesBids);

    store.orderbooks[market_ticker] = {
      yes_bids: yesBids,
      yes_asks: yesAsks,
      no_bids: noBids,
      no_asks: noAsks,
      ts: Date.now(),
    };

    _logThrottled(`orderbook-snapshot:${market_ticker}`, 'debug', `[KalshiWS] Orderbook snapshot for ${market_ticker}`);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kalshi:orderbook', { detail: { market_ticker, ...store.orderbooks[market_ticker] } }));
    }
  }

  function handleOrderbookDelta(payload) {
    const {
      market_ticker, client_order_id,
      yes_bid_levels, yes_ask_levels, no_bid_levels, no_ask_levels,
      yes_dollars, no_dollars
    } = payload;
    if (!market_ticker) return;

    // Merge delta price levels into existing snapshot
    if (store.orderbooks[market_ticker]) {
      const ob = store.orderbooks[market_ticker];

      // Helper: apply delta array — entries with size=0 remove the level
      function applyDelta(existing, delta) {
        if (!Array.isArray(delta)) return existing;
        const map = new Map(existing.map(l => [l[0], l]));
        for (const [priceRaw, sizeRaw] of normalizeL2Levels(delta)) {
          const price = clamp01(toFiniteDecimal(priceRaw));
          const size = toFiniteDecimal(sizeRaw);
          if (price == null || size == null) continue;
          if (size === 0) {
            map.delete(price);
          } else {
            map.set(price, [price, size]);
          }
        }
        return Array.from(map.values());
      }

      if (yes_bid_levels || yes_dollars) ob.yes_bids = applyDelta(ob.yes_bids, yes_bid_levels || yes_dollars);
      if (yes_ask_levels) ob.yes_asks = applyDelta(ob.yes_asks, yes_ask_levels);
      if (no_bid_levels || no_dollars)  ob.no_bids  = applyDelta(ob.no_bids,  no_bid_levels || no_dollars);
      if (no_ask_levels)  ob.no_asks  = applyDelta(ob.no_asks,  no_ask_levels);
      if (!ob.yes_asks.length && ob.no_bids.length) ob.yes_asks = synthesizeAsksFromOpposingBids(ob.no_bids);
      if (!ob.no_asks.length && ob.yes_bids.length) ob.no_asks = synthesizeAsksFromOpposingBids(ob.yes_bids);
      ob.ts = Date.now();
    }

    if (client_order_id) {
      console.log(`[KalshiWS] Your order ${client_order_id} caused orderbook change on ${market_ticker}`);
    }

    if (typeof window !== 'undefined') {
      if (store.orderbooks[market_ticker]) {
        window.dispatchEvent(new CustomEvent('kalshi:orderbook', { detail: { market_ticker, ...store.orderbooks[market_ticker] } }));
      }
      window.dispatchEvent(
        new CustomEvent('kalshi:orderbook_delta', {
          detail: {
            market_ticker,
            client_order_id,
            ts: Date.now(),
          },
        })
      );
    }
  }

  function handleTrade(payload) {
    const { market_ticker, yes_price, no_price, size, timestamp } = payload;
    if (!market_ticker) return;

    if (!store.trades[market_ticker]) {
      store.trades[market_ticker] = [];
    }

    store.trades[market_ticker].push({
      yes_price,
      no_price,
      size,
      ts: timestamp || Date.now(),
    });

    // Keep only last 100 trades per market
    if (store.trades[market_ticker].length > 100) {
      store.trades[market_ticker].shift();
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:trade', {
          detail: { market_ticker, yes_price, no_price, size, ts: timestamp || Date.now() },
        })
      );
    }
  }

  function handleMarketLifecycle(payload) {
    store.lifecycle = { payload, ts: Date.now() };
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:market_lifecycle', {
          detail: { ...(payload || {}), ts: Date.now() },
        })
      );
    }
  }

  function handleError(payload) {
    const { code, msg: errorMsg } = payload;
    const errorDescription = ERROR_CODES[code] || 'Unknown error';

    const hasPublicMarketData = Object.keys(store.tickers).length > 0 || Object.keys(store.orderbooks).length > 0;
    const logError = code === 13 && hasPublicMarketData ? console.warn : console.error;
    logError(`[KalshiWS] Error ${code}: ${errorMsg} (${errorDescription})`);

    store.errors.push({
      code,
      msg: errorMsg,
      description: errorDescription,
      ts: Date.now(),
    });

    // Keep last 50 errors
    if (store.errors.length > 50) {
      store.errors.shift();
    }

    // Handle specific error codes with recovery
    handleErrorRecovery(code, errorMsg);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:error', {
          detail: { code, msg: errorMsg, description: errorDescription, ts: Date.now() },
        })
      );
    }
  }

  function handleErrorRecovery(code, errorMsg) {
    switch (code) {
      case 2: // Params required
        console.warn('[KalshiWS] Missing params in message — check subscription format');
        break;
      case 3: // Channels required
        console.warn('[KalshiWS] Missing channels array — subscription requires "channels"');
        break;
      case 5: // Unknown command
        console.error('[KalshiWS] Invalid command — check cmd field');
        break;
      case 6: // Already subscribed
        console.warn('[KalshiWS] Duplicate subscription — skipping');
        break;
      case 8: // Unknown channel name
        _logThrottled('invalid-channel', 'error', '[KalshiWS] Invalid channel — valid: ticker, trade, orderbook_delta, fill, market_positions, communications, order_group_updates, market_lifecycle_v2');
        break;
      case 9: // Authentication required
        console.error('[KalshiWS] Private channel requires authentication');
        break;
      case 14: // Market Ticker required
        console.error('[KalshiWS] Market specification required — provide market_ticker or market_id');
        break;
      case 16: // Market not found
        console.error('[KalshiWS] Market not found — verify market_ticker is valid');
        break;
      case 17: // Internal error
        console.error('[KalshiWS] Server-side error — retry later');
        break;
      case 18: // Command timeout
        console.warn('[KalshiWS] Server timeout — retrying subscription');
        // Could implement retry logic here
        break;
      default:
        console.log('[KalshiWS] Error code:', code);
    }
  }

  const ERROR_CODES = {
    1: 'Unable to process message',
    2: 'Params required',
    3: 'Channels required',
    4: 'Subscription IDs required',
    5: 'Unknown command',
    6: 'Already subscribed',
    7: 'Unknown subscription ID',
    8: 'Unknown channel name',
    9: 'Authentication required',
    10: 'Channel error',
    11: 'Invalid parameter',
    12: 'Exactly one subscription ID is required',
    13: 'Unsupported action',
    14: 'Market Ticker required',
    15: 'Action required',
    16: 'Market not found',
    17: 'Internal error',
    18: 'Command timeout',
    19: 'shard_factor must be > 0',
    20: 'shard_factor is required when shard_key is set',
    21: 'shard_key must be >= 0 and < shard_factor',
    22: 'shard_factor must be <= 100',
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Subscriptions
  // ─────────────────────────────────────────────────────────────────────────────

  function subscribeToTicker(marketTickers = []) {
    const list = (Array.isArray(marketTickers) ? marketTickers : []).filter(Boolean);
    const msg = {
      id: messageId++,
      cmd: 'subscribe',  // Kalshi uses cmd for some, but fallback action for compatibility
      params: {
        channels: ['ticker'],
        ...(list.length ? { market_tickers: list } : {}),
      },
    };
    // Some Kalshi WS versions reject certain cmds; try action form as fallback
    const altMsg = {
      id: messageId++,
      action: 'subscribe',
      params: {
        channels: ['ticker'],
        ...(list.length ? { market_tickers: list } : {}),
      },
    };
    pendingSubscriptions.set(msg.id, {
      channels: [...msg.params.channels],
      marketTickers: list,
      ts: Date.now(),
    });
    try {
      sendMessage(msg);
    } catch (e) {
      console.warn('[KalshiWS] cmd subscribe failed, trying action form');
      sendMessage(altMsg);
    }
    console.log(`[KalshiWS] Subscribing to ticker channel (${list.length || 'global'} markets)`);
  }

  function subscribeToOrderbook(marketTickers) {
    if (!marketTickers || marketTickers.length === 0) {
      console.warn('[KalshiWS] No markets specified for orderbook subscription');
      return;
    }

    const msg = {
      id: messageId++,
      cmd: 'subscribe',
      params: {
        channels: ['orderbook_delta'],
        market_tickers: marketTickers,
      },
    };
    pendingSubscriptions.set(msg.id, {
      channels: [...msg.params.channels],
      marketTickers: [...marketTickers],
      ts: Date.now(),
    });
    sendMessage(msg);
    console.log(`[KalshiWS] Subscribing to orderbook for ${marketTickers.length} markets`);
  }

  function subscribeToTrades(marketTickers) {
    if (window.WECRYPTO_KALSHI_WS_TRADES_ENABLED !== true) {
      return;
    }

    if (!marketTickers || marketTickers.length === 0) {
      console.warn('[KalshiWS] No markets specified for trade subscription');
      return;
    }

    const msg = {
      id: messageId++,
      cmd: 'subscribe',
      params: {
        channels: ['trade'],
        market_tickers: marketTickers,
      },
    };
    pendingSubscriptions.set(msg.id, {
      channels: [...msg.params.channels],
      marketTickers: [...marketTickers],
      ts: Date.now(),
    });
    sendMessage(msg);
    console.log(`[KalshiWS] Subscribing to trades for ${marketTickers.length} markets`);
  }

  function unsubscribe(subscriptionIds) {
    if (!subscriptionIds || subscriptionIds.length === 0) {
      console.warn('[KalshiWS] No subscription IDs specified');
      return;
    }

    const msg = {
      id: messageId++,
      cmd: 'unsubscribe',
      params: {
        sids: subscriptionIds,
      },
    };
    sendMessage(msg);
    console.log(`[KalshiWS] Unsubscribing from ${subscriptionIds.length} subscription(s)`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  function sendMessage(msg) {
    const socketOpen = ws && ws.readyState === 1;
    if (!readyToSend || !socketOpen) {
      messageQueue.push(msg);
      return;
    }

    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[KalshiWS] Send error:', err.message);
      messageQueue.push(msg); // Retry on reconnect
    }
  }

  async function disconnect() {
    intentionalDisconnect = true;
    _clearSuspendTimer();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectDueAt = 0;
    }
    _stopHeartbeat();
    _stopStaleWatchdog();
    if (ws) {
      ws.close();
      ws = null;
    }
    connected = false;
    authenticated = false;
    readyToSend = false;
    _emitStatusUpdate('disconnected');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Heartbeat — keeps the connection alive; Kalshi closes idle sockets
  // ─────────────────────────────────────────────────────────────────────────────

  function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = setInterval(() => {
      if (!connected || !readyToSend) return;
      try {
        if (ws && ws.readyState === 1 && typeof ws.ping === 'function') {
          ws.ping();
        }
      } catch (err) {
        console.warn('[KalshiWS] Heartbeat send failed:', err.message);
      }
    }, HEARTBEAT_INTERVAL_MS);
    console.log('[KalshiWS] Heartbeat started (every', HEARTBEAT_INTERVAL_MS / 1000, 's)');
  }

  function _stopHeartbeat() {
    if (_heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }
  }

  function getState() {
    const reconnectInMs = reconnectTimer ? Math.max(0, reconnectDueAt - Date.now()) : 0;
    const connectingForMs = connecting && connectStartedAt ? Math.max(0, Date.now() - connectStartedAt) : 0;
    const suspendInMs = _isSuspended() ? Math.max(0, suspendedUntil - Date.now()) : 0;
    return {
      connected,
      connecting,
      connectingForMs,
      suspended: _isSuspended(),
      suspendInMs,
      suspendUntil: _isSuspended() ? suspendedUntil : 0,
      suspendReason,
      suspendLevel,
      authenticated,
      stale: _isStale(),
      reconnectAttempts,
      reconnectInMs,
      lastMessageTs: lastMessageTs || null,
      lastConnectTs: lastConnectTs || null,
      lastCloseCode,
      lastCloseReason,
      lastError,
      lastFailureClass,
      lastIssueBucket,
      lastIssueReason,
      lastWsCtorSource,
      lastHandshakeStatus,
      lastHandshakeError,
      lastRouteEventReason,
      lastConnectAttempt,
      lastAuthStatus,
      lastAuthError,
      tickers: Object.keys(store.tickers).length,
      trades: Object.values(store.trades).reduce((sum, t) => sum + t.length, 0),
      fills: store.fills.length,
      positions: Object.keys(store.positions).length,
    };
  }

  function getSnapshot() {
    return store;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────────────────────────────

  function subscribeMarkets(marketTickers) {
    const list = _normalizeMarketTickers(marketTickers);
    if (!list.length) return;
    window._kalshiActiveMarkets = list;
    desiredMarketTickers.clear();
    for (const ticker of list) desiredMarketTickers.add(ticker);
    if (!connected) return;
    const signature = _marketSubscriptionSignature(list);
    if (signature === lastSubscriptionSignature) return;

    if (connected && ws && lastSubscriptionSignature) {
      lastSubscriptionSignature = signature;
      intentionalDisconnect = false;
      try { ws.close(); } catch (_) { }
      return;
    }

    lastSubscriptionSignature = signature;
    subscribeToTicker(list);
    subscribeToOrderbook(list);
    subscribeToTrades(list);
  }

  function reconnectNow(reason = 'manual') {
    intentionalDisconnect = false;
    lastRouteEventReason = reason;
    reconnectAttempts = 0;
    _resetSuspendState();
    if (connected && ws) {
      try { ws.close(); } catch (_) { }
      return;
    }
    reconnect(reason);
  }

  function forceRetry(reason = 'manual-force') {
    intentionalDisconnect = false;
    _resetSuspendState();
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectDueAt = 0;
    }
    connect({ reason: `force:${reason}`, force: true }).catch((err) => {
      lastError = _formatError(err);
      const fc = _classifyFailure(err);
      const issue = _classifyIssueBucket(err, fc);
      lastFailureClass = fc;
      lastIssueBucket = issue.bucket;
      lastIssueReason = issue.reason || lastError;
      _emitStatusUpdate(`force-retry-failed:${lastError}`);
    });
  }

  const KalshiWS = {
    connect,
    disconnect,
    reconnectNow,
    forceRetry,
    sendMessage,
    getState,
    getSnapshot,
    subscribeMarkets,
    store, // Direct access for debugging
    DEFAULT_SERIES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KalshiWS;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('proxy-route-change', (event) => {
      const detail = event?.detail || {};
      const stage = String(detail.stage || '');
      const reason = String(detail.reason || 'route-change');
      const proxied = String(detail.proxied || '').toLowerCase();
      const reasonLower = reason.toLowerCase();
      const provider = String(detail.provider || '').toLowerCase();
      const kalshiScoped = provider === 'kalshi' || proxied.includes('/kalshi') || reasonLower.includes('kalshi');
      const wsUnhealthy = !connected || _isStale();
      const nowTs = Date.now();
      const cooldownOk = (nowTs - lastRouteReconnectTs) > 12_000;

      // Avoid reconnect storms from optional-provider proxy churn.
      if ((stage === 'reinit-done' || stage === 'route-error') && cooldownOk && kalshiScoped) {
        lastRouteReconnectTs = nowTs;
        lastRouteEventReason = reason;
        console.info(`[KalshiWS] Route change event (${stage}) → reconnect (${reason})`);
        reconnectNow(`route:${reason}`);
      } else if (!kalshiScoped && wsUnhealthy && stage === 'network-failure') {
        lastFailureClass = String(detail.failureClass || 'network-fail');
        _emitStatusUpdate(`non-kalshi-network-failure:${lastFailureClass}`);
      }
    });

    window.KalshiWS = KalshiWS;
    window.forceKalshiWsRetry = (reason = 'window-hook') => {
      try {
        KalshiWS.forceRetry(reason);
        return true;
      } catch (_) {
        return false;
      }
    };
  }
})();
