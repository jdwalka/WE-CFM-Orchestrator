// orbital-firebase-broadcaster.js — WECRYPTO Firestore lane broadcaster
'use strict';

const path = require('path');

let _firestore = null;
let _rtdb = null;
let _initDone = false;
let _initError = null;
let _adminModule = null;
let _bootstrapInFlight = null;

const ROOT_COLLECTION = 'wecrypto_engine';
const ROOT_DOC_ID = 'root';
const FIRESTORE_RATE_MS = 30_000;     // orbital state writes
const TICK_RATE_MS = 1_000;           // per-market tick writes
const VERTEX_RATE_MS = 2_000;         // per-kind execution logs
const FIRESTORE_WRITE_TIMEOUT_MS = _readIntEnv('WECRYPTO_FIRESTORE_WRITE_TIMEOUT_MS', 6500, 1000, 60000);
const FIRESTORE_WRITE_ATTEMPTS = _readIntEnv('WECRYPTO_FIRESTORE_WRITE_ATTEMPTS', 2, 1, 5);
const FIRESTORE_BACKOFF_BASE_MS = _readIntEnv('WECRYPTO_FIRESTORE_BACKOFF_BASE_MS', 350, 50, 20000);
const FIRESTORE_BACKOFF_MAX_MS = _readIntEnv('WECRYPTO_FIRESTORE_BACKOFF_MAX_MS', 5000, 250, 60000);
const FIRESTORE_CIRCUIT_FAILURES = _readIntEnv('WECRYPTO_FIRESTORE_CIRCUIT_FAILURES', 3, 1, 20);
const FIRESTORE_CIRCUIT_BASE_MS = _readIntEnv('WECRYPTO_FIRESTORE_CIRCUIT_BASE_MS', 30000, 1000, 300000);
const FIRESTORE_CIRCUIT_MAX_MS = _readIntEnv('WECRYPTO_FIRESTORE_CIRCUIT_MAX_MS', 180000, 5000, 900000);
const _lastWrite = {};                // { sym: ts }
const _lastTickWrite = {};            // { market: ts }
const _lastVertexWrite = {};          // { kind: ts }
const _inFlightWrites = new Set();

const _writeCircuit = {
  failures: 0,
  openUntil: 0,
  lastError: null,
  lastFailureAt: 0,
  lastWarnAt: 0,
  fallbackActivated: false,
  fallbackReason: null,
  skipped: 0,
};

function _initFirebase() {
  if (_firestore && (_rtdb || _initDone)) return;
  try {
    _adminModule = _adminModule || require(path.join(__dirname, '../cloud/firebase-admin-firestore'));
    _firestore = _adminModule && typeof _adminModule.getFirestore === 'function'
      ? _adminModule.getFirestore()
      : (_adminModule && _adminModule.firestore ? _adminModule.firestore : null);
    if (!_firestore && _adminModule && typeof _adminModule.startupCheck === 'function' && !_bootstrapInFlight) {
      _bootstrapInFlight = _adminModule.startupCheck({ required: false, probe: false })
        .then(() => {
          _firestore = _adminModule && typeof _adminModule.getFirestore === 'function'
            ? _adminModule.getFirestore()
            : _firestore;
        })
        .catch((e) => {
          _initError = e && e.message ? e.message : String(e);
        })
        .finally(() => {
          _bootstrapInFlight = null;
        });
    }
  } catch (e) {
    _initError = e.message;
  }
  try {
    const admin = require('firebase-admin');
    const rtdbUrl = process.env.WECRYPTO_FIREBASE_DATABASE_URL;
    if (rtdbUrl && admin.apps && admin.apps.length) {
      _rtdb = admin.app().database(rtdbUrl);
    }
  } catch (_) { }
  _initDone = true;
}

function _toUpper(value, fallback) {
  const v = String(value || '').trim().toUpperCase();
  return v || String(fallback || 'UNKNOWN').trim().toUpperCase();
}

function _toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _isRateLimited(map, key, windowMs) {
  const now = Date.now();
  const last = map[key] || 0;
  if (now - last < windowMs) return true;
  map[key] = now;
  return false;
}

function _readIntEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _describeError(error) {
  return String(error && (error.message || error.details || error.code) || error || 'unknown error');
}

function _isTransientFirestoreError(error) {
  const msg = _describeError(error).toLowerCase();
  return (
    msg.includes('deadline')
    || msg.includes('timeout')
    || msg.includes('unavailable')
    || msg.includes('econnrefused')
    || msg.includes('socket')
    || msg.includes('network')
    || msg.includes('rst_stream')
  );
}

