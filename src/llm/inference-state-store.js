/**
 * Renderer-side persistence for AI inference briefs / truth verdicts.
 * Survives Electron restarts via localStorage (best-effort MultiDriveCache).
 *
 * Keys:
 *   wecrypto_asi1_briefs_v1
 *   wecrypto_truth_verdicts_v1
 *   wecrypto_range_guidance_v1
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const BRIEFS_KEY = 'wecrypto_asi1_briefs_v1';
  const TRUTH_KEY = 'wecrypto_truth_verdicts_v1';
  const GUIDANCE_KEY = 'wecrypto_range_guidance_v1';
  const ACCURACY_KEY = 'wecrypto_ai_accuracy_v1';
  const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h — still useful after restart, not forever

  function load(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function pruneByAge(obj, maxAge = MAX_AGE_MS) {
    if (!obj || typeof obj !== 'object') return {};
    const now = Date.now();
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const ts = Number(v?.ts || v?.savedAt || 0);
      if (!ts || (now - ts) <= maxAge) out[k] = v;
    }
    return out;
  }

  const InferenceStateStore = {
    saveBriefs(briefsMap) {
      const slim = {};
      for (const [k, b] of Object.entries(briefsMap || {})) {
        if (!b) continue;
        slim[k] = {
          sym: b.sym,
          ts: b.ts || Date.now(),
          slug: b.slug,
          horizon: b.horizon,
          call: b.call,
          aiCallOriginal: b.aiCallOriginal || null,
          confidence: b.confidence,
          regime: b.regime,
          notes: String(b.notes || '').slice(0, 800),
          primaryRationale: String(b.primaryRationale || '').slice(0, 800),
          marketPatterns: b.marketPatterns || null,
          preContract: b.preContract || null,
          polyPeg: b.polyPeg || null,
          provider: b.provider,
          model: b.model,
          nullified: !!b.nullified,
          softConflict: !!b.softConflict,
          truthReason: b.truthReason || null,
          truthCall: b.truthCall || null,
          sourceOfTruth: b.sourceOfTruth || null,
          market: b.market ? {
            slug: b.market.slug,
            yesProb: b.market.yesProb,
            priceToBeatNum: b.market.priceToBeatNum,
            secondsToClose: b.market.secondsToClose,
            spot: b.market.spot,
          } : null,
        };
      }
      return save(BRIEFS_KEY, { savedAt: Date.now(), briefs: slim });
    },

    loadBriefs() {
      const data = load(BRIEFS_KEY);
      if (!data?.briefs) return {};
      return pruneByAge(data.briefs);
    },

    saveGuidance(guidanceByHorizon) {
      // { '15m': { BTC: {...} }, '60m': { ... } }
      return save(GUIDANCE_KEY, { savedAt: Date.now(), guidance: guidanceByHorizon || {} });
    },

    loadGuidance() {
      const data = load(GUIDANCE_KEY);
      if (!data?.guidance) return null;
      // Drop entries older than MAX_AGE
      const out = {};
      const now = Date.now();
      for (const [hz, byCoin] of Object.entries(data.guidance)) {
        out[hz] = {};
        for (const [coin, g] of Object.entries(byCoin || {})) {
          if (g && (!g.ts || (now - g.ts) <= MAX_AGE_MS)) out[hz][coin] = g;
        }
      }
      return out;
    },

    saveTruth(verdict) {
      if (!verdict?.sym) return;
      const all = load(TRUTH_KEY)?.verdicts || {};
      const key = `${verdict.sym}:${verdict.horizon || 'x'}`;
      all[key] = {
        ts: verdict.ts || Date.now(),
        sym: verdict.sym,
        horizon: verdict.horizon,
        nullified: verdict.nullified,
        effectiveCall: verdict.effectiveCall,
        aiCall: verdict.aiCall,
        reason: verdict.reason,
        sourceOfTruth: verdict.sourceOfTruth,
      };
      save(TRUTH_KEY, { savedAt: Date.now(), verdicts: pruneByAge(all) });
    },

    loadTruth() {
      return pruneByAge(load(TRUTH_KEY)?.verdicts || {});
    },

    /**
     * AI-inference accuracy ledger — separate from the quant model's own
     * win-rate (tracked elsewhere via TradeJournal/ContractWinRateCalculator).
     * Compares the AI's call at brief time against the settled outcome.
     */
    recordOutcome(sym, horizon, aiCall, actualOutcome) {
      const coin = String(sym || '').toUpperCase();
      const call = String(aiCall || '').toUpperCase();
      const actual = String(actualOutcome || '').toUpperCase();
      if (!coin || (call !== 'UP' && call !== 'DOWN') || (actual !== 'UP' && actual !== 'DOWN')) return null;

      const correct = call === actual;
      const data = load(ACCURACY_KEY) || { overall: { wins: 0, losses: 0, total: 0 }, byCoin: {} };
      data.overall.total++;
      if (correct) data.overall.wins++; else data.overall.losses++;
      if (!data.byCoin[coin]) data.byCoin[coin] = { wins: 0, losses: 0, total: 0 };
      data.byCoin[coin].total++;
      if (correct) data.byCoin[coin].wins++; else data.byCoin[coin].losses++;
      save(ACCURACY_KEY, data);
      return { correct, coin, horizon, aiCall: call, actualOutcome: actual };
    },

    getAccuracy() {
      const data = load(ACCURACY_KEY) || { overall: { wins: 0, losses: 0, total: 0 }, byCoin: {} };
      const pct = (b) => (b && b.total > 0 ? Math.round((b.wins / b.total) * 100) : null);
      const byCoin = {};
      for (const [coin, b] of Object.entries(data.byCoin || {})) byCoin[coin] = { ...b, pct: pct(b) };
      return { overall: { ...data.overall, pct: pct(data.overall) }, byCoin };
    },
  };

  window.InferenceStateStore = InferenceStateStore;

  // Hook truth events
  window.addEventListener('inference:truth', (ev) => {
    try { InferenceStateStore.saveTruth(ev.detail); } catch (_) { /* */ }
  });

  console.info('[InferenceStateStore] ready — localStorage cold-start restore enabled');
})();
