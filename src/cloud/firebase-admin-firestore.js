const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let firebaseAdmin = null;
try {
  firebaseAdmin = require('firebase-admin');
} catch (_) {
  firebaseAdmin = null;
}

let firebaseApp = null;
let firestore = null;
let initError = null;
let initSource = 'uninitialized';
function resolveProjectId(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return null;
}

let projectId = resolveProjectId(
  process.env.WECRYPTO_FIREBASE_PROJECT_ID,
  process.env.WECRYPTO_GOOGLE_PROJECT_ID,
  process.env.GOOGLE_CLOUD_PROJECT
);
let clientEmailHash = null;
let firestoreDatabaseId = process.env.WECRYPTO_FIREBASE_DATABASE_ID || '(default)';
let firestorePreferRest = true;
let firestoreTarget = null;
let firestoreEmulatorHost = process.env.WECRYPTO_FIRESTORE_EMULATOR_HOST
  || process.env.FIRESTORE_EMULATOR_HOST
  || '127.0.0.1:8080';
let localFallbackReason = null;
const firestoreClients = {};

const EMULATOR_APP_NAME = 'wecrypto-firestore-emulator';
const DEFAULT_FIRESTORE_RPC_TIMEOUT_MS = 5000;

function envFlagEnabled(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function envFlagSpecified(value) {
  return value != null && String(value).trim() !== '';
}

function normalizeFirestoreMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['local', 'localhost', 'emulator', 'emu'].includes(normalized)) return 'emulator';
  if (['prod', 'production', 'cloud', 'remote'].includes(normalized)) return 'prod';
  if (['auto', 'fallback'].includes(normalized)) return 'auto';
  return 'auto';
}

function firestoreMode() {
  const explicit = process.env.WECRYPTO_FIRESTORE_MODE || process.env.WECRYPTO_FIREBASE_MODE;
  if (envFlagSpecified(explicit)) return normalizeFirestoreMode(explicit);
  if (envFlagEnabled(process.env.WECRYPTO_FIRESTORE_USE_EMULATOR || '0')) return 'emulator';
  return 'auto';
}

function firestoreLocalFallbackEnabled() {
  const value = process.env.WECRYPTO_FIRESTORE_LOCAL_FALLBACK;
  if (envFlagSpecified(value)) return envFlagEnabled(value);
  if (envFlagEnabled(process.env.WECRYPTO_FIREBASE_REQUIRED || '0')) return false;
  if (
    !envFlagEnabled(process.env.WECRYPTO_FIREBASE_ENABLED || '0')
    && !envFlagSpecified(process.env.WECRYPTO_FIRESTORE_MODE)
    && !firestoreEmulatorRequestedByEnv()
  ) {
    return false;
  }
  return firestoreMode() === 'auto';
}

function firestoreEmulatorRequestedByEnv() {
  return !!(
    envFlagSpecified(process.env.FIRESTORE_EMULATOR_HOST)
    || envFlagEnabled(process.env.WECRYPTO_FIRESTORE_USE_EMULATOR || '0')
  );
}

function getFirestoreEmulatorHost() {
  firestoreEmulatorHost = String(
    process.env.WECRYPTO_FIRESTORE_EMULATOR_HOST
    || process.env.FIRESTORE_EMULATOR_HOST
    || firestoreEmulatorHost
    || '127.0.0.1:8080'
  ).trim();
  return firestoreEmulatorHost || '127.0.0.1:8080';
}

function initialFirestoreTarget() {
  const mode = firestoreMode();
  if (mode === 'emulator') return 'emulator';
  if (mode === 'auto' && firestoreEmulatorRequestedByEnv()) return 'emulator';
  return 'prod';
}

function firestoreRestPreferred(target = 'prod') {
  const specificValue = target === 'emulator'
    ? process.env.WECRYPTO_FIRESTORE_EMULATOR_PREFER_REST
    : process.env.WECRYPTO_FIRESTORE_PREFER_REST;
  if (envFlagSpecified(specificValue)) return envFlagEnabled(specificValue);
  return target === 'emulator' ? false : true;
}

