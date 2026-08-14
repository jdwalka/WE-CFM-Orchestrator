/**
 * LLM Signal Assistant — Real LLM-Powered Analysis Layer
 * 
 * Connects to Google Gemini SDK or any chat-completions compatible API
 * Uses SPECIALIZED prompt for 9-indicator crypto engine
 * Non-blocking, safe-gated, fully logged
 */

const fs = require("fs");
const path = require("path");
const {
  generateSystemPrompt,
  generateUserPrompt,
  generateFiveMinSystemPrompt,
  generateFiveMinUserPrompt,
  generateRangeSystemPrompt,
  generateRangeUserPrompt,
  resolveFiveMinTarget,
  sanitizeOracleSnapshot,
  scrubMoneyFloatsInText,
  formatUsdForCoin,
} = require("./specialized_prompt");
const Asi1Client = require("../infra/asi1-client");

function loadLLMEnv() {
  const loadedPaths = [];

  try {
    const dotenv = require("dotenv");
    const candidatePaths = [
      process.env.LLM_ENV_PATH,
      path.resolve(process.cwd(), ".env"),
      path.resolve(__dirname, "../../.env"),
      process.resourcesPath ? path.resolve(process.resourcesPath, "..", ".env") : null,
      process.execPath ? path.resolve(path.dirname(process.execPath), ".env") : null,
    ].filter(Boolean);

    for (const envPath of candidatePaths) {
      try {
        if (!fs.existsSync(envPath)) continue;
        const result = dotenv.config({ path: envPath, quiet: true });
        if (!result.error) loadedPaths.push(envPath);
      } catch (_) { }
    }

    return [...new Set(loadedPaths)];
  } catch (_) { }

  return [];
}

const LLM_ENV_SOURCES = loadLLMEnv();

function resolveCompatibleApiKey() {
  return Asi1Client.resolveAsi1ApiKey()
    || process.env.LLM_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.OPENAI_KEY
    || '';
}

// ── Robust secret dir candidates (Electron-aware, multi-drive) ──────────────

// The app keeps API keys as files under secrets/ (not auto-loaded into env).
// Read the Anthropic key from there as a fallback so dropping it into
// secrets/ANTHROPIC_API_KEY.txt (or CLAUDE_API.txt) just works — matching how
// other keys are stored. Accepts a bare key, a "# header" + key, or KEY=value.
function readAnthropicKeyFromSecrets() {
  const fileNames = ["ANTHROPIC_API_KEY.txt", "CLAUDE_API.txt"];
  const dirs = [
    path.resolve(process.cwd(), "secrets"),
    path.resolve(__dirname, "../../secrets"),
  ];
  for (const dir of dirs) {
    for (const name of fileNames) {
      try {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, "utf8");
        const match = raw.match(/sk-ant-[A-Za-z0-9_-]+/);
        if (match) return match[0];
        const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
        if (line) return line.replace(/^[A-Za-z0-9_]+\s*=\s*/, "").trim();
      } catch (_) { }
    }
  }
  return "";
}

function resolveAnthropicApiKey() {
  return process.env.ANTHROPIC_API_KEY
    || process.env.CLAUDE_API_KEY
    || readAnthropicKeyFromSecrets()
    || '';
}

// ── Robust secret dir candidates (Electron-aware, multi-drive) ──────────────
// Mirrors the logic in electron/main.js so keys placed in secrets/ are found
// whether running from source, packaged asar, different drive letters, etc.
function getLlmSecretDirCandidates() {
  const fsMod = fs;
  const pathMod = path;

  if (!fsMod || !pathMod) return [];

  const exeDir = pathMod.dirname(process.execPath || __filename || '');
  let userDataDir = '';
  try {
    // app may not be available at require time in some contexts, safe try
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') userDataDir = app.getPath('userData');
  } catch (_) {}

  const candidates = [
    userDataDir && pathMod.join(userDataDir, 'secrets'),
    pathMod.join(exeDir, 'secrets'),
    process.resourcesPath && pathMod.join(process.resourcesPath, '..', 'secrets'),
    pathMod.join(__dirname, '..', 'secrets'),
    pathMod.join(__dirname, '..', '..', 'secrets'),
    pathMod.resolve(process.cwd(), 'secrets'),
    // Hardcoded common dev locations (project supports launching from any drive)
    'G:\\WECRYPTO\\secrets',
    'F:\\WECRYPTO\\secrets',
    'E:\\WECRYPTO\\secrets',
    'G:\\WECRYP\\secrets',
    'G:\\wecryp\\secrets',
    pathMod.join(process.cwd(), '..', 'secrets'),
  ].filter(Boolean);

  const seen = new Set();
  const existing = [];
  for (const c of candidates) {
    try {
      const resolved = pathMod.resolve(c);
      const key = resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (fsMod.existsSync(resolved)) existing.push(resolved);
    } catch (_) {}
  }
  return existing;
}

function extractKeyFromRaw(raw, patterns) {
  if (!raw) return '';
  const text = String(raw);

  // Prefer the *last* regex match so multi-key secret files (old + new)
  // keep the newest key at the bottom without the loader latching on a revoked first key.
  for (const p of patterns) {
    const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
    let re;
    try {
      re = new RegExp(p.source, flags);
    } catch (_) {
      re = p;
    }
    const matches = [];
    if (re.global) {
      for (const m of text.matchAll(re)) {
        if (m && m[0]) matches.push(m[0]);
      }
    } else {
      const m = text.match(re);
      if (m && m[0]) matches.push(m[0]);
    }
    if (matches.length) return matches[matches.length - 1];
  }

  // Fallback: last non-comment non-empty line, strip KEY= prefix
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const line = lines.length ? lines[lines.length - 1] : '';
  if (line) return line.replace(/^[A-Za-z0-9_.-]+\s*=\s*/, '').trim();

  return '';
}

function readAllGoogleApiKeysFromSecrets() {
  const fileNames = ["-GOOGLE_AI_STUDIO_API_KEYS.txt", "Google FLASH API.txt", "GEMINI_API_KEY.txt", "GOOGLE_API_KEY.txt"];
  const keys = [];
  const seen = new Set();

  for (const dir of getLlmSecretDirCandidates()) {
    for (const name of fileNames) {
      try {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, "utf8");
        const matches = raw.match(/AIzaSy[A-Za-z0-9_-]+/g) || [];
        for (const m of matches) {
          if (!seen.has(m)) {
            seen.add(m);
            if (m.startsWith('AIzaSyDpJw')) keys.unshift(m);
            else keys.push(m);
          }
        }
      } catch (_) { }
    }
  }
  return keys;
}

function resolveGoogleApiKeys() {
  const secretKeys = readAllGoogleApiKeysFromSecrets();
  const seen = new Set(secretKeys);
  const keys = [...secretKeys];
  for (const k of [process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY]) {
    const trimmed = String(k || '').trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      keys.push(trimmed);
    }
  }
  return keys;
}

function resolveGoogleApiKey() {
  return resolveGoogleApiKeys()[0] || '';
}

// Read the Anthropic key ... (now uses full Electron + drive candidates)
function readAnthropicKeyFromSecrets() {
  const fileNames = ["ANTHROPIC_API_KEY.txt", "CLAUDE_API.txt"];
  const patterns = [/sk-ant-[A-Za-z0-9_-]+/i];

  for (const dir of getLlmSecretDirCandidates()) {
    for (const name of fileNames) {
      try {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, "utf8");
        const val = extractKeyFromRaw(raw, patterns);
        if (val) return val;
      } catch (_) { }
    }
  }
  return "";
}

// Read xAI / Grok key from secrets/ for the 5-minute binary PTB markets (polycool.app contracts, Chainlink price-to-beat).
function readXaiKeyFromSecrets() {
  const fileNames = ["XAI_API_KEY.txt", "GROK_API_KEY.txt", "xai_api_key.txt", "grok_api_key.txt"];
  // xAI keys are usually xai-... or sometimes sk- style
  const patterns = [/xai-[A-Za-z0-9_-]+/i, /sk-[A-Za-z0-9_-]+/i];

  for (const dir of getLlmSecretDirCandidates()) {
    for (const name of fileNames) {
      try {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, "utf8");
        const val = extractKeyFromRaw(raw, patterns);
        if (val) return val;
      } catch (_) { }
    }
  }
  return "";
}

function resolveXaiApiKey() {
  return process.env.XAI_API_KEY
    || process.env.GROK_API_KEY
    || process.env.XAI_KEY
    || readXaiKeyFromSecrets()
    || '';
}

// TokenMix (tokenmix.ai) -- OpenAI-compatible multi-provider relay, one key for
// 171+ models across 14 providers. Not a free tier: prepaid wallet, pay-as-you-go.
// Verified live (2026-08-09) that a subset of models work on promotional credit
// even at a $0.00 paid balance -- confirmed working: gpt-5.4-mini,
// deepseek-v4-flash, doubao-seed-2.1-turbo, grok-4.3. Others (gemini-3.5-flash,
// qwen3.6-flash, kimi-k2.5) returned 402 "not available with promotional
// credits" on the same account, so model choice matters even before funding it.
function readTokenMixKeyFromSecrets() {
  const fileNames = ["tokenmix_api_key.txt", "TOKENMIX_API_KEY.txt", "TokenMix.txt"];
  const patterns = [/sk-tm-[A-Za-z0-9_-]+/i];

  for (const dir of getLlmSecretDirCandidates()) {
    for (const name of fileNames) {
      try {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, "utf8");
        const val = extractKeyFromRaw(raw, patterns);
        if (val) return val;
      } catch (_) { }
    }
  }
  return "";
}

function resolveTokenMixApiKey() {
  return process.env.TOKENMIX_API_KEY
    || readTokenMixKeyFromSecrets()
    || '';
}

// Configuration from environment
const LLM_API_URL = process.env.LLM_API_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions";
const LLM_API_KEY = resolveCompatibleApiKey();
const LLM_MODEL = process.env.LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4-mini";
const GOOGLE_API_KEY = resolveGoogleApiKey();
if (GOOGLE_API_KEY) {
  process.env.GOOGLE_API_KEY = GOOGLE_API_KEY;
  process.env.GEMINI_API_KEY = GOOGLE_API_KEY;
}
const GOOGLE_MODEL = process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || "gemini-3.6-flash";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "~openai/gpt-latest";
// OpenRouter rejects the whole request with 402 when max_tokens exceeds what the
// remaining balance can afford ("requested up to 1500, can only afford 1326") —
// it does not silently truncate. Keep the ask under the balance or every call fails.
const OPENROUTER_MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS || 800);
const TOKENMIX_API_KEY = resolveTokenMixApiKey();
const TOKENMIX_BASE_URL = process.env.TOKENMIX_BASE_URL || "https://api.tokenmix.ai/v1/chat/completions";
// TokenMix cost ranking (api.tokenmix.ai/api/models, verified 2026-08-14):
// deepseek/deepseek-v4-flash is the best cost/detail pick for market JSON —
// ~0.13/0.26 $/MTok, JSON+reasoning+tools, 1M ctx. Pro is ~3x pricier; Claude/
// Gemini/GLM tiers are 10–70x for similar structured notes. Override with
// TOKENMIX_MODEL=deepseek/deepseek-v4-pro only if you want heavier reasoning.
const TOKENMIX_MODEL = process.env.TOKENMIX_MODEL || "deepseek/deepseek-v4-flash";
// DeepSeek V4 Flash is a *reasoning* model: with thinking on, completion tokens
// are spent on hidden reasoning first. If max_tokens is too low, finish_reason
// becomes "length", content is "", and we throw "Unexpected LLM API response
// format (tokenmix) keys=[choices…]". Default thinking OFF for market JSON
// (fast, cheap, reliable content). Override TOKENMIX_ENABLE_THINKING=1 for CoT.
const TOKENMIX_ENABLE_THINKING = (() => {
  const v = String(process.env.TOKENMIX_ENABLE_THINKING || '0').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
})();
// With thinking off, ~800–1400 is enough. With thinking on, budget must cover
// reasoning_tokens + JSON (~3–6k). Keep a healthy default either way.
const TOKENMIX_MAX_TOKENS = Number(
  process.env.TOKENMIX_MAX_TOKENS || (TOKENMIX_ENABLE_THINKING ? 4500 : 1600)
);
const TOKENMIX_TIMEOUT_MS = Number(process.env.TOKENMIX_TIMEOUT_MS || 45000);
// DeepSeek-via-TokenMix sometimes chokes on response_format; we retry without it.
const TOKENMIX_FORCE_JSON = process.env.TOKENMIX_FORCE_JSON !== '0';
// Anthropic (Claude) kept for backward/fallback only.
// xAI (rex) is primary for 5m PTB. Fallback on failure: asi1 → openai → claude → gemini.
const ANTHROPIC_API_KEY = resolveAnthropicApiKey();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const ANTHROPIC_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 1500);
// claude-opus-4-8 has no temperature/top_p; effort tunes thinking depth and
// token spend (low|medium|high|max). Default "low" keeps the real-time 5m loop
// responsive; raise it to trade latency for rigor.
const ANTHROPIC_VALID_EFFORTS = ["low", "medium", "high", "max"];
const ANTHROPIC_EFFORT = (() => {
  const e = String(process.env.ANTHROPIC_EFFORT || "low").toLowerCase();
  return ANTHROPIC_VALID_EFFORTS.includes(e) ? e : "low";
})();

