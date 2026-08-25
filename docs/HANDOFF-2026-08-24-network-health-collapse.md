# Handoff — 2026-08-24 Network Health cascade collapse

Continues from `docs/HANDOFF-2026-08-23-asi1-hud-incident.md` (Tailscale/Mullvad tunnel conflict history — read if this turns out to be a repeat). Written from a WSL Claude Code session that could read `G:\WECRYP` via `/mnt/g/WECRYP` but could **not** run PowerShell, check live Windows processes, or restart services — that's why this handoff exists. A session opened directly on Windows (PowerShell) should pick this up.

**App tree:** `G:\WECRYP`. Live Windows box — treat as a live-trading environment per the prior incident doc's warning.

---

## What happened (today, ~18:53–19:10 UTC)

User reported the app "was good for ~15 minutes then started failing." Watched it live via the app's own Network Health panel and `COPILOT_DEBUG/network-errors.log`:

1. **First observed**: a brief multi-exchange 502 burst (Bitstamp, Bitget, Gemini, Coinbase, Deribit, Crypto.com, Upbit, Bitfinex, BingX, Bitvavo, Hyperliquid, XRPL, Alchemy, MEXC, OKX all logging 502/timeout within the same ~3-minute window), which then went quiet. At that point the Network Health panel showed only 1 degraded (CoinGecko, genuine 429 rate-limit on `coins/solana/market_chart?...&days=7`, unrelated to the rest — that one's just app-side polling frequency vs. CoinGecko's free-tier demo API key rate cap, not a network issue).
2. **Then it escalated for real**, over the next several minutes, into near-total collapse: DexScreener, Etherscan, Gemini, s1/s2.ripple.com, Solana RPC, Upbit, Whale Alert, OKX, xrplcluster, Crypto.com, Bitfinex, MEXC, Binance (futures), Bitget, Pyth, Alternative.me all showed DEGRADED simultaneously, almost all carrying the identical message pattern: **`[app/logic] 503 Circuit open for <host> (WE proxy-fetch backoff)`** — the app's own circuit breaker tripping after repeated failures on that route — plus some `[network/transport] Chain route timed out after 25000ms`. Pyth separately showed `Fallback` / stale 57s (no fresh tick, using cached/secondary source).

The shared-circuit-breaker-cascade pattern across totally unrelated exchanges, all at once, points at the **shared transport underneath all of them**, not each exchange independently breaking.

## Confirmed architecture (read from source, not assumed)

Every exchange/data-provider fetch funnels through a local HTTP relay on `127.0.0.1:3010` (this is the "LocalProxy"/"WE proxy-fetch" seen throughout the log), which is supposed to forward out through a **Mullvad SOCKS5 proxy** for Sweden-geo egress (needed at minimum for Binance futures, which 451-geo-blocks non-Sweden-routed calls — confirmed repeatedly in the raw log as `fapi.binance.com`/`dapi.binance.com` returning `451 [network-fail]` whenever the tunnel path is degraded).

Two files implement the Mullvad SOCKS5 layer:
- `cloudflared/mullvad-standalone-socks.js` — the actual SOCKS5 server. Listens on `process.env.MULLVAD_SOCKS_PORT || 18090` (confirmed by reading the source directly, line 11).
- `cloudflared/proxy-runner.js` — spawns it, also defaulting/passing `MULLVAD_SOCKS_PORT || 18090` (lines 12, 23).
- `cloudflared/Repair-MullvadTunnel.ps1` — diagnostic script, own architecture comment says the path is `WireGuardTunnel$wecrypto-mullvad (10.65.50.149) -> mullvad-standalone-socks.js (:18090) -> WECRYPTO_SWEDEN_SOCKS`, and its `-SocksPort` param also defaults to `18090`.

## Open lead — NOT YET CONFIRMED as the live cause, needs Windows-side verification

`http-socks5-bridge.js` (repo root, `G:\WECRYP\http-socks5-bridge.js`) is a **different** file that also implements an HTTP→SOCKS5 bridge on port **3010** (matches the "LocalProxy" port in the log), but its `SOCKS5_PROXY` target is **hardcoded to port 18091** (line 6: `const SOCKS5_PROXY = { host: '127.0.0.1', port: 18091, type: 5 };`) — not 18090.

