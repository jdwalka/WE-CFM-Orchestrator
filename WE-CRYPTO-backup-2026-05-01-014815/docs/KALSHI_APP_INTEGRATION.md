# Kalshi Integration in app.js

## Quick Start

Add this code to `app.js` after DOM loads:

```javascript
// Load credentials and initialize Kalshi client
async function initializeKalshi() {
  try {
    // Load credentials from main process
    const creds = await window.desktopApp.loadKalshiCredentials();
    if (!creds.success) {
      console.error('[Kalshi] Failed to load credentials:', creds.error);
      return;
    }

    // Initialize unified client (REST + WebSocket)
    window.KalshiClient = new window.KalshiClient(
      creds.apiKeyId,
      creds.privateKeyPem,
      'production'  // or 'demo' for testing
    );

    // Connect
    const connected = await window.KalshiClient.connect();
    if (!connected) {
      console.error('[Kalshi] Failed to connect');
      return;
    }

    console.log('[Kalshi] Connected and ready');

    // Subscribe to market data
    window.KalshiClient.subscribe('ticker', ['INXUSD', 'FED-23DEC-T3.00']);
    window.KalshiClient.subscribe('trade');
    window.KalshiClient.subscribe('orderbook_delta', ['INXUSD']);

    // Get initial balance
    const balance = await window.KalshiClient.getBalance();
    console.log('Balance:', balance);

    return true;
  } catch (error) {
    console.error('[Kalshi] Initialization failed:', error.message);
    return false;
  }
}

// Call during app startup
initializeKalshi();
```

## Event Listeners

Listen to real-time market data:

```javascript
// Ticker updates (price, volume, open interest)
window.addEventListener('kalshi:ticker', (e) => {
  const ticker = e.detail;
  console.log(`${ticker.market_ticker}: $${ticker.last_price} (vol: ${ticker.last_price_24h_volume})`);
  // Update predictions engine with market odds
  updatePredictionScore(ticker.market_ticker, ticker.last_price);
});

// Trade updates
window.addEventListener('kalshi:trade', (e) => {
  const trade = e.detail;
  console.log(`Trade: ${trade.market_ticker} @ $${trade.yes_price}, size: ${trade.quantity}`);
  // Track volume spikes
  recordTradeVolume(trade.market_ticker, trade.quantity);
});

// Orderbook updates
window.addEventListener('kalshi:orderbook', (e) => {
  const orderbook = e.detail;
  console.log(`Orderbook: ${orderbook.market_ticker}`, {
    bestBid: orderbook.bids?.[0],
    bestAsk: orderbook.asks?.[0],
    bidDepth: orderbook.bids?.length,
    askDepth: orderbook.asks?.length
  });
});

// Balance changes (REST polling)
window.addEventListener('kalshi:balance', (e) => {
  const balance = e.detail.balance;
  console.log(`Balance: $${balance.balance} (available: $${balance.available})`);
  updatePortfolioUI(balance);
});

// Connection events
window.addEventListener('kalshi:connected', (e) => {
  console.log('[Kalshi] Connected', e.detail);
  // Update UI to show connection status
  setConnectionStatus('Connected to Kalshi');
});

// Errors
window.addEventListener('kalshi:error', (e) => {
  const error = e.detail;
  console.error(`[Kalshi Error] ${error.type}:`, error.message);
  recordErrorMetric(error.type);
});
```

## REST API Methods (Portfolio Management)

```javascript
const client = window.KalshiClient;

// Get balance
const balance = await client.getBalance();
console.log(`Balance: $${balance.balance || 0} (available: $${balance.available || 0})`);

// Get positions
const positions = await client.getPositions();
positions.forEach(pos => {
  console.log(`${pos.market_ticker}: ${pos.resting_orders_count} resting orders`);
});

// Get orders
const orders = await client.getOrders();
orders.forEach(order => {
  console.log(`Order ${order.order_id}: ${order.side} ${order.quantity} @ $${order.yes_price}`);
});

// Get market data
const markets = await client.rest.getMarkets({ limit: 50 });
console.log(`Found ${markets.count} markets`);

// Find event by ticker
const eventData = await client.rest.findEventByTicker('2024-ELECTION');
console.log(`Event: ${eventData.event.event_ticker}`, eventData.markets);

// Get candlesticks
const candles = await client.rest.getMarketCandlesticks('1h', 'INXUSD');
candles.data.candlesticks.forEach(c => {
  console.log(`${c.timestamp}: open $${c.open}, close $${c.close}`);
});
```

## WebSocket Subscriptions

