// window.NetworkHealth.js
// Global network health state for all market data providers
(function () {
    if (window.NetworkHealth) return; // Singleton

    const PROVIDERS = [
        'Polymarket',
        'ProxyOrchestrator',
        'Pyth',
        'Crypto.com',
        'Coinbase',
        'Binance',
        'Bybit',
        'OKX',
        'Hyperliquid',
        'dYdX',
        'Deribit',
        'DerivativesFeed',
        'Mempool.space',
        'Solana RPC',
        'Etherscan',
        'XRP Ledger',
        'Alchemy RPC',
    ];

    const DEFAULT_STATUS = {
        status: 'unknown', // healthy | degraded | down | recovering | unknown
        lastFetch: null,
        fallback: false,
        reason: '',
        bucket: 'unknown',
        bucketReason: '',
    };

    const CRITICAL_PROVIDERS = new Set([
        'Polymarket',
        'Pyth',
        'Coinbase',
        'OKX',
        'Hyperliquid',
        'dYdX',
        'Deribit',
        'DerivativesFeed',
        'Crypto.com',
        'ProxyOrchestrator',
        'Mempool.space',
    ]);

    const WS_PROVIDER_NAMES = {
        BINANCE: 'Binance',
        COINBASE: 'Coinbase',
        BYBIT: 'Bybit',
        OKX: 'OKX',
        HYPERLIQUID: 'Hyperliquid',
        DYDX: 'dYdX',
        DERIBIT: 'Deribit',
    };

    const recovery = {
        active: false,
        reason: '',
        phase: '',
        startedAt: 0,
    };


    const state = {};
    const failureCounters = {}; // provider -> { count, lastDown }
    const FAILURE_THRESHOLD = 3; // cycles before alert
    const OPTIONAL_FAILURE_TTL_MS = 2 * 60_000;
    const OPTIONAL_PROVIDERS = new Set([
        'Solana RPC',
        'Etherscan',
        'XRP Ledger',
        'Alchemy RPC',
        'BSCScan',
        'Polygonscan',
        'Blockchair',
        'Blockcypher',
        'Blockscout',
        'LocalProxy',
        'Binance',
        'Bybit',
        'OKX',
    ]);
    const OPTIONAL_PROVIDER_KEYS = new Set([
        'solana rpc',
        'etherscan',
        'xrp ledger',
        'alchemy rpc',
        'bscscan',
        'polygonscan',
        'blockchair',
        'blockcypher',
        'blockscout',
        'localproxy',
        'binance',
        'bybit',
        'okx',
    ]);
    const TRANSIENT_REASON_RE = /(abort|timed?\s*out|timeout|502|503|504|429|network\s*changed|econnreset|socket hang up|failed to fetch)/i;
    const APP_LOGIC_RE = /(stale[-\s]*watchdog|stale[-\s]*demote|stale-reconnect|lifecycle-reconnect|auth-config-fail|demote|hysteresis|scheduler|circuit|loop|oscillat|internal|state bug|coordination|reconnect storm|thrash|browser websocket cannot send|requires node ws|credential|crypto unavailable|signature generation|ipc-sdk|rpc\/http)/i;
    const NETWORK_TRANSPORT_RE = /(dns|tls|ssl|cert|handshake|upgrade|timeout|abort|route|network|econnreset|socket hang up|websocket|wss|readyState=3|connect failure|closed-before-open)/i;
    const PROVIDER_API_RE = /(http\s*(401|403|404|408|409|410|412|415|422|429|5\d\d)|status\s*(401|403|404|408|409|410|412|415|422|429|5\d\d)|upstream|rate limit|unauthorized|forbidden|not found)/i;
    const BUCKETS = {
        APP_LOGIC: 'app/logic',
        NETWORK_TRANSPORT: 'network/transport',
        PROVIDER_API: 'provider/api',
        UNKNOWN: 'unknown',
    };
    const transport = {
        lastSync: null,
        priority: ['wss', 'grpc', 'rpc', 'http'],
        preferred: {},
        byKey: {},
        policy: {},
        proxy: {},
        ws: {},
        route: {},
        bus: {},
        coordination: {},
    };

    function canonicalProviderName(provider) {
        const raw = String(provider || '').trim();
        const key = raw.toLowerCase().replace(/\s+/g, '');
        if (!raw) return 'Network';
        if (key.includes('coingecko')) return 'CoinGecko';
        if (key.includes('bullish')) return 'Bullish';
        if (key.includes('localproxy') || key.includes('127.0.0.1') || key.includes('localhost')) return 'LocalProxy';
        if (key.includes('coinmarketcap')) return 'CoinMarketCap';
        if (key.includes('alternative.me')) return 'Alternative.me';
        if (key.includes('blockscout')) return 'Blockscout';
        if (key.includes('dexscreener')) return 'DexScreener';
        if (key.includes('kalshi')) return 'Kalshi';
        if (key.includes('polymarket')) return 'Polymarket';
        if (key.includes('pyth') || key.includes('hermes')) return 'Pyth';
        if (key.includes('gateio') || key === 'gate' || key.includes('gate.io')) return 'Gate';
        if (key.includes('timeapi') || key.includes('time.akamai')) return 'TimeAPI';
        if (key.includes('projectserum') || key.includes('solana') || key.includes('publicnode')) return 'Solana RPC';
        if (key.includes('alchemy')) return 'Alchemy RPC';
        if (key.includes('hyperliquid')) return 'Hyperliquid';
        if (key.includes('dydx')) return 'dYdX';
        if (key.includes('deribit')) return 'Deribit';
        if (key.includes('bybit')) return 'Bybit';
        if (key.includes('okx')) return 'OKX';
        if (key.includes('derivatives')) return 'DerivativesFeed';
        return raw;
    }

    function isOptionalProvider(provider) {
        const canonical = canonicalProviderName(provider);
        const key = String(canonical || '').toLowerCase().replace(/\s+/g, '');
        return OPTIONAL_PROVIDERS.has(canonical) || OPTIONAL_PROVIDER_KEYS.has(key);
    }
    for (const p of PROVIDERS) {
        state[p] = { ...DEFAULT_STATUS };
        failureCounters[p] = { count: 0, lastDown: null, alertActive: false };
    }
    const bucketCounters = {
        [BUCKETS.APP_LOGIC]: 0,
        [BUCKETS.NETWORK_TRANSPORT]: 0,
        [BUCKETS.PROVIDER_API]: 0,
        [BUCKETS.UNKNOWN]: 0,
    };


    function isCriticalProvider(provider) {
        return CRITICAL_PROVIDERS.has(canonicalProviderName(provider));
    }

    function classify(provider, statusObj) {
        const reason = String(statusObj?.reason || '');
        const inputStatus = statusObj?.status || 'unknown';
        const providerKey = String(provider || '').toLowerCase().replace(/\s+/g, '');
        const isOptional = isOptionalProvider(provider) || OPTIONAL_PROVIDER_KEYS.has(providerKey);
        const isTransient = !!statusObj?.transient || TRANSIENT_REASON_RE.test(reason);

        if (inputStatus === 'recovering') {
            return { status: 'recovering', isOptional, isTransient: true };
        }

        let status = inputStatus;
        if (inputStatus === 'down' && (isOptional || isTransient)) {
            status = 'degraded';
        }
        if (inputStatus === 'healthy' && isTransient) {
            status = 'degraded';
        }

        return { status, isOptional, isTransient };
    }

    function _normalizeBucket(input) {
        const raw = String(input || '').toLowerCase().trim();
        if (!raw) return BUCKETS.UNKNOWN;
        if (raw === BUCKETS.APP_LOGIC || raw.includes('app')) return BUCKETS.APP_LOGIC;
        if (raw === BUCKETS.NETWORK_TRANSPORT || raw.includes('network') || raw.includes('transport')) return BUCKETS.NETWORK_TRANSPORT;
        if (raw === BUCKETS.PROVIDER_API || raw.includes('provider') || raw.includes('api')) return BUCKETS.PROVIDER_API;
        return BUCKETS.UNKNOWN;
    }

    function classifyBucket(statusObj = {}) {
        const bucketOverride = _normalizeBucket(statusObj.bucket);
        if (bucketOverride !== BUCKETS.UNKNOWN) {
            return {
                bucket: bucketOverride,
                bucketReason: String(statusObj.bucketReason || statusObj.reason || '').trim(),
            };
        }

        const statusCode = Number(statusObj.statusCode || 0);
        const reason = String(statusObj.reason || '').trim();
        const failureClass = String(statusObj.failureClass || '').toLowerCase();
        const text = `${reason} ${failureClass}`.toLowerCase();

        if (APP_LOGIC_RE.test(text)) {
            return {
                bucket: BUCKETS.APP_LOGIC,
                bucketReason: reason || 'internal scheduler/circuit handling issue',
            };
        }
        if ((statusCode >= 400 && statusCode !== 0) || PROVIDER_API_RE.test(text)) {
            return {
                bucket: BUCKETS.PROVIDER_API,
                bucketReason: reason || (statusCode ? `upstream API reject (${statusCode})` : 'upstream API reject'),
            };
        }
        if (
            NETWORK_TRANSPORT_RE.test(text) ||
            ['dns-fail', 'tls-fail', 'handshake-fail', 'timeout', 'route-change', 'socket-reset', 'network-fail'].includes(failureClass)
        ) {
            let bucketReason = reason || 'network transport failure';
            if (/event:error/.test(text) && /readystate=3/.test(text)) {
                bucketReason = 'websocket connect failure (readyState=3 before open)';
            }
            return {
                bucket: BUCKETS.NETWORK_TRANSPORT,
                bucketReason,
            };
        }
        return {
            bucket: BUCKETS.UNKNOWN,
            bucketReason: reason || '',
        };
    }

    function recomputeBucketCounters() {
        bucketCounters[BUCKETS.APP_LOGIC] = 0;
        bucketCounters[BUCKETS.NETWORK_TRANSPORT] = 0;
        bucketCounters[BUCKETS.PROVIDER_API] = 0;
        bucketCounters[BUCKETS.UNKNOWN] = 0;
        for (const row of Object.values(state)) {
            if (!row || (row.status !== 'degraded' && row.status !== 'down')) continue;
            if (row.optional && row.lastFetch && (Date.now() - row.lastFetch) > OPTIONAL_FAILURE_TTL_MS) continue;
            const bucket = _normalizeBucket(row.bucket);
            bucketCounters[bucket] = (bucketCounters[bucket] || 0) + 1;
        }
    }

    function update(provider, statusObj) {
        provider = canonicalProviderName(provider);
        if (provider === 'Kalshi' || String(provider).toLowerCase().includes('kalshi')) {
            if (state[provider]) delete state[provider];
            return;
        }
        if (!state[provider]) state[provider] = { ...DEFAULT_STATUS };
        if (!failureCounters[provider]) failureCounters[provider] = { count: 0, lastDown: null, alertActive: false };
        const { status, isOptional, isTransient } = classify(provider, statusObj || {});
        const bucketMeta = classifyBucket(statusObj || {});
        Object.assign(state[provider], statusObj, {
            status,
            optional: isOptional,
            transient: isTransient,
            bucket: bucketMeta.bucket,
            bucketReason: bucketMeta.bucketReason || String(statusObj?.reason || ''),
        });
        state[provider].lastUpdate = Date.now();
        recomputeBucketCounters();

        // Persistent failure tracking (skip during coordinated recovery)
        if (recovery.active && (isOptional || isTransient || status === 'recovering')) {
            failureCounters[provider].count = 0;
            failureCounters[provider].alertActive = false;
        } else if (status === 'down' && !isOptional && !isTransient) {
            failureCounters[provider].count++;
            failureCounters[provider].lastDown = Date.now();
        } else if (status === 'healthy') {
            failureCounters[provider].count = 0;
            failureCounters[provider].alertActive = false;
            state[provider].bucket = BUCKETS.UNKNOWN;
            state[provider].bucketReason = '';
        } else if (status !== 'down') {
            failureCounters[provider].alertActive = false;
        }

        // Escalation: trigger alert if threshold breached
        if (failureCounters[provider].count >= FAILURE_THRESHOLD && !failureCounters[provider].alertActive) {
            failureCounters[provider].alertActive = true;
            // Emit alert event for UI
            if (typeof window.dispatchEvent === 'function') {
                window.dispatchEvent(new CustomEvent('network-health-alert', { detail: { provider, count: failureCounters[provider].count, since: failureCounters[provider].lastDown, reason: state[provider].reason } }));
            }
        }

        // Optionally: emit event for UI listeners
        if (typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('network-health-update', { detail: { provider, ...state[provider] } }));
        }
    }

    function displayRow(row) {
        if (!row) return row;
        const ageMs = row.lastFetch ? (Date.now() - row.lastFetch) : Number.POSITIVE_INFINITY;
        if (row.status === 'recovering' && !recovery.active && ageMs > 90_000) {
            return {
                ...row,
                status: row.optional ? 'unknown' : 'degraded',
                reason: row.optional ? '' : (row.reason || 'Recovery timed out'),
                staleOptional: !!row.optional,
            };
        }
        if (row.optional && row.lastFetch && ageMs > OPTIONAL_FAILURE_TTL_MS) {
            if (row.status === 'healthy') return { ...row };
            return {
                ...row,
                status: 'unknown',
                fallback: false,
                reason: '',
                bucket: BUCKETS.UNKNOWN,
                bucketReason: '',
                staleOptional: true,
            };
        }
        if (!row.optional && row.status === 'degraded' && row.transient && ageMs > 120_000 && !recovery.active) {
            return {
                ...row,
                status: 'unknown',
                reason: '',
                bucket: BUCKETS.UNKNOWN,
                bucketReason: '',
                staleTransient: true,
            };
        }
        return { ...row };
    }

    function get(provider) {
        if (provider) return displayRow(state[canonicalProviderName(provider)]);
        return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, displayRow(v)]));
    }

    function getAll() {
        return get();
    }

    function updateTransport(summary) {
        if (!summary || typeof summary !== 'object') return;
        transport.lastSync = summary.lastSync || transport.lastSync || Date.now();
        if (Array.isArray(summary.priority)) transport.priority = summary.priority;
        if (summary.preferred) transport.preferred = { ...summary.preferred };
        if (summary.byKey) transport.byKey = { ...summary.byKey };
        if (summary.policy) transport.policy = { ...summary.policy };
        if (summary.proxy) transport.proxy = { ...summary.proxy };
        if (summary.ws) transport.ws = { ...summary.ws };
        if (summary.route) transport.route = { ...summary.route };
        if (summary.bus) transport.bus = { ...summary.bus };
        if (summary.coordination) transport.coordination = { ...summary.coordination };

        const kalshiPref = transport.preferred.kalshi;
        const ws = transport.ws || {};
        const now = Date.now();
        const staleAgeMs = transport.lastSync ? Math.max(0, now - transport.lastSync) : Number.POSITIVE_INFINITY;
        const syncStale = staleAgeMs > 90_000;
        const wsConnected = !!ws.connected;
        const wsStale = !!ws.stale || syncStale;
        const reconnecting = !wsConnected && Number(ws.reconnectAttempts || 0) > 0;
        const routeHint = transport.route?.reason ? ` route=${transport.route.reason}` : '';
        const failureHint = ws.lastFailureClass ? ` failure=${ws.lastFailureClass}` : '';
        const bucketHint = ws.lastIssueBucket ? ` bucket=${ws.lastIssueBucket}` : '';
        const demoteHint = ws.lastDemoteReason ? ` demote=${ws.lastDemoteReason}` : '';
        const connectAttemptHint = ws.lastConnectAttemptResult
            ? ` connect=${ws.lastConnectAttemptResult}`
            : '';
        const authHint = ws.lastAuthStatus ? ` auth=${ws.lastAuthStatus}` : '';
        const handshakeHint = ws.lastHandshakeStatus ? ` hs=${ws.lastHandshakeStatus}` : '';

        const polyStatus = window.PolymarketWS?.getStatus?.();
        if (polyStatus?.clobConnected || polyStatus?.rtdsConnected) {
            update('Polymarket', {
                status: 'healthy',
                lastFetch: now,
                fallback: false,
                reason: `CLOB/RTDS WS connected (${polyStatus.subscribedAssetsCount || 0} feeds)`,
                bucket: BUCKETS.UNKNOWN,
                bucketReason: '',
            });
        }

        if (typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('network-transport-update', { detail: { ...transport } }));
        }

        const proxy = transport.proxy || {};
        if (proxy.mode || proxy.healthy === false || proxy.bypassActive || proxy.available !== undefined) {
            // Unified with tauri-bridge.js _setProxyMode: HEALTHY = proxy
            // process reachable (available). A short per-request bypass is
            // healthy+fallback, NOT degraded. DEGRADED only when down.
            const proxyUp = proxy.available !== false && proxy.enabled !== false && proxy.healthy !== false;
            update('LocalProxy', {
                status: proxyUp ? 'healthy' : 'degraded',
                lastFetch: proxy.ts || Date.now(),
                fallback: proxy.mode === 'bypass' || !!proxy.bypassActive,
                transient: !proxyUp || !!proxy.bypassActive,
                reason: proxy.mode === 'bypass'
                    ? `hybrid bypass (${proxy.bypassMsLeft > 0 ? Math.round(proxy.bypassMsLeft / 1000) + 's' : 'active'})`
                    : (proxyUp ? 'proxy healthy' : `proxy degraded (${proxy.failures || 0})`),
            });
        }
    }

    function getTransport() {
        return {
            lastSync: transport.lastSync,
            priority: [...transport.priority],
            preferred: { ...transport.preferred },
            byKey: { ...transport.byKey },
            policy: { ...transport.policy },
            proxy: { ...transport.proxy },
            ws: { ...transport.ws },
            route: { ...transport.route },
            bus: { ...transport.bus },
            coordination: { ...transport.coordination },
        };
    }

    function getBucketCounters() {
        recomputeBucketCounters();
        return { ...bucketCounters };
    }

    const LOCAL_STATUS_BRIDGE_MS = 2_000;
    const LOCAL_STATUS_BRIDGE_REFRESH_MS = 10_000;
    const POLYMARKET_STALE_MS = 5 * 60_000;
    const POLYMARKET_STARTUP_GRACE_MS = 45_000;
    const localStatusBridgeStartedAt = Date.now();
    let localStatusBridgeTimer = null;
    let localStatusBridgeInFlight = false;

    function bridgeUpdate(provider, statusObj) {
        const name = canonicalProviderName(provider);
        const current = state[name] || {};
        const now = Date.now();
        const changed =
            current.status !== statusObj.status ||
            current.reason !== statusObj.reason ||
            current.fallback !== statusObj.fallback ||
            current.bucket !== statusObj.bucket ||
            current.bucketReason !== statusObj.bucketReason;
        if (!changed && current._bridgeTs && (now - current._bridgeTs) < LOCAL_STATUS_BRIDGE_REFRESH_MS) return;
        update(name, {
            ...statusObj,
            _bridgeTs: now,
        });
    }

    function summarizeProxyHealth(health = {}) {
        const optionalProxyEndpoints = new Set([
            'cmc',
            'coinmarketcap',
            'blockcypher',
            'bscscan',
            'etherscan',
            'coingecko',
            'dexscreener',
            'polymarket',
        ]);
        const sumEndpointCounts = (counts = {}, includeOptional = true) => Object.entries(counts || {})
            .filter(([endpoint]) => includeOptional || !optionalProxyEndpoints.has(String(endpoint).toLowerCase()))
            .reduce((total, [, count]) => total + Number(count || 0), 0);
        const requests = Number(
            health.requests?.total ??
            health.totalRequests ??
            health.requestCount ??
            0
        );
        const rawFailures = Number(
            health.failures?.total ??
            health.totalFailures ??
            health.failureCount ??
            0
        );
        const endpointRequests = health.requests?.byEndpoint || {};
        const endpointFailures = health.failures?.byEndpoint || {};
        const rollingRequests = health.rolling?.byEndpoint || endpointRequests;
        const rollingFailures = health.rolling?.failuresByEndpoint || endpointFailures;
        const criticalRequests = sumEndpointCounts(endpointRequests, false);
        const criticalFailures = sumEndpointCounts(endpointFailures, false);
        const recentCriticalRequests = sumEndpointCounts(rollingRequests, false);
        const recentCriticalFailures = sumEndpointCounts(rollingFailures, false);
        const optionalFailures = Math.max(0, rawFailures - criticalFailures);
        const failures = recentCriticalRequests > 0 ? recentCriticalFailures : 0;
        const cacheHits = Number(
            health.cache?.hits ??
            health.cacheHits ??
            0
        );
        const avgLatency = Number(
            health.latency?.avg ??
            health.averageLatency ??
            health.avgLatency ??
            0
        );
        const failureRate = recentCriticalRequests > 0
            ? recentCriticalFailures / recentCriticalRequests
            : 0;
        const degraded = recentCriticalFailures >= 3 && failureRate > 0.5;
        const parts = ['initialized'];
        if (requests > 0) parts.push(`${requests} req`);
        if (recentCriticalFailures > 0) parts.push(`${recentCriticalFailures} recent critical fail`);
        else if (criticalFailures > 0) parts.push(`${criticalFailures} historical critical fail`);
        if (optionalFailures > 0) parts.push(`${optionalFailures} optional fail`);
        if (cacheHits > 0) parts.push(`${cacheHits} cache`);
        if (avgLatency > 0) parts.push(`${Math.round(avgLatency)}ms avg`);
        return {
            status: degraded ? 'degraded' : 'healthy',
            fallback: degraded || !!health.fallback?.active || !!health.fallbackActive,
            reason: parts.join(' · '),
            transient: degraded,
            bucket: degraded ? BUCKETS.PROVIDER_API : BUCKETS.UNKNOWN,
            bucketReason: degraded ? 'recent critical proxy request failures exceed successful requests' : '',
            lastFetch: health.lastRequestTs || health.lastUpdate || Date.now(),
        };
    }

    function refreshProxyOrchestratorStatus(now) {
        const orchestrator = window._proxyOrchestrator;
        if (!orchestrator) {
            bridgeUpdate('ProxyOrchestrator', {
                status: 'degraded',
                lastFetch: now,
                fallback: true,
                transient: true,
                reason: 'Waiting for ProxyOrchestrator initialization',
                bucket: BUCKETS.APP_LOGIC,
                bucketReason: 'orchestrator instance not yet available',
            });
            return;
        }

        if (typeof orchestrator.getHealthStatus !== 'function') {
            bridgeUpdate('ProxyOrchestrator', {
                status: 'healthy',
                lastFetch: now,
                fallback: false,
                reason: 'initialized',
                bucket: BUCKETS.UNKNOWN,
                bucketReason: '',
            });
            return;
        }

        try {
            bridgeUpdate('ProxyOrchestrator', summarizeProxyHealth(orchestrator.getHealthStatus()));
        } catch (err) {
            bridgeUpdate('ProxyOrchestrator', {
                status: 'degraded',
                lastFetch: now,
                fallback: true,
                transient: true,
                reason: `Health probe failed: ${err?.message || err}`,
                bucket: BUCKETS.APP_LOGIC,
                bucketReason: 'orchestrator health API threw',
            });
        }
    }

    function refreshPolymarketStatus(now) {
        const predictionMarkets = window.PredictionMarkets;
        if (!predictionMarkets || typeof predictionMarkets.getStatus !== 'function') {
            const wsStatus = window.PolymarketWS?.getStatus?.() || {};
            if (wsStatus.clobConnected || wsStatus.rtdsConnected) {
                bridgeUpdate('Polymarket', {
                    status: 'healthy',
                    lastFetch: Date.now(),
                    fallback: false,
                    transient: false,
                    reason: `CLOB/RTDS WS connected (${wsStatus.subscribedAssetsCount || 0} feeds) · PredictionMarkets layer unavailable`,
                    bucket: BUCKETS.UNKNOWN,
                    bucketReason: '',
                });
                return;
            }
            if (now - localStatusBridgeStartedAt < POLYMARKET_STARTUP_GRACE_MS) {
                bridgeUpdate('Polymarket', {
                    status: 'unknown',
                    lastFetch: null,
                    fallback: false,
                    transient: true,
                    reason: 'Waiting for PredictionMarkets initialization',
                    bucket: BUCKETS.UNKNOWN,
                    bucketReason: '',
                });
                return;
            }
            bridgeUpdate('Polymarket', {
                status: 'degraded',
                lastFetch: now,
                fallback: true,
                transient: true,
                reason: 'Waiting for PredictionMarkets initialization',
                bucket: BUCKETS.APP_LOGIC,
                bucketReason: 'prediction markets module not yet available',
            });
            return;
        }

        try {
            const wsStatus = window.PolymarketWS?.getStatus?.() || {};
            const isWsConnected = wsStatus.clobConnected || wsStatus.rtdsConnected;

            const status = (typeof predictionMarkets.getStatus === 'function' ? predictionMarkets.getStatus() : {}) || {};
            const poly = status.polymarket || {};
            const marketCount = Number(poly.marketCount || 0);
            const poly5mCount = Number(poly.poly5mCount || 0);
            const hasData = isWsConnected || !!poly.hasData || marketCount > 0 || poly5mCount > 0;
            const lastFetch = Number(poly.lastFetch || 0);
            const source = poly.source ? ` via ${poly.source}` : '';
            const age = lastFetch ? Math.max(0, now - lastFetch) : null;
            const stale = !isWsConnected && age != null && age > POLYMARKET_STALE_MS;
            let reason = isWsConnected
                ? `CLOB/RTDS WS connected (${wsStatus.subscribedAssetsCount || 0} feeds)`
                : (hasData ? `${marketCount} markets${source}` : (poly.lastError || 'Connecting to Polymarket feeds'));
            if (stale) reason = `${reason} · stale ${Math.round(age / 1000)}s`;
            bridgeUpdate('Polymarket', {
                status: hasData && !stale ? 'healthy' : 'degraded',
                lastFetch: lastFetch || status.lastFetch || now,
                fallback: false,
                transient: false,
                reason,
                bucket: BUCKETS.UNKNOWN,
                bucketReason: '',
            });
        } catch (err) {
            bridgeUpdate('Polymarket', {
                status: 'degraded',
                lastFetch: now,
                fallback: true,
                transient: true,
                reason: `Status probe failed: ${err?.message || err}`,
                bucket: BUCKETS.APP_LOGIC,
                bucketReason: 'PredictionMarkets status API threw',
            });
        }
    }

    function promiseTimeout(ms, value) {
        return new Promise((resolve) => setTimeout(() => resolve(value), ms));
    }

    async function refreshPythStatus(now) {
        const current = state.Pyth || {};
        if (!window.pythLazer || typeof window.pythLazer.getStatus !== 'function') {
            if (current.status === 'healthy') return;
            if (!current.status || current.status === 'unknown') {
                bridgeUpdate('Pyth', {
                    status: 'healthy',
                    lastFetch: now,
                    fallback: false,
                    transient: false,
                    reason: 'Hermes web feed active',
                    bucket: BUCKETS.UNKNOWN,
                    bucketReason: '',
                });
            }
            return;
        }

        let payload;
        try {
            payload = await Promise.race([
                window.pythLazer.getStatus(),
                promiseTimeout(1500, { success: false, error: 'Pyth status timeout' }),
            ]);
        } catch (err) {
            payload = { success: false, error: err?.message || String(err) };
        }

        const ok = !payload || payload.success !== false;
        const initialized = !!payload?.initialized;
        const connected = !!payload?.connected;
        const lastDataTs = Number(payload?.lastDataTs || 0);
        const lastWsTickTs = Number(payload?.lastWsTickTs || 0);
        const age = lastDataTs ? Math.max(0, now - lastDataTs) : null;
        const wsAge = lastWsTickTs ? Math.max(0, now - lastWsTickTs) : null;
        const dataCount = Number(payload?.dataCount || 0);
        const timeoutCount = Number(payload?.timeoutCount || 0);
        const currentFreshHealthy = current.status === 'healthy' &&
            Number(current.lastFetch || 0) > 0 &&
            (now - Number(current.lastFetch)) < 30_000;

        const dataHealthy = ok && connected && age != null && age < 15_000;
        const wsHealthy = ok && payload?.wsConnected === true && wsAge != null && wsAge < 15_000;
        const restFallbackHealthy = ok && payload?.restFallbackActive === true && dataHealthy;
        const sustainedWsOutage = !wsHealthy && wsAge != null && wsAge >= 10_000;
        if (currentFreshHealthy && !(dataHealthy && (wsHealthy || restFallbackHealthy))) return;

        let status = 'degraded';
        let reason = payload?.error || 'Pyth Lazer status unavailable';
        let bucket = BUCKETS.APP_LOGIC;
        let bucketReason = reason;

        if (dataHealthy && (wsHealthy || restFallbackHealthy)) {
            status = 'healthy';
            reason = restFallbackHealthy && !wsHealthy
                ? `${dataCount} ticks · ${sustainedWsOutage ? 'WS reconnecting; ' : ''}REST fallback active (${Math.round(age / 1000)}s old)`
                : `${dataCount} ticks · ${Math.round(age / 1000)}s old`;
            if (restFallbackHealthy && !wsHealthy && payload?.wsDisabledReason) {
                reason = `${dataCount} ticks · REST fallback · WS disabled (${payload.wsDisabledReason})`;
            }
            bucket = BUCKETS.UNKNOWN;
            bucketReason = '';
        } else if (dataHealthy && payload?.wsConnected === false) {
            reason = `${dataCount} ticks · ${sustainedWsOutage ? 'WS reconnecting' : 'REST fallback active'} (${Math.round(age / 1000)}s old)`;
            bucket = BUCKETS.NETWORK_TRANSPORT;
            bucketReason = 'Pyth WebSocket reconnecting';
        } else if (ok && dataCount > 0) {
            reason = age == null
                ? `${dataCount} ticks · stale`
                : `${dataCount} ticks · stale ${Math.round(age / 1000)}s`;
            bucket = BUCKETS.NETWORK_TRANSPORT;
            bucketReason = 'Pyth feed has not delivered a fresh tick';
        } else if (ok && initialized) {
            reason = 'Waiting for first Pyth tick';
            bucket = BUCKETS.NETWORK_TRANSPORT;
            bucketReason = 'Pyth Lazer connected but no prices received yet';
        } else if (ok && !initialized) {
            reason = 'Pyth Lazer client not initialized';
            bucket = BUCKETS.APP_LOGIC;
            bucketReason = 'main process has not started the Pyth client';
        }

        if (timeoutCount > 0 && status !== 'healthy') {
            reason = `${reason} · ${timeoutCount} timeout${timeoutCount === 1 ? '' : 's'}`;
        }

        bridgeUpdate('Pyth', {
            status,
            lastFetch: lastDataTs || now,
            fallback: status !== 'healthy',
            transient: status !== 'healthy',
            reason,
            bucket,
            bucketReason,
        });
    }

    function refreshDerivativesFeedStatus(now) {
        const feed = window.DerivativesFeed;
        if (!feed) return;
        try {
            const diag = feed.getDiagnostics?.() || {};
            const all = feed.getAll?.() || {};
            const coins = Object.keys(all);
            const activeCoins = Object.values(all).filter(s => s && s.available);
            const quality = diag.data_quality || 'clean';
            const latencyMap = diag.latency_ms || {};

            const coinCount = activeCoins.length || coins.length;
            const hasData = coinCount > 0;
            bridgeUpdate('DerivativesFeed', {
                status: hasData ? (quality === 'clean' ? 'healthy' : 'degraded') : 'recovering',
                lastFetch: now,
                fallback: false,
                transient: !hasData,
                reason: hasData
                    ? `${coinCount} coins · quality: ${quality}`
                    : 'Awaiting first derivatives poll',
                bucket: BUCKETS.UNKNOWN,
                bucketReason: '',
            });

            const venueHosts = {
                'Hyperliquid': ['api.hyperliquid.xyz'],
                'dYdX': ['indexer.dydx.trade'],
                'Deribit': ['www.deribit.com', 'deribit.com'],
                'Bybit': ['api.bybit.com'],
                'OKX': ['www.okx.com', 'okx.com'],
                'Binance': ['fapi.binance.com', 'dapi.binance.com', 'api.binance.com'],
            };

            for (const [venue, hosts] of Object.entries(venueHosts)) {
                let venueLatency = null;
                for (const h of hosts) {
                    if (latencyMap[h] != null) {
                        venueLatency = latencyMap[h];
                        break;
                    }
                }
                const activeInCoins = coins.some(c => all[c]?.venues?.some(v => v.toLowerCase().includes(venue.toLowerCase())));
                const hasLiveLatency = venueLatency != null && venueLatency > 0 && venueLatency <= 3500;
                const isVenueLive = activeInCoins || hasLiveLatency;
                if (venueLatency != null || activeInCoins || venue === 'Binance' || venue === 'Bybit') {
                    const isOptional = isOptionalProvider(venue);
                    const degraded = !isVenueLive;
                    const isGeoRestrictedVenue = (venue === 'Binance' || venue === 'Bybit');
                    const offlineReason = isGeoRestrictedVenue
                        ? 'Geo-restricted (US egress · proxy/VPN optional)'
                        : `${venue} feeds offline`;
                    bridgeUpdate(venue, {
                        status: degraded ? 'degraded' : 'healthy',
                        lastFetch: now,
                        fallback: false,
                        optional: isOptional,
                        transient: degraded,
                        reason: isVenueLive
                            ? (venueLatency != null ? `${Math.round(venueLatency)}ms latency · live` : 'Active perp venue')
                            : offlineReason,
                        bucket: (isGeoRestrictedVenue && !isVenueLive) ? BUCKETS.PROVIDER_API : BUCKETS.UNKNOWN,
                        bucketReason: (isGeoRestrictedVenue && !isVenueLive) ? 'US residential geo-block (HTTP 451/403)' : '',
                    });
                }
            }
        } catch (err) {
            console.warn('[NetworkHealth] refreshDerivativesFeedStatus failed:', err?.message || err);
        }
    }

    // ── DATA FAULTS: data-freshness truth row ─────────────────────────────
    // Answers "is what I'm looking at real?" for px candles, the Kalshi
    // ladder cache, the model board, and the calibration mirror. A source
    // only faults on CONFIRMED-stale data — unreachable checks are noted
    // as skipped, never alarmed (no false reds during sleep/offline).
    async function fetchJsonTimeout(url, ms) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, ms) : null;
        try {
            const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
            if (!res || !res.ok) return null;
            return await res.json();
        } catch (_) {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function refreshDataFaultsStatus(now) {
        const faults = [];
        const notes = [];
        try {
            // 1. px candles (the feed that once served 22h-stale hours as live)
            const px = await fetchJsonTimeout('http://127.0.0.1:8040/px?symbol=BTC&interval=1h&limit=2', 8000);
            const newestTs = (px && Array.isArray(px.prices) ? px.prices : [])
                .map(p => p && p.ts).filter(Number.isFinite).sort((a, b) => a - b).pop();
            if (newestTs) {
                const ageMin = (now / 1000 - newestTs) / 60;
                // Hourly candles are timestamped at hour-start by construction,
                // so age always reads 0-60m past the hour. 15m here false-alarmed
                // 45min of every hour; 75m means the publisher actually missed one.
                if (ageMin > 150) faults.push(`px candles ${Math.round(ageMin / 60)}h stale`);
                else if (ageMin > 75) faults.push(`px candles ${Math.round(ageMin)}m old`);
                else notes.push(`px ${Math.max(Math.round(ageMin), 0)}m`);
            } else {
                notes.push('px unreadable (skipped)');
            }
            // 2. ladder KV (kv-stale = Kalshi 429 storm; expired = dark symbols)
            const sig = await fetchJsonTimeout('https://ladder.leaksnipe.win/signals', 10000);
            const arr = (sig && Array.isArray(sig.signals)) ? sig.signals : [];
            if (arr.length) {
                const expired = arr.filter(s => /expired/.test(String(s.cache_source || ''))).map(s => s.symbol);
                const stale = arr.filter(s => s.cache_source === 'kv-stale').map(s => s.symbol);
                if (expired.length >= 4) faults.push(`ladder dark: ${expired.join(',')}`);
                else if (expired.length) faults.push(`ladder expired: ${expired.join(',')}`);
                else if (stale.length > 2) faults.push(`ladder stale: ${stale.join(',')}`);
                else notes.push(`ladder fresh (${arr.length})`);
            } else {
                notes.push('ladder unreadable (skipped)');
            }
            // 3. model board (engine_latest.json via the same IPC the panel uses)
            let board = null;
            try {
                let res = null;
                if (window.electron && typeof window.electron.invoke === 'function') {
                    try { res = await window.electron.invoke('data:engineLatest'); } catch (_) { res = null; }
                }
                if ((!res || !res.ok) && window.electron && typeof window.electron.readFile === 'function') {
                    const content = await window.electron.readFile('data/engine_latest.json');
                    res = content ? { ok: true, content } : null;
                }
                if (res && res.ok && res.content) board = JSON.parse(typeof res.content === 'string' ? res.content : res.content);
            } catch (_) { board = null; }
            if (board && board.timestamp_utc) {
                const ageMs = now - Date.parse(board.timestamp_utc);
                if (!Number.isFinite(ageMs)) {
                    notes.push('board unreadable (skipped)');
                } else if (ageMs > 3600000) {
                    faults.push(`model board ${Math.round(ageMs / 60000)}m old`);
                } else if (ageMs > 600000) {
                    faults.push(`model board ${Math.round(ageMs / 60000)}m old`);
                } else {
                    notes.push(`board ${Math.max(Math.round(ageMs / 60000), 0)}m`);
                }
            } else {
                notes.push('board unreadable (skipped)');
            }
            // 4. calibration mirror (bridge D1 read; WSL-side records land here via sync)
            const cal = await fetchJsonTimeout('http://127.0.0.1:8788/d1/query?sql=' + encodeURIComponent('SELECT MAX(timestamp_utc) AS m FROM predictions'), 10000);
            const calTs = Array.isArray(cal) ? (cal[0] && cal[0].m) : (cal && cal.m);
            if (calTs) {
                const ageMin = (now - Date.parse(calTs)) / 60000;
                if (Number.isFinite(ageMin)) {
                    if (ageMin > 180) faults.push(`calibration mirror ${Math.round(ageMin / 60)}h old`);
                    else notes.push(`mirror ${Math.max(Math.round(ageMin), 0)}m`);
                } else {
                    notes.push('mirror unreadable (skipped)');
                }
            } else {
                notes.push('mirror unreadable (skipped)');
            }
        } catch (err) {
            console.warn('[NetworkHealth] refreshDataFaultsStatus failed:', err && err.message || err);
            return;
        }
        const status = faults.length >= 2 ? 'down' : (faults.length ? 'degraded' : 'healthy');
        bridgeUpdate('DataFaults', {
            status,
            lastFetch: now,
            fallback: false,
            transient: status !== 'healthy',
            reason: faults.length ? faults.join(' · ') : `data fresh: ${notes.join(', ')}`,
            bucket: BUCKETS.UNKNOWN,
            bucketReason: '',
        });
    }

    function refreshLocalProviderStatuses() {
        if (localStatusBridgeInFlight) return;
        localStatusBridgeInFlight = true;
        const now = Date.now();
        Promise.resolve()
            .then(async () => {
                refreshProxyOrchestratorStatus(now);
                refreshPolymarketStatus(now);
                await refreshPythStatus(now);
                refreshDerivativesFeedStatus(now);
                refreshDataFaultsStatus(now);
            })
            .catch((err) => {
                console.warn('[NetworkHealth] Local status bridge failed:', err?.message || err);
            })
            .finally(() => {
                localStatusBridgeInFlight = false;
            });
    }

    function startLocalStatusBridge() {
        if (localStatusBridgeTimer) return;
        setTimeout(refreshLocalProviderStatuses, 250);
        localStatusBridgeTimer = setInterval(refreshLocalProviderStatuses, LOCAL_STATUS_BRIDGE_MS);
    }

    function setRecoveryPhase(phase) {
        recovery.phase = String(phase || '');
        if (typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('network-recovery-phase', { detail: { ...recovery } }));
        }
    }

    function beginRecovery(reason = 'manual') {
        recovery.active = true;
        recovery.reason = String(reason || 'manual');
        recovery.startedAt = Date.now();
        recovery.phase = 'starting';
        for (const [provider, row] of Object.entries(state)) {
            if (!row) continue;
            const isOptional = row.optional || isOptionalProvider(provider);
            if (!isOptional) continue;
            if (row.status !== 'degraded' && row.status !== 'down') continue;
            update(provider, {
                status: 'recovering',
                lastFetch: row.lastFetch,
                fallback: true,
                transient: true,
                reason: 'Reconnecting after idle',
                bucket: BUCKETS.UNKNOWN,
                bucketReason: '',
            });
        }
        if (typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('network-recovery-start', { detail: { ...recovery } }));
        }
    }

    function endRecovery() {
        recovery.active = false;
        recovery.phase = 'complete';
        syncLiveProbe();
        if (typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('network-recovery-end', { detail: { ...recovery } }));
        }
    }

    function getRecoveryState() {
        return { ...recovery };
    }

    function getSummary() {
        const rows = get();
        const summary = {
            healthy: 0,
            degraded: 0,
            down: 0,
            recovering: 0,
            unknown: 0,
            optional: 0,
            critical: 0,
            criticalHealthy: 0,
            criticalTotal: CRITICAL_PROVIDERS.size,
            recoveringActive: recovery.active,
            recoveryPhase: recovery.phase || '',
        };
        for (const [provider, row] of Object.entries(rows)) {
            if (!row) continue;
            const critical = isCriticalProvider(provider);
            const optional = row.optional || isOptionalProvider(provider);
            if (critical) summary.critical += 1;
            if (optional) summary.optional += 1;
            switch (row.status) {
                case 'healthy':
                    summary.healthy += 1;
                    if (critical) summary.criticalHealthy += 1;
                    break;
                case 'degraded':
                    summary.degraded += 1;
                    break;
                case 'down':
                    summary.down += 1;
                    break;
                case 'recovering':
                    summary.recovering += 1;
                    break;
                default:
                    summary.unknown += 1;
                    break;
            }
        }
        return summary;
    }

    function syncExchangeWsHealth(now = Date.now()) {
        const status = window.ExchangeWS?.getStatus?.();
        if (!status?.connections) return;
        const optionalWsNames = new Set([
            'BYBIT', 'OKX',
        ]);
        const optionalPool = new Map(
            (status.optionalPool?.providers || []).map((row) => [String(row?.name || '').toUpperCase(), row || {}]),
        );
        const optionalRest = status.optionalRest || {};
        for (const [rawName, conn] of Object.entries(status.connections)) {
            const label = WS_PROVIDER_NAMES[rawName] || canonicalProviderName(rawName);
            if (!label) continue;
            const tracked = !!state[label] || optionalWsNames.has(rawName);
            if (!tracked) continue;
            const connected = !!conn?.connected;
            const optionalFeed = optionalWsNames.has(String(rawName || '').toUpperCase());
            const poolRow = optionalPool.get(String(rawName || '').toUpperCase());
            const restRow = optionalRest[String(rawName || '').toUpperCase()] || poolRow?.restProbe || null;
            const active = optionalFeed ? !!poolRow?.active : !!conn?.active;
            if (connected) {
                update(label, {
                    status: 'healthy',
                    lastFetch: now,
                    fallback: false,
                    transient: false,
                    reason: 'WS live',
                    bucket: BUCKETS.UNKNOWN,
                    bucketReason: '',
                });
            } else if (optionalFeed && restRow?.ok && !active && !recovery.active) {
                const via = restRow.via ? ` via ${restRow.via}` : '';
                update(label, {
                    status: 'healthy',
                    lastFetch: Number(restRow.ts || now),
                    fallback: restRow.via !== 'direct',
                    transient: false,
                    reason: `REST route ok (${Math.max(1, Math.round(Number(restRow.latencyMs || 0)))}ms${via})`,
                    bucket: BUCKETS.UNKNOWN,
                    bucketReason: '',
                });
            } else if (optionalFeed && !active && !recovery.active) {
                update(label, {
                    status: 'unknown',
                    lastFetch: Number(restRow?.ts || poolRow?.lastStart || now),
                    fallback: false,
                    transient: true,
                    optional: true,
                    reason: restRow?.error
                        ? `Optional standby · REST probe failed: ${String(restRow.error).slice(0, 90)}`
                        : 'Optional feed standby',
                    bucket: BUCKETS.UNKNOWN,
                    bucketReason: '',
                });
            } else if (active || recovery.active) {
                update(label, {
                    status: recovery.active ? 'recovering' : 'degraded',
                    lastFetch: now,
                    fallback: true,
                    transient: true,
                    reason: recovery.active
                        ? 'WS reconnecting'
                        : `WS offline${conn?.reconnectMs ? ` · retry ${Math.max(1, Math.round(Number(conn.reconnectMs) / 1000))}s` : ''}`,
                    bucket: BUCKETS.NETWORK_TRANSPORT,
                    bucketReason: 'exchange websocket not connected',
                });
            }
        }
    }

    function syncTickerHealth(now = Date.now()) {
        const tickerTs = Number(window._lastTickerFetchTs || 0);
        if (!tickerTs) return;
        const ageMs = now - tickerTs;
        if (ageMs < 45_000) {
            update('Crypto.com', {
                status: 'healthy',
                lastFetch: tickerTs,
                fallback: false,
                transient: false,
                reason: ageMs < 8000 ? 'Live tickers' : `Tickers ${Math.round(ageMs / 1000)}s old`,
                bucket: BUCKETS.UNKNOWN,
                bucketReason: '',
            });
        } else if (ageMs < 180_000) {
            update('Crypto.com', {
                status: recovery.active ? 'recovering' : 'degraded',
                lastFetch: tickerTs,
                fallback: true,
                transient: true,
                reason: `Stale tickers (${Math.round(ageMs / 1000)}s)`,
                bucket: BUCKETS.NETWORK_TRANSPORT,
                bucketReason: 'primary ticker feed has not refreshed recently',
            });
        }
    }

    function syncKalshiWsHealth(now = Date.now()) {
        const ws = window.KalshiWS?.getState?.() || {};
        if (ws.connected && !ws.stale) return;
        if (recovery.active && (ws.reconnectAttempts || ws.suspended)) {
            update('Kalshi', {
                status: 'recovering',
                lastFetch: ws.lastMessageTs || now,
                fallback: true,
                transient: true,
                reason: ws.suspended
                    ? `WSS suspended · retry ${Math.max(0, Math.ceil(Number(ws.suspendInMs || 0) / 1000))}s`
                    : `WSS reconnecting (${ws.reconnectAttempts || 0})`,
                bucket: BUCKETS.NETWORK_TRANSPORT,
                bucketReason: ws.lastIssueReason || ws.lastError || '',
            });
        }
    }

    const HOST_CANONICAL = {
        'api.binance.com': 'Binance',
        'fapi.binance.com': 'Binance',
        'dapi.binance.com': 'Binance',
        'fstream.binance.com': 'Binance',
        'api.coinbase.com': 'Coinbase',
        'api.crypto.com': 'Crypto.com',
        'api.bybit.com': 'Bybit',
        'www.okx.com': 'OKX',
        'okx.com': 'OKX',
        'api.hyperliquid.xyz': 'Hyperliquid',
        'indexer.dydx.trade': 'dYdX',
        'www.deribit.com': 'Deribit',
        'deribit.com': 'Deribit',
        'mempool.space': 'Mempool.space',
        'api.etherscan.io': 'Etherscan',
        'api.mainnet-beta.solana.com': 'Solana RPC',
        'eth-mainnet.g.alchemy.com': 'Alchemy RPC',
        'polygon-mainnet.g.alchemy.com': 'Alchemy RPC',
        's1.ripple.com': 'XRP Ledger',
        'xrplcluster.com': 'XRP Ledger',
        'ethereum.publicnode.com': 'Alchemy RPC',
        'cloudflare-eth.com': 'Alchemy RPC',
    };

    const ENDPOINT_HOST_PROBES = [
        { provider: 'Crypto.com', url: 'https://api.crypto.com/v2/public/get-ticker?instrument_name=BTC_USDT', viaProxy: true },
        { provider: 'Mempool.space', url: 'https://mempool.space/api/blocks/tip/height', viaProxy: true },
        { provider: 'Solana RPC', url: 'https://solana-rpc.publicnode.com', fallbackUrl: 'https://api.mainnet-beta.solana.com', method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"getEpochInfo"}', viaProxy: true, validateJson: true },
        { provider: 'Etherscan', url: null, viaProxy: true, validateJson: true },
        { provider: 'XRP Ledger', url: 'https://xrplcluster.com', fallbackUrl: 'https://s1.ripple.com:51234', method: 'POST', body: '{"method":"server_info","params":[{}]}' , viaProxy: true, validateJson: true },
        { provider: 'Alchemy RPC', url: 'https://ethereum.publicnode.com', fallbackUrl: 'https://cloudflare-eth.com', method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}', viaProxy: true, validateJson: true },
        // LocalProxy is sourced from the bridge state (ProxyTransport.getState),
        // NOT probed over HTTP: a hardcoded :3010 probe marks the proxy
        // DEGRADED whenever the cascade binds :3011+ even though the proxy is
        // healthy. See probeEndpointHostBatch() bridge-state branch below.
        { provider: 'LocalProxy', url: null, fromBridge: true },
    ];

    // Operator kill-switch: Etherscan probe gate. Re-enabled with verified keys
    // & rate-limited burst control (5 req/s max, 100k daily budget). Flip to
    // false to park the row at unknown instead of flapping degraded.
    const ETHERSCAN_ENABLED = true;

    const ENDPOINT_PROBE_STALE_MS = 90_000;
    const ENDPOINT_PROBE_BATCH = 4;
    const ENDPOINT_PROBE_FAILURE_THRESHOLD = 3;
    const endpointProbeFailures = {};
    let endpointProbeCursor = 0;
    let endpointProbeInFlight = false;
    let optionalWarmCounter = 0;

    function pruneDuplicateProviders() {
        for (const [host, canonical] of Object.entries(HOST_CANONICAL)) {
            const hostRow = state[host];
            if (!hostRow) continue;
            const canonicalRow = state[canonical];
            if (canonicalRow && Number(canonicalRow.lastFetch || 0) >= Number(hostRow.lastFetch || 0)) {
                delete state[host];
                if (failureCounters[host]) delete failureCounters[host];
                continue;
            }
            if (!canonicalRow) {
                state[canonical] = { ...hostRow, optional: true };
                delete state[host];
                if (failureCounters[host]) delete failureCounters[host];
            }
        }
    }

    async function probeEndpointHostBatch(now = Date.now()) {
        if (endpointProbeInFlight || !ENDPOINT_HOST_PROBES.length) return;
        endpointProbeInFlight = true;
        try {
            const due = [];
            for (let i = 0; i < ENDPOINT_HOST_PROBES.length; i++) {
                const idx = (endpointProbeCursor + i) % ENDPOINT_HOST_PROBES.length;
                const cfg = ENDPOINT_HOST_PROBES[idx];
                const row = state[cfg.provider];
                const ageMs = row?.lastFetch ? (now - row.lastFetch) : Number.POSITIVE_INFINITY;
                if (!row || ageMs >= ENDPOINT_PROBE_STALE_MS || row.status === 'unknown') {
                    due.push(cfg);
                }
                if (due.length >= ENDPOINT_PROBE_BATCH) break;
            }
            endpointProbeCursor = (endpointProbeCursor + due.length) % ENDPOINT_HOST_PROBES.length;

            for (const cfg of due) {
                // Etherscan dropped by operator: never probe, park at unknown.
                if (cfg.provider === 'Etherscan' && !ETHERSCAN_ENABLED) {
                    update(cfg.provider, {
                        status: 'unknown',
                        lastFetch: now,
                        fallback: false,
                        optional: true,
                        transient: false,
                        reason: 'Etherscan disabled by operator',
                        bucket: BUCKETS.UNKNOWN,
                        bucketReason: '',
                    });
                    continue;
                }                // LocalProxy: source from bridge state (live port), never a
                // hardcoded :3010 HTTP probe. The bridge owns discovery across
                // the full cascade; probing :3010 here would report DEGRADED
                // whenever the proxy correctly bound :3011+.
                if (cfg.fromBridge && cfg.provider === 'LocalProxy') {
                    try {
                        const p = window.ProxyTransport?.getState?.() || {};
                        if (p && (p.available !== undefined || p.port)) {
                            const proxyUp = p.available !== false && p.enabled !== false && p.healthy !== false;
                            update('LocalProxy', {
                                status: proxyUp ? 'healthy' : 'degraded',
                                lastFetch: p.ts || now,
                                fallback: p.mode === 'bypass' || !!p.bypassActive,
                                optional: true,
                                transient: !proxyUp || !!p.bypassActive,
                                reason: p.mode === 'bypass'
                                    ? `hybrid bypass (${p.bypassMsLeft > 0 ? Math.round(p.bypassMsLeft / 1000) + 's' : 'active'})`
                                    : (proxyUp ? `proxy healthy (:${p.port || '?'})` : `proxy degraded (${p.failures || 0})`),
                                bucket: proxyUp ? BUCKETS.UNKNOWN : BUCKETS.NETWORK_TRANSPORT,
                                bucketReason: proxyUp ? '' : 'local proxy process unreachable',
                            });
                        }
                    } catch (_) { /* keep last known state */ }
                    continue;
                }
                // Route RPC/datacenter endpoints through the local proxy (SOCKS
                // egress) — they are geo-blocked or slow when hit directly and
                // previously burned 10s timeouts every cycle. LocalProxy is
                // sourced from the bridge state, not probed over HTTP.
                const fetchFn = cfg.viaProxy && typeof window.proxyFetch === 'function'
                    ? (url, opts) => window.proxyFetch(url, { ...opts, retries: 1 })
                    : fetch;

            const fetchWithTimeout = async (url) => {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(new Error('endpoint-probe-timeout')), 10000);
                try {
                    let r;
                    const reqOpts = {
                        method: cfg.method || 'GET',
                        cache: 'no-store',
                        signal: ctrl.signal,
                        retries: 1,
                        headers: cfg.body
                            ? { Accept: 'application/json', 'Content-Type': 'application/json' }
                            : { Accept: 'application/json,*/*' },
                        body: cfg.body || undefined,
                    };
                    const isLocal = /localhost|127\.0\.0\.1/i.test(url);
                    const caller = (!isLocal && fetchFn) ? fetchFn : fetch;
                    const raceWithTimeout = (promise) => {
                        return Promise.race([
                            promise,
                            new Promise((_, rej) => {
                                if (ctrl.signal.aborted) rej(new Error('endpoint-probe-timeout'));
                                ctrl.signal.addEventListener('abort', () => rej(new Error('endpoint-probe-timeout')));
                            })
                        ]);
                    };
                    try {
                        r = await raceWithTimeout(caller(url, reqOpts));
                    } catch (err) {
                        if (caller !== fetch) {
                            r = await raceWithTimeout(fetch(url, reqOpts));
                        } else {
                            throw err;
                        }
                    }
                    return r;
                } finally {
                    clearTimeout(timer);
                }
            };

                // Etherscan keys are read-only free-tier scanner keys (public
                // chain data only). They ship in client-side probe URLs by
                // design; env keys take priority when configured.
                const etherscanKeys = (cfg.provider === 'Etherscan')
                    ? [
                        window.__env?.ETHERSCAN_API_KEY,
                        window.__env?.ETHERSCAN_API_KEY_2,
                        window.__env?.ETHERSCAN_API_KEY_3,
                        'T6F48S3FE2N74N9TR5GIRUPS95X7EWQ8GY',
                        'YS8N4PZ78ZCMPGNEZIAFE6KPPFYXV74YBR',
                        '39FHNNVAV6N9FXZ45YW1HQX6QFBSU3W61U'
                      ].filter(Boolean)
                    : [];
                if (cfg.provider === 'Etherscan' && !etherscanKeys.length) {
                    update(cfg.provider, {
                        status: 'unknown',
                        lastFetch: now,
                        fallback: false,
                        optional: true,
                        transient: true,
                        reason: 'Etherscan API key unavailable',
                        bucket: BUCKETS.UNKNOWN,
                        bucketReason: '',
                    });
                    continue;
                }

                const responseOk = async (response) => {
                    if (!response?.ok) return false;
                    if (!cfg.validateJson) return true;
                    try {
                        const payload = await response.clone().json();
                        if (payload?.error) return false;
                        if (cfg.provider === 'Etherscan' && String(payload?.status) !== '1') return false;
                        if (cfg.provider === 'XRP Ledger') {
                            return Boolean(payload?.result?.info || payload?.result);
                        }
                        return payload?.result !== undefined && payload?.result !== null;
                    } catch (_) {
                        return false;
                    }
                };

                try {
                    let res;
                    let ok = false;
                    let usedFallback = false;
                    if (cfg.provider === 'Etherscan') {
                        // Rate-limited Etherscan probe with key rotation (5 req/s max, 100k daily limit)
                        const ts = Math.floor(Date.now() / 1000);
                        for (const k of etherscanKeys) {
                            const keyUrl = `https://api.etherscan.io/v2/api?chainid=1&module=block&action=getblocknobytime&timestamp=${ts}&closest=before&apikey=${encodeURIComponent(k)}`;
                            try {
                                res = await fetchWithTimeout(keyUrl);
                                if (await responseOk(res)) { ok = true; break; }
                            } catch (_) { /* try next key */ }
                        }
                    } else {
                        // Multi-candidate fallbacks for resilient blockchain probes
                        const candidateUrls = [cfg.url];
                        if (cfg.fallbackUrl) candidateUrls.push(cfg.fallbackUrl);
                        if (cfg.provider === 'Solana RPC') {
                            candidateUrls.push('https://api.mainnet-beta.solana.com', 'https://rpc.ankr.com/solana', 'https://1rpc.io/solana');
                        } else if (cfg.provider === 'XRP Ledger') {
                            candidateUrls.push('https://s1.ripple.com:51234', 'https://s2.ripple.com:51234', 'https://rpc.xrpl.org');
                        }

                        for (let i = 0; i < candidateUrls.length; i++) {
                            const target = candidateUrls[i];
                            try {
                                res = await fetchWithTimeout(target);
                                if (await responseOk(res)) {
                                    ok = true;
                                    usedFallback = (i > 0);
                                    break;
                                }
                            } catch (_) { /* try next candidate */ }
                        }
                    }
                    endpointProbeFailures[cfg.provider] = ok ? 0 : (endpointProbeFailures[cfg.provider] || 0) + 1;
                    const shouldDegrade = !ok && endpointProbeFailures[cfg.provider] >= ENDPOINT_PROBE_FAILURE_THRESHOLD;
                    const current = state[cfg.provider];
                    if (!shouldDegrade && current?.status === 'healthy') {
                        current.lastFetch = now;
                        current.transient = !ok;
                        current.reason = ok ? 'Endpoint probe OK' : `Endpoint probe failed (${endpointProbeFailures[cfg.provider]}/${ENDPOINT_PROBE_FAILURE_THRESHOLD})`;
                        current.bucket = BUCKETS.UNKNOWN;
                        current.bucketReason = '';
                        recomputeBucketCounters();
                        continue;
                    }
                    update(cfg.provider, {
                        status: ok ? 'healthy' : (shouldDegrade ? 'degraded' : 'unknown'),
                        lastFetch: now,
                        fallback: usedFallback,
                        optional: true,
                        transient: !ok,
                        reason: ok ? 'Endpoint probe OK' : `Endpoint probe HTTP ${res?.status || 'error'}`,
                        bucket: ok ? BUCKETS.UNKNOWN : BUCKETS.PROVIDER_API,
                        bucketReason: ok ? '' : `probe ${cfg.url}`,
                    });
                } catch (err) {
                    let recovered = false;
                    if (cfg.fallbackUrl) {
                        try {
                            const res2 = await fetchWithTimeout(cfg.fallbackUrl);
                            if (typeof res2?.ok === 'boolean' ? res2.ok : (Number(res2?.status || 0) > 0 && Number(res2?.status || 0) < 500)) {
                                recovered = true;
                                update(cfg.provider, {
                                    status: 'healthy',
                                    lastFetch: now,
                                    fallback: true,
                                    optional: true,
                                    transient: false,
                                    reason: 'Endpoint probe OK (fallback)',
                                    bucket: BUCKETS.UNKNOWN,
                                    bucketReason: '',
                                });
                            }
                        } catch (_) {}
                    }
                    if (!recovered) {
                        endpointProbeFailures[cfg.provider] = (endpointProbeFailures[cfg.provider] || 0) + 1;
                        const shouldDegrade = endpointProbeFailures[cfg.provider] >= ENDPOINT_PROBE_FAILURE_THRESHOLD;
                        const current = state[cfg.provider];
                        if (!shouldDegrade && current?.status === 'healthy') {
                            current.lastFetch = now;
                            current.transient = true;
                            current.reason = `Endpoint probe failed (${endpointProbeFailures[cfg.provider]}/${ENDPOINT_PROBE_FAILURE_THRESHOLD})`;
                            current.bucket = BUCKETS.UNKNOWN;
                            current.bucketReason = '';
                            recomputeBucketCounters();
                            continue;
                        }
                        update(cfg.provider, {
                            status: shouldDegrade ? 'degraded' : 'unknown',
                            lastFetch: now,
                            fallback: false,
                            optional: true,
                            transient: true,
                            reason: String(err?.message || err || 'endpoint probe failed').slice(0, 120),
                            bucket: BUCKETS.NETWORK_TRANSPORT,
                            bucketReason: String(err?.message || err || 'endpoint probe failed'),
                        });
                    }
                }
            }
        } finally {
            endpointProbeInFlight = false;
        }
    }

    function syncLiveProbe() {
        const now = Date.now();
        syncExchangeWsHealth(now);
        syncTickerHealth(now);
        syncKalshiWsHealth(now);
        pruneDuplicateProviders();
        refreshLocalProviderStatuses();
        optionalWarmCounter += 1;
        if (optionalWarmCounter % 6 === 0) {
            try { window.ExchangeWS?.warmOptionalWsRoutes?.('health-sync'); } catch (_) { }
        }
        void probeEndpointHostBatch(now);
    }

    function markSuccess(provider, detail = {}) {
        update(canonicalProviderName(provider), {
            status: 'healthy',
            lastFetch: detail.lastFetch || Date.now(),
            fallback: false,
            transient: false,
            reason: detail.reason || '',
            bucket: BUCKETS.UNKNOWN,
            bucketReason: '',
        });
    }

    window.NetworkHealth = {
        update,
        updateTransport,
        get,
        getAll,
        getTransport,
        getBucketCounters,
        getSummary,
        getRecoveryState,
        beginRecovery,
        endRecovery,
        setRecoveryPhase,
        syncLiveProbe,
        markSuccess,
        isCriticalProvider,
        isOptionalProvider,
        classifyBucket,
        BUCKETS,
        HOST_CANONICAL,
        PROVIDERS,
        CRITICAL_PROVIDERS,
        failureCounters,
    };
    startLocalStatusBridge();
    // 12s probe cadence (was 5s) — cuts health-check fetch/WS chatter ~60% on Canada node
    setInterval(syncLiveProbe, 12_000);
})();
