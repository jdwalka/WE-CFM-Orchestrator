# Kalshi Standalone Worker — Quick Start

## Architecture

```
┌─────────────────────────────┐
│   Electron App              │
│   (WECRYPTO.exe)            │
│                             │
│  Uses KalshiWorkerClient    │
│  to query worker via HTTP   │
└──────────────┬──────────────┘
               │
        HTTP (port 3050)
               │
┌──────────────▼──────────────┐
│   Kalshi Worker Process     │
│   (Node.js, separate PID)   │
│                             │
│  ├─ REST Client             │
│  ├─ Credential Loading      │
│  ├─ HTTP Server             │
│  └─ Market Data Cache       │
└─────────────────────────────┘
         │
         └─→ Kalshi API
                (REST)
```

## Why Standalone?

✅ **Decoupled** — Worker runs independently  
✅ **No Electron Bloat** — Pure Node.js  
✅ **Reusable** — Can query from any app/script  
✅ **Debuggable** — Separate process, own logs  
✅ **Scalable** — Easy to run multiple workers  
✅ **Optional** — App works without it  

---

## Quick Start

### 1️⃣ Start the Worker

```bash
cd F:\WECRYP
node kalshi-worker.js
```

Or with custom settings:
```bash
node kalshi-worker.js --port 3050 --env production --file KALSHI-API-KEY.txt
```

Expected output:
```
╔════════════════════════════════════════════╗
║  Kalshi Standalone Worker                 ║
╚════════════════════════════════════════════╝

Environment: production
API Key: a8f1995c...

[Kalshi Worker] HTTP server listening on http://127.0.0.1:3050

Available endpoints:
  GET  /health
  GET  /status
  GET  /balance
  ...

Press Ctrl+C to stop
```

### 2️⃣ Query from Command Line

```bash
# Health check
curl http://127.0.0.1:3050/health

# Get balance
curl http://127.0.0.1:3050/balance

# List markets
curl http://127.0.0.1:3050/markets?limit=20

# List events
curl http://127.0.0.1:3050/events

# Get positions
curl http://127.0.0.1:3050/positions
```

### 3️⃣ Query from Electron App

Add to your app:

```javascript
// Load client
const client = new KalshiWorkerClient('http://127.0.0.1:3050');

// Check connection
const health = await client.healthCheck();
console.log('Worker healthy:', health.healthy);

// Get balance
const balance = await client.getBalance();
console.log('Balance:', balance.data.balance);

// Get markets
const markets = await client.getMarkets(50);
console.log(`Found ${markets.count} markets`);

// Get events with markets
const events = await client.getEvents('2024-ELECTION');
console.log(`Event markets:`, events.data.markets);

// Poll balance every 5 seconds
const stop = client.pollBalance(5000, (balance) => {
  console.log('Updated balance:', balance.data.balance);
});

// Stop polling when done
// stop();
```

---

## HTTP API Reference

### GET Endpoints

#### `/health` — Health Check
```bash
curl http://127.0.0.1:3050/health

# Response:
{
  "status": "ok",
  "connected": true,
  "uptime": 12345,
  "environment": "production"
}
```

#### `/status` — Full Worker Status
```bash
curl http://127.0.0.1:3050/status

# Response:
{
  "connected": true,
  "environment": "production",
  "balance": {...},
  "subscriptions": 0,
  "stats": {
    "requests": 42,
    "errors": 0,
    "messages": 0
  },
  "uptime": 12345,
  "errors": []
}
```

#### `/balance` — Account Balance
```bash
curl http://127.0.0.1:3050/balance

# Response:
{
  "success": true,
  "data": {
    "balance": "50000.00",
    "available": "45000.00"
  },
  "timestamp": 1714160000000
}
```

#### `/markets` — List Markets
```bash
curl "http://127.0.0.1:3050/markets?limit=50"

# Response:
{
  "success": true,
  "data": {
    "markets": [
      {
        "market_ticker": "INXUSD",
        "market_type": "binary",
        "last_price": "0.75",
        ...
      },
      ...
    ]
  },
  "count": 50,
  "timestamp": 1714160000000
}
```

#### `/events` — List Events
```bash
curl "http://127.0.0.1:3050/events"
curl "http://127.0.0.1:3050/events?ticker=2024-ELECTION"

# Response:
{
  "success": true,
  "data": {
    "events": [...],
    "markets": [...]
  },
  "count": 5,
  "timestamp": 1714160000000
}
```

#### `/positions` — Your Positions
```bash
curl http://127.0.0.1:3050/positions

# Response:
{
  "success": true,
  "data": {
    "positions": [...]
  },
  "count": 3,
  "timestamp": 1714160000000
}
```

#### `/orders` — Your Orders
```bash
curl http://127.0.0.1:3050/orders

# Response:
{
  "success": true,
  "data": {
    "orders": [...]
  },
  "count": 2,
  "timestamp": 1714160000000
}
```

