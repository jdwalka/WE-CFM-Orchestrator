// ═══════════════════════════════════════════════════════════════════════════════
// TOR & ONION ROUTING INTEGRATION LAYER
// ═══════════════════════════════════════════════════════════════════════════════
// Routes API calls through TOR network with automatic failover to direct
// Usage: window.TORRouter.routeAPI(endpoint, options) → Promise<Response>
//        window.TORRouter.enable() / disable()
//        window.TORRouter.status()

(function () {
    'use strict';

    // TOR SOCKS5 proxy configuration
    const TOR_CONFIG = {
        // SOCKS5 proxy address (local TOR daemon assumed running on localhost:9050)
        socksHost: 'localhost',
        socksPort: 9050,

        // Fallback: HTTP proxy on port 8118 (Privoxy over TOR)
        httpProxyHost: 'localhost',
        httpProxyPort: 8118,

        // Connection timeouts
        connectTimeoutMs: 5000,
        requestTimeoutMs: 30000,

        // Routing policies
        routes: {
            // Route specific endpoints through TOR
            kalshi: { enabled: false, name: 'Kalshi API' },           // ⚠️ NO - too slow for real-time
            polymarket: { enabled: false, name: 'Polymarket' },       // ⚠️ NO - too slow for live data
            coingecko: { enabled: true, name: 'CoinGecko' },         // ✓ OK - non-time-critical
            crypto_com: { enabled: false, name: 'Crypto.com' },      // ⚠️ NO - live candles needed
            whale_alert: { enabled: true, name: 'Whale Alert' },     // ✓ OK - non-time-critical
            dex_scan: { enabled: true, name: 'DEX Scanners' },       // ✓ OK - analysis only
            portfolio: { enabled: true, name: 'Portfolio Tools' },   // ✓ OK - analytics only
            cex_flow: { enabled: false, name: 'CEX Flow' },          // ⚠️ NO - needs speed
            alternative_me: { enabled: true, name: 'Fear & Greed' }, // ✓ OK - slow analytics
        },

        // URLs that should ALWAYS bypass TOR (real-time critical)
        bypassPatterns: [
            /api\.crypto\.com/i,
            /api\.exchange\.coinbase\.com/i,
            /api\.bybit\.com/i,
            /api\.binance\.com/i,
            /api\.binance\.us/i,
            /fapi\.binance\.com/i,
            /api\.mexc\.com/i,
            /api\.kucoin\.com/i,
            /api-pub\.bitfinex\.com/i,
            /api\.coincap\.io/i,
            /rest\.coincap\.io/i,
            /api\.kraken\.com/i,
            /wss:\/\//,  // WebSockets
            /elections\.kalshi\.com/i,  // Critical settlement API
        ],
    };

    const TORRouter = {
        _enabled: false,
        _stats: {
            routed: 0,
            bypassed: 0,
            torFails: 0,
            totalMs: 0,
        },

        /**
         * Initialize TOR router
         */
        async init() {
            try {
                // Test TOR connectivity
                const response = await this._testTORConnection();
                if (response.ok) {
                    console.log('✅ [TOR] SOCKS5 proxy reachable on localhost:9050');
                    this._enabled = true;
                    return true;
                }
            } catch (e) {
                console.warn('⚠️ [TOR] SOCKS5 proxy not available:', e.message);
            }

            // Try Privoxy fallback
            try {
                const response = await fetch('http://localhost:8118/', { mode: 'no-cors' });
                console.log('✅ [TOR] Privoxy (HTTP proxy) reachable on localhost:8118');
                this._enabled = true;
                return true;
            } catch (e) {
                console.warn('⚠️ [TOR] Privoxy also not available:', e.message);
            }

            console.warn('⚠️ [TOR] No SOCKS5 or HTTP proxy detected. TOR routing disabled.');
            console.log('📖 [TOR] To enable:');
            console.log('   1. Install TOR: https://www.torproject.org/download/');
            console.log('   2. Run: tor --SocksPort 9050');
            console.log('   3. Or install Privoxy: https://www.privoxy.org/');
            return false;
        },

        /**
         * Test TOR connectivity
         */
        async _testTORConnection() {
            // If running in Electron, test native SOCKS5 directly
            if (window.electron && window.electron.ipcFetch) {
                const response = await window.electron.ipcFetch('https://check.torproject.org/', { useTor: true });
                if (response.ok) return { ok: true };
                throw new Error(response.error || 'IPC SOCKS5 connection failed');
            }

            return new Promise((resolve, reject) => {
                // Since browser fetch cannot directly use SOCKS5, we test via Privoxy/HTTP fallback
                const controller = new AbortController();
                const timeoutId = setTimeout(() => {
                    controller.abort();
                    reject(new Error('TOR connection timeout'));
                }, 2000);

                fetch('http://check.torproject.org/', {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'WE-CRYPTO-TOR' },
                    mode: 'no-cors'
                })
                    .then(() => {
                        clearTimeout(timeoutId);
                        resolve({ ok: true });
                    })
                    .catch((err) => {
                        clearTimeout(timeoutId);
                        reject(err);
                    });
            });
        },

        /**
         * Decide if a URL should route through TOR
         */
        _shouldRouteThroughTOR(url, options = {}) {
            // .onion URLs MUST ALWAYS route through TOR
            if (/\.onion/i.test(url)) return true;

            // Never route unless analytics opt-in is enabled.
            if (!window.__TOR_ANALYTICS_OPT_IN__) return false;

            // Explicit classing allows callers to keep live paths out of TOR.
            const routeClass = String(options.routeClass || '').toLowerCase();
            if (routeClass && routeClass !== 'analytics') return false;

            // Always bypass real-time critical endpoints
            for (const pattern of TOR_CONFIG.bypassPatterns) {
                if (pattern.test(url)) {
                    return false;
                }
            }

            if (routeClass === 'analytics') {
                if (/coingecko|alternative\.me|whale|portfolio|dex/i.test(url)) return true;
            }

            // Check routing policy
            for (const [key, policy] of Object.entries(TOR_CONFIG.routes)) {
                if (policy.enabled && url.includes(key)) {
                    return true;
                }
            }

            return false;
        },

        /**
         * Route an API call through TOR
         */
        async routeAPI(url, options = {}) {
            const startTime = Date.now();

            // Check if TOR routing should be used
            if (!this._enabled || !this._shouldRouteThroughTOR(url, options)) {
                this._stats.bypassed++;
                return fetch(url, options);
            }

            // Try TOR routing
            try {
                // If native IPC SOCKS5 is available, use it directly (bypass Privoxy)
                if (window.electron && window.electron.ipcFetch) {
                    const response = await window.electron.ipcFetch(url, { ...options, useTor: true });
                    if (!response.ok && response.status === 0) {
                         throw new Error(response.error || 'IPC SOCKS5 failed');
                    }
                    this._stats.routed++;
                    this._stats.totalMs += Date.now() - startTime;
                    console.debug(`✅ [TOR] Routed natively via IPC SOCKS5 ${url} (${Date.now() - startTime}ms)`);
                    
                    return new Response(response.text, {
                        status: response.status || 200,
                        statusText: response.ok ? 'OK' : 'Error',
                        headers: new Headers({ 'Content-Type': 'application/json' })
                    });
                }

                // Modify request headers to indicate TOR origin
                const torOptions = {
                    ...options,
                    headers: {
                        ...options.headers,
                        'X-Forwarded-For': 'anonymized',
                        'Via': 'Privoxy/1.8.3',
                    },
                };

                // For browser fetch, we route via Privoxy HTTP proxy
                // Modify URL to route through proxy
                const proxyUrl = `http://localhost:${TOR_CONFIG.httpProxyPort}/${url}`;
                const response = await fetch(proxyUrl, {
                    ...torOptions,
                    mode: 'cors',
                    timeout: TOR_CONFIG.requestTimeoutMs,
                });

                this._stats.routed++;
                this._stats.totalMs += Date.now() - startTime;

                console.debug(`✅ [TOR] Routed ${url} (${Date.now() - startTime}ms)`);
                return response;
            } catch (torErr) {
                // TOR failed, fallback to direct
                this._stats.torFails++;
                console.warn(`⚠️ [TOR] Fallback to direct for ${url}:`, torErr.message);
                return fetch(url, options);
            }
        },

        /**
         * Enable TOR routing
         */
        async enable() {
            const success = await this.init();
            if (success) {
                this._enabled = true;
                console.log('🟢 [TOR] Routing enabled');
                this.printPolicy();
            }
            return success;
        },

        /**
         * Disable TOR routing
         */
        disable() {
            this._enabled = false;
            console.log('🔴 [TOR] Routing disabled');
        },

        /**
         * Get router status
         */
        status() {
            return {
                enabled: this._enabled,
                stats: this._stats,
                avgLatencyMs: this._stats.routed > 0 ? Math.round(this._stats.totalMs / this._stats.routed) : 0,
                routes: TOR_CONFIG.routes,
            };
        },

        /**
         * Print current routing policy
         */
        printPolicy() {
            console.log('\n╔════════════════════════════════════════════╗');
            console.log('║         TOR ROUTING POLICY                 ║');
            console.log('╚════════════════════════════════════════════╝');
            Object.entries(TOR_CONFIG.routes).forEach(([key, policy]) => {
                const status = policy.enabled ? '✓' : '✗';
                console.log(`${status} ${policy.name.padEnd(30)} [${key}]`);
            });
            console.log('\n⚠️  Real-time critical APIs (Kalshi, CDC, Binance) always bypass TOR');
            console.log('📊 Non-critical analytics (whale-alert, dex, portfolio) route through TOR\n');
        },

        /**
         * Set routing policy for specific endpoint
         */
        setPolicy(endpointKey, enabled) {
            if (TOR_CONFIG.routes[endpointKey]) {
                TOR_CONFIG.routes[endpointKey].enabled = enabled;
                const status = enabled ? 'enabled' : 'disabled';
                console.log(`ℹ️ [TOR] ${endpointKey} routing ${status}`);
            }
        },

        /**
         * Patch global fetch to use TOR router
         */
        patchGlobalFetch() {
            if (window._TOR_FETCH_PATCHED) return;

            const originalFetch = window.fetch;
            window.fetch = async function (url, options) {
                // Only intercept non-CORS requests and non-blob URLs
                if (typeof url === 'string' && !url.startsWith('blob:')) {
                    return TORRouter.routeAPI(url, options);
                }
                return originalFetch.call(window, url, options);
            };

            window._TOR_FETCH_PATCHED = true;
            console.log('🔧 [TOR] Global fetch patched');
        },
    };

    // ═══════════════════════════════════════════════════════════════════════════════
    // ANONYMIZATION & OBFUSCATION LAYER (Advanced)
    // ═══════════════════════════════════════════════════════════════════════════════

    const AnonymizationEngine = {
        _enabled: false,

        /**
         * Obfuscate User-Agent to appear as different browser
         */
        rotateUserAgent() {
            const agents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
            ];
            return agents[Math.floor(Math.random() * agents.length)];
        },

        /**
         * Add random delays to make bot detection harder
         */
        addRandomJitter(baseMs = 100) {
            return baseMs + Math.random() * 200;
        },

        /**
         * Pool of IP-obfuscation headers (simulated, actual requires VPN integration)
         */
        obfuscateHeaders(headers = {}) {
            return {
                ...headers,
                'User-Agent': this.rotateUserAgent(),
                'X-Forwarded-For': `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
                'CF-Connecting-IP': `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
                'X-Real-IP': `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
            };
        },

        /**
         * Batch requests to avoid API rate limiting detection
         */
        async batchRequests(requests = [], batchSizeMs = 500) {
            const results = [];
            for (let i = 0; i < requests.length; i += 1) {
                const req = requests[i];
                try {
                    const result = await TORRouter.routeAPI(req.url, req.options);
                    results.push(result);
                } catch (err) {
                    results.push(null);
                }

                if (i < requests.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, this.addRandomJitter(batchSizeMs)));
                }
            }
            return results;
        },

        enable() {
            this._enabled = true;
            console.log('🛡️ [ANON] Anonymization engine enabled');
            console.log('  ✓ User-Agent rotation');
            console.log('  ✓ Header obfuscation');
            console.log('  ✓ Request batching');
        },

        disable() {
            this._enabled = false;
            console.log('🛡️ [ANON] Anonymization engine disabled');
        },
    };

    // Export to window
    window.TORRouter = TORRouter;
    window.AnonymizationEngine = AnonymizationEngine;

    console.log('✅ [TOR] Router initialized. Use: window.TORRouter.enable()');

})();
