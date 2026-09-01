/**
 * ASI:One API client — OpenAI-compatible chat + agentic Agentverse routing.
 *
 * Official models (docs.asi1.ai/documentation/models) share one key + request
 * shape per account: asi1 (default), asi1-ultra (deep), asi1-mini (fast).
 * We also try undocumented `asi1-fast` last because this repo used it.
 *
 * Three Fetch.ai / ASI:One accounts (icloud first — fresh daily quota as of
 * 2026-08-22; gitgoin/mauro both maxed their day request quota that date
 * and neither has ever had asi1-ultra token allowance, limit=0 "eon"):
 *   mauro_fanelli@icloud.com  → ASI1_API_KEY_ICLOUD / secrets/ASI1_ICLOUD.txt
 *   gitgoin87@gmail.com       → ASI1_API_KEY_GITGOIN / secrets/ASI1_GITGOIN.txt
 *   maurofanellijr@gmail.com  → ASI1_API_KEY_MAURO / secrets/ASI1_MAURO.txt
 * Plus legacy aliases (ASI_ONE_API_KEY, ASI1_API_KEY_FALLBACK, ASI1_API.txt).
 * Label lines / `# account=` / `# skip` in those files tag or drop keys.
 *
 * Auth: Authorization: Bearer $ASI_ONE_API_KEY
 * Planner / Agentverse (playground): planner_mode + required x-session-id.
 *   opt in per call (options.plannerMode) or ASI1_PLANNER_MODE=1.
 *   Do not enable on 5m ticks — a planner run can take minutes.
 */

const ASI1_BASE_URL = (
  process.env.ASI1_BASE_URL || 'https://api.asi1.ai/v1'
).replace(/\/$/, '');

const ASI1_CHAT_URL = `${ASI1_BASE_URL}/chat/completions`;
// Default model selection set to asi1-mini for fast response & low quota usage
const ASI1_QUICK_TICK_MODEL = process.env.ASI1_QUICK_TICK_MODEL || 'asi1-mini';
const ASI1_DEEP_INSIGHT_MODEL = process.env.ASI1_DEEP_INSIGHT_MODEL || process.env.ASI1_MODEL || 'asi1-mini';
const ASI1_DEFAULT_MODEL = process.env.ASI1_MODEL || 'asi1-mini';
const ASI1_HEALTH_TIMEOUT_MS = Number(process.env.ASI1_HEALTH_TIMEOUT_MS || 12000);
const ASI1_REQUEST_TIMEOUT_MS = Number(process.env.ASI1_REQUEST_TIMEOUT_MS || 30000);

const ASI1_OFFICIAL_MODELS = Object.freeze(['asi1-ultra', 'asi1', 'asi1-mini']);
const ASI1_EXTRA_MODELS = Object.freeze(['asi1-fast']);
const ASI1_ALL_MODELS = Object.freeze([...ASI1_OFFICIAL_MODELS, ...ASI1_EXTRA_MODELS]);

// mauro (Pro Unlimited primary) first — routes here whenever its key is present
// and not rate-limited; icloud / gitgoin are secondary fallbacks.
const ASI1_ACCOUNTS = Object.freeze([
  {
    id: 'mauro',
    email: 'maurofanellijr@gmail.com',
    envNames: ['ASI1_API_KEY_MAURO', 'ASI_ONE_API_KEY_MAURO', 'ASI1_API_KEY', 'ASI_ONE_API_KEY'],
    sessionEnv: 'ASI1_SESSION_MAURO',
    secretFiles: [
      'ASI1_MAUROFANELLIJR_ACCT.txt',
      'ASI1 MAUROFANELLIJR ACCT.txt',
      'ASI1_MAURO.txt',
      'ASI1_maurofanellijr.txt',
      'ASI1_API.txt',
    ],
  },
  {
    id: 'icloud',
    email: 'mauro_fanelli@icloud.com',
    envNames: ['ASI1_API_KEY_ICLOUD', 'ASI_ONE_API_KEY_ICLOUD'],
    sessionEnv: 'ASI1_SESSION_ICLOUD',
    secretFiles: ['ASI1_ICLOUD.txt'],
  },
  {
    id: 'gitgoin',
    email: 'gitgoin87@gmail.com',
    envNames: ['ASI1_API_KEY_GITGOIN', 'ASI_ONE_API_KEY_GITGOIN', 'ASI1_API_KEY_GITGOIN87'],
    sessionEnv: 'ASI1_SESSION_GITGOIN',
    secretFiles: ['ASI1_GITGOIN.txt', 'ASI1_gitgoin87.txt'],
  },
]);

