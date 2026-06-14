const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load API Keys from KALSHI-API-KEY.txt
const keysFile = 'G:\\WECRYPTO\\secrets\\KALSHI-API-KEY.txt';
if (!fs.existsSync(keysFile)) {
  console.error(`Keys file not found: ${keysFile}`);
  process.exit(1);
}

const content = fs.readFileSync(keysFile, 'utf8');
const rawLines = content.split(/\r?\n/);

const keys = [];
let currentKeyId = null;
let currentKeyPemLines = [];

for (let i = 0; i < rawLines.length; i++) {
  const line = rawLines[i].trim();
  if (!line) continue;
  
  if (line.includes('-----BEGIN')) {
    currentKeyPemLines.push(rawLines[i]); // Keep original spacing
  } else if (currentKeyPemLines.length > 0) {
    currentKeyPemLines.push(rawLines[i]);
    if (line.includes('-----END')) {
      keys.push({
        apiKeyId: currentKeyId,
        privateKeyPem: currentKeyPemLines.join('\n').trim()
      });
      currentKeyId = null;
      currentKeyPemLines = [];
    }
  } else if (line.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    currentKeyId = line;
  }
}

console.log(`Parsed ${keys.length} API keys from ${keysFile}.\n`);

// Helper to sign request manually (so we don't depend on kalshi-typescript SDK details)
async function testKey(keyObj, index) {
  const { apiKeyId, privateKeyPem } = keyObj;
  console.log(`[Key #${index + 1}] ID: ${apiKeyId.substring(0, 8)}...`);
  
  const method = 'GET';
  const requestPath = '/trade-api/v2/portfolio/balance';
  const timestamp = String(Date.now());
  const msg = `${timestamp}${method}${requestPath}`;
  
  try {
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(msg)
      .sign({
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      .toString('base64');

    const headers = {
      'Accept': 'application/json',
      'KALSHI-ACCESS-KEY': apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };

    const url = 'https://api.elections.kalshi.com/trade-api/v2/portfolio/balance';
    
    const start = Date.now();
    const res = await fetch(url, { method, headers });
    const elapsed = Date.now() - start;
    
    console.log(`  Response Code: ${res.status} (${res.statusText}) in ${elapsed}ms`);
    const text = await res.text();
    console.log(`  Body: ${text.substring(0, 200)}`);
    
    if (res.ok) {
      return { index, apiKeyId, success: true, body: text };
    }
    return { index, apiKeyId, success: false, status: res.status, error: text };
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    return { index, apiKeyId, success: false, error: err.message };
  }
}

async function run() {
  const results = [];
  for (let i = 0; i < keys.length; i++) {
    const result = await testKey(keys[i], i);
    results.push(result);
    console.log('-------------------------------------------');
  }
  
  const working = results.filter(r => r.success);
  if (working.length > 0) {
    console.log(`\nWORKING KEYS: ${working.map(w => `#${w.index + 1} (${w.apiKeyId})`).join(', ')}`);
  } else {
    console.log('\nNO WORKING KEYS FOUND');
  }
}

run();
