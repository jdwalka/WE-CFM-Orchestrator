// Tensor Contraction and Phase Angle Rotation using WASM SIMD
// Compiled to WebAssembly via AssemblyScript

// We assume the host environment passes a pointer to a Float64Array.
// We will process elements in chunks of 2 (x, y) vectors.
// SIMD v128 can hold two f64 values!

export function contractTensors(ptr: usize, length: i32, angle: f64): void {
  // SIMD Tensor Contraction Implementation
  let cosA = Math.cos(angle);
  let sinA = Math.sin(angle);
  let end = ptr + (length << 3); 
  for (let p = ptr; p < end; p += 16) { 
    let vec = v128.load(p);
    let x = f64x2.extract_lane(vec, 0);
    let y = f64x2.extract_lane(vec, 1);
    let newX = x * cosA - y * sinA;
    let newY = x * sinA + y * cosA;
    let res = f64x2.replace_lane(f64x2.replace_lane(v128.splat<f64>(0.0), 0, newX), 1, newY);
    v128.store(p, res);
  }
}

// --- MONTE CARLO TREE SEARCH (MCTS) ---
// Custom 32-bit xorshift RNG for deterministic MCTS rollouts
class RNG {
  private s: u32;
  constructor(seed: u32) {
    this.s = seed == 0 ? 0x9e3779b9 : seed;
  }
  next(): f64 {
    this.s = this.s + 0x6d2b79f5;
    let s1 = this.s ^ (this.s >>> 15);
    let s2 = (1 as u32) | this.s;
    let t = Math.imul(s1 as i32, s2 as i32) as u32;
    let t1 = t ^ (t >>> 7);
    let t2 = (61 as u32) | t;
    t ^= Math.imul(t1 as i32, t2 as i32) as u32;
    let r = t ^ (t >>> 14);
    return (r as f64) / 4294967296.0;
  }
}

function clamp(v: f64, lo: f64, hi: f64): f64 {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// State mapping: 
// 0: modelProbUp, 1: confidence, 2: momentum, 3: trendDir, 4: volatility, 
// 5: mispricing, 6: secsLeft, 7: liquidity, 8: regime (0=mixed,1=trend,2=range,3=vol,4=chop), 9: modelStrength
function rolloutReward(statePtr: usize, action: i32, rng: RNG, depth: i32): f64 {
  let modelProbUp = load<f64>(statePtr + 0 * 8);
  let confidence = load<f64>(statePtr + 1 * 8);
  let momentum = load<f64>(statePtr + 2 * 8);
  let trendDir = load<f64>(statePtr + 3 * 8);
  let volatility = load<f64>(statePtr + 4 * 8);
  let mispricing = load<f64>(statePtr + 5 * 8);
  let secsLeft = load<f64>(statePtr + 6 * 8);
  let liquidity = load<f64>(statePtr + 7 * 8);
  let regime = load<f64>(statePtr + 8 * 8);
  let modelStrength = load<f64>(statePtr + 9 * 8);

  let bias = ((modelProbUp - 0.5) * 1.9) + (momentum * 0.5) + (trendDir * 0.3);
  let path: f64 = 0.0;
  let steps = Math.max(2, depth) as i32;

  let isChop = regime == 4.0;
  let isVolatile = regime == 3.0;

  for (let i = 0; i < steps; i++) {
    let shockScale = 0.12 + (volatility * 0.22) + (isChop ? 0.08 : 0.0);
    if (isVolatile) shockScale += 0.05;
    let shock = (rng.next() - 0.5) * 2.0 * shockScale;
    path += (bias * 0.38) + shock;
  }

  let dirEdge = path / (steps as f64);
  let lateRisk = secsLeft >= 0.0 ? clamp((90.0 - secsLeft) / 90.0, 0.0, 1.0) : 0.4;
  let slippage = clamp((volatility * 0.4) + (liquidity < 1400.0 ? 0.25 : 0.0), 0.0, 1.3);

  // Actions: 0 = UP, 1 = DOWN, 2 = WAIT
  if (action == 2) {
    let waitSafety = (0.35 * lateRisk) + (0.22 * slippage) + (isVolatile ? 0.18 : 0.0);
    let waitOpportunityCost = Math.abs(dirEdge) * (0.45 + (confidence * 0.55));
    return clamp(waitSafety - waitOpportunityCost, -1.5, 1.5);
  }

  let sign = action == 0 ? 1.0 : -1.0;
  let directionalFit = sign * dirEdge;
  let confidenceBoost = confidence * (0.30 + modelStrength * 0.20);
  let mispricingBoost = mispricing * 1.3;
  let wrongWayPenalty = (sign == 1.0 ? (0.5 - modelProbUp) : (modelProbUp - 0.5));
  let regimePenalty = (isVolatile ? 0.14 : (isChop ? 0.07 : 0.0));
  
  let maxWW = Math.max(0.0, wrongWayPenalty);
  let riskPenalty = (lateRisk * 0.28) + (slippage * 0.20) + regimePenalty + maxWW;
  
  return clamp((directionalFit * 1.2) + confidenceBoost + mispricingBoost - riskPenalty, -1.5, 1.5);
}

// Memory block mapping for results (3 floats: UP, DOWN, WAIT scores)
export function runMcts(statePtr: usize, outPtr: usize, sims: i32, depth: i32, exploration: f64, seed: u32): void {
  let rng = new RNG(seed);
  
  let visits = new StaticArray<i32>(3);
  let totals = new StaticArray<f64>(3);
  let totalVisits: i32 = 0;

  for (let i = 0; i < sims; i++) {
    let picked = 0;
    let bestUcb = -1000000.0;

    for (let action = 0; action < 3; action++) {
      let v = visits[action];
      let t = totals[action];
      let ucb = v == 0 ? 1000000.0 : (t / (v as f64)) + exploration * Math.sqrt(Math.log(totalVisits + 1) / (v as f64));
      
      if (ucb > bestUcb) {
        bestUcb = ucb;
        picked = action;
      }
    }

    let reward = rolloutReward(statePtr, picked, rng, depth);
    visits[picked] += 1;
    totals[picked] += reward;
    totalVisits += 1;
  }

  let upScore = visits[0] > 0 ? totals[0] / (visits[0] as f64) : 0.0;
  let downScore = visits[1] > 0 ? totals[1] / (visits[1] as f64) : 0.0;
  let waitScore = visits[2] > 0 ? totals[2] / (visits[2] as f64) : 0.0;

  store<f64>(outPtr + 0 * 8, upScore);
  store<f64>(outPtr + 1 * 8, downScore);
  store<f64>(outPtr + 2 * 8, waitScore);
}
