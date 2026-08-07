# Deep Debug: Liquidity Map Not Rendering

## Status

✅ **Build Complete** — v2.15.5 with comprehensive debug instrumentation
- **Orderbook Module** (src/feeds/orderbook.js): Enhanced logging for WebSocket, data flow, snapshot accumulation
- **Depth Renderer** (src/core/app.js): Enhanced logging for canvas sizing, drawing, handler registration
- **Debug APIs** (window): New diagnostic exports for runtime inspection

---

## What Was Added

### 1. **Order Book Debug Logging** (src/feeds/orderbook.js)

**Console logs now show:**
- `[OB] Coinbase WS opened for BTC, subscribing to BTC-USD`
- `[OB] snapshot received for BTC: 100 bids, 100 asks`
- `[OB] processBook BTC: snapshot added (total=1), mid=42500.00, bids=100, asks=100`
- `[OB] _initBookState: initialized BTC`

**Debug API:** `window.OB.DEBUG.printStatus()`
```javascript
// In browser DevTools console:
window.OB.DEBUG.printStatus()
// Output:
// [OB.DEBUG] Connected symbols: ['BTC', 'ETH', 'XRP', 'SOL']
// [OB.DEBUG] Books: {BTC: {mid: 42500.50, bids: 15, asks: 15}, ...}
// [OB.DEBUG] Liquidity Snaps: {BTC: 5, ETH: 3, XRP: 2, ...}
// [OB.DEBUG] Wall Alerts: 12
// [OB.DEBUG] Listeners: {BTC: 1, ETH: 1, ...}
```

---

### 2. **Depth Renderer Debug Logging** (src/core/app.js)

**Console logs now show:**
- `[LIQ-DEBUG] drawLiqMap entry: sym=BTC`
- `[LIQ-DEBUG] canvas found: CANVAS`
- `[LIQ-DEBUG] canvas rect: w=640, h=400`
- `[LIQ-DEBUG] resolved canvas dimensions: W=640, H=400`
- `[LIQ-DEBUG] canvas.width/height set: w=640, h=400`
- `[LIQ-DEBUG] liquiditySnaps[BTC] found: true, length=5`
- `[LIQ-DEBUG] READY: snaps length=5, proceeding with heatmap render`

**For Handler Registration:**
- `[LIQ-DEBUG] startDepthLive called: sym=BTC`
- `[LIQ-DEBUG] window.OB available: true`
- `[LIQ-DEBUG] onBook: registering listener for BTC`
- `[LIQ-DEBUG] mapTimer: interval started (2000ms)`

---

### 3. **Debug APIs** (window.DepthDebug)

Access from browser DevTools console:

#### a. **View the debug log:**
```javascript
window.DepthDebug.getLiqMapLog()
// Returns array of all debug log entries (last 100)

window.DepthDebug.printLiqMapLog()
// Prints all entries to console for easy viewing

window.DepthDebug.clearLiqMapLog()
// Clears the log
```

#### b. **Inspect Order Book state:**
```javascript
window.DepthDebug.getOBState()
// Returns:
// {
//   module_exists: true,
//   connected: ['BTC', 'ETH', 'XRP', 'SOL'],
//   books: {
//     BTC: {bids: 15, asks: 15, mid: 42500.50, spread: 0.50},
//     ETH: {bids: 20, asks: 20, mid: 2250.25, spread: 0.05},
//     ...
//   },
//   liquiditySnaps: {BTC: 5, ETH: 3, XRP: 2, SOL: 1},
//   wallAlerts: 12,
//   wallEventLog: {BTC: 4, ETH: 2, ...}
// }
```

#### c. **Check canvas element and visibility:**
```javascript
window.DepthDebug.getCanvasState()
// Returns:
// {
//   canvas_exists: true,
//   tagName: 'CANVAS',
//   width: 640,                    // Rendered resolution
//   height: 400,
//   bounding_rect: {width: 640, height: 400, x: 100, y: 50},
//   offsetWidth: 640,
//   offsetHeight: 400,
//   parent: {tag: 'DIV', classes: 'depth-map-panel'},
//   visible: true,                 // w > 0 && h > 0
//   context_2d: true               // Can get 2D context
// }
```

#### d. **Manual diagnostics:**
```javascript
window.DepthDebug.getSelectedSymbol()
// Returns currently displayed symbol: 'BTC'

window.DepthDebug.forceRedraw()
// Manually trigger drawLiqMap on current symbol

window.DepthDebug.reconnectOB()
// Force reconnect all OB WebSockets
```

---

## Debug Workflow

### Step 1: Run the App
```bash
npm start
# or launch the built .exe directly
```

### Step 2: Navigate to Order Depth
1. Click on the **Order Depth** tab
2. Verify you see coin tabs (BTC, ETH, XRP, SOL)
3. Check if the order ladder is populating (bids/asks visible)
4. Check if the liquidity map canvas is **blank** or missing

### Step 3: Open DevTools
- Press **F12** to open browser DevTools
- Go to **Console** tab
- You should see diagnostic messages:
  ```
  [OB] API exported to window.OB
  [DepthDebug] API ready — ...
  ```

### Step 4: Collect Diagnostics

**Copy-paste these into DevTools Console one at a time:**

