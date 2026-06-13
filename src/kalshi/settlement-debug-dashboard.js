/**
 * Kalshi Settlement Debug Dashboard
 * 
 * Real-time verification of model predictions vs Kalshi settlement outcomes.
 * Shows: Predicted direction + Actual settlement + Win/Loss per contract
 */

(function () {
  'use strict';

  const DASHBOARD_ID = 'kalshi-settlement-debug-dashboard';
  
  // ── Build HTML dashboard ──
  function createDashboard() {
    const html = `
      <div id="${DASHBOARD_ID}" style="
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 420px;
        max-height: 600px;
        background: #0f1622;
        border: 2px solid #00d4ff;
        border-radius: 8px;
        padding: 16px;
        font-family: 'Courier New', monospace;
        font-size: 11px;
        z-index: 9999;
        overflow-y: auto;
        box-shadow: 0 0 20px rgba(0,212,255,0.3);
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px solid #2a3f5f; padding-bottom: 8px;">
          <span style="color: #00d4ff; font-weight: 700;">🧪 KALSHI SETTLEMENT DEBUG</span>
          <button onclick="document.getElementById('${DASHBOARD_ID}').style.display='none'; return false;" 
            style="background: none; border: none; color: #888; cursor: pointer; font-size: 14px;">✕</button>
        </div>
        
        <div style="margin-bottom: 12px;">
          <div style="color: #ffd700; margin-bottom: 8px;">📊 WIN RATE BY COIN</div>
          <div id="dashboard-coin-stats" style="margin-left: 8px; line-height: 1.6; color: #90caf9;"></div>
        </div>
        
        <div style="border-top: 1px solid #2a3f5f; padding-top: 12px; margin-top: 12px;">
          <div style="color: #ffd700; margin-bottom: 8px;">📋 RECENT SETTLEMENTS (Model vs Actual)</div>
          <div id="dashboard-settlements" style="margin-left: 8px; max-height: 300px; overflow-y: auto; color: #90caf9;"></div>
        </div>
      </div>
    `;
    
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div);
  }

  // ── Extract prediction data from app state ──
  function getSettlementData() {
    const log = window._kalshiLog || [];
    const resLog = window._15mResolutionLog || [];
    
    // Merge and sort by timestamp
    const all = [
      ...log.filter(e => e._settled).map(e => ({
        sym: e.sym,
        modelDir: e.modelDir,
        outcome: e._kalshiResult,
        ts: e.ts || e.settledTs,
        source: 'kalshi-log',
        correct: e.modelCorrect,
        confidence: e.proxyConfidence || e.modelConf || 0,
        kalshiProb: e.kYesPct || 0,
        kYesAsk: e.yesAsk || 0,
        kYesBid: e.yesBid || 0,
        kNoAsk: e.noAsk || 0,
        kNoBid: e.noBid || 0
      })),
      ...resLog.filter(e => e.modelCorrect !== null).map(e => ({
        sym: e.sym,
        modelDir: e.direction,
        outcome: e.actualOutcome,
        ts: e.settledTs,
        source: 'resolution-log',
        correct: e.modelCorrect,
        confidence: e.confidence || e.modelConf || 0,
        kalshiProb: e.entryProb != null ? Math.round(e.entryProb * 100) : 0,
        kYesAsk: e.yesAsk || (e.closeSnapshots?.slice(-1)[0]?.kalshiProb != null ? Math.round(e.closeSnapshots.slice(-1)[0].kalshiProb * 100) : 0),
        kYesBid: e.yesBid || 0,
        kNoAsk: e.noAsk || 0,
        kNoBid: e.noBid || 0
      }))
    ];
    
    return all.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  }

  // ── Calculate win rates by coin ──
  function calculateStats() {
    const data = getSettlementData();
    const stats = {};
    
    for (const d of data) {
      if (!stats[d.sym]) {
        stats[d.sym] = { wins: 0, total: 0 };
      }
      stats[d.sym].total++;
      if (d.correct === true) stats[d.sym].wins++;
    }
    
    return stats;
  }

  // ── Update dashboard UI ──
  function updateDashboard() {
    const stats = calculateStats();
    const data = getSettlementData();
    
    // Coin stats
    const coinStatsDiv = document.getElementById('dashboard-coin-stats');
    if (coinStatsDiv) {
      let html = '';
      Object.entries(stats).forEach(([sym, s]) => {
        const wr = Math.round((s.wins / s.total) * 100);
        const color = wr >= 55 ? '#26d47e' : wr >= 50 ? '#ffd700' : '#ff4444';
        html += `<div style="color: ${color}; margin-bottom: 4px;">${sym}: ${wr}% (${s.wins}/${s.total})</div>`;
      });
      coinStatsDiv.innerHTML = html || '<div style="color: #888;">No settlements yet</div>';
    }
    
    // Recent settlements
    const settlementsDiv = document.getElementById('dashboard-settlements');
    if (settlementsDiv) {
      const recent = data.slice(0, 15);
      let html = '';
      
      for (const d of recent) {
        const isCorrect = d.correct === true;
        const icon = isCorrect ? '✅' : d.correct === false ? '❌' : '❓';
        const modelStr = d.modelDir || '?';
        const actualStr = d.outcome || '?';
        const time = new Date(d.ts).toISOString().slice(11, 19);
        
        html += `<div style="
          display: flex;
          gap: 8px;
          margin-bottom: 6px;
          padding: 6px;
          background: ${isCorrect ? 'rgba(38,212,126,0.1)' : 'rgba(255,68,68,0.1)'};
          border-left: 2px solid ${isCorrect ? '#26d47e' : '#ff4444'};
          border-radius: 2px;
        ">
          <span>${icon}</span>
          <span style="flex: 1;">
            <span style="color: #a0aec0;">${d.sym}</span>
            <span style="color: #888; margin: 0 6px;">model=${modelStr}</span>
            <span style="color: #888;">→</span>
            <span style="color: #888; margin-left: 6px;">actual=${actualStr}</span>
          </span>
          <span style="color: #666; font-size: 10px;">${time}</span>
        </div>`;
      }
      
      settlementsDiv.innerHTML = html || '<div style="color: #888;">No settlements logged yet</div>';
    }
  }

  // ── API for console access ──
  window.KalshiSettlementDebug = {
    show: () => {
      const el = document.getElementById(DASHBOARD_ID);
      if (el) el.style.display = 'block';
    },
    hide: () => {
      const el = document.getElementById(DASHBOARD_ID);
      if (el) el.style.display = 'none';
    },
    refresh: updateDashboard,
    getStats: calculateStats,
    getSettlements: getSettlementData,
    getAllData: getSettlementData,
    printReport: () => {
      const stats = calculateStats();
      const data = getSettlementData();
      console.log('═══════════════════════════════════════════');
      console.log('KALSHI SETTLEMENT ACCURACY REPORT');
      console.log('═══════════════════════════════════════════');
      
      let totalWins = 0, totalTrades = 0;
      Object.entries(stats).forEach(([sym, s]) => {
        const wr = Math.round((s.wins / s.total) * 100);
        console.log(`${sym}: ${wr}% (${s.wins}/${s.total})`);
        totalWins += s.wins;
        totalTrades += s.total;
      });
      
      const overallWR = totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0;
      console.log('───────────────────────────────────────────');
      console.log(`OVERALL: ${overallWR}% (${totalWins}/${totalTrades})`);
      console.log('═══════════════════════════════════════════');
      
      console.log('\nRecent 10 settlements:');
      data.slice(0, 10).forEach(d => {
        const icon = d.correct === true ? '✓' : d.correct === false ? '✗' : '?';
        console.log(`  ${icon} ${d.sym}: model=${d.modelDir} actual=${d.outcome}`);
      });
    }
  };

  // ── Auto-create dashboard when app loads ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      createDashboard();
      setInterval(updateDashboard, 2000);  // Refresh every 2s
    });
  } else {
    createDashboard();
    setInterval(updateDashboard, 2000);
  }

  console.log('[KalshiSettlementDebug] Dashboard loaded. Use window.KalshiSettlementDebug.printReport() to see accuracy.');
})();
