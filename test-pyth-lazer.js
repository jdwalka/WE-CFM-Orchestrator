const WebSocket = require('ws');
const dotenv = require('dotenv');

// Load environment variables from .env
dotenv.config({ path: 'g:/WECRYP/.env' });

// Read your API key from the environment (never hard-code it)
const TOKEN = process.env.PYTH_LAZER_TOKEN || process.env.LAZER_TOKEN;
if (!TOKEN) {
  console.error("Please set PYTH_LAZER_TOKEN or LAZER_TOKEN in your environment or .env file.");
  process.exit(1);
}

const ENDPOINTS = [
  "wss://pyth-lazer-0.dourolabs.app/v1/stream",
  "wss://pyth-lazer-1.dourolabs.app/v1/stream",
  "wss://pyth-lazer-2.dourolabs.app/v1/stream",
];

async function subscribeToPrices() {
  // Subscription request
  const subscribeRequest = {
    type: "subscribe",
    subscriptionId: 1,
    priceFeedIds: [1, 2, 6, 13, 15, 14],
    properties: ["price", "bestBidPrice", "bestAskPrice", "confidence", "fundingRate", "fundingRateInterval", "marketSession", "feedUpdateTimestamp", "fundingTimestamp", "publisherCount", "exponent"],
    formats: ["solana"],
    channel: "fixed_rate@200ms",
    deliveryFormat: "json",
    jsonBinaryEncoding: "hex",
    parsed: true,
    // ignoreInvalidFeeds: true, // Ignore invalid feed IDs instead of failing
  };

  // Connect to the first endpoint (for production, connect to all for redundancy)
  const uri = ENDPOINTS[0];
  console.log(`Connecting to ${uri}...`);

  const ws = new WebSocket(uri, {
    headers: {
      Authorization: `Bearer ${TOKEN}`
    }
  });

  ws.on('open', () => {
    console.log('Connected! Sending subscription...');
    ws.send(JSON.stringify(subscribeRequest));
    console.log('Subscribed to price feeds. Waiting for updates...');
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(message);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Connection closed');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    ws.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    ws.close();
    process.exit(0);
  });
}

function handleMessage(data) {
  const msgType = data.type;

  if (msgType === "streamUpdated") {
    const subscriptionId = data.subscriptionId;
    const parsed = data.parsed || {};
    const timestamp = parsed.timestampUs || "N/A";
    const priceFeeds = parsed.priceFeeds || [];

    console.log(`\n--- Price Update (Subscription ${subscriptionId}) ---`);
    console.log(`Timestamp: ${timestamp}`);

    for (const feed of priceFeeds) {
      const feedId = feed.priceFeedId;
      const price = feed.price !== undefined ? feed.price : "N/A";
      const exponent = feed.exponent || 0;
      const feedUpdateTs = feed.feedUpdateTimestamp !== undefined ? feed.feedUpdateTimestamp : "N/A";

      // Calculate actual price if both values are present
      if (price !== "N/A" && exponent) {
        const actualPrice = Number(price) * Math.pow(10, exponent);
        console.log(`  Feed ${feedId}: ${actualPrice.toFixed(8)} (feedUpdateTimestamp=${feedUpdateTs})`);
      } else {
        console.log(`  Feed ${feedId}: ${price} (feedUpdateTimestamp=${feedUpdateTs})`);
      }
    }
  } else if (msgType === "subscribed") {
    console.log(`Successfully subscribed:`, data);
  } else if (msgType === "error") {
    console.log(`Error:`, data.message || "Unknown error");
  } else {
    console.log(`Received:`, data);
  }
}

// Start client
subscribeToPrices();
