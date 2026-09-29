function envFlagEnabled(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getStatus() {
  const enabled = envFlagEnabled(process.env.WECRYPTO_GOOGLE_CLOUD_ENABLED || '0');
  const pubSubEnabled = envFlagEnabled(process.env.WECRYPTO_GOOGLE_PUBSUB_ENABLED || '0');
  const firebaseEnabled = envFlagEnabled(process.env.WECRYPTO_FIREBASE_ENABLED || '0');
  const vertexTideEnabled = envFlagEnabled(
    process.env.WECRYPTO_VERTEX_TIDE_ENABLED
    || process.env.WECRYPTO_TIDE_ENABLED
    || '0'
  ) || !!process.env.WECRYPTO_TIDE_ENDPOINT;
  const cloudSqlEnabled = envFlagEnabled(process.env.WECRYPTO_CLOUDSQL_ENABLED || '0');

  return {
    enabled: enabled || pubSubEnabled || vertexTideEnabled || cloudSqlEnabled,
    pubSubEnabled,
    firebaseEnabled,
    vertexTideEnabled,
    cloudSqlEnabled,
    projectId: process.env.WECRYPTO_GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || null,
    location: process.env.WECRYPTO_GOOGLE_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || null,
    tideEndpoint: process.env.WECRYPTO_TIDE_ENDPOINT || null,
    tideModel: process.env.WECRYPTO_TIDE_MODEL || 'wecrypto.tide.shadow',
  };
}

function extractLastClose(series = []) {
  if (!Array.isArray(series) || !series.length) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const close = toFiniteNumber(series[i]?.c ?? series[i]?.close, null);
    if (close != null) return close;
  }
  return null;
}

function simpleSlope(series = []) {
  if (!Array.isArray(series) || series.length < 2) return 0;
  const closes = series
    .map((bar) => toFiniteNumber(bar?.c ?? bar?.close, null))
    .filter((value) => value != null && value > 0);
  if (closes.length < 2) return 0;
  const first = closes[0];
  const last = closes[closes.length - 1];
  return (last - first) / first;
}

function localTideForecast(payload = {}) {
  const m1 = Array.isArray(payload?.series?.m1) ? payload.series.m1 : [];
  const m5 = Array.isArray(payload?.series?.m5) ? payload.series.m5 : [];
  const m15 = Array.isArray(payload?.series?.m15) ? payload.series.m15 : [];

  const slope1 = simpleSlope(m1);
  const slope5 = simpleSlope(m5);
  const slope15 = simpleSlope(m15);
  const weightedSlope = (slope1 * 0.25) + (slope5 * 0.35) + (slope15 * 0.40);

  const fallbackCurrent = extractLastClose(m1) || extractLastClose(m5) || extractLastClose(m15);
  const currentPrice = toFiniteNumber(payload.currentPrice, fallbackCurrent || 0);
  const projectedMove = clamp(weightedSlope * 0.45, -0.04, 0.04);
  const forecastPrice = currentPrice > 0
    ? Number((currentPrice * (1 + projectedMove)).toFixed(6))
    : null;
  const confidenceBase = 0.52 + Math.min(Math.abs(weightedSlope) * 6, 0.26);
  const confidence = Number(clamp(confidenceBase, 0.5, 0.78).toFixed(4));
  const direction = projectedMove > 0.001 ? 'UP' : projectedMove < -0.001 ? 'DOWN' : 'WAIT';

  const spread = Math.max(0.001, Math.abs(projectedMove) * 0.75 + 0.0025);
  const quantiles = forecastPrice == null
    ? null
    : {
      p10: Number((forecastPrice * (1 - spread)).toFixed(6)),
      p50: forecastPrice,
      p90: Number((forecastPrice * (1 + spread)).toFixed(6)),
    };

  return {
    direction,
    confidence,
    forecastPrice,
    quantiles,
  };
}

