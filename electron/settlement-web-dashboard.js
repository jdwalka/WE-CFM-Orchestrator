/**
 * Kalshi Settlement Web Dashboard Server
 * 
 * HTTPS web service for viewing settlement data across all drives
 * Accessible via Edge browser + Copilot integration
 * 
 * Endpoints:
 *   GET  /api/settlements        → Get all settlement records
 *   GET  /api/stats              → Get win rates by coin
 *   GET  /api/sync-all           → Sync and merge all drive logs
 *   GET  /api/status             → Get sync status for all drives
 *   GET  /                        → Web UI dashboard
 */

const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.SETTLEMENT_DASHBOARD_PORT || 3450;
const HOST = process.env.SETTLEMENT_DASHBOARD_HOST || 'localhost';

let app = null;
let server = null;

/**
 * Get all settlement log files from multi-drive targets
 */
function getAllSettlementLogs(targets) {
  const logs = [];
  const username = os.userInfo().username;

  const allTargets = [
    // Network drives
    ...targets.network_drives,
    // OneDrive
    ...(targets.onedrive || []).map(base => {
      const oneDrivePath = base || path.join('C:\\Users', username, 'OneDrive');
      return path.join(oneDrivePath, 'WECRYPTO', 'settlement-logs');
    }),
    // Google Drive
    ...(targets.google_drive || []).map(base => {
      const gdrPath = base || path.join('C:\\Users', username, 'Google Drive');
      return path.join(gdrPath, 'WECRYPTO', 'settlement-logs');
    })
  ];

  for (const dir of allTargets) {
    try {
      if (!fs.existsSync(dir)) continue;
      
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('kalshi-settlements-') && f.endsWith('.log'))
        .map(f => {
          const fullPath = path.join(dir, f);
          return {
            filename: f,
            path: fullPath,
            size: fs.statSync(fullPath).size,
            modified: fs.statSync(fullPath).mtime,
            source: dir
          };
        });

      logs.push(...files);
    } catch (e) {
      console.error(`[Dashboard] Error scanning ${dir}:`, e.message);
    }
  }

  return logs;
}

/**
 * Parse settlement CSV file
 */
function parseSettlementLog(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 7) {
        records.push({
          timestamp: parts[0],
          coin: parts[1],
          model_direction: parts[2],
          kalshi_outcome: parts[3],
          result: parts[4],
          confidence: parseFloat(parts[5]) || 0,
          kalshi_probability: parseFloat(parts[6]) || 0
        });
      }
    }

    return records;
  } catch (e) {
    console.error(`[Dashboard] Error parsing ${filepath}:`, e.message);
    return [];
  }
}

/**
 * Calculate statistics from settlement records
 */
function calculateStats(records) {
  const stats = {
    total: records.length,
    by_coin: {},
    by_result: { WIN: 0, LOSS: 0, PENDING: 0 },
    by_direction: { UP: 0, DOWN: 0, WAIT: 0 },
    win_rate: 0,
    avg_confidence: 0
  };

  if (records.length === 0) return stats;

  let totalConfidence = 0;
  const wins = [];
  const losses = [];

  for (const r of records) {
    // By coin
    if (!stats.by_coin[r.coin]) {
      stats.by_coin[r.coin] = {
        total: 0,
        wins: 0,
        losses: 0,
        pending: 0,
        win_rate: 0,
        avg_confidence: 0
      };
    }

    stats.by_coin[r.coin].total++;
    totalConfidence += r.confidence;

    if (r.result === 'WIN') {
      stats.by_coin[r.coin].wins++;
      stats.by_result.WIN++;
      wins.push(r);
    } else if (r.result === 'LOSS') {
      stats.by_coin[r.coin].losses++;
      stats.by_result.LOSS++;
      losses.push(r);
    } else {
      stats.by_coin[r.coin].pending++;
      stats.by_result.PENDING++;
    }

    // By direction
    if (r.model_direction && r.model_direction !== 'UNKNOWN') {
      const dir = r.model_direction === 'UP' ? 'UP' : r.model_direction === 'DOWN' ? 'DOWN' : 'WAIT';
      stats.by_direction[dir]++;
    }
  }

  // Calculate per-coin win rates
  for (const coin of Object.keys(stats.by_coin)) {
    const c = stats.by_coin[coin];
    c.win_rate = c.total > 0 ? Math.round((c.wins / c.total) * 100) : 0;
    c.avg_confidence = c.total > 0 ? Math.round((totalConfidence / c.total) * 100) / 100 : 0;
  }

  // Overall stats
  stats.win_rate = stats.total > 0 ? Math.round(((stats.by_result.WIN || 0) / stats.total) * 100) : 0;
  stats.avg_confidence = stats.total > 0 ? Math.round((totalConfidence / stats.total) * 100) / 100 : 0;

  return stats;
}

/**
 * Start HTTPS server
 */
