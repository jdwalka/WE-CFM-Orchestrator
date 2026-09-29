const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// Load environment and service account
const rootDir = path.join(__dirname, '..');
const credentialPath = '.\\secrets\\wecrypto-firebase-service-account.json';
const resolvedPath = path.resolve(rootDir, credentialPath);

if (!fs.existsSync(resolvedPath)) {
  console.error(`Service account not found at ${resolvedPath}`);
  process.exit(1);
}

const credentials = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));

// Helper to create Google JWT for OAuth2 token
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const jwtHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    
    const now = Math.floor(Date.now() / 1000);
    const jwtClaim = Buffer.from(JSON.stringify({
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    })).toString('base64url');

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${jwtHeader}.${jwtClaim}`);
    const signature = sign.sign(credentials.private_key, 'base64url');
    const assertion = `${jwtHeader}.${jwtClaim}.${signature}`;

    const postData = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`;

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            resolve(json.access_token);
          } else {
            reject(new Error(`OAuth failed: ${JSON.stringify(json)}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function testRestWrite(token) {
  const projectId = credentials.project_id;
  const databaseId = 'ai-studio-wecryptidebridge-e08bc26e-a164-49df-b69e-24536e2e818e';
  
  // Endpoint to create document:
  // POST https://firestore.googleapis.com/v1/projects/{project}/databases/{database}/documents/{collection}
  const path = `/v1/projects/${projectId}/databases/${databaseId}/documents/_health?documentId=startup_rest_test`;
  
  const payload = JSON.stringify({
    fields: {
      ts: { integerValue: String(Date.now()) },
      source: { stringValue: 'rest-api-test' }
    }
  });

  return new Promise((resolve) => {
    console.log('Sending write request to Firestore REST API...');
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      console.log(`Response Code: ${res.statusCode} (${res.statusMessage})`);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Response Body:', data);
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
    });

    req.on('error', (e) => {
      console.error('REST request failed:', e.message);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

async function run() {
  try {
    console.log('Generating Google access token...');
    const token = await getAccessToken();
    console.log('Token successfully generated!');
    const success = await testRestWrite(token);
    console.log('Test completed. Success:', success);
    process.exit(success ? 0 : 1);
  } catch (err) {
    console.error('Fatal REST test error:', err.message);
    process.exit(1);
  }
}

run();
