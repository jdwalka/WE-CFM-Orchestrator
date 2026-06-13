/**
 * Kalshi Settlement File Logger
 * 
 * Persists settlement outcomes to disk for post-session analysis
 * Logs: Model prediction, Kalshi outcome, Win/Loss, Timestamp, Confidence
 */

(function () {
  'use strict';

  const { ipcRenderer } = require('electron');
  const path = require('path');
  const os = require('os');

  const LOG_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'WE-CRYPTO', 'settlement-logs');
  const SESSION_START = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const LOG_FILE = path.join(LOG_DIR, `kalshi-settlements-${SESSION_START}.log`);

  // Request main process to ensure log directory exists
  ipcRenderer.send('ensure-log-dir', LOG_DIR);

  let settlementBuffer = [];
  let isLogging = true;

  /**
   * Write settlement record to file
   * Format: CSV with headers for easy analysis
   */
  function writeSettlementRecord(record) {
    if (!isLogging) return;

    settlementBuffer.push(record);

    // Batch write every 10 records or on flush
    if (settlementBuffer.length >= 10) {
      flushBuffer();
    }
  }

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

    // Write header on first write
    const isNewFile = settlementBuffer.length > 0 && !window._settlementLogHeaderWritten;
    const content = isNewFile
      ? `timestamp,coin,model_direction,kalshi_outcome,result,confidence,kalshi_probability,kalshi_yes_ask,kalshi_yes_bid,kalshi_no_ask,kalshi_no_bid\n${lines.join('\n')}\n`
      : `${lines.join('\n')}\n`;

    ipcRenderer.send('write-settlement-log', {
      filePath: LOG_FILE,
      content: content,
      isNewFile: isNewFile
    });

    window._settlementLogHeaderWritten = true;
    settlementBuffer = [];
  }

  /**
   * Hook into dashboard to capture settlements
   */
  function setupHooks() {
    // Poll dashboard data every 5 seconds and capture new settlements
    setInterval(() => {
      if (!window.KalshiSettlementDebug) return;

      const allData = window.KalshiSettlementDebug.getAllData?.();
      if (!allData || !Array.isArray(allData)) return;

      // Track which settlements we've already logged
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
  }

  /**
   * Public API
   */
  window.SettlementFileLogger = {
    /**
     * Get path to current session log file
     */
    getLogFile: () => LOG_FILE,

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
      logFile: LOG_FILE,
      bufferedRecords: settlementBuffer.length,
      isLogging: isLogging,
      loggedIds: window._loggedSettlementIds?.size || 0
    })
  };

  // Auto-flush on page unload
  window.addEventListener('beforeunload', () => {
    flushBuffer();
  });

  // Setup monitoring
  setupHooks();

  console.log(`[SettlementFileLogger] Logging to: ${LOG_FILE}`);
})();