// xAI Grok via console.x.ai API key (separate from SuperGrok consumer sub).
// Flagship default: grok-4.5. Override with XAI_MODEL=grok-4.3 for cheaper high volume.
// Use XAI_MODEL_FAST=grok-4.3 for batch/backtest if desired.
// Transport: official OpenAI-compatible SDK (openai npm) with baseURL api.x.ai — not raw fetch stream.
const XAI_API_KEY = resolveXaiApiKey();
const XAI_MODEL = process.env.XAI_MODEL || process.env.GROK_MODEL || "grok-4.5";
const XAI_MODEL_FAST = process.env.XAI_MODEL_FAST || process.env.XAI_BATCH_MODEL || "grok-4.3";
const XAI_BASE_URL = process.env.XAI_BASE_URL || "https://api.x.ai/v1/chat/completions";
const XAI_API_ROOT = (() => {
  const raw = String(process.env.XAI_API_ROOT || process.env.XAI_BASE_URL || "https://api.x.ai/v1").trim();
  return raw.replace(/\/chat\/completions\/?$/i, "").replace(/\/$/, "") || "https://api.x.ai/v1";
})();
const XAI_MAX_TOKENS = Number(process.env.XAI_MAX_TOKENS || 1600);
const XAI_TIMEOUT_MS = Number(process.env.XAI_TIMEOUT_MS || 45_000);
const XAI_MAX_RETRIES = Number(process.env.XAI_MAX_RETRIES || 1);
// Prefer xAI for ALL LLM analysis when key present (not only 5m PTB).
const XAI_PRIMARY_ALL = String(process.env.XAI_PRIMARY_ALL || "true").toLowerCase() !== "false";

let _xaiSdkClient = null;
function getXaiSdkClient() {
  if (_xaiSdkClient) return _xaiSdkClient;
  if (!XAI_API_KEY) throw new Error("XAI_API_KEY required for xAI SDK client");
  // xAI documents OpenAI SDK compatibility: baseURL https://api.x.ai/v1 + Bearer key
  const OpenAI = require("openai");
  _xaiSdkClient = new OpenAI({
    apiKey: XAI_API_KEY,
    baseURL: XAI_API_ROOT,
    timeout: XAI_TIMEOUT_MS,
    maxRetries: XAI_MAX_RETRIES,
  });
  return _xaiSdkClient;
}

const LLM_PROVIDER = (process.env.LLM_PROVIDER || "auto").toLowerCase();
const CONTEXT_CACHE_TTL_MS = Number(process.env.LLM_CONTEXT_CACHE_TTL_MS || 15000);
const MARKET_MEMORY_LIMIT = Number(process.env.LLM_MARKET_MEMORY_LIMIT || 12);
const LLM_RATE_LIMIT_BASE_COOLDOWN_MS = Number(process.env.LLM_RATE_LIMIT_BASE_COOLDOWN_MS || 15000);
const LLM_RATE_LIMIT_MAX_COOLDOWN_MS = Number(process.env.LLM_RATE_LIMIT_MAX_COOLDOWN_MS || 5 * 60 * 1000);
const LLM_RATE_LIMIT_LOG_DEBOUNCE_MS = Number(process.env.LLM_RATE_LIMIT_LOG_DEBOUNCE_MS || 20000);

// ── 5-minute Polymarket price-to-beat detection ─────────────────
// resolveFiveMinTarget comes from specialized_prompt (Polymarket-only PTB).
// PTB may be pending; still route 5m flags/horizon to five-min prompts.

function getHorizonMinutes(snapshot) {
  const h = Number(snapshot?.horizonMinutes ?? snapshot?.horizon);
  return Number.isFinite(h) ? h : null;
}

function isFiveMinPtbMarket(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const horizon = getHorizonMinutes(snapshot);
  // Explicit 5m product flags / horizon — even when PTB still pending
  if (snapshot.fiveMinute === true || snapshot.isFiveMin === true || horizon === 5) {
    return true;
  }
  // Do not steal 15m/60m range pre-contract traffic
  if (snapshot.rangePrediction === true || snapshot.rangeHorizon === true) {
    const rh = Number(snapshot.rangeHorizonMinutes || snapshot.horizonMinutes);
    if (rh === 15 || rh === 60) return false;
  }
  const venue = String(
    snapshot.venue || snapshot.marketType || snapshot.market?.venue || ""
  ).toLowerCase();
  if (venue.includes("5m") || venue.includes("five") || venue.includes("polycool")) {
    return true;
  }
  // Live poly5m contract without 15m active on same snapshot
  if (snapshot.poly5m?.slug && !snapshot.poly15m?.slug && resolveFiveMinTarget(snapshot) != null) {
    return true;
  }
  return false;
}

class LLMSignalAssistant {
  constructor() {
    this.provider = this.resolveProvider();
    
    if (this.provider === "openrouter") {
      this.enabled = !!OPENROUTER_API_KEY;
    } else if (this.provider === "google") {
      this.enabled = !!GOOGLE_API_KEY;
    } else if (this.provider === "anthropic") {
      this.enabled = !!ANTHROPIC_API_KEY;
    } else {
      // Any live market provider enables the assistant (ASI1 + TokenMix/DeepSeek included).
      this.enabled = !!(LLM_API_URL && LLM_API_KEY)
        || !!XAI_API_KEY
        || !!ANTHROPIC_API_KEY
        || Asi1Client.hasAsi1Credentials()
        || !!TOKENMIX_API_KEY;
    }

    // Restore query history / market memory / cooldowns from disk (cold-start avoidance)
    try { this._hydratePersistedState(); } catch (_) { /* */ }

    this.contextCache = new Map();      // short-lived prompt/result cache
    this.marketMemory = new Map();      // per-coin rolling recall memory
    this.queryHistory = [];             // rolling query log across all LLM providers
    this.queryStatsByProvider = {};     // per-provider stats (calls, latency, errors)
    this.queryStatsByModel = {};        // per-model stats (calls, latency, errors)
    // Circuit breaker: provider -> { until, reason }. Every provider was observed
    // failing on account-level errors (invalid/revoked key, exhausted credits,
    // rate/quota limit) rather than transient network issues -- those don't
    // self-heal within a request's timeout, so retrying them on every single
    // cascade call just pays the full round-trip+timeout cost repeatedly for a
    // provider already known to be dead. Skip a provider immediately while its
    // cooldown is active; it naturally retries again once the cooldown expires,
    // so a fixed key/billing gets picked back up without a restart.
    this._providerCooldowns = {};
    this._googleClient = null;
    this._googleClientKind = null;
    this._anthropicClient = null;
    this.envDiagnostics = {
      dotenvLoaded: LLM_ENV_SOURCES.length > 0,
      dotenvSources: LLM_ENV_SOURCES,
      hasCompatibleKey: !!LLM_API_KEY,
      hasGoogleKey: !!GOOGLE_API_KEY,
      hasAnthropicKey: !!ANTHROPIC_API_KEY,
      hasXaiKey: !!XAI_API_KEY,
      xaiKeySource: XAI_API_KEY ? 'env-or-secrets' : null,
      hasAsi1Key: Asi1Client.hasAsi1Credentials(),
      asi1KeysConfigured: Asi1Client.getDiagnostics().keysConfigured,
      hasTokenMixKey: !!TOKENMIX_API_KEY,
      providerOverride: process.env.LLM_PROVIDER || null,
    };

    this.stats = {
      calls: 0,
      successes: 0,
      failures: 0,
      influenceCount: 0,
      cacheHits: 0,
      cooldownSkips: 0,
    };

    this.rateLimitState = {
      cooldownUntilTs: 0,
      consecutiveFailures: 0,
      lastReason: null,
      lastRetryAfterMs: 0,
      lastRateLimitLogTs: 0,
    };

    const activeModel = this.provider === "xai" ? XAI_MODEL
      : this.provider === "google" ? GOOGLE_MODEL
        : this.provider === "anthropic" ? ANTHROPIC_MODEL
          : LLM_MODEL;
    console.log(
      `[LLMSignalAssistant] Initialized ${this.enabled ? "✓ ENABLED" : "⚠ DISABLED"} ` +
      `(provider=${this.provider}, model=${activeModel})`
    );
    if (XAI_API_KEY) {
      console.log(
        `[LLMSignalAssistant] xAI Grok PRIMARY (model=${XAI_MODEL}, fast=${XAI_MODEL_FAST}, ` +
        `allHorizons=${XAI_PRIMARY_ALL}) — fallback: asi1→openai→claude→gemini`
      );
      if (process.env.LLM_CASCADE_PRIMARY) {
        console.log(
          `[LLMSignalAssistant] ⚠ LLM_CASCADE_PRIMARY=${process.env.LLM_CASCADE_PRIMARY} overrides the above — ` +
          `that provider is tried FIRST. Unset it to restore xAI-first order.`
        );
      }
    } else if (ANTHROPIC_API_KEY) {
      console.log(`[LLMSignalAssistant] (fallback) Claude for 5m PTB (model=${ANTHROPIC_MODEL})`);
    }
    if (this.envDiagnostics.dotenvLoaded) {
      console.log(`[LLMSignalAssistant] Loaded env from: ${this.envDiagnostics.dotenvSources.join(" | ")}`);
    }
  }

  resolveProvider() {
    if (LLM_PROVIDER === "openrouter") return "openrouter";
    if (LLM_PROVIDER === "google") return "google";
    if (LLM_PROVIDER === "anthropic" || LLM_PROVIDER === "claude") return "anthropic";
    if (LLM_PROVIDER === "xai" || LLM_PROVIDER === "grok" || LLM_PROVIDER === "x.ai") return "xai";
    if (LLM_PROVIDER === "openai" || LLM_PROVIDER === "compatible") return "compatible";
    // Prefer xAI console key over other providers when present
    if (XAI_API_KEY && XAI_PRIMARY_ALL) return "xai";
    if (GOOGLE_API_KEY) return "google";
    if (OPENROUTER_API_KEY) return "openrouter";
    if (XAI_API_KEY) return "xai";
    return "compatible";
  }

