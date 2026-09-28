---
name: wecrypto-session-sync
description: >-
  Mandatory session and environment synchronization skill for WE-CRYPTO.
  Executes at the beginning of each session and throughout user interactions
  to sync claude-mem between host G:/WECRYP and WSL /home/mauro/claude-mem,
  verify Mullvad SOCKS5 (:18090) and HTTP proxy bouncer (:3010) health,
  audit local Gemini agent (:8003), probe exchange routing (Binance, Bybit, XRPL, Polymarket),
  and inspect git branch alignment across GitHub PR #230 and GitLab MR #30.
---

# WE-CRYPTO Session & Environment Synchronization Skill

## Purpose
This skill ensures continuous environment integrity, unbroken proxy routing, daemon uptime, and dual-system memory synchronization (Windows host + WSL) across all WE-CRYPTO interactions.

## When to Use
1. **Session Start (Pre-flight)**: Run immediately upon beginning a new session or after context resumption.
2. **Throughout Interactions**: Run before and after major deployments, recalibration runs, git commits, or when any network or proxy anomaly is suspected.
3. **Memory Append & Sync**: Run whenever a new milestone entry is written to `G:/WECRYP/claude-mem` to ensure it is immediately mirrored to `/home/mauro/claude-mem` in WSL.

---

## Synchronization Workflow

### Step 1: Execute Deterministic Audit & Sync
Run the automated synchronization script:
```powershell
python G:\WECRYP\.agents\skills\wecrypto-session-sync\scripts\sync_session.py
```

This single command will:
- Replicate `G:/WECRYP/claude-mem` to `/home/mauro/claude-mem` in WSL (`wsl -e cp /mnt/g/WECRYP/claude-mem /home/mauro/claude-mem`).
- Verify TCP connectivity for SOCKS5 proxy (`127.0.0.1:18090`), HTTP bouncer (`127.0.0.1:3010`), and Gemini agent (`127.0.0.1:8003`).
- Probe `http://127.0.0.1:8003/health` for local Gemini quantitative agent readiness.
- Probe Binance FAPI (`/binance-f/fapi/v1/ping`) and Bybit V5 (`/bybit/v5/market/time`) via `:3010` to guarantee zero geo-blocking.
- Probe Polymarket and XRPL Link (`https://xrpl.link/`) for data feed health.
- Check current git branch, head commit, and working tree cleanliness.

### Step 2: Auto-Recovery Procedures (If Any Check Fails)

#### If Gemini Agent (:8003) is Down:
Spawn the Gemini background daemon:
```powershell
# Run as daemon via run_command (IsDaemon=true)
python G:\WECRYP\gemini_agent.py
```
Verify via:
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8003/health" -Method Get
```

#### If SOCKS5 (:18090) is Down:
Spawn the SOCKS5 proxy daemon in WSL:
```powershell
# Run as daemon via run_command (IsDaemon=true)
wsl -e node /mnt/g/WECRYP/cloudflared/mullvad-standalone-socks.js
```

#### If Proxy Bouncer (:3010) is Down:
Verify the local bouncer process or launch via `launch_dev.bat`.

### Step 3: Logging to Memory
When a new milestone occurs:
1. Append the new entry to `G:/WECRYP/claude-mem`.
2. Sync to WSL:
   ```powershell
   wsl -e cp /mnt/g/WECRYP/claude-mem /home/mauro/claude-mem
   ```
3. Do NOT commit `claude-mem` to git (it is preserved in `.gitignore`).

---

## Constraints & Golden Rules
- **Anchor**: Exclusively `G:\WECRYP` on host and `/mnt/g/WECRYP` in WSL.
- **Feed Integrity**: Permanent ban on Google Finance; exclusively live exchange tape via Mullvad Sweden egress (`89.37.63.142` / port 3010 / port 18090).
- **Anti-Overfitting Rigor**: Maintain regularized bounds on weights and treat overnight Asia session as the baseline volatility floor.
- **Active Branch**: `feat/mullvad-socks-routing-and-jdwalkaz-bridge` tracked on GitHub PR #230 and GitLab MR #30.
