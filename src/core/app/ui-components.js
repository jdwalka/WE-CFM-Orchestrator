// UI Components
(function() {
function predictionCard(p) {
    if (!p || !p.sym) {
      console.warn('[predictionCard] Missing prediction object or sym:', p);
      return `<div class="pred-card" style="padding:20px 16px;border-left:4px solid var(--color-red,#ff4444)">
        <div style="font-weight:700;color:var(--color-red,#ff4444);font-size:13px">⚠ Invalid Prediction</div>
        <div style="font-size:11px;color:var(--color-text-muted,#aaa);margin-top:6px">Prediction object missing sym field</div>
      </div>`;
    }
    if (!Number.isFinite(p.score)) {
      console.warn('[predictionCard] Missing score for:', p.sym);
      p.score = 0;
    }
    // ── Verdict ──────────────────────────────────────────────────────────────
    // Priority order:
    //   1. Polymarket certainty (≥90% / ≤10%) — trust near-certain market consensus, never fade
    //   2. CDF modelYesPct — P(close ≥ strike): correct metric for binary contracts (not raw score direction)
    //   3. Raw score direction — fallback when no Polymarket ref is set yet
    //   4. Polymarket tiebreak — when model is neutral and Polymarket has clear edge
    // Raw model score (UP/DOWN) = "will price move?" — WRONG basis for binary "close above strike" contracts.
    // modelYesPct = P(projected target ≥ strike) via normal CDF — this is the RIGHT metric.
    const _k15mCV = window.PredictionMarkets?.getCoin(p.sym);
    const _k15mV = _k15mCV?.kalshi15m ?? null;
    // Kalshi fetching is disabled (user no longer trades there) -- _k15mV is
    // always null now. Prefer the Polymarket 15m Up/Down market directly
    // (fresher/more precise than the blended combinedProb fallback).
    const _poly15mV = _k15mCV?.poly15m ?? null;
    const polymarketProb = _poly15mV?.probability ?? _k15mV?.probability ?? _k15mCV?.combinedProb ?? null;
    const polymarketPct = polymarketProb !== null ? Math.round(polymarketProb * 100) : null;
    const polymarketEdge = polymarketProb !== null ? Math.abs(polymarketProb - 0.5) : null;
    let _kAlignEarly = p.projections?.p15?.polyAlign ?? null;
    if (_kAlignEarly && _k15mV && _kAlignEarly.ticker && _k15mV.ticker && _kAlignEarly.ticker !== _k15mV.ticker) {
      _kAlignEarly = null;
    }
    const _strikeDirEarly = (_kAlignEarly?.strikeDir ?? _k15mV?.strikeDir) === 'below' ? 'below' : 'above';
    const _yesDirEarly = _strikeDirEarly === 'below' ? 'down' : 'up';
    const _noDirEarly = _yesDirEarly === 'up' ? 'down' : 'up';

    // Fetch Grok 15m & Hourly range overlay guidance if available
    const grokOverlayApi = (typeof window !== 'undefined') ? (window.GrokRangeOverlay || window.GrokRangeGrok) : null;
    const grok15mGuidance = grokOverlayApi && typeof grokOverlayApi.getGuidance === 'function'
      ? grokOverlayApi.getGuidance(p.sym, 15)
      : null;
    let grokBinaryCall = null;
    let grokConfPct = null;
    let grokNotesText = '';
    if (grok15mGuidance && !grok15mGuidance.error && (grok15mGuidance.aiCall || grok15mGuidance.call)) {
      const gCall = String(grok15mGuidance.aiCall || grok15mGuidance.call).toUpperCase();
      grokBinaryCall = gCall === 'UP' ? _yesDirEarly : gCall === 'DOWN' ? _noDirEarly : null;
      const cRaw = Number(grok15mGuidance.confidence) || 0.60;
      grokConfPct = cRaw <= 1 ? Math.round(cRaw * 100) : Math.round(cRaw);
      grokNotesText = String(grok15mGuidance.notes || grok15mGuidance.rationale || '').trim();
    }

    const modelDir = p.score > 0.02 ? 'up' : p.score < -0.02 ? 'down' : 'wait';
    const polymarketDir = polymarketProb !== null ? (polymarketProb >= 0.5 ? _yesDirEarly : _noDirEarly) : null;

    const livePathApi = (typeof window !== 'undefined' && window.LivePath15m) || null;
    const livePath = livePathApi
      ? (typeof livePathApi.fromAny === 'function'
          ? livePathApi.fromAny(p.sym, { spot: p.price, poly15m: _poly15mV, modelScore: p.score })
          : livePathApi.resolve(p.sym, { spot: p.price, poly15m: _poly15mV, modelScore: p.score }))
      : null;
    const livePathDir = livePath && livePath.dir
      ? (livePath.dir === 'UP' ? _yesDirEarly : _noDirEarly)
      : null;

    let verdictDir, verdictSource;
    // 15m paint follows the live settlement path (Pyth vs Polymarket PTB,
    // ticks, window return). Model/Grok stay visible as a lean, but they
    // must not lock the green/red label until an extreme swing.

    if (_kAlignEarly?.modelYesPct != null) {
      // Use CDF P(close ≥ strike) — correct for binary contracts
      const myp = _kAlignEarly.modelYesPct;
      if (myp >= 50.5) { verdictDir = _yesDirEarly; verdictSource = 'model-cdf'; }
      else if (myp <= 49.5) { verdictDir = _noDirEarly; verdictSource = 'model-cdf'; }
      else { verdictDir = _yesDirEarly; verdictSource = 'model-cdf-lean'; }
    } else if (modelDir !== 'wait') {
      verdictDir = modelDir;
      verdictSource = 'model';
    } else if (p.score !== 0) {
      verdictDir = p.score > 0 ? _yesDirEarly : _noDirEarly;
      verdictSource = 'model-score-lean';
    } else if (grokBinaryCall) {
      verdictDir = grokBinaryCall;
      verdictSource = 'grok-inference-lean';
    } else if (polymarketDir !== null) {
      verdictDir = polymarketDir;
      verdictSource = 'polymarket-market-lean';
    } else {
      verdictDir = 'up';
      verdictSource = 'default-lean';
    }

    const modelVerdictDir = verdictDir;
    const modelVerdictSource = verdictSource;
    if (livePathDir) {
      verdictDir = livePathDir;
      verdictSource = 'live-path-15m';
    }

    // Safety gate: note late/borderline entry risks without obliterating the binary belief
    const tickerAgeMs = Math.max(0, Date.now() - Number(window._lastTickerFetchTs || 0));
    const isTickerStale = tickerAgeMs > 8_000;
    const msToClose = _k15mV?.closeTime
      ? (new Date(_k15mV.closeTime).getTime() - Date.now())
      : null;
    const inSafetyWindow = Number.isFinite(msToClose)
      && msToClose >= 0
      && msToClose <= 5 * 60_000;
    const isBorderlineStrike = Number.isFinite(_kAlignEarly?.gapPct)
      ? Math.abs(_kAlignEarly.gapPct) < 0.08
      : false;
    const isWeakConviction = Math.abs(Number(p.score || 0)) < 0.18;
    let safetyGuardActive = false;
    let safetyGuardReason = '';
    if (inSafetyWindow && (isTickerStale || isBorderlineStrike || isWeakConviction)) {
      safetyGuardActive = true;
      safetyGuardReason = isTickerStale
        ? 'Stale data in 5m pre-close window'
        : isBorderlineStrike
          ? 'Borderline strike gap in 5m pre-close window'
          : 'Weak conviction in 5m pre-close window';
    }

    // Targeted guard (ultra-late only)
    const confNorm = _normalizeConfidence(p.confidence) ?? 0;
    const isSemiConfidence = confNorm >= 0.40 && confNorm < 0.70;
    const isCrowdConflict =
      polymarketDir !== null && modelDir !== 'wait' && modelDir !== polymarketDir;
    const isUltraLateWindow =
      Number.isFinite(msToClose) && msToClose >= 0 && msToClose <= 45_000;

    if (isSemiConfidence && isCrowdConflict && isUltraLateWindow) {
      safetyGuardActive = true;
      safetyGuardReason = 'Semi-confidence crowd conflict in last 45s';
    }

    // Fade flag: raw price direction conflicts with Polymarket crowd
    const _fadeActive = polymarketDir !== null && modelDir !== 'wait' && modelDir !== polymarketDir;
    const _fadeSolid = _fadeActive && Math.abs(p.score) >= 0.20;
    const _fadeSoft = _fadeActive && !_fadeSolid;
    const _betAction = verdictDir === _yesDirEarly ? 'YES' : verdictDir === _noDirEarly ? 'NO' : null;
    const compositeEdge = 0.75 * Math.abs(p.score) + 0.25 * (polymarketEdge ?? 0);

    const isYesVerdict = verdictDir === _yesDirEarly;
    const binaryOutcomeText = isYesVerdict ? 'BUY YES' : 'BUY NO';
    const verdictMain = isYesVerdict ? `▲ ${binaryOutcomeText}` : `▼ ${binaryOutcomeText}`;
    const strength = safetyGuardActive ? 'GUARDED'
      : compositeEdge >= 0.42 ? 'STRONG' : compositeEdge >= 0.22 ? 'MODERATE' : 'LEAN';
    const scoreStr = Number.isFinite(p.score) ? (p.score > 0 ? '+' : '') + p.score.toFixed(2) : '—';

    // ── Pre-compute model probability (outer scope — used in verdict banner + comparison bar) ──
    const _cdfYesPct = Number.isFinite(_kAlignEarly?.modelYesPct) ? _kAlignEarly.modelYesPct : null;
    const _modelUpPct = _cdfYesPct != null
      ? Math.round(_cdfYesPct)
      : Math.round(Math.min(99, Math.max(1, 50 + (p.score || 0) * 50)));
    const _modelDownPct = 100 - _modelUpPct;
    const _modelYesPctCard = _cdfYesPct ?? (_strikeDirEarly === 'below' ? _modelDownPct : _modelUpPct);
    const _modelProbStr = modelVerdictDir === 'up' ? `${_modelUpPct}% UP`
      : modelVerdictDir === 'down' ? `${_modelDownPct}% DOWN` : 'NEUTRAL';
    const _modelProbColor = modelVerdictDir === 'up' ? 'var(--color-green)'
      : modelVerdictDir === 'down' ? 'var(--color-red)' : 'var(--color-text-muted)';
    const _liveKProbCard = window.PredictionMarkets?.getCoin?.(p.sym)?.kalshi15m?.probability ?? polymarketProb;
    const _liveKPctCard = _liveKProbCard != null ? Math.round(_liveKProbCard * 100) : null;
    const _edgePpCard = _liveKPctCard != null ? Math.abs(_modelYesPctCard - _liveKPctCard) : null;
    const _liveKDirCard = _liveKProbCard == null ? null : (_liveKProbCard >= 0.5 ? _yesDirEarly : _noDirEarly);
    const _liveKColorCard = _liveKProbCard == null ? 'var(--color-text-muted)'
      : _liveKDirCard === 'up' ? 'var(--color-green)' : 'var(--color-red)';

    // Session badge (informational only — session multipliers removed; all sessions treated equally)
    const _nowUTC = new Date().getUTCHours();
    const isLondonSession = _nowUTC >= 7 && _nowUTC < 12;
    const londonBadge = '';

    // Model calibration notices for problem coins
    const _uncalibrated = { HYPE: 'Limited data — extreme thresholds active', DOGE: 'Meme-coin regime — higher threshold required' };
    const calibBadge = _uncalibrated[p.sym]
      ? `<span class="pred-calib-warn" title="${_uncalibrated[p.sym]}">⚠ ${p.sym === 'HYPE' ? 'HYPE: low calibration' : 'DOGE: noisy regime'}</span>`
      : '';

    // Weak signal notice — light bucket (absScore <0.25) in model-only verdict has poor backtest WR
    const _isLightModel = modelVerdictSource === 'model' && Math.abs(p.score) < 0.25 && modelVerdictDir !== 'wait';
    const weakBadge = _isLightModel
      ? `<span class="pred-weak-warn" title="Low-conviction signal — backtest accuracy below 50%">⚡ WEAK</span>`
      : '';
    const safetyBadge = verdictSource.startsWith('safety-')
      ? `<span class="pred-weak-warn" title="Protected by safety gate (${verdictSource.replace('safety-', '')})">🛡 WAIT GUARD</span>`
      : '';
    const hcConfThreshold = 0.62;
    const hcEdgeThreshold = 0.20;
    const hcPass =
      verdictDir !== 'wait' &&
      !verdictSource.startsWith('safety-') &&
      confNorm >= hcConfThreshold &&
      compositeEdge >= hcEdgeThreshold;
    const hcBadge = isHighConfidenceOverlayOn()
      ? `<span class="pred-source-badge ${hcPass ? 'polymarket-align' : 'polymarket-fade'}" title="Advisory overlay only; does not alter model verdict routing">${hcPass ? '✅ HC PASS' : '⏸ HC HOLD'}</span>`
      : '';
    const hcRationale = (() => {
      if (!isHighConfidenceOverlayOn()) return '';
      if (hcPass) {
        return `High-confidence overlay: PASS (conf ${Math.round(confNorm * 100)}%, edge ${compositeEdge.toFixed(2)}).`;
      }
      if (verdictDir === 'wait') {
        return `High-confidence overlay: HOLD until model exits WAIT and clears confidence/edge thresholds.`;
      }
      if (verdictSource.startsWith('safety-')) {
        return `High-confidence overlay: HOLD due to active safety guard.`;
      }
      if (confNorm < hcConfThreshold) {
        return `High-confidence overlay: HOLD (confidence ${Math.round(confNorm * 100)}% < ${Math.round(hcConfThreshold * 100)}% threshold).`;
      }
      return `High-confidence overlay: HOLD (edge ${compositeEdge.toFixed(2)} < ${hcEdgeThreshold.toFixed(2)} threshold).`;
    })();
    const waitRationale = (() => {
      if (verdictDir !== 'wait') return '';

      const modelYesPct = Number(_kAlignEarly?.modelYesPct);
      if (verdictSource === 'model-cdf-neutral' && Number.isFinite(modelYesPct)) {
        return `Model thinking: CDF neutral at ${modelYesPct.toFixed(1)}% YES (needs >=58% for YES direction or <=42% for NO direction).`;
      }
      if (verdictSource === 'model-uncertain') {
        return `Model thinking: low conviction score ${scoreStr} (needs >+0.12 for UP or <-0.12 for DOWN).`;
      }
      if (verdictSource === 'safety-stale-data') {
        return `Model thinking: signal blocked by stale ticker data (${Math.round(tickerAgeMs / 1000)}s old) inside the 5-minute pre-close guard.`;
      }
      if (verdictSource === 'safety-borderline-strike') {
        const gap = Number(_kAlignEarly?.gapPct);
        return `Model thinking: strike gap too narrow (${Number.isFinite(gap) ? gap.toFixed(3) : 'n/a'}%) inside the 5-minute pre-close guard.`;
      }
      if (verdictSource === 'safety-weak-conviction') {
        return `Model thinking: weak score ${scoreStr} in the 5-minute pre-close guard (requires stronger than ±0.18).`;
      }
      if (verdictSource === 'safety-semi-confidence-ultra-late') {
        return `Model thinking: semi-confidence (${Math.round(confNorm * 100)}%) with crowd conflict in the last 45 seconds, so entry is blocked.`;
      }
      return `Model thinking: waiting for stronger directional confirmation.`;
    })();
    const llmRegime = p.llm?.regime || p.diagnostics?.llmRegime || null;
    const llmConfidence = Number(p.llm?.confidence || p.diagnostics?.llmConfidence || 0);
    const llmNotes = String(p.llm?.notes || p.diagnostics?.llmNotes || '').trim();
    const asi1Brief = window.Asi1PreContract?.get?.(p.sym);
    const asi1Notes = String(asi1Brief?.notes || asi1Brief?.primaryRationale || '').trim();
    const displayNotes = asi1Notes || llmNotes;
    const thoughtsProvider = String(
      asi1Brief?.provider || p.llm?.provider || p.diagnostics?.llmProvider || 'ASI1'
    ).toUpperCase();
    const thoughtsModel = asi1Brief?.model || p.llm?.model || '';
    const thoughtsRegime = asi1Brief?.regime || llmRegime || 'Mixed Regime';
    const preAction = asi1Brief?.nullified ? 'USE_RAW' : (asi1Brief?.preContract?.action || '');
    const truthBadge = window.InferenceTruthGuard?.renderBadgeHtml?.(asi1Brief || p.llm) || '';
    let llmPatterns = p.llm?.market_patterns || p.diagnostics?.market_patterns || null;
    if (Array.isArray(llmPatterns)) llmPatterns = llmPatterns.join(', ');
    const llmBadge = llmRegime && llmRegime !== 'unknown'
      ? `<span class="pred-source-badge" style="border-color:rgba(143,168,255,0.45);color:#8fa8ff">🧠 LLM ${escapeHtml(llmRegime.replace(/_/g, ' '))}${llmConfidence ? ` ${Math.round(llmConfidence)}%` : ''}</span>`
      : '';
    const { primary: ratPrimary, secondary: ratSecondary } = getDecisionRationale(p);

    const arrow = p.score > 0.3 ? '\u2B06' : p.score < -0.3 ? '\u2B07' : p.score > 0 ? '\u2197' : p.score < 0 ? '\u2198' : '\u2194';
    const confClass = p.score > 0 ? 'bull' : p.score < 0 ? 'bear' : 'flat';
    const ind = p.indicators || {};
    const hasBacktest = !!p.backtest;
    const reliabilityPct = hasBacktest ? Math.round((p.backtest.summary?.reliability || 0) * 100) : 0;
    const tradeFitPct = hasBacktest ? Math.round(((p.backtest.summary?.tradeFit ?? p.backtest.summary?.reliability ?? 0) * 100)) : 0;
    const advanced = p.backtest?.advanced || null;
    const advancedVol = advanced?.volatility || null;
    const advancedQualityPct = advanced ? Math.round((advanced.summary?.reliability || 0) * 100) : 0;
    const advancedFitPct = advanced ? Math.round((advanced.summary?.tradeFit || advanced.summary?.reliability || 0) * 100) : 0;
    const agreementPct = Math.round((p.diagnostics?.agreement || 0.5) * 100);
    const conflictPct = Math.round((p.diagnostics?.conflict || 0) * 100);
    const qualityLabel = hasBacktest ? (p.diagnostics?.qualityLabel || 'Backtest mixed') : 'Backtest unavailable';
    const tradeFitLabel = hasBacktest ? (p.diagnostics?.tradeFitLabel || 'Timing mixed') : 'Timing unavailable';
    const preferredHorizon = p.diagnostics?.preferredHorizon || p.backtest?.summary?.preferredHorizon || 5;
    const fastTiming = p.diagnostics?.fastTiming || null;
    const driverSummary = p.diagnostics?.driverSummary || 'No dominant driver cluster';
    const topDrivers = Array.isArray(p.diagnostics?.topDrivers) ? p.diagnostics.topDrivers.slice(0, 3) : [];
    const vetoReason = p.diagnostics?.vetoReason || '';
    const inBufferZone = !!p.diagnostics?.inBufferZone;
    const routedAction = p.diagnostics?.routedAction || 'watch';
    const routedSummary = p.diagnostics?.routedSummary || driverSummary;
    const routedRiskFlags = Array.isArray(p.diagnostics?.routedRiskFlags) ? p.diagnostics.routedRiskFlags.slice(0, 3) : [];
    const mdt = p.mdt || null;
    const reversalFlags = Array.isArray(p.reversalFlags) ? p.reversalFlags : [];
    const mdtVerdict = mdt?.verdict || 'HOLD';
    const mdtBias = mdt?.bias || 'neutral';
    const mdtConf = mdt?.biasConf || 0;
    const mdtPreemptive = !!mdt?.preemptive;
    const mdtLayer = mdt?.layer || 6;
    const mdtRegimeLabel = mdt?.regimeLabel || 'Flat / Ranging';
    const mdtPath = Array.isArray(mdt?.path) ? mdt.path : [];
    const rfRow = reversalFlags.length ? `
      <div class="rf-row">
        ${reversalFlags.map(f => `
          <span class="rf-badge rf-${f.severity} rf-${f.bias}" title="${f.desc}">
            ${f.severity === 'critical' ? '🔴' : f.severity === 'alert' ? '🟠' : '🟡'}
            ${f.label}
          </span>
        `).join('')}
      </div>` : '';
    const expanded = !predictionCollapsed.has(p.sym);
    const horizonRows = PREDICTION_HORIZONS.map(horizonMin => ({
      horizonMin,
      label: `${horizonMin}m`,
      stats: p.backtest?.[`h${horizonMin}`] || null,
      projection: p.projections?.[`p${horizonMin}`] || null,
    }));
    const setup15 = (() => {
      const h15 = p.backtest?.h15 || null;
      if (!h15 || !h15.activeSignals) {
        return { label: '15m setup: pending', cls: 'flat', detail: 'waiting for h15 samples' };
      }
      const wr = Number(h15.winRate) || 0;
      const edge = Number(h15.avgSignedReturn) || 0;
      if (wr >= 55 && edge > 0) {
        return { label: '15m setup: ready', cls: 'bull', detail: `${wr.toFixed(1)}% hit · ${fmtPct(edge)} edge` };
      }
      if (wr < 45 || edge <= 0) {
        return { label: '15m setup: caution', cls: 'bear', detail: `${wr.toFixed(1)}% hit · ${fmtPct(edge)} edge` };
      }
      return { label: '15m setup: mixed', cls: 'flat', detail: `${wr.toFixed(1)}% hit · ${fmtPct(edge)} edge` };
    })();
    const depthMeta = ind.orderBookImbalance?.meta || null;
    const depth10 = depthMeta?.levels?.level10 || null;
    const depth20 = depthMeta?.levels?.level20 || null;
    const velocityMeta = ind.imbalanceVelocity?.meta || null;
    const liquidityMeta = ind.liquidityDepth?.meta || null;
    const fmtDepthImb = value => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(0)}%` : '—';
    const depthClass = value => Number(value) > 0.12 ? 'bull' : Number(value) < -0.12 ? 'bear' : 'flat';
    const depthRows = depthMeta ? `
      <div class="ind-item"><span class="ind-name">Depth 10/20</span><span class="ind-val ${depthClass(depthMeta.rawImbalance)}">10L ${fmtDepthImb(depth10?.imbalance)} / 20L ${fmtDepthImb(depth20?.imbalance)}</span></div>
      <div class="ind-item"><span class="ind-name">Imb Velocity</span><span class="ind-val ${depthClass(velocityMeta?.value)}">${velocityMeta?.band || 'stable'} · ${fmtDepthImb(velocityMeta?.value)}</span></div>
      <div class="ind-item"><span class="ind-name">Liquidity</span><span class="ind-val ${liquidityMeta?.band === 'fragile' || liquidityMeta?.band === 'thin' ? 'bear' : liquidityMeta?.band === 'deep' ? 'bull' : 'flat'}">${liquidityMeta?.band || 'unknown'} · 20L ${fmtCompactUsd(liquidityMeta?.notional20)}</span></div>
    ` : '';

    function indClass(sig) { return sig > 0.15 ? 'bull' : sig < -0.15 ? 'bear' : 'flat'; }
    function btClass(stats) {
      if (!stats || !stats.activeSignals) return 'flat';
      if (stats.winRate >= 55 && stats.avgSignedReturn > 0) return 'bull';
      if (stats.winRate < 45 && stats.avgSignedReturn < 0) return 'bear';
      return 'flat';
    }
    function routeClass(action) {
      return action === 'trade' ? 'bull' : action === 'invalidated' ? 'bear' : 'flat';
    }

    // Scalp setups count for this coin
    const mySetups = (p.scalpSetups || []);
    const scalpCount = mySetups.filter(s => s.type.startsWith('scalp_')).length;
    const contrarianCount = mySetups.filter(s => s.type.startsWith('contrarian_')).length;

    // ---- Polymarket 15M Up/Down live market row ----
    // YES resolves if closePrice ≥ targetPriceNum (meet or exceed the reference).
    // NO  resolves if closePrice  < targetPriceNum (falls below the reference).
    // Kalshi fetching is disabled -- _k15m is always null now. Source this row
    // from Polymarket's 15m Up/Down market instead (poly15m), which is always
    // "beat the opening price" (no variable strike direction like Kalshi had).
    const _k15mCoin = window.PredictionMarkets?.getCoin(p.sym);
    const _k15m = _k15mCoin?.kalshi15m ?? null;
    const _poly15m = _k15mCoin?.poly15m ?? null;
    const _kProb = ind.mktSentiment?.kalshi ?? _poly15m?.probability ?? _k15m?.probability ?? _k15mCoin?.combinedProb ?? null;
    let _kAlign = p.projections?.p15?.polyAlign ?? null;
    if (_kAlign && _k15m && _kAlign.ticker && _k15m.ticker && _kAlign.ticker !== _k15m.ticker) {
      _kAlign = null;
    }

    // Debug: log data availability on first few renders
    const _debugPolymarket = window._debugPolymarketCount = (window._debugPolymarketCount || 0) + 1;
    if (_debugPolymarket <= 3) {
      console.log(`[polymarket15mRow] ${p.sym}: _k15mCoin=${!!_k15mCoin}, _k15m=${!!_k15m}, _kProb=${_kProb}, combinedProb=${_k15mCoin?.combinedProb}, mktSentiment.kalshi=${ind.mktSentiment?.kalshi}`);
    }

    const polymarket15mRow = (() => {
      if (_kProb === null) return '';

      // YES and NO are complementary — always sum to 100%
      const kYesPct = Math.round(_kProb * 100);
      const kNoPct = 100 - kYesPct;
      // Polymarket Up/Down has no variable strike direction like Kalshi did --
      // it's always "beat the opening price" -- so default to 'above' unless
      // an actual Kalshi alignment object is still present with one set.
      const _rowStrikeDir = _poly15m ? 'above' : ((_kAlign?.strikeDir ?? _k15m?.strikeDir ?? _strikeDirEarly) === 'below' ? 'below' : 'above');
      const _rowYesDir = _rowStrikeDir === 'below' ? 'down' : 'up';
      const _rowNoDir = _rowYesDir === 'up' ? 'down' : 'up';
      const kDir = _kProb >= 0.5 ? _rowYesDir : _rowNoDir;
      const kCls = kDir === 'up' ? 'bull' : 'bear';

      let probLine;
      if (_kAlign?.modelYesPct != null) {
        // Reference price is set — show full YES/NO breakdown for both sides
        const mYesPct = _kAlign.modelYesPct;
        const mNoPct = 100 - mYesPct;
        const div = _kAlign.divergence;
        const status = _kAlign.status;

        const divBadge = status === 'divergent'
          ? `<span class="k15-divergent">⚡ ${div}pp</span>`
          : status === 'soft-split'
            ? `<span class="k15-soft-split">${div}pp</span>`
            : `<span class="k15-agree">✓</span>`;

        // K: YES 68% / NO 32%   M: YES 72% / NO 28%   ⚡badge
        // YES = price meets/exceeds ref = bullish = always green (k15-yes)
        // NO  = price stays below ref   = bearish = always red   (k15-no)
        probLine =
          `<span class="k15-side-label">K</span>` +
          `<span class="k15-yes">Y ${kYesPct}%</span>` +
          `<span class="k15-sep">/</span>` +
          `<span class="k15-no">N ${kNoPct}%</span>` +
          `  <span class="k15-side-label">M</span>` +
          `<span class="k15-yes">Y ${mYesPct}%</span>` +
          `<span class="k15-sep">/</span>` +
          `<span class="k15-no">N ${mNoPct}%</span>` +
          ` ${divBadge}`;
      } else {
        // Reference TBD — show direction + YES/NO split while waiting
        const agree = verdictDir !== 'wait' && verdictDir === kDir;
        const disagree = verdictDir !== 'wait' && verdictDir !== kDir;
        const agBadge = agree ? `<span class="k15-agree">✓ AGREE</span>`
          : disagree ? `<span class="k15-disagree">⚡ DIVERGENT</span>` : '';
        probLine =
          `<span class="k15-yes">Y ${kYesPct}%</span>` +
          `<span class="k15-sep">/</span>` +
          `<span class="k15-no">N ${kNoPct}%</span>` +
          ` ${agBadge}`;
      }

      // Reference threshold — "Beat $85.32" for above, "Below $85.32" for below.
      // Prefer the raw API string (targetPrice) to avoid rounding.
      const refTarget = _poly15m?.targetPrice ?? _k15m?.targetPrice ?? (_kAlign?.ref != null ? fmtPrice(_kAlign.ref, p.sym) : null);
      const refVerb = _rowStrikeDir === 'below' ? 'Below' : 'Beat';
      const refLine = refTarget
        ? ` <span class="k15-target">${refVerb} ${refTarget}</span>`
        : '';

      // Gap from current price to reference — show dollar amount + % + BORDERLINE warning
      const _gapRaw = _kAlign?.gapPct ?? null;
      const _gapDollar = (_kAlign?.ref != null && p.price > 0)
        ? (_kAlign.ref - p.price) : null;
      const _gapDec = window.CoinPrecision?.getCoinDeltaDecimals
        ? window.CoinPrecision.getCoinDeltaDecimals(p.sym)
        : (/^DOGE$/i.test(p.sym) ? 4 : /^XRP$/i.test(p.sym) ? 4 : 2);
      const _borderline = _gapRaw !== null && Math.abs(_gapRaw) < 0.12; // within 0.12% of strike
      const gapLine = _gapRaw !== null && Math.abs(_gapRaw) > 0.001
        ? ` <span class="k15-gap ${_gapRaw > 0 ? 'k15-gap-up' : 'k15-gap-down'} ${_borderline ? 'k15-borderline' : ''}">` +
        `${_gapRaw > 0 ? '▲' : '▼'} ${_gapDollar !== null ? '$' + Math.abs(_gapDollar).toFixed(_gapDec) + ' ' : ''}` +
        `(${_gapRaw > 0 ? '+' : ''}${_gapRaw.toFixed(3)}%)` +
        `${_borderline ? ' ⚠ BORDERLINE' : ''}</span>`
        : (_gapRaw !== null ? ` <span class="k15-gap k15-gap-down k15-borderline">✓ AT STRIKE</span>` : '');


      // Countdown to settlement
      let countdown = '';
      const _closeTimeRow = _poly15m?.closeTime ?? _k15m?.closeTime;
      if (_closeTimeRow) {
        const msl = new Date(_closeTimeRow).getTime() - Date.now();
        const closeUtc4 = formatUtc4Time(_closeTimeRow);
        if (msl > 0) {
          const ts = Math.floor(msl / 1000);
          countdown = ` <span class="k15-expiry" data-close-ms="${new Date(_closeTimeRow).getTime()}">⏱ ${Math.floor(ts / 60)}m${String(ts % 60).padStart(2, '0')}s · UTC-4 ${closeUtc4}</span>`;
        } else {
          countdown = ` <span class="k15-expiry k15-settling">⏱ SETTLING</span>`;
        }
      }

      const cfmRow = (() => {
        const cfmData = window.CFMEngine?.getAll ? window.CFMEngine.getAll()[p.sym] : null;
        if (!cfmData || !cfmData.bias) return '';
        const dir = cfmData.bias === 'up' ? 'bull' : cfmData.bias === 'down' ? 'bear' : 'flat';
        const mktContext = window.tickers?.[p.sym] ? `5m Δ ${((window.tickers[p.sym].close - window.tickers[p.sym].open) / window.tickers[p.sym].open * 100).toFixed(2)}%` : '';
        return `<div class="ind-item"><span class="ind-name">CFM Context</span><span class="ind-val ${dir}">${String(cfmData.bias).toUpperCase()} · ${mktContext}</span></div>`;
      })();

      // Kalshi fetching is disabled -- never show "Kalshi" here, that was the
      // label flickering back and forth whenever poly15m was momentarily null
      // between its own refresh cycles (a data gap, not evidence of Kalshi
      // data existing).
      const _rowLabel = 'Polymarket 15M';
      return `<div class="ind-item k15m-row"><span class="ind-name">${_rowLabel}</span><span class="ind-val ${kCls}">${probLine}${refLine}${gapLine}${countdown}</span></div>${cfmRow}`;
    })();

    const model5mRow = (() => {
      const p5 = p.projections?.p5;
      if (!p5) return '';
      const dir = p5.target > p.price ? 'UP' : 'DOWN';
      const cls = dir === 'UP' ? 'bull' : 'bear';
      const gapPct = ((p5.target - p.price) / p.price) * 100;
      const gapDec = window.CoinPrecision?.getCoinDeltaDecimals
        ? window.CoinPrecision.getCoinDeltaDecimals(p.sym)
        : (/^DOGE$/i.test(p.sym) ? 4 : /^XRP$/i.test(p.sym) ? 4 : 2);
      const targetStr = window.CoinPrecision?.formatCoinStrike
        ? window.CoinPrecision.formatCoinStrike(p.sym, p5.target)
        : fmtPrice(p5.target, p.sym);
      const gapLine = ` <span class="k15-gap ${gapPct > 0 ? 'k15-gap-up' : 'k15-gap-down'}">${gapPct > 0 ? '▲' : '▼'} $${gapDollar.toFixed(gapDec)} (${gapPct > 0 ? '+' : ''}${gapPct.toFixed(3)}%)</span>`;
      return `<div class="ind-item k15m-row" style="background:rgba(255,255,255,0.03); border-left:2px solid var(--color-${dir === 'UP' ? 'green' : 'red'}); padding-left: 6px;"><span class="ind-name">Model 5M</span><span class="ind-val ${cls}"><span class="k15-side-label" style="opacity:0.6">PROJ</span><span class="k15-${dir.toLowerCase()}" style="font-weight:700">${dir}</span><span class="k15-target"> ≥ ${targetStr}</span>${gapLine}</span></div>`;

    })();

    const lazerRow = (() => {
      const ms = window.tickers?.[p.sym]?.microstructure;
      if (!ms || !ms.signal) return '';
      
      const sig = ms.signal;
      const isAccel = sig === "MOMENTUM_ACCELERATING";
      const isExhaust = sig === "MOMENTUM_EXHAUSTION";
      const dir = ms.velocity > 0 ? "UP" : "DOWN";
      
      let color = "var(--color-text-muted)";
      let icon = "➡️";
      let text = "FLAT";
      
      if (isAccel) {
        color = dir === "UP" ? "var(--color-green)" : "var(--color-red)";
        icon = "🔥";
        text = "ACCELERATING";
      } else if (isExhaust) {
        color = "var(--color-orange)";
        icon = "⚠️";
        text = "EXHAUSTION";
      }
      
      return `<div class="ind-item k15m-row" style="background:rgba(255,255,255,0.03); border-left:2px solid ${color}; padding-left: 6px;">
        <span class="ind-name">Pyth Lazer 5M</span>
        <span class="ind-val" style="color:${color}; font-weight:700; display:flex; align-items:center; gap:6px;">
          <span>${icon} MOMENTUM ${text} ${dir}</span>
          <span style="font-size:9px; opacity:0.8; font-family:var(--font-mono);">(Vel: ${Number(ms.velocity).toFixed(2)})</span>
        </span>
      </div>`;
    })();

    return `
      <div class="pred-card ${p.signal} ${expanded ? 'expanded' : ''}" data-testid="pred-${p.sym}" data-pred-toggle="${p.sym}"
           style="border-left: 4px solid ${verdictDir === 'up' ? 'var(--color-green)' : verdictDir === 'down' ? 'var(--color-red)' : 'var(--color-border)'}">

        ${displayNotes ? `
        <div class="ai-thoughts-popup" style="
          margin: 0 0 12px 0;
          padding: 16px;
          border-radius: 8px;
          background: linear-gradient(135deg, rgba(25, 30, 45, 0.95), rgba(15, 20, 30, 0.98));
          border: 1px solid rgba(143, 168, 255, 0.35);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
          font-family: 'Inter', 'Outfit', 'Segoe UI', sans-serif;
          position: relative;
        ">
          <div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#a5b4fc;margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:14px;">✨</span> <span>${escapeHtml(thoughtsProvider)} PRE-CONTRACT</span>
            ${thoughtsModel ? `<span style="font-size:9px;opacity:0.8;font-weight:600;">${escapeHtml(thoughtsModel)}</span>` : ''}
            <span style="font-size:9px;padding:2px 8px;border-radius:999px;background:rgba(165, 180, 252, 0.15);color:#c7d2fe;letter-spacing:0.5px;">${escapeHtml(String(thoughtsRegime).replace(/_/g, ' '))}</span>
            ${asi1Brief?.call ? `<span style="font-size:9px;padding:2px 8px;border-radius:999px;background:${asi1Brief.call === 'UP' ? 'rgba(0,230,118,0.2)' : 'rgba(255,82,82,0.2)'};color:${asi1Brief.call === 'UP' ? '#00e676' : '#ff8a80'};font-weight:800;">CALL ${escapeHtml(asi1Brief.call)}</span>` : ''}
            ${asi1Brief?.aiCallOriginal && asi1Brief?.nullified ? `<span style="font-size:9px;color:#fca5a5;text-decoration:line-through;">was ${escapeHtml(asi1Brief.aiCallOriginal)}</span>` : ''}
            ${truthBadge}
            ${preAction ? `<span style="font-size:9px;padding:2px 8px;border-radius:999px;background:rgba(255,193,7,0.15);color:#ffe082;">${escapeHtml(preAction)}</span>` : ''}
          </div>
          <div style="font-size:13px;color:#f8fafc;line-height:1.6;font-weight:400;white-space:pre-wrap;">${escapeHtml(displayNotes)}</div>
          ${asi1Brief?.preContract?.invalidation ? `
          <div style="margin-top:8px;font-size:11px;color:#fca5a5;">Invalidation: ${escapeHtml(String(asi1Brief.preContract.invalidation))}</div>` : ''}
          ${(llmPatterns || asi1Brief?.marketPatterns) ? `
          <div style="margin-top:10px;font-size:11px;color:#cbd5e1;background:rgba(165,180,252,0.08);padding:8px 12px;border-radius:6px;border-left:3px solid #a5b4fc;">
            <strong style="color:#a5b4fc;text-transform:uppercase;letter-spacing:0.5px;">Detected Patterns:</strong><br>
            <span style="font-family:var(--font-mono);">${escapeHtml(String(asi1Brief?.marketPatterns || llmPatterns))}</span>
          </div>` : ''}
        </div>` : ''}

        <!-- Header: always visible -->
        <div class="pred-header">
          <div class="pred-coin-icon" style="background:${p.color}22;color:${p.color}">${coinIcon(p.sym)}</div>
          <div class="pred-coin-info">
            <div class="pred-coin-sym">${p.sym}</div>
            <div class="pred-coin-name">${p.name}</div>
          </div>
          <div>
            <div class="pred-coin-price">${fmtPrice(p.price, p.sym)}</div>
            <div class="pred-coin-src">${p.source === 'error'

        ? `<span style="color:var(--color-orange,#f90);font-size:9px">⚠ ${p.error ? p.error.slice(0, 50) : 'compute error'} — will retry</span>`
        : p.source === 'loading'
          ? `<span style="color:var(--color-text-muted,#888);font-size:9px">⏳ loading 15m pooled candles…</span>`
          : `${p.source || 'partial'} &middot; ${p.candleCount15m || p.candleCount || '?'} x 15m (pooled from exchanges: WS+CB+BIN+G etc.)${p.candleCount1m ? ` · ${p.candleCount1m} x 1m` : ''}`
      }</div>
          </div>
          ${p._15mPoolingDebug ? `
          <div style="font-size:8px;color:#ffeb3b;margin-top:2px;background:rgba(0,0,0,0.3);padding:2px 4px;border-radius:2px;">
            15m POOL DEBUG (exchanges): WS=${p._15mPoolingDebug.ws} CB=${p._15mPoolingDebug.cb} BIN=${p._15mPoolingDebug.bin} G=${p._15mPoolingDebug.gecko||0} → pooled=${p._15mPoolingDebug.pooled} | cacheSrc=${p._15mPoolingDebug.sourceInCache || 'n/a'} ${p._15mPoolingDebug.fallbackUsed ? '(5m fallback used)' : ''}
          </div>` : `
          <div style="font-size:8px;color:#ffeb3b;margin-top:2px;background:rgba(0,0,0,0.2);padding:2px 4px;border-radius:2px;">
            15m POOL: ${p.candleCount15m || '?'} bars pooled from exchanges (WS/CB/BIN) - see [15mPool] console logs for per-source counts or click Refresh
          </div>`}
          <div class="pred-expand-icon">${expanded ? '−' : '+'}</div>
        </div>

        <!-- Verdict Banner: always visible — this is the primary signal -->
        <div class="pred-verdict ${verdictDir}">
          <div class="pred-verdict-call">
            <span class="pred-verdict-main">${verdictMain}</span>
            <span class="pred-verdict-strength">${strength}</span>
          </div>
          <div class="pred-verdict-meta">
            ${livePathDir ? `<span class="pred-source-badge" style="border-color:${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'};color:${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'}" title="${escapeHtml(livePath.reason || 'live path')}">LIVE ${livePath.dir}${Number.isFinite(livePath.bps) ? ` ${livePath.bps >= 0 ? '+' : ''}${livePath.bps.toFixed(1)}bps` : ''}</span>` : ''}
            <span class="pred-source-badge model">MODEL</span>
            ${llmBadge}
            ${_liveKPctCard !== null
        ? `<span class="pred-source-badge ${_fadeActive ? 'polymarket-fade' : 'polymarket-align'}">${_fadeActive ? '⚡ ' : ''}POLYMARKET ${_liveKPctCard}% YES</span>`
        : ''}
            <span style="color:${_modelProbColor};font-weight:700">${_modelProbStr}</span>
            <span>·</span>
            <span>${p.confidence}% conf</span>
            ${grokBinaryCall ? `<span class="pred-source-badge" style="border-color:rgba(0,229,255,0.45);color:#00e5ff" title="${escapeHtml(grokNotesText)}">🤖 GROK ${grok15mGuidance.aiCall || grok15mGuidance.call} ${grokConfPct}%</span>` : ''}
            ${_edgePpCard != null && _edgePpCard >= 10 ? `<span style="color:${_edgePpCard >= 20 ? 'var(--color-green)' : '#ffd700'};font-weight:800;font-size:9px;padding:1px 5px;border-radius:3px;background:${_edgePpCard >= 20 ? 'rgba(38,212,126,0.12)' : 'rgba(255,215,0,0.12)'}">${_edgePpCard}pp ${_fadeActive ? 'FADE' : 'EDGE'}</span>` : ''}
            ${londonBadge}${calibBadge}${weakBadge}${safetyBadge}${hcBadge}
            <span style="font-size:9px;padding:2px 6px;border-radius:9999px;background:var(--color-surface-2);color:${setup15.cls === 'bull' ? 'var(--color-green)' : setup15.cls === 'bear' ? 'var(--color-red)' : 'var(--color-text-muted)'};font-weight:700;text-transform:uppercase">${setup15.label}</span>
          </div>
          ${(p.llm?.ai_wording?.wait_rationale) ? `<div class="pred-verdict-rationale" style="color:#8fa8ff"><span style="font-weight:700">✨ AI:</span> ${escapeHtml(p.llm.ai_wording.wait_rationale)}</div>` : waitRationale ? `<div class="pred-verdict-rationale">${waitRationale}</div>` : ''}
          ${(p.llm?.ai_wording?.high_confidence_rationale) ? `<div class="pred-verdict-rationale" style="color:#8fa8ff"><span style="font-weight:700">✨ AI:</span> ${escapeHtml(p.llm.ai_wording.high_confidence_rationale)}</div>` : hcRationale ? `<div class="pred-verdict-rationale">${hcRationale}</div>` : ''}
          ${(p.llm?.ai_wording?.primary_rationale) ? `<div class="pred-verdict-rationale" style="color:#8fa8ff"><span style="font-weight:700">✨ AI:</span> ${escapeHtml(p.llm.ai_wording.primary_rationale)}</div>` : ratPrimary ? `<div class="pred-verdict-rationale">${ratPrimary}</div>` : ''}
          <div class="pred-verdict-bar-wrap">
            <div class="pred-verdict-bar-fill ${verdictDir}" style="width:${p.confidence}%"></div>
          </div>
          <!-- Projected Binary Decision & Countdown Box -->
          <div class="binary-decision-box" style="margin-top:8px;padding:8px 10px;background:rgba(0,229,255,0.04);border:1px solid rgba(0,229,255,0.25);border-radius:6px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
              <span style="font-size:10px;font-weight:800;color:#00e5ff;text-transform:uppercase;letter-spacing:0.06em;">🎯 BINARY OUTCOME DECISION</span>
              <span class="k15-expiry" data-close-ms="${_k15mV?.closeTime ? new Date(_k15mV.closeTime).getTime() : (Math.floor(Date.now() / 900000) + 1) * 900000}" style="font-family:var(--font-mono);font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px;background:rgba(0,229,255,0.12);color:#00e5ff;">⏱ 00:00 to Decision Lock</span>
            </div>
            <div style="font-size:12px;font-weight:700;color:${isYesVerdict ? 'var(--color-green)' : 'var(--color-red)'};">
              ${isYesVerdict ? '▲ PROJECTED OUTCOME: YES (Price ≥ Strike)' : '▼ PROJECTED OUTCOME: NO (Price < Strike)'}
            </div>
            <div style="font-size:11px;color:var(--color-text-muted);margin-top:2px;">
              Model CDF P(YES): <strong style="color:var(--color-text);">${_modelYesPctCard}%</strong> ${grokBinaryCall ? `· Grok Inference: <strong style="color:#00e5ff;">${grok15mGuidance.call} (${grokConfPct}%)</strong>` : ''}
            </div>
            ${grokNotesText ? `<div style="font-size:11px;color:var(--color-text);margin-top:3px;line-height:1.35;"><span style="color:#00e5ff;font-weight:700;">🤖 Grok Rationale:</span> ${escapeHtml(grokNotesText)}</div>` : ''}
          </div>
          <!-- Model vs Polymarket Comparison Bar -->
          ${_liveKPctCard !== null ? `
            <div class="pred-comparison-bar-wrap" title="Model vs Market: shows where model (top) differs from Polymarket crowd (bottom)">
              <div style="font-size:9px;color:var(--color-text-muted);margin-bottom:4px;display:flex;justify-content:space-between">
                <span>Model: ${_modelProbStr}</span>
                <span>Polymarket: ${_liveKPctCard}% YES</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <div style="flex:1;height:12px;background:rgba(0,0,0,0.1);border-radius:3px;position:relative;overflow:hidden">
                  <div style="height:100%;width:${_modelUpPct}%;background:${verdictDir === 'up' ? 'var(--color-green)' : 'var(--color-red)'};border-radius:3px"></div>
                </div>
                <span style="font-size:9px;font-weight:700;min-width:35px;text-align:right;color:var(--color-text)">${_edgePpCard ?? '—'}pp</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                <div style="flex:1;height:12px;background:rgba(0,0,0,0.1);border-radius:3px;position:relative;overflow:hidden">
                  <div style="height:100%;width:${_liveKPctCard}%;background:${_liveKColorCard};border-radius:3px"></div>
                </div>
                <span style="font-size:9px;font-weight:700;min-width:35px;text-align:right;color:var(--color-text-muted)">crowd</span>
              </div>
            </div>
          ` : ''}
          ${lazerRow}
          ${model5mRow}
          ${polymarket15mRow}
          ${_k15mCoin ? renderFifteenMinuteMovePlan(_k15mCoin, true) : ''}
          ${(() => {
        // ── Market Divergence row ─────────────────────────────────────
        const _md = window._marketDivergence?.[p.sym];
        if (!_md?.active || _md.phase === 'STALE') return '';

        const phaseColors = {
          PRIME: ['rgba(38,212,126,0.10)', 'rgba(38,212,126,0.40)', 'var(--color-green)'],
          ACTIVE: ['rgba(0,150,255,0.09)', 'rgba(0,150,255,0.35)', '#4f9eff'],
          CATCHING: ['rgba(255,215,0,0.10)', 'rgba(255,215,0,0.40)', '#ffd700'],
          DIVERGING: ['rgba(220,60,60,0.09)', 'rgba(220,60,60,0.35)', 'var(--color-red)'],
          LATE: ['rgba(130,130,130,0.07)', 'rgba(130,130,130,0.25)', 'var(--color-text-muted)'],
        };
        const [bg, border, textColor] = phaseColors[_md.phase] || phaseColors.LATE;

        const phaseLabels = {
          PRIME: '🟢 PRIME WINDOW',
          ACTIVE: '🔵 ACTIVE',
          CATCHING: '🟡 CROWD CATCHING',
          DIVERGING: '🔴 CROWD DOUBLING DOWN',
          LATE: '⬜ LATE',
        };

        // Compute elapsed time live from firstDivTs (not from stale durationMs)
        const secElapsed = _md.firstDivTs ? Math.floor((Date.now() - _md.firstDivTs) / 1000) : 0;
        const minSec = secElapsed >= 60
          ? Math.floor(secElapsed / 60) + 'm ' + (secElapsed % 60) + 's'
          : secElapsed + 's';

        // Read live Polymarket probability directly — don't rely on stale snapshot value
        const livePolymarketPct = window.PredictionMarkets?.getCoin?.(p.sym)?.kalshi15m?.probability != null
          ? window.PredictionMarkets.getCoin(p.sym).kalshi15m.probability * 100
          : (_md.currentPolymarketPct ?? null);

        // Recompute catchupDelta from live odds
        const liveCatchupDelta = (livePolymarketPct != null && _md.entryPolymarketPct != null)
          ? (_md.entryModelDir === 'up' || _md.entryModelDir === 'UP'
            ? livePolymarketPct - _md.entryPolymarketPct
            : _md.entryPolymarketPct - livePolymarketPct)
          : (_md.catchupDelta ?? 0);

        const deltaStr = Math.abs(liveCatchupDelta) >= 0.5
          ? (liveCatchupDelta > 0
            ? `+${liveCatchupDelta.toFixed(1)}pp crowd → model`
            : `${liveCatchupDelta.toFixed(1)}pp crowd away`)
          : '';

        const entryHint = _md.phase === 'PRIME'
          ? 'Best entry window — model ahead of crowd'
          : _md.phase === 'ACTIVE'
            ? 'Divergence holding — monitor for catchup'
            : _md.phase === 'CATCHING'
              ? 'Crowd moving toward model — entry closing'
              : _md.phase === 'DIVERGING'
                ? 'Crowd opposing model — elevated risk'
                : 'Signal aging — verify before entry';

        return `
              <div style="margin-top:5px;padding:7px 10px;border-radius:4px;background:${bg};border:1px solid ${border};font-size:11px;font-family:var(--font-mono)">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span style="font-weight:900;letter-spacing:.3px;color:${textColor}">MKT DIV</span>
                  <span style="font-weight:800;color:${textColor}">${phaseLabels[_md.phase] ?? _md.phase}</span>
                  <span style="font-weight:700;color:var(--color-text)" data-mdiv-ts="${_md.firstDivTs ?? ''}">${minSec}</span>
                  ${deltaStr ? `<span style="margin-left:auto;color:var(--color-text-muted)">${deltaStr}</span>` : ''}
                </div>
                <div style="margin-top:3px;color:var(--color-text-muted);font-size:10px;font-family:var(--font-sans)">${entryHint}${_md.entryPolymarketPct != null ? ` · Entry K: ${_md.entryPolymarketPct.toFixed(0)}% → now ${livePolymarketPct != null ? livePolymarketPct.toFixed(0) : '?'}%` : ''}</div>
              </div>`;
      })()}
          <!-- Kalshi order-routing box removed -- no Polymarket equivalent, user no longer trades Kalshi -->
        </div>

        ${rfRow}
        <!-- Expanded detail: hidden until card is clicked -->
        <div class="pred-expand-panel ${expanded ? 'open' : ''}">

          <div class="ind-grid" style="margin-bottom:12px">
            <div class="ind-item"><span class="ind-name">Model Quality</span><span class="ind-val ${reliabilityPct >= 60 ? 'bull' : reliabilityPct < 45 ? 'bear' : 'flat'}">${hasBacktest ? `${qualityLabel} (${reliabilityPct}%)` : qualityLabel}</span></div>
            <div class="ind-item"><span class="ind-name">Trade Fit</span><span class="ind-val ${tradeFitPct >= 62 ? 'bull' : tradeFitPct < 45 ? 'bear' : 'flat'}">${hasBacktest ? `${tradeFitLabel} (${tradeFitPct}%)` : tradeFitLabel}</span></div>
            <div class="ind-item"><span class="ind-name">Signal Alignment</span><span class="ind-val ${agreementPct >= 70 ? 'bull' : conflictPct >= 35 ? 'bear' : 'flat'}">${agreementPct}% aligned / ${conflictPct}% conflict</span></div>
            ${horizonRows.map(horizon => `<div class="ind-item"><span class="ind-name">UP/DOWN ${horizon.label}</span><span class="ind-val ${btClass(horizon.stats)}">${horizon.stats && horizon.stats.activeSignals ? `${horizon.stats.winRate.toFixed(0)}% win · ${fmtPct(Math.min(Math.max(horizon.stats.equity?.returnPct || 0, -9999), 9999))}` : 'Not enough signals'}</span></div>`).join('')}
            <div class="ind-item"><span class="ind-name">Decision Gate</span><span class="ind-val ${vetoReason ? 'bear' : inBufferZone ? 'flat' : 'bull'}">${vetoReason || (inBufferZone ? 'Buffer zone' : 'Clear to trade')}</span></div>
            <div class="ind-item ind-mdt">
              <span class="ind-name">Bias Gate</span>
              <span class="ind-val ${mdtBias === 'bullish' ? 'bull' : mdtBias === 'bearish' ? 'bear' : 'flat'}">
                ${mdtRegimeLabel}
                ${mdtPreemptive ? '<span class="mdt-pre-tag">PRE</span>' : ''}
                · ${mdtConf}% conf
                ${mdtVerdict !== 'HOLD' ? `· <strong>${mdtVerdict}</strong>` : ''}
              </span>
            </div>
            <div class="ind-item"><span class="ind-name">Router</span><span class="ind-val ${routeClass(routedAction)}">${routedAction}</span></div>
            <div class="ind-item"><span class="ind-name">Long-range Context</span><span class="ind-val ${advancedQualityPct >= 58 ? 'bull' : advancedQualityPct < 42 ? 'bear' : 'flat'}">${advanced ? `${advancedQualityPct}% quality · ${advancedFitPct}% fit${advancedVol ? ` · ${advancedVol.regime}` : ''}` : 'Loading full history'}</span></div>
          </div>

          <div class="ind-grid" style="margin-bottom:12px">
            <div class="ind-item"><span class="ind-name">RSI(14)</span><span class="ind-val ${indClass(ind.rsi?.signal || 0)}">${ind.rsi?.value?.toFixed(1) ?? '—'} ${ind.rsi?.label ?? ''}</span></div>
            <div class="ind-item"><span class="ind-name">EMA 9/21</span><span class="ind-val ${indClass(ind.ema?.signal || 0)}">${ind.ema?.label ?? '—'}</span></div>
            <div class="ind-item"><span class="ind-name">VWAP</span><span class="ind-val ${indClass(ind.vwap?.signal || 0)}">${Number.isFinite(ind.vwap?.value) ? `${ind.vwap.value > 0 ? '+' : ''}${ind.vwap.value.toFixed(2)}%` : '—'} ${ind.vwap?.label ?? ''}</span></div>
            <div class="ind-item"><span class="ind-name">OBV</span><span class="ind-val ${indClass(ind.obv?.signal || 0)}">${ind.obv?.label ?? '—'}</span></div>
            <div class="ind-item"><span class="ind-name">Vol Flow</span><span class="ind-val ${indClass(ind.volume?.signal || 0)}">${ind.volume?.label ?? '—'}</span></div>
            <div class="ind-item"><span class="ind-name">Momentum</span><span class="ind-val ${indClass(ind.momentum?.signal || 0)}">${Number.isFinite(ind.momentum?.value) ? `${ind.momentum.value > 0 ? '+' : ''}${ind.momentum.value.toFixed(2)}%` : '—'}</span></div>
            ${depthRows}
            ${ind.bands ? `<div class="ind-item"><span class="ind-name">Bands</span><span class="ind-val ${indClass(ind.bands.signal)}">${ind.bands.label}</span></div>` : ''}
            ${ind.persistence ? `<div class="ind-item"><span class="ind-name">Persistence</span><span class="ind-val ${indClass(ind.persistence.signal)}">${ind.persistence.label}</span></div>` : ''}
            ${ind.structure ? `<div class="ind-item"><span class="ind-name">Structure</span><span class="ind-val ${indClass(ind.structure.signal)}">${ind.structure.label}</span></div>` : ''}
            ${ind.book ? `<div class="ind-item"><span class="ind-name">Book</span><span class="ind-val ${ind.book.imbalance > 0.2 ? 'bull' : ind.book.imbalance < -0.2 ? 'bear' : 'flat'}">${(ind.book.label || "—").split('\u2014')[0]}</span></div>` : ''}
            ${ind.flow ? `<div class="ind-item"><span class="ind-name">Tape</span><span class="ind-val ${ind.flow.aggressor === 'buyers' ? 'bull' : ind.flow.aggressor === 'sellers' ? 'bear' : 'flat'}">${(ind.flow.label || "—").split('(')[0]}</span></div>` : ''}
            ${fastTiming ? `<div class="ind-item"><span class="ind-name">Pooled 1m</span><span class="ind-val ${fastTiming.score > 0.12 ? 'bull' : fastTiming.score < -0.12 ? 'bear' : 'flat'}">${fastTiming.label}</span></div>` : ''}
          </div>

          <div class="proj-section">
            <div class="proj-title">Why it fired</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">
              ${topDrivers.map(driver => `<span style="font-size:9px;padding:3px 6px;background:var(--color-surface-2);border-radius:9999px;color:${driver.direction === 'up' ? 'var(--color-green)' : 'var(--color-red)'}">${driver.label}: ${driver.detail}</span>`).join('')}
              ${fastTiming ? `<span style="font-size:9px;padding:3px 6px;background:var(--color-surface-2);border-radius:9999px;color:${fastTiming.score > 0 ? 'var(--color-green)' : fastTiming.score < 0 ? 'var(--color-red)' : 'var(--color-text-muted)'}">1m pulse: ${fastTiming.label}</span>` : ''}
              ${routedRiskFlags.map(flag => `<span style="font-size:9px;padding:3px 6px;background:var(--color-red-dim);border-radius:9999px;color:var(--color-red)">${flag}</span>`).join('')}
              ${mdtPath.slice(0, 5).map(step => `
                <span style="font-size:9px;padding:3px 6px;background:var(--color-surface-2);border-radius:9999px;color:${step.pass === false ? 'var(--color-text-faint)' : mdtBias === 'bullish' ? 'var(--color-green)' : mdtBias === 'bearish' ? 'var(--color-red)' : 'var(--color-text-muted)'}">
                  MDT/${step.node}${step.result ? ': ' + step.result : ''}
                </span>`).join('')}
            </div>
            <div style="font-size:11px;color:var(--color-text-muted);line-height:1.45">${routedSummary}</div>
          </div>

          <div class="proj-section">
            <div class="proj-title">Resolution Range</div>
            ${horizonRows.filter(horizon => horizon.projection).map(horizon => `
              <div class="proj-row">
                <span class="proj-label">${horizon.label}</span>
                <span style="color:var(--color-red);font-size:10px">${fmtPrice(horizon.projection.low, p.sym)}</span>
                <div class="proj-range">
                  <div class="proj-target ${confClass}" style="left:50%"></div>
                </div>
                <span style="color:var(--color-green);font-size:10px">${fmtPrice(horizon.projection.high, p.sym)}</span>
                <span class="proj-val" style="color:${p.score >= 0 ? 'var(--color-green)' : 'var(--color-red)'}">${fmtPrice(horizon.projection.target, p.sym)}</span>
              </div>

            `).join('')}
          </div>

          <div class="pred-detail-grid" style="margin-top:10px">
            <div class="cfm-detail-card"><span class="cfm-detail-label">Consensus</span><strong>${p.diagnostics?.consensusLabel || 'Balanced'}</strong><small>${agreementPct}% aligned</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Raw Score</span><strong>${(p.rawScore ?? p.score).toFixed(3)}</strong><small>pre-calibration</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Trade Horizon</span><strong>${preferredHorizon}m bias</strong><small>${tradeFitLabel}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">15m Window Setup</span><strong>${setup15.label.replace('15m setup: ', '').toUpperCase()}</strong><small>${setup15.detail}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Decision Buffer</span><strong>${inBufferZone ? 'Inside buffer' : 'Outside buffer'}</strong><small>${vetoReason || `score ±${((p.diagnostics?.scoreBuffer || 0) * 100).toFixed(0)}bp gate`}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Router Verdict</span><strong>${routedAction}</strong><small>${routedRiskFlags.length ? routedRiskFlags.join(', ') : 'clean packet flow'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Funding</span><strong>${p.derivatives ? fmtPct(p.derivatives.funding) : '—'}</strong><small>${p.derivatives?.exchange || 'no perp feed'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">CVD Slope</span><strong>${p.cvd?.slope ? fmtPct(p.cvd.slope) : '—'}</strong><small>${p.cvd?.slope > 0 ? 'buyers leading' : p.cvd?.slope < 0 ? 'sellers leading' : 'flat flow'}</small></div>
            ${horizonRows.map(horizon => `<div class="cfm-detail-card"><span class="cfm-detail-label">${horizon.label} Filter</span><strong>${horizon.stats?.entryThreshold ? horizon.stats.entryThreshold.toFixed(2) : '—'} / ${horizon.stats?.minAgreement ? Math.round(horizon.stats.minAgreement * 100) + '%' : '—'}</strong><small>score / agreement gate</small></div>`).join('')}
            <div class="cfm-detail-card"><span class="cfm-detail-label">Advanced Span</span><strong>${advanced ? `${advanced.startDate} → ${advanced.endDate}` : '—'}</strong><small>${advanced ? `${advanced.candleCount} daily candles` : 'full-history loading'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Advanced 1d / 7d</span><strong>${advanced?.d1?.activeSignals ? `${advanced.d1.winRate.toFixed(0)}%` : '—'} / ${advanced?.d7?.activeSignals ? `${advanced.d7.winRate.toFixed(0)}%` : '—'}</strong><small>${advanced ? `${advancedQualityPct}% quality · ${advancedFitPct}% fit` : 'no data yet'}</small></div>
            <div class="cfm-detail-card"><span class="cfm-detail-label">Advanced Vol (7d)</span><strong>${advancedVol ? `${advancedVol.regime} · ${Number(advancedVol.volPercentile || 0).toFixed(0)}p` : '—'}</strong><small>${advancedVol ? `EWMA ${Number(advancedVol.ewmaVolPct || 0).toFixed(2)}% · Jump ${((Number(advancedVol.jumpRatio) || 0) * 100).toFixed(1)}%` : 'volatility snapshot pending'}</small></div>
            ${horizonRows.map(horizon => `<div class="cfm-detail-card"><span class="cfm-detail-label">${horizon.label} Strong Bucket</span><strong>${horizon.stats?.buckets?.strong?.trades ?? 0}</strong><small>${horizon.stats?.buckets?.strong ? horizon.stats.buckets.strong.winRate.toFixed(0) + '% win · DD ' + (horizon.stats.equity?.maxDrawdownPct || 0).toFixed(1) + '%' : 'no data'}</small></div>`).join('')}
          </div>

          ${(p.scalpSetups || []).length ? `
            <div class="pred-setup-list">
              ${(p.scalpSetups || []).slice(0, 4).map(s => `
                <div class="pred-setup-item"><strong>${s.label}</strong><span>${s.desc}</span></div>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <!-- Footer: always visible -->
        <div class="pred-footer">
          <div>
            <span class="vol-badge ${(p.volatility?.label || 'unknown').toLowerCase()}">Vol: ${p.volatility?.label || 'Unknown'} (${(p.volatility?.atrPct || 0).toFixed(2)}%)</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${scalpCount > 0 ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-green-dim);color:var(--color-green);border-radius:9999px;font-weight:700">${scalpCount} scalp</span>` : ''}
            ${contrarianCount > 0 ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-orange-dim);color:var(--color-orange);border-radius:9999px;font-weight:700">${contrarianCount} contrarian</span>` : ''}
            ${fastTiming ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:${fastTiming.score > 0 ? 'var(--color-green)' : fastTiming.score < 0 ? 'var(--color-red)' : 'var(--color-text-muted)'};border-radius:9999px;font-weight:700">1m ${fastTiming.label}</span>` : ''}
            ${p.backtest ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:var(--color-text-muted);border-radius:9999px;font-weight:700">${reliabilityPct}% quality</span>` : ''}
            ${p.backtest ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:var(--color-text-muted);border-radius:9999px;font-weight:700">${tradeFitPct}% fit</span>` : ''}
            ${vetoReason ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-red-dim);color:var(--color-red);border-radius:9999px;font-weight:700">${vetoReason}</span>` : inBufferZone ? `<span style="font-size:9px;padding:2px 5px;background:var(--color-surface-2);color:var(--color-orange);border-radius:9999px;font-weight:700">Buffer zone</span>` : ''}
          </div>
          <span>${p.updatedAt}</span>
        </div>
      </div>
    `;
  }

function normalizePredictionCardData(raw, fallbackSym = '') {
    const incoming = raw && typeof raw === 'object' ? raw : {};
    const sym = String(incoming.sym || incoming.symbol || incoming.coin || fallbackSym || '').toUpperCase();
    if (!sym) return { ...incoming, sym: '' };

    const prev = (typeof window !== 'undefined' && window._predictions?.[sym]) || null;
    if (prev && prev.price === incoming.price && prev.score === incoming.score && prev.backtest === incoming.backtest && prev.holderMetrics === incoming.holderMetrics && prev.signal === incoming.signal) {
      return prev; // bail - avoid unnecessary object allocation and DOM layout work
    }

    const meta = getPredictionCoinMeta(sym) || {};
    const color = incoming.color
      || meta.color
      || (typeof COIN_COLORS !== 'undefined' ? COIN_COLORS[sym] : null)
      || '#7880a0';
    const score = Number(incoming.score);
    const confidence = Number(incoming.confidence);
    const price = Number(incoming.price);
    const hasPayload = Object.keys(incoming).length > 0;

    return {
      ...incoming,
      sym,
      llm: window._llmIntegration?.lastInfluence?.[sym] || incoming.llm || null,
      name: incoming.name || meta.name || (typeof COIN_SHORT !== 'undefined' ? COIN_SHORT[sym] : null) || sym,
      instrument: incoming.instrument || meta.instrument || `${sym}USD`,
      geckoId: incoming.geckoId || meta.geckoId || null,
      icon: incoming.icon || meta.icon || sym.slice(0, 2),
      iconSources: Array.isArray(incoming.iconSources)
        ? incoming.iconSources
        : (Array.isArray(meta.iconSources) ? meta.iconSources : []),
      color,
      signal: incoming.signal || 'neutral',
      score: Number.isFinite(score) ? score : 0,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      price: Number.isFinite(price) ? price : 0,
      source: incoming.source || (hasPayload ? 'partial' : 'loading'),
      candleCount: incoming.candleCount ?? 0,
      candleCount1m: incoming.candleCount1m ?? 0,
      candleCount15m: incoming.candleCount15m ?? 0,
      _15mPoolingDebug: incoming._15mPoolingDebug || null,
      updatedAt: incoming.updatedAt || 'pending',
      indicators: incoming.indicators || {},
      diagnostics: incoming.diagnostics || {},
      projections: incoming.projections || {},
      volatility: incoming.volatility || { label: 'Unknown', atrPct: 0 },
      scalpSetups: Array.isArray(incoming.scalpSetups) ? incoming.scalpSetups : [],
      backtest: incoming.backtest || window._predictions?.[sym]?.backtest || null,
      holderMetrics: incoming.holderMetrics || window._predictions?.[sym]?.holderMetrics || window.HolderMetrics?.getMetrics?.(sym) || null,
    };
  }

function getPredictionCoinMeta(sym) {
    const key = String(sym || '').toUpperCase();
    if (!key) return null;
    const configured = Array.isArray(window.PREDICTION_COINS)
      ? window.PREDICTION_COINS
      : (typeof PREDICTION_COINS !== 'undefined' && Array.isArray(PREDICTION_COINS) ? PREDICTION_COINS : []);
    const portfolio = typeof PORTFOLIO_HOLDINGS !== 'undefined' && Array.isArray(PORTFOLIO_HOLDINGS)
      ? PORTFOLIO_HOLDINGS
      : [];
    const watchlist = typeof WATCHLIST !== 'undefined' && Array.isArray(WATCHLIST)
      ? WATCHLIST
      : [];

    return configured.find(c => c?.sym === key)
      || portfolio.find(c => c?.sym === key)
      || watchlist.find(c => c?.sym === key)
      || null;
  }

function buildMarketDebugPanel() {
    try {
      const snaps = window._lastMarketSnapshot || {};
      const log = (window._marketSettlementLog || []).slice(-20).reverse();
      const errors = (window._kalshiErrors || []).slice(-8).reverse();
      const resLog = (window._15mResolutionLog || []).slice(-10).reverse();
      const orchLog = (window._orchLog || []).slice(-15).reverse();

      const fmtPrice = (v, sym) => {
        if (v == null || v === '') return '–';
        if (window.CoinPrecision?.formatCoinPrice) {
          return window.CoinPrecision.formatCoinPrice(sym, v);
        }
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return '–';
        const s = String(sym || '').toUpperCase();
        const d = (s === 'XRP' || s === 'DOGE') ? 4 : (n < 1 ? 4 : 2);
        return `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
      };

      const fmtPct = v => v != null ? `${v}%` : '–';
      const fmtTime = ms => ms ? new Date(ms).toISOString().slice(11, 19) : '–';
      const fmtScore = v => v != null ? (v > 0 ? '+' : '') + Number(v).toFixed(3) : '–';
      const fmtEdge = v => v != null ? (v >= 0 ? '+' : '') + v + '¢' : '–';
      const ok = v => v === true
        ? '<span style="color:#4caf50;font-weight:700">✓</span>'
        : v === false ? '<span style="color:#f44336;font-weight:700">✗</span>'
          : '<span style="color:#666">?</span>';
      const colDir = v => (v === 'UP' || v === 'up') ? 'color:#4caf50'
        : (v === 'DOWN' || v === 'down') ? 'color:#f44336' : 'color:#888';
      const colAct = a => a === 'trade' ? 'color:#4caf50;font-weight:700'
        : a === 'watch' ? 'color:#ffc107'
          : a === 'skip' ? 'color:#f44336'
            : a === 'hold' ? 'color:#80cbc4'
              : a === 'earlyExit' ? 'color:#e040fb' : 'color:#888';
      const alignColor = al => ({
        ALIGNED: '#4caf50', DIVERGENT: '#ff9800', MODEL_LEADS: '#4f9eff',
        CROWD_FADE: '#e040fb', MODEL_ONLY: '#80cbc4', POLYMARKET_ONLY: '#ffc107',
        SHELL_EVAL: '#ff5722', EARLY_EXIT: '#888',
      }[al] || '#aaa');

      const th = 'style="color:#888;font-size:10px;font-weight:600;padding:3px 6px;border-bottom:1px solid #2a2a2a;white-space:nowrap"';
      const tdBase = 'padding:3px 6px;font-size:11px;border-bottom:1px solid #1a1a1a';
      const td = `style="${tdBase}"`;
      const tbl = 'width:100%;border-collapse:collapse;margin-bottom:8px';

      // Orchestrator state is updated in the prediction render path. Keep this
      // panel read-only so frequent renders cannot recursively churn live state.

      // ── 1. ORCHESTRATOR LIVE ──────────────────────────────────────────────
      const suppressionCounts = {};
      const stageFailCounts = {};
      const actionCounts = { trade: 0, watch: 0, hold: 0, skip: 0, earlyExit: 0, other: 0 };
      const liveOrchRows = PREDICTION_COINS.map(coin => {
        try {
          const ki = window.PolymarketOrchestrator?.getIntent?.(coin.sym);
          if (!ki) return `<tr><td style="${tdBase};color:#fff;font-weight:700">${coin.sym}</td>
            <td colspan="9" style="${tdBase};color:#555;font-size:10px">no data — waiting for first prediction cycle</td></tr>`;
          const actionKey = actionCounts[ki.action] != null ? ki.action : 'other';
          actionCounts[actionKey] += 1;
          const minsStr = ki.minsLeft != null ? ki.minsLeft.toFixed(1) + 'm'
            : ki.secsLeft != null ? ki.secsLeft.toFixed(0) + 's' : '–';
          const flags = (ki.sweetSpot ? '⭐' : '') + (ki.crowdFade ? '🔄' : '') + (ki.signalLocked ? '🔒' : '');
          const failedStages = Array.isArray(ki.stageDiagnostics?.stages)
            ? ki.stageDiagnostics.stages.filter(stage => stage && stage.passed === false)
            : [];
          failedStages.forEach(stage => {
            stageFailCounts[stage.name] = (stageFailCounts[stage.name] || 0) + 1;
          });
          const blockerReasons = []
            .concat(Array.isArray(ki.blockedBy) ? ki.blockedBy : [])
            .concat(Array.isArray(ki.stageDiagnostics?.suppressionReasons) ? ki.stageDiagnostics.suppressionReasons : []);
          blockerReasons.filter(Boolean).forEach(reason => {
            suppressionCounts[reason] = (suppressionCounts[reason] || 0) + 1;
          });
          const stageSummary = failedStages.length
            ? failedStages.map(stage => stage.name).slice(0, 2).join(', ')
            : 'pass';
          const blockerSummary = blockerReasons.length
            ? blockerReasons.slice(0, 2).join(' · ')
            : '—';
          return `<tr>
            <td style="${tdBase};color:#fff;font-weight:700">${coin.sym}</td>
            <td style="${tdBase};${colAct(ki.action)}">${(ki.action || '–').toUpperCase()}</td>
            <td style="${tdBase};${ki.side === 'YES' ? 'color:#4caf50' : ki.side === 'NO' ? 'color:#f44336' : 'color:#888'};font-weight:700">${ki.side ?? '–'}</td>
            <td style="${tdBase};color:${alignColor(ki.alignment)};font-size:10px">${ki.alignment ?? '–'}</td>
            <td style="${tdBase};color:${(ki.edgeCents ?? 0) >= 7 ? '#4caf50' : '#f44336'}">${fmtEdge(ki.edgeCents)}</td>
            <td style="${tdBase};${colDir(ki.direction)}">${fmtScore(ki.modelScore)}</td>
            <td style="${tdBase};color:#888">${minsStr}</td>
            <td style="${tdBase};font-size:12px">${flags || '–'}</td>
            <td style="${tdBase};font-size:10px;color:${failedStages.length ? '#ff9800' : '#4caf50'}">${stageSummary}</td>
            <td style="${tdBase};font-size:10px;color:#aaa;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${blockerSummary}</td>
          </tr>`;
        } catch (e) {
          return `<tr><td style="${tdBase};color:#fff">${coin.sym}</td><td colspan="9" style="${tdBase};color:#f44336;font-size:10px">render error: ${e.message}</td></tr>`;
        }
      }).join('');
      const topSuppressions = Object.entries(suppressionCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([reason, count]) => `<span style="padding:2px 6px;border:1px solid #2a2a2a;border-radius:9999px;font-size:10px;color:#aaa">${count}× ${escapeHtml(reason)}</span>`)
        .join('') || '<span style="font-size:10px;color:#666">No suppression reasons collected yet</span>';
      const topStageFailures = Object.entries(stageFailCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name}:${count}`)
        .join(' · ') || 'none';
      const suppressionSummary = `
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 8px">
          <span style="font-size:10px;color:#888">Actions → trade:${actionCounts.trade} watch:${actionCounts.watch} hold:${actionCounts.hold} skip:${actionCounts.skip} exit:${actionCounts.earlyExit}</span>
          <span style="font-size:10px;color:#888">Stage fails → ${escapeHtml(topStageFailures)}</span>
          ${topSuppressions}
        </div>
      `;

      // ── 2. ACCURACY SCORECARD ─────────────────────────────────────────────
      const scorecardRows = PREDICTION_COINS.map((coin, idx) => {
        try {
          // Count all contracts with outcome (resolved), not just those marked _settled
          const entries = (window._marketSettlementLog || []).filter(e => e.sym === coin.sym && e.outcome);
          const resE = (window._15mResolutionLog || []).filter(e => e.sym === coin.sym && e.modelCorrect !== null);

          // ADD HISTORICAL DATA FROM CALCULATOR
          const historical = (window.getHistoricalContracts?.() || [])
            .filter(h => h.symbol === coin.sym && (h.modelCorrect !== null || h.outcome));

          const total = entries.length + resE.length + historical.length;
          if (!total) return `<tr><td style="${tdBase};color:#fff;font-weight:700">${coin.sym}</td>
            <td colspan="5" style="${tdBase};color:#555;font-size:10px">no settled data yet</td></tr>`;
          const modelOk = entries.filter(e => e.modelCorrect === true).length + resE.filter(e => e.modelCorrect === true).length + historical.filter(h => h.modelCorrect === true).length;
          const mktOk = entries.filter(e => e.marketCorrect === true).length + resE.filter(e => e.marketCorrect === true).length;
          const fadeE = entries.filter(e => e.fadeActive && e.fadeCorrect !== null);
          const fadeOk = fadeE.filter(e => e.fadeCorrect === true).length;
          const modelPct = Math.round(modelOk / total * 100);
          const mktPct = Math.round(mktOk / total * 100);
          const fadePct = fadeE.length ? Math.round(fadeOk / fadeE.length * 100) : null;
          const last8 = [...entries, ...resE, ...historical].sort((a, b) => (b.settledTs || b.ts || 0) - (a.settledTs || a.ts || 0)).slice(0, 8);
          const l8ok = last8.filter(e => e.modelCorrect === true).length;
          const trend = last8.length >= 4 ? (l8ok / last8.length >= 0.6 ? '↑' : l8ok / last8.length <= 0.35 ? '↓' : '→') : '?';
          const tC = trend === '↑' ? '#4caf50' : trend === '↓' ? '#f44336' : '#ffc107';
          const mC = modelPct >= 55 ? '#4caf50' : modelPct >= 45 ? '#ffc107' : '#f44336';
          const fC = fadePct == null ? '#555' : fadePct >= 55 ? '#4caf50' : fadePct >= 45 ? '#ffc107' : '#f44336';

          // Build debug context: split last contracts by UP/DOWN
          const allContracts = [...entries, ...resE, ...historical].sort((a, b) => (b.ts || b.settledTs || 0) - (a.ts || a.settledTs || 0));
          const resolvedDir = (e) => e.actualOutcome || e.modelDir || e.direction || null;
          const ups = allContracts.filter(e => resolvedDir(e) === 'UP').slice(0, 3);
          const downs = allContracts.filter(e => resolvedDir(e) === 'DOWN').slice(0, 3);

          const detailsId = `scorecard-${coin.sym}-${idx}`;
          const debugHtml = `
            <div style="margin:6px 0;padding:8px;background:#0a0a0a;border-left:3px solid #80cbc4;font-size:10px;border-radius:4px">
              <div style="color:#80cbc4;font-weight:700;margin-bottom:6px">📊 Up/Down Debug Context for ${coin.sym}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div style="border-right:1px solid #222">
                  <div style="color:#4caf50;font-weight:600;margin-bottom:3px;font-size:9px">🔼 UP (${ups.length})</div>
                  ${ups.map(u => {
            const correct = u.modelCorrect === true ? '✓' : u.modelCorrect === false ? '✗' : '?';
            const dir = u.modelDir || u.direction || '?';
            const actual = u.actualOutcome || u._marketResult || u.marketResult || u.outcome || '?';
            const ts = new Date(u.ts || u.settledTs || 0).toISOString().slice(11, 19);
            return `<div style="font-size:9px;color:#aaa;margin:2px 0;padding:2px 4px;background:rgba(76,175,80,0.1);border-radius:2px">${correct} pred=${dir} result=${actual} <span style="color:#666">${ts}</span></div>`;
          }).join('')}
                  ${ups.length === 0 ? '<div style="font-size:9px;color:#555">—</div>' : ''}
                </div>
                <div>
                  <div style="color:#f44336;font-weight:600;margin-bottom:3px;font-size:9px">🔽 DOWN (${downs.length})</div>
                  ${downs.map(d => {
            const correct = d.modelCorrect === true ? '✓' : d.modelCorrect === false ? '✗' : '?';
            const dir = d.modelDir || d.direction || '?';
            const actual = d.actualOutcome || d._marketResult || d.marketResult || d.outcome || '?';
            const ts = new Date(d.ts || d.settledTs || 0).toISOString().slice(11, 19);
            return `<div style="font-size:9px;color:#aaa;margin:2px 0;padding:2px 4px;background:rgba(244,67,54,0.1);border-radius:2px">${correct} pred=${dir} result=${actual} <span style="color:#666">${ts}</span></div>`;
          }).join('')}
                  ${downs.length === 0 ? '<div style="font-size:9px;color:#555">—</div>' : ''}
                </div>
              </div>
            </div>
          `;

          return `<tr style="background:rgba(128,203,196,0.02)">
            <td style="${tdBase};color:#fff;font-weight:700;cursor:pointer;user-select:none;padding:6px;border-radius:4px 0 0 4px"
                onclick="const d=document.getElementById('${detailsId}');d.style.display=d.style.display==='none'?'table-row':'none'">
              ${coin.sym} <span style="color:#666;font-size:9px">▸</span>
            </td>
            <td style="${tdBase};color:#888">${total}</td>
            <td style="${tdBase};color:${mC};font-weight:700">${modelPct}%</td>
            <td style="${tdBase};color:#888">${mktPct}%</td>
            <td style="${tdBase};color:${fC}">${fadePct != null ? fadePct + '% (' + fadeE.length + ')' : '–'}</td>
            <td style="${tdBase};color:${tC};font-weight:700;border-radius:0 4px 4px 0">${trend} ${last8.length}/${8}</td>
          </tr>
          <tr id="${detailsId}" style="display:none;background:#0a0a0a">
            <td colspan="6" style="padding:0 6px 6px 6px;border:1px solid #1a1a1a;border-radius:0 0 4px 4px">
              ${debugHtml}
            </td>
          </tr>`;
        } catch (e) {
          return `<tr><td style="${tdBase};color:#fff">${coin.sym}</td><td colspan="5" style="${tdBase};color:#f44336;font-size:10px">err: ${e.message}</td></tr>`;
        }
      }).join('');

      // ── 3. CURRENT SNAPSHOTS ──────────────────────────────────────────────
      const snapRows = Object.entries(snaps).map(([sym, s]) => {
        if (!s) return '';
        const conflict = s.dirConflict ? '⚠️' : '';
        const confCol = s.dirConflict ? 'color:#f44336;font-weight:700' : 'color:#4caf50';
        const fadeTag = s.fadeActive
          ? (s.fadeSolid ? '<span style="color:#ff9800;font-weight:700">🔥FADE</span>'
            : '<span style="color:#ffc107">~fade</span>') : '';
        return `<tr>
          <td style="${tdBase};color:#fff;font-weight:600">${sym}</td>
          <td style="${tdBase}">${fmtPrice(s.floorPrice || s.ref, sym)}</td>
          <td style="${tdBase};${s.strikeDir === 'below' ? 'color:#f44336' : 'color:#4caf50'}">${s.strikeDir || 'above'}</td>
          <td style="${tdBase};${colDir(s.modelDir)}">${s.modelDir || '–'}</td>
          <td style="${tdBase}">${fmtPct(s.mYesPct)}</td>
          <td style="${tdBase}">${fmtPct(s.kYesPct)}</td>
          <td style="${tdBase};${confCol}">${conflict}${s.cdfImpliedDir || '–'}</td>
          <td style="${tdBase};font-size:10px">${fadeTag || '–'}</td>
          <td style="${tdBase};color:#888;font-size:10px">${fmtTime(s.closeTimeMs)}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="9" style="${tdBase};color:#666;text-align:center">No snapshots yet</td></tr>`;

      // ── 4. CONTRACT LOG ───────────────────────────────────────────────────
      const logRows = log.slice(0, 10).map(e => {
        if (!e) return '';
        const settled = e._settled
          ? `<span style="color:#4caf50">✓${e._marketResult || ''}</span>`
          : (e._pendingAuth ? '<span style="color:#ffc107">⏳</span>' : '–');
        const match = e._settled
          ? (e._proxyMismatch ? '<span style="color:#f44336">MM</span>' : '<span style="color:#4caf50">✓</span>') : '';
        const fadeCol = e.fadeActive
          ? (e.fadeCorrect === true ? '<span style="color:#4caf50">F✓</span>'
            : e.fadeCorrect === false ? '<span style="color:#f44336">F✗</span>'
              : '<span style="color:#ff9800">F?</span>')
          : '<span style="color:#555">–</span>';
        const mdivBadge = e.mdivPhase && e.mdivPhase !== 'STALE'
          ? `<span style="font-size:9px;color:#888">${e.mdivPhase}</span>` : '–';
        const betTag = e.betAction
          ? `<span style="color:${e.betAction === 'YES' ? '#4caf50' : '#f44336'};font-weight:700">${e.betAction}</span>` : '–';
        const flags = [e._wickStraddle ? '🔥' : '', e._nearRef ? '≈' : '', e._dirConflict ? '⚠️' : ''].filter(Boolean).join('');
        return `<tr>
          <td style="${tdBase};color:#fff;font-weight:700">${e.sym}</td>
          <td style="${tdBase};${e.outcome === 'YES' ? 'color:#4caf50' : 'color:#f44336'}">${e.outcome || '–'}</td>
          <td style="${tdBase};color:#888;font-size:10px">${fmtPrice(e.ref, e.sym)}</td>
          <td style="${tdBase};color:#aaa;font-size:10px">${e.refDiffPct != null ? e.refDiffPct.toFixed(3) + '%' : '–'}</td>
          <td style="${tdBase};${colDir(e.modelDir)}">${fmtScore(e.modelScore)}</td>
          <td style="${tdBase}">${betTag}</td>
          <td style="${tdBase}">${fadeCol}</td>
          <td style="${tdBase};font-size:10px">${mdivBadge}</td>
          <td style="${tdBase}">${settled}${match}</td>
          <td style="${tdBase};color:#ffc107;font-size:10px">${flags || '–'}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="10" style="${tdBase};color:#666;text-align:center">No contract log entries yet</td></tr>`;

      // ── 5. SETTLED CONTRACTS ─────────────────────────────────────────────
      const resRows = resLog.map(r => {
        const missedTag = r.missedOpportunity
          ? '<span style="color:#e040fb;font-size:9px">MISSED</span>' : '';
        const orchTag = r.orchestratorAction === 'trade'
          ? '<span style="color:#4caf50;font-size:9px">TRADED</span>' : '';
        return `<tr>
          <td style="${tdBase};color:#fff;font-weight:700">${r.sym}</td>
          <td style="${tdBase};color:${r.actualOutcome === 'UP' ? '#4caf50' : '#f44336'};font-weight:700">${r.actualOutcome || '–'}</td>
          <td style="${tdBase};color:#888;font-size:10px">${r.marketResult || '–'}</td>
          <td style="${tdBase}">${r.modelDir || '–'} ${ok(r.modelCorrect)}</td>
          <td style="${tdBase};${colAct(r.orchestratorAction)};font-size:10px">${r.orchestratorAction || '–'} ${orchTag}${missedTag}</td>
          <td style="${tdBase};color:${(r.edgeCents ?? 0) >= 8 ? '#4caf50' : '#888'}">${fmtEdge(r.edgeCents)}</td>
          <td style="${tdBase};font-size:10px;color:#aaa">${r.cbSettlePrice ? fmtPrice(r.cbSettlePrice, r.sym) : fmtPrice(r.floorPrice || r.refPrice, r.sym)}</td>
          <td style="${tdBase};color:${(r.confidence ?? 0) >= 90 ? '#4caf50' : '#ffc107'};font-size:10px">${r.confidence != null ? r.confidence + '%' : '–'}</td>
          <td style="${tdBase};color:#888;font-size:10px">${fmtTime(r.settledTs)}</td>
        </tr>`;

      }).join('') || `<tr><td colspan="9" style="${tdBase};color:#666;text-align:center">No settled contracts yet — first settlement fires ~2 min after contract close_time</td></tr>`;

      // ── 6. ORCHESTRATOR HISTORY ──────────────────────────────────────────
      const orchLogRows = orchLog.slice(0, 12).map(e => {
        const flags = (e.sweetSpot ? '⭐' : '') + (e.crowdFade ? '🔄' : '') + (e.signalLocked ? '🔒' : '');
        return `<tr>
          <td style="${tdBase};color:#fff;font-weight:700">${e.sym}</td>
          <td style="${tdBase};${colAct(e.action)}">${(e.action || '–').toUpperCase()}</td>
          <td style="${tdBase};${e.side === 'YES' ? 'color:#4caf50' : e.side === 'NO' ? 'color:#f44336' : 'color:#888'}">${e.side ?? '–'}</td>
          <td style="${tdBase};color:${alignColor(e.alignment)};font-size:10px">${e.alignment ?? '–'}</td>
          <td style="${tdBase};color:${(e.edgeCents ?? 0) >= 8 ? '#4caf50' : '#888'}">${fmtEdge(e.edgeCents)}</td>
          <td style="${tdBase};${colDir(e.direction)}">${fmtScore(e.modelScore)}</td>
          <td style="${tdBase};color:#888;font-size:10px">${fmtTime(e.ts)}</td>
          <td style="${tdBase};font-size:12px">${flags || '–'}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="8" style="${tdBase};color:#666;text-align:center">No orchestrator history yet — logs on first actionable signal</td></tr>`;

      // ── 7. ERRORS ─────────────────────────────────────────────────────────
      const errRows = errors.map(e => {
        const typeCol = e.type === 'proxy_mismatch' ? '#f44336' : e.type === 'wick_straddle' ? '#ff9800' :
          e.type === 'dir_conflict' ? '#e040fb' : e.type === 'fetch_fail' ? '#f44336' : '#ffc107';
        return `<tr>
          <td style="${tdBase};color:${typeCol};font-weight:600;font-size:10px">${e.type}</td>
          <td style="${tdBase};color:#fff">${e.sym}</td>
          <td style="${tdBase};color:#888;font-size:10px">${e.tsIso?.slice(11, 19) || '–'}</td>
          <td style="${tdBase};font-size:10px">${e.proxy || ''}${e.proxy && e.authoritative ? ' → ' : ''}${e.authoritative || ''}</td>
          <td style="${tdBase};font-size:10px;color:#aaa">${e.refDiffPct != null ? e.refDiffPct.toFixed(3) + '%' : ''} ${e.wickStraddle ? '🔥' : ''} ${e.nearRef ? '≈' : ''}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="5" style="${tdBase};color:#4caf50;text-align:center">No errors 🎉</td></tr>`;

      const trailRows = Object.values(window._marketPredictionTrail || {})
        .sort((a, b) => (b.closeTimeMs || 0) - (a.closeTimeMs || 0))
        .slice(0, 10)
        .map(t => {
          const points = (t.points || [])
            .slice()
            .sort((a, b) => (a.stepIndex || 0) - (b.stepIndex || 0));
          const flips = points.slice(1).reduce((n, p, i) => {
            const prev = points[i];
            return n + ((prev?.modelDir && p?.modelDir && prev.modelDir !== p.modelDir) ? 1 : 0);
          }, 0);
          const seq = points.map(p => {
            const arrow = p.modelDir === 'UP' ? '▲' : p.modelDir === 'DOWN' ? '▼' : '•';
            const pct = p.modelYesPct != null ? `${p.modelYesPct}%` : '—';
            return `${p.minsFromOpen}m ${arrow}${pct}`;
          }).join(' · ');
          return `<tr>
            <td style="${tdBase};color:#fff;font-weight:700">${t.sym || '—'}</td>
            <td style="${tdBase};color:#aaa;font-size:10px">${t.ticker || '—'}</td>
            <td style="${tdBase};color:#888;font-size:10px">${fmtTime(t.closeTimeMs)}</td>
            <td style="${tdBase};color:${flips > 0 ? '#ff9800' : '#4caf50'}">${points.length}</td>
            <td style="${tdBase};color:${flips > 0 ? '#f44336' : '#888'}">${flips}</td>
            <td style="${tdBase};font-size:10px;color:#ddd;max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${seq || '—'}</td>
          </tr>`;
        }).join('') || `<tr><td colspan="6" style="${tdBase};color:#666;text-align:center">No 2-minute prediction trails yet</td></tr>`;

      const pendingN = window.MarketResolver?.getPending?.()?.length ?? 0;

      return `
      <details id="market-debug-panel" class="poly-debug-panel" style="margin:8px 0 14px;background:#111;border:1px solid #2a2a2a;border-radius:8px">
        <summary style="cursor:pointer;padding:8px 14px;font-size:12px;font-weight:700;color:#00e5ff;letter-spacing:.5px;display:flex;align-items:center;gap:8px;user-select:none">
          🔬 POLYMARKET CONTRACT DEBUG
          <span style="font-size:10px;color:#666;font-weight:400;margin-left:auto">
            snap:${Object.keys(snaps).length} log:${(window._marketSettlementLog || []).length} trail:${Object.keys(window._marketPredictionTrail || {}).length} err:${errors.length} res:${resLog.length} pending:${pendingN} orch:${(window._orchLog || []).length}
          </span>
        </summary>
        <div style="padding:10px 14px;border-radius:0 0 8px 8px">

          <div style="font-size:10px;color:#e040fb;font-weight:700;margin-bottom:4px;letter-spacing:.5px">▸ ORCHESTRATOR — LIVE INTENTS</div>
          ${suppressionSummary}
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>ACTION</th><th ${th}>SIDE</th>
              <th ${th}>ALIGNMENT</th><th ${th}>EDGE</th><th ${th}>SCORE</th>
              <th ${th}>TIME LEFT</th><th ${th}>FLAGS</th><th ${th}>STAGE FAILS</th><th ${th}>BLOCKERS</th>
            </tr></thead>
            <tbody>${liveOrchRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#80cbc4;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ ACCURACY SCORECARD</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>N</th><th ${th}>MODEL%</th>
              <th ${th}>POLY%</th><th ${th}>FADE✓</th><th ${th}>TREND</th>
            </tr></thead>
            <tbody>${scorecardRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#00e5ff;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ CURRENT SNAPSHOTS</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>FLOOR</th><th ${th}>STRIKE</th>
              <th ${th}>MODEL</th><th ${th}>mYes%</th><th ${th}>polyYes%</th>
              <th ${th}>CDF</th><th ${th}>FADE</th><th ${th}>CLOSES</th>
            </tr></thead>
            <tbody>${snapRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#4fc3f7;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ CONTRACT LOG (last 10)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>OUTCOME</th><th ${th}>REF</th>
              <th ${th}>GAP%</th><th ${th}>SCORE</th><th ${th}>BET</th>
              <th ${th}>FADE</th><th ${th}>MDIV</th><th ${th}>AUTH</th><th ${th}>FLAGS</th>
            </tr></thead>
            <tbody>${logRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#26c6da;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ 2-MIN PREDICTION TRAIL (15m window)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>TICKER</th><th ${th}>CLOSES</th>
              <th ${th}>PTS</th><th ${th}>FLIPS</th><th ${th}>SEQUENCE</th>
            </tr></thead>
            <tbody>${trailRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#4caf50;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ SETTLED CONTRACTS (last 10)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>RESULT</th><th ${th}>RAW</th>
              <th ${th}>MODEL</th><th ${th}>ORCH</th><th ${th}>EDGE</th>
              <th ${th}>CB$</th><th ${th}>CONF</th><th ${th}>TIME</th>
            </tr></thead>
            <tbody>${resRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#7986cb;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ ORCHESTRATOR HISTORY (last 12 changes)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>SYM</th><th ${th}>ACTION</th><th ${th}>SIDE</th>
              <th ${th}>ALIGNMENT</th><th ${th}>EDGE</th><th ${th}>SCORE</th>
              <th ${th}>TIME</th><th ${th}>FLAGS</th>
            </tr></thead>
            <tbody>${orchLogRows}</tbody>
          </table></div>

          <div style="font-size:10px;color:#f44336;font-weight:700;margin:10px 0 4px;letter-spacing:.5px">▸ ERRORS / MISMATCHES (last 8)</div>
          <div style="overflow-x:auto"><table style="${tbl}">
            <thead><tr>
              <th ${th}>TYPE</th><th ${th}>SYM</th><th ${th}>TIME</th>
              <th ${th}>PROXY→AUTH</th><th ${th}>GAP</th>
            </tr></thead>
            <tbody>${errRows}</tbody>
          </table></div>

          <div style="margin-top:8px;font-size:10px;color:#555;font-family:monospace">
            DevTools: MarketDebug.audit('ETH') · .errors() · .pending() · .suspects({topN:5}) · .replayIncident({topN:2}) · .contract('ETH') · .trail('ETH') · .orch('BTC') · .scorecard()
          </div>
        </div>
      </details>`;
    } catch (panelErr) {
      console.error('[MarketDebug] panel render error:', panelErr);
      return `<details style="margin:8px 0 14px;background:#111;border:1px solid #f44336;border-radius:8px">
        <summary style="padding:8px 14px;color:#f44336;font-size:12px">🔬 MARKET DEBUG — render error</summary>
        <div style="padding:10px 14px;color:#f44336;font-size:11px">${panelErr.message}<br><small style="color:#888">${panelErr.stack || ''}</small></div>
      </details>`;
    }
  }

function buildQuickDecisionPanel(predArr) {
    if (!predArr || predArr.length === 0) return '';

    const ordered = PREDICTION_COINS
      .map(c => predArr.find(p => p.sym === c.sym))
      .filter(Boolean);

    let upCount = 0, downCount = 0, neutralCount = 0;

    const cards = ordered.map(pred => {
      const dir = predictionDirection(pred);
      const dirClass = dir > 0 ? 'up' : dir < 0 ? 'down' : 'neutral';
      const arrow = dir > 0 ? '▲' : dir < 0 ? '▼' : '→';
      const label = dir > 0 ? 'UP' : dir < 0 ? 'DOWN' : 'FLAT';
      const score = Number.isFinite(pred.score) ? (pred.score > 0 ? '+' : '') + pred.score.toFixed(2) : '—';
      const horizon = pred.backtest?.summary?.preferredHorizon ? `${pred.backtest.summary.preferredHorizon}m` : '';
      const mkt = pred.indicators?.mktSentiment;
      const kPct = mkt?.kalshi != null ? Math.round(mkt.kalshi * 100) : null;
      const pPct = mkt?.poly != null ? Math.round(mkt.poly * 100) : null;
      const mktRow = (kPct != null || pPct != null) ? `
        <div class="dc-mkt-row">
          ${kPct != null ? `<span class="dc-badge-k">K:${kPct}%</span>` : ''}
          ${pPct != null ? `<span class="dc-badge-p">P:${pPct}%</span>` : ''}
        </div>` : '';

      // Ground state synthesis for this coin
      const coin = PREDICTION_COINS.find(c => c.sym === pred.sym);
      const wClass = COIN_WEIGHT[pred.sym] || 'light';
      const cfmSnap = window.CFMEngine?.getAll?.()?.[pred.sym];
      const gsVals = cfmSnap ? {
        ...cfmSnap,
        _emaCross: pred.indicators?.ema?.value ?? 0,
        _obvSlope: pred.indicators?.obv?.slope ?? 0,
        _volRatio: pred.indicators?.volume?.ratio ?? 1,
        _bookImbal: pred.indicators?.book?.imbalance ?? 0,
        _aggrBuy: pred.indicators?.flow?.buyRatio ?? 50,
        _funding: pred.derivatives?.funding ?? 0,
        _cvdSlope: pred.cvd?.slope ?? 0,
        _squeezeScore: pred.squeeze ? (pred.squeeze.severity === 'high' ? 2 : 1) : 0,
        _squeezeType: pred.squeeze?.type ?? null,
        _cbPremium: cfmSnap.sources?.CB > 0 && cfmSnap.cfmRate > 0 ? ((cfmSnap.sources.CB - cfmSnap.cfmRate) / cfmSnap.cfmRate) * 100 : 0,
        _mktConsensus: window.PredictionMarkets?.getCoin(pred.sym)?.combinedProb ?? null,
        _xSentiment: window.SocialSentiment?.getCoin(pred.sym)?.score ?? null,
      } : null;
      const gs = gsVals ? computeGroundState(gsVals, pred, wClass) : null;
      const eq = gs ? computeEntryQuality(gs, detectMarketRegime(pred), pred) : null;

      const gsRow = gs ? `
        <div class="dc-gs-row">
          <span class="dc-gs-score ${gs.dir}" title="Ground state: ${gs.stateLabel}">${gs.dir === 'up' ? '▲' : gs.dir === 'down' ? '▼' : '—'} ${gs.score >= 0 ? '+' : ''}${gs.score.toFixed(2)}</span>
          <span class="gs-grade ${eq?.cls || 'wait'}">${eq?.label || '—'}</span>
          ${gs.conflicted ? `<span class="dc-conflict">⚠ CONFLICT</span>` : ''}
        </div>` : '';

      const { primary, secondary } = getDecisionRationale(pred);

      if (dir > 0) upCount++; else if (dir < 0) downCount++; else neutralCount++;

      return `
        <div class="decision-card ${dirClass}${gs?.conflicted ? ' conflicted' : ''}" data-scroll-pred="${pred.sym}" title="${pred.sym} — ${label}  score ${score}">
          <span class="dc-sym">${pred.sym}</span>
          <span class="dc-arrow">${arrow}</span>
          <span class="dc-label">${label}</span>
          <span class="dc-score">${score}</span>
          ${horizon ? `<span class="dc-horizon">${horizon}</span>` : ''}
          ${mktRow}
          ${gsRow}
          ${primary ? `<span class="dc-rationale-primary">${primary}</span>` : ''}
          ${secondary ? `<span class="dc-rationale-secondary">${secondary}</span>` : ''}
          ${pred.llm?.narration ? `<span class="dc-rationale-llm" style="color:var(--color-primary); font-style:italic; font-size: 0.9em; display:block; margin-top:4px;">✨ ${pred.llm.narration}</span>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="decision-band">
        <div class="decision-band-header">
          <span class="decision-band-title">⚡ Market Calls</span>
          <div class="decision-band-tally">
            <span class="tally-up">${upCount} ▲ UP</span>
            <span class="tally-down">${downCount} ▼ DOWN</span>
            <span class="tally-flat">${neutralCount} → FLAT</span>
          </div>
        </div>
        <div class="decision-band-coins">
          ${cards}
        </div>
      </div>`;
  }

function getDecisionRationale(pred) {
    const ind = pred?.indicators || {};
    const dir = predictionDirection(pred);
    const rsi = ind.rsi?.value;
    const adx = ind.adx?.adx;
    const bbPos = ind.bands?.position;
    const vwapDev = ind.vwap?.value;
    const stochK = ind.stochrsi?.k;
    const mfi = ind.mfi?.value;
    const obvSlope = ind.obv?.slope;
    const buyPct = ind.volume?.buyPct;

    let primary = '';
    let secondary = '';

    // ---- 0. Polymarket odds — primary ground truth ────────────────────────
    // Kalshi fetching is disabled -- kalshi15m is always null now, so this
    // was already resolving through to combinedProb (Polymarket-derived) via
    // the fallback below, just mislabeled "Kalshi".
    const _kCoinR = window.PredictionMarkets?.getCoin(pred?.sym);
    const _kProbR = _kCoinR?.poly15m?.probability ?? _kCoinR?.kalshi15m?.probability ?? _kCoinR?.combinedProb ?? null;
    const _strikeR = 'above'; // Polymarket Up/Down is always "beat the opening price"
    const _yesDirR = _strikeR === 'below' ? 'DOWN' : 'UP';
    const _noDirR = _yesDirR === 'UP' ? 'DOWN' : 'UP';
    if (_kProbR !== null) {
      const kp = Math.round(_kProbR * 100);
      if (_kProbR >= 0.68) primary = `Polymarket ${kp}% YES — crowd strongly pricing ${_yesDirR} for this strike`;
      else if (_kProbR <= 0.32) primary = `Polymarket ${100 - kp}% NO — crowd strongly pricing ${_noDirR}`;
      else if (_kProbR >= 0.55) primary = `Polymarket ${kp}% YES — market leans ${_yesDirR}`;
      else if (_kProbR <= 0.45) primary = `Polymarket ${100 - kp}% NO — market leans ${_noDirR}`;
      else primary = `Polymarket near 50/50 (${kp}%) — uncertain, model drives verdict`;
    }

    if (!primary) {
      if (rsi != null && rsi < 30 && dir >= 0) {
        primary = `Mean reversion — RSI ${rsi.toFixed(0)}, oversold bounce`;
      } else if (rsi != null && rsi > 70 && dir <= 0) {
        primary = `Mean reversion — RSI ${rsi.toFixed(0)}, overbought fade`;
      } else if (stochK != null && stochK < 15 && dir >= 0) {
        primary = `StochRSI oversold — ${stochK.toFixed(0)}, reversal setup`;
      } else if (stochK != null && stochK > 85 && dir <= 0) {
        primary = `StochRSI overbought — ${stochK.toFixed(0)}, pullback risk`;
      } else if (mfi != null && mfi < 20 && dir >= 0) {
        primary = `MFI oversold — money flow exhausted, bounce likely`;
      } else if (mfi != null && mfi > 80 && dir <= 0) {
        primary = `MFI overbought — smart money distributing`;

        // ---- 2. Strong trend (ADX > 25) ----
      } else if (adx != null && adx > 28) {
        if (dir > 0) primary = `Strong uptrend — ADX ${adx.toFixed(0)}, trend continuation`;
        else if (dir < 0) primary = `Strong downtrend — ADX ${adx.toFixed(0)}, trend continuation`;
        else primary = `Trending market — ADX ${adx.toFixed(0)}, direction unclear`;

        // ---- 3. Bollinger Band stretch ----
      } else if (bbPos != null && bbPos >= 0.88) {
        primary = dir <= 0 ? `Upper-band stretch — overextended, reversion risk` : `Upper-band breakout — momentum expanding`;
      } else if (bbPos != null && bbPos <= 0.12) {
        primary = dir >= 0 ? `Lower-band stretch — oversold, snap-back setup` : `Lower-band breakdown — momentum extending`;

        // ---- 4. VWAP deviation ----
      } else if (vwapDev != null && Math.abs(vwapDev) > 1.2) {
        if (vwapDev > 0 && dir <= 0) primary = `VWAP extended — ${vwapDev.toFixed(1)}% above, mean reversion`;
        else if (vwapDev < 0 && dir >= 0) primary = `VWAP discount — ${Math.abs(vwapDev).toFixed(1)}% below, reversion bid`;
        else if (vwapDev > 0) primary = `VWAP momentum — price ${vwapDev.toFixed(1)}% above, bulls in control`;
        else primary = `VWAP breakdown — price ${Math.abs(vwapDev).toFixed(1)}% below VWAP`;

        // ---- 5. MACD ----
      } else if (ind.macd?.sig != null) {
        const hist = ind.macd.histogram;
        if (ind.macd.sig > 0 && hist > 0) primary = `MACD bull cross — histogram expanding, momentum building`;
        else if (ind.macd.sig < 0 && hist < 0) primary = `MACD bear cross — histogram deepening, sellers in control`;
        else if (ind.macd.sig > 0) primary = `MACD bullish — signal line above zero`;
        else if (ind.macd.sig < 0) primary = `MACD bearish — signal line below zero`;

        // ---- 6. EMA ----
      } else if (ind.ema?.value != null) {
        if (ind.ema.value > 0.15) primary = `EMA bull cross — short above long, trend aligning`;
        else if (ind.ema.value < -0.15) primary = `EMA bear cross — short below long, trend falling`;
        else primary = `EMA converging — breakout pending`;

        // ---- Generic fallback ----
      } else {
        if (pred?.signal === 'strong_bull') primary = `Strong buy — multiple indicators aligned UP`;
        else if (pred?.signal === 'strong_bear') primary = `Strong sell — multiple indicators aligned DOWN`;
        else if (pred?.signal === 'bullish') primary = `Bullish bias — majority of signals positive`;
        else if (pred?.signal === 'bearish') primary = `Bearish bias — majority of signals negative`;
        else primary = `Mixed signals — insufficient confluence`;
      }
    } // end !primary

    // ---- Secondary: pick the next most relevant fact ----
    if (obvSlope != null) {
      secondary = obvSlope > 0 ? `OBV: accumulation in progress` : `OBV: distribution detected`;
    } else if (buyPct != null && buyPct > 62) {
      secondary = `Volume: ${buyPct.toFixed(0)}% buy-side pressure`;
    } else if (buyPct != null && buyPct < 38) {
      secondary = `Volume: ${(100 - buyPct).toFixed(0)}% sell-side pressure`;
    } else if (ind.ichimoku?.label) {
      secondary = `Ichimoku: ${ind.ichimoku.label}`;
    } else if (ind.mktSentiment?.combined != null) {
      const pct = Math.round(ind.mktSentiment.combined * 100);
      secondary = `Prediction markets: ${pct}% UP probability`;
    } else if (ind.adx?.adx != null && !primary.includes('ADX')) {
      const trending = ind.adx.adx > 20;
      secondary = trending ? `ADX ${ind.adx.adx.toFixed(0)} — ${ind.adx.label.toLowerCase()}` : `ADX ${ind.adx.adx.toFixed(0)} — ranging / consolidation`;
    } else if (rsi != null && !primary.includes('RSI')) {
      secondary = `RSI ${rsi.toFixed(0)} — ${ind.rsi.label}`;
    }

    return { primary, secondary };
  }

function computeQuickMACD(cfm) {
    if (!cfm || !cfm.vwap15 || !cfm.twap15) return 0;
    return ((cfm.vwap15 - cfm.twap15) / cfm.twap15) * 100;
  }

function formatSuborbital(orb, raw) {
    if (raw === undefined || raw === null || (typeof raw === 'number' && !isFinite(raw))) return { display: '\u2014', sentiment: 'flat' };
    if (typeof raw === 'number') raw = Number(raw); // ensure clean number
    switch (orb.fmt) {
      case 'price': return { display: fmtPrice(raw), sentiment: 'flat' };
      case 'num1': {
        const s = raw > 70 ? 'bear' : raw < 30 ? 'bull' : raw > 55 ? 'bull' : raw < 45 ? 'bear' : 'flat';
        return { display: raw.toFixed(1), sentiment: s };
      }
      case 'pct2': return { display: raw.toFixed(2) + '%', sentiment: raw > 2 ? 'warn' : 'flat' };
      case 'pct3': return { display: (raw >= 0 ? '+' : '') + raw.toFixed(3) + '%', sentiment: raw > 0.03 ? 'bull' : raw < -0.03 ? 'bear' : 'flat' };
      case 'pct4': return { display: raw.toFixed(4) + '%', sentiment: raw > 0.05 ? 'warn' : 'flat' };
      case 'sign2': return { display: (raw >= 0 ? '+' : '') + raw.toFixed(2), sentiment: raw > 1 ? 'bull' : raw < -1 ? 'bear' : 'flat' };
      case 'sign4': return { display: (raw >= 0 ? '+' : '') + raw.toFixed(4), sentiment: raw > 0 ? 'bull' : raw < 0 ? 'bear' : 'flat' };
      case 'ratio': return { display: raw.toFixed(2) + 'x', sentiment: raw > 1.15 ? 'bull' : raw < 0.85 ? 'bear' : 'flat' };
      case 'trend': return { display: String(raw).charAt(0).toUpperCase() + String(raw).slice(1), sentiment: raw === 'rising' ? 'bull' : raw === 'falling' ? 'bear' : 'flat' };
      case 'of4': return { display: raw + '/4', sentiment: raw >= 3 ? 'bull' : raw <= 1 ? 'warn' : 'flat' };
      case 'pct1': {
        const s = raw > 60 ? 'bull' : raw < 40 ? 'bear' : 'flat';
        return { display: raw.toFixed(1) + '%', sentiment: s };
      }
      case 'prob1': {
        // Probability 0–1 stored in key, displayed as percentage
        const pct = raw * 100;
        const s = pct > 62 ? 'bull' : pct < 38 ? 'bear' : 'flat';
        return { display: pct.toFixed(0) + '%', sentiment: s };
      }
      case 'compactUsd': {
        if (raw >= 1e9) return { display: '$' + (raw / 1e9).toFixed(1) + 'B', sentiment: 'flat' };
        if (raw >= 1e6) return { display: '$' + (raw / 1e6).toFixed(1) + 'M', sentiment: 'flat' };
        if (raw >= 1e3) return { display: '$' + (raw / 1e3).toFixed(0) + 'K', sentiment: 'flat' };
        return { display: raw > 0 ? '$' + raw.toFixed(0) : '\u2014', sentiment: 'flat' };
      }
      case 'fundingRate': {
        const s = raw > 0.3 ? 'warn' : raw < -0.3 ? 'warn' : raw > 0.01 ? 'bull' : raw < -0.01 ? 'bear' : 'flat';
        return { display: (raw >= 0 ? '+' : '') + raw.toFixed(3) + '%', sentiment: s };
      }
      case 'squeeze': {
        if (raw >= 2) return { display: 'HIGH', sentiment: 'warn' };
        if (raw >= 1) return { display: 'MED', sentiment: 'warn' };
        return { display: 'LOW', sentiment: 'flat' };
      }
      case 'sentiment': {
        // X.com score: -100 to +100
        const s = raw >= 35 ? 'bull' : raw <= -35 ? 'bear' : 'flat';
        return { display: (raw >= 0 ? '+' : '') + Math.round(raw).toString(), sentiment: s };
      }
      default: return { display: String(raw), sentiment: 'flat' };
    }
  }

function evaluateSignal(orb, raw, vals = {}) {
    if (raw === undefined || raw === null) return { signal: null, reason: '', tag: '' };
    const mk = (signal, tag, reason) => ({ signal, tag, reason });
    switch (orb.sym) {
      case 'RSI':
        if (raw >= 78) return mk('bear', 'REV-DN', 'RSI ' + raw.toFixed(0) + ' \u2014 extreme overbought, expect DOWN');
        if (raw <= 22) return mk('bull', 'REV-UP', 'RSI ' + raw.toFixed(0) + ' \u2014 extreme oversold, expect UP');
        if (raw >= 70) return mk('bear', 'REV-DN', 'RSI ' + raw.toFixed(0) + ' \u2014 overbought, contrarian fade');
        if (raw <= 30) return mk('bull', 'REV-UP', 'RSI ' + raw.toFixed(0) + ' \u2014 oversold, bounce scalp');
        if (raw > 45 && raw < 55) return mk('even', 'EVEN', 'RSI neutral \u2014 no edge');
        return mk(null, '', '');
      case 'MOM':
        if (raw > 0.5) return mk('bull', 'TRD-UP', 'Momentum +' + raw.toFixed(2) + '% \u2014 ride the wave');
        if (raw < -0.5) return mk('bear', 'TRD-DN', 'Momentum ' + raw.toFixed(2) + '% \u2014 expect DOWN');
        if (raw > -0.05 && raw < 0.05) return mk('even', 'EVEN', 'Flat momentum \u2014 break-even zone');
        return mk(null, '', '');
      case 'MCD':
        if (raw > 0.005) return mk('bull', 'TRD-UP', 'MACD bullish divergence \u2014 VWAP > TWAP');
        if (raw < -0.005) return mk('bear', 'TRD-DN', 'MACD bearish \u2014 VWAP < TWAP, expect DOWN');
        return mk('even', 'EVEN', 'MACD flat \u2014 no divergence');
      case 'EMA':
        if (raw > 0.3) return mk('bull', 'TRD-UP', 'EMA bull cross +' + raw.toFixed(2) + '% \u2014 trending UP');
        if (raw < -0.3) return mk('bear', 'TRD-DN', 'EMA bear cross ' + raw.toFixed(2) + '% \u2014 trending DOWN');
        if (Math.abs(raw) < 0.05) return mk('even', 'EVEN', 'EMA converging \u2014 no trend');
        return mk(null, '', '');
      case 'OBV':
        if (raw > 50) return mk('bull', 'FLOW-UP', 'Heavy accumulation \u2014 buyers loading');
        if (raw < -50) return mk('bear', 'FLOW-DN', 'Distribution \u2014 smart money selling');
        if (Math.abs(raw) < 5) return mk('even', 'EVEN', 'OBV flat \u2014 no conviction');
        return mk(null, '', '');
      case 'VDL':
        if (raw > 1.4) return mk('bull', 'FLOW-UP', 'Buy pressure ' + raw.toFixed(2) + 'x \u2014 scalp with momentum');
        if (raw < 0.7) return mk('bear', 'FLOW-DN', 'Sell pressure ' + raw.toFixed(2) + 'x \u2014 expect DOWN');
        if (raw > 0.95 && raw < 1.05) return mk('even', 'EVEN', 'Volume balanced \u2014 coin flip');
        return mk(null, '', '');
      case 'ATR':
        if (raw > 3) return mk('danger', 'RISK', 'High vol ' + raw.toFixed(1) + '% \u2014 big moves, wide targets');
        if (raw < 0.3) return mk('even', 'EVEN', 'Low vol \u2014 not worth the spread');
        return mk(null, '', '');
      case 'BKI':
        if (raw > 0.35) return mk('bull', 'BOOK-UP', 'Bid wall \u2014 support below, expect UP');
        if (raw < -0.35) return mk('bear', 'BOOK-DN', 'Ask wall \u2014 resistance above, fade');
        return mk(null, '', '');
      case 'AGR':
        if (raw > 65) return mk('bull', 'TAPE-UP', 'Buy aggression ' + raw.toFixed(0) + '% \u2014 tape says UP');
        if (raw < 35) return mk('bear', 'TAPE-DN', 'Sell aggression ' + (100 - raw).toFixed(0) + '% \u2014 tape says DOWN');
        if (raw > 47 && raw < 53) return mk('even', 'EVEN', 'Trade flow 50/50 \u2014 no edge on tape');
        return mk(null, '', '');
      case 'XSP':
        if (raw > 2) return mk('danger', 'RISK', 'Wide spread ' + raw.toFixed(1) + '% \u2014 fragmented liquidity');
        if (raw > 0.5) return mk('danger', 'ARB?', 'Arb spread ' + raw.toFixed(2) + '% \u2014 cross-exchange opportunity');
        return mk(null, '', '');
      case 'CBP':
        if (raw > 0.1) return mk('bull', 'INST-UP', 'CB premium +' + raw.toFixed(2) + '% \u2014 institutional buying');
        if (raw < -0.1) return mk('bear', 'INST-DN', 'CB discount ' + raw.toFixed(2) + '% \u2014 institutional selling');
        return mk(null, '', '');
      case 'TRD':
        if (raw === 'rising') return mk('bull', 'TRND-UP', 'Trend rising \u2014 go with it');
        if (raw === 'falling') return mk('bear', 'TRND-DN', 'Trend falling \u2014 sell rallies');
        return mk('even', 'EVEN', 'Flat \u2014 range-bound, no directional edge');
      case 'FND':
        if (raw < -0.5) return mk('bull', 'POS-UP', 'Funding ' + raw.toFixed(3) + '% \u2014 shorts overcrowded, squeeze risk = expect UP');
        if (raw < -0.1) return mk('bull', 'POS-UP', 'Funding negative ' + raw.toFixed(3) + '% \u2014 bearish positioning, contrarian UP');
        if (raw > 0.3) return mk('bear', 'POS-DN', 'Funding +' + raw.toFixed(3) + '% \u2014 longs overcrowded, expect DOWN');
        if (raw > 0.1) return mk('bear', 'POS-DN', 'Funding elevated +' + raw.toFixed(3) + '% \u2014 longs paying, expect DOWN');
        return mk(null, '', '');
      case 'SQZ':
        if (raw >= 1) {
          if (vals._squeezeType === 'short_squeeze') return mk('bull', raw >= 2 ? 'SQZ-UP' : 'SQ-UP', raw >= 2 ? 'HIGH squeeze risk \u2014 liquidation cascade imminent, trade squeeze UP' : 'Medium squeeze risk \u2014 watch for upward cascade trigger');
          if (vals._squeezeType === 'long_squeeze') return mk('bear', raw >= 2 ? 'SQZ-DN' : 'SQ-DN', raw >= 2 ? 'HIGH squeeze risk \u2014 liquidation cascade imminent, trade squeeze DOWN' : 'Medium squeeze risk \u2014 watch for downward cascade trigger');
          return mk('danger', 'SQZ?', raw >= 2 ? 'HIGH squeeze risk \u2014 liquidation cascade imminent, direction unclear' : 'Medium squeeze risk \u2014 watch for cascade trigger');
        }
        return mk(null, '', '');
      case 'CVD':
        if (raw > 30) return mk('bull', 'FLOW-UP', 'CVD rising sharply \u2014 aggressive buying, momentum scalp');
        if (raw < -30) return mk('bear', 'FLOW-DN', 'CVD falling sharply \u2014 aggressive selling, expect DOWN');
        if (Math.abs(raw) < 5) return mk('even', 'EVEN', 'CVD flat \u2014 no aggressive order flow');
        return mk(null, '', '');
      case 'MKT':
        if (raw === null || raw === undefined) return mk(null, '', '');
        if (raw > 62) return mk('bull', 'MKT-UP', 'Markets imply ' + raw.toFixed(0) + '% UP — prediction market consensus');
        if (raw < 38) return mk('bear', 'MKT-DN', 'Markets imply ' + (100 - raw).toFixed(0) + '% DOWN — prediction market consensus');
        if (raw > 47 && raw < 53) return mk('even', 'EVEN', 'Markets split ' + raw.toFixed(0) + '/50 — no prediction market edge');
        return mk(null, '', '');
      case 'SNT':
        if (raw === null || raw === undefined) return mk(null, '', '');
        if (raw >= 65) return mk('bull', 'SOC-UP', 'X crowd: +' + raw.toFixed(0) + ' — FOMO building, strong bullish sentiment');
        if (raw >= 35) return mk('bull', 'SOC-UP', 'X crowd: +' + raw.toFixed(0) + ' — positive social flow');
        if (raw <= -65) return mk('bear', 'SOC-DN', 'X crowd: ' + raw.toFixed(0) + ' — fear/panic spreading');
        if (raw <= -35) return mk('bear', 'SOC-DN', 'X crowd: ' + raw.toFixed(0) + ' — negative social flow');
        if (Math.abs(raw) < 15) return mk('even', 'EVEN', 'X crowd: ' + raw.toFixed(0) + ' — mixed, no edge');
        return mk(null, '', '');
      default:
        return mk(null, '', '');
    }
  }

function buildCoinPeriodicTable(coin, cfm, pred) {
    const trendColor = cfm.trend === 'rising' ? 'var(--color-green)' : cfm.trend === 'falling' ? 'var(--color-red)' : 'var(--color-text-muted)';
    const srcKeys = Object.keys(cfm.sources || {});
    const weightClass = COIN_WEIGHT[coin.sym] || 'light';
    const coinRank = WEIGHT_RANK[weightClass];

    const activeOrbitals = SUBORBITALS.filter(orb => {
      const required = ORBITAL_ACCESS[orb.weight] || 1;
      return coinRank >= required;
    });

    const shellCount = new Set(activeOrbitals.map(o => o.shell)).size;
    const atomicMass = activeOrbitals.length;

    const ind = pred?.indicators || {};
    const bookData = ind.book || {};
    const flowData = ind.flow || {};
    const dexMeta = cfm.dexMeta || {};
    const cbPrice = cfm.sources?.CB || 0;

    const vals = {
      ...cfm,
      _rsi: ind.rsi?.value ?? 50,
      _macd: computeQuickMACD(cfm),
      _emaCross: ind.ema?.value ?? 0,
      _obvSlope: ind.obv?.slope ?? 0,
      _volRatio: ind.volume?.ratio ?? 1,
      _atrPct: pred?.volatility?.atrPct ?? 0,
      _bookImbal: bookData.imbalance ?? 0,
      _aggrBuy: flowData.buyRatio ?? 50,
      _cbPremium: cbPrice > 0 && cfm.cfmRate > 0 ? ((cbPrice - cfm.cfmRate) / cfm.cfmRate) * 100 : 0,
      _dexVol: dexMeta.vol ?? 0,
      _dexLiq: dexMeta.liq ?? 0,
      _funding: pred?.derivatives?.funding ?? 0,
      _oi: pred?.derivatives?.oi ?? 0,
      _squeezeScore: pred?.squeeze ? (pred.squeeze.severity === 'high' ? 2 : 1) : 0,
      _squeezeType: pred?.squeeze?.type ?? null,
      _cvdSlope: pred?.cvd?.slope ?? 0,
    };

    const gs = computeGroundState(vals, pred, weightClass);
    const regime = detectMarketRegime(pred);
    const eq = computeEntryQuality(gs, regime, pred);

    const barPct = Math.abs(gs.score) * 50;
    const barFill = `left:${gs.dir === 'down' ? 50 - barPct : 50}%;width:${barPct}%;`;

    const triggerBadges = gs.triggers.map(t =>
      `<span class="gs-trigger ${t.dir} ${t.strength}" title="${t.sym}">${t.sym} ${t.label}</span>`
    ).join('');

    const conflictHtml = gs.conflicted ? `
      <div class="gs-conflict-warn">⚠ Shell conflict — outer catalysts oppose inner state. Reduce size.</div>
    ` : '';

    const gsHtml = `
      <div class="gs-wrap" onclick="event.stopPropagation()">
        <div class="gs-header-row">
          <span class="gs-state-label ${gs.dir}">${gs.stateLabel}</span>
          <div class="gs-bar-outer">
            <div class="gs-bar-center"></div>
            <div class="gs-bar-fill ${gs.dir}" style="${barFill}"></div>
          </div>
          <span style="font-size:10px;font-family:var(--font-mono);color:${gs.dir === 'up' ? 'var(--color-green)' : gs.dir === 'down' ? 'var(--color-red)' : 'var(--color-text-muted)'}">
            ${gs.score >= 0 ? '+' : ''}${gs.score.toFixed(2)}
          </span>
          <span class="gs-grade ${eq.cls}" title="${eq.reason}">${eq.label}</span>
          <span class="gs-regime ${regime.cls}" title="${regime.desc}">${regime.label}</span>
        </div>
        <div class="gs-meta-row">
          ${triggerBadges}
          <span class="gs-confluence ${gs.shellsAligned / gs.shellsTotal < 0.45 ? 'warn' : ''}">${gs.shellsAligned}/${gs.shellsTotal} shells</span>
        </div>
        ${conflictHtml}
      </div>
    `;

    const weightLabel = { heavy: 'Heavy', mid: 'Mid', light: 'Light' }[weightClass];
    const weightBadgeColor = { heavy: 'var(--color-gold)', mid: 'var(--color-primary)', light: 'var(--color-text-faint)' }[weightClass];
    const expanded = cfmExpanded.has(coin.sym);
    const partitionCards = (cfm.partitions || []).map(part => `
      <div class="cfm-detail-card">
        <span class="cfm-detail-label">Partition ${part.i}</span>
        <strong>${part.vwm ? fmtPrice(part.vwm) : '—'}</strong>
        <small>${part.n} samples</small>
      </div>
    `).join('');
    const sourceCards = Object.entries(cfm.sources || {}).map(([src, value]) => `
      <div class="cfm-detail-card">
        <span class="cfm-detail-label">${src}</span>
        <strong>${fmtPrice(value)}</strong>
        <small>${src === 'DEX' && cfm.dexMeta?.pair ? cfm.dexMeta.pair : 'live source'}</small>
      </div>
    `).join('');

    return `
      <div id="cfm-coin-slot-${coin.sym}" class="cfm-coin-block ${expanded ? 'expanded' : ''}" data-cfm-sym="${coin.sym}">
        <button type="button" class="cfm-coin-header cfm-toggle" data-cfm-toggle="${coin.sym}" style="border-left:3px solid ${coin.color};flex-wrap:wrap">
          <div class="cfm-coin-icon" style="background:${coin.color}22;color:${coin.color}">${coinIcon(coin.sym)}</div>
          <div class="cfm-coin-meta">
            <div class="cfm-coin-sym">
              ${coin.sym}
              <span style="font-size:9px;padding:1px 6px;border-radius:9999px;background:${weightBadgeColor}22;color:${weightBadgeColor};font-weight:700;margin-left:6px;letter-spacing:0.04em">${weightLabel} · ${atomicMass} orbitals · ${shellCount} shells</span>
            </div>
            <div class="cfm-coin-name">${coin.name} · ${srcKeys.length}/4 sources · ${cfm.sampleCount} samples</div>
          </div>
          <div>
            <div class="cfm-coin-rate" style="color:${trendColor}">${fmtPrice(cfm.cfmRate)}</div>
            <div class="cfm-coin-sub">
              <span style="color:${cfm.momentum >= 0 ? 'var(--color-green)' : 'var(--color-red)'}">${cfm.momentum >= 0 ? '+' : ''}${cfm.momentum.toFixed(3)}%</span>
              · ${cfm.trend}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:3px;align-items:center">
            ${['CDC', 'CB', 'GKO', 'DEX'].map(src => {
      const has = srcKeys.includes(src);
      const c = src === 'CDC' ? '#1a6eff' : src === 'CB' ? '#0052ff' : src === 'GKO' ? '#8dc63f' : '#a259ff';
      return `<span title="${src}: ${cfm.sources?.[src] ? fmtPrice(cfm.sources[src]) : 'N/A'}" style="width:6px;height:6px;border-radius:50%;background:${has ? c : 'var(--color-border)'};opacity:${has ? 1 : 0.25}"></span>`;
    }).join('')}
            <span class="cfm-expand-icon">${expanded ? '−' : '+'}</span>
          </div>
          ${gsHtml}
        </button>
        <div class="cfm-table">
          ${activeOrbitals.map(orb => renderSuborbital(orb, vals, coin.color)).join('')}
        </div>
        <div class="cfm-expand-panel ${expanded ? 'open' : ''}">
          <div class="cfm-detail-grid">
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Cross Spread</span>
              <strong>${cfm.spread.toFixed(3)}%</strong>
              <small>venue dispersion</small>
            </div>
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Convergence</span>
              <strong>${cfm.convergence.toFixed(3)}%</strong>
              <small>lower is tighter</small>
            </div>
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Bid / Ask</span>
              <strong>${cfm.bidAsk.toFixed(4)}%</strong>
              <small>market tightness</small>
            </div>
            <div class="cfm-detail-card">
              <span class="cfm-detail-label">Backtest Quality</span>
              <strong>${pred?.backtest ? Math.round((pred.backtest.summary?.reliability || 0) * 100) + '%' : '—'}</strong>
              <small>${pred?.diagnostics?.qualityLabel || 'live only'}</small>
            </div>
            ${partitionCards}
            ${sourceCards}
          </div>
          ${cfm.dexMeta ? `
            <div class="cfm-detail-strip">
              <span class="screener-chip">${cfm.dexMeta.chain || 'dex'} / ${cfm.dexMeta.dex || 'aggregated'}</span>
              <span class="screener-chip">${cfm.dexMeta.pair || 'pair n/a'}</span>
              <span class="screener-chip">DEX Vol ${fmtCompactUsd(cfm.dexMeta.vol)}</span>
              <span class="screener-chip">DEX Liq ${fmtCompactUsd(cfm.dexMeta.liq)}</span>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

function computeEntryQuality(gs, regime, pred) {
    const abs = Math.abs(gs.score);
    const conf = gs.shellsTotal > 0 ? gs.shellsAligned / gs.shellsTotal : 0;
    const rel = pred?.backtest?.summary?.reliability ?? 0;

    if (gs.conflicted) {
      return { grade: 'D', label: 'WAIT', cls: 'wait', reason: 'Shell conflict — outer catalysts oppose inner state' };
    }
    if (abs >= 0.50 && conf >= 0.65 && rel >= 0.45) {
      return { grade: 'A', label: 'A-SETUP', cls: 'a', reason: 'High energy + strong confluence + reliable backtest' };
    }
    if (abs >= 0.35 && conf >= 0.55 && rel >= 0.40) {
      return { grade: 'B', label: 'B-SETUP', cls: 'b', reason: 'Good energy + majority aligned' };
    }
    if (abs >= 0.15 && conf >= 0.45) {
      return { grade: 'C', label: 'C-SETUP', cls: 'c', reason: 'Partial confluence — trade smaller size' };
    }
    return { grade: 'D', label: 'WAIT', cls: 'wait', reason: 'Low energy or insufficient confluence' };
  }

function detectMarketRegime(pred) {
    const ind = pred?.indicators || {};
    const adx = ind.adx?.adx ?? 0;
    const atr = pred?.volatility?.atrPct ?? 0;
    const bbWidth = ind.bands?.width ?? null;

    if (atr > 3.0) {
      return { type: 'volatile', label: 'VOLATILE', cls: 'volatile', desc: `ATR ${atr.toFixed(1)}% — wide swings, widen stops` };
    }
    if (adx > 25) {
      const trendDir = ind.adx?.trend > 0 ? ' ▲' : ind.adx?.trend < 0 ? ' ▼' : '';
      return { type: 'trending', label: 'TREND' + trendDir, cls: 'trending', desc: `ADX ${adx.toFixed(0)} — directional, ride momentum` };
    }
    if (bbWidth !== null && bbWidth < 0.04) {
      return { type: 'squeeze', label: 'SQUEEZE', cls: 'breakout', desc: `BB squeeze — breakout imminent, wait for direction` };
    }
    if (adx < 18 && atr < 1.2) {
      return { type: 'ranging', label: 'RANGING', cls: 'ranging', desc: `ADX ${adx.toFixed(0)} — consolidation, fade extremes` };
    }
    return { type: 'neutral', label: 'NEUTRAL', cls: 'neutral', desc: 'No dominant regime — mixed conditions' };
  }

function computeGroundState(vals, pred, weightClass) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const ind = pred?.indicators || {};

    let innerScore = 0;
    let innerCount = 0;

    function addInner(v, w) {
      if (v === null || v === undefined || !isFinite(v)) return;
      innerScore += v * w;
      innerCount += w;
    }

    const vwapDev = ind.vwap?.value ?? 0;
    addInner(clamp(vwapDev / 2, -1, 1), 0.18);

    const rsi = ind.rsi?.value ?? 50;
    addInner(clamp((rsi - 50) / 30, -1, 1), 0.14);

    const macdHist = ind.macd?.histogram ?? 0;
    addInner(clamp(macdHist * 50, -1, 1), 0.10);

    const emaCross = vals._emaCross ?? 0;
    addInner(clamp(emaCross / 0.5, -1, 1), 0.12);

    const trd = vals.trend;
    if (trd === 'rising') addInner(0.7, 0.10);
    else if (trd === 'falling') addInner(-0.7, 0.10);

    const obv = vals._obvSlope ?? 0;
    addInner(clamp(obv / 80, -1, 1), 0.10);

    const volR = vals._volRatio ?? 1;
    addInner(clamp((volR - 1) / 0.5, -1, 1), 0.08);

    if (weightClass !== 'light') {
      addInner(clamp((vals._bookImbal ?? 0) / 0.5, -1, 1), 0.09);
      addInner(clamp(((vals._aggrBuy ?? 50) - 50) / 30, -1, 1), 0.09);
    }

    if (weightClass !== 'light') {
      const fund = vals._funding ?? 0;
      addInner(clamp(-fund / 0.5, -1, 1), 0.08);
    }

    const rawInner = innerCount > 0 ? innerScore / innerCount : 0;
    const innerNorm = clamp(rawInner, -1, 1) * 0.7;

    let outerBoost = 0;
    const triggers = [];

    const sqz = vals._squeezeScore ?? 0;
    if (sqz >= 1) {
      const dir = vals._squeezeType === 'short_squeeze' ? 1 : vals._squeezeType === 'long_squeeze' ? -1 : 0;
      const mag = sqz >= 2 ? 0.40 : 0.25;
      if (dir !== 0) {
        outerBoost += dir * mag;
        triggers.push({ sym: 'SQZ', dir: dir > 0 ? 'bull' : 'bear', label: sqz >= 2 ? 'HIGH' : 'MED', strength: sqz >= 2 ? 'strong' : 'medium' });
      }
    }

    const cvd = vals._cvdSlope ?? 0;
    if (Math.abs(cvd) > 10) {
      const boost = clamp(cvd / 80, -1, 1) * 0.20;
      outerBoost += boost;
      triggers.push({ sym: 'CVD', dir: boost > 0 ? 'bull' : 'bear', label: (cvd >= 0 ? '+' : '') + cvd.toFixed(0), strength: Math.abs(cvd) > 40 ? 'strong' : 'medium' });
    }

    const cbp = vals._cbPremium ?? 0;
    if (Math.abs(cbp) > 0.08) {
      const boost = clamp(cbp / 0.3, -1, 1) * 0.18;
      outerBoost += boost;
      triggers.push({ sym: 'CBP', dir: boost > 0 ? 'bull' : 'bear', label: (cbp >= 0 ? '+' : '') + cbp.toFixed(2) + '%', strength: Math.abs(cbp) > 0.2 ? 'strong' : 'medium' });
    }

    outerBoost = clamp(outerBoost, -0.30, 0.30);

    const raw = clamp(innerNorm + outerBoost, -1.0, 1.0);
    const abs = Math.abs(raw);
    const dir = raw > 0.08 ? 'up' : raw < -0.08 ? 'down' : 'flat';

    let stateLabel, stateClass;
    if (abs >= 0.80) { stateLabel = 'IONISED'; stateClass = 'ionised'; }
    else if (abs >= 0.60) { stateLabel = 'IONISING'; stateClass = 'ionising'; }
    else if (abs >= 0.35) { stateLabel = 'HIGH ENERGY'; stateClass = 'high'; }
    else if (abs >= 0.12) { stateLabel = 'EXCITED'; stateClass = 'excited'; }
    else { stateLabel = 'GROUND'; stateClass = 'ground'; }

    const conflicted = (
      Math.abs(outerBoost) >= 0.15 &&
      Math.sign(outerBoost) !== Math.sign(innerNorm) &&
      Math.abs(innerNorm) >= 0.10
    );

    const bullSignals = pred?.signals?.filter(s => s.dir > 0).length ?? 0;
    const bearSignals = pred?.signals?.filter(s => s.dir < 0).length ?? 0;
    const totalSignals = bullSignals + bearSignals;
    const shellsAligned = dir === 'up' ? bullSignals : dir === 'down' ? bearSignals : Math.min(bullSignals, bearSignals);
    const shellsTotal = Math.max(totalSignals, 1);

    return {
      score: raw,
      innerScore: innerNorm,
      outerBoost,
      dir,
      stateLabel,
      stateClass,
      conflicted,
      triggers,
      shellsAligned,
      shellsTotal,
    };
  }

function buildOpportunitiesPanel(cfmAll, predAll) {
    const allSignals = [];
    const coinEdges = {};

    const polymarketIntents = window.PolymarketOrchestrator?.update(predAll, cfmAll) ?? {};

    try {
      PREDICTION_COINS.forEach(coin => {
        const ki = polymarketIntents[coin.sym];
        if (!ki) return;
        maybePlayContractArrivalBell(coin.sym, ki);
        if (ki.action === 'skip') return;
        const prev = window._orchLog.length
          ? window._orchLog.filter(e => e.sym === coin.sym).slice(-1)[0] : null;
        const changed = !prev
          || prev.action !== ki.action
          || prev.side !== ki.side
          || prev.alignment !== ki.alignment;
        if (changed) {
          const setupType = maybePlayTradeSetupBell(coin.sym, ki);
          window._orchLog.push({
            sym: coin.sym,
            ts: Date.now(),
            action: ki.action,
            side: ki.side ?? null,
            direction: ki.direction ?? null,
            alignment: ki.alignment ?? null,
            edgeCents: ki.edgeCents ?? null,
            confidence: ki.confidence ?? null,
            modelScore: ki.modelScore ?? null,
            secsLeft: ki.secsLeft ?? null,
            minsLeft: ki.minsLeft ?? null,
            sweetSpot: ki.sweetSpot ?? false,
            timingRegime: ki.timingRegime ?? null,
            timingScore: ki.timingScore ?? null,
            closeValue: ki.closeValue ?? false,
            scalpFlip: ki.scalpFlip ?? false,
            missedOpportunityScore: ki.missedOpportunityScore ?? 0,
            crowdFade: ki.crowdFade ?? false,
            signalLocked: ki.signalLocked ?? false,
            setupType: setupType ?? null,
            contractTicker: ki.contractTicker ?? null,
            humanReason: ki.humanReason ?? null,
            regimeTag: ki.regimeTag ?? null,
            waitGuardDiagnostics: ki.waitGuardDiagnostics ?? null,
            mcts: ki.mcts ?? null,
          });
          if (window._orchLog.length > 300) window._orchLog.shift();
          saveOrchLog();
        }
      });
    } catch (orchLogErr) { console.warn('[orchLog]', orchLogErr.message); }

    if (window.DataLogger) {
      PREDICTION_COINS.forEach(coin => {
        const pred = predAll[coin.sym];
        const cfm = cfmAll[coin.sym];
        if (!pred || !cfm || cfm.cfmRate === 0) return;
        const ind = pred.indicators || {};
        const lastPred = window._lastPrediction?.[coin.sym];
        window.DataLogger.logPrediction(coin.sym, {
          dir: pred.direction ?? lastPred?.direction ?? null,
          score: pred.score ?? null,
          conf: pred.confidence ?? null,
          quality: pred.modelQuality ?? null,
          fit: pred.tradeFit ?? null,
          alignment: pred.signalAlignment ?? null,
          rsi: ind.rsi?.value ?? null,
          vwapDev: cfm.vwapDev ?? null,
        });
        const ki = polymarketIntents[coin.sym];
        if (ki) window.DataLogger.logDecision(coin.sym, ki);
      });
      window._cfmAll = cfmAll;
    }

    PREDICTION_COINS.forEach(coin => {
      const cfm = cfmAll[coin.sym];
      const pred = predAll[coin.sym];
      if (!cfm || cfm.cfmRate === 0) return;

      const edge = calcEdge(coin.sym, cfm, pred);
      if (edge) coinEdges[coin.sym] = edge;

      const wc = COIN_WEIGHT[coin.sym] || 'light';
      const rank = WEIGHT_RANK[wc];
      const ind = pred?.indicators || {};
      const dexMeta = cfm.dexMeta || {};
      const cbPrice = cfm.sources?.CB || 0;

      const vals = {
        ...cfm,
        _rsi: ind.rsi?.value ?? 50,
        _macd: computeQuickMACD(cfm),
        _emaCross: ind.ema?.value ?? 0,
        _obvSlope: ind.obv?.slope ?? 0,
        _volRatio: ind.volume?.ratio ?? 1,
        _atrPct: pred?.volatility?.atrPct ?? 0,
        _bookImbal: (ind.book || {}).imbalance ?? 0,
        _aggrBuy: (ind.flow || {}).buyRatio ?? 50,
        _cbPremium: cbPrice > 0 && cfm.cfmRate > 0 ? ((cbPrice - cfm.cfmRate) / cfm.cfmRate) * 100 : 0,
        _dexVol: dexMeta.vol ?? 0,
        _dexLiq: dexMeta.liq ?? 0,
        _funding: pred?.derivatives?.funding ?? 0,
        _oi: pred?.derivatives?.oi ?? 0,
        _squeezeScore: pred?.squeeze ? (pred.squeeze.severity === 'high' ? 2 : 1) : 0,
        _cvdSlope: pred?.cvd?.slope ?? 0,
      };

      const activeOrbs = SUBORBITALS.filter(orb => rank >= (ORBITAL_ACCESS[orb.weight] || 1));
      activeOrbs.forEach(orb => {
        const sig = evaluateSignal(orb, vals[orb.key], vals);
        if (sig.signal && sig.signal !== 'even') {
          allSignals.push({ coin: coin.sym, color: coin.color, orb: orb.sym, shell: orb.shell, signal: sig.signal, tag: sig.tag, reason: sig.reason });
        }
      });
    });

    const verdicts = PREDICTION_COINS
      .map(c => ({ sym: c.sym, color: c.color, edge: coinEdges[c.sym] }))
      .filter(v => v.edge)
      .sort((a, b) => b.edge.edge15 - a.edge.edge15);

    const highConv = verdicts.filter(v => v.edge.tier === 'HIGH CONVICTION');
    const marginal = verdicts.filter(v => v.edge.tier === 'MARGINAL');
    const notWorth = verdicts.filter(v => v.edge.tier === 'NOT WORTH IT' || v.edge.tier === 'BREAK EVEN');

    const scalpCount = allSignals.filter(s => s.signal === 'bull').length;
    const fadeCount = allSignals.filter(s => s.signal === 'bear').length;
    const dangerCount = allSignals.filter(s => s.signal === 'danger').length;

    const callouts = buildNarrativeCallouts(verdicts, allSignals, cfmAll, predAll);
    const liveCalibrationTelemetry = window.PolymarketOrchestrator?.getCalibrationTelemetry?.() || null;

    return `
      ${callouts}
      ${renderLiveCalibrationTelemetryStrip(liveCalibrationTelemetry)}

      <div class="opp-panel" style="border-left:3px solid ${highConv.length > 0 ? 'var(--color-green)' : marginal.length > 0 ? 'var(--color-orange)' : 'var(--color-text-faint)'}">
        <div class="card-title" style="color:var(--color-gold)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Trade Verdicts \u2014 Polymarket Up/Down
        </div>

        ${verdicts.length === 0 ? '<div style="font-size:12px;color:var(--color-text-muted);padding:12px 0">Warming up \u2014 accumulating price data...</div>' : ''}

        <div class="opp-grid">
          ${verdicts.map(v => {
      const e = v.edge;
      const arrow = e.dir === 'up' ? '\u2191' : '\u2193';
      const dirLabel = e.dir === 'up' ? 'UP' : 'DOWN';
      return `
              <div class="opp-card ${e.tier === 'HIGH CONVICTION' ? 'scalp' : e.tier === 'MARGINAL' ? 'fade' : e.tier === 'NOT WORTH IT' ? 'danger' : 'even'}" style="padding:12px">
                <div class="opp-head">
                  <span style="color:${v.color};font-size:14px">${v.sym}</span>
                  <span style="font-size:16px;color:${e.dir === 'up' ? 'var(--color-green)' : 'var(--color-red)'}">${arrow}</span>
                  <span style="font-size:10px;color:var(--color-text-muted)">${dirLabel}</span>
                  <span style="margin-left:auto;font-size:9px;padding:2px 6px;border-radius:9999px;font-weight:700;background:${e.tierColor}22;color:${e.tierColor}">${e.tier}</span>
                </div>
                <div style="font-size:10px;color:var(--color-text-muted);margin:4px 0">${e.tierDesc}</div>

                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;font-family:var(--font-mono);margin-top:4px">
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">15m MOVE</div>
                    <div style="font-weight:700;color:${e.expected15m > e.totalCostPct ? 'var(--color-green)' : 'var(--color-red)'}">${e.expected15m.toFixed(2)}%</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">COST</div>
                    <div style="font-weight:700;color:var(--color-red)">${e.totalCostPct.toFixed(2)}%</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">EDGE</div>
                    <div style="font-weight:700;color:${e.edge15 > 0 ? 'var(--color-green)' : 'var(--color-red)'}">${e.edge15 > 0 ? '+' : ''}${e.edge15.toFixed(2)}%</div>
                  </div>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;font-family:var(--font-mono);margin-top:3px">
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">ENTRY</div>
                    <div style="font-weight:700">${fmtPrice(e.entryPrice)}</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">STOP</div>
                    <div style="font-weight:700;color:var(--color-red)">${fmtPrice(e.stopLoss)}</div>
                  </div>
                  <div style="background:var(--color-surface-3);padding:3px 5px;border-radius:3px">
                    <div style="color:var(--color-text-faint)">TARGET</div>
                    <div style="font-weight:700;color:var(--color-green)">${fmtPrice(e.takeProfit)}</div>
                  </div>
                </div>

                <div style="font-size:9px;color:var(--color-text-faint);margin-top:4px;display:flex;gap:8px">
                  <span>${e.signalCount} confirming signals</span>
                  <span>R:R ${e.riskReward.toFixed(1)}:1</span>
                  <span>ATR ${e.atrPct.toFixed(2)}%</span>
                  <span>${e.edge15 >= 0 ? '+' : ''}$${e.dollarEdgePer100_15.toFixed(2)} per $100</span>
                </div>

                <!-- Kalshi order-routing box removed -- no Polymarket equivalent -->
                </div>
            `;
    }).join('')}
        </div>
      </div>

      ${allSignals.length > 0 ? `
        <div class="opp-panel">
          <div class="card-title" style="color:var(--color-gold)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Flashing Indicators \u2014 ${allSignals.length} active
            <span style="margin-left:auto;font-size:10px;font-weight:400;color:var(--color-text-muted)">
              ${scalpCount > 0 ? '<span style="color:var(--color-green)">' + scalpCount + ' up</span>' : ''}
              ${fadeCount > 0 ? ' <span style="color:var(--color-orange)">' + fadeCount + ' down</span>' : ''}
              ${dangerCount > 0 ? ' <span style="color:var(--color-red)">' + dangerCount + ' risk</span>' : ''}
            </span>
          </div>
          <div class="opp-grid">
            ${allSignals.slice(0, 12).map(s => `
              <div class="opp-card ${s.signal}">
                <div class="opp-head">
                  <span style="color:${s.color}">${s.coin}</span>
                  <span style="font-size:9px;color:var(--color-text-faint)">${s.orb} \u00b7 ${s.shell}</span>
                  <span style="margin-left:auto;font-size:9px;padding:1px 5px;border-radius:9999px;background:${s.signal === 'bull' ? 'var(--color-green-dim)' : s.signal === 'bear' ? 'var(--color-orange-dim)' : 'var(--color-red-dim)'};color:${s.signal === 'bull' ? 'var(--color-green)' : s.signal === 'bear' ? 'var(--color-orange)' : 'var(--color-red)'};font-weight:700;text-transform:uppercase">${s.tag || s.signal}</span>
                </div>
                <div class="opp-desc">${s.reason}</div>
              </div>
            `).join('')}
          </div>
          ${allSignals.length > 12 ? '<div style="font-size:10px;color:var(--color-text-faint);margin-top:6px">+ ' + (allSignals.length - 12) + ' more signals in the tables below</div>' : ''}
        </div>
      ` : `
        <div class="opp-panel">
          <div class="card-title" style="color:var(--color-text-faint)">\u26a1 Indicators</div>
          <div style="font-size:12px;color:var(--color-text-muted);padding:8px 0">No flashing indicators yet \u2014 market is break-even across all orbitals.</div>
        </div>
      `}
    `;
  }

function buildFifteenMinuteMovePlan(ki) {
    if (!ki || ki.action === 'skip') return null;
    const secsLeft = Number.isFinite(ki.secsLeft)
      ? ki.secsLeft
      : (Number.isFinite(ki.closeTimeMs) ? Math.max(0, (ki.closeTimeMs - Date.now()) / 1000) : null);

    let phase = 'UNTIMED';
    if (secsLeft != null) {
      if (secsLeft > 720) phase = 'OPENING';
      else if (secsLeft > 420) phase = 'SETUP';
      else if (secsLeft > 180) phase = 'PRIME';
      else if (secsLeft > 60) phase = 'LATE';
      else if (secsLeft > 5) phase = 'LAST_CALL';
      else phase = 'SETTLING';
    }
    if (ki.timingRegime === 'SCALP_EARLY') phase = 'SCALP';
    else if (ki.timingRegime === 'CLOSE_VALUE') phase = 'CLOSE_VALUE';

    const isTrade = ki.action === 'trade';
    const isHold = ki.action === 'hold';
    const isExit = ki.action === 'earlyExit';
    const isCrowdFade = ki.alignment === 'CROWD_FADE' || !!ki.crowdFade;
    const edge = Number.isFinite(ki.edgeCents) ? ki.edgeCents : null;
    const side = ki.side || '—';

    let title = 'Watch';
    let detail = 'No clean trade setup yet.';
    let tone = 'var(--color-text-muted)';

    if (isExit) {
      title = 'Stand aside';
      detail = 'Shell/early-exit gate is active for this contract.';
      tone = 'var(--color-red)';
    } else if (isHold) {
      title = 'Hold';
      detail = 'Router is collecting confirmation before allowing entry.';
      tone = 'var(--color-orange)';
    } else if (ki.crowdFadeSuggested && !ki.crowdFade) {
      title = 'Stalk fade';
      detail = `Wait ${ki.crowdFadeConfirmLeftSec ?? '?'}s for ${ki.crowdFadeTimingLabel || 'adaptive'} mispricing confirmation before entering ${side}${ki.crowdFadeWindowLabel ? ` (${ki.crowdFadeWindowLabel})` : ''}.`;
      tone = '#ffb74d';
    } else if (phase === 'SCALP') {
      title = isTrade ? `Scalp ${side}` : 'Stalk scalp';
      detail = isTrade
        ? (ki.exitPlan || 'Buy the early flip and sell into the probability expansion before book pressure fades.')
        : `Book/tape scanner is watching for a clean flip${(ki.blockedBy?.length || ki.timingBlocks?.length) ? ': ' + (ki.blockedBy?.length ? ki.blockedBy.slice(0, 2) : ki.timingBlocks.slice(0, 2)).join(', ') : '.'}`;
      tone = isTrade ? 'var(--color-green)' : '#ffb74d';
    } else if (phase === 'OPENING') {
      title = isTrade ? `Prepare ${side}` : 'Observe open';
      detail = isTrade
        ? 'Let the first minute print; avoid instant fills at contract open.'
        : 'Collect tape and flow before committing capital.';
      tone = isTrade ? 'var(--color-text)' : 'var(--color-text-muted)';
    } else if (phase === 'SETUP') {
      title = isTrade ? `Set up ${side}` : 'Watch setup';
      detail = isTrade
        ? `Edge ${edge != null ? (edge >= 0 ? '+' : '') + edge + 'c' : '?'} — queue entry plan, prefer better price into 7m→3m.`
        : 'Model and market are still forming; wait for clearer spread.';
      tone = isTrade ? 'var(--color-green)' : 'var(--color-text-muted)';
    } else if (phase === 'PRIME') {
      title = isTrade ? `Execute ${side}` : 'Prime window';
      detail = isTrade
        ? (isCrowdFade
          ? `Confirmed ${ki.crowdFadeTimingLabel || 'adaptive'} mispricing fade${ki.crowdFadeWindowLabel ? ` (${ki.crowdFadeWindowLabel})` : ''}; execute with disciplined sizing.`
          : 'Best 15m entry window (3m–7m left); execute if edge remains stable.')
        : 'Window is ideal but setup is not confirmed yet.';
      tone = isTrade ? (isCrowdFade ? '#e040fb' : 'var(--color-green)') : '#ffd700';
    } else if (phase === 'LATE') {
      title = isTrade ? `Manage ${side}` : 'Late phase';
      detail = isTrade
        ? 'Late-cycle trade: reduce size unless it upgrades into the 2-3m value window.'
        : 'Stalk only heavy payout skew or clear mispricing into the 2-3m close window.';
      tone = isTrade ? 'var(--color-orange)' : 'var(--color-text-muted)';
    } else if (phase === 'CLOSE_VALUE') {
      title = isTrade ? `Value ${side}` : 'Close-value scan';
      detail = isTrade
        ? (ki.exitPlan || '2-3m mispricing window is active; enter only while edge and book pressure stay aligned.')
        : `Hunting payout/mispricing skew${(ki.blockedBy?.length || ki.timingBlocks?.length) ? ': ' + (ki.blockedBy?.length ? ki.blockedBy.slice(0, 2) : ki.timingBlocks.slice(0, 2)).join(', ') : '.'}`;
      tone = isTrade ? 'var(--color-green)' : '#ffd700';
    } else if (phase === 'LAST_CALL') {
      title = 'Last call';
      detail = 'Final seconds: only exceptional fill-at-price entries; otherwise let the contract settle.';
      tone = 'var(--color-red)';
    } else if (phase === 'SETTLING') {
      title = 'Settling';
      detail = 'Contract is settling — no new entries.';
      tone = 'var(--color-red)';
    }

    if (ki.tailRisk && isTrade) {
      detail += ' Tail-risk pricing detected; keep size conservative.';
    }

    return { phase, title, detail, tone };
  }

function countConfirmingSignals(coin, cfm, pred) {
    const ind = pred?.indicators || {};
    let count = 0;
    const dir = predictionDirection(pred, (cfm.momentum || 0) >= 0 ? 1 : -1);
    if (dir === 0) return 0;

    const rsi = ind.rsi?.value ?? 50;
    if (dir > 0 && rsi < 40) count++;
    if (dir < 0 && rsi > 60) count++;
    if (dir > 0 && (ind.ema?.value ?? 0) > 0.1) count++;
    if (dir < 0 && (ind.ema?.value ?? 0) < -0.1) count++;
    if (dir > 0 && (ind.obv?.slope ?? 0) > 5) count++;
    if (dir < 0 && (ind.obv?.slope ?? 0) < -5) count++;
    if (dir > 0 && (ind.volume?.ratio ?? 1) > 1.2) count++;
    if (dir < 0 && (ind.volume?.ratio ?? 1) < 0.8) count++;
    if (dir > 0 && cfm.trend === 'rising') count++;
    if (dir < 0 && cfm.trend === 'falling') count++;
    if (Math.abs(cfm.momentum || 0) > 0.1) count++;
    const bookImbal = (ind.book?.imbalance ?? 0);
    if (dir > 0 && bookImbal > 0.2) count++;
    if (dir < 0 && bookImbal < -0.2) count++;
    const funding = pred?.derivatives?.funding ?? 0;
    if (dir > 0 && funding < -0.1) count++;
    if (dir < 0 && funding > 0.1) count++;
    const cvdSlope = pred?.cvd?.slope ?? 0;
    if (dir > 0 && cvdSlope > 10) count++;
    if (dir < 0 && cvdSlope < -10) count++;
    if (pred?.squeeze) {
      if (dir > 0 && pred.squeeze.type === 'short_squeeze') count++;
      if (dir < 0 && pred.squeeze.type === 'long_squeeze') count++;
    }

    return count;
  }

function calcEdge(coin, cfm, pred) {
    const price = cfm.cfmRate || cfm.lastPrice || 0;
    if (price === 0) return null;

    const atrPct = pred?.volatility?.atrPct ?? 0;
    const momentum = Math.abs(cfm.momentum || 0);
    const bidAsk = cfm.bidAsk || 0;
    const xSpread = cfm.spread || 0;

    const expected15m = atrPct * Math.sqrt(3);
    const expected60m = atrPct * Math.sqrt(12);

    const totalCostPct = bidAsk + 0.02;

    const edge15 = expected15m - totalCostPct;
    const edge60 = expected60m - totalCostPct;

    const dollarEdgePer100_15 = (edge15 / 100) * 100;
    const dollarEdgePer100_60 = (edge60 / 100) * 100;

    const signalCount = countConfirmingSignals(coin, cfm, pred);

    const pm = window.PredictionMarkets?.getCoin?.(coin?.sym);
    const polymarketYesPrice = pm?.kalshi15m?.probability ?? null;
    const entryIsTailRisk = polymarketYesPrice !== null && polymarketYesPrice >= 0.85;
    const entryIsLeveraged = polymarketYesPrice !== null && polymarketYesPrice <= 0.15;
    const lossErasesWins = entryIsTailRisk
      ? Math.round(polymarketYesPrice / (1 - polymarketYesPrice))
      : null;

    let tier, tierColor, tierDesc;

    if (entryIsTailRisk) {
      tier = 'TAIL RISK'; tierColor = 'var(--color-red)';
      tierDesc = `YES at ${Math.round(polymarketYesPrice * 100)}¢ — 1 loss erases ${lossErasesWins} wins. Need overwhelming edge to justify.`;
    } else if (entryIsLeveraged) {
      tier = edge15 > 0.25 && signalCount >= 3 ? 'HIGH CONVICTION' : 'LEVERAGED';
      tierColor = edge15 > 0.25 && signalCount >= 3 ? 'var(--color-green)' : 'var(--color-orange)';
      tierDesc = `YES at ${Math.round(polymarketYesPrice * 100)}¢ — ${Math.round(1 / polymarketYesPrice)}x payout but high variance. ${signalCount} signals, need wider gap.`;
    } else if (edge15 > 0.25 && signalCount >= 3) {
      tier = 'HIGH CONVICTION'; tierColor = 'var(--color-green)';
      tierDesc = `${signalCount} indicators aligned — strong directional move expected, ${edge15.toFixed(2)}% edge`;
    } else if (edge15 > 0.08 && signalCount >= 2) {
      tier = 'MARGINAL'; tierColor = 'var(--color-orange)';
      tierDesc = `Thin edge — ${edge15.toFixed(2)}% expected move, ${signalCount} signals. Widen gap or wait for confirmation.`;
    } else if (edge15 < 0) {
      tier = 'LOW VOLATILITY'; tierColor = 'var(--color-red)';
      tierDesc = `Expected move ${expected15m.toFixed(2)}% < spread ${totalCostPct.toFixed(2)}% — underlying too quiet for a clear binary direction`;
    } else {
      tier = 'WATCH'; tierColor = 'var(--color-text-faint)';
      tierDesc = `Edge ~0 — market flat, no directional conviction yet`;
    }

    if (tier === 'HIGH CONVICTION' && (pred?.backtest?.summary?.reliability ?? 1) < 0.55) {
      tier = 'MARGINAL'; tierColor = 'var(--color-orange)';
      tierDesc = `Signals align but backtest reliability ${Math.round((pred.backtest.summary.reliability || 0) * 100)}% < 55% gate \u2014 wait for confirmation`;
    }

    const dirBias = predictionDirection(pred, (cfm.momentum || 0) >= 0 ? 1 : -1);
    const dir = dirBias >= 0 ? 'up' : 'down';
    const entryPrice = dir === 'up'
      ? price * (1 - atrPct / 200)
      : price * (1 + atrPct / 200);
    const stopLoss = dir === 'up'
      ? price * (1 - atrPct * 1.5 / 100)
      : price * (1 + atrPct * 1.5 / 100);
    const takeProfit = dir === 'up'
      ? price * (1 + atrPct * 2 / 100)
      : price * (1 - atrPct * 2 / 100);
    const riskReward = atrPct > 0 ? 2.0 : 0;

    return {
      price, atrPct, expected15m, expected60m, totalCostPct, edge15, edge60,
      dollarEdgePer100_15, dollarEdgePer100_60,
      tier, tierColor, tierDesc, signalCount,
      dir, entryPrice, stopLoss, takeProfit, riskReward,
    };
  }

function buildNarrativeCallouts(verdicts, allSignals, cfmAll, predAll) {
    const alerts = []; // { type: 'opp'|'warn'|'info', icon, title, body, coin, color }

    PREDICTION_COINS.forEach(coin => {
      const pred = predAll[coin.sym];
      const cfm = cfmAll[coin.sym];
      if (!pred || !cfm || cfm.cfmRate === 0) return;

      const sym = coin.sym;
      const price = cfm.cfmRate;
      const deriv = pred.derivatives;
      const squeeze = pred.squeeze;
      const cvd = pred.cvd;
      const ind = pred.indicators || {};
      const rsi = ind.rsi?.value ?? 50;
      const mom = cfm.momentum || 0;
      const trend = cfm.trend;
      const volRatio = ind.volume?.ratio ?? 1;
      const obvSlope = ind.obv?.slope ?? 0;
      const emaCross = ind.ema?.value ?? 0;
      const verdict = verdicts.find(v => v.sym === sym);
      const confirming = verdict?.edge?.signalCount ?? 0;
      const funding = deriv?.funding ?? 0;
      const predDir = predictionDirection(pred, 0);
      const predDirLabel = predDir > 0 ? 'UP' : predDir < 0 ? 'DOWN' : 'NEUTRAL';
      const agreement = pred.diagnostics?.agreement ?? 0;
      const conflict = pred.diagnostics?.conflict ?? 0;
      const reliability = pred.diagnostics?.reliability ?? pred.backtest?.summary?.reliability ?? 0;
      const bullishSignals = pred.diagnostics?.bullishSignals ?? 0;
      const bearishSignals = pred.diagnostics?.bearishSignals ?? 0;

      // --- Squeeze alerts ---
      if (squeeze) {
        const dir = squeeze.type === 'short_squeeze' ? 'UP' : 'DOWN';
        const alignsWithPrediction = (dir === 'UP' && predDir > 0) || (dir === 'DOWN' && predDir < 0);
        const urgency = alignsWithPrediction && reliability >= 0.45 && conflict <= 0.4
          ? (squeeze.severity === 'high' ? 'opp' : 'warn')
          : 'info';
        alerts.push({
          type: urgency, coin: sym, color: coin.color,
          icon: squeeze.severity === 'high' ? '\u26a1' : '\u26a0',
          title: `${sym} ${squeeze.type === 'short_squeeze' ? 'Short Squeeze' : 'Long Squeeze'} Risk`,
          body: `Funding at ${funding.toFixed(3)}%. ${squeeze.desc} Prediction bias: ${predDirLabel}.${alignsWithPrediction && confirming >= 3 ? ' ' + confirming + ' indicators confirm.' : alignsWithPrediction ? '' : ' Treat as positioning context until price confirms.'}`,
        });
      }

      // --- RSI extremes ---
      if (rsi >= 75) {
        const aligned = predDir < 0 && reliability >= 0.45 && conflict <= 0.45;
        alerts.push({
          type: aligned ? 'warn' : 'info', coin: sym, color: coin.color, icon: '\ud83d\udcc9',
          title: `${sym} Overbought — RSI ${rsi.toFixed(0)}`,
          body: aligned
            ? `RSI above 75 signals buyer exhaustion. ${trend === 'rising' ? 'Trend still rising but reversal risk is elevated.' : 'Already weakening.'} Prediction bias stays DOWN — tighten stops.`
            : `RSI is stretched but the broader model is not cleanly bearish yet. Treat this as exhaustion context, not a standalone short trigger.`,
        });
      } else if (rsi <= 25) {
        const aligned = predDir > 0 && reliability >= 0.45 && conflict <= 0.45;
        alerts.push({
          type: aligned ? 'opp' : 'info', coin: sym, color: coin.color, icon: '\ud83d\udcc8',
          title: `${sym} Oversold — RSI ${rsi.toFixed(0)}`,
          body: aligned
            ? `RSI below 25 signals seller exhaustion. ${trend === 'falling' ? 'Trend is still down, but the bounce setup is supported by the broader model.' : 'Price is already stabilizing.'} Expect UP — bounce opportunity.`
            : `RSI is deeply oversold, but momentum/flow are still leaning against a clean reversal. Watch for confirmation before treating this as an UP call.`,
        });
      }

      // --- CVD divergence (the cue you missed on BTC) ---
      if (cvd && Math.abs(cvd.slope) > 20) {
        const cvdDir = cvd.slope > 0 ? 'rising' : 'falling';
        const priceDir = mom > 0 ? 'up' : mom < 0 ? 'down' : 'flat';
        if ((cvd.slope > 0 && mom < -0.05) || (cvd.slope < 0 && mom > 0.05)) {
          alerts.push({
            type: 'opp', coin: sym, color: coin.color, icon: '\ud83d\udd04',
            title: `${sym} CVD Divergence Detected`,
            body: `Price moving ${priceDir} but CVD ${cvdDir} — order flow disagrees with price action. ${cvd.slope > 0 ? 'Buyers still aggressive despite price drop → reversal up likely.' : 'Sellers still aggressive despite price rise → exhaustion incoming, take profit.'} This is an exit/entry timing signal.`,
          });
        }
      }

      // --- Multi-signal confluence (HIGH CONVICTION) ---
      if (confirming >= 4 && predDir !== 0 && agreement >= 0.72 && conflict <= 0.28) {
        alerts.push({
          type: 'opp', coin: sym, color: coin.color, icon: '\ud83c\udfaf',
          title: `${sym} High Confluence — ${confirming} Signals Aligned ${predDirLabel}`,
          body: `${bullishSignals} bullish vs ${bearishSignals} bearish components, agreement ${(agreement * 100).toFixed(0)}%, conflict ${(conflict * 100).toFixed(0)}%. EMA ${emaCross > 0 ? 'bull' : 'bear'} cross, OBV ${obvSlope > 0 ? 'accumulation' : 'distribution'}, Vol Delta ${volRatio.toFixed(2)}x, Trend ${trend}${deriv ? ', Funding ' + funding.toFixed(3) + '%' : ''}. ${reliability >= 0.55 ? 'Backtest quality supports this cluster.' : 'Live cluster is strong, but backtest quality is mixed.'}`,
        });
      }

      // --- Volume anomaly ---
      if (volRatio > 1.5) {
        alerts.push({
          type: 'info', coin: sym, color: coin.color, icon: '\ud83d\udcca',
          title: `${sym} Elevated Buy Volume — ${volRatio.toFixed(2)}x ratio`,
          body: `Buy-side volume significantly exceeds sell-side. ${obvSlope > 10 ? 'OBV confirms accumulation.' : 'But OBV not yet confirming — could be a trap.'} Watch for follow-through.`,
        });
      } else if (volRatio < 0.65) {
        alerts.push({
          type: 'warn', coin: sym, color: coin.color, icon: '\ud83d\udcca',
          title: `${sym} Heavy Sell Pressure — ${volRatio.toFixed(2)}x ratio`,
          body: `Sell-side dominating order flow. ${obvSlope < -10 ? 'OBV confirms distribution — expect DOWN.' : 'Volume dropping though, may not sustain.'}`,
        });
      }

      // --- Extreme funding (not squeeze level, but notable) ---
      if (Math.abs(funding) > 0.1 && !squeeze) {
        const side = funding > 0 ? 'longs' : 'shorts';
        alerts.push({
          type: 'info', coin: sym, color: coin.color, icon: '\ud83d\udcb0',
          title: `${sym} Funding Imbalance — ${side} paying ${Math.abs(funding).toFixed(3)}%`,
          body: `${side === 'longs' ? 'Bullish crowding' : 'Bearish crowding'} in perpetual futures. Not at squeeze level yet but positioning is skewed. Contrarian edge building.`,
        });
      }

      // --- Cross-exchange arb opportunity ---
      if (cfm.spread > 0.3) {
        const spreadType = cfm.spread > 5 ? 'warn' : 'info';
        alerts.push({
          type: spreadType, coin: sym, color: coin.color, icon: '\ud83d\udd00',
          title: `${sym} Cross-Exchange Spread ${cfm.spread.toFixed(2)}%`,
          body: spreadType === 'warn'
            ? `Venue disagreement is unusually large, so this is more likely a source mismatch or illiquid venue than a clean arb. Sources: ${Object.keys(cfm.sources || {}).join(', ')}${cfm.dexMeta?.pair ? ` · DEX ${cfm.dexMeta.pair}` : ''}.`
            : `Price diverging across sources. ${cfm.spread > 1 ? 'Significant arb window open.' : 'Mild divergence, watching for convergence trade.'} Sources: ${Object.keys(cfm.sources || {}).join(', ')}.`,
        });
      }
    });

    // --- Market-wide context ---
    const allFunding = PREDICTION_COINS.map(c => predAll[c.sym]?.derivatives?.funding ?? 0).filter(f => f !== 0);
    if (allFunding.length > 0) {
      const avgFunding = allFunding.reduce((a, b) => a + b, 0) / allFunding.length;
      const negCount = allFunding.filter(f => f < -0.1).length;
      const posCount = allFunding.filter(f => f > 0.1).length;
      if (negCount >= 3) {
        alerts.unshift({
          type: 'opp', coin: 'MKT', color: 'var(--color-primary)', icon: '\ud83c\udf0a',
          title: `Market-Wide Short Crowding — ${negCount}/${allFunding.length} coins negative funding`,
          body: `Multiple coins showing negative funding rates simultaneously. This often precedes a broad short squeeze / relief rally. Avg funding: ${fmtSignedPct(avgFunding, 3)}.`,
        });
      } else if (posCount >= 3) {
        alerts.unshift({
          type: 'warn', coin: 'MKT', color: 'var(--color-primary)', icon: '\ud83c\udf0a',
          title: `Market-Wide Long Crowding — ${posCount}/${allFunding.length} coins positive funding`,
          body: `Majority of coins showing positive funding. Leveraged longs are overcrowded. Correction risk elevated. Avg funding: ${fmtSignedPct(avgFunding, 3)}.`,
        });
      }
    }

    if (alerts.length === 0) {
      return `
        <div class="opp-panel" style="border-left:3px solid var(--color-text-faint)">
          <div class="card-title" style="color:var(--color-text-muted)">\ud83d\udce1 Market Read</div>
          <div style="font-size:12px;color:var(--color-text-muted);padding:8px 0;line-height:1.6">
            No strong signals firing. Market is in a neutral / range-bound state across all 7 tokens. The orchestrator is watching every 15 seconds and will flag the moment conviction builds on any coin. Sit tight.
          </div>
        </div>
      `;
    }

    // Sort: opp first, then warn, then info
    const typeOrder = { opp: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

    const oppCount = alerts.filter(a => a.type === 'opp').length;
    const warnCount = alerts.filter(a => a.type === 'warn').length;
    const infoCount = alerts.filter(a => a.type === 'info').length;

    return `
      <div class="opp-panel" style="border-left:3px solid ${oppCount > 0 ? 'var(--color-green)' : warnCount > 0 ? 'var(--color-orange)' : 'var(--color-primary)'}">
        <div class="card-title" style="color:var(--color-text)">
          \ud83d\udce1 Live Market Read \u2014 ${alerts.length} flags
          <span style="margin-left:auto;font-size:10px;font-weight:400;color:var(--color-text-muted)">
            ${oppCount > 0 ? '<span style="color:var(--color-green)">' + oppCount + ' opportunity</span> ' : ''}
            ${warnCount > 0 ? '<span style="color:var(--color-orange)">' + warnCount + ' warning</span> ' : ''}
            ${infoCount > 0 ? '<span style="color:var(--color-primary)">' + infoCount + ' info</span>' : ''}
          </span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
          ${alerts.map(a => {
      const bgColor = a.type === 'opp' ? 'var(--color-green-dim)' : a.type === 'warn' ? 'var(--color-orange-dim)' : 'var(--color-surface-2)';
      const borderColor = a.type === 'opp' ? 'var(--color-green)' : a.type === 'warn' ? 'var(--color-orange)' : 'var(--color-primary)';
      const typeLabel = a.type === 'opp' ? 'OPPORTUNITY' : a.type === 'warn' ? 'WARNING' : 'INTEL';
      const typeBadgeColor = a.type === 'opp' ? 'var(--color-green)' : a.type === 'warn' ? 'var(--color-orange)' : 'var(--color-primary)';
      return `
              <div style="padding:10px 14px;background:${bgColor};border-left:3px solid ${borderColor};border-radius:var(--radius-md)">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <span style="font-size:15px">${a.icon}</span>
                  <span style="font-size:13px;font-weight:700;color:${a.color}">${a.coin}</span>
                  <span style="font-size:12px;font-weight:700;color:var(--color-text)">${a.title}</span>
                  <span style="margin-left:auto;font-size:8px;padding:2px 6px;border-radius:9999px;background:${typeBadgeColor}22;color:${typeBadgeColor};font-weight:700;letter-spacing:0.06em">${typeLabel}</span>
                </div>
                <div style="font-size:11px;color:var(--color-text-muted);line-height:1.5">${a.body}</div>
              </div>
            `;
    }).join('')}
        </div>
      </div>
    `;
  }

function marketRow(c, i) {
    const t = c.ticker;
    const p = price(t), ch = change(t), v = volume(t), h24 = high(t), l24 = low(t);
    const isPortfolio = PORTFOLIO_HOLDINGS.some(h => h.sym === c.sym);
    return `
      <tr id="row-${c.sym}">
        <td style="color:var(--color-text-faint);font-size:11px">${i + 1}</td>
        <td>
          <div class="coin-cell">
            <div class="coin-icon" style="background:${coinColor(c.sym)}22;color:${coinColor(c.sym)}">${coinIcon(c.sym)}</div>
            <div>
              <div class="coin-name">${c.sym} ${isPortfolio ? '<span style="color:var(--color-gold);font-size:9px">●</span>' : ''}</div>
              <div class="coin-sym">${c.name}</div>
            </div>
          </div>
        </td>
        <td class="price-val" id="price-${c.sym}">${t ? fmtPrice(p) : '—'}</td>
        <td class="${chgClass(ch)}" id="chg-${c.sym}">${t ? fmtPct(ch) : '—'}</td>
        <td style="color:var(--color-green)">${t ? fmtPrice(h24) : '—'}</td>
        <td style="color:var(--color-red)">${t ? fmtPrice(l24) : '—'}</td>
        <td>
          <div class="vol-bar-wrap">
            <span>$${fmt(v, 0)}</span>
          </div>
        </td>
        <td class="spark-cell"><canvas class="spark-canvas" id="spark-${c.sym}" width="80" height="28"></canvas></td>
        <td><button class="chart-btn" data-chart="${c.instrument}">Chart</button></td>
      </tr>
    `;
  }
window.APP_UI_COMPONENTS = {
  predictionCard, normalizePredictionCardData, getPredictionCoinMeta, 
  buildMarketDebugPanel, buildQuickDecisionPanel, getDecisionRationale,
  computeQuickMACD, formatSuborbital, evaluateSignal, buildCoinPeriodicTable,
  computeEntryQuality, detectMarketRegime, computeGroundState, buildOpportunitiesPanel,
  buildFifteenMinuteMovePlan, countConfirmingSignals, calcEdge, buildNarrativeCallouts,
  marketRow
};
Object.assign(window, window.APP_UI_COMPONENTS);
})();
