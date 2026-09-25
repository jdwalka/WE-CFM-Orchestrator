/**
 * ASI1 Desk — docked economy panel.
 * Modes: ASI1-only (save TokenMix) / dual-fire / planner (15m+ only).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.Asi1Desk) return;
  if (window._deskSubscribed) return;
  window._deskSubscribed = true;
  const escapeHTML = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const fallbackPriceDecimals = (coin) => {
    const key = String(coin || '').toUpperCase();
    if (key === 'DOGE') return 7;
    if (key === 'SOL' || key === 'HYPE' || key === 'XRP') return 4;
    return 2;
  };
  const fallbackFormatPrice = (coin, value) => {
    const decimals = fallbackPriceDecimals(coin);
    return Number(value).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  };
  const MODE_KEY = 'wecrypto.asi1Desk.mode';
  const MIN_KEY = 'wecrypto.asi1Desk.minimized';
  const MODEL_KEY = 'wecrypto.asi1Desk.model';
  const REASONING_KEY = 'wecrypto.asi1Desk.reasoningEffort';
  const WEBSEARCH_KEY = 'wecrypto.asi1Desk.webSearch';
  const HORIZON_KEY = 'wecrypto.asi1Desk.horizon';
  const PROMPT_CACHE_KEY = 'wecrypto.asi1Desk.customPrompt';
  const ANSWER_CACHE_KEY = 'wecrypto.asi1Desk.customAnswer';
  const SESSION_ID_KEY = 'wecrypto.asi1Desk.sessionId';
  const newDeskSessionId = () => {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return `asi1-desk-${Date.now()}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  };

  const dash = document.createElement('div');
  dash.id = 'asi1-desk';
  dash.innerHTML = `
    <style>
      #asi1-desk{position:fixed;top:78px;right:16px;width:min(360px,calc(100vw - 32px));z-index:8985;
        background:#111318;border:1px solid #1e2129;border-radius:12px;color:#e6e8eb;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 8px 24px #000a;
        max-height:min(78vh,820px);display:flex;flex-direction:column;overflow:hidden}
      #asi1-desk .ad-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #1e2129}
      #asi1-desk .ad-title{font-size:13px;font-weight:700;letter-spacing:.04em;color:#00d4ff}
      #asi1-desk .ad-modes{display:flex;gap:4px}
      #asi1-desk .ad-mode,#asi1-desk .ad-min{background:transparent;border:1px solid #2a2f38;color:#8b929a;
        font-size:10px;padding:3px 7px;border-radius:6px;cursor:pointer}
      #asi1-desk .ad-mode.active{background:#0088aa;color:#fff;border-color:transparent}
      #asi1-desk .ad-body{padding:10px 12px;overflow:auto}
      #asi1-desk .ad-row{display:flex;justify-content:space-between;gap:8px;font-size:11px;margin:3px 0}
      #asi1-desk .ad-k{color:#8b929a}
      #asi1-desk .ad-v{font-family:Consolas,Menlo,monospace}
      #asi1-desk .ad-pills{display:flex;flex-direction:column;gap:6px;margin:8px 0}
      #asi1-desk .ad-pill{display:flex;align-items:center;gap:8px;background:#0a0b0e;border:1px solid #1e2129;border-radius:6px;padding:6px 8px;font-size:11px}
      #asi1-desk .ad-dot{width:8px;height:8px;border-radius:50%;background:#8b929a}
      #asi1-desk .ad-dot.live{background:#00e676}
      #asi1-desk .ad-dot.rate{background:#ffb74d}
      #asi1-desk .ad-selects{display:flex;gap:6px;margin:8px 0}
      #asi1-desk select{flex:1;background:#0a0b0e;color:#e6e8eb;border:1px solid #1e2129;border-radius:6px;padding:5px;font-size:11px}
      #asi1-desk .ad-ask{width:100%;padding:8px;background:#0088aa;border:0;color:#fff;font-weight:700;border-radius:6px;cursor:pointer}
      #asi1-desk .ad-ask:disabled{opacity:.5;cursor:wait}
      #asi1-desk .ad-badge{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px}
      #asi1-desk .buy-up{background:rgba(0,230,118,.15);color:#00e676}
      #asi1-desk .buy-down{background:rgba(255,82,82,.15);color:#ff5252}
      #asi1-desk .size-down{background:rgba(255,183,77,.15);color:#ffb74d}
      #asi1-desk .hold-flat{background:rgba(139,146,154,.15);color:#8b929a}
      #asi1-desk .ad-notes{background:#0a0b0e;border-radius:8px;padding:8px;font-size:12px;line-height:1.45;margin-top:8px}
      #asi1-desk .ad-warn{color:#ff5252;font-size:11px;margin-top:6px}
      #asi1-desk .ad-fb{color:#ffb74d;font-size:10px;margin-top:4px}
    </style>
    <div class="ad-head">
      <span class="ad-title">ASI1 DESK</span>
      <div style="display:flex;gap:6px;align-items:center">
        <div class="ad-modes">
          <button class="ad-mode active" data-mode="asi1_only">ASI1</button>
          <button class="ad-mode" data-mode="dual_fire">Dual</button>
          <button class="ad-mode" data-mode="planner">Planner</button>
        </div>
        <button class="ad-min" id="adMin" type="button">▼</button>
      </div>
    </div>
    <div class="ad-body" id="adBody">
      <div class="ad-pills" id="adAccounts"></div>
      <div class="ad-selects">
        <select id="adCoin"></select>
        <select id="adHorizon">
          <option value="15m">15m Contract</option>
          <option value="5m">5m Scalp</option>
          <option value="1h">1h Hourly Contract</option>
          <option value="lookahead-1h">Look Ahead (Hourly 1h)</option>
          <option value="lookahead-15m">Look Ahead (15m)</option>
          <option value="anytime">Look Ahead (Anytime)</option>
          <option value="mispricings">Contract Mispricings</option>
          <option value="jdwalkaz">jdwalkaz (Live Agent)</option>
        </select>
      </div>
      <div class="ad-selects">
        <select id="adModelChoice">
          <option value="auto">Model: Auto (asi1-mini)</option>
          <option value="asi1-mini">asi1-mini (Fast / Scalp)</option>
          <option value="asi1">asi1 (Standard)</option>
          <option value="asi1-ultra">asi1-ultra (Deep Reasoning)</option>
          <option value="asi1-fast">asi1-fast (Quick)</option>
        </select>
        <select id="adReasoningEffort">
          <option value="auto">Effort: Auto (Fast)</option>
          <option value="off">Thinking: Off</option>
          <option value="low">Reasoning: Low</option>
          <option value="medium">Reasoning: Medium</option>
          <option value="high">Reasoning: High</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px 0">
        <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#8b929a;cursor:pointer">
          <input type="checkbox" id="adWebSearch"> Web Search
        </label>
        <span style="font-size:10px;color:#00d4ff">api.asi1.ai</span>
      </div>
      <button class="ad-ask" id="adAsk" type="button">Ask ASI1</button>
      <!-- Dynamic Pin-Risk Warning Banner -->
      <div id="adPinRiskBanner" style="display:none;margin:8px 0 4px 0;padding:6px 8px;background:rgba(255,82,82,0.12);border:1px solid #ff5252;border-radius:6px;font-size:10px;line-height:1.4;color:#ff8080"></div>
      <div class="ad-row" style="margin-top:10px"><span class="ad-k">Action</span><span class="ad-badge hold-flat" id="adAction">HOLD_FLAT</span></div>
      <div class="ad-row"><span class="ad-k">Call</span><span class="ad-v" id="adCall">—</span></div>
      <div class="ad-row"><span class="ad-k">Conf</span><span class="ad-v" id="adConf">—</span></div>
      <div class="ad-row"><span class="ad-k">Regime</span><span class="ad-v" id="adRegime">—</span></div>
      <div class="ad-row"><span class="ad-k">Edge</span><span class="ad-v" id="adEdge">—</span></div>
      <div class="ad-row"><span class="ad-k">Size</span><span class="ad-v" id="adSize">—</span></div>
      <div class="ad-row"><span class="ad-k">Spot</span><span class="ad-v" id="adSpot">—</span></div>
      <div class="ad-row"><span class="ad-k">PTB</span><span class="ad-v" id="adPtb">—</span></div>
      <div class="ad-row"><span class="ad-k">Closes in</span><span class="ad-v" id="adTtc">—</span></div>
      <div id="adNextHorizonBox" style="margin:8px 0 4px 0;padding:6px 8px;background:#06080a;border:1px solid #1f2a38;border-radius:6px;transition:border-color .3s, box-shadow .3s">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;font-weight:700;color:#00d4ff;margin-bottom:4px">
          <span id="adNextHorizonTitle">NEXT HORIZON (T+1) · PRE-OPEN</span>
          <span id="adNextCountdown">—</span>
        </div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Est. Strike PTB</span><span class="ad-v" id="adNextPtb">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Pre-Open Call</span><span class="ad-v" id="adNextCall">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Sniper Stance</span><span class="ad-v" id="adNextSniper">—</span></div>
      </div>
      <!-- ═══ AGENTVERSE AUTONOMOUS SCOUT & HUNT PANEL ═══ -->
      <div id="adAgentversePanel" style="margin:8px 0 4px 0;padding:6px 8px;background:#050a10;border:1px solid #005577;border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
          <div style="display:flex;align-items:center;gap:4px">
            <span style="font-size:10px;font-weight:700;color:#00e5ff;letter-spacing:.05em">AGENTVERSE HUNT</span>
            <span id="adAvStatusBadge" style="font-size:9px;padding:1px 5px;border-radius:3px;background:#003344;color:#00e5ff;font-weight:600">CUED (60s)</span>
          </div>
          <div style="display:flex;align-items:center;gap:4px">
            <button id="adAvAuditBtn" type="button" title="Audit Agentverse agents" style="background:transparent;border:1px solid #005577;color:#8ab4f8;font-size:9px;padding:1px 5px;border-radius:3px;cursor:pointer">🔍 AUDIT</button>
            <button id="adAvHuntBtn" type="button" title="Hunt contracts & intelligence now" style="background:transparent;border:1px solid #00e5ff;color:#00e5ff;font-size:9px;padding:1px 5px;border-radius:3px;cursor:pointer;font-weight:700">⚡ HUNT</button>
          </div>
        </div>
        <!-- Active Roster Badges -->
        <div id="adAvRosterBadges" style="display:flex;gap:3px;flex-wrap:wrap;margin-bottom:5px">
          <span class="ad-pill" style="font-size:8px;padding:1px 4px;background:#081420;border:1px solid #004466;color:#8ab4f8" title="Polymarket Live Data Agent">📊 PolyLive</span>
          <span class="ad-pill" style="font-size:8px;padding:1px 4px;background:#081420;border:1px solid #004466;color:#8ab4f8" title="Crypto Whale Radar">🐋 WhaleRadar</span>
          <span class="ad-pill" style="font-size:8px;padding:1px 4px;background:#081420;border:1px solid #004466;color:#8ab4f8" title="Vedetta Sentiment Divergence">🎯 Vedetta</span>
          <span class="ad-pill" style="font-size:8px;padding:1px 4px;background:#081420;border:1px solid #004466;color:#8ab4f8" title="Technical Analysis Agent">📈 TA-Ind</span>
        </div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k" style="font-size:10px">Macro Regime</span><span class="ad-v" id="adAvMacro" style="font-size:10px">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k" style="font-size:10px">Whale Bias</span><span class="ad-v" id="adAvWhale" style="font-size:10px">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k" style="font-size:10px">Divergence</span><span class="ad-v" id="adAvDivergence" style="font-size:10px">—</span></div>
        <!-- Top Hunted Opportunities -->
        <div id="adAvOpportunities" style="margin-top:4px;display:flex;flex-direction:column;gap:3px">
          <div style="font-size:9px;color:#8b929a;font-style:italic">Cued on startup. Agents will hunt Polymarket contracts & orderbooks automatically.</div>
        </div>
      </div>
      <!-- Range & Strike Viability Card -->
      <div id="adRangeCard" style="margin:8px 0 4px 0;padding:6px 8px;background:#06080a;border:1px solid #1f2a38;border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;font-weight:700;color:#00d4ff;margin-bottom:4px">
          <span>STRIKE & RANGE VIABILITY</span>
          <span id="adRangeStatus" style="font-size:9px;color:#00e676">LADDER ACTIVE</span>
        </div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Safe Range (1.65σ)</span><span class="ad-v" id="adRangeCone" style="font-size:10px">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Strike Zone</span><span class="ad-v" id="adActiveStrikeZone" style="font-size:10px;font-weight:700">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Optimal Target</span><span class="ad-v" id="adOptimalTarget" style="font-size:10px;color:#00d4ff">—</span></div>
      </div>
      <div style="margin:8px 0 4px 0;padding:6px 8px;background:#06080a;border:1px solid #1f2a38;border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;font-weight:700;color:#00d4ff;margin-bottom:4px">
          <span>MERGEKIT ENSEMBLER</span>
          <span style="font-size:9px;color:#00e676" id="adMergeMethod">SLERP + DARE</span>
        </div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Weight Matrix</span><span class="ad-v" id="adMergeWeights" style="font-size:10px">Adaptive Active</span></div>
      </div>

      <!-- ═══ ORBITAL FORESIGHT ENGINE PANEL ═══ -->
      <div id="ofe-panel" style="margin:8px 0 4px 0;padding:6px 8px;background:#04060a;border:1px solid #0d2040;border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
          <span style="font-size:10px;font-weight:700;color:#00aaff;letter-spacing:.05em">ORBITAL FORESIGHT ENGINE</span>
          <div style="display:flex;align-items:center;gap:5px">
            <span id="ofeStatus" style="font-size:9px;padding:1px 5px;border-radius:3px;background:#0d2040;color:#8b929a">OFFLINE</span>
            <button id="ofeForceScan" type="button" title="Force OSL scan" style="background:transparent;border:1px solid #0d2040;color:#0077cc;font-size:9px;padding:1px 5px;border-radius:3px;cursor:pointer">↺ SCAN</button>
          </div>
        </div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k" style="font-size:10px">Foresight Vec</span><span class="ad-v" id="ofeVector" style="font-size:10px;color:#8b929a">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k" style="font-size:10px">Macro Regime</span><span class="ad-v" id="ofeRegime" style="font-size:10px">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k" style="font-size:10px">Smart Money</span><span class="ad-v" id="ofeSmartMoney" style="font-size:10px">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k" style="font-size:10px">Sentiment</span><span class="ad-v" id="ofeSentiment" style="font-size:10px">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k" style="font-size:10px">Scan Age</span><span class="ad-v" id="ofeScanAge" style="font-size:10px">—</span></div>
        <div id="ofeNarrative" style="display:none;margin-top:5px;padding:5px 6px;background:#020408;border:1px solid #0d2040;border-radius:4px;font-size:10px;line-height:1.4;color:#aabbd0;max-height:60px;overflow-y:auto"></div>
        <div id="ofeDriftAnchor" style="display:none;margin-top:4px;padding:4px 6px;background:#010305;border-left:2px solid #0055aa;font-size:9px;color:#5588aa;font-style:italic;max-height:40px;overflow-y:auto"></div>
        <div id="ofeCatalysts" style="display:none;margin-top:4px;font-size:9px;color:#6699bb"></div>
      </div>
      <div class="ad-row"><span class="ad-k">Asked</span><span class="ad-v" id="adAskedAt">—</span></div>
      <div class="ad-row"><span class="ad-k">Model</span><span class="ad-v" id="adModel">—</span></div>
      <div class="ad-row"><span class="ad-k">Account</span><span class="ad-v" id="adAcct">—</span></div>
      <div class="ad-row"><span class="ad-k">Latency</span><span class="ad-v" id="adLat">—</span></div>
      <div class="ad-notes" id="adNotes">TokenMix-off path. Click Ask ASI1.</div>

      <!-- Interactive ASI1 Custom Query Prompt Box -->
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #1e2129;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:10px;font-weight:700;color:#00d4ff;letter-spacing:.04em">ASI1 CUSTOM QUERY / PROMPT</span>
          <span style="font-size:9px;color:#8b929a">Enter ↵ or click Send</span>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button type="button" class="ad-chip" data-query="Will price hold PTB before expiry?" style="background:#111318;border:1px solid #2a2f38;color:#8b929a;font-size:9px;padding:2px 6px;border-radius:4px;cursor:pointer">🎯 PTB Defense</button>
          <button type="button" class="ad-chip" data-query="Analyze orderbook imbalance and whale absorption" style="background:#111318;border:1px solid #2a2f38;color:#8b929a;font-size:9px;padding:2px 6px;border-radius:4px;cursor:pointer">🐋 Whale Book</button>
          <button type="button" class="ad-chip" data-query="Give me 3-5m pre-open sniper entry guidance for next contract" style="background:#111318;border:1px solid #2a2f38;color:#8b929a;font-size:9px;padding:2px 6px;border-radius:4px;cursor:pointer">⚡ Sniper Entry</button>
        </div>
        <div style="display:flex;gap:4px">
          <textarea id="adCustomPrompt" placeholder="Ask ASI1 anything with live market context..." rows="2" style="flex:1;background:#06080a;color:#e6e8eb;border:1px solid #1f2a38;border-radius:6px;padding:6px;font-size:11px;resize:none;outline:none;font-family:inherit"></textarea>
          <button id="adSendPrompt" type="button" style="background:#00d4ff;color:#06080a;font-weight:700;border:0;border-radius:6px;padding:0 10px;font-size:11px;cursor:pointer">Send</button>
          <button id="adGeminiToggle" type="button" title="Route query to Gemini" style="background:#111318;border:1px solid #2a2f38;color:#8b929a;font-weight:700;border-radius:6px;padding:0 8px;font-size:11px;cursor:pointer">Gemini</button>
          <button id="adJdwalkazToggle" type="button" title="Route query to local jdwalkaz agent (port 8002)" style="background:#111318;border:1px solid #2a2f38;color:#8b929a;font-weight:700;border-radius:6px;padding:0 8px;font-size:11px;cursor:pointer">jdwalkaz</button>
          <button id="adResetMemory" type="button" title="Clear conversation memory and start a new session" style="background:#1c2530;color:#ff8a80;font-weight:700;border:1px solid #ff5252;border-radius:6px;padding:0 8px;font-size:11px;cursor:pointer">Reset</button>
        </div>
        <div id="adCustomAnswer" style="display:none;background:#06080a;border:1px solid #1f2a38;border-radius:6px;padding:8px;font-size:11px;line-height:1.45;color:#e6e8eb;max-height:160px;overflow-y:auto"></div>
      </div>

      <div class="ad-warn" id="adWarn"></div>
      <div class="ad-fb" id="adFb"></div>
    </div>
  `;
  document.body.appendChild(dash);

  // Built via DOM APIs rather than string interpolation into the innerHTML
  // template above, so that template stays a fully static literal (COINS is
  // hardcoded today, but this also avoids the innerHTML-with-interpolation
  // pattern entirely rather than relying on that staying true).
  const coinSelect = document.getElementById('adCoin');
  if (coinSelect) {
    for (const c of COINS) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      coinSelect.appendChild(opt);
    }
    coinSelect.addEventListener('change', () => paintNextHorizon());
  }

  const horizonSelect = document.getElementById('adHorizon');
  if (horizonSelect) {
    try {
      const savedH = window.localStorage.getItem(HORIZON_KEY);
      if (savedH) horizonSelect.value = savedH;
    } catch (_) {}
    horizonSelect.addEventListener('change', (e) => {
      try { window.localStorage.setItem(HORIZON_KEY, e.target.value); } catch (_) {}
      paintNextHorizon();
    });
  }

  let mode = 'asi1_only';
  let minimized = false;
  let windowDeadlineMs = null;
  let countdownTimer = null;

  // Memoize expensive quantitative calculations to prevent main-thread churn on 100ms ticks
  const _predMemo = new Map();
  function getMemoizedPrediction(sym, price) {
    if (!Number.isFinite(price) || price <= 0) return null;
    const key = `${sym}:${Math.floor(price / 0.01)}`; // quantize to 1 cent
    if (_predMemo.has(key)) return _predMemo.get(key);
    const Desk = window.Asi1DeskContract;
    const pkt = buildPacket();
    pkt.spot = price;
    const result = Desk?.inferLocal?.(pkt, mode);
    _predMemo.set(key, result);
    if (_predMemo.size > 500) _predMemo.delete(_predMemo.keys().next().value);
    return result;
  }

  function formatCountdown(ms) {
    if (ms == null) return '—';
    if (ms <= 0) return 'closed';
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function tickCountdown() {
    const el = document.getElementById('adTtc');
    if (windowDeadlineMs == null) { if (el) el.textContent = '—'; return; }
    const remainingMs = windowDeadlineMs - Date.now();
    const remainingSec = Math.max(0, Math.round(remainingMs / 1000));
    if (el) el.textContent = formatCountdown(remainingMs);

    // Dynamic Pin-Risk & T+1 Hone-In Guard
    const pinBanner = document.getElementById('adPinRiskBanner');
    const nextBox = document.getElementById('adNextHorizonBox');
    const nextTitle = document.getElementById('adNextHorizonTitle');

    if (remainingSec <= 90 && remainingSec > 0) {
      const spotTxt = document.getElementById('adSpot')?.textContent?.replace(/,/g, '');
      const ptbTxt = document.getElementById('adPtb')?.textContent?.replace(/,/g, '');
      const spotNum = Number(spotTxt);
      const ptbNum = Number(ptbTxt);
      const dist = (spotNum > 0 && ptbNum > 0) ? Math.abs(spotNum - ptbNum) : null;
      const distBps = (dist != null && ptbNum > 0) ? (dist / ptbNum) * 10000 : null;

      if (isPinTrapped && pinBanner) {
        const coin = document.getElementById('adCoin')?.value || 'BTC';
        const distStr = window.CoinPrecision?.formatCoinDelta
          ? window.CoinPrecision.formatCoinDelta(coin, dist, { showSign: false })
          : `$${dist.toFixed(fallbackPriceDecimals(coin))}`;
        pinBanner.style.display = 'block';
        pinBanner.textContent = `⚠ PIN RISK DEFENSE DETECTED: Spot within ${distStr} (${distBps.toFixed(1)} bps) of PTB with ${remainingSec}s left. MM defense walls active; high probability of 1-2s post-expiry snap. Focus automatically honed on T+1 Pre-Open below.`;
      }

      if (nextBox) {
        nextBox.style.borderColor = '#00d4ff';
        nextBox.style.background = '#0a1018';
        nextBox.style.boxShadow = '0 0 12px rgba(0, 212, 255, 0.25)';
      }
      if (nextTitle) {
        nextTitle.textContent = 'NEXT HORIZON (T+1) · AUTO-HONED [EXPIRING PIN RISK]';
        nextTitle.style.color = '#00e676';
      }
    } else {
      if (pinBanner && pinBanner.dataset.persisted !== '1') {
        pinBanner.style.display = 'none';
      }
      if (nextBox) {
        nextBox.style.borderColor = '#1f2a38';
        nextBox.style.background = '#06080a';
        nextBox.style.boxShadow = 'none';
      }
      if (nextTitle) {
        const horizon = document.getElementById('adHorizon')?.value || '15m';
        const isHourly = horizon === '1h' || horizon === '60m' || horizon === 'hourly' || horizon === 'lookahead-1h';
        const is5m = horizon === '5m' || horizon === 'lookahead-5m';
        nextTitle.textContent = `NEXT HORIZON (T+1) · ${isHourly ? '1H' : (is5m ? '5M' : '15M')} PRE-OPEN`;
        nextTitle.style.color = '#00d4ff';
      }
    }

    if (remainingMs <= 0 && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }
  try { mode = window.localStorage.getItem(MODE_KEY) || 'asi1_only'; } catch (_) { /* */ }
  try { minimized = window.localStorage.getItem(MIN_KEY) === '1'; } catch (_) { /* */ }

  try {
    const savedModel = window.localStorage.getItem(MODEL_KEY) || 'asi1';
    if (document.getElementById('adModelChoice')) {
      document.getElementById('adModelChoice').value = savedModel;
    }
    const savedEffort = window.localStorage.getItem(REASONING_KEY) || 'low';
    if (document.getElementById('adReasoningEffort')) {
      document.getElementById('adReasoningEffort').value = savedEffort;
    }
    const savedWeb = window.localStorage.getItem(WEBSEARCH_KEY);
    if (savedWeb != null && document.getElementById('adWebSearch')) {
      document.getElementById('adWebSearch').checked = savedWeb === '1';
    }
  } catch (_) {}

  document.getElementById('adModelChoice')?.addEventListener('change', (e) => {
    try { window.localStorage.setItem(MODEL_KEY, e.target.value); } catch (_) {}
  });
  document.getElementById('adReasoningEffort')?.addEventListener('change', (e) => {
    try { window.localStorage.setItem(REASONING_KEY, e.target.value); } catch (_) {}
  });
  document.getElementById('adWebSearch')?.addEventListener('change', (e) => {
    try { window.localStorage.setItem(WEBSEARCH_KEY, e.target.checked ? '1' : '0'); } catch (_) {}
  });

  function invoke(name, payload) {
    if (window.electron?.asi1?.[name]) return window.electron.asi1[name](payload);
    if (window.electron?.invoke) {
      const map = {
        status: 'asi1:desk-status',
        setMode: 'asi1:desk-mode',
        infer: 'asi1:desk-infer',
        chat: 'asi1:desk-chat',
        jdwalkazQuery: 'jdwalkaz:query',
        hunt: 'asi1:agentverse-hunt',
        auditAgents: 'asi1:agentverse-audit',
        agentverseStatus: 'asi1:agentverse-status',
        'ai:run-inference': 'ai:run-inference',
      };
      return window.electron.invoke(map[name] || name, payload);
    }
    return Promise.reject(new Error('no-ipc'));
  }

  function setMinimized(next) {
    minimized = !!next;
    const body = document.getElementById('adBody');
    const btn = document.getElementById('adMin');
    if (body) body.style.display = minimized ? 'none' : '';
    if (btn) btn.textContent = minimized ? '▲' : '▼';
    try { window.localStorage.setItem(MIN_KEY, minimized ? '1' : '0'); } catch (_) { /* */ }
  }

  function paintMode() {
    dash.querySelectorAll('.ad-mode').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
  }

  let _lastAccountsFingerprint = '';
  function paintAccounts(diag) {
    const el = document.getElementById('adAccounts');
    if (!el) return;
    const accounts = diag?.accounts || {};
    const fingerprint = JSON.stringify(accounts);
    if (fingerprint === _lastAccountsFingerprint) return;
    _lastAccountsFingerprint = fingerprint;

    const accountIds = ['leaksnipe'];
    for (const k of Object.keys(accounts)) {
      if (!accountIds.includes(k)) accountIds.push(k);
    }
    const rows = accountIds.map((id) => {
      const a = accounts[id] || {};
      const keys = a.keys || 0;
      const email = a.email || 'margithub@icloud.com';
      const live = keys > 0;
      const dotClass = live ? 'live' : 'rate';
      const label = 'mauro (LeakSnipe)';
      return `<div class="ad-pill">
        <span class="ad-dot ${dotClass}"></span>
        <span style="font-weight:600;color:${live ? '#00e676' : '#e6e8eb'}">${escapeHTML(label)}</span>
        <span style="font-size:9px;color:#8ab4f8;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;" title="${escapeHTML(email)}">${escapeHTML(email)}</span>
        <span style="margin-left:auto;color:${live ? '#00e676' : '#8b929a'};font-weight:700;">${keys} key${keys === 1 ? '' : 's'}</span>
      </div>`;
    });
    el.innerHTML = rows.join('') || '<div class="ad-pill">no ASI1 keys</div>';
  }

  // Route/latency comes from asi1-client.js's free background probe of the
  // LOCAL proxy port (no LLM call, no quota cost, and off port 443 — that's
  function paintConnectivity(diag) {
    const latEl = document.getElementById('adLat');
    if (!latEl) return;
    if (latEl.dataset.isInferLatency === '1') return;
    const routeMode = diag?.routeMode || 'unknown';
    const routeLabel = { native: 'direct fast', unreachable: 'unreachable', fallback: 'proxy', unknown: 'unknown' }[routeMode] || routeMode;
    latEl.textContent = diag?.lastLatencyMs != null && routeMode !== 'unreachable'
      ? `${Math.round(diag.lastLatencyMs)}ms (${routeLabel})`
      : `— (${routeLabel})`;
  }

  function paintContract(contract, extra) {
    if (!contract) return;
    const action = String(contract.action || 'HOLD_FLAT');
    const badge = document.getElementById('adAction');
    badge.textContent = action;
    badge.className = 'ad-badge ' + action.toLowerCase().replace(/_/g, '-');
    document.getElementById('adCall').textContent = contract.call || '—';
    document.getElementById('adConf').textContent = contract.confidence != null
      ? Math.round(Number(contract.confidence) * 100) + '%' : '—';
    document.getElementById('adRegime').textContent = contract.regime || '—';
    document.getElementById('adEdge').textContent = contract.edge_vs_crowd || '—';
    document.getElementById('adSize').textContent = contract.size_hint || '—';
    document.getElementById('adModel').textContent = contract._meta?.model || '—';
    document.getElementById('adAcct').textContent = contract._meta?.account || contract._meta?.email || '—';
    const latEl = document.getElementById('adLat');
    if (latEl) {
      latEl.textContent = contract._meta?.latency != null ? contract._meta.latency + 'ms' : '—';
      latEl.dataset.isInferLatency = '1';
      setTimeout(() => { if (latEl) delete latEl.dataset.isInferLatency; }, 45000);
    }
    document.getElementById('adNotes').textContent = contract.notes || '';
    const warns = (contract.warnings || []).join(' · ');
    document.getElementById('adWarn').textContent = warns;
    document.getElementById('adFb').textContent = extra?.fallback
      ? ('offline inferLocal' + (extra.error ? ' — ' + extra.error : ''))
      : (contract._meta?.thought ? String(contract._meta.thought).slice(0, 240) : (contract._meta?.source === 'asi1' ? `ASI1 live (${contract._meta.model || 'model'})` : ''));

    // ── Range Viability & Pin Risk Rendering ──────────────────────────────
    const pinBanner = document.getElementById('adPinRiskBanner');
    const isPinDefended = (contract.warnings || []).some(w => w.includes('PIN_RISK_DEFENDED'))
      || (contract.notes || '').includes('PIN_RISK_DEFENDED')
      || (contract.action === 'HOLD_FLAT' && (contract.warnings || []).some(w => w.toLowerCase().includes('pin')));

    if (pinBanner) {
      if (isPinDefended) {
        pinBanner.style.display = 'block';
        pinBanner.dataset.persisted = '1';
        pinBanner.textContent = '⚠ PIN RISK DEFENSE ACTIVE: Price trapped near strike with late expiry. MM defense walls active; late directional trades risk 1-2s post-expiry snap. Active guidance pivoted to T+1 Pre-Open.';
      } else {
        delete pinBanner.dataset.persisted;
        pinBanner.style.display = 'none';
      }
    }

    const coin = document.getElementById('adCoin')?.value || 'BTC';
    const horizon = document.getElementById('adHorizon')?.value || '15m';
    const hMin = horizon === '1h' || horizon === '60m' ? 60 : (horizon === '5m' ? 5 : 15);
    const rangeData = window.PredictionEngine?.getRangeViability?.(coin, hMin, Number(document.getElementById('adPtb')?.textContent?.replace(/,/g, '')));
    if (rangeData) {
      const coneEl = document.getElementById('adRangeCone');
      if (coneEl) {
        const fmtCone = (v) => window.CoinPrecision?.formatCoinPrice
          ? window.CoinPrecision.formatCoinPrice(coin, v)
          : `$${fallbackFormatPrice(coin, v)}`;
        coneEl.textContent = `${fmtCone(rangeData.safeBoundLower)} — ${fmtCone(rangeData.safeBoundUpper)} (±${fmtCone(rangeData.expectedMoveDollar)})`;
      }
      const zoneEl = document.getElementById('adActiveStrikeZone');
      if (zoneEl) {
        const atm = rangeData.strikes?.find(s => s.type === 'ATM');
        if (atm) {
          zoneEl.textContent = `${atm.tag} (${atm.sigmaDist}σ · ${atm.distanceBps} bps)`;
          zoneEl.style.color = atm.viabilityZone === 'CLEAN_TARGET' ? '#00e676' : atm.viabilityZone === 'PIN_TRAP_DANGER' ? '#ff5252' : '#ffb74d';
        }
      }
      const optEl = document.getElementById('adOptimalTarget');
      if (optEl && rangeData.bestTarget) {
        const optStrike = window.CoinPrecision?.formatCoinStrike
          ? window.CoinPrecision.formatCoinStrike(coin, rangeData.bestTarget.strike)
          : `$${fallbackFormatPrice(coin, rangeData.bestTarget.strike)}`;
        optEl.textContent = `${optStrike} (${rangeData.bestTarget.name})`;
      }
    }

  }

  function buildPacket() {
    const Desk = window.Asi1DeskContract;
    const coin = document.getElementById('adCoin')?.value || 'BTC';
    const horizon = document.getElementById('adHorizon')?.value || '15m';
    const isHourly = horizon === '1h' || horizon === '60m' || horizon === 'hourly' || horizon === 'lookahead-1h' || horizon === 'hourly-lookahead';
    const is5m = horizon === '5m' || horizon === 'lookahead-5m';
    const isLookahead = horizon.startsWith('lookahead') || horizon === 'anytime';
    const hMin = (isHourly || horizon === 'anytime') ? 60 : (is5m ? 5 : 15);

    let pkt = {};
    try {
      if (window.OracleSnapshot?.buildOraclePacket && Desk?.packetFromOracle) {
        const o = window.OracleSnapshot.buildOraclePacket(coin, isHourly ? '1h' : (is5m ? '5m' : '15m'));
        pkt = Desk.packetFromOracle(o, { sym: coin, horizon }) || {};
      }
    } catch (_) { pkt = {}; }

    const pmCoin = (typeof window !== 'undefined' && window.PredictionMarkets?.getCoin?.(coin)) || {};
    const poly = horizon === 'anytime' ? {} : (
      (isHourly ? pmCoin.poly60m : (is5m ? pmCoin.poly5m : pmCoin.kalshi15m))
      || (isHourly ? pmCoin.poly60m : (is5m ? pmCoin.poly5m : pmCoin.poly15m))
      || pmCoin.poly5m
      || {}
    );
    const pred = (typeof window !== 'undefined' && (window.PredictionEngine?.get?.(coin) || window._predictions?.[coin])) || {};
    const cache = (typeof window !== 'undefined' && window.candleCache?.[coin]) || {};
    const forecast = window.PredictionEngine?.getPreOpenForecast?.(coin, hMin);

    const nowMs = Date.now();
    const hourlyCloseMs = Math.ceil(nowMs / 3600000) * 3600000;
    const hourlyTtc = Math.max(0, Math.round((hourlyCloseMs - nowMs) / 1000));
    const targetCloseTime = new Date(hourlyCloseMs).toISOString();
    const targetCloseHourUtc = new Date(hourlyCloseMs).toUTCString();

    const hourlyRanges = (typeof window !== 'undefined' && window.HourlyRangesPanel?.getRanges?.(coin))
      || pkt.hourlyLadder
      || [];

    const pythPrice = Number(window.PythBrowser?.getPrice?.(coin) || window._pythPrices?.[coin] || 0);
    const rawSpot = Number(pkt.spot || (pythPrice > 0 ? pythPrice : 0) || pred.price || pred.currentPrice || cache.ticker?.usd || cache.candles?.[cache.candles.length - 1]?.c || 0);
    const spot = Number.isFinite(rawSpot) && rawSpot > 0 ? rawSpot : null;

    let spotBucket = (spot != null && hourlyRanges.length)
      ? (hourlyRanges.find(r => spot >= Number(r.low) && spot <= Number(r.high)) || null)
      : (pkt.spotBucket || null);

    let rawPtb = Number(pkt.priceToBeatNum || poly.priceToBeatNum || poly.targetPriceNum || 0);
    if ((!rawPtb || isNaN(rawPtb)) && isLookahead && forecast?.projectedOpenPtb) {
      rawPtb = forecast.projectedOpenPtb;
    }
    if ((!rawPtb || isNaN(rawPtb)) && isHourly) {
      if (spotBucket) rawPtb = (Number(spotBucket.low) + Number(spotBucket.high)) / 2;
      else if (hourlyRanges[0]) rawPtb = (Number(hourlyRanges[0].low) + Number(hourlyRanges[0].high)) / 2;
      else if (spot != null) rawPtb = spot;
    }
    const ptb = Number.isFinite(rawPtb) && rawPtb > 0 ? rawPtb : null;

    const yesProb = Number.isFinite(Number(pkt.yesProb))
      ? Number(pkt.yesProb)
      : (Number.isFinite(Number(poly.probability))
        ? Number(poly.probability)
        : (isHourly && spotBucket?.yesProb != null ? Number(spotBucket.yesProb) : (isLookahead && forecast?.pUp != null ? forecast.pUp : 0.50)));
    const mid = Number.isFinite(Number(pkt.mid)) ? Number(pkt.mid) : (Number.isFinite(Number(poly.mid)) ? Number(poly.mid) : yesProb);
    const ttc = isHourly
      ? hourlyTtc
      : (isLookahead && forecast?.msToNextBoundary != null
        ? Math.max(1, Math.round(forecast.msToNextBoundary / 1000))
        : (Number.isFinite(Number(pkt.secondsToClose))
          ? Number(pkt.secondsToClose)
          : (Number.isFinite(Number(poly.secondsToClose))
            ? Number(poly.secondsToClose)
            : 180)));

    const delta = (spot != null && ptb != null) ? (spot - ptb) : 0;
    const pathDir = delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : 'FLAT';

    // Compute spotAgeSec only if we have a valid timestamp in ms (> 2020)
    let spotAgeSec = pkt.spotAgeSec;
    if (spotAgeSec == null && window._pythPythMetadata?.[coin]?.publishTime) {
      const pubMs = Number(window._pythPythMetadata[coin].publishTime);
      if (pubMs > 1_577_836_800_000) {
        spotAgeSec = Math.max(0, Math.round((Date.now() - pubMs) / 1000));
      }
    }

    let binaryIV = null;
    let binaryIV_15m = null;
    if (horizon === 'mispricings' && window.QuantStatUtils && window.QuantStatUtils.calculateBinaryIV) {
      // Calculate for 5m
      const poly5m = pmCoin.poly5m || {};
      const ptb5m = Number(poly5m.priceToBeatNum || poly5m.targetPriceNum);
      const prob5m = Number(poly5m.probability || 0.5);
      const ttc5m = Number(poly5m.secondsToClose || 300);
      if (spot != null && !isNaN(ptb5m) && !isNaN(prob5m) && !isNaN(ttc5m) && ttc5m > 0) {
        binaryIV = window.QuantStatUtils.calculateBinaryIV(prob5m, spot, ptb5m, ttc5m / 86400, 'polymarket');
      }
      
      // Calculate for 15m — Kalshi is primary, Polymarket is legacy fallback.
      const market15m = pmCoin.kalshi15m || pmCoin.poly15m || {};
      const ptb15m = Number(market15m.targetPriceNum || market15m.priceToBeatNum);
      const prob15m = Number(market15m.probability || 0.5);
      const ttc15m = Number(market15m.secondsToClose || 900);
      const venue15m = 'kalshi';
      if (spot != null && !isNaN(ptb15m) && !isNaN(prob15m) && !isNaN(ttc15m) && ttc15m > 0) {
        binaryIV_15m = window.QuantStatUtils.calculateBinaryIV(prob15m, spot, ptb15m, ttc15m / 86400, venue15m);
      }
    }

    const activeSlug = pkt.slug || poly.ticker || poly.slug || (isHourly ? `${coin.toLowerCase()}-hourly-ranges-${targetCloseTime}` : (is5m ? `${coin.toLowerCase()}-updown-5m` : `${coin.toLowerCase()}-updown-15m`));

    return {
      sym: coin,
      horizon,
      slug: activeSlug,
      isHourly,
      marketType: isHourly ? 'hourly_ranges' : 'updown_binary',
      hourlyRanges,
      hourlyLadder: hourlyRanges,
      spotBucket,
      targetCloseTime,
      targetCloseHourUtc,
      spot,
      spotSource: pkt.spotSource || (pythPrice > 0 ? 'pyth-browser' : 'pyth'),
      spotAgeSec: spotAgeSec ?? null,
      priceToBeatNum: ptb,
      yesProb,
      mid,
      spread: Number.isFinite(Number(pkt.spread)) ? Number(pkt.spread) : (Number(poly.spread) || 0.02),
      depthImbalance: Number.isFinite(Number(pkt.depthImbalance)) ? Number(pkt.depthImbalance) : (Number(poly.depthImbalance) || 0),
      secondsToClose: ttc,
      deltaVsPtb: delta,
      liveDirection: pkt.liveDirection || pathDir,
      lookahead: isLookahead,
      ...(isLookahead && forecast?.projectedOpenPtb ? { projectedOpenPtb: forecast.projectedOpenPtb } : {}),
      ...(isLookahead && forecast?.msToNextBoundary ? { msToNextBoundary: forecast.msToNextBoundary } : {}),
      ...(binaryIV !== null ? { binaryIV_5m: binaryIV } : {}),
      ...(binaryIV_15m !== null ? { binaryIV_15m, binaryIV_15m_venue: venue15m } : {}),
      pinRisk: (spot > 0 && ptb > 0 && !isHourly)
        ? (window.PredictionEngine?.getPinRisk?.(coin, spot, ptb, ttc, Number(pkt.depthImbalance) || 0) || null)
        : null,
      rangeViability: (spot > 0)
        ? (window.PredictionEngine?.getRangeViability?.(coin, hMin, ptb, ttc) || null)
        : null,
      futureWindowT1: forecast ? {
        projectedOpenPtb: forecast.projectedOpenPtb,
        projectedSettlement: forecast.projectedSettlement,
        forecastDirection: forecast.forecastDirection,
        confidence: forecast.confidence,
        sniperAction: forecast.sniperAction,
        msToNextBoundary: forecast.msToNextBoundary,
      } : null,
      ...pkt,
      sym: coin,
      horizon,
      slug: activeSlug,
      isHourly,
      spot,
      priceToBeatNum: ptb,
      secondsToClose: ttc,
    };
  }

  function paintNextHorizon() {
    const coin = document.getElementById('adCoin')?.value || 'BTC';
    const horizon = document.getElementById('adHorizon')?.value || '15m';
    const isHourly = horizon === '1h' || horizon === '60m' || horizon === 'hourly' || horizon === 'lookahead-1h' || horizon === 'hourly-lookahead';
    const is5m = horizon === '5m' || horizon === 'lookahead-5m';
    const hMin = (isHourly || horizon === 'anytime') ? 60 : (is5m ? 5 : 15);

    const titleEl = document.getElementById('adNextHorizonTitle');
    if (titleEl) {
      const label = isHourly ? '1H HOURLY' : (is5m ? '5M' : '15M');
      titleEl.textContent = `NEXT HORIZON (T+1) · ${label} PRE-OPEN`;
    }

    const forecast = window.PredictionEngine?.getPreOpenForecast?.(coin, hMin);
    if (!forecast) return;

    const countEl = document.getElementById('adNextCountdown');
    if (countEl) {
      const mins = Math.floor(forecast.msToNextBoundary / 60000);
      const secs = Math.floor((forecast.msToNextBoundary % 60000) / 1000);
      countEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    const ptbEl = document.getElementById('adNextPtb');
    if (ptbEl) {
      ptbEl.textContent = forecast.projectedOpenPtb != null
        ? (window.CoinPrecision?.formatCoinStrike
            ? window.CoinPrecision.formatCoinStrike(coin, forecast.projectedOpenPtb)
            : `$${fallbackFormatPrice(coin, forecast.projectedOpenPtb)}`)
        : '—';
    }

    const callEl = document.getElementById('adNextCall');
    if (callEl) {
      callEl.textContent = `${forecast.forecastDirection} (${forecast.confidence}%)`;
      callEl.style.color = forecast.forecastDirection === 'UP' ? '#00e676' : '#ff5252';
    }

    const sniperEl = document.getElementById('adNextSniper');
    if (sniperEl) {
      sniperEl.textContent = forecast.sniperAction;
      sniperEl.style.color = forecast.sniperAction.startsWith('PRE_POSITION') ? '#00d4ff' : '#8b929a';
    }

    const mergeEl = document.getElementById('adMergeWeights');
    if (mergeEl) {
      const diag = window.PredictionWeightMergeKit?.getMergeDiagnostics?.(coin);
      const methodName = diag?.method?.toUpperCase() || 'DELLA-SLERP';
      mergeEl.textContent = diag
        ? `${methodName} θ=${(diag.thetaDeg || 21).toFixed(0)}° · Sparsity ${(diag.sparsityPct || 15).toFixed(0)}%`
        : 'Adaptive Matrix Live';
    }
  }

  let _avCuedSecondsLeft = 0;
  function paintAgentverseHunter(st) {
    if (!st) return;
    const badge = document.getElementById('adAvStatusBadge');
    const macroEl = document.getElementById('adAvMacro');
    const whaleEl = document.getElementById('adAvWhale');
    const divEl = document.getElementById('adAvDivergence');
    const oppsEl = document.getElementById('adAvOpportunities');

    const status = st.status || 'IDLE';
    _avCuedSecondsLeft = Number(st.cuedSecondsLeft || 0);

    if (badge) {
      if (status === 'CUED') {
        badge.textContent = `CUED (${_avCuedSecondsLeft}s)`;
        badge.style.background = '#003344';
        badge.style.color = '#00e5ff';
      } else if (status === 'HUNTING') {
        badge.textContent = 'HUNTING (Planner)…';
        badge.style.background = '#332000';
        badge.style.color = '#ffb74d';
      } else if (status === 'COMPLETED') {
        const ageSec = st.latestHunt?.timestamp ? Math.round((Date.now() - st.latestHunt.timestamp) / 1000) : 0;
        const ageStr = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
        badge.textContent = `LIVE INTEL (${ageStr})`;
        badge.style.background = '#002810';
        badge.style.color = '#00e676';
      } else if (status === 'ERROR') {
        badge.textContent = 'HUNT ERR';
        badge.style.background = '#280000';
        badge.style.color = '#ff5252';
      } else {
        badge.textContent = status;
        badge.style.background = '#0a1018';
        badge.style.color = '#8b929a';
      }
    }

    const hunt = st.latestHunt;
    if (hunt) {
      if (macroEl) {
        macroEl.textContent = hunt.macroRegime || '—';
        macroEl.style.color = hunt.macroRegime === 'RISK_ON' ? '#00e676' : hunt.macroRegime === 'RISK_OFF' ? '#ff5252' : '#8ab4f8';
      }
      if (whaleEl) {
        const w = hunt.whaleRadar || {};
        whaleEl.textContent = w.bias ? `${w.bias.replace(/_/g, ' ')}` : '—';
        whaleEl.style.color = (w.bias || '').includes('BULL') ? '#00e676' : (w.bias || '').includes('BEAR') ? '#ff5252' : '#8b929a';
      }
      if (divEl) {
        const d = hunt.sentimentDivergence || {};
        divEl.textContent = d.verdict ? d.verdict.slice(0, 42) : '—';
        divEl.style.color = d.edgeDirection === 'UP' ? '#00e676' : d.edgeDirection === 'DOWN' ? '#ff5252' : '#8ab4f8';
      }

      if (oppsEl && Array.isArray(hunt.scoutedOpportunities) && hunt.scoutedOpportunities.length > 0) {
        oppsEl.innerHTML = hunt.scoutedOpportunities.slice(0, 3).map((op) => {
          const actColor = op.action === 'BUY_UP' ? '#00e676' : op.action === 'BUY_DOWN' ? '#ff5252' : '#ffb74d';
          const strikeStr = op.targetStrike
            ? (window.CoinPrecision?.formatCoinStrike
                ? window.CoinPrecision.formatCoinStrike(op.symbol, op.targetStrike)
                : `$${Number(op.targetStrike).toLocaleString()}`)
            : '';
          const edgeStr = op.edgePct ? ` (${op.edgePct})` : '';

          const pinBadge = op.pinRiskSafe === false ? '<span style="color:#ff5252;margin-left:4px">⚠ PIN</span>' : '';
          return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:9px;background:#03080e;padding:3px 5px;border-radius:4px;border-left:2px solid ${actColor}">
            <div style="display:flex;align-items:center;gap:4px">
              <span style="font-weight:700;color:#e6e8eb">${op.symbol} ${op.horizon || '15m'}</span>
              <span style="color:${actColor};font-weight:700">${op.action}</span>
              <span style="color:#8ab4f8">${strikeStr}${edgeStr}</span>
              ${pinBadge}
            </div>
            <span style="color:#00d4ff;font-weight:600">${op.confidence != null ? Math.round(op.confidence * 100) + '%' : ''}</span>
          </div>`;
        }).join('');
      }
    }
  }

  let _isRefreshing = false;
  async function refreshStatus() {
    if (_isRefreshing) return;
    if (minimized || (typeof document !== 'undefined' && document.hidden)) return;
    _isRefreshing = true;
    try {
      const st = await invoke('status');
      if (st?.mode) mode = st.mode;
      paintMode();
      paintAccounts(st?.diagnostics || {});
      paintConnectivity(st?.diagnostics || {});
      paintNextHorizon();

      // Defer non-critical Agentverse poll off the main render thread
      const pollAv = () => {
        invoke('agentverseStatus').then((avSt) => {
          if (avSt?.status) paintAgentverseHunter(avSt.status);
        }).catch(() => null);
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(pollAv);
      } else {
        setTimeout(pollAv, 0);
      }
    } catch (_) {
      paintAccounts({});
      paintConnectivity({});
      paintNextHorizon();
    } finally {
      _isRefreshing = false;
    }
  }

  // ── rAF-Batched HUD Tile & Spot Update (pyth-batch) ──────────────────────────
  function renderDeskBatch(syms) {
    if (!Array.isArray(syms) || !syms.length) return;
    const coin = document.getElementById('adCoin')?.value || 'BTC';
    if (!syms.includes(coin)) return;

    // Read phase
    const price = window._pythPrices?.[coin];
    if (!Number.isFinite(price) || price <= 0) return;

    // Write phase: single DOM update pass without layout thrashing
    const spotEl = document.getElementById('adSpot');
    if (spotEl) {
      spotEl.textContent = window.CoinPrecision?.formatCoinPrice
        ? window.CoinPrecision.formatCoinPrice(coin, price, { prefix: '' })
        : fallbackFormatPrice(coin, price);
    }

    const ptbTxt = document.getElementById('adPtb')?.textContent?.replace(/,/g, '');
    const ptbNum = Number(ptbTxt);
    if (Number.isFinite(ptbNum) && ptbNum > 0) {
      const delta = price - ptbNum;
      const dist = Math.abs(delta);
      const distBps = (dist / ptbNum) * 10000;
      const isDefended = distBps <= 8;
      const pinBanner = document.getElementById('adPinRiskBanner');
      if (pinBanner) {
        if (isDefended) {
          const distStr = window.CoinPrecision?.formatCoinDelta
            ? window.CoinPrecision.formatCoinDelta(coin, dist, { showSign: false })
            : `$${dist.toFixed(fallbackPriceDecimals(coin))}`;
          pinBanner.style.display = 'block';
          pinBanner.textContent = `⚠ PIN RISK DEFENSE DETECTED: Spot within ${distStr} (${distBps.toFixed(1)} bps) of PTB. MM defense walls active.`;
        } else if (pinBanner.dataset.persisted !== '1') {
          pinBanner.style.display = 'none';
        }
      }
    }
  }

  window.addEventListener('pyth-batch', (e) => {
    if (e?.detail?.syms) renderDeskBatch(e.detail.syms);
  });

  async function applyMode(next) {
    mode = next;
    paintMode();
    try { window.localStorage.setItem(MODE_KEY, mode); } catch (_) { /* */ }
    try { await invoke('setMode', mode); } catch (_) { /* */ }
  }

  async function ask() {
    const btn = document.getElementById('adAsk');
    btn.disabled = true;
    btn.textContent = 'Asking…';
    try {
      const horizonNow = document.getElementById('adHorizon')?.value || '15m';
      if (horizonNow === 'jdwalkaz') {
        const coinNow = document.getElementById('adCoin')?.value || 'BTC';
        const askedEl = document.getElementById('adAskedAt');
        if (askedEl) askedEl.textContent = new Date().toLocaleTimeString();
        const query = `Give me your live read on ${coinNow} right now: current spot, the live Kalshi hourly range ladder (or the 15m/5m contracts if more relevant), and the best out-of-range scalp setup if there is one.`;
        // Full bid-wall + depth datapoints for this query — logged to
        // logs/jdwalkaz-wall-stats.log by the jdwalkaz:query handler.
        const wallSnap = window.WallDepthSnapshot?.build?.(coinNow) || null;
        if (wallSnap) {
          window.WallDepthSnapshot.summarize(wallSnap).forEach((l) => console.info(l));
          try { window.dispatchEvent(new CustomEvent('jdwalkaz:wallstats', { detail: wallSnap })); } catch (_) { /* */ }
        }
        const t0 = Date.now();
        const res = await invoke('jdwalkazQuery', { query, wallStats: wallSnap, focus: coinNow, channel: 'jdwalkaz-horizon' });
        const content = res?.ok
          ? (res.content || 'No response from jdwalkaz.')
          : `jdwalkaz error: ${res?.error || 'unknown — is the agent running on port 8002?'}`;
        const jdwalkazContract = {
          call: '—',
          action: 'HOLD_FLAT',
          confidence: null,
          regime: '—',
          edge_vs_crowd: '—',
          urgency: '—',
          size_hint: '—',
          invalidation: '',
          notes: content,
          warnings: [],
          _meta: { model: 'jdwalkaz', account: 'jdwalkaz-live-agent' },
        };
        paintContract(jdwalkazContract, {});
        window.dispatchEvent(new CustomEvent('asi1:desk', { detail: { contract: jdwalkazContract } }));
        return;
      }

      const packet = buildPacket();

      const spotEl = document.getElementById('adSpot');
      if (spotEl) {
        spotEl.textContent = packet?.spot != null
          ? (window.CoinPrecision?.formatCoinPrice
              ? window.CoinPrecision.formatCoinPrice(coin, packet.spot, { prefix: '' })
              : fallbackFormatPrice(coin, packet.spot))
          : '—';
      }
      const ptbEl = document.getElementById('adPtb');
      if (ptbEl) {
        if (packet?.isHourly && packet?.spotBucket) {
          const bLabel = typeof packet.spotBucket === 'string'
            ? packet.spotBucket
            : (packet.spotBucket.label || packet.spotBucket.bracket || (packet.spotBucket.low != null && packet.spotBucket.high != null ? `$${packet.spotBucket.low}–$${packet.spotBucket.high}` : 'Range'));
          ptbEl.textContent = bLabel;
        } else if (packet?.isHourly) {
          ptbEl.textContent = packet.targetCloseHourUtc ? `${packet.targetCloseHourUtc}:00 UTC Range` : 'Hourly Range';
        } else {
          ptbEl.textContent = packet?.priceToBeatNum != null
            ? (window.CoinPrecision?.formatCoinStrike
                ? window.CoinPrecision.formatCoinStrike(coin, packet.priceToBeatNum, { prefix: '' })
                : fallbackFormatPrice(coin, packet.priceToBeatNum))
            : '—';
        }
      }
      const askedEl = document.getElementById('adAskedAt');

      if (askedEl) askedEl.textContent = new Date().toLocaleTimeString();

      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      windowDeadlineMs = Number.isFinite(packet?.secondsToClose) ? Date.now() + (packet.secondsToClose * 1000) : null;
      tickCountdown();
      if (windowDeadlineMs != null) countdownTimer = setInterval(tickCountdown, 1000);

      // Instant local baseline render (0ms optimistic response)
      const Desk = window.Asi1DeskContract;
      const provisional = Desk?.inferLocal?.(packet, mode);
      if (provisional) {
        provisional._meta = { model: 'provisional (local)', latency: 0, thought: 'Querying ASI:One live stream…' };
        paintContract(provisional, { provisional: true });
      }


      const effortChoice = document.getElementById('adReasoningEffort')?.value || 'auto';
      const webSearch = document.getElementById('adWebSearch')?.checked || false;

      // Only enter planner mode if explicitly chosen by user toggle
      const inferMode = (mode === 'planner') ? 'planner' : mode;

      const options = {
        model: modelChoice !== 'auto' ? modelChoice : undefined,
        reasoning_effort: (effortChoice === 'high' || effortChoice === 'medium' || effortChoice === 'low') ? effortChoice : 'low',
        enable_thinking: effortChoice === 'off' ? false : (effortChoice !== 'auto' ? true : undefined),
        web_search: webSearch ? true : undefined,
        timeoutMs: inferMode === 'planner' ? 25000 : 8000,
      };

      const res = await invoke('infer', { packet, mode: inferMode, options });
      paintContract(res?.contract, res);
      window.dispatchEvent(new CustomEvent('asi1:desk', { detail: res }));
    } catch (err) {
      const Desk = window.Asi1DeskContract;
      const local = Desk?.inferLocal?.(buildPacket(), mode);
      paintContract(local, { fallback: true, error: err?.message || String(err) });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Ask ASI1';
    }
  }

  let geminiActive = false;
  let geminiAvailable = false;
  let jdwalkazActive = false;
  let jdwalkazAvailable = false;

  async function refreshGeminiAvailability() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('probe-timeout')), 1500);
      const res = await fetch('http://127.0.0.1:8003/health', { signal: ctrl.signal, cache: 'no-store' });
      geminiAvailable = res.ok;
    } catch (_) {
      geminiAvailable = false;
    }
    const btn = document.getElementById('adGeminiToggle');
    if (btn) {
      if (!geminiAvailable) {
        btn.title = 'Gemini offline - no service on 127.0.0.1:8003';
        btn.style.borderColor = '#ff5252';
      } else {
        btn.title = 'Route query to local Gemini agent (port 8003)';
        btn.style.borderColor = geminiActive ? '#00dcfa' : '#2a2f38';
      }
    }
  }

  async function refreshJdwalkazAvailability() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('probe-timeout')), 1500);
      const res = await fetch('http://127.0.0.1:8002/health', { signal: ctrl.signal, cache: 'no-store' });
      jdwalkazAvailable = res.ok;
    } catch (_) {
      jdwalkazAvailable = false;
    }
    const btn = document.getElementById('adJdwalkazToggle');
    if (btn) {
      if (!jdwalkazAvailable) {
        btn.title = 'jdwalkaz offline — no service on 127.0.0.1:8002';
        btn.style.borderColor = '#ff5252';
      } else {
        btn.title = 'Route query to local jdwalkaz agent (port 8002)';
        btn.style.borderColor = jdwalkazActive ? '#00d4ff' : '#2a2f38';
      }
    }
  }

  async function askGemini(query) {
    const r = await fetch('http://127.0.0.1:8003/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) throw new Error('Gemini agent HTTP ' + r.status);
    const data = await r.json();
    if (data && data.ok) return data.content;
    throw new Error('Gemini agent error: ' + (data?.error || 'unknown'));
  }

  async function askJdwalkaz(query) {
    const r = await fetch('http://127.0.0.1:8002/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) throw new Error('jdwalkaz agent HTTP ' + r.status);
    const data = await r.json();
    if (data && data.ok) return data.content;
    throw new Error('jdwalkaz agent error: ' + (data?.error || 'unknown'));
  }

  async function sendCustomPrompt() {
    const promptInput = document.getElementById('adCustomPrompt');
    const answerEl = document.getElementById('adCustomAnswer');
    const sendBtn = document.getElementById('adSendPrompt');
    const query = String(promptInput?.value || '').trim();
    if (!query) return;

    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = '…';
    }
    if (answerEl) {
      answerEl.style.display = 'block';
      answerEl.textContent = '';
      const loadingSpan = document.createElement('span');
      loadingSpan.style.color = '#00d4ff';
      loadingSpan.textContent = 'ASI1 analyzing live market context…';
      answerEl.appendChild(loadingSpan);
    }

    try {
      const packet = buildPacket();
      const explicitMicro = /\b(5m|5\s*min(?:ute)?s?|15m|15\s*min(?:ute)?s?)\b/i.test(query);
      const explicitHourlyQuery = /\b(1h|60m|hour|hourly|top\s*of\s*(?:the\s*)?hour|hourly\s*close|hourly\s*range(?:s)?)\b/i.test(query);
      if (explicitMicro) {
        packet.isHourly = false;
        packet.marketType = 'updown_binary';
      } else if (explicitHourlyQuery && !packet.isHourly) {
        packet.isHourly = true;
        packet.marketType = 'hourly_ranges';
        const hourlyCloseMs = Math.ceil(Date.now() / 3600000) * 3600000;
        packet.secondsToClose = Math.max(1, Math.round((hourlyCloseMs - Date.now()) / 1000));
        packet.targetCloseTime = new Date(hourlyCloseMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
        packet.targetCloseHourUtc = new Date(hourlyCloseMs).getUTCHours();
        if (!packet.hourlyLadder?.length) {
          packet.hourlyLadder = window.HourlyRangesPanel?.getRanges?.(packet.sym) || [];
          packet.hourlyRanges = packet.hourlyLadder;
          if (packet.spot != null && packet.hourlyLadder.length) {
            packet.spotBucket = packet.hourlyLadder.find(r => packet.spot >= Number(r.low) && packet.spot <= Number(r.high)) || null;
          }
        }
      }
      if (geminiActive) {
        if (!geminiAvailable) {
          if (answerEl) {
            answerEl.textContent = 'Gemini offline - start the agent on 127.0.0.1:8003, then retry. This prompt was not sent to ASI1.';
          }
          return;
        }
        try {
          const geminiAnswer = await askGemini(query);
          if (answerEl) {
            answerEl.textContent = '';
            const pre = document.createElement('pre');
            pre.style.whiteSpace = 'pre-wrap';
            pre.style.fontFamily = 'inherit';
            pre.textContent = geminiAnswer;
            answerEl.appendChild(pre);
          }
          return;
        } catch (err) {
          if (answerEl) {
            answerEl.textContent = 'Gemini unavailable - falling back to ASI1.';
          }
        }
      }
      if (jdwalkazActive) {
        if (!jdwalkazAvailable) {
          if (answerEl) {
            answerEl.textContent = 'jdwalkaz offline — start the agent on 127.0.0.1:8002, then retry. This prompt was not sent to ASI1.';
          }
          return;
        }
        try {
          const jdwalkazAnswer = await askJdwalkaz(query);
          if (answerEl) {
            answerEl.textContent = '';
            const pre = document.createElement('pre');
            pre.style.whiteSpace = 'pre-wrap';
            pre.style.fontFamily = 'inherit';
            pre.textContent = jdwalkazAnswer;
            answerEl.appendChild(pre);
          }
          return;
        } catch (err) {
          if (answerEl) {
            answerEl.textContent = 'jdwalkaz unavailable — falling back to ASI1.';
          }
        }
      }

      const modelChoice = document.getElementById('adModelChoice')?.value || 'auto';
      const effortChoice = document.getElementById('adReasoningEffort')?.value || 'auto';
      const webSearch = document.getElementById('adWebSearch')?.checked || false;

      let res = null;
      let sessionId = null;
      try { sessionId = window.localStorage.getItem(SESSION_ID_KEY); } catch (_) {}
      if (!sessionId) {
        sessionId = newDeskSessionId();
        try { window.localStorage.setItem(SESSION_ID_KEY, sessionId); } catch (_) {}
      }
      try {
        let overrideModel = modelChoice !== 'auto' ? modelChoice : 'asi1-mini';
        if (geminiActive) {
          overrideModel = 'gemini-pro';
        }
        res = await invoke('chat', {
          prompt: query,
          sessionId,
          packet,
          model: overrideModel,
          reasoning_effort: effortChoice !== 'auto' ? effortChoice : 'low',
          web_search: webSearch,
        });
      } catch (_) {
        // Fallback to general AI inference bridge if chat channel not present
        res = await invoke('ai:run-inference', {
          prompt: query,
          context: {
            coin: packet.sym,
            horizon: packet.isHourly ? 60 : (packet.horizon === 'anytime' ? 'anytime' : (packet.horizon === '5m' || packet.horizon === 'lookahead-5m' ? 5 : 15)),
            spot: packet.spot,
            ptb: packet.priceToBeatNum,
            isHourly: packet.isHourly,
            hourlyLadder: packet.hourlyLadder,
            spotBucket: packet.spotBucket,
            targetCloseTime: packet.targetCloseTime,
            targetCloseHourUtc: packet.targetCloseHourUtc,
            model: modelChoice !== 'auto' ? modelChoice : 'asi1-mini',
            reasoning_effort: effortChoice !== 'auto' ? effortChoice : 'low',
            web_search: webSearch,
          }
        });
      }

      let cleanOut = '';
      let isError = false;
      if (res && res.ok === false) {
        cleanOut = res.error || 'ASI1 Chat request failed';
        isError = true;
      } else {
        const rawOut = res?.content || res?.output?.suggestions?.notes || res?.output?.ai_wording?.primary_rationale || res?.output?.notes || res?.output?.content || res?.output || (res?.error ? `Error: ${res.error}` : 'Analysis complete.');
        cleanOut = typeof rawOut === 'object' ? JSON.stringify(rawOut, null, 2) : String(rawOut);
        if (res?.error && !res?.content) isError = true;
      }
      const usedModel = res?.model || modelChoice;

      // Only persist successful responses in localStorage
      if (!isError) {
        try {
          window.localStorage.setItem(PROMPT_CACHE_KEY, query);
          window.localStorage.setItem(ANSWER_CACHE_KEY, JSON.stringify({
            model: usedModel,
            content: cleanOut,
            ts: Date.now(),
          }));
        } catch (_) {}
      }

      if (answerEl) {
        answerEl.textContent = '';
        const titleDiv = document.createElement('div');
        titleDiv.style.cssText = isError ? 'color:#ff5252;font-weight:700;margin-bottom:4px' : 'color:#00e676;font-weight:700;margin-bottom:4px';
        titleDiv.textContent = isError ? `ASI1 Error (${usedModel}):` : `ASI1 Intelligence (${usedModel}):`;

        const bodyDiv = document.createElement('div');
        bodyDiv.style.cssText = isError ? 'color:#ff8a80;font-size:11px;white-space:pre-wrap' : 'color:#e6e8eb;font-size:11px;white-space:pre-wrap';
        bodyDiv.textContent = cleanOut;

        answerEl.appendChild(titleDiv);
        answerEl.appendChild(bodyDiv);
      }
    } catch (err) {
      if (answerEl) {
        answerEl.textContent = '';
        const errorSpan = document.createElement('span');
        errorSpan.style.color = '#ff5252';
        errorSpan.textContent = `Query Error: ${err?.message || String(err)}`;
        answerEl.appendChild(errorSpan);
      }
    } finally {
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
      }
    }
  }

  dash.querySelectorAll('.ad-mode').forEach((b) => {
    b.addEventListener('click', () => applyMode(b.getAttribute('data-mode')));
  });
  document.getElementById('adMin')?.addEventListener('click', () => setMinimized(!minimized));
  document.getElementById('adAsk')?.addEventListener('click', ask);
  document.getElementById('adSendPrompt')?.addEventListener('click', sendCustomPrompt);
  const geminiBtn = document.getElementById('adGeminiToggle');
  if (geminiBtn) {
    geminiBtn.addEventListener('click', () => {
      geminiActive = !geminiActive;
      geminiBtn.style.background = geminiActive ? '#00dcfa' : '#111318';
      geminiBtn.style.color = geminiActive ? '#06080a' : '#8b929a';
      geminiBtn.style.border = geminiActive ? '1px solid #00dcfa' : '1px solid #2a2f38';
      geminiBtn.textContent = geminiActive ? 'Gemini ON' : 'Gemini';
    });
  }
  const jdwalkazBtn = document.getElementById('adJdwalkazToggle');
  if (jdwalkazBtn) {
    jdwalkazBtn.addEventListener('click', () => {
      jdwalkazActive = !jdwalkazActive;
      jdwalkazBtn.style.background = jdwalkazActive ? '#00d4ff' : '#111318';
      jdwalkazBtn.style.color = jdwalkazActive ? '#06080a' : '#8b929a';
      jdwalkazBtn.style.border = jdwalkazActive ? '1px solid #00d4ff' : '1px solid #2a2f38';
      jdwalkazBtn.textContent = jdwalkazActive ? 'jdwalkaz ON' : 'jdwalkaz';
    });
  }
  setInterval(refreshJdwalkazAvailability, 5000);
  void refreshJdwalkazAvailability();
  setInterval(refreshGeminiAvailability, 5000);
  void refreshGeminiAvailability();
  document.getElementById('adResetMemory')?.addEventListener('click', async () => {
    try {
      let sessionId = null;
      try { sessionId = window.localStorage.getItem(SESSION_ID_KEY); } catch (_) {}
      if (window.electron?.asi1?.resetChatMemory) {
        await window.electron.asi1.resetChatMemory({ sessionId });
      } else if (window.electron?.invoke) {
        await window.electron.invoke('asi1:desk-chat-reset', { sessionId });
      }
      const newSessionId = newDeskSessionId();
      try { window.localStorage.setItem(SESSION_ID_KEY, newSessionId); } catch (_) {}
      const answerEl = document.getElementById('adAnswer');
      if (answerEl) {
        answerEl.textContent = '';
        const titleDiv = document.createElement('div');
        titleDiv.style.cssText = 'color:#00e676;font-weight:700;margin-bottom:4px';
        titleDiv.textContent = 'ASI1 Memory Reset:';
        const bodyDiv = document.createElement('div');
        bodyDiv.style.cssText = 'color:#e6e8eb;font-size:11px;white-space:pre-wrap';
        bodyDiv.textContent = 'Conversation memory cleared. New session started. Ask me anything.';
        answerEl.appendChild(titleDiv);
        answerEl.appendChild(bodyDiv);
      }
    } catch (err) {
      const answerEl = document.getElementById('adAnswer');
      if (answerEl) {
        answerEl.textContent = '';
        const errorSpan = document.createElement('span');
        errorSpan.style.color = '#ff5252';
        errorSpan.textContent = `Reset Error: ${err?.message || String(err)}`;
        answerEl.appendChild(errorSpan);
      }
    }
  });
  document.getElementById('adCustomPrompt')?.addEventListener('input', (e) => {
    try { window.localStorage.setItem(PROMPT_CACHE_KEY, e.target.value); } catch (_) {}
  });
  document.getElementById('adCustomPrompt')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCustomPrompt();
    }
  });
  dash.querySelectorAll('.ad-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const q = chip.getAttribute('data-query');
      const input = document.getElementById('adCustomPrompt');
      if (input && q) {
        input.value = q;
        try { window.localStorage.setItem(PROMPT_CACHE_KEY, q); } catch (_) {}
        sendCustomPrompt();
      }
    });
  });

  // Model & Reasoning parameter change persistence
  document.getElementById('adModelChoice')?.addEventListener('change', (e) => {
    try { window.localStorage.setItem(MODEL_KEY, e.target.value); } catch (_) {}
  });
  document.getElementById('adReasoningEffort')?.addEventListener('change', (e) => {
    try { window.localStorage.setItem(REASONING_KEY, e.target.value); } catch (_) {}
  });
  document.getElementById('adWebSearch')?.addEventListener('change', (e) => {
    try { window.localStorage.setItem(WEBSEARCH_KEY, e.target.checked ? '1' : '0'); } catch (_) {}
  });

  try {
    const savedModel = window.localStorage.getItem(MODEL_KEY);
    if (savedModel && document.getElementById('adModelChoice')) {
      document.getElementById('adModelChoice').value = savedModel;
    }
    const savedEffort = window.localStorage.getItem(REASONING_KEY);
    if (savedEffort && document.getElementById('adReasoningEffort')) {
      document.getElementById('adReasoningEffort').value = savedEffort;
    }
    const savedWeb = window.localStorage.getItem(WEBSEARCH_KEY);
    if (savedWeb != null && document.getElementById('adWebSearch')) {
      document.getElementById('adWebSearch').checked = savedWeb === '1';
    }

    // Restore cached custom prompt and cached previous response
    const cachedPrompt = window.localStorage.getItem(PROMPT_CACHE_KEY);
    if (cachedPrompt && document.getElementById('adCustomPrompt')) {
      document.getElementById('adCustomPrompt').value = cachedPrompt;
    }
    const cachedAnsStr = window.localStorage.getItem(ANSWER_CACHE_KEY);
    if (cachedAnsStr && document.getElementById('adCustomAnswer')) {
      try {
        const cachedAns = JSON.parse(cachedAnsStr);
        if (cachedAns?.content) {
          const ansEl = document.getElementById('adCustomAnswer');
          ansEl.style.display = 'block';
          ansEl.textContent = '';
          const titleDiv = document.createElement('div');
          titleDiv.style.cssText = 'color:#00e676;font-weight:700;margin-bottom:4px';
          titleDiv.textContent = `ASI1 Intelligence (${cachedAns.model || 'cached'}):`;

          const bodyDiv = document.createElement('div');
          bodyDiv.style.cssText = 'color:#e6e8eb;font-size:11px;white-space:pre-wrap';
          bodyDiv.textContent = cachedAns.content;

          ansEl.appendChild(titleDiv);
          ansEl.appendChild(bodyDiv);
        }
      } catch (_) {}
    }
  } catch (_) {}

  setMinimized(minimized);
  paintMode();
  applyMode(mode);
  refreshStatus();
  // Auto-refresh connectivity (free diagnostics probe) without requiring a
  // click — actual trade-signal inference (ask()) stays manual/on-demand.
  // Relaxed to 15s to keep UI / IPC bus instantaneous and avoid polling churn.
  setInterval(refreshStatus, 15000);

  // ───────────────────────────────────────────────────────────────────────
  //  AGENTVERSE AUTONOMOUS HUNTER — HUD wiring & 1s cue ticker
  // ───────────────────────────────────────────────────────────────────────
  setInterval(() => {
    if (_avCuedSecondsLeft > 0) {
      _avCuedSecondsLeft -= 1;
      const badge = document.getElementById('adAvStatusBadge');
      if (badge && badge.textContent.startsWith('CUED')) {
        badge.textContent = `CUED (${_avCuedSecondsLeft}s)`;
      }
    }
  }, 1000);

  const avHuntBtn = document.getElementById('adAvHuntBtn');
  if (avHuntBtn) {
    avHuntBtn.addEventListener('click', async () => {
      avHuntBtn.disabled = true;
      avHuntBtn.textContent = '⚡…';
      const badge = document.getElementById('adAvStatusBadge');
      if (badge) {
        badge.textContent = 'HUNTING (Planner)…';
        badge.style.background = '#332000';
        badge.style.color = '#ffb74d';
      }
      try {
        const packet = buildPacket();
        const res = await invoke('hunt', {
          marketContext: {
            coins: ['BTC', 'ETH', 'SOL'],
            [packet.sym || 'BTC']: {
              spot: packet.spot,
              ptb15m: packet.priceToBeatNum,
              pinRisk: packet.pinRisk,
            },
          },
        });
        if (res?.result) {
          paintAgentverseHunter({ status: 'COMPLETED', latestHunt: res.result });
        }
      } catch (_) {
        if (badge) { badge.textContent = 'HUNT ERR'; badge.style.color = '#ff5252'; }
      } finally {
        avHuntBtn.disabled = false;
        avHuntBtn.textContent = '⚡ HUNT';
      }
    });
  }

  const avAuditBtn = document.getElementById('adAvAuditBtn');
  if (avAuditBtn) {
    avAuditBtn.addEventListener('click', async () => {
      avAuditBtn.disabled = true;
      avAuditBtn.textContent = '🔍…';
      try {
        const res = await invoke('auditAgents');
        const count = res?.audit?.onlineCount ?? 0;
        const total = res?.audit?.totalAgents ?? 0;
        const badge = document.getElementById('adAvStatusBadge');
        if (badge) {
          badge.textContent = `AUDITED ${count}/${total} OK`;
          badge.style.background = '#002810';
          badge.style.color = '#00e676';
          setTimeout(() => refreshStatus(), 5000);
        }
      } catch (_) {
        avAuditBtn.textContent = 'ERR';
      } finally {
        avAuditBtn.disabled = false;
        avAuditBtn.textContent = '🔍 AUDIT';
      }
    });
  }

  if (window.electron?.asi1?.onHuntCompleted) {
    window.electron.asi1.onHuntCompleted((hunt) => {
      paintAgentverseHunter({ status: 'COMPLETED', latestHunt: hunt });
    });
  }
  window.addEventListener('asi1:agentverse-hunt-completed', (e) => {
    if (e?.detail) paintAgentverseHunter({ status: 'COMPLETED', latestHunt: e.detail });
  });

  // ───────────────────────────────────────────────────────────────────────
  //  ORBITAL FORESIGHT ENGINE — HUD wiring
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Paint the OFE panel from an OslScanResult or null.
   * Called by the ofe:scan CustomEvent listener and on force-scan completion.
   */
  function paintOfePanel(result) {
    // Status badge
    const ofeStatus = document.getElementById('ofeStatus');
    if (ofeStatus) {
      if (!result) {
        ofeStatus.textContent = 'SCANNING…';
        ofeStatus.style.color = '#ffb74d';
        ofeStatus.style.background = '#1a1200';
        return;
      }
      const OFE = window.OrbitalForesightEngine;
      const sym = document.getElementById('adCoin')?.value || 'BTC';
      const rhc = OFE ? OFE.getRhcStatus(sym) : null;
      if (rhc && rhc.dead) {
        ofeStatus.textContent = '⚠ DEAD';
        ofeStatus.style.color = '#ff5252';
        ofeStatus.style.background = '#200000';
      } else if (rhc && rhc.stale) {
        ofeStatus.textContent = '◈ STALE';
        ofeStatus.style.color = '#ffb74d';
        ofeStatus.style.background = '#181000';
      } else if (rhc && rhc.warn) {
        ofeStatus.textContent = '◈ WARN';
        ofeStatus.style.color = '#ffd740';
        ofeStatus.style.background = '#141000';
      } else {
        ofeStatus.textContent = '✓ LIVE';
        ofeStatus.style.color = '#00e676';
        ofeStatus.style.background = '#001a0a';
      }
    }

    // Foresight Vector
    const vecEl = document.getElementById('ofeVector');
    if (vecEl && result) {
      const vec = String(result.foresightVector || '—').toUpperCase();
      const conf = result.foresightConfidence != null ? `${(result.foresightConfidence * 100).toFixed(0)}%` : '';
      vecEl.textContent = conf ? `${vec} (${conf})` : vec;
      vecEl.style.color = vec === 'UP' ? '#00e676' : vec === 'DOWN' ? '#ff5252' : '#8b929a';
    }

    // Macro Regime
    const regEl = document.getElementById('ofeRegime');
    if (regEl && result) {
      const regConf = result.regimeConfidence != null ? ` @${(result.regimeConfidence * 100).toFixed(0)}%` : '';
      regEl.textContent = (result.macroRegime || '—') + regConf;
      const regColors = { trending: '#00e676', volatile: '#ff9800', ranging: '#7b8cde', unknown: '#8b929a' };
      regEl.style.color = regColors[result.macroRegime] || '#e6e8eb';
    }

    // Smart Money
    const smEl = document.getElementById('ofeSmartMoney');
    if (smEl && result) {
      smEl.textContent = result.smartMoneyBias || '—';
      const smColors = { bullish: '#00e676', bearish: '#ff5252', contested: '#ffb74d', neutral: '#8b929a' };
      smEl.style.color = smColors[result.smartMoneyBias] || '#e6e8eb';
    }

    // Sentiment Score
    const sentEl = document.getElementById('ofeSentiment');
    if (sentEl && result) {
      const s = result.sentimentScore;
      if (s != null) {
        const pct = (s * 100).toFixed(0);
        sentEl.textContent = `${s > 0 ? '+' : ''}${pct}`;
        sentEl.style.color = s >= 0.15 ? '#00e676' : s <= -0.15 ? '#ff5252' : '#ffb74d';
      } else {
        sentEl.textContent = '—';
        sentEl.style.color = '#8b929a';
      }
    }

    // Scan Age
    const ageEl = document.getElementById('ofeScanAge');
    if (ageEl) {
      if (result && result.epochMs) {
        const ageSec = Math.round((Date.now() - result.epochMs) / 1000);
        ageEl.textContent = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
      } else {
        ageEl.textContent = '—';
      }
    }

    // Narrative
    const narEl = document.getElementById('ofeNarrative');
    if (narEl && result && result.narrativeSummary) {
      narEl.textContent = result.narrativeSummary;
      narEl.style.display = 'block';
    } else if (narEl) {
      narEl.style.display = 'none';
    }

    // Drift Anchor
    const dapEl = document.getElementById('ofeDriftAnchor');
    if (dapEl && result) {
      const OFE = window.OrbitalForesightEngine;
      const sym = document.getElementById('adCoin')?.value || 'BTC';
      const dap = OFE ? OFE.getDapAnchor(sym) : null;
      const anchor = dap?.driftAnchor || result.driftAnchor;
      if (anchor) {
        dapEl.textContent = `⚓ ${anchor}`;
        dapEl.style.display = 'block';
      } else {
        dapEl.style.display = 'none';
      }
    } else if (dapEl) {
      dapEl.style.display = 'none';
    }

    // Catalysts
    const catEl = document.getElementById('ofeCatalysts');
    if (catEl && result) {
      const cats = Array.isArray(result.upcomingCatalysts) ? result.upcomingCatalysts.slice(0, 3) : [];
      if (cats.length) {
        catEl.textContent = '⚡ ' + cats.join(' · ');
        catEl.style.display = 'block';
      } else {
        catEl.style.display = 'none';
      }
    }
  }

  // Listen for OFE scan events from OrbitalForesightEngine
  window.addEventListener('ofe:scan', (e) => {
    const payload = e?.detail || {};
    if (payload.type === 'osl_scan' && payload.result) {
      paintOfePanel(payload.result);
    }
  });

  // Force-scan button: immediately re-run OSL for current coin
  const ofeForceScanBtn = document.getElementById('ofeForceScan');
  if (ofeForceScanBtn) {
    ofeForceScanBtn.addEventListener('click', async () => {
      const OFE = window.OrbitalForesightEngine;
      if (!OFE) return;
      const sym = document.getElementById('adCoin')?.value || 'BTC';
      const statusEl = document.getElementById('ofeStatus');
      if (statusEl) {
        statusEl.textContent = 'SCANNING…';
        statusEl.style.color = '#ffb74d';
        statusEl.style.background = '#1a1200';
      }
      paintOfePanel(null); // show scanning state
      try {
        const result = await OFE.forceScan(sym, {});
        if (result) paintOfePanel(result);
      } catch (_) {
        if (statusEl) { statusEl.textContent = 'ERR'; statusEl.style.color = '#ff5252'; }
      }
    });
  }

  // Initialize OFE panel from existing scan (if present) without auto-spamming background LLM completions.
  // Full scans can be triggered on-demand via the Force Scan button.
  setTimeout(() => {
    try {
      const OFE = window.OrbitalForesightEngine;
      if (!OFE) return;
      const sym = document.getElementById('adCoin')?.value || 'BTC';
      const existingScan = typeof OFE.getLatestScan === 'function' ? OFE.getLatestScan(sym) : null;
      if (existingScan) {
        paintOfePanel(existingScan);
      }
      // Poll scan age every 30 s to keep the age counter live
      setInterval(() => {
        const scan = typeof OFE.getLatestScan === 'function' ? OFE.getLatestScan(document.getElementById('adCoin')?.value || 'BTC') : null;
        if (scan) {
          const ageEl = document.getElementById('ofeScanAge');
          if (ageEl && scan.epochMs) {
            const ageSec = Math.round((Date.now() - scan.epochMs) / 1000);
            ageEl.textContent = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
          }
          // Update status freshness
          const coinNow = document.getElementById('adCoin')?.value || 'BTC';
          const rhc = typeof OFE.getRhcStatus === 'function' ? OFE.getRhcStatus(coinNow) : null;
          const statusEl = document.getElementById('ofeStatus');
          if (statusEl && rhc) {
            if (rhc.stale || rhc.dead) {
              statusEl.textContent = rhc.dead ? '⚠ DEAD' : '◈ STALE';
              statusEl.style.color = '#ffb74d';
              statusEl.style.background = '#181000';
            }
          }
        }
      }, 30_000);
    } catch (_) { /* non-fatal: OFE may not be loaded yet */ }
  }, 2000);

  window.Asi1Desk = {
    getMode: () => mode,
    setMode: applyMode,
    ask,
    refresh: refreshStatus,
    paintOfePanel,
  };
})();