  /**
   * Main entry point: analyze market snapshot
   * Returns: { regime, confidence, suggestions, warnings }
   */
  async analyzeSnapshot(snapshot) {
    this.stats.calls++;

    if (!this.enabled) {
      return {
        regime: "unknown",
        confidence: 0,
        suggestions: { notes: "LLM disabled" },
        warnings: ["LLM not configured"],
      };
    }

    const cooldownFallback = this.getCooldownFallback();
    if (cooldownFallback) {
      this.stats.cooldownSkips++;
      return cooldownFallback;
    }

    try {
      // Polymarket-only PTB + Pyth path normalization before any prompt build
      const snap = sanitizeOracleSnapshot(snapshot);
      const cacheKey = this.getCacheKey(snap);
      const now = Date.now();
      const cached = this.contextCache.get(cacheKey);
      if (cached && (now - cached.ts) < CONTEXT_CACHE_TTL_MS) {
        this.stats.cacheHits++;
        return cached.value;
      }

      // 5m PTB → five-min prompts; 15m/60m range → range prompts; else generic.
      // Served by xAI (Grok) first when configured; fallback cascade elsewhere.
      const fiveMin = isFiveMinPtbMarket(snap);
      const rangeHorizon = Number(snap.rangeHorizonMinutes || snap.horizonMinutes);
      const isRange = !fiveMin && (
        snap.rangePrediction === true
        || snap.rangeHorizon === true
        || rangeHorizon === 15
        || rangeHorizon === 60
      );
      const systemPrompt = fiveMin
        ? generateFiveMinSystemPrompt()
        : isRange
          ? generateRangeSystemPrompt(rangeHorizon === 60 ? 60 : 15)
          : generateSystemPrompt(getHorizonMinutes(snap) || 15);
      const rawUserPrompt = fiveMin
        ? generateFiveMinUserPrompt(snap)
        : isRange
          ? generateRangeUserPrompt(snap)
          : generateUserPrompt(snap);
      const userPrompt = this.enrichPromptWithRecall(snap, rawUserPrompt);

      const rawResponse = await this.callAPI(systemPrompt, userPrompt, snap);
      const normalized = this.normalizeResponse(rawResponse, snap);
      // Surface oracle PTB on output for UI/debug (does not invent numbers)
      if (snap.priceToBeatNum != null) {
        normalized.polymarketPtb = snap.priceToBeatNum;
        normalized.polymarketPtbSource = snap.priceToBeatSource || null;
        normalized.polymarketPtbDisplay = formatUsdForCoin(snap.coin || snap, snap.priceToBeatNum);
      }
      if (snap.modelDirection || snap.modelScore != null) {
        normalized.modelGuide = {
          direction: snap.modelDirection || snap.direction || null,
          score: snap.modelScore ?? snap.score ?? null,
          confidence: snap.confidence ?? null,
        };
      }
      this.recordMarketMemory(snap, normalized);
      this.contextCache.set(cacheKey, { ts: now, value: normalized });
      this.stats.successes++;
      this.clearRateLimitState();
      try { this._persistState(); } catch (_) { /* */ }
      return normalized;
    } catch (err) {
      this.stats.failures++;
      const rateLimited = this.handleRateLimitError(err);
      if (!rateLimited) {
        console.error("[LLMSignalAssistant] Analysis failed:", err.message);
      }
      return {
        regime: "unknown",
        confidence: 0,
        suggestions: {},
        warnings: [rateLimited ? this.formatCooldownWarning() : `LLM error: ${err.message}`],
      };
    }
  }

  /**
   * Call the LLM API with specialized prompts
   */
  getCacheKey(snapshot) {
    const coin = String(snapshot?.coin || "ALL");
    const horizon = String(snapshot?.horizon || snapshot?.rangeHorizonMinutes || snapshot?.horizonMinutes || "h15");
    const volatility = Number(snapshot?.volatility || 0).toFixed(4);
    const ticker = String(snapshot?.poly5m?.slug || snapshot?.poly15m?.slug || snapshot?.activeContract?.slug || snapshot?.contractSlug || "");
    const spotBucket = JSON.stringify(snapshot?.market || "");
    const spot = Number(snapshot?.currentPrice || snapshot?.price || 0).toFixed(2);
    const dir = String(snapshot?.direction || snapshot?.modelDirection || "");
    const indicatorsHash = JSON.stringify(snapshot?.indicators || {});
    return `${coin}|${horizon}|${ticker}|${spotBucket}|${spot}|${dir}|${volatility}|${indicatorsHash}`;
  }

  getRecentMemory(coin, limit = 4) {
    const key = String(coin || "ALL");
    const rows = this.marketMemory.get(key) || [];
    return rows.slice(-limit);
  }

  enrichPromptWithRecall(snapshot, userPrompt) {
    const coin = String(snapshot?.coin || "ALL");
    const recent = this.getRecentMemory(coin, 4);
    if (!recent.length) return userPrompt;

    const recall = recent.map((row, idx) => {
      const conf = Math.round((row.confidence || 0) * 100);
      const notes = row?.suggestions?.notes || "";
      return `${idx + 1}. regime=${row.regime} conf=${conf}% notes=${notes.slice(0, 180)}`;
    }).join("\n");

    return `${userPrompt}

Recent memory for ${coin} (most recent last):
${recall}

Use this recall only as context, and prioritize current market snapshot data if conflict occurs.`;
  }

  recordMarketMemory(snapshot, output) {
    const key = String(snapshot?.coin || "ALL");
    const rows = this.marketMemory.get(key) || [];
    rows.push({
      ts: Date.now(),
      regime: output?.regime || "unknown",
      confidence: Number(output?.confidence || 0),
      suggestions: output?.suggestions || {},
      warnings: output?.warnings || [],
    });
    if (rows.length > MARKET_MEMORY_LIMIT) rows.splice(0, rows.length - MARKET_MEMORY_LIMIT);
    this.marketMemory.set(key, rows);
  }

  /**
   * Internal query execution recorder across all providers
   */
  _recordQueryExecution(rec) {
    if (!rec || typeof rec !== 'object') return;

    // Rolling 200 history
    this.queryHistory.push(rec);
    if (this.queryHistory.length > 200) {
      this.queryHistory.shift();
    }

    // Provider stats
    const prov = rec.provider || 'unknown';
    if (!this.queryStatsByProvider[prov]) {
      this.queryStatsByProvider[prov] = {
        calls: 0,
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        lastUsedTs: 0,
        lastStatus: null,
      };
    }
    const pStats = this.queryStatsByProvider[prov];
    pStats.calls++;
    if (rec.status === 'SUCCESS') pStats.successes++;
    else pStats.failures++;
    pStats.totalLatencyMs += (rec.latencyMs || 0);
    pStats.avgLatencyMs = Math.round(pStats.totalLatencyMs / pStats.calls);
    pStats.lastUsedTs = rec.ts;
    pStats.lastStatus = rec.status;

    // Model stats
    const model = rec.model || 'unknown';
    if (!this.queryStatsByModel[model]) {
      this.queryStatsByModel[model] = {
        calls: 0,
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        lastUsedTs: 0,
      };
    }
    const mStats = this.queryStatsByModel[model];
    mStats.calls++;
    if (rec.status === 'SUCCESS') mStats.successes++;
    else mStats.failures++;
    mStats.totalLatencyMs += (rec.latencyMs || 0);
    mStats.avgLatencyMs = Math.round(mStats.totalLatencyMs / mStats.calls);
    mStats.lastUsedTs = rec.ts;
  }

  // Classifies an error into a cooldown duration, or null if it looks transient
  // (network blip, timeout) and should be retried on the very next call as
  // usual. Status codes are read from common shapes across providers (raw
  // fetch Response-derived errors carry "API error <code>" / "HTTP <code>" in
  // the message; SDK errors may carry .status/.statusCode).
  _classifyProviderError(err) {
    const status = Number(err?.status || err?.statusCode || 0)
      || Number(String(err?.message || '').match(/\b(40[0-9]|429)\b/)?.[1]) || 0;
    if (status === 401 || status === 403) {
      return { ms: 30 * 60_000, reason: `auth (${status}) -- key invalid/revoked or account permission denied` };
    }
    if (status === 402) {
      return { ms: 30 * 60_000, reason: 'payment required (402) -- no credits on this account' };
    }
    if (status === 429) {
      return { ms: 10 * 60_000, reason: 'rate/quota limited (429)' };
    }
    return null; // timeouts, network errors, 5xx -- worth retrying immediately
  }

  _recordProviderCooldown(provider, err) {
    if (provider === 'asi1') return; // ASI1 handles multi-key rotation internally
    const cls = this._classifyProviderError(err);
    if (!cls) return;
    const until = Date.now() + cls.ms;
    this._providerCooldowns[provider] = { until, reason: cls.reason };
    console.warn(`[LLMSignalAssistant] ${provider} cooling down for ${Math.round(cls.ms / 60000)}m -- ${cls.reason}`);
  }

  _providerCooldownRemaining(provider) {
    const cd = this._providerCooldowns[provider];
    if (!cd) return 0;
    const remaining = cd.until - Date.now();
    if (remaining <= 0) { delete this._providerCooldowns[provider]; return 0; }
    return remaining;
  }

