const { ipcMain } = require('electron');
const path = require('path');
const fsp = require('fs').promises;

const MULTI_DRIVE_FS_TIMEOUT_MS = Math.max(1000, Number(process.env.WECRYP_DATA_FS_TIMEOUT_MS) || 5000);
const GOOGLE_DRIVE_ACCOUNT_HINTS = [
  'maurofanelijr@gmail.com',
  'gitgoin87@gmail.com',
  'jdwalka@pm.me',
];

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'file operation'} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function existsAsync(p) {
  try {
    await withTimeout(fsp.access(p), 1200, `access ${p}`);
    return true;
  } catch {
    return false;
  }
}

function splitPathList(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(/[;\n]/)
    .map(part => part.trim())
    .filter(Boolean);
}

function googleAccountHints() {
  return Array.from(new Set([
    ...GOOGLE_DRIVE_ACCOUNT_HINTS,
    ...splitPathList(process.env.WECRYP_GOOGLE_DRIVE_ACCOUNTS),
    ...splitPathList(process.env.WECRYP_GOOGLE_ACCOUNT_HINTS),
  ].map(value => String(value || '').trim()).filter(Boolean)));
}

function googleDriveAccountCandidates(home) {
  const candidates = [];
  for (const account of googleAccountHints()) {
    candidates.push(path.join(home, `Google Drive (${account})`));
    candidates.push(path.join(home, `My Drive (${account})`));
  }
  return candidates;
}

function augmentTargets(t) {
  t = t || {};
  const username = process.env.USERNAME || 'user';
  const home = `C:\\Users\\${username}`;
  const unique = (paths) => Array.from(new Set((paths || []).filter(Boolean)));
  return {
    network_drives: unique([...(t.network_drives || [])]),
    onedrive: unique([
      ...(t.onedrive || []),
      process.env.ONEDRIVE || '',
      process.env.OneDriveConsumer || '',
      process.env.ONEDRIVE_BUSINESS || '',
      process.env.OneDriveCommercial || '',
      `C:\\Users\\${username}\\OneDrive`,
      `C:\\Users\\${username}\\OneDrive - Personal`,
      `C:\\Users\\${username}\\OneDrive - ctstate.edu`,
      `C:\\Users\\${username}\\OneDrive - Azure ctstate.edu`,
      `C:\\Users\\${username}\\OneDrive - Company`
    ]),
    google_drive: unique([
      ...(t.google_drive || []),
      `G:\\My Drive`,
      `G:\\Google Drive`,
      `H:\\My Drive`,
      `H:\\Google Drive`,
      `I:\\My Drive`,
      `I:\\Google Drive`,
      `${home}\\Google Drive`,
      `${home}\\My Drive`,
      ...googleDriveAccountCandidates(home),
      process.env.GOOGLE_DRIVE_PATH || '',
      ...splitPathList(process.env.WECRYP_GOOGLE_DRIVE_ROOTS),
      ...splitPathList(process.env.WECRYP_DRIVE_ROOTS)
    ])
  };
}

ipcMain.on('multi-drive:init-directories', async (event, args = {}) => {
  let { targets, filename } = args;
  const syncStatus = {
    network_drives: {},
    onedrive: {},
    google_drive: {}
  };

  targets = augmentTargets(targets);

  for (const dir of targets.network_drives) {
    if (!dir) continue;
    try {
      if (!(await existsAsync(dir))) {
        await withTimeout(fsp.mkdir(dir, { recursive: true }), MULTI_DRIVE_FS_TIMEOUT_MS, `mkdir ${dir}`);
      }
      syncStatus.network_drives[dir] = { success: true, message: 'Directory ready', full_path: path.join(dir, filename) };
    } catch (e) {
      syncStatus.network_drives[dir] = { success: false, message: `Error: ${e.message}` };
    }
  }

  for (const dir of targets.onedrive) {
    if (!dir) continue;
    try {
      if (!(await existsAsync(dir))) continue;
      const targetDir = path.join(dir, 'WECRYPTO', 'settlement-logs');
      if (!(await existsAsync(targetDir))) {
        await withTimeout(fsp.mkdir(targetDir, { recursive: true }), MULTI_DRIVE_FS_TIMEOUT_MS, `mkdir ${targetDir}`);
      }
      syncStatus.onedrive[dir] = { success: true, message: 'OneDrive directory ready', full_path: path.join(targetDir, filename) };
    } catch (e) {
      syncStatus.onedrive[dir] = { success: false, message: `Error: ${e.message}` };
    }
  }

  for (const dir of targets.google_drive) {
    if (!dir) continue;
    try {
      if (!(await existsAsync(dir))) continue;
      const targetDir = path.join(dir, 'WECRYPTO', 'settlement-logs');
      if (!(await existsAsync(targetDir))) {
        await withTimeout(fsp.mkdir(targetDir, { recursive: true }), MULTI_DRIVE_FS_TIMEOUT_MS, `mkdir ${targetDir}`);
      }
      syncStatus.google_drive[dir] = { success: true, message: 'Google Drive directory ready', full_path: path.join(targetDir, filename) };
    } catch (e) {
      syncStatus.google_drive[dir] = { success: false, message: `Error: ${e.message}` };
    }
  }

  event.reply('multi-drive:init-complete', syncStatus);
});

