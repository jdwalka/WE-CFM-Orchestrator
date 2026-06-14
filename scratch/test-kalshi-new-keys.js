const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseKeyFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const rawLines = content.split(/\r?\n/);
  const nonEmpty = rawLines.map(l => l.trim()).filter(Boolean);
  const apiKeyId = nonEmpty[0];
  const beginIdx = rawLines.findIndex(l => l.includes('-----BEGIN'));
  const endIdx = rawLines.findIndex(l => l.includes('-----END'));
  let privateKeyPem = null;
  if (beginIdx !== -1 && endIdx !== -1 && endIdx >= beginIdx) {
    privateKeyPem = rawLines.slice(beginIdx, endIdx + 1).join('\n').trim();
  }
  return { apiKeyId, privateKeyPem, path: filePath };
}

async function testKey(keyObj, name) {
  const { apiKeyId, privateKeyPem } = keyObj;
  console.log(`\nTesting Key [${name}] | ID: ${apiKeyId}`);
  
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
    const text = await res.text();
    console.log(`  Response Code: ${res.status} (${res.statusText}) in ${Date.now() - start}ms`);
    console.log(`  Body: ${text.substring(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    return false;
  }
}

async function run() {
  const key1 = parseKeyFile('G:\\WECRYPTO\\secrets\\KALSHI_API_SHA256_WeCrypto.txt');
  const key2 = parseKeyFile('G:\\WECRYPTO\\secrets\\KALSHI_WEBSOCKETS and WORKER READ_ONLY.txt');

  if (key1) await testKey(key1, 'KALSHI_API_SHA256_WeCrypto.txt');
  if (key2) await testKey(key2, 'KALSHI_WEBSOCKETS and WORKER READ_ONLY.txt');
  
  process.exit(0);
}

run();
