const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment
const rootDir = path.join(__dirname, '..');
if (fs.existsSync(path.join(rootDir, '.env'))) {
  dotenv.config({ path: path.join(rootDir, '.env') });
}
if (fs.existsSync(path.join(rootDir, '.env.local'))) {
  dotenv.config({ path: path.join(rootDir, '.env.local'), override: true });
}

// 1. Test loadKalshiCredentials
console.log('--- Testing Kalshi Credentials Loading ---');
const { loadKalshiCredentials } = require('../electron/kalshi-credentials.js');
const credentials = loadKalshiCredentials({ runtimeBaseDir: rootDir });

console.log('Credentials Resolution Result:');
console.log('  Success:', credentials.success);
if (credentials.success) {
  console.log('  Loaded Path:', credentials.path);
  console.log('  API Key ID:', credentials.apiKeyId);
  console.log('  Private Key length:', credentials.privateKeyPem?.length, 'bytes');
} else {
  console.error('  Error:', credentials.error);
  console.error('  Failures:', credentials.failures);
  process.exit(1);
}

// 2. Test Live Kalshi Authentication using loaded credentials
const crypto = require('crypto');
async function testKalshiAuth(creds) {
  console.log('\n--- Testing Live Kalshi Auth ---');
  const method = 'GET';
  const requestPath = '/trade-api/v2/portfolio/balance';
  const timestamp = String(Date.now());
  const msg = `${timestamp}${method}${requestPath}`;
  
  try {
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(msg)
      .sign({
        key: creds.privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      .toString('base64');

    const headers = {
      'Accept': 'application/json',
      'KALSHI-ACCESS-KEY': creds.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };

    const url = 'https://api.elections.kalshi.com/trade-api/v2/portfolio/balance';
    const start = Date.now();
    const res = await fetch(url, { method, headers });
    const text = await res.text();
    console.log(`  HTTP Response: ${res.status} (${res.statusText}) in ${Date.now() - start}ms`);
    console.log(`  Body Summary: ${text.substring(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.error('  Auth request failed:', err.message);
    return false;
  }
}

// 3. Test Firestore Startup Check (should fail fast if quota exceeded)
const fb = require('./test-firestore.js'); // reuse our previous test runner

async function run() {
  const authOk = await testKalshiAuth(credentials);
  console.log('\n--- Verification Summary ---');
  console.log('Credentials Resolution: PASS');
  console.log('Kalshi Auth Status:', authOk ? 'PASS' : 'FAIL');
  
  console.log('\nStarting Firestore fast-fail check...');
  // Require our firestore-admin-firestore directly and verify the config
  const fbAdminModule = require('../src/cloud/firebase-admin-firestore.js');
  const status = fbAdminModule.getStatus();
  console.log('Firestore initialization status:');
  console.log(`  Available: ${status.available}`);
  console.log(`  Configured: ${status.configured}`);
  console.log(`  preferRest: ${status.preferRest}`);
  
  console.log('\nVerification complete.');
  process.exit(authOk ? 0 : 1);
}

run();
