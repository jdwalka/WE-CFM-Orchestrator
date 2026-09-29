# Fallback Chain Documentation

## Core Fallback Chains (ProxyOrchestrator)

| Chain Name            | Fallback Order                        |
|-----------------------|---------------------------------------|
| kalshi-markets        | kalshi → polymarket → cache           |
| kalshi-markets-legacy | kalshi → polymarket → cache           |
| cmc-quotes            | cmc → pyth → cache                    |
| kalshi-settlement     | kalshi → polymarket → cache           |
| polymarket-markets    | polymarket → kalshi → cache           |

- See `src/infra/proxy-orchestrator.js` for implementation.

## Per-Exchange Fallbacks (exchange-fallback-handler.js)

| Asset   | Primary Source         | Fallback(s)                                 |
|---------|-----------------------|---------------------------------------------|
| BTC     | btcMempool            | btcBlockchain (deprecated)                  |
| ETH     | ethBlockscout         | ethEtherscan                                |
| SOL     | solRpc (mainnet-beta) | solRpc (ankr)                               |
| XRP     | xrpLedger (cluster)   | xrpLedger (s2.ripple.com)                   |
| BNB     | bnbAnkrRpc            | bnbBscscan → bnbBlockscout                  |
| DOGE    | dogeBlockcypher       | dogeChainSo → dogeBlockchair                |

- See `ERROR_FIXES_REPORT.md` for validation and test status.

## Transport priority (all providers)

Global order via `src/infra/endpoint-transport.js`:

1. **WSS** — live streams (Kalshi `KalshiWS`, Coinbase `CandleWS`, Pyth Lazer)
2. **gRPC** — Binance market data when `@grpc/grpc-js` is loaded in renderer
3. **RPC** — Kalshi worker HTTP (`127.0.0.1:3050`) + Electron IPC `kalshi:markets`
4. **HTTP** — `suppFetch` → `ipcFetch` → `ProxyOrchestrator` → direct `fetch`

Kalshi 15M contract lists use **RPC → HTTP**; live YES/NO odds overlay **WSS** on top of REST metadata.

## gRPC Fallbacks (optional client)

| Chain Name         | gRPC Endpoint(s)                | Fallback(s)         |
|--------------------|---------------------------------|---------------------|
| BINANCE_GRPC       | binance.grpc.public:443         | HTTP via proxy      |
| BYBIT_GRPC         | bybit.grpc.public:443           | (stub)              |

- See `exchange-fallback-handler.js` and `endpoint-transport.js`.

## Pyth Lazer Fallback Chain

- Strict 1000ms timeout: pyth-lazer → crypto.com → binance → coingecko → kraken
- See `PYTH_1000MS_TIMEOUT_FALLBACK.md` for details and test instructions.

## Documentation References

- `PROXY-ORCHESTRATOR-QUICKSTART.md`
- `PROXY-ORCHESTRATOR-FINAL-SUMMARY.txt`
- `PYTH_1000MS_TIMEOUT_FALLBACK.md`
- `ERROR_FIXES_REPORT.md`
- `src/infra/proxy-orchestrator.js`
- `src/feeds/exchange-fallback-handler.js`
