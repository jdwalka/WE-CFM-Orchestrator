const fetch = require('node-fetch'); // Oh wait I don't have node-fetch
const https = require('https');

function test() {
  // Let's try status=open again just in case it was a typo in my previous test
  const url = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC&status=open&limit=100';
  console.log('Fetching', url);
  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        console.log('Success:', json.markets ? json.markets.length : json);
        if (json.markets && json.markets.length > 0) {
          console.log('First market:', json.markets[0].ticker, json.markets[0].status, json.markets[0].close_time);
        }
      } catch (e) {
        console.error('Parse error:', e, data.substring(0, 100));
      }
    });
  });
}

test();
