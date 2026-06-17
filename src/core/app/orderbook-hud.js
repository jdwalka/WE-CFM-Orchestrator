// Orderbook HUD & Depth Logic
(function() {
function startDepthLive(sym) {
    if (_depthLiveCleanup) { _depthLiveCleanup(); _depthLiveCleanup = null; }
    if (!window.OB) return;

    // Remove any previously registered listener to prevent accumulation
    if (_depthBookSym && _depthBookFn) window.OB.offBook?.(_depthBookSym, _depthBookFn);

    const handler = () => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      // Re-render book ladder only (not full re-render, for perf)
      updateDepthBook(sym);
    };

    _depthBookSym = sym;
    _depthBookFn = handler;
    window.OB.onBook(sym, handler);

    // Also redraw liquidity map every 2s
    const mapTimer = setInterval(() => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      requestAnimationFrame(() => drawLiqMap(sym));
    }, 2000);

    // Also update alert list every 5s
    const alertTimer = setInterval(() => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      updateDepthAlerts(sym);
    }, 5000);

    // Also refresh raw wall data every 3s
    const rawWallTimer = setInterval(() => {
      if (currentView !== 'depth' || window._depthSelectedSym !== sym) return;
      updateDepthRawWalls(sym);
    }, 3000);

    _depthLiveCleanup = () => {
      clearInterval(mapTimer);
      clearInterval(alertTimer);
      clearInterval(rawWallTimer);
      window.OB.offBook?.(_depthBookSym, _depthBookFn);
      _depthBookSym = null; _depthBookFn = null;
    };
  }

function updateDepthBook(sym) {
    const book = window.OB?.books?.[sym];
    if (!book) return;
    const ladder = document.querySelector('.ob-ladder');
    if (!ladder) return;
    // Full re-render of the book section only — simpler than diffing
    const MAX_LEVELS = 15;
    const allQtys = [...book.bids.slice(0, MAX_LEVELS), ...book.asks.slice(0, MAX_LEVELS)].map(([, q]) => q);
    const maxQty = allQtys.length > 0 ? Math.max(...allQtys) : 1;
    const avgQty = allQtys.length > 0 ? allQtys.reduce((a, b) => a + b, 0) / allQtys.length : 1;
    const minQty = window.OB?.WALL_MIN_QTY?.[sym] || 0;
    const wallThresh = Math.max(minQty, avgQty * (window.OB?.WALL_MULTI || 3.5));

    const fmtPrice = (p) => {
      if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (p >= 1) return p.toFixed(4);
      return p.toFixed(6);
    };
    const fmtQty = (q) => window.OB?.formatQty?.(sym, q) ?? q.toFixed(2);

    const makeRow = (price, qty, side) => {
      const pct = (qty / maxQty) * 100;
      const isWall = qty >= wallThresh;
      return `<div class="ob-row ${side} ${isWall ? 'ob-wall' : ''}">
        <span class="ob-price">${fmtPrice(price)}</span>
        <div class="ob-bar-wrap"><div class="ob-bar ${side}" style="width:${pct.toFixed(1)}%"></div></div>
        <span class="ob-qty">${fmtQty(qty)}</span>
        ${isWall ? '<span class="ob-wall-badge">WALL</span>' : ''}
      </div>`;
    };

    const askHTML = book.asks.slice(0, MAX_LEVELS).reverse().map(([p, q]) => makeRow(p, q, 'ask')).join('');
    const bidHTML = book.bids.slice(0, MAX_LEVELS).map(([p, q]) => makeRow(p, q, 'bid')).join('');
    const spreadHTML = `<div class="ob-spread-row">
      <span>Spread: ${fmtPrice(book.spread || 0)}</span>
      <span>${book.spreadPct?.toFixed(4) || ''}%</span>
      <span class="ob-mid">$${fmtPrice(book.mid || 0)}</span>
    </div>`;

    ladder.innerHTML = `
      <div class="ob-section-label ask">ASK / RESISTANCE</div>
      ${askHTML || '<div class="ob-empty">Connecting…</div>'}
      ${spreadHTML}
      <div class="ob-section-label bid">BID / SUPPORT</div>
      ${bidHTML || '<div class="ob-empty">Connecting…</div>'}`;

    updateDepthAnalyzer(sym);
  }

