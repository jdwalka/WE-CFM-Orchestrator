const WebSocket = require('ws');
require('dotenv').config({path: 'g:/WECRYP/.env'});

const token = process.env.PYTH_LAZER_TOKEN;
const ws = new WebSocket('wss://pyth-lazer-0.dourolabs.app/v1/stream', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'subscribe',
    subscriptionId: 1,
    priceFeedIds: [1, 2, 6, 10, 13, 14, 15, 110],
    properties: ['price', 'bestBidPrice', 'bestAskPrice', 'confidence', 'exponent', 'publisherCount', 'feedUpdateTimestamp', 'marketSession', 'fundingRate', 'fundingTimestamp', 'fundingRateInterval'],
    formats: ['solana', 'leUnsigned', 'leEcdsa', 'evm'],
    channel: 'fixed_rate@1000ms',
    deliveryFormat: 'json',
    jsonBinaryEncoding: 'hex',
    parsed: true,
    ignoreInvalidFeeds: true
  }));
});

ws.on('message', (data) => {
  console.log('Msg:', data.toString());
});
