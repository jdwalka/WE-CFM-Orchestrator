// ================================================================
// alchemy-key.js — single source of truth for the Alchemy API key
// ================================================================
// Every module that talks to Alchemy (alchemy-ws.js, chain-router.js,
// portfolio-intel.js) used to read the key its own way — one env var name
// per file (ALCHEMY_API_KEY vs window._env.ALCHEMY_KEY vs
// localStorage.alchemyApiKey), and each fell back to the same hardcoded key
// if nothing was configured. A key visible in Electron-renderer JS is
// visible via devtools to anyone running the app, so a hardcoded fallback
// defeats the point of configuring one at all. This module is the only
// place that resolves the key from here on; there is no fallback constant
// — an absent key must mean "Alchemy calls are skipped," never "silently
// use this other key."
//
// Precedence: env-like (window.__env / window._env / process.env) →
// Electron secrets file → localStorage. Standardized on ALCHEMY_API_KEY as
// the one name across every source (localStorage key: alchemyApiKey, the
// one pre-existing exception, kept for backward compat with
// wallet-intel-config.js's existing write path).
//
// Exports: window.AlchemyKey.getSync()  — env + localStorage only (no I/O)
//          window.AlchemyKey.get()      — awaits the Electron secrets file too
// ================================================================
(function () {
  'use strict';

  function getSync() {
    try {
      if (typeof window !== 'undefined' && window.__env && window.__env.ALCHEMY_API_KEY) {
        return window.__env.ALCHEMY_API_KEY;
      }
    } catch (_) { }
    try {
      if (typeof window !== 'undefined' && window._env && window._env.ALCHEMY_KEY) {
        return window._env.ALCHEMY_KEY;
      }
    } catch (_) { }
    try {
      if (typeof localStorage !== 'undefined') {
        const v = localStorage.getItem('alchemyApiKey');
        if (v) return v;
      }
    } catch (_) { }
    try {
      if (typeof process !== 'undefined' && process && process.env && process.env.ALCHEMY_API_KEY) {
        return process.env.ALCHEMY_API_KEY;
      }
    } catch (_) { }
    return '';
  }

  async function get() {
    const sync = getSync();
    if (sync) return sync;
    try {
      if (typeof window !== 'undefined' && window.electron && window.electron.readFile) {
        const txt = await window.electron.readFile('secrets/ALCHEMY-API-KEY.txt');
        if (txt) return txt.trim();
      }
    } catch (_) { }
    return '';
  }

  window.AlchemyKey = { get, getSync };
})();
