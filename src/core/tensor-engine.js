/**
 * TENSOR ENGINE
 * 
 * Exposes a WebAssembly SIMD-accelerated calculation engine for
 * offloading tensor contractions and phase angle rotations.
 * Bypasses JS limitations by operating directly on WebAssembly Memory buffers.
 */

class TensorEngine {
  constructor() {
    this.wasmModule = null;
    this.wasmMemory = null;
    this.isReady = false;
    this.initPromise = null;
    this.hasMctsWasm = false;
    this._warnedMissingMctsExport = false;
  }

  async init() {
    if (this.isReady) return this;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        let wasmSource;
        if (typeof process !== 'undefined' && process.type === 'renderer') {
          const path = require('path');
          const fs = require('fs');
          const url = new URL(window.location.href);
          let htmlDir = path.dirname(decodeURIComponent(url.pathname));
          if (process.platform === 'win32' && htmlDir.startsWith('/')) {
            htmlDir = htmlDir.slice(1);
          }
          const wasmPath = path.join(htmlDir, 'tensor_math.wasm');
          wasmSource = fs.readFileSync(wasmPath);
        } else {
          const response = await fetch('tensor_math.wasm');
          if (!response.ok && response.status !== 0) throw new Error(`WASM module fetch failed with status ${response.status}`);
          wasmSource = await response.arrayBuffer();
        }
        const { instance } = await WebAssembly.instantiate(wasmSource, {
          env: {
            abort: () => console.error('WASM Aborted')
          }
        });

        this.wasmModule = instance.exports;
        this.wasmMemory = instance.exports.memory;
        this.hasMctsWasm = typeof instance.exports.runMcts === 'function';
        this.isReady = true;
        if (!this.hasMctsWasm && !this._warnedMissingMctsExport) {
          console.warn('[TensorEngine] tensor_math.wasm loaded without runMcts export; falling back to JS MCTS.');
          this._warnedMissingMctsExport = true;
        }
        console.log('[TensorEngine] WebAssembly SIMD module initialized successfully.');
      } catch (err) {
        console.error('[TensorEngine] Failed to initialize WASM SIMD module:', err);
      } finally {
        if (!this.isReady) this.initPromise = null;
      }
      return this;
    })();

    return this.initPromise;
  }

  canRunMcts() {
    return !!(this.isReady && this.hasMctsWasm && this.wasmModule && typeof this.wasmModule.runMcts === 'function');
  }

  /**
   * Performs a near-native speed phase angle rotation across an array of floating point vectors.
   * @param {number[]} values - Interleaved x, y coordinates [x1, y1, x2, y2, ...]
   * @param {number} angleRad - Rotation angle in radians
   * @returns {Float64Array} The predictive distribution array
   */
  rotatePhaseAngles(values, angleRad = 0.785398) {
    if (!this.isReady || !this.wasmModule.contractTensors) {
      console.warn('[TensorEngine] WASM module not ready. Returning unrotated values.');
      return new Float64Array(values);
    }

    // Determine the required memory size
    const byteLength = values.length * 8; // 8 bytes per f64
    
    // Grow WASM memory if needed (each page is 64KB = 65536 bytes)
    if (this.wasmMemory.buffer.byteLength < byteLength) {
      const pagesNeeded = Math.ceil((byteLength - this.wasmMemory.buffer.byteLength) / 65536);
      this.wasmMemory.grow(pagesNeeded);
    }

    // 1. Copy the JS values into the WASM memory buffer starting at pointer 0
    const wasmF64View = new Float64Array(this.wasmMemory.buffer);
    for (let i = 0; i < values.length; i++) {
      wasmF64View[i] = values[i];
    }

    // 2. Invoke the WASM SIMD Tensor Contraction
    // Signature: contractTensors(ptr: usize, length: i32, angle: f64)
    const t0 = performance.now();
    this.wasmModule.contractTensors(0, values.length, angleRad);
    const t1 = performance.now();

    // 3. Extract the mutated data
    // We create a copy so the WASM memory can be safely reused for the next frame
    const predictiveDistribution = new Float64Array(this.wasmMemory.buffer, 0, values.length);
    const resultCopy = new Float64Array(predictiveDistribution);
    
    console.log(`[TensorEngine] SIMD phase rotation on ${values.length/2} vectors took ${(t1 - t0).toFixed(3)}ms`);
    return resultCopy;
  }

  /**
   * Executes a Monte Carlo Tree Search using WebAssembly Memory buffers
   */
  runMcts(state, sims = 1000, depth = 10, exploration = 1.414) {
    if (!this.canRunMcts()) return null;

    // Regime tag to float mapping
    let regimeMap = { 'mixed': 0.0, 'trending': 1.0, 'range': 2.0, 'volatile': 3.0, 'chop': 4.0 };
    let regimeVal = regimeMap[state.regime] ?? 0.0;
    let secsLeft = state.secsLeft == null ? -1.0 : state.secsLeft;

    // We need 10 floats for input state (80 bytes)
    // and 3 floats for output (24 bytes). Total 104 bytes.
    // Let's place the state at pointer 0, and output at pointer 80.
    const statePtr = 0;
    const outPtr = 80;

    const memoryView = new Float64Array(this.wasmMemory.buffer);
    
    // Write state
    memoryView[0] = state.modelProbUp;
    memoryView[1] = state.confidence;
    memoryView[2] = state.momentum;
    memoryView[3] = state.trendDir;
    memoryView[4] = state.volatility;
    memoryView[5] = state.mispricing;
    memoryView[6] = secsLeft;
    memoryView[7] = state.liquidity;
    memoryView[8] = regimeVal;
    memoryView[9] = state.modelStrength;

    let seed = Math.floor(Math.random() * 4294967296);

    // Run WASM MCTS
    // runMcts(statePtr: usize, outPtr: usize, sims: i32, depth: i32, exploration: f64, seed: u32)
    this.wasmModule.runMcts(statePtr, outPtr, sims, depth, exploration, seed);

    // Read the 3 resulting floats (upScore, downScore, waitScore)
    // float64 index is byteOffset / 8
    const outIndex = outPtr / 8;
    const result = new Float64Array([
      memoryView[outIndex],
      memoryView[outIndex + 1],
      memoryView[outIndex + 2]
    ]);

    return result;
  }
}

window.TensorEngine = new TensorEngine();
window.TensorEngine.init().catch(console.error);