```javascript
// Subscribe to ticker for multiple markets
const sid1 = window.KalshiClient.subscribe('ticker', [
  'INXUSD',
  'FED-23DEC-T3.00',
  'NVDA-26DEC-520'
]);
console.log('Subscribed with sid:', sid1);

// Subscribe to all trades (no filter)
const sid2 = window.KalshiClient.subscribe('trade');

// Subscribe to orderbook delta for single market
const sid3 = window.KalshiClient.subscribe('orderbook_delta', ['INXUSD']);

// Unsubscribe
window.KalshiClient.unsubscribe(sid1);

// Get current subscriptions
const state = window.KalshiClient.getState();
console.log('Active subscriptions:', state.subscriptions);
```

## Integration with Predictions Engine

```javascript
// Use Kalshi odds as sentiment proxy (10% weight)
function updatePredictionScore(marketTicker, kalshiPrice) {
  // Extract probability from price (0-100 cents = 0-100% implied probability)
  const kalshiProbability = kalshiPrice;

  // Get current prediction score
  const prediction = getPredictionForTicker(marketTicker);
  if (!prediction) return;

  // Blend scores (90% original, 10% Kalshi)
  prediction.kalshiSignal = kalshiProbability;
  prediction.blendedScore = (prediction.score * 0.9) + (kalshiProbability * 0.1);

  console.log(`${marketTicker}: original=${prediction.score}, kalshi=${kalshiProbability}, blended=${prediction.blendedScore}`);
}

// Track volume patterns
function recordTradeVolume(marketTicker, quantity) {
  const event = new CustomEvent('prediction:volume', {
    detail: {
      market: marketTicker,
      quantity: parseInt(quantity),
      timestamp: Date.now()
    }
  });
  window.dispatchEvent(event);
}
```

## Error Handling

```javascript
// All REST methods return {success, data/error, code, timestamp}
const res = await client.rest.getBalance();
if (!res.success) {
  console.error(`Failed (${res.code}): ${res.error}`);
  if (res.code === 401) {
    // Authentication failed - reload credentials
    await initializeKalshi();
  }
}

// Common errors:
// 401: Unauthorized (bad signature)
// 404: Market/event not found
// 429: Rate limited
// 500+: Server error
```

## Health Monitoring

```javascript
// Get connection state
const state = window.KalshiClient.getState();
console.log(state);
// Output:
// {
//   isConnected: true,
//   environment: 'production',
//   balance: {...},
//   positions: 5,
//   subscriptions: 3,
//   latestTickers: 42,
//   recentTrades: 1250,
//   errors: 2,
//   eventCounts: {...},
//   restMetrics: {...}
// }

// Check if connection is healthy
if (!state.isConnected) {
  console.warn('Kalshi connection lost');
  await window.KalshiClient.reconnect();
}

// Monitor error rate
const errorRate = state.restMetrics.errorRate;
if (parseFloat(errorRate) > 10) {
  console.warn(`High error rate: ${errorRate}`);
}
```

## Testing in Browser Console

```javascript
// Connect
await window.KalshiClient.connect()

// Get state
window.KalshiClient.getState()

// Subscribe to ticker
const sid = window.KalshiClient.subscribe('ticker', ['INXUSD'])

// Get latest ticker
window.KalshiClient.getTicker('INXUSD')

// Get balance
await window.KalshiClient.getBalance()

// Manually trigger event
window.dispatchEvent(new CustomEvent('kalshi:balance', {
  detail: { balance: { balance: '10000.00', available: '9500.00' } }
}))

// Disconnect
await window.KalshiClient.disconnect()
```

## Performance Tips

1. **Batch subscriptions**: Subscribe to multiple markets in one call instead of multiple calls
2. **Debounce renders**: Update UI every 100ms instead of on every message
3. **Memory limits**: Keep last 1000 trades, not all historical trades
4. **Backpressure**: If processing slower than arrival, acknowledge but don't block
5. **Monitor WebSocket lag**: Check timestamp delta between message receive and processing

## Deployment Checklist

- [ ] Load credentials from KALSHI-API-KEY.txt
- [ ] Test connection in dev mode
- [ ] Verify all 3 modules load: kalshi-ws.js, kalshi-rest.js, kalshi-client.js
- [ ] Monitor for 30 minutes live data
- [ ] Check for 401 errors (signature issues)
- [ ] Verify balance polling works
- [ ] Test order placement (if not read-only)
- [ ] Build portable .exe: `npm run build:portable`
- [ ] Test startup sequence
- [ ] Merge to main
