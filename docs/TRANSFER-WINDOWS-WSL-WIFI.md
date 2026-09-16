# WE-Crypto portable transfer runbook

This PR moves the complete Windows-first WE-Crypto stack to another laptop and keeps network setup adaptive to Wi-Fi changes.

## What transfers

- **App:** the full Electron app, UI, Kalshi 15m contract surface, ASI1 desk, prediction engine, and tests.
- **Cloudflare Worker:** `cloudflare/scalper-market-data` with D1 calibration storage and cache-safe market-data proxy.
- **Tunnel tooling:** whole files, not excerpts:
  - `cloudflared/Repair-MullvadTunnel.ps1`
  - `cloudflared/Test-TunnelConnectivity.ps1`
  - `cloudflared/Set-WeCryptoLanes.ps1`
  - `cloudflared/Find-WeCryptoSocksHost.ps1`
  - `cloudflared/Test-Port.ps1`
- **Launcher:** `launch_dev.bat`, updated to discover the current WSL/Wi-Fi bridge automatically.

## Fresh-machine requirements

Install these on Windows before the first run:

- Git for Windows
- Node.js 20+ and npm
- Docker Desktop (optional; Redpanda/Redis only)
- WSL2 Ubuntu
- Tailscale and Mullvad, if you use the Sweden trading lane

## Clone and pull

Use the GitLab repository as the transfer source:

```powershell
git clone https://gitlab.com/walkershooligans/wecrypto.git G:\WECRYP
cd G:\WECRYP
git fetch origin
git switch main
git pull --ff-only origin main
```

To test this branch before it merges:

```powershell
cd G:\WECRYP
git fetch origin
git switch feat/transfer-portable-network
git pull --ff-only origin feat/transfer-portable-network
```

## Verify the transfer

Run from PowerShell:

```powershell
cd G:\WECRYP

git ls-files `
  cloudflared/Repair-MullvadTunnel.ps1 `
  cloudflared/Test-TunnelConnectivity.ps1 `
  cloudflared/Set-WeCryptoLanes.ps1 `
  cloudflared/Find-WeCryptoSocksHost.ps1 `
  cloudflared/Test-Port.ps1
```

All five paths must print. Missing paths mean the pull did not complete; do not launch until fixed.

## Install dependencies

```powershell
cd G:\WECRYP
npm ci
```

If native modules report errors, run:

```powershell
npm audit fix --omit=dev
```

## Restore local configuration

Secrets and machine-local settings are not in Git. On the new laptop:

1. Create `.env` from your secure password manager or a private transfer.
2. Do not copy `.env` into Git.
3. Confirm GitLab/Cloudflare/GitHub credentials are available to Git and the tools.

## Adaptive network setup

The launcher no longer hard-codes `10.13.13.2`. It discovers the SOCKS bridge in this order:

1. `WECRYPTO_SOCKS_HOST`
2. `WECRYPTO_WSL_HOST`
3. current WSL IPv4 addresses from `wsl.exe`
4. legacy `10.13.13.2`
5. `127.0.0.1`

It writes the first reachable host into `WECRYPTO_SWEDEN_SOCKS`. If none is reachable, it starts the local standalone SOCKS bridge and uses loopback.

Optional ports can be overridden in `.env` or the Windows environment:

- `MULLVAD_SOCKS_PORT` (default `18090`)
- `WECRYPTO_PROXY_PORT` (default `3010`)
- `WECRYPTO_WEB_PORT` (default `3450`)

Set `WECRYPTO_DISABLE_WSL_DISCOVERY=1` only if you need to pin the bridge manually.

## Tunnel repair and lane control

Diagnose the WireGuard/Mullvad tunnel:

```powershell
cd G:\WECRYP
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\cloudflared\Repair-MullvadTunnel.ps1
```

Check end-to-end egress:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\cloudflared\Test-TunnelConnectivity.ps1 `
  -SocksUrl socks5://127.0.0.1:18090
```

Select a routing lane:

```powershell
.\cloudflared\Set-WeCryptoLanes.ps1 -Lane Status
.\cloudflared\Set-WeCryptoLanes.ps1 -Lane Fast
.\cloudflared\Set-WeCryptoLanes.ps1 -Lane Sweden
```

For a different Wi-Fi or WSL address, no edit is needed. If the tunnel is healthy, the launcher finds the new address automatically.

## Launch

From Windows Explorer or PowerShell:

```powershell
cd G:\WECRYP
.\launch_dev.bat
```

Expected startup output:

- `Detected active SOCKS5 bridge at <current-host>:18090` or a local-bridge fallback
- `HTTP proxy bouncer successfully bound`
- Web interface at `http://127.0.0.1:3450`

## Validate after launch

Check the 15-minute tab:

- It must say **Kalshi 15M**, not Polymarket.
- A missing contract must say **Awaiting Kalshi 15M contract**.
- No 15m strike may come from Polymarket PTB.

Run the focused tests:

```powershell
cd G:\WECRYP
node tests/live-path-15m.test.js
node tests/specialized-prompt-kalshi-15m.test.js
node --test tests/asi1-desk-contract.test.js
```

## Transfer safety rules

- Windows is authoritative; use `G:\WECRYP` for all app work.
- Do not delete WSL files during setup; WSL is only the development/runtime side.
- Do not store tokens in Git history.
- Do not add generated build artifacts to source control.
