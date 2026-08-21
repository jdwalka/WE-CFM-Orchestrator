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
        <select id="adCoin">${COINS.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
        <select id="adHorizon"><option value="15m">15m</option><option value="5m">5m</option></select>
      </div>
      <button class="ad-ask" id="adAsk" type="button">Ask ASI1</button>
      <div class="ad-row" style="margin-top:10px"><span class="ad-k">Action</span><span class="ad-badge hold-flat" id="adAction">HOLD_FLAT</span></div>
      <div class="ad-row"><span class="ad-k">Call</span><span class="ad-v" id="adCall">—</span></div>
      <div class="ad-row"><span class="ad-k">Conf</span><span class="ad-v" id="adConf">—</span></div>
      <div class="ad-row"><span class="ad-k">Regime</span><span class="ad-v" id="adRegime">—</span></div>
      <div class="ad-row"><span class="ad-k">Edge</span><span class="ad-v" id="adEdge">—</span></div>
      <div class="ad-row"><span class="ad-k">Size</span><span class="ad-v" id="adSize">—</span></div>
      <div class="ad-row"><span class="ad-k">Model</span><span class="ad-v" id="adModel">—</span></div>
      <div class="ad-row"><span class="ad-k">Account</span><span class="ad-v" id="adAcct">—</span></div>
      <div class="ad-row"><span class="ad-k">Latency</span><span class="ad-v" id="adLat">—</span></div>
      <div class="ad-notes" id="adNotes">TokenMix-off path. Click Ask ASI1.</div>
      <div class="ad-warn" id="adWarn"></div>
      <div class="ad-fb" id="adFb"></div>
    </div>
  `;
  document.body.appendChild(dash);

  let mode = 'asi1_only';
  let minimized = false;
  try { mode = window.localStorage.getItem(MODE_KEY) || 'asi1_only'; } catch (_) { /* */ }
  try { minimized = window.localStorage.getItem(MIN_KEY) === '1'; } catch (_) { /* */ }

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
    const rows = ['gitgoin', 'mauro'].map((id) => {
      const a = accounts[id] || {};
      const keys = a.keys || 0;
      const live = keys > 0;
      return `<div class="ad-pill"><span class="ad-dot ${live ? 'live' : 'rate'}"></span><span>${id}</span><span style="margin-left:auto;color:#8b929a">${keys} key${keys === 1 ? '' : 's'}</span></div>`;
    });
    el.innerHTML = rows.join('') || '<div class="ad-pill">no ASI1 keys</div>';
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
    document.getElementById('adAcct').textContent = contract._meta?.account || '—';
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

  async function refreshStatus() {
    try {
      const st = await invoke('status');
      if (st?.mode) mode = st.mode;
      paintMode();
      paintAccounts(st?.diagnostics || {});
    } catch (_) {
      paintAccounts({});
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
      const res = await invoke('infer', { packet, mode });
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

  window.Asi1Desk = {
    getMode: () => mode,
    setMode: applyMode,
    ask,
    refresh: refreshStatus,
  };
})();
