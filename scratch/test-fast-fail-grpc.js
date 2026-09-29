const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment
const rootDir = path.join(__dirname, '..');
const credentialPath = '.\\secrets\\wecrypto-firebase-service-account.json';
const resolvedPath = path.resolve(rootDir, credentialPath);

if (!fs.existsSync(resolvedPath)) {
  console.error(`Service account not found at ${resolvedPath}`);
  process.exit(1);
}

const credentials = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
const firebaseAdmin = require('firebase-admin');
const { initializeFirestore } = require('firebase-admin/firestore');

async function testFastFailGrpc() {
  console.log('Initializing Firebase App in gRPC mode with fail-fast clientConfig...');
  const app = firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(credentials),
    projectId: credentials.project_id
  });

  const firestoreSettings = {
    preferRest: false, // Force gRPC mode so clientConfig is respected
    ignoreUndefinedProperties: true,
    clientConfig: {
      interfaces: {
        'google.firestore.v1.Firestore': {
          methods: {
            Write: { timeout_millis: 4000, retry_codes: [] },
            Commit: { timeout_millis: 4000, retry_codes: [] },
            CreateDocument: { timeout_millis: 4000, retry_codes: [] },
            UpdateDocument: { timeout_millis: 4000, retry_codes: [] },
            GetDocument: { timeout_millis: 4000, retry_codes: [] }
          }
        }
      }
    }
  };

  const databaseId = 'ai-studio-wecryptidebridge-e08bc26e-a164-49df-b69e-24536e2e818e';
  const db = initializeFirestore(app, firestoreSettings, databaseId);

  console.log('Attempting write to _health/startup_grpc_test...');
  const start = Date.now();
  try {
    await db.collection('_health').doc('startup_grpc_test').set({
      ts: Date.now(),
      mode: 'grpc-fast-fail'
    });
    console.log(`SUCCESS! Write succeeded in ${Date.now() - start}ms`);
  } catch (err) {
    console.log(`FAILED as expected in ${Date.now() - start}ms!`);
    console.log('Error Message:', err.message);
    console.log('Error Code/Status:', err.code, err.status);
  }
}

testFastFailGrpc().then(() => process.exit(0));
