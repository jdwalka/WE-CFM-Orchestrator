'use strict';

const fs = require('fs');
const path = require('path');

// Simulate readEnvValue and loadCoinbaseCredential from electron/main.js
function readEnvValue(keys) {
  for (const k of keys) {
    if (process.env[k]) return process.env[k];
  }
  return null;
}

function coinbaseCredentialFromObject(obj, source) {
  if (!obj || !obj.name || !obj.privateKey) return null;
  return {
    name: String(obj.name).trim(),
    privateKey: String(obj.privateKey).trim(),
    source
  };
}

function loadCoinbaseCredential() {
  const legacyCandidates = [
    'F:\\WECRYPTO\\secrets\\cdp_api_key-WECRYPTO-ECDSA.json',
    'G:\\WECRYPTO\\secrets\\cdp_api_key-WECRYPTO-ECDSA.json',
  ];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const driveRoot = `${String.fromCharCode(code)}:\\`;
      legacyCandidates.push(path.join(driveRoot, 'WECRYPTO', 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'));
      legacyCandidates.push(path.join(driveRoot, 'My Drive', 'WECRYPTO', 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'));
      legacyCandidates.push(path.join(driveRoot, 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'));
      legacyCandidates.push(path.join(driveRoot, 'My Drive', 'secrets', 'cdp_api_key-WECRYPTO-ECDSA.json'));
    }
  }

  console.log(`Checking ${legacyCandidates.length} candidate paths...`);
  for (const p of legacyCandidates) {
    try {
      if (!fs.existsSync(p)) continue;
      console.log(`Found candidate at: ${p}`);
      const content = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(content);
      const credential = coinbaseCredentialFromObject(parsed, `legacy-file:${p}`);
      if (credential) return credential;
    } catch (e) {
      console.log(`Error parsing ${p}: ${e.message}`);
    }
  }
  return null;
}

console.log('=== Coinbase Credentials Diagnostic ===');
const credential = loadCoinbaseCredential();
if (credential) {
  console.log('✅ Coinbase credentials loaded successfully!');
  console.log('Key Name (kid):', credential.name);
  console.log('Private Key length:', credential.privateKey ? credential.privateKey.length + ' bytes' : '0');
  console.log('Source:', credential.source);
} else {
  console.log('❌ Coinbase credentials load failed.');
}
