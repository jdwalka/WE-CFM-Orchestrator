const fs = require('fs');
const path = require('path');

function analyzeHar() {
  const harPath = 'G:\\WECRYPTO\\COPILOT_DEBUG\\anti.har';
  console.log(`Reading ${harPath}...`);
  
  if (!fs.existsSync(harPath)) {
    console.error('HAR file not found');
    return;
  }

  const content = fs.readFileSync(harPath, 'utf8');
  console.log('Parsing JSON...');
  const har = JSON.parse(content);
  
  const entries = har.log?.entries || [];
  console.log(`Found ${entries.length} total entries.`);

  const failures = [];
  const kalshiRequests = [];
  const firestoreRequests = [];
  const otherFailures = [];

  for (const entry of entries) {
    const req = entry.request;
    const res = entry.response;
    const url = req?.url || '';
    const status = res?.status || 0;

    const isKalshi = url.includes('kalshi');
    const isFirestore = url.includes('firestore') || url.includes('firebase');

    if (isKalshi) {
      kalshiRequests.push({
        method: req.method,
        url,
        status,
        time: entry.time,
        error: res._error || null,
        response: res.content?.text?.substring(0, 300)
      });
    }

    if (isFirestore) {
      firestoreRequests.push({
        method: req.method,
        url,
        status,
        time: entry.time,
        error: res._error || null,
        response: res.content?.text?.substring(0, 300)
      });
    }

    if (status >= 400 || status === 0 || res._error) {
      failures.push({
        method: req.method,
        url,
        status,
        time: entry.time,
        error: res._error || null,
        statusText: res.statusText,
        responseText: res.content?.text?.substring(0, 200)
      });
    }
  }

  console.log('\n--- NETWORK FAILURE SUMMARY (Status >= 400 or Error) ---');
  console.log(`Total Failures: ${failures.length}`);
  
  // Show first 15 failures
  failures.slice(0, 15).forEach((f, idx) => {
    console.log(`[Fail #${idx + 1}] ${f.method} ${f.url}`);
    console.log(`  Status: ${f.status} (${f.statusText || 'No Status Text'}) | Time: ${f.time?.toFixed(1)}ms`);
    if (f.error) console.log(`  Connection Error: ${f.error}`);
    if (f.responseText) console.log(`  Response: ${f.responseText}`);
    console.log('');
  });

  console.log('--- KALSHI REQUEST SUMMARY ---');
  console.log(`Total Kalshi requests: ${kalshiRequests.length}`);
  const kalshiFails = kalshiRequests.filter(r => r.status >= 400 || r.status === 0);
  console.log(`Failed Kalshi requests: ${kalshiFails.length}`);
  kalshiFails.slice(0, 5).forEach((r, idx) => {
    console.log(`[Kalshi Fail #${idx + 1}] ${r.method} ${r.url}`);
    console.log(`  Status: ${r.status} | Latency: ${r.time?.toFixed(1)}ms | Response: ${r.response}`);
  });

  console.log('\n--- FIRESTORE/FIREBASE REQUEST SUMMARY ---');
  console.log(`Total Firestore requests: ${firestoreRequests.length}`);
  const firestoreFails = firestoreRequests.filter(r => r.status >= 400 || r.status === 0);
  console.log(`Failed Firestore requests: ${firestoreFails.length}`);
  firestoreFails.slice(0, 5).forEach((r, idx) => {
    console.log(`[Firestore Fail #${idx + 1}] ${r.method} ${r.url}`);
    console.log(`  Status: ${r.status} | Latency: ${r.time?.toFixed(1)}ms | Response: ${r.response}`);
  });
}

analyzeHar();
