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

console.log('CWD:', process.cwd());
console.log('ENV path:', process.env.WECRYPTO_FIREBASE_SERVICE_ACCOUNT_PATH);

const credentialPath = process.env.WECRYPTO_FIREBASE_SERVICE_ACCOUNT_PATH;
if (credentialPath) {
  const resolved = path.resolve(credentialPath);
  console.log('Resolved Path:', resolved);
  console.log('Exists:', fs.existsSync(resolved));
  if (fs.existsSync(resolved)) {
    try {
      const content = fs.readFileSync(resolved, 'utf8');
      const parsed = JSON.parse(content);
      console.log('Parsed successfully!');
      console.log('Project ID in credentials:', parsed.project_id);
      console.log('Client Email in credentials:', parsed.client_email);
    } catch (err) {
      console.error('Failed to parse:', err.message);
    }
  }
}

const fb = require('../src/cloud/firebase-admin-firestore.js');
fb.startupCheck({ required: false, probe: false }).then(status => {
  console.log('fb.startupCheck (no probe) result:', JSON.stringify(status, null, 2));
}).catch(err => {
  console.error('fb.startupCheck failed:', err);
});
