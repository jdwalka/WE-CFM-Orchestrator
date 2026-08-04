# Endpoint and API Key Summary Table

| Endpoint / Service         | Type      | URL / gRPC Address                  | API Key Required | Env Variable / Config Key         |
|---------------------------|-----------|-------------------------------------|------------------|-----------------------------------|
| Kalshi REST               | HTTP      | <https://api.elections.kalshi.com>    | Yes              | KALSHI_API_KEY, KALSHI_API_SECRET |
| Kalshi gRPC               | gRPC      | kalshi.grpc.public:443              | No (public)      |                                   |
| Polymarket REST           | HTTP      | <https://gamma-api.polymarket.com>    | No               |                                   |
| Polymarket gRPC           | gRPC      | polymarket.grpc.public:443          | No               |                                   |
| Binance REST              | HTTP      | <https://api.binance.com>             | No               |                                   |
| Binance gRPC              | gRPC      | binance.grpc.public:443             | No               |                                   |
| Bybit REST                | HTTP      | <https://api.bybit.com>               | No               |                                   |
| Bybit gRPC                | gRPC      | bybit.grpc.public:443               | No               |                                   |
| Coinbase REST             | HTTP      | <https://api.exchange.coinbase.com>   | Optional         | COINBASE_API_KEY, COINBASE_API_SECRET |
| CoinGecko REST            | HTTP      | <https://api.coingecko.com/api/v3>    | No               |                                   |
| Pyth Lazer                | WebSocket | wss://pyth-lazer.dourolabs.app      | Optional         | PYTH_LAZER_TOKEN                  |
| Birdeye                   | HTTP      | <https://public-api.birdeye.so>       | Yes              | BIRDEYE_API_KEY                   |
| Whale Alert               | HTTP      | <https://api.whale-alert.io/v1>       | Optional         | WHALE_ALERT_KEY                   |
| Blockscout                | HTTP      | <https://eth.blockscout.com/api/v2>   | No               |                                   |
| Etherscan                 | HTTP      | <https://api.etherscan.io>            | No               |                                   |
| BSCScan                   | HTTP      | <https://api.bscscan.com>             | No               |                                   |
| CoinCap                   | HTTP      | <https://api.coincap.io/v2>           | No               |                                   |
| Alternative.me (F&G)      | HTTP      | <https://api.alternative.me/fng/>     | No               |                                   |
| xAI Grok (5m PTB analysis) | HTTP     | https://api.x.ai/v1                 | Yes (for 5m)     | XAI_API_KEY or GROK_API_KEY       |

---

- See `docs/CONFIGURATION.md` for full environment variable descriptions.
- See `GRPC_INTEGRATION_GUIDE.md` for gRPC setup and proto details.
- See `src/infra/proxy-orchestrator.js` for fallback chain logic and endpoint registration.
- See `src/feeds/exchange-fallback-handler.js` for per-exchange fallback and handler details.
