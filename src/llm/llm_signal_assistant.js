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
const Asi1CreditOrch = require("./asi1-credit-orchestrator");

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

// ── Robust secret dir candidates (Electron-aware, multi-drive) ──────────────
// Mirrors the logic in electron/main.js so keys placed in secrets/ are found
// whether running from source, packaged asar, different drive letters, etc.
function getLlmSecretDirCandidates() {
  const exeDir = path.dirname(process.execPath || __filename || '');
  let userDataDir = '';
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') userDataDir = app.getPath('userData');
  } catch (_) {}

  const candidates = [
    userDataDir && path.join(userDataDir, 'secrets'),
    path.join(exeDir, 'secrets'),
    process.resourcesPath && path.join(process.resourcesPath, '..', 'secrets'),
    path.join(__dirname, '..', 'secrets'),
    path.join(__dirname, '..', '..', 'secrets'),
    path.resolve(process.cwd(), 'secrets'),
    'G:\\WECRYPTO\\secrets',
    'F:\\WECRYPTO\\secrets',
    'E:\\WECRYPTO\\secrets',
    'G:\\WECRYP\\secrets',
    'G:\\wecryp\\secrets',
    path.join(process.cwd(), '..', 'secrets'),
  ].filter(Boolean);

  const seen = new Set();
  const existing = [];
  for (const c of candidates) {
    try {
      const resolved = path.resolve(c);
      const key = resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (fs.existsSync(resolved)) existing.push(resolved);
    } catch (_) {}
  }
  return existing;
}

function extractKeyFromRaw(raw, patterns) {
  if (!raw) return '';
  const text = String(raw);
  for (const p of patterns) {
    const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
    let re;
    try { re = new RegExp(p.source, flags); } catch (_) { re = p; }
    const matches = [];
    if (re.global) {
      for (const m of text.matchAll(re)) { if (m && m[0]) matches.push(m[0]); }
    } else {
      const m = text.match(re);
      if (m && m[0]) matches.push(m[0]);
    }
    if (matches.length) return matches[matches.length - 1];
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const line = lines.length ? lines[lines.length - 1] : '';
  if (line) return line.replace(/^[A-Za-z0-9_.-]+\s*=\s*/, '').trim();
  return '';
}

// TokenMix (tokenmix.ai) -- OpenAI-compatible relay used as the PRIMARY
// inference provider while the ASI1/Fetch.ai wallet is unfunded (2026-08-22).
// ASI1 remains wired as automatic fallback on TokenMix failure/exhaustion --
// see callAPI() below. Re-flip priority by setting LLM_PRIMARY_PROVIDER=asi1.
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
  return process.env.TOKENMIX_API_KEY || readTokenMixKeyFromSecrets() || '';
}

function resolveAnthropicApiKey() {
  return process.env.ANTHROPIC_API_KEY || '';
}

