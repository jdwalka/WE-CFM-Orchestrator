const fs = require('fs');

const file = 'g:/WECRYPTO/electron/multi-drive-logger-handlers.js';
let code = fs.readFileSync(file, 'utf8');

const correctCode = `ipcMain.handle('multi-drive:get-all-logs', async (event, args = {}) => {
  let { targets } = args;
  targets = augmentTargets(targets);
  const logs = {
    network_drives: [],
    onedrive: [],
    google_drive: []
  };

  const scanDirectory = async (baseDir, category) => {
    try {
      let scanPath = baseDir;
      if (category === 'onedrive' || category === 'google_drive') {
        scanPath = path.join(baseDir, 'WECRYPTO', 'settlement-logs');
      }

      if (!(await existsAsync(scanPath))) return [];

      const dirents = await fsp.readdir(scanPath);
      const validFiles = dirents.filter(f => f.startsWith('polymarket-settlements-') && f.endsWith('.log'));
      
      const files = [];
      for (const f of validFiles) {
        const fullPath = path.join(scanPath, f);
        const stats = await fsp.stat(fullPath);
        files.push({
          filename: f,
          path: fullPath,
          size: stats.size,
          modified: stats.mtime
        });
      }
      return files.sort((a, b) => b.modified - a.modified);
    } catch (e) {
      console.error(\`[Multi-Drive] Error scanning \${baseDir}:\`, e.message);
      return [];
    }
  };

  // Scan all targets
  for (const dir of targets.network_drives) {
    if (dir) logs.network_drives.push(...(await scanDirectory(dir, 'network_drives')));
  }
  for (const dir of targets.onedrive) {
    if (dir) logs.onedrive.push(...(await scanDirectory(dir, 'onedrive')));
  }
  for (const dir of targets.google_drive) {
    if (dir) logs.google_drive.push(...(await scanDirectory(dir, 'google_drive')));
  }

  return logs;
});

/**
 * Read settlement log file
 */`;

// Find where it got cut off:
// From: ipcMain.handle('multi-drive:get-all-logs', async (event, args = {}) => {
// ...
// To: /**
//  * Read settlement log file
//  */

code = code.replace(/ipcMain\.handle\('multi-drive:get-all-logs'[\s\S]*?\/\*\*\r?\n \* Read settlement log file\r?\n \*\//, correctCode);

fs.writeFileSync(file, code, 'utf8');
console.log("Restored!");