function _withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'WECRYPTO_FIRESTORE_WRITE_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]);
}

function _isCircuitOpen() {
  const now = Date.now();
  if (_writeCircuit.openUntil > now) {
    _writeCircuit.skipped += 1;
    return true;
  }
  if (_writeCircuit.openUntil && _writeCircuit.openUntil <= now) {
    _writeCircuit.openUntil = 0;
  }
  return false;
}

function _recordWriteSuccess() {
  _writeCircuit.failures = 0;
  _writeCircuit.openUntil = 0;
  _writeCircuit.lastError = null;
}

function _recordWriteFailure(label, error) {
  const now = Date.now();
  _writeCircuit.failures += 1;
  _writeCircuit.lastFailureAt = now;
  _writeCircuit.lastError = _describeError(error);

  if (_writeCircuit.failures >= FIRESTORE_CIRCUIT_FAILURES) {
    const exponent = Math.min(5, _writeCircuit.failures - FIRESTORE_CIRCUIT_FAILURES);
    const cooldown = Math.min(FIRESTORE_CIRCUIT_MAX_MS, FIRESTORE_CIRCUIT_BASE_MS * Math.pow(2, exponent));
    _writeCircuit.openUntil = now + cooldown;
  }

  const warnWindow = Math.max(5000, Math.min(FIRESTORE_CIRCUIT_BASE_MS, 30000));
  if (now - _writeCircuit.lastWarnAt >= warnWindow) {
    _writeCircuit.lastWarnAt = now;
    const suffix = _writeCircuit.openUntil > now
      ? `; circuit open for ${Math.ceil((_writeCircuit.openUntil - now) / 1000)}s`
      : '';
    console.warn(`[orbital-broadcaster] Firestore write failure (${label}): ${_writeCircuit.lastError}${suffix}`);
  }
}

function _retryDelay(attempt) {
  const base = Math.min(FIRESTORE_BACKOFF_MAX_MS, FIRESTORE_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.max(25, base * 0.25));
  return Math.min(FIRESTORE_BACKOFF_MAX_MS, base + jitter);
}

function _docId(...parts) {
  const raw = parts
    .map((part) => String(part == null ? '' : part).trim())
    .filter(Boolean)
    .join('_');
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 180);
  return safe || `doc_${Date.now()}`;
}

async function _activateLocalFallback(reason) {
  if (!_adminModule || typeof _adminModule.switchToLocalEmulator !== 'function') return false;
  const fallbackEnabled = typeof _adminModule.firestoreLocalFallbackEnabled === 'function'
    ? _adminModule.firestoreLocalFallbackEnabled()
    : envFlagEnabled(process.env.WECRYPTO_FIRESTORE_LOCAL_FALLBACK || '0');
  if (!fallbackEnabled) return false;

  try {
    const result = await _adminModule.switchToLocalEmulator({ reason });
    if (result && result.success) {
      _firestore = typeof _adminModule.getFirestore === 'function'
        ? _adminModule.getFirestore()
        : _firestore;
      _writeCircuit.failures = 0;
      _writeCircuit.openUntil = 0;
      _writeCircuit.fallbackActivated = true;
      _writeCircuit.fallbackReason = reason || result.localFallbackReason || 'prod Firestore unavailable';
      console.warn(`[orbital-broadcaster] Firestore local emulator fallback active (${result.emulatorHost || '127.0.0.1:8080'}).`);
      return !!_firestore;
    }
    _initError = result && result.error ? result.error : 'Firestore emulator fallback failed';
  } catch (error) {
    _initError = _describeError(error);
  }
  return false;
}

async function _ensureFirestoreReady() {
  _initFirebase();
  if (_bootstrapInFlight) {
    try {
      await _bootstrapInFlight;
    } catch (error) {
      _initError = _describeError(error);
    }
  }
  if (_firestore) return true;
  return _activateLocalFallback(_initError || 'Firestore unavailable');
}

