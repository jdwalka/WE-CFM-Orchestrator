const https = require('https');

function test() {
  const url = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC&status=active&limit=100';
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
          console.log('Last market:', json.markets[json.markets.length - 1].ticker, json.markets[json.markets.length - 1].status, json.markets[json.markets.length - 1].close_time);
        }
      } catch (e) {
        console.error('Parse error:', e, data.substring(0, 100));
      }
    });
  }).on('error', (e) => {
    console.error(e);
  });
}

test();
