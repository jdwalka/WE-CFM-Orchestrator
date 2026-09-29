// ================================================================
// onchain-side-scan.js — Compressed on-chain features for Grok + sizing
// ================================================================
// BTC / ETH / SOL only. Does NOT dump raw txs into the LLM.
//
// Architecture:
//   ChainRouter + WhaleAlert + CexFlow  →  feature vector (10–15s)
//   Mechanical gate uses vector for size / burst (ms path)
//   Grok receives the SAME compact JSON on 5m/15m fires (interpretive)
//
// Exposes: window.OnChainFlow
//   .get(sym)              → feature packet or null
//   .getAll()              → map
//   .isBurst(sym)          → boolean
//   .sizeMultiplier(sym, modelDir)  → 0.5–1.5
//   .lean(sym)             → 'up' | 'down' | 'flat'
//   .packetForGrok(sym)    → truncated JSON-safe blob for LLM prompts
//   .start() / .stop() / .refresh()
// Events: onchain-side-scan-update  detail = { coin → packet }
// ================================================================

(function () {
  'use strict';

  const COINS = ['BTC', 'ETH', 'SOL'];
  const POLL_MS = 12_000;
  const STALE_MS = 90_000;
  const HISTORY_LEN = 8;

  const CACHE = {};       // sym → packet
  const HISTORY = {};     // sym → [raw snapshots]
  let _timer = null;
  let _inFlight = false;

  function num(v, d = null) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function velPct(curr, prev) {
    if (!(prev > 0) || !Number.isFinite(curr)) return 0;
    return (curr - prev) / prev;
  }

  function pushHist(sym, raw) {
    if (!HISTORY[sym]) HISTORY[sym] = [];
    HISTORY[sym].push({ ts: Date.now(), ...raw });
    if (HISTORY[sym].length > HISTORY_LEN) HISTORY[sym].shift();
  }

  function prevRaw(sym) {
    const h = HISTORY[sym];
    if (!h || h.length < 2) return null;
    return h[h.length - 2];
  }

  // ── Pull raw metrics from existing scanners (no extra HTTP if warm) ──

  function readChainRouter(sym) {
    try {
      const src = window.ChainRouter || window.BlockchainScan;
      if (!src || typeof src.get !== 'function') return null;
      return src.get(sym) || null;
    } catch (_) {
      return null;
    }
  }

  function readWhale(sym) {
    try {
      if (!window.WhaleAlertMonitor) return null;
      const score = typeof window.WhaleAlertMonitor.getAccumulationScore === 'function'
        ? window.WhaleAlertMonitor.getAccumulationScore(sym)
        : 0;
      const cache = window.WhaleAlertMonitor._debugCache
        ? window.WhaleAlertMonitor._debugCache(sym)
        : null;
      let txs = [];
      // Prefer cached getWhaleTransactions sync path via last fetch if available
      if (typeof window.WhaleAlertMonitor.getCached === 'function') {
        const c = window.WhaleAlertMonitor.getCached(sym);
        if (c && Array.isArray(c.txs)) txs = c.txs;
      }
      let inflowUsd = 0;
      let outflowUsd = 0;
      let largeTxCount = 0;
      for (const tx of txs) {
        const usd = num(tx.amount_usd || tx.score, 0);
        if (usd <= 0) continue;
        largeTxCount++;
        if (tx.direction === 'sell') inflowUsd += usd;   // to exchange
        else if (tx.direction === 'buy') outflowUsd += usd; // from exchange
      }
      return {
        accumulationScore: num(score, 0),
        exchangeInflowUsd: inflowUsd,
        exchangeOutflowUsd: outflowUsd,
        netExchangeFlowUsd: outflowUsd - inflowUsd,
        largeTxCount,
      };
    } catch (_) {
      return null;
    }
  }

  function readCex(sym) {
    try {
      if (!window.CexFlow || typeof window.CexFlow.get !== 'function') return null;
      const e = window.CexFlow.get(sym);
      if (!e) return null;
      const agg = e.aggregate || {};
      const hf = e.hf || {};
      return {
        vpin: num(hf.vpin),
        whaleTrades10k: num(hf.whaleTrades10k, 0),
        whaleTrades50k: num(hf.whaleTrades50k, 0),
        buyPct: num(hf.buyPct),
        sellPct: num(hf.sellPct),
        volMult: num(agg.volMult),
        hurst: num(agg.hurst_v),
        label: agg.label || null,
        connected: !!hf.connected || !!hf.active,
      };
    } catch (_) {
      return null;
    }
  }

  function extractChainRaw(sym, chainRow) {
    const raw = (chainRow && chainRow.raw) || {};
    const congestion = String((chainRow && chainRow.congestion) || 'LOW').toUpperCase();
    const score = num(chainRow && chainRow.score, 0);
    const signal = (chainRow && chainRow.signal) || 'NEUTRAL';
    const source = (chainRow && chainRow.source) || 'unknown';

    if (sym === 'BTC') {
      return {
        feeFast: num(raw.feeFast, 0),
        feeMed: num(raw.feeMed, 0),
        vsize: num(raw.vsize, 0),
        txCount: num(raw.txCount, 0),
        congestion,
        score,
        signal,
        source,
      };
    }
    if (sym === 'ETH') {
      return {
        gasAvg: num(raw.gasAvg, 0),
        gasFast: num(raw.gasFast, 0),
        gasSlow: num(raw.gasSlow, 0),
        txsToday: num(raw.txsToday, 0),
        congestion,
        score,
        signal,
        source,
      };
    }
    // SOL
    return {
      avgTPS: num(raw.avgTPS, 0),
      peakTPS: num(raw.peakTPS, 0),
      slot: num(raw.slot, 0),
      epoch: num(raw.epoch, 0),
      congestion,
      score,
      signal,
      source,
    };
  }

  function feeGasCongestionPctl(sym, chainRaw) {
    // Rough percentile proxies for "how hot is the network"
    if (sym === 'BTC') {
      const fee = chainRaw.feeFast || 0;
      if (fee >= 80) return 95;
      if (fee >= 40) return 80;
      if (fee >= 20) return 60;
      if (fee >= 10) return 40;
      return 20;
    }
    if (sym === 'ETH') {
      const g = chainRaw.gasAvg || 0;
      if (g >= 80) return 95;
      if (g >= 40) return 80;
      if (g >= 20) return 60;
      if (g >= 10) return 40;
      return 20;
    }
    const tps = chainRaw.avgTPS || 0;
    if (tps >= 4000) return 90;
    if (tps >= 2500) return 70;
    if (tps >= 1500) return 50;
    if (tps >= 800) return 30;
    return 15;
  }

  // ── Compress into trading packet ─────────────────────────────────

  function buildPacket(sym) {
    const chainRow = readChainRouter(sym);
    const chainRaw = extractChainRaw(sym, chainRow);
    const whale = readWhale(sym) || {
      accumulationScore: 0,
      exchangeInflowUsd: 0,
      exchangeOutflowUsd: 0,
      netExchangeFlowUsd: 0,
      largeTxCount: 0,
    };
    const cex = readCex(sym);

    pushHist(sym, {
      feeFast: chainRaw.feeFast,
      gasAvg: chainRaw.gasAvg,
      avgTPS: chainRaw.avgTPS,
      vsize: chainRaw.vsize,
      netFlow: whale.netExchangeFlowUsd,
    });
    const prev = prevRaw(sym);

    // Velocity of congestion / activity
    let activityVel = 0;
    if (sym === 'BTC' && prev) {
      activityVel = velPct(chainRaw.feeFast, prev.feeFast) * 0.7
        + velPct(chainRaw.vsize, prev.vsize) * 0.3;
    } else if (sym === 'ETH' && prev) {
      activityVel = velPct(chainRaw.gasAvg, prev.gasAvg);
    } else if (sym === 'SOL' && prev) {
      activityVel = velPct(chainRaw.avgTPS, prev.avgTPS);
    }

    const mempoolFeePctl = feeGasCongestionPctl(sym, chainRaw);
    const congestionHigh = chainRaw.congestion === 'HIGH' || mempoolFeePctl >= 80;

    // Directional lean from whale exchange flows + CEX aggressor
    // outflow from exchange (buy) = bullish; inflow to exchange (sell) = bearish
    let leanScore = 0;
    leanScore += clamp(whale.accumulationScore, -1, 1) * 0.45;
    if (whale.netExchangeFlowUsd > 1e6) leanScore += 0.25;
    else if (whale.netExchangeFlowUsd < -1e6) leanScore -= 0.25;
    if (cex) {
      if (Number.isFinite(cex.buyPct) && Number.isFinite(cex.sellPct)) {
        leanScore += clamp((cex.buyPct - cex.sellPct) / 100, -0.4, 0.4);
      }
      if (cex.whaleTrades50k > 0 && Number.isFinite(cex.buyPct)) {
        leanScore += cex.buyPct >= 55 ? 0.15 : cex.buyPct <= 45 ? -0.15 : 0;
      }
    }
    // Congestion alone is not directional — only risk flag
    leanScore = clamp(leanScore, -1, 1);

    const lean = leanScore > 0.12 ? 'up' : leanScore < -0.12 ? 'down' : 'flat';

    const burstReasons = [];
    if (congestionHigh && Math.abs(activityVel) >= 0.15) {
      burstReasons.push(sym === 'BTC' ? 'mempool-fee-spike' : sym === 'ETH' ? 'gas-spike' : 'tps-spike');
    }
    if (Math.abs(activityVel) >= 0.35) burstReasons.push('activity-velocity');
    if (whale.largeTxCount >= 2 || Math.abs(whale.netExchangeFlowUsd) >= 2e6) {
      burstReasons.push('whale-exchange-flow');
    }
    if (cex) {
      if (Number.isFinite(cex.vpin) && cex.vpin >= 0.4) burstReasons.push('cex-vpin');
      if ((cex.whaleTrades50k || 0) > 0) burstReasons.push('cex-whale-50k');
      else if ((cex.whaleTrades10k || 0) >= 3) burstReasons.push('cex-whale-cluster');
      if (Number.isFinite(cex.volMult) && cex.volMult >= 2.0) burstReasons.push('cex-vol-mult');
    }

    const burst = burstReasons.length > 0;

    // Mechanical size mult for ALWAYS_TRADE path (modelDir: 'UP'|'DOWN'|null)
    // Agreement with lean → boost; disagreement → dampen; congestion-only → slight cut
    function sizeMultiplier(modelDir) {
      let m = 1.0;
      const d = String(modelDir || '').toUpperCase();
      const modelUp = d === 'UP' || d === 'YES' || d === 'LONG' || d === '1';
      const modelDown = d === 'DOWN' || d === 'NO' || d === 'SHORT' || d === '-1';
      if (lean === 'up' && modelUp) m = 1.25;
      else if (lean === 'down' && modelDown) m = 1.25;
      else if (lean === 'up' && modelDown) m = 0.55;
      else if (lean === 'down' && modelUp) m = 0.55;
      else if (lean === 'flat' && congestionHigh) m = 0.85;
      if (burst && Math.abs(leanScore) < 0.08 && congestionHigh) m = Math.min(m, 0.7);
      return clamp(m, 0.5, 1.5);
    }

    const packet = {
      coin: sym,
      ts: Date.now(),
      source: chainRaw.source || 'onchain-side-scan',
      chain: {
        congestion: chainRaw.congestion || 'LOW',
        mempoolFeePctl,
        activityVel: Number(activityVel.toFixed(4)),
        score: chainRaw.score,
        signal: chainRaw.signal,
        // coin-specific raw (compressed)
        ...(sym === 'BTC' ? {
          feeFast: chainRaw.feeFast,
          feeMed: chainRaw.feeMed,
          mempoolVsize: chainRaw.vsize,
          mempoolTxCount: chainRaw.txCount,
        } : {}),
        ...(sym === 'ETH' ? {
          gasAvg: chainRaw.gasAvg,
          gasFast: chainRaw.gasFast,
          gasSlow: chainRaw.gasSlow,
        } : {}),
        ...(sym === 'SOL' ? {
          avgTPS: chainRaw.avgTPS,
          peakTPS: chainRaw.peakTPS,
          slot: chainRaw.slot,
        } : {}),
      },
      whale: {
        accumulationScore: Number(num(whale.accumulationScore, 0).toFixed(3)),
        exchangeInflowUsd1m: Math.round(whale.exchangeInflowUsd || 0),
        exchangeOutflowUsd1m: Math.round(whale.exchangeOutflowUsd || 0),
        netExchangeFlowUsd: Math.round(whale.netExchangeFlowUsd || 0),
        netExchangeFlow: (whale.netExchangeFlowUsd || 0) > 5e5
          ? 'outflow'
          : (whale.netExchangeFlowUsd || 0) < -5e5
            ? 'inflow'
            : 'neutral',
        largeTxCount: whale.largeTxCount || 0,
      },
      cex: cex || null,
      lean,
      leanScore: Number(leanScore.toFixed(3)),
      burst,
      burstReasons,
      sizeMultiplier,
      // Pre-bound for common model dirs (serializable for LLM)
      sizeMultUp: sizeMultiplier('UP'),
      sizeMultDown: sizeMultiplier('DOWN'),
      stale: !(chainRow && chainRow.ts) || (Date.now() - Number(chainRow.ts || 0) > STALE_MS),
    };

    return packet;
  }

  async function refreshOnce() {
    if (_inFlight) return CACHE;
    _inFlight = true;
    try {
      // Nudge underlying scanners if present
      try {
        if (window.ChainRouter && typeof window.ChainRouter.fetchAll === 'function') {
          // non-blocking; use cache if in-flight
          Promise.resolve(window.ChainRouter.fetchAll()).catch(() => {});
        } else if (window.BlockchainScan && typeof window.BlockchainScan.fetchAll === 'function') {
          Promise.resolve(window.BlockchainScan.fetchAll()).catch(() => {});
        }
      } catch (_) {}

      // Whale cache refresh: DROPPED feed (dead API key → permanent 401s).
      // Re-enable per-call with window.__WE_ENABLE_WHALE__ === true.
      try {
        if (window.__WE_ENABLE_WHALE__ === true && window.WhaleAlertMonitor && typeof window.WhaleAlertMonitor.getWhaleTransactions === 'function') {
          for (const c of ['BTC', 'ETH']) {
            window.WhaleAlertMonitor.getWhaleTransactions(c).catch(() => {});
          }
        }
      } catch (_) {}

      for (const sym of COINS) {
        try {
          CACHE[sym] = buildPacket(sym);
        } catch (err) {
          console.warn('[OnChainFlow] build failed', sym, err && err.message);
        }
      }

      try {
        window.dispatchEvent(new CustomEvent('onchain-side-scan-update', {
          detail: Object.assign({}, CACHE),
        }));
      } catch (_) {}

      return CACHE;
    } finally {
      _inFlight = false;
    }
  }

  function get(sym) {
    const key = String(sym || '').toUpperCase();
    if (!COINS.includes(key)) return null;
    if (!CACHE[key]) {
      try { CACHE[key] = buildPacket(key); } catch (_) { return null; }
    }
    return CACHE[key] || null;
  }

  function getAll() {
    const out = {};
    for (const c of COINS) out[c] = get(c);
    return out;
  }

  function isBurst(sym) {
    const p = get(sym);
    return !!(p && p.burst);
  }

  function lean(sym) {
    const p = get(sym);
    return (p && p.lean) || 'flat';
  }

  function sizeMultiplier(sym, modelDir) {
    const p = get(sym);
    if (!p) return 1.0;
    if (typeof p.sizeMultiplier === 'function') return p.sizeMultiplier(modelDir);
    const d = String(modelDir || '').toUpperCase();
    if (d === 'UP' || d === 'YES') return p.sizeMultUp != null ? p.sizeMultUp : 1;
    if (d === 'DOWN' || d === 'NO') return p.sizeMultDown != null ? p.sizeMultDown : 1;
    return 1.0;
  }

  /** Compact blob safe for Grok prompts (no functions, truncated). */
  function packetForGrok(sym) {
    const p = get(sym);
    if (!p) return { note: 'no on-chain side-scan yet', coin: String(sym || '').toUpperCase() };
    return {
      coin: p.coin,
      ageMs: Date.now() - (p.ts || 0),
      lean: p.lean,
      leanScore: p.leanScore,
      burst: p.burst,
      burstReasons: p.burstReasons,
      sizeMultIfUp: p.sizeMultUp,
      sizeMultIfDown: p.sizeMultDown,
      chain: p.chain,
      whale: p.whale,
      cex: p.cex ? {
        vpin: p.cex.vpin,
        buyPct: p.cex.buyPct,
        sellPct: p.cex.sellPct,
        whale50k: p.cex.whaleTrades50k,
        whale10k: p.cex.whaleTrades10k,
        volMult: p.cex.volMult,
        label: p.cex.label,
      } : null,
      stale: p.stale,
    };
  }

  function start() {
    if (_timer) return;
    refreshOnce();
    _timer = setInterval(refreshOnce, POLL_MS);
    console.log('[OnChainFlow] started — BTC/ETH/SOL side-scan every', POLL_MS / 1000, 's');
  }

  function stop() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
  }

  window.OnChainFlow = {
    COINS,
    POLL_MS,
    get,
    getAll,
    isBurst,
    lean,
    sizeMultiplier,
    packetForGrok,
    refresh: refreshOnce,
    start,
    stop,
  };

  // Alias used in playbooks / older names
  window.OnChainSideScan = window.OnChainFlow;

  console.log('[OnChainFlow] module loaded (BTC/ETH/SOL compressor — mechanical + Grok packet)');
})();
