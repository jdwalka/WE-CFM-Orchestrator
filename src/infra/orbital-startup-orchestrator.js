/**
 * orbital-startup-orchestrator.js
 * Manages the lifecycle of Redpanda and the Orbital Matrix services.
 *
 * Responsibilities:
 * 1. Detect if Docker is available
 * 2. Spin up docker-compose (Redpanda cluster)
 * 3. Wait for Redpanda to be healthy
 * 4. Pre-create orbital topics (idempotent)
 * 5. Initialize the Redpanda bridge (KafkaJS producer)
 * 6. Start the Orbital Ingestor daemon (s, p, d, f producers)
 * 7. Start the Matrix Processor (coherence loop / consumer)
 * 8. Handle graceful shutdown on app exit
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const REDPANDA_CONTAINER_NAME = 'redpanda-orbital';

// Fix Windows PATH for Docker if missing
if (process.platform === 'win32') {
    const dockerPaths = [
        'C:\\Program Files\\Docker\\Docker\\resources\\bin',
        'C:\\ProgramData\\DockerDesktop\\version-bin'
    ];
    for (const dp of dockerPaths) {
        if (!process.env.PATH.includes(dp) && fs.existsSync(dp)) {
            process.env.PATH = process.env.PATH + ';' + dp;
        }
    }
}

let dockerComposeProcess = null;
let ingestorProcess = null;
let processorIntervalHandle = null;
let orbitalServiceProcess = null;
let orchestratorReady = false;
let shutdownInFlight = null;
let shutdownComplete = false;

// WE-CRYPTO proxies
let httpProxyProcess = null;
let wsProxyProcess = null;

// Status cache — prevents concurrent docker exec pile-up from flipping display to DOWN
const STATUS_CACHE_TTL_MS = 30000; // re-probe every 30s; return cached result between probes
let _statusCache = null;           // { ts, value }
let _statusInFlight = null;        // Promise while a probe is running
const MAX_STATUS_EVENTS = 12;
const recentStatusEvents = [];
const lastProbeState = {
    docker: null,
    redpanda: null,
    bridgeConnected: null,
    nodes: null,
    topicCount: null
};

function recordStatusEvent(level, message, meta = {}) {
    recentStatusEvents.unshift({
        ts: Date.now(),
        level: level || 'info',
        message: String(message || '').trim(),
        source: 'orchestrator',
        meta: meta && typeof meta === 'object' ? meta : {}
    });
    if (recentStatusEvents.length > MAX_STATUS_EVENTS) {
        recentStatusEvents.length = MAX_STATUS_EVENTS;
    }
}

function getBridgeStatsSafe() {
    try {
        const bridge = require('./orbital-redpanda-bridge');
        return typeof bridge.getBridgeStats === 'function'
            ? bridge.getBridgeStats()
            : { connected: false, messageCounts: {}, lastTickAt: {}, totalMessages: 0, activeOrbitals: [], recentEvents: [] };
    } catch (_) {
        return { connected: false, messageCounts: {}, lastTickAt: {}, totalMessages: 0, activeOrbitals: [], recentEvents: [] };
    }
}

function enrichStatus(baseStatus) {
    const bridge = getBridgeStatsSafe();
    const notifications = [...recentStatusEvents, ...(bridge.recentEvents || [])]
        .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
        .slice(0, 8)
        .map((event) => ({ ...event }));
    return {
        ...baseStatus,
        bridge,
        activity: {
            totalMessages: Number(bridge.totalMessages || 0),
            activeOrbitals: Array.isArray(bridge.activeOrbitals) ? bridge.activeOrbitals : [],
            lastProducedAt: bridge.lastProducedAt || null,
        },
        notifications,
        checkedAt: Date.now(),
    };
}

// --- Health Check Utilities ---

/**
 * Check if a TCP port is open (used to probe Redpanda readiness).
 */
function checkPort(port, host = 'localhost', timeout = 1000) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ port, host });
        socket.setTimeout(timeout);
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => { resolve(false); });
    });
}

/**
 * Poll for Redpanda readiness via port 9092 (Kafka broker).
 * Waits up to maxWaitMs (default 60 s).
 */