function inferAccountFromLabel(token) {
  const s = String(token || '').toLowerCase();
  // Check icloud before the generic 'mauro' match below -- the icloud
  // account's own address ('mauro_fanelli@icloud.com') contains 'mauro'
  // and would otherwise get misfiled under the gmail/mauro account.
  if (s.includes('icloud')) return { account: 'icloud', email: 'mauro_fanelli@icloud.com' };
  if (s.includes('gitgoin')) return { account: 'gitgoin', email: 'gitgoin87@gmail.com' };
  if (s.includes('mauro')) return { account: 'mauro', email: 'maurofanellijr@gmail.com' };
  return null;
}

function extractAsi1KeyValue(line) {
  const trimmed = String(line || '').trim();
  if (trimmed.startsWith('sk_')) return trimmed;
  const kv = trimmed.match(/=\s*(sk_[0-9a-f]+)\s*$/i);
  return kv ? kv[1] : '';
}

function resolveModelForTier(tier, requestedModel) {
  if (requestedModel) return requestedModel;
  if (tier === 'quick-tick' || tier === 'quick' || tier === 'mini' || tier === 'fast') return ASI1_QUICK_TICK_MODEL;
  if (tier === 'deep-insight' || tier === 'deep' || tier === 'macro' || tier === 'ultra') {
    return process.env.ASI1_DEEP_INSIGHT_MODEL || process.env.ASI1_PRECONTRACT_MODEL || 'asi1-ultra';
  }
  return ASI1_DEFAULT_MODEL;
}

function defaultCandidateModels(requestedModel, tier) {
  const preferred = resolveModelForTier(tier, requestedModel);
  const rest = ASI1_ALL_MODELS.filter((m) => m !== preferred);
  return [preferred, ...rest];
}

const KEY_ENV_NAMES = [
  ...ASI1_ACCOUNTS.flatMap((a) => a.envNames.map((env) => ({ env, account: a.id, email: a.email }))),
  { env: 'ASI_ONE_API_KEY', account: 'primary', email: null },
  { env: 'ASI1_API_KEY', account: 'primary', email: null },
  { env: 'asi1_api_key2_fallback', account: 'fallback', email: null },
  { env: 'ASI1_API_KEY2_FALLBACK', account: 'fallback', email: null },
  { env: 'ASI1_API_KEY_FALLBACK', account: 'fallback', email: null },
  { env: 'asi1_api_key_fallback', account: 'fallback', email: null },
];

const fs = require('fs');
const pathMod = require('path');
const http = require('http');
const https = require('https');

function secretSearchDirs() {
  return [
    pathMod.resolve(process.cwd(), 'secrets'),
    pathMod.resolve(__dirname, '../../secrets'),
    pathMod.resolve(__dirname, '../secrets'),
    'G:\\WECRYP\\secrets',
    'G:\\WECRYPTO\\secrets',
  ];
}

