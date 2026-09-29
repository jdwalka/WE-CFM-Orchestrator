const fs = require('fs');
const path = require('path');

function scan(dir) {
  const results = [];
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file === 'node_modules' || file === '.git' || file === '.snapshots') continue;
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...scan(fullPath));
      } else if (file.endsWith('.har')) {
        results.push({ path: fullPath, size: stat.size, mtime: stat.mtime });
      }
    }
  } catch (e) {
    // ignore
  }
  return results;
}

const harFiles = scan('G:\\WECRYPTO');
harFiles.sort((a, b) => b.mtime - a.mtime);

console.log('HAR FILES FOUND (newest first):');
for (const file of harFiles) {
  console.log(`- ${file.path} (${file.size} bytes) - Modified: ${file.mtime.toISOString()}`);
}
console.log('Scan complete.');
