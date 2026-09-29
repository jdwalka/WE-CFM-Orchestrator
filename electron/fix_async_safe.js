const fs = require('fs');

const file = 'g:/WECRYPTO/electron/multi-drive-logger-handlers.js';
let code = fs.readFileSync(file, 'utf8');

// Ensure fsp is added
if (!code.includes("const fsp = require('fs').promises;")) {
  code = code.replace("const fs = require('fs');", "const fs = require('fs');\nconst fsp = require('fs').promises;\nasync function existsAsync(p) { try { await fsp.access(p); return true; } catch { return false; } }");
}

// 1. Fix init-directories
code = code.replace("ipcMain.on('multi-drive:init-directories', (event, { targets, filename }) => {", "ipcMain.on('multi-drive:init-directories', async (event, { targets, filename }) => {");

code = code.replace(
  /if \(!fs\.existsSync\(dir\)\) \{\s*fs\.mkdirSync\(dir, \{ recursive: true \}\);\s*\}/g,
  "if (!(await existsAsync(dir))) { await fsp.mkdir(dir, { recursive: true }); }"
);

code = code.replace(
  /if \(!fs\.existsSync\(targetDir\)\) \{\s*fs\.mkdirSync\(targetDir, \{ recursive: true \}\);\s*\}/g,
  "if (!(await existsAsync(targetDir))) { await fsp.mkdir(targetDir, { recursive: true }); }"
);

code = code.replace(
  /if \(!fs\.existsSync\(dir\)\) continue; \/\/ ONLY write if the base OneDrive directory actually exists/g,
  "if (!(await existsAsync(dir))) continue; // ONLY write if the base OneDrive directory actually exists"
);
code = code.replace(
  /if \(!fs\.existsSync\(dir\)\) continue; \/\/ ONLY write if the base Google Drive directory actually exists/g,
  "if (!(await existsAsync(dir))) continue; // ONLY write if the base Google Drive directory actually exists"
);

// 2. Fix write-settlement-log
code = code.replace("ipcMain.on('multi-drive:write-settlement-log', (event, { filename, content, isNewFile, targets, recordCount }) => {", "ipcMain.on('multi-drive:write-settlement-log', async (event, { filename, content, isNewFile, targets, recordCount }) => {");
code = code.replace("const writeToTarget = (targetList, category) => {", "const writeToTarget = async (targetList, category) => {");

code = code.replace(
  /if \(!fs\.existsSync\(baseDir\)\) continue; \/\/ NEVER auto-create the base drive directory!/g,
  "if (!(await existsAsync(baseDir))) continue; // NEVER auto-create the base drive directory!"
);

code = code.replace(
  /if \(!fs\.existsSync\(dir\)\) \{\s*fs\.mkdirSync\(dir, \{ recursive: true \}\);\s*\}/g,
  "if (!(await existsAsync(dir))) { await fsp.mkdir(dir, { recursive: true }); }"
);

code = code.replace(
  /if \(isNewFile\) \{\s*fs\.writeFileSync\(targetPath, content, 'utf8'\);\s*\} else \{\s*fs\.appendFileSync\(targetPath, content, 'utf8'\);\s*\}/g,
  "if (isNewFile) { await fsp.writeFile(targetPath, content, 'utf8'); } else { await fsp.appendFile(targetPath, content, 'utf8'); }"
);

// 3. Update calls to writeToTarget
code = code.replace("writeToTarget(targets.network_drives, 'network_drives');", "await writeToTarget(targets.network_drives, 'network_drives');");
code = code.replace("writeToTarget(targets.onedrive, 'onedrive');", "await writeToTarget(targets.onedrive, 'onedrive');");
code = code.replace("writeToTarget(targets.google_drive, 'google_drive');", "await writeToTarget(targets.google_drive, 'google_drive');");

fs.writeFileSync(file, code, 'utf8');
console.log("Safely applied async fixes.");
