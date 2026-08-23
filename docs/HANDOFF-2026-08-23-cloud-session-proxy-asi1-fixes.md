# Handoff — 2026-08-23 cloud session: proxy circuit breaker + ASI1 HUD fixes

Continues from `docs/HANDOFF-2026-08-23-asi1-hud-incident.md`. This session ran in
a cloud sandbox (no access to `G:\wecryp`, `COPILOT_DEBUG\`, or any `.har` file on
the live Windows box) and worked purely from the git history + what was pasted
into chat. All work is on branch `claude/antigravity-gemini-remediation-t08lj0`,
**PR #113** (draft, not merged — user is holding merge until the live app is
confirmed working).

## What shipped (5 commits, all pushed, CI clean, Sourcery-approved)

1. **`src/infra/proxy-fetch.js` — per-host circuit breaker.** The health dashboard
   showed ~22 unrelated providers (Binance, Coinbase, Etherscan, Alchemy RPC,
   ripple/xrpl nodes, etc.) simultaneously `502 Bad Gateway` while the local proxy
   process itself reported healthy — the proxy's own outbound leg was failing
   (consistent with the box's egress IP being flagged), and every ~20s poll loop
   kept re-hammering the same dead host. Now tracks failures per real upstream
   hostname; after 3 consecutive gateway/timeout errors (502/503/504/522/524) it
   opens a 30s circuit and fails fast with a synthetic 503 instead of re-dispatching.
   Reuses the existing `ApiCircuitBreaker` registry (`src/feeds/api-circuit-breaker.js`).

2. **`src/infra/asi1-client.js` — route mode is now measured, not hardcoded.**
   The old code (and the HUD badge, and `llm_signal_assistant.js`'s diagnostics)
   hardcoded `routeMode: 'native'` unconditionally — a lie whenever the direct-punch
   route silently fell back through a slow tunnel. First attempt measured route
   latency from full chat-completion round-trip time, which is dominated by actual
   LLM inference (observed 45000ms) and always looked "slow" regardless of network
   route — **that was wrong and got corrected in the same session** (commit
   `010ec22`). Final version: a dedicated lightweight raw TCP connect probe against
   the ASI1 host, run independently every 30s (`ASI1_ROUTE_PROBE_INTERVAL_MS`,
   default 30000), decoupled entirely from request/inference time. Classifies
   `native` (<=250ms, `ASI1_NATIVE_LATENCY_THRESHOLD_MS`) vs `fallback` vs `unknown`
   (stale >5min or no data yet). Exposed via `getDiagnostics()` as `routeMode` +
   `lastLatencyMs`.

3. **`src/llm/llm_signal_assistant.js`** — `getDiagnostics()` now passes through
   `asi1Diag.routeMode`/`lastLatencyMs` instead of the hardcoded literal.

4. **`src/ui/network-health-dashboard.js`** — the AI-inference status badge now
   renders the real route mode + measured ms (`native route · 24ms` /
   `tunneled (slow) · 1800ms` / `route unknown`) instead of a permanently-green
   hardcoded "native route" label.

5. **`src/ui/asi1-desk.js`** — the "ASI1 Desk" panel (top-right, model/reasoning
   selectors, "Ask ASI1" button) only ever populated its Latency/Account fields
   when you clicked "Ask ASI1" — which fires a real, quota-costing LLM inference
   call. There was no free way to see current connectivity. Now auto-refreshes
   those fields every 10s from the free TCP-probe diagnostics (`asi1:desk-status`
   IPC → `Asi1Client.getDiagnostics()`), no quota cost. The actual "Ask ASI1"
   trade-signal button is unchanged — still manual/click-only, since that's a real
   paid call.

6. **`mcp-server/server.js`** — removed the dead `wecrypto_tailscale_status` MCP
   tool and its `wecrypto.prairiedog-godzilla.ts.net` fallback origin, now that
   Tailscale has been uninstalled and replaced by the standalone Mullvad tunnel +
   `mullvad-standalone-socks.js` SOCKS5 bridge (see the asi1-hud-incident doc).
   This also removed a **hardcoded Tailscale API key** that was committed as a
   fallback default (`TAILSCALE_API_KEY = process.env.TAILSCALE_API_KEY || 'tskey-...'`)
   — user confirmed it's already revoked. Cloudflare Tunnel / `leaksnipe.win`
   status tooling (WARP-based — user explicitly wants WARP kept for the LeakSnipe
   poker app) was left untouched.

7. **`src/infra/asi1-client.js`** — fixed a stale comment above `ASI1_ACCOUNTS`
   that said "gitgoin first" while the actual array (and thus the actual key
   resolution order in `KEY_ENV_NAMES` / `resolveAsi1ApiKeys()` /
   `readAsi1KeysFromSecrets()`) has always had `icloud` (`mauro_fanelli@icloud.com`,
   user's enterprise/Pro account) listed first. **Verified but not changed**:
   routing already prefers icloud whenever its key is present and not rate-limited
   — no code change was needed there, only the misleading comment.

## Explicitly NOT done — deferred, needs care

- **Broader Tailscale removal.** User wants "all the old Tailscale code" gone
  (frustrated — says it wasted 20+ hrs and broke things tonight). Scoped but not
  executed:
  - `cloudflared/Apply-TailscaleWarpCoexist.ps1`, `Publish-WeCryptoTailscale.ps1`,
    `wecrypto-tailscale-serve.json` — look safely deletable (single-purpose,
    Tailscale-only), **not yet deleted**.
  - `cloudflared/Set-WeCryptoLanes.ps1`, `Finish-WeCryptoStack.ps1`,
    `Split-Beacons.ps1`, `apply-sweden-egress.ps1`, `beacon-identities.json` —
    mixed concerns (WARP + Tailscale + Cloudflare Tunnel all coupled together).
    User wants to **keep WARP** (used for the LeakSnipe poker app at
    `leaksnipe.win`). These need surgical, file-by-file edits to strip only the
    Tailscale-specific pieces (`tailscale set --exit-node=...`,
    `tailscale up`/`status` calls, tailnet ACL tags) while preserving WARP
    include/DoH and the Cloudflare Tunnel origin. Not done — too risky to do
    blind from a cloud sandbox with no way to test PowerShell/Windows networking,
    and the user's other live session was actively mid-edit on
    `Set-WeCryptoLanes.ps1` at the same time.
  - `k8s/00-tailscale-operator.yaml`, `01-connector-sweden-exit.yaml`, and the
    rest of `k8s/*.yaml` + `deploy.ps1`/`deploy.sh` — **untouched, explicitly out
    of scope**. This is a separate Kubernetes/cloud deployment, not part of
    tonight's Windows-box incident. Confirm with user before touching.

- **The `.har` file** — user referenced a new `.har` network-errors file in a
  `COPILOT_DEBUG` folder (path never given — likely `G:\wecryp\COPILOT_DEBUG\` or
  similar). Never obtained; this cloud sandbox has no access to the local
  filesystem. **Read it locally and paste the failing entries (or just run
  the extraction snippet below) into the next session.**

  ```powershell
  $har = Get-Content 'path\to\file.har' -Raw | ConvertFrom-Json
  $har.log.entries | Where-Object { $_.response.status -ge 400 -or $_.response.status -eq 0 } |
    Select-Object @{n='url';e={$_.request.url}}, @{n='status';e={$_.response.status}}, @{n='timeMs';e={$_.time}} |
    ConvertTo-Json -Depth 3
  ```

- **Binance "whole history is fucked up"** — diagnosed earlier in this session as
  downstream of the same network incident (Sweden-exit-node egress IP getting
  flagged by Cloudflare-protected APIs), not a code bug — nothing in the Binance
  history fetch paths (`backtest/backtest-alltime.js`,
  `src/core/predictions/data-fetchers.js`) has changed recently. **Not
  independently verified** against the actual `.har`/COPILOT_DEBUG data — worth
  rechecking once that's available in case there's a real code-level bug too.

- **App not yet confirmed working end-to-end.** User's last words: "the app
  doesnt work yet i wont merge till it works." None of the fixes above have been
  verified live against the running Electron app — only `node -c` syntax checks
  and code-path review from this sandbox. **First step of the next session:
  pull this branch, restart the app, and check the HUD/ASI1 Desk badges actually
  show sane numbers now** (should be low-ms native or clearly-tunneled fallback,
  not a hardcoded lie or a nonsensical 45000ms figure).

## Do not

- Don't merge PR #113 without the user's go-ahead — they were explicit about this.
- Don't touch `k8s/*tailscale*` without separately confirming scope — it's a
  different deployment.
- Don't strip Tailscale out of `Set-WeCryptoLanes.ps1`/`Finish-WeCryptoStack.ps1`/
  `Split-Beacons.ps1` without preserving the WARP/Cloudflare Tunnel logic those
  files also contain — user needs WARP for `leaksnipe.win`.
