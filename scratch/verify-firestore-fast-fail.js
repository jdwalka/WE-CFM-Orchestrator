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

const fb = require('../src/cloud/firebase-admin-firestore.js');

async function testFastFail() {
  console.log('--- Starting Firestore Fast-Fail Test ---');
  const start = Date.now();
  try {
    const res = await fb.startupCheck({ required: false, probe: true });
    const elapsed = Date.now() - start;
    console.log(`\nTest Finished in ${elapsed}ms`);
    console.log('Result:', JSON.stringify(res, null, 2));
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`\nTest Failed with Error in ${elapsed}ms:`, err.message);
  }
}

testFastFail();
