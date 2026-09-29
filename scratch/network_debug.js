const https = require('https');

const EXCHANGES = {
  Binance: 'https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT',
  Coinbase: 'https://api.coinbase.com/api/v3/brokerage/products/BTC-USD/ticker?limit=10',
  Kraken: 'https://api.kraken.com/0/public/Trades?pair=XBTUSDT&count=10',
  Bybit: 'https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=BTCUSDT&limit=10',
  OKX: 'https://www.okx.com/api/v5/market/trades?instId=BTC-USDT&limit=10',
  Upbit: 'https://api.upbit.com/v1/trades/ticks?market=USDT-BTC&count=10',
  Bitget: 'https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT',
  BingX: 'https://open-api.bingx.com/openApi/spot/v1/ticker/trade?symbol=BTC-USDT&limit=10',
  Bitstamp: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
  Bitvavo: 'https://api.bitvavo.com/v2/ticker/24h?market=BTC-EUR'
};

function fetchHttps(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

async function testEndpoint(name, url, iterations = 5, delayMs = 500) {
  console.log(`\n--- Testing ${name} ---`);
  let successCount = 0;
  let failCount = 0;
  let latencies = [];

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    try {
      const res = await fetchHttps(url);
      const latency = Date.now() - start;
      if (res.status >= 200 && res.status < 300) {
        successCount++;
        latencies.push(latency);
        console.log(`[${i+1}/${iterations}] ${name} Success (Status: ${res.status}, Latency: ${latency}ms)`);
      } else {
        failCount++;
        console.error(`[${i+1}/${iterations}] ${name} Failed: HTTP ${res.status}`);
      }
    } catch (e) {
      failCount++;
      console.error(`[${i+1}/${iterations}] ${name} Error: ${e.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  console.log(`=> ${name} Summary: ${successCount}/${iterations} succeeded. Avg Latency: ${avgLatency.toFixed(2)}ms`);
}

async function run() {
  console.log('Starting Network Debug & Rate Limit Tests...');
  const promises = [];
  for (const [name, url] of Object.entries(EXCHANGES)) {
    promises.push(testEndpoint(name, url, 5, 1000));
  }
  await Promise.all(promises);
  console.log('\nAll tests completed.');
}

run();
