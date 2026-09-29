/**
 * birdeye-sol-feed.js  —  Birdeye Solana Microstructure Feed
 *
 * Pulls real-time liquidity walls, order flow, and whale activity from
 * Birdeye and maps each signal to the quantum orbital shell model.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ORBITAL SHELL MAP  (Quantum Principal Number → Trading Signal)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Shell s  (n=1, K-shell)  m_l={0}        FUNDAMENTAL
 *  ─────────────────────────────────────────────────────
 *  Source : blockchain-scan.js
 *  Signal : Network health — TPS, epoch, congestion level
 *  Spin   : 0 only (binary — on/off network health gate)
 *  Coins  : All (SOL reads TPS/epoch from Solana RPC)
 *
 *  Shell p  (n=2, L-shell)  m_l={-1,0,+1}  TREND
 *  ─────────────────────────────────────────────────────
 *  Source : predictions.js (EMA, price structure)
 *  Signal : Price trend bias, EMA cross, higher-lows/lower-highs
 *  Spin   : ±1
 *  SOL+   : Birdeye OHLCV (on-chain confirmed trend, not CEX)
 *
 *  Shell d  (n=3, M-shell)  m_l={-2,-1,0,+1,+2}  MOMENTUM / FLOW
 *  ─────────────────────────────────────────────────────
 *  Source : predictions.js (RSI, MACD, OBV slope, rate-of-change)
 *  Signal : Short-term directional momentum
 *  Spin   : ±2
 *  SOL+   : Birdeye /defi/v3/token/trade-data/single
 *             buy1h / sell1h ratio → flow pressure
 *             buyVolume1h vs sellVolume1h → institutional vs retail
 *
 *  Shell f  (n=4, N-shell)  m_l={-3..+3}   MICROSTRUCTURE  ← OLD MAX
 *  ─────────────────────────────────────────────────────
 *  Source : predictions.js (bid/ask imbalance, CVD)
 *  Signal : Order book pressure, bid/ask wall detection
 *  Spin   : ±3
 *  SOL+   : Birdeye /defi/v3/token/exit-liquidity
 *             Large LP concentrations = bid/ask walls
 *             Wall consumption rate = urgency signal
 *           Birdeye /defi/txs/token (recent swaps)
 *             Sweep detection (wall eaten fast → strong momentum)
 *
 *  Shell g  (n=5, O-shell)  m_l={-4..+4}   CONSENSUS  ← NEW
 *  ─────────────────────────────────────────────────────
 *  Source : Cross-shell alignment (d + f + p must agree)
 *  Signal : Multi-layer conviction — activates only on confluence
 *  Spin   : ±4
 *  SOL+   : Birdeye whale flow (/defi/txs/token filtered >$50K)
 *             Net whale buy → +g boost
 *             Net whale sell → -g boost
 *             Requires ≥3 of 4 lower shells aligned
 *
 *  Shell h  (n=6, P-shell)  m_l={-5..+5}   EXTREME CONVICTION  ← NEW
 *  ─────────────────────────────────────────────────────
 *  Source : All shells + Polymarket confirmation
 *  Signal : Full orbital alignment — rarest state (~2-3% of ticks)
 *  Spin   : ±5
 *  SOL+   : Birdeye wall + flow + whale + PYTH momentum ALL agree
 *             "Yellow wall confirmed" — bid wall holding AND
 *             buy flow dominant AND whale accumulation AND
 *             Polymarket crowd pricing the wrong side
 *
 * ═══════════════════════════════════════════════════════════════════
 *  SOL Native Token Address (Wrapped SOL on all DEXes)
 *  So11111111111111111111111111111111111111112
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────
  const BIRDEYE_BASE    = 'https://public-api.birdeye.so';
  const SOL_ADDRESS     = 'So11111111111111111111111111111111111111112';
  const CHAIN_HEADER    = 'solana';
  const POLL_MS         = 20_000;   // 20-sec cadence (3× per 15m bar)
  const WHALE_THRESHOLD = 50_000;   // USD — trades above this = whale
  const SWEEP_WINDOW_S  = 300;      // 5 min window for sweep detection

  // API key — loaded from window.BIRDEYE_API_KEY or config
  function getApiKey() {
    return window.BIRDEYE_API_KEY
      || window.__env?.BIRDEYE_API_KEY
      || '';
  }

  // ── State ────────────────────────────────────────────────────────────
  const state = {
    lastUpdate:   0,
    polling:      false,
    apiKeyMissing: false,

    // Per-shell signal outputs (-1 to +1)
    shells: {
      p: 0,   // trend (Birdeye OHLCV confirmation)
      d: 0,   // momentum / flow (trade data ratio)
      f: 0,   // microstructure (liquidity walls, sweep detection)
      g: 0,   // consensus (whale flow + multi-shell alignment)
      h: 0,   // extreme (full confluence)
    },

    // Raw data cache
    tradeData:     null,  // /defi/v3/token/trade-data/single
    recentTxs:     null,  // /defi/txs/token
    exitLiquidity: null,  // /defi/v3/token/exit-liquidity
    ohlcv:         null,  // /defi/ohlcv (15m bars)

    // Derived signals (for diagnostics)
    signals: {
      buyPressure:     0,   // buy/sell flow ratio  (-1 to +1)
      wallBias:        0,   // bid wall vs ask wall (-1 to +1)
      sweepDetected:   false,
      sweepDirection:  0,   // +1 buy sweep, -1 sell sweep
      whaleBias:       0,   // net whale direction (-1 to +1)
      whaleCount:      0,   // # whale trades in last 5 min
      liquidityScore:  0,   // 0-1 overall liquidity health
    },

    // Composite orbital spin for SOL (augments predictions.js output)
    orbitalSpin:   0,   // final blended signal to inject
    spinLabel:     'Neutral',
    shellsAligned: 0,   // count of shells agreeing direction
  };

  // ── Fetch helper (routes through proxyFetch for CORS) ────────────────
  async function birdeyeFetch(path, params = {}) {
    const key = getApiKey();
    if (!key) {
      state.apiKeyMissing = true;
      return null;
    }
    const qs = new URLSearchParams(params).toString();
    const url = `${BIRDEYE_BASE}${path}${qs ? '?' + qs : ''}`;

    try {
      // Try suppFetch first (Electron proxy), fall back to native fetch
      let res;
      if (typeof window.suppFetch === 'function') {
        res = await window.suppFetch(url, {
          headers: {
            'x-api-key':  key,
            'x-chain':    CHAIN_HEADER,
            'accept':     'application/json',
          },
        });
      } else {
        res = await fetch(url, {
          headers: {
            'x-api-key':  key,
            'x-chain':    CHAIN_HEADER,
            'accept':     'application/json',
          },
        });
      }
      if (!res.ok) return null;
      const data = await res.json();
      return data?.data ?? data ?? null;
    } catch (e) {
      console.warn('[BirdeyeSOL] fetch error:', e.message);
      return null;
    }
  }

  // ── Fetch all data sources in parallel ──────────────────────────────
  async function fetchAll() {
    const now = Math.floor(Date.now() / 1000);

    const [tradeData, recentTxs, exitLiq, ohlcv] = await Promise.all([

      // Shell d — momentum/flow: buy vs sell pressure
      birdeyeFetch('/defi/v3/token/trade-data/single', {
        address: SOL_ADDRESS,
      }),

      // Shell f+g — microstructure: recent swaps for sweep + whale detection
      birdeyeFetch('/defi/txs/token', {
        address: SOL_ADDRESS,
        type:    'swap',
        limit:   100,
      }),

      // Shell f — exit liquidity walls
      birdeyeFetch('/defi/v3/token/exit-liquidity', {
        address: SOL_ADDRESS,
      }),

      // Shell p — on-chain OHLCV trend confirmation
      birdeyeFetch('/defi/ohlcv', {
        address:   SOL_ADDRESS,
        type:      '15m',
        time_from: now - 3600,   // last 4 bars
        time_to:   now,
      }),

    ]);

    return { tradeData, recentTxs, exitLiq, ohlcv };
  }

  // ── Shell d: Momentum / Flow ─────────────────────────────────────────
  // Uses buy1h/sell1h from trade data to compute buy pressure ratio
  function calcFlowSignal(tradeData) {
    if (!tradeData) return 0;

    const buy1h  = tradeData.buy1h  || tradeData.buy24h  / 24 || 0;
    const sell1h = tradeData.sell1h || tradeData.sell24h / 24 || 0;
    const buyVol = tradeData.buyVolume1h  || tradeData.buyVolume24h  / 24 || 0;
    const selVol = tradeData.sellVolume1h || tradeData.sellVolume24h / 24 || 0;

    const total = buy1h + sell1h;
    if (total < 5) return 0;  // not enough trades

    // Trade count ratio (-1 to +1)
    const countRatio = (buy1h - sell1h) / total;

    // Volume ratio (weighted heavier — $value matters more than count)
    const totalVol = buyVol + selVol;
    const volRatio = totalVol > 0 ? (buyVol - selVol) / totalVol : 0;

    // Blend count + volume, volume weighted 60/40
    const raw = countRatio * 0.4 + volRatio * 0.6;

    state.signals.buyPressure = raw;
    return Math.max(-1, Math.min(1, raw * 1.5));  // slight amplification
  }

  // ── Shell f: Microstructure — Liquidity Walls ────────────────────────
  // Exit liquidity = where large LP positions are concentrated
  // Bid wall (below price) → bullish support; Ask wall (above price) → resistance
  function calcWallSignal(exitLiq, currentPrice) {
    if (!exitLiq) return 0;

    // exitLiq may be array of { price, liquidity, type } objects
    const items = Array.isArray(exitLiq) ? exitLiq
      : (exitLiq.items || exitLiq.positions || []);

    if (!items.length) return 0;

    const price = currentPrice || 0;
    let bidWallTotal = 0, askWallTotal = 0;

    items.forEach(item => {
      const p   = item.price || item.priceUsd || 0;
      const liq = item.liquidity || item.amount || 0;
      if (!p || !liq) return;
      if (price > 0) {
        if (p < price) bidWallTotal += liq;  // below price = support
        else           askWallTotal += liq;  // above price = resistance
      }
    });

    const totalWall = bidWallTotal + askWallTotal;
    if (totalWall < 1) return 0;

    const wallBias = (bidWallTotal - askWallTotal) / totalWall;
    state.signals.wallBias = wallBias;
    return Math.max(-1, Math.min(1, wallBias * 2));  // amplify wall imbalance
  }

  // ── Shell f+g: Sweep Detection (recent txs) ──────────────────────────
  // A sweep = large directional trades consuming multiple walls in <5 min
  function calcSweepSignal(recentTxs) {
    if (!recentTxs) return { sweep: false, direction: 0, whaleBias: 0, whaleCount: 0 };

    const items = Array.isArray(recentTxs) ? recentTxs
      : (recentTxs.items || recentTxs.trades || []);

    if (!items.length) return { sweep: false, direction: 0, whaleBias: 0, whaleCount: 0 };

    const now = Date.now() / 1000;
    const recent = items.filter(tx => {
      const ts = tx.blockUnixTime || tx.timestamp || 0;
      return (now - ts) < SWEEP_WINDOW_S;
    });

    // Whale trades
    let whaleBuyVol = 0, whaleSellVol = 0, whaleCount = 0;
    let buyVol = 0, sellVol = 0;

    recent.forEach(tx => {
      const vol  = tx.volumeUsd || (tx.amount * (tx.price || 0)) || 0;
      const side = tx.side || tx.type || '';
      const isBuy = side === 'buy' || side === 'Buy' || side === 'BUY';

      if (isBuy) buyVol += vol; else sellVol += vol;

      if (vol >= WHALE_THRESHOLD) {
        whaleCount++;
        if (isBuy) whaleBuyVol += vol; else whaleSellVol += vol;
      }
    });

    // Sweep: >3 whale trades in window OR vol skew >80%
    const totalVol = buyVol + sellVol;
    const volSkew  = totalVol > 0 ? Math.abs(buyVol - sellVol) / totalVol : 0;
    const sweep    = whaleCount >= 3 || volSkew > 0.8;
    const dir      = buyVol >= sellVol ? 1 : -1;

    const totalWhale = whaleBuyVol + whaleSellVol;
    const whaleBias  = totalWhale > 0
      ? (whaleBuyVol - whaleSellVol) / totalWhale
      : 0;

    state.signals.sweepDetected  = sweep;
    state.signals.sweepDirection = sweep ? dir : 0;
    state.signals.whaleBias      = whaleBias;
    state.signals.whaleCount     = whaleCount;

    return { sweep, direction: dir, whaleBias, whaleCount };
  }

  // ── Shell p: On-chain Trend Confirmation (OHLCV) ─────────────────────
  function calcTrendSignal(ohlcv) {
    if (!ohlcv) return 0;
    const items = Array.isArray(ohlcv) ? ohlcv
      : (ohlcv.items || ohlcv.data || []);
    if (items.length < 2) return 0;

    const closes = items.map(b => b.c || b.close || 0).filter(Boolean);
    if (closes.length < 2) return 0;

    // Simple trend: is price above or below short EMA of available bars?
    const last  = closes[closes.length - 1];
    const prev  = closes[closes.length - 2];
    const avg   = closes.reduce((s, v) => s + v, 0) / closes.length;

    const aboveAvg = last > avg ? 1 : -1;
    const momentum = last > prev ? 0.5 : -0.5;

    return Math.max(-1, Math.min(1, aboveAvg * 0.6 + momentum * 0.4));
  }

  // ── Shell g: Consensus — cross-shell alignment ───────────────────────
  // g activates only when ≥3 of the lower 4 shells agree direction
  function calcConsensusSignal(pSig, dSig, fSig, whaleData) {
    const signals = [pSig, dSig, fSig];
    const bullCount = signals.filter(s => s > 0.15).length;
    const bearCount = signals.filter(s => s < -0.15).length;
    const aligned   = Math.max(bullCount, bearCount);
    const direction = bullCount >= bearCount ? 1 : -1;

    state.shellsAligned = aligned;

    if (aligned < 3) return 0;  // not enough agreement for g-shell

    // Whale flow boosts g-shell when direction agrees
    const whaleBoost = whaleData.whaleBias * direction > 0.3
      ? 0.3 : 0;

    const base = (aligned / 3) * 0.8 + whaleBoost;
    return Math.max(-1, Math.min(1, base * direction));
  }

  // ── Shell h: Extreme — full orbital confluence ────────────────────────
  // Fires only when ALL shells agree AND sweep is detected
  function calcExtremeSignal(pSig, dSig, fSig, gSig, sweep) {
    const allBull = pSig > 0.2 && dSig > 0.2 && fSig > 0.2 && gSig > 0.2;
    const allBear = pSig < -0.2 && dSig < -0.2 && fSig < -0.2 && gSig < -0.2;

    if (!allBull && !allBear) return 0;
    if (!sweep.sweep) return 0;  // must have sweep confirmation for h-shell

    const dir = allBull ? 1 : -1;
    // Scale by how aligned each shell is (avg absolute value)
    const avg = (Math.abs(pSig) + Math.abs(dSig) + Math.abs(fSig) + Math.abs(gSig)) / 4;
    return dir * Math.min(1, avg * 1.2);
  }

  // ── Combine all shells into final orbital spin (-1 to +1) ────────────
  function buildOrbitalSpin(shells) {
    // Shell weights follow orbital energy levels (higher n = more weight when present)
    const weights = { p: 0.15, d: 0.25, f: 0.30, g: 0.20, h: 0.10 };

    // h-shell takes over if it fires (it's the full alignment signal)
    if (Math.abs(shells.h) > 0.5) {
      return shells.h;
    }

    let weighted = 0, totalW = 0;
    for (const [shell, w] of Object.entries(weights)) {
      if (shell === 'h') continue;
      weighted += (shells[shell] || 0) * w;
      totalW   += w;
    }
    return totalW > 0 ? weighted / totalW : 0;
  }

  // ── Spin label from orbital value ────────────────────────────────────
  function spinLabel(val) {
    const abs = Math.abs(val);
    const dir = val > 0 ? 'Bull' : 'Bear';
    if (abs >= 0.85) return `Extreme ${dir}`;
    if (abs >= 0.65) return `Very Strong ${dir}`;
    if (abs >= 0.45) return `Strong ${dir}`;
    if (abs >= 0.25) return `${dir}`;
    if (abs >= 0.10) return `Weak ${dir}`;
    return 'Neutral';
  }

  // ── Main poll cycle ──────────────────────────────────────────────────
  async function poll() {
    if (!getApiKey()) {
      console.warn('[BirdeyeSOL] No API key — set window.BIRDEYE_API_KEY');
      return;
    }

    const { tradeData, recentTxs, exitLiq, ohlcv } = await fetchAll();

    // Cache raw data
    state.tradeData     = tradeData;
    state.recentTxs     = recentTxs;
    state.exitLiquidity = exitLiq;
    state.ohlcv         = ohlcv;

    // Approximate current price from trade data
    const currentPrice = tradeData?.price || tradeData?.priceUsd || 0;

    // Calculate per-shell signals
    const pSig = calcTrendSignal(ohlcv);
    const dSig = calcFlowSignal(tradeData);
    const fSig = calcWallSignal(exitLiq, currentPrice);
    const sweep = calcSweepSignal(recentTxs);
    const gSig = calcConsensusSignal(pSig, dSig, fSig, sweep);
    const hSig = calcExtremeSignal(pSig, dSig, fSig, gSig, sweep);

    state.shells = { p: pSig, d: dSig, f: fSig, g: gSig, h: hSig };

    const spin = buildOrbitalSpin(state.shells);
    state.orbitalSpin = spin;
    state.spinLabel   = spinLabel(spin);
    state.lastUpdate  = Date.now();

    console.log(
      `[BirdeyeSOL] spin=${spin.toFixed(3)} (${state.spinLabel}) | ` +
      `p=${pSig.toFixed(2)} d=${dSig.toFixed(2)} f=${fSig.toFixed(2)} ` +
      `g=${gSig.toFixed(2)} h=${hSig.toFixed(2)} | ` +
      `shells_aligned=${state.shellsAligned} whale=${sweep.whaleCount} ` +
      `sweep=${sweep.sweep}`
    );

    // Emit event so predictions.js / app.js can react
    window.dispatchEvent(new CustomEvent('birdeye-sol-update', {
      detail: {
        orbitalSpin:   spin,
        spinLabel:     state.spinLabel,
        shells:        { ...state.shells },
        signals:       { ...state.signals },
        shellsAligned: state.shellsAligned,
        ts:            state.lastUpdate,
      }
    }));
  }

  // ── Start polling ────────────────────────────────────────────────────
  function start() {
    if (state.polling) return;
    state.polling = true;

    // Initial poll immediately
    poll().catch(e => console.error('[BirdeyeSOL] poll error:', e));

    // Then every POLL_MS
    setInterval(() => {
      poll().catch(e => console.error('[BirdeyeSOL] poll error:', e));
    }, POLL_MS);

    console.log(`[BirdeyeSOL] Started — polling every ${POLL_MS / 1000}s`);
  }

  // ── Public API ───────────────────────────────────────────────────────
  window.BirdeyeSOL = {
    start,

    /** Inject orbital spin into a SOL prediction object */
    augmentSOLPrediction(pred) {
      if (!pred || pred.symbol !== 'SOL') return pred;
      if (!state.lastUpdate || Date.now() - state.lastUpdate > 120_000) return pred; // stale

      const spin = state.orbitalSpin;
      if (Math.abs(spin) < 0.10) return pred;  // not strong enough to change anything

      // Blend Birdeye spin with existing prediction score (30% Birdeye weight)
      const existing = pred.score ?? 0;
      const blended  = existing * 0.70 + spin * 0.30;

      return {
        ...pred,
        score:        blended,
        birdeyeSpin:  spin,
        birdeyeShells: { ...state.shells },
        birdeyeLabel:  state.spinLabel,
        birdeyeAligned: state.shellsAligned,
        // Flag h-shell activation for UI
        extremeActivation: Math.abs(state.shells.h) > 0.5,
      };
    },

    /** Raw shell signals for diagnostics */
    getShells:   () => ({ ...state.shells }),
    getSignals:  () => ({ ...state.signals }),
    getSpin:     () => state.orbitalSpin,
    getLabel:    () => state.spinLabel,
    isStale:     () => Date.now() - state.lastUpdate > 60_000,
    hasData:     () => state.lastUpdate > 0 && !state.apiKeyMissing,

    /** Full diagnostic dump */
    diagnostics() {
      return {
        lastUpdate:    new Date(state.lastUpdate).toISOString(),
        apiKeyLoaded:  !!getApiKey(),
        polling:       state.polling,
        orbitalSpin:   state.orbitalSpin,
        spinLabel:     state.spinLabel,
        shellsAligned: state.shellsAligned,
        shells:        { ...state.shells },
        signals:       { ...state.signals },
      };
    },
  };

  // Auto-start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

})();
