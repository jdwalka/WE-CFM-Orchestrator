# WE-CRYPTO / WE-CFM-Orchestrator — Repository Architecture

> Living doc. Covers the whole repo start to finish: runtime, boot, transports,
> feeds, prediction markets, LLM/ASI1, Truffle agent, workers, data, secrets,
> tests, network ops, and known issues. Date: 2026-09-20. Branch: `dev`.

---

## 1. What this is

Electron desktop trading HUD (`file://` renderer + Node main) for crypto
prediction markets. Tracked coins: **BTC, ETH, SOL, XRP, DOGE, BNB, HYPE**.

- **Prediction venues:** Polymarket 5m/15m Up-Down + hourly ranges; Kalshi hourly
  ladder (via a Cloudflare worker); CME CF RTI composite from CEX order books.
- **Market data:** Coinbase / Kraken / Bitstamp / Gemini books, Hyperliquid +
  Binance websockets, on-chain via Alchemy / Helius / Etherscan / BSCScan /
  Blockchair / Solana RPC / XRPL / Pyth Hermes + Douro Lazer.
- **Inference:** ASI1-only (`api.asi1.ai`: `asi1-mini` fast, `asi1` standard,
  `asi1-ultra` deep). OpenAI / TokenMix / Anthropic paths are cut or stubbed.
- **Local agent:** Truffle (`mcp_agent.py`, uAgents, `127.0.0.1:8002`), full-live
  ASI1 inference with MCP tool-calling (LeakSnipe suite).

---

## 2. Runtime & boot

- **Renderer** is classic multi-`<script>` (no bundler): `public/index.html`
  loads ~100 scripts in dependency order — infra shims first
  (`proxy-fetch.js` → `tauri-bridge.js` → `throttled-fetch.js` →
  `endpoint-transport.js`), then feeds, prediction markets, LLM, UI.
  `src/core/app-core.js` + `src/core/app-init.js` wire everything and start
  poll loops.
- **Electron main** (`electron/main.js`) spawns the Rust proxy, writes its
  `config.toml` at spawn from `PROXY_EXCHANGE_BASES`, owns all IPC
  (`asi1:*`, `llm:*`, `truffle:query`, `data:*`, proxy port discovery).
  Renderer reaches main via `electron/preload.js`
  (`window.electron.invoke`, `window.dataStore.appendLine`, …).
- There is a parallel **Tauri** path (`tauri-bridge.js` sidecar discovery,
  `we-crypto-cfm-tauri/`); the proxy bridge works in both.
- **No build step for the renderer** — `src/` edits apply on app reload.
  `electron/main.js` and the Rust proxy need an app restart (proxy config is
  written at spawn; the release binary is `proxy/target/release/`).

---

## 3. Local proxy (`proxy/`, Rust/axum)

- One binary, binds lowest free port in **3000–3020** (`bind_cascade()`).
  It must never bind `:8080` — that port is a local nginx trap serving fake
  `200 OK` on `/health` while 404ing every real route.
- Routes: `/health`, `/port` (identity: proves *our* proxy on *this* port),
  `/grades`, `/test[/:exchange]`, `/cache`, generic `/proxy?url=`, and
  `/:exchange[/path]` slug routes from `proxy/config.toml` (`electron/main.js`
  overwrites that file at spawn — the file on disk is a template).
- Exchange map covers Binance (spot/US/data/F/D), Bybit, OKX, Kraken,
  Coinbase, Gemini, Bitstamp, Crypto.com, KuCoin, MEXC, Hyperliquid,
  Polymarket (gamma/clob/data/perps), Kalshi, Etherscan/BSCScan, Solana,
  XRPL/Ripple, mempool, Blockchair, alchemy-adjacent history, Upbit/Bitget/
  BingX/WhiteBIT/CoinW/LBank/Bitso/Bullish/WEEX, Deribit, Gate.
- Per-exchange grades (`proxy/src/grades.rs`): Origin spoofing, cache TTLs
  (500ms–5s), used for Cloudflare-evasion + rate-limit headroom.
- Response cache (`proxy/src/cache.rs`); request client uses Chrome TLS
  fingerprint + cookie store (`proxy/src/main.rs`, `proxy/src/proxy.rs`).

---

