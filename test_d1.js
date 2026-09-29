const { execSync } = require('child_process');

function getWranglerCmd() {
  try {
    execSync('wrangler --version', { stdio: 'ignore' });
    return 'wrangler';
  } catch (e) {
    return 'npx wrangler';
  }
}

function runWranglerD1(cmd) {
  const wrangler = getWranglerCmd();
  const fullCmd = `${wrangler} d1 execute scalper-calibration --remote --json --command "${cmd.replace(/"/g, '\\"')}"`;
  const stdout = execSync(fullCmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  // Find JSON array in output
  const jsonStart = stdout.indexOf('[');
  if (jsonStart === -1) {
    throw new Error('No JSON output found in wrangler response: ' + stdout);
  }
  const parsed = JSON.parse(stdout.slice(jsonStart));
  return parsed[0]?.results || [];
}

try {
  const countRes = runWranglerD1('SELECT COUNT(*) as total, COUNT(CASE WHEN resolved_at_utc IS NOT NULL THEN 1 END) as resolved FROM predictions;');
  const latestRes = runWranglerD1('SELECT id, prediction_key, timestamp_utc, expiry_utc, band, p_calibrated, touched, resolved_at_utc FROM predictions ORDER BY id DESC LIMIT 1;');

  const total = countRes[0]?.total || 0;
  const resolved = countRes[0]?.resolved || 0;
  const latest = latestRes[0] || null;

  let stalenessMinutes = null;
  let isStale = true;
  if (latest?.timestamp_utc) {
    const ts = new Date(latest.timestamp_utc).getTime();
    stalenessMinutes = Math.round((Date.now() - ts) / (60 * 1000));
    isStale = stalenessMinutes > 60;
  }

  const result = {
    success: true,
    database: 'scalper-calibration (48536b22-03b3-42dd-92fa-44feab144d84)',
    predictions: {
      total,
      resolved,
      pending: total - resolved,
      latest_id: latest?.id || null,
      latest_timestamp_utc: latest?.timestamp_utc || null,
      latest_expiry_utc: latest?.expiry_utc || null,
      latest_band: latest?.band || null,
      latest_p_calibrated: latest?.p_calibrated || null,
      staleness_minutes: stalenessMinutes,
      is_stale: isStale
    }
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (e) {
  console.error(JSON.stringify({
    success: false,
    error: e.message || String(e)
  }, null, 2));
  process.exit(1);
}