function firestoreRpcTimeoutMs() {
  const raw = Number(
    process.env.WECRYPTO_FIRESTORE_RPC_TIMEOUT_MS
    || process.env.WECRYPTO_FIRESTORE_WRITE_TIMEOUT_MS
    || DEFAULT_FIRESTORE_RPC_TIMEOUT_MS
  );
  if (!Number.isFinite(raw)) return DEFAULT_FIRESTORE_RPC_TIMEOUT_MS;
  return Math.max(1000, Math.min(60000, Math.floor(raw)));
}

function firestoreOperationTimeoutMs() {
  const raw = Number(
    process.env.WECRYPTO_FIRESTORE_OPERATION_TIMEOUT_MS
    || process.env.WECRYPTO_FIRESTORE_WRITE_TIMEOUT_MS
    || 6500
  );
  if (!Number.isFinite(raw)) return 6500;
  return Math.max(1000, Math.min(60000, Math.floor(raw)));
}

function withOperationTimeout(promise, label) {
  const timeoutMs = firestoreOperationTimeoutMs();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'WECRYPTO_FIRESTORE_OPERATION_TIMEOUT';
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

function databaseIdForTarget(target = 'prod') {
  if (target === 'emulator' && envFlagSpecified(process.env.WECRYPTO_FIRESTORE_EMULATOR_DATABASE_ID)) {
    return String(process.env.WECRYPTO_FIRESTORE_EMULATOR_DATABASE_ID).trim() || '(default)';
  }
  return String(process.env.WECRYPTO_FIREBASE_DATABASE_ID || '(default)').trim() || '(default)';
}

function emulatorProjectId() {
  return resolveProjectId(
    process.env.WECRYPTO_FIRESTORE_EMULATOR_PROJECT_ID,
    process.env.WECRYPTO_FIREBASE_PROJECT_ID,
    process.env.WECRYPTO_GOOGLE_PROJECT_ID,
    process.env.GOOGLE_CLOUD_PROJECT,
    'wecrypto-local'
  );
}

function firestoreSettings(target = 'prod') {
  const timeoutMs = firestoreRpcTimeoutMs();
  return {
    preferRest: firestoreRestPreferred(target),
    ignoreUndefinedProperties: true,
    clientConfig: {
      interfaces: {
        'google.firestore.v1.Firestore': {
          methods: {
            Write: { timeout_millis: timeoutMs, retry_codes: [] },
            Commit: { timeout_millis: timeoutMs, retry_codes: [] },
            CreateDocument: { timeout_millis: timeoutMs, retry_codes: [] },
            UpdateDocument: { timeout_millis: timeoutMs, retry_codes: [] },
            GetDocument: { timeout_millis: timeoutMs, retry_codes: [] },
            ListDocuments: { timeout_millis: timeoutMs, retry_codes: [] }
          }
        }
      }
    }
  };
}

function isTransientFirestoreError(error) {
  const msg = String(error && (error.message || error.details || error.code) || error || '').toLowerCase();
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

function hashEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function readServiceAccountFromEnv() {
  const inlineJson = process.env.WECRYPTO_FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    const parsed = safeJsonParse(inlineJson);
    if (parsed) return { credentials: parsed, source: 'WECRYPTO_FIREBASE_SERVICE_ACCOUNT_JSON' };
  }

  const inlineBase64 = process.env.WECRYPTO_FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (inlineBase64) {
    try {
      const decoded = Buffer.from(inlineBase64, 'base64').toString('utf8');
      const parsed = safeJsonParse(decoded);
      if (parsed) return { credentials: parsed, source: 'WECRYPTO_FIREBASE_SERVICE_ACCOUNT_BASE64' };
    } catch (_) { }
  }

  const credentialPath = process.env.WECRYPTO_FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialPath) {
    const resolved = path.resolve(credentialPath);
    if (fs.existsSync(resolved)) {
      const parsed = safeJsonParse(fs.readFileSync(resolved, 'utf8'));
      if (parsed) return { credentials: parsed, source: resolved };
    }
  }

  return null;
}

