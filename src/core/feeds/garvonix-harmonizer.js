(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const exports = factory();
    if (typeof window !== 'undefined') {
      window.GarvonixHarmonizer = exports;
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_SAMPLE_HZ = 20;
  const DEFAULT_ROLLOFF_HZ = 0.25;
  const DEFAULT_NOTCH_HZ = [1, 2];
  const DEFAULT_OUTPUT_HZ = 20;
  const DEFAULT_NOTCH_QUALITY = 0.9;
  const ANCHOR_HZ = 0.001;
  const WARMUP_SAMPLES = 32;
  const MAX_GAP_MS = 125;
  const SAMPLE_HISTORY = 256;

  let config = {
    enabled: true,
    sampleHz: DEFAULT_SAMPLE_HZ,
    rolloffHz: DEFAULT_ROLLOFF_HZ,
    notchHz: [...DEFAULT_NOTCH_HZ],
    outputHz: DEFAULT_OUTPUT_HZ,
    notchQuality: DEFAULT_NOTCH_QUALITY,
  };
  const symbols = new Map();

  function finitePositive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizeFrequencies(values) {
    if (!Array.isArray(values)) return [];
    const nyquist = config.sampleHz * 0.95;
    const seen = new Set();
    const result = [];
    for (const value of values) {
      const frequency = Number(value);
      if (!Number.isFinite(frequency) || frequency <= 0 || frequency >= nyquist) continue;
      const key = frequency.toFixed(6);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(frequency);
    }
    return result;
  }

  function configure(options = {}) {
    const sampleHz = finitePositive(options.sampleHz, config.sampleHz);
    const rolloffHz = finitePositive(options.rolloffHz, config.rolloffHz);
    const outputHz = finitePositive(options.outputHz, config.outputHz);
    const notchQuality = Math.min(
      Math.max(finitePositive(options.notchQuality, config.notchQuality), 0.5),
      0.999
    );
    config = {
      enabled: options.enabled === undefined ? config.enabled : Boolean(options.enabled),
      sampleHz,
      rolloffHz,
      notchHz: normalizeFrequencies(options.notchHz === undefined ? config.notchHz : options.notchHz),
      outputHz: Math.min(outputHz, sampleHz),
      notchQuality,
    };
    return { ...config };
  }

  function timestampToMs(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return number < 1e12 ? number * 1000 : number;
  }

  function createState(timestampMs) {
    const notchHz = config.notchHz;
    return {
      baseline: null,
      previousResidual: 0,
      previousRolloff: 0,
      notches: notchHz.map((frequency) => ({
        frequency,
        x1: 0,
        x2: 0,
        y1: 0,
        y2: 0,
      })),
      lastTimestampMs: timestampMs,
      lastEmittedTimestampMs: null,
      phase: 0,
      warmupRemaining: WARMUP_SAMPLES,
      accepted: 0,
      emitted: 0,
      skipped: 0,
      resets: 0,
      jitterEmaMs: 0,
      lastRaw: null,
      lastFiltered: null,
      inputEnergy: 0,
      outputEnergy: 0,
      samples: [],
    };
  }

  function resetFilters(state, price) {
    state.previousResidual = 0;
    state.previousRolloff = 0;
    for (const notch of state.notches) {
      notch.x1 = 0;
      notch.x2 = 0;
      notch.y1 = 0;
      notch.y2 = 0;
    }
    state.resets += 1;
    state.warmupRemaining = WARMUP_SAMPLES;
    if (Number.isFinite(price)) {
      state.baseline = price;
      state.lastFiltered = null;
    }
  }

  function applyNotches(state, input) {
    let output = input;
    for (const notch of state.notches) {
      const omega = (2 * Math.PI * notch.frequency) / config.sampleHz;
      const cosine = Math.cos(omega);
      const radius = config.notchQuality;
      const a1 = -2 * radius * cosine;
      const a2 = radius * radius;
      const next = output - 2 * cosine * notch.x1 + notch.x2 - a1 * notch.y1 - a2 * notch.y2;
      notch.x2 = notch.x1;
      notch.x1 = output;
      notch.y2 = notch.y1;
      notch.y1 = next;
      output = next;
    }
    return output;
  }

  function shouldEmit(state) {
    state.phase += config.outputHz;
    if (state.phase < config.sampleHz) return false;
    state.phase -= config.sampleHz;
    return true;
  }

  function pushSample(state, sample) {
    state.samples.push(sample);
    if (state.samples.length > SAMPLE_HISTORY) state.samples.shift();
  }

  function onTick(sym, price, meta = {}) {
    if (!config.enabled || !sym) return null;
    const symbol = String(sym).toUpperCase();
    const raw = Number(price);
    if (!Number.isFinite(raw) || raw <= 0) return null;

    const timestampMs = timestampToMs(meta.publishTime ?? meta.timestamp);
    let state = symbols.get(symbol);
    if (!state) {
      state = createState(timestampMs);
      symbols.set(symbol, state);
    }

    let intervalMs = 1000 / config.sampleHz;
    if (timestampMs != null) {
      if (state.lastTimestampMs != null) {
        const delta = timestampMs - state.lastTimestampMs;
        if (delta > 0) {
          intervalMs = delta;
          const jitter = Math.abs(delta - 1000 / config.sampleHz);
          state.jitterEmaMs = state.jitterEmaMs === 0
            ? jitter
            : state.jitterEmaMs * 0.9 + jitter * 0.1;
        }
        if (intervalMs > MAX_GAP_MS) resetFilters(state, raw);
      }
      state.lastTimestampMs = timestampMs;
    }

    state.lastRaw = raw;
    state.accepted += 1;
    if (state.baseline == null) state.baseline = raw;

    const baselineAlpha = 1 - Math.exp((-2 * Math.PI * ANCHOR_HZ) / config.sampleHz);
    const rolloffAlpha = 1 / (1 + (2 * Math.PI * config.rolloffHz) / config.sampleHz);
    state.baseline += baselineAlpha * (raw - state.baseline);
    const residual = raw - state.baseline;
    const rolloffResidual = rolloffAlpha * (state.previousRolloff + residual - state.previousResidual);
    state.previousResidual = residual;
    state.previousRolloff = rolloffResidual;
    const filteredResidual = applyNotches(state, rolloffResidual);
    const filtered = state.baseline + filteredResidual;

    state.inputEnergy += residual * residual;
    state.outputEnergy += filteredResidual * filteredResidual;
    if (!shouldEmit(state)) {
      state.skipped += 1;
      return null;
    }

    state.lastEmittedTimestampMs = timestampMs ?? (
      state.lastEmittedTimestampMs == null ? Date.now() : state.lastEmittedTimestampMs + intervalMs
    );
    state.emitted += 1;
    if (state.warmupRemaining > 0) {
      state.warmupRemaining -= 1;
      state.lastFiltered = raw;
      state.outputEnergy += 0;
    } else {
      state.lastFiltered = filtered;
    }
    pushSample(state, {
      sym: symbol,
      raw,
      filtered: state.lastFiltered,
      residualSignal: filteredResidual,
      residual,
      filteredResidual,
      timestampMs: state.lastEmittedTimestampMs,
      intervalMs,
    });

    return {
      sym: symbol,
      raw,
      price: raw,
      filteredPrice: state.lastFiltered,
      residualSignal: filteredResidual,
      sampled: true,
      meta,
      ts: state.lastEmittedTimestampMs,
    };
  }

  function getStats(sym) {
    if (!sym) return null;
    const state = symbols.get(String(sym).toUpperCase());
    if (!state) return null;
    const suppression = state.inputEnergy > 0
      ? Math.max(0, Math.min(1, 1 - state.outputEnergy / state.inputEnergy))
      : 0;
    return {
      enabled: config.enabled,
      sampleHz: config.sampleHz,
      outputHz: config.outputHz,
      rolloffHz: config.rolloffHz,
      notchHz: [...config.notchHz],
      accepted: state.accepted,
      emitted: state.emitted,
      skipped: state.skipped,
      resets: state.resets,
      jitterEmaMs: state.jitterEmaMs,
      lastRaw: state.lastRaw,
      lastFiltered: state.lastFiltered,
      suppressionRatio: suppression,
      sampleCount: state.samples.length,
    };
  }

  function getFilteredPrice(sym) {
    if (!sym) return null;
    const state = symbols.get(String(sym).toUpperCase());
    return state ? state.lastFiltered : null;
  }

  function getFilteredPrices() {
    const result = {};
    for (const [symbol, state] of symbols.entries()) {
      result[symbol] = state.lastFiltered;
    }
    return result;
  }

  function getSamples(sym, limit = SAMPLE_HISTORY) {
    if (!sym) return [];
    const state = symbols.get(String(sym).toUpperCase());
    if (!state) return [];
    const count = Math.max(0, Math.min(Number(limit) || 0, state.samples.length));
    return state.samples.slice(-count);
  }

  function resetForTesting() {
    symbols.clear();
    config = {
      enabled: true,
      sampleHz: DEFAULT_SAMPLE_HZ,
      rolloffHz: DEFAULT_ROLLOFF_HZ,
      notchHz: [...DEFAULT_NOTCH_HZ],
      outputHz: DEFAULT_OUTPUT_HZ,
      notchQuality: DEFAULT_NOTCH_QUALITY,
    };
  }

  return {
    configure,
    onTick,
    getStats,
    getFilteredPrice,
    getFilteredPrices,
    getSamples,
    resetForTesting,
  };
});
