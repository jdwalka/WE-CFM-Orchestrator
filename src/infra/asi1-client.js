/**
 * ASI:One API client — OpenAI-compatible chat + agentic Agentverse routing.
 *
 * Official models (docs.asi1.ai/documentation/models) share one key + request
 * shape per account: asi1 (default), asi1-ultra (deep), asi1-mini (fast).
 * We also try undocumented `asi1-fast` last because this repo used it.
 *
 * Two Fetch.ai / ASI:One accounts:
 *   maurofanellijr@gmail.com  → ASI1_API_KEY_MAURO / secrets/ASI1_MAURO.txt
 *   gitgoin87@gmail.com       → ASI1_API_KEY_GITGOIN / secrets/ASI1_GITGOIN.txt
 * Plus legacy aliases (ASI_ONE_API_KEY, ASI1_API_KEY_FALLBACK, ASI1_API.txt).
 *
 * Auth: Authorization: Bearer $ASI_ONE_API_KEY
 * Agentic: model "asi1" + optional x-session-id (ASI1_SESSION_<ACCOUNT>).
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
const ASI1_REQUEST_TIMEOUT_MS = Number(process.env.ASI1_REQUEST_TIMEOUT_MS || 90000);

const ASI1_OFFICIAL_MODELS = Object.freeze(['asi1-ultra', 'asi1', 'asi1-mini']);
const ASI1_EXTRA_MODELS = Object.freeze(['asi1-fast']);
const ASI1_ALL_MODELS = Object.freeze([...ASI1_OFFICIAL_MODELS, ...ASI1_EXTRA_MODELS]);

const ASI1_ACCOUNTS = Object.freeze([
  {
    id: 'mauro',
    email: 'maurofanellijr@gmail.com',
    envNames: ['ASI1_API_KEY_MAURO', 'ASI_ONE_API_KEY_MAURO'],
    sessionEnv: 'ASI1_SESSION_MAURO',
    secretFiles: ['ASI1_MAURO.txt', 'ASI1_maurofanellijr.txt'],
  },
  {
    id: 'gitgoin',
    email: 'gitgoin87@gmail.com',
    envNames: ['ASI1_API_KEY_GITGOIN', 'ASI_ONE_API_KEY_GITGOIN', 'ASI1_API_KEY_GITGOIN87'],
    sessionEnv: 'ASI1_SESSION_GITGOIN',
    secretFiles: ['ASI1_GITGOIN.txt', 'ASI1_gitgoin87.txt'],
  },
]);

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
    for (const raw of content.split(/\r?\n/)) {
      const trimmed = raw.trim();
      const tag = trimmed.match(/^#\s*account\s*[:=]\s*(\S+)/i);
      if (tag) {
        email = tag[1];
        account = email.includes('mauro') ? 'mauro' : email.includes('gitgoin') ? 'gitgoin' : account;
        continue;
      }
      if (!trimmed.startsWith('sk_')) continue;
      found.push({
        env: meta.env || `file:${pathMod.basename(fullPath)}`,
        value: trimmed,
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
      account: spec.account,
      email: spec.email,
    });
  }
  for (const k of readAsi1KeysFromSecrets()) {
    if (seen.has(k.value)) continue;
    seen.add(k.value);
    keys.push(k);
  }
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal chat/completion against ASI:One (OpenAI-compatible).
 */
async function chatCompletion(messages, options = {}) {
  const keys = resolveAsi1ApiKeys();
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
      ...(options.response_format ? { response_format: options.response_format } : {}),
      ...(options.web_search != null ? { web_search: options.web_search } : {}),
    };

    for (const key of keys) {
      const { env, value, account, email } = key;
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
        const sessionId = options.sessionId || accountSession;
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
          // Retry next key/model on 5xx, 429, auth
          if (isRetryableAsi1Error(err)) {
            continue;
          }
          // Non-retryable for this key; still try next model
          break;
        }

        if (payload.stream && response.body) {
          const text = await readSseContent(response);
          return {
            content: text,
            model: payload.model,
            keyEnv: env,
            account,
            email,
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
  for await (const chunk of response.body) {
    const text = decoder.decode(chunk, { stream: true });
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') continue;
      try {
        const data = JSON.parse(dataStr);
        if (data.choices?.[0]?.delta?.content) {
          content += data.choices[0].delta.content;
        }
      } catch (_) { /* partial SSE chunk */ }
    }
  }
  return content.trim();
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
    agenticNote: 'Use model asi1 + x-session-id for Agentverse agent universe routing',
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
  resolveModelForTier,
  defaultCandidateModels,
  resolveAsi1ApiKey,
  resolveAsi1ApiKeys,
  hasAsi1Credentials,
  chatCompletion,
  healthCheck,
  getDiagnostics,
};
