const https = require('https');

function testUrl(url) {
  return new Promise((resolve) => {
    console.log(`Testing connection to ${url}...`);
    const start = Date.now();
    const req = https.get(url, (res) => {
      console.log(`  [${url}] Success: HTTP ${res.statusCode} in ${Date.now() - start}ms`);
      resolve(true);
    });

    req.on('error', (err) => {
      console.error(`  [${url}] Failed in ${Date.now() - start}ms:`, err.message);
      resolve(false);
    });

    req.setTimeout(8000, () => {
      console.error(`  [${url}] Timeout after 8000ms`);
      req.destroy();
      resolve(false);
    });
  });
}

async function run() {
  await testUrl('https://www.google.com');
  await testUrl('https://api.elections.kalshi.com/trade-api/v2/markets?limit=1');
  await testUrl('https://firestore.googleapis.com');
  process.exit(0);
}

run();
