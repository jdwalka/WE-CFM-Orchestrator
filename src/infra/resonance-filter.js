/**
 * Resonance filter -- smooths Hz fluctuations in a real-time feed.
 *
 * Two independent things get filtered here, both additive/opt-in (neither
 * replaces an existing raw value -- callers that need the unfiltered price
 * or exact tick timing still get it untouched):
 *
 *   createLowPassFilter -- a first-order IIR low-pass (the standard DSP
 *   "resonance filter" primitive) applied to a noisy price series, so
 *   microstructure noise/oscillation near the sample rate doesn't ride
 *   straight through into a spot-price reading. Never apply this to PTB:
 *   PTB is Polymarket's own published contract value and must stay exact
 *   (see POLY5M_PTB_LOCK_VERSION notes in prediction-markets.js) -- this
 *   filter is for Pyth spot/context prices only.
 *
 *   createHzTracker -- smooths the observed tick-arrival RATE itself (an
 *   EMA over inter-tick intervals), so a single fast/slow gap (network
 *   jitter, a reconnect replay burst) doesn't read as "feed just changed
 *   speed" when the underlying subscription cadence hasn't changed.
 *
 * Node + browser; no dependencies.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.ResonanceFilter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * First-order IIR low-pass filter (exponential moving average with a
   * time-constant derived from an actual cutoff frequency, not a guessed
   * smoothing factor). Standard formula: alpha = 1 - exp(-2*pi*cutoffHz*dt).
   *
   * @param {number} cutoffHz - frequencies above this are attenuated.
   *   Lower = smoother/laggier, higher = closer to passing the raw signal.
   * @returns {{ update(value: number, nowMs?: number): number, reset(): void, value: number|null }}
   */
  function createLowPassFilter(cutoffHz, gapReseedMs = 3000) {
    if (!(cutoffHz > 0)) throw new Error('createLowPassFilter: cutoffHz must be > 0');
    if (!(gapReseedMs >= 0)) throw new Error('createLowPassFilter: gapReseedMs must be >= 0');
    let filtered = null;
    let lastTs = null;

    function update(value, nowMs) {
      const v = Number(value);
      if (!Number.isFinite(v)) return filtered;
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      if (filtered == null || lastTs == null) {
        filtered = v;
        lastTs = now;
        return filtered;
      }
      const dtSec = Math.max(0, (now - lastTs) / 1000);
      lastTs = now;
      if (dtSec === 0) return filtered; // duplicate-timestamp tick, no time to filter over

      // After a prolonged disconnection gap, reseed directly to avoid lag/ramping
      if (dtSec * 1000 > gapReseedMs) {
        filtered = v;
        return filtered;
      }

      // First-order IIR low-pass filter: alpha = 1 - exp(-2*pi*cutoffHz*dt).
      // Clamped strictly to [0, 1] to guarantee stability and prevent resonance ringing or divergence.
      const alpha = Math.min(1, Math.max(0, 1 - Math.exp(-2 * Math.PI * cutoffHz * dtSec)));
      filtered = filtered + alpha * (v - filtered);
      if (!Number.isFinite(filtered)) filtered = v;
      return filtered;
    }

    return {
      update,
      reset() { filtered = null; lastTs = null; },
      get value() { return filtered; },
    };
  }

  /**
   * Smoothed tick-arrival-rate tracker. Feed it a timestamp on every real
   * tick; it reports an EMA-smoothed Hz estimate instead of the instantaneous
   * (noisy) 1/interval of the single most recent gap.
   *
   * @param {number} [smoothingHz=0.5] - cutoff for the EMA over inter-tick
   *   intervals themselves. 0.5Hz means it settles over a ~2s window, which
   *   absorbs single-tick jitter without lagging behind a real rate change
   *   (e.g. a genuine reconnect at a different subscribed cadence) for long.
   */
  function createHzTracker(smoothingHz) {
    const intervalFilter = createLowPassFilter(smoothingHz > 0 ? smoothingHz : 0.5);
    let lastTickTs = null;
    let sampleCount = 0;

    function tick(nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      if (lastTickTs == null) {
        lastTickTs = now;
        sampleCount = 1;
        return null; // first tick has no interval yet
      }
      const intervalMs = now - lastTickTs;
      lastTickTs = now;
      if (intervalMs <= 0) return (intervalFilter.value != null && intervalFilter.value > 0) ? 1000 / intervalFilter.value : null;

      // Discontinuity handling: if interval > 3000ms (reconnect/pause), re-anchor
      // without feeding the idle gap into intervalFilter, preventing resonance drag
      if (intervalMs > 3000) {
        intervalFilter.reset();
        lastTickTs = now;
        return (intervalFilter.value != null && intervalFilter.value > 0) ? 1000 / intervalFilter.value : null;
      }

      sampleCount += 1;
      const smoothedIntervalMs = intervalFilter.update(intervalMs, now);
      return (smoothedIntervalMs != null && smoothedIntervalMs > 0) ? 1000 / smoothedIntervalMs : null;
    }

    return {
      tick,
      get hz() { return (intervalFilter.value != null && intervalFilter.value > 0) ? 1000 / intervalFilter.value : null; },
      get sampleCount() { return sampleCount; },
      reset() { intervalFilter.reset(); lastTickTs = null; sampleCount = 0; },
    };
  }

  return { createLowPassFilter, createHzTracker };
}));
