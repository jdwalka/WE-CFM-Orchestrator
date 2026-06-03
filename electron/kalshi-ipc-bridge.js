/**
 * Kalshi IPC Bridge
 * 
 * Main process (Electron) connects to Kalshi worker via HTTP,
 * then exposes API to renderer via IPC.
 * 
 * This goes in main.js after existing ipc handlers.
 */

const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { resolveKalshiCredentialFile } = require('./kalshi-credentials.js');

// Kalshi worker state
let kalshiWorker = null;
let kalshiWorkerUrl = 'http://127.0.0.1:3050';
let readinessPollTimer = null;
const kalshiWorkerState = {
  bootStartedAt: 0,
  ready: false,
  readyLatencyMs: null,
  lastHealthError: null,
};

function resolveWorkerScriptPath() {
  const packagedScript = process.resourcesPath
    ? path.join(process.resourcesPath, 'app.asar', 'electron', 'kalshi-worker.js')
    : null;
  if (packagedScript && fs.existsSync(packagedScript)) return packagedScript;
  return path.join(__dirname, 'kalshi-worker.js');
}

function resolveRuntimeBaseDir() {
  const execDir = path.dirname(process.execPath || '');
  if (execDir && fs.existsSync(execDir)) return execDir;
  if (fs.existsSync(__dirname)) return __dirname;
  return process.cwd();
}

async function probeWorkerHealth(timeoutMs = 800) {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => {
      try {
        ctrl.abort(new DOMException(`Kalshi worker health timeout after ${timeoutMs}ms`, 'TimeoutError'));
      } catch (_) {
        try { ctrl.abort(); } catch (_) { }
      }
    }, timeoutMs);
    const res = await fetch(`${kalshiWorkerUrl}/health`, { signal: ctrl.signal });
    clearTimeout(timeout);
    return !!res.ok;
  } catch (_) {
    return false;
  }
}

/**
 * Start Kalshi worker as subprocess
 */
async function startKalshiWorker(options = {}) {
  const bootTimeoutMs = Number.isFinite(options.bootTimeoutMs) ? options.bootTimeoutMs : 12000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 150;
  const alreadyRunning = await probeWorkerHealth(900);
  if (alreadyRunning) {
    kalshiWorkerState.bootStartedAt = Date.now();
    kalshiWorkerState.ready = true;
    kalshiWorkerState.readyLatencyMs = 0;
    kalshiWorkerState.lastHealthError = null;
    console.log('[Main] Kalshi worker already running on http://127.0.0.1:3050 (reusing existing process)');
    return true;
  }

  return new Promise((resolve) => {
    console.log('[Main] Starting Kalshi worker...');
    kalshiWorkerState.bootStartedAt = Date.now();
    kalshiWorkerState.ready = false;
    kalshiWorkerState.readyLatencyMs = null;
    kalshiWorkerState.lastHealthError = null;

    const nodeExec = process.execPath || 'node';
    const runtimeBaseDir = resolveRuntimeBaseDir();
    const workerScript = resolveWorkerScriptPath();
    const credentialFile = resolveKalshiCredentialFile({ app, runtimeBaseDir }).path;

    if (!fs.existsSync(workerScript)) {
      console.error(`[Main] Kalshi worker script not found: ${workerScript}`);
      resolve(false);
      return;
    }

    kalshiWorker = spawn(nodeExec, [
      workerScript,
      '--port', '3050',
      '--env', 'production',
      '--file', credentialFile
    ], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: runtimeBaseDir,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      }
    });

    // Log worker output
    kalshiWorker.stdout?.on('data', (data) => {
      console.log('[Kalshi Worker]', data.toString().trim());
    });
    kalshiWorker.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      console.error('[Kalshi Worker Error]', msg);
      if (msg.includes('EADDRINUSE') && msg.includes('127.0.0.1:3050')) {
        // Another worker may already be serving this port.
        probeWorkerHealth(1200).then((ok) => {
          if (!ok) return;
          kalshiWorkerState.ready = true;
          kalshiWorkerState.readyLatencyMs = Date.now() - (kalshiWorkerState.bootStartedAt || Date.now());
          kalshiWorkerState.lastHealthError = null;
          console.log('[Main] Kalshi worker port already in use by a healthy instance (reusing existing service)');
        });
      }
    });

    kalshiWorker.on('error', (err) => {
      console.error('[Main] Failed to start worker:', err.message);
      resolve(false);
    });

    kalshiWorker.on('exit', (code) => {
      console.log('[Main] Worker exited with code', code);
      kalshiWorker = null;
      kalshiWorkerState.ready = false;
      kalshiWorkerState.readyLatencyMs = null;
      if (readinessPollTimer) {
        clearTimeout(readinessPollTimer);
        readinessPollTimer = null;
      }
    });

    // Wait for worker to be ready (health check)
    waitForWorkerReady(bootTimeoutMs, pollMs).then((ready) => {
      if (!ready) {
        scheduleLateReadinessCheck();
      }
      resolve(ready);
    });
  });
}

