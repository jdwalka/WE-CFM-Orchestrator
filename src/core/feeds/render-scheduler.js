/**
 * render-scheduler.js — High-performance rAF Render Scheduler
 * Decouples 100ms (10Hz) Pyth Lazer feed ingest from the browser paint cycle.
 * Ingest stays at 100ms; DOM and HUD paints are batched and capped at 60fps via rAF.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const exports = factory();
    if (typeof window !== 'undefined') {
      window.RenderScheduler = exports;
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  let rafPending = false;
  const dirtySyms = new Set();
  const latestPrices = {};

  const getPerfNow = () => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  };

  const scheduleFrame = (callback) => {
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(callback);
    }
    return setTimeout(callback, 16);
  };

  function onPythTick(sym, price, meta = {}) {
    if (!sym) return;
    const s = String(sym).toUpperCase();
    const numPrice = Number(price);
    if (!Number.isFinite(numPrice) || numPrice <= 0) return;

    latestPrices[s] = {
      price: numPrice,
      meta,
      ts: getPerfNow(),
    };
    dirtySyms.add(s);

    if (!rafPending) {
      rafPending = true;
      scheduleFrame(flush);
    }
  }

  function flush() {
    rafPending = false;
    const syms = Array.from(dirtySyms);
    dirtySyms.clear();
    if (syms.length === 0) return;

    // Single DOM/state update pass
    if (typeof window !== 'undefined') {
      window._pythPrices = window._pythPrices || {};
      window._pythPythMetadata = window._pythPythMetadata || {};
      for (const sym of syms) {
        const data = latestPrices[sym];
        if (!data) continue;
        window._pythPrices[sym] = data.price;
        window._pythPythMetadata[sym] = data.meta;
      }

      // Notify desk and HUD once per animation frame, not per tick
      if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('pyth-batch', {
          detail: {
            syms,
            prices: latestPrices,
            ts: getPerfNow(),
          },
        }));
      }
    }
  }

  function getLatestPrices() {
    return { ...latestPrices };
  }

  function getLatestPrice(sym) {
    if (!sym) return null;
    return latestPrices[String(sym).toUpperCase()] || null;
  }

  function resetForTesting() {
    rafPending = false;
    dirtySyms.clear();
    for (const k of Object.keys(latestPrices)) delete latestPrices[k];
  }

  return {
    onPythTick,
    flush,
    getLatestPrices,
    getLatestPrice,
    resetForTesting,
  };
});
