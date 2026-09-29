const https = require('https');
const payload = JSON.stringify({
  channel: 'real_time',
  formats: ['evm'],
  properties: ['price'],
  priceFeedIds: [1,2,6,10,14,15],
  parsed: true,
  jsonBinaryEncoding: 'hex',
});
const options = {
  hostname: 'pyth-lazer-proxy-1.dourolabs.app',
  path: '/v1/latest_price',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};
const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('STATUS:', res.statusCode);
    try {
      const j = JSON.parse(data);
      console.log('parsed feeds count:', j?.parsed?.priceFeeds?.length || 0);
      if (j?.parsed?.priceFeeds && j.parsed.priceFeeds.length > 0) {
        console.dir(j.parsed.priceFeeds[0]);
      } else {
        console.log('no feeds, body sample:', data.substring(0,500));
      }
    } catch(e) { console.log('parse err', e.message); console.log('raw sample:', data.substring(0,300)); }
  });
});
req.on('error', e => console.error('ERR', e.message));
req.write(payload);
req.end();