ipcMain.on('multi-drive:write-settlement-log', async (event, args = {}) => {
  let { filename, content, isNewFile, targets, recordCount } = args;
  targets = augmentTargets(targets);
  const syncStatus = {
    network_drives: {},
    onedrive: {},
    google_drive: {},
    summary: { total: 0, success: 0, failed: 0 }
  };

  const writeToTarget = async (targetList, category) => {
    for (const baseDir of targetList) {
      if (!baseDir) continue;

      let targetPath = baseDir;
      if (category === 'onedrive' || category === 'google_drive') {
        targetPath = path.join(baseDir, 'WECRYPTO', 'settlement-logs', filename);
      } else {
        targetPath = path.join(baseDir, filename);
      }

      if (!(await existsAsync(baseDir))) continue;
      try {
        const dir = path.dirname(targetPath);
        if (!(await existsAsync(dir))) {
          await withTimeout(fsp.mkdir(dir, { recursive: true }), MULTI_DRIVE_FS_TIMEOUT_MS, `mkdir ${dir}`);
        }

        if (isNewFile) {
          await withTimeout(fsp.writeFile(targetPath, content, 'utf8'), MULTI_DRIVE_FS_TIMEOUT_MS, `write ${targetPath}`);
        } else {
          await withTimeout(fsp.appendFile(targetPath, content, 'utf8'), MULTI_DRIVE_FS_TIMEOUT_MS, `append ${targetPath}`);
        }

        syncStatus[category][baseDir] = { success: true, message: `Wrote ${recordCount} records`, path: targetPath, timestamp: new Date().toISOString() };
        syncStatus.summary.success++;
      } catch (e) {
        syncStatus[category][baseDir] = { success: false, message: `Write failed: ${e.message}`, path: targetPath };
        syncStatus.summary.failed++;
      }
      syncStatus.summary.total++;
    }
  };

  await writeToTarget(targets.network_drives, 'network_drives');
  await writeToTarget(targets.onedrive, 'onedrive');
  await writeToTarget(targets.google_drive, 'google_drive');

  console.log(`[Multi-Drive] Write complete: ${syncStatus.summary.success}/${syncStatus.summary.total} targets successful`);
  event.reply('multi-drive:write-complete', { syncStatus });
});