### POST Endpoints

#### Place Order
```bash
curl -X POST http://127.0.0.1:3050/ \
  -H "Content-Type: application/json" \
  -d '{
    "command": "placeOrder",
    "params": {
      "market_ticker": "INXUSD",
      "side": "yes",
      "action": "buy",
      "quantity": 10,
      "yes_price": "75.00"
    }
  }'
```

#### Cancel Order
```bash
curl -X POST http://127.0.0.1:3050/ \
  -H "Content-Type: application/json" \
  -d '{
    "command": "cancelOrder",
    "params": {
      "orderId": "order-id-here"
    }
  }'
```

#### Cancel All Orders
```bash
curl -X POST http://127.0.0.1:3050/ \
  -H "Content-Type: application/json" \
  -d '{
    "command": "cancelAllOrders",
    "params": {
      "filters": {}
    }
  }'
```

---

## Client Library Methods

```javascript
const client = new KalshiWorkerClient('http://127.0.0.1:3050');

// Connection
await client.healthCheck()              // Is worker running?
await client.getStatus()                // Full status

// Portfolio
await client.getBalance()               // Account balance
await client.getPositions()             // Your positions
await client.getOrders()                // Your orders

// Orders
await client.placeOrder({...})          // Create order
await client.cancelOrder(orderId)       // Cancel order
await client.cancelAllOrders()          // Cancel all

// Market Data
await client.getMarkets(limit)          // List markets
await client.getEvents(ticker)          // List events
await client.getMarket(marketId)        // Single market
await client.getTrades(marketId)        // Recent trades

// Caching
client.clearCache()                     // Clear all cache
await client.getBalance(true)           // Force refresh

// Polling
const stop = client.pollBalance(5000, callback)
const stop2 = client.pollOrders(3000, callback)
// stop()   // Stop polling
```

---

## Running the Worker Automatically

### Option 1: Background Process (Windows)
```batch
REM Create a shortcut or batch file
start /MIN node kalshi-worker.js --port 3050 --env production
```

### Option 2: Node.js Process Manager (PM2)
```bash
npm install -g pm2
pm2 start kalshi-worker.js --name "kalshi" --port 3050
pm2 save
pm2 startup
```

### Option 3: System Service (Advanced)
Use NSSM (Non-Sucking Service Manager) or similar to run as Windows service.

---

## Testing

### From PowerShell
```powershell
# Start worker
Start-Process -WindowStyle Minimized node -ArgumentList "kalshi-worker.js"

# Wait for startup
Start-Sleep -Seconds 2

# Health check
$response = Invoke-WebRequest http://127.0.0.1:3050/health -UseBasicParsing
Write-Output $response.Content

# Get balance
$response = Invoke-WebRequest http://127.0.0.1:3050/balance -UseBasicParsing
Write-Output $response.Content
```

### From Browser Console (Electron App)
```javascript
// Load client
window.KalshiClient = new KalshiWorkerClient('http://127.0.0.1:3050');

// Test connection
await window.KalshiClient.healthCheck()

// Get balance
await window.KalshiClient.getBalance()

// Get markets
await window.KalshiClient.getMarkets(20)

// Get status
await window.KalshiClient.getStatus()
```

---

## Troubleshooting

### Worker won't start
```
Check KALSHI-API-KEY.txt exists in current directory
Check Node.js is installed: node --version
Check port 3050 is not in use
```

### 401 Unauthorized
```
Verify API key file format:
  Line 1: UUID (api-key-id)
  Lines 5+: RSA private key (-----BEGIN RSA PRIVATE KEY-----)
```

### Connection refused from client
```
Ensure worker is running: curl http://127.0.0.1:3050/health
Check firewall not blocking port 3050
Check URL in client: new KalshiWorkerClient('http://127.0.0.1:3050')
```

### High memory usage
```
Worker caches last 100 errors and some market data
Memory should stabilize around 50-100 MB
If higher, restart worker
```

---

## Production Deployment

1. **Start worker on boot**
   ```
   Use PM2, NSSM, or Windows Task Scheduler
   ```

2. **Monitor uptime**
   ```javascript
   setInterval(async () => {
     const health = await client.healthCheck();
     if (!health.healthy) {
       // Alert or restart
     }
   }, 60000);  // Check every minute
   ```

3. **Log rotation**
   ```
   Redirect stdout/stderr to file
   Rotate logs daily
   ```

4. **Graceful shutdown**
   ```
   SIGINT/SIGTERM handled
   Closes server cleanly
   ```

---

## Files

- `kalshi-worker.js` — Standalone server (run this)
- `kalshi-worker-client.js` — Client library (use in app)
- `kalshi-rest.js` — REST API client (used by worker)
- `kalshi-ws.js` — WebSocket module (available in worker, not used in this version)
- `KALSHI-API-KEY.txt` — Credentials file

---

**Status:** ✅ Ready to deploy

Start worker, query from app. Simple and clean.
