'use strict';
/**
 * start-runtime.js
 * Headless server runtime entry point for Docker / container environments.
 *
 * Starts three service layers in order:
 *   1. Orbital ingestor + Redpanda bridge  (orbital-service pipeline)
 *   2. WECRYPTO web service                (Express/WS API on WECRYPTO_WEB_PORT)
 *   3. Health endpoint on /health          (used by Docker HEALTHCHECK)
 *
 * Environment variables:
 *   WECRYPTO_WEB_HOST     Bind address for the web service (default: 0.0.0.0)
 *   WECRYPTO_WEB_PORT     Port for the web service         (default: 3443)
 *   KAFKA_BROKERS         Comma-separated Redpanda brokers (default: localhost:9092)
 *   REDIS_URL             Redis connection string          (default: redis://localhost:6379)
 *   NODE_ENV              production | development
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Resolve workspace root ─────────────────────────────────────────────────
const rootDir = path.resolve(__dirname, '..');
process.env.WECRYP_ROOT = process.env.WECRYP_ROOT || rootDir;

// Force container-friendly bind address unless already set
process.env.WECRYPTO_WEB_HOST = process.env.WECRYPTO_WEB_HOST || '0.0.0.0';
process.env.WECRYPTO_WEB_PORT = process.env.WECRYPTO_WEB_PORT || '3443';

// ── Status tracking ────────────────────────────────────────────────────────
const statusFile = process.env.WECRYPTO_RUNTIME_STATUS_FILE ||
  path.join(os.tmpdir(), 'wecrypto-runtime-status.json');

let orbitalReady = false;
let webReady = false;
let stopping = false;
let lastError = null;

function writeStatus(extra = {}) {
  try {
    fs.writeFileSync(statusFile, JSON.stringify({
      pid: process.pid,
      ts: Date.now(),
      orbitalReady,
      webReady,
      stopping,
      error: lastError,
      ...extra,
    }), 'utf8');
  } catch (_) {}
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
let orbitalShutdown = null;
let webServiceStop = null;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  orbitalReady = false;
  webReady = false;
  writeStatus({ event: 'stopping' });
  console.log('[runtime] Shutting down...');

  const tasks = [];
  if (typeof webServiceStop === 'function') tasks.push(Promise.resolve(webServiceStop()).catch(() => {}));
  if (typeof orbitalShutdown === 'function') tasks.push(Promise.resolve(orbitalShutdown()).catch(() => {}));

  await Promise.allSettled(tasks);
  writeStatus({ event: 'stopped' });
  process.exit(code);
}

process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => {
  lastError = { message: err?.message || String(err), stack: err?.stack || null };
  writeStatus({ event: 'uncaughtException' });
  console.error('[runtime] Uncaught exception:', lastError.message);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  lastError = { message: reason?.message || String(reason), stack: reason?.stack || null };
  writeStatus({ event: 'unhandledRejection' });
  console.error('[runtime] Unhandled rejection:', lastError.message);
});

// ── Boot sequence ──────────────────────────────────────────────────────────
(async () => {
  writeStatus({ event: 'starting' });
  console.log(`[runtime] WE-CFM-Orchestrator server runtime starting`);
  console.log(`[runtime] NODE_ENV=${process.env.NODE_ENV || 'production'}`);
  console.log(`[runtime] WECRYP_ROOT=${process.env.WECRYP_ROOT}`);

  // ── Step 1: Orbital pipeline (Redpanda bridge + ingestor) ──────────────
  // Set WECRYPTO_SKIP_ORBITAL=1 (or SKIP_ORBITAL=1) for headless Linux without Docker/Redpanda.
  const skipOrbital = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.WECRYPTO_SKIP_ORBITAL || process.env.SKIP_ORBITAL || '').trim().toLowerCase()
  );
  let initRedpanda, disconnectRedpanda, OrbitalIngestor, startProcessor, stopProcessor;
  if (skipOrbital) {
    console.warn('[runtime] Orbital pipeline skipped (WECRYPTO_SKIP_ORBITAL/SKIP_ORBITAL)');
    writeStatus({ event: 'orbital_skipped', reason: 'env_skip' });
  } else try {
    ({ initRedpanda, disconnectRedpanda } = require('../src/infra/orbital-redpanda-bridge'));
    OrbitalIngestor = require('../src/orbital/orbital-ingestor-daemon');
    ({ startProcessor, stopProcessor } = require('../src/orbital/orbital-matrix-processor'));

    console.log('[runtime] Connecting to Redpanda...');
    // Don't hang forever if broker is down — KafkaJS retries can take a long time.
    const connectMs = Number(process.env.WECRYPTO_REDPANDA_CONNECT_MS || 8000);
    await Promise.race([
      initRedpanda(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Redpanda connect timeout after ${connectMs}ms`)), connectMs)),
    ]);
    OrbitalIngestor.start();
    await startProcessor();
    orbitalReady = true;
    writeStatus({ event: 'orbital_ready' });
    console.log('[runtime] Orbital pipeline ready');

    orbitalShutdown = async () => {
      try { OrbitalIngestor.stop(); } catch (_) {}
      try { await stopProcessor(); }    catch (_) {}
      try { await disconnectRedpanda(); } catch (_) {}
    };
  } catch (err) {
    // Orbital pipeline is best-effort in environments without Redpanda
    console.warn(`[runtime] Orbital pipeline unavailable (${err.message}); continuing without it`);
    writeStatus({ event: 'orbital_skipped', reason: err.message });
  }

  // ── Step 2: Web service ────────────────────────────────────────────────
  try {
    const webSvc = require('../electron/wecrypto-web-service');
    const result = webSvc.startWebService();
    webReady = true;
    writeStatus({ event: 'web_ready', port: result.port, host: result.host });
    console.log(`[runtime] Web service ready on ${result.protocol || 'http'}://${result.host}:${result.port}`);

    webServiceStop = typeof webSvc.stopWebService === 'function' ? webSvc.stopWebService : null;
  } catch (err) {
    console.error(`[runtime] Web service failed to start: ${err.message}`);
    lastError = { message: err.message, stack: err.stack };
    writeStatus({ event: 'web_failed', reason: err.message });
    // Web service failure is fatal — nothing to serve
    await shutdown(1);
    return;
  }

  writeStatus({ event: 'ready' });
  console.log('[runtime] All services ready. Runtime is live.');

  // Keep alive — services maintain their own event loops
  setInterval(() => writeStatus(), 10_000).unref();
})();