async function ensureInitialized(options = {}) {
  const requestedTarget = options.target
    ? (normalizeFirestoreMode(options.target) === 'emulator' ? 'emulator' : 'prod')
    : initialFirestoreTarget();
  if (firestore && !options.force && (!options.target || firestoreTarget === requestedTarget)) {
    return {
      success: true,
      available: true,
      configured: true,
      source: initSource,
      target: firestoreTarget,
      mode: firestoreMode(),
      projectId,
      clientEmailHash,
      databaseId: firestoreDatabaseId,
      emulatorHost: firestoreTarget === 'emulator' ? firestoreEmulatorHost : null,
      preferRest: firestorePreferRest,
      localFallback: firestoreTarget === 'emulator' && !!localFallbackReason,
      localFallbackReason,
    };
  }

  if (!firebaseAdmin) {
    initError = 'firebase-admin dependency is not installed';
    return { success: false, available: false, configured: false, error: initError };
  }

  const enabled = envFlagEnabled(process.env.WECRYPTO_FIREBASE_ENABLED || '0');
  const required = envFlagEnabled(process.env.WECRYPTO_FIREBASE_REQUIRED || '0');
  const mode = firestoreMode();
  const target = requestedTarget;
  const explicitEmulator = target === 'emulator' && (!!options.target || mode === 'emulator' || firestoreEmulatorRequestedByEnv());
  if (!enabled && !required && !explicitEmulator) {
    initSource = 'disabled';
    return {
      success: false,
      available: false,
      configured: false,
      disabled: true,
      error: 'Firebase disabled (set WECRYPTO_FIREBASE_ENABLED=1 to enable)',
    };
  }

  const serviceAccount = target === 'prod' ? readServiceAccountFromEnv() : null;
  const useApplicationDefault = target === 'prod'
    ? envFlagEnabled(process.env.WECRYPTO_FIREBASE_USE_APPLICATION_DEFAULT || '0')
    : false;
  if (target === 'prod' && !serviceAccount && !useApplicationDefault) {
    initError = 'No Firebase service account found';
    const result = {
      success: false,
      available: false,
      configured: false,
      error: `${initError}. Set WECRYPTO_FIREBASE_SERVICE_ACCOUNT_PATH or WECRYPTO_FIREBASE_SERVICE_ACCOUNT_JSON`,
    };
    if (firestoreLocalFallbackEnabled()) {
      return switchToLocalEmulator({ reason: result.error });
    }
    return result;
  }

  try {
    const options = {};
    if (target === 'emulator') {
      firestoreEmulatorHost = getFirestoreEmulatorHost();
      process.env.FIRESTORE_EMULATOR_HOST = firestoreEmulatorHost;
      projectId = emulatorProjectId();
      options.projectId = projectId;
      clientEmailHash = null;
      initSource = `firestore-emulator:${firestoreEmulatorHost}`;
    } else if (serviceAccount?.credentials) {
      if (mode === 'prod' && process.env.FIRESTORE_EMULATOR_HOST) {
        delete process.env.FIRESTORE_EMULATOR_HOST;
      }
      options.credential = firebaseAdmin.credential.cert(serviceAccount.credentials);
      projectId = resolveProjectId(
        process.env.WECRYPTO_FIREBASE_PROJECT_ID,
        process.env.WECRYPTO_GOOGLE_PROJECT_ID,
        process.env.GOOGLE_CLOUD_PROJECT,
        serviceAccount.credentials.project_id,
        projectId
      );
      clientEmailHash = hashEmail(serviceAccount.credentials.client_email);
      initSource = serviceAccount.source;
    } else {
      if (mode === 'prod' && process.env.FIRESTORE_EMULATOR_HOST) {
        delete process.env.FIRESTORE_EMULATOR_HOST;
      }
      options.credential = firebaseAdmin.credential.applicationDefault();
      projectId = resolveProjectId(
        process.env.WECRYPTO_FIREBASE_PROJECT_ID,
        process.env.WECRYPTO_GOOGLE_PROJECT_ID,
        process.env.GOOGLE_CLOUD_PROJECT,
        projectId
      );
      initSource = 'application-default-credentials';
    }
    if (projectId) options.projectId = projectId;

    if (target === 'emulator') {
      const existing = firebaseAdmin.apps.find((app) => app && app.name === EMULATOR_APP_NAME);
      firebaseApp = existing ? firebaseAdmin.app(EMULATOR_APP_NAME) : firebaseAdmin.initializeApp(options, EMULATOR_APP_NAME);
    } else {
      const defaultApp = firebaseAdmin.apps.find((app) => app && app.name === '[DEFAULT]');
      firebaseApp = defaultApp ? firebaseAdmin.app() : firebaseAdmin.initializeApp(options);
    }
    firestoreDatabaseId = databaseIdForTarget(target);
    firestorePreferRest = firestoreRestPreferred(target);
    const clientKey = `${target}:${firestoreDatabaseId || '(default)'}`;
    if (firestoreClients[clientKey]) {
      firestore = firestoreClients[clientKey];
    } else {
      try {
        const firestoreModule = require('firebase-admin/firestore');
        if (typeof firestoreModule.initializeFirestore === 'function') {
          const settings = firestoreSettings(target);
          if (firestoreDatabaseId && firestoreDatabaseId !== '(default)') {
            firestore = firestoreModule.initializeFirestore(firebaseApp, settings, firestoreDatabaseId);
          } else {
            firestore = firestoreModule.initializeFirestore(firebaseApp, settings);
          }
        } else if (firestoreDatabaseId && firestoreDatabaseId !== '(default)' && typeof firestoreModule.getFirestore === 'function') {
          firestore = firestoreModule.getFirestore(firebaseApp, firestoreDatabaseId);
        } else if (typeof firestoreModule.getFirestore === 'function') {
          firestore = firestoreModule.getFirestore(firebaseApp);
        } else {
          firestore = firebaseAdmin.firestore(firebaseApp);
        }
      } catch (_) {
        firestorePreferRest = false;
        firestore = firebaseAdmin.firestore(firebaseApp);
      }
      if (firestore) {
        firestoreClients[clientKey] = firestore;
      }
    }
    try {
      firestore.settings({ ignoreUndefinedProperties: true });
    } catch (_) { }
    initError = null;
    firestoreTarget = target;

    return {
      success: true,
      available: true,
      configured: true,
      source: initSource,
      target: firestoreTarget,
      mode,
      projectId,
      clientEmailHash,
      databaseId: firestoreDatabaseId,
      emulatorHost: firestoreTarget === 'emulator' ? firestoreEmulatorHost : null,
      preferRest: firestorePreferRest,
      rpcTimeoutMs: firestoreRpcTimeoutMs(),
      localFallback: firestoreTarget === 'emulator' && !!localFallbackReason,
      localFallbackReason,
    };
  } catch (error) {
    initError = error.message || String(error);
    if (target === 'prod' && firestoreLocalFallbackEnabled() && isTransientFirestoreError(error)) {
      return switchToLocalEmulator({ reason: initError });
    }
    return {
      success: false,
      available: false,
      configured: false,
      source: initSource,
      target,
      mode,
      error: initError,
    };
  }
}

