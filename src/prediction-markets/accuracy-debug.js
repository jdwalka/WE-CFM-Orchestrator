/**
 * ================================================================
 * Polymarket Accuracy Scorecard Debug Helper
 * 
 * Adds console commands to inspect accuracy scorecard data and
 * signal inversion issues
 * ================================================================
 */

(function () {
  'use strict';

  window.PolymarketAccuracyDebug = {
    /**
     * Show accuracy scorecard data for a specific coin
     */
    scorecard(sym = 'ALL') {
      if (sym === 'ALL') {
        const coins = ['BTC', 'ETH', 'SOL', 'XRP']; // 4-coin focused model
        console.log('═══════════════════════════════════════════');
        console.log('📊 ACCURACY SCORECARD FOR ALL COINS');
        console.log('═══════════════════════════════════════════');
        coins.forEach(coin => this.scorecard(coin));
        return;
      }

      const entries = (window._marketSettlementLog || []).filter(e => e.sym === sym && e._settled);
      const resE = (window._15mResolutionLog || []).filter(e => e.sym === sym && e.modelCorrect !== null);
      const total = entries.length + resE.length;

      if (!total) {
        console.log(`ℹ️  ${sym}: No settled contracts yet`);
        return;
      }

      const modelOk = entries.filter(e => e.modelCorrect === true).length + resE.filter(e => e.modelCorrect === true).length;
      const mktOk = entries.filter(e => e.marketCorrect === true).length + resE.filter(e => e.marketCorrect === true).length;
      const modelPct = Math.round((modelOk / total) * 100);
      const mktPct = Math.round((mktOk / total) * 100);

      console.log(`\n${sym}: ${modelPct}% model (${modelOk}/${total}), ${mktPct}% market`);
      console.log(`  Market trades: ${entries.length}`);
      console.log(`  Resolution log: ${resE.length}`);

      // Show last 5 contracts
      const recent = [...entries, ...resE].slice(-5);
      console.log(`\n  Recent contracts:`);
      recent.forEach(e => {
        const correct = e.modelCorrect === true ? '✓' : e.modelCorrect === false ? '✗' : '?';
        const dir = e.modelDir || e.direction || '?';
        const outcome = e._marketResult || e.marketResult || e.actualOutcome || '?';
        console.log(`    ${correct} model=${dir} actual=${outcome} (${new Date(e.ts || e.settledTs).toISOString().slice(11, 19)})`);
      });
    },

    /**
     * Find signal inversion issues
     */
    findInversions() {
      const all = [
        ...(window._marketSettlementLog || []).filter(e => e._settled),
        ...(window._15mResolutionLog || []).filter(e => e.modelCorrect !== null),
      ];

      const inversions = all.filter(e => {
        const modelDir = e.modelDir || e.direction;
        const outcome = e._marketResult || e.marketResult || e.actualOutcome;
        return modelDir && outcome && modelDir !== outcome;
      });

      if (inversions.length === 0) {
        console.log('✅ No inversions detected');
        return [];
      }

      console.log(`\n🚨 Found ${inversions.length} inversions:`);
      inversions.slice(-10).forEach(e => {
        const modelDir = e.modelDir || e.direction;
        const outcome = e._marketResult || e.marketResult || e.actualOutcome;
        console.log(`  ${e.sym}: predicted ${modelDir} but got ${outcome}`);
      });

      return inversions;
    },

    /**
     * Check if confidence values are inverted
     */
    checkConfidenceInversion() {
      const preds = window._predictions || {};
      let inversions = 0;
      let totalChecked = 0;

      Object.entries(preds).forEach(([coin, trades]) => {
        const tradeArray = Array.isArray(trades) ? trades : Object.values(trades || {});
        tradeArray.forEach(t => {
          if (!t.prediction || !t.actual || !t.confidence) return;
          totalChecked++;
          const correct = t.prediction === t.actual;
          const highConf = (t.confidence || 0) > 70;

          // If confidence is high but prediction was wrong, that's an inversion issue
          if (highConf && !correct) {
            inversions++;
            console.log(`  ${coin}: ${t.confidence}% conf but predicted ${t.prediction} (actual ${t.actual})`);
          }
        });
      });

      if (inversions === 0) {
        console.log('✅ No confidence inversions detected');
      } else {
        console.log(`\n🚨 Found ${inversions}/${totalChecked} high-confidence errors`);
      }

      return inversions;
    },

    /**
     * Show the most recent prediction vs actual outcome
     */
    recent(coin = null) {
      const coins = coin ? [coin] : ['BTC', 'ETH', 'SOL', 'XRP'];  // 4-coin focused
      console.log('\n📋 RECENT PREDICTIONS:');
      console.log('═══════════════════════════════════════════');

      coins.forEach(c => {
        const preds = window._predictions?.[c];
        if (!preds) return;

        const tradeArray = Array.isArray(preds) ? preds : Object.values(preds || {});
        const recent = tradeArray.slice(-3).reverse();

        console.log(`\n${c}:`);
        recent.forEach(t => {
          const match = t.prediction === t.actual ? '✓' : '✗';
          const conf = t.confidence ? `${t.confidence}%` : 'N/A';
          console.log(`  ${match} Predicted: ${t.prediction} | Actual: ${t.actual} | Conf: ${conf}`);
        });
      });
    },

    /**
     * Export all accuracy data to CSV
     */
    exportCSV() {
      const all = [
        ...(window._marketSettlementLog || []).filter(e => e._settled),
        ...(window._15mResolutionLog || []).filter(e => e.modelCorrect !== null),
      ];

      let csv = 'SYM,TIMESTAMP,MODEL_DIR,ACTUAL_OUTCOME,MODEL_CORRECT,MARKET_CORRECT,CONFIDENCE\n';
      all.forEach(e => {
        const ts = new Date(e.ts || e.settledTs).toISOString();
        const modelDir = e.modelDir || e.direction || '';
        const outcome = e._marketResult || e.marketResult || e.actualOutcome || '';
        const modelCorrect = e.modelCorrect === true ? 'YES' : e.modelCorrect === false ? 'NO' : '';
        const mktCorrect = e.marketCorrect === true ? 'YES' : e.marketCorrect === false ? 'NO' : '';
        const conf = e.confidence || '';
        csv += `${e.sym},${ts},${modelDir},${outcome},${modelCorrect},${mktCorrect},${conf}\n`;
      });

      console.log('📊 Copying CSV to clipboard...');
      navigator.clipboard.writeText(csv).then(() => {
        console.log('✅ CSV copied! Paste into Excel/Sheets');
      });

      return csv;
    },

    /**
     * Health check: is scorecard data being captured?
     */
    healthCheck() {
      console.log('\n🔍 SCORECARD HEALTH CHECK');
      console.log('═══════════════════════════════════════════');

      const marketLog = window._marketSettlementLog || [];
      const resLog = window._15mResolutionLog || [];

      console.log(`📍 _marketSettlementLog entries: ${marketLog.length}`);
      console.log(`📍 _15mResolutionLog entries: ${resLog.length}`);

      const settled = marketLog.filter(e => e._settled).length;
      console.log(`📍 _marketSettlementLog (settled): ${settled}`);

      const modelCorrect = resLog.filter(e => e.modelCorrect !== null).length;
      console.log(`📍 _15mResolutionLog (with modelCorrect): ${modelCorrect}`);

      if (marketLog.length === 0 && resLog.length === 0) {
        console.warn('⚠️  NO DATA: Scorecard will be empty until first contract settles');
        return false;
      }

      if (settled === 0 && modelCorrect === 0) {
        console.warn('⚠️  DATA CAPTURED but NOT SETTLED: Waiting for Polymarket API resolutions');
        return false;
      }

      console.log('✅ Scorecard data is being captured properly');
      return true;
    },

    /**
     * Sync cached contracts from Electron file system (D:/Z: drives) into _15mResolutionLog
     * This bridges the multi-drive cache with the in-memory resolution log for the debug panel
     */
    async syncDriveCacheToMemory() {
      console.log('[PolymarketAccuracyDebug] Syncing drive cache to memory...');

      // If running in Electron, call IPC to read contract cache files
      if (typeof window !== 'undefined' && window.electron && window.electron.invoke) {
        try {
          const contractData = await window.electron.invoke('storage:readContractCache');
          const settlements = Array.isArray(contractData)
            ? contractData
            : (contractData?.settlements || contractData?.data || contractData?.contracts || []);

          if (Array.isArray(settlements) && settlements.length > 0) {
            console.log(
              `[PolymarketAccuracyDebug] Loaded ${settlements.length} contracts from drive cache ` +
              `(source: ${contractData?.source || 'unknown'})`
            );

            // Normalize drive-cache records to runtime resolution-log schema
            const normalizedSettlements = settlements
              .map((c) => {
                const sym = String(c.sym || c.symbol || c.coin || '').toUpperCase();
                const settledTs = c.settledTs ?? c.timestamp ?? c.ts ?? null;
                const actualOutcomeRaw = c.actualOutcome ?? c.outcome ?? c.marketResult ?? null;
                const actualOutcome = actualOutcomeRaw === 'YES'
                  ? 'UP'
                  : actualOutcomeRaw === 'NO'
                    ? 'DOWN'
                    : actualOutcomeRaw;
                return {
                  ...c,
                  sym,
                  settledTs,
                  ts: c.ts ?? settledTs,
                  actualOutcome,
                  modelDir: c.modelDir ?? c.direction ?? null,
                  modelCorrect: c.modelCorrect ?? null,
                  _source: c._source || 'drive-cache-sync',
                };
              })
              .filter((c) => !!c.sym && !!c.settledTs);

            const existing = new Set(
              (window._15mResolutionLog || []).map((e) => (
                e.id ||
                `${e.sym || e.symbol || e.coin || 'UNK'}-${e.ts || e.timestamp || e.settledTs || 0}`
              ))
            );
            const newContracts = normalizedSettlements.filter((c) => {
              const key = c.id || `${c.sym || c.symbol || c.coin || 'UNK'}-${c.ts || c.timestamp || c.settledTs || 0}`;
              return !existing.has(key);
            });

            if (newContracts.length > 0) {
              window._15mResolutionLog = [...(window._15mResolutionLog || []), ...newContracts].slice(-300);
              console.log(`[PolymarketAccuracyDebug] Added ${newContracts.length} new contracts to resolution log`);

              try {
                localStorage.setItem('beta1_15m_resolution_log', JSON.stringify(window._15mResolutionLog.slice(-300)));
              } catch (_) { }
            } else {
              console.log('[PolymarketAccuracyDebug] No new contracts to sync');
            }
          } else {
            console.log('[PolymarketAccuracyDebug] No contracts found in drive cache response');
          }
        } catch (err) {
          console.warn('[PolymarketAccuracyDebug] Drive sync failed:', err.message);
        }
      } else {
        console.log('[PolymarketAccuracyDebug] Not running in Electron, skipping drive sync');
      }
    },
  };

  console.log('[PolymarketAccuracyDebug] Ready — use PolymarketAccuracyDebug.scorecard(sym) .findInversions() .recent() .exportCSV() .healthCheck() .syncDriveCacheToMemory()');
})();