## 4. Renderer transport layers (`src/infra/`)

Discovery + routing, in load order:

1. **`proxy-fetch.js`** — patches `window.fetch`. Buckets: (A) CF-protected /
   geo hosts → always proxy; (B) rate-limited APIs → proxy for headroom;
   (C) open APIs → direct in Electron. Port cascade discovery over XHR with
   `/port` identity check; syncs live port via `proxy-mode-update` events.
   Per-host circuit breakers (`api-circuit-breaker.js`, trip 5 failures/60s):
   breaker-open fails fast (synthetic 503 or direct leg for non-CF hosts).
   Proxied 403/404 on non-CF hosts retries direct once (covers Bitstamp
   Incapsula + stale-proxy routes). Always-direct: localhost, ASI1/OpenAI/
   Anthropic/xAI/DeepSeek, timeapi, pyth, `bitstamp.net`.
2. **`tauri-bridge.js`** — `window.proxyFetch` + `window.suppFetch`. Silent
   XHR discovery, in-flight sweep guard, latches the **lowest**
   identity-verified port (a stale binary can linger high while a fresh one
   serves low). Proxy-process-down = 3s global bypass **only**; upstream
   502/503/504 and non-CF 403/404 = per-request direct retry, even on the
   last attempt (single-attempt health probes fail over). Dead origins get a
   60s direct-quiet window so retries don't double traffic.
3. **`throttled-fetch.js`** — concurrency slots + 65ms serial queue so poll
   loops don't burst the proxy.
4. **`resilient-fetch.js`** — multi-URL try/fallback chains.
5. **`endpoint-transport.js`** — priority **WSS → gRPC → RPC → HTTP**, with
   WSS staleness demotion/repromotion windows and per-host 429 cooldowns.
   The local proxy is the HTTP-leg transport only.
6. **`proxy-orchestrator.js`** — `window._proxyOrchestrator`: endpoint
   try-chains (`cmc → coingecko → coinbase → cache`), L1 cache with per-type
   TTLs, queued dispatch.
7. Supporting: `network-log.js` (fetch wrapper logging), `api-rate-limiter.js`,
   `exchange-fallback-handler.js`, `coinbase-jwt-utils.js`,
   `tor-routing-layer.js`, `signal-scheduler-agent.js`, `orbital-startup-orchestrator.js`.

---

## 5. Exchange / market feeds (`src/feeds/`, `src/core/feeds/`)

- **`orderbook.js`** (`window.OB`) — Hyperliquid WS primary (all 7 coins),
  Binance depth WS fallback. Live wall detection (qty ≥ max(min, avg×3.5),
  APPEARED/EATEN/PULLED alerts), top-20 weighted depth profiles, imbalance
  10/20 + velocity, liquidity bands, per-sym books + balance metrics +
  wall event log.
- **`rti-feed.js`** — CME CF RTI composite from Coinbase/Kraken/Bitstamp/
  Gemini books (throttled, outlier filtering, rolling buffer).
- **`wall-depth-snapshot.js`** (`window.WallDepthSnapshot`) — builds the full
  bid-wall + depth datapoint set per Truffle query; logged as JSONL to
  `logs/truffle-wall-stats.log`.
- Polling REST: `exchange-ws.js`, `candle-ws.js`, `polymarket-client.js`,
  `polymarket-perps-client.js` (`api.perpetuals.polymarket.com` + WS),
  `coinmarketcap-pro-feed.js` (Pro key; 3-strike kill switch → fallbacks),
  `coingecko` helpers, `pyth-browser-client.js` (Hermes REST → `window._pythPrices`).
- On-chain intel: `wallet-intel-config.js`, `portfolio-intel.js`,
  `dex-activity-monitor.js`, `dexscreener-profiles.js`, `cex-flow.js`,
  `holder-metrics.js`, `derivatives-feed.js`, `options-gamma-feed.js`,
  `coinmarketcap-pro-feed.js`. (Whale Alert feed dropped, opt-in only.)

---

## 6. On-chain router (`src/orbital/`)