async function switchToLocalEmulator(options = {}) {
  if (!firebaseAdmin) {
    initError = 'firebase-admin dependency is not installed';
    return { success: false, available: false, configured: false, error: initError };
  }
  localFallbackReason = options.reason || localFallbackReason || 'prod Firestore unavailable';
  const previousFirestore = firestore;
  const previousTarget = firestoreTarget;
  firestore = null;
  firestoreTarget = null;
  const result = await ensureInitialized({ target: 'emulator', force: true });
  if (!result.success && previousFirestore) {
    firestore = previousFirestore;
    firestoreTarget = previousTarget;
  }
  return result;
}

function getStatus() {
  const enabled = envFlagEnabled(process.env.WECRYPTO_FIREBASE_ENABLED || '0');
  const required = envFlagEnabled(process.env.WECRYPTO_FIREBASE_REQUIRED || '0');
  return {
    available: !!firestore,
    configured: !!firestore,
    initialized: !!firestore,
    source: initSource,
    mode: firestoreMode(),
    target: firestoreTarget,
    projectId: projectId || null,
    databaseId: firestoreDatabaseId || '(default)',
    preferRest: firestorePreferRest,
    rpcTimeoutMs: firestoreRpcTimeoutMs(),
    emulatorHost: firestoreTarget === 'emulator' ? firestoreEmulatorHost : getFirestoreEmulatorHost(),
    localFallbackEnabled: firestoreLocalFallbackEnabled(),
    localFallback: firestoreTarget === 'emulator' && !!localFallbackReason,
    localFallbackReason,
    clientEmailHash,
    enabled,
    required,
    error: initError,
  };
}

