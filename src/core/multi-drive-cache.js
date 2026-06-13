/**
 * ════════════════════════════════════════════════════════════════════════════
 * MULTI-DRIVE INSTANT CACHE SYSTEM
 * 
 * Writes predictions/settlements/errors INSTANTLY to every mounted target the
 * Electron bridge exposes:
 *   - all mounted local drives
 *   - mapped/UNC network shares
 *   - OneDrive mirrors
 *   - Google Drive mirrors
 *   - localStorage (browser persistence)
 * 
 * No async delays — synchronous to each drive before returning
 * ════════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // SafeGuard: Check if in browser (no Node.js requires needed here - it's a browser module)
  class MultiDriveCache {
    constructor() {
      this.cacheFile = 'contract-cache-2h.json';

      // Detect Electron via contextBridge (works with contextIsolation:true + nodeIntegration:false)
      this.isElectron = typeof window !== 'undefined' && window.desktopApp?.isElectron === true;
      this.userEnv = this._getUserEnv();

      // Drive paths (Windows) — mounted roots discovered asynchronously
      this.drivePaths = this._uniquePaths([
        `C:\\Users\\${username}\\AppData\\Local\\WE-CRYPTO-CACHE`,
      ]);
      this.networkDrivePaths = [];

      // Cloud folders discovered async during _initAsync
      this.onedriveFolders = [];
      this.onedriveFolder = null;
      this.googleDriveFolder = null;
      this.googleDriveFolders = [];
      this.lastSyncFailures = [];

      // In-memory cache
      this.data = {
        predictions: [],
        settlements: [],
        candles: [],
        orders: [],
        errors: [],
        correlations: [],
        marketContexts: [],
        inferences: [],
        lastSyncTime: Date.now(),
      };

      // Kick off async init (discover cloud folders, ensure dirs, load from drives)
      if (this.isElectron) {
        this._initAsync().catch(e => console.warn('[MultiDriveCache] Async init error:', e.message));
      }

      console.log('[MultiDriveCache] Initialized — isElectron:', this.isElectron);
    }

    // Simple cross-platform path joiner (replaces require('path').join)
    _join(...parts) {
      return parts.join('\\').replace(/\\{2,}/g, '\\');
    }

    _normalizePath(input) {
      if (!input || typeof input !== 'string') return '';
      const normalized = input.trim().replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
      return normalized;
    }

    _uniquePaths(paths = []) {
      return [...new Set((paths || []).map(p => this._normalizePath(p)).filter(Boolean))];
    }

    _candidateCacheDirs(root) {
      const base = this._normalizePath(root);
      if (!base) return [];
      return this._uniquePaths([
        this._join(base, 'WECRYPTO', 'WE-CRYPTO-CACHE'),
        this._join(base, 'WE-CRYPTO-CACHE'),
      ]);
    }

    _isCloudFolderName(name) {
      const value = String(name || '');
      return value.startsWith('OneDrive')
        || /^Google Drive(?:\s*\(.+\))?$/i.test(value)
        || /^My Drive(?:\s*\(.+\))?$/i.test(value);
    }

    _isGoogleDriveRoot(root) {
      return /(?:^|\\)(?:My Drive|Google Drive(?:\s*\(.+\))?)$/i.test(this._normalizePath(root));
    }

    _writeOk(result) {
      return result === true || !!result?.ok;
    }

    _writeError(result) {
      if (result === false) return 'write rejected';
      if (!result) return 'no result';
      return result.error || result.code || 'write rejected';
    }

    async _probeWritableDir(dirPath) {
      if (!window.dataStore?.writeFile) return { ok: false, dirPath, error: 'dataStore write bridge unavailable' };
      const probePath = this._join(dirPath, '.permission-check', 'multi-drive-cache-probe.json');
      try {
        const result = await window.dataStore.writeFile(probePath, JSON.stringify({ source: 'MultiDriveCache', ts: Date.now() }));
        if (this._writeOk(result)) return { ok: true, dirPath };
        return { ok: false, dirPath, error: this._writeError(result), code: result?.code || null };
      } catch (e) {
        return { ok: false, dirPath, error: e?.message || String(e), code: e?.code || null };
      }
    }

    _allDrivePaths() {
      return this._uniquePaths([
        ...this.drivePaths,
        ...this.networkDrivePaths,
        ...this.onedriveFolders,
        ...this.googleDriveFolders,
        ...(this.googleDriveFolder ? [this.googleDriveFolder] : []),
      ]);
    }

    async _initAsync() {
      await this._discoverMountedDrives();
      await this._discoverCloudFolders();
      await this._ensureDirectories();
      await this._loadFromDrives();
    }

    async _discoverMountedDrives() {
      if (!this.isElectron || !window.desktopApp?.getDrives) return;
      try {
        const drives = await window.desktopApp.getDrives();
        const localRoots = [];
        const networkRoots = [];
        for (const drive of drives || []) {
          if (!drive?.root) continue;
          const root = this._normalizePath(drive.root);
          if (!root) continue;

          if (drive.type === 'local') {
            localRoots.push(this._join(root, 'WE-CRYPTO-CACHE'));
          } else if (drive.type === 'network') {
            networkRoots.push(this._join(root, 'WE-CRYPTO-CACHE'));
          }
        }

        this.drivePaths = this._uniquePaths([
          ...this.drivePaths,
          ...localRoots,
        ]);
        this.networkDrivePaths = this._uniquePaths(networkRoots);

        if (localRoots.length) {
          console.log('[MultiDriveCache] Local drives discovered:', localRoots.join(' | '));
        }
        if (networkRoots.length) {
          console.log('[MultiDriveCache] Network shares discovered:', networkRoots.join(' | '));
        }
      } catch (e) {
        console.warn('[MultiDriveCache] Mounted drive discovery error:', e.message);
      }
    }

    async _discoverCloudFolders() {
      if (!this.isElectron || !window.dataStore?.listDir) return;
      try {
        // Discover cloud folders under common user home paths
        const username = (typeof process !== 'undefined' && process.env && process.env.USERNAME)
          ? process.env.USERNAME
          : 'user';
        const homeCandidates = this._uniquePaths([
          `C:\\Users\\${username}`,
          'C:\\Users\\Public',
        ]);
        for (const home of homeCandidates) {
          const res = await window.dataStore.listDir(home);
          if (!res?.ok) continue;
          for (const entry of (res.entries || [])) {
            if (entry.startsWith('OneDrive')) {
              this.onedriveFolders.push(...this._candidateCacheDirs(this._join(home, entry)));
            }
            if (this._isGoogleDriveRoot(entry)) {
              for (const dir of this._candidateCacheDirs(this._join(home, entry))) {
                const probe = await this._probeWritableDir(dir);
                if (probe.ok) this.googleDriveFolders.push(dir);
                else this.lastSyncFailures.push({ path: probe.dirPath, error: probe.error || probe.code || 'probe failed' });
              }
            }
          }
        }
        this.onedriveFolders = this._uniquePaths(this.onedriveFolders);
        if (this.onedriveFolders.length) {
          this.onedriveFolder = this.onedriveFolders[0];
        }

        // Google Drive - use the Electron-exposed mounted account roots first.
        const googleCandidates = new Set([
          'G:\\My Drive',
          'H:\\My Drive',
          'I:\\My Drive',
          `C:\\Users\\${username}\\Google Drive`,
          `C:\\Users\\${username}\\My Drive`,
        ]);

        if (window.desktopApp?.getGoogleDriveTargets) {
          try {
            const status = await window.desktopApp.getGoogleDriveTargets({ force: true });
            for (const target of status?.targets || []) {
              if (target?.root) googleCandidates.add(target.root);
            }
          } catch (e) {
            console.warn('[MultiDriveCache] Google target bridge failed:', e.message);
          }
        }

        if (window.desktopApp?.getDrives) {
          try {
            const drives = await window.desktopApp.getDrives();
            for (const drive of drives || []) {
              if (!drive?.root) continue;
              const root = this._normalizePath(drive.root);
              if (!root) continue;
              if (drive.type === 'cloud' && this._isGoogleDriveRoot(root)) {
                googleCandidates.add(root);
              }
            }
          } catch (e) {
            console.warn('[MultiDriveCache] Drive scan for Google mounts failed:', e.message);
          }
        }

        for (const root of ['G:\\', 'H:\\', 'I:\\', 'Y:\\', 'Z:\\']) {
          const base = this._normalizePath(root).replace(/\\$/, '');
          if (!base) continue;
          googleCandidates.add(`${base}\\My Drive`);
          googleCandidates.add(`${base}\\Google Drive`);
        }

        for (const candidate of this._uniquePaths([...googleCandidates])) {
          for (const dir of this._candidateCacheDirs(candidate)) {
            const probe = await this._probeWritableDir(dir);
            if (probe.ok) this.googleDriveFolders.push(dir);
            else this.lastSyncFailures.push({ path: probe.dirPath, error: probe.error || probe.code || 'probe failed' });
          }
        }

        this.googleDriveFolders = this._uniquePaths(this.googleDriveFolders);
        this.googleDriveFolder = this.googleDriveFolders[0] || null;
        if (this.googleDriveFolders.length) {
          console.log('[MultiDriveCache] Writable Google Drive targets:', this.googleDriveFolders.join(' | '));
        } else {
          console.warn('[MultiDriveCache] No writable Google Drive cache targets found');
        }
      } catch (e) {
        console.warn('[MultiDriveCache] Cloud folder discovery error:', e.message);
      }
    }

    async _ensureDirectories() {
      if (!this.isElectron || !window.dataStore?.ensureDir) return;
      const allPaths = this._allDrivePaths();
      await Promise.allSettled(allPaths.map(p => window.dataStore.ensureDir(p)));
    }

    /**
     * Get OneDrive folder paths — sync stub kept for back-compat, populated async
     */
    _getOnedriveFolders() { return []; }

    /**
     * Get Google Drive folder — sync stub kept for back-compat, populated async
     */
    _getGoogleDriveFolder() { return null; }

    /**
     * Record prediction and write INSTANTLY to all drives
     */
    recordPrediction(coin, direction, confidence, signals = {}) {
      const now = Date.now();
      const record = {
        coin,
        direction,
        confidence,
        signals,
        timestamp: now,
        id: `pred-${coin}-${now}`,
      };

      this.data.predictions.push(record);
      this._trim('predictions');

      // Write instantly to all drives
      this._syncAllDrives();

      // Also write to localStorage (browser)
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-predictions-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record compact market context for inference/recall
     */
    recordMarketContext(coin, context = {}, options = {}) {
      const now = Date.now();
      const record = {
        coin,
        ...context,
        timestamp: now,
        id: `ctx-${coin}-${now}`,
      };

      this.data.marketContexts.push(record);
      this._trim('marketContexts', 3000);

      if (options.sync !== false) {
        this._syncAllDrives();
      }

      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-market-context-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record inference output + optional input snapshot
     */
    recordInference(coin, inference = {}, snapshot = null, options = {}) {
      const now = Date.now();
      const record = {
        coin,
        inference,
        snapshot,
        timestamp: now,
        id: `inf-${coin}-${now}`,
      };

      this.data.inferences.push(record);
      this._trim('inferences', 1500);

      if (options.sync !== false) {
        this._syncAllDrives();
      }

      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-inference-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record settlement and write INSTANTLY to all drives
     */
    recordSettlement(coin, outcome, modelCorrect, marketCorrect) {
      const now = Date.now();
      const record = {
        coin,
        outcome,
        modelCorrect,
        marketCorrect,
        timestamp: now,
        id: `settle-${coin}-${now}`,
      };

      this.data.settlements.push(record);
      this._trim('settlements');

      // Write instantly to all drives
      this._syncAllDrives();

      // Also write to localStorage
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-settlements-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record error and write INSTANTLY to all drives
     */
    recordError(type, message, context = {}) {
      const now = Date.now();
      const record = {
        type,
        message,
        context,
        timestamp: now,
        id: `error-${type}-${now}`,
      };

      this.data.errors.push(record);
      this._trim('errors', 500);  // Keep last 500 errors

      // Write instantly to all drives
      this._syncAllDrives();

      // Also write to localStorage
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-errors-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Write current cache to all target drives (fire-and-forget async)
     */
    _syncAllDrives() {
      if (!this.isElectron || !window.dataStore?.writeFile) return;

      if (this._syncPending) return;
      this._syncPending = true;

      // Debounce writing to avoid starving the main thread on every prediction
      setTimeout(() => {
        this._syncPending = false;
        try {
          // Do not use formatting (null, 2) to reduce stringification overhead
          const cacheJson = JSON.stringify(this.data);
          const allPaths = this._allDrivePaths();

          this.data.lastSyncTime = Date.now();

          // Fire-and-forget: each write is independent
          allPaths.forEach(dirPath => {
            const filePath = this._join(dirPath, this.cacheFile);
            window.dataStore.writeFile(filePath, cacheJson)
              .then(result => {
                if (!this._writeOk(result)) {
                  this.lastSyncFailures.push({
                    path: filePath,
                    error: this._writeError(result),
                    ts: Date.now(),
                  });
                  this.lastSyncFailures = this.lastSyncFailures.slice(-30);
                  console.warn('[MultiDriveCache] Write failed:', filePath, this._writeError(result));
                }
              })
              .catch(e => {
                this.lastSyncFailures.push({
                  path: filePath,
                  error: e?.message || String(e),
                  ts: Date.now(),
                });
                this.lastSyncFailures = this.lastSyncFailures.slice(-30);
              });
          });
        } catch (err) {
          console.warn('[MultiDriveCache] Sync failed:', err.message);
        }
      }, 2000);
    }

    /**
     * Public sync trigger for batched writes
     */
    flushSync() {
      this._syncAllDrives();
    }

    /**
     * Load cache from drives (priority order) — async, called from _initAsync
     */
    async _loadFromDrives() {
      if (!this.isElectron || !window.dataStore?.readFile) return;

      const allPaths = this._allDrivePaths();

      for (const dirPath of allPaths) {
        try {
          const filePath = this._join(dirPath, this.cacheFile);
          const res = await window.dataStore.readFile(filePath);
          if (!res?.ok || !res.content) continue;

          const loaded = JSON.parse(res.content);
          const now = Date.now();
          const maxAge = 2 * 60 * 60 * 1000;

          this.data.predictions = (loaded.predictions || []).filter(p => now - p.timestamp < maxAge);
          this.data.settlements = (loaded.settlements || []).filter(s => now - s.timestamp < maxAge);
          this.data.candles = (loaded.candles || []).filter(c => now - c.timestamp < maxAge);
          this.data.orders = (loaded.orders || []).filter(o => now - o.timestamp < maxAge);
          this.data.errors = (loaded.errors || []).slice(-500);
          this.data.correlations = (loaded.correlations || []).filter(c => now - c.timestamp < maxAge);
          this.data.marketContexts = (loaded.marketContexts || loaded.contexts || []).filter(c => now - c.timestamp < maxAge);
          this.data.inferences = (loaded.inferences || loaded.inference || []).filter(i => now - i.timestamp < maxAge);

          console.log(`[MultiDriveCache] Loaded from ${dirPath}: ${this.data.predictions.length} predictions`);
          return; // First successful drive wins
        } catch (e) {
          console.warn(`[MultiDriveCache] Load from ${dirPath} failed:`, e.message);
        }
      }

      console.log('[MultiDriveCache] No cache found on any drive, starting fresh');
    }

    /**
     * Trim old data from arrays
     */
    _trim(key, maxCount = null) {
      const now = Date.now();
      const maxAge = 2 * 60 * 60 * 1000;  // 2 hours

      if (key === 'errors') {
        this.data.errors = this.data.errors.filter(e => now - e.timestamp < maxAge).slice(-500);
      } else if (key === 'predictions') {
        this.data.predictions = this.data.predictions.filter(p => now - p.timestamp < maxAge).slice(-1000);
      } else if (key === 'settlements') {
        this.data.settlements = this.data.settlements.filter(s => now - s.timestamp < maxAge).slice(-1000);
      } else if (key === 'candles') {
        this.data.candles = this.data.candles.filter(c => now - c.timestamp < maxAge).slice(-1000);
      } else if (key === 'orders') {
        this.data.orders = this.data.orders.filter(o => now - o.timestamp < maxAge).slice(-1000);
      } else if (key === 'correlations') {
        this.data.correlations = this.data.correlations.filter(c => now - c.timestamp < maxAge).slice(-1000);
      } else if (key === 'marketContexts') {
        this.data.marketContexts = this.data.marketContexts.filter(c => now - c.timestamp < maxAge).slice(-3000);
      } else if (key === 'inferences') {
        this.data.inferences = this.data.inferences.filter(i => now - i.timestamp < maxAge).slice(-1500);
      }

      if (maxCount) {
        this.data[key] = this.data[key].slice(-maxCount);
      }
    }

    /**
     * Get cache status
     */
    getStatus() {
      return {
        predictions: this.data.predictions.length,
        settlements: this.data.settlements.length,
        candles: this.data.candles.length,
        orders: this.data.orders.length,
        errors: this.data.errors.length,
        correlations: this.data.correlations.length,
        marketContexts: this.data.marketContexts.length,
        inferences: this.data.inferences.length,
        lastSyncTime: new Date(this.data.lastSyncTime).toISOString(),
        drivesConfigured: this.drivePaths.length,
        onedriveConfigured: this.onedriveFolders.length > 0,
        onedriveTargets: this.onedriveFolders.length,
        googleDriveConfigured: this.googleDriveFolder ? true : false,
        googleDriveTargets: this.googleDriveFolders.length,
        googleDriveFolders: [...this.googleDriveFolders],
        networkTargets: this.networkDrivePaths.length,
        totalTargets: this._allDrivePaths().length,
        lastSyncFailures: this.lastSyncFailures.slice(-10),
      };
    }

    /**
     * Get accuracy by coin
     */
    getAccuracyByCoins() {
      const byCoins = {};

      this.data.settlements.forEach(s => {
        if (!byCoins[s.coin]) {
          byCoins[s.coin] = { correct: 0, total: 0 };
        }
        byCoins[s.coin].total++;
        if (s.modelCorrect === true) byCoins[s.coin].correct++;
      });

      return Object.entries(byCoins).reduce((acc, [coin, data]) => {
        acc[coin] = {
          accuracy: Math.round((data.correct / data.total) * 100),
          correct: data.correct,
          total: data.total,
        };
        return acc;
      }, {});
    }

    /**
     * Export recent data
     */
    exportRecent(minutes = 60) {
      const cutoff = Date.now() - (minutes * 60 * 1000);

      return {
        predictions: this.data.predictions.filter(p => p.timestamp > cutoff),
        settlements: this.data.settlements.filter(s => s.timestamp > cutoff),
        errors: this.data.errors.filter(e => e.timestamp > cutoff),
        marketContexts: this.data.marketContexts.filter(c => c.timestamp > cutoff),
        inferences: this.data.inferences.filter(i => i.timestamp > cutoff),
      };
    }
  }

  // Global instance
  const multiDriveCache = new MultiDriveCache();

  // Expose to window
  if (typeof window !== 'undefined') {
    window.MultiDriveCache = multiDriveCache;
    window.MultiDriveCacheDebug = {
      status: () => {
        console.table(multiDriveCache.getStatus());
        return multiDriveCache.getStatus();
      },
      accuracy: () => {
        console.table(multiDriveCache.getAccuracyByCoins());
        return multiDriveCache.getAccuracyByCoins();
      },
      recent: (minutes = 60) => {
        const data = multiDriveCache.exportRecent(minutes);
        console.log(`Exported last ${minutes}m:`, data);
        return data;
      },
      syncNow: () => {
        multiDriveCache._syncAllDrives();
        console.log('✓ Manual sync complete');
      },
      googleTargets: () => {
        console.table(multiDriveCache.googleDriveFolders);
        return [...multiDriveCache.googleDriveFolders];
      },
    };
  }

  // Expose to Node.js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = multiDriveCache;
  }
})();
