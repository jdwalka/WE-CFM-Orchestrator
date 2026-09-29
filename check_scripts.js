const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const html = fs.readFileSync('public/index.html', 'utf8');
const regex = /<script\s+[^>]*src=["']([^"']+)["']/gi;
const scriptSrcs = [];
let match;
while ((match = regex.exec(html)) !== null) {
  scriptSrcs.push(match[1]);
}

const errors = [];
for (const src of scriptSrcs) {
  if (src.startsWith('vendors/') || src.startsWith('http')) continue;
  const filePath = path.resolve('public', src);
  if (!fs.existsSync(filePath)) {
    errors.push({ file: src, error: 'File not found' });
    continue;
  }
  try {
    execSync(`node -c "${filePath}"`, { stdio: 'pipe' });
  } catch (err) {
    errors.push({ file: src, error: err.stderr ? err.stderr.toString() : err.message });
  }
}
console.log(`Checked ${scriptSrcs.length} scripts. Found ${errors.length} errors:`);
console.log(JSON.stringify(errors, null, 2));
