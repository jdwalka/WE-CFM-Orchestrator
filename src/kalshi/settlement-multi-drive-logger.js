/**
 * Settlement Multi-Drive Cloud Logger
 * 
 * Persists settlement data across:
 * - Local network drives (F:\, Z:\, etc.)
 * - OneDrive (both personal + business)
 * - Google Drive
 * 
 * Ensures data survives any single drive failure
 */

(function () {
  'use strict';

  // Guard: preload multiDrive API only available in Electron renderer process
  const multiDrive = window.multiDrive;
  if (!multiDrive) {
    console.warn('[settlement-multi-drive-logger] multiDrive API not available - module disabled');
    return;
  }

  async function discoverNetworkShareTargets() {
    try {
      if (!window.desktopApp?.getDrives) return [];
      const drives = await window.desktopApp.getDrives();
      return (drives || [])
        .filter(d => d && d.type === 'network' && d.root)
        .map(d => `${d.root}WECRYPTO\\settlement-logs`);
    } catch (e) {
      console.warn('[SettlementLogger] Network share discovery failed:', e.message);
      return [];
    }
  }

  async function discoverGoogleDriveTargets() {
    const targets = new Set([
      'G:\\My Drive',
      'H:\\My Drive',
      'I:\\My Drive',
      'C:\\Users\\jdwal\\Google Drive',
      'C:\\Users\\jdwal\\My Drive'
    ]);

    try {
      if (window.desktopApp?.getGoogleDriveTargets) {
        const status = await window.desktopApp.getGoogleDriveTargets({ force: true });
        for (const target of status?.targets || []) {
          if (target?.root) targets.add(target.root);
        }
      } else if (window.desktopApp?.getDrives) {
        const drives = await window.desktopApp.getDrives();
        for (const drive of drives || []) {
          if (drive?.type === 'cloud' && /(?:^|\\)(?:My Drive|Google Drive(?:\s*\(.+\))?)$/i.test(String(drive.root || ''))) {
            targets.add(drive.root);
          }
        }
      }
    } catch (e) {
      console.warn('[SettlementLogger] Google Drive discovery failed:', e.message);
    }

    return [...targets].filter(Boolean);
  }

    const SYNC_TARGETS = {
    network_drives: [],
    onedrive: [
      'C:\Users\gitgo\OneDrive\WECRYPTO_Logs'
    ],
    google_drive: [
      'H:\My Drive\WECRYPTO_Logs'
    ]
  };

  const SESSION_START = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const LOG_FILENAME = `kalshi-settlements-${SESSION_START}.log`;

  let settlementBuffer = [];
  let syncStatus = {
    network_drives: {},
    onedrive: {},
    google_drive: {}
  };
  let isLogging = true;

  /**
   * Initialize all target directories
   */
  function initializeTargets() {
    Promise.all([discoverNetworkShareTargets(), discoverGoogleDriveTargets()]).then(([extraTargets, googleTargets]) => {
      if (extraTargets?.length) {
        SYNC_TARGETS.network_drives = [...new Set([...(SYNC_TARGETS.network_drives || []), ...extraTargets].filter(Boolean))];
        console.log('[SettlementLogger] Network shares discovered:', extraTargets.join(' | '));
      }
      if (googleTargets?.length) {
        SYNC_TARGETS.google_drive = [...new Set([...(SYNC_TARGETS.google_drive || []), ...googleTargets].filter(Boolean))];
        console.log('[SettlementLogger] Google Drive targets exposed:', SYNC_TARGETS.google_drive.join(' | '));
      }

      multiDrive.initDirectories({
        targets: SYNC_TARGETS,
        filename: LOG_FILENAME
      });
    }).catch(() => {
      multiDrive.initDirectories({
        targets: SYNC_TARGETS,
        filename: LOG_FILENAME
      });
    });

    // Listen for directory init results
    multiDrive.onInitComplete((results) => {
      console.log('[SettlementLogger] Directory initialization complete:', results);
      syncStatus = results;
    });
  }

  /**
   * Write settlement record to all targets
   */
  function writeSettlementRecord(record) {
    if (!isLogging) return;

    settlementBuffer.push(record);

    // Batch write every 5 records
    if (settlementBuffer.length >= 5) {
      flushBuffer();
    }
  }

  /**
   * Flush buffer to all targets (network, OneDrive, Google Drive)
   */
  function flushBuffer() {
    if (settlementBuffer.length === 0) return;

    const lines = settlementBuffer.map(r => {
      const timestamp = new Date(r.ts).toISOString();
      const modelDir = r.modelDir || 'UNKNOWN';
      const outcome = r.outcome || 'PENDING';
      const correct = r.correct === true ? 'WIN' : r.correct === false ? 'LOSS' : 'PENDING';
      const confidence = r.confidence || 0;
      const kalshiProb = r.kalshiProb || 0;
      const kYesAsk = r.kYesAsk || 0;
      const kYesBid = r.kYesBid || 0;
      const kNoAsk = r.kNoAsk || 0;
      const kNoBid = r.kNoBid || 0;

      return `${timestamp},${r.sym},${modelDir},${outcome},${correct},${confidence},${kalshiProb},${kYesAsk},${kYesBid},${kNoAsk},${kNoBid}`;
    });

    const isNewFile = !window._settlementLogHeaderWritten;
    const content = isNewFile
      ? `timestamp,coin,model_direction,kalshi_outcome,result,confidence,kalshi_probability,kalshi_yes_ask,kalshi_yes_bid,kalshi_no_ask,kalshi_no_bid\n${lines.join('\n')}\n`
      : `${lines.join('\n')}\n`;

    // Send to main process for multi-target write
    multiDrive.writeSettlementLog({
      filename: LOG_FILENAME,
      content: content,
      isNewFile: isNewFile,
      targets: SYNC_TARGETS,
      recordCount: settlementBuffer.length
    });

    // Listen for write results
    multiDrive.onWriteComplete((results) => {
      console.log('[SettlementLogger] Multi-drive write complete:', results);
      // Update sync status
      syncStatus = results.syncStatus || syncStatus;
    });

    window._settlementLogHeaderWritten = true;
    settlementBuffer = [];
  }

  /**
   * Hook into dashboard to capture settlements
   */
  function setupHooks() {
    setInterval(() => {
      if (!window.KalshiSettlementDebug) return;

      const allData = window.KalshiSettlementDebug.getAllData?.();
      if (!allData || !Array.isArray(allData)) return;

      if (!window._loggedSettlementIds) {
        window._loggedSettlementIds = new Set();
      }

      for (const record of allData) {
        const id = `${record.ts}-${record.sym}`;
        if (!window._loggedSettlementIds.has(id)) {
          writeSettlementRecord(record);
          window._loggedSettlementIds.add(id);
        }
      }
    }, 5000);

    // Flush partial batches regularly so recent logs are not lost on abrupt exits.
    setInterval(() => {
      if (settlementBuffer.length > 0) flushBuffer();
    }, 30000);
  }

  /**
   * Public API
   */
  window.SettlementMultiDriveLogger = {
    /**
     * Get log filename
     */
    getFilename: () => LOG_FILENAME,

    /**
     * Get all target locations
     */
    getTargets: () => SYNC_TARGETS,

    /**
     * Get sync status for all targets
     */
    getSyncStatus: () => syncStatus,

    /**
     * Flush buffer to disk immediately
     */
    flush: () => flushBuffer(),

    /**
     * Stop logging
     */
    stop: () => {
      isLogging = false;
      flushBuffer();
    },

    /**
     * Resume logging
     */
    resume: () => {
      isLogging = true;
    },

    /**
     * Get buffer status
     */
    status: () => ({
      filename: LOG_FILENAME,
      bufferedRecords: settlementBuffer.length,
      isLogging: isLogging,
      loggedIds: window._loggedSettlementIds?.size || 0,
      syncStatus: syncStatus,
      targets: SYNC_TARGETS
    }),

    /**
     * Print sync status to console
     */
    printSyncStatus: () => {
      console.log('=== SETTLEMENT MULTI-DRIVE SYNC STATUS ===');
      console.log(`Log File: ${LOG_FILENAME}`);
      console.log('\nNetwork Drives:');
      Object.entries(syncStatus.network_drives).forEach(([path, status]) => {
        const icon = status.success ? '✅' : '❌';
        console.log(`  ${icon} ${path}: ${status.message}`);
      });
      console.log('\nOneDrive:');
      Object.entries(syncStatus.onedrive).forEach(([path, status]) => {
        const icon = status.success ? '✅' : '❌';
        console.log(`  ${icon} ${path}: ${status.message}`);
      });
      console.log('\nGoogle Drive:');
      Object.entries(syncStatus.google_drive).forEach(([path, status]) => {
        const icon = status.success ? '✅' : '❌';
        console.log(`  ${icon} ${path}: ${status.message}`);
      });
    }
  };

  // Auto-flush on page unload
  window.addEventListener('beforeunload', () => {
    flushBuffer();
  });

  // Initialize and setup monitoring
  initializeTargets();
  setupHooks();

  console.log('[SettlementMultiDriveLogger] Initialized for multi-target persistence');
  console.log('[SettlementMultiDriveLogger] Targets:', SYNC_TARGETS);
})();
