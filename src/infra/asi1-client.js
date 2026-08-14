/**
 * ASI:One API client — OpenAI-compatible chat + agentic Agentverse routing.
 *
 * Env vars (never commit real keys):
 *   ASI_ONE_API_KEY          — primary (official ASI:One name)
 *   ASI1_API_KEY             — alias accepted by LeakSnipe + WECRYP
 *   asi1_api_key2_fallback   — secondary fallback key (user-provided)
 *   ASI1_API_KEY2_FALLBACK   — uppercase alias for the same fallback
 *   ASI1_API_KEY_FALLBACK    — alias without the "2" (spelling used in WECRYP .env)
 *   ASI1_BASE_URL            — default https://api.asi1.ai/v1
 *   ASI1_MODEL               — asi1 | asi1-mini | asi1-ultra (default: asi1-ultra)
 *
 * Agent universe: use model "asi1" with x-session-id header; ASI:One discovers
 * Agentverse marketplace agents automatically (see docs.asi1.ai agentic-llm).
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

function resolveModelForTier(tier, requestedModel) {
  if (requestedModel) return requestedModel;
  if (tier === 'quick-tick' || tier === 'quick' || tier === 'mini') return ASI1_QUICK_TICK_MODEL;
  if (tier === 'deep-insight' || tier === 'deep' || tier === 'macro' || tier === 'ultra') return ASI1_DEEP_INSIGHT_MODEL;
  return ASI1_DEFAULT_MODEL;
}

const KEY_ENV_NAMES = [
  'ASI_ONE_API_KEY',
  'ASI1_API_KEY',
  'asi1_api_key2_fallback',
  'ASI1_API_KEY2_FALLBACK',
  // .env ships this spelling (no "2"); without it the second key is silently
  // ignored and rotation can't fire, since it requires keys.length > 1.
  'ASI1_API_KEY_FALLBACK',
  'asi1_api_key_fallback',
];

const fs = require('fs');
const pathMod = require('path');

function readAsi1KeysFromSecrets() {
  const candidateDirs = [
    pathMod.resolve(process.cwd(), 'secrets'),
    pathMod.resolve(__dirname, '../../secrets'),
    pathMod.resolve(__dirname, '../secrets'),
    'G:\\WECRYP\\secrets',
    'G:\\WECRYPTO\\secrets',
  ];
  const fileNames = ['ASI1_API.txt', 'ASI_ONE_API_KEY.txt', 'ASI1_API_KEY.txt'];
  const foundKeys = [];
  const seen = new Set();

  for (const dir of candidateDirs) {
    for (const file of fileNames) {
      const fullPath = pathMod.join(dir, file);
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('sk_') && !seen.has(trimmed)) {
              seen.add(trimmed);
              foundKeys.push({ env: `file:${file}`, value: trimmed });
            }
          }
        }
      } catch (_) {}
    }
  }
  return foundKeys;
}

function resolveAsi1ApiKeys() {
  const keys = [];
  const seen = new Set();
  for (const name of KEY_ENV_NAMES) {
    const value = String(process.env[name] || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    keys.push({ env: name, value });
  }
  const secretKeys = readAsi1KeysFromSecrets();
  for (const k of secretKeys) {
    if (!seen.has(k.value)) {
      seen.add(k.value);
      keys.push(k);
    }
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
      : [requestedModel, 'asi1-fast', 'asi1-mini', 'asi1']
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

    const headers = {
      'Content-Type': 'application/json',
      ...(options.extraHeaders || {}),
    };
    if (options.sessionId) {
      headers['x-session-id'] = options.sessionId;
    }

    for (const { env, value } of keys) {
      try {
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
  return {
    configured: keys.length > 0,
    keysConfigured: keys.length,
    keyEnvNames: keys.map((k) => k.env),
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
  resolveModelForTier,
  resolveAsi1ApiKey,
  resolveAsi1ApiKeys,
  hasAsi1Credentials,
  chatCompletion,
  healthCheck,
  getDiagnostics,
};
