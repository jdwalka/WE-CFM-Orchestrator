// polymarket-terminal.js — Polymarket Pro Suite Terminal UI
// Features: Dual Predictions (5m/15m) + Perpetuals, Live CLOB Orderbook,
//           Token-Bucket Telemetry, Geoblock Badge, Gasless 1-Click Relayer Execution
// WalkerEnterprise WE|||CRYPTO Engine
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  let _activeSymbol = 'BTC';
  let _activeTab = 'predictions'; // 'predictions' | 'perps' | 'portfolio'
  let _autoRefreshTimer = null;
  let _geoStatus = null;
  // Tracks the embed slug currently loaded into the live iframe DOM node, so
  // re-renders (as often as every 250-900ms via refreshActiveView) can leave
  // the iframe alone instead of recreating it every cycle. Recreating it via
  // innerHTML on every render was the tab-flicker bug: on 5m markets the
  // underlying data changes fast enough that the iframe was torn down before
  // it ever finished loading, so it flickered constantly and sometimes never
  // rendered at all.
  let _embedSlug = null;

  async function _initGeoblock() {
    if (window.PolymarketClient?.checkGeoblock) {
      _geoStatus = await window.PolymarketClient.checkGeoblock().catch(() => null);
    }
  }
  _initGeoblock();

  function selectSymbol(sym) {
    _activeSymbol = sym.toUpperCase();
    renderPolymarketTerminal();
  }

  function selectTab(tab) {
    _activeTab = tab;
    renderPolymarketTerminal();
  }

  /**
   * Live CLOB place via Electron IPC (poly:placeOrder).
   * @param {string} side - 'UP' | 'DOWN' (also accepts legacy YES=UP, NO=DOWN)
   * @param {string} contractType - '5M' | '15M'
   * @param {number} [size=10]
   */
  async function handleQuickTrade(side, contractType = '5M', size = 10) {
    const sideNorm = String(side || '').toUpperCase();
    const isUp = sideNorm === 'UP' || sideNorm === 'YES';
    const label = isUp ? 'UP' : 'DOWN';
    const btn = document.getElementById(`btn-quick-${isUp ? 'yes' : 'no'}`)
      || document.getElementById(`btn-quick-${label.toLowerCase()}`);
    if (btn) {
      btn.innerHTML = `<span>⏳ Submitting...</span>`;
      btn.disabled = true;
    }

    try {
      const coin = window.PredictionMarkets?.getCoin?.(_activeSymbol);
      const mkt = contractType === '15M'
        ? (coin?.poly15m || coin?.poly5m)
        : (coin?.poly5m || coin?.poly15m);
      if (!mkt) throw new Error(`No Polymarket ${contractType} market for ${_activeSymbol}`);

      const tokenID = isUp
        ? (mkt.clobUpAssetId || mkt.clobTokenIds?.[0] || mkt.upTokenId)
        : (mkt.clobDownAssetId || mkt.clobTokenIds?.[1] || mkt.downTokenId);
      if (!tokenID) throw new Error('Missing CLOB token id for selected side');

      let price = isUp
        ? (Number(mkt.bestAsk) || Number(mkt.probability) || 0.5)
        : (Number(mkt.downBestAsk) || (1 - Number(mkt.probability || 0.5)));
      price = Math.min(0.99, Math.max(0.01, Number(price.toFixed(3))));

      const status = window.electron?.invoke
        ? await window.electron.invoke('poly:status')
        : { ready: false, liveTrading: false, error: 'No Electron IPC' };

      if (!status?.ready) {
        throw new Error(status?.error || 'CLOB client not ready (check secrets/POLYMARKET_API.txt)');
      }
      if (!status.liveTrading) {
        throw new Error('Live trading off. Set POLY_LIVE_TRADING=1 or "liveTrading": true in secrets.');
      }

      if (!window.__polyLiveConfirmOnce) {
        const ok = window.confirm(
          `Place LIVE Polymarket order?\n${_activeSymbol} BUY ${label} size=${size} @ ${price}\n\nThis spends real funds.`
        );
        if (!ok) throw new Error('Order cancelled by user');
        window.__polyLiveConfirmOnce = true;
      }

      const result = await window.electron.invoke('poly:placeOrder', {
        tokenID,
        side: 'BUY',
        price,
        size: Number(size) || 10,
        orderType: 'GTC',
      });

      if (result?.error) throw new Error(result.error);

      const msg = `✓ LIVE BUY ${label} ${_activeSymbol} ${size}@${(price * 100).toFixed(1)}¢`;
      console.info('[PolymarketPro]', msg, result);
      if (window.showToast) window.showToast(msg, 'success');
      else alert(msg);
    } catch (err) {
      console.error('[PolymarketPro] Quick trade error:', err);
      const msg = `Trade error: ${err.message || err}`;
      if (window.showToast) window.showToast(msg, 'error');
      else alert(msg);
    } finally {
      if (btn) {
        btn.innerHTML = isUp ? 'BUY UP ↗' : 'BUY DOWN ↘';
        btn.disabled = false;
      }
      renderPolymarketTerminal();
    }
  }

  async function handleCancelAll() {
    try {
      if (!window.electron?.invoke) throw new Error('No Electron IPC');
      const result = await window.electron.invoke('poly:cancelAll');
      if (result?.error) throw new Error(result.error);
      const msg = '✓ cancelAll sent';
      if (window.showToast) window.showToast(msg, 'success');
      else alert(msg);
    } catch (err) {
      alert(`Cancel all failed: ${err.message || err}`);
    }
  }

  function renderPolymarketTerminal() {
    // App shell mounts panels into #content (see render-layer.js). The old
    // mainContent / .main-content selectors never matched, so this panel no-op'd
    // and the previous nav view (e.g. Settlement Log / debug) stayed on screen.
    const container =
      document.getElementById('content')
      || document.querySelector('main.content')
      || document.getElementById('mainContent')
      || document.querySelector('.main-content');
    if (!container) {
      console.warn('[PolymarketPro] no #content host — cannot render');
      return;
    }

    const rateLimits = window.PolymarketClient?.getRateLimitStatus?.() || {
      order: { tokens: 60, burstCapacity: 60, refillRate: 40, tier: 'Standard' },
      cancel: { tokens: 120, burstCapacity: 120, refillRate: 80, tier: 'Standard' },
    };

    // Model accuracy (quant engine) vs AI-inference accuracy — tracked separately,
    // never conflated (see src/llm/inference-state-store.js recordOutcome/getAccuracy).
    let modelAccPct = null;
    try {
      window.__WinRateCalculatorInstance?.calculateAccuracy?.();
      const s = window.__WinRateCalculatorInstance?.stats?.overall;
      if (s && s.total > 0) modelAccPct = Number(s.winRate);
    } catch (_) { /* */ }
    const aiAcc = window.InferenceStateStore?.getAccuracy?.()?.overall || { total: 0, pct: null };

    const wsStatus = window.PolymarketWS?.getStatus?.() || {};
    const perpTicker = window.PolymarketPerpsClient?.getTicker?.(_activeSymbol) || {};
    const perpFunding = window.PolymarketPerpsClient?.getFundingRate?.(_activeSymbol) || {};
    const coinData = window.PredictionMarkets?.getCoin?.(_activeSymbol) || {};
    const poly5m = coinData?.poly5m || {};

    const yesProb = Math.round((poly5m.probability || 0.5) * 100);
    const noProb = 100 - yesProb;
    const fmtUsd = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      const d = /^DOGE$/i.test(_activeSymbol) ? 6 : /^XRP$/i.test(_activeSymbol) ? 4 : 2;
      return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    };
    const targetPrice = poly5m.targetPrice
      || fmtUsd(poly5m.targetPriceNum ?? poly5m.priceToBeatNum)
      || 'Live PTB';
    const markPrice = fmtUsd(perpTicker.mark_price)
      || fmtUsd(poly5m.currentPriceNum ?? poly5m.currentPrice)
      || '$--';
    const fundingRateFormatted = perpFunding.funding_rate ? `${(Number(perpFunding.funding_rate) * 100).toFixed(4)}%` : '+0.0100%';

    const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];

    const geoBadge = _geoStatus ? `
      <div style="display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;background:rgba(0,229,255,0.08);border:1px solid rgba(0,229,255,0.3);font-size:11px;color:#00e5ff;">
        <span style="width:7px;height:7px;border-radius:50%;background:#00e5ff;box-shadow:0 0 8px #00e5ff;"></span>
        <span>${_geoStatus.country || 'GLOBAL'} · ${_geoStatus.status}</span>
      </div>
    ` : '';

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;padding:4px 0 24px 0;animation:fadeIn 0.25s ease-out;">
        
        <!-- Header & Telemetry Bar -->
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:12px 16px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" stroke-width="2.2">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <span style="font-size:16px;font-weight:800;letter-spacing:0.5px;color:var(--color-text);">POLYMARKET <span style="color:#00e5ff">PRO</span></span>
            </div>
            <span style="padding:2px 8px;border-radius:4px;background:rgba(0,230,118,0.12);color:#00e676;font-size:11px;font-weight:700;border:1px solid rgba(0,230,118,0.3)">
              LIVE SUITE
            </span>
          </div>

          <!-- Live Status Badges -->
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;">
            ${geoBadge}
            <!-- Token Bucket Monitor -->
            <div style="display:flex;align-items:center;gap:8px;padding:4px 10px;border-radius:6px;background:var(--color-surface-2);border:1px solid var(--color-border);font-size:11px;">
              <span style="color:var(--color-text-faint);">Signer Tokens:</span>
              <span style="color:#00e676;font-weight:700;">Order ${rateLimits.order.tokens}/${rateLimits.order.burstCapacity}</span>
              <span style="color:var(--color-border)">|</span>
              <span style="color:#00e5ff;font-weight:700;">Cancel ${rateLimits.cancel.tokens}/${rateLimits.cancel.burstCapacity}</span>
              <span style="color:var(--color-text-faint);">(${rateLimits.order.tier})</span>
            </div>

            <!-- WebSocket Status -->
            <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--color-text-muted);">
              <span style="width:8px;height:8px;border-radius:50%;background:#00e676;box-shadow:0 0 6px #00e676;"></span>
              <span>CLOB + RTDS WS Live</span>
            </div>
          </div>
        </div>

        <!-- Accuracy Counters: model (quant engine) vs AI inference, tracked separately -->
        <div style="display:flex;flex-wrap:wrap;gap:10px;">
          <div style="flex:1;min-width:160px;display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;background:var(--color-surface);border:1px solid var(--color-border);">
            <span style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;">Model Accuracy</span>
            <span style="margin-left:auto;font-size:14px;font-weight:800;color:${modelAccPct == null ? 'var(--color-text-faint)' : modelAccPct >= 50 ? '#00e676' : '#ff5252'};">
              ${modelAccPct == null ? 'n/a' : modelAccPct + '%'}
            </span>
          </div>
          <div style="flex:1;min-width:160px;display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;background:var(--color-surface);border:1px solid var(--color-border);">
            <span style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;">AI Inference Accuracy</span>
            <span style="margin-left:auto;font-size:14px;font-weight:800;color:${aiAcc.pct == null ? 'var(--color-text-faint)' : aiAcc.pct >= 50 ? '#00e676' : '#ff5252'};">
              ${aiAcc.pct == null ? 'n/a' : aiAcc.pct + '%'}
            </span>
            <span style="font-size:10px;color:var(--color-text-faint);">(${aiAcc.total || 0})</span>
          </div>
        </div>

        <!-- Asset Selector Pills -->
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;">
          <div style="display:flex;gap:6px;overflow-x:auto;">
            ${coins.map(sym => `
              <button onclick="window.PolymarketTerminal.selectSymbol('${sym}')"
                style="padding:6px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.15s;
                       background:${sym === _activeSymbol ? '#00e5ff' : 'var(--color-surface)'};
                       color:${sym === _activeSymbol ? '#000' : 'var(--color-text)'};
                       border:1px solid ${sym === _activeSymbol ? '#00e5ff' : 'var(--color-border)'};
                       box-shadow:${sym === _activeSymbol ? '0 0 12px rgba(0,229,255,0.4)' : 'none'};">
                ${sym}
              </button>
            `).join('')}
          </div>

          <!-- Dual Mode Switch -->
          <div style="display:flex;background:var(--color-surface-2);border-radius:6px;padding:2px;border:1px solid var(--color-border);">
            <button onclick="window.PolymarketTerminal.selectTab('predictions')"
              style="padding:5px 12px;border-radius:4px;font-size:11px;font-weight:700;border:none;cursor:pointer;
                     background:${_activeTab === 'predictions' ? 'var(--color-surface)' : 'transparent'};
                     color:${_activeTab === 'predictions' ? '#00e5ff' : 'var(--color-text-muted)'};">
              ▲▼ 5M/15M Up/Down
            </button>
            <button onclick="window.PolymarketTerminal.selectTab('perps')"
              style="padding:5px 12px;border-radius:4px;font-size:11px;font-weight:700;border:none;cursor:pointer;
                     background:${_activeTab === 'perps' ? 'var(--color-surface)' : 'transparent'};
                     color:${_activeTab === 'perps' ? '#00e5ff' : 'var(--color-text-muted)'};">
              📈 Perpetuals (Perps)
            </button>
          </div>
        </div>

        <!-- Metric KPI Cards -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
          <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:14px;">
            <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;">5M Target (PTB)</div>
            <div style="font-size:20px;font-weight:800;color:#00e5ff;margin-top:4px;">${targetPrice}</div>
            <div style="font-size:11px;color:var(--color-text-muted);margin-top:4px;">Chainlink 30s TWAP Benchmark</div>
          </div>

          <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:14px;">
            <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;">Implied Odds</div>
            <div style="display:flex;align-items:baseline;gap:10px;margin-top:4px;">
              <span style="font-size:20px;font-weight:800;color:#00e676;">YES ${yesProb}%</span>
              <span style="font-size:16px;font-weight:700;color:#ff5252;">NO ${noProb}%</span>
            </div>
            <div style="font-size:11px;color:var(--color-text-muted);margin-top:4px;">Live CLOB Midpoint</div>
          </div>

          ${(() => {
            try {
              const b5 = window.Asi1PreContract?.get?.(_activeSymbol, '5m');
              const b15 = window.Asi1PreContract?.get?.(_activeSymbol, '15m');
              const b = b5 || b15;
              if (!b?.call && !b?.notes) {
                return `<div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:14px;">
                  <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;">ASI1 Pre-Contract</div>
                  <div style="font-size:13px;color:var(--color-text-muted);margin-top:6px;">Waiting for brief…</div>
                </div>`;
              }
              const col = b.call === 'UP' ? '#00e676' : b.call === 'DOWN' ? '#ff5252' : 'var(--color-text)';
              return `<div style="background:var(--color-surface);border:1px solid rgba(165,180,252,0.35);border-radius:8px;padding:14px;">
                <div style="font-size:10px;color:#a5b4fc;text-transform:uppercase;font-weight:800;">✨ ASI1 ${b.horizon || ''}</div>
                <div style="font-size:22px;font-weight:800;color:${col};margin-top:4px;">${b.call || '—'} ${b.confidence != null ? Math.round(b.confidence * 100) + '%' : ''}</div>
                <div style="font-size:11px;color:var(--color-text-muted);margin-top:4px;line-height:1.4;">${String(b.preContract?.action || b.notes || '').slice(0, 120)}</div>
              </div>`;
            } catch (_) {
              return '';
            }
          })()}

          <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:14px;">
            <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;">Perp Mark Price</div>
            <div style="font-size:20px;font-weight:800;color:var(--color-text);margin-top:4px;">${markPrice}</div>
            <div style="font-size:11px;color:var(--color-text-muted);margin-top:4px;">Funding: <span style="color:#00e5ff">${fundingRateFormatted}</span> (8h)</div>
          </div>

          <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:14px;">
            <div style="font-size:10px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:0.05em;">Gasless Relayer v2</div>
            <div style="font-size:20px;font-weight:800;color:#00e676;margin-top:4px;">ACTIVE ✓</div>
            <div style="font-size:11px;color:var(--color-text-muted);margin-top:4px;">0x8a178...b46E (Zero Gas POL)</div>
          </div>
        </div>

        <!-- Main Workspace: Predictions & Order Execution -->
        <div style="display:grid;grid-template-columns:1fr 340px;gap:16px;">
          
          <!-- Left: Live Polymarket Embed & Orderbook Depth -->
          <div style="display:flex;flex-direction:column;gap:16px;">
            <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;overflow:hidden;padding:8px;">
              <div id="poly-pro-embed-slot" style="width:100%;height:340px;"></div>
            </div>

            <!-- Rolling 5M Contract Queue -->
            <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:14px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <span style="font-size:11px;font-weight:700;color:var(--color-text-faint);text-transform:uppercase;">Upcoming 5M Queue (25-Min Horizon)</span>
                <span style="font-size:10px;color:#00e5ff;">Auto-syncing PTB</span>
              </div>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;">
                <div style="background:var(--color-surface-2);border:1px solid #00e5ff;border-radius:6px;padding:8px;text-align:center;">
                  <div style="font-size:10px;color:var(--color-text-muted);">Current Window</div>
                  <div style="font-size:16px;font-weight:800;color:#00e676;margin:2px 0;">${yesProb}%</div>
                  <div style="font-size:10px;color:var(--color-text);">${targetPrice}</div>
                </div>
                <div style="background:var(--color-surface-2);border:1px solid var(--color-border);border-radius:6px;padding:8px;text-align:center;">
                  <div style="font-size:10px;color:var(--color-text-muted);">+5 Min</div>
                  <div style="font-size:16px;font-weight:800;color:var(--color-text);margin:2px 0;">50%</div>
                  <div style="font-size:10px;color:var(--color-text-muted);">Awaiting Lock</div>
                </div>
                <div style="background:var(--color-surface-2);border:1px solid var(--color-border);border-radius:6px;padding:8px;text-align:center;">
                  <div style="font-size:10px;color:var(--color-text-muted);">+10 Min</div>
                  <div style="font-size:16px;font-weight:800;color:var(--color-text);margin:2px 0;">50%</div>
                  <div style="font-size:10px;color:var(--color-text-muted);">Awaiting Lock</div>
                </div>
                <div style="background:var(--color-surface-2);border:1px solid var(--color-border);border-radius:6px;padding:8px;text-align:center;">
                  <div style="font-size:10px;color:var(--color-text-muted);">+15 Min</div>
                  <div style="font-size:16px;font-weight:800;color:var(--color-text);margin:2px 0;">50%</div>
                  <div style="font-size:10px;color:var(--color-text-muted);">Awaiting Lock</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Right: 1-Click Gasless Order Execution Desk -->
          <div style="display:flex;flex-direction:column;gap:12px;">
            <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:16px;">
              <div style="font-size:12px;font-weight:800;color:var(--color-text);letter-spacing:0.5px;margin-bottom:12px;">
                ⚡ GASLESS EXECUTION DESK
              </div>

              <div style="display:flex;flex-direction:column;gap:10px;">
                <!-- Price Target Info -->
                <div style="background:var(--color-surface-2);border-radius:6px;padding:10px;font-size:11px;">
                  <div style="display:flex;justify-content:space-between;color:var(--color-text-muted);">
                    <span>Contract Target:</span>
                    <span style="color:#00e5ff;font-weight:700;">${targetPrice}</span>
                  </div>
                  <div style="display:flex;justify-content:space-between;color:var(--color-text-muted);margin-top:4px;">
                    <span>Gas Price:</span>
                    <span style="color:#00e676;font-weight:700;">0 POL (Relayer Sponsored)</span>
                  </div>
                </div>

                <!-- 1-Click Buy Buttons (Polymarket Up/Down) -->
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px;">
                  <button id="btn-quick-yes" onclick="window.PolymarketTerminal.handleQuickTrade('UP')"
                    style="padding:14px;border-radius:6px;background:#00e676;color:#000;font-size:13px;font-weight:800;border:none;cursor:pointer;box-shadow:0 0 14px rgba(0,230,118,0.4);transition:all 0.15s;">
                    BUY UP ↗ (${yesProb}¢)
                  </button>

                  <button id="btn-quick-no" onclick="window.PolymarketTerminal.handleQuickTrade('DOWN')"
                    style="padding:14px;border-radius:6px;background:#ff5252;color:#fff;font-size:13px;font-weight:800;border:none;cursor:pointer;box-shadow:0 0 14px rgba(255,82,82,0.4);transition:all 0.15s;">
                    BUY DOWN ↘ (${noProb}¢)
                  </button>
                </div>

                <button onclick="window.PolymarketTerminal.handleCancelAll()"
                  style="width:100%;margin-top:8px;padding:8px;border-radius:6px;background:transparent;border:1px solid #ff5252;color:#ff5252;font-size:11px;font-weight:700;cursor:pointer;">
                  ⛔ Cancel All Open Orders
                </button>

                <div style="font-size:10px;color:var(--color-text-faint);text-align:center;margin-top:8px;">
                  Live CLOB via Electron IPC · requires POLY_LIVE_TRADING + secrets/POLYMARKET_API.txt
                </div>
              </div>
            </div>

            <!-- Open on Polymarket Direct Link -->
            <a href="https://polymarket.com" target="_blank" rel="noopener"
               style="display:block;text-align:center;padding:10px;border-radius:6px;background:var(--color-surface-2);border:1px solid var(--color-border);color:var(--color-text-muted);font-size:11px;text-decoration:none;font-weight:600;">
              Open Full Polymarket Portal ↗
            </a>
          </div>

        </div>

      </div>
    `;

    _reconcileEmbed(container, poly5m);
  }

  /**
   * Moves the live Polymarket iframe in/out of its slot without recreating
   * it unless the target market slug actually changed. Called after every
   * innerHTML rewrite of the panel (see comment on _embedSlug above).
   */
  function _reconcileEmbed(container, poly5m) {
    const slot = container.querySelector('#poly-pro-embed-slot');
    if (!slot) return;
    const slug = poly5m.slug || `${_activeSymbol.toLowerCase()}-updown-5m`;

    // The panel's innerHTML rewrite always produces a brand-new slot div, so
    // any previously-loaded iframe is now detached (its old parent is gone).
    // Same slug => just reinsert the SAME node (no reload). Different slug
    // => the embed genuinely needs to point elsewhere, so create fresh.
    if (_embedSlug === slug && window._polyProEmbedFrame) {
      slot.appendChild(window._polyProEmbedFrame);
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.id = `poly-pro-embed-${_activeSymbol}`;
    iframe.title = `${_activeSymbol} Polymarket Live`;
    iframe.src = `https://embed.polymarket.com/market?market=${encodeURIComponent(slug)}&theme=dark&border=false&creator=JohnDaWalka&height=340`;
    iframe.style.cssText = 'width:100%;height:340px;border:0;border-radius:6px;display:block;';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowtransparency', 'true');
    iframe.loading = 'lazy';

    slot.innerHTML = '';
    slot.appendChild(iframe);
    window._polyProEmbedFrame = iframe;
    _embedSlug = slug;
  }

  const PolymarketTerminal = {
    render: renderPolymarketTerminal,
    selectSymbol,
    selectTab,
    handleQuickTrade,
    handleCancelAll,
  };

  window.PolymarketTerminal = PolymarketTerminal;
  console.info('[WE] PolymarketTerminal Pro Suite initialized ✓');
})();
