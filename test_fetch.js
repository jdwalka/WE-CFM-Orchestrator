const https = require('https');
const agent = new https.Agent({ localAddress: '10.68.218.219', family: 4 });
https.get('https://fapi.binance.com/fapi/v1/allForceOrders?symbol=BTCUSDT&limit=5', { agent }, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data.slice(0, 200)));
});
