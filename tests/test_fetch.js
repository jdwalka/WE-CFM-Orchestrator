const http = require('http');

const req = http.get('http://127.0.0.1:3010/kalshi/trade-api/v2/markets?limit=1', (res) => {
  console.log('STATUS:', res.statusCode);
  console.log('HEADERS:', JSON.stringify(res.headers, null, 2));
  
  let data = '';
  res.on('data', chunk => {
    console.log(`Received ${chunk.length} bytes`);
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('END. Total length:', data.length);
  });
});

req.on('error', e => console.error('ERROR:', e.message));
req.end();