async function _writeWithRetry(label, operation, options = {}) {
  const ready = await _ensureFirestoreReady();
  if (!ready || !_firestore) {
    return { success: false, skipped: true, error: _initError || 'Firestore unavailable' };
  }

  if (_isCircuitOpen()) {
    return { success: false, skipped: true, circuitOpen: true, error: _writeCircuit.lastError || 'Firestore circuit open' };
  }

  const attempts = Math.max(1, options.attempts || FIRESTORE_WRITE_ATTEMPTS);
  const token = Symbol(label);
  _inFlightWrites.add(token);
  let lastError = null;

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await _withTimeout(operation(), FIRESTORE_WRITE_TIMEOUT_MS, label);
        _recordWriteSuccess();
        return { success: true, result };
      } catch (error) {
        lastError = error;

        const status = _adminModule && typeof _adminModule.getStatus === 'function'
          ? _adminModule.getStatus()
          : {};
        if (
          status.target === 'prod'
          && _isTransientFirestoreError(error)
          && await _activateLocalFallback(_describeError(error))
        ) {
          continue;
        }

        if (attempt < attempts && _isTransientFirestoreError(error)) {
          await _sleep(_retryDelay(attempt));
          continue;
        }
        break;
      }
    }
  } finally {
    _inFlightWrites.delete(token);
  }

  _recordWriteFailure(label, lastError);
  return { success: false, error: _describeError(lastError) };
}

function _deriveAssetFromTicker(marketTicker) {
  const txt = String(marketTicker || '').toUpperCase();
  const known = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'RNDR', 'DOT'];
  for (const sym of known) {
    if (txt.includes(sym)) return sym;
  }
  return 'UNKNOWN';
}

