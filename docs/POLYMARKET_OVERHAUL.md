# Polymarket-only overhaul

**Branch:** `feat/polymarket-overhaul` · **PR:** https://github.com/JohnDaWalka/WE-CFM-Orchestrator/pull/71

## Runtime model

| Layer | Module | Role |
|-------|--------|------|
| Live books | `src/feeds/polymarket-ws.js` | Single CLOB + RTDS owner; L2 depth + micro features |
| Markets | `src/kalshi/prediction-markets.js` | Gamma discovery, PTB, poly5m/poly15m on `getCoin()` |
| Settlement | `src/kalshi/market-resolver.js` | WS `market_resolved` push + Gamma poll fallback |
| Trading | `electron/polymarket-clob-manager.js` | Signed CLOB via secrets; `poly:*` IPC |
| UI | `src/ui/polymarket-terminal.js` | BUY UP/DOWN → live place when enabled |

## Live trading

1. Put L2 creds in `secrets/POLYMARKET_API.txt` (`"key"`, `"secret"`, `"passphrase"`).
2. Enable: `POLY_LIVE_TRADING=1` **or** `"liveTrading": true` in that file.
3. Restart Electron. First order confirms once per session; use **Cancel All** as kill switch.

Never put API secrets in renderer source.

## Remote access

Optional Cloudflare Tunnel: `wecrypto.leaksnipe.win` → `https://127.0.0.1:3450`  
Setup: `cloudflared/setup-wecrypto-tunnel.ps1` (config under `%USERPROFILE%\.cloudflared\`).

## Deferred (not blocking)

- Rename `src/kalshi/` → `src/markets/`
- Cosmetic rename of `kalshi*` fields inside large `predictions.js` (data already Polymarket-sourced)
- Agents: prefer Polymarket MCP https://docs.polymarket.com/mcp

## ASI1 + DeepSeek (TokenMix) pre-contract inference

| Order (15m / hourly) | Provider | Default model | Notes |
|----------------------|----------|---------------|--------|
| 1 | ASI1 | `asi1-fast` | Best live market notes; ultra falls back on 504 |
| 2 | TokenMix | `deepseek/deepseek-v4-flash` | Best **cost/detail** on TokenMix (~10–70× cheaper than Claude/GPT tiers) |
| 3 | xAI | grok-4.5 | When keyed |

5m PTB: xAI first (if keyed), then ASI1, then DeepSeek/TokenMix.

| Env | Default |
|-----|---------|
| `TOKENMIX_MODEL` | `deepseek/deepseek-v4-flash` |
| `TOKENMIX_MAX_TOKENS` | `1400` |
| `ASI1_PRECONTRACT_MODEL` | `asi1-fast` |
| `ASI1_WEB_SEARCH` | off unless `=1` (web search was contributing to 504s) |

Keys: `secrets/tokenmix_api_key.txt`, `secrets/ASI1_*.txt`

## TokenMix / DeepSeek traffic

Pre-contract paths **dual-fire** ASI1 + TokenMix (`deepseek/deepseek-v4-flash`) in parallel so DeepSeek is not starved when ASI1 wins. Both appear in the LLM query log. Set `LLM_DUAL_FIRE=0` to disable dual-fire (cascade only).

## Cold-start persistence

| Layer | Store |
|-------|--------|
| Main process LLM history / market memory | `WE-CRYPTO-CACHE/llm-inference-state.json` (or Electron `userData`) |
| ASI1 briefs | `localStorage` `wecrypto_asi1_briefs_v1` |
| Range guidance | `localStorage` `wecrypto_range_guidance_v1` |
| Truth verdicts | `localStorage` `wecrypto_truth_verdicts_v1` |

TTL ~6h for renderer stores. Restart should restore last briefs immediately, then refresh.

## Inference source-of-truth (mid-contract nullify)

Raw Polymarket + spot data is the **source of truth**. If an LLM/ASI1 call fights live data, it is cut off immediately.

| Vote | Signal |
|------|--------|
| `spot_vs_ptb` | Spot vs price-to-beat (settlement definition) |
| `clob_mid` | P(Up) / book mid vs 50% |
| `book_imbalance` | CLOB depth imbalance |
| `live_direction` | Feed liveDirection field |
| `model_score` | Non-LLM prediction engine score |

**Nullify** when ≥2 independent votes oppose the AI (or 1 strong path vote in last 120s).  
Effective call flips to raw truth; AI weight → 0; UI shows **⛔ NULLIFIED**.

Module: `src/llm/inference-truth-guard.js`  
Wired: ASI1 pre-contract (8s recheck), prediction inference overlay, Grok/ASI1 range finalize.

## Quick health checks

- Console: `[PolymarketWS]` CLOB connected
- `getCoin('BTC').poly5m` has `bestBid` / `bids` after subscribe
- After window close: `_15mResolutionLog` grows (`settlementAuthority` `polymarket_ws` or `polymarket_gamma`)
- No requests to `api.elections.kalshi.com` / `trading-api.kalshi.com`
- ASI1 thoughts on cards with call + preContract action