async function callRemoteTideEndpoint(payload = {}) {
  const endpoint = process.env.WECRYPTO_TIDE_ENDPOINT;
  if (!endpoint) return null;

  const headers = {
    'content-type': 'application/json',
    'x-wecrypto-source': 'electron-main',
  };
  if (process.env.WECRYPTO_TIDE_BEARER_TOKEN) {
    headers.authorization = `Bearer ${process.env.WECRYPTO_TIDE_BEARER_TOKEN}`;
  }
  if (process.env.WECRYPTO_TIDE_API_KEY) {
    headers['x-api-key'] = process.env.WECRYPTO_TIDE_API_KEY;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TiDE endpoint HTTP ${response.status}: ${body.slice(0, 220)}`);
  }

  return await response.json();
}

async function predictTide(payload = {}) {
  const status = getStatus();
  if (!status.vertexTideEnabled) {
    return { success: false, error: 'Google TiDE bridge disabled (set WECRYPTO_VERTEX_TIDE_ENABLED=1)' };
  }

  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'Invalid TiDE payload' };
  }

  try {
    const remote = await callRemoteTideEndpoint(payload);
    if (remote && typeof remote === 'object') {
      return {
        success: remote.success !== false,
        queued: !!remote.queued,
        mode: remote.mode || 'remote-endpoint',
        forecast: remote.forecast || remote.output || localTideForecast(payload),
        diagnostics: remote.diagnostics || null,
      };
    }
  } catch (error) {
    const msg = error.message || '';
    if (msg.includes('401') || msg.includes('403') || msg.includes('Quota') || msg.includes('Forbidden')) {
      console.warn(`[TiDE] Remote endpoint unavailable (${msg}). Gracefully falling back to local-shadow heuristic.`);
      // Fall through to local-shadow fallback
    } else {
      return {
        success: false,
        queued: false,
        mode: 'remote-endpoint',
        error: msg || 'TiDE endpoint request failed',
      };
    }
  }

  return {
    success: true,
    queued: false,
    mode: 'local-shadow',
    forecast: localTideForecast(payload),
    diagnostics: { source: 'local-shadow-heuristic' },
  };
}

async function ensureCloudSqlDatabase() {
  const cloudSqlEnabled = envFlagEnabled(process.env.WECRYPTO_CLOUDSQL_ENABLED || '0');
  if (!cloudSqlEnabled) {
    return {
      success: true,
      configured: false,
      message: 'Skipped (WECRYPTO_CLOUDSQL_ENABLED=0)',
    };
  }

  return {
    success: true,
    configured: true,
    projectId: process.env.WECRYPTO_GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || null,
    instance: process.env.WECRYPTO_CLOUDSQL_INSTANCE || null,
    database: process.env.WECRYPTO_CLOUDSQL_DATABASE || null,
    message: 'Cloud SQL enabled (runtime probe only in desktop mode)',
  };
}

async function probeCloudSql() {
  const cloudSqlEnabled = envFlagEnabled(process.env.WECRYPTO_CLOUDSQL_ENABLED || '0');
  if (!cloudSqlEnabled) {
    return {
      success: true,
      configured: false,
      cached: false,
      instanceState: null,
      databaseExists: null,
      message: 'Skipped (WECRYPTO_CLOUDSQL_ENABLED=0)',
    };
  }

  const instance = process.env.WECRYPTO_CLOUDSQL_INSTANCE || null;
  const database = process.env.WECRYPTO_CLOUDSQL_DATABASE || null;
  return {
    success: true,
    configured: !!(instance && database),
    cached: false,
    instanceState: instance ? 'CONFIGURED' : 'MISSING_INSTANCE',
    databaseExists: !!database,
    projectId: process.env.WECRYPTO_GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || null,
    instance,
    database,
    message: instance && database
      ? 'Cloud SQL identifiers configured (desktop mode uses external connectivity)'
      : 'Cloud SQL enabled but missing WECRYPTO_CLOUDSQL_INSTANCE or WECRYPTO_CLOUDSQL_DATABASE',
  };
}

module.exports = {
  envFlagEnabled,
  getStatus,
  ensureCloudSqlDatabase,
  probeCloudSql,
  predictTide,
};
