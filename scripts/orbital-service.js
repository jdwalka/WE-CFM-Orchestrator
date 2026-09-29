'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const workspacePath = process.argv[2] || path.join(__dirname, '..');
process.env.WECRYP_ROOT = workspacePath;

const statusFile = process.env.WECRYP_ORBITAL_STATUS_FILE ||
    path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'WECRYPTO', 'orbital-service-status.json');

const { initRedpanda, disconnectRedpanda, getBridgeStats } = require('../src/infra/orbital-redpanda-bridge');
const OrbitalIngestor = require('../src/orbital/orbital-ingestor-daemon');
const { startProcessor, stopProcessor, getBufferStats } = require('../src/orbital/orbital-matrix-processor');

let statusTimer = null;
let ready = false;
let stopping = false;
let lastError = null;

function writeStatus(extra = {}) {
    try {
        fs.mkdirSync(path.dirname(statusFile), { recursive: true });
        fs.writeFileSync(statusFile, JSON.stringify({
            pid: process.pid,
            ready,
            stopping,
            ts: Date.now(),
            bridge: getBridgeStats(),
            buffer: getBufferStats(),
            error: lastError,
            ...extra,
        }), 'utf8');
    } catch (_) {}
}

async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    ready = false;
    writeStatus({ event: 'stopping' });
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
    }

    try { OrbitalIngestor.stop(); } catch (_) {}
    try { await stopProcessor(); } catch (_) {}
    try { await disconnectRedpanda(); } catch (_) {}

    writeStatus({ event: 'stopped' });
    process.exit(code);
}

process.on('SIGINT', () => { shutdown(0); });
process.on('SIGTERM', () => { shutdown(0); });
process.on('uncaughtException', (error) => {
    lastError = { message: error?.message || String(error), stack: error?.stack || null };
    writeStatus({ event: 'uncaughtException' });
    shutdown(1);
});
process.on('unhandledRejection', (reason) => {
    lastError = { message: reason?.message || String(reason), stack: reason?.stack || null };
    writeStatus({ event: 'unhandledRejection' });
});

(async () => {
    writeStatus({ event: 'starting' });
    await initRedpanda();
    OrbitalIngestor.start();
    await startProcessor();
    ready = true;
    writeStatus({ event: 'ready' });
    statusTimer = setInterval(() => writeStatus(), 5000);
    statusTimer.unref?.();
})();