function collectKeysFromFile(fullPath, meta) {
  const found = [];
  try {
    if (!fs.existsSync(fullPath)) return found;
    const content = fs.readFileSync(fullPath, 'utf8');
    let account = meta.account;
    let email = meta.email;
    let skipNext = false;
    for (const raw of content.split(/\r?\n/)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const tag = trimmed.match(/^#\s*account\s*[:=]\s*(\S+)/i);
      if (tag) {
        const inferred = inferAccountFromLabel(tag[1]);
        if (inferred) {
          account = inferred.account;
          email = inferred.email;
        } else {
          email = tag[1];
        }
        skipNext = false;
        continue;
      }
      if (/^#\s*(skip|dead|revoked|invalid)\b/i.test(trimmed)) {
        skipNext = true;
        continue;
      }
      const labeled = inferAccountFromLabel(trimmed);
      if (labeled && !extractAsi1KeyValue(trimmed)) {
        account = labeled.account;
        email = labeled.email;
        skipNext = false;
        continue;
      }
      const value = extractAsi1KeyValue(trimmed);
      if (!value) continue;
      if (skipNext) {
        skipNext = false;
        continue;
      }
      found.push({
        env: meta.env || `file:${pathMod.basename(fullPath)}`,
        value,
        account,
        email,
      });
    }
  } catch (_) { /* */ }
  return found;
}

function readAsi1KeysFromSecrets() {
  const foundKeys = [];
  const seen = new Set();
  const fileSpecs = [
    ...ASI1_ACCOUNTS.flatMap((a) => a.secretFiles.map((file) => ({
      file, account: a.id, email: a.email,
    }))),
    { file: 'ASI1_API.txt', account: 'shared', email: null },
    { file: 'ASI_ONE_API_KEY.txt', account: 'shared', email: null },
    { file: 'ASI1_API_KEY.txt', account: 'shared', email: null },
  ];

  for (const dir of secretSearchDirs()) {
    for (const spec of fileSpecs) {
      const rows = collectKeysFromFile(pathMod.join(dir, spec.file), spec);
      for (const row of rows) {
        if (seen.has(row.value)) continue;
        seen.add(row.value);
        foundKeys.push(row);
      }
    }
  }
  return foundKeys;
}

function resolveAsi1ApiKeys() {
  const keys = [];
  const seen = new Set();
  for (const spec of KEY_ENV_NAMES) {
    const value = String(process.env[spec.env] || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    keys.push({
      env: spec.env,
      value,
      account: spec.account === 'primary' ? 'mauro' : spec.account,
      email: spec.email || (spec.account === 'mauro' ? 'maurofanellijr@gmail.com' : null),
    });
  }
  for (const k of readAsi1KeysFromSecrets()) {
    if (seen.has(k.value)) continue;
    seen.add(k.value);
    keys.push(k);
  }

  const primaryKeyVal = 'sk_6e0fd5443f0142cdabb698464e0d1760259cf526025140a4a04d36f5b1e3f1fd';
  const fallbackKeyVal = 'sk_3b69c96c28364341b1aadff583e38739329767058b0f44f8a17e7b61eaf2e0f9';
  const preferredAccount = process.env.ASI1_ONLY_ACCOUNT || process.env.ASI1_PREFERRED_ACCOUNT || process.env.ASI1_PRIMARY_ACCOUNT || 'mauro';
  keys.sort((a, b) => {
    if (a.value === primaryKeyVal) return -1;
    if (b.value === primaryKeyVal) return 1;
    if (a.value === fallbackKeyVal) return -1;
    if (b.value === fallbackKeyVal) return 1;

    const aIsPref = a.account === preferredAccount || a.email === 'maurofanellijr@gmail.com';
    const bIsPref = b.account === preferredAccount || b.email === 'maurofanellijr@gmail.com';
    if (aIsPref && !bIsPref) return -1;
    if (!aIsPref && bIsPref) return 1;
    return 0;
  });

  return keys;
}

function resolveAsi1ApiKey() {
  return resolveAsi1ApiKeys()[0]?.value || '';
}

function hasAsi1Credentials() {
  return resolveAsi1ApiKeys().length > 0;
}

function isRetryableAsi1Error(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = Number(err?.status || err?.statusCode || 0);
  return status === 401 || status === 403 || status === 429 || status === 402
    || status === 500 || status === 502 || status === 503 || status === 504
    || msg.includes('rate limit') || msg.includes('unauthorized') || msg.includes('invalid api key')
    || msg.includes('upstream_error') || msg.includes('aborted') || msg.includes('timeout')
    || msg.includes('econnreset') || msg.includes('fetch failed');
}

function fetchWithTimeout(url, options = {}, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const body = options.body;
    const headers = { ...(options.headers || {}) };
    if (body && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = transport.request(url, {
      method: options.method || 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          text: async () => rawBody,
          json: async () => JSON.parse(rawBody),
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      reject(err);
    });

    if (body) req.write(body);
    req.end();
  });
}

// ── Route mode: measured, not assumed ──────────────────────────────────
// ASI1 traffic is *designed* to bypass the Sweden SOCKS5 lane via a direct
// Ethernet punch route (see cloudflared/Set-WeCryptoLanes.ps1), but that
// punch route can silently fail (Tailscale exit-node WFP blocking, route not
// installed) and traffic falls back through the slow Tailscale tunnel with
// no error — just higher latency. This must be measured from a raw TCP
// connect, NOT full chat-completion time — a completion includes seconds of
// actual model inference on ASI1's servers, which would swamp any network
// latency signal and make every request look "slow" regardless of route.
const net = require('net');
const NATIVE_ROUTE_LATENCY_THRESHOLD_MS = Number(process.env.ASI1_NATIVE_LATENCY_THRESHOLD_MS || 250);
const ROUTE_STALE_MS = 5 * 60_000;
const ROUTE_PROBE_INTERVAL_MS = Number(process.env.ASI1_ROUTE_PROBE_INTERVAL_MS || 30_000);
const ROUTE_PROBE_TIMEOUT_MS = Number(process.env.ASI1_ROUTE_PROBE_TIMEOUT_MS || 12_000);
const routeState = {
  lastLatencyMs: null,
  lastMeasuredAt: null,
  lastRequestOk: null,
  lastError: null,
};

function recordAsi1RouteTiming({ elapsedMs = null, ok = false, error = null } = {}) {
  if (elapsedMs != null) routeState.lastLatencyMs = elapsedMs;
  routeState.lastMeasuredAt = Date.now();
  routeState.lastRequestOk = ok;
  routeState.lastError = error;
}

function classifyAsi1RouteMode() {
  if (routeState.lastLatencyMs == null) return 'unknown';
  const ageMs = routeState.lastMeasuredAt ? Date.now() - routeState.lastMeasuredAt : Infinity;
  if (ageMs > ROUTE_STALE_MS) return 'unknown';
  // A timed-out/errored probe still has an elapsedMs (~= ROUTE_PROBE_TIMEOUT_MS),
  // which would otherwise get misclassified as "fallback" (slow-but-connected)
  // instead of surfacing that the probe couldn't connect at all.
  if (routeState.lastRequestOk === false) return 'unreachable';
  return routeState.lastLatencyMs <= NATIVE_ROUTE_LATENCY_THRESHOLD_MS ? 'native' : 'fallback';
}

// Probe the actual ASI1 TLS endpoint, not the local proxy's listening port.
// A loopback connect only proves that some process accepted a socket and will
// therefore report single-digit latency even when the ASI1 route is slow or
// unreachable. Node's raw socket bypasses renderer fetch wrappers and measures
// the route selected by the OS routing table (including any direct /32 punch).
function probeAsi1RouteOnce() {
  const endpoint = new URL(ASI1_BASE_URL);
  const host = endpoint.hostname;
  const port = Number(endpoint.port) || (endpoint.protocol === 'http:' ? 80 : 443);
  const startedAt = Date.now();
  const socket = net.connect({ host, port, timeout: ROUTE_PROBE_TIMEOUT_MS });
  const finish = (ok, error) => {
    socket.removeAllListeners();
    socket.destroy();
    recordAsi1RouteTiming({ elapsedMs: Date.now() - startedAt, ok, error: error || null });
  };
  socket.once('connect', () => finish(true, null));
  socket.once('timeout', () => finish(false, 'connect timeout'));
  socket.once('error', (err) => finish(false, err.message));
}

// Runs only in a long-lived process (Electron main); harmless no-op timer
// elsewhere. Disable with ASI1_DISABLE_ROUTE_PROBE=1 (e.g. in short-lived
// CLI/test invocations of this module).
if (process.env.ASI1_DISABLE_ROUTE_PROBE !== '1') {
  probeAsi1RouteOnce();
  const probeTimer = setInterval(probeAsi1RouteOnce, ROUTE_PROBE_INTERVAL_MS);
  if (typeof probeTimer.unref === 'function') probeTimer.unref();
}

/**
 * Minimal chat/completion against ASI:One (OpenAI-compatible).
 */
async function chatCompletion(messagesOrOptions, maybeOptions = {}) {
  let messages = messagesOrOptions;
  let options = maybeOptions;

  if (messagesOrOptions && !Array.isArray(messagesOrOptions) && typeof messagesOrOptions === 'object') {
    if (Array.isArray(messagesOrOptions.messages)) {
      messages = messagesOrOptions.messages;
      options = { ...messagesOrOptions, ...maybeOptions };
    } else if (typeof messagesOrOptions.prompt === 'string') {
      messages = [{ role: 'user', content: messagesOrOptions.prompt }];
      options = { ...messagesOrOptions, ...maybeOptions };
    }
  }
  if (!Array.isArray(messages)) {
    messages = typeof messages === 'string' ? [{ role: 'user', content: messages }] : [];
  }

  const allKeys = resolveAsi1ApiKeys();
  // onlyAccount pins a caller (e.g. the HUD's quick-narrative lane) to a
  // single account with no cross-account fallback -- that cascade through
  // every key is what makes a lone-wolf HUD poll take minutes instead of
  // failing fast on its own path. Falls back to the full key list if the
  // pinned account has no key configured, so a HUD call never hard-fails
  // just because e.g. icloud creds are momentarily missing.
  const keys = options.onlyAccount
    ? (allKeys.filter((k) => k.account === options.onlyAccount).length
      ? allKeys.filter((k) => k.account === options.onlyAccount)
      : allKeys)
    : allKeys;
  if (!keys.length) {
    throw new Error('ASI:One API key missing — set ASI_ONE_API_KEY or asi1_api_key2_fallback');
  }

  const requestedModel = resolveModelForTier(options.tier, options.model) || 'asi1-mini';
  const candidateModels = Array.from(new Set(
    Array.isArray(options.candidateModels) && options.candidateModels.length
      ? options.candidateModels
      : defaultCandidateModels(requestedModel, options.tier)
  ));

  let lastErr = null;
  for (const targetModel of candidateModels) {
    const payload = {
      model: targetModel,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.max_tokens ?? 1500,
      stream: options.stream ?? false,
      ...(options.reasoning_effort ? { reasoning_effort: options.reasoning_effort } : {}),
      ...(options.reasoning_level ? { reasoning_effort: options.reasoning_level } : {}),
      ...(options.enable_thinking != null ? { enable_thinking: options.enable_thinking } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.response_format ? { response_format: options.response_format } : {}),
      ...(options.web_search != null ? { web_search: options.web_search } : {}),
      ...(options.uvix != null ? { uvix: options.uvix } : {}),
    };

    const rateLimitedAccounts = new Set();
    for (const key of keys) {
      const { env, value, account, email } = key;
      if (account && rateLimitedAccounts.has(`${account}::${targetModel}`)) continue;
      try {
        const headers = {
          'Content-Type': 'application/json',
          ...(options.extraHeaders || {}),
        };
        const accountSession = account === 'mauro'
          ? process.env.ASI1_SESSION_MAURO
          : account === 'gitgoin'
            ? process.env.ASI1_SESSION_GITGOIN
            : '';
        const plannerOn = options.plannerMode === true
          || options.planner_mode === true
          || process.env.ASI1_PLANNER_MODE === '1';
        if (plannerOn) payload.planner_mode = true;
        if (Array.isArray(options.agents) && options.agents.length) {
          payload.agents = options.agents.slice();
        }
        // Planner requires x-session-id for the whole run (docs.asi1.ai planner).
        const sessionId = options.sessionId || accountSession
          || (plannerOn ? `wecrypto-${account || 'shared'}-${Date.now().toString(36)}` : '');
        if (sessionId) headers['x-session-id'] = String(sessionId);
        const response = await fetchWithTimeout(
          ASI1_CHAT_URL,
          {
            method: 'POST',
            headers: { ...headers, Authorization: `Bearer ${value}` },
            body: JSON.stringify(payload),
          },
          options.timeoutMs || ASI1_REQUEST_TIMEOUT_MS,
        );

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          const err = new Error(`ASI:One HTTP ${response.status}: ${body.slice(0, 240) || response.statusText}`);
          err.status = response.status;
          err.keyEnv = env;
          err.account = account;
          err.email = email;
          lastErr = err;
          // Same-account keys share the ultra 429 — skip the rest of this account
          // for this model instead of burning four mauro keys on the same limit.
          if (response.status === 429 && account) {
            rateLimitedAccounts.add(`${account}::${targetModel}`);
          }
          // Retry next key/model on 5xx, 429, auth
          if (isRetryableAsi1Error(err)) {
            continue;
          }
          // Non-retryable for this key; still try next model
          break;
        }

        if (payload.stream && response.body) {
          const streamed = await readSseContent(response);
          return {
            content: streamed.content,
            model: payload.model,
            keyEnv: env,
            account,
            email,
            sessionId: sessionId || null,
            plannerMode: !!payload.planner_mode,
            plan: streamed.plan,
            raw: null,
          };
        }

        const data = await response.json();
        const msg = data?.choices?.[0]?.message || {};
        let content = msg.content ?? data?.choices?.[0]?.text ?? '';
        if (Array.isArray(content)) {
          content = content.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('');
        }
        if (!content && msg.reasoning_content) content = msg.reasoning_content;
        content = String(content || '').trim();
        if (!content) {
          lastErr = new Error(`ASI:One empty content model=${targetModel}`);
          continue;
        }
        return {
          content,
          model: data?.model || payload.model,
          keyEnv: env,
          account,
          email,
          sessionId: sessionId || null,
          plannerMode: !!payload.planner_mode,
          raw: data,
          usage: data?.usage || null,
          executable_data: data?.executable_data || null,
          intermediate_steps: data?.intermediate_steps || null,
          thought: data?.thought || msg.reasoning_content || null,
        };
      } catch (err) {
        if (err?.name === 'AbortError' || /aborted|timeout/i.test(String(err?.message || ''))) {
          lastErr = new Error(`ASI:One aborted/timeout model=${targetModel}`);
          lastErr.status = 408;
        } else {
          lastErr = err;
        }
        // Continue to next key, then next model
        continue;
      }
    }
  }
  throw lastErr || new Error('ASI1 chat completion failed across all keys and models');
}