/**
 * Wait for worker to be ready
 */
async function waitForWorkerReady(maxMs = 12000, pollMs = 150) {
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${kalshiWorkerUrl}/health`);
      if (res.ok) {
        kalshiWorkerState.ready = true;
        kalshiWorkerState.readyLatencyMs = Date.now() - (kalshiWorkerState.bootStartedAt || Date.now());
        kalshiWorkerState.lastHealthError = null;
        console.log(`[Main] Kalshi worker ready (${kalshiWorkerState.readyLatencyMs}ms)`);
        return true;
      }
    } catch (e) {
      kalshiWorkerState.lastHealthError = e.message || 'health probe failed';
    }
    await new Promise(r => setTimeout(r, pollMs));
  }

  console.warn(`[Main] Kalshi worker did not start in time (${maxMs}ms)`);
  return false;
}

function scheduleLateReadinessCheck() {
  if (!kalshiWorker || readinessPollTimer) return;
  const poll = async () => {
    readinessPollTimer = null;
    if (!kalshiWorker || kalshiWorkerState.ready) return;
    const ready = await waitForWorkerReady(1200, 200);
    if (ready) {
      console.log('[Main] Kalshi worker became ready after initial timeout');
      return;
    }
    readinessPollTimer = setTimeout(poll, 1000);
  };
  readinessPollTimer = setTimeout(poll, 1000);
}

/**
 * Stop Kalshi worker
 */
function stopKalshiWorker() {
  if (kalshiWorker) {
    console.log('[Main] Stopping Kalshi worker...');
    try {
      kalshiWorker.kill();
    } catch (e) {
      console.error('[Main] Error killing worker:', e.message);
    }
    kalshiWorker = null;
  }
  kalshiWorkerState.ready = false;
  kalshiWorkerState.readyLatencyMs = null;
  if (readinessPollTimer) {
    clearTimeout(readinessPollTimer);
    readinessPollTimer = null;
  }
}

/**
 * Proxy HTTP request to worker
 */
async function proxyToWorker(method, path, body = null) {
  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${kalshiWorkerUrl}${path}`, options);
    const data = await res.json();
    return {
      success: res.ok,
      data,
      status: res.status
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      status: 0
    };
  }
}

// ──────────────────────────────────────────────────────────────
// IPC Handlers (for renderer process)
// ──────────────────────────────────────────────────────────────

/**
 * kalshi:health — Check if worker is alive
 */
ipcMain.handle('kalshi:health', async () => {
  return await proxyToWorker('GET', '/health');
});

/**
 * kalshi:status — Get full worker status
 */
ipcMain.handle('kalshi:status', async () => {
  return await proxyToWorker('GET', '/status');
});

/**
 * kalshi:workerReadiness — Local startup readiness state
 */
ipcMain.handle('kalshi:workerReadiness', async () => {
  return {
    success: true,
    data: {
      running: !!kalshiWorker,
      ...kalshiWorkerState,
    },
  };
});

/**
 * kalshi:balance — Get account balance
 */