  /**
   * Public helper to retrieve recent query history
   */
  getQueryHistory(limit = 50) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.queryHistory.slice(-lim);
  }

  /**
   * Call the LLM API with specialized prompts.
   *
   * Cascade policy (Polymarket-first product):
   * - Pre-contract 15m / hourly range: **ASI1 first** (asi1-ultra) — strongest
   *   market-analysis guidance before entry; then xAI, TokenMix, others.
   * - 5m PTB binaries: xAI first when keyed (fast path); ASI1 next.
   * - LLM_CASCADE_PRIMARY still pins an absolute primary when set.
   */
  async callAPI(systemPrompt, userPrompt, snapshot = {}) {
    const is5mPtb = isFiveMinPtbMarket(snapshot);
    const rangeHorizon = Number(snapshot?.rangeHorizonMinutes || snapshot?.horizonMinutes || 0);
    const isPreContractRange = !is5mPtb && (
      snapshot?.rangePrediction === true
      || snapshot?.preferAsi1 === true
      || snapshot?.preContract === true
      || rangeHorizon === 15
      || rangeHorizon === 60
      || String(snapshot?.horizon || '').includes('15')
      || String(snapshot?.horizon || '') === '60m'
      || String(snapshot?.horizon || '') === '1h'
    );
    const useXai = !!XAI_API_KEY && (XAI_PRIMARY_ALL || is5mPtb);
    const useLegacyClaude = is5mPtb && !XAI_API_KEY && !!ANTHROPIC_API_KEY;
    // Pre-contract: dual-fire ASI1 + TokenMix/DeepSeek (both get traffic), then cascade.
    // 5m PTB: xAI first when keyed; DeepSeek is strong cheap fallback.
    let baseCascade = ['asi1', 'tokenmix', 'xai', 'google', 'openai', 'anthropic', 'openrouter'];
    if (is5mPtb && XAI_API_KEY) {
      baseCascade = ['xai', 'asi1', 'tokenmix', 'google', 'openai', 'anthropic', 'openrouter'];
    } else if (isPreContractRange) {
      baseCascade = ['asi1', 'tokenmix', 'xai', 'google', 'openai', 'anthropic', 'openrouter'];
    }
    // LLM_CASCADE_PRIMARY pins one provider to the front without disturbing the
    // fallback order behind it.
    const primaryOverride = String(process.env.LLM_CASCADE_PRIMARY || '').trim().toLowerCase();
    const cascade = primaryOverride && baseCascade.includes(primaryOverride)
      ? [primaryOverride, ...baseCascade.filter((p) => p !== primaryOverride)]
      : baseCascade;
    console.log(
      `[LLM] is5mPtb=${is5mPtb} preContract=${isPreContractRange} useXai=${useXai} ` +
      `tokenmixKey=${!!TOKENMIX_API_KEY} asi1Key=${Asi1Client.hasAsi1Credentials()} path=${cascade.join('→')}`
    );

    // Inference router: pre-contract (15m/60m) always hits both providers when
    // keyed, TokenMix for the quick short-horizon/order-book read and ASI1 for
    // the deep regime + pre-contract read, merged into one decisive call.
    // Set LLM_RELAY_SPECIALIST_SPLIT=0 to revert to the same-prompt dual-fire
    // vote (_dualFireAsi1AndTokenMix) instead.
    if (
      isPreContractRange
      && process.env.LLM_DUAL_FIRE !== '0'
      && Asi1Client.hasAsi1Credentials()
      && process.env.LLM_DISABLE_ASI1 !== '1'
      && TOKENMIX_API_KEY
      && this._providerCooldownRemaining('tokenmix') <= 0
    ) {
      const useSpecialistSplit = process.env.LLM_RELAY_SPECIALIST_SPLIT !== '0';
      try {
        const meta = {
          coin: String(snapshot?.coin || 'GLOBAL'),
          horizon: String(snapshot?.horizon || snapshot?.horizonMinutes || '15m'),
          promptLength: (systemPrompt || '').length + (userPrompt || '').length,
        };
        const combined = useSpecialistSplit
          ? await this._relaySpecialistSplit(snapshot, meta)
          : await this._dualFireAsi1AndTokenMix(systemPrompt, userPrompt, snapshot, meta);
        // Scrub float trails (e.g. $75.44527553043135 → $75.45) before cascade return
        if (combined) return this.normalizeResponse(combined, snapshot);
      } catch (err) {
        console.warn(`[LLM] relay/dual-fire failed, falling back to cascade: ${err.message}`);
      }
    }

    let lastErr = null;
    const attempted = [];
    const skipped = [];
    const coin = String(snapshot?.coin || 'GLOBAL');
    const horizon = is5mPtb ? '5m-ptb' : String(snapshot?.horizon || snapshot?.horizonMinutes || '15m');
    const promptLength = (systemPrompt || '').length + (userPrompt || '').length;

    for (const p of cascade) {
      const cooldownMs = this._providerCooldownRemaining(p);
      if (cooldownMs > 0) {
        skipped.push(`${p}(cooldown ${Math.round(cooldownMs / 1000)}s)`);
        continue;
      }
      const startTime = Date.now();
      try {
        if (p === 'xai') {
          if (!XAI_API_KEY) { skipped.push(p); continue; }
          attempted.push(p);
          const model = is5mPtb ? XAI_MODEL : (XAI_MODEL || XAI_MODEL_FAST);
          const maxTokens = Number(
            snapshot?.xaiMaxTokens
            || snapshot?.maxTokens
            || (is5mPtb ? (process.env.XAI_5M_MAX_TOKENS || 1600) : XAI_MAX_TOKENS)
          );
          console.log(`[LLM] trying xai SDK (${model}) max_tokens=${maxTokens}`);
          const res = await this.callXaiAPI(systemPrompt, userPrompt, { model, maxTokens });
          
          this._recordQueryExecution({
            id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
            coin,
            horizon,
            provider: 'xai',
            model,
            status: 'SUCCESS',
            latencyMs: Date.now() - startTime,
            promptChars: promptLength,
            responseChars: JSON.stringify(res || {}).length,
            resultCall: res?.call || res?.direction || null,
            regime: res?.regime || null,
            confidence: res?.confidence ?? null,
            notes: res?.suggestions?.notes?.slice(0, 180) || null,
            attempted: [...attempted],
            skipped: [...skipped],
            error: null,
          });
          this._lastProvider = 'xai';
          this._lastModel = model;
          if (res && typeof res === 'object') {
            res._provider = 'xai';
            res._model = model;
          }
          return res;
        }

        if (p === 'asi1') {
          if (!Asi1Client.hasAsi1Credentials() || process.env.LLM_DISABLE_ASI1 === '1') { skipped.push(p); continue; }
          attempted.push(p);
          // Pre-contract / range: asi1-ultra with room for full guidance notes.
          // 5m ticks: faster mini unless ASI1_5M_MODEL overrides.
          const preContract = isPreContractRange || snapshot?.preferAsi1 === true;
          // Prefer asi1-fast for pre-contract — ultra has been 504/abort heavy;
          // logs show fast delivers solid market notes at half the fail rate.
          const model = preContract
            ? (process.env.ASI1_PRECONTRACT_MODEL || process.env.ASI1_MODEL || 'asi1-fast')
            : (process.env.ASI1_5M_MODEL || process.env.ASI1_QUICK_TICK_MODEL || process.env.ASI1_MODEL || 'asi1-mini');
          const maxTokens = preContract
            ? Number(process.env.ASI1_PRECONTRACT_MAX_TOKENS || 1600)
            : Number(process.env.ASI1_MAX_TOKENS || 1200);
          console.log(`[LLM ${horizon}] trying asi1 (${model}) preContract=${preContract} max_tokens=${maxTokens}`);
          const result = await Asi1Client.chatCompletion(
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            {
              model,
              // Always include fast fallback chain inside the client
              candidateModels: preContract
                ? [model, 'asi1-fast', 'asi1-mini', 'asi1']
                : [model, 'asi1-fast', 'asi1'],
              tier: preContract ? 'deep-insight' : 'quick-tick',
              temperature: 0.12,
              max_tokens: maxTokens,
              stream: false,
              response_format: { type: 'json_object' },
              web_search: preContract && process.env.ASI1_WEB_SEARCH === '1',
              timeoutMs: preContract
                ? Number(process.env.ASI1_PRECONTRACT_TIMEOUT_MS || 55000)
                : Number(process.env.ASI1_TIMEOUT_MS || 35000),
            },
          );
          let content = String(result.content || '').trim();
          const parsed = this.parseLlmJsonContent(content, { provider: 'asi1', rawText: content });
          // Stamp provider for UI "ASI1 THOUGHTS" / badges
          parsed._provider = 'asi1';
          parsed._model = result.model || model;
          if (result.thought && !parsed.ai_wording?.primary_rationale) {
            parsed.ai_wording = {
              ...(parsed.ai_wording || {}),
              primary_rationale: String(result.thought).slice(0, 500),
            };
          }

          this._recordQueryExecution({
            id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
            coin,
            horizon,
            provider: 'asi1',
            model: result.model || model,
            status: 'SUCCESS',
            latencyMs: Date.now() - startTime,
            promptChars: promptLength,
            responseChars: content.length,
            resultCall: parsed?.call || parsed?.direction || null,
            regime: parsed?.regime || null,
            confidence: parsed?.confidence ?? null,
            notes: parsed?.suggestions?.notes?.slice(0, 280) || null,
            attempted: [...attempted],
            skipped: [...skipped],
            error: null,
          });
          this._lastProvider = 'asi1';
          this._lastModel = result.model || model;
          return parsed;
        }

        if (p === 'openai') {
          if (!process.env.OPENAI_API_KEY) { skipped.push(p); continue; }
          attempted.push(p);
          const model = "gpt-4o";
          console.log('[LLM 5m] trying openai');
          const res = await this.callCompatibleAPI(systemPrompt, userPrompt, {
            url: "https://api.openai.com/v1/chat/completions",
            model,
            key: process.env.OPENAI_API_KEY
          });

          this._recordQueryExecution({
            id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
            coin,
            horizon,
            provider: 'openai',
            model,
            status: 'SUCCESS',
            latencyMs: Date.now() - startTime,
            promptChars: promptLength,
            responseChars: JSON.stringify(res || {}).length,
            resultCall: res?.call || res?.direction || null,
            regime: res?.regime || null,
            confidence: res?.confidence ?? null,
            notes: res?.suggestions?.notes?.slice(0, 180) || null,
            attempted: [...attempted],
            skipped: [...skipped],
            error: null,
          });
          return res;
        }

        if (p === 'anthropic') {
          if (!ANTHROPIC_API_KEY) { skipped.push(p); continue; }
          attempted.push(p);
          const model = ANTHROPIC_MODEL;
          console.log('[LLM 5m] trying claude');
          const res = await this.callAnthropicAPI(systemPrompt, userPrompt);

          this._recordQueryExecution({
            id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
            coin,
            horizon,
            provider: 'anthropic',
            model,
            status: 'SUCCESS',
            latencyMs: Date.now() - startTime,
            promptChars: promptLength,
            responseChars: JSON.stringify(res || {}).length,
            resultCall: res?.call || res?.direction || null,
            regime: res?.regime || null,
            confidence: res?.confidence ?? null,
            notes: res?.suggestions?.notes?.slice(0, 180) || null,
            attempted: [...attempted],
            skipped: [...skipped],
            error: null,
          });
          return res;
        }

        if (p === 'google') {
          if (!GOOGLE_API_KEY) { skipped.push(p); continue; }
          attempted.push(p);
          const model = GOOGLE_MODEL;
          console.log('[LLM 5m] trying gemini');
          const res = await this.callGoogleAPI(systemPrompt, userPrompt);

          this._recordQueryExecution({
            id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
            coin,
            horizon,
            provider: 'google',
            model,
            status: 'SUCCESS',
            latencyMs: Date.now() - startTime,
            promptChars: promptLength,
            responseChars: JSON.stringify(res || {}).length,
            resultCall: res?.call || res?.direction || null,
            regime: res?.regime || null,
            confidence: res?.confidence ?? null,
            notes: res?.suggestions?.notes?.slice(0, 180) || null,
            attempted: [...attempted],
            skipped: [...skipped],
            error: null,
          });
          return res;
        }

        if (p === 'openrouter') {
          if (!OPENROUTER_API_KEY) { skipped.push(p); continue; }
          attempted.push(p);
          const model = OPENROUTER_MODEL;
          const res = await this.callCompatibleAPI(systemPrompt, userPrompt, {
            url: "https://openrouter.ai/api/v1/chat/completions",
            model,
            key: OPENROUTER_API_KEY,
            maxTokens: OPENROUTER_MAX_TOKENS,
            extraHeaders: {
              "HTTP-Referer": process.env.OPENROUTER_REFERER || "http://localhost:3000",
              "X-OpenRouter-Title": process.env.OPENROUTER_TITLE || "WE-CFM"
            },
            tools: [
              { type: "openrouter:web_search" },
              { type: "openrouter:datetime" }
            ]
          });

          this._recordQueryExecution({
            id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
            coin,
            horizon,
            provider: 'openrouter',
            model,
            status: 'SUCCESS',
            latencyMs: Date.now() - startTime,
            promptChars: promptLength,
            responseChars: JSON.stringify(res || {}).length,
            resultCall: res?.call || res?.direction || null,
            regime: res?.regime || null,
            confidence: res?.confidence ?? null,
            notes: res?.suggestions?.notes?.slice(0, 180) || null,
            attempted: [...attempted],
            skipped: [...skipped],
            error: null,
          });
          return res;
        }

        if (p === 'tokenmix') {
          if (!TOKENMIX_API_KEY) { skipped.push(p); continue; }
          attempted.push(p);
          const model = TOKENMIX_MODEL;
          console.log(`[LLM ${horizon}] trying tokenmix/deepseek (${model})`);
          const res = await this.callTokenMixAPI(systemPrompt, userPrompt, {
            model,
            maxTokens: TOKENMIX_MAX_TOKENS,
            timeoutMs: TOKENMIX_TIMEOUT_MS,
          });

          this._recordQueryExecution({
            id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
            coin,
            horizon,
            provider: 'tokenmix',
            model: res?._model || model,
            status: 'SUCCESS',
            latencyMs: Date.now() - startTime,
            promptChars: promptLength,
            responseChars: JSON.stringify(res || {}).length,
            resultCall: res?.call || res?.direction || null,
            regime: res?.regime || null,
            confidence: res?.confidence ?? null,
            notes: res?.suggestions?.notes?.slice(0, 280) || null,
            attempted: [...attempted],
            skipped: [...skipped],
            error: null,
          });
          this._lastProvider = 'tokenmix';
          this._lastModel = res?._model || model;
          if (res && typeof res === 'object') {
            res._provider = 'tokenmix';
            res._model = res._model || model;
          }
          return res;
        }
      } catch (err) {
        lastErr = err;
        console.warn(`[LLMSignalAssistant] Provider ${p} failed: ${err.message}. Falling back...`);
        this._recordProviderCooldown(p, err);
        this._recordQueryExecution({
          id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
          ts: Date.now(),
          coin,
          horizon,
          provider: p,
          model: p === 'xai' ? XAI_MODEL : p === 'asi1' ? 'asi1-ultra' : p === 'tokenmix' ? TOKENMIX_MODEL : p === 'anthropic' ? ANTHROPIC_MODEL : p === 'google' ? GOOGLE_MODEL : 'unknown',
          status: 'FAILURE',
          latencyMs: Date.now() - startTime,
          promptChars: promptLength,
          responseChars: 0,
          resultCall: null,
          regime: null,
          confidence: null,
          notes: null,
          attempted: [...attempted],
          skipped: [...skipped],
          error: String(err.message || err),
        });
      }
    }

    if (lastErr) {
      if (skipped.length) {
        console.warn(
          `[LLMSignalAssistant] Cascade exhausted — attempted=[${attempted.join(', ')}] `
          + `skipped (no credentials or on cooldown)=[${skipped.join(', ')}]. `
          + `Last error is from "${attempted[attempted.length - 1]}": ${lastErr.message}`
        );
      }
      throw lastErr;
    }

    // Every provider was skipped (missing credentials and/or cooling down after a
    // recent account-level failure) -- nothing was actually attempted, so there is
    // no lastErr to throw. Falling through to callCompatibleAPI() with no explicit
    // key/url would silently reuse whatever the default OpenAI-compatible config
    // happens to be, which is confusing when the real reason is "everything is
    // cooling down." Fail clearly instead.
    if (skipped.length) {
      throw new Error(
        `[LLMSignalAssistant] All providers unavailable — skipped=[${skipped.join(', ')}]`
      );
    }

    // No cascade entries matched at all (cascade array itself was empty) --
    // preserves the original last-resort behavior.
    return this.callCompatibleAPI(systemPrompt, userPrompt);
  }

  /**
   * Pull text from OpenAI-compatible payloads (DeepSeek/TokenMix variants included).
   * Reasoning models often put the answer in reasoning_content / content arrays.
   */
  extractOpenAICompatibleContent(data) {
    if (!data || typeof data !== 'object') return '';
    if (data.error?.message) {
      const err = new Error(`LLM API error: ${data.error.message}`);
      err.status = data.error.code || data.error.status;
      throw err;
    }

    const choice = data.choices?.[0] || data.data?.choices?.[0] || null;
    const msg = choice?.message || choice?.delta || null;

    const pick = (v) => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) {
        return v.map((part) => {
          if (typeof part === 'string') return part;
          if (part?.text) return part.text;
          if (part?.content) return typeof part.content === 'string' ? part.content : '';
          if (part?.type === 'text' && part?.text) return part.text;
          return '';
        }).join('');
      }
      if (typeof v === 'object' && typeof v.text === 'string') return v.text;
      return '';
    };

    let content = '';
    if (msg) {
      content = pick(msg.content)
        || pick(msg.reasoning_content)
        || pick(msg.reasoning)
        || pick(msg.output_text)
        || pick(msg.text);
    }
    if (!content && choice) {
      content = pick(choice.text) || pick(choice.content) || pick(choice.output);
    }
    if (!content) {
      content = pick(data.output_text)
        || pick(data.output)
        || pick(data.content)
        || pick(data.result)
        || pick(data.message?.content);
    }
    return String(content || '').trim();
  }

  /**
   * Parse model text into our structured schema. Accepts pure JSON, fenced JSON,
   * or plain trader notes ("BUY DOWN…") which we wrap into {call, notes, …}.
   */
  parseLlmJsonContent(content, meta = {}) {
    const raw = String(content || '').trim();
    if (!raw) {
      throw new Error(`Empty LLM content${meta.provider ? ` from ${meta.provider}` : ''}`);
    }

    let candidate = raw;
    const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) candidate = fenced[1].trim();

    // Prefer first {...} block if model added prose around JSON
    if (!candidate.startsWith('{')) {
      const first = candidate.indexOf('{');
      const last = candidate.lastIndexOf('}');
      if (first >= 0 && last > first) {
        candidate = candidate.slice(first, last + 1);
      }
    }

    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { /* fall through to text wrapper */ }

    // Plain-text trader note (ASI1/DeepSeek often return this under stress)
    const upper = raw.toUpperCase();
    let call = null;
    if (/\bBUY\s+UP\b|\bCALL\s+UP\b|^\s*UP\b/.test(upper) || /\bABOVE\s+PTB\b/.test(upper)) call = 'UP';
    else if (/\bBUY\s+DOWN\b|\bCALL\s+DOWN\b|^\s*DOWN\b/.test(upper) || /\bBELOW\s+PTB\b/.test(upper)) call = 'DOWN';
    else if (/\bWAIT\b/.test(upper)) call = 'WAIT';

    const confMatch = raw.match(/\b(\d{1,3})\s*%/);
    let confidence = 0.55;
    if (confMatch) {
      const n = Number(confMatch[1]);
      if (n > 1 && n <= 100) confidence = n / 100;
    }

    return {
      call: call && call !== 'WAIT' ? call : (call === 'WAIT' ? 'UP' : 'UP'),
      direction: call && call !== 'WAIT' ? call : 'UP',
      confidence,
      regime: 'chop_noise',
      suggestions: {
        notes: raw.slice(0, 600),
        increase_weight: [],
        decrease_weight: [],
      },
      ai_wording: {
        primary_rationale: raw.slice(0, 800),
        market_patterns: '',
        scalp_setups: [],
      },
      warnings: call === 'WAIT' ? ['model_said_wait_forced_side'] : ['parsed_from_plaintext'],
      _provider: meta.provider || null,
      _softParsed: true,
    };
  }

  /**
   * Parallel ASI1 + TokenMix/DeepSeek for pre-contract. Both providers are always
   * queried (so TokenMix is not starved). Winner:
   *  - same call → higher confidence
   *  - disagree → prefer ASI1 but attach DeepSeek as shadow (truth guard decides later)
   */
  async _dualFireAsi1AndTokenMix(systemPrompt, userPrompt, snapshot, meta = {}) {
    const coin = meta.coin || 'GLOBAL';
    const horizon = meta.horizon || '15m';
    const promptLength = meta.promptLength || 0;
    const start = Date.now();

    const asi1Model = process.env.ASI1_PRECONTRACT_MODEL || process.env.ASI1_MODEL || 'asi1-fast';
    const tmModel = TOKENMIX_MODEL;

    const asi1Promise = Asi1Client.chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        model: asi1Model,
        candidateModels: [asi1Model, 'asi1-fast', 'asi1-mini', 'asi1'],
        tier: 'deep-insight',
        temperature: 0.12,
        max_tokens: Number(process.env.ASI1_PRECONTRACT_MAX_TOKENS || 1600),
        stream: false,
        response_format: { type: 'json_object' },
        web_search: process.env.ASI1_WEB_SEARCH === '1',
        timeoutMs: Number(process.env.ASI1_PRECONTRACT_TIMEOUT_MS || 55000),
      },
    ).then((result) => {
      const content = String(result.content || '').trim();
      const parsed = this.parseLlmJsonContent(content, { provider: 'asi1', rawText: content });
      parsed._provider = 'asi1';
      parsed._model = result.model || asi1Model;
      return { ok: true, parsed, model: parsed._model, ms: Date.now() - start };
    }).catch((err) => ({ ok: false, error: err, ms: Date.now() - start }));

    const tmPromise = this.callTokenMixAPI(systemPrompt, userPrompt, {
      model: tmModel,
      maxTokens: TOKENMIX_MAX_TOKENS,
      timeoutMs: TOKENMIX_TIMEOUT_MS,
    }).then((parsed) => {
      parsed._provider = 'tokenmix';
      parsed._model = parsed._model || tmModel;
      return { ok: true, parsed, model: parsed._model, ms: Date.now() - start };
    }).catch((err) => ({ ok: false, error: err, ms: Date.now() - start }));

    const [asi1Res, tmRes] = await Promise.all([asi1Promise, tmPromise]);

    // Always log both attempts so the query UI shows TokenMix traffic
    for (const [provider, res, model] of [
      ['asi1', asi1Res, asi1Model],
      ['tokenmix', tmRes, tmModel],
    ]) {
      this._recordQueryExecution({
        id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        ts: Date.now(),
        coin,
        horizon,
        provider,
        model: res.model || model,
        status: res.ok ? 'SUCCESS' : 'FAILURE',
        latencyMs: res.ms || 0,
        promptChars: promptLength,
        responseChars: res.ok ? JSON.stringify(res.parsed || {}).length : 0,
        resultCall: res.ok ? (res.parsed?.call || res.parsed?.direction || null) : null,
        regime: res.ok ? (res.parsed?.regime || null) : null,
        confidence: res.ok ? (res.parsed?.confidence ?? null) : null,
        notes: res.ok
          ? String(res.parsed?.suggestions?.notes || '').slice(0, 280)
          : null,
        attempted: ['asi1', 'tokenmix'],
        skipped: [],
        error: res.ok ? null : String(res.error?.message || res.error || 'failed'),
        dualFire: true,
      });
      if (!res.ok && provider === 'tokenmix') {
        this._recordProviderCooldown('tokenmix', res.error || new Error('tokenmix dual-fire fail'));
      }
    }

    if (!asi1Res.ok && !tmRes.ok) {
      throw (asi1Res.error || tmRes.error || new Error('dual-fire both failed'));
    }
    if (asi1Res.ok && !tmRes.ok) {
      console.log(`[LLM dual-fire] ASI1 ok, TokenMix failed — using ASI1`);
      this._lastProvider = 'asi1';
      this._lastModel = asi1Res.model;
      return asi1Res.parsed;
    }
    if (!asi1Res.ok && tmRes.ok) {
      console.log(`[LLM dual-fire] ASI1 failed, TokenMix/DeepSeek ok — using DeepSeek`);
      this._lastProvider = 'tokenmix';
      this._lastModel = tmRes.model;
      return tmRes.parsed;
    }

    // Both ok — pick winner
    const a = asi1Res.parsed;
    const b = tmRes.parsed;
    const aCall = String(a.call || a.direction || '').toUpperCase();
    const bCall = String(b.call || b.direction || '').toUpperCase();
    const aConf = Number(a.confidence) || 0;
    const bConf = Number(b.confidence) || 0;

    let winner = a;
    let winnerName = 'asi1';
    if (aCall && bCall && aCall === bCall) {
      winner = aConf >= bConf ? a : b;
      winnerName = aConf >= bConf ? 'asi1' : 'tokenmix';
      winner._ensemble = 'agree';
    } else if (aCall && bCall && aCall !== bCall) {
      // Disagreement: keep ASI1 as primary label but attach DeepSeek shadow + flag
      winner = a;
      winnerName = 'asi1';
      winner._ensemble = 'disagree';
      winner._shadow = {
        provider: 'tokenmix',
        model: tmRes.model,
        call: bCall,
        confidence: bConf,
        notes: scrubMoneyFloatsInText(String(b.suggestions?.notes || '').slice(0, 220), snapshot?.coin || ''),
      };
      winner.warnings = [
        ...(Array.isArray(winner.warnings) ? winner.warnings : []),
        `ensemble_disagree:asi1=${aCall}/tokenmix=${bCall}`,
      ];
      // Soften confidence when models fight
      winner.confidence = Math.min(aConf, bConf, 0.55);
    } else {
      winner = aCall ? a : b;
      winnerName = aCall ? 'asi1' : 'tokenmix';
    }

    winner._provider = winnerName === 'tokenmix' ? 'tokenmix' : 'asi1';
    winner._model = winnerName === 'tokenmix' ? tmRes.model : asi1Res.model;
    winner._dualFire = true;
    this._lastProvider = winner._provider;
    this._lastModel = winner._model;
    console.log(
      `[LLM dual-fire] winner=${winnerName} call=${winner.call || winner.direction} ` +
      `ensemble=${winner._ensemble || 'single'} asi1=${aCall}@${aConf} deepseek=${bCall}@${bConf}`
    );
    return winner;
  }

  /**
   * Specialist-split inference router: TokenMix/DeepSeek handles the quick,
   * short-horizon/order-book read; ASI1 handles the deep, 15m-60m regime +
   * pre-contract read. Unlike _dualFireAsi1AndTokenMix (same prompt to both,
   * then vote), each model gets a role-specific prompt built from
   * inference-relay.js's microstructure packet, and the two legs are merged
   * deterministically (InferenceRelay.mergeLegsLocally) into one decisive
   * binary call — no extra synthesis LLM call needed.
   */
  async _relaySpecialistSplit(snapshot, meta = {}) {
    const InferenceRelay = require('./inference-relay');
    const coin = meta.coin || snapshot?.coin || 'GLOBAL';
    const horizon = meta.horizon || '15m';
    const start = Date.now();

    const packet = InferenceRelay.buildMicrostructurePacket(snapshot);

    const shortPromise = this.callTokenMixAPI(
      InferenceRelay.specialistSystemShort(),
      InferenceRelay.buildSpecialistUser(packet, 'short_ob'),
      { model: TOKENMIX_MODEL, maxTokens: TOKENMIX_MAX_TOKENS, timeoutMs: TOKENMIX_TIMEOUT_MS },
    ).then((parsed) => ({ ok: true, parsed, ms: Date.now() - start }))
      .catch((err) => ({ ok: false, error: err, ms: Date.now() - start }));

    const asi1Model = process.env.ASI1_PRECONTRACT_MODEL || process.env.ASI1_MODEL || 'asi1-fast';
    const longPromise = Asi1Client.chatCompletion(
      [
        { role: 'system', content: InferenceRelay.specialistSystemLong() },
        { role: 'user', content: InferenceRelay.buildSpecialistUser(packet, 'medium_long') },
      ],
      {
        model: asi1Model,
        candidateModels: [asi1Model, 'asi1-fast', 'asi1-mini', 'asi1'],
        tier: 'deep-insight',
        temperature: 0.12,
        max_tokens: Number(process.env.ASI1_PRECONTRACT_MAX_TOKENS || 1600),
        response_format: { type: 'json_object' },
        timeoutMs: Number(process.env.ASI1_PRECONTRACT_TIMEOUT_MS || 55000),
      },
    ).then((result) => {
      const content = String(result.content || '').trim();
      const parsed = this.parseLlmJsonContent(content, { provider: 'asi1', rawText: content });
      return { ok: true, parsed, model: result.model || asi1Model, ms: Date.now() - start };
    }).catch((err) => ({ ok: false, error: err, ms: Date.now() - start }));

    const [shortRes, longRes] = await Promise.all([shortPromise, longPromise]);

    if (!shortRes.ok && !longRes.ok) {
      throw (longRes.error || shortRes.error || new Error('relay: both specialist legs failed'));
    }

    const shortLeg = shortRes.ok ? shortRes.parsed : null;
    const longLeg = longRes.ok ? longRes.parsed : null;
    const merged = InferenceRelay.mergeLegsLocally(packet, shortLeg, longLeg);

    for (const [provider, res] of [['tokenmix', shortRes], ['asi1', longRes]]) {
      this._recordQueryExecution({
        id: `llm-relay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        ts: Date.now(),
        coin,
        horizon,
        provider,
        model: provider === 'tokenmix' ? TOKENMIX_MODEL : asi1Model,
        status: res.ok ? 'SUCCESS' : 'FAILURE',
        latencyMs: res.ms || 0,
        resultCall: res.ok ? (res.parsed?.call || null) : null,
        confidence: res.ok ? (res.parsed?.confidence ?? null) : null,
        error: res.ok ? null : String(res.error?.message || res.error || 'failed'),
        relaySpecialistSplit: true,
        relayRole: provider === 'tokenmix' ? 'short_ob' : 'medium_long',
      });
    }

    this._lastProvider = 'relay';
    this._lastModel = `tokenmix:${TOKENMIX_MODEL}+asi1:${asi1Model}`;
    console.log(
      `[LLM relay] ${coin} ${horizon} call=${merged.call} agreement=${merged.relay?.agreement} ` +
      `short=${shortLeg?.call || 'FAIL'} long=${longLeg?.call || 'FAIL'} primary=${merged.relay?.primaryLeg}`
    );
    return merged;
  }

  _inferenceStatePath() {
    const candidates = [
      path.join(process.cwd(), 'WE-CRYPTO-CACHE', 'llm-inference-state.json'),
      path.join(__dirname, '..', '..', 'WE-CRYPTO-CACHE', 'llm-inference-state.json'),
      path.join(process.cwd(), 'data', 'llm-inference-state.json'),
    ];
    try {
      const { app } = require('electron');
      if (app?.getPath) {
        candidates.unshift(path.join(app.getPath('userData'), 'llm-inference-state.json'));
      }
    } catch (_) { /* not in electron */ }
    return candidates[0];
  }

  _hydratePersistedState() {
    const tryPaths = [
      this._inferenceStatePath(),
      path.join(process.cwd(), 'WE-CRYPTO-CACHE', 'llm-inference-state.json'),
      path.join(__dirname, '..', '..', 'WE-CRYPTO-CACHE', 'llm-inference-state.json'),
    ];
    for (const p of tryPaths) {
      try {
        if (!fs.existsSync(p)) continue;
        const raw = fs.readFileSync(p, 'utf8');
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') continue;
        if (Array.isArray(data.queryHistory)) {
          this.queryHistory = data.queryHistory.slice(-200);
        }
        if (data.marketMemory && typeof data.marketMemory === 'object') {
          for (const [k, rows] of Object.entries(data.marketMemory)) {
            if (Array.isArray(rows)) this.marketMemory.set(k, rows.slice(-12));
          }
        }
        if (data.contextCache && typeof data.contextCache === 'object') {
          const now = Date.now();
          for (const [k, entry] of Object.entries(data.contextCache)) {
            if (entry && entry.value && (now - Number(entry.ts || 0)) < CONTEXT_CACHE_TTL_MS * 4) {
              this.contextCache.set(k, { ts: entry.ts, value: entry.value });
            }
          }
        }
        if (data.queryStatsByProvider) this.queryStatsByProvider = data.queryStatsByProvider;
        if (data.queryStatsByModel) this.queryStatsByModel = data.queryStatsByModel;
        console.log(
          `[LLMSignalAssistant] Restored inference state from ${p} ` +
          `(history=${this.queryHistory.length} memoryCoins=${this.marketMemory.size} cache=${this.contextCache.size})`
        );
        return;
      } catch (err) {
        console.warn(`[LLMSignalAssistant] hydrate skip ${p}:`, err.message);
      }
    }
  }

  _persistState() {
    const file = this._inferenceStatePath();
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const marketMemory = {};
      for (const [k, rows] of this.marketMemory.entries()) {
        marketMemory[k] = (rows || []).slice(-12);
      }
      const contextCache = {};
      for (const [k, entry] of this.contextCache.entries()) {
        contextCache[k] = { ts: entry.ts, value: entry.value };
      }
      const payload = {
        savedAt: Date.now(),
        queryHistory: this.queryHistory.slice(-200),
        marketMemory,
        contextCache,
        queryStatsByProvider: this.queryStatsByProvider,
        queryStatsByModel: this.queryStatsByModel,
        lastProvider: this._lastProvider || null,
        lastModel: this._lastModel || null,
      };
      fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
    } catch (err) {
      // Don't spam — once per few minutes is enough
      if (!this._lastPersistWarn || Date.now() - this._lastPersistWarn > 120_000) {
        this._lastPersistWarn = Date.now();
        console.warn('[LLMSignalAssistant] persist failed:', err.message);
      }
    }
  }

  /**
   * TokenMix → DeepSeek V4 Flash (default).
   * Retries: json→plain, and if reasoning ate max_tokens (empty content),
   * re-calls with enable_thinking:false and a larger budget.
   */
  async callTokenMixAPI(systemPrompt, userPrompt, config = {}) {
    if (!TOKENMIX_API_KEY) throw new Error('TOKENMIX_API_KEY missing');
    const model = config.model || TOKENMIX_MODEL;
    const baseMaxTokens = Number(config.maxTokens || TOKENMIX_MAX_TOKENS);
    const timeoutMs = Number(config.timeoutMs || TOKENMIX_TIMEOUT_MS);
    const preferThinking = config.enableThinking != null
      ? !!config.enableThinking
      : TOKENMIX_ENABLE_THINKING;

    // Prefer plain first when thinking is off (faster, fewer empty bodies);
    // with thinking on, try json_object first for structured notes.
    const jsonFirst = TOKENMIX_FORCE_JSON && preferThinking;
    const modeAttempts = jsonFirst
      ? [{ jsonMode: true }, { jsonMode: false }]
      : TOKENMIX_FORCE_JSON
        ? [{ jsonMode: false }, { jsonMode: true }]
        : [{ jsonMode: false }];

    const attempts = [
      // Primary: env thinking preference
      ...modeAttempts.map((m) => ({
        ...m,
        enableThinking: preferThinking,
        maxTokens: baseMaxTokens,
      })),
      // Rescue: reasoning burned the budget → force no-thinking + headroom
      {
        jsonMode: false,
        enableThinking: false,
        maxTokens: Math.max(baseMaxTokens, 2000),
        rescue: true,
      },
      {
        jsonMode: true,
        enableThinking: false,
        maxTokens: Math.max(baseMaxTokens, 2000),
        rescue: true,
      },
    ];

    // De-dupe identical attempt shapes
    const seen = new Set();
    const uniqueAttempts = attempts.filter((a) => {
      const k = `${a.jsonMode}|${a.enableThinking}|${a.maxTokens}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    let lastErr = null;
    for (const attempt of uniqueAttempts) {
      try {
        const res = await this.callCompatibleAPI(systemPrompt, userPrompt, {
          url: TOKENMIX_BASE_URL,
          model,
          key: TOKENMIX_API_KEY,
          maxTokens: attempt.maxTokens,
          timeoutMs,
          stream: false,
          responseFormat: attempt.jsonMode ? { type: 'json_object' } : null,
          enableThinking: attempt.enableThinking,
          providerLabel: 'tokenmix',
        });
        if (res && typeof res === 'object') {
          res._provider = 'tokenmix';
          res._model = model;
          res._tokenmixThinking = attempt.enableThinking;
        }
        return res;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        const reasoningStarve = /empty content|reasoning_tokens|finish=length|Unexpected LLM API response format/i.test(msg);
        console.warn(
          `[TokenMix] attempt json=${attempt.jsonMode} think=${attempt.enableThinking}` +
            ` maxTok=${attempt.maxTokens}${attempt.rescue ? ' rescue' : ''} failed: ${msg.slice(0, 180)}`
        );
        // If not a reasoning/format miss and not the last try, still continue
        // (json_mode can 400). Skip remaining same-thinking attempts only when
        // auth/payment errors.
        if (/\b(401|402|403)\b/.test(msg)) break;
        if (!reasoningStarve && attempt.rescue) continue;
      }
    }
    throw lastErr || new Error('TokenMix DeepSeek failed');
  }

  async callCompatibleAPI(systemPrompt, userPrompt, config = {}) {
    const url = config.url || LLM_API_URL;
    const model = config.model || LLM_MODEL;
    const key = config.key || LLM_API_KEY;
    const extraHeaders = config.extraHeaders || {};
    const maxTokens = Number(config.maxTokens || config.max_tokens || 1500);
    // Default non-stream for reliability (esp. xAI / Electron). Opt-in stream with config.stream=true.
    const useStream = config.stream === true;
    const providerLabel = config.providerLabel || 'compatible';

    if (!key) throw new Error("API key missing for compatible provider");

    const payload = {
      model: model,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.1, // low temp for consistency
      max_tokens: maxTokens,
      stream: useStream,
    };

    // Optional JSON mode — TokenMix/DeepSeek sometimes 400s or returns empty with it
    if (config.responseFormat) {
      payload.response_format = config.responseFormat;
    } else if (config.responseFormat !== null && config.jsonMode !== false) {
      // legacy default for OpenAI-style providers
      if (config.forceJson !== false && providerLabel !== 'tokenmix') {
        payload.response_format = { type: "json_object" };
      }
    }

    if (config.tools) {
      payload.tools = config.tools;
    }

    // DeepSeek V4 (TokenMix and direct): disable hidden reasoning so max_tokens
    // is spent on visible content. Without this, large prompts often return
    // finish_reason=length with content="" (reasoning_tokens == max_tokens).
    if (typeof config.enableThinking === 'boolean') {
      payload.enable_thinking = config.enableThinking;
    }

    const controller = new AbortController();
    const timeoutMs = Number(config.timeoutMs || XAI_TIMEOUT_MS || 45_000);
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error(`compatible LLM timeout after ${timeoutMs}ms`));
      } catch (_) {
        try { controller.abort(); } catch (_) {}
      }
    }, timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          ...extraHeaders
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `LLM API error ${response.status}: ${response.statusText}${errBody ? ` — ${errBody.slice(0, 220)}` : ""}`
      );
    }

    let content = "";
    if (useStream && response.body) {
      const decoder = new TextDecoder("utf-8");
      for await (const chunk of response.body) {
        const text = decoder.decode(chunk, { stream: true });
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") continue;
            try {
              const data = JSON.parse(dataStr);
              const delta = data.choices?.[0]?.delta;
              if (delta?.content) content += typeof delta.content === 'string' ? delta.content : '';
              else if (delta?.reasoning_content) content += String(delta.reasoning_content);
            } catch (e) {
              // ignore partial json block
            }
          }
        }
      }
      content = content.trim();
    } else {
      const data = await response.json();
      try {
        content = this.extractOpenAICompatibleContent(data);
      } catch (err) {
        throw err;
      }
      if (!content) {
        const choice = data?.choices?.[0] || null;
        const finish = choice?.finish_reason || 'unknown';
        const usage = data?.usage || {};
        const reasonTok = usage?.completion_tokens_details?.reasoning_tokens
          ?? usage?.reasoning_tokens
          ?? null;
        const keys = Object.keys(data || {}).slice(0, 12).join(',');
        const c0 = choice ? Object.keys(choice).join(',') : 'none';
        const m0 = choice?.message ? Object.keys(choice.message).join(',') : 'none';
        // Explicit diagnosis so callTokenMixAPI can rescue (thinking off / more tokens)
        throw new Error(
          `Unexpected LLM API response format (${providerLabel}) empty content` +
          ` finish=${finish} reasoning_tokens=${reasonTok} max_tokens=${maxTokens}` +
          ` keys=[${keys}] choice=[${c0}] message=[${m0}]`
        );
      }
    }

    return this.parseLlmJsonContent(content, { provider: providerLabel });
  }

  getGoogleClient(apiKey) {
    const key = apiKey || resolveGoogleApiKey();
    try {
      const { GoogleGenAI } = require("@google/genai");
      return { kind: "genai", client: new GoogleGenAI({ apiKey: key }) };
    } catch (_) { }

    try {
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      return { kind: "generative-ai", client: new GoogleGenerativeAI(key) };
    } catch (_) { }

    throw new Error("Google provider selected but no supported SDK found (@google/genai or @google/generative-ai)");
  }

  extractJsonContent(rawText) {
    const content = String(rawText || "").trim();
    if (!content) throw new Error("Empty LLM response");

    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) return fenced[1];

    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }

    return content;
  }

  async callGoogleAPI(systemPrompt, userPrompt) {
    const keys = resolveGoogleApiKeys();
    if (!keys.length) {
      throw new Error("GOOGLE_API_KEY (or GEMINI_API_KEY) is required for Google provider");
    }

    const prompt = `${systemPrompt}\n\nReturn valid JSON only.\n\n${userPrompt}`;
    let lastErr = null;

    for (const key of keys) {
      try {
        const { kind, client } = this.getGoogleClient(key);
        let content = "";
        if (kind === "genai") {
          const response = await client.models.generateContent({
            model: GOOGLE_MODEL,
            contents: prompt,
            config: {
              temperature: 0.1,
              responseMimeType: "application/json",
            },
          });
          content = typeof response?.text === "function" ? response.text() : response?.text;
        } else {
          const model = client.getGenerativeModel({
            model: GOOGLE_MODEL,
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json",
            },
          });
          const result = await model.generateContent(prompt);
          const response = await result.response;
          content = typeof response?.text === "function" ? response.text() : response?.text;
        }

        const json = this.extractJsonContent(content);
        return JSON.parse(json);
      } catch (err) {
        lastErr = err;
        console.warn(`[LLM Google] Key ${key.slice(0, 10)}... failed: ${err.message}`);
        if (keys.length > 1) continue;
        throw err;
      }
    }
    throw lastErr || new Error("All Google API keys failed");
  }

  getAnthropicClient() {
    if (this._anthropicClient) return this._anthropicClient;

    let AnthropicModule;
    try {
      AnthropicModule = require("@anthropic-ai/sdk");
    } catch (_) {
      throw new Error("Anthropic provider selected but @anthropic-ai/sdk is not installed");
    }
    const Anthropic = AnthropicModule.Anthropic || AnthropicModule.default || AnthropicModule;
    this._anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    return this._anthropicClient;
  }

  async callAnthropicAPI(systemPrompt, userPrompt) {
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is required for Anthropic provider");
    }

    const client = this.getAnthropicClient();

    // claude-opus-4-8 rejects temperature/top_p/top_k — steer with the prompt
    // and `effort` instead. Thinking is omitted for the fast real-time 5m path;
    // the JSON-only instruction + extractJsonContent keep any stray reasoning
    // out of the parsed result.
    const message = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: systemPrompt,
      output_config: { effort: ANTHROPIC_EFFORT },
      messages: [
        {
          role: "user",
          content: `${userPrompt}\n\nRespond with only a single valid JSON object — no preamble, no explanation, no markdown fences.`,
        },
      ],
    });

    const text = (message?.content || [])
      .filter((block) => block && block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!text) throw new Error("Anthropic returned an empty response");

    return JSON.parse(this.extractJsonContent(text));
  }

  _parseXaiJsonContent(content) {
    let text = String(content || "").trim();
    if (!text) throw new Error("xAI returned empty content");
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) text = fenced[1].trim();
    try {
      return JSON.parse(text);
    } catch (e1) {
      // Truncation recovery: close open braces/brackets if max_tokens cut mid-object
      if (typeof this.extractJsonContent === "function") {
        try {
          return JSON.parse(this.extractJsonContent(text));
        } catch (_) { /* fall through */ }
      }
      const start = text.indexOf("{");
      if (start >= 0) {
        let slice = text.slice(start);
        // strip trailing incomplete string
        slice = slice.replace(/,\s*"[^"]*$/, "");
        slice = slice.replace(/:\s*"[^"]*$/, ':""');
        const opens = (slice.match(/\{/g) || []).length - (slice.match(/\}/g) || []).length;
        const openArr = (slice.match(/\[/g) || []).length - (slice.match(/\]/g) || []).length;
        slice += "]".repeat(Math.max(0, openArr)) + "}".repeat(Math.max(0, opens));
        try {
          return JSON.parse(slice);
        } catch (_) { /* fall through */ }
      }
      throw e1;
    }
  }

  async callXaiAPI(systemPrompt, userPrompt, opts = {}) {
    if (!XAI_API_KEY) {
      throw new Error("XAI_API_KEY (or GROK_API_KEY) is required for xAI Grok inference — get one at https://console.x.ai");
    }

    const model = opts.model || XAI_MODEL;
    // 5m schema is large — under-budget max_tokens truncates JSON ("Unterminated string")
    let maxTokens = Number(opts.maxTokens || XAI_MAX_TOKENS || 1600);
    if (maxTokens < 800) maxTokens = 800;
    const temperature = opts.temperature != null ? Number(opts.temperature) : 0.1;
    const t0 = Date.now();
    const client = getXaiSdkClient();

    const runOnce = async (tokens) => {
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `${userPrompt}\n\nRespond with a single compact JSON object only. Keep notes under 280 chars. No markdown fences.`,
          },
        ],
        temperature,
        max_tokens: tokens,
        response_format: { type: "json_object" },
        stream: false,
      });
      const content = String(completion?.choices?.[0]?.message?.content || "").trim();
      const finish = completion?.choices?.[0]?.finish_reason || "";
      const parsed = this._parseXaiJsonContent(content);
      return { parsed, completion, finish, tokens };
    };

    try {
      let result;
      try {
        result = await runOnce(maxTokens);
      } catch (parseErr) {
        // Retry once with larger budget if truncated / bad JSON
        const bump = Math.min(2800, Math.max(maxTokens * 2, 1800));
        console.warn(`[LLM] xai SDK JSON issue (${String(parseErr.message || parseErr).slice(0, 80)}) — retry max_tokens=${bump}`);
        result = await runOnce(bump);
      }
      console.log(
        `[LLM] xai SDK ok model=${model} ms=${Date.now() - t0} ` +
        `max_tokens=${result.tokens} finish=${result.finish || "?"} ` +
        `usage=${result.completion?.usage?.total_tokens ?? "?"}`
      );
      return result.parsed;
    } catch (sdkErr) {
      const msg = String(sdkErr?.message || sdkErr || "");
      console.warn(`[LLM] xai SDK path failed (${msg.slice(0, 140)}) — raw non-stream fallback`);
      return this.callCompatibleAPI(systemPrompt, userPrompt, {
        url: `${XAI_API_ROOT}/chat/completions`,
        model,
        key: XAI_API_KEY,
        maxTokens: Math.max(maxTokens, 1600),
        stream: false,
        timeoutMs: XAI_TIMEOUT_MS,
      });
    }
  }

  getCooldownFallback() {
    const remainingMs = this.getCooldownRemainingMs();
    if (remainingMs <= 0) return null;
    return {
      regime: "unknown",
      confidence: 0,
      suggestions: {
        notes: `LLM cooldown active for ${Math.ceil(remainingMs / 1000)}s due to provider rate limits`,
      },
      warnings: [this.formatCooldownWarning(remainingMs)],
    };
  }

  getCooldownRemainingMs() {
    const until = Number(this.rateLimitState?.cooldownUntilTs || 0);
    return Math.max(0, until - Date.now());
  }

  clearRateLimitState() {
    this.rateLimitState.consecutiveFailures = 0;
    this.rateLimitState.lastReason = null;
    this.rateLimitState.lastRetryAfterMs = 0;
    this.rateLimitState.cooldownUntilTs = 0;
  }

  formatCooldownWarning(remainingMs = this.getCooldownRemainingMs()) {
    const secs = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
    const reason = this.rateLimitState?.lastReason || 'provider rate limit';
    return `LLM cooldown active (${secs}s remaining): ${reason}`;
  }

  extractRetryAfterMs(err) {
    const retryInfo = err?.error?.details?.find?.((detail) => String(detail?.['@type'] || '').includes('RetryInfo'));
    const retryDelay = retryInfo?.retryDelay;
    if (typeof retryDelay === 'string') {
      const secs = Number.parseFloat(retryDelay.replace(/s$/i, ''));
      if (Number.isFinite(secs) && secs > 0) return secs * 1000;
    }

    const msg = String(err?.message || err || '');
    const match = msg.match(/retry in\s+([\d.]+)s/i);
    if (match) {
      const secs = Number.parseFloat(match[1]);
      if (Number.isFinite(secs) && secs > 0) return secs * 1000;
    }

    return 0;
  }

  isRateLimitError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return /429|quota|resource_exhausted|resource exhausted|rate limit|too many requests/.test(msg);
  }

  handleRateLimitError(err) {
    if (!this.isRateLimitError(err)) return false;

    const retryAfterMs = this.extractRetryAfterMs(err);
    const nextFailureCount = Number(this.rateLimitState.consecutiveFailures || 0) + 1;
    const backoffMs = LLM_RATE_LIMIT_BASE_COOLDOWN_MS * Math.max(1, nextFailureCount);
    const cooldownMs = Math.min(
      LLM_RATE_LIMIT_MAX_COOLDOWN_MS,
      Math.max(LLM_RATE_LIMIT_BASE_COOLDOWN_MS, retryAfterMs, backoffMs)
    );

    this.rateLimitState.consecutiveFailures = nextFailureCount;
    this.rateLimitState.lastRetryAfterMs = retryAfterMs;
    this.rateLimitState.lastReason = String(err?.message || 'rate limit');
    this.rateLimitState.cooldownUntilTs = Date.now() + cooldownMs;

    const now = Date.now();
    if ((now - Number(this.rateLimitState.lastRateLimitLogTs || 0)) >= LLM_RATE_LIMIT_LOG_DEBOUNCE_MS) {
      this.rateLimitState.lastRateLimitLogTs = now;
      console.warn(
        `[LLMSignalAssistant] Rate limit detected; cooling down for ${Math.ceil(cooldownMs / 1000)}s ` +
        `(retryAfter=${Math.ceil((retryAfterMs || 0) / 1000)}s, failures=${nextFailureCount})`
      );
    }

    return true;
  }

  /**
   * Normalize and validate LLM response.
   * @param {object} raw
   * @param {object} [snapshot] — used to scrub float trails by coin decimals
   */
  normalizeResponse(raw, snapshot = null) {
    if (!raw) {
      return {
        regime: "unknown",
        confidence: 0,
        suggestions: { notes: "null response" },
        warnings: ["LLM returned null"],
      };
    }

    const regime = this.validateRegime(raw.regime);
    const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
    const coinHint = snapshot?.coin
      || snapshot?.poly5m?.slug
      || snapshot?.poly15m?.slug
      || snapshot?.activeContract?.slug
      || raw?.polyPeg?.slug
      || '';

    const scrub = (t) => scrubMoneyFloatsInText(t, coinHint);

    const increaseWeight = Array.isArray(raw.suggestions?.increase_weight)
      ? raw.suggestions.increase_weight
      : Array.isArray(raw.suggestions?.increase)
        ? raw.suggestions.increase
        : [];
    const decreaseWeight = Array.isArray(raw.suggestions?.decrease_weight)
      ? raw.suggestions.decrease_weight
      : Array.isArray(raw.suggestions?.decrease)
        ? raw.suggestions.decrease
        : [];

    const suggestions = {
      increase_weight: increaseWeight.filter(s => typeof s === 'string'),
      decrease_weight: decreaseWeight.filter(s => typeof s === 'string'),
      notes: typeof raw.suggestions?.notes === 'string' ? scrub(raw.suggestions.notes) :
        typeof raw.suggestions?.reasoning === 'string' ? scrub(raw.suggestions.reasoning) :
          typeof raw.suggestions?.summary === 'string' ? scrub(raw.suggestions.summary) : "",
    };

    // Prefer longer ASI1 notes from primary_rationale when notes are thin
    if ((!suggestions.notes || suggestions.notes.length < 40) && raw.ai_wording?.primary_rationale) {
      suggestions.notes = scrub(String(raw.ai_wording.primary_rationale));
    } else if (suggestions.notes) {
      suggestions.notes = scrub(suggestions.notes);
    }

    const warnings = Array.isArray(raw.warnings)
      ? raw.warnings.map(String).filter(w => w.length > 0)
      : Array.isArray(raw.suggestions?.issues)
        ? raw.suggestions.issues.map(String).filter(w => w.length > 0)
        : [];

    const ai_wording = raw.ai_wording ? {
      ...raw.ai_wording,
      primary_rationale: scrub(raw.ai_wording.primary_rationale || ''),
      wait_rationale: scrub(raw.ai_wording.wait_rationale || ''),
      high_confidence_rationale: scrub(raw.ai_wording.high_confidence_rationale || ''),
      market_patterns: scrub(raw.ai_wording.market_patterns || ''),
    } : {
      primary_rationale: "",
      wait_rationale: "",
      high_confidence_rationale: "",
      scalp_setups: []
    };
    const display_terms = Array.isArray(raw.display_terms)
      ? raw.display_terms.map(String).map(s => s.trim()).filter(Boolean).slice(0, 12)
      : [];

    return {
      regime,
      confidence,
      suggestions,
      warnings,
      analysis: raw.analysis || {},
      ai_wording,
      display_terms,
      provider: raw._provider || this._lastProvider || null,
      model: raw._model || this._lastModel || null,
      // ── 5m PTB binary contract fields ─────────────────────────────────────
      // These keys are emitted by the 5m system prompt and consumed by
      // FiveMinGrok / GrokRangeOverlay. Passed through verbatim so overlays
      // don't have to re-parse notes text for the directional call.
      ...(typeof raw.call === 'string' && raw.call
        ? { call: raw.call.trim().toUpperCase() } : {}),
      ...(typeof raw.direction === 'string' && raw.direction
        ? { direction: raw.direction.trim().toUpperCase() } : {}),
      ...(raw.snipe_plan && typeof raw.snipe_plan === 'object'
        ? { snipe_plan: raw.snipe_plan } : {}),
      ...(typeof raw.broader_observations === 'string'
        ? { broader_observations: raw.broader_observations.trim() } : {}),
      ...(raw.preferredRange && typeof raw.preferredRange === 'object'
        ? { preferredRange: raw.preferredRange } : {}),
      ...(raw.polyPeg && typeof raw.polyPeg === 'object'
        ? { polyPeg: raw.polyPeg } : {}),
      ...(raw.preContract && typeof raw.preContract === 'object'
        ? { preContract: raw.preContract } : {}),
    };
  }

  validateRegime(regime) {
    const valid = [
      "trend_continuation",
      "mean_reversion",
      "chop_noise",
      "breakout_volatility",
    ];
    return valid.includes(regime) ? regime : "unknown";
  }

  /**
   * Apply LLM suggestions to weights with safety gates
   */
  applyWeights(llmOutput, currentWeights) {
    if (!llmOutput || llmOutput.regime === "unknown") {
      return { changed: false, newWeights: currentWeights };
    }

    if (llmOutput.confidence < 0.6) {
      // Safety gate: need high confidence
      return { changed: false, newWeights: currentWeights };
    }

    let newWeights = { ...currentWeights };
    let changed = false;

    const maxAdjustment = 1.05; // max 5% nudge
    const minAdjustment = 0.95;

    // Apply increases
    for (const signal of llmOutput.suggestions.increase_weight) {
      if (newWeights[signal]) {
        newWeights[signal] = Math.min(newWeights[signal] * maxAdjustment, 2.0); // cap at 2.0x
        changed = true;
      }
    }

    // Apply decreases
    for (const signal of llmOutput.suggestions.decrease_weight) {
      if (signal === "all") {
        for (const key of Object.keys(newWeights)) {
          newWeights[key] = Math.max(newWeights[key] * minAdjustment, 0.3); // floor at 0.3x
        }
        changed = true;
      } else if (newWeights[signal]) {
        newWeights[signal] = Math.max(newWeights[signal] * minAdjustment, 0.3);
        changed = true;
      }
    }

    if (changed) {
      this.stats.influenceCount++;
    }

    return { changed, newWeights };
  }

  /**
   * Log LLM analysis to disk for forensics
   */
  logAnalysis(coin, input, output, applied) {
    try {
      const logDir = path.join(process.cwd(), "logs", "llm");
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const timestamp = new Date().toISOString();
      const filename = path.join(logDir, `${coin}-${Date.now()}.json`);

      fs.writeFileSync(
        filename,
        JSON.stringify(
          {
            timestamp,
            coin,
            input,
            output,
            applied,
          },
          null,
          2
        )
      );
    } catch (err) {
      console.warn("[LLMSignalAssistant] Failed to write log:", err.message);
    }
  }

  /**
   * Get diagnostics
   */
  getDiagnostics() {
    const rate = this.stats.calls > 0 ? (this.stats.successes / this.stats.calls * 100).toFixed(1) : 0;
    const lastProvider = this._lastProvider || this.provider || null;
    const lastModel = this._lastModel || null;
    return {
      enabled: this.enabled,
      provider: lastProvider || this.provider,
      lastProvider,
      lastModel,
      api_url: this.enabled
        ? (lastProvider === "asi1" ? "https://api.asi1.ai/v1"
          : lastProvider === "google" || this.provider === "google" ? "google-sdk"
          : lastProvider === "anthropic" || this.provider === "anthropic" ? "anthropic-sdk"
          : lastProvider === "xai" || this.provider === "xai" ? XAI_BASE_URL
          : LLM_API_URL)
        : "disabled",
      model: this.enabled
        ? (lastModel
          || (this.provider === "google" ? GOOGLE_MODEL
          : this.provider === "anthropic" ? ANTHROPIC_MODEL
          : this.provider === "xai" ? XAI_MODEL
          : LLM_MODEL))
        : "disabled",
      // Pre-contract 15m/60m: ASI1 primary. 5m PTB: xAI primary when keyed.
      preContractProvider: Asi1Client.hasAsi1Credentials() ? "asi1" : (XAI_API_KEY ? "xai" : null),
      fiveMinuteProvider: XAI_API_KEY ? "xai" : (Asi1Client.hasAsi1Credentials() ? "asi1" : (ANTHROPIC_API_KEY ? "anthropic" : null)),
      fiveMinuteModel: XAI_API_KEY ? XAI_MODEL : (Asi1Client.hasAsi1Credentials() ? "asi1-mini" : (ANTHROPIC_API_KEY ? ANTHROPIC_MODEL : null)),
      stats: {
        total_calls: this.stats.calls,
        successes: this.stats.successes,
        failures: this.stats.failures,
        success_rate: `${rate}%`,
        influence_count: this.stats.influenceCount,
        cache_hits: this.stats.cacheHits,
        cooldown_skips: this.stats.cooldownSkips,
      },
      cooldown: {
        active: this.getCooldownRemainingMs() > 0,
        remaining_ms: this.getCooldownRemainingMs(),
        last_reason: this.rateLimitState.lastReason,
        retry_after_ms: this.rateLimitState.lastRetryAfterMs,
        consecutive_failures: this.rateLimitState.consecutiveFailures,
      },
      env: this.envDiagnostics,
      observability: {
        totalQueries: this.queryHistory.length,
        recentQueries: this.queryHistory.slice(-50),
        lastQuery: this.queryHistory.length ? this.queryHistory[this.queryHistory.length - 1] : null,
        byProvider: this.queryStatsByProvider,
        byModel: this.queryStatsByModel,
        // Per-provider circuit breaker state (distinct from the single-global
        // `cooldown` field above, which predates this and tracks something else).
        // A provider showing here is being skipped without a network attempt --
        // see _recordProviderCooldown / _providerCooldownRemaining.
        providerCooldowns: Object.fromEntries(
          Object.entries(this._providerCooldowns)
            .map(([p, cd]) => [p, cd.until > Date.now() ? { remainingMs: cd.until - Date.now(), reason: cd.reason } : null])
            .filter(([, v]) => v)
        ),
      },
    };
  }
}

// ══════════════════════════════════════════════════════════════
// Export
// ══════════════════════════════════════════════════════════════

module.exports = new LLMSignalAssistant();

if (typeof window !== "undefined") {
  window.LLMSignalAssistant = module.exports;
}

console.log("[LLMSignalAssistant] Module loaded with SPECIALIZED prompts");

