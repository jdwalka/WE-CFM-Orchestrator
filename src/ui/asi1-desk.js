/**
 * ASI1 Desk — docked economy panel.
 * Modes: ASI1-only (save TokenMix) / dual-fire / planner (15m+ only).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.Asi1Desk) return;
  const escapeHTML = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const MODE_KEY = 'wecrypto.asi1Desk.mode';
  const MIN_KEY = 'wecrypto.asi1Desk.minimized';
  const MODEL_KEY = 'wecrypto.asi1Desk.model';
  const REASONING_KEY = 'wecrypto.asi1Desk.reasoningEffort';
  const WEBSEARCH_KEY = 'wecrypto.asi1Desk.webSearch';

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
        <select id="adHorizon"><option value="15m">15m</option><option value="5m">5m</option><option value="anytime">Look Ahead (Anytime)</option><option value="mispricings">Contract Mispricings</option></select>
      </div>
      <div class="ad-selects">
        <select id="adModelChoice">
          <option value="auto">Model: Auto</option>
          <option value="asi1-ultra">asi1-ultra (Deep Reasoning)</option>
          <option value="asi1">asi1 (Standard)</option>
          <option value="asi1-mini">asi1-mini (Fast / Scalp)</option>
          <option value="asi1-fast">asi1-fast (Quick)</option>
        </select>
        <select id="adReasoningEffort">
          <option value="auto">Effort: Auto</option>
          <option value="high">Reasoning: High</option>
          <option value="medium">Reasoning: Medium</option>
          <option value="low">Reasoning: Low</option>
          <option value="off">Thinking: Off</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px 0">
        <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#8b929a;cursor:pointer">
          <input type="checkbox" id="adWebSearch"> Web Search
        </label>
        <span style="font-size:10px;color:#00d4ff">api.asi1.ai</span>
      </div>
      <button class="ad-ask" id="adAsk" type="button">Ask ASI1</button>
      <div class="ad-row" style="margin-top:10px"><span class="ad-k">Action</span><span class="ad-badge hold-flat" id="adAction">HOLD_FLAT</span></div>
      <div class="ad-row"><span class="ad-k">Call</span><span class="ad-v" id="adCall">—</span></div>
      <div class="ad-row"><span class="ad-k">Conf</span><span class="ad-v" id="adConf">—</span></div>
      <div class="ad-row"><span class="ad-k">Regime</span><span class="ad-v" id="adRegime">—</span></div>
      <div class="ad-row"><span class="ad-k">Edge</span><span class="ad-v" id="adEdge">—</span></div>
      <div class="ad-row"><span class="ad-k">Size</span><span class="ad-v" id="adSize">—</span></div>
      <div class="ad-row"><span class="ad-k">Spot</span><span class="ad-v" id="adSpot">—</span></div>
      <div class="ad-row"><span class="ad-k">PTB</span><span class="ad-v" id="adPtb">—</span></div>
      <div class="ad-row"><span class="ad-k">Closes in</span><span class="ad-v" id="adTtc">—</span></div>
      <div style="margin:8px 0 4px 0;padding:6px 8px;background:#06080a;border:1px solid #1f2a38;border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;font-weight:700;color:#00d4ff;margin-bottom:4px">
          <span>NEXT HORIZON (T+1) · 3–5m PRE-OPEN</span>
          <span id="adNextCountdown">—</span>
        </div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Est. Strike PTB</span><span class="ad-v" id="adNextPtb">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Pre-Open Call</span><span class="ad-v" id="adNextCall">—</span></div>
        <div class="ad-row" style="margin:2px 0"><span class="ad-k">Sniper Stance</span><span class="ad-v" id="adNextSniper">—</span></div>
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
  }

  let mode = 'asi1_only';
  let minimized = false;
  let windowDeadlineMs = null;
  let countdownTimer = null;

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
    if (el) el.textContent = formatCountdown(remainingMs);
    if (remainingMs <= 0 && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }
  try { mode = window.localStorage.getItem(MODE_KEY) || 'asi1_only'; } catch (_) { /* */ }
  try { minimized = window.localStorage.getItem(MIN_KEY) === '1'; } catch (_) { /* */ }

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

  function paintAccounts(diag) {
    const el = document.getElementById('adAccounts');
    if (!el) return;
    const accounts = diag?.accounts || {};
    const accountIds = ['mauro', 'icloud', 'gitgoin'];
    for (const k of Object.keys(accounts)) {
      if (!accountIds.includes(k)) accountIds.push(k);
    }
    const rows = accountIds.map((id) => {
      const a = accounts[id] || {};
      const keys = a.keys || 0;
      const email = a.email || (id === 'mauro' ? 'maurofanellijr@gmail.com' : (id === 'icloud' ? 'mauro_fanelli@icloud.com' : 'gitgoin87@gmail.com'));
      const live = keys > 0;
      const dotClass = live ? 'live' : 'rate';
      const label = id === 'mauro' ? 'mauro (Primary)' : (id === 'icloud' ? 'icloud (Pro)' : id);
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
  // only used by real ASI1 chat requests) — safe to poll on a timer, unlike
  // ask() which fires a real ASI1 inference request.
  function paintConnectivity(diag) {
    const latEl = document.getElementById('adLat');
    if (!latEl) return;
    const routeMode = diag?.routeMode || 'unknown';
    const routeLabel = { native: 'proxy up', unreachable: 'proxy unreachable', unknown: 'unknown' }[routeMode] || 'unknown';
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
    document.getElementById('adLat').textContent = contract._meta?.latency != null ? contract._meta.latency + 'ms' : '—';
    document.getElementById('adNotes').textContent = contract.notes || '';
    const warns = (contract.warnings || []).join(' · ');
    document.getElementById('adWarn').textContent = warns;
    document.getElementById('adFb').textContent = extra?.fallback
      ? ('offline inferLocal' + (extra.error ? ' — ' + extra.error : ''))
      : (contract._meta?.thought ? String(contract._meta.thought).slice(0, 240) : (contract._meta?.source === 'asi1' ? `ASI1 live (${contract._meta.model || 'model'})` : ''));
  }

  function buildPacket() {
    const Desk = window.Asi1DeskContract;
    const coin = document.getElementById('adCoin')?.value || 'BTC';
    const horizon = document.getElementById('adHorizon')?.value || '5m';
    let pkt = {};
    try {
      if (window.OracleSnapshot?.buildOraclePacket && Desk?.packetFromOracle) {
        const o = window.OracleSnapshot.buildOraclePacket(coin, horizon);
        pkt = Desk.packetFromOracle(o, { sym: coin, horizon }) || {};
      }
    } catch (_) { pkt = {}; }

    const pmCoin = (typeof window !== 'undefined' && window.PredictionMarkets?.getCoin?.(coin)) || {};
    const poly = horizon === 'anytime' ? {} : ((horizon === '5m' ? pmCoin.poly5m : pmCoin.poly15m) || pmCoin.poly5m || pmCoin.poly15m || {});
    const pred = (typeof window !== 'undefined' && (window.PredictionEngine?.get?.(coin) || window._predictions?.[coin])) || {};
    const cache = (typeof window !== 'undefined' && window.candleCache?.[coin]) || {};

    const pythPrice = Number(window.PythBrowser?.getPrice?.(coin) || window._pythPrices?.[coin] || 0);
    const rawSpot = Number(pkt.spot || (pythPrice > 0 ? pythPrice : 0) || pred.price || pred.currentPrice || cache.ticker?.usd || cache.candles?.[cache.candles.length - 1]?.c || 0);
    const rawPtb = Number(pkt.priceToBeatNum || poly.priceToBeatNum || poly.targetPriceNum || 0);
    const spot = Number.isFinite(rawSpot) && rawSpot > 0 ? rawSpot : null;
    const ptb = Number.isFinite(rawPtb) && rawPtb > 0 ? rawPtb : null;
    const yesProb = Number.isFinite(Number(pkt.yesProb)) ? Number(pkt.yesProb) : (Number.isFinite(Number(poly.probability)) ? Number(poly.probability) : 0.50);
    const mid = Number.isFinite(Number(pkt.mid)) ? Number(pkt.mid) : (Number.isFinite(Number(poly.mid)) ? Number(poly.mid) : yesProb);
    const ttc = Number.isFinite(Number(pkt.secondsToClose)) ? Number(pkt.secondsToClose) : (Number.isFinite(Number(poly.secondsToClose)) ? Number(poly.secondsToClose) : 180);

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
      
      // Calculate for 15m
      const poly15m = pmCoin.poly15m || {};
      const ptb15m = Number(poly15m.priceToBeatNum || poly15m.targetPriceNum);
      const prob15m = Number(poly15m.probability || 0.5);
      const ttc15m = Number(poly15m.secondsToClose || 900);
      if (spot != null && !isNaN(ptb15m) && !isNaN(prob15m) && !isNaN(ttc15m) && ttc15m > 0) {
        binaryIV_15m = window.QuantStatUtils.calculateBinaryIV(prob15m, spot, ptb15m, ttc15m / 86400, 'polymarket');
      }
    }

    return {
      ...(Desk?.SAMPLE_PACKET || {}),
      ...pkt,
      sym: coin,
      horizon,
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
      ...(binaryIV !== null ? { binaryIV_5m: binaryIV } : {}),
      ...(binaryIV_15m !== null ? { binaryIV_15m: binaryIV_15m } : {}),
    };
  }

  // Route/latency comes from asi1-client.js's free background TCP probe
  // (no LLM call, no quota cost) — safe to poll on a timer, unlike ask()
  // which fires a real ASI1 inference request.
  function paintConnectivity(diag) {
    const latEl = document.getElementById('adLat');
    if (!latEl) return;
    const routeMode = diag?.routeMode || 'unknown';
    const routeLabel = { native: 'native', fallback: 'tunneled', unreachable: 'unreachable', unknown: 'unknown' }[routeMode] || 'unknown';
    latEl.textContent = diag?.lastLatencyMs != null && routeMode !== 'unreachable'
      ? `${Math.round(diag.lastLatencyMs)}ms (${routeLabel})`
      : `— (${routeLabel})`;
  }

  function paintNextHorizon() {
    const coin = document.getElementById('adCoin')?.value || 'BTC';
    const horizon = document.getElementById('adHorizon')?.value || '5m';
    const hMin = horizon === 'anytime' ? 60 : (horizon === '15m' ? 15 : 5);
    const forecast = window.PredictionEngine?.getPreOpenForecast?.(coin, hMin);
    if (!forecast) return;

    const countEl = document.getElementById('adNextCountdown');
    if (countEl) {
      const mins = Math.floor(forecast.msToNextBoundary / 60000);
      const secs = Math.floor((forecast.msToNextBoundary % 60000) / 1000);
      countEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    const ptbEl = document.getElementById('adNextPtb');
    if (ptbEl) ptbEl.textContent = forecast.projectedOpenPtb != null ? `$${forecast.projectedOpenPtb.toLocaleString()}` : '—';

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
      mergeEl.textContent = diag ? `SLERP θ=${(diag.thetaDeg || 24).toFixed(0)}° · Sparsity ${(diag.sparsityPct || 12).toFixed(0)}%` : 'Adaptive Matrix Live';
    }
  }

  async function refreshStatus() {
    try {
      const st = await invoke('status');
      if (st?.mode) mode = st.mode;
      paintMode();
      paintAccounts(st?.diagnostics || {});
      paintConnectivity(st?.diagnostics || {});
      paintNextHorizon();
    } catch (_) {
      paintAccounts({});
      paintConnectivity({});
      paintNextHorizon();
    }
  }

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
      const packet = buildPacket();

      const spotEl = document.getElementById('adSpot');
      if (spotEl) spotEl.textContent = packet?.spot != null ? Number(packet.spot).toLocaleString() : '—';
      const ptbEl = document.getElementById('adPtb');
      if (ptbEl) ptbEl.textContent = packet?.priceToBeatNum != null ? Number(packet.priceToBeatNum).toLocaleString() : '—';
      const askedEl = document.getElementById('adAskedAt');
      if (askedEl) askedEl.textContent = new Date().toLocaleTimeString();

      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      windowDeadlineMs = Number.isFinite(packet?.secondsToClose) ? Date.now() + (packet.secondsToClose * 1000) : null;
      tickCountdown();
      if (windowDeadlineMs != null) countdownTimer = setInterval(tickCountdown, 1000);

      const modelChoice = document.getElementById('adModelChoice')?.value || 'auto';
      const effortChoice = document.getElementById('adReasoningEffort')?.value || 'auto';
      const webSearch = document.getElementById('adWebSearch')?.checked || false;

      const options = {
        model: modelChoice !== 'auto' ? modelChoice : undefined,
        reasoning_effort: (effortChoice === 'high' || effortChoice === 'medium' || effortChoice === 'low') ? effortChoice : undefined,
        enable_thinking: effortChoice === 'off' ? false : (effortChoice !== 'auto' ? true : undefined),
        web_search: webSearch ? true : undefined,
      };

      const inferMode = packet.horizon === 'anytime' ? 'planner' : mode;
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
      const modelChoice = document.getElementById('adModelChoice')?.value || 'auto';
      const effortChoice = document.getElementById('adReasoningEffort')?.value || 'auto';
      const webSearch = document.getElementById('adWebSearch')?.checked || false;

      let res = null;
      try {
        res = await invoke('chat', {
          prompt: query,
          packet,
          model: modelChoice !== 'auto' ? modelChoice : 'asi1-mini',
          reasoning_effort: effortChoice !== 'auto' ? effortChoice : 'medium',
          web_search: webSearch,
        });
      } catch (_) {
        // Fallback to general AI inference bridge if chat channel not present
        res = await invoke('ai:run-inference', {
          prompt: query,
          context: {
            coin: packet.sym,
            horizon: packet.horizon === 'anytime' ? 'anytime' : (packet.horizon === '5m' ? 5 : 15),
            spot: packet.spot,
            ptb: packet.priceToBeatNum,
            model: modelChoice !== 'auto' ? modelChoice : 'asi1-mini',
            reasoning_effort: effortChoice !== 'auto' ? effortChoice : 'medium',
            web_search: webSearch,
          }
        });
      }

      const rawOut = res?.content || res?.output?.suggestions?.notes || res?.output?.ai_wording?.primary_rationale || res?.output?.notes || res?.output?.content || res?.output || res?.error || 'Analysis complete.';
      const cleanOut = typeof rawOut === 'object' ? JSON.stringify(rawOut, null, 2) : String(rawOut);
      if (answerEl) {
        answerEl.textContent = '';
        const titleDiv = document.createElement('div');
        titleDiv.style.cssText = 'color:#00e676;font-weight:700;margin-bottom:4px';
        titleDiv.textContent = `ASI1 Intelligence (${res?.model || modelChoice}):`;

        const bodyDiv = document.createElement('div');
        bodyDiv.style.cssText = 'color:#e6e8eb;font-size:11px;white-space:pre-wrap';
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
        sendCustomPrompt();
      }
    });
  });

  setMinimized(minimized);
  paintMode();
  applyMode(mode);
  refreshStatus();
  // Auto-refresh connectivity (free diagnostics probe) without requiring a
  // click — actual trade-signal inference (ask()) stays manual/on-demand.
  setInterval(refreshStatus, 3000);

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

  // Auto-start the OSL scanner when the desk loads (deferred to avoid blocking)
  setTimeout(() => {
    try {
      const OFE = window.OrbitalForesightEngine;
      if (!OFE || typeof OFE.startOsl !== 'function') return;
      const sym = document.getElementById('adCoin')?.value || 'BTC';
      OFE.startOsl({
        symbols: [sym],
        horizon: '15m',
        model: 'asi1-mini',
        webSearch: true,
        useAgentverse: true,
        verbose: false,
      });
      // Poll scan age every 30 s to keep the age counter live
      setInterval(() => {
        const scan = OFE.getLatestScan(document.getElementById('adCoin')?.value || 'BTC');
        if (scan) {
          const ageEl = document.getElementById('ofeScanAge');
          if (ageEl && scan.epochMs) {
            const ageSec = Math.round((Date.now() - scan.epochMs) / 1000);
            ageEl.textContent = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
          }
          // Update status freshness
          const coinNow = document.getElementById('adCoin')?.value || 'BTC';
          const rhc = OFE.getRhcStatus(coinNow);
          const statusEl = document.getElementById('ofeStatus');
          if (statusEl) {
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
