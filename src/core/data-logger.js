// data-logger.js  v2.2
// ══════════════════════════════════════════════════════════════════════════════
// Local-spool JSONL logger + durable Google Drive sync + Ctrl+D debug overlay
//
// Writes low-latency batches to a local spool, then asynchronously syncs them to:
//   H:\My Drive\WECRYP\data\YYYY-MM-DD\{category}.jsonl
//   I:\My Drive\WECRYP\data\YYYY-MM-DD\{category}.jsonl
//
// Each mounted My Drive root is write-probed at startup and every five minutes.
// Categories: predictions · decisions · cfm_snapshots · shell_events ·
//             resolver_outcomes · polymarket_raw · polymarket_5m · logic_debug · errors
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  let LOCAL_ROOT = '';
  let DRIVE_PATHS = [];
  const GOOGLE_DRIVE_ROOTS = [
    'H:\\My Drive\\WECRYP\\data',
    'I:\\My Drive\\WECRYP\\data',
  ];
  const LOCAL_FLUSH_MS = 5_000;
  const CLOUD_SYNC_MS = 60_000;
  const DRIVE_REPROBE_MS = 300_000;
  const POLYMARKET_RAW_SNAPSHOT_MS = 300_000;
  const STORAGE_PROBE_TIMEOUT_MS = 20000;
  let initialDataLoadComplete = false;
  let driveDiscoveryInFlight = null;
  let cloudSyncInFlight = null;
  let lastPolymarketRawSnapshotAt = 0;

  function normalizeRoot(root) {
    return String(root || '').replace(/[\\/]+$/, '');
  }

  function resolveLocalSpoolRoot() {
    const localAppData = normalizeRoot(window.desktopApp?.userEnv?.localAppData);
    return localAppData
      ? `${localAppData}\\WECRYP\\data-spool`
      : 'C:\\WECRYP\\data-spool';
  }

  function writeResultOk(result) {
    return result === true || !!result?.ok;
  }

  function writeResultError(result) {
    if (result === false) return 'write rejected';
    if (!result) return 'no result';
    return result.error || result.code || 'write rejected';
  }

  function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        resolve({ ok: false, code: 'ETIMEDOUT', error: `${label || 'operation'} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    });
    return Promise.race([
      Promise.resolve(promise).catch(error => ({ ok: false, error: error?.message || String(error) })),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async function probeStorageRoot(root) {
    const normalized = normalizeRoot(root);
    const writeFile = window.dataStore?.writeFileDetailed || window.dataStore?.writeFile;
    if (!normalized || !writeFile) {
      return { ok: false, root: normalized, error: 'dataStore write bridge unavailable' };
    }

    const probePath = `${normalized}\\.permission-check\\data-logger-write-probe.json`;
    const payload = JSON.stringify({
      source: 'DataLogger',
      ts: Date.now(),
      root: normalized,
    });
    const result = await withTimeout(
      writeFile(probePath, payload),
      STORAGE_PROBE_TIMEOUT_MS,
      probePath
    );

    if (writeResultOk(result)) return { ok: true, root: normalized, probePath };
    return { ok: false, root: normalized, path: probePath, error: writeResultError(result), code: result?.code || null };
  }

  
  // ── Async drive discovery — runs once on load ─────────────────────────────
  function discoverDrives() {
    if (driveDiscoveryInFlight) return driveDiscoveryInFlight;
    driveDiscoveryInFlight = runDriveDiscovery().finally(() => { driveDiscoveryInFlight = null; });
    return driveDiscoveryInFlight;
  }

  async function runDriveDiscovery() {
    try {
      LOCAL_ROOT = resolveLocalSpoolRoot();
      const localProbe = await probeStorageRoot(LOCAL_ROOT);
      if (!localProbe.ok) {
        throw new Error(`local spool unavailable: ${localProbe.error || localProbe.code || LOCAL_ROOT}`);
      }

      const googleProbes = await Promise.all(GOOGLE_DRIVE_ROOTS.map(probeStorageRoot));
      DRIVE_PATHS = googleProbes.filter(result => result.ok).map(result => result.root);
      _storage.ready = true;
      _storage.discoveredAt = Date.now();
      _storage.googleRoots = [...GOOGLE_DRIVE_ROOTS];
      _storage.googleTargets = [...DRIVE_PATHS];
      _storage.writableRoots = [LOCAL_ROOT, ...DRIVE_PATHS];
      _storage.failedRoots = googleProbes.filter(result => !result.ok);
      _stats.session.storageReady = true;
      _stats.session.storageRoots = 1 + DRIVE_PATHS.length;
      _stats.session.lastStorageDiscovery = Date.now();

      console.log('[DataLogger] local spool:', LOCAL_ROOT);
      console.log('[DataLogger] writable Google My Drive targets:', DRIVE_PATHS.join(' | ') || 'none');
      if (_storage.failedRoots.length) {
        console.warn('[DataLogger] unavailable Google My Drive targets:', _storage.failedRoots.map(result => `${result.root}: ${result.error || result.code || 'probe failed'}`).join(' | '));
      }

      await trackLocalSpoolPartitions();
      if (!initialDataLoadComplete) {
        initialDataLoadComplete = true;
        await loadFreshestData();
        setTimeout(backloadHistoricalData, 5000);
      }
    } catch (e) {
      console.warn('[DataLogger] drive discovery failed:', e.message);
      _storage.ready = true;
      _storage.discoveredAt = Date.now();
      _storage.failedRoots = [{ root: LOCAL_ROOT, error: e.message }];
    }
  }

  async function loadFreshestData() {
    if (!window.dataStore?.readFile) return;
    try {
      const today = todayStr();
      const d = new Date(); d.setDate(d.getDate() - 1);
      const yesterday = localDayStr(d);
      
      const cats = ['predictions', 'decisions', 'resolver_outcomes'];
      for (const day of [yesterday, today]) {
        for (const cat of cats) {
          try {
            let res = null;
            for (const root of [LOCAL_ROOT, ...DRIVE_PATHS]) {
              const candidate = await window.dataStore.readFile(`${root}\\${day}\\${cat}.jsonl`);
              if (candidate?.data || candidate?.content) {
                res = candidate;
                break;
              }
            }
            if (res?.data || res?.content) {
              const content = res.data || res.content;
              const lines = content.split('\\n');
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const obj = JSON.parse(line);
                  if (cat === 'predictions') {
                    const sym = obj.sym;
                    if (!_stats.predictions[sym]) _stats.predictions[sym] = { total: 0, up: 0, down: 0, scores: [] };
                    const s = _stats.predictions[sym];
                    s.total++;
                    if (obj.dir === 'UP') s.up++;
                    if (obj.dir === 'DOWN') s.down++;
                    if (obj.score != null) {
                      s.scores.push(+obj.score);
                      if (s.scores.length > 200) s.scores.shift();
                    }
                  } else if (cat === 'decisions') {
                    const sym = obj.sym;
                    if (!_stats.decisions[sym]) _stats.decisions[sym] = { trade: 0, watch: 0, hold: 0, exit: 0, skip: 0 };
                    const d = _stats.decisions[sym];
                    if (obj.action === 'trade') d.trade++;
                    else if (obj.action === 'earlyExit') d.exit++;
                    else if (obj.action === 'hold') d.hold++;
                    else if (obj.action === 'skip') d.skip++;
                    else d.watch++;
                  } else if (cat === 'resolver_outcomes') {
                    const sym = obj.sym;
                    if (!_stats.resolverOutcomes[sym]) _stats.resolverOutcomes[sym] = { correct: 0, wrong: 0, total: 0 };
                    const r = _stats.resolverOutcomes[sym];
                    r.total++;
                    if (obj.modelCorrect === true) r.correct++;
                    if (obj.modelCorrect === false) r.wrong++;
                  }
                } catch(e) {}
              }
            }
          } catch(e) {}
        }
      }
      console.log('[DataLogger] loadFreshestData complete from', LOCAL_ROOT);
    } catch(e) {
      console.warn('[DataLogger] loadFreshestData error', e);
    }
  }

  async function backloadHistoricalData() {
    if (!DRIVE_PATHS[0] || !window.dataStore?.readFile) return;
    console.log('[DataLogger] background fetching historical data from', DRIVE_PATHS[0]);
    try {
      const cats = ['predictions', 'decisions', 'resolver_outcomes'];
      for (let i = 2; i <= 7; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const day = localDayStr(d);
        for (const cat of cats) {
          const path = `${DRIVE_PATHS[0]}\\${day}\\${cat}.jsonl`;
          try {
            const res = await window.dataStore.readFile(path);
            if (res?.data || res?.content) {
              const content = res.data || res.content;
              const lines = content.split('\\n');
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const obj = JSON.parse(line);
                  // Basic historical accumulation
                  if (cat === 'resolver_outcomes') {
                    const sym = obj.sym;
                    if (!_stats.resolverOutcomes[sym]) _stats.resolverOutcomes[sym] = { correct: 0, wrong: 0, total: 0 };
                    const r = _stats.resolverOutcomes[sym];
                    r.total++;
                    if (obj.modelCorrect === true) r.correct++;
                    if (obj.modelCorrect === false) r.wrong++;
                  }
                } catch(e) {}
              }
            }
          } catch(e) {}
        }
      }
      console.log('[DataLogger] backloadHistoricalData complete');
    } catch(e) {
      console.warn('[DataLogger] backloadHistoricalData error', e);
    }
  }

  // ── Buffer + Stats ──────────────────────────────────────────────────────────
  const _buf = {};   // category -> string[] awaiting local spool
  const _cloudPartitions = new Set(); // day|category files monitored for incremental sync
  const _storage = {
    ready: false,
    discoveredAt: 0,
    drives: [],
    accountHints: [],
    googleRoots: [],
    googleTargets: [],
    writableRoots: [],
    failedRoots: [],
    lastWriteFailure: null,
  };

  const _stats = {
    session: {
      startTs: Date.now(),
      flushCount: 0,
      bytesWritten: 0,
      writeFailures: 0,
      storageReady: false,
      storageRoots: 0,
      lastStorageDiscovery: 0,
      lastWriteFailure: null,
      cloudSyncCount: 0,
      cloudTrackedFiles: 0,
      cloudSyncFailures: 0,
    },
    predictions:      {},   // sym → { total, up, down, scores[] }
    decisions:        {},   // sym → { trade, watch, hold, exit, skip }
    resolverOutcomes: {},   // sym → { correct, wrong, total }
    shellEvents: { photons: 0, vetoFires: 0, vetoReleases: 0, volSpikes: 0 },
    logicDebug: { total: 0, byType: {} }, // type → count
    errors: [],             // last 30
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function localDayStr(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function todayStr() { return localDayStr(); }

  function filePaths(category) {
    const day = todayStr();
    const paths = [`${LOCAL_ROOT}\\${day}\\${category}.jsonl`];
    for (const d of DRIVE_PATHS) paths.push(`${d}\\${day}\\${category}.jsonl`);
    return paths;
  }

  function trackCloudPartition(day, category) {
    _cloudPartitions.add(`${day}|${category}`);
    _stats.session.cloudTrackedFiles = _cloudPartitions.size;
  }

  async function trackLocalSpoolPartitions() {
    if (!LOCAL_ROOT || !window.dataStore?.listDir) return;
    const days = [new Date()];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    days.push(yesterday);

    for (const date of days) {
      const day = localDayStr(date);
      const result = await window.dataStore.listDir(`${LOCAL_ROOT}\\${day}`);
      if (!result?.ok || !Array.isArray(result.entries)) continue;
      for (const entry of result.entries) {
        if (typeof entry !== 'string' || !entry.endsWith('.jsonl')) continue;
        trackCloudPartition(day, entry.slice(0, -6));
      }
    }
  }

  async function appendBlock(filePath, block) {
    const appendLine = window.dataStore?.appendLineDetailed || window.dataStore?.appendLine;
    if (!appendLine) return { ok: false, path: filePath, error: 'dataStore append bridge unavailable' };
    try {
      const result = await appendLine(filePath, block);
      if (writeResultOk(result)) return { ok: true, path: filePath };
      return { ok: false, path: filePath, error: writeResultError(result), code: result?.code || null };
    } catch (error) {
      return { ok: false, path: filePath, error: error?.message || String(error), code: error?.code || null };
    }
  }

  function push(category, obj) {
    if (!_buf[category]) _buf[category] = [];
    obj.ts = obj.ts || Date.now();
    _buf[category].push(JSON.stringify(obj));
  }

  async function flushCat(category) {
    const lines = _buf[category];
    if (!lines || !lines.length) return;

    const block = lines.join('\n');
    _buf[category] = [];
    const day = todayStr();
    const localPath = `${LOCAL_ROOT}\\${day}\\${category}.jsonl`;
    const localResult = await appendBlock(localPath, block);
    if (!localResult.ok) {
      _buf[category] = lines.concat(_buf[category] || []);
      const failureSummary = {
        category,
        ts: Date.now(),
        tier: 'local-spool',
        keptBuffered: true,
        failures: [localResult],
      };
      _storage.lastWriteFailure = failureSummary;
      _stats.session.writeFailures++;
      _stats.session.lastWriteFailure = failureSummary;
      console.warn('[DataLogger] local spool write failed:', category, `${localResult.path}: ${localResult.error || localResult.code || 'failed'}`);
      try {
        window.dispatchEvent(new CustomEvent('data-logger-write-error', { detail: failureSummary }));
      } catch (_) {}
      return;
    }

    trackCloudPartition(day, category);
    _stats.session.bytesWritten += block.length;
  }

  function logPolymarketRaw(data) {
    const now = Date.now();
    if (now - lastPolymarketRawSnapshotAt < POLYMARKET_RAW_SNAPSHOT_MS) return;
    lastPolymarketRawSnapshotAt = now;
    push('polymarket_raw', {
      markets: data,
      snapshotIntervalMs: POLYMARKET_RAW_SNAPSHOT_MS,
    });
  }

  function syncCloudPending() {
    if (cloudSyncInFlight) return cloudSyncInFlight;
    cloudSyncInFlight = runCloudSyncPending().finally(() => { cloudSyncInFlight = null; });
    return cloudSyncInFlight;
  }

  async function runCloudSyncPending() {
    if (!_storage.ready) return;
    if (!DRIVE_PATHS.length) {
      await discoverDrives();
      if (!DRIVE_PATHS.length) return;
    }

    const syncFileIncremental = window.dataStore?.syncFileIncremental;
    if (!syncFileIncremental) {
      console.warn('[DataLogger] incremental Google My Drive sync bridge unavailable');
      return;
    }

    for (const queueKey of _cloudPartitions) {
      const separatorIndex = queueKey.indexOf('|');
      const day = queueKey.slice(0, separatorIndex);
      const category = queueKey.slice(separatorIndex + 1);
      const sourcePath = `${LOCAL_ROOT}\\${day}\\${category}.jsonl`;

      for (const root of DRIVE_PATHS) {
        const cloudPath = `${root}\\${day}\\${category}.jsonl`;
        const driveId = String(root).slice(0, 1).toLowerCase() || 'drive';
        const statePath = `${LOCAL_ROOT}\\.sync-state\\${driveId}\\${day}\\${category}.json`;
        const result = await syncFileIncremental({ sourcePath, targetPath: cloudPath, statePath });
        if (result.ok) {
          _stats.session.cloudSyncCount++;
          continue;
        }

        const failureSummary = {
          category,
          ts: Date.now(),
          tier: 'google-drive',
          keptBuffered: true,
          failures: [result],
        };
        _storage.lastWriteFailure = failureSummary;
        _stats.session.writeFailures++;
        _stats.session.cloudSyncFailures++;
        _stats.session.lastWriteFailure = failureSummary;
        console.warn('[DataLogger] Google My Drive sync failed; local spool retained:', `${cloudPath}: ${result.error || result.code || 'failed'}`);
      }
    }
  }

  async function flushAll() {
    _stats.session.flushCount++;
    for (const cat of Object.keys(_buf)) await flushCat(cat);

    // Snapshot current CFM state
    const cfmAll = window._cfmAll || window._lastCfm || {};
    if (Object.keys(cfmAll).length) {
      const snap = {};
      for (const [sym, c] of Object.entries(cfmAll)) {
        snap[sym] = {
          cfmRate:     +(c.cfmRate   ?? 0).toFixed(6),
          momentum:    +(c.momentum  ?? 0).toFixed(6),
          trend:       c.trend       ?? 'neutral',
          sourceCount: c.sourceCount ?? 0,
        };
      }
      push('cfm_snapshots', { snap });
      await flushCat('cfm_snapshots');
    }
  }

  // ── Public log methods ───────────────────────────────────────────────────────
  function logPrediction(sym, data) {
    push('predictions', { sym, ...data });
    if (!_stats.predictions[sym]) _stats.predictions[sym] = { total: 0, up: 0, down: 0, scores: [] };
    const s = _stats.predictions[sym];
    s.total++;
    if (data.dir === 'UP')   s.up++;
    if (data.dir === 'DOWN') s.down++;
    if (data.score != null) {
      s.scores.push(+data.score);
      if (s.scores.length > 200) s.scores.shift();
    }
  }

  function logDecision(sym, intent) {
    if (!intent) return;
    push('decisions', {
      sym,
      action:    intent.action,
      alignment: intent.alignment,
      side:      intent.side,
      conf:      intent.confidence,
      timingRegime: intent.timingRegime ?? null,
      timingScore: intent.timingScore ?? null,
      closeValue: !!intent.closeValue,
      scalpFlip: !!intent.scalpFlip,
      missedOpportunityScore: intent.missedOpportunityScore ?? 0,
      reason:    (intent.reason || '').slice(0, 100),
    });
    if (!_stats.decisions[sym]) _stats.decisions[sym] = { trade: 0, watch: 0, hold: 0, exit: 0, skip: 0 };
    const d = _stats.decisions[sym];
    if      (intent.action === 'trade')     d.trade++;
    else if (intent.action === 'earlyExit') d.exit++;
    else if (intent.action === 'hold')      d.hold++;
    else if (intent.action === 'skip')      d.skip++;
    else                                    d.watch++;
  }

  function logShellEvent(type, data) {
    push('shell_events', { type, ...data });
    const s = _stats.shellEvents;
    if (type === 'photon_emitted') s.photons++;
    if (type === 'veto_confirmed') s.vetoFires++;
    if (type === 'veto_released')  s.vetoReleases++;
    if (type === 'vol_ionize')     s.volSpikes++;
  }

  function logResolverOutcome(sym, res) {
    // Accept full resolution object or legacy (sym, outcome, modelCorrect, prob) signature
    const isFullObj = res && typeof res === 'object' && ('actualOutcome' in res || 'outcome' in res);
    const outcome     = isFullObj ? (res.actualOutcome ?? res.outcome) : res;
    const modelCorrect= isFullObj ? res.modelCorrect : arguments[2];
    const prob        = isFullObj ? (res.entryProb ?? arguments[3]) : arguments[3];

    const intent = window.KalshiOrchestrator?.getIntent?.(sym);
    push('resolver_outcomes', {
      sym,
      outcome,
      modelCorrect,
      prob:           Math.round((prob || 0.5) * 100),
      action:         isFullObj ? (res.orchestratorAction ?? intent?.action ?? null) : (intent?.action ?? null),
      // Extended fields from full resolution object
      modelScore:     isFullObj ? (res.modelScore     ?? null) : null,
      alignment:      isFullObj ? (res.orchestratorAlign ?? null) : null,
      sweetSpot:      isFullObj ? (res.sweetSpot      ?? false) : false,
      crowdFade:      isFullObj ? (res.crowdFade       ?? false) : false,
      edgeCents:      isFullObj ? (res.edgeCents       ?? null) : null,
      entryPrice:     isFullObj ? (res.entryPrice      ?? null) : null,
      timingRegime:   isFullObj ? (res.timingRegime    ?? null) : null,
      timingScore:    isFullObj ? (res.timingScore     ?? null) : null,
      closeValue:     isFullObj ? (res.closeValue      ?? false) : false,
      scalpFlip:      isFullObj ? (res.scalpFlip       ?? false) : false,
      missedOpportunityScore: isFullObj ? (res.missedOpportunityScore ?? 0) : 0,
      wickedOut:      isFullObj ? (res.wickedOut        ?? false) : false,
      lateEntry:      isFullObj ? (res.lateEntry        ?? false) : false,
      closeSnapshots: isFullObj ? (res.closeSnapshots  ?? []) : [],
      confidence:     isFullObj ? (res.confidence      ?? null) : null,
      ticker:         isFullObj ? (res.ticker          ?? null) : null,
      strikeDir:      isFullObj ? (res.strikeDir       ?? null) : null,
      floorPrice:     isFullObj ? (res.floorPrice      ?? null) : null,
    });

    if (!_stats.resolverOutcomes[sym])
      _stats.resolverOutcomes[sym] = { correct: 0, wrong: 0, total: 0 };
    const r = _stats.resolverOutcomes[sym];
    r.total++;
    if (modelCorrect === true)  r.correct++;
    if (modelCorrect === false) r.wrong++;

    // ── localStorage summary cache (last 100 contracts, compact) ────────────
    try {
      const cacheKey = 'wc_contract_log';
      let cache = [];
      try { cache = JSON.parse(localStorage.getItem(cacheKey) || '[]'); } catch (_) {}
      const compact = {
        sym,
        ts:         Date.now(),
        dir:        isFullObj ? (res.modelDir ?? null) : null,
        outcome,
        correct:    modelCorrect,
        score:      isFullObj ? (res.modelScore ?? null) : null,
        kalshiPct:  Math.round((prob || 0.5) * 100),
        sweetSpot:  isFullObj ? (res.sweetSpot ?? false) : false,
        wickedOut:  isFullObj ? (res.wickedOut ?? false) : false,
        alignment:  isFullObj ? (res.orchestratorAlign ?? null) : null,
        edgeCents:  isFullObj ? (res.edgeCents ?? null) : null,
        timingRegime: isFullObj ? (res.timingRegime ?? null) : null,
        timingScore: isFullObj ? (res.timingScore ?? null) : null,
        closeValue: isFullObj ? (res.closeValue ?? false) : false,
        scalpFlip: isFullObj ? (res.scalpFlip ?? false) : false,
      };
      cache.push(compact);
      if (cache.length > 100) cache = cache.slice(-100);
      localStorage.setItem(cacheKey, JSON.stringify(cache));
    } catch (_) {}

    flushCat('resolver_outcomes');
  }

  function logError(source, err, { sym, ticker } = {}) {
    const entry = { source, msg: String(err?.message || err).slice(0, 200), ts: Date.now() };
    if (sym)    entry.sym    = sym;
    if (ticker) entry.ticker = ticker;
    push('errors', entry);
    _stats.errors.push(entry);
    if (_stats.errors.length > 30) _stats.errors.shift();
    flushCat('errors');
  }

  function logLogicDebug(source, type, data = {}) {
    const entry = {
      source: String(source || 'unknown').slice(0, 64),
      type: String(type || 'unspecified').slice(0, 64),
      ts: Date.now(),
      ...data,
    };
    push('logic_debug', entry);
    _stats.logicDebug.total++;
    _stats.logicDebug.byType[entry.type] = (_stats.logicDebug.byType[entry.type] || 0) + 1;
    flushCat('logic_debug');
  }

  // ── Hourly Kalshi outcome logger ─────────────────────────────────────────────
  function logOutcome(sym, record) {
    push('hourly_kalshi', {
      sym,
      ts: record.ts,
      closeTimeMs: record.closeTimeMs,
      kalshiYes: record.kalshiYes,
      outcome: record.outcome,
      edgeRealized: record.edgeRealized,
      payout: record.payout,
      entryPrice: record.entryPrice,
    });
  }

  // ── Debug Overlay (Ctrl+D) ───────────────────────────────────────────────────
  let _overlayEl  = null;
  let _overlayOn  = false;
  let _refreshTmr = null;

  function buildHTML() {
    const s     = _stats;
    const upMin = Math.floor((Date.now() - s.session.startTs) / 60000);
    const kb    = (s.session.bytesWritten / 1024).toFixed(1);

    /* ── Prediction rows ── */
    const predRows = Object.entries(s.predictions).map(([sym, p]) => {
      const avg = p.scores.length
        ? (p.scores.reduce((a, b) => a + b, 0) / p.scores.length).toFixed(3)
        : '—';
      const r   = s.resolverOutcomes[sym];
      const acc = r?.total ? Math.round(r.correct / r.total * 100) : null;
      const accColor = acc == null ? '' : acc >= 55 ? 'var(--color-up)' : acc >= 45 ? 'var(--color-gold)' : 'var(--color-down)';
      return `<tr>
        <td>${sym}</td><td>${p.total}</td>
        <td style="color:var(--color-up)">${p.up}</td>
        <td style="color:var(--color-down)">${p.down}</td>
        <td style="color:${+avg < 0 ? 'var(--color-down)' : 'var(--color-up)'}">${avg}</td>
        <td>${acc != null ? `<b style="color:${accColor}">${acc}%</b> (${r.total})` : '—'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="color:var(--color-text-muted)">No data yet — waiting for prediction cycles</td></tr>';

    /* ── Decision rows ── */
    const decRows = Object.entries(s.decisions).map(([sym, d]) => `<tr>
      <td>${sym}</td>
      <td style="color:var(--color-green)">${d.trade}</td>
      <td>${d.watch}</td>
      <td style="color:var(--color-gold)">${d.hold}</td>
      <td style="color:var(--color-red)">${d.exit}</td>
      <td style="color:var(--color-text-muted)">${d.skip}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="color:var(--color-text-muted)">No decisions yet</td></tr>';

    /* ── Live CFM rows ── */
    const cfmAll  = window._cfmAll || window._lastCfm || {};
    const cfmRows = Object.entries(cfmAll).map(([sym, c]) => {
      const mom = c.momentum || 0;
      const col = mom > 0.01 ? 'var(--color-up)' : mom < -0.01 ? 'var(--color-down)' : 'var(--color-text-muted)';
      return `<tr>
        <td>${sym}</td>
        <td style="color:${col}">${mom.toFixed(5)}</td>
        <td>${(c.cfmRate || 0).toFixed(5)}</td>
        <td>${c.trend || '—'}</td>
        <td>${c.sourceCount || 0}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" style="color:var(--color-text-muted)">CFM warming up…</td></tr>';

    /* ── Shell router rows ── */
    const sr  = window._shellRouter;
    const shRows = sr
      ? Object.entries(sr.shells || {}).map(([key, sh]) => {
          const col = sh.ionized ? 'var(--color-down)' : sh.volSpiked ? 'var(--color-gold)' : 'var(--color-text-muted)';
          return `<tr>
            <td>${key}</td>
            <td style="color:${col}">${(sh.velocity || 0).toFixed(4)}</td>
            <td>${sh.ionized ? '⚡ IONIZED' : sh.volSpiked ? `📊 ${(sh.volSpikeMult || 0).toFixed(1)}×` : '—'}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="3" style="color:var(--color-text-muted)">Shell router inactive</td></tr>';

    /* ── Error rows ── */
    const errRows = s.errors.slice(-8).reverse().map(e =>
      `<tr><td style="color:var(--color-red);white-space:nowrap">${e.source}</td>
       <td style="color:var(--color-text-muted);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.msg}</td></tr>`
    ).join('');

    return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:10px">
      <span style="font-size:15px;font-weight:800;color:var(--color-primary,#7c6aff)">⚙ WeCrypto Debug Metrics</span>
      <span style="font-size:10px;color:var(--color-text-muted)">
        Uptime <b>${upMin}m</b> · <b>${s.session.flushCount}</b> local flushes · <b>${kb} KB</b> written ·
        <b>${1 + DRIVE_PATHS.length}</b> storage root(s) active · <kbd style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px">Ctrl+D</kbd> close
      </span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">

      <!-- Col 1: Predictions + Decisions -->
      <div>
        <div class="dl-head">📊 Prediction Counts &amp; Accuracy</div>
        <table class="dl-tbl">
          <thead><tr><th>Coin</th><th>Total</th><th>UP</th><th>DN</th><th>AvgScore</th><th>15M Acc</th></tr></thead>
          <tbody>${predRows}</tbody>
        </table>

        <div class="dl-head" style="margin-top:12px">🎯 Orchestrator Decisions</div>
        <table class="dl-tbl">
          <thead><tr><th>Coin</th><th style="color:var(--color-green)">Trade</th><th>Watch</th><th style="color:var(--color-gold)">Hold</th><th style="color:var(--color-red)">Exit</th><th>Skip</th></tr></thead>
          <tbody>${decRows}</tbody>
        </table>
      </div>

      <!-- Col 2: CFM + Shell -->
      <div>
        <div class="dl-head">⚡ Live CFM Momentum</div>
        <table class="dl-tbl">
          <thead><tr><th>Coin</th><th>Mom</th><th>Rate</th><th>Trend</th><th>Src</th></tr></thead>
          <tbody>${cfmRows}</tbody>
        </table>

        <div class="dl-head" style="margin-top:12px">🛡 Shell Router</div>
        <table class="dl-tbl">
          <thead><tr><th>Shell</th><th>Velocity</th><th>State</th></tr></thead>
          <tbody>${shRows}</tbody>
        </table>

        <div style="font-size:10px;color:var(--color-text-muted);margin-top:8px;line-height:1.7">
          Photons: <b>${s.shellEvents.photons}</b> ·
          Veto fires: <b style="color:${s.shellEvents.vetoFires ? 'var(--color-gold)' : 'inherit'}">${s.shellEvents.vetoFires}</b> ·
          Released: <b>${s.shellEvents.vetoReleases}</b> ·
          Vol spikes: <b style="color:${s.shellEvents.volSpikes ? 'var(--color-gold)' : 'inherit'}">${s.shellEvents.volSpikes}</b> ·
          Logic anomalies: <b style="color:${s.logicDebug.total ? 'var(--color-gold)' : 'inherit'}">${s.logicDebug.total}</b>
        </div>
      </div>

      <!-- Col 3: Errors + Storage info -->
      <div>
        ${s.errors.length
          ? `<div class="dl-head" style="color:var(--color-red)">⚠ Recent Errors (${s.errors.length})</div>
             <table class="dl-tbl">
               <thead><tr><th>Source</th><th>Message</th></tr></thead>
               <tbody>${errRows}</tbody>
             </table>`
          : `<div style="padding:14px 12px;background:rgba(0,200,100,0.07);border:1px solid rgba(0,200,100,0.2);border-radius:6px;font-size:11px;color:var(--color-green,#00c864)">
               ✅ No errors this session
             </div>`}

        <div style="margin-top:14px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:6px;font-size:10px;color:var(--color-text-muted);line-height:1.9">
          <div style="font-weight:700;color:var(--color-text,#e2e8f0);margin-bottom:4px">💾 Storage Paths (${1 + DRIVE_PATHS.length} roots)</div>
          <div>📁 Local spool: <code>${LOCAL_ROOT}\\${todayStr()}</code></div>
          ${DRIVE_PATHS.map(p => `<div>💾 Google My Drive: <code>${p}\\${todayStr()}</code></div>`).join('')}
          ${DRIVE_PATHS.length === 0 ? '<div style="color:var(--color-gold)">⚠ Google My Drive unavailable; retaining local spool</div>' : ''}
          <div>Cloud monitor: <b>${s.session.cloudTrackedFiles}</b> files · sync checks: <b>${s.session.cloudSyncCount}</b> · failures: <b>${s.session.cloudSyncFailures}</b></div>
          ${_storage.accountHints.length ? `<div>Google accounts: <code>${_storage.accountHints.join('</code> · <code>')}</code></div>` : ''}
          ${s.session.writeFailures ? `<div style="color:var(--color-red);margin-top:4px">Write failures: <b>${s.session.writeFailures}</b> · last: <code>${s.session.lastWriteFailure?.category || 'unknown'}</code></div>` : ''}
          <div style="margin-top:6px">Categories: predictions · decisions · cfm_snapshots · shell_events · resolver_outcomes · polymarket_raw · polymarket_5m · logic_debug · errors</div>
        </div>

        <div style="margin-top:10px;font-size:10px;color:var(--color-text-muted)">
          Auto-refresh every 3s · Local flush every 5s · Google sync every 60s · Press <kbd style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px">Ctrl+D</kbd> or <kbd style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px">Esc</kbd> to close
        </div>
      </div>

    </div>`;
  }

  function injectStyles() {
    if (document.getElementById('dl-styles')) return;
    const s = document.createElement('style');
    s.id = 'dl-styles';
    s.textContent = `
      #wc-debug-overlay { box-sizing:border-box }
      .dl-head { font-size:10px;font-weight:700;color:var(--color-text-muted,#8892a4);text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px }
      .dl-tbl  { width:100%;border-collapse:collapse;font-size:10px }
      .dl-tbl th { text-align:left;padding:3px 6px;color:var(--color-text-muted,#8892a4);border-bottom:1px solid rgba(255,255,255,0.1) }
      .dl-tbl td { padding:3px 6px;border-bottom:1px solid rgba(255,255,255,0.04) }
      .dl-tbl tr:hover td { background:rgba(255,255,255,0.03) }
    `;
    document.head.appendChild(s);
  }

  function showOverlay() {
    injectStyles();
    if (!_overlayEl) {
      _overlayEl = document.createElement('div');
      _overlayEl.id = 'wc-debug-overlay';
      Object.assign(_overlayEl.style, {
        position:   'fixed',
        inset:      '0',
        zIndex:     '99999',
        background: 'rgba(7,12,28,0.97)',
        overflowY:  'auto',
        padding:    '20px 26px',
        fontFamily: 'var(--font-mono,monospace)',
        fontSize:   '11px',
        color:      'var(--color-text,#e2e8f0)',
      });
      document.body.appendChild(_overlayEl);
    }
    _overlayEl.innerHTML = buildHTML();
    _overlayEl.style.display = 'block';
    _overlayOn = true;
    if (!_refreshTmr) _refreshTmr = setInterval(() => {
      if (_overlayOn && _overlayEl) _overlayEl.innerHTML = buildHTML();
    }, 3000);
  }

  function hideOverlay() {
    if (_overlayEl) _overlayEl.style.display = 'none';
    _overlayOn = false;
    if (_refreshTmr) { clearInterval(_refreshTmr); _refreshTmr = null; }
  }

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'd') { e.preventDefault(); _overlayOn ? hideOverlay() : showOverlay(); }
    if (e.key === 'Escape' && _overlayOn) hideOverlay();
  });

  // ── Wire shell / market events ───────────────────────────────────────────────
  window.addEventListener('shell:vetoConfirmed', e => {
    logShellEvent('veto_confirmed', { sym: e.detail?.sym, energy: e.detail?.amplifiedEnergy });
    flushCat('shell_events');
  });
  window.addEventListener('shell:vetoReleased', e => {
    logShellEvent('veto_released', { sym: e.detail?.sym, reason: e.detail?.reason });
  });
  window.addEventListener('market15m:resolved', e => {
    const { sym } = e.detail || {};
    if (sym) {
      // Pass full resolution object from _resolutionMap if available, else fall back to event detail
      const res = window._resolutionMap?.[sym] ?? e.detail;
      logResolverOutcome(sym, res);
    }
  });

  // ── Global error capture ─────────────────────────────────────────────────────
  window.addEventListener('error', e => logError('window', e.error || e.message));
  window.addEventListener('unhandledrejection', e => logError('promise', e.reason));

  // Local writes stay off the cloud mount's latency path; cloud sync retries independently.
  setInterval(flushAll, LOCAL_FLUSH_MS);
  setInterval(syncCloudPending, CLOUD_SYNC_MS);
  setInterval(discoverDrives, DRIVE_REPROBE_MS);

  // ── Public API ───────────────────────────────────────────────────────────────
  window.DataLogger = {
    logPrediction,
    logDecision,
    logShellEvent,
    logResolverOutcome,
    logOutcome,
    logLogicDebug,
    logError,
    logPolymarketOutcome: (sym, record) => push('polymarket_outcomes', { sym, ...record, ts: Date.now() }),
    logPolymarket: logPolymarketRaw,
    logPolymarket5M: (data) => push('polymarket_5m', { markets: data }),
    flush:         async () => {
      await flushAll();
      await syncCloudPending();
    },
    getStats:      () => _stats,
    getStorageRoots: () => ({
      primary: LOCAL_ROOT,
      mirrors: [...DRIVE_PATHS],
      ..._storage,
    }),
    refreshStorageRoots: discoverDrives,
    getWritePaths: (category) => filePaths(category || 'export'),
    showDebug:     showOverlay,
    hideDebug:     hideOverlay,
  };

  // Kick off async drive discovery — populates DRIVE_PATHS before first flush
  discoverDrives();
  console.log('[DataLogger] v2.2 — local spool + Google My Drive sync started | local=5s | cloud=60s | Ctrl+D=debug overlay');
})();