async function startupCheck(options = {}) {
  const required = !!options.required;
  const probe = options.probe !== false;

  const init = await ensureInitialized(options.target ? { target: options.target } : {});
  if (!init.success) {
    if (required) {
      throw new Error(init.error || 'Firebase startup check failed');
    }
    const status = getStatus();
    return {
      success: false,
      configured: false,
      required,
      probe,
      target: status.target,
      mode: status.mode,
      projectId: status.projectId,
      databaseId: status.databaseId,
      preferRest: status.preferRest,
      emulatorHost: status.emulatorHost,
      localFallback: status.localFallback,
      localFallbackReason: status.localFallbackReason,
      clientEmailHash,
      source: initSource,
      error: init.error || initError || 'Firebase unavailable',
    };
  }

  if (probe && firestore) {
    try {
      await withOperationTimeout(firestore.collection('_health').doc('startup').set(
        {
          ts: Date.now(),
          source: 'wecrypto-electron',
        },
        { merge: true }
      ), 'Firestore startup probe');
    } catch (error) {
      if (!required && firestoreTarget === 'prod' && firestoreLocalFallbackEnabled() && isTransientFirestoreError(error)) {
        const fallback = await switchToLocalEmulator({ reason: error.message || 'Firestore probe failed' });
        if (fallback.success && firestore) {
          try {
            await withOperationTimeout(firestore.collection('_health').doc('startup').set(
              {
                ts: Date.now(),
                source: 'wecrypto-electron',
                fallbackFrom: 'prod',
              },
              { merge: true }
            ), 'Firestore startup fallback probe');
            return {
              success: true,
              configured: true,
              required,
              probe,
              projectId: projectId || null,
              databaseId: firestoreDatabaseId || '(default)',
              target: firestoreTarget,
              mode: firestoreMode(),
              preferRest: firestorePreferRest,
              emulatorHost: firestoreEmulatorHost,
              localFallback: true,
              localFallbackReason,
              clientEmailHash,
              source: initSource,
            };
          } catch (fallbackError) {
            error = fallbackError;
          }
        }
      }
      if (required) throw error;
      return {
        success: false,
        configured: true,
        required,
        probe,
        projectId: projectId || null,
        databaseId: firestoreDatabaseId || '(default)',
        target: firestoreTarget,
        mode: firestoreMode(),
        preferRest: firestorePreferRest,
        emulatorHost: firestoreTarget === 'emulator' ? firestoreEmulatorHost : null,
        localFallback: firestoreTarget === 'emulator' && !!localFallbackReason,
        localFallbackReason,
        clientEmailHash,
        source: initSource,
        error: error.message || 'Firestore probe failed',
      };
    }
  }

  return {
    success: true,
    configured: true,
    required,
    probe,
    projectId: projectId || null,
    databaseId: firestoreDatabaseId || '(default)',
    target: firestoreTarget,
    mode: firestoreMode(),
    preferRest: firestorePreferRest,
    emulatorHost: firestoreTarget === 'emulator' ? firestoreEmulatorHost : null,
    localFallback: firestoreTarget === 'emulator' && !!localFallbackReason,
    localFallbackReason,
    clientEmailHash,
    source: initSource,
  };
}

function normalizeLimit(limit, fallback = 30) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(n)));
}

