# Handoff — 2026-08-23 ASI1 HUD incident + standalone Mullvad build

Continues from `docs/HANDOFF-ASI1-HUD.md` and `docs/HANDOFF-2026-08-22-session.md`. Read both first.

**App tree:** `G:\wecryp` = `G:\WECRYP`. Live Windows box, user actively trading real money throughout this session — every action here was applied directly to the live machine, not just committed to git.

---

## What happened

1. Session opened from `docs/HANDOFF-ASI1-HUD.md`, an older/interim doc describing a standalone `asi1-windows-proxy.js` CONNECT proxy on `127.0.0.1:18080` for ASI1. That doc was **superseded** by `docs/HANDOFF-2026-08-22-session.md` (same night, later), which documents the real fix: `Install-Asi1Punch` in `cloudflared/Set-WeCryptoLanes.ps1` — a plain `/32` host route via the LAN gateway, no local proxy needed, verified at 114.5ms.
2. User reported the HUD (ASI1 inference) was down. Diagnosis found the ASI1 punch route + the Windows CONNECT proxy were both present but the proxy's outbound leg was failing (`ResponseEnded`) intermittently.
3. **Root cause, confirmed via direct WFP (Windows Filtering Platform) audit** (`netsh wfp show filters`, ~1390 filters dumped, parsed for block-action entries): Tailscale's exit-node "no traffic leak" enforcement blocks *any* punched `/32` destination — not just ASI1 — at the OS socket layer (`WSAEACCES`) whenever `RouteAll` + an active exit node are on. This is **not** a static, deletable firewall rule (only 4 block-action WFP filters exist system-wide, all standard Microsoft boot-time boilerplate under provider `{58954787-101b-4391-bfe3-cd8f4b8e03fa}` — nothing Tailscale-specific, nothing IP-scoped). It's Tailscale's driver making a live per-connection decision (a callout), matching the two upstream issues already cited in the prior handoff (tailscale/tailscale#11554, #7766).
4. This affects **every** direct-punched host equally — confirmed by testing raw TCP connects to Alchemy (`57.129.88.148`) and Helius (`104.18.36.169`) RPC IPs, not just ASI1's `34.149.190.89`. If WeCrypto's execution path touches Alchemy/Helius for on-chain settlement, that was silently broken too, not just the LLM signal — this is the more likely real cause of trades failing tonight, not just "the HUD was slow."
5. Tested and ruled out: `tailscale down`/`up` full reconnect (identical `EACCES` after), local Windows Firewall rules (only 2 custom block rules exist, both scoped to `warp-svc.exe`/`tailscaled.exe`'s own traffic, not app traffic), the proxy's explicit `localAddress` bind (fails identically bound or unbound).
6. `SwedenSplit` lane (clears the Tailscale exit node) was tried live as a fix — it does free the punch routes, but it also **kills the trading SOCKS5 leg** (`10.64.0.1:1080` goes unreachable), because that SOCKS5 endpoint only exists through the active exit-node peer connection. **Do not use `SwedenSplit` while trading is live** — this cost real trades tonight when tried without warning first.

## Current live state (as of this doc)

- Direct-punch routes for ASI1/Alchemy/Helius/TokenMix: **removed**. All traffic to those hosts falls back through the Tailscale Sweden exit tunnel — works, but slow (hundreds of ms to low seconds instead of ~10-150ms).
- Tailscale exit node: Sweden (`se-sto-wg-209`), `RouteAll: true`, unchanged all night except for one `down`/`up` cycle (no lasting effect).
- Trading SOCKS5 (`10.64.0.1:1080`): reachable, confirmed working.
- `asi1-windows-proxy.js` on `127.0.0.1:18080`: running, `ASI1_PROXY_LOCAL_ADDR=0.0.0.0` (no forced source bind) — gets real `401` responses from `api.asi1.ai` through the Sweden tunnel.
- **User independently installed and connected the official Mullvad VPN desktop app** (`Mullvad VPN.exe` / `mullvad-daemon`, own account, own `Mullvad` WireGuard adapter) partway through this session — this created a second full-tunnel default route (`0.0.0.0/0` via `10.64.0.1`, metric 0) competing with Tailscale's own default route at the same metric. Real, currently-live instability, independent of anything in this doc's fix.

## In progress: standalone Mullvad tunnel (the real fix)

Goal: a Mullvad connection **independent of Tailscale**, so the Tailscale exit node can be cleared entirely (→ ASI1/Alchemy/Helius get full native-Ethernet speed, no WFP conflict) while trading keeps its Sweden-geo SOCKS5 path via the new tunnel instead.

Done:
- Registered a new WireGuard device on the user's Mullvad account (`1112761104782017`) via `POST https://api.mullvad.net/wg/` (classic account+pubkey endpoint, still live, HTTP 201). Assigned tunnel address `10.65.50.149/32` / `fc00:bbbb:bbbb:bb01::2:3294/128`. Keypair generated locally via `openssl genpkey -algorithm X25519` — private key never left the machine, was never committed.
- Installed WireGuard for Windows (`winget install WireGuard.WireGuard`).
- Wrote a config peering with Stockholm relay `se-sto-wg-009` (`185.195.233.69:51820`, from `cloudflared/mullvad-stockholm-relays.json`), critically with **`Table = off`** under `[Interface]` — this is what prevents the tunnel from auto-installing a default route and re-creating tonight's exact problem in reverse (a VPN that swallows ASI1 traffic).
- First `wireguard.exe /installtunnelservice` attempt failed to start — root cause was the just-started official Mullvad app already owning the WireGuard NT driver/interface. Uninstalled the failed duplicate service to avoid a second competing default route.

Not done yet:
- User needs to disconnect the official Mullvad app so the manual tunnel can start cleanly (asked live, response pending as of this doc).
- Once the manual tunnel is up: build a minimal local SOCKS5 server (same pattern as `cloudflared/asi1-windows-proxy.js`, i.e. `net.createServer` + explicit `localAddress` bind — but SOCKS5 protocol, not HTTP CONNECT, since `electron/main.js` consumes `WECRYPTO_SWEDEN_SOCKS` as `ALL_PROXY`/`socks5://`) bound to the tunnel's local address (`10.65.50.149`), so only that server's traffic goes through Mullvad — not the whole box.
- Point `WECRYPTO_SWEDEN_SOCKS` at the new local SOCKS5 server instead of `socks5://10.64.0.1:1080`.
- Verify a needled trading domain (e.g. `api.polymarket.com`) resolves to a Mullvad/Stockholm exit IP through the new proxy (`am.i.mullvad.net` is a good test target).
- Only then: clear the Tailscale exit node (`tailscale set --exit-node=`), re-add the ASI1/Alchemy/Helius punch routes (`Install-DirectPunch` in `Set-WeCryptoLanes.ps1`, or the `-Lane SwedenSplit`/similar), and verify ASI1 is fast again *and* trading still works, simultaneously, before calling this done.
- `electron/main.js` around lines 604, 609, 873, 1869-1870 is where `WECRYPTO_SWEDEN_SOCKS` is consumed — no code changes needed there, just the env var value once the new proxy exists.

## Do not

- Everything in the original `HANDOFF-ASI1-HUD.md`'s "Do not" list still applies.
- Do **not** run `-Lane SwedenSplit` while a trade is open — confirmed live tonight that it drops the SOCKS5 trading leg the instant the exit node clears.
- Do **not** assume "the HUD is slow" only means ASI1 — Alchemy/Helius (on-chain RPC) share the exact same punch-route mechanism and were equally broken tonight. Check those too before declaring anything fixed.
- Do **not** run the official Mullvad app and the manual `wecrypto-mullvad` WireGuard tunnel service at the same time — confirmed conflict tonight (manual service fails to start while the app's driver is active).
- Never commit `secrets/ASI1_ICLOUD.txt`, the Mullvad account number, or the WireGuard private key generated tonight. The private key lives only in `$env:TEMP`/job scratch on the live machine and was registered with Mullvad's API directly from there.
