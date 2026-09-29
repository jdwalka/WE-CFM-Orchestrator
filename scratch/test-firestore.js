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

const firebaseAdmin = require('firebase-admin');
const { initializeFirestore } = require('firebase-admin/firestore');

async function testConnection(preferRest) {
  console.log(`\n--- Testing Firestore connection with preferRest = ${preferRest} ---`);
  
  // Clean up existing app if initialized
  if (firebaseAdmin.apps.length > 0) {
    await Promise.all(firebaseAdmin.apps.map(app => app.delete()));
  }

  const credentialPath = process.env.WECRYPTO_FIREBASE_SERVICE_ACCOUNT_PATH || '.\\secrets\\wecrypto-firebase-service-account.json';
  const resolvedPath = path.resolve(rootDir, credentialPath);
  
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Service account file not found at ${resolvedPath}`);
    return false;
  }

  const credentials = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  const projectId = credentials.project_id || process.env.WECRYPTO_FIREBASE_PROJECT_ID || 'wecrypto';
  const databaseId = process.env.WECRYPTO_FIREBASE_DATABASE_ID || '(default)';

  console.log(`Project: ${projectId}, Database: ${databaseId}`);

  const app = firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(credentials),
    projectId
  });

  const firestoreSettings = {
    preferRest,
    ignoreUndefinedProperties: true
  };

  const db = databaseId && databaseId !== '(default)'
    ? initializeFirestore(app, firestoreSettings, databaseId)
    : initializeFirestore(app, firestoreSettings);

  console.log('Attempting write to _health/startup...');
  const start = Date.now();
  
  try {
    // We set a short timeout using a promise wrapper to see if it responds quickly
    const writePromise = db.collection('_health').doc('startup_test').set({
      ts: Date.now(),
      preferRest,
      source: 'test-script'
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Local timeout after 8000ms')), 8000)
    );

    await Promise.race([writePromise, timeoutPromise]);
    console.log(`SUCCESS! Write succeeded in ${Date.now() - start}ms`);
    return true;
  } catch (err) {
    console.error(`FAILED in ${Date.now() - start}ms:`, err.message);
    if (err.stack) {
      console.log('Error Stack:', err.stack.split('\n').slice(0, 5).join('\n'));
    }
    return false;
  }
}

async function run() {
  try {
    const grpcResult = await testConnection(false);
    const restResult = await testConnection(true);
    console.log('\n--- RESULTS ---');
    console.log('gRPC Success:', grpcResult);
    console.log('REST Success:', restResult);
    process.exit(0);
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exit(1);
  }
}

run();
