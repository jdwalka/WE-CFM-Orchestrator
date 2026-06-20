/**
 * ASI:One API client — OpenAI-compatible chat + agentic Agentverse routing.
 *
 * Env vars (never commit real keys):
 *   ASI_ONE_API_KEY          — primary (official ASI:One name)
 *   ASI1_API_KEY             — alias accepted by LeakSnipe + WECRYP
 *   asi1_api_key2_fallback   — secondary fallback key (user-provided)
 *   ASI1_API_KEY2_FALLBACK   — uppercase alias for the same fallback
 *   ASI1_BASE_URL            — default https://api.asi1.ai/v1
 *   ASI1_MODEL               — default asi1 | asi1-mini | asi1-ultra
 *
 * Agent universe: use model "asi1" with x-session-id header; ASI:One discovers
 * Agentverse marketplace agents automatically (see docs.asi1.ai agentic-llm).
 */

const ASI1_BASE_URL = (
  process.env.ASI1_BASE_URL || 'https://api.asi1.ai/v1'
).replace(/\/$/, '');

const ASI1_CHAT_URL = `${ASI1_BASE_URL}/chat/completions`;
const ASI1_DEFAULT_MODEL = process.env.ASI1_MODEL || 'asi1';
const ASI1_HEALTH_TIMEOUT_MS = Number(process.env.ASI1_HEALTH_TIMEOUT_MS || 12000);
const ASI1_REQUEST_TIMEOUT_MS = Number(process.env.ASI1_REQUEST_TIMEOUT_MS || 90000);

const KEY_ENV_NAMES = [
  'ASI_ONE_API_KEY',
  'ASI1_API_KEY',
  'asi1_api_key2_fallback',
  'ASI1_API_KEY2_FALLBACK',
];

function resolveAsi1ApiKeys() {
  const keys = [];
  const seen = new Set();
  for (const name of KEY_ENV_NAMES) {
    const value = String(process.env[name] || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    keys.push({ env: name, value });
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
    || msg.includes('rate limit') || msg.includes('unauthorized') || msg.includes('invalid api key');
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

  const payload = {
    model: options.model || ASI1_DEFAULT_MODEL,
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

  let lastErr = null;
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
        if (isRetryableAsi1Error(err) && keys.length > 1) {
          lastErr = err;
          continue;
        }
        throw err;
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
      const content = data?.choices?.[0]?.message?.content ?? '';
      return {
        content: String(content).trim(),
        model: data?.model || payload.model,
        keyEnv: env,
        raw: data,
        usage: data?.usage || null,
        executable_data: data?.executable_data || null,
        intermediate_steps: data?.intermediate_steps || null,
        thought: data?.thought || null,
      };
    } catch (err) {
      lastErr = err;
      if (isRetryableAsi1Error(err) && keys.length > 1) continue;
      throw err;
    }
  }

  throw lastErr || new Error('ASI:One request failed');
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
 * Lightweight health probe — uses asi1-mini when available for lower cost.
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
        model: options.model || process.env.ASI1_HEALTH_MODEL || 'asi1-mini',
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
  resolveAsi1ApiKey,
  resolveAsi1ApiKeys,
  hasAsi1Credentials,
  chatCompletion,
  healthCheck,
  getDiagnostics,
};
