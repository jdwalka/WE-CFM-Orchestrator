const https = require('https');
https.get('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=1', (res) => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => console.log('Response:', data));
}).on('error', e => console.error(e));
