// grok-firestore-bridge.js — durable Firestore persistence for Grok's
// session-memory (sampleCount survives restarts) and PTB-defense history
// (a real, queryable "has this level been defended before" signal).
//
// Main-process only. Modeled on src/orbital/orbital-firebase-broadcaster.js
// but simpler — write volume here is low (one session snapshot every ~5min
// per coin, one PTB-window record every 5min per coin), so the full
// retry/circuit-breaker machinery that module needs isn't required; a
// dropped write just means one missed history point, not a cascading outage.
//
// Fails open everywhere: if Firebase isn't enabled/configured
// (WECRYPTO_FIREBASE_ENABLED/REQUIRED default off, see electron/main.js),
// every exported function resolves to {success:false, ...}/null instead of
// throwing, so callers never need to special-case "Firebase is off".
'use strict';

let firebaseAdmin = null;
try {
  firebaseAdmin = require('firebase-admin');
} catch (_) {
  firebaseAdmin = null;
}

let _adminModule = null;
let _firestore = null;
let _initError = null;
let _bootstrapInFlight = null;

const SESSION_COLLECTION = 'wecrypto_grok_session_memory';
const PTB_COLLECTION = 'wecrypto_grok_ptb_defense';

const SESSION_SNAPSHOT_RATE_MS = 60_000;
const PTB_WRITE_RATE_MS = 30_000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TOLERANCE_BPS = 15; // 0.15%
const DEFAULT_QUERY_LIMIT = 500;
// Rate-limit tracking is keyed by symbol; today's only caller (grok-analytics-memory.js)
// only ever passes BTC/ETH/SOL/XRP, but bound it anyway so this stays safe if that
// changes — evicts the oldest-tracked symbol rather than growing forever.
const MAX_TRACKED_SYMBOLS = 64;

const _lastSessionWrite = new Map(); // sym -> ts
const _lastPtbWrite = new Map();     // sym -> ts

function _isRateLimited(map, key, windowMs) {
  const now = Date.now();
  const last = map.get(key) || 0;
  if (now - last < windowMs) return true;
  if (!map.has(key) && map.size >= MAX_TRACKED_SYMBOLS) {
    map.delete(map.keys().next().value);
  }
  map.set(key, now);
  return false;
}

function _toUpper(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function _toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _docId(...parts) {
  const raw = parts
    .map((part) => String(part == null ? '' : part).trim())
    .filter(Boolean)
    .join('_');
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 180);
  return safe || `doc_${Date.now()}`;
}

function _serverTimestamp() {
  return firebaseAdmin && firebaseAdmin.firestore
    ? firebaseAdmin.firestore.FieldValue.serverTimestamp()
    : null;
}

function _initFirebase() {
  if (_firestore) return;
  try {
    _adminModule = _adminModule || require('./firebase-admin-firestore');
    _firestore = typeof _adminModule.getFirestore === 'function' ? _adminModule.getFirestore() : null;
    if (!_firestore && typeof _adminModule.startupCheck === 'function' && !_bootstrapInFlight) {
      _bootstrapInFlight = _adminModule.startupCheck({ required: false, probe: false })
        .then(() => {
          _firestore = typeof _adminModule.getFirestore === 'function' ? _adminModule.getFirestore() : _firestore;
        })
        .catch((e) => {
          _initError = e && e.message ? e.message : String(e);
        })
        .finally(() => {
          _bootstrapInFlight = null;
        });
    }
  } catch (e) {
    _initError = e && e.message ? e.message : String(e);
  }
}

async function _ensureReady() {
  _initFirebase();
  if (_bootstrapInFlight) {
    try {
      await _bootstrapInFlight;
    } catch (e) {
      _initError = e && e.message ? e.message : String(e);
    }
  }
  return !!_firestore;
}

/**
 * Durable, cross-restart session-memory snapshot for one coin — merge-written
 * so sampleCount/windows survive an app restart instead of resetting to 0.
 */
