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

function resolveGoogleApiKey() {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
}

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
const GOOGLE_MODEL = process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "~openai/gpt-latest";
// OpenRouter rejects the whole request with 402 when max_tokens exceeds what the
// remaining balance can afford ("requested up to 1500, can only afford 1326") —
// it does not silently truncate. Keep the ask under the balance or every call fails.
const OPENROUTER_MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS || 800);
const TOKENMIX_API_KEY = resolveTokenMixApiKey();
const TOKENMIX_BASE_URL = process.env.TOKENMIX_BASE_URL || "https://api.tokenmix.ai/v1/chat/completions";
// grok-4.3 confirmed working live on this account's promotional credit balance
// (see readTokenMixKeyFromSecrets comment above for the full verified list).
const TOKENMIX_MODEL = process.env.TOKENMIX_MODEL || "grok-4.3";
const TOKENMIX_MAX_TOKENS = Number(process.env.TOKENMIX_MAX_TOKENS || 800);
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

// ── 5-minute Polymarket / polycool.app price-to-beat detection ─────────────────
// xAI Grok is the primary for 5-minute binary PTB contracts. The "price to beat"
// (immutable, resolved via Chainlink oracle feeds for settlement) is injected
// into the specialized prompt. 15m Kalshi never carry PTB and never route here.