async function readSseContent(response) {
  const decoder = new TextDecoder('utf-8');
  let content = '';
  let plan = null;
  for await (const chunk of response.body) {
    const text = decoder.decode(chunk, { stream: true });
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') continue;
      try {
        const data = JSON.parse(dataStr);
        if (data.metadata) {
          plan = plan && typeof plan === 'object' ? { ...plan, ...data.metadata } : data.metadata;
        }
        if (data.choices?.[0]?.delta?.content) {
          content += data.choices[0].delta.content;
        }
      } catch (_) { /* partial SSE chunk */ }
    }
  }
  return { content: content.trim(), plan };
}

/**
 * Lightweight health probe — defaults to asi1-ultra model.
 */
async function healthCheck(options = {}) {
  const keys = resolveAsi1ApiKeys();
  if (!keys.length) {
    return {
      ok: false,
      reason: 'no_keys',
      keysConfigured: 0,
      baseUrl: ASI1_BASE_URL,
    };
  }

  try {
    const result = await chatCompletion(
      [{ role: 'user', content: 'Reply with OK only.' }],
      {
        model: options.model || process.env.ASI1_HEALTH_MODEL || 'asi1-ultra',
        max_tokens: 8,
        temperature: 0,
        stream: false,
        timeoutMs: options.timeoutMs || ASI1_HEALTH_TIMEOUT_MS,
      },
    );
    return {
      ok: !!result.content,
      reason: result.content ? 'ok' : 'empty_response',
      keysConfigured: keys.length,
      activeKeyEnv: result.keyEnv,
      model: result.model,
      baseUrl: ASI1_BASE_URL,
      sample: result.content.slice(0, 32),
    };
  } catch (err) {
    return {
      ok: false,
      reason: err.message || 'health_failed',
      keysConfigured: keys.length,
      baseUrl: ASI1_BASE_URL,
    };
  }
}

