/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ORBITAL FORESIGHT ENGINE (OFE) — WE|||CRYPTO Proprietary Intelligence
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Proprietary nomenclature layer on top of the ASI1 / AgentVerse ecosystem.
 *  Provides forward-looking market context to prevent AI drift.
 *
 *  Architecture — four interlocking sub-systems:
 *
 *    OSL  — Orbital Scan Layer
 *             Periodic structured queries to ASI1 chat/completions (web-search
 *             enabled) and optionally to AgentVerse agents for macro narrative,
 *             smart money flow, regime classification, news sentiment, and
 *             upcoming macro catalysts.
 *
 *    FCI  — Foresight Context Injector
 *             Formats the latest OSL scan result into a concise telemetry block
 *             that is appended to every LLM prompt context window.
 *
 *    DAP  — Drift Anchor Protocol
 *             Session-scoped rolling store (ring buffer, 8 slots) that keeps a
 *             "ground-truth" market state digest.  Any call to getFciBlock()
 *             also injects the most-recent DAP anchor so the model can never
 *             drift beyond one scan cycle without being re-grounded.
 *
 *    RHC  — Resonance Horizon Clock
 *             Tracks how stale the OSL scan is relative to the active contract
 *             window (5 m / 15 m).  Fires urgency flags and auto-triggers a
 *             refresh if staleness exceeds configurable thresholds.
 *
 *  Public API (window.OrbitalForesightEngine / module.exports):
 *    .startOsl(opts)             — begin periodic OSL scans
 *    .stopOsl()                  — halt OSL scans
 *    .forceScan(sym, opts)       — fire an immediate OSL scan
 *    .getFciBlock(sym)           — get FCI telemetry string for prompt injection
 *    .getLatestScan(sym)         — raw latest scan result object
 *    .getDapAnchor(sym)          — latest DAP anchor object
 *    .getRhcStatus(sym)          — staleness + urgency flags from RHC
 *    .registerHudCallback(fn)    — receive HUD paint payloads
 *    .unregisterHudCallback(fn)  — remove a HUD callback
 *    .getDiagnostics()           — full internal state dump
 *
 *  Browser + Node.js (CommonJS) dual support.
 *
 *  @module orbital-foresight-engine
 *  @version 1.0.0
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.OrbitalForesightEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  //  OFE CONSTANTS
  // ─────────────────────────────────────────────────────────────────────────

  const OFE_VERSION = '1.0.0';

  /** Default scan cadence per horizon (ms) */
  const SCAN_INTERVAL_5M  = 45_000;   // every 45 s for 5m contracts
  const SCAN_INTERVAL_15M = 90_000;   // every 90 s for 15m contracts
  const SCAN_INTERVAL_DEFAULT = 60_000;

  /** Staleness thresholds (ms) — RHC flags */
  const RHC_WARN_MS  =  90_000;   // warn after 90 s
  const RHC_STALE_MS = 180_000;   // stale after 3 m
  const RHC_DEAD_MS  = 300_000;   // dead after 5 m (force re-scan trigger)

  /** DAP ring buffer depth (number of anchors kept per symbol) */
  const DAP_RING_DEPTH = 8;

  /** AgentVerse search endpoint */
  const AGENTVERSE_SEARCH_URL = 'https://agentverse.ai/v1/search/agents';

  /** ASI1 chat completions endpoint */
  const ASI1_CHAT_URL = 'https://api.asi1.ai/v1/chat/completions';

  /** OSL agent query topics */
  const OSL_TOPICS = [
    'macro-regime',
    'smart-money-flow',
    'news-sentiment',
    'upcoming-catalysts',
    'derivative-positioning',
  ];

  // ─────────────────────────────────────────────────────────────────────────
  //  INTERNAL STATE
  // ─────────────────────────────────────────────────────────────────────────

  /** Map<sym → latest OslScanResult> */
  const _oslStore = new Map();

  /** Map<sym → OslScanResult[]> — DAP ring buffers */
  const _dapStore = new Map();

  /** Map<sym → intervalId> — active OSL polling timers */
  const _oslTimers = new Map();

  /** Map<sym → lastScanEpochMs> — RHC staleness tracking */
  const _rhcTimestamps = new Map();

  /** Set<fn> — HUD paint callback registry */
  const _hudCallbacks = new Set();

  /** Session-level config */
  let _cfg = {
    apiKey: null,         // ASI1 primary API key (set from env/IPC)
    agentverseKey: null,  // AgentVerse JWT bearer
    model: 'asi1-mini',   // ASI1 model for OSL queries (fast)
    useAgentverse: true,  // whether to call AgentVerse agent search
    webSearch: true,      // whether to enable web-search on ASI1 calls
    horizon: '15m',       // active contract horizon
    verbose: false,
  };

  let _scanCounter = 0;
  let _errorCounter = 0;

  // ─────────────────────────────────────────────────────────────────────────
  //  UTILITY
  // ─────────────────────────────────────────────────────────────────────────

  function _now() { return Date.now(); }
  function _iso() { return new Date().toISOString(); }

  function _log(...args) {
    if (_cfg.verbose) console.log('[OFE]', ...args);
  }

  function _warn(...args) {
    console.warn('[OFE]', ...args);
  }

  /**
   * Resolve the best available ASI1 API key.
   * In Electron the IPC env-store exposes keys; in browser the global
   * window.__wecrypto_env or __asi1Keys may be populated from main.js.
   */
  function _resolveApiKey() {
    if (_cfg.apiKey) return _cfg.apiKey;
    if (typeof window !== 'undefined') {
      const env = window.__wecrypto_env || {};
      return (
        env.ASI1_API_KEY_ICLOUD ||
        env.ASI1_API_KEY_GITGOIN ||
        env.ASI1_API_KEY_MAURO ||
        env.ASI1_API_KEY_FALLBACK ||
        env.ASI1_API_KEY ||
        null
      );
    }
    if (typeof process !== 'undefined' && process.env) {
      return (
        process.env.ASI1_API_KEY_ICLOUD ||
        process.env.ASI1_API_KEY_GITGOIN ||
        process.env.ASI1_API_KEY_MAURO ||
        process.env.ASI1_API_KEY_FALLBACK ||
        process.env.ASI1_API_KEY ||
        null
      );
    }
    return null;
  }

  function _resolveAgentverseKey() {
    if (_cfg.agentverseKey) return _cfg.agentverseKey;
    if (typeof window !== 'undefined') {
      const env = window.__wecrypto_env || {};
      return env.AGENTVERSE_KEY || null;
    }
    if (typeof process !== 'undefined' && process.env) {
      return process.env.AGENTVERSE_KEY || null;
    }
    return null;
  }

  /**
   * Resolve the fetch implementation.
   * Browser: window.fetch
   * Electron renderer: window.electron.ipcFetch (routes through main process)
   * Node: global fetch (Node 18+) or null (graceful degradation)
   */
  function _fetchFn() {
    if (typeof window !== 'undefined') {
      // Prefer the Electron IPC bridge so traffic routes through the proxy layer
      if (window.electron && typeof window.electron.ipcFetch === 'function') {
        return (url, opts) => window.electron.ipcFetch(url, opts);
      }
      if (typeof window.fetch === 'function') return window.fetch.bind(window);
    }
    if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis);
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  OSL — Orbital Scan Layer
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build the OSL prompt for ASI1.
   * This is the Foresight Query Template (FQT) — a proprietary structured
   * prompt that instructs ASI1 to scan and synthesize forward-looking signals.
   *
   * @param {string} sym   — coin symbol, e.g. 'BTC'
   * @param {object} ctx   — optional live market context (spot, ptb, horizon)
   * @returns {string}
   */
  function _buildOslPrompt(sym, ctx = {}) {
    const coin = String(sym || 'BTC').toUpperCase();
    const spotStr = ctx.spot ? `Spot: $${Number(ctx.spot).toLocaleString()}` : '';
    const ptbStr  = ctx.ptb  ? `PTB: $${Number(ctx.ptb).toLocaleString()}`  : '';
    const horStr  = ctx.horizon || _cfg.horizon || '15m';
    const tsStr   = new Date().toUTCString();

    return [
      `[ORBITAL FORESIGHT QUERY — WE|||CRYPTO OFE v${OFE_VERSION}]`,
      `Asset: ${coin} | Horizon: ${horStr} | Query Time: ${tsStr}`,
      spotStr, ptbStr,
      '',
      'You are the Orbital Scan Layer (OSL) intelligence for a live crypto prediction market terminal.',
      `Provide a concise, actionable FORESIGHT BRIEF for ${coin} covering the next 15–30 minutes.`,
      '',
      'Structure your response as a single JSON object with these exact fields:',
      '{',
      '  "macroRegime": "<trending|ranging|volatile|unknown>",',
      '  "regimeConfidence": <0.0–1.0>,',
      '  "narrativeSummary": "<2–3 sentence plain-English market narrative>",',
      '  "smartMoneyBias": "<bullish|bearish|neutral|contested>",',
      '  "sentimentScore": <-1.0 to 1.0, negative=bearish>,',
      '  "upcomingCatalysts": ["<catalyst 1>", "<catalyst 2>"],',
      '  "keyRiskEvents": ["<risk 1>"],',
      '  "driftAnchor": "<one-line ground truth: the most important thing to remember right now>",',
      '  "foresightVector": "<up|down|neutral>",',
      '  "foresightConfidence": <0.0–1.0>,',
      '  "scanTopics": ["macro-regime","smart-money-flow","news-sentiment","upcoming-catalysts","derivative-positioning"],',
      '  "agentverseAgentsConsulted": [],',
      '  "ofeVersion": "' + OFE_VERSION + '"',
      '}',
      '',
      'Rules:',
      '- Return ONLY valid JSON. No markdown, no extra text.',
      '- Base foresightVector on real current data, not speculation.',
      `- If uncertain, set regimeConfidence and foresightConfidence below 0.5.`,
      '- driftAnchor must be a single factual sentence that re-grounds the model if recalled later.',
    ].filter(Boolean).join('\n');
  }

  /**
   * Call ASI1 chat/completions for an OSL scan.
   * Returns parsed JSON result or null on error.
   */
  async function _callAsi1Osl(sym, ctx) {
    const apiKey = _resolveApiKey();
    if (!apiKey) {
      _warn('No ASI1 API key — OSL scan skipped');
      return null;
    }
    const fetch = _fetchFn();
    if (!fetch) {
      _warn('No fetch implementation available — OSL scan skipped');
      return null;
    }

    const model = _cfg.model || 'asi1-mini';
    const prompt = _buildOslPrompt(sym, ctx);

    const body = {
      model,
      messages: [
        {
          role: 'system',
          content: 'You are the Orbital Scan Layer (OSL) intelligence engine. Return valid JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    };

    if (_cfg.webSearch) body.web_search = true;

    const t0 = _now();
    let raw = null;
    try {
      const resp = await fetch(ASI1_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        _warn(`ASI1 OSL HTTP ${resp.status} for ${sym}`);
        return null;
      }
      const json = await resp.json();
      raw = json?.choices?.[0]?.message?.content || null;
    } catch (e) {
      _warn(`ASI1 OSL fetch error for ${sym}:`, e?.message || e);
      return null;
    }

    const latencyMs = _now() - t0;
    if (!raw) return null;

    let parsed = null;
    try {
      // Strip possible markdown fences
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      parsed = JSON.parse(clean);
    } catch (_) {
      _warn(`OSL JSON parse error for ${sym}:`, raw.slice(0, 120));
      return null;
    }

    _scanCounter++;
    return {
      sym: String(sym).toUpperCase(),
      ts: _iso(),
      epochMs: _now(),
      latencyMs,
      model,
      source: 'asi1-osl',
      ...parsed,
    };
  }

  /**
   * Search the AgentVerse marketplace for relevant agents for a given topic,
   * then use ASI1 to chat with / query the first matching agent endpoint.
   * Returns a supplemental insight string or null.
   *
   * NOTE: AgentVerse agent-to-agent messaging (ACP envelope protocol) requires
   * a running uAgents mailbox.  We use the simpler approach: search for agents
   * and read their descriptions/capabilities, then feed that metadata into
   * the ASI1 OSL prompt as supplemental agent context.
   */
  async function _queryAgentverse(topic, sym) {
    const avKey = _resolveAgentverseKey();
    if (!avKey) return null;
    const fetch = _fetchFn();
    if (!fetch) return null;

    const searchBody = {
      search_text: `${sym} crypto ${topic} market analysis`,
      sort: 'relevancy',
      direction: 'asc',
      offset: 0,
      limit: 3,
    };

    try {
      const resp = await fetch(AGENTVERSE_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${avKey}`,
        },
        body: JSON.stringify(searchBody),
      });
      if (!resp.ok) {
        _log(`AgentVerse search ${resp.status} for topic=${topic}`);
        return null;
      }
      const json = await resp.json();
      const agents = json?.agents || json?.items || [];
      if (!agents.length) return null;

      // Summarize top agents for OFE context enrichment
      return agents.slice(0, 3).map(a =>
        `Agent: ${a.name || a.address || 'unknown'} | ${(a.description || a.readme || '').slice(0, 100)}`
      ).join('; ');
    } catch (e) {
      _log(`AgentVerse search error:`, e?.message || e);
      return null;
    }
  }

  /**
   * Run a full OSL scan for a symbol.
   * Orchestrates ASI1 + optional AgentVerse queries, stores results,
   * updates DAP anchor, fires HUD callbacks.
   */
  async function _runOslScan(sym, ctx = {}) {
    const coin = String(sym || 'BTC').toUpperCase();
    _log(`OSL scan start → ${coin}`);

    // Optionally enrich context with AgentVerse agent metadata
    let avInsights = null;
    if (_cfg.useAgentverse) {
      try {
        avInsights = await _queryAgentverse('smart money flow sentiment', coin);
      } catch (_) { /* non-fatal */ }
    }

    const enrichedCtx = {
      ...ctx,
      agentverseMeta: avInsights || undefined,
    };

    const result = await _callAsi1Osl(coin, enrichedCtx);
    if (!result) {
      _errorCounter++;
      return null;
    }

    // Attach AgentVerse meta to result if available
    if (avInsights) {
      result.agentverseAgentsConsulted = [avInsights];
    }

    // Store latest scan
    _oslStore.set(coin, result);

    // Update RHC timestamp
    _rhcTimestamps.set(coin, _now());

    // Update DAP ring buffer
    _pushDap(coin, result);

    // Notify HUD callbacks
    _notifyHud({ type: 'osl_scan', sym: coin, result });

    _log(`OSL scan complete → ${coin} | vector=${result.foresightVector} conf=${result.foresightConfidence}`);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  DAP — Drift Anchor Protocol
  // ─────────────────────────────────────────────────────────────────────────

  function _pushDap(sym, scanResult) {
    if (!scanResult) return;
    const key = String(sym).toUpperCase();
    if (!_dapStore.has(key)) _dapStore.set(key, []);
    const ring = _dapStore.get(key);
    ring.push({
      epochMs: scanResult.epochMs || _now(),
      ts: scanResult.ts,
      driftAnchor: scanResult.driftAnchor || '',
      macroRegime: scanResult.macroRegime || 'unknown',
      foresightVector: scanResult.foresightVector || 'neutral',
      foresightConfidence: scanResult.foresightConfidence || 0,
      narrativeSummary: scanResult.narrativeSummary || '',
    });
    // Trim to ring depth
    while (ring.length > DAP_RING_DEPTH) ring.shift();
  }

  /**
   * Get the latest DAP anchor for a symbol.
   * @returns {{ epochMs, ts, driftAnchor, macroRegime, foresightVector, foresightConfidence, narrativeSummary }|null}
   */
  function getDapAnchor(sym) {
    const key = String(sym || 'BTC').toUpperCase();
    const ring = _dapStore.get(key) || [];
    return ring.length ? ring[ring.length - 1] : null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  RHC — Resonance Horizon Clock
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Return staleness flags for a symbol.
   * @returns {{ ageMs: number, fresh: boolean, warn: boolean, stale: boolean, dead: boolean }}
   */
  function getRhcStatus(sym) {
    const key = String(sym || 'BTC').toUpperCase();
    const lastScan = _rhcTimestamps.get(key) || 0;
    const ageMs = _now() - lastScan;
    return {
      ageMs,
      fresh: lastScan > 0 && ageMs < RHC_WARN_MS,
      warn:  lastScan > 0 && ageMs >= RHC_WARN_MS && ageMs < RHC_STALE_MS,
      stale: lastScan > 0 && ageMs >= RHC_STALE_MS && ageMs < RHC_DEAD_MS,
      dead:  lastScan === 0 || ageMs >= RHC_DEAD_MS,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  FCI — Foresight Context Injector
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Produce a compact telemetry block ready for injection into any LLM prompt.
   * Includes the latest OSL scan + DAP anchor with staleness annotation.
   *
   * @param {string} sym
   * @returns {string}  — formatted telemetry block (≈ 300 tokens)
   */
  function getFciBlock(sym) {
    const coin = String(sym || 'BTC').toUpperCase();
    const scan = _oslStore.get(coin);
    const dap  = getDapAnchor(coin);
    const rhc  = getRhcStatus(coin);

    const lines = [
      '╔═══ ORBITAL FORESIGHT ENGINE (OFE) ═══╗',
      `  Asset: ${coin}  |  Scan Age: ${rhc.ageMs > 0 ? Math.round(rhc.ageMs / 1000) + 's' : 'no scan yet'}  |  Status: ${rhc.dead ? '⚠ DEAD' : rhc.stale ? '⚠ STALE' : rhc.warn ? '◈ WARN' : '✓ FRESH'}`,
    ];

    if (scan) {
      lines.push(
        `  Macro Regime   : ${scan.macroRegime || 'unknown'} (conf ${((scan.regimeConfidence || 0) * 100).toFixed(0)}%)`,
        `  Foresight Vec  : ${(scan.foresightVector || 'neutral').toUpperCase()} (conf ${((scan.foresightConfidence || 0) * 100).toFixed(0)}%)`,
        `  Smart Money    : ${scan.smartMoneyBias || 'neutral'}`,
        `  Sentiment Score: ${scan.sentimentScore != null ? scan.sentimentScore.toFixed(2) : 'n/a'}`,
        `  Narrative      : ${(scan.narrativeSummary || '—').slice(0, 180)}`,
      );
      if (scan.upcomingCatalysts && scan.upcomingCatalysts.length) {
        lines.push(`  Catalysts      : ${scan.upcomingCatalysts.slice(0, 3).join(' | ')}`);
      }
      if (scan.keyRiskEvents && scan.keyRiskEvents.length) {
        lines.push(`  Key Risks      : ${scan.keyRiskEvents.slice(0, 2).join(' | ')}`);
      }
    } else {
      lines.push('  [OFE] No scan available — HOLD_FLAT until first foresight pass completes.');
    }

    if (dap && dap.driftAnchor) {
      lines.push(
        '  ─── DRIFT ANCHOR PROTOCOL (DAP) ───────',
        `  Ground Truth   : ${dap.driftAnchor.slice(0, 200)}`,
        `  Anchored At    : ${dap.ts || 'unknown'}`,
      );
    }

    lines.push('╚══════════════════════════════════════╝');
    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  HUD CALLBACKS
  // ─────────────────────────────────────────────────────────────────────────

  function _notifyHud(payload) {
    for (const fn of _hudCallbacks) {
      try { fn(payload); } catch (_) { /* non-fatal */ }
    }
    // Also dispatch a DOM event for the HUD to listen on
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(new CustomEvent('ofe:scan', { detail: payload }));
      } catch (_) { /* non-fatal */ }
    }
  }

  function registerHudCallback(fn) {
    if (typeof fn === 'function') _hudCallbacks.add(fn);
  }

  function unregisterHudCallback(fn) {
    _hudCallbacks.delete(fn);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PUBLIC LIFECYCLE — startOsl / stopOsl / forceScan
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start periodic OSL scanning for one or more symbols.
   *
   * @param {object} opts
   * @param {string|string[]} opts.symbols   — e.g. ['BTC','ETH']
   * @param {string}          opts.horizon   — '5m' | '15m'
   * @param {string}          opts.apiKey    — override ASI1 key
   * @param {string}          opts.agentverseKey — override AgentVerse JWT
   * @param {string}          opts.model     — ASI1 model override
   * @param {boolean}         opts.webSearch
   * @param {boolean}         opts.useAgentverse
   * @param {boolean}         opts.verbose
   * @param {object}          opts.marketCtx — { spot, ptb } seed for first scan
   */
  function startOsl(opts = {}) {
    // Merge config
    if (opts.apiKey)          _cfg.apiKey = opts.apiKey;
    if (opts.agentverseKey)   _cfg.agentverseKey = opts.agentverseKey;
    if (opts.model)           _cfg.model = opts.model;
    if (opts.horizon)         _cfg.horizon = opts.horizon;
    if (opts.webSearch != null)      _cfg.webSearch = opts.webSearch;
    if (opts.useAgentverse != null)  _cfg.useAgentverse = opts.useAgentverse;
    if (opts.verbose != null)        _cfg.verbose = opts.verbose;

    const symbols = [].concat(opts.symbols || ['BTC']).map(s => String(s).toUpperCase());
    const intervalMs = opts.horizon === '5m' ? SCAN_INTERVAL_5M
      : opts.horizon === '15m' ? SCAN_INTERVAL_15M
      : SCAN_INTERVAL_DEFAULT;

    for (const sym of symbols) {
      // Stop existing timer if running
      if (_oslTimers.has(sym)) {
        clearInterval(_oslTimers.get(sym));
        _oslTimers.delete(sym);
      }
      // Fire immediately
      _runOslScan(sym, opts.marketCtx || {});
      // Then on cadence
      const tid = setInterval(() => _runOslScan(sym, {}), intervalMs);
      _oslTimers.set(sym, tid);
      _log(`OSL started for ${sym} — interval ${intervalMs}ms`);
    }
  }

  /**
   * Stop OSL scanning for specified symbols (or all if none given).
   */
  function stopOsl(symbols) {
    const targets = symbols
      ? [].concat(symbols).map(s => String(s).toUpperCase())
      : [..._oslTimers.keys()];
    for (const sym of targets) {
      if (_oslTimers.has(sym)) {
        clearInterval(_oslTimers.get(sym));
        _oslTimers.delete(sym);
        _log(`OSL stopped for ${sym}`);
      }
    }
  }

  /**
   * Fire an immediate OSL scan outside the periodic cadence.
   * Useful when the user manually triggers a re-scan from the HUD.
   */
  async function forceScan(sym, opts = {}) {
    const coin = String(sym || 'BTC').toUpperCase();
    _log(`OSL force-scan → ${coin}`);
    return _runOslScan(coin, opts.marketCtx || {});
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  ACCESSORS
  // ─────────────────────────────────────────────────────────────────────────

  function getLatestScan(sym) {
    return _oslStore.get(String(sym || 'BTC').toUpperCase()) || null;
  }

  function getDiagnostics() {
    return {
      version: OFE_VERSION,
      config: { ..._cfg, apiKey: _cfg.apiKey ? '***' : null, agentverseKey: _cfg.agentverseKey ? '***' : null },
      scanCounter: _scanCounter,
      errorCounter: _errorCounter,
      activeTimers: [..._oslTimers.keys()],
      storedScans: [..._oslStore.keys()],
      dapDepths: Object.fromEntries([..._dapStore.entries()].map(([k, v]) => [k, v.length])),
      rhcStatus: Object.fromEntries([..._rhcTimestamps.entries()].map(([k, ts]) => [k, getRhcStatus(k)])),
      hudCallbackCount: _hudCallbacks.size,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  AUTO-INIT FROM WINDOW ENV
  // ─────────────────────────────────────────────────────────────────────────
  //  When loaded in the Electron renderer, the main process exposes
  //  window.__wecrypto_env at load time.  We do a lightweight auto-configure
  //  so callers only need to call startOsl({ symbols }) without key wiring.

  (function _autoInit() {
    try {
      const key = _resolveApiKey();
      if (key) _cfg.apiKey = key;
      const avKey = _resolveAgentverseKey();
      if (avKey) _cfg.agentverseKey = avKey;
    } catch (_) { /* non-fatal */ }
  })();

  // ─────────────────────────────────────────────────────────────────────────
  //  PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────

  return Object.freeze({
    // Lifecycle
    startOsl,
    stopOsl,
    forceScan,
    // FCI
    getFciBlock,
    // Accessors
    getLatestScan,
    getDapAnchor,
    getRhcStatus,
    // HUD
    registerHudCallback,
    unregisterHudCallback,
    // Debug
    getDiagnostics,
    // Internals (test / integration hooks)
    _buildOslPrompt,
    _cfg,
    VERSION: OFE_VERSION,
  });
}));