function updateDepthAlerts(sym) {
    const container = document.querySelector('.ob-alerts-list');
    if (!container) return;
    const alerts = (window.OB?.wallAlerts || []).filter(a => a.sym === sym).slice(0, 20);
    if (alerts.length === 0) { container.innerHTML = '<div class="ob-alert-empty">No wall events yet</div>'; return; }
    const fmtP = (p) => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(4) : p.toFixed(6);
    container.innerHTML = alerts.map(a => {
      const ago = Math.round((Date.now() - a.ts) / 1000);
      return `<div class="ob-alert-row ${a.bias.toLowerCase()}">
        <span class="ob-alert-dot ${a.bias.toLowerCase()}"></span>
        <span class="ob-alert-text">${a.side}-WALL <strong>${a.type}</strong> @ $${fmtP(a.price)}</span>
        <span class="ob-alert-qty">qty: ${window.OB?.formatQty?.(sym, a.qty) ?? a.qty.toFixed(2)}</span>
        <span class="ob-alert-age">${ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm'}</span>
      </div>`;
    }).join('');
  }

function updateDepthRawWalls(sym) {
    const container = document.getElementById('depth-raw-walls');
    if (!container) return;
    const tracker = window.OB?.wallTracker?.[sym];
    if (!tracker) { container.innerHTML = '<span style="color:var(--color-text-faint);font-size:0.8em;">Waiting for data…</span>'; return; }
    const fmtP = (p) => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(4) : p.toFixed(6);
    const fmtQ = (q) => window.OB?.formatQty?.(sym, q) ?? q.toFixed(2);
    const now = Date.now();

    const bidWalls = [...(tracker.bids || new Map()).entries()]
      .map(([price, d]) => ({ price: +price, qty: d.qty, age: Math.round((now - d.firstTs) / 1000) }))
      .sort((a, b) => b.qty - a.qty).slice(0, 7);
    const askWalls = [...(tracker.asks || new Map()).entries()]
      .map(([price, d]) => ({ price: +price, qty: d.qty, age: Math.round((now - d.firstTs) / 1000) }))
      .sort((a, b) => b.qty - a.qty).slice(0, 7);

    const makeRows = (walls, side) => walls.length === 0
      ? `<div style="color:var(--color-text-faint);font-size:0.78em;padding:4px 0;">None detected</div>`
      : walls.map(w => `
          <div style="display:grid;grid-template-columns:100px 1fr 56px;gap:6px;align-items:center;padding:3px 0;font-size:0.78em;font-family:var(--font-mono);">
            <span style="color:${side === 'bid' ? 'var(--color-green)' : 'var(--color-red)'};font-weight:600;">$${fmtP(w.price)}</span>
            <span style="color:var(--color-text-muted);">${fmtQ(w.qty)}</span>
            <span style="color:var(--color-text-faint);">${w.age < 60 ? w.age + 's' : Math.round(w.age / 60) + 'm'}</span>
          </div>`).join('');

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:8px 14px;">
        <div>
          <div style="font-size:0.68em;color:var(--color-green);text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:6px;">BID WALLS — Support</div>
          ${makeRows(bidWalls, 'bid')}
        </div>
        <div>
          <div style="font-size:0.68em;color:var(--color-red);text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:6px;">ASK WALLS — Resistance</div>
          ${makeRows(askWalls, 'ask')}
        </div>
      </div>`;

    updateDepthAnalyzer(sym);
  }

function updateDepthAnalyzer(sym) {
    const container = document.getElementById('depth-balance-analyzer');
    if (!container) return;

    const metrics = window.OB?.getBalanceMetrics?.(sym) || window.OB?.balanceMetrics?.[sym] || null;
    if (!metrics) {
      container.innerHTML = '<span style="color:var(--color-text-faint);font-size:0.8em;">Waiting for balance metrics…</span>';
      return;
    }

    const fmtMoney = (v) => {
      if (!Number.isFinite(v)) return '—';
      if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + 'B';
      if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
      if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
      return v.toFixed(0);
    };

    const fmtMid = (v) => {
      if (!Number.isFinite(v)) return '—';
      if (v >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (v >= 1) return v.toFixed(4);
      return v.toFixed(6);
    };

    const imb = metrics.imbalance?.value || 0;
    const band = metrics.imbalance?.band || 'balanced';
    const weighted = metrics.weighted || {};
    const depth10 = weighted.level10 || null;
    const depth20 = weighted.level20 || null;
    const velocity = metrics.velocity || {};
    const liquidity = metrics.liquidity || {};
    const wall = metrics.walls || {};
    const dom = wall.dominantWallSide || 'none';
    const ageSec = Math.max(0, Math.round((Date.now() - (metrics.ts || 0)) / 1000));
    const totalNotional = (metrics.bidNotional || 0) + (metrics.askNotional || 0);
    const confidence = totalNotional >= 50_000_000 ? 'high'
      : totalNotional >= 10_000_000 ? 'medium'
        : 'low';

    const bandLabel = ({
      balanced: 'balanced',
      lean_bid: 'lean bid',
      strong_bid: 'strong bid',
      extreme_bid: 'extreme bid',
      lean_ask: 'lean ask',
      strong_ask: 'strong ask',
      extreme_ask: 'extreme ask',
    })[band] || band;

    let read = 'Balanced book, no clear side dominance.';
    if (band.includes('bid') && dom === 'bid') read = 'Bid pressure and support walls align (bullish microstructure).';
    else if (band.includes('ask') && dom === 'ask') read = 'Ask pressure and resistance walls align (bearish microstructure).';
    else if (band.includes('bid')) read = 'Bid pressure present, but wall structure is mixed.';
    else if (band.includes('ask')) read = 'Ask pressure present, but wall structure is mixed.';
    if (Math.abs(velocity.value || 0) >= 0.25) read += ` Imbalance velocity is ${velocity.direction || 'active'} (${velocity.band || 'moving'}).`;
    if (liquidity.band === 'fragile' || liquidity.band === 'thin') read += ` ${liquidity.band} 20-level liquidity; size carefully.`;
    if (confidence === 'low') read += ' Low depth notional, treat signal as tentative.';
    if (ageSec > 6) read += ' Data slightly stale; awaiting fresh ladder updates.';

    const sig = [
      sym,
      fmtMid(metrics.mid),
      (metrics.spreadPct || 0).toFixed(4),
      fmtMoney(metrics.bidNotional),
      fmtMoney(metrics.askNotional),
      imb.toFixed(3),
      band,
      (wall.bidWallConcentration || 0).toFixed(2),
      (wall.askWallConcentration || 0).toFixed(2),
      dom,
      (depth10?.imbalance || 0).toFixed(3),
      (depth20?.imbalance || 0).toFixed(3),
      (velocity.value || 0).toFixed(3),
      liquidity.band || '',
      liquidity.notional20 || 0,
      confidence,
      ageSec,
    ].join('|');
    if (container.dataset.sig === sig) return;
    container.dataset.sig = sig;

    container.innerHTML = `
      <div style="padding:8px 14px;font-family:var(--font-mono);font-size:0.78em;line-height:1.5;color:var(--color-text-muted);">
        <div>BALANCE ${sym}  mid ${fmtMid(metrics.mid)}  spr ${(metrics.spreadPct || 0).toFixed(4)}%  age ${ageSec}s</div>
        <div>NOTIONAL  bid ${fmtMoney(metrics.bidNotional)}  ask ${fmtMoney(metrics.askNotional)}  skew ${imb >= 0 ? '+' : ''}${imb.toFixed(3)}</div>
        <div>WEIGHTED  10L ${depth10?.imbalance >= 0 ? '+' : ''}${(depth10?.imbalance || 0).toFixed(3)}  20L ${depth20?.imbalance >= 0 ? '+' : ''}${(depth20?.imbalance || 0).toFixed(3)}  vel ${velocity.value >= 0 ? '+' : ''}${(velocity.value || 0).toFixed(3)} (${velocity.band || 'stable'})</div>
        <div>LIQUIDITY  10L ${fmtMoney(liquidity.notional10 || 0)}  20L ${fmtMoney(liquidity.notional20 || 0)}  band ${liquidity.band || 'unknown'}  expansion ${(liquidity.depthExpansion || 0).toFixed(2)}x</div>
        <div>BAND  ${bandLabel}  conf ${confidence}</div>
        <div>WALL CONC  bid ${(wall.bidWallConcentration || 0).toFixed(2)}  ask ${(wall.askWallConcentration || 0).toFixed(2)}  dom ${dom}</div>
        <div>READ  ${read}</div>
      </div>`;
  }

function drawLiqMap(sym) {
    const canvas = document.getElementById('liq-map-canvas');
    if (!canvas) { _drawLiqRetryPending = false; return; }

    // Use getBoundingClientRect for reliable CSS dimensions in flex containers
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(rect.width || canvas.offsetWidth || canvas.parentElement?.clientWidth || 400, 200);
    const H = Math.max(rect.height || canvas.offsetHeight || 280, 200);

    // If canvas has no layout dimensions yet, defer — only one retry chain at a time
    if (rect.width === 0 || rect.height === 0) {
      if (!_drawLiqRetryPending) {
        _drawLiqRetryPending = true;
        setTimeout(() => { _drawLiqRetryPending = false; if (document.getElementById('liq-map-canvas')) drawLiqMap(sym); }, 150);
      }
      return;
    }
    _drawLiqRetryPending = false;

    canvas.width = W;
    canvas.height = H;

    const snaps = window.OB?.liquiditySnaps?.[sym];
    if (!snaps || snaps.length < 2) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Collecting data…', W / 2, H / 2);
      return;
    }

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#070d1a';
    ctx.fillRect(0, 0, W, H);

    const PRICE_AXIS_W = 56;
    const TIME_AXIS_H = 18;
    const mapW = W - PRICE_AXIS_W;
    const mapH = H - TIME_AXIS_H;

    const displaySnaps = snaps.slice(-Math.min(snaps.length, Math.floor(mapW)));
    const nCols = displaySnaps.length;
    if (nCols < 2) return;

    const currentMid = displaySnaps[displaySnaps.length - 1].mid || 1;
    const PRICE_RANGE = 0.015; // ±1.5%
    const N_BUCKETS = 80;
    const priceLo = currentMid * (1 - PRICE_RANGE);
    const priceHi = currentMid * (1 + PRICE_RANGE);
    const bucketSize = (priceHi - priceLo) / N_BUCKETS;

    // Build intensity grid [col][bucket]
    const grid = new Float32Array(nCols * N_BUCKETS);
    const isBid = new Uint8Array(nCols * N_BUCKETS); // 1=bid, 0=ask, 2=both

    for (let col = 0; col < nCols; col++) {
      const snap = displaySnaps[col];
      for (const [price, qty] of snap.bids) {
        const bucket = Math.floor((price - priceLo) / bucketSize);
        if (bucket >= 0 && bucket < N_BUCKETS) {
          grid[col * N_BUCKETS + bucket] += qty;
          isBid[col * N_BUCKETS + bucket] = 1;
        }
      }
      for (const [price, qty] of snap.asks) {
        const bucket = Math.floor((price - priceLo) / bucketSize);
        if (bucket >= 0 && bucket < N_BUCKETS) {
          grid[col * N_BUCKETS + bucket] += qty;
          isBid[col * N_BUCKETS + bucket] = isBid[col * N_BUCKETS + bucket] === 1 ? 2 : 0;
        }
      }
    }

    // 95th percentile max for color scale
    const nonZero = [];
    for (let i = 0; i < grid.length; i++) { if (grid[i] > 0) nonZero.push(grid[i]); }
    nonZero.sort((a, b) => a - b);
    const p95 = nonZero[Math.floor(nonZero.length * 0.95)] || 1;

    // Draw columns
    const colW = mapW / nCols;
    const rowH = mapH / N_BUCKETS;

    for (let col = 0; col < nCols; col++) {
      for (let b = 0; b < N_BUCKETS; b++) {
        const val = grid[col * N_BUCKETS + b];
        if (val === 0) continue;
        const intensity = Math.min(val / p95, 1);
        const side = isBid[col * N_BUCKETS + b];
        let r, g, bl;
        if (side === 1) { // bid = blue/cyan
          r = Math.round(0 * intensity); g = Math.round(150 * intensity); bl = Math.round(255 * intensity);
        } else if (side === 0) { // ask = red/orange
          r = Math.round(255 * intensity); g = Math.round(60 * intensity); bl = 0;
        } else { // both = purple
          r = Math.round(140 * intensity); g = 0; bl = Math.round(200 * intensity);
        }
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        // Y: bucket 0 = priceLo (bottom), flip so higher price = higher on canvas
        const y = mapH - (b + 1) * rowH;
        ctx.fillRect(PRICE_AXIS_W + col * colW, y, Math.max(colW, 1), rowH + 0.5);
      }
    }

    // Mid price line
    const midBucket = (currentMid - priceLo) / bucketSize;
    const midY = mapH - midBucket * rowH;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(PRICE_AXIS_W, midY);
    ctx.lineTo(W, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Wall event markers
    const events = window.OB?.wallEventLog?.[sym] || [];
    const firstSnapTs = displaySnaps[0].ts;
    const lastSnapTsVal = displaySnaps[displaySnaps.length - 1].ts;
    const tsRange = lastSnapTsVal - firstSnapTs || 1;

    for (const ev of events) {
      if (ev.ts < firstSnapTs || ev.ts > lastSnapTsVal + 5000) continue;
      const xFrac = (ev.ts - firstSnapTs) / tsRange;
      const x = PRICE_AXIS_W + xFrac * mapW;
      const priceBucket = (ev.price - priceLo) / bucketSize;
      const y = mapH - priceBucket * rowH;
      // Draw diamond
      const color = ev.bias === 'BULL' ? '#00ff88' : '#ff4466';
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x, y + 5);
      ctx.lineTo(x - 4, y);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Price axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    const fmtP = (p) => p >= 1000 ? '$' + (p / 1000).toFixed(1) + 'K' : p >= 1 ? '$' + p.toFixed(2) : '$' + p.toFixed(4);
    for (let i = 0; i <= 4; i++) {
      const price = priceLo + (i / 4) * (priceHi - priceLo);
      const y = mapH - (i / 4) * mapH;
      ctx.fillText(fmtP(price), PRICE_AXIS_W - 2, y + 3);
    }

    // Time axis
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('now', W - 10, H - 3);
    const minutesBack = Math.round((tsRange / 1000) / 60);
    if (minutesBack > 0) ctx.fillText(`-${minutesBack}m`, PRICE_AXIS_W + 20, H - 3);
  }

function initOBHud() {
    const hud = document.getElementById('ob-hud');
    if (!hud) return;
    let minimized = false;
    let hudFilter = 'ALL';
    let soundOn = isTradeBellOn();

    function renderHud() {
      const all = window.OB?.wallAlerts || [];
      const alerts = hudFilter === 'ALL' ? all : all.filter(a => a.sym === hudFilter);
      const shown = alerts.slice(0, 15);

      const syms = PREDICTION_COINS.map(c => c.sym);
      const filterPills = ['ALL', ...syms].map(s => {
        const active = s === hudFilter ? 'active' : '';
        return `<button class="hud-pill ${active}" data-hud-filter="${s}">${s}</button>`;
      }).join('');

      const fmtP = (p) => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(3) : p.toFixed(5);

      const rows = shown.map(a => {
        const ago = Math.round((Date.now() - a.ts) / 1000);
        const agoStr = ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`;
        return `<div class="hud-row ${a.bias.toLowerCase()} ${Date.now() - a.ts < 2000 ? 'hud-new' : ''}">
          <span class="hud-dot ${a.bias.toLowerCase()}"></span>
          <span class="hud-sym">${a.sym}</span>
          <span class="hud-msg">${a.side} ${a.type}</span>
          <span class="hud-price">$${fmtP(a.price)}</span>
          <span class="hud-age">${agoStr}</span>
        </div>`;
      }).join('');

      const connCount = window.OB?.getConnected?.()?.length || 0;

      hud.innerHTML = `
        <div class="hud-header">
          <span class="hud-title">⚡ WALL ALERTS <span class="hud-conn">${connCount}/7</span></span>
          <div class="hud-header-btns">
            <button class="hud-icon-btn" id="hud-sound-btn" title="Toggle signal alerts">
              ${soundOn ? '🔔' : '🔕'}
            </button>
            <button class="hud-icon-btn" id="hud-min-btn" title="Minimize">
              ${minimized ? '▲' : '▼'}
            </button>
          </div>
        </div>
        ${!minimized ? `
          <div class="hud-filters">${filterPills}</div>
          <div class="hud-rows">${rows || '<div class="hud-empty">Monitoring for wall events…</div>'}</div>
        ` : ''}`;

      // Attach handlers
      hud.querySelector('#hud-min-btn')?.addEventListener('click', () => {
        minimized = !minimized; renderHud();
      });
      hud.querySelector('#hud-sound-btn')?.addEventListener('click', () => {
        soundOn = !soundOn;
        setTradeBellOn(soundOn);
        renderHud();
      });
      hud.querySelectorAll('[data-hud-filter]').forEach(btn => {
        btn.addEventListener('click', () => { hudFilter = btn.dataset.hudFilter; renderHud(); });
      });
    }

    // Re-render HUD every 3 seconds
    setInterval(renderHud, 3000);
    renderHud();

    // Live Market Divergence timer — update elapsed time on cards every 3s
    setInterval(() => {
      document.querySelectorAll('[data-mdiv-ts]').forEach(el => {
        const ts = parseInt(el.dataset.mdivTs, 10);
        if (!ts || isNaN(ts)) return;
        const sec = Math.floor((Date.now() - ts) / 1000);
        el.textContent = sec >= 60
          ? Math.floor(sec / 60) + 'm ' + (sec % 60) + 's'
          : sec + 's';
      });
    }, 3000);

    // Live countdown for all Kalshi contract close times — ticks every 1s
    setInterval(() => {
      document.querySelectorAll('[data-close-ms]').forEach(el => {
        const closeMs = parseInt(el.dataset.closeMs, 10);
        if (!closeMs || isNaN(closeMs)) return;
        const msLeft = closeMs - Date.now();
        if (msLeft <= 0) {
          if (el.classList.contains('k15-expiry')) {
            el.classList.add('k15-settling');
            el.textContent = '⏱ SETTLING';
          } else {
            el.innerHTML = '⏱ <strong>SETTLING</strong>';
            el.style.color = 'var(--color-text-muted)';
          }
          return;
        }
        const s = Math.floor(msLeft / 1000);
        const m = Math.floor(s / 60);
        const sec = s % 60;
        if (el.classList.contains('k15-expiry')) {
          el.textContent = `⏱ ${m}m${String(sec).padStart(2, '0')}s`;
          el.style.color = s < 60 ? 'var(--color-red)' : s < 180 ? '#ffd700' : '';
        } else {
          const str = m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
          el.innerHTML = `⏱ <strong>${str}</strong> left`;
          el.style.color = s < 60 ? 'var(--color-red)' : s < 180 ? '#ffd700' : '';
        }
      });
    }, 1000);

    // Re-render immediately on alert
    window.OB?.onAlert(() => renderHud());
  }

