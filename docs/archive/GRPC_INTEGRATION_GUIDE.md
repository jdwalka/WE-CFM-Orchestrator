# WE-CFM-Orchestrator gRPC Integration Guide

## Overview

This document describes how to replace the gRPC stub handler in the WE-CFM-Orchestrator app with a real gRPC client implementation using `@grpc/grpc-js` (Node.js/Electron) or a browser-compatible library. It also documents the required endpoints, keys, and integration steps.

---

## 1. gRPC Endpoints

### Example Endpoints (update as needed)

- **Kalshi Market Data**: `grpc-kalshi` — e.g., `kalshi.grpc.public:443` (replace with actual endpoint)
- **Binance Market Data**: `binance.grpc.public:443`
- **Bybit Market Data**: `bybit.grpc.public:443`

Endpoints are registered in `src/infra/proxy-orchestrator.js` via `registerSource(endpoint, handler, 'grpc')`.

---

## 2. Required Keys & Credentials

- **Public market data**: Most endpoints do not require authentication.
- **Private/trading endpoints**: If needed, obtain API keys from the provider and store securely (not in source code).
- **Electron**: Use secure storage for secrets.

---

## 3. Integration Steps

### A. Install Dependencies

```
npm install @grpc/grpc-js @grpc/proto-loader
```

### B. Obtain .proto Files

- Download the relevant `.proto` files for each gRPC service (e.g., Kalshi, Binance, Bybit).
- Place them in a new folder: `protos/`

### C. Implement Real gRPC Client

Replace the stub in `src/infra/proxy-orchestrator.js`:

```js
// 1. Load proto
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const packageDefinition = protoLoader.loadSync('protos/kalshi.proto', { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const kalshiProto = grpc.loadPackageDefinition(packageDefinition).kalshi;

// 2. Create client
const kalshiClient = new kalshiProto.MarketData('kalshi.grpc.public:443', grpc.credentials.createSsl());

// 3. Handler function
async function grpcKalshiHandler(context, endpoint) {
  return new Promise((resolve, reject) => {
    kalshiClient.GetMarketData({ ...context }, (err, response) => {
      if (err) return reject(err);
      resolve(response);
    });
  });
}

// 4. Register handler
window.grpcKalshiHandler = grpcKalshiHandler;
```

- Repeat for other exchanges as needed (update proto/service names).

### D. Register the Handler

In `ProxyOrchestrator` constructor:

```js
if (typeof window.grpcKalshiHandler === 'function') {
  this.fallback.registerSource('grpc-kalshi', window.grpcKalshiHandler, 'grpc');
}
```

---

## 4. Browser Compatibility

- `@grpc/grpc-js` is Node/Electron only. For browser, use a library like `grpc-web` or `@improbable-eng/grpc-web`.
- Adjust handler implementation for browser context.

---

## 5. Testing

- Use the app's fallback/health check logic to validate gRPC endpoint health.
- Run integration tests (see `test-integration.js`).

---

## 6. References

- [@grpc/grpc-js documentation](https://www.npmjs.com/package/@grpc/grpc-js)
- [@grpc/proto-loader documentation](https://www.npmjs.com/package/@grpc/proto-loader)
- [grpc-web](https://github.com/grpc/grpc-web)

---

## 7. Notes

- Update endpoint addresses and proto/service names as needed for your provider.
- Do not commit API keys or secrets to source control.
- For private endpoints, use secure storage and environment variables.
