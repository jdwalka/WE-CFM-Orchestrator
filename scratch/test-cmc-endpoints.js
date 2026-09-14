const apiKey = process.env.COINMARKETCAP_API_KEY;
if (!apiKey) throw new Error("COINMARKETCAP_API_KEY is required");

async function testEndpoint(urlName, url) {
  console.log(`\nTesting ${urlName}:`);
  console.log(`  URL: ${url}`);
  try {
    const start = Date.now();
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-CMC_PRO_API_KEY': apiKey
      }
    });
    const elapsed = Date.now() - start;
    const text = await res.text();
    console.log(`  Response: HTTP ${res.status} (${res.statusText}) in ${elapsed}ms`);
    console.log(`  Body: ${text.substring(0, 300)}`);
  } catch (err) {
    console.error(`  Fetch error:`, err.message);
  }
}

async function run() {
  const symbols = 'BTC,ETH,SOL,XRP';
  
  // Test various Base URLs and Paths
  await testEndpoint(
    '1. Standard API v1 (Pro URL)', 
    `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${symbols}`
  );

  await testEndpoint(
    '2. Standard API v2 (Pro URL)', 
    `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${symbols}`
  );

  await testEndpoint(
    '3. Standard API v3 (Pro URL)', 
    `https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest?symbol=${symbols}`
  );

  await testEndpoint(
    '4. Trial API v3 (Trial URL)', 
    `https://pro-api.coinmarketcap.com/trial-pro-api/v3/cryptocurrency/quotes/latest?symbol=${symbols}`
  );

  await testEndpoint(
    '5. Sandbox API v1 (Sandbox URL)', 
    `https://sandbox-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${symbols}`
  );

  process.exit(0);
}

run();