ipcMain.handle('kalshi:balance', async () => {
  return await proxyToWorker('GET', '/balance');
});

/**
 * kalshi:markets — Get markets list
 */
ipcMain.handle('kalshi:markets', async (event, options = {}) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(options.limit || 50));
  if (options.series_ticker) qs.set('series_ticker', options.series_ticker);
  if (options.status) qs.set('status', options.status);
  return await proxyToWorker('GET', `/markets?${qs}`);
});

/**
 * kalshi:events — Get events
 */
ipcMain.handle('kalshi:events', async (event, options = {}) => {
  const ticker = options.ticker ? `?ticker=${encodeURIComponent(options.ticker)}` : '';
  return await proxyToWorker('GET', `/events${ticker}`);
});

/**
 * kalshi:positions — Get your positions
 */
ipcMain.handle('kalshi:positions', async () => {
  return await proxyToWorker('GET', '/positions');
});

/**
 * kalshi:orders — Get your orders
 */
ipcMain.handle('kalshi:orders', async () => {
  return await proxyToWorker('GET', '/orders');
});

/**
 * kalshi:placeOrder — Place an order
 */
ipcMain.handle('kalshi:placeOrder', async (event, orderRequest) => {
  return await proxyToWorker('POST', '/', {
    command: 'placeOrder',
    params: orderRequest
  });
});

/**
 * kalshi:cancelOrder — Cancel an order
 */
ipcMain.handle('kalshi:cancelOrder', async (event, orderId) => {
  return await proxyToWorker('POST', '/', {
    command: 'cancelOrder',
    params: { orderId }
  });
});

/**
 * kalshi:cancelAllOrders — Cancel all orders
 */
ipcMain.handle('kalshi:cancelAllOrders', async (event, filters = {}) => {
  return await proxyToWorker('POST', '/', {
    command: 'cancelAllOrders',
    params: { filters }
  });
});

/**
 * kalshi:getTrades — Get trades for market
 */
ipcMain.handle('kalshi:getTrades', async (event, marketId, filters = {}) => {
  return await proxyToWorker('POST', '/', {
    command: 'getTrades',
    params: { marketId, filters }
  });
});

const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch2 = require('node-fetch'); // Use node-fetch for agent support

// Default to 9050 (Tor daemon), but we can fall back to 9150 (Tor Browser) if needed.
// Mullvad Browser doesn't run Tor, so they need either tor.exe or Tor Browser.
const torAgent9050 = new SocksProxyAgent('socks5://127.0.0.1:9050');
const torAgent9150 = new SocksProxyAgent('socks5://127.0.0.1:9150');

// ──────────────────────────────────────────────────────────────
// Export for use in main.js
ipcMain.handle('ipc:fetch', async (event, url, opts = {}) => {
  try {
    const isBlockchain = /mempool\.space|blockchair\.com|etherscan\.io|blockscout\.com|xrplcluster\.com|alchemy\.com/.test(url);
    const useTor = isBlockchain || /\.onion/i.test(url) || opts.useTor === true;
    
    // We use node-fetch to pass the SOCKS5 agent
    const fetchFn = useTor ? fetch2 : fetch;
    
    const fetchOpts = {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json', ...(opts.headers || {}) },
    };

    if (useTor) {
      console.log(`[IPC Fetch] Routing via .TOR (SOCKS5): ${url}`);
      fetchOpts.agent = opts.torPort === 9150 ? torAgent9150 : torAgent9050;
    } else {
      fetchOpts.signal = AbortSignal.timeout(10000);
    }

    const res = await fetchFn(url, fetchOpts);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    console.error(`[IPC Fetch] Error fetching ${url}:`, err.message);
    return { ok: false, status: 0, error: err.message };
  }
});

// ──────────────────────────────────────────────────────────────
// Export for use in main.js
// ──────────────────────────────────────────────────────────────

module.exports = {
  startKalshiWorker,
  stopKalshiWorker,
  getWorkerStatus: () => kalshiWorker ? 'running' : 'stopped',
  getWorkerReadiness: () => ({ ...kalshiWorkerState }),
};
