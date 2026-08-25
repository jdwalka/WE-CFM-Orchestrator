# Session Handoff: WSL/Ubuntu CEX Routing & Direct US Split
**Date:** 2026-08-25  
**Context:** Tailscale has been completely removed. Cloudflare is running TLS/DNS only. Routing is split between direct native US connection and the `wecrypto-wsl` WireGuard link.

---

## 1. Network Topology & Split Routing Architecture

```
                         ┌────────────────────────────────────────────────────────┐
                         │               WINDOWS ELECTRON RENDERER                │
                         └──────────────────────────┬─────────────────────────────┘
                                                    │
                         ┌──────────────────────────┴─────────────────────────────┐
                         │          src/infra/proxy-fetch.js (needsProxy)         │
                         └──────────┬───────────────────────────────────┬─────────┘
                                    │                                   │
              [US-Allowed / Direct Native]                    [Geo-Blocked CEXs]
                                    │                                   │
                                    ▼                                   ▼
  ┌──────────────────────────────────────────────────┐   ┌──────────────────────────────┐
  │ Direct Native Source IP (US + Cloudflare DNS)    │   │ Windows Proxy (Port 3010)    │
  │ - AI / LLM: api.asi1.ai, OpenAI, Anthropic       │   └──────────────┬───────────────┘
  │ - Prediction Markets: Polymarket CLOB/Gamma      │                  │ SOCKS5 over WireGuard
  │ - US Spot APIs: Coinbase, Kraken, CoinGecko      │                  ▼
  └──────────────────────────────────────────────────┘   ┌──────────────────────────────┐
                                                         │ wecrypto-wsl Tunnel          │
                                                         │ Windows: 10.13.13.1          │
                                                         │ WSL: 10.13.13.2:18090        │
                                                         └──────────────┬───────────────┘
                                                                        │
                                                                        ▼
                                                         ┌──────────────────────────────┐
                                                         │ WSL2 / Ubuntu Non-US Egress  │
                                                         │ - Binance Spot & Futures     │
                                                         │ - Bybit, OKX, KuCoin, MEXC   │
                                                         └──────────────────────────────┘
```

---

## 2. Key Network Parameters

| Parameter | Value | Details |
|---|---|---|
| Windows WireGuard Adapter | `wecrypto-wsl` | IP: `10.13.13.1` (Ping RTT: 0ms) |
| WSL WireGuard Interface | `wg0` | IP: `10.13.13.2` |
| Windows Local Proxy | `127.0.0.1:3010` | Keep-Alive pooling + 600ms micro-cache |
| WSL SOCKS5 Proxy Target | `10.13.13.2:18090` | Forwards CEX traffic out of WSL |
| Active ASI1 Account | `mauro_fanelli@icloud.com` | `ASI1_API_KEY_ICLOUD=sk_71e8da9b7cb3411c9714acc836ed14232843a372617449ae97de0b5e77c86487` |

---

## 3. Codebase State & What is Already Done

1. **`src/infra/proxy-fetch.js`**:
   - Direct bypass for AI (`api.asi1.ai`, `openai.com`, etc.), Polymarket, and US feeds.
   - `needsProxy()` routes Binance (`fapi.binance.com`, `api.binance.com`), Bybit (`api.bybit.com`), OKX, Kraken, Bitstamp, Hyperliquid to `127.0.0.1:3010`.
   - `proxy-fetch.js` is loaded at the top of `<head>` in `public/index.html` before `network-log.js`.

2. **`electron/main.js` & `cloudflared/proxy-runner.js`**:
   - `SocksProxyAgent` with `keepAlive: true` (`maxSockets: 64`).
   - 600ms in-memory micro-cache serving warm ticker responses in 1ms – 14ms.

3. **ASI1 Desk HUD**:
   - Dynamic account discovery rendering `icloud` (Pro) with 1 active live key.
   - Fixed `ReferenceError: lastModel is not defined` in `llm_signal_assistant.js`.

4. **Test Suite**:
   - Automated test suites passing on branch `dev` (PR #112: remediation TAILSCALE MOONLIGHT).

---

## 4. WSL / Ubuntu Workflow & Next Steps

### Step 1: Verify / Establish Non-US Egress in WSL
Test if WSL exits via a non-US IP for Binance:
```bash
curl -s -o /dev/null -w "Binance HTTP Status: %{http_code}\n" https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT
```
- If HTTP `200`: WSL egress is non-US and ready.
- If HTTP `451`: Bring up the non-US WireGuard/VPN interface inside WSL.

### Step 2: Launch the SOCKS5 Bridge inside WSL
Run the SOCKS5 proxy server bound to `0.0.0.0:18090` (accessible on `10.13.13.2` from Windows):
```bash
cd /mnt/g/WECRYP
MULLVAD_SOCKS_BIND="0.0.0.0" MULLVAD_SOCKS_PORT=18090 node cloudflared/mullvad-standalone-socks.js
```

### Step 3: Test SOCKS5 Tunnel from WSL
```bash
curl -s -x "socks5://127.0.0.1:18090" https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT
curl -s -x "socks5://127.0.0.1:18090" https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT
```

### Step 4: Connect Windows Proxy Bouncer to WSL
On the Windows side, point `proxy-runner.js` to WSL:
```powershell
$env:WECRYPTO_SWEDEN_SOCKS = "socks5://10.13.13.2:18090"
node G:\WECRYP\cloudflared\proxy-runner.js
```

Then launch Electron:
```powershell
npx electron G:\WECRYP
```