async function getAllLogsCore(targets) {
  targets = augmentTargets(targets);
  const logs = { network_drives: [], onedrive: [], google_drive: [] };

  const scanDirectory = async (baseDir, category) => {
    try {
      let scanPath = baseDir;
      if (category === 'onedrive' || category === 'google_drive') {
        scanPath = path.join(baseDir, 'WECRYPTO', 'settlement-logs');
      }

      if (!(await existsAsync(scanPath))) return [];

      const dirents = await withTimeout(fsp.readdir(scanPath), MULTI_DRIVE_FS_TIMEOUT_MS, `readdir ${scanPath}`);
      const validFiles = dirents.filter(f => f.startsWith('polymarket-settlements-') && f.endsWith('.log'));

      const files = [];
      for (const f of validFiles) {
        const fullPath = path.join(scanPath, f);
        const stats = await withTimeout(fsp.stat(fullPath), MULTI_DRIVE_FS_TIMEOUT_MS, `stat ${fullPath}`);
        files.push({
          filename: f,
          path: fullPath,
          size: stats.size,
          modified: stats.mtime
        });
      }
      return files.sort((a, b) => b.modified - a.modified);
    } catch (e) {
      console.error(`[Multi-Drive] Error scanning ${baseDir}:`, e.message);
      return [];
    }
  };

  for (const dir of targets.network_drives) { if (dir) logs.network_drives.push(...(await scanDirectory(dir, 'network_drives'))); }
  for (const dir of targets.onedrive) { if (dir) logs.onedrive.push(...(await scanDirectory(dir, 'onedrive'))); }
  for (const dir of targets.google_drive) { if (dir) logs.google_drive.push(...(await scanDirectory(dir, 'google_drive'))); }

  return logs;
}

ipcMain.handle('multi-drive:get-all-logs', async (event, args = {}) => {
  return await getAllLogsCore(args.targets);
});

ipcMain.handle('multi-drive:read-log', async (event, args = {}) => {
  let { filepath } = args;
  try {
    const content = await fsp.readFile(filepath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 7) {
        records.push({
          timestamp: parts[0],
          coin: parts[1],
          model_direction: parts[2],
          polymarket_outcome: parts[3],
          result: parts[4],
          confidence: parseFloat(parts[5]),
          polymarket_probability: parseFloat(parts[6])
        });
      }
    }
    return { success: true, filepath, record_count: records.length, records: records };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('multi-drive:sync-all-logs', async (event, args = {}) => {
  let { targets } = args;
  targets = augmentTargets(targets);
  const allLogs = await getAllLogsCore(targets);
  const mergedRecords = new Map();

  for (const category of ['network_drives', 'onedrive', 'google_drive']) {
    for (const logFile of allLogs[category]) {
      try {
        const content = await withTimeout(fsp.readFile(logFile.path, 'utf8'), MULTI_DRIVE_FS_TIMEOUT_MS, `read ${logFile.path}`);
        const lines = content.split('\n').filter(l => l.trim());

        for (let i = 1; i < lines.length; i++) {
          const firstComma = lines[i].indexOf(',');
          if (firstComma > -1) {
            const secondComma = lines[i].indexOf(',', firstComma + 1);
            if (secondComma > -1) {
              const key = lines[i].slice(0, secondComma); // timestamp-coin
              if (!mergedRecords.has(key)) {
                mergedRecords.set(key, lines[i]);
              }
            }
          }
        }
      } catch (e) {
        console.error(`[Multi-Drive] Failed to read ${logFile.path} for sync:`, e.message);
      }

      // Let the event loop breathe between files
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Optimized Schwartzian transform sort to avoid freezing event loop on huge arrays
  const recordsArr = Array.from(mergedRecords.values());
  const sortedLines = recordsArr.map(line => {
    const tsStr = line.slice(0, line.indexOf(','));
    return { line, ts: new Date(tsStr).getTime() };
  }).sort((a, b) => b.ts - a.ts).map(obj => obj.line);

  const header = 'timestamp,coin,model_direction,polymarket_outcome,result,confidence,polymarket_probability\n';
  const mergedContent = header + sortedLines.join('\n');

  let writtenCount = 0;
  for (const category of ['network_drives', 'onedrive', 'google_drive']) {
    for (const dir of targets[category]) {
      if (!dir) continue;
      try {
        let targetPath = dir;
        if (category === 'onedrive' || category === 'google_drive') {
          targetPath = path.join(dir, 'WECRYPTO', 'settlement-logs');
        }
        if (!(await existsAsync(targetPath))) continue;

        targetPath = path.join(targetPath, 'polymarket-settlements-merged.log');
        await withTimeout(fsp.writeFile(targetPath, mergedContent, 'utf8'), MULTI_DRIVE_FS_TIMEOUT_MS, `write ${targetPath}`);
        writtenCount++;
      } catch (e) {
        console.error(`[Multi-Drive] Failed to write merged log to ${dir}:`, e.message);
      }
    }
  }

  return { success: true, merged_count: mergedRecords.size, targets_written: writtenCount };
});