- **`chain-router.js`** (`window.ChainRouter` / `BlockchainScan`) — per-coin
  route tables with handler fallback chains + per-handler backoff, 60s poll:
  BTC mempool.space/Blockstream/BlockCypher; ETH public RPCs → Alchemy →
  Etherscan → Blockscout; SOL public RPCs (+Helius if keyed); XRP
  xrplcluster/s1/s2/rpc.xrpl.org; BNB BSC RPCs → Alchemy → Ankr → BSCScan;
  DOGE Blockchair/BlockCypher; HYPE Hyperliquid L1. Alchemy key resolution:
  env → `secrets/ALCHEMY-API-KEY-gitgoin.txt` → legacy file → fallback.
- **`alchemy-ws.js`** — ETH head subscriptions over Alchemy WSS (primary push,
  HTTP fallback kept).
- Plus: `chain-router` companions (`quantum-state.js`, `orbital-engine*.js`,
  `signal-router-cfm.js`, `temporal-edge.js`, `shell-router.js`,
  `pyth-momentum-exit.js`, `orbital-signal-client.js`, …).

---

## 7. Prediction markets (`src/prediction-markets/`)

- **`prediction-markets.js`** — Polymarket 5m/15m flow: slug parsing, PTB
  locks (immutable contract openPrice wins; event-page authoritative),
  `crypto-price` fetch with 4s cache + in-flight dedupe + 60s 429-backoff,
  pending-lock blitz ticks, TWAP, CLOB fallbacks, calibration + settlement
  debug modules.
- **`hourly-ranges-panel.js`** — hourly range cards + real Kalshi ladder rows
  (single-PTB, bid-wall saturation colors); ladder fetch skips while the
  worker breaker is open; 2.5s/5s/10s adaptive poll.
- Supporting: `market-resolver.js`, `poly5m-resolution-tracker.js`,
  `historical-settlement-fetcher.js`, `scorecard-data-aggregator.js`,
  `gammaApi`, `kalshi` helpers, accuracy/settlement dashboards.

---

## 8. LLM / ASI1 (`src/llm/`, `src/infra/asi1-client.js`, `src/ml/`)

- **`asi1-client.js`** (Node) — single choke point for main-process ASI1:
  key resolution (env + `secrets/ASI1_MARGITHUB.txt`, role tags), tier→model
  mapping, 2-model candidate chains, 401/402 key blacklisting, 429
  per-account skip, Cloudflare AI Gateway option, TCP route-mode probe
  (native vs fallback lane), `healthCheck`, diagnostics.
- **`asi1-credit-orchestrator.js`** — desk modes (`asi1_only` default,
  `planner`), model roster, fast-path option policy, `deskInfer` (spot+PTB
  hydration → `chatCompletion` → contract parse or local fallback).
- **`llm_signal_assistant.js`** — snapshot→prompt→inference; 15m/60m
  precontract = ultra tier, 5m = mini tier; specialist-split relay;
  non-ASI providers cut.
- **`asi1-precontract-advisor.js`** — 5m+15m briefs, 15m inference cooldown
  (deterministic fallback inside window), PTB-gated firing.
- **`orbital-foresight-engine.js`** — manual OSL scans (ASI1 + AgentVerse
  enrichment), FCI prompt injection, drift-anchor ring, staleness clock.
- **`asi1-desk-contract.js`** — prompts, local inference, contract schema.
- **`agentverse-hunter.js`**, **`grok-*`** overlays (range memory, PTB
  defense), **`five-min-claude-overlay.js`** (disabled),
  **`narrative-velocity.js`** (quick/deep narrative overlays via IPC),
  **`inference-truth-guard.js`**, **`inference-relay.js`**, **`live-path-15m.js`**.
- **ML (`src/ml/`, `src/quant/`)** — calibration, regime classifiers
  (HMM/Kalman/Hurst), scalper pipeline, backtests (`backtest/`,
  `tests/*backtest*`), replay gating.

---

## 9. UI (`src/ui/`, `src/core/app/`)

`asi1-desk.js` (Ask ASI1 / Truffle / custom prompt / AgentVerse hunt),
`hourly-ranges-panel.js`, `polymarket-terminal.js`, `network-health-dashboard.js`,
`orderbook-hud.js` + `microstructure-hud.js`, `render-layer.js` (coin icons,
predictions, overlays), `floating-orchestrator.js` (MCTS-gated execution),
`app/ui-components.js`. Boot: `app-core.js` → `app-init.js` (starts refresh
engines, Pyth validator 60s loop, ChainRouter, feeds).