function drawOrbital() {
    const canvas = document.getElementById('orbital-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;

    ctx.clearRect(0, 0, W, H);

    // Background glow
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, 30, cx, cy, Math.max(W, H) * 0.7);
    grad.addColorStop(0, 'rgba(79,158,255,0.12)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Orbital rings
    [0, 1, 2].forEach(i => {
      const r = 110 + i * 95;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(120,130,160,${0.28 - i * 0.06})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 7]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Nucleus
    ctx.save();
    ctx.shadowBlur = 22;
    ctx.shadowColor = 'rgba(79,158,255,0.55)';
    ctx.fillStyle = 'rgba(79,158,255,0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,158,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(130,150,200,0.9)';
    ctx.font = 'bold 10px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CFM', cx, cy);
    ctx.restore();

    // Coin nodes
    PREDICTION_COINS.forEach((coin, index) => {
      const pred = window._predictions?.[coin.sym] || {};
      const score = pred.score || 0;
      const angle = (index * (Math.PI * 2 / PREDICTION_COINS.length)) + (Date.now() / 8000);
      const orbitIdx = ['BTC', 'ETH', 'BNB'].includes(coin.sym) ? 0 : ['SOL', 'XRP'].includes(coin.sym) ? 1 : 2;
      const r = 110 + orbitIdx * 95;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      const hue = score > 0.1 ? 150 : score < -0.1 ? 340 : 210;

      ctx.save();
      ctx.shadowBlur = 14;
      ctx.shadowColor = `hsl(${hue}, 88%, 60%)`;
      ctx.fillStyle = `hsl(${hue}, 88%, 58%)`;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.fill();

      // Coin icon text
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(coin.icon || coin.sym[0], x, y + 1);

      // Ticker label below node
      ctx.font = '500 10px monospace';
      ctx.fillText(coin.sym, x, y + 32);
      ctx.restore();
    });

    orbitalAnimationFrame = requestAnimationFrame(drawOrbital);
  }

function refreshCexFlow(sym, el) {
    if (!el) el = document.getElementById('universe-cex');
    if (!el) return;
    _cexActiveSym = sym;

    const data = window.CexFlow?.get(sym) ?? null;
    const chain = window.ChainRouter?.get(sym) ?? null;
    const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
    const loading = !data;

    // Coin selector tabs
    const coinTabs = COINS.map(c =>
      `<button class="cex-coin-tab ${c === sym ? 'active' : ''}" data-cex-coin="${c}">${c}</button>`
    ).join('');

    // Aggregate bar
    const agg = data?.aggregate;
    const aggColor = agg
      ? agg.score < -0.2 ? 'var(--color-red)' : agg.score > 0.2 ? 'var(--color-green)' : 'var(--color-text-muted)'
      : 'var(--color-text-muted)';
    const aggLabel = agg?.label ?? '—';
    const sAgo = data?.ts ? Math.round((Date.now() - data.ts) / 1000) : null;
    const staleTag = sAgo != null && sAgo > 60
      ? `<span style="color:var(--color-orange);font-size:10px">⚠ ${sAgo}s ago</span>`
      : sAgo != null ? `<span style="color:var(--color-text-faint);font-size:10px">↻ ${sAgo}s ago</span>` : '';

    // Chain velocity row
    let chainRow = '';
    if (chain) {
      const vel = chain.velocity?.score ?? 0;
      const velLabel = chain.velocityLabel ?? 'Stable';
      const velColor = vel > 0.15 ? 'var(--color-green)' : vel < -0.10 ? 'var(--color-red)' : 'var(--color-text-muted)';
      chainRow = `
        <div class="cex-chain-row">
          <span class="cex-chain-label">On-Chain (${chain.source})</span>
          <span style="color:${velColor};font-weight:700">${velLabel}</span>
          <span style="color:var(--color-text-muted);font-size:11px">velocity ${vel > 0 ? '+' : ''}${(vel * 100).toFixed(0)}%</span>
          <span style="color:${aggColor};font-size:11px">${chain.congestion} congestion · Leading: ${(chain.leadingScore ?? chain.score ?? 0) > 0 ? '↑ bullish' : (chain.leadingScore ?? chain.score ?? 0) < 0 ? '↓ bearish' : '—'}</span>
        </div>`;
    }

    // Exchange rows
    const exchanges = data?.exchanges ?? [];
    const exRows = exchanges.length
      ? exchanges.map(ex => {
        if (!ex.available) {
          return `<tr class="cex-row cex-na">
              <td class="cex-name">${ex.exchange}</td>
              <td colspan="4" style="color:var(--color-text-faint);font-size:11px">${ex.reason ?? 'Not listed'}</td>
            </tr>`;
        }
        const sigColor = ex.color === 'red' ? 'var(--color-red)' : ex.color === 'green' ? 'var(--color-green)' : ex.color === 'orange' ? 'var(--color-orange)' : 'var(--color-text-muted)';
        const sigDot = ex.color === 'red' ? '🔴' : ex.color === 'green' ? '🟢' : ex.color === 'orange' ? '🟠' : '⚪';
        const fundStr = ex.fundingPct != null ? `${ex.fundingPct > 0 ? '+' : ''}${ex.fundingPct.toFixed(3)}%` : '—';
        const volStr = ex.volMult != null ? `${ex.volMult.toFixed(1)}×` : '—';
        const volColor = ex.volMult != null && ex.volMult > 2 ? 'var(--color-orange)' : ex.volMult != null && ex.volMult > 1.4 ? 'var(--color-gold)' : 'var(--color-text-muted)';
        return `<tr class="cex-row">
            <td class="cex-name">${ex.exchange}</td>
            <td class="cex-buysell">
              <span style="color:var(--color-green)">${ex.buyPct.toFixed(0)}%B</span>
              <span style="color:var(--color-text-faint)">/</span>
              <span style="color:var(--color-red)">${ex.sellPct.toFixed(0)}%S</span>
            </td>
            <td style="color:${volColor}">${volStr}</td>
            <td style="color:${ex.fundingPct != null && ex.fundingPct > 0.02 ? 'var(--color-red)' : ex.fundingPct != null && ex.fundingPct < -0.02 ? 'var(--color-green)' : 'var(--color-text-muted)'}">${fundStr}</td>
            <td><span style="color:${sigColor};font-weight:700">${sigDot} ${ex.signal}</span></td>
          </tr>`;
      }).join('')
      : `<tr><td colspan="5" style="text-align:center;color:var(--color-text-faint);padding:24px">
          ${loading ? 'Loading exchange data…' : 'No data available'}
         </td></tr>`;

    // Aggregate summary row
    const aggSummaryRow = agg ? `
      <tr class="cex-agg-row">
        <td colspan="5">
          <span style="color:${aggColor};font-weight:800">${aggLabel}</span>
          <span style="color:var(--color-text-muted);font-size:11px;margin-left:10px">
            ${agg.distributing} dist · ${agg.accumulating} accum · ${agg.volatile} volatile
          </span>
          ${agg.maxFunding ? `<span style="color:var(--color-orange);font-size:11px;margin-left:8px">⚡ Max funding: ${agg.maxFunding.exchange} ${agg.maxFunding.pct > 0 ? '+' : ''}${agg.maxFunding.pct.toFixed(3)}%</span>` : ''}
        </td>
      </tr>` : '';

    el.innerHTML = `
      <div class="cex-flow-panel">
        <div class="cex-header">
          <div class="cex-coin-tabs">${coinTabs}</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:11px;color:var(--color-text-muted)">CEX FLOW MONITOR</span>
            ${staleTag}
            <button class="cex-refresh-btn" onclick="window.CexFlow?.fetchAll()">↻</button>
          </div>
        </div>
        ${chainRow}
        <div class="cex-table-wrap">
          <table class="cex-table">
            <thead>
              <tr>
                <th>Exchange</th>
                <th>Buy / Sell</th>
                <th>Vol ×Avg</th>
                <th>Funding</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              ${exRows}
              ${aggSummaryRow}
            </tbody>
          </table>
        </div>
        <div class="cex-footnote">
          Buy/Sell from last 200–500 trades · Funding from perpetuals · Vol = current 24h vs rolling avg
        </div>
      </div>`;

    // Wire coin tab clicks
    el.querySelectorAll('[data-cex-coin]').forEach(btn => {
      btn.addEventListener('click', () => refreshCexFlow(btn.dataset.cexCoin, el));
    });
  }
window.APP_ORDERBOOK_HUD = {
  startDepthLive, updateDepthBook, updateDepthAlerts, updateDepthRawWalls, 
  updateDepthAnalyzer, drawLiqMap, initOBHud, drawOrbital, refreshCexFlow
};
})();