Grepped the whole repo for `MULLVAD_SOCKS_PORT` (excluding `node_modules`/`target`): every reference (`mullvad-standalone-socks.js`, `proxy-runner.js`, `Repair-MullvadTunnel.ps1`) consistently uses/defaults to **18090**. There is no `18091` override anywhere. So if `http-socks5-bridge.js` is the actual process currently listening on `127.0.0.1:3010`, it is trying to reach a SOCKS5 proxy on a port nothing is listening on — which would cause instant, total connection failure on every request through it, not intermittent flakiness. That fits the observed cascade (many unrelated exchanges' circuit breakers tripping together) better than "the tunnel occasionally drops," but **this was not verified against the live process** before this handoff was written — WSL couldn't check what's actually bound to port 3010 on the Windows side.

**First thing to check, before touching WireGuard/Mullvad at all:**
```powershell
# What's actually listening on 3010 right now, and which script owns it?
netstat -ano | findstr :3010
Get-Process -Id <pid from above> | Select-Object Path,CommandLine
```
- If it's `http-socks5-bridge.js`: the port-18091-vs-18090 mismatch is real and is very likely the actual root cause. Fix is a one-line change — either edit `http-socks5-bridge.js` line 6 to `port: 18090`, or set `MULLVAD_SOCKS_PORT=18091` in the environment before `mullvad-standalone-socks.js` starts (the former is more correct, since 18090 is what every other file in the repo already agrees is canonical).
- If it's something spawned by `proxy-runner.js` instead (which already uses the correct 18090 default): the port mismatch is a red herring — `http-socks5-bridge.js` may just be a stale/superseded file from an earlier iteration. In that case, fall back to `Repair-MullvadTunnel.ps1` for the real diagnosis (WireGuard service status, tunnel interface, actual SOCKS bridge health) — full content already read, reproduced below for reference since a fresh session won't have it in context yet.

## `Repair-MullvadTunnel.ps1` (already read in full — diagnostic only, does not auto-fix)

Checks, in order: `WireGuardTunnel$wecrypto-mullvad` service status → `wecrypto-mullvad` interface IP (expects `10.65.50.149`, matching the prior incident doc's registered tunnel address) → whether the SOCKS bridge port is listening → calls `Test-TunnelConnectivity.ps1` for an end-to-end egress test. If egress fails, it prints (but does not run) these repair steps:
1. Run elevated, then `Restart-Service WireGuardTunnel`$wecrypto-mullvad`
2. Confirm `C:\Windows\Temp\wecrypto-mullvad.conf` peer `AllowedIPs` includes `0.0.0.0/0`
3. Confirm peer `Endpoint` matches a live Stockholm relay (`cloudflared/mullvad-stockholm-relays.json`)
4. If handshake still dead, re-register the device via the Mullvad API (see the 2026-08-23 incident doc for the exact `POST https://api.mullvad.net/wg/` flow already used once before)

Also worth knowing: `mullvad-standalone-socks.js` already POSTs its own failure telemetry to `http://127.0.0.1:7629/ingest/9b1c0a9c-...` with a `hypothesisId`/`runId` field (line ~104) — there's an existing local debug-ingest harness wired up from a prior session's hypothesis-testing. Check what's consuming that ingest endpoint (or just query it directly) for a live signal before re-deriving everything from scratch.

## What's NOT the cause (ruled out or irrelevant this time)

- CoinGecko's 429 is real but unrelated — plain rate-limiting on the free/demo API key, not a network/tunnel issue.
- The very first multi-exchange 502 burst (Bitstamp/Bitget/etc.) self-resolved before the real collapse started — don't chase that specific timestamp, it's stale.
- Not yet checked, but worth ruling in/out given the 2026-08-23 incident history: whether Tailscale's exit-node WFP callout (the confirmed root cause last time) or a second competing default route (official Mullvad app vs. the standalone tunnel) is back. If `Repair-MullvadTunnel.ps1`'s interface/service checks come back clean but egress still fails, revisit that doc's WFP-audit method (`netsh wfp show filters`) rather than assuming it's the port mismatch above.

## Possibly-related, unconfirmed timing correlation

User was actively reconfiguring Cloudflare Access / WireGuard split / DNS-over-TLS for an unrelated domain (`leaksnipe.win`) in roughly the same window today. No evidence either way that this touched WECRYPTO's network path — flagging only because the timing overlaps and past incidents in this repo have involved multiple VPN/tunnel layers stepping on each other.