---

## 10. Truffle agent (`mcp_agent.py`, `truffle-bridge/`)

- uAgents-based, ASI1 LLM + MCP tool-calling (LeakSnipe suite at
  `leaksnipe-suite.gitgoin87.workers.dev`). `TRUFFLE_HUD_ONLY` defaults off:
  full-live inference everywhere, `max_tokens` 1000, cost no object.
- REST: `/query` (HUD channel: asi1-desk + `truffle:query` IPC, `live=True`),
  `/health`, `/weights`, `/trees`, `/kodak`, `/alt-signal`, `/calibration`,
  `/tail-diagnostics`, `/kalshi-15m-model`, `/cascade`,
  `/truffle/cascade-audit`, `/truffle/model-summary`, `/summary`.
- Runs in WSL (`/mnt/g/WECRYP/mcp_agent.py`); `truffle-bridge/` is the
  FastAPI/AMM sidecar (requirements + server).
- Renderer query paths: horizon-mode Ask → `truffle:query` IPC (attaches
  wall-stats, main appends JSONL to `logs/truffle-wall-stats.log`) and
  custom-prompt direct `POST 127.0.0.1:8002/query` fallback.

---

## 11. Cloud workers & backend

- **`kalshi-ladder-worker/`** — `/ladder?symbol=`, `/edges`, `/health`;
  1-min cron warms KV cache; per-isolate + KV cross-isolate cooldowns so
  Kalshi 429s don't cascade. Currently 503ing from its isolates → client
  backs off; needs worker-side fix + `wrangler` redeploy.
- Others: `functions/`, `cloudflare/` + `cloudflared/` (tunnel/Mullvad/Sweden
  lane configs, PAC, split-domain lists), `mcp-server/`, `server/`,
  `data-pipeline/`, `k8s/`, `freqtrade/`, Firebase (`firebase.json`,
  `.firebaserc`, D1/wrangler configs).

---

## 12. Data, logs, secrets, tests

- **Logs:** `logs/` (app, cex monitors, hedge, kalshi), `logs/truffle-wall-stats.log`
  (JSONL wall/depth per Truffle query), `backtest-logs/`, per-feed caches
  (`WE-CRYPTO-CACHE/`, `WECRYP0-data/`, runtime `*.db` for Pyth Lazer/Coinbase L2).
- **Secrets:** never in code. Env (`.env`: ASI1/OpenAI/CMC/Etherscan/Alchemy/
  Helius keys, primary-provider switches) + `secrets/*.txt` (role-tagged ASI1
  keys, Alchemy gitgoin file first). Renderer gets keys via main IPC
  (`readAlchemySecret`, `__env`), never bundled.
- **Tests:** `tests/` (vitest-style `*.test.js`: ASI1 account/contract,
  orchestrator, overlays, hourly-ranges, Polymarket slugs, backtests) +
  `test_*.js/py/sh` scratch + `backtest/` suites. Run via `package.json`
  scripts; Python via `.venv`.

---

## 13. Network ops

- Egress normally via **Mullvad Sweden** WireGuard (`cloudflared/*.conf`,
  `Set-WeCryptoLanes.ps1` punch routes); `wecrypto-wsl` tunnel carries
  WSL traffic. Bybit/Binance-F geo-fence US egress; Bitstamp must go direct;
  Hermes 403s this egress (Lazer fallback used); Kalshi polling is worker-side.
- Health dashboard (`network-health.js`): CORE providers + OPT transports;
  LocalProxy state comes from the bridge (healthy + fallback during bypass,
  degraded only when the proxy process is down).

## 14. Known issues (2026-09-20)

1. Stale elevated `we-crypto-proxy.exe` on `:3012` (missing newer routes) —
   unkillable without admin; discovery prefers `:3010`/`:3011`; full app
   restart clears it.
2. Kalshi worker 503s — needs worker fix/redeploy (client backs off).
3. CMC Pro key rejected (401) — kill-switched to fallbacks.
4. Hermes 401/403 on this egress — Lazer fallback healthy.
5. Polymarket `crypto-price` 429s under burst — per-contract dedupe + 60s
   backoff in place.