async function waitForRedpandaReady(maxWaitMs = 60000) {
    const startTime = Date.now();
    const pollInterval = 2000;
    console.log('[OrbitalOrchestrator] Waiting for Redpanda to be ready...');
    while (Date.now() - startTime < maxWaitMs) {
        const isReady = await checkPort(9092, '127.0.0.1', 1000);
        if (isReady) {
            console.log('[OrbitalOrchestrator] ✓ Redpanda is ready!');
            return true;
        }
        console.log('[OrbitalOrchestrator] Polling... (waiting for Redpanda on :9092)');
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    throw new Error('Redpanda failed to start within 60 seconds');
}

/**
 * Check if Docker daemon is running.
 */
async function isDockerAvailable() {
    return new Promise((resolve) => {
        exec('docker ps', (err, stdout, stderr) => {
            if (err) {
                console.error('[OrbitalOrchestrator] isDockerAvailable failed:', err.message, stderr);
                try {
                    fs.writeFileSync(require('path').join(process.cwd(), 'docker-error.log'), 'Docker err: ' + err.message + '\nStderr: ' + stderr);
                } catch (e) { }
            }
            resolve(!err);
        });
    });
}

/**
 * Spawn docker-compose up -d and wait for it to complete.
 */
function spawnDockerCompose(workspacePath) {
    return new Promise((resolve, reject) => {
        console.log('[OrbitalOrchestrator] Spawning docker-compose for Redpanda services...');
        const proc = spawn('docker', ['compose', 'up', '-d', 'redpanda', 'redpanda-console'], {
            cwd: workspacePath,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stderr = '';
        proc.stdout.on('data', (data) => console.log('[Docker-Compose]', data.toString().trim()));
        proc.stderr.on('data', (data) => { stderr += data.toString(); console.warn('[Docker-Compose]', data.toString().trim()); });
        proc.on('close', (code) => {
            if (code !== 0) {
                const detail = stderr.trim().split(/\r?\n/).slice(-4).join(' | ');
                reject(new Error(`docker compose up failed with code ${code}${detail ? `: ${detail}` : ''}`));
                return;
            }
            resolve(proc);
        });
        proc.on('error', (err) => reject(err));
    });
}

/**
 * Pre-create orbital topics via the init script (idempotent — safe every run).
 */
async function initTopics(workspacePath) {
    try {
        const topicScript = path.join(workspacePath, 'scripts', 'redpanda-init-topics.js');
        if (fs.existsSync(topicScript)) {
            const { createAllTopics } = require(topicScript);
            await createAllTopics();
            console.log('[OrbitalOrchestrator] ✓ Orbital + Grok topics created/verified');
        } else {
            console.warn('[OrbitalOrchestrator] Topic init script not found — skipping (topics must already exist)');
        }
    } catch (err) {
        // Topics may already exist — not fatal
        console.warn('[OrbitalOrchestrator] Topic init note:', err.message);
    }
}

/**
 * Initialize the Redpanda bridge (KafkaJS producer connects).
 */
async function initBridge() {
    try {
        const { initRedpanda } = require('./orbital-redpanda-bridge');
        await initRedpanda();
        if (!getBridgeStatsSafe().connected) {
            throw new Error('Kafka producer bridge did not connect to Redpanda');
        }
        console.log('[OrbitalOrchestrator] ✓ Redpanda bridge initialized');
    } catch (err) {
        console.error('[OrbitalOrchestrator] Failed to initialize bridge:', err.message);
        throw err;
    }
}

/**
 * Start the Orbital Ingestor daemon (connects CoinGecko, Coinbase, Hyperliquid, Kalshi WS/poll).
 */
function startIngestor() {
    try {
        const OrbitalIngestor = require('../orbital/orbital-ingestor-daemon');
        OrbitalIngestor.start();
        console.log('[OrbitalOrchestrator] ✓ Orbital Ingestor daemon started');
        return OrbitalIngestor;
    } catch (err) {
        console.error('[OrbitalOrchestrator] Failed to start ingestor:', err.message);
        throw err;
    }
}

/**
 * Start the Matrix Processor (KafkaJS consumer + 15-min Time-Windowed Barrier).
 */
async function startProcessor() {
    try {
        const { startProcessor: runProcessor } = require('../orbital/orbital-matrix-processor');
        processorIntervalHandle = await runProcessor();
        console.log('[OrbitalOrchestrator] ✓ Matrix Processor coherence loop started');
    } catch (err) {
        console.error('[OrbitalOrchestrator] Failed to start processor:', err.message);
        throw err;
    }
}

/**
 * Main orchestration entry point.
 * Called from Electron main process on app-ready.
 * @param {string} workspacePath - Absolute path to the project root (contains docker-compose.yml).
 */
async function startOrbitalSystem(workspacePath) {
    if (orchestratorReady) {
        console.log('[OrbitalOrchestrator] System already running.');
        return true;
    }

    shutdownComplete = false;
    try {
        console.log('[OrbitalOrchestrator] ===== Starting Orbital System =====');

        // Start WE-CRYPTO Proxies early and independently of Docker/Redpanda
        try {
            await startProxies(workspacePath);
            await new Promise(r => setTimeout(r, 2000));
        } catch (proxyErr) {
            console.error('[OrbitalOrchestrator] Non-fatal: Proxies failed to start:', proxyErr.message);
        }

        // Step 1: Check Docker availability
        const dockerAvailable = await isDockerAvailable();
        if (!dockerAvailable) {
            throw new Error('Docker daemon is not running. Please start Docker Desktop and try again.');
        }
        console.log('[OrbitalOrchestrator] ✓ Docker is available');
        recordStatusEvent('success', 'Docker daemon available');

        // Step 2: Spin up docker-compose (Redpanda single-node cluster)
        dockerComposeProcess = await spawnDockerCompose(workspacePath);
        recordStatusEvent('info', 'docker-compose started', { workspacePath });

        // Step 3: Wait for Redpanda broker to be reachable on :9092
        await waitForRedpandaReady();
        recordStatusEvent('success', 'Redpanda broker reachable on localhost:9092');

        // Step 4: Pre-create orbital topics (idempotent)
        await initTopics(workspacePath);
        recordStatusEvent('info', 'Orbital topics initialized');

        // Step 5: Connect KafkaJS producer via the bridge
        await initBridge();
        recordStatusEvent('success', 'Kafka bridge initialized');

        // Step 6: Start Orbital Ingestor (s, p, d, f producers → Redpanda)
        ingestorProcess = startIngestor();
        recordStatusEvent('success', 'Orbital ingestor started');

        // Step 7: Start Matrix Processor (consumer + 15-min barrier → Firebase)
        await startProcessor();
        recordStatusEvent('success', 'Orbital processor started');

        orchestratorReady = true;
        // Bust the status cache so the next UI poll immediately reflects healthy state
        _statusCache = null;
        console.log('[OrbitalOrchestrator] ===== Orbital System Ready =====');
        console.log('[OrbitalOrchestrator] Services online: Redpanda | Topics | Bridge | Ingestor | Processor');

        return true;
    } catch (err) {
        console.error('[OrbitalOrchestrator] FATAL: Failed to start Orbital System:', err.message);
        recordStatusEvent('error', 'Orbital system failed to start', { error: err.message });
        await shutdownOrbitalSystem(false, { stopDocker: false }); // Preserve containers for diagnostics/retry.
        throw err;
    }
}

/**
 * Graceful shutdown: stop all services and bring down docker-compose.
 */
function shutdownOrbitalSystem(stopProxiesFlag = true, options = {}) {
    if (shutdownComplete) return Promise.resolve();
    if (shutdownInFlight) return shutdownInFlight;
    shutdownInFlight = performShutdownOrbitalSystem(stopProxiesFlag, options)
        .finally(() => {
            shutdownComplete = true;
            shutdownInFlight = null;
        });
    return shutdownInFlight;
}

async function performShutdownOrbitalSystem(stopProxiesFlag = true, options = {}) {
    console.log('[OrbitalOrchestrator] Initiating graceful shutdown...');

    try {
        if (stopProxiesFlag) {
            await stopProxies();
            console.log('[OrbitalOrchestrator] Proxies stopped');
        }
        // Fully stop the Matrix Processor. This must disconnect the KafkaJS
        // consumer (via stopProcessor), not merely clear the barrier interval.
        // The consumer is a module-level singleton; if it is left connected and
        // running, the next startProcessor() re-subscribes on a running consumer
        // and KafkaJS throws "Cannot subscribe to topic while consumer is
        // running", trapping the orchestrator in a failed-restart loop.
        try {
            const { stopProcessor } = require('../orbital/orbital-matrix-processor');
            if (typeof stopProcessor === 'function') {
                await stopProcessor();
            }
            processorIntervalHandle = null;
            console.log('[OrbitalOrchestrator] Matrix Processor stopped');
        } catch (e) {
            console.warn('[OrbitalOrchestrator] Matrix Processor stop warning:', e.message);
            if (processorIntervalHandle) {
                clearInterval(processorIntervalHandle);
                processorIntervalHandle = null;
            }
        }

        // Close Ingestor WebSocket connections
        if (ingestorProcess && typeof ingestorProcess.stop === 'function') {
            ingestorProcess.stop();
            console.log('[OrbitalOrchestrator] Ingestor connections closed');
        } else if (ingestorProcess && ingestorProcess.connections) {
            for (const conn of ingestorProcess.connections.values()) {
                if (conn && typeof conn.close === 'function') conn.close();
            }
        }
        ingestorProcess = null;

        // Disconnect KafkaJS producer gracefully
        try {
            const { disconnectRedpanda } = require('./orbital-redpanda-bridge');
            if (typeof disconnectRedpanda === 'function') {
                await disconnectRedpanda();
            }
            console.log('[OrbitalOrchestrator] Kafka producer disconnected');
        } catch (e) {
            // Bridge not initialized — safe to ignore
        }

        // Keep the broker persistent across Electron restarts. Cluster teardown
        // is destructive to availability and must be explicitly requested.
        if (options.stopDocker === true) {
            if (dockerComposeProcess && !dockerComposeProcess.killed) {
                dockerComposeProcess.kill('SIGTERM');
            }
            await new Promise((resolve) => {
                exec('docker compose down', { cwd: process.env.WECRYP_ROOT || process.cwd() }, (err) => {
                    if (err) {
                        console.warn('[OrbitalOrchestrator] docker-compose down warning:', err.message);
                    } else {
                        console.log('[OrbitalOrchestrator] docker-compose down completed');
                    }
                    resolve();
                });
            });
        } else {
            console.log('[OrbitalOrchestrator] Redpanda containers left running');
        }

        orchestratorReady = false;
        recordStatusEvent('info', 'Orbital system shutdown complete');
        console.log('[OrbitalOrchestrator] Orbital System shutdown complete');
    } catch (err) {
        console.error('[OrbitalOrchestrator] Error during shutdown:', err.message);
        recordStatusEvent('warn', 'Orbital shutdown encountered an error', { error: err.message });
    }
}

async function restartOrbitalSystem(workspacePath) {
    recordStatusEvent('info', 'Orbital restart requested');
    await shutdownOrbitalSystem(false, { stopDocker: false });
    _statusCache = null;
    return startOrbitalSystem(workspacePath);
}

/**
 * Get the current status of the Orbital system for the UI (IPC: redpanda:status).
 *
 * Uses a 30-second cache + in-flight guard so rapid 2-second UI polls never
 * pile up concurrent docker exec calls that could flip the display to DOWN.
 */
async function getOrbitalStatus() {
    const now = Date.now();

    // Return cached result if fresh enough
    if (_statusCache && (now - _statusCache.ts) < STATUS_CACHE_TTL_MS) {
        return enrichStatus(_statusCache.value);
    }

    // If a probe is already running, wait for it (don't launch a second one)
    if (_statusInFlight) {
        return _statusInFlight;
    }

    // Launch a new probe and cache the promise so concurrent callers share it
    _statusInFlight = (async () => {
        const status = {
            ready: orchestratorReady,
            redpanda: 'unknown',
            docker: 'unknown',
            ingestor: !!ingestorProcess,
            processor: !!processorIntervalHandle,
            nodes: Number(lastProbeState.nodes || 0),
            nodesDown: [],
            topics: []
        };

        try {
            const dockerAvailable = await isDockerAvailable();
            status.docker = dockerAvailable ? 'healthy' : 'down';
            if (lastProbeState.docker !== status.docker) {
                lastProbeState.docker = status.docker;
                recordStatusEvent(
                    status.docker === 'healthy' ? 'success' : 'error',
                    status.docker === 'healthy' ? 'Docker daemon reachable' : 'Docker daemon unavailable'
                );
            }

            const redpandaReady = await checkPort(9092, '127.0.0.1', 5000);
            status.redpanda = redpandaReady ? 'healthy' : 'down';
            if (lastProbeState.redpanda !== status.redpanda) {
                lastProbeState.redpanda = status.redpanda;
                recordStatusEvent(
                    status.redpanda === 'healthy' ? 'success' : 'warn',
                    status.redpanda === 'healthy' ? 'Redpanda broker reachable' : 'Redpanda broker offline'
                );
            }

            if (redpandaReady) {
                // Use Node's built-in http.get instead of undici-backed fetch to avoid
                // ECONNRESET on Redpanda's Admin HTTP server (known undici incompatibility).
                const httpGetJson = (url, timeoutMs = 4000) => new Promise((resolve, reject) => {
                    const http = require('http');
                    const req = http.get(url, (res) => {
                        let body = '';
                        res.on('data', chunk => { body += chunk; });
                        res.on('end', () => {
                            if (res.statusCode >= 200 && res.statusCode < 300) {
                                try { resolve({ ok: true, statusCode: res.statusCode, body: JSON.parse(body) }); }
                                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
                            } else {
                                reject(new Error(`HTTP ${res.statusCode}`));
                            }
                        });
                    });
                    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
                    req.on('error', reject);
                });

                // Node count via Redpanda Admin REST API
                try {
                    const { body: brokers } = await httpGetJson('http://127.0.0.1:9644/v1/brokers');
                    const brokerList = Array.isArray(brokers) ? brokers : [];
                    const activeBrokers = brokerList.filter(broker => (
                        broker?.is_alive !== false && broker?.membership_status === 'active'
                    ));
                    status.nodes = activeBrokers.length;
                    status.nodesDown = brokerList
                        .filter(broker => broker?.is_alive === false || broker?.membership_status !== 'active')
                        .map(broker => broker?.node_id)
                        .filter(nodeId => Number.isFinite(nodeId));
                    if (status.nodesDown.length) status.redpanda = 'degraded';
                } catch (e) {
                    console.warn('[OrbitalOrchestrator] Failed to fetch brokers:', e.message);
                }

                if (!status.nodes) {
                    try {
                        const { body: health } = await httpGetJson('http://127.0.0.1:9644/v1/cluster/health_overview');
                        const allNodes = Array.isArray(health?.all_nodes) ? health.all_nodes : [];
                        const downNodes = Array.isArray(health?.nodes_down) ? health.nodes_down : [];
                        status.nodes = Math.max(0, allNodes.length - downNodes.length);
                        status.nodesDown = downNodes;
                        status.redpanda = health?.is_healthy === false ? 'degraded' : status.redpanda;
                    } catch (e) {
                        console.warn('[OrbitalOrchestrator] Failed to fetch cluster health:', e.message);
                    }
                }

                // Orbital topic list via Redpanda Console REST API
                try {
                    const { body: data } = await httpGetJson('http://127.0.0.1:8081/api/topics');
                    if (data && Array.isArray(data.topics)) {
                        status.topics = data.topics
                            .map(t => t.topicName)
                            .filter(name => name && name.includes('wecrypto.orbital'));
                    }
                } catch (e) {
                    console.warn('[OrbitalOrchestrator] Failed to fetch topics:', e.message);
                }
            }
        } catch (err) {
            console.warn('[OrbitalOrchestrator] Status check failed:', err.message);
            recordStatusEvent('warn', 'Orbital status probe failed', { error: err.message });
        }

        const bridge = getBridgeStatsSafe();
        const topicCount = Array.isArray(status.topics) ? status.topics.length : 0;
        if (lastProbeState.topicCount !== topicCount) {
            lastProbeState.topicCount = topicCount;
            recordStatusEvent('info', `Orbital topics visible: ${topicCount}`, { topics: status.topics });
        }
        if (lastProbeState.nodes !== status.nodes) {
            lastProbeState.nodes = status.nodes;
            recordStatusEvent('info', `Redpanda broker nodes: ${status.nodes}`, { nodes: status.nodes });
        }
        if (lastProbeState.bridgeConnected !== bridge.connected) {
            lastProbeState.bridgeConnected = bridge.connected;
            recordStatusEvent(
                bridge.connected ? 'success' : 'warn',
                bridge.connected ? 'Kafka bridge connected' : 'Kafka bridge disconnected'
            );
        }

        // Store in cache
        _statusCache = { ts: Date.now(), value: status };
        return enrichStatus(status);
    })().finally(() => {
        _statusInFlight = null;
    });

    return _statusInFlight;
}

// ---------------------------------------------------------------------------
// WE-CRYPTO PROXY MANAGEMENT
// ---------------------------------------------------------------------------

async function startProxies(workspacePath) {
    console.log('[OrbitalOrchestrator] Starting WE-CRYPTO proxies...');

    // 1. WebSocket Proxy
    if (!wsProxyProcess || wsProxyProcess.killed) {
        const wsProxyScript = path.join(workspacePath, 'src', 'infra', 'ws-proxy-server.js');
        if (fs.existsSync(wsProxyScript)) {
            wsProxyProcess = spawn(process.execPath, [wsProxyScript], {
                cwd: workspacePath,
                env: { ...process.env, WECRYPTO_WS_PROXY_PORT: '3011' },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            wsProxyProcess.stdout.on('data', chunk => console.log('[ws-proxy]', chunk.toString().trim()));
            wsProxyProcess.stderr.on('data', chunk => console.warn('[ws-proxy:err]', chunk.toString().trim()));
            wsProxyProcess.on('exit', code => { wsProxyProcess = null; console.log('[ws-proxy] exited', code); });
        } else {
            console.warn('[OrbitalOrchestrator] ws-proxy-server.js not found!');
        }
    }

    // 2. HTTP Rust Proxy
    if (!httpProxyProcess || httpProxyProcess.killed) {
        const candidates = [
            path.join(process.env.APPDATA || '', 'WECRYPTO', 'we-crypto-proxy.exe'),
            path.join(workspacePath, 'we-crypto-proxy.exe'),
            path.join(workspacePath, 'proxy', 'target', 'x86_64-pc-windows-gnu', 'release', 'we-crypto-proxy.exe'),
            path.join(workspacePath, 'proxy', 'target', 'release', 'we-crypto-proxy.exe'),
        ];

        let exePath = candidates.find(p => fs.existsSync(p));
        if (!exePath && process.resourcesPath) {
            const cp = [
                path.join(process.resourcesPath, 'app.asar.unpacked', 'we-crypto-proxy.exe'),
                path.join(process.resourcesPath, 'we-crypto-proxy.exe')
            ];
            exePath = cp.find(p => fs.existsSync(p));
        }

        if (exePath) {
            const chosenPort = 3010;
            let proxyDir = path.dirname(exePath);
            if (proxyDir.includes('app.asar')) {
                const os = require('os');
                proxyDir = path.join(process.env.TEMP || path.join(os.homedir(), 'AppData', 'Roaming', 'WECRYPTO'), 'proxy-config');
                fs.mkdirSync(proxyDir, { recursive: true });
            }
            try {
                const configContent = `[server]
host         = "127.0.0.1"
port         = ${chosenPort}
timeout_secs = 12
[exchanges]
binance         = "https://data-api.binance.vision"
binance-f       = "https://fapi.binance.com"
coingecko       = "https://api.coingecko.com"
coinbase        = "https://api.coinbase.com"
coinbase-ex     = "https://api.exchange.coinbase.com"
kraken          = "https://api.kraken.com"
bybit           = "https://api.bybit.com"
okx             = "https://www.okx.com"
kalshi          = "https://api.elections.kalshi.com"
polymarket      = "https://gamma-api.polymarket.com"
polymarket-clob = "https://clob.polymarket.com"
bitfinex        = "https://api-pub.bitfinex.com"
kucoin          = "https://api.kucoin.com"
mexc            = "https://api.mexc.com"
hypurrscan      = "https://hypurrscan.io"
dexscreener     = "https://api.dexscreener.com"
mempool         = "https://mempool.space"
blockchair      = "https://api.blockchair.com"
etherscan       = "https://api.etherscan.io"
bscscan         = "https://api.bscscan.com"
crypto-com      = "https://api.crypto.com"
bitstamp        = "https://www.bitstamp.net"
upbit           = "https://api.upbit.com"
binance-data    = "https://data-api.binance.vision"`;
                fs.writeFileSync(path.join(proxyDir, 'config.toml'), configContent);
            } catch (e) {
                console.warn('[OrbitalOrchestrator] could not write config.toml:', e.message);
            }

            httpProxyProcess = spawn(exePath, [], {
                detached: false,
                cwd: proxyDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            httpProxyProcess.stdout.on('data', chunk => console.log('[http-proxy]', chunk.toString().trim()));
            httpProxyProcess.stderr.on('data', chunk => console.warn('[http-proxy:err]', chunk.toString().trim()));
            httpProxyProcess.on('exit', code => { httpProxyProcess = null; console.log('[http-proxy] exited', code); });
        } else {
            console.warn('[OrbitalOrchestrator] we-crypto-proxy.exe not found!');
        }
    }
}

async function stopProxies() {
    if (httpProxyProcess && !httpProxyProcess.killed) {
        try { httpProxyProcess.kill(); } catch (e) { }
    }
    if (wsProxyProcess && !wsProxyProcess.killed) {
        try { wsProxyProcess.kill(); } catch (e) { }
    }
}

module.exports = {
    startOrbitalSystem,
    restartOrbitalSystem,
    shutdownOrbitalSystem,
    getOrbitalStatus,
    isOrchestrationReady: () => orchestratorReady
};
