# Kalshi Integration in app.js (Hybrid IPC Approach)

## Architecture

```
Electron Main Process (main.js)
  ├─ Starts kalshi-worker.js subprocess
  ├─ Bridges via IPC handlers
  └─ Exposes kalshi:* IPC channels

Electron Renderer Process (app.js)
  ├─ window.Kalshi API (via IPC)
  └─ No direct credentials, all proxied
```

## Usage in app.js

### Import
Worker auto-starts when app launches. Just use `window.Kalshi.*`

```javascript
// No import needed - available globally when index.html loads
```

### Get Balance
```javascript
async function displayBalance() {
  const res = await window.Kalshi.getBalance();
  if (res.success) {
    console.log(`Balance: $${res.data.balance}`);
    document.getElementById('balance').textContent = `$${res.data.balance}`;
  } else {
    console.error('Failed to get balance:', res.error);
  }
}

displayBalance();
```

### List Markets
```javascript
async function showMarkets() {
  const res = await window.Kalshi.getMarkets(50);
  if (res.success) {
    console.log(`${res.count} markets available`);
    res.data.markets.forEach(m => {
      console.log(`${m.market_ticker}: $${m.last_price}`);
    });
  }
}

showMarkets();
```

### Get Events
```javascript
async function findEvent(ticker) {
  const res = await window.Kalshi.getEvents(ticker);
  if (res.success && res.data.events.length > 0) {
    const event = res.data.events[0];
    console.log(`Event: ${event.event_ticker}`);
    console.log(`Markets: ${res.data.markets.length}`);
    return event;
  }
}

await findEvent('2024-ELECTION');
```

### Place Order
```javascript
async function placeOrder(marketTicker, side, quantity, price) {
  const res = await window.Kalshi.placeOrder({
    market_ticker: marketTicker,
    side,  // 'yes' or 'no'
    action: 'buy',
    quantity,
    yes_price: price
  });

  if (res.success) {
    console.log(`Order placed: ${res.data.order_id}`);
  } else {
    console.error(`Order failed: ${res.error}`);
  }
}

// Usage:
await placeOrder('INXUSD', 'yes', 10, '75.00');
```

### Get Your Orders
```javascript
async function showOrders() {
  const res = await window.Kalshi.getOrders();
  if (res.success) {
    console.log(`You have ${res.count} orders`);
    res.data.orders.forEach(o => {
      console.log(`${o.market_ticker}: ${o.side} ${o.quantity} @ $${o.yes_price}`);
    });
  }
}

showOrders();
```

### Poll Balance Updates
```javascript
// Update balance every 5 seconds
setInterval(async () => {
  const res = await window.Kalshi.getBalance();
  if (res.success) {
    document.getElementById('balance').textContent = `$${res.data.balance}`;
  }
}, 5000);
```

### Check Worker Health
```javascript
async function checkKalshi() {
  const res = await window.Kalshi.health();
  if (res.success && res.data.status === 'ok') {
    console.log('✅ Kalshi worker is running');
    return true;
  } else {
    console.warn('⚠️ Kalshi worker is not available');
    return false;
  }
}

const ok = await checkKalshi();
```

### Get Full Status
```javascript
async function getKalshiStatus() {
  const res = await window.Kalshi.status();
  console.log(res.data);
  // Returns:
  // {
  //   connected: true,
  //   environment: 'production',
  //   balance: {...},
  //   subscriptions: 0,
  //   stats: {requests: 42, errors: 0, messages: 0},
  //   uptime: 123456,
  //   errors: [...]
  // }
}

await getKalshiStatus();
```

## Integration with Existing Code

### Use in predictions.js
```javascript
// Add Kalshi odds as sentiment signal
async function blendKalshiSignal(marketTicker, currentScore) {
  try {
    const markets = await window.Kalshi.getMarkets(100);
    const market = markets.data.markets.find(m => m.market_ticker === marketTicker);
    
    if (market) {
      const kalshiOdds = market.last_price;  // 0-100 (probability)
      
      // Blend: 90% original score + 10% Kalshi odds
      const blendedScore = (currentScore * 0.9) + (kalshiOdds * 0.1);
      
      console.log(`${marketTicker}: original=${currentScore}, kalshi=${kalshiOdds}, blended=${blendedScore}`);
      return blendedScore;
    }
  } catch (error) {
    console.error('Kalshi blend failed:', error);
  }
  
  return currentScore;
}
```

