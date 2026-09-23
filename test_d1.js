const { execSync } = require('child_process');
try {
  const out = execSync('wrangler d1 info kodak-market-d1 --json');
  console.log(out.toString());
} catch(e) {
  console.log(e.toString());
}