```javascript
// Check Order Book module
window.OB.DEBUG.printStatus()

// Check Canvas element
window.DepthDebug.getCanvasState()

// Check OB state
window.DepthDebug.getOBState()

// View all debug logs
window.DepthDebug.printLiqMapLog()

// Get full log array
JSON.stringify(window.DepthDebug.getLiqMapLog(), null, 2)
```

### Step 5: Interpret Results

#### **Scenario A: Canvas Not Visible**
```
Symptom: canvas_exists = false or visible = false

Cause: Canvas element missing or zero-sized
Fix:
  1. Check if depth-map-panel exists: document.querySelector('.depth-map-panel')
  2. Check CSS overflow/display: getComputedStyle(document.querySelector('.depth-map-panel'))
  3. Check parent layout: parent width/height should be > 0
```

#### **Scenario B: liquiditySnaps Empty**
```
Symptom: liquiditySnaps[BTC] = 0

Cause: Coinbase WebSocket not connected or not receiving updates
Fix:
  1. Check connected: window.DepthDebug.getOBState().connected
  2. Check books: window.DepthDebug.getOBState().books (should have bids/asks)
  3. Reconnect: window.DepthDebug.reconnectOB()
  4. Wait 5 seconds and check again
```

#### **Scenario C: Canvas Exists but Blank (Not Even "Collecting data...")**
```
Symptom: canvas_exists = true, visible = true, but draws nothing

Cause: drawLiqMap not being called or context is null
Fix:
  1. Check logs: window.DepthDebug.printLiqMapLog()
  2. Look for "drawLiqMap entry:" messages
  3. If no messages: handler not registered, try window.DepthDebug.forceRedraw()
  4. If "ERR: canvas.getContext('2d') returned null": browser issue
```

#### **Scenario D: "Collecting data..." Message Visible**
```
Symptom: Canvas shows "Collecting data…" text

Cause: liquiditySnaps has < 2 entries (normal on first visit)
Fix:
  1. Wait 5-10 seconds (snapshots taken every 2 seconds)
  2. Check: window.DepthDebug.getOBState().liquiditySnaps.BTC (should grow to 2+)
  3. Heatmap should render once ≥2 snapshots accumulated
```

---

## Console Commands Summary

**Real-time monitoring (copy these to run continuously):**

```javascript
// Monitor snapshot accumulation every second
setInterval(() => {
  const state = window.DepthDebug.getOBState();
  console.log('📊 Snaps:', state.liquiditySnaps, '| Books:', Object.keys(state.books).map(k => k + '=' + state.books[k].mid.toFixed(2)));
}, 1000);

// Monitor canvas visibility
setInterval(() => {
  const canvas = window.DepthDebug.getCanvasState();
  console.log('🎨 Canvas visible:', canvas.visible, 'size:', canvas.width + 'x' + canvas.height);
}, 2000);

// Monitor connected sockets
setInterval(() => {
  const connected = window.OB.getConnected();
  console.log('🔌 Connected:', connected);
}, 3000);
```

---

## Expected Behavior (Working State)

1. **Order Book Module Logs:**
   ```
   [OB] Coinbase WS opened for BTC, subscribing to BTC-USD
   [OB] snapshot received for BTC: 100 bids, 100 asks
   [OB] processBook BTC: snapshot added (total=1), mid=42500.00, ...
   [OB] processBook BTC: snapshot added (total=2), mid=42500.15, ...
   ```

2. **Depth Renderer Logs:**
   ```
   [LIQ-DEBUG] drawLiqMap entry: sym=BTC
   [LIQ-DEBUG] canvas found: CANVAS
   [LIQ-DEBUG] liquiditySnaps[BTC] found: true, length=5
   [LIQ-DEBUG] READY: snaps length=5, proceeding with heatmap render
   ```

3. **UI Behavior:**
   - Canvas shows "Collecting data…" briefly (< 5 seconds)
   - Heatmap appears (grid of blue/red/purple cells)
   - Price axis labels visible on left (±1.5% around mid price)
   - Time axis at bottom ("now", "-5m")
   - Wall event markers (green/red diamonds) appear as alerts fire

4. **Debug API Results:**
   - `getOBState().connected` includes ['BTC', 'ETH', 'XRP', 'SOL']
   - `getOBState().liquiditySnaps` has BTC/ETH/XRP/SOL with counts > 2
   - `getCanvasState().visible` = true
   - `getCanvasState().context_2d` = true

---

## Next Steps (After Diagnostics)

Once you've collected the debug info:

1. **Run the diagnostics above** in DevTools console
2. **Copy the full output** (especially printLiqMapLog() results)
3. **Note the exact failure point** (missing canvas? no snapshots? canvas blank?)
4. **Share results** so we can identify and fix the specific blockage

---

## File Changes

- `src/feeds/orderbook.js`: +35 lines of debug logging
- `src/core/app.js`: +80 lines (debug instrumentation + DepthDebug export)
- Both files: **Syntax verified** (node -c passed)
- **Build**: ✅ Complete, signed, ready to run

---

## Build Artifacts

Latest executable: **WE-CRYPTO-Kalshi-15m-v2.15.5-win32.exe** (90 MB)
- Path: `dist/WE-CRYPTO-Kalshi-15m-v2.15.5-win32.exe`
- Includes all debug instrumentation