function startServer(targets) {
  if (server) return; // Already running

  app = express();

  // Middleware
  app.use(express.json());
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // Routes
  app.get('/api/settlements', (req, res) => {
    const logs = getAllSettlementLogs(targets);
    const allRecords = [];

    for (const log of logs) {
      const records = parseSettlementLog(log.path);
      allRecords.push(...records.map(r => ({ ...r, source: log.source })));
    }

    res.json({
      success: true,
      record_count: allRecords.length,
      log_file_count: logs.length,
      records: allRecords
    });
  });

  app.get('/api/stats', (req, res) => {
    const logs = getAllSettlementLogs(targets);
    const allRecords = [];

    for (const log of logs) {
      const records = parseSettlementLog(log.path);
      allRecords.push(...records);
    }

    const stats = calculateStats(allRecords);

    res.json({
      success: true,
      stats: stats
    });
  });

  app.get('/api/sync-all', (req, res) => {
    const logs = getAllSettlementLogs(targets);
    const mergedRecords = new Map();

    for (const log of logs) {
      const records = parseSettlementLog(log.path);
      for (const r of records) {
        const key = `${r.timestamp}-${r.coin}`;
        if (!mergedRecords.has(key)) {
          mergedRecords.set(key, r);
        }
      }
    }

    const merged = Array.from(mergedRecords.values()).sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );

    const stats = calculateStats(merged);

    res.json({
      success: true,
      merged_record_count: merged.length,
      stats: stats,
      recent: merged.slice(0, 50)
    });
  });

  app.get('/api/status', (req, res) => {
    const logs = getAllSettlementLogs(targets);
    const statusBySource = {};

    for (const log of logs) {
      if (!statusBySource[log.source]) {
        statusBySource[log.source] = { file_count: 0, total_size: 0, files: [] };
      }
      statusBySource[log.source].file_count++;
      statusBySource[log.source].total_size += log.size;
      statusBySource[log.source].files.push({
        filename: log.filename,
        size: log.size,
        modified: log.modified
      });
    }

    res.json({
      success: true,
      targets: targets,
      status_by_source: statusBySource,
      total_log_files: logs.length
    });
  });

  // Web UI
  app.get('/', (req, res) => {
    res.send(getDashboardHTML());
  });

  // Create self-signed cert if not exists
  const certDir = path.join(os.homedir(), 'AppData', 'Roaming', 'WE-CRYPTO', 'certs');
  const certFile = path.join(certDir, 'settlement-dashboard.crt');
  const keyFile = path.join(certDir, 'settlement-dashboard.key');

  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    console.log('[Dashboard] Generating self-signed certificate...');
    const { execSync } = require('child_process');
    try {
      execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 365 -nodes -subj "/CN=localhost"`, {
        stdio: 'ignore'
      });
    } catch (e) {
      console.warn('[Dashboard] Could not generate cert with openssl, using insecure mode');
      // Fallback: use http instead
    }
  }

  // Start HTTPS server
  try {
    const options = {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile)
    };
    server = https.createServer(options, app);
  } catch (e) {
    console.warn('[Dashboard] HTTPS cert not available, using HTTP:', e.message);
    const http = require('http');
    server = http.createServer(app);
  }

  server.listen(PORT, HOST, () => {
    const protocol = server instanceof https.Server ? 'HTTPS' : 'HTTP';
    console.log(`[Dashboard] Settlement web dashboard running: ${protocol}://${HOST}:${PORT}`);
  });
}

/**
 * Get dashboard HTML
 */
function getDashboardHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WECRYPTO Settlement Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: linear-gradient(135deg, #0b1020 0%, #1a2540 100%);
      color: #e0e0e0;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    header {
      border-bottom: 2px solid #00d4ff;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    h1 {
      color: #00d4ff;
      font-size: 32px;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #90caf9;
      font-size: 14px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: rgba(26, 37, 64, 0.8);
      border: 1px solid #00d4ff;
      border-radius: 8px;
      padding: 20px;
      text-align: center;
    }
    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: #26d47e;
      margin: 10px 0;
    }
    .stat-label {
      font-size: 14px;
      color: #90caf9;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .coin-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-top: 20px;
    }
    .coin-card {
      background: rgba(15, 22, 34, 0.8);
      border-left: 4px solid #00d4ff;
      padding: 15px;
      border-radius: 4px;
    }
    .coin-name {
      font-weight: 700;
      font-size: 16px;
      color: #ffd700;
      margin-bottom: 8px;
    }
    .coin-stat {
      font-size: 12px;
      color: #90caf9;
      margin: 4px 0;
    }
    .wr-good { color: #26d47e; }
    .wr-ok { color: #ffd700; }
    .wr-bad { color: #ff4444; }
    .recent-settlements {
      background: rgba(26, 37, 64, 0.8);
      border: 1px solid #00d4ff;
      border-radius: 8px;
      padding: 20px;
    }
    .settlement-row {
      display: flex;
      gap: 15px;
      padding: 10px;
      border-bottom: 1px solid #2a3f5f;
      font-size: 12px;
      align-items: center;
    }
    .settlement-row:last-child { border-bottom: none; }
    .icon { font-size: 18px; }
    .settlement-time { color: #888; min-width: 150px; }
    .settlement-coin { color: #ffd700; font-weight: 700; min-width: 50px; }
    .settlement-pred { color: #90caf9; }
    .settlement-actual { color: #90caf9; }
    .settlement-result { font-weight: 700; }
    .result-win { color: #26d47e; }
    .result-loss { color: #ff4444; }
    .loading { color: #00d4ff; font-style: italic; }
    button {
      background: #00d4ff;
      color: #0b1020;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 700;
      margin-right: 10px;
      margin-top: 20px;
    }
    button:hover { background: #26d47e; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🧪 WECRYPTO Settlement Dashboard</h1>
      <p class="subtitle">Real-time model accuracy tracking across Kalshi 15m contracts</p>
    </header>

    <div id="stats-container" class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Records</div>
        <div class="stat-value" id="total-records">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value" id="overall-wr">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Confidence</div>
        <div class="stat-value" id="avg-confidence">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Log Sources</div>
        <div class="stat-value" id="log-sources">—</div>
      </div>
    </div>

    <div style="background: rgba(26, 37, 64, 0.8); border: 1px solid #00d4ff; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
      <h2 style="color: #ffd700; margin-bottom: 15px;">📊 Win Rate by Coin</h2>
      <div class="coin-stats" id="coin-stats"></div>
    </div>

    <div class="recent-settlements">
      <h2 style="color: #ffd700; margin-bottom: 15px;">📋 Recent Settlements</h2>
      <div id="settlements-list" class="loading">Loading settlements...</div>
    </div>

    <div style="margin-top: 20px;">
      <button onclick="location.reload()">🔄 Refresh</button>
      <button onclick="syncAllLogs()">⚡ Sync All Drives</button>
    </div>
  </div>

  <script>
    async function loadData() {
      try {
        const [statsRes, settlementsRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/sync-all')
        ]);

        const statsData = await statsRes.json();
        const settlementsData = await settlementsRes.json();

        if (statsData.success) {
          const stats = statsData.stats;
          document.getElementById('total-records').textContent = stats.total || 0;
          document.getElementById('overall-wr').textContent = (stats.win_rate || 0) + '%';
          document.getElementById('avg-confidence').textContent = (stats.avg_confidence || 0).toFixed(2);

          // Coin stats
          const coinHtml = Object.entries(stats.by_coin || {})
            .map(([coin, data]) => {
              const wrColor = data.win_rate >= 55 ? 'wr-good' : data.win_rate >= 50 ? 'wr-ok' : 'wr-bad';
              return \`
                <div class="coin-card">
                  <div class="coin-name">\${coin}</div>
                  <div class="coin-stat"><strong>\${data.win_rate}%</strong> WR</div>
                  <div class="coin-stat">\${data.wins}W / \${data.losses}L</div>
                  <div class="coin-stat">Conf: \${data.avg_confidence}</div>
                </div>
              \`;
            })
            .join('');
          document.getElementById('coin-stats').innerHTML = coinHtml;
        }

        if (settlementsData.success) {
          const recent = settlementsData.recent || [];
          const html = recent.slice(0, 20).map(r => {
            const isCorrect = r.result === 'WIN';
            const icon = isCorrect ? '✅' : r.result === 'LOSS' ? '❌' : '❓';
            const resultClass = isCorrect ? 'result-win' : 'result-loss';
            const time = new Date(r.timestamp).toLocaleTimeString();
            return \`
              <div class="settlement-row">
                <div class="icon">\${icon}</div>
                <div class="settlement-time">\${time}</div>
                <div class="settlement-coin">\${r.coin}</div>
                <div class="settlement-pred">Model: \${r.model_direction}</div>
                <div class="settlement-actual">Actual: \${r.kalshi_outcome}</div>
                <div class="settlement-result \${resultClass}">\${r.result}</div>
                <div style="margin-left: auto; color: #888;">\${r.confidence}%</div>
              </div>
            \`;
          }).join('');
          document.getElementById('settlements-list').innerHTML = html || '<div class="loading">No settlements yet</div>';

          document.getElementById('log-sources').textContent = settlementsData.merged_record_count > 0 ? 'Multi-drive' : '—';
        }
      } catch (e) {
        console.error('Error loading data:', e);
        document.getElementById('settlements-list').innerHTML = '<div style="color: #ff4444;">Error loading data</div>';
      }
    }

    async function syncAllLogs() {
      alert('Syncing all settlement logs from network drives, OneDrive, and Google Drive...');
      try {
        const res = await fetch('/api/sync-all');
        const data = await res.json();
        if (data.success) {
          alert('Sync complete! ' + data.merged_record_count + ' total records.');
          loadData();
        }
      } catch (e) {
        alert('Sync error: ' + e.message);
      }
    }

    // Load on startup and refresh every 10 seconds
    loadData();
    setInterval(loadData, 10000);
  </script>
</body>
</html>
  `;
}

/**
 * Public API
 */
module.exports = {
  startServer,
  getAllSettlementLogs,
  parseSettlementLog,
  calculateStats,
  getDashboardHTML,
  PORT,
  HOST
};

console.log('[SettlementWebDashboard] Module loaded');