function _deriveMarketId(marketTicker) {
  const raw = String(marketTicker || '').trim();
  if (!raw) return 'UNKNOWN_MARKET';
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function _buildOrbitalPayload(orbital) {
  return {
    asset: _toUpper(orbital.asset, 'UNKNOWN'),
    timestamp: new Date().toISOString(),
    ts: _toNum(orbital.ts, Date.now()),
    lambda: _toNum(orbital.lambda, null),
    orbital_metrics: {
      s_ground_state: _toNum(orbital.s, null),
      p_momentum: _toNum(orbital.p, null),
      d_diffusion: _toNum(orbital.d, null),
      f_price_accel: _toNum(orbital.f, null),
      f_vol_anomaly: _toNum(orbital.fAnomalyVol, null),
    },
    exhaustion_profile: {
      oeq_v1: _toNum(orbital.oeq, null),
      oeq_v2: _toNum(orbital.oeqV2, null),
      p_pct: _toNum(orbital?.v2?.pPct, null),
      d_pct: _toNum(orbital?.v2?.dPct, null),
      dist_pct: _toNum(orbital?.v2?.distPct, null),
      structural_state: orbital.state || null,
    },
    qsp: orbital.qsp || null,
    quantum_state: orbital.quantum_state || orbital.quantum_states || null,
    execution_signal: {
      action: orbital.action || null,
      reason: orbital.reason || null,
      fade_direction: orbital.fadeDirection || null,
    },
    kalshi_v2_payload: orbital.kalshiV2Payload || null,
    position: {
      side: orbital.position ? orbital.position.side : null,
      entry_price: orbital.position ? _toNum(orbital.position.entryPrice, null) : null,
      peak_price: orbital.position ? _toNum(orbital.position.peakPrice, null) : null,
      peak_oeq: orbital.position ? _toNum(orbital.position.peakAbsOEQ, null) : null,
    },
  };
}

function _buildTickPayload(tick) {
  const market = _deriveMarketId(tick.market_id || tick.market_ticker || tick.ticker);
  const ts = _toNum(tick.ts, Date.now());
  return {
    market_id: market,
    price: _toNum(tick.price, _toNum(tick.yes_bid, _toNum(tick.last_traded, null))),
    vol: _toNum(tick.vol, _toNum(tick.volume, null)),
    ts,
    stream_status: tick.stream_status || 'active',
    yes_bid: _toNum(tick.yes_bid, null),
    yes_ask: _toNum(tick.yes_ask, null),
    no_bid: _toNum(tick.no_bid, null),
    no_ask: _toNum(tick.no_ask, null),
    source: tick.source || 'kalshi-ws',
  };
}

function _buildTensorBatchPayload(orbital) {
  const ts = _toNum(orbital.ts, Date.now());
  const qsp = orbital.qsp || {};
  const eigenvalues = Array.isArray(qsp.schrodingerOrbitals)
    ? qsp.schrodingerOrbitals.map((lvl) => _toNum(lvl.energy, null)).filter(Number.isFinite)
    : [];

  const confidence = _toNum(qsp?.quantizer?.confidence, null);
  let state = 'coiled';
  const action = orbital.action || orbital?.execution_signal?.action || null;
  if (action === 'EXECUTE_COUNTER_TRADE') state = 'excited';
  else if (action === 'EXECUTE_EXIT') state = 'decaying';
  else if (confidence != null && confidence < 0.45) state = 'diffuse';

  return {
    state,
    ts,
    eigenvalues,
    qsp_mode: qsp.mode || null,
    confidence,
    oeq: _toNum(orbital.oeq, _toNum(orbital?.exhaustion_profile?.oeq_v1, null)),
    oeq_v2: _toNum(orbital.oeqV2, _toNum(orbital?.exhaustion_profile?.oeq_v2, null)),
    p_delta: _toNum(orbital.pDelta, null),
    payload: orbital.kalshiV2Payload || orbital.kalshi_v2_payload || null,
  };
}

function _buildVertexExecutionPayload(kind, data = {}) {
  return {
    kind: String(kind || 'orbital_rebalances'),
    ts: _toNum(data.ts, Date.now()),
    source: data.source || 'wecrypto',
    asset: data.asset ? _toUpper(data.asset, 'UNKNOWN') : null,
    market_id: data.market_id ? _deriveMarketId(data.market_id) : null,
    action: data.action || null,
    score: _toNum(data.score, null),
    payload: data.payload && typeof data.payload === 'object' ? data.payload : null,
    diagnostics: data.diagnostics && typeof data.diagnostics === 'object' ? data.diagnostics : null,
  };
}

async function _pushOrbitalState(sym, payload) {
  const asset = _toUpper(sym, 'UNKNOWN');
  await _writeWithRetry(`orbital latest ${asset}`, async () => {
    const rootRef = _firestore.collection(ROOT_COLLECTION).doc(ROOT_DOC_ID);
    const latestRef = rootRef.collection('orbital_states').doc(asset);
    await latestRef.set({
      latest_state: payload.exhaustion_profile?.structural_state || null,
      latest_ts: payload.ts,
      latest_oeq: payload.exhaustion_profile?.oeq_v1 || null,
      latest_confidence: payload?.qsp?.quantizer?.confidence || null,
      quantum_state: payload.quantum_state || payload.quantum_states || null,
      updated_at: payload.timestamp,
    }, { merge: true });
  });

  const tensorDocId = _docId(asset, payload.ts, payload.timestamp, 'tensor');
  await _writeWithRetry(`tensor batch ${asset}`, async () => {
    const rootRef = _firestore.collection(ROOT_COLLECTION).doc(ROOT_DOC_ID);
    const tensorRef = rootRef
      .collection('orbital_states').doc(asset)
      .collection('tensor_batches')
      .doc(tensorDocId);
    await tensorRef.set(_buildTensorBatchPayload(payload), { merge: true });
  });
}

async function _pushTick(tickPayload) {
  const marketId = _deriveMarketId(tickPayload.market_id);
  await _writeWithRetry(`tick ${marketId}`, async () => {
    const rootRef = _firestore.collection(ROOT_COLLECTION).doc(ROOT_DOC_ID);
    const streamRef = rootRef.collection('event_streams').doc(marketId);
    await streamRef.set({
      stream_status: tickPayload.stream_status || 'active',
      market_id: marketId,
      updated_at_ts: tickPayload.ts,
    }, { merge: true });

    const tickDocId = _docId(marketId, tickPayload.ts, tickPayload.source, tickPayload.price);
    await streamRef.collection('ticks').doc(tickDocId).set({
      price: tickPayload.price,
      vol: tickPayload.vol,
      ts: tickPayload.ts,
      yes_bid: tickPayload.yes_bid,
      yes_ask: tickPayload.yes_ask,
      no_bid: tickPayload.no_bid,
      no_ask: tickPayload.no_ask,
      source: tickPayload.source || 'kalshi-ws',
    }, { merge: true });
  });
}

async function _pushVertexExecution(kind, data = {}) {
  const bucket = String(kind || 'orbital_rebalances');
  const entryDocId = _docId(bucket, data.ts || Date.now(), data.asset, data.market_id, data.action);
  await _writeWithRetry(`vertex execution ${bucket}`, async () => {
    const rootRef = _firestore.collection(ROOT_COLLECTION).doc(ROOT_DOC_ID);
    const bucketRef = rootRef.collection('vertex_executions').doc(bucket);
    await bucketRef.set({
      last_ts: _toNum(data.ts, Date.now()),
      updated_at: new Date().toISOString(),
      kind: bucket,
    }, { merge: true });
    await bucketRef.collection('entries').doc(entryDocId).set(_buildVertexExecutionPayload(bucket, data), { merge: true });
  });
}

async function _pushToRTDB(sym, payload) {
  if (!_rtdb) return;
  try {
    await _rtdb.ref('orbital/' + _toUpper(sym, 'UNKNOWN')).set(payload);
  } catch (_) { }
}

function push(orbital) {
  if (!orbital || !orbital.asset) return;
  _initFirebase();
  const sym = _toUpper(orbital.asset, 'UNKNOWN');
  if (_isRateLimited(_lastWrite, sym, FIRESTORE_RATE_MS)) return;

  const payload = _buildOrbitalPayload(orbital);
  _pushOrbitalState(sym, payload).catch(() => { });
  _pushToRTDB(sym, payload).catch(() => { });

  if (orbital.action === 'EXECUTE_COUNTER_TRADE' || orbital.action === 'EXECUTE_EXIT') {
    const kind = orbital.action === 'EXECUTE_COUNTER_TRADE' ? 'short_term_contracts' : 'orbital_rebalances';
    _pushVertexExecution(kind, {
      ts: payload.ts,
      source: 'orbital-engine',
      asset: sym,
      action: orbital.action,
      score: payload.exhaustion_profile?.oeq_v2 ?? payload.exhaustion_profile?.oeq_v1 ?? null,
      payload: orbital.kalshiV2Payload || null,
      diagnostics: { state: orbital.state, reason: orbital.reason, qsp: orbital.qsp || null },
    }).catch(() => { });
  }
}

async function pushBatch(results) {
  if (!Array.isArray(results) || !results.length) return;
  _initFirebase();
  for (const orbital of results) push(orbital);
}

function envFlagEnabled(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function pushMarketTick(tick) {
  if (!tick) return;
  if (!envFlagEnabled(process.env.WECRYPTO_FIRESTORE_TICKS_ENABLED || '0')) return;
  _initFirebase();
  const marketId = _deriveMarketId(tick.market_id || tick.market_ticker || tick.ticker);
  if (_isRateLimited(_lastTickWrite, marketId, TICK_RATE_MS)) return;
  const payload = _buildTickPayload(tick);
  _pushTick(payload).catch(() => { });
}

function pushVertexExecution(kind, data) {
  _initFirebase();
  const bucket = String(kind || 'orbital_rebalances');
  if (_isRateLimited(_lastVertexWrite, bucket, VERTEX_RATE_MS)) return;
  _pushVertexExecution(bucket, data || {}).catch(() => { });
}

function getDiagnostics() {
  const status = _adminModule && typeof _adminModule.getStatus === 'function'
    ? _adminModule.getStatus()
    : null;
  return {
    firestoreReady: !!_firestore,
    rtdbReady: !!_rtdb,
    initError: _initError,
    firestoreStatus: status,
    writeCircuit: {
      failures: _writeCircuit.failures,
      openUntil: _writeCircuit.openUntil,
      openForMs: Math.max(0, _writeCircuit.openUntil - Date.now()),
      lastError: _writeCircuit.lastError,
      lastFailureAt: _writeCircuit.lastFailureAt,
      fallbackActivated: _writeCircuit.fallbackActivated,
      fallbackReason: _writeCircuit.fallbackReason,
      skipped: _writeCircuit.skipped,
      inFlight: _inFlightWrites.size,
      writeTimeoutMs: FIRESTORE_WRITE_TIMEOUT_MS,
      attempts: FIRESTORE_WRITE_ATTEMPTS,
    },
    lastWrite: Object.assign({}, _lastWrite),
    lastTickWrite: Object.assign({}, _lastTickWrite),
    lastVertexWrite: Object.assign({}, _lastVertexWrite),
    rootCollection: ROOT_COLLECTION,
    rootDocId: ROOT_DOC_ID,
    rateLimitMs: FIRESTORE_RATE_MS,
    tickRateMs: TICK_RATE_MS,
    vertexRateMs: VERTEX_RATE_MS,
  };
}


function pushMatrixElement(element) {
  if (!element || !element.asset) return;
  _initFirebase();
  const sym = _toUpper(element.asset, 'UNKNOWN');
  
  // We bypass rate limiting for the matrix elements as they are 15-min windowed already
  const payload = {
    ...element,
    timestamp_iso: new Date().toISOString(),
    source: 'orbital-matrix-engine'
  };

  _pushOrbitalState(sym, payload).catch(() => { });
  _pushToRTDB(sym, payload).catch(() => { });
}
module.exports = {
  push,
  pushBatch,
  pushMarketTick,
  pushVertexExecution,
  pushMatrixElement,
  getDiagnostics,
};

