// Observability & Metrics Logic
(function() {
function _obsNum(v, fallback = null) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

function _obsNormRegime(v) {
    if (!v) return 'UNKNOWN';
    return String(v).trim().replace(/\s+/g, '_').toUpperCase();
  }

function _obsPct(v, dp = 1) {
    return Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : '—';
  }

function _obsEsc(v) {
    return String(v ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

function _obsLatencyBuckets(valuesMs = []) {
    const labels = ['0-5s', '5-15s', '15-30s', '30-60s', '1-2m', '2-5m', '5-10m', '10m+'];
    const bounds = [5000, 15000, 30000, 60000, 120000, 300000, 600000, Infinity];
    const counts = new Array(labels.length).fill(0);
    for (const v of valuesMs) {
      if (!Number.isFinite(v) || v < 0) continue;
      for (let i = 0; i < bounds.length; i++) {
        if (v <= bounds[i]) {
          counts[i]++;
          break;
        }
      }
    }
    const total = counts.reduce((a, b) => a + b, 0);
    return { labels, counts, total };
  }

function _obsGetQuantDriftSnapshot() {
    const sources = [
      window.QuantCore?.driftDetector,
      window.QuantCore?.drift,
      window.QuantCore?.diagnostics?.driftDetector,
      window._driftDetector,
    ];

    for (const src of sources) {
      if (!src) continue;
      try {
        if (typeof src.overallStatus === 'function') {
          const status = src.overallStatus();
          if (!status) continue;
          if (typeof status === 'string') {
            return { overall_status: String(status).toUpperCase(), source: 'overallStatus:string' };
          }
          if (typeof status === 'object') {
            return {
              ...status,
              overall_status: String(status.overall_status || status.status || 'UNKNOWN').toUpperCase(),
            };
          }
        }
        if (typeof src === 'object' && (src.overall_status || src.status)) {
          return {
            ...src,
            overall_status: String(src.overall_status || src.status).toUpperCase(),
            source: 'object',
          };
        }
      } catch (err) { console.error('[Error caught]', err);  }
    }

    return null;
  }

function _obsEmergencyToolsSummary() {
    const out = {
      available: false,
      active: 0,
      pending: 0,
      total: 0,
      note: 'Emergency tools dashboard unavailable.',
    };

    const et = window.__EMERGENCY_TOOLS;
    if (!et || typeof et.catalog !== 'function') return out;

    out.available = true;
    try {
      const text = String(et.catalog() || '');
      const lines = text.split(/\r?\n/);
      lines.forEach(line => {
        if (line.includes('ACTIVE')) out.active += 1;
        else if (line.includes('PENDING')) out.pending += 1;
      });
      out.total = out.active + out.pending;
      out.note = out.total > 0
        ? `${out.active}/${out.total} tools active`
        : 'Emergency tools catalog loaded.';
    } catch (err) { console.error('[Error caught]', err); 
      out.note = 'Emergency tools catalog unavailable.';
    }

    return out;
  }

function _obsBuildMetrics() {
    const resLog = window._15mResolutionLog || [];
    const kalshiLog = window._kalshiLog || [];
    const orchLog = window._orchLog || [];
    const kalshiErrors = window._kalshiErrors || [];
    const journal = _getTradeJournal();
    const journalTrades = Array.isArray(journal?.trades) ? journal.trades : [];
    const quantDrift = _obsGetQuantDriftSnapshot();
    const emergencyTools = _obsEmergencyToolsSummary();
    const networkSummary = window.NetworkLog?.summary?.() || { total: 0, lastTs: null, byProvider: {} };
    const recentNetwork = window.NetworkLog?.getRecent?.(10) || [];
    const sig = [
      resLog.length,
      resLog.length ? (resLog[resLog.length - 1].settledTs || resLog[resLog.length - 1].ts || 0) : 0,
      kalshiLog.length,
      kalshiLog.length ? (kalshiLog[kalshiLog.length - 1].settledTs || kalshiLog[kalshiLog.length - 1].ts || 0) : 0,
      orchLog.length,
      orchLog.length ? (orchLog[orchLog.length - 1].ts || 0) : 0,
      journalTrades.length,
      learningEngine?.tuneLog?.length || 0,
      quantDrift?.overall_status || 'NO_QUANT_DRIFT',
      emergencyTools.active,
      emergencyTools.total,
      networkSummary.total,
      networkSummary.lastTs || 0,
    ].join('|');

    if (_observabilityCache.sig === sig && _observabilityCache.data && (Date.now() - _observabilityCache.ts) < 10_000) {
      return _observabilityCache.data;
    }

    const events = [];

    resLog.forEach(e => {
      if (typeof e.modelCorrect === 'boolean') {
        const modelDir = String(e.modelDir || '').toUpperCase();
        const pUp = _obsNum(e.modelProbUp, null);
        const confFromProb = Number.isFinite(pUp) && (modelDir === 'UP' || modelDir === 'DOWN')
          ? (modelDir === 'UP' ? pUp : (1 - pUp))
          : null;
        events.push({
          source: 'resolution',
          sym: e.sym || 'UNK',
          ts: _obsNum(e.settledTs || e.ts, Date.now()),
          correct: e.modelCorrect,
          regime: _obsNormRegime(e.quantRegime?.state || e.quantRegime?.regime || e.mdtRegime || e.regime),
          confidence: Number.isFinite(confFromProb)
            ? Math.max(0, Math.min(1, confFromProb))
            : (Number.isFinite(_obsNum(e.modelScore, null)) ? Math.max(0, Math.min(1, 0.5 + Math.abs(e.modelScore) * 0.5)) : null),
          latency: {
            snapshotTs: _obsNum(e.snapshotTs, null),
            closeTimeMs: _obsNum(e.closeTimeMs, null),
            settledTs: _obsNum(e.settledTs, null),
            fillTs: _obsNum(e.fillTs || e.fillTsMs, null),
          },
          signalComponents: e.signalComponents || null,
          orchestratorAction: e.orchestratorAction || null,
        });
      }
    });

    kalshiLog.forEach(e => {
      if (typeof e.modelCorrect === 'boolean') {
        const modelDir = String(e.modelDir || '').toUpperCase();
        const mYesPct = _obsNum(e.mYesPct, null);
        const conf = Number.isFinite(mYesPct) && (modelDir === 'UP' || modelDir === 'DOWN')
          ? (modelDir === 'UP' ? mYesPct / 100 : (100 - mYesPct) / 100)
          : (Number.isFinite(_obsNum(e.modelConf, null)) ? Math.max(0, Math.min(1, _obsNum(e.modelConf, 0))) : null);
        events.push({
          source: 'kalshi',
          sym: e.sym || 'UNK',
          ts: _obsNum(e.settledTs || e.ts, Date.now()),
          correct: e.modelCorrect,
          regime: _obsNormRegime(e.quantRegime?.state || e.quantRegime?.regime),
          confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
          signalComponents: e.signalComponents || null,
          orchestratorAction: e.orchestratorAction || null,
        });
      }
    });

    journalTrades.forEach(t => {
      if (!t?.settled || (t.win !== 0 && t.win !== 1)) return;
      events.push({
        source: 'journal',
        sym: t.asset || 'UNK',
        ts: _obsNum(t.settled_timestamp || t.timestamp, Date.now()),
        correct: t.win === 1,
        regime: _obsNormRegime(t.regime),
        confidence: Number.isFinite(_obsNum(t.confidence, null)) ? Math.max(0, Math.min(1, t.confidence)) : null,
        signalComponents: t.signals || null,
        orchestratorAction: t.metadata?.routed_action || null,
      });
    });

    const eventsSorted = events.sort((a, b) => a.ts - b.ts);

    const regimeMap = {};
    eventsSorted.forEach(e => {
      const r = e.regime || 'UNKNOWN';
      if (!regimeMap[r]) regimeMap[r] = { regime: r, wins: 0, total: 0 };
      regimeMap[r].total += 1;
      if (e.correct) regimeMap[r].wins += 1;
    });
    const regimeRows = Object.values(regimeMap)
      .map(r => ({ ...r, winRate: r.total ? r.wins / r.total : 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);

    const confBuckets = [
      { label: '50-59%', min: 0.50, max: 0.60, wins: 0, total: 0, confSum: 0 },
      { label: '60-69%', min: 0.60, max: 0.70, wins: 0, total: 0, confSum: 0 },
      { label: '70-79%', min: 0.70, max: 0.80, wins: 0, total: 0, confSum: 0 },
      { label: '80-89%', min: 0.80, max: 0.90, wins: 0, total: 0, confSum: 0 },
      { label: '90-100%', min: 0.90, max: 1.01, wins: 0, total: 0, confSum: 0 },
    ];
    eventsSorted.forEach(e => {
      if (!Number.isFinite(e.confidence)) return;
      const b = confBuckets.find(x => e.confidence >= x.min && e.confidence < x.max);
      if (!b) return;
      b.total += 1;
      b.confSum += e.confidence;
      if (e.correct) b.wins += 1;
    });
    const calibrationRows = confBuckets.map(b => {
      const avgConf = b.total ? b.confSum / b.total : null;
      const empirical = b.total ? b.wins / b.total : null;
      const ece = (avgConf != null && empirical != null) ? Math.abs(avgConf - empirical) : null;
      return { ...b, avgConf, empirical, ece };
    });

    const orchBySym = {};
    orchLog.forEach(o => {
      const sym = o.sym || 'UNK';
      if (!orchBySym[sym]) orchBySym[sym] = [];
      orchBySym[sym].push(_obsNum(o.ts, 0));
    });
    Object.values(orchBySym).forEach(arr => arr.sort((a, b) => a - b));

    const signalToQuote = [];
    const quoteToFill = [];
    const fillToSettle = [];
    const signalToSettle = [];
    const quoteToSettle = [];
    let fillCoverage = 0;
    let latencySamples = 0;

    resLog.forEach(e => {
      const settledTs = _obsNum(e.settledTs, null);
      const quoteTs = _obsNum(e.snapshotTs, null);
      const closeTs = _obsNum(e.closeTimeMs, null);
      const fillTs = _obsNum(e.fillTs || e.fillTsMs, null);
      if (!Number.isFinite(settledTs) || !Number.isFinite(closeTs)) return;
      latencySamples += 1;

      const symArr = orchBySym[e.sym] || [];
      let signalTs = null;
      for (let i = symArr.length - 1; i >= 0; i--) {
        const cand = symArr[i];
        if (cand <= closeTs && cand >= (closeTs - 30 * 60_000)) {
          signalTs = cand;
          break;
        }
      }

      if (Number.isFinite(signalTs) && Number.isFinite(quoteTs) && quoteTs >= signalTs) {
        signalToQuote.push(quoteTs - signalTs);
      }
      if (Number.isFinite(quoteTs) && Number.isFinite(fillTs) && fillTs >= quoteTs) {
        quoteToFill.push(fillTs - quoteTs);
      }
      if (Number.isFinite(fillTs) && Number.isFinite(settledTs) && settledTs >= fillTs) {
        fillToSettle.push(settledTs - fillTs);
        fillCoverage += 1;
      } else if (Number.isFinite(quoteTs) && Number.isFinite(settledTs) && settledTs >= quoteTs) {
        quoteToSettle.push(settledTs - quoteTs);
      }
      if (Number.isFinite(signalTs) && Number.isFinite(settledTs) && settledTs >= signalTs) {
        signalToSettle.push(settledTs - signalTs);
      }
    });

    const latency = {
      samples: latencySamples,
      fillCoverage: latencySamples ? fillCoverage / latencySamples : 0,
      signalToQuote: _obsLatencyBuckets(signalToQuote),
      quoteToFill: _obsLatencyBuckets(quoteToFill),
      fillToSettle: _obsLatencyBuckets(fillToSettle),
      signalToSettle: _obsLatencyBuckets(signalToSettle),
      quoteToSettle: _obsLatencyBuckets(quoteToSettle),
    };

    const recentKalshi = kalshiLog.slice(-80);
    const dirConflictCount = recentKalshi.filter(e => e._dirConflict || e.dirConflict).length;
    const proxyMismatchCount = recentKalshi.filter(e => e._proxyMismatch).length;
    const wickCount = recentKalshi.filter(e => e._wickStraddle || e._nearRef).length;
    const recentErrors = kalshiErrors.slice(-80);
    const errByType = {};
    recentErrors.forEach(e => {
      const type = String(e.type || 'unknown');
      errByType[type] = (errByType[type] || 0) + 1;
    });

    const conflictRate = recentKalshi.length ? dirConflictCount / recentKalshi.length : 0;
    const mismatchRate = recentKalshi.length ? proxyMismatchCount / recentKalshi.length : 0;
    const wickRate = recentKalshi.length ? wickCount / recentKalshi.length : 0;
    let driftStatus = 'STABLE';
    if ((quantDrift?.overall_status === 'MAJOR_DRIFT') || mismatchRate > 0.15 || conflictRate > 0.20) driftStatus = 'ELEVATED';
    else if ((quantDrift?.overall_status === 'DRIFT') || mismatchRate > 0.08 || conflictRate > 0.12 || wickRate > 0.20) driftStatus = 'WATCH';

    const featureDrift = {
      driftStatus,
      quant: quantDrift,
      emergencyTools,
      conflictRate,
      mismatchRate,
      wickRate,
      errByType,
      recentErrors: recentErrors.slice(-6),
    };

    const attributionMap = {};
    const addAttr = (name, score, samples = 1, weight = null) => {
      const key = String(name || 'unknown').toUpperCase();
      if (!attributionMap[key]) {
        attributionMap[key] = {
          signal: key,
          score: 0,
          samples: 0,
          weightSum: 0,
          weightN: 0,
        };
      }
      attributionMap[key].score += Number.isFinite(score) ? score : 0;
      attributionMap[key].samples += Number.isFinite(samples) ? samples : 0;
      if (Number.isFinite(weight)) {
        attributionMap[key].weightSum += weight;
        attributionMap[key].weightN += 1;
      }
    };

    if (learningEngine?.getAllReports) {
      const reports = learningEngine.getAllReports() || {};
      Object.values(reports).forEach(rep => {
        if (!rep?.signals) return;
        Object.entries(rep.signals).forEach(([signal, st]) => {
          const acc = _obsNum(st.accuracy, null);
          const smp = _obsNum(st.samples, 0);
          const w = _obsNum(st.weight, null);
          if (!Number.isFinite(acc) || smp <= 0) return;
          addAttr(signal, (acc - 0.5) * smp, smp, w);
        });
      });
    }

    eventsSorted.forEach(e => {
      const sigs = e.signalComponents;
      if (!sigs || typeof sigs !== 'object') return;
      const outcomeSign = e.correct ? 1 : -1;
      Object.entries(sigs).forEach(([name, raw]) => {
        let val = null;
        let weight = null;
        if (typeof raw === 'number') {
          val = raw;
        } else if (raw && typeof raw === 'object') {
          val = _obsNum(raw.contribution, null);
          if (!Number.isFinite(val)) val = _obsNum(raw.value, null);
          if (!Number.isFinite(val)) val = _obsNum(raw.score, null);
          weight = _obsNum(raw.weight, null);
        }
        if (!Number.isFinite(val)) return;
        addAttr(name, outcomeSign * Math.abs(val), 1, weight);
      });
    });

    const attributionRows = Object.values(attributionMap)
      .map(r => ({
        signal: r.signal,
        score: r.score,
        samples: r.samples,
        avgWeight: r.weightN ? r.weightSum / r.weightN : null,
      }))
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 12);

    const sourceContribution = {};
    eventsSorted.forEach(e => {
      sourceContribution[e.source] = (sourceContribution[e.source] || 0) + 1;
    });

    const drawdownBySym = {};
    eventsSorted.forEach(e => {
      const sym = e.sym || 'UNK';
      if (!drawdownBySym[sym]) {
        drawdownBySym[sym] = {
          sym,
          equity: 0,
          peak: 0,
          maxDrawdown: 0,
          currentLossStreak: 0,
          maxLossStreak: 0,
          clusterCount: 0,
          clusters: [],
        };
      }
      const s = drawdownBySym[sym];
      s.equity += e.correct ? 1 : -1;
      s.peak = Math.max(s.peak, s.equity);
      s.maxDrawdown = Math.max(s.maxDrawdown, s.peak - s.equity);
      if (!e.correct) {
        s.currentLossStreak += 1;
        s.maxLossStreak = Math.max(s.maxLossStreak, s.currentLossStreak);
      } else if (s.currentLossStreak > 0) {
        if (s.currentLossStreak >= 3) {
          s.clusterCount += 1;
          s.clusters.push({ len: s.currentLossStreak, ts: e.ts });
        }
        s.currentLossStreak = 0;
      }
    });
    Object.values(drawdownBySym).forEach(s => {
      if (s.currentLossStreak >= 3) {
        s.clusterCount += 1;
        s.clusters.push({ len: s.currentLossStreak, ts: Date.now() });
      }
    });

    const drawdownRows = Object.values(drawdownBySym)
      .sort((a, b) => (b.maxDrawdown - a.maxDrawdown) || (b.maxLossStreak - a.maxLossStreak))
      .slice(0, 10);

    const out = {
      sampleCount: eventsSorted.length,
      regimeRows,
      calibrationRows,
      latency,
      featureDrift,
      network: {
        summary: networkSummary,
        recent: recentNetwork,
      },
      attributionRows,
      sourceContribution,
      drawdownRows,
      updatedAt: Date.now(),
    };

    _observabilityCache = { sig, ts: Date.now(), data: out };
    return out;
  }

function _obsRenderHist(title, hist, accent = 'var(--color-primary)') {
    const max = Math.max(1, ...hist.counts);
    const rows = hist.labels.map((label, i) => {
      const c = hist.counts[i] || 0;
      const width = Math.max(0, Math.min(100, (c / max) * 100));
      return `
        <div style="display:grid;grid-template-columns:60px 1fr 40px;gap:8px;align-items:center;margin:4px 0">
          <span style="font-size:10px;color:var(--color-text-muted)">${label}</span>
          <div style="height:8px;background:var(--color-surface-3);border-radius:999px;overflow:hidden">
            <div style="height:100%;width:${width}%;background:${accent};opacity:0.88"></div>
          </div>
          <span style="font-size:10px;font-family:var(--font-mono);color:var(--color-text)">${c}</span>
        </div>`;
    }).join('');
    return `
      <div class="card" style="padding:12px">
        <div class="card-title" style="margin-bottom:8px">${title}</div>
        ${rows}
      </div>`;
  }
window.APP_OBSERVABILITY = {
  _obsNum, _obsNormRegime, _obsPct, _obsEsc, _obsLatencyBuckets, 
  _obsGetQuantDriftSnapshot, _obsEmergencyToolsSummary, _obsBuildMetrics, _obsRenderHist
};
Object.assign(window, window.APP_OBSERVABILITY);
})();