const TOKENMIX_API_KEY = resolveTokenMixApiKey();
const ANTHROPIC_API_KEY = resolveAnthropicApiKey();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 45000);
const OPENAI_MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS || 1600);
const TOKENMIX_BASE_URL = process.env.TOKENMIX_BASE_URL || "https://api.tokenmix.ai/v1/chat/completions";
// deepseek/deepseek-v4-flash is the verified-working cost/detail pick (confirmed
// live against api.tokenmix.ai on 2026-08-22: 200 OK, ~2s, clean JSON content).
const TOKENMIX_MODEL = process.env.TOKENMIX_MODEL || "deepseek/deepseek-v4-flash";
// DeepSeek V4 Flash is a *reasoning* model: with thinking on, completion tokens
// go to hidden reasoning first, and if max_tokens is too low, content comes
// back empty (finish_reason=length). Default thinking OFF for reliable JSON.
const TOKENMIX_ENABLE_THINKING = (() => {
  const v = String(process.env.TOKENMIX_ENABLE_THINKING || '0').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
})();
const TOKENMIX_MAX_TOKENS = Number(
  process.env.TOKENMIX_MAX_TOKENS || (TOKENMIX_ENABLE_THINKING ? 4500 : 1600)
);
const TOKENMIX_TIMEOUT_MS = Number(process.env.TOKENMIX_TIMEOUT_MS || 45000);
const TOKENMIX_FORCE_JSON = process.env.TOKENMIX_FORCE_JSON !== '0';
// TokenMix credit exhaustion (402 / "out of credits") cooldown before retrying.
const TOKENMIX_CREDIT_COOLDOWN_MS = Number(process.env.TOKENMIX_CREDIT_COOLDOWN_MS || 30 * 60 * 1000);
// Confirmed live 2026-08-22: TokenMix returns HTTP 403 (not 402) with
// "Account credits are temporarily unavailable while recent card payments
// are under review" when the account's payment method is flagged -- an
// account-level block, not a per-request one, so it needs the same cooldown
// as an explicit 402.
const TOKENMIX_CREDIT_RE = /\bhttp\s*40[23]\b|\bstatus(?:code)?[:\s]*40[23]\b|\bpayment required\b|\btokenmix(?:['’]s)?\s+(?:is\s+)?(?:out of|insufficient)\s+credits?\b|\binsufficient credits?\b|\bout of credits?\b|\bcredits?\s+exhausted\b|\bcredits?\s+(?:are\s+)?temporarily unavailable\b|\bcard payments?\s+are\s+under review\b/i;
// Primary/fallback ordering. 'tokenmix' tries TokenMix first, falls back to
// ASI1 on failure/cooldown. 'asi1' (default as of 2026-08-22) restores the
// pre-2026-08-22 order -- TokenMix's account is card-payment-blocked and
// couldn't be funded, so ASI1 is primary again until that clears.
const LLM_PRIMARY_PROVIDER = (
  process.env.LLM_PRIMARY_PROVIDER
  || (OPENAI_API_KEY ? 'openai' : 'asi1')
).toLowerCase();

// ── Inference layer: TokenMix primary, ASI1 fallback ────────────────────
// PR #86 (2026-08-19) made ASI1 the sole inference provider, removing
// TokenMix/xAI/OpenAI/Anthropic/Google/OpenRouter entirely. TokenMix was
// restored 2026-08-22 as the PRIMARY provider (ASI1/Fetch.ai wallet
// unfunded at the time) -- callAPI() below tries TokenMix first and falls
// back to ASI1 on failure/credit-exhaustion. xAI/OpenAI/Anthropic/Google/
// OpenRouter remain removed; only TokenMix came back. Set
// LLM_PRIMARY_PROVIDER=asi1 to flip the order back once ASI1 credits are
// funded again. ASI1's key resolution, full model roster (asi1-ultra /
// asi1 / asi1-mini / asi1-fast) and reasoning/planner-mode routing still
// live in ../infra/asi1-client.js and ./asi1-credit-orchestrator.js.

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
    this.provider = LLM_PRIMARY_PROVIDER === 'openai' && OPENAI_API_KEY ? "openai" : (LLM_PRIMARY_PROVIDER === 'anthropic' && ANTHROPIC_API_KEY ? "anthropic" : (LLM_PRIMARY_PROVIDER === 'tokenmix' && TOKENMIX_API_KEY ? "tokenmix" : "asi1"));
    this.openAIEnabled = !!OPENAI_API_KEY;
    this.anthropicEnabled = !!ANTHROPIC_API_KEY;
    this.tokenmixEnabled = !!TOKENMIX_API_KEY;
    this.enabled = this.openAIEnabled || this.anthropicEnabled || this.tokenmixEnabled || Asi1Client.hasAsi1Credentials();

    this.contextCache = new Map();      // short-lived prompt/result cache
    this.marketMemory = new Map();      // per-coin rolling recall memory
    this.queryHistory = [];             // rolling query log across all LLM providers
    this.queryStatsByProvider = Object.create(null);     // per-provider stats (calls, latency, errors)
    this.queryStatsByModel = Object.create(null);        // per-model stats (calls, latency, errors)
    // Circuit breaker: provider -> { until, reason }. ASI1 handles its own
    // multi-key/multi-model rotation internally (see asi1-client.js). TokenMix
    // uses this directly for 402/credit-exhaustion cooldowns (see
    // _isTokenmixInCooldown / _markTokenmixCooldown below).
    this._providerCooldowns = Object.create(null);
    this._tokenmixCreditExhausted = false;

    // Restore query history / market memory / cooldowns from disk (cold-start avoidance)
    try { this._hydratePersistedState(); } catch (_) { /* */ }
    this.envDiagnostics = {
      dotenvLoaded: LLM_ENV_SOURCES.length > 0,
      dotenvSources: LLM_ENV_SOURCES,
      hasAsi1Key: Asi1Client.hasAsi1Credentials(),
      asi1KeysConfigured: Asi1Client.getDiagnostics().keysConfigured,
      hasAnthropicKey: this.anthropicEnabled,
      hasTokenMixKey: this.tokenmixEnabled,
      hasOpenAIKey: this.openAIEnabled,
      primaryProvider: this.provider,
      providerOverride: null,
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

    console.log(
      `[LLMSignalAssistant] Initialized ${this.enabled ? "\u2713 ENABLED" : "\u26a0 DISABLED"} ` +
      `(primary=${this.provider}, anthropic=${this.anthropicEnabled ? `${ANTHROPIC_MODEL}` : 'no-key'}, tokenmix=${this.tokenmixEnabled ? `${TOKENMIX_MODEL}` : 'no-key'}, ` +
      `asi1-fallback=${Asi1Client.hasAsi1Credentials() ? 'yes' : 'no-key'}, roster=${Asi1Client.ASI1_ALL_MODELS.join("/")})`
    );
    if (this.envDiagnostics.dotenvLoaded) {
      console.log(`[LLMSignalAssistant] Loaded env from: ${this.envDiagnostics.dotenvSources.join(" | ")}`);
    }
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
      const baseUserPrompt = fiveMin
        ? generateFiveMinUserPrompt(snap)
        : isRange
          ? generateRangeUserPrompt(snap)
          : generateUserPrompt(snap);
      const rawUserPrompt = snap.prompt
        ? `${snap.prompt}\n\n--- Standard Market Snapshot ---\n${baseUserPrompt}`
        : baseUserPrompt;
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
   * ASI1-only. Pre-contract 15m/60m range calls use the deep/reasoning tier
   * (asi1-ultra by default, planner/reasoning mode enabled outside 5m ticks);
   * 5m PTB binaries use the fast tier (asi1-mini/asi1-fast) for latency. The
   * full official roster (asi1-ultra / asi1 / asi1-mini / asi1-fast) is
   * always available as an automatic in-call fallback chain -- see
   * asi1-credit-orchestrator.js#rosterFor.
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

    if (LLM_PRIMARY_PROVIDER === 'openai' && OPENAI_API_KEY && process.env.LLM_DISABLE_OPENAI !== '1') {
      const coinOpenAI = String(snapshot?.coin || 'GLOBAL');
      const horizonOpenAI = is5mPtb ? '5m-ptb' : String(snapshot?.horizon || snapshot?.horizonMinutes || '15m');
      const promptLengthOpenAI = (systemPrompt || '').length + (userPrompt || '').length;
      const startOpenAI = Date.now();
      try {
        console.log(`[LLM ${horizonOpenAI}] trying openai (${OPENAI_MODEL})`);
        const res = await this.callOpenAIAPI(systemPrompt, userPrompt, {});
        const parsed = this.parseLlmJsonContent(res.content, { provider: 'openai', rawText: res.content });
        parsed._provider = 'openai';
        parsed._model = res.model;
        this._recordQueryExecution({
          id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
          ts: Date.now(),
          coin: coinOpenAI,
          horizon: horizonOpenAI,
          provider: 'openai',
          model: res.model,
          status: 'SUCCESS',
          latencyMs: Date.now() - startOpenAI,
          promptChars: promptLengthOpenAI,
          responseChars: res.content.length,
          resultCall: parsed?.call || parsed?.direction || null,
          regime: parsed?.regime || null,
          confidence: parsed?.confidence ?? null,
          notes: parsed?.suggestions?.notes?.slice(0, 280) || null,
          attempted: ['openai'],
          skipped: [],
          error: null,
        });
        this._lastProvider = 'openai';
        this._lastModel = res.model;
        return this.normalizeResponse(parsed, snapshot);
      } catch (err) {
        this._recordQueryExecution({
          id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
          ts: Date.now(),
          coin: coinOpenAI,
          horizon: horizonOpenAI,
          provider: 'openai',
          model: OPENAI_MODEL,
          status: 'FAILURE',
          latencyMs: Date.now() - startOpenAI,
          promptChars: promptLengthOpenAI,
          responseChars: 0,
          resultCall: null,
          regime: null,
          confidence: null,
          notes: null,
          attempted: ['openai'],
          skipped: [],
          error: String(err.message || err),
        });
        console.warn(`[LLM ${horizonOpenAI}] openai failed, falling back: ${String(err.message || err).slice(0, 180)}`);
      }
    }

    // Anthropic-first: primary provider if configured
    if (LLM_PRIMARY_PROVIDER === 'anthropic' && ANTHROPIC_API_KEY && process.env.LLM_DISABLE_ANTHROPIC !== '1') {
      const coinAnt = String(snapshot?.coin || 'GLOBAL');
      const horizonAnt = is5mPtb ? '5m-ptb' : String(snapshot?.horizon || snapshot?.horizonMinutes || '15m');
      const promptLengthAnt = (systemPrompt || '').length + (userPrompt || '').length;
      const startAnt = Date.now();
      try {
        console.log(`[LLM ${horizonAnt}] trying anthropic (${ANTHROPIC_MODEL})`);
        const res = await this.callAnthropicAPI(systemPrompt, userPrompt, {});
        const parsed = this.parseLlmJsonContent(res.content, { provider: 'anthropic', rawText: res.content });
        parsed._provider = 'anthropic';
        parsed._model = res.model;
        this._recordQueryExecution({
          id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
          ts: Date.now(),
          coin: coinAnt,
          horizon: horizonAnt,
          provider: 'anthropic',
          model: res.model,
          status: 'SUCCESS',
          latencyMs: Date.now() - startAnt,
          promptChars: promptLengthAnt,
          responseChars: res.content.length,
          resultCall: parsed?.call || parsed?.direction || null,
          regime: parsed?.regime || null,
          confidence: parsed?.confidence ?? null,
          notes: parsed?.suggestions?.notes?.slice(0, 280) || null,
          attempted: ['anthropic'],
          skipped: [],
          error: null,
        });
        this._lastProvider = 'anthropic';
        this._lastModel = res.model;
        return this.normalizeResponse(parsed, snapshot);
      } catch (err) {
        this._recordQueryExecution({
          id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
          ts: Date.now(),
          coin: coinAnt,
          horizon: horizonAnt,
          provider: 'anthropic',
          model: ANTHROPIC_MODEL,
          status: 'FAILURE',
          latencyMs: Date.now() - startAnt,
          promptChars: promptLengthAnt,
          responseChars: 0,
          resultCall: null,
          regime: null,
          confidence: null,
          notes: null,
          attempted: ['anthropic'],
          skipped: [],
          error: String(err.message || err),
        });
        console.warn(`[LLM ${horizonAnt}] anthropic failed, falling back: ${String(err.message || err).slice(0, 180)}`);
      }
    }

    // TokenMix-first: primary provider while ASI1/Fetch.ai credits are
    // unfunded (see LLM_PRIMARY_PROVIDER, default 'tokenmix'). Falls through
    // to the existing ASI1 path below on any failure -- key missing, network
    // error, credit exhaustion (cooldown), or bad/empty response.
    if (LLM_PRIMARY_PROVIDER === 'tokenmix' && TOKENMIX_API_KEY && !this._isTokenmixInCooldown()
        && process.env.LLM_DISABLE_TOKENMIX !== '1') {
      const coinTm = String(snapshot?.coin || 'GLOBAL');
      const horizonTm = is5mPtb ? '5m-ptb' : String(snapshot?.horizon || snapshot?.horizonMinutes || '15m');
      const promptLengthTm = (systemPrompt || '').length + (userPrompt || '').length;
      const startTm = Date.now();
      try {
        console.log(`[LLM ${horizonTm}] trying tokenmix (${TOKENMIX_MODEL})`);
        const res = await this.callTokenMixAPI(systemPrompt, userPrompt, {});
        const parsed = this.parseLlmJsonContent(res.content, { provider: 'tokenmix', rawText: res.content });
        parsed._provider = 'tokenmix';
        parsed._model = res.model;
        this._recordQueryExecution({
          id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
          ts: Date.now(),
          coin: coinTm,
          horizon: horizonTm,
          provider: 'tokenmix',
          model: res.model,
          status: 'SUCCESS',
          latencyMs: Date.now() - startTm,
          promptChars: promptLengthTm,
          responseChars: res.content.length,
          resultCall: parsed?.call || parsed?.direction || null,
          regime: parsed?.regime || null,
          confidence: parsed?.confidence ?? null,
          notes: parsed?.suggestions?.notes?.slice(0, 280) || null,
          attempted: ['tokenmix'],
          skipped: [],
          error: null,
        });
        this._lastProvider = 'tokenmix';
        this._lastModel = res.model;
        return this.normalizeResponse(parsed, snapshot);
      } catch (err) {
        this._recordQueryExecution({
          id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
          ts: Date.now(),
          coin: coinTm,
          horizon: horizonTm,
          provider: 'tokenmix',
          model: TOKENMIX_MODEL,
          status: 'FAILURE',
          latencyMs: Date.now() - startTm,
          promptChars: promptLengthTm,
          responseChars: 0,
          resultCall: null,
          regime: null,
          confidence: null,
          notes: null,
          attempted: ['tokenmix'],
          skipped: [],
          error: String(err.message || err),
        });
        console.warn(`[LLM ${horizonTm}] tokenmix failed, falling back to asi1: ${String(err.message || err).slice(0, 180)}`);
      }
    }

    if (!Asi1Client.hasAsi1Credentials() || process.env.LLM_DISABLE_ASI1 === '1') {
      const coin = String(snapshot?.coin || 'GLOBAL');
      const horizon = is5mPtb ? '5m-ptb' : String(snapshot?.horizon || snapshot?.horizonMinutes || '15m');
      const deskMode = typeof Asi1CreditOrch.getMode === 'function' ? Asi1CreditOrch.getMode() : 'unknown';
      throw new Error(
        `[LLMSignalAssistant] ASI1 unavailable (coin=${coin} horizon=${horizon} deskMode=${deskMode}) -- `
        + `${process.env.LLM_DISABLE_ASI1 === '1' ? 'LLM_DISABLE_ASI1=1' : 'no ASI1 API key configured'}`
      );
    }

    // Pre-contract (15m/60m) fires two ASI1 tiers in parallel -- a fast/mini
    // short-horizon+order-book read and an ultra deep/reasoning regime read --
    // and merges them deterministically. Set LLM_RELAY_SPECIALIST_SPLIT=0 to
    // skip the split and just make one direct ASI1 call below.
    if (
      isPreContractRange
      && process.env.LLM_RELAY_SPECIALIST_SPLIT !== '0'
    ) {
      try {
        const meta = {
          coin: String(snapshot?.coin || 'GLOBAL'),
          horizon: String(snapshot?.horizon || snapshot?.horizonMinutes || '15m'),
          promptLength: (systemPrompt || '').length + (userPrompt || '').length,
        };
        const combined = await this._relaySpecialistSplit(snapshot, meta);
        // Scrub float trails (e.g. $75.44527553043135 -> $75.45) before return
        if (combined) return this.normalizeResponse(combined, snapshot);
      } catch (err) {
        console.warn(`[LLM] ASI1 specialist-split failed, falling back to single call: ${err.message}`);
      }
    }

    const coin = String(snapshot?.coin || 'GLOBAL');
    const horizon = is5mPtb ? '5m-ptb' : String(snapshot?.horizon || snapshot?.horizonMinutes || '15m');
    const promptLength = (systemPrompt || '').length + (userPrompt || '').length;
    const startTime = Date.now();

    try {
      // Pre-contract / range: asi1-ultra (deep/reasoning tier) with room for
      // full guidance notes and planner mode where the horizon allows it.
      // 5m ticks: faster mini/fast tier unless ASI1_5M_MODEL overrides.
      const preContract = isPreContractRange || snapshot?.preferAsi1 === true;
      const model = preContract
        ? (process.env.ASI1_PRECONTRACT_MODEL || process.env.ASI1_MODEL || 'asi1-ultra')
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
          // Always include the full official roster as an in-call fallback chain.
          candidateModels: Asi1CreditOrch.rosterFor({ model }),
          tier: preContract ? 'deep-insight' : 'quick-tick',
          temperature: 0.12,
          max_tokens: maxTokens,
          stream: false,
          response_format: { type: 'json_object' },
          web_search: preContract && process.env.ASI1_WEB_SEARCH === '1',
          plannerMode: typeof Asi1CreditOrch.plannerEnabled === 'function'
            && Asi1CreditOrch.plannerEnabled(horizon),
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
        attempted: ['asi1'],
        skipped: [],
        error: null,
      });
      this._lastProvider = 'asi1';
      this._lastModel = result.model || model;
      return parsed;
    } catch (err) {
      this._recordQueryExecution({
        id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        ts: Date.now(),
        coin,
        horizon,
        provider: 'asi1',
        model: 'asi1-ultra',
        status: 'FAILURE',
        latencyMs: Date.now() - startTime,
        promptChars: promptLength,
        responseChars: 0,
        resultCall: null,
        regime: null,
        confidence: null,
        notes: null,
        attempted: ['asi1'],
        skipped: [],
        error: String(err.message || err),
      });
      throw err;
    }
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

  // ── TokenMix (tokenmix.ai) provider ──────────────────────────────────────
  // Restored 2026-08-22 as primary provider while ASI1/Fetch.ai credits are
  // unfunded. Recovered from git history (commit a1276d1c^, the last version
  // before PR #86 removed it) rather than rewritten from scratch, including
  // the enable_thinking:false empty-content fix from commit 4410e5e6.

  _isTokenmixInCooldown() {
    if (this._tokenmixCreditExhausted) {
      const cd = this._providerCooldowns.tokenmix;
      if (cd && cd.until > Date.now()) return true;
      // Cooldown window elapsed -- allow a retry to see if credits landed.
      this._tokenmixCreditExhausted = false;
    }
    return false;
  }

  _markTokenmixCooldown(err) {
    const msg = String(err?.message || err || '');
    const status = Number(err?.status || err?.statusCode || 0);
    if (status !== 402 && !TOKENMIX_CREDIT_RE.test(msg)) return false;
    this._tokenmixCreditExhausted = true;
    this._providerCooldowns.tokenmix = {
      until: Date.now() + TOKENMIX_CREDIT_COOLDOWN_MS,
      reason: 'payment required (402) -- no credits on TokenMix account',
    };
    console.warn(`[TokenMix] credit exhaustion detected, cooling down ${Math.round(TOKENMIX_CREDIT_COOLDOWN_MS / 60000)}m: ${msg.slice(0, 160)}`);
    return true;
  }

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
      content = pick(msg.content) || pick(msg.reasoning_content) || pick(msg.reasoning)
        || pick(msg.output_text) || pick(msg.text);
    }
    if (!content && choice) {
      content = pick(choice.text) || pick(choice.content) || pick(choice.output);
    }
    if (!content) {
      content = pick(data.output_text) || pick(data.output) || pick(data.content)
        || pick(data.result) || pick(data.message?.content);
    }
    return String(content || '').trim();
  }

  /**
   * Generic OpenAI-compatible chat-completions caller, trimmed to what
   * TokenMix needs (no xAI/Google/Anthropic branches -- those providers stay
   * removed per PR #86; only TokenMix was asked back).
   */
  async callCompatibleAPI(systemPrompt, userPrompt, config = {}) {
    const url = config.url;
    const model = config.model;
    const key = config.key;
    const maxTokens = Number(config.maxTokens || 1500);
    const providerLabel = config.providerLabel || 'compatible';
    if (!key) throw new Error(`API key missing for ${providerLabel}`);
    if (!url) throw new Error(`API url missing for ${providerLabel}`);

    const payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      stream: false,
    };
    if (config.responseFormat) payload.response_format = config.responseFormat;
    if (typeof config.enableThinking === 'boolean') payload.enable_thinking = config.enableThinking;

    const controller = new AbortController();
    const timeoutMs = Number(config.timeoutMs || 45000);
    const timer = setTimeout(() => {
      try { controller.abort(new Error(`${providerLabel} timeout after ${timeoutMs}ms`)); }
      catch (_) { try { controller.abort(); } catch (_) {} }
    }, timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const err = new Error(
        `LLM API error ${response.status}: ${response.statusText}${errBody ? ` — ${errBody.slice(0, 220)}` : ''}`
      );
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const content = this.extractOpenAICompatibleContent(data);
    if (!content) {
      const choice = data?.choices?.[0] || null;
      const finish = choice?.finish_reason || 'unknown';
      const usage = data?.usage || {};
      const reasonTok = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? null;
      const keys = Object.keys(data || {}).slice(0, 12).join(',');
      throw new Error(
        `Unexpected LLM API response format (${providerLabel}) empty content`
        + ` finish=${finish} reasoning_tokens=${reasonTok} max_tokens=${maxTokens} keys=[${keys}]`
      );
    }
    return content;
  }

  /**
   * TokenMix -> DeepSeek V4 Flash (default). Retries: json->plain, and if
   * reasoning ate max_tokens (empty content), re-calls with
   * enable_thinking:false and a larger budget.
   */
  async callTokenMixAPI(systemPrompt, userPrompt, config = {}) {
    if (!TOKENMIX_API_KEY) throw new Error('TOKENMIX_API_KEY missing');
    if (this._isTokenmixInCooldown()) {
      throw new Error('TokenMix in credit-exhaustion cooldown');
    }
    const model = config.model || TOKENMIX_MODEL;
    const baseMaxTokens = Number(config.maxTokens || TOKENMIX_MAX_TOKENS);
    const timeoutMs = Number(config.timeoutMs || TOKENMIX_TIMEOUT_MS);
    const preferThinking = config.enableThinking != null ? !!config.enableThinking : TOKENMIX_ENABLE_THINKING;

    const jsonFirst = TOKENMIX_FORCE_JSON && preferThinking;
    const modeAttempts = jsonFirst
      ? [{ jsonMode: true }, { jsonMode: false }]
      : TOKENMIX_FORCE_JSON
        ? [{ jsonMode: false }, { jsonMode: true }]
        : [{ jsonMode: false }];

    const attempts = [
      ...modeAttempts.map((m) => ({ ...m, enableThinking: preferThinking, maxTokens: baseMaxTokens })),
      { jsonMode: false, enableThinking: false, maxTokens: Math.max(baseMaxTokens, 2000), rescue: true },
      { jsonMode: true, enableThinking: false, maxTokens: Math.max(baseMaxTokens, 2000), rescue: true },
    ];
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
        const content = await this.callCompatibleAPI(systemPrompt, userPrompt, {
          url: TOKENMIX_BASE_URL,
          model,
          key: TOKENMIX_API_KEY,
          maxTokens: attempt.maxTokens,
          timeoutMs,
          responseFormat: attempt.jsonMode ? { type: 'json_object' } : null,
          enableThinking: attempt.enableThinking,
          providerLabel: 'tokenmix',
        });
        return { content, model, thinking: attempt.enableThinking };
      } catch (err) {
        lastErr = err;
        this._markTokenmixCooldown(err);
        const msg = String(err?.message || err);
        const reasoningStarve = /empty content|reasoning_tokens|finish=length|Unexpected LLM API response format/i.test(msg);
        console.warn(
          `[TokenMix] attempt json=${attempt.jsonMode} think=${attempt.enableThinking}`
          + ` maxTok=${attempt.maxTokens}${attempt.rescue ? ' rescue' : ''} failed: ${msg.slice(0, 180)}`
        );
        if (/\b(401|402|403)\b/.test(msg)) break;
        if (!reasoningStarve && attempt.rescue) continue;
      }
    }
    throw lastErr || new Error('TokenMix DeepSeek failed');
  }

  async callOpenAIAPI(systemPrompt, userPrompt, config = {}) {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    const model = config.model || OPENAI_MODEL;
    const maxTokens = Number(config.maxTokens || OPENAI_MAX_TOKENS);
    const timeoutMs = Number(config.timeoutMs || OPENAI_TIMEOUT_MS);
    const content = await this.callCompatibleAPI(systemPrompt, userPrompt, {
      url: OPENAI_BASE_URL,
      model,
      key: OPENAI_API_KEY,
      maxTokens,
      timeoutMs,
      providerLabel: 'openai',
    });
    return { content, model };
  }

  async callAnthropicAPI(systemPrompt, userPrompt, config = {}) {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
    const model = config.model || ANTHROPIC_MODEL;
    const maxTokens = Number(config.maxTokens || 4096);
    const timeoutMs = Number(config.timeoutMs || 45000);

    const payload = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(new Error(`anthropic timeout after ${timeoutMs}ms`)); } catch (_) {}
    }, timeoutMs);

    let response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const err = new Error(`Anthropic API error ${response.status}: ${response.statusText} - ${errBody.slice(0, 220)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;
    if (!content) {
      throw new Error(`Unexpected Anthropic API response format: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return { content, model };
  }

  /**
   * Specialist-split inference router, ASI1-only across two tiers: the fast
   * tier (asi1-mini/asi1-fast) handles the quick, short-horizon+order-book
   * read; the ultra/deep-reasoning tier handles the 15m-60m regime +
   * pre-contract read. Each tier gets a role-specific prompt built from
   * inference-relay.js's microstructure packet, and the two legs are merged
   * deterministically (InferenceRelay.mergeLegsLocally) into one decisive
   * binary call -- no extra synthesis LLM call needed.
   */
  async _relaySpecialistSplit(snapshot, meta = {}) {
    const InferenceRelay = require('./inference-relay');
    const coin = meta.coin || snapshot?.coin || 'GLOBAL';
    const horizon = meta.horizon || '15m';
    const start = Date.now();

    const packet = InferenceRelay.buildMicrostructurePacket(snapshot);

    const shortModel = process.env.ASI1_RELAY_SHORT_MODEL || process.env.ASI1_QUICK_TICK_MODEL || 'asi1-mini';
    const shortPromise = Asi1Client.chatCompletion(
      [
        { role: 'system', content: InferenceRelay.specialistSystemShort() },
        { role: 'user', content: InferenceRelay.buildSpecialistUser(packet, 'short_ob') },
      ],
      {
        model: shortModel,
        candidateModels: Asi1CreditOrch.rosterFor({ model: shortModel }),
        tier: 'quick-tick',
        temperature: 0.12,
        max_tokens: Number(process.env.ASI1_RELAY_SHORT_MAX_TOKENS || 900),
        response_format: { type: 'json_object' },
        timeoutMs: Number(process.env.ASI1_RELAY_SHORT_TIMEOUT_MS || 30000),
      },
    ).then((result) => {
      const content = String(result.content || '').trim();
      const parsed = this.parseLlmJsonContent(content, { provider: 'asi1', rawText: content });
      return { ok: true, parsed, model: result.model || shortModel, ms: Date.now() - start };
    }).catch((err) => ({ ok: false, error: err, ms: Date.now() - start }));

    const longModel = process.env.ASI1_PRECONTRACT_MODEL || process.env.ASI1_MODEL || 'asi1-ultra';
    const longPromise = Asi1Client.chatCompletion(
      [
        { role: 'system', content: InferenceRelay.specialistSystemLong() },
        { role: 'user', content: InferenceRelay.buildSpecialistUser(packet, 'medium_long') },
      ],
      {
        model: longModel,
        candidateModels: Asi1CreditOrch.rosterFor({ model: longModel }),
        tier: 'deep-insight',
        temperature: 0.12,
        max_tokens: Number(process.env.ASI1_PRECONTRACT_MAX_TOKENS || 1600),
        response_format: { type: 'json_object' },
        web_search: process.env.ASI1_WEB_SEARCH === '1',
        plannerMode: typeof Asi1CreditOrch.plannerEnabled === 'function'
          && Asi1CreditOrch.plannerEnabled(horizon),
        timeoutMs: Number(process.env.ASI1_PRECONTRACT_TIMEOUT_MS || 55000),
      },
    ).then((result) => {
      const content = String(result.content || '').trim();
      const parsed = this.parseLlmJsonContent(content, { provider: 'asi1', rawText: content });
      return { ok: true, parsed, model: result.model || longModel, ms: Date.now() - start };
    }).catch((err) => ({ ok: false, error: err, ms: Date.now() - start }));

    const [shortRes, longRes] = await Promise.all([shortPromise, longPromise]);

    if (!shortRes.ok && !longRes.ok) {
      throw (longRes.error || shortRes.error || new Error(
        `relay: both ASI1 specialist legs failed (coin=${coin} horizon=${horizon} `
        + `shortModel=${shortModel} longModel=${longModel})`
      ));
    }

    const shortLeg = shortRes.ok ? shortRes.parsed : null;
    const longLeg = longRes.ok ? longRes.parsed : null;
    const merged = InferenceRelay.mergeLegsLocally(packet, shortLeg, longLeg);

    for (const [role, res, model] of [['short_ob', shortRes, shortModel], ['medium_long', longRes, longModel]]) {
      this._recordQueryExecution({
        id: `llm-relay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        ts: Date.now(),
        coin,
        horizon,
        provider: 'asi1',
        model: res.model || model,
        status: res.ok ? 'SUCCESS' : 'FAILURE',
        latencyMs: res.ms || 0,
        resultCall: res.ok ? (res.parsed?.call || null) : null,
        confidence: res.ok ? (res.parsed?.confidence ?? null) : null,
        error: res.ok ? null : String(res.error?.message || res.error || 'failed'),
        relaySpecialistSplit: true,
        relayRole: role,
      });
    }

    this._lastProvider = 'asi1';
    this._lastModel = `asi1:${shortRes.model || shortModel}+asi1:${longRes.model || longModel}`;
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
      const marketMemory = Object.create(null);
      for (const [k, rows] of this.marketMemory.entries()) {
        marketMemory[k] = (rows || []).slice(-12);
      }
      const contextCache = Object.create(null);
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

    let newWeights = Object.assign(Object.create(null), currentWeights);
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
    const asi1Diag = (() => { try { return Asi1Client.getDiagnostics(); } catch (_) { return {}; } })();
    const currentAccount = asi1Diag.currentAccount || 'mauro@leaksnipe.win';
    const currentAccountId = asi1Diag.currentAccountId || 'leaksnipe';
    return {
      enabled: this.enabled,
      provider: lastProvider || this.provider,
      lastProvider,
      lastModel,
      currentAccount: currentAccountId,
      // Measured from actual request round-trips (asi1-client.js), not assumed —
      // the direct-punch route can silently fall back to a slow tunnel.
      currentAccount,
      currentAccountId,
      routeMode: asi1Diag.routeMode || 'unknown',
      lastLatencyMs: asi1Diag.lastLatencyMs ?? null,
      api_url: this.enabled ? "https://api.asi1.ai/v1" : "disabled",
      model: this.enabled ? (lastModel || "asi1-ultra") : "disabled",
      // ASI1-only: pre-contract 15m/60m uses the deep/ultra tier, 5m PTB uses mini/fast.
      asi1DeskMode: typeof Asi1CreditOrch.getMode === 'function' ? Asi1CreditOrch.getMode() : null,
      preContractProvider: Asi1Client.hasAsi1Credentials() ? "asi1" : null,
      fiveMinuteProvider: Asi1Client.hasAsi1Credentials() ? "asi1" : null,
      fiveMinuteModel: Asi1Client.hasAsi1Credentials() ? "asi1-mini" : null,
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

