require('dotenv').config({ path: '.env' });
require('dotenv').config({ path: '.env.local' });

const firebaseFirestore = require('./src/cloud/firebase-admin-firestore.js');
const googleCloudBridge = require('./src/cloud/google-cloud-bridge.js');

async function testWiring() {
  console.log('--- Testing Firebase ---');
  try {
    const fbStatus = firebaseFirestore.getStatus();
    console.log('Firebase Status before init:', fbStatus);
    
    const startup = await firebaseFirestore.startupCheck({ required: true, probe: true });
    console.log('Firebase Startup Check:', startup);
  } catch (error) {
    console.error('Firebase Error:', error);
  }

  console.log('\n--- Testing TiDE ---');
  try {
    const tideStatus = googleCloudBridge.getStatus();
    console.log('TiDE Status:', tideStatus);
    
    const tideResult = await googleCloudBridge.predictTide({
      series: { m15: [{ close: 100 }, { close: 105 }] },
      currentPrice: 105
    });
    console.log('TiDE Predict Result:', tideResult);
  } catch (error) {
    console.error('TiDE Error:', error);
  }
}

testWiring();
