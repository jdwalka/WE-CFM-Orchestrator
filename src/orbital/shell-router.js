// shell-router.js  v2.0
// ═══════════════════════════════════════════════════════════════════════════
// Quantum Shell Router  +  Veto Evaluator
//
// Models electron orbital energy propagation between crypto "element shells".
// Each shell is self-contained. The router is the ONLY channel between shells.
//
// SHELLS
//   s-orbital  (core)       BTC  ETH  XRP  BNB   innermost, most stable
//   p-orbital  (momentum)   SOL  HYPE             reactive, 1.65× amplitude
//   d-orbital  (highBeta)   DOGE                  complex, 2.80× amplitude
//   f-orbital  (sentiment)  BTC..DOGE             externality-driven, global risk pulse
//
// ENERGY ROUTING
//   Shell ionisation = velocity crosses ionizeThreshold.
//   A photon is emitted and queued for delivery to outer shells with:
//     s → p : delay 90 s   β 1.65×
//     s → d : delay 210 s  β 2.80×
//     p → d : delay 120 s  β 1.70×
//
// VETO EVALUATOR (VE)
//   Wall events are noisy. The VE never hard-blocks — instead:
//   1. HOLD  : photon arrives → coin enters 'evaluating' state, trade suspended
//   2. GRAB  : collect 3 snapshots over ~15s (shell vel, CFM momentum, alignment)
//   3. DECIDE: majority-vote (2-of-3 criteria) → 'confirmed' or 'released'
//      confirmed → fire 'shell:vetoConfirmed' event → earlyExit in orchestrator
//      released  → wall was absorbed, clear packet, resume prediction normally
//
// API
//   window.ShellRouter.getRoutedPacket(sym)  → risk packet for predictions.js
//   window.ShellRouter.getShellState(key)    → shell velocity/ionisation state
//   window.ShellRouter.getVetoState(sym)     → veto evaluator state per coin
//   window._shellRouter                      → full debug snapshot
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // ── Shell definitions ──────────────────────────────────────────────────────
  const ORBITAL_RINGS = {
    s: ['spot price', 'market cap', 'TVL', '1% order book depth'],
    p: ['15m VWAP', 'spot volume', 'on-chain transaction velocity'],
    d: ['open interest', 'funding rates', 'long/short ratios', 'liquidation clusters'],
    f: ['prediction market odds', 'social sentiment velocity', 'fear/greed'],
  };

  const ASSET_ORBITAL_BASE = {
    BTC:  { shell: 's', beta: 1.00, weight: 1.00, classification: 'Heavy Metal',       orbitalFocus: 'core',           marketCapUsd: 1.39e12, tvlUsd: 5.0e9 },
    ETH:  { shell: 's', beta: 1.15, weight: 0.90, classification: 'Heavy Metal',       orbitalFocus: 'defi-base',      marketCapUsd: 2.85e11, tvlUsd: 45.0e9 },
    SOL:  { shell: 'p', beta: 1.65, weight: 0.90, classification: 'Transition Metal',  orbitalFocus: 'momentum',       marketCapUsd: 6.50e10, tvlUsd: 8.0e9 },
    XRP:  { shell: 's', beta: 1.25, weight: 0.70, classification: 'Transition Metal',  orbitalFocus: 'isolated-flow',  marketCapUsd: 3.50e10, tvlUsd: 0 },
    BNB:  { shell: 's', beta: 1.10, weight: 0.40, classification: 'Transition Metal',  orbitalFocus: 'ecosystem',      marketCapUsd: null,      tvlUsd: 0 },
    HYPE: { shell: 'p', beta: 1.80, weight: 0.60, classification: 'Reactive Non-Metal', orbitalFocus: 'derivatives',    marketCapUsd: 1.20e10, tvlUsd: 4.5e9 },
    DOGE: { shell: 'd', beta: 2.80, weight: 0.50, classification: 'Noble Gas',         orbitalFocus: 'sentiment',      marketCapUsd: 1.50e10, tvlUsd: 0 },
  };

  const SHELLS = {
    s: { key: 's', label: 'core',       coins: ['BTC', 'ETH', 'XRP', 'BNB'], ionizeThreshold: -0.022 },
    p: { key: 'p', label: 'momentum',   coins: ['SOL', 'HYPE'],               ionizeThreshold: -0.028 },
    d: { key: 'd', label: 'highBeta',   coins: ['DOGE'],                      ionizeThreshold: -0.045 },
    f: { key: 'f', label: 'sentiment',  coins: Object.keys(ASSET_ORBITAL_BASE), ionizeThreshold: -0.035 },
  };

  // ── Inter-shell routing table ──────────────────────────────────────────────
  const ROUTES = [
    { from: 's', to: 'p', delay_ms:  90_000, beta: 1.65, label: 's→p' },
    { from: 's', to: 'd', delay_ms: 210_000, beta: 2.80, label: 's→d' },
    { from: 'p', to: 'd', delay_ms: 120_000, beta: 1.70, label: 'p→d' },
    { from: 'f', to: 's', delay_ms:  45_000, beta: 1.40, label: 'f→s' },
    { from: 'f', to: 'p', delay_ms:  60_000, beta: 1.55, label: 'f→p' },
    { from: 'f', to: 'd', delay_ms:  90_000, beta: 1.85, label: 'f→d' },
  ];

  // ── Per-coin beta coefficients ─────────────────────────────────────────────
  const COIN_META = {
    BTC:  { ...ASSET_ORBITAL_BASE.BTC },
    ETH:  { ...ASSET_ORBITAL_BASE.ETH },
    XRP:  { ...ASSET_ORBITAL_BASE.XRP },
    BNB:  { ...ASSET_ORBITAL_BASE.BNB },
    SOL:  { ...ASSET_ORBITAL_BASE.SOL },
    HYPE: { ...ASSET_ORBITAL_BASE.HYPE },
    DOGE: { ...ASSET_ORBITAL_BASE.DOGE },
  };

  function getLiveMarketCapUsd(sym) {
    const liveQuote = window._cmcProFeed?.getCachedQuote?.(sym);
    const base = ASSET_ORBITAL_BASE[sym];
    const liveCap = Number(liveQuote?.marketCap);
    if (Number.isFinite(liveCap) && liveCap > 0) return liveCap;
    return Number.isFinite(base?.marketCapUsd) ? base.marketCapUsd : null;
  }

  function getAtomicProfile(sym) {
    const base = COIN_META[sym];
    if (!base) return null;
    const marketCapUsd = getLiveMarketCapUsd(sym);
    const tvlUsd = Number.isFinite(base.tvlUsd) ? base.tvlUsd : 0;
    const atomicWeightUsd = Number.isFinite(marketCapUsd) ? marketCapUsd + tvlUsd : null;
    const rings = {
      s: ORBITAL_RINGS.s.slice(),
      p: ORBITAL_RINGS.p.slice(),
      d: ORBITAL_RINGS.d.slice(),
      f: ORBITAL_RINGS.f.slice(),
    };
    return {
      sym,
      ...base,
      marketCapUsd,
      tvlUsd,
      atomicWeightUsd,
      orbitalOrder: ['s', 'p', 'd', 'f'],
      rings,
    };
  }

  function sentimentVelocity() {
    const markets = window.PredictionMarkets?.getAll?.() || {};
    const fng = Number(window._cmcProFeed?.fearGreed?.()?.value ?? 50);
    const btcDom = Number(window._cmcProFeed?.globalMetrics?.()?.btcDominance ?? 50);
    let total = 0;
    let weight = 0;
    for (const [sym, meta] of Object.entries(COIN_META)) {
      const profile = getAtomicProfile(sym) || meta;
      const pm = markets[sym];
      const prob = Number(pm?.combinedProb);
      let signal = 0;
      if (Number.isFinite(prob)) signal += clamp((prob - 0.5) * 2, -1, 1) * 0.7;
      const vel = Number(window.PredictionMarkets?.getVelocity?.(sym)?.velCentsPerMin);
      if (Number.isFinite(vel)) signal += clamp(vel / 8, -1, 1) * 0.3;
      const seriesWeight = profile?.weight || meta.weight || 1;
      total += signal * seriesWeight;
      weight += seriesWeight;
    }
    const fngBias = Number.isFinite(fng) ? clamp((50 - fng) / 50, -1, 1) * 0.35 : 0;
    const domBias = Number.isFinite(btcDom) ? clamp((btcDom - 50) / 20, -1, 1) * -0.12 : 0;
    return (weight > 0 ? total / weight : 0) + fngBias + domBias;
  }

  // ── VE constants ───────────────────────────────────────────────────────────
  const VE_EVAL_TICKS   = 3;       // snapshots to collect before deciding (3 × 5s = 15s)
  const VE_HOLD_MS      = 180_000; // max hold period; auto-release if never confirmed
  const VE_RECOVERY_THR = 0.010;   // shell velocity above this = wall absorbed (release)
  const VE_PERSIST_THR  = -0.015;  // CFM momentum below this = sell is persisting

  // ── Volume anomaly constants ────────────────────────────────────────────────
  // Catches wall events by volume spike even when price drop is < ionizeThreshold.
  // Uses EMA of |cfmRate| per shell. If current rate exceeds baseline × VOL_SPIKE_MULT
  // and velocity is negative, a dampened photon is emitted (edge-triggered).
  const VOL_SPIKE_MULT  = 7;    // cfmRate must be 7× baseline to soft-ionize
  const VOL_ALPHA       = 0.08; // EMA alpha — slow decay keeps baseline stable
  const VOL_MIN_TICKS   = 12;   // warm-up ticks before vol-ionize can fire (~60s)

  // ── Core state ────────────────────────────────────────────────────────────
  const _shellState    = {};  // shellKey → { velocity, energy, ionized, volSpiked, direction, lastTs }
  const _photonQueue   = [];  // pending photons
  const _routedPackets = {};  // sym → current risk packet for predictions.js
  const _vetoState     = {};  // sym → VetoEvaluator state object
  const _volBaseline   = {};  // shellKey → EMA of |cfmRate|
  const _volTicks      = {};  // shellKey → tick count for warm-up guard
  const _quantumTracker = window.OrbitalQuantumState?.createQuantumStateTracker?.() || null;

  function shellElectronPayload(shellKey) {
    const payload = {};
    if (shellKey === 'f') {
      const markets = window.PredictionMarkets?.getAll?.() || {};
      for (const sym of SHELLS.f.coins) {
        const probability = Number(markets[sym]?.combinedProb);
        const velocity = Number(window.PredictionMarkets?.getVelocity?.(sym)?.velCentsPerMin);
        if (Number.isFinite(probability)) payload[sym + '_probability'] = probability;
        if (Number.isFinite(velocity)) payload[sym + '_velocity'] = velocity;
      }
      return payload;
    }

    const cfmAll = window._cfm || {};
    for (const sym of SHELLS[shellKey].coins) {
      const momentum = Number(cfmAll[sym]?.momentum);
      if (Number.isFinite(momentum)) payload[sym + '_momentum'] = momentum;
    }
    return payload;
  }

  // ── Shell velocity ─────────────────────────────────────────────────────────
  function shellVelocity(shellKey) {
    const shell  = SHELLS[shellKey];
    if (shellKey === 'f') return sentimentVelocity();
    const cfmAll = window._cfm || {};
    let vSum = 0, wSum = 0;
    for (const sym of shell.coins) {
      const cfm  = cfmAll[sym];
      if (!cfm?.cfmRate || (cfm.sourceCount ?? 0) < 1) continue;
      const meta = COIN_META[sym];
      const normMom = (cfm.momentum || 0) / meta.beta;
      vSum += normMom * meta.weight;
      wSum += meta.weight;
    }
    return wSum > 0 ? vSum / wSum : 0;
  }

  // ── Volume baseline (EMA of weighted |cfmRate| per shell) ──────────────────
  // Returns { curRate, baseline, spikeMult } for the shell.
  function updateVolumeBaseline(shellKey) {
    const shell  = SHELLS[shellKey];
    const cfmAll = window._cfm || {};
    let rateSum = 0, wSum = 0;
    for (const sym of shell.coins) {
      const cfm = cfmAll[sym];
      if (!cfm?.cfmRate || (cfm.sourceCount ?? 0) < 1) continue;
      const meta = COIN_META[sym];
      rateSum += Math.abs(cfm.cfmRate || 0) * meta.weight;
      wSum    += meta.weight;
    }
    const curRate = wSum > 0 ? rateSum / wSum : 0;
    if (_volBaseline[shellKey] == null) _volBaseline[shellKey] = curRate;
    _volBaseline[shellKey] = VOL_ALPHA * curRate + (1 - VOL_ALPHA) * _volBaseline[shellKey];
    _volTicks[shellKey]    = (_volTicks[shellKey] || 0) + 1;
    const baseline  = _volBaseline[shellKey];
    const spikeMult = baseline > 0 ? curRate / baseline : 0;
    return { curRate, baseline, spikeMult };
  }

  // ── Photon emission ────────────────────────────────────────────────────────
  function emitPhoton(fromKey, velocity) {
    const now       = Date.now();
    const direction = velocity < 0 ? -1 : 1;
    const outgoing  = ROUTES.filter(r => r.from === fromKey);
    for (const route of outgoing) {
      _photonQueue.push({
        from: fromKey, to: route.to,
        energy: Math.abs(velocity), direction,
        arrivedAt: now + route.delay_ms,
        beta: route.beta, label: route.label, emittedAt: now,
      });
    }
    console.log(
      `[ShellRouter] 📡 ${fromKey}-shell ionised → photon queued` +
      `  vel=${velocity.toFixed(4)}%  dir=${direction > 0 ? 'UP' : 'DOWN'}`
    );
  }

  // ── Veto Evaluator ─────────────────────────────────────────────────────────
  // When a photon arrives, the target-shell coins don't get a hard block.
  // They enter EVALUATING: trade is suspended while we collect fresh data.
  // After VE_EVAL_TICKS snapshots, a 2-of-3 majority vote decides.

  function veInitiate(sym, photon, amplifiedEnergy) {
    if (_vetoState[sym]?.phase === 'evaluating') return; // already running
    _vetoState[sym] = {
      phase:            'evaluating',
      initiatedAt:      Date.now(),
      expiresAt:        Date.now() + VE_HOLD_MS,
      photon,
      amplifiedEnergy,
      snapshots:        [],
      evalTick:         0,
    };

    // While evaluating: medium-strength risk packet — prevents trade, not a veto
    _routedPackets[sym] = _buildPacket(photon, amplifiedEnergy, 'evaluating');
    console.log(`[ShellRouter] ⏳ ${sym} veto evaluating  energy=${amplifiedEnergy.toFixed(4)}%`);
  }

  function veTick(sym) {
    const ve = _vetoState[sym];
    if (!ve || ve.phase !== 'evaluating') return;

    // Auto-expire if we've been holding too long
    if (Date.now() > ve.expiresAt) {
      veRelease(sym, 'expired');
      return;
    }

    const meta     = COIN_META[sym];
    const shellKey = meta?.shell ?? 's';
    const cfm      = window._cfm?.[sym] ?? {};
    const shellSt  = _shellState[shellKey] ?? {};

    ve.snapshots.push({
      ts:           Date.now(),
      shellVel:     shellSt.velocity   ?? 0,
      shellIonized: shellSt.ionized    ?? false,
      cfmMom:       cfm.momentum       ?? 0,
      cfmTrend:     cfm.trend          ?? 'neutral',
      sourceCount:  cfm.sourceCount    ?? 0,
    });
    ve.evalTick++;

    if (ve.evalTick >= VE_EVAL_TICKS) veDecide(sym);
  }

  function veDecide(sym) {
    const ve   = _vetoState[sym];
    const snaps = ve.snapshots;
    if (!snaps.length) { veRelease(sym, 'no-data'); return; }

    // ── Criterion 1: Shell still selling (velocity persisting low) ──────────
    const avgShellVel = snaps.reduce((s, x) => s + x.shellVel, 0) / snaps.length;
    const shellStillDown = avgShellVel < -VE_RECOVERY_THR;

    // ── Criterion 2: CFM momentum staying negative ──────────────────────────
    const negMomSnaps = snaps.filter(x => x.cfmMom < VE_PERSIST_THR).length;
    const cfmPersists = negMomSnaps >= Math.ceil(snaps.length * 0.6); // ≥60% negative

    // ── Criterion 3: No recovery signal (shell velocity NOT trending back up) ─
    const velFirst = snaps[0].shellVel;
    const velLast  = snaps[snaps.length - 1].shellVel;
    const noRecovery = velLast <= velFirst + VE_RECOVERY_THR; // hasn't bounced back

    const score = [shellStillDown, cfmPersists, noRecovery].filter(Boolean).length;
    const result = score >= 2 ? 'confirmed' : 'released';

    console.log(
      `[ShellRouter] 🔬 ${sym} veto decide → ${result}` +
      `  shellDown=${shellStillDown}  cfmPersists=${cfmPersists}  noRecovery=${noRecovery}` +
      `  score=${score}/3`
    );

    if (result === 'confirmed') {
      veConfirm(sym);
    } else {
      veRelease(sym, 'wall-absorbed');
    }
  }

  function veConfirm(sym) {
    const ve = _vetoState[sym];
    ve.phase = 'confirmed';
    ve.confirmedAt = Date.now();

    // Upgrade to high-strength packet — will push riskScore above tradeRisk
    _routedPackets[sym] = _buildPacket(ve.photon, ve.amplifiedEnergy, 'confirmed');

    console.log(`[ShellRouter] ✅ ${sym} wall CONFIRMED — veto active`);
    try {
      window.dispatchEvent(new CustomEvent('shell:vetoConfirmed', {
        detail: { sym, amplifiedEnergy: ve.amplifiedEnergy, snapshots: ve.snapshots },
      }));
    } catch (_) {}
  }

  function veRelease(sym, reason) {
    const ve = _vetoState[sym];
    if (ve) { ve.phase = 'released'; ve.releasedAt = Date.now(); ve.releaseReason = reason; }
    delete _routedPackets[sym]; // clear packet — wall absorbed, prediction resumes
    console.log(`[ShellRouter] 🔓 ${sym} veto released (${reason})`);
    try {
      window.dispatchEvent(new CustomEvent('shell:vetoReleased', { detail: { sym, reason } }));
    } catch (_) {}
  }

  // ── Packet builder ─────────────────────────────────────────────────────────
  // Two tiers:
  //   'evaluating' → medium strength — suspends trade without forcing exit
  //   'confirmed'  → high strength   — pushes riskScore above tradeRisk threshold
  function _buildPacket(photon, amplifiedEnergy, phase) {
    const confirmed  = phase === 'confirmed';
    const baseStr    = Math.min(amplifiedEnergy / 0.07, 1.0);
    return {
      family:    `shell-routed-${photon.from}${photon.to}`,
      category:  'timing',
      role:      'risk',
      label:     confirmed ? `⚡ Shell wall CONFIRMED ${photon.label}` : `⏳ Shell wall evaluating ${photon.label}`,
      detail:    `${photon.from}→${photon.to}  β=${photon.beta}×  phase=${phase}  energy=${amplifiedEnergy.toFixed(3)}%`,
      direction: photon.direction,
      // Amplify when confirmed: multiply by 1.45 → decisive strength
      // Hold low when evaluating: don't veto prematurely on noise
      strength:  confirmed ? Math.min(baseStr * 1.45, 0.97) : Math.min(baseStr * 0.55, 0.62),
      relevance: confirmed ? 0.95 : 0.78,
      trust:     confirmed ? 0.95 : 0.82,
      freshness: confirmed ? 0.92 : 0.88,
      _phase:    phase,
      _photon:   photon,
    };
  }

  // ── Photon delivery ────────────────────────────────────────────────────────
  function processPhotons() {
    const now = Date.now();
    for (let i = _photonQueue.length - 1; i >= 0; i--) {
      const p = _photonQueue[i];
      if (p.arrivedAt > now) continue;
      _photonQueue.splice(i, 1);

      const targetShell = SHELLS[p.to];
      if (!targetShell) continue;

      const amplifiedEnergy = p.energy * p.beta;
      console.log(`[ShellRouter] ⚡ ${p.label} arrived  energy=${amplifiedEnergy.toFixed(4)}%`);

      for (const sym of targetShell.coins) {
        veInitiate(sym, p, amplifiedEnergy);
      }
    }
  }

  // ── Per-shell tick ─────────────────────────────────────────────────────────
  function tickShell(shellKey) {
    const velocity = shellVelocity(shellKey);
    const ionized  = velocity < SHELLS[shellKey].ionizeThreshold;
    const prev     = _shellState[shellKey] || {};

    // Primary ionization: velocity crossed threshold (edge-triggered)
    if (ionized && !prev.ionized) emitPhoton(shellKey, velocity);

    // Secondary: volume-anomaly soft ionization
    // Fires a dampened photon when cfmRate spikes 7× its EMA baseline
    // even if price drop hasn't hit the hard threshold yet.
    const vol = updateVolumeBaseline(shellKey);
    const volSpiked = (_volTicks[shellKey] || 0) >= VOL_MIN_TICKS
                   && vol.spikeMult >= VOL_SPIKE_MULT
                   && velocity < 0;
    if (volSpiked && !prev.volSpiked && !ionized) {
      emitPhoton(shellKey, velocity * 0.6); // dampened 0.6× — vol-photon is softer
      console.log(
        `[ShellRouter] 📊 ${shellKey}-shell vol-ionised` +
        `  spike=${vol.spikeMult.toFixed(1)}×  vel=${velocity.toFixed(4)}  rate=${vol.curRate.toFixed(4)}`
      );
    }

    const quantumState = _quantumTracker
      ? _quantumTracker.enrich(shellKey, 'SHELL_' + shellKey, shellElectronPayload(shellKey), Date.now()).quantum_state
      : {
          shell: shellKey,
          ion_charge: velocity > 0 ? '+' : velocity < 0 ? '-' : '0',
          net_charge: clamp(velocity, -1, 1),
          coherence: Math.abs(velocity) > 0 ? 1 : 0,
          electron_count: 0,
          subatomic_orbital_count: 0,
          subshells: [],
          ts: Date.now(),
        };

    _shellState[shellKey] = {
      velocity, energy: Math.abs(velocity), ionized, volSpiked,
      volSpikeMult: vol.spikeMult, volRate: vol.curRate,
      direction: velocity < 0 ? -1 : 1, lastTs: Date.now(),
      quantum_state: quantumState,
    };
  }

  // ── Main tick ──────────────────────────────────────────────────────────────
  function tick() {
    tickShell('s');
    tickShell('p');
    tickShell('d');
    tickShell('f');
    processPhotons();

    // Advance all active VE cycles
    for (const sym of Object.keys(_vetoState)) {
      if (_vetoState[sym].phase === 'evaluating') veTick(sym);
    }

    window._shellRouter = {
      shells:         _shellState,
      pendingPhotons: _photonQueue.length,
      vetoStates:     Object.fromEntries(
        Object.entries(_vetoState).map(([k, v]) => [k, { phase: v.phase, tick: v.evalTick, snaps: v.snapshots?.length }])
      ),
      routedPackets:  Object.fromEntries(
        Object.entries(_routedPackets).map(([k, v]) => [k, { phase: v._phase, strength: v.strength, dir: v.direction }])
      ),
      volBaselines:   Object.fromEntries(
        Object.entries(_volBaseline).map(([k, v]) => [k, { baseline: +v.toFixed(5), ticks: _volTicks[k] ?? 0 }])
      ),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.ShellRouter = {
    tick,
    getRoutedPacket:  sym      => _routedPackets[sym] ?? null,
    getShellState:    shellKey => _shellState[shellKey] ?? null,
    getVetoState:     sym      => _vetoState[sym] ?? null,
    getShellVelocity: shellVelocity,
    getCoinMeta:      sym      => COIN_META[sym] ?? null,
    getAtomicProfile: sym      => getAtomicProfile(sym),
    getOrbitalRings:  sym      => getAtomicProfile(sym)?.rings ?? null,
    clearVeto:        sym      => { veRelease(sym, 'manual-clear'); },
    SHELLS, COIN_META, ROUTES,
  };

  let _handle = null;
  function start() {
    if (_handle) return;
    _handle = setInterval(tick, 5000);
    console.log('[ShellRouter] v2.0 — hold/evaluate veto engine active  poll=5s');
  }

  setTimeout(start, 3000);
})();