### Use in cfm-engine.js
```javascript
// Get Kalshi market odds for filtering
async function getKalshiFilters() {
  try {
    const res = await window.Kalshi.getMarkets(1000);
    if (res.success) {
      return res.data.markets.reduce((acc, m) => {
        acc[m.market_ticker] = {
          lastPrice: m.last_price,
          volume: m.last_price_24h_volume
        };
        return acc;
      }, {});
    }
  } catch (error) {
    console.error('Failed to load Kalshi filters:', error);
  }
  
  return {};
}
```

## Error Handling

```javascript
async function withErrorHandling(fn) {
  try {
    const res = await fn();
    
    if (!res.success) {
      console.error(`Kalshi error: ${res.error}`);
      
      // Handle specific errors
      if (res.status === 401) {
        console.error('Authentication failed - check credentials');
      } else if (res.status === 404) {
        console.error('Market or event not found');
      } else if (res.status === 429) {
        console.error('Rate limited - slow down requests');
      }
      
      return null;
    }
    
    return res;
  } catch (error) {
    console.error('Kalshi request failed:', error.message);
    return null;
  }
}

// Usage:
const balance = await withErrorHandling(() => window.Kalshi.getBalance());
```

## Available Methods

```javascript
// Connection
window.Kalshi.health()                                    // Is worker alive?
window.Kalshi.status()                                    // Full status

// Portfolio
window.Kalshi.getBalance()                                // Account balance
window.Kalshi.getPositions()                              // Open positions
window.Kalshi.getOrders()                                 // Order history

// Market Data
window.Kalshi.getMarkets(limit = 50)                      // List markets
window.Kalshi.getEvents(ticker = null)                    // List events

// Orders
window.Kalshi.placeOrder({...})                           // Create order
window.Kalshi.cancelOrder(orderId)                        // Cancel order
window.Kalshi.cancelAllOrders(filters = {})               // Cancel all

// Market Details
window.Kalshi.getTrades(marketId, filters = {})           // Trade history
```

## Performance Tips

1. **Cache responses** — Don't call getMarkets every 100ms
2. **Batch requests** — Call once with large limit, filter in app
3. **Debounce updates** — Update UI max every 1 second
4. **Error recovery** — Retry with exponential backoff
5. **Monitor lag** — Check timestamp delta between request and response

## Debugging

### Browser Console
```javascript
// Check if Kalshi is available
window.Kalshi
// Should show object with methods

// Test connection
await window.Kalshi.health()
// Should return {success: true, data: {status: 'ok', connected: true}}

// Get status
await window.Kalshi.status()
// Should show full worker status

// Check DevTools Network tab
// All requests go to main process via IPC, then to worker HTTP
```

### Main Process
Worker logs appear in main process console.
```
[Kalshi Worker] HTTP server listening on http://127.0.0.1:3050
[Kalshi Worker] GET /health
[Kalshi Worker] GET /balance
```

## File Structure

```
main.js
  ├─ Imports kalshi-ipc-bridge.js
  ├─ startKalshiWorker() on app ready
  ├─ stopKalshiWorker() on quit
  └─ IPC handlers bridge to worker

index.html
  ├─ <script src="kalshi-renderer-bridge.js"></script>
  └─ Exposes window.Kalshi

app.js
  ├─ Uses window.Kalshi.*
  └─ No direct Kalshi imports needed

kalshi-worker.js
  ├─ Spawned as subprocess by main.js
  ├─ Loads kalshi-rest.js
  ├─ HTTP server on :3050
  └─ Handles API calls
```

## Status: Ready to Use

Start app with `npm start`, then use `window.Kalshi.*` in app.js.

All IPC bridging handled automatically.

No credentials exposed to renderer.

Simple, clean integration. 🚀