function normalizeRecord(record = {}) {
  const now = Date.now();
  const sourceTs = Number(record.ts || record.createdAtMs || now);
  return {
    schemaVersion: String(record.schemaVersion || 'wecrypto.inference.v1'),
    kind: String(record.kind || 'inference'),
    sym: String(record.sym || record.coin || record.symbol || 'UNKNOWN').toUpperCase(),
    ts: Number.isFinite(sourceTs) ? sourceTs : now,
    source: String(record.source || 'wecrypto'),
    provider: record.provider ? String(record.provider) : null,
    snapshot: record.snapshot && typeof record.snapshot === 'object' ? record.snapshot : null,
    diagnostics: record.diagnostics && typeof record.diagnostics === 'object' ? record.diagnostics : null,
    output: record.output && typeof record.output === 'object' ? record.output : null,
    forecast: record.forecast && typeof record.forecast === 'object' ? record.forecast : null,
    rawResponse: record.rawResponse && typeof record.rawResponse === 'object' ? record.rawResponse : null,
    createdAtMs: now,
  };
}

function collectionName() {
  return String(process.env.WECRYPTO_FIREBASE_INFERENCE_COLLECTION || 'wecrypto_inferences').trim() || 'wecrypto_inferences';
}

async function appendInferenceRecord(record = {}) {
  const init = await ensureInitialized();
  if (!init.success || !firestore) {
    return { success: false, error: init.error || 'Firestore unavailable' };
  }

  const payload = normalizeRecord(record);
  try {
    const ref = firestore.collection(collectionName()).doc();
    await withOperationTimeout(ref.set({
      ...payload,
      createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    }), 'Firestore append inference');
    return { success: true, id: ref.id, collection: collectionName() };
  } catch (error) {
    const msg = error.message || '';
    if (firestoreTarget === 'prod' && firestoreLocalFallbackEnabled() && isTransientFirestoreError(error)) {
      const fallback = await switchToLocalEmulator({ reason: msg || 'append inference write failed' });
      if (fallback.success) {
        return appendInferenceRecord(record);
      }
    }
    if (msg.includes('PERMISSION_DENIED') || msg.includes('403') || msg.includes('Quota') || msg.includes('billing')) {
      console.warn(`[Firestore] Permission/Quota error appending inference (${msg}). Yielding to graceful local fallback.`);
      return { success: false, gracefulFallback: true, error: msg };
    }
    return { success: false, error: msg || 'Failed to append inference record' };
  }
}

async function getSystemWeights() {
  const init = await ensureInitialized();
  if (!init.success || !firestore) {
    return { success: false, weights: null, error: init.error || 'Firestore unavailable' };
  }
  try {
    const doc = await firestore.collection('wecrypto_config').doc('system_weights').get();
    if (!doc.exists) return { success: true, weights: null };
    return { success: true, weights: doc.data().weights };
  } catch (error) {
    return { success: false, weights: null, error: error.message };
  }
}

async function updateSystemWeights(weights) {
  const init = await ensureInitialized();
  if (!init.success || !firestore) {
    return { success: false, error: init.error || 'Firestore unavailable' };
  }
  try {
    await withOperationTimeout(firestore.collection('wecrypto_config').doc('system_weights').set({
      weights,
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }), 'Firestore update system weights');
    return { success: true };
  } catch (error) {
    if (firestoreTarget === 'prod' && firestoreLocalFallbackEnabled() && isTransientFirestoreError(error)) {
      const fallback = await switchToLocalEmulator({ reason: error.message || 'system weights write failed' });
      if (fallback.success) {
        return updateSystemWeights(weights);
      }
    }
    return { success: false, error: error.message };
  }
}

async function getInferenceRecords(limitCount = 30) {
  const init = await ensureInitialized();
  if (!init.success || !firestore) {
    throw new Error(init.error || 'Firestore unavailable');
  }

  const cappedLimit = normalizeLimit(limitCount);
  const snapshot = await firestore
    .collection(collectionName())
    .orderBy('createdAtMs', 'desc')
    .limit(cappedLimit)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function getFirestore(options = {}) {
  if (!firestore || (options.target && firestoreTarget !== options.target)) {
    // Fire-and-forget lazy init for callers that need a sync handle.
    ensureInitialized(options).catch(() => { });
  }
  return firestore;
}

module.exports = {
  envFlagEnabled,
  firestoreLocalFallbackEnabled,
  getFirestore,
  getStatus,
  switchToLocalEmulator,
  startupCheck,
  appendInferenceRecord,
  getInferenceRecords,
  getSystemWeights,
  updateSystemWeights,
};
