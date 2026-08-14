// floating-orchestrator.js v2.0 — EV Engine
// Model-primary. Kalshi = house odds. Edge = modelProbUp vs kalshiYesPrice.
// Divergence = OPPORTUNITY. Entry price = context + risk flags, never a gate.
// Near-close trades: minimum gate is 5 seconds.
//
// Active orchestrator symbols are resolved from window.PREDICTION_COINS at runtime.
// Any extra weights below remain dormant unless a symbol is part of the live prediction set.



(function () {
  'use strict';

  // --- Alert Audio System ---
  var _audioCtx = null;
  var _lastAlertTime = 0;
  function playAlert(type) {
    if (typeof window === 'undefined' || (!window.AudioContext && !window.webkitAudioContext)) return;
    var now = Date.now();
    if (now - _lastAlertTime < 20000) return; // Throttle 8s
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      var osc = _audioCtx.createOscillator();
      var gainNode = _audioCtx.createGain();
      osc.connect(gainNode);
      gainNode.connect(_audioCtx.destination);
      if (type === 'DIVERGENT') {
        // High pitched urgent beep (Crowd is wrong)
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, _audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1760, _audioCtx.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0.05, _audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.2);
        osc.start(_audioCtx.currentTime);
        osc.stop(_audioCtx.currentTime + 0.2);
      } else if (type === 'PRIME_OPPORTUNITY') {
        // Chime for good payout / likely to win
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, _audioCtx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, _audioCtx.currentTime + 0.1); // E5
        gainNode.gain.setValueAtTime(0.1, _audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.5);
        osc.start(_audioCtx.currentTime);
        osc.stop(_audioCtx.currentTime + 0.5);
      }
      _lastAlertTime = now;
    } catch (e) {
      console.warn("Audio alert failed", e);
    }
  }

  // Allocation weights (normalized; divide by sum for probability)
  // Physics-aligned to shell activation rates from ionization model
  const COIN_WEIGHTS = {
    BTC: 0.65,   // 55% → 35%  (reduce: 16% shell3 activation)
    ETH: 1.05,   // 27% → 30%  (steady: 45% shell3 activation)
    SOL: 0.45,   // 13% → 8%   (reduce: 0% shell3 activation)
    XRP: 0.70,   // 3% → 2%    (maintain: 0% shell3 activation)
    HYPE: 7.50,   // 1% → 8%    (increase: 41% shell3 activation)
    DOGE: 12.0,   // 1% → 10%   (increase: 52% shell3 activation)
    BNB: 9.99    // 0% → 10%   (new: 18% shell3 activation)
  };

  // Compute normalized weights for probability allocation
  const _weightSum = Object.values(COIN_WEIGHTS).reduce((a, b) => a + b, 0);
  const COIN_ALLOCATION = {};
  for (const [coin, weight] of Object.entries(COIN_WEIGHTS)) {
    COIN_ALLOCATION[coin] = weight / _weightSum;
  }

  const MODEL_THRESHOLD = 0.02; // ALWAYS_TRADE: fire on tiny score lean
  const BINARY_CDF_YES_THRESHOLD = 0.62;
  const BINARY_CDF_NO_THRESHOLD = 0.38;
  const FINAL_MODEL_CONF_MIN_TRADE = 58;
  const FINAL_MODEL_CONF_MIN_NONALIGNED_TRADE = 68;
  const MIN_SECONDS_LEFT = 12;           // was 35 — allow late fills
  const OPEN_WINDOW_GUARD_SECS = 0;      // was 15 — take trades from open
  const PREDICTION_STALE_WARN_MS = 45000;
  const MARKET_STALE_WARN_MS = 15000;
  const MAX_SECONDS_LEFT = 15 * 60 + 30;
  const EDGE_MIN_CENTS = 2;              // was 10 — always-trade coverage
  const PRIME_PAYOUT_MAX_ENTRY_PRICE = 0.92; // was 0.62 — allow expensive yes/no
  const PRIME_PAYOUT_MIN_MISPRICING = 0.02;  // was 0.12
  const EXCEPTIONAL_RECOVERY_TIMING_SCORE = 68;
  const EXCEPTIONAL_RECOVERY_EDGE_CENTS = 12;
  const EXCEPTIONAL_RECOVERY_MISPRICING = 0.10;
  const INVERSION_THRESH = 30;
  const THIN_BOOK_THRESH = 0.05;
  const TAIL_RISK_THRESH = 0.80;
  const LAST_CALL_MS = 60000;
  const MAX_KELLY = 0.25;
  const ENABLE_CROWD_FADE_OVERRIDE = true;
  const LOG_TUNED_HIGH_EDGE_RISK_CENTS = 20;
  const LOG_TUNED_DIVERGENT_YES_RISK_MIN = 0.55;
  const LOG_TUNED_DIVERGENT_YES_RISK_MAX = 0.70;
  function readRuntimeKnob(key, fallback) {
    var val = null;
    try {
      if (typeof window !== 'undefined' && window.__WECRYP_ORCH_CONFIG && window.__WECRYP_ORCH_CONFIG[key] != null) {
        val = window.__WECRYP_ORCH_CONFIG[key];
      }
    } catch (_) {}
    try {
      if (val == null && typeof process !== 'undefined' && process.env && process.env[key] != null) {
        val = process.env[key];
      }
    } catch (_) {}
    return val == null ? fallback : val;
  }
  function readNumberKnob(key, fallback, min, max) {
    var raw = readRuntimeKnob(key, fallback);
    var num = Number(raw);
    if (!Number.isFinite(num)) num = Number(fallback);
    if (Number.isFinite(min)) num = Math.max(min, num);
    if (Number.isFinite(max)) num = Math.min(max, num);
    return num;
  }
  function readBoolKnob(key, fallback) {
    var raw = readRuntimeKnob(key, fallback);
    if (typeof raw === 'boolean') return raw;
    var txt = String(raw).trim().toLowerCase();
    if (txt === '1' || txt === 'true' || txt === 'yes' || txt === 'on') return true;
    if (txt === '0' || txt === 'false' || txt === 'no' || txt === 'off') return false;
    return !!fallback;
  }
  const WAIT_GUARD_TIMING_SCORE_BASE = readNumberKnob('WECRYP_WAIT_GUARD_TIMING_SCORE_BASE', 40, 20, 95);
  const WAIT_GUARD_BTC_ETH_RELAX = readNumberKnob('WECRYP_WAIT_GUARD_BTC_ETH_RELAX', 8, 0, 12);
  const WAIT_GUARD_REGIME_TREND_RELAX = readNumberKnob('WECRYP_WAIT_GUARD_REGIME_TREND_RELAX', 6, 0, 10);
  const WAIT_GUARD_REGIME_VOLATILE_PENALTY = readNumberKnob('WECRYP_WAIT_GUARD_REGIME_VOLATILE_PENALTY', 0, 0, 12);
  const WAIT_GUARD_MCTS_RELAX_MAX = readNumberKnob('WECRYP_WAIT_GUARD_MCTS_RELAX_MAX', 8, 0, 12);
  const WAIT_GUARD_OPEN_BYPASS_ENABLED = readBoolKnob('WECRYP_WAIT_GUARD_OPEN_BYPASS_ENABLED', true);
  const WAIT_GUARD_OPEN_BYPASS_MIN_CONF = readNumberKnob('WECRYP_WAIT_GUARD_OPEN_BYPASS_MIN_CONF', 5, 0, 99);
  const WAIT_GUARD_OPEN_BYPASS_MIN_EDGE = readNumberKnob('WECRYP_WAIT_GUARD_OPEN_BYPASS_MIN_EDGE', 2, 0, 50);
  const WAIT_GUARD_OPEN_BYPASS_MIN_MISPRICING = readNumberKnob('WECRYP_WAIT_GUARD_OPEN_BYPASS_MIN_MISPRICING', 0.02, 0.0, 0.5);
  const MCTS_ENABLED = readBoolKnob('WECRYP_MCTS_ENABLED', true);
  const MCTS_SIMULATIONS = Math.round(readNumberKnob('WECRYP_MCTS_SIMULATIONS', 96, 16, 400));
  const MCTS_DEPTH = Math.round(readNumberKnob('WECRYP_MCTS_DEPTH', 6, 2, 16));
  const MCTS_EXPLORATION = readNumberKnob('WECRYP_MCTS_EXPLORATION', 1.15, 0.1, 4.0);
  const MCTS_CONFIDENCE_MOD_MAX = readNumberKnob('WECRYP_MCTS_CONFIDENCE_MOD_MAX', 10, 0, 20);
  const MCTS_DIRECTION_OVERRIDE_MIN_GAP = readNumberKnob('WECRYP_MCTS_DIRECTION_OVERRIDE_MIN_GAP', 0.14, 0.01, 0.5);
  const LIVE_CALIBRATION_EVENT_WINDOW = Math.round(readNumberKnob('WECRYP_LIVE_CALIBRATION_EVENT_WINDOW', 120, 20, 500));

  // Signal stability — prevents flipping in final minutes
  // Reduce lock hold time to avoid entering on stale signals; locks will also
  // be invalidated when a fresher model prediction appears for the same sym.
  const LOCK_MS = 20000;   // hold a trade signal for 20s on same contract
  const CROWD_FADE_NEUTRAL_BAND = 0.03; // treat 47/53 as neutral to avoid noisy fades
  const CROWD_FADE_BASE_MIN_SECS = 180;  // base sweet spot, then adapt live
  const CROWD_FADE_BASE_MAX_SECS = 420;
  const CROWD_FADE_HARD_MIN_SECS = 75;   // allow fast-track fades late only when tape is clean
  const CROWD_FADE_HARD_MAX_SECS = 540;  // allow early fades when edge is unusually strong
  const CROWD_FADE_CONFIRM_MIN_MS = 7000;
  const CROWD_FADE_CONFIRM_MAX_MS = 45000;
  const CROWD_FADE_MIN_EDGE_CENTS = 14; // stronger edge required than normal trade
  const CROWD_FADE_MIN_MISPRICE = 0.16; // dynamic floor starts at 16pp
  const CROWD_FADE_MAX_MISPRICE = 0.22; // and rises to 22pp when earlier
  const CROWD_FADE_MIN_MODEL_CONF = 0.12; // require model to be at least 62/38
  const CROWD_FADE_MIN_LIQUIDITY = 1500; // gate out very thin markets
  const STATE_PRUNE_MS = 120000;

  // Sweet spot entry window — best payout + not too close to close
  const SWEET_MIN_SECS = 180;     // 3 min left
  const SWEET_MAX_SECS = 360;     // 6 min left
  const SWEET_PAYOUT_MIN = 1.65;    // payout >= 1.65x (entry price <= ~0.61)
  const CLOSE_VALUE_MIN_SECS = 75;
  const CLOSE_VALUE_MAX_SECS = 210;
  const CLOSE_VALUE_CORE_MIN_SECS = 120;
  const CLOSE_VALUE_CORE_MAX_SECS = 180;
  const CLOSE_VALUE_EDGE_CENTS = 10;
  const CLOSE_VALUE_STRONG_EDGE_CENTS = 14;
  const CLOSE_VALUE_MIN_MISPRICE = 0.12;
  const CLOSE_VALUE_PAYOUT_MIN = 1.75;
  const SCALP_MIN_SECS = 420;
  const SCALP_MAX_SECS = 840;
  const SCALP_EDGE_CENTS = 6;
  const FINAL_SNIPE_MIN_SECS = 45;
  const FINAL_SNIPE_MAX_SECS = 90;

  // _locks[sym+closeTimeMs] = { direction, side, ts, closeTimeMs }
  var _locks = {};
  // _fadeCandidates[sym+closeTimeMs] = {
  //   direction, side, firstTs, lastTs, qualifiedSinceTs, lastQualifiedTs
  // }
  var _fadeCandidates = {};

  // --- SHARED ARRAY BUFFER (High-Frequency Memory-Mapped WebSocket Feeds) ---
  let sabFloatView = null;
  const SAB_SYMBOL_MAP = {
    'BTC': 0,
    'ETH': 1,
    'SOL': 2,
    'XRP': 3,
    'DOGE': 4,
    'BNB': 5
  };

  if (typeof window !== 'undefined' && window.electron && window.electron.sab) {
    window.electron.sab.onInit((sharedBuffer) => {
      console.log('[FloatingOrchestrator] SharedArrayBuffer attached to UI thread!');
      sabFloatView = new Float64Array(sharedBuffer);
    });
  }

  // Get instantly updated physical memory price (0ms deserialization overhead)
  function getSABPrice(symbol) {
    if (!sabFloatView) return null;
    const idx = SAB_SYMBOL_MAP[symbol];
    if (idx === undefined) return null;
    const val = sabFloatView[idx];
    return val > 0 ? val : null;
  }

  // Zero-cost polling loop (20Hz)
  setInterval(() => {
    if (sabFloatView) {
      const btc = getSABPrice('BTC');
      const eth = getSABPrice('ETH');
      if (btc && eth) {
        // Expose zero-latency prices globally for any UI component to read
        window._SAB_PRICES = { BTC: btc, ETH: eth };
      }
    }
  }, 50);
  // --------------------------------------------------------------------------

  function crowdFadeDir(kalshiYesPrice, secsLeft, dirs, modelDir) {
    if (!Number.isFinite(kalshiYesPrice)) return null;
    if (!dirs || !modelDir) return null;

    // Crowd-fade is blockchain-led: follow model direction only when crowd pricing disagrees.
    var kalshiDir = null;
    if (kalshiYesPrice >= (0.5 + CROWD_FADE_NEUTRAL_BAND)) kalshiDir = dirs.yesDir;
    else if (kalshiYesPrice <= (0.5 - CROWD_FADE_NEUTRAL_BAND)) kalshiDir = dirs.noDir;
    if (!kalshiDir || kalshiDir === modelDir) return null;
    return modelDir;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function hash32(text) {
    var h = 2166136261 >>> 0;
    var t = String(text || '');
    for (var i = 0; i < t.length; i += 1) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function seededRng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function confidence01(v) {
    if (!Number.isFinite(v)) return 0;
    if (v <= 1.01) return clamp(v, 0, 1);
    return clamp(v / 100, 0, 1);
  }
  function directionSign(dir) {
    if (dir === 'UP') return 1;
    if (dir === 'DOWN') return -1;
    return 0;
  }
  function extractRegimeTag(pred, cfm) {
    var diagRegime = pred && pred.diagnostics && pred.diagnostics.regime;
    var regimeState = diagRegime && (diagRegime.regime_state || diagRegime.state);
    if (regimeState) return String(regimeState);
    var liveRegime = pred && pred.liveRegime && (pred.liveRegime.regime || pred.liveRegime.state);
    if (liveRegime) return String(liveRegime);
    if (typeof crowdFadeRegime === 'function') return crowdFadeRegime(pred, cfm);
    return 'mixed';
  }
  function normalizeRegimeTag(regimeTag) {
    var r = String(regimeTag || '').toLowerCase();
    if (r.indexOf('trend') !== -1) return 'trending';
    if (r.indexOf('mean') !== -1 || r.indexOf('range') !== -1 || r.indexOf('reversion') !== -1) return 'range';
    if (r.indexOf('vol') !== -1) return 'volatile';
    if (r.indexOf('chop') !== -1 || r.indexOf('noise') !== -1) return 'chop';
    return r || 'mixed';
  }
  function buildMctsState(sym, pred, cfm, context) {
    if (!MCTS_ENABLED) return null;
    if (!pred || !Number.isFinite(context && context.modelProbUp)) return null;
    var momentum = cfm && Number.isFinite(cfm.momentum) ? cfm.momentum : 0;
    var trendDir = cfm && cfm.trend === 'rising' ? 1 : cfm && cfm.trend === 'falling' ? -1 : 0;
    var atrPct = pred && pred.volatility && Number.isFinite(pred.volatility.atrPct) ? pred.volatility.atrPct : null;
    var volatilityNorm = atrPct == null ? 0.25 : clamp(atrPct / 4.0, 0, 1.2);
    var liquidity = Number.isFinite(context && context.liquidity) ? context.liquidity : 1200;
    return {
      sym: sym,
      confidence: confidence01(context && context.calibratedConfidence),
      modelProbUp: clamp(context.modelProbUp, 0.02, 0.98),
      modelStrength: clamp(Math.abs(context.modelScore || 0), 0, 1),
      momentum: clamp(momentum, -1, 1),
      trendDir: trendDir,
      volatility: clamp(volatilityNorm, 0, 1.5),
      mispricing: Number.isFinite(context && context.mispricing) ? clamp(context.mispricing, 0, 0.5) : 0,
      secsLeft: Number.isFinite(context && context.secsLeft) ? context.secsLeft : null,
      liquidity: clamp(liquidity, 50, 200000),
      regime: normalizeRegimeTag(context && context.regimeTag),
      direction: context && context.currentDirection ? context.currentDirection : null,
      side: context && context.currentSide ? context.currentSide : null,
    };
  }

  function rolloutRewardForAction(state, action, rng, depth) {
    var bias = ((state.modelProbUp - 0.5) * 1.9) + (state.momentum * 0.5) + (state.trendDir * 0.3);
    var path = 0;
    var steps = Math.max(2, depth);
    for (var i = 0; i < steps; i += 1) {
      var shockScale = 0.12 + (state.volatility * 0.22) + (state.regime === 'chop' ? 0.08 : 0);
      if (state.regime === 'volatile') shockScale += 0.05;
      var shock = (rng() - 0.5) * 2 * shockScale;
      path += (bias * 0.38) + shock;
    }
    var dirEdge = path / Math.max(1, steps);
    var lateRisk = state.secsLeft != null ? clamp((90 - state.secsLeft) / 90, 0, 1) : 0.4;
    var slippage = clamp((state.volatility * 0.4) + (state.liquidity < 1400 ? 0.25 : 0), 0, 1.3);
    if (action === 'WAIT') {
      var waitSafety = (0.35 * lateRisk) + (0.22 * slippage) + (state.regime === 'volatile' ? 0.18 : 0);
      var waitOpportunityCost = Math.abs(dirEdge) * (0.45 + (state.confidence * 0.55));
      return clamp(waitSafety - waitOpportunityCost, -1.5, 1.5);
    }
    var sign = action === 'UP' ? 1 : -1;
    var directionalFit = sign * dirEdge;
    var confidenceBoost = state.confidence * (0.30 + state.modelStrength * 0.20);
    var mispricingBoost = state.mispricing * 1.3;
    var wrongWayPenalty = (sign === 1 ? (0.5 - state.modelProbUp) : (state.modelProbUp - 0.5));
    var regimePenalty = (state.regime === 'volatile' ? 0.14 : (state.regime === 'chop' ? 0.07 : 0));
    var riskPenalty = (lateRisk * 0.28) + (slippage * 0.20) + regimePenalty + Math.max(0, wrongWayPenalty);
    return clamp((directionalFit * 1.2) + confidenceBoost + mispricingBoost - riskPenalty, -1.5, 1.5);
  }

  // --- WASM-backed when available; deterministic JS fallback otherwise ---
  function runVanillaMcts(state, cfg) {
    if (!state) {
      return { ran: false, reason: 'missing-state' };
    }

    var sims = Math.max(8, Number(cfg && cfg.simulations) || MCTS_SIMULATIONS);
    var depth = Math.max(2, Number(cfg && cfg.depth) || MCTS_DEPTH);
    var c = Number.isFinite(Number(cfg && cfg.exploration)) ? Number(cfg.exploration) : MCTS_EXPLORATION;
    var seed = hash32([
      state.sym,
      state.modelProbUp.toFixed(5),
      state.confidence.toFixed(4),
      state.momentum.toFixed(4),
      state.volatility.toFixed(4),
      state.mispricing.toFixed(4),
      state.secsLeft == null ? 'na' : String(Math.round(state.secsLeft)),
      state.regime
    ].join('|'));

    var scores = null;
    var engine = (typeof window !== 'undefined') ? window.TensorEngine : null;
    if (engine && typeof engine.canRunMcts === 'function' && engine.canRunMcts()) {
      scores = engine.runMcts(state, sims, depth, c);
    }

    if (!scores || scores.length < 3) {
      var rng = seededRng(seed);
      var children = {
        UP: { action: 'UP', visits: 0, total: 0 },
        DOWN: { action: 'DOWN', visits: 0, total: 0 },
        WAIT: { action: 'WAIT', visits: 0, total: 0 },
      };
      var totalVisits = 0;
      var actions = ['UP', 'DOWN', 'WAIT'];
      for (var i = 0; i < sims; i += 1) {
        var picked = null;
        var bestUcb = -Infinity;
        for (var j = 0; j < actions.length; j += 1) {
          var child = children[actions[j]];
          var ucb = child.visits === 0
            ? Infinity
            : (child.total / child.visits) + c * Math.sqrt(Math.log(totalVisits + 1) / child.visits);
          if (ucb > bestUcb) {
            bestUcb = ucb;
            picked = child;
          }
        }
        var reward = rolloutRewardForAction(state, picked.action, rng, depth);
        picked.visits += 1;
        picked.total += reward;
        totalVisits += 1;
      }
      function avg(action) {
        var node = children[action];
        return node.visits > 0 ? (node.total / node.visits) : 0;
      }
      scores = new Float64Array([
        avg('UP'),
        avg('DOWN'),
        avg('WAIT')
      ]);
    }

    if (!scores || scores.length < 3) return { ran: false };

    if (state.mispricing && state.mispricing >= 0.12 && state.modelStrength >= 0.05) {
      scores[2] -= (state.mispricing * 1.5);
    }

    var upScore = scores[0];
    var downScore = scores[1];
    var waitScore = scores[2];

    var ordered = [
      { action: 'UP', score: upScore },
      { action: 'DOWN', score: downScore },
      { action: 'WAIT', score: waitScore },
    ].sort(function (a, b) { return b.score - a.score; });

    var best = ordered[0];
    var second = ordered[1];

    try {
      if (typeof persistPrediction === 'function') {
        persistPrediction({
          market_id: state.sym,
          coin: state.sym,
          timestamp: new Date().toISOString(),
          voteAction: best.action,
          voteStrength: parseFloat(Math.abs(best.score - second.score).toFixed(4)),
          sessionId: (window.SESSION_ID || null)
        });
      }
    } catch(e) {}

    return {
      ran: true,
      seed: seed,
      simulations: sims,
      depth: depth,
      exploration: c,
      voteAction: best.action,
      voteStrength: parseFloat(Math.abs(best.score - second.score).toFixed(4)),
      directionalGap: parseFloat((upScore - downScore).toFixed(4)),
      waitScore: parseFloat(waitScore.toFixed(4)),
      upScore: parseFloat(upScore.toFixed(4)),
      downScore: parseFloat(downScore.toFixed(4))
    };
  }

  function computeWaitGuardThreshold(params) {
    var base = WAIT_GUARD_TIMING_SCORE_BASE;
    var sym = String(params && params.sym || '').toUpperCase();
    var regime = normalizeRegimeTag(params && params.regimeTag);
    var mcts = params && params.mctsResult ? params.mctsResult : null;
    var conf = Number.isFinite(params && params.calibratedConfidence) ? params.calibratedConfidence : 0;
    if (sym === 'BTC' || sym === 'ETH') base -= WAIT_GUARD_BTC_ETH_RELAX;
    if (regime === 'trending') base -= WAIT_GUARD_REGIME_TREND_RELAX;
    else if (regime === 'volatile' || regime === 'chop') base += WAIT_GUARD_REGIME_VOLATILE_PENALTY;
    if (conf >= 18) base -= 2;
    if (mcts && mcts.ran) {
      if (mcts.voteAction === 'WAIT') base += 2;
      else {
        var relax = Math.round(clamp((mcts.voteStrength || 0) * 10, 0, WAIT_GUARD_MCTS_RELAX_MAX));
        base -= relax;
      }
    }
    return Math.round(clamp(base, 50, 92));
  }

  function shouldBypassOpenWindowGuard(params) {
    if (!WAIT_GUARD_OPEN_BYPASS_ENABLED) return false;
    var sym = String(params && params.sym || '').toUpperCase();
    var regime = normalizeRegimeTag(params && params.regimeTag);
    if (regime === 'volatile' || regime === 'chop') return false;
    var conf = Number.isFinite(params && params.calibratedConfidence) ? params.calibratedConfidence : 0;
    var edge = Number.isFinite(params && params.edgeCents) ? params.edgeCents : 0;
    var mispricing = Number.isFinite(params && params.mispricing) ? params.mispricing : 0;
    var mcts = params && params.mctsResult;
    if (!mcts || !mcts.ran || mcts.voteAction === 'WAIT') return false;
    if ((mcts.voteStrength || 0) < MCTS_DIRECTION_OVERRIDE_MIN_GAP) return false;
    if (sym === 'BTC' || sym === 'ETH') {
      return conf >= WAIT_GUARD_OPEN_BYPASS_MIN_CONF
        && edge >= WAIT_GUARD_OPEN_BYPASS_MIN_EDGE
        && mispricing >= WAIT_GUARD_OPEN_BYPASS_MIN_MISPRICING;
    }
    return conf >= (WAIT_GUARD_OPEN_BYPASS_MIN_CONF + 2)
      && edge >= (WAIT_GUARD_OPEN_BYPASS_MIN_EDGE + 2)
      && mispricing >= Math.max(WAIT_GUARD_OPEN_BYPASS_MIN_MISPRICING, 0.14);
  }

  function crowdFadeFlowScore(modelDir, pred, cfm) {
    var score = 0;
    var isUp = modelDir === 'UP';
    var trend = pred && pred.trendDir > 0 ? 'rising' : (pred && pred.trendDir < 0 ? 'falling' : 'flat');
    var bookImbalance = cfm && cfm.bookImbalance;
    var buyRatio = cfm && cfm.buyRatio;
    var volRatio = cfm && cfm.volRatio;

    if ((isUp && trend === 'rising') || (!isUp && trend === 'falling')) score += 1;
    else if ((isUp && trend === 'falling') || (!isUp && trend === 'rising')) score -= 1;

    if (bookImbalance != null) {
      if ((isUp && bookImbalance >= 0.10) || (!isUp && bookImbalance <= -0.10)) score += 1;
      else if ((isUp && bookImbalance <= -0.12) || (!isUp && bookImbalance >= 0.12)) score -= 1;
    }

    if (buyRatio != null) {
      if ((isUp && buyRatio >= 55) || (!isUp && buyRatio <= 45)) score += 1;
      else if ((isUp && buyRatio <= 43) || (!isUp && buyRatio >= 57)) score -= 1;
    }

    if (volRatio != null) {
      if (volRatio >= 1.08) score += 1;
      else if (volRatio <= 0.88) score -= 1;
    }

    return clamp(score, -2, 5);
  }

  function crowdFadeToxicity(pred, cfm, liquidity, flowScore) {
    var toxicity = 0;
    var atr = pred && pred.volatility && Number.isFinite(pred.volatility.atrPct)
      ? pred.volatility.atrPct : null;
    if (Number.isFinite(liquidity) && liquidity > 0 && liquidity < CROWD_FADE_MIN_LIQUIDITY) toxicity += 1;
    if (cfm && Number.isFinite(cfm.bidAsk) && cfm.bidAsk >= 0.35) toxicity += 1;
    if (cfm && Number.isFinite(cfm.spread) && cfm.spread >= 0.75) toxicity += 1;
    if (atr != null && atr >= 3.5) toxicity += 1;
    if (flowScore < 1) toxicity += 1;
    return toxicity;
  }

  function formatCrowdFadeWindowSecs(secs) {
    var n = Number(secs);
    if (!Number.isFinite(n)) return '?';
    return n >= 60 ? Math.round(n / 60) + 'm' : Math.round(n) + 's';
  }

  function buildCrowdFadeTimingProfile(params) {
    var secsLeft = params.secsLeft;
    var mispricing = params.mispricing;
    var edgeCents = params.edgeCents;
    var modelConfidence = params.modelConfidence;
    var liquidity = params.liquidity;
    var pred = params.pred;
    var cfm = params.cfm;
    var modelDir = params.modelDir;

    var regime = normalizeRegimeTag(extractRegimeTag(pred, cfm));
    var flowScore = crowdFadeFlowScore(modelDir, pred, cfm);
    var toxicity = crowdFadeToxicity(pred, cfm, liquidity, flowScore);
    var activeMinSecs = CROWD_FADE_BASE_MIN_SECS;
    var activeMaxSecs = CROWD_FADE_BASE_MAX_SECS;
    var timingLabel = 'adaptive';

    if (regime === 'trending' && flowScore >= 3 && mispricing >= 0.20 && edgeCents >= 18) {
      activeMinSecs = CROWD_FADE_HARD_MIN_SECS;
      activeMaxSecs = CROWD_FADE_HARD_MAX_SECS;
      timingLabel = 'fast-track';
    } else if (regime === 'trending' && flowScore >= 2) {
      activeMinSecs = 105;
      activeMaxSecs = 510;
      timingLabel = 'trend-led';
    } else if (regime === 'range') {
      activeMinSecs = 165;
      activeMaxSecs = 420;
      timingLabel = 'range-confirm';
    } else if (regime === 'volatile' || toxicity >= 3) {
      activeMinSecs = 150;
      activeMaxSecs = 330;
      timingLabel = 'volatility-caution';
    } else {
      activeMinSecs = 135;
      activeMaxSecs = 480;
    }

    if (flowScore >= 4 && mispricing >= 0.24 && edgeCents >= 20) timingLabel = 'fast-track';

    activeMinSecs = clamp(activeMinSecs, CROWD_FADE_HARD_MIN_SECS, CROWD_FADE_HARD_MAX_SECS);
    activeMaxSecs = clamp(activeMaxSecs, activeMinSecs + 30, CROWD_FADE_HARD_MAX_SECS);

    var span = Math.max(1, activeMaxSecs - activeMinSecs);
    var t = Number.isFinite(secsLeft) ? clamp((secsLeft - activeMinSecs) / span, 0, 1) : 1;

    var confirmMs = 25000 + t * 18000;
    confirmMs += toxicity * 5000;
    confirmMs -= Math.max(0, flowScore - 1) * 2500;
    if (mispricing >= 0.24) confirmMs -= 3000;
    else if (mispricing >= 0.20) confirmMs -= 1500;
    if (edgeCents >= 20) confirmMs -= 1000;
    if (modelConfidence >= 0.20) confirmMs -= 1000;
    confirmMs = Math.round(clamp(confirmMs, CROWD_FADE_CONFIRM_MIN_MS, CROWD_FADE_CONFIRM_MAX_MS));

    var minMispricing = CROWD_FADE_MIN_MISPRICE + t * (CROWD_FADE_MAX_MISPRICE - CROWD_FADE_MIN_MISPRICE);
    if (regime === 'trending') minMispricing -= 0.01;
    if (regime === 'range') minMispricing += 0.01;
    minMispricing += toxicity * 0.01;
    if (flowScore >= 3) minMispricing -= 0.02;
    minMispricing = clamp(minMispricing, 0.12, 0.28);

    var minEdgeCents = CROWD_FADE_MIN_EDGE_CENTS + Math.max(0, toxicity - 1) * 2;
    if (flowScore >= 3) minEdgeCents -= 2;
    if (regime === 'range') minEdgeCents += 1;
    minEdgeCents = Math.round(clamp(minEdgeCents, 10, 24));

    var minModelConfidence = CROWD_FADE_MIN_MODEL_CONF + Math.max(0, toxicity - 1) * 0.015;
    if (flowScore >= 3) minModelConfidence -= 0.02;
    if (regime === 'volatile') minModelConfidence += 0.02;
    minModelConfidence = clamp(minModelConfidence, 0.10, 0.22);

    var minLiquidity = CROWD_FADE_MIN_LIQUIDITY;
    if (regime === 'volatile') minLiquidity += 500;
    if (flowScore >= 3) minLiquidity = Math.max(1000, minLiquidity - 250);

    var lateSideGraceSecs = 20;
    var earlySideGraceSecs = 25;
    if (flowScore >= 2) {
      lateSideGraceSecs += 10;
      earlySideGraceSecs += 15;
    }
    if (flowScore >= 4) {
      lateSideGraceSecs += 10;
      earlySideGraceSecs += 15;
    }
    if (regime === 'trending') {
      lateSideGraceSecs += 15;
      earlySideGraceSecs += 20;
    } else if (regime === 'range') {
      lateSideGraceSecs += 5;
      earlySideGraceSecs += 10;
    } else if (regime === 'volatile') {
      lateSideGraceSecs -= 5;
      earlySideGraceSecs -= 5;
    }
    if (mispricing >= 0.22) {
      lateSideGraceSecs += 10;
      earlySideGraceSecs += 10;
    }
    if (edgeCents >= 20) {
      lateSideGraceSecs += 5;
      earlySideGraceSecs += 10;
    }
    lateSideGraceSecs = Math.round(clamp(lateSideGraceSecs - toxicity * 4, 8, 75));
    earlySideGraceSecs = Math.round(clamp(earlySideGraceSecs - Math.max(0, toxicity - 1) * 6, 12, 120));

    var softResetMs = 4500 + Math.max(0, flowScore) * 1500;
    if (regime === 'trending') softResetMs += 1500;
    if (regime === 'volatile') softResetMs -= 1000;
    if (mispricing >= 0.22) softResetMs += 1000;
    softResetMs -= Math.max(0, toxicity - 1) * 1000;
    softResetMs = Math.round(clamp(softResetMs, 3500, 25000));

    var graceMinSecs = clamp(activeMinSecs - lateSideGraceSecs, MIN_SECONDS_LEFT, activeMaxSecs);
    var graceMaxSecs = clamp(
      activeMaxSecs + earlySideGraceSecs,
      Math.max(activeMaxSecs, graceMinSecs + 30),
      MAX_SECONDS_LEFT
    );

    return {
      regime: regime,
      flowScore: flowScore,
      toxicity: toxicity,
      activeMinSecs: activeMinSecs,
      activeMaxSecs: activeMaxSecs,
      confirmMs: confirmMs,
      minMispricing: minMispricing,
      minEdgeCents: minEdgeCents,
      minModelConfidence: minModelConfidence,
      minLiquidity: minLiquidity,
      lateSideGraceSecs: lateSideGraceSecs,
      earlySideGraceSecs: earlySideGraceSecs,
      graceMinSecs: graceMinSecs,
      graceMaxSecs: graceMaxSecs,
      softResetMs: softResetMs,
      timingLabel: timingLabel,
      coreWindowLabel: formatCrowdFadeWindowSecs(activeMinSecs) + '→' + formatCrowdFadeWindowSecs(activeMaxSecs),
      windowLabel: formatCrowdFadeWindowSecs(graceMinSecs) + '→' + formatCrowdFadeWindowSecs(graceMaxSecs),
    };
  }

  function directionSign(direction) {
    return direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : 0;
  }

  function scalpSetupScore(direction, pred) {
    var setups = Array.isArray(pred && pred.scalpSetups) ? pred.scalpSetups : [];
    if (!setups.length || !direction) return 0;
    var sign = directionSign(direction);
    return setups.reduce(function (score, setup) {
      if (!setup || setup.type === 'avoid') return score - 1;
      var dir = setup.direction === 'up' ? 1 : setup.direction === 'down' ? -1 : 0;
      var strength = setup.strength === 'high' ? 2 : setup.strength === 'medium' ? 1 : 0;
      if (setup.type === 'scalp_window' && strength) return score + 1;
      if (!dir || !sign) return score;
      return score + (dir === sign ? strength : -strength);
    }, 0);
  }

  function buildAdaptiveTimingRegime(params) {
    var sym = params.sym;
    var secsLeft = params.secsLeft;
    var entry = params.entry;
    var pred = params.pred || null;
    var cfm = params.cfm || null;
    var direction = params.direction;
    var modelActive = !!params.modelActive;
    var modelYesProb = params.modelYesProb;
    var kalshiYesPrice = params.kalshiYesPrice;
    var liquidity = params.liquidity;
    var finalConfidenceWeak = !!params.finalConfidenceWeak;
    var logTunedDowngradeReason = params.logTunedDowngradeReason || null;
    var reasons = [];
    var blocks = [];
    var phase = 'UNTIMED';

    if (Number.isFinite(secsLeft)) {
      if (secsLeft < FINAL_SNIPE_MIN_SECS) phase = 'SETTLING';
      else if (secsLeft < FINAL_SNIPE_MAX_SECS) phase = 'FINAL_SNIPE';
      else if (secsLeft <= CLOSE_VALUE_MAX_SECS) phase = 'CLOSE_VALUE';
      else if (secsLeft <= 420) phase = 'PRIME';
      else if (secsLeft <= SCALP_MAX_SECS) phase = 'SCALP_EARLY';
      else phase = 'SETUP';
    }

    var edgeCents = entry && Number.isFinite(entry.edgeCents) ? entry.edgeCents : 0;
    var payout = entry && Number.isFinite(entry.payoutMult) ? entry.payoutMult : 0;
    var entryPrice = entry && Number.isFinite(entry.entryPrice) ? entry.entryPrice : null;
    var modelConfidence = Number.isFinite(modelYesProb) ? Math.abs(modelYesProb - 0.5) : 0;
    var mispricing = Number.isFinite(modelYesProb) && Number.isFinite(kalshiYesPrice)
      ? Math.abs(modelYesProb - kalshiYesPrice)
      : 0;
    var adaptiveTiming = null;
    try {
      if (typeof window !== 'undefined' && window._adaptiveTuner?.getAdaptiveTimingThresholds) {
        adaptiveTiming = window._adaptiveTuner.getAdaptiveTimingThresholds(sym, {
          closeEdgeCents: CLOSE_VALUE_EDGE_CENTS,
          closeStrongEdgeCents: CLOSE_VALUE_STRONG_EDGE_CENTS,
          closeMinMisprice: CLOSE_VALUE_MIN_MISPRICE,
          closePayoutMin: CLOSE_VALUE_PAYOUT_MIN,
          scalpEdgeCents: SCALP_EDGE_CENTS,
        }, {
          pred: pred,
          cfm: cfm,
          secsLeft: secsLeft,
          direction: direction,
          edgeCents: edgeCents,
          modelYesProb: modelYesProb,
          kalshiYesPrice: kalshiYesPrice,
          bookImbalance: pred?.indicators?.book?.imbalance,
          buyRatio: pred?.indicators?.flow?.buyRatio,
        });
      }
    } catch (_) {}
    var closeEdgeCents = adaptiveTiming?.closeEdgeCents ?? CLOSE_VALUE_EDGE_CENTS;
    var closeStrongEdgeCents = adaptiveTiming?.closeStrongEdgeCents ?? CLOSE_VALUE_STRONG_EDGE_CENTS;
    var closeMinMisprice = adaptiveTiming?.closeMinMisprice ?? CLOSE_VALUE_MIN_MISPRICE;
    var closePayoutMin = adaptiveTiming?.closePayoutMin ?? CLOSE_VALUE_PAYOUT_MIN;
    var scalpEdgeCents = adaptiveTiming?.scalpEdgeCents ?? SCALP_EDGE_CENTS;
    var flowScore = crowdFadeFlowScore(direction, pred, cfm);
    var toxicity = crowdFadeToxicity(pred, cfm, liquidity, flowScore);
    var scalpScore = scalpSetupScore(direction, pred);
    var payoutHeavy = payout >= closePayoutMin || (entryPrice != null && entryPrice <= (1 / closePayoutMin));
    var coreCloseValueWindow = Number.isFinite(secsLeft)
      && secsLeft >= CLOSE_VALUE_CORE_MIN_SECS
      && secsLeft <= CLOSE_VALUE_CORE_MAX_SECS;
    var requiredCloseEdgeCents = coreCloseValueWindow ? closeEdgeCents : closeStrongEdgeCents;
    var closeValueFlowOk = flowScore >= 1
      || (coreCloseValueWindow && edgeCents >= closeEdgeCents + 6 && mispricing >= closeMinMisprice + 0.04)
      || (coreCloseValueWindow && edgeCents >= closeStrongEdgeCents + 4 && payoutHeavy);
    if (adaptiveTiming?.reasons?.length) {
      reasons.push('adaptive tuner: ' + adaptiveTiming.reasons.slice(0, 2).join(', '));
    }

    if (!modelActive) blocks.push('model inactive');
    if (!entry) blocks.push('no executable entry');
    if (finalConfidenceWeak) blocks.push('final model confidence weak');
    if (logTunedDowngradeReason) blocks.push(logTunedDowngradeReason);

    var closeValueQualified = phase === 'CLOSE_VALUE'
      && modelActive
      && !!entry
      && edgeCents >= requiredCloseEdgeCents
      && (mispricing >= closeMinMisprice || payoutHeavy)
      && closeValueFlowOk
      && toxicity <= 2
      && !logTunedDowngradeReason
      && (!finalConfidenceWeak || edgeCents >= closeStrongEdgeCents);

    var finalSnipeQualified = phase === 'FINAL_SNIPE'
      && modelActive
      && !!entry
      && edgeCents >= 16
      && mispricing >= 0.18
      && payout >= 2.0
      && flowScore >= 2
      && toxicity <= 1
      && !finalConfidenceWeak
      && !logTunedDowngradeReason;

    var scalpQualified = phase === 'SCALP_EARLY'
      && modelActive
      && !!entry
      && edgeCents >= scalpEdgeCents
      && modelConfidence >= 0.08
      && (flowScore >= 2 || scalpScore >= 2)
      && toxicity <= 2
      && !entry.tailRisk
      && !entry.thinBook
      && !finalConfidenceWeak
      && !logTunedDowngradeReason;

    var primeQualified = phase === 'PRIME'
      && modelActive
      && !!entry
      && edgeCents >= closeEdgeCents
      && (mispricing >= closeMinMisprice - 0.02 || payoutHeavy || flowScore >= 1)
      && toxicity <= 2
      && !entry.tailRisk
      && !finalConfidenceWeak
      && !logTunedDowngradeReason;

    if (phase === 'CLOSE_VALUE') {
      if (coreCloseValueWindow) reasons.push('core 2-3m value window');
      if (payoutHeavy) reasons.push('payout skew favorable');
      if (mispricing >= closeMinMisprice) reasons.push('market/model mispricing');
      if (flowScore >= 1) reasons.push('book/tape confirms');
      else if (closeValueFlowOk) reasons.push('large edge overrides neutral book');
      if (!closeValueQualified) {
        if (edgeCents < requiredCloseEdgeCents) blocks.push('close-window edge below +' + requiredCloseEdgeCents + 'c');
        if (!payoutHeavy && mispricing < closeMinMisprice) blocks.push('no payout/mispricing skew');
        if (!closeValueFlowOk) blocks.push('book/tape not confirming');
        if (toxicity > 2) blocks.push('microstructure toxicity elevated');
      }
    } else if (phase === 'SCALP_EARLY') {
      if (flowScore >= 2) reasons.push('book/tape impulse');
      if (scalpScore >= 2) reasons.push('scalp setup aligned');
      if (edgeCents >= scalpEdgeCents) reasons.push('positive scalp edge');
      if (!scalpQualified) {
        if (edgeCents < scalpEdgeCents) blocks.push('scalp edge below +' + scalpEdgeCents + 'c');
        if (flowScore < 2 && scalpScore < 2) blocks.push('no scalp impulse yet');
        if (entry && (entry.tailRisk || entry.thinBook)) blocks.push('bad scalp fill profile');
      }
    } else if (phase === 'PRIME') {
      if (flowScore >= 1) reasons.push('book/tape supports prime entry');
      if (edgeCents >= closeEdgeCents) reasons.push('sufficient edge for prime window');
      if (!primeQualified) {
        if (edgeCents < closeEdgeCents) blocks.push('prime edge below +' + closeEdgeCents + 'c');
        if (toxicity > 2) blocks.push('prime microstructure toxicity elevated');
        if (entry && entry.tailRisk) blocks.push('prime tail risk avoided');
      }
    } else if (phase === 'FINAL_SNIPE') {
      if (!finalSnipeQualified) blocks.push('final snipe requires exceptional edge, payout, and clean tape');
    } else if (phase === 'SETTLING') {
      blocks.push('settlement too close for new entry');
    }

    var score = 0;
    score += clamp(edgeCents / 24, 0, 1) * 35;
    score += clamp(mispricing / 0.24, 0, 1) * 25;
    score += clamp((payout - 1) / 1.5, 0, 1) * 18;
    score += clamp((flowScore + 2) / 7, 0, 1) * 12;
    score += clamp((scalpScore + 2) / 6, 0, 1) * 10;
    score -= toxicity * 8;
    score = Math.round(clamp(score, 0, 100));

    var timingLabel = {
      SCALP_EARLY: 'SCALP FLIP',
      SETUP: 'SETUP',
      PRIME: 'PRIME',
      CLOSE_VALUE: coreCloseValueWindow ? '2-3M VALUE' : 'CLOSE VALUE',
      FINAL_SNIPE: 'FINAL SNIPE',
      SETTLING: 'SETTLING',
      UNTIMED: 'LIVE',
    }[phase] || phase;

    var exitPlan = null;
    if (phase === 'SCALP_EARLY') {
      exitPlan = 'Scalp exit: sell into the probability flip; take +8-12c or exit when book imbalance/tape mean-reverts.';
    } else if (phase === 'CLOSE_VALUE') {
      exitPlan = 'Close-value plan: hold only while edge stays mispriced; cancel/exit if live book flips or edge compresses under +6c.';
    } else if (phase === 'FINAL_SNIPE') {
      exitPlan = 'Final-snipe plan: only fill at price; no chase, no averaging, abandon on first book flip.';
    } else if (phase === 'PRIME') {
      exitPlan = 'Prime plan: enter if edge remains stable and manage before the last-minute spread widens.';
    }

    return {
      phase: phase,
      timingLabel: timingLabel,
      timingScore: score,
      promoteToTrade: closeValueQualified || finalSnipeQualified || scalpQualified || primeQualified,
      closeValueQualified: closeValueQualified,
      finalSnipeQualified: finalSnipeQualified,
      scalpQualified: scalpQualified,
      primeQualified: primeQualified,
      scalpCandidate: phase === 'SCALP_EARLY',
      closeValueCandidate: phase === 'CLOSE_VALUE',
      coreCloseValueWindow: coreCloseValueWindow,
      flowScore: flowScore,
      scalpScore: scalpScore,
      toxicity: toxicity,
      mispricing: mispricing,
      payoutHeavy: payoutHeavy,
      adaptiveTiming: adaptiveTiming,
      reasons: reasons,
      blocks: blocks.filter(Boolean),
      exitPlan: exitPlan,
    };
  }

  function pruneContractState(nowMs) {
    Object.keys(_locks).forEach(function (key) {
      var v = _locks[key];
      if (!v) { delete _locks[key]; return; }
      var expiredByClose = Number.isFinite(v.closeTimeMs) && nowMs > (v.closeTimeMs + 60000);
      var expiredByAge = Number.isFinite(v.ts) ? (nowMs - v.ts > LOCK_MS * 4) : true;
      if (expiredByClose || expiredByAge) delete _locks[key];
    });
    Object.keys(_fadeCandidates).forEach(function (key) {
      var v = _fadeCandidates[key];
      if (!v) { delete _fadeCandidates[key]; return; }
      if (!Number.isFinite(v.lastTs) || (nowMs - v.lastTs) > STATE_PRUNE_MS) delete _fadeCandidates[key];
    });
  }

  function scoreToProbUp(score) {
    return clamp(0.5 + score * 0.40, 0.02, 0.98);
  }

  function yesNoFromStrikeDir(strikeDir) {
    var yesDir = strikeDir === 'below' ? 'DOWN' : 'UP';
    return { yesDir: yesDir, noDir: yesDir === 'UP' ? 'DOWN' : 'UP' };
  }

  function computeEV(side, modelProbUp, kalshiYesPrice) {
    return side === 'YES' ? modelProbUp - kalshiYesPrice
      : kalshiYesPrice - modelProbUp;
  }

  function analyseEntry(side, modelProbUp, kalshiYesPrice) {
    var entryPrice = side === 'YES' ? kalshiYesPrice : (1 - kalshiYesPrice);
    var winProb = side === 'YES' ? modelProbUp : (1 - modelProbUp);
    var evRaw = computeEV(side, modelProbUp, kalshiYesPrice);
    var edgeCents = Math.round(evRaw * 100);
    var payoutMult = entryPrice > 0 ? parseFloat((1 / entryPrice).toFixed(2)) : null;
    var breakEven = parseFloat(entryPrice.toFixed(4));
    var netPayout = 1 - entryPrice;
    var kellyFrac = 0;
    if (evRaw > 0 && winProb > 0 && netPayout > 0)
      kellyFrac = clamp(evRaw / (winProb * netPayout), 0, MAX_KELLY);
    return {
      entryPrice: parseFloat(entryPrice.toFixed(4)),
      evRaw, edgeCents, payoutMult, breakEven,
      kellyFrac: parseFloat(kellyFrac.toFixed(4)),
      kellyPct: Math.round(kellyFrac * 100),
      isInversion: Math.abs(edgeCents) >= INVERSION_THRESH,
      thinBook: entryPrice <= THIN_BOOK_THRESH,
      tailRisk: entryPrice >= TAIL_RISK_THRESH,
      lossErasesWins: (entryPrice >= TAIL_RISK_THRESH && netPayout > 0)
        ? Math.round(entryPrice / netPayout) : null,
    };
  }

  function evaluateCrowdFade(params) {
    var sym = params.sym;
    var closeTimeMs = params.closeTimeMs;
    var kalshiYesPrice = params.kalshiYesPrice;
    var secsLeft = params.secsLeft;
    var dirs = params.dirs;
    var modelDir = params.modelDir;
    var modelYesProb = params.modelYesProb;
    var modelActive = params.modelActive;
    var entryYes = params.entryYes;
    var entryNo = params.entryNo;
    var liquidity = params.liquidity;
    var pred = params.pred || null;
    var cfm = params.cfm || null;

    var key = sym + '_' + (closeTimeMs || 'none');
    function clearCandidate() { delete _fadeCandidates[key]; }

    var fadeDir = crowdFadeDir(kalshiYesPrice, secsLeft, dirs, modelDir);
    if (!fadeDir || !modelActive || !Number.isFinite(modelYesProb)) {
      clearCandidate();
      return null;
    }

    var fadeSide = fadeDir === dirs.yesDir ? 'YES' : 'NO';
    var fadeEntry = fadeSide === 'YES' ? entryYes : entryNo;
    if (!fadeEntry) {
      clearCandidate();
      return null;
    }

    var now = Date.now();
    var prev = _fadeCandidates[key];
    var sameCandidate = !!(prev && prev.direction === fadeDir && prev.side === fadeSide);

    var mispricing = Math.abs(modelYesProb - kalshiYesPrice);
    var modelConfidence = Math.abs(modelYesProb - 0.5);
    var profile = buildCrowdFadeTimingProfile({
      secsLeft: secsLeft,
      mispricing: mispricing,
      edgeCents: fadeEntry.edgeCents,
      modelConfidence: modelConfidence,
      liquidity: liquidity,
      pred: pred,
      cfm: cfm,
      modelDir: fadeDir,
    });
    var withinAdaptiveWindow = Number.isFinite(secsLeft)
      && secsLeft >= profile.activeMinSecs
      && secsLeft <= profile.activeMaxSecs;
    var withinGraceWindow = Number.isFinite(secsLeft)
      && secsLeft >= profile.graceMinSecs
      && secsLeft <= profile.graceMaxSecs;
    if (!withinAdaptiveWindow && !sameCandidate) {
      clearCandidate();
      return null;
    }

    var edgeOk = Number.isFinite(fadeEntry.edgeCents) && fadeEntry.edgeCents >= profile.minEdgeCents;
    var modelConfOk = modelConfidence >= profile.minModelConfidence;
    var liquidityOk = !Number.isFinite(liquidity) || liquidity <= 0 || liquidity >= profile.minLiquidity;
    var qualified = modelConfOk && edgeOk && liquidityOk && mispricing >= profile.minMispricing;
    var lastQualifiedTs = sameCandidate
      ? (Number.isFinite(prev.lastQualifiedTs) ? prev.lastQualifiedTs : prev.lastTs)
      : null;
    var qualifiedSinceTs = sameCandidate
      ? (Number.isFinite(prev.qualifiedSinceTs) ? prev.qualifiedSinceTs : prev.firstTs)
      : null;
    var softHold = sameCandidate
      && withinGraceWindow
      && Number.isFinite(lastQualifiedTs)
      && (now - lastQualifiedTs) <= profile.softResetMs;
    if ((!qualified || !withinAdaptiveWindow) && !softHold) {
      clearCandidate();
      return null;
    }

    var timingLabel = profile.timingLabel;
    if (!withinAdaptiveWindow && softHold) timingLabel += ' hold';
    else if (!qualified && softHold) timingLabel += ' soft';

    if (sameCandidate) {
      prev.lastTs = now;
      if (qualified && withinAdaptiveWindow) {
        if (!Number.isFinite(prev.firstTs)) prev.firstTs = now;
        if (!Number.isFinite(prev.qualifiedSinceTs)) prev.qualifiedSinceTs = prev.firstTs;
        prev.lastQualifiedTs = now;
      }
      if (!Number.isFinite(prev.qualifiedSinceTs)) prev.qualifiedSinceTs = qualifiedSinceTs || prev.firstTs || now;
      var ageMs = Math.max(0, now - prev.qualifiedSinceTs);
      return {
        suggested: true,
        confirmed: ageMs >= profile.confirmMs,
        direction: fadeDir,
        side: fadeSide,
        entry: fadeEntry,
        ageMs: ageMs,
        confirmMs: profile.confirmMs,
        mispricing: mispricing,
        minMispricing: profile.minMispricing,
        timingLabel: timingLabel,
        windowLabel: profile.windowLabel,
        regime: profile.regime,
        flowScore: profile.flowScore,
      };
    }

    _fadeCandidates[key] = {
      direction: fadeDir,
      side: fadeSide,
      firstTs: now,
      lastTs: now,
      qualifiedSinceTs: now,
      lastQualifiedTs: now,
    };
    return {
      suggested: true,
      confirmed: false,
      direction: fadeDir,
      side: fadeSide,
      entry: fadeEntry,
      ageMs: 0,
      confirmMs: profile.confirmMs,
      mispricing: mispricing,
      minMispricing: profile.minMispricing,
      timingLabel: timingLabel,
      windowLabel: profile.windowLabel,
      regime: profile.regime,
      flowScore: profile.flowScore,
    };
  }

  function translate(sym, pred, cfm) {
    var pm = window.PredictionMarkets && window.PredictionMarkets.getCoin && window.PredictionMarkets.getCoin(sym);
    var polyMarket = (pm && (pm.poly15m || pm.poly5m || pm.poly)) || null;
    var kAlign = pred && pred.projections && pred.projections.p15 && (pred.projections.p15.polyAlign || pred.projections.p15.kalshiAlign) ? (pred.projections.p15.polyAlign || pred.projections.p15.kalshiAlign) : null;
    var strikeDirRaw = (kAlign && kAlign.strikeDir) || (polyMarket && polyMarket.strikeDir) || 'above';
    var strikeDir = strikeDirRaw === 'below' ? 'below' : 'above';
    var dirs = yesNoFromStrikeDir(strikeDir);
    var modelScore = (pred && pred.score) || 0;
    var calibratedConfidence = pred && Number.isFinite(pred.confidence) ? pred.confidence : null;
    var modelVetoed = !!(pred && pred.diagnostics && pred.diagnostics.vetoed);
    var modelVetoReason = pred && pred.diagnostics && pred.diagnostics.vetoReason ? String(pred.diagnostics.vetoReason) : '';
    var modelVetoSeverity = pred && pred.diagnostics && pred.diagnostics.vetoSeverity
      ? String(pred.diagnostics.vetoSeverity).toLowerCase()
      : '';
    var modelHardVeto = modelVetoSeverity === 'hard' || !!(pred && pred.diagnostics && pred.diagnostics.hardVeto);
    var modelSoftVeto = !modelHardVeto && (modelVetoed || !!(pred && pred.diagnostics && pred.diagnostics.softVeto));
    var modelProbUpRaw = (kAlign && Number.isFinite(kAlign.modelYesPct))
      ? (kAlign.modelYesPct / 100)
      : (pred && pred.diagnostics && pred.diagnostics.ptbAnchor && Number.isFinite(pred.diagnostics.ptbAnchor.modelYesPct))
        ? (pred.diagnostics.ptbAnchor.modelYesPct / 100)
        : scoreToProbUp(modelScore);
    var signalGate = (pred && pred.gate) || (pred && pred.diagnostics && pred.diagnostics.signalGate) || null;
    var signalGateBlocked = !!(signalGate && signalGate.gated);
    var signalGateReasons = signalGate && Array.isArray(signalGate.reasons) ? signalGate.reasons : [];
    // Model probability from calibrated signals
    var modelProbUp = modelProbUpRaw;
    // Map model's UP/DOWN probability to YES/NO based on contract structure
    var modelYesProb = strikeDir === 'below' ? (1 - modelProbUpRaw) : modelProbUpRaw;
    // Keep CDF reference available for diagnostics but NOT for direction
    var hasBinaryCdf = !!(kAlign && Number.isFinite(kAlign.modelYesPct));
    var scoreActive = Math.abs(modelScore) >= MODEL_THRESHOLD;
    var polyYesPrice = polyMarket ? (polyMarket.probability ?? polyMarket.yes ?? null) : null;
    var polyActive = polyYesPrice !== null && polyYesPrice !== undefined;
    var polyYesProb = polyActive ? polyYesPrice : 0.5;

    var evYesEdge = modelYesProb - polyYesProb;
    var evNoEdge = (1 - modelYesProb) - (1 - polyYesProb);
    var payoutYes = polyYesProb > 0 ? 1 / polyYesProb : 0;
    var payoutNo = (1 - polyYesProb) > 0 ? 1 / (1 - polyYesProb) : 0;

    // EV triggers for edge sizing only — do NOT use for direction override
    var yesEVTrigger = false;
    var noEVTrigger = false;

    var cdfActive = hasBinaryCdf
      ? (modelYesProb >= BINARY_CDF_YES_THRESHOLD || modelYesProb <= BINARY_CDF_NO_THRESHOLD || yesEVTrigger || noEVTrigger)
      : false;
    var confidenceActive = (calibratedConfidence != null ? calibratedConfidence : 0) >= FINAL_MODEL_CONF_MIN_TRADE;
    var modelActive = !modelHardVeto && !signalGateBlocked && scoreActive && confidenceActive;

    // DIRECTION FROM RAW MODEL ONLY — blockchain signals, not venue crowd odds
    var modelDir = null;
    if (modelScore > MODEL_THRESHOLD) modelDir = 'UP';
    else if (modelScore < -MODEL_THRESHOLD) modelDir = 'DOWN';
    var modelBullish = modelDir === 'UP';
    var venueDirHint = !polyActive ? null
      : polyYesPrice >= 0.55 ? dirs.yesDir
        : polyYesPrice <= 0.45 ? dirs.noDir
          : null;
    var venueBullish = venueDirHint === 'UP';
    var venueBearish = venueDirHint === 'DOWN';
    var venueNeutral = venueDirHint === null;
    var nowMs = Date.now();
    var closeTimeMs = k15 && k15.closeTime ? new Date(k15.closeTime).getTime() : null;
    var msLeft = closeTimeMs != null ? Math.max(0, closeTimeMs - nowMs) : null;
    var secsLeft = msLeft != null ? msLeft / 1000 : null;
    var minsLeft = msLeft != null ? msLeft / 60000 : null;
    var predictionTs = pred && (pred.ts || pred.timestamp) ? Number(pred.ts || pred.timestamp) : null;
    var predictionAgeMs = Number.isFinite(predictionTs) ? Math.max(0, nowMs - predictionTs) : null;
    var marketAgeMs = null;
    try {
      var marketStatus = window.PredictionMarkets && window.PredictionMarkets.getStatus
        ? window.PredictionMarkets.getStatus()
        : null;
      marketAgeMs = Number.isFinite(Number(marketStatus && marketStatus.age))
        ? Math.max(0, Number(marketStatus.age))
        : null;
    } catch (_) {}
    var transportMode = null;
    try {
      var transport = window.NetworkHealth && window.NetworkHealth.getTransport
        ? window.NetworkHealth.getTransport()
        : null;
      transportMode = (k15 && k15._liveTransport) || transport?.preferred?.kalshi || null;
    } catch (_) {}
    var schedulerCooldownRemainingMs = 0;
    var schedulerCircuitRemainingMs = 0;
    try {
      var schedulerProviders = window._signalScheduler && window._signalScheduler.getHealthStatus
        ? window._signalScheduler.getHealthStatus().providers
        : null;
      var kalshiScheduler = schedulerProviders && schedulerProviders.kalshi ? schedulerProviders.kalshi : null;
      if (kalshiScheduler) {
        schedulerCooldownRemainingMs = Math.max(0, (Number(kalshiScheduler.cooldownUntil) || 0) - nowMs);
        schedulerCircuitRemainingMs = Math.max(0, (Number(kalshiScheduler.circuitUntil) || 0) - nowMs);
      }
    } catch (_) {}
    var is15mTicker = !k15 || !k15.ticker || /15M/i.test(String(k15.ticker));
    var hasValid15mWindow = Number.isFinite(secsLeft) && secsLeft > 0 && secsLeft <= MAX_SECONDS_LEFT;
    pruneContractState(nowMs);
    var tooLate = msLeft != null && msLeft < MIN_SECONDS_LEFT * 1000;
    var tooEarly = secsLeft != null && secsLeft > ((15 * 60) - OPEN_WINDOW_GUARD_SECS);
    var stalePrediction = Number.isFinite(predictionAgeMs) && predictionAgeMs > PREDICTION_STALE_WARN_MS;
    var staleMarket = Number.isFinite(marketAgeMs) && marketAgeMs > MARKET_STALE_WARN_MS;
    var lastCall = msLeft != null && msLeft <= LAST_CALL_MS;
    var stageDiagnostics = {
      stages: [],
      suppressionReasons: [],
      tunedRecovery: null,
      timing: {
        predictionAgeMs: predictionAgeMs,
        marketAgeMs: marketAgeMs,
        schedulerCooldownRemainingMs: schedulerCooldownRemainingMs,
        schedulerCircuitRemainingMs: schedulerCircuitRemainingMs,
        transportMode: transportMode,
      },
    };
    function pushSuppression(reason) {
      if (!reason) return;
      if (stageDiagnostics.suppressionReasons.indexOf(reason) === -1) stageDiagnostics.suppressionReasons.push(reason);
    }
    function addStage(name, passed, checks, failures) {
      var normalizedFailures = Array.isArray(failures) ? failures.filter(Boolean) : [];
      normalizedFailures.forEach(pushSuppression);
      stageDiagnostics.stages.push({
        name: name,
        passed: !!passed,
        checks: checks || {},
        failures: normalizedFailures,
      });
    }
    function withStageDiagnostics(outcome) {
      if (!outcome || typeof outcome !== 'object') return outcome;
      outcome.stageDiagnostics = stageDiagnostics;
      return outcome;
    }
    addStage('model_input', modelActive, {
      modelActive: modelActive,
      modelHardVeto: modelHardVeto,
      modelSoftVeto: modelSoftVeto,
      modelScore: Number.isFinite(modelScore) ? parseFloat(modelScore.toFixed(4)) : null,
      finalModelConfidence: calibratedConfidence,
      scoreActive: scoreActive,
      cdfActive: cdfActive,
      confidenceActive: confidenceActive,
      predictionAgeMs: predictionAgeMs,
      stalePrediction: stalePrediction,
      signalGate: signalGate ? {
        passed: !!signalGate.passed,
        gated: !!signalGate.gated,
        quality: signalGate.quality || null,
        label: signalGate.label || null,
      } : null,
    }, (modelHardVeto ? ['hard veto' + (modelVetoReason ? ': ' + modelVetoReason : '')] : [])
      .concat(signalGateBlocked
        ? signalGateReasons.slice(0, 3).map(function (reason) { return 'signal gate: ' + reason; })
        : [])
      .concat(hasBinaryCdf && !cdfActive ? ['15m binary CDF neutral (' + Math.round(modelYesProb * 100) + '% YES)'] : [])
      .concat(stalePrediction ? ['prediction stale ' + Math.round(predictionAgeMs / 1000) + 's'] : []));
    addStage('market_window', !tooLate && (!kalshiActive || hasValid15mWindow), {
      kalshiActive: kalshiActive,
      hasValid15mWindow: hasValid15mWindow,
      is15mTicker: is15mTicker,
      tooLate: tooLate,
      tooEarly: tooEarly,
      secsLeft: secsLeft != null ? parseFloat(secsLeft.toFixed(1)) : null,
      marketAgeMs: marketAgeMs,
      staleMarket: staleMarket,
      transportMode: transportMode,
      openWindowGuardSecs: OPEN_WINDOW_GUARD_SECS,
      schedulerCooldownRemainingMs: schedulerCooldownRemainingMs,
      schedulerCircuitRemainingMs: schedulerCircuitRemainingMs,
    }, [
      (kalshiActive && (!is15mTicker || !hasValid15mWindow))
        ? ('window mismatch: ticker=' + (k15 && k15.ticker ? k15.ticker : 'n/a')
          + ', secsLeft=' + (secsLeft != null ? Math.round(secsLeft) : 'n/a'))
        : null,
      tooLate ? ('settlement < ' + MIN_SECONDS_LEFT + 's') : null,
      tooEarly ? ('open-window guard (' + OPEN_WINDOW_GUARD_SECS + 's)') : null,
      staleMarket ? ('market snapshot stale ' + Math.round(marketAgeMs / 1000) + 's') : null,
    ]);
    var vetoSt = window.ShellRouter && window.ShellRouter.getVetoState && window.ShellRouter.getVetoState(sym);
    if (vetoSt && vetoSt.phase === 'evaluating') {
      addStage('shell_guard', false, {
        shellPhase: 'evaluating',
        evalTick: vetoSt.evalTick || null,
      }, ['shell wall evaluating']);
      return withStageDiagnostics({
        sym: sym, action: 'hold', side: null, direction: null, alignment: 'SHELL_EVAL',
        confidence: 0, msLeft: msLeft ? Math.round(msLeft) : null, secsLeft: secsLeft ? parseFloat(secsLeft.toFixed(1)) : null,
        minsLeft: minsLeft, lastCall: lastCall, closeTimeMs: closeTimeMs, closeTime: k15 ? k15.closeTime : null,
        contractTicker: k15 ? k15.ticker : null,
        reason: 'Shell wall evaluating (' + (vetoSt.evalTick || '?') + '/3) — data collection'
      });
    }
    if (vetoSt && vetoSt.phase === 'confirmed')
      return withStageDiagnostics(_earlyExit(sym, k15, msLeft, secsLeft, minsLeft, lastCall, 'Shell wall confirmed — stand aside'));
    var earlyExit = pred && pred.diagnostics && pred.diagnostics.earlyExit;
    if (modelHardVeto && (!kalshiActive || kalshiDirHint === null)) {
      addStage('decision_route', false, {
        earlyExit: false,
        kalshiIndependentEdge: !!(kalshiActive && kalshiDirHint !== null),
      }, ['model veto with no independent market edge']);
      return withStageDiagnostics(_skip(sym, 'Model vetoed' + (modelVetoReason ? ' — ' + modelVetoReason : '') + '; no independent market edge'));
    }
    if (!kalshiActive && !modelActive)
      return withStageDiagnostics(_skip(sym, 'No signal — score ' + modelScore.toFixed(3) + ', no Kalshi data'));
    if (kalshiActive && (!is15mTicker || !hasValid15mWindow))
      return withStageDiagnostics(_skip(sym, 'Invalid contract window for 15m execution'));
    if (tooLate)
      return withStageDiagnostics(_skip(sym, 'Settlement < ' + MIN_SECONDS_LEFT + 's — too late to fill'));
    if (earlyExit)
      return withStageDiagnostics(_earlyExit(sym, k15, msLeft, secsLeft, minsLeft, lastCall));
    var direction, alignment;
    if (kalshiActive && modelActive) {
      var sameDir = (modelBullish && kalshiBullish) || (!modelBullish && kalshiBearish);
      if (sameDir) { direction = modelDir; alignment = 'ALIGNED'; }
      else if (kalshiNeutral) { direction = modelDir; alignment = 'MODEL_LEADS'; }
      else { direction = modelDir; alignment = 'DIVERGENT'; }
    } else if (modelActive) {
      direction = modelDir; alignment = 'MODEL_ONLY';
    } else {
      if (kalshiNeutral)
        return _skip(sym, (modelVetoed
          ? 'Model vetoed' + (modelVetoReason ? ' — ' + modelVetoReason : '')
          : 'Kalshi ~50/50, model below threshold (' + modelScore.toFixed(3) + ')'));
      direction = kalshiYesPrice >= 0.5 ? dirs.yesDir : dirs.noDir;
      alignment = 'KALSHI_ONLY';
    }
    var regimeTag = extractRegimeTag(pred, cfm);
    var currentMispricing = Number.isFinite(modelYesProb) && Number.isFinite(kalshiYesPrice)
      ? Math.abs(modelYesProb - kalshiYesPrice)
      : 0;
    var mctsState = buildMctsState(sym, pred, cfm, {
      modelProbUp: modelProbUp,
      modelScore: modelScore,
      calibratedConfidence: calibratedConfidence,
      mispricing: currentMispricing,
      secsLeft: secsLeft,
      liquidity: k15 ? k15.liquidity : null,
      regimeTag: regimeTag,
      currentDirection: direction,
    });
    var mctsResult = runVanillaMcts(mctsState, {
      simulations: MCTS_SIMULATIONS,
      depth: MCTS_DEPTH,
      exploration: MCTS_EXPLORATION,
    });
    var mctsVoteDirection = mctsResult && mctsResult.ran
      ? (mctsResult.voteAction === 'UP' ? 'UP' : (mctsResult.voteAction === 'DOWN' ? 'DOWN' : null))
      : null;
    var mctsDirectionOverrode = false;
    if (
      mctsVoteDirection
      && direction
      && mctsVoteDirection !== direction
      && mctsResult.voteStrength >= MCTS_DIRECTION_OVERRIDE_MIN_GAP
      && !modelHardVeto
      && false  // DISABLED: MCTS must not override raw model direction
      && (alignment !== 'KALSHI_ONLY' || mctsResult.voteStrength >= (MCTS_DIRECTION_OVERRIDE_MIN_GAP * 1.5))
      && alignment !== 'EARLY_EXIT'
    ) {
      direction = mctsVoteDirection;
      alignment = 'MCTS_OVERRIDE';
      mctsDirectionOverrode = true;
    }
    var entryYes = kalshiYesPrice !== null ? analyseEntry('YES', modelYesProb, kalshiYesPrice) : null;
    var entryNo = kalshiYesPrice !== null ? analyseEntry('NO', modelYesProb, kalshiYesPrice) : null;
    var side = direction === dirs.yesDir ? 'YES' : 'NO';
    var entry = side === 'YES' ? entryYes : side === 'NO' ? entryNo : null;
    var mStr = clamp(Math.abs(modelScore), 0, 1);
    var eBoost = entry ? clamp(Math.abs(entry.edgeCents) / 60, 0, 0.25) : 0;
    var mctsDirectionalBias = 0;
    if (mctsResult && mctsResult.ran) {
      if (direction === 'UP') mctsDirectionalBias = mctsResult.upScore - Math.max(mctsResult.downScore, mctsResult.waitScore);
      else if (direction === 'DOWN') mctsDirectionalBias = mctsResult.downScore - Math.max(mctsResult.upScore, mctsResult.waitScore);
      else mctsDirectionalBias = mctsResult.waitScore - Math.max(mctsResult.upScore, mctsResult.downScore);
    }
    var mctsConfidenceModifier = Math.round(clamp(mctsDirectionalBias * MCTS_CONFIDENCE_MOD_MAX, -MCTS_CONFIDENCE_MOD_MAX, MCTS_CONFIDENCE_MOD_MAX));
    var baseConfidence = Math.round(clamp((mStr + eBoost) * 75, 0, 99));
    // Meta-label from live xAI Grok (window._grokLive, refreshed by quant-layer ~60s)
    // ALWAYS_TRADE still fires; Grok conf only scales confidence for sizing / ranking.
    var grokMod = 0;
    var grokLive = null;
    try {
      grokLive = (typeof window !== 'undefined' && window._grokLive && window._grokLive[sym]) || null;
      if (grokLive && (Date.now() - Number(grokLive.ts || 0)) < 5 * 60_000) {
        var gc = Number(grokLive.confidence);
        if (Number.isFinite(gc)) {
          if (gc <= 1) gc = gc * 100;
          // Map Grok 0–100 → −8…+12 confidence points
          grokMod = Math.round(clamp((gc - 50) * 0.24, -8, 12));
        }
      }
    } catch (_) { grokLive = null; }
    // On-chain side-scan size mult (BTC/ETH/SOL): agree with lean → boost conf, disagree → cut
    var chainSizeMult = 1.0;
    var chainLean = null;
    try {
      if (typeof window !== 'undefined' && window.OnChainFlow
          && ['BTC', 'ETH', 'SOL'].indexOf(String(sym || '').toUpperCase()) >= 0) {
        var modelDirForChain = direction || (Number.isFinite(modelScore) && modelScore !== 0
          ? (modelScore >= 0 ? 'UP' : 'DOWN') : null);
        if (typeof window.OnChainFlow.sizeMultiplier === 'function') {
          chainSizeMult = Number(window.OnChainFlow.sizeMultiplier(sym, modelDirForChain)) || 1.0;
        }
        if (typeof window.OnChainFlow.lean === 'function') {
          chainLean = window.OnChainFlow.lean(sym);
        }
      }
    } catch (_) { chainSizeMult = 1.0; }
    // Map size mult 0.5–1.5 → confidence delta about −12…+10 (ALWAYS_TRADE still fires)
    var chainConfMod = Math.round(clamp((chainSizeMult - 1) * 20, -12, 10));
    var confidence = Math.round(clamp(baseConfidence + mctsConfidenceModifier + grokMod + chainConfMod, 0, 99));
    var alwaysTrade = !!(typeof window !== 'undefined' && window.ALWAYS_TRADE_MODE);
    // ALWAYS_TRADE: if no model dir, still pick Kalshi lean or score sign
    if (!direction || direction === 'FLAT') {
      if (kalshiYesPrice != null) {
        direction = kalshiYesPrice >= 0.5 ? dirs.yesDir : dirs.noDir;
        alignment = alignment || 'KALSHI_FORCE';
      } else if (Number.isFinite(modelScore) && modelScore !== 0) {
        direction = modelScore >= 0 ? 'UP' : 'DOWN';
        alignment = alignment || 'MODEL_FORCE';
      } else {
        direction = 'UP';
        alignment = alignment || 'DEFAULT_UP';
      }
      side = direction === dirs.yesDir ? 'YES' : 'NO';
      entry = side === 'YES' ? entryYes : entryNo;
    }
    var action;
    if (alwaysTrade && direction) {
      action = 'trade';
    } else if (alignment === 'KALSHI_ONLY') action = 'watch';
    else if (!entry || entry.edgeCents < EDGE_MIN_CENTS) action = (entry && entry.edgeCents < 0) ? 'skip' : 'watch';
    else action = modelActive ? 'trade' : 'watch';
    var payoutNotPrime = !!(entry && (
      entry.entryPrice > PRIME_PAYOUT_MAX_ENTRY_PRICE
      || currentMispricing < PRIME_PAYOUT_MIN_MISPRICING
    ));
    // ALWAYS_TRADE: do not demote trade→watch for "non-prime" payout
    if (action === 'trade' && payoutNotPrime && !alwaysTrade) action = 'watch';
    var waitGuardThreshold = computeWaitGuardThreshold({
      sym: sym,
      regimeTag: regimeTag,
      calibratedConfidence: calibratedConfidence,
      mctsResult: mctsResult,
    });
    var finalConfidenceFloor = alignment === 'ALIGNED'
      ? FINAL_MODEL_CONF_MIN_TRADE
      : FINAL_MODEL_CONF_MIN_NONALIGNED_TRADE;
    if (
      (String(sym || '').toUpperCase() === 'BTC' || String(sym || '').toUpperCase() === 'ETH')
      && (normalizeRegimeTag(regimeTag) === 'trending' || normalizeRegimeTag(regimeTag) === 'mixed')
      && mctsResult && mctsResult.ran && mctsResult.voteAction !== 'WAIT'
      && mctsResult.voteStrength >= MCTS_DIRECTION_OVERRIDE_MIN_GAP
    ) {
      finalConfidenceFloor = Math.max(8, finalConfidenceFloor - 2);
    }
    var finalConfidenceWeak = calibratedConfidence != null && calibratedConfidence < finalConfidenceFloor;
    if (action === 'trade' && finalConfidenceWeak && !alwaysTrade) action = 'watch';
    var openWindowBypassed = false;
    var openWindowBlocked = false;
    if (tooEarly && action === 'trade' && !alwaysTrade) {
      openWindowBypassed = shouldBypassOpenWindowGuard({
        sym: sym,
        regimeTag: regimeTag,
        calibratedConfidence: calibratedConfidence,
        edgeCents: entry && entry.edgeCents,
        mispricing: currentMispricing,
        mctsResult: mctsResult,
      });
      if (!openWindowBypassed) {
        action = 'watch';
        openWindowBlocked = true;
      }
    } else if (tooEarly && alwaysTrade) {
      openWindowBypassed = true;
    }
    // Final always-trade force: never leave a live contract as pure watch/skip if we have a side
    if (alwaysTrade && direction && action !== 'trade' && !tooLate) {
      action = 'trade';
    }
    var symNorm = String(sym || '').toUpperCase();
    var logTunedDowngradeReason = null;
    if (
      action === 'trade'
      && symNorm !== 'BTC'
      && alignment !== 'ALIGNED'
      && entry
      && Number.isFinite(entry.edgeCents)
      && entry.edgeCents >= LOG_TUNED_HIGH_EDGE_RISK_CENTS
      && currentMispricing < 0.10
      && (!Number.isFinite(calibratedConfidence) || calibratedConfidence < 18)
    ) {
      logTunedDowngradeReason = 'non-BTC non-aligned high-edge segment';
    } else if (
      action === 'trade'
      && symNorm !== 'BTC'
      && alignment === 'DIVERGENT'
      && Number.isFinite(kalshiYesPrice)
      && kalshiYesPrice >= LOG_TUNED_DIVERGENT_YES_RISK_MIN
      && kalshiYesPrice < LOG_TUNED_DIVERGENT_YES_RISK_MAX
      && currentMispricing < 0.12
      && (!Number.isFinite(calibratedConfidence) || calibratedConfidence < 18)
    ) {
      logTunedDowngradeReason = 'non-BTC divergent 55-69% YES segment';
    }
    if (logTunedDowngradeReason) action = 'watch';
    var softVetoDowngradeReason = null;
    if (
      action === 'trade'
      && modelSoftVeto
      && entry
      && Number.isFinite(entry.edgeCents)
      && entry.edgeCents < (EDGE_MIN_CENTS + 2)
    ) {
      softVetoDowngradeReason = 'soft veto + marginal edge';
      action = 'watch';
    }
    var timingDowngradeReason = logTunedDowngradeReason || softVetoDowngradeReason;
    var timingProfile = buildAdaptiveTimingRegime({
      sym: sym,
      secsLeft: secsLeft,
      entry: entry,
      pred: pred,
      cfm: cfm,
      direction: direction,
      modelActive: modelActive,
      modelYesProb: modelYesProb,
      kalshiYesPrice: kalshiYesPrice,
      liquidity: k15 ? k15.liquidity : null,
      finalConfidenceWeak: finalConfidenceWeak,
      logTunedDowngradeReason: timingDowngradeReason,
    });
    addStage('orchestrator_base', action === 'trade', {
      alignment: alignment,
      action: action,
      edgeCents: entry && Number.isFinite(entry.edgeCents) ? entry.edgeCents : null,
      finalConfidenceFloor: finalConfidenceFloor,
      finalConfidenceWeak: finalConfidenceWeak,
      baseConfidence: baseConfidence,
      confidence: confidence,
      payoutNotPrime: payoutNotPrime,
      entryPrice: entry && Number.isFinite(entry.entryPrice) ? entry.entryPrice : null,
      minMispricing: PRIME_PAYOUT_MIN_MISPRICING,
      maxEntryPrice: PRIME_PAYOUT_MAX_ENTRY_PRICE,
      regimeTag: regimeTag,
      mctsVote: mctsResult && mctsResult.ran ? mctsResult.voteAction : null,
      mctsVoteStrength: mctsResult && mctsResult.ran ? mctsResult.voteStrength : null,
      mctsConfidenceModifier: mctsConfidenceModifier,
      logTunedDowngradeReason: logTunedDowngradeReason || null,
      softVetoDowngradeReason: softVetoDowngradeReason || null,
    }, [
      finalConfidenceWeak ? 'final confidence floor' : null,
      payoutNotPrime ? 'payout not prime' : null,
      logTunedDowngradeReason,
      softVetoDowngradeReason,
      openWindowBlocked ? ('open-window guard (' + OPEN_WINDOW_GUARD_SECS + 's)') : null,
      (!entry || (entry && entry.edgeCents < EDGE_MIN_CENTS)) ? ('edge below +' + EDGE_MIN_CENTS + 'c') : null,
    ]);
    if (action !== 'skip' && timingProfile.promoteToTrade) {
      action = 'trade';
    } else if (action === 'trade' && timingProfile.phase === 'SETTLING') {
      action = 'watch';
    }
    var exceptionalRecoveryCleared = [];
    var mispricing = Number.isFinite(modelYesProb) && Number.isFinite(kalshiYesPrice)
      ? Math.abs(modelYesProb - kalshiYesPrice)
      : 0;
    var canRecoverWithTiming = action !== 'trade'
      && modelActive
      && Number.isFinite(timingProfile.timingScore)
      && timingProfile.phase !== 'SETTLING'
      && timingProfile.timingScore >= Math.min(waitGuardThreshold, EXCEPTIONAL_RECOVERY_TIMING_SCORE)
      && entry
      && Number.isFinite(entry.edgeCents)
      && entry.edgeCents >= EXCEPTIONAL_RECOVERY_EDGE_CENTS
      && mispricing >= EXCEPTIONAL_RECOVERY_MISPRICING
      && !modelHardVeto
      && !signalGateBlocked
      && !tooLate;
    if (canRecoverWithTiming) {
      if (logTunedDowngradeReason) {
        exceptionalRecoveryCleared.push(logTunedDowngradeReason);
        logTunedDowngradeReason = null;
      }
      if (softVetoDowngradeReason) {
        exceptionalRecoveryCleared.push(softVetoDowngradeReason);
        softVetoDowngradeReason = null;
      }
      if (finalConfidenceWeak && calibratedConfidence != null && calibratedConfidence >= (finalConfidenceFloor - 2)) {
        exceptionalRecoveryCleared.push('final confidence floor');
        finalConfidenceWeak = false;
      }
      if (exceptionalRecoveryCleared.length) {
        action = 'trade';
      }
    }
    var filteredTimingBlocks = timingProfile && Array.isArray(timingProfile.blocks)
      ? timingProfile.blocks.slice()
      : [];
    if (exceptionalRecoveryCleared.length) {
      filteredTimingBlocks = filteredTimingBlocks.filter(function (reason) {
        if (!reason) return false;
        if (reason === 'final model confidence weak') return false;
        return exceptionalRecoveryCleared.indexOf(reason) === -1;
      });
      stageDiagnostics.tunedRecovery = {
        activated: true,
        timingScore: timingProfile.timingScore,
        edgeCents: entry && Number.isFinite(entry.edgeCents) ? entry.edgeCents : null,
        mispricing: parseFloat(mispricing.toFixed(4)),
        cleared: exceptionalRecoveryCleared.slice(),
      };
    }
    addStage('timing_regime', action === 'trade' || timingProfile.promoteToTrade, {
      phase: timingProfile.phase,
      timingLabel: timingProfile.timingLabel,
      timingScore: timingProfile.timingScore,
      waitGuardThreshold: waitGuardThreshold,
      promoteToTrade: timingProfile.promoteToTrade,
      closeValueQualified: timingProfile.closeValueQualified,
      scalpQualified: timingProfile.scalpQualified,
      finalSnipeQualified: timingProfile.finalSnipeQualified,
      tunedRecovery: stageDiagnostics.tunedRecovery,
    }, filteredTimingBlocks.slice(0, 4));
    if (action === 'skip')
      return withStageDiagnostics(_skip(sym, 'Negative EV — edge ' + (entry ? entry.edgeCents : 0) + 'c (need >=' + EDGE_MIN_CENTS + 'c)', { side: side, direction: direction, alignment: alignment, edgeCents: entry ? entry.edgeCents : null }));

    // Tier 1: Sweet spot window (3–6 min left, payout >= 1.65x)
    var payout = entry ? entry.payoutMult : null;
    var sweetSpot = secsLeft != null && secsLeft >= SWEET_MIN_SECS && secsLeft <= SWEET_MAX_SECS
      && payout != null && payout >= SWEET_PAYOUT_MIN
      && action === 'trade';
    var kPct = kalshiYesPrice != null ? 'Kalshi ' + Math.round(kalshiYesPrice * 100) + '% YES' : '';
    var mPct = 'model ' + Math.round(modelYesProb * 100) + '% YES';
    var edgeStr = entry ? ((entry.edgeCents >= 0 ? '+' : '') + entry.edgeCents + 'c/contract') : '';
    var confidenceTail = finalConfidenceWeak
      ? ' · downgraded to watch: final model confidence ' + calibratedConfidence + '% < ' + finalConfidenceFloor + '%'
      : '';
    var logTunedTail = logTunedDowngradeReason
      ? ' · downgraded to watch: ' + logTunedDowngradeReason
      : '';
    var softVetoTail = softVetoDowngradeReason
      ? ' · downgraded to watch: ' + softVetoDowngradeReason
      : (modelSoftVeto ? ' · model caution: ' + (modelVetoReason || 'soft veto') : '');
    var timingTail = timingProfile && timingProfile.promoteToTrade
      ? ' · timing regime: ' + timingProfile.timingLabel + ' (' + timingProfile.reasons.join(', ') + ')'
      : (timingProfile && filteredTimingBlocks.length && action !== 'trade'
        ? ' · timing watch: ' + filteredTimingBlocks.slice(0, 2).join(', ')
        : '');
    var reasonMap = {
      ALIGNED: sym + ' ' + direction + ': ' + kPct + ' + ' + mPct + ' -> ' + edgeStr,
      DIVERGENT: sym + ': ' + mPct + ' vs ' + kPct + ' -> INVERSION — buy ' + side + ' cheap, house is wrong — ' + edgeStr,
      MODEL_LEADS: sym + ' ' + direction + ': ' + mPct + ' (Kalshi ~50/50, model ahead) -> ' + edgeStr,
      MODEL_ONLY: sym + ' ' + direction + ': ' + mPct + ' (no Kalshi data)',
      MCTS_OVERRIDE: sym + ' ' + direction + ': MCTS override (' + (mctsResult && mctsResult.ran ? mctsResult.voteAction : '?')
        + ', score ' + (mctsResult && mctsResult.ran ? mctsResult.voteStrength.toFixed(3) : 'n/a') + ') -> ' + edgeStr,
      KALSHI_ONLY: sym + ' ' + direction + ': ' + kPct + ' (' + (modelVetoed
        ? 'model vetoed' + (modelVetoReason ? ' — ' + modelVetoReason : '')
        : 'model score ' + modelScore.toFixed(3) + ' below threshold') + ')',
    };
    Object.keys(reasonMap).forEach(function (key) {
      if (key !== 'KALSHI_ONLY' && confidenceTail) reasonMap[key] += confidenceTail;
      if (key !== 'KALSHI_ONLY' && logTunedTail) reasonMap[key] += logTunedTail;
      if (key !== 'KALSHI_ONLY' && softVetoTail) reasonMap[key] += softVetoTail;
      if (key !== 'KALSHI_ONLY' && timingTail) reasonMap[key] += timingTail;
    });
    var blockedBy = [];
    if (modelHardVeto) blockedBy.push('hard veto' + (modelVetoReason ? ': ' + modelVetoReason : ''));
    else if (modelSoftVeto) blockedBy.push('soft veto' + (modelVetoReason ? ': ' + modelVetoReason : ''));
    if (signalGateBlocked) {
      blockedBy.push('signal gate' + (signalGateReasons.length ? ': ' + signalGateReasons.slice(0, 2).join(', ') : ''));
    }
    if (hasBinaryCdf && !cdfActive) blockedBy.push('15m binary CDF neutral');
    if (payoutNotPrime) {
      blockedBy.push(
        'payout not prime'
        + (entry && Number.isFinite(entry.entryPrice) ? ': entry ' + Math.round(entry.entryPrice * 100) + 'c' : '')
        + (Number.isFinite(currentMispricing) ? ', mispricing ' + Math.round(currentMispricing * 100) + 'pp' : '')
      );
    }
    if (finalConfidenceWeak) blockedBy.push('final confidence floor');
    if (logTunedDowngradeReason) blockedBy.push(logTunedDowngradeReason);
    if (softVetoDowngradeReason) blockedBy.push(softVetoDowngradeReason);
    if (openWindowBlocked) blockedBy.push('open-window guard (' + OPEN_WINDOW_GUARD_SECS + 's)');
    if (stalePrediction) blockedBy.push('prediction stale ' + Math.round(predictionAgeMs / 1000) + 's');
    if (staleMarket) blockedBy.push('market stale ' + Math.round(marketAgeMs / 1000) + 's');
    if (schedulerCooldownRemainingMs > 0) blockedBy.push('scheduler cooldown ' + Math.ceil(schedulerCooldownRemainingMs / 1000) + 's');
    if (schedulerCircuitRemainingMs > 0) blockedBy.push('scheduler circuit ' + Math.ceil(schedulerCircuitRemainingMs / 1000) + 's');
    if (timingProfile && filteredTimingBlocks.length) {
      blockedBy = blockedBy.concat(filteredTimingBlocks.slice(0, 3));
    }
    var timingScoreBelowGate = Number.isFinite(timingProfile && timingProfile.timingScore)
      && timingProfile.timingScore < waitGuardThreshold;
    var waitGuardBlocked = signalGateBlocked || (action === 'trade' && (
      timingScoreBelowGate
      || stalePrediction
      || staleMarket
      || schedulerCooldownRemainingMs > 0
      || schedulerCircuitRemainingMs > 0
    ));
    if (action === 'trade' && waitGuardBlocked) action = 'watch';
    var waitGuardDiagnostics = {
      blocked: waitGuardBlocked,
      threshold: waitGuardThreshold,
      timingScoreBelowGate: timingScoreBelowGate,
      confidence: calibratedConfidence,
      regime: regimeTag,
      openWindowBlocked: openWindowBlocked,
      openWindowBypassed: openWindowBypassed,
      mctsVote: mctsResult && mctsResult.ran ? mctsResult.voteAction : null,
      mctsVoteStrength: mctsResult && mctsResult.ran ? mctsResult.voteStrength : null,
      mctsConfidenceModifier: mctsConfidenceModifier,
    };
    if (waitGuardBlocked) {
      blockedBy.push(
        signalGateBlocked
          ? 'wait-guard: signal quality blocked'
          : 'wait-guard threshold '
            + waitGuardThreshold
            + ' (timing ' + (Number.isFinite(timingProfile && timingProfile.timingScore) ? timingProfile.timingScore : 'n/a')
            + ', conf ' + (Number.isFinite(calibratedConfidence) ? calibratedConfidence : 'n/a')
            + ', regime ' + String(regimeTag || 'mixed')
            + ', mcts ' + (waitGuardDiagnostics.mctsVote || 'n/a')
            + '/' + (Number.isFinite(waitGuardDiagnostics.mctsVoteStrength) ? waitGuardDiagnostics.mctsVoteStrength.toFixed(3) : 'n/a')
            + ')'
      );
    }
    addStage('wait_guard', !waitGuardBlocked, {
      blocked: waitGuardBlocked,
      threshold: waitGuardThreshold,
      timingScore: Number.isFinite(timingProfile && timingProfile.timingScore) ? timingProfile.timingScore : null,
      confidence: calibratedConfidence,
      regimeTag: regimeTag,
      openWindowBlocked: openWindowBlocked,
      openWindowBypassed: openWindowBypassed,
      mctsVote: waitGuardDiagnostics.mctsVote,
      mctsVoteStrength: waitGuardDiagnostics.mctsVoteStrength,
      mctsConfidenceModifier: mctsConfidenceModifier,
    }, waitGuardBlocked ? [blockedBy[blockedBy.length - 1]] : []);
    addStage('final_action', action === 'trade', {
      action: action,
      alignment: alignment,
      side: side,
      blockedBy: blockedBy.slice(0, 4),
    }, action === 'trade' ? [] : blockedBy.slice(0, 4));
    var strikeStr = null;
    if (k15 && k15.ticker) {
      var tm = k15.ticker.match(/T(\d+(?:\.\d+)?)$/);
      if (tm) strikeStr = 'T' + Number(tm[1]).toLocaleString();
    }
    var result = {
      sym: sym, contractTicker: k15 ? k15.ticker : null, strikeStr: strikeStr,
      side: side, direction: direction, alignment: alignment, action: action, confidence: confidence,
      baseConfidence: baseConfidence,
      finalModelConfidence: calibratedConfidence,
      modelVetoed: modelVetoed,
      modelVetoSeverity: modelVetoSeverity || (modelHardVeto ? 'hard' : (modelSoftVeto ? 'soft' : 'none')),
      modelHardVeto: modelHardVeto,
      modelSoftVeto: modelSoftVeto,
      modelVetoReason: modelVetoReason || null,
      signalGateBlocked: signalGateBlocked,
      binaryCdfActive: cdfActive,
      binaryCdfThresholds: { yes: BINARY_CDF_YES_THRESHOLD, no: BINARY_CDF_NO_THRESHOLD },
      modelScore: modelScore, modelProbUp: parseFloat(modelProbUp.toFixed(4)),
      modelProbYes: parseFloat(modelYesProb.toFixed(4)),
      kalshiYesPrice: kalshiYesPrice, kalshiActive: kalshiActive,
      predictionTs: predictionTs,
      predictionAgeMs: predictionAgeMs,
      marketAgeMs: marketAgeMs,
      transportMode: transportMode,
      schedulerCooldownRemainingMs: schedulerCooldownRemainingMs,
      schedulerCircuitRemainingMs: schedulerCircuitRemainingMs,
      closeTimeMs: closeTimeMs,
      msLeft: msLeft != null ? Math.round(msLeft) : null,
      secsLeft: secsLeft != null ? parseFloat(secsLeft.toFixed(1)) : null,
      minsLeft: minsLeft != null ? parseFloat(minsLeft.toFixed(3)) : null,
      minutesLeft: minsLeft,
      preferredHorizonMin: Number.isFinite(pred?.diagnostics?.preferredHorizon) ? pred.diagnostics.preferredHorizon : 15,
      lastCall: lastCall, tooEarly: tooEarly,
      targetPrice: k15 ? k15.targetPrice : null, targetPriceNum: k15 ? k15.targetPriceNum : null,
      liquidity: k15 ? k15.liquidity : 0, closeTime: k15 ? k15.closeTime : null,
      humanReason: reasonMap[alignment] || (sym + ' ' + direction),
      aiInferenceReason: pred?.llm?.notes || pred?.diagnostics?.llmNotes || null,
      aiInferenceProvider: pred?.llm?.provider || null,
      aiInferenceConfidence: Number.isFinite(pred?.llm?.confidence) ? pred.llm.confidence : (Number.isFinite(pred?.diagnostics?.llmConfidence) ? pred.diagnostics.llmConfidence : null),
      sweetSpot: sweetSpot,
      timingRegime: timingProfile.phase,
      timingLabel: timingProfile.timingLabel,
      timingScore: timingProfile.timingScore,
      timingReasons: timingProfile.reasons,
      timingBlocks: filteredTimingBlocks,
      closeValue: !!timingProfile.closeValueQualified,
      closeValueCandidate: !!timingProfile.closeValueCandidate,
      scalpFlip: !!timingProfile.scalpQualified,
      scalpCandidate: !!timingProfile.scalpCandidate,
      coreCloseValueWindow: !!timingProfile.coreCloseValueWindow,
      exitPlan: timingProfile.exitPlan,
      microFlowScore: timingProfile.flowScore,
      scalpSetupScore: timingProfile.scalpScore,
      microToxicity: timingProfile.toxicity,
      timingAdaptive: timingProfile.adaptiveTiming,
      missedOpportunityScore: action === 'watch' ? timingProfile.timingScore : 0,
      regimeTag: regimeTag,
      mcts: mctsResult && mctsResult.ran ? {
        ran: true,
        voteAction: mctsResult.voteAction,
        voteStrength: mctsResult.voteStrength,
        directionalGap: mctsResult.directionalGap,
        scores: { up: mctsResult.upScore, down: mctsResult.downScore, wait: mctsResult.waitScore },
        confidenceModifier: mctsConfidenceModifier,
        simulations: mctsResult.simulations,
        depth: mctsResult.depth,
        exploration: mctsResult.exploration,
        directionOverrode: mctsDirectionOverrode,
      } : {
        ran: false,
        reason: mctsResult && mctsResult.reason ? mctsResult.reason : 'unavailable',
      },
      waitGuardDiagnostics: waitGuardDiagnostics,
      logTunedDowngrade: !!logTunedDowngradeReason,
      logTunedDowngradeReason: logTunedDowngradeReason,
      softVetoDowngradeReason: softVetoDowngradeReason,
      blockedBy: blockedBy.filter(Boolean),
      stageDiagnostics: stageDiagnostics,
    };
    if (entry) Object.assign(result, entry);
    if (result.aiInferenceReason) {
      var horizonLabel = Number.isFinite(result.preferredHorizonMin) ? result.preferredHorizonMin + 'm' : '15m';
      var providerLabel = result.aiInferenceProvider ? String(result.aiInferenceProvider).toUpperCase() : 'AI';
      var aiTail = providerLabel + ' ' + horizonLabel
        + (Number.isFinite(result.aiInferenceConfidence) ? (' · ' + result.aiInferenceConfidence + '%') : '')
        + ' · ' + result.aiInferenceReason;
      result.humanReason = result.humanReason ? (result.humanReason + ' · ' + aiTail) : aiTail;
    }

    // --- WECRYPTO cross-chain orbital diagnostics (additive, never vetoes) ---
    try {
      var orbital = pred && pred.orbital;
      if (orbital && typeof orbital === 'object') {
        result.orbital = {
          asset: orbital.asset || sym,
          lambda: orbital.lambda,
          s: orbital.s,
          p: orbital.p,
          d: orbital.d,
          f: orbital.f,
          oeq: orbital.oeq,
          pDelta: orbital.pDelta,
          qsp: orbital.qsp || null,
          temporalEdge: orbital.temporalEdge || null,
          state: orbital.state,
          action: orbital.action,
          fadeDirection: orbital.fadeDirection,
          reason: orbital.reason,
        };

        var oeqStr = Number.isFinite(orbital.oeq) ? Number(orbital.oeq).toFixed(2) : 'n/a';
        var actionPretty = orbital.action === 'EXECUTE_COUNTER_TRADE'
          ? 'counter-trade (' + (orbital.fadeDirection || 'neutral') + ')'
          : orbital.action === 'EXECUTE_EXIT'
            ? 'exit (' + (orbital.state || 'hybrid') + ')'
            : (orbital.action || 'hold').toLowerCase();
        var qspMode = orbital.qsp && orbital.qsp.mode ? orbital.qsp.mode : null;
        var qspConf = (orbital.qsp && orbital.qsp.quantizer && Number.isFinite(orbital.qsp.quantizer.confidence))
          ? Number(orbital.qsp.quantizer.confidence).toFixed(2)
          : null;
        var qspStr = qspMode ? (' · qsp: ' + qspMode + (qspConf != null ? (' @' + qspConf) : '')) : '';
        var orbitalHint = 'Orbital ' + (orbital.state || 'idle') + ' · OEQ ' + oeqStr + qspStr + ' · action: ' + actionPretty;
        result.orbitalHint = orbitalHint;
        if (typeof result.humanReason === 'string' && result.humanReason.length) {
          result.humanReason = result.humanReason + ' · ' + orbitalHint;
        }

        // Build optional Kalshi V2 payload preview (gated by env; default dry-run).
        try {
          if (orbital.action === 'EXECUTE_COUNTER_TRADE' && window.KalshiV2Mapper) {
            var payload = window.KalshiV2Mapper.buildOrderPayload({
              ticker: result.contractTicker,
              pDelta: orbital.pDelta,
              count: Number.isFinite(result.contractQty) ? result.contractQty : 1,
              price: Number.isFinite(result.kalshiYesPrice) ? result.kalshiYesPrice : 0.5,
            });
            if (payload) {
              result.orbitalOrderPayload = payload;
              result.orbitalSubmitEnabled = !!window.KalshiV2Mapper.isSubmitEnabled();
            }
          }
        } catch (mapErr) {
          result.orbitalOrderPayload = null;
          result.orbitalMapperError = mapErr && mapErr.message ? mapErr.message : String(mapErr);
        }

        // Mirror to telemetry-dual-sink path if the desktop bridge exposes it.
        try {
          var bridge = (typeof window !== 'undefined') ? window.desktopApp : null;
          if (bridge && typeof bridge.telemetryRecord === 'function') {
            bridge.telemetryRecord({
              kind: 'orbital-intent',
              sym: sym,
              ts: Date.now(),
              orbital: result.orbital,
              payloadPresent: !!result.orbitalOrderPayload,
              submitEnabled: !!result.orbitalSubmitEnabled,
            });
          }
        } catch (_) {}
      }
    } catch (_) {}

    // --- Signal lock + crowd fade ---
    var lockKey = sym + '_' + (closeTimeMs || 'none');
    var lock = _locks[lockKey];
    var nowTs = Date.now();
    var fadeEval = evaluateCrowdFade({
      sym: sym,
      closeTimeMs: closeTimeMs,
      kalshiYesPrice: kalshiYesPrice,
      secsLeft: secsLeft,
      dirs: dirs,
      modelDir: modelDir,
      modelYesProb: modelYesProb,
      modelActive: modelActive,
      entryYes: entryYes,
      entryNo: entryNo,
      liquidity: k15 ? k15.liquidity : null,
      pred: pred,
      cfm: cfm,
    });

    if (
      fadeEval
      && fadeEval.confirmed
      && ENABLE_CROWD_FADE_OVERRIDE
      && !waitGuardBlocked
      && !signalGateBlocked
      && result.action === 'trade'
    ) {
      // Persistent, model-confirmed mispricing fade.
      result.direction = fadeEval.direction;
      result.side = fadeEval.side;
      result.action = 'trade';
      result.alignment = 'CROWD_FADE';
      result.crowdFade = true;
      result.crowdFadeAgeMs = fadeEval.ageMs;
      result.crowdFadeConfirmLeftSec = 0;
      result.crowdFadeMispricingPp = Math.round((fadeEval.mispricing || 0) * 100);
      result.crowdFadeTimingLabel = fadeEval.timingLabel || 'adaptive';
      result.crowdFadeWindowLabel = fadeEval.windowLabel || null;
      result.timingRegime = result.timingRegime || 'CROWD_FADE';
      result.timingLabel = 'CROWD FADE';
      result.exitPlan = 'Crowd-fade plan: sell when market reprices toward model or when book/tape stops confirming the fade.';
      if (fadeEval.entry) Object.assign(result, fadeEval.entry);
      result.humanReason = sym + ' CROWD FADE (' + (fadeEval.timingLabel || 'adaptive') +
        (fadeEval.windowLabel ? ', ' + fadeEval.windowLabel : '') + ') → ' + fadeEval.direction +
        ': model-vs-market gap ' + result.crowdFadeMispricingPp + 'pp, edge ' + (result.edgeCents || 0) + 'c';
      // include predTs to allow invalidation when a newer model prediction arrives
      _locks[lockKey] = { direction: fadeEval.direction, side: result.side, ts: nowTs, closeTimeMs: closeTimeMs, predTs: (pred && (pred.ts || pred.timestamp)) || nowTs };
    } else if (fadeEval && fadeEval.suggested) {
      // Candidate mispricing is building but not persistent enough yet.
      result.crowdFadeSuggested = true;
      result.crowdFade = false;
      result.crowdFadeAgeMs = fadeEval.ageMs;
      result.crowdFadeTimingLabel = fadeEval.timingLabel || 'adaptive';
      result.crowdFadeWindowLabel = fadeEval.windowLabel || null;
      var confirmLeft = Math.max(0, Math.ceil(((fadeEval.confirmMs || CROWD_FADE_CONFIRM_MAX_MS) - fadeEval.ageMs) / 1000));
      result.crowdFadeConfirmLeftSec = confirmLeft;
      result.crowdFadeMispricingPp = Math.round((fadeEval.mispricing || 0) * 100);
      result.humanReason += ' · crowd-fade setup ' + Math.round((fadeEval.mispricing || 0) * 100) +
        'pp/' + Math.round((fadeEval.minMispricing || CROWD_FADE_MIN_MISPRICE) * 100) + 'pp (' +
        (fadeEval.timingLabel || 'adaptive') + ', confirm ' + confirmLeft + 's)';
    } else if (result.action === 'trade' && !waitGuardBlocked && !signalGateBlocked) {
      // New trade signal — lock it
      _locks[lockKey] = { direction: result.direction, side: result.side, ts: nowTs, closeTimeMs: closeTimeMs, predTs: (pred && (pred.ts || pred.timestamp)) || nowTs };
    } else if (lock && lock.closeTimeMs === closeTimeMs && (nowTs - lock.ts) < LOCK_MS) {
      // Signal drifted off trade but lock is still fresh — hold it
      // However, invalidate the lock when a newer model prediction is present
      var latestPredTs = pred && (pred.ts || pred.timestamp) ? Number(pred.ts || pred.timestamp) : null;
      var lockInvalid = waitGuardBlocked || signalGateBlocked || modelHardVeto || stalePrediction || staleMarket || !modelActive;
      if (lockInvalid || (latestPredTs && lock.predTs && latestPredTs > lock.predTs)) {
        // Newer prediction arrived — drop stale lock
        delete _locks[lockKey];
      } else {
        var lockConflict = modelActive && modelDir && lock.direction && modelDir !== lock.direction;
        if (lockConflict) {
          delete _locks[lockKey];
        } else {
          result.direction = lock.direction;
          result.side = lock.side;
          result.action = 'trade';
          result.signalLocked = true;
          result.humanReason = sym + ' [LOCKED ' + Math.round((nowTs - lock.ts) / 1000) + 's ago] ' + lock.direction;
        }
      }
    }

    // Trigger audio alerts based on the synthesized result
    if (result.action === 'trade') {
      if (result.alignment === 'DIVERGENT' && !result.payoutNotPrime) {
        playAlert('DIVERGENT');
      } else if (result.alignment === 'ALIGNED' && !result.payoutNotPrime && result.payoutMult >= 1.5 && result.modelProbYes > 0.65) {
        playAlert('PRIME_OPPORTUNITY');
      }
    }

    return result;
  }

  function _skip(sym, reason, extra) {
    var res = { sym: sym, action: 'skip', side: null, direction: null, reason: reason, alignment: null, confidence: 0 };
    if (extra) {
      if (extra.side !== undefined) res.side = extra.side;
      if (extra.direction !== undefined) res.direction = extra.direction;
      if (extra.alignment !== undefined) res.alignment = extra.alignment;
      if (extra.edgeCents !== undefined && Number.isFinite(extra.edgeCents)) res.edgeCents = extra.edgeCents;
    }
    return res;
  }
  function _earlyExit(sym, k15, msLeft, secsLeft, minsLeft, lastCall, reason) {
    return {
      sym: sym, action: 'earlyExit', side: null, direction: null,
      alignment: 'EARLY_EXIT', confidence: 0,
      reason: reason || 'CFM Router early-exit signal',
      contractTicker: k15 ? k15.ticker : null,
      closeTimeMs: k15 && k15.closeTime ? new Date(k15.closeTime).getTime() : null,
      closeTime: k15 ? k15.closeTime : null,
      msLeft: msLeft != null ? Math.round(msLeft) : null,
      secsLeft: secsLeft != null ? parseFloat(secsLeft.toFixed(1)) : null,
      minsLeft: minsLeft, lastCall: lastCall
    };
  }

  function getActiveCoins() {
    var coins = (window.PREDICTION_COINS || []).map(function (coin) {
      return coin && coin.sym ? coin.sym : null;
    }).filter(Boolean);
    return coins.length ? coins : ['BTC', 'ETH', 'SOL', 'XRP'];
  }

  function resolveAll(predAll, cfmAll) {
    var COINS = getActiveCoins();
    var intents = {};
    COINS.forEach(function (sym) {
      try { intents[sym] = translate(sym, predAll && predAll[sym], cfmAll && cfmAll[sym]); }
      catch (e) { intents[sym] = _skip(sym, 'Error: ' + e.message); }
    });
    recordLiveCalibrationTelemetry(intents);
    return intents;
  }

  var _cache = {};
  var _liveCalibrationState = {
    events: [],
    lastFingerprintBySym: {},
  };
  function isCalibrationCoin(sym) {
    var s = String(sym || '').toUpperCase();
    return s === 'BTC' || s === 'ETH';
  }
  function _is15mIntent(intent) {
    var ticker = intent && intent.contractTicker ? String(intent.contractTicker) : '';
    return !ticker || /15M/i.test(ticker);
  }
  function _trimCalibrationEvents() {
    var cap = Math.max(40, LIVE_CALIBRATION_EVENT_WINDOW * 3);
    if (_liveCalibrationState.events.length > cap) {
      _liveCalibrationState.events = _liveCalibrationState.events.slice(-cap);
    }
  }
  function _calibrationFingerprint(intent) {
    return [
      intent && intent.contractTicker ? intent.contractTicker : 'na',
      intent && intent.action ? intent.action : 'na',
      intent && intent.direction ? intent.direction : 'na',
      intent && intent.alignment ? intent.alignment : 'na',
      intent && intent.waitGuardDiagnostics && intent.waitGuardDiagnostics.blocked ? 'wg1' : 'wg0',
      intent && intent.modelHardVeto ? 'hv1' : 'hv0',
      intent && intent.modelSoftVeto ? 'sv1' : 'sv0',
      intent && intent.stageDiagnostics && intent.stageDiagnostics.timing ? Math.round(Number(intent.stageDiagnostics.timing.predictionAgeMs || 0) / 20000) : 'pa0',
      intent && intent.stageDiagnostics && intent.stageDiagnostics.timing ? Math.round(Number(intent.stageDiagnostics.timing.marketAgeMs || 0) / 5000) : 'ma0',
      intent && intent.mcts && intent.mcts.directionOverrode ? 'mo1' : 'mo0',
    ].join('|');
  }
  function _isStaleDataBlocked(intent) {
    if (!intent || intent.action === 'trade') return false;
    var stalePrediction = Number.isFinite(Number(intent.predictionAgeMs)) && Number(intent.predictionAgeMs) > PREDICTION_STALE_WARN_MS;
    var staleMarket = Number.isFinite(Number(intent.marketAgeMs)) && Number(intent.marketAgeMs) > MARKET_STALE_WARN_MS;
    return stalePrediction || staleMarket;
  }
  function _isVetoBlocked(intent) {
    if (!intent || intent.action === 'trade') return false;
    return !!(intent.modelHardVeto || intent.modelSoftVeto);
  }
  function _isWaitGuardBlocked(intent) {
    return !!(intent && intent.waitGuardDiagnostics && intent.waitGuardDiagnostics.blocked);
  }
  function _isMctsOverrideUsed(intent) {
    return !!(intent && intent.mcts && intent.mcts.ran && intent.mcts.directionOverrode);
  }
  function _isExecutedDirectionalIntent(intent) {
    var dir = intent && intent.direction;
    return !!(intent && intent.action === 'trade' && (dir === 'UP' || dir === 'DOWN'));
  }
  function recordLiveCalibrationTelemetry(intents) {
    if (!intents || typeof intents !== 'object') return;
    var now = Date.now();
    Object.keys(intents).forEach(function (sym) {
      if (!isCalibrationCoin(sym)) return;
      var intent = intents[sym];
      if (!intent || !_is15mIntent(intent)) return;
      var fp = _calibrationFingerprint(intent);
      if (_liveCalibrationState.lastFingerprintBySym[sym] === fp) return;
      _liveCalibrationState.lastFingerprintBySym[sym] = fp;
      _liveCalibrationState.events.push({
        ts: now,
        sym: sym,
        waitGuardBlocked: _isWaitGuardBlocked(intent),
        staleDataBlocked: _isStaleDataBlocked(intent),
        vetoBlocked: _isVetoBlocked(intent),
        mctsOverrideUsed: _isMctsOverrideUsed(intent),
        executedDirectionalIntent: _isExecutedDirectionalIntent(intent),
        action: intent.action || null,
      });
    });
    _trimCalibrationEvents();
  }
  function getLiveCalibrationTelemetry() {
    var recent = _liveCalibrationState.events.slice(-LIVE_CALIBRATION_EVENT_WINDOW);
    var counts = {
      waitGuardBlocked: 0,
      staleDataBlocked: 0,
      vetoBlocked: 0,
      mctsOverrideUsed: 0,
      executedDirectionalIntents: 0,
    };
    var bySymbol = {};
    recent.forEach(function (event) {
      if (!event || !event.sym) return;
      if (!bySymbol[event.sym]) {
        bySymbol[event.sym] = {
          samples: 0,
          waitGuardBlocked: 0,
          staleDataBlocked: 0,
          vetoBlocked: 0,
          mctsOverrideUsed: 0,
          executedDirectionalIntents: 0,
        };
      }
      var bucket = bySymbol[event.sym];
      bucket.samples += 1;
      if (event.waitGuardBlocked) { counts.waitGuardBlocked += 1; bucket.waitGuardBlocked += 1; }
      if (event.staleDataBlocked) { counts.staleDataBlocked += 1; bucket.staleDataBlocked += 1; }
      if (event.vetoBlocked) { counts.vetoBlocked += 1; bucket.vetoBlocked += 1; }
      if (event.mctsOverrideUsed) { counts.mctsOverrideUsed += 1; bucket.mctsOverrideUsed += 1; }
      if (event.executedDirectionalIntent) { counts.executedDirectionalIntents += 1; bucket.executedDirectionalIntents += 1; }
    });
    return {
      windowSize: LIVE_CALIBRATION_EVENT_WINDOW,
      samples: recent.length,
      counts: counts,
      bySymbol: bySymbol,
      updatedAt: recent.length ? recent[recent.length - 1].ts : null,
    };
  }
  window.KalshiOrchestrator = {
    translate: translate,
    resolveAll: resolveAll,
    scoreToProbUp: scoreToProbUp,
    analyseEntry: analyseEntry,
    getIntent: function (sym) { return _cache[sym] || null; },
    getAllIntents: function () { return _cache; },
    getCalibrationTelemetry: getLiveCalibrationTelemetry,
    update: function (predAll, cfmAll) {
      _cache = resolveAll(predAll, cfmAll);
      return _cache;
    },
  };
  console.log('[KalshiOrchestrator] v2.0 loaded — EV engine | gate=5s | ms-precision clock');
})();