function getDiagnostics() {
  const keys = resolveAsi1ApiKeys();
  const accounts = {};
  for (const k of keys) {
    const id = k.account || 'shared';
    if (!accounts[id]) accounts[id] = { email: k.email || null, keys: 0, env: [] };
    accounts[id].keys += 1;
    accounts[id].env.push(k.env);
  }
  return {
    configured: keys.length > 0,
    keysConfigured: keys.length,
    keyEnvNames: keys.map((k) => k.env),
    accounts,
    officialModels: ASI1_OFFICIAL_MODELS.slice(),
    extraModels: ASI1_EXTRA_MODELS.slice(),
    allModels: ASI1_ALL_MODELS.slice(),
    baseUrl: ASI1_BASE_URL,
    defaultModel: ASI1_DEFAULT_MODEL,
    plannerMode: process.env.ASI1_PLANNER_MODE === '1',
    agenticNote: 'planner_mode + x-session-id routes through Agentverse; official models are asi1 / asi1-ultra / asi1-mini',
    routeMode: classifyAsi1RouteMode(),
    lastLatencyMs: routeState.lastLatencyMs,
    lastMeasuredAt: routeState.lastMeasuredAt,
  };
}

module.exports = {
  ASI1_BASE_URL,
  ASI1_CHAT_URL,
  ASI1_DEFAULT_MODEL,
  ASI1_QUICK_TICK_MODEL,
  ASI1_DEEP_INSIGHT_MODEL,
  ASI1_OFFICIAL_MODELS,
  ASI1_EXTRA_MODELS,
  ASI1_ALL_MODELS,
  ASI1_ACCOUNTS,
  inferAccountFromLabel,
  extractAsi1KeyValue,
  resolveModelForTier,
  defaultCandidateModels,
  resolveAsi1ApiKey,
  resolveAsi1ApiKeys,
  hasAsi1Credentials,
  chatCompletion,
  healthCheck,
  getDiagnostics,
};
