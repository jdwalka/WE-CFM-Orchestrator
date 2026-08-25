// window.NetworkHealth.js
// Global network health state for all market data providers
(function () {
    if (window.NetworkHealth) return; // Singleton

    const PROVIDERS = [
        'Polymarket',
        'ProxyOrchestrator',
        'Pyth',
        'Crypto.com',
        // Add more as needed
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
        'Crypto.com',
        'ProxyOrchestrator',
    ]);

    const WS_PROVIDER_NAMES = {
        BINANCE: 'Binance',
        COINBASE: 'Coinbase',
        KRAKEN: 'Kraken',
        BYBIT: 'Bybit',
        HYPERLIQUID: 'Hyperliquid',
        OKX: 'OKX',
        KUCOIN: 'KuCoin',
        GATE: 'Gate',
        BULLISH: 'Bullish',
        UPBIT: 'Upbit',
        BITGET: 'Bitget',
        BINGX: 'BingX',
        BITVAVO: 'Bitvavo',
        GEMINI: 'Gemini',
        COINW: 'CoinW',
        LBANK: 'LBank',
        BITSTAMP: 'Bitstamp',
        BITSO: 'Bitso',
        WHITEBIT: 'WhiteBIT',
        OURBIT: 'Ourbit',
        WEEX: 'Weex',
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
        'Alternative.me',
        'CoinMarketCap',
        'CoinGecko',
        'Blockscout',
        'LocalProxy',
        'Blockcypher',
        'BSCScan',
        'DexScreener',
        'Bullish',
        'CoinW',
        'LBank',
        'Bitstamp',
        'Bitso',
        'WhiteBIT',
        'Ourbit',
        'Weex',
        'Gate',
        'TimeAPI',
        'Solana RPC',
        'Alchemy RPC',
        'Whale Alert',
        'api.whale-alert.io',
    ]);
    const OPTIONAL_PROVIDER_KEYS = new Set([
        'alternative.me',
        'coinmarketcap',
        'coingecko',
        'blockscout',
        'localproxy',
        'blockcypher',
        'bscscan',
        'dexscreener',
        'bullish',
        'coinw',
        'lbank',
        'bitstamp',
        'bitso',
        'whitebit',
        'ourbit',
        'weex',
        'gate',
        'gate.io',
        'api.gateio.ws',
        'whalealert',
        'whale alert',
        'api.whale-alert.io',
        'whale-alert.io',
        'timeapi',
        'timeapi.io',
        'solanarpc',
        'alchemyrpc',
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
        if (proxy.mode || proxy.healthy === false || proxy.bypassActive) {
            update('LocalProxy', {
                status: proxy.mode === 'proxy' && proxy.healthy ? 'healthy' : 'degraded',
                lastFetch: proxy.ts || Date.now(),
                fallback: proxy.mode === 'bypass' || !!proxy.bypassActive,
                transient: !!proxy.bypassActive || proxy.healthy === false,
                reason: proxy.mode === 'bypass'
                    ? `hybrid bypass (${proxy.bypassMsLeft > 0 ? Math.round(proxy.bypassMsLeft / 1000) + 's' : 'active'})`
                    : (proxy.healthy ? 'proxy healthy' : `proxy degraded (${proxy.failures || 0})`),
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
        const age = lastDataTs ? Math.max(0, now - lastDataTs) : null;
        const dataCount = Number(payload?.dataCount || 0);
        const timeoutCount = Number(payload?.timeoutCount || 0);
        const currentFreshHealthy = current.status === 'healthy' &&
            Number(current.lastFetch || 0) > 0 &&
            (now - Number(current.lastFetch)) < 30_000;

        if (currentFreshHealthy && !(ok && connected && age != null && age < 15_000)) return;

        let status = 'degraded';
        let reason = payload?.error || 'Pyth Lazer status unavailable';
        let bucket = BUCKETS.APP_LOGIC;
        let bucketReason = reason;

        if (ok && connected && age != null && age < 15_000) {
            status = 'healthy';
            reason = `${dataCount} ticks · ${Math.round(age / 1000)}s old`;
            bucket = BUCKETS.UNKNOWN;
            bucketReason = '';
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

    function refreshLocalProviderStatuses() {
        if (localStatusBridgeInFlight) return;
        localStatusBridgeInFlight = true;
        const now = Date.now();
        Promise.resolve()
            .then(async () => {
                refreshProxyOrchestratorStatus(now);
                refreshPolymarketStatus(now);
                await refreshPythStatus(now);
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
            'BINANCE', 'COINBASE', 'KRAKEN', 'BYBIT', 'HYPERLIQUID', 'OKX', 'KUCOIN', 'GATE',
            'BULLISH', 'UPBIT', 'BITGET', 'BINGX', 'BITVAVO', 'GEMINI',
            'COINW', 'LBANK', 'BITSTAMP', 'BITSO', 'WHITEBIT', 'OURBIT', 'WEEX',
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
        'api.bitget.com': 'Bitget',
        'open-api.bingx.com': 'BingX',
        'api.kraken.com': 'Kraken',
        'api.gemini.com': 'Gemini',
        'api.hyperliquid.xyz': 'Hyperliquid',
        'www.coinw.com': 'CoinW',
        'ourbit.com': 'Ourbit',
        'www.lbank.com': 'LBank',
        'www.bitstamp.net': 'Bitstamp',
        'api.bitso.com': 'Bitso',
        'whitebit.com': 'WhiteBIT',
        'api.whitebit.com': 'WhiteBIT',
        'www.weex.com': 'Weex',
        'www.bullish.com': 'Bullish',
        'api.upbit.com': 'Upbit',
        'api.bitvavo.com': 'Bitvavo',
        'api.etherscan.io': 'Etherscan',
        'mempool.space': 'Mempool.space',
        'api.blockcypher.com': 'Blockcypher',
        'api.blockchair.com': 'Blockchair',
        'api.mainnet-beta.solana.com': 'Solana RPC',
        'eth-mainnet.g.alchemy.com': 'Alchemy RPC',
        'polygon-mainnet.g.alchemy.com': 'Alchemy RPC',
        'api.whale-alert.io': 'Whale Alert',
    };

    const ENDPOINT_HOST_PROBES = [
        { provider: 'Kraken', url: 'https://api.kraken.com/0/public/Time' },
        { provider: 'Gemini', url: 'https://api.gemini.com/v1/symbols' },
        { provider: 'Hyperliquid', url: 'https://api.hyperliquid.xyz/info', method: 'POST', body: '{"type":"meta"}' },
        { provider: 'Mempool.space', url: 'https://mempool.space/api/blocks/tip/height' },
        { provider: 'Etherscan', url: 'https://api.etherscan.io/api?module=proxy&action=eth_blockNumber' },
        { provider: 'Solana RPC', url: 'https://api.mainnet-beta.solana.com', fallbackUrl: 'https://solana-mainnet.g.alchemy.com/v2/UNcUYppLXPl4s0jAkQe_J', method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"getEpochInfo"}' },
    ];

    const ENDPOINT_PROBE_STALE_MS = 90_000;
    const ENDPOINT_PROBE_BATCH = 4;
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
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(new Error('endpoint-probe-timeout')), 4500);
                const fetchFn = typeof window.proxyFetch === 'function' ? window.proxyFetch : fetch;
                try {
                    let res = await fetchFn(cfg.url, {
                        method: cfg.method || 'GET',
                        cache: 'no-store',
                        signal: ctrl.signal,
                        headers: cfg.body
                            ? { Accept: 'application/json', 'Content-Type': 'application/json' }
                            : { Accept: 'application/json,*/*' },
                        body: cfg.body || undefined,
                    });
                    let ok = typeof res?.ok === 'boolean' ? res.ok : (Number(res?.status || 0) > 0 && Number(res?.status || 0) < 500);
                    if (!ok && cfg.fallbackUrl) {
                        try {
                            const res2 = await fetchFn(cfg.fallbackUrl, {
                                method: cfg.method || 'GET',
                                cache: 'no-store',
                                signal: ctrl.signal,
                                headers: cfg.body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json,*/*' },
                                body: cfg.body || undefined,
                            });
                            if (typeof res2?.ok === 'boolean' ? res2.ok : (Number(res2?.status || 0) > 0 && Number(res2?.status || 0) < 500)) {
                                res = res2;
                                ok = true;
                            }
                        } catch (_) {}
                    }
                    update(cfg.provider, {
                        status: ok ? 'healthy' : 'degraded',
                        lastFetch: now,
                        fallback: fetchFn !== fetch,
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
                            const res2 = await fetchFn(cfg.fallbackUrl, {
                                method: cfg.method || 'GET',
                                cache: 'no-store',
                                signal: ctrl.signal,
                                headers: cfg.body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json,*/*' },
                                body: cfg.body || undefined,
                            });
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
                        update(cfg.provider, {
                            status: 'degraded',
                            lastFetch: now,
                            fallback: fetchFn !== fetch,
                            optional: true,
                            transient: true,
                            reason: String(err?.message || err || 'endpoint probe failed').slice(0, 120),
                            bucket: BUCKETS.NETWORK_TRANSPORT,
                            bucketReason: String(err?.message || err || 'endpoint probe failed'),
                        });
                    }
                } finally {
                    clearTimeout(timer);
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