function resolveFiveMinTarget(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const m = (snapshot.market && typeof snapshot.market === "object") ? snapshot.market : {};
  const candidates = [
    snapshot.priceToBeat, snapshot.price_to_beat, snapshot.targetPrice, snapshot.target,
    m.priceToBeat, m.price_to_beat, m.targetPrice, m.target,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function getHorizonMinutes(snapshot) {
  const h = Number(snapshot?.horizonMinutes ?? snapshot?.horizon);
  return Number.isFinite(h) ? h : null;
}

function isFiveMinPtbMarket(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  // Must carry a price-to-beat target (Polymarket/polycool 5m binaries via Chainlink) — the discriminator.
  if (resolveFiveMinTarget(snapshot) == null) return false;
  // …and be a 5-minute market.
  const horizon = getHorizonMinutes(snapshot);
  const venue = String(
    snapshot.venue || snapshot.marketType || snapshot.market?.venue || ""
  ).toLowerCase();
  return snapshot.fiveMinute === true
    || snapshot.isFiveMin === true
    || horizon === 5
    || venue.includes("polymarket")
    || venue.includes("five")
    || venue.includes("5m");
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
      // Standalone XAI key (or legacy Anthropic) enables assistant so 5m PTB markets can run
      // on Grok for the binary contracts even if main provider is not configured.
      this.enabled = !!(LLM_API_URL && LLM_API_KEY) || !!XAI_API_KEY || !!ANTHROPIC_API_KEY;
    }

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
      const cacheKey = this.getCacheKey(snapshot);
      const now = Date.now();
      const cached = this.contextCache.get(cacheKey);
      if (cached && (now - cached.ts) < CONTEXT_CACHE_TTL_MS) {
        this.stats.cacheHits++;
        return cached.value;
      }

      // 5m PTB → five-min prompts; 15m/60m range → range prompts; else generic.
      // Served by xAI (Grok) first when configured; fallback cascade elsewhere.
      const fiveMin = isFiveMinPtbMarket(snapshot);
      const rangeHorizon = Number(snapshot.rangeHorizonMinutes || snapshot.horizonMinutes);
      const isRange = !fiveMin && (
        snapshot.rangePrediction === true
        || snapshot.rangeHorizon === true
        || rangeHorizon === 15
        || rangeHorizon === 60
      );
      const systemPrompt = fiveMin
        ? generateFiveMinSystemPrompt()
        : isRange
          ? generateRangeSystemPrompt(rangeHorizon === 60 ? 60 : 15)
          : generateSystemPrompt(getHorizonMinutes(snapshot) || 15);
      const rawUserPrompt = fiveMin
        ? generateFiveMinUserPrompt(snapshot)
        : isRange
          ? generateRangeUserPrompt(snapshot)
          : generateUserPrompt(snapshot);
      const userPrompt = this.enrichPromptWithRecall(snapshot, rawUserPrompt);

      const rawResponse = await this.callAPI(systemPrompt, userPrompt, snapshot);
      const normalized = this.normalizeResponse(rawResponse);
      this.recordMarketMemory(snapshot, normalized);
      this.contextCache.set(cacheKey, { ts: now, value: normalized });
      this.stats.successes++;
      this.clearRateLimitState();
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
    const ticker = String(snapshot?.kalshi15m?.ticker || snapshot?.activeContract?.ticker || snapshot?.contractTicker || "");
    const spotBucket = JSON.stringify(snapshot?.kalshiSpotBucket || "");
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
   * With XAI_API_KEY + XAI_PRIMARY_ALL (default true): Grok is first for ALL horizons.
   * 5m PTB binaries always prefer xAI when keyed. Fallbacks: asi1 → openai → claude → gemini → openrouter.
   */
  async callAPI(systemPrompt, userPrompt, snapshot = {}) {
    const is5mPtb = isFiveMinPtbMarket(snapshot);
    const useXai = !!XAI_API_KEY && (XAI_PRIMARY_ALL || is5mPtb);
    const useLegacyClaude = is5mPtb && !XAI_API_KEY && !!ANTHROPIC_API_KEY;
    // tokenmix leads every variant: as of 2026-08-09 it is the only provider in
    // this cascade with a live, working call on this account (grok-4.3 via
    // promotional credit -- see TOKENMIX_MODEL comment). Every other entry below
    // was individually verified dead (invalid key, exhausted credits/quota) on
    // the same date; they stay in the cascade as fallbacks in case that changes.
    const baseCascade = useXai
      ? ['tokenmix', 'xai', 'asi1', 'openai', 'anthropic', 'google', 'openrouter']
      : useLegacyClaude
        ? ['tokenmix', 'anthropic', 'asi1', 'openai', 'google', 'openrouter']
        : ['tokenmix', 'asi1', 'google', 'openai', 'openrouter'];
    // LLM_CASCADE_PRIMARY pins one provider to the front without disturbing the
    // fallback order behind it. Set it when the default primary is known-dead
    // (e.g. xAI 403 "no credits") so every call stops paying failed round trips
    // before reaching a provider that answers. Unset it to restore the default.
    const primaryOverride = String(process.env.LLM_CASCADE_PRIMARY || '').trim().toLowerCase();
    const cascade = primaryOverride && baseCascade.includes(primaryOverride)
      ? [primaryOverride, ...baseCascade.filter((p) => p !== primaryOverride)]
      : baseCascade;
    console.log(`[LLM] is5mPtb=${is5mPtb} useXai=${useXai} model=${useXai ? XAI_MODEL : 'cascade'} path=${cascade.join('→')}`);

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
          return res;
        }

        if (p === 'asi1') {
          if (!Asi1Client.hasAsi1Credentials()) { skipped.push(p); continue; }
          attempted.push(p);
          const model = process.env.ASI1_MODEL || 'asi1-ultra';
          console.log('[LLM 5m] trying asi1');
          const result = await Asi1Client.chatCompletion(
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            {
              model,
              temperature: 0.1,
              max_tokens: 1500,
              stream: true,
              response_format: { type: 'json_object' },
            },
          );
          let content = String(result.content || '').trim();
          const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (jsonMatch) content = jsonMatch[1];
          const parsed = JSON.parse(content);

          this._recordQueryExecution({
            id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
            coin,
            horizon,
            provider: 'asi1',
            model,
            status: 'SUCCESS',
            latencyMs: Date.now() - startTime,
            promptChars: promptLength,
            responseChars: content.length,
            resultCall: parsed?.call || parsed?.direction || null,
            regime: parsed?.regime || null,
            confidence: parsed?.confidence ?? null,
            notes: parsed?.suggestions?.notes?.slice(0, 180) || null,
            attempted: [...attempted],
            skipped: [...skipped],
            error: null,
          });
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
          console.log(`[LLM 5m] trying tokenmix (${model})`);
          const res = await this.callCompatibleAPI(systemPrompt, userPrompt, {
            url: TOKENMIX_BASE_URL,
            model,
            key: TOKENMIX_API_KEY,
            maxTokens: TOKENMIX_MAX_TOKENS,
          });

          this._recordQueryExecution({
            id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            ts: Date.now(),
            coin,
            horizon,
            provider: 'tokenmix',
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

  async callCompatibleAPI(systemPrompt, userPrompt, config = {}) {
    const url = config.url || LLM_API_URL;
    const model = config.model || LLM_MODEL;
    const key = config.key || LLM_API_KEY;
    const extraHeaders = config.extraHeaders || {};
    const maxTokens = Number(config.maxTokens || config.max_tokens || 1500);
    // Default non-stream for reliability (esp. xAI / Electron). Opt-in stream with config.stream=true.
    const useStream = config.stream === true;

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
      response_format: { type: "json_object" },
    };

    if (config.tools) {
      payload.tools = config.tools;
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
        `LLM API error ${response.status}: ${response.statusText}${errBody ? ` — ${errBody.slice(0, 180)}` : ""}`
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
              if (data.choices?.[0]?.delta?.content) {
                content += data.choices[0].delta.content;
              }
            } catch (e) {
              // ignore partial json block
            }
          }
        }
      }
      content = content.trim();
    } else {
      const data = await response.json();
      if (data.choices?.[0]?.message?.content) {
        content = data.choices[0].message.content.trim();
      } else if (data.error) {
        throw new Error(`LLM API error: ${data.error.message}`);
      } else {
        throw new Error("Unexpected LLM API response format");
      }
    }

    // Extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      content = jsonMatch[1];
    }

    return JSON.parse(content);
  }

  getGoogleClient() {
    if (this._googleClient) {
      return { kind: this._googleClientKind, client: this._googleClient };
    }

    try {
      const { GoogleGenAI } = require("@google/genai");
      this._googleClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
      this._googleClientKind = "genai";
      return { kind: this._googleClientKind, client: this._googleClient };
    } catch (_) { }

    try {
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      this._googleClient = new GoogleGenerativeAI(GOOGLE_API_KEY);
      this._googleClientKind = "generative-ai";
      return { kind: this._googleClientKind, client: this._googleClient };
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
    if (!GOOGLE_API_KEY) {
      throw new Error("GOOGLE_API_KEY (or GEMINI_API_KEY) is required for Google provider");
    }

    const { kind, client } = this.getGoogleClient();
    const prompt = `${systemPrompt}\n\nReturn valid JSON only.\n\n${userPrompt}`;
    let content = "";

    if (kind === "genai") {
      const response = await client.models.generateContent({
        model: GOOGLE_MODEL,
        contents: prompt,
        config: {
          temperature: 0.1,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: "HIGH" },
          tools: [{ googleSearch: {} }]
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
        tools: [{ googleSearch: {} }]
      });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      content = typeof response?.text === "function" ? response.text() : response?.text;
    }

    const json = this.extractJsonContent(content);
    return JSON.parse(json);
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
   * Normalize and validate LLM response
   */
  normalizeResponse(raw) {
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
      notes: typeof raw.suggestions?.notes === 'string' ? raw.suggestions.notes :
        typeof raw.suggestions?.reasoning === 'string' ? raw.suggestions.reasoning :
          typeof raw.suggestions?.summary === 'string' ? raw.suggestions.summary : "",
    };

    const warnings = Array.isArray(raw.warnings)
      ? raw.warnings.map(String).filter(w => w.length > 0)
      : Array.isArray(raw.suggestions?.issues)
        ? raw.suggestions.issues.map(String).filter(w => w.length > 0)
        : [];

    const ai_wording = raw.ai_wording || {
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
    return {
      enabled: this.enabled,
      provider: this.provider,
      api_url: this.enabled
        ? (this.provider === "google" ? "google-sdk"
          : this.provider === "anthropic" ? "anthropic-sdk"
          : this.provider === "xai" ? XAI_BASE_URL
          : LLM_API_URL)
        : "disabled",
      model: this.enabled
        ? (this.provider === "google" ? GOOGLE_MODEL
          : this.provider === "anthropic" ? ANTHROPIC_MODEL
          : this.provider === "xai" ? XAI_MODEL
          : LLM_MODEL)
        : "disabled",
      // For 5m PTB: primary xai (rex). Fallback order on failure: asi1 → openai → anthropic → google.
      fiveMinuteProvider: XAI_API_KEY ? "xai" : (ANTHROPIC_API_KEY ? "anthropic" : null),
      fiveMinuteModel: XAI_API_KEY ? XAI_MODEL : (ANTHROPIC_API_KEY ? ANTHROPIC_MODEL : null),
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