async function writeSessionSnapshot(coin, snapshot) {
  const sym = _toUpper(coin);
  if (!sym || !snapshot || typeof snapshot !== 'object') {
    return { success: false, error: 'coin and snapshot are required' };
  }
  if (_isRateLimited(_lastSessionWrite, sym, SESSION_SNAPSHOT_RATE_MS)) {
    return { success: false, skipped: true, reason: 'rate-limited' };
  }
  const ready = await _ensureReady();
  if (!ready) return { success: false, error: _initError || 'Firestore unavailable' };

  try {
    await _firestore.collection(SESSION_COLLECTION).doc(sym).set({
      schemaVersion: 'wecrypto.grokMemory.v1',
      sym,
      ...snapshot,
      updatedAtMs: Date.now(),
      updatedAt: _serverTimestamp(),
    }, { merge: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error && error.message ? error.message : String(error) };
  }
}

async function getSessionSnapshot(coin) {
  const sym = _toUpper(coin);
  if (!sym) return { success: false, snapshot: null, error: 'coin is required' };
  const ready = await _ensureReady();
  if (!ready) return { success: false, snapshot: null, error: _initError || 'Firestore unavailable' };

  try {
    const doc = await _firestore.collection(SESSION_COLLECTION).doc(sym).get();
    if (!doc.exists) return { success: true, snapshot: null };
    return { success: true, snapshot: doc.data() };
  } catch (error) {
    return { success: false, snapshot: null, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * Records the mechanically-computed outcome of one closed 5-minute PTB
 * window. Doc ID is deterministic (sym + windowStart) so a duplicate close
 * event (e.g. app restart mid-window) overwrites idempotently instead of
 * inflating the defended/broken counts.
 */
async function recordPtbWindowClose(record) {
  const sym = _toUpper(record && record.sym);
  const windowStart = _toNum(record && record.windowStart);
  if (!sym || windowStart == null) {
    return { success: false, error: 'record.sym and record.windowStart are required' };
  }
  if (_isRateLimited(_lastPtbWrite, sym, PTB_WRITE_RATE_MS)) {
    return { success: false, skipped: true, reason: 'rate-limited' };
  }
  const ready = await _ensureReady();
  if (!ready) return { success: false, error: _initError || 'Firestore unavailable' };

  const docId = _docId(sym, windowStart);
  try {
    await _firestore.collection(PTB_COLLECTION).doc(docId).set({
      schemaVersion: 'wecrypto.ptbDefense.v1',
      sym,
      windowStart,
      windowEnd: _toNum(record.windowEnd),
      ptb: _toNum(record.ptb),
      open: _toNum(record.open),
      high: _toNum(record.high),
      low: _toNum(record.low),
      close: _toNum(record.close),
      sideOpen: record.sideOpen || null,
      sideClose: record.sideClose || null,
      outcome: record.outcome || null,
      distanceOpenBps: _toNum(record.distanceOpenBps),
      distanceCloseBps: _toNum(record.distanceCloseBps),
      crossCount: _toNum(record.crossCount, 0),
      sampleCount: _toNum(record.sampleCount, 0),
      source: record.source || 'grok-analytics-memory',
      createdAtMs: Date.now(),
      createdAt: _serverTimestamp(),
    }, { merge: true });
    return { success: true, id: docId };
  } catch (error) {
    return { success: false, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * Answers "has this PTB level been defended before" from real history:
 * pulls recent closed windows for the coin, filters to ones near the given
 * PTB (within toleranceBps), and aggregates defended/broken counts.
 *
 * Note: this where(sym==)+orderBy(windowStart) query will likely need a
 * Firestore composite index on first live run — the resulting error includes
 * a direct console link to auto-create it.
 */
async function getPtbDefenseStats(coin, ptb, opts = {}) {
  const sym = _toUpper(coin);
  const ptbNum = _toNum(ptb);
  const empty = { testedCount: 0, defendedCount: 0, brokenCount: 0, defendRate: null, sampleWindowStarts: [] };
  if (!sym || ptbNum == null || ptbNum <= 0) {
    return { success: false, stats: empty, error: 'coin and a positive ptb are required' };
  }
  const ready = await _ensureReady();
  if (!ready) return { success: false, stats: empty, error: _initError || 'Firestore unavailable' };

  const lookbackMs = _toNum(opts.lookbackMs, DEFAULT_LOOKBACK_MS);
  const toleranceBps = _toNum(opts.toleranceBps, DEFAULT_TOLERANCE_BPS);
  const limit = _toNum(opts.limit, DEFAULT_QUERY_LIMIT);
  const since = Date.now() - lookbackMs;
  const toleranceFrac = toleranceBps / 10_000;

  try {
    const snapshot = await _firestore.collection(PTB_COLLECTION)
      .where('sym', '==', sym)
      .where('windowStart', '>=', since)
      .orderBy('windowStart', 'desc')
      .limit(limit)
      .get();

    const nearLevel = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      const docPtb = _toNum(data.ptb);
      if (docPtb == null || docPtb <= 0) return;
      if (Math.abs(docPtb - ptbNum) / ptbNum > toleranceFrac) return;
      nearLevel.push(data);
    });

    const defendedCount = nearLevel.filter((r) => r.outcome === 'DEFENDED').length;
    const brokenCount = nearLevel.filter((r) => r.outcome === 'BROKEN').length;
    const testedCount = nearLevel.length;

    return {
      success: true,
      stats: {
        testedCount,
        defendedCount,
        brokenCount,
        defendRate: testedCount > 0 ? defendedCount / testedCount : null,
        sampleWindowStarts: nearLevel.slice(0, 10).map((r) => r.windowStart),
      },
    };
  } catch (error) {
    return { success: false, stats: empty, error: error && error.message ? error.message : String(error) };
  }
}

function getDiagnostics() {
  const status = _adminModule && typeof _adminModule.getStatus === 'function'
    ? _adminModule.getStatus()
    : null;
  return {
    firestoreReady: !!_firestore,
    initError: _initError,
    firestoreStatus: status,
    lastSessionWrite: Object.fromEntries(_lastSessionWrite),
    lastPtbWrite: Object.fromEntries(_lastPtbWrite),
    sessionCollection: SESSION_COLLECTION,
    ptbCollection: PTB_COLLECTION,
    sessionSnapshotRateMs: SESSION_SNAPSHOT_RATE_MS,
    ptbWriteRateMs: PTB_WRITE_RATE_MS,
  };
}

module.exports = {
  writeSessionSnapshot,
  getSessionSnapshot,
  recordPtbWindowClose,
  getPtbDefenseStats,
  getDiagnostics,
};
