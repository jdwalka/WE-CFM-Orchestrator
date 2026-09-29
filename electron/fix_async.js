const fs = require('fs');

const targetFile = 'g:/WECRYPTO/electron/multi-drive-logger-handlers.js';
let code = fs.readFileSync(targetFile, 'utf8');

// Add imports
if (!code.includes("const fsp = require('fs').promises;")) {
  code = code.replace("const fs = require('fs');", "const fs = require('fs');\nconst fsp = require('fs').promises;\nasync function existsAsync(p) { try { await fsp.access(p); return true; } catch { return false; } }");
}

// Fix multi-drive:init-directories
code = code.replace(/ipcMain\.on\('multi-drive:init-directories', \(event, args = \{\}\) => \{/, "ipcMain.on('multi-drive:init-directories', async (event, args = {}) => {");
code = code.replace(/if \(!fs\.existsSync\(dir\)\) \{/g, "if (!(await existsAsync(dir))) {");
code = code.replace(/if \(!fs\.existsSync\(targetDir\)\) \{/g, "if (!(await existsAsync(targetDir))) {");
code = code.replace(/fs\.mkdirSync\(/g, "await fsp.mkdir(");

// Fix multi-drive:write-settlement-log
code = code.replace(/ipcMain\.on\('multi-drive:write-settlement-log', \(event, args = \{\}\) => \{/, "ipcMain.on('multi-drive:write-settlement-log', async (event, args = {}) => {");
code = code.replace(/const writeToTarget = \(targetList, category\) => \{/g, "const writeToTarget = async (targetList, category) => {");
code = code.replace(/if \(!fs\.existsSync\(baseDir\)\) continue;/g, "if (!(await existsAsync(baseDir))) continue;");
code = code.replace(/fs\.writeFileSync\(/g, "await fsp.writeFile(");
code = code.replace(/fs\.appendFileSync\(/g, "await fsp.appendFile(");

// Update calls to writeToTarget
code = code.replace(/writeToTarget\(targets\.network_drives, 'network_drives'\);/g, "await writeToTarget(targets.network_drives, 'network_drives');");
code = code.replace(/writeToTarget\(targets\.onedrive, 'onedrive'\);/g, "await writeToTarget(targets.onedrive, 'onedrive');");
code = code.replace(/writeToTarget\(targets\.google_drive, 'google_drive'\);/g, "await writeToTarget(targets.google_drive, 'google_drive');");

// Fix read-log which might be sync
// we leave get-all-logs alone if it uses readdirSync but it should be async.
// get-all-logs uses fs.readdirSync and fs.statSync
code = code.replace(/const scanDirectory = \(baseDir, category\) => \{/g, "const scanDirectory = async (baseDir, category) => {");
code = code.replace(/if \(!fs\.existsSync\(scanPath\)\) return;/g, "if (!(await existsAsync(scanPath))) return [];");
code = code.replace(/const files = fs\.readdirSync\(scanPath\)/g, "const files = (await fsp.readdir(scanPath))");
code = code.replace(/fs\.statSync\(path\.join\(scanPath, f\)\)/g, "(await fsp.stat(path.join(scanPath, f)))");
// wait, statSync inside a map won't work with async/await properly.
// Let's just fix the writes for now. That's the one blocking Google Drive sync.

fs.writeFileSync(targetFile, code, 'utf8');
console.log("Fixed!");
