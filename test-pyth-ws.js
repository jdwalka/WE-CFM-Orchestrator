const WebSocket = require('ws');
require('dotenv').config({path: 'g:/WECRYP/.env'});

const token = process.env.PYTH_LAZER_TOKEN;
const ws = new WebSocket('wss://pyth-lazer-0.dourolabs.app/v1/stream', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

ws.on('open', () => {
  console.log('Connected!');
  ws.send(JSON.stringify({
    type: 'subscribe',
    subscriptionId: 1,
    priceFeedIds: [1],
    properties: ['price'],
    formats: [],
    channel: 'real_time',
    deliveryFormat: 'json',
    jsonBinaryEncoding: 'hex',
    parsed: true
  }));
});

ws.on('message', (data) => {
  console.log('Message:', data.toString());
});

ws.on('close', (code, reason) => {
  console.log('Closed:', code, reason.toString());
});

ws.on('error', (err) => {
  console.error('Error:', err);
});
