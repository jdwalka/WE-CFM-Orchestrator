/**
 * ASI1 Desk — docked economy panel.
 * Modes: ASI1-only (save TokenMix) / dual-fire / planner (15m+ only).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.Asi1Desk) return;

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
        <select id="adHorizon"><option value="15m">15m</option><option value="5m">5m</option></select>
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
      <div class="ad-row"><span class="ad-k">Asked</span><span class="ad-v" id="adAskedAt">—</span></div>
      <div class="ad-row"><span class="ad-k">Model</span><span class="ad-v" id="adModel">—</span></div>
      <div class="ad-row"><span class="ad-k">Account</span><span class="ad-v" id="adAcct">—</span></div>
      <div class="ad-row"><span class="ad-k">Latency</span><span class="ad-v" id="adLat">—</span></div>
      <div class="ad-notes" id="adNotes">TokenMix-off path. Click Ask ASI1.</div>
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
      const map = { status: 'asi1:desk-status', setMode: 'asi1:desk-mode', infer: 'asi1:desk-infer' };
      return window.electron.invoke(map[name], payload);
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
    const accountIds = ['icloud', 'gitgoin', 'mauro'];
    for (const k of Object.keys(accounts)) {
      if (!accountIds.includes(k)) accountIds.push(k);
    }
    const rows = accountIds.map((id) => {
      const a = accounts[id] || {};
      const keys = a.keys || 0;
      const email = a.email || (id === 'icloud' ? 'mauro_fanelli@icloud.com' : (id === 'gitgoin' ? 'gitgoin87@gmail.com' : 'maurofanellijr@gmail.com'));
      const live = keys > 0;
      const dotClass = live ? 'live' : 'rate';
      const label = id === 'icloud' ? 'icloud (Pro)' : id;
      return `<div class="ad-pill">
        <span class="ad-dot ${dotClass}"></span>
        <span style="font-weight:600;color:${live ? '#00e676' : '#e6e8eb'}">${label}</span>
        <span style="font-size:9px;color:#8ab4f8;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;" title="${email}">${email}</span>
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
    const horizon = document.getElementById('adHorizon')?.value || '15m';
    try {
      if (window.OracleSnapshot?.buildOraclePacket && Desk?.packetFromOracle) {
        const o = window.OracleSnapshot.buildOraclePacket(coin, horizon);
        const pkt = Desk.packetFromOracle(o, { sym: coin, horizon });
        if (pkt.spot != null && pkt.priceToBeatNum != null) return pkt;
      }
    } catch (_) { /* fall through to sample */ }
    const sample = Desk?.SAMPLE_PACKET ? { ...Desk.SAMPLE_PACKET, sym: coin, horizon } : { sym: coin, horizon };
    return sample;
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

  async function refreshStatus() {
    try {
      const st = await invoke('status');
      if (st?.mode) mode = st.mode;
      paintMode();
      paintAccounts(st?.diagnostics || {});
      paintConnectivity(st?.diagnostics || {});
    } catch (_) {
      paintAccounts({});
      paintConnectivity({});
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

      const res = await invoke('infer', { packet, mode, options });
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

  dash.querySelectorAll('.ad-mode').forEach((b) => {
    b.addEventListener('click', () => applyMode(b.getAttribute('data-mode')));
  });
  document.getElementById('adMin')?.addEventListener('click', () => setMinimized(!minimized));
  document.getElementById('adAsk')?.addEventListener('click', ask);

  setMinimized(minimized);
  paintMode();
  applyMode(mode);
  refreshStatus();
  // Auto-refresh connectivity (free diagnostics probe) without requiring a
  // click — actual trade-signal inference (ask()) stays manual/on-demand.
  setInterval(refreshStatus, 3000);

  window.Asi1Desk = {
    getMode: () => mode,
    setMode: applyMode,
    ask,
    refresh: refreshStatus,
  };
})();
