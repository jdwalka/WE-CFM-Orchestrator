// window.NetworkHealth.js
// Global network health state for all market data providers
(function () {
    if (window.NetworkHealth) return; // Singleton

    const PROVIDERS = [
        'Kalshi',
        'Polymarket',
        'ProxyOrchestrator',
        'Pyth',
        // Add more as needed
    ];

    const DEFAULT_STATUS = {
        status: 'unknown', // healthy | degraded | down | unknown
        lastFetch: null,
        fallback: false,
        reason: '',
        bucket: 'unknown',
        bucketReason: '',
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
        'Chain.so',
        'Bullish',
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
        'chain.so',
        'chainso',
        'bullish',
    ]);
    const TRANSIENT_REASON_RE = /(abort|timed?\s*out|timeout|502|503|504|429|network\s*changed|econnreset|socket hang up|failed to fetch)/i;
    const APP_LOGIC_RE = /(stale[-\s]*watchdog|stale[-\s]*demote|demote|hysteresis|scheduler|circuit|loop|oscillat|internal|state bug|coordination|reconnect storm|thrash|browser websocket cannot send|requires node ws|credential|crypto unavailable|signature generation)/i;
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


    function classify(provider, statusObj) {
        const reason = String(statusObj?.reason || '');
        const inputStatus = statusObj?.status || 'unknown';
        const providerKey = String(provider || '').toLowerCase().replace(/\s+/g, '');
        const isOptional = isOptionalProvider(provider) || OPTIONAL_PROVIDER_KEYS.has(providerKey);
        const isTransient = !!statusObj?.transient || TRANSIENT_REASON_RE.test(reason);

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

        // Persistent failure tracking
        if (status === 'down' && !isOptional && !isTransient) {
            failureCounters[provider].count++;
            failureCounters[provider].lastDown = Date.now();
        } else {
            failureCounters[provider].count = 0;
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
        if (row.optional && row.lastFetch && (Date.now() - row.lastFetch) > OPTIONAL_FAILURE_TTL_MS) {
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

        if (wsConnected && !wsStale) {
            update('Kalshi', {
                status: 'healthy',
                lastFetch: ws.lastMessageTs || transport.lastSync || now,
                fallback: kalshiPref && kalshiPref !== 'wss' && kalshiPref !== 'rpc',
                reason: kalshiPref ? `via ${kalshiPref}${authHint}${handshakeHint}` : `wss live${authHint}${handshakeHint}`,
                bucket: BUCKETS.UNKNOWN,
                bucketReason: '',
            });
        } else if (ws.suspended) {
            const retrySecs = Math.max(0, Math.ceil(Number(ws.suspendInMs || 0) / 1000));
            update('Kalshi', {
                status: 'degraded',
                lastFetch: ws.lastMessageTs || transport.lastSync || now,
                fallback: true,
                transient: true,
                reason: `WSS suspended (persistent network block) · retry ${retrySecs}s${routeHint}${failureHint}${bucketHint}${demoteHint}${authHint}${handshakeHint}`,
                bucket: ws.lastIssueBucket || BUCKETS.NETWORK_TRANSPORT,
                bucketReason: ws.lastIssueReason || 'persistent websocket connect failure',
            });
        } else if (reconnecting || wsStale) {
            update('Kalshi', {
                status: 'degraded',
                lastFetch: ws.lastMessageTs || transport.lastSync || now,
                fallback: true,
                transient: true,
                reason: wsStale
                    ? `WSS stale${routeHint}${failureHint}${demoteHint}${authHint}${handshakeHint}`
                    : `WSS reconnecting (${ws.reconnectAttempts || 0})${routeHint}${failureHint}${connectAttemptHint}${authHint}${handshakeHint}`,
                bucket: ws.lastIssueBucket || BUCKETS.NETWORK_TRANSPORT,
                bucketReason: ws.lastIssueReason || ws.lastError || ws.lastCloseReason || '',
            });
        } else if (kalshiPref) {
            update('Kalshi', {
                status: 'degraded',
                lastFetch: transport.lastSync || now,
                fallback: true,
                transient: true,
                reason: `WSS off; via ${kalshiPref}${routeHint}${failureHint}${demoteHint}${connectAttemptHint}${authHint}${handshakeHint}`,
                bucket: ws.lastIssueBucket || BUCKETS.NETWORK_TRANSPORT,
                bucketReason: ws.lastIssueReason || ws.lastError || ws.lastCloseReason || '',
            });
        } else {
            update('Kalshi', {
                status: 'down',
                lastFetch: transport.lastSync || null,
                fallback: false,
                transient: true,
                reason: `WSS disconnected${routeHint}${failureHint}${demoteHint}${connectAttemptHint}${authHint}${handshakeHint}`,
                bucket: ws.lastIssueBucket || BUCKETS.NETWORK_TRANSPORT,
                bucketReason: ws.lastIssueReason || ws.lastError || ws.lastCloseReason || '',
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

    window.NetworkHealth = {
        update,
        updateTransport,
        get,
        getAll,
        getTransport,
        getBucketCounters,
        classifyBucket,
        BUCKETS,
        PROVIDERS,
        failureCounters,
    };
})();
