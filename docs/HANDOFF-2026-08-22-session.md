# Handoff — 2026-08-22 session (ASI1/TokenMix, cache tiers, Tailscale split-tunnel)

**Continue in:** WSL, repo `G:\WECRYP` = `/mnt/g/wecryp`. `origin` = `JohnDaWalka/WE-CFM-Orchestrator`, only `main` exists remotely (`dev` was deleted after a squash-merge). `gh` CLI is at `~/.local/bin/gh`, already `gh auth setup-git`'d as `JohnDaWalka` in this WSL session (may not persist to a fresh session — re-auth if `git push`/`gh` fail).

Working tree has ~1100+ **unrelated** uncommitted files (an editor whitespace/line-ending reformat plus other in-progress work, pre-dating this session) — **never** `git add -A`/`git add .` in this repo. Every PR this session was built by `git worktree add /tmp/<name> -b <branch> origin/main`, editing only the intended files fresh there, then commit/push/PR from the worktree. Reuse that pattern.

---

## PRs from this session

| # | Title | State |
|---|-------|-------|
| 97 | fix(polymarket): correct Perps API endpoints to match live docs | **merged** |
| 98 | fix(deps): override tar to 7.5.18+ (Dependabot #532, #458) | **merged** |
| 99 | fix: clean up remaining Kalshi->Polymarket rename bugs | **merged** |
| 101 | feat: 4 Coin Major LLM Inference (BTC/ETH/SOL/XRP) | **merged** |
| 102 | fix(llm): icloud ultra-account metadata in asi1-desk-contract.js | **merged** |
| 103 | fix(cache): probe OneDrive cold-cache targets for writability | **open** |
| 104 | fix(llm): register icloud ASI1 account, TokenMix fallback, primary=asi1 | **open** |
| 105 | docs: this handoff | **open** |
| 106 | feat(network): SwedenSplit lane + Install-Asi1Punch (see below — SwedenSplit itself is dead, punch route is the real fix) | **open** |
| 100 | feat(llm): restore TokenMix as primary, ASI1 fallback | **closed, not merged** — superseded by #104 (same content, `LLM_PRIMARY_PROVIDER` default flipped `tokenmix`→`asi1`) |
| 96 | (issue) bug: Polymarket Perps client polls dead endpoints | tracking issue for #97 |

**Check #103, #104, #105, #106 got merged before trusting `main` reflects current state.** As of this update all four are still open.

---

## ASI1 / TokenMix inference — current state

Three ASI1 accounts exist (`src/infra/asi1-client.js`, `ASI1_ACCOUNTS`), tried in this order:

1. **icloud** (`mauro_fanelli@icloud.com`) — user's new **Pro-tier** account, `secrets/ASI1_ICLOUD.txt` (gitignored, never commit). Only account with real `asi1-ultra` token allowance. Fresh daily quota as of 2026-08-22.
2. **gitgoin** (`gitgoin87@gmail.com`)
3. **mauro** (`maurofanellijr@gmail.com`)

gitgoin/mauro both sit at a hard **0-token "eon"-window cap** on `asi1-ultra` (confirmed live against `api.asi1.ai` — not a temporary rate limit, a plan-tier restriction) and were maxed on daily request quota (1000/1000 `asi1`/`asi1-mini`, 500/500 `asi1-fast`) as of today.

`inferAccountFromLabel()` checks `icloud` **before** the `mauro` substring match — `mauro_fanelli@icloud.com` contains `"mauro"` and would otherwise misfile under the gmail account.

Verified end-to-end (not just curl): `asi1-credit-orchestrator.deskInfer()` for a 15m packet → `model=asi1-ultra account=icloud fallback=false`.

**TokenMix** (`deepseek/deepseek-v4-flash` via `api.tokenmix.ai`) was restored as fallback — real implementation recovered from git history (`a1276d1c^`, before PR #86 deleted it), including the `enable_thinking:false` empty-content fix. **TokenMix's own account is blocked**: HTTP 403 *"Account credits are temporarily unavailable while recent card payments are under review"* — this is on TokenMix's side, not fixable from code; check their dashboard/support. `LLM_PRIMARY_PROVIDER` env var default is `'asi1'` (flip to `'tokenmix'` once their card review clears, if desired).

---

## Cache tiers (hot/warm/cold) — already existed, two real bugs found and fixed

`src/core/tiered-cache.js` (hot = in-memory Map, warm = Redis via IPC, cold = `MultiDriveCache`) and `src/core/multi-drive-cache.js` (cold tier: writes to every local drive + OneDrive + Google Drive + localStorage) both predate this session — this wasn't a build-from-scratch task.

- **Fixed (PR #103):** OneDrive candidates in `multi-drive-cache.js` were added to the write-target list on name-match alone, never probed for writability like Google Drive candidates are. Now probed the same way; a bare `OneDrive` / `OneDrive - Personal` folder is preferred over a work/school variant (`OneDrive - <Org>`) when multiple are signed in.
- **Confirmed live:** OneDrive cold-tier sync is actively working right now under Windows user `gitgo`, personal account **confirmed as `maurofanellijr@gmail.com`** (grepped directly out of OneDrive's own `SyncEngineDatabase.db`/`OCSI.db` — not inferred from folder name). NOT the `ctstate.edu` work/school account, which is also signed in on the same machine. `WE-CRYPTO-CACHE/contract-cache-2h.json` and `WECRYPTO/data/*`/`WECRYPTO/settlement-logs/*` all actively updating, most recent write minutes old at last check.
- **Warm tier (Redis):** fully wired in code (`electron/main.js` → `src/infra/tiered-cache-redis.js`, `electron/preload.js` exposes `window._tieredCacheWarm`), defined as a service in `docker-compose.yml`. **Could not verify it's actually running** — Docker isn't reachable from this WSL distro (separate environment from wherever the Electron app actually runs). User needs to confirm `docker-compose up -d redis` is up on their end.

---

## Tailscale split-tunnel — DONE, superseding everything below this session originally planned

**Correction to the plan below as originally written:** the Cloudflare-side work (Access Application, Gateway FQDN-list audit) is **explicitly deprioritized by the user** — direct quotes from later in the session: *"dont worry about cloudflare"*, *"get over the cloudflare attachment"*, and confirmation that **WeCrypto trading never actually used WARP** — WARP is for a separate tool (LeakSnipe/poker MCP), not WeCrypto. Don't pick the Cloudflare-audit items back up unless the user asks again. The actual mechanism that shipped is pure Tailscale + Mullvad, no Cloudflare involved.

### Root cause found and fixed

The user trades with the Tailscale exit node (Mullvad Stockholm) active system-wide (`RouteAll: true`). That's an all-or-nothing default route — it was dragging `api.asi1.ai` through Stockholm along with the exchange/Polymarket traffic that actually needs it, even though ASI1 was never in `electron/main.js`'s `WECRYPTO_SWEDEN_SOCKS` needle list (that list is real, deliberately curated over 2 months — never blind-trim it).

**Confirmed via Tailscale's own upstream GitHub issues (both still open) that there is no native fix for this:**
- [tailscale/tailscale#11554](https://github.com/tailscale/tailscale/issues/11554) — Mullvad's exit-node integration doesn't advertise its SOCKS5 proxy as a route separable from the exit node itself.
- [tailscale/tailscale#7766](https://github.com/tailscale/tailscale/issues/7766) — "bypass exit nodes for certain domains" — App Connectors are the closest official feature but require a publicly-reachable Linux node, not a fit here.

This was also verified empirically, not just from the issue trackers: a `SwedenSplit` lane was built first (clear the exit node, keep the SOCKS5 env var) on the theory that the app-level SOCKS5 proxy might survive independently — **it doesn't**. Live test: `10.64.0.1:1080 reachable=False` once the exit node is cleared. `SwedenSplit` is dead code left in `Set-WeCryptoLanes.ps1` for the record (its own output tells you this if you run it) — **do not use it expecting it to work**, use `Sweden` instead.

### The actual fix: `Install-Asi1Punch`

Same mechanism the script already used for Cloudflare's WARP ranges (`Install-WarpPunch`): a `/32` host route via the LAN gateway beats any `0.0.0.0/0` default route on prefix length alone, regardless of exit-node state. `Install-Asi1Punch` (new function in `cloudflared/Set-WeCryptoLanes.ps1`) resolves `api.asi1.ai` live against `1.1.1.1` (benchmarked marginally faster than `172.64.36.1`, both tested head-to-head) and adds a persistent (`route -p`) punch route, wired into the `Sweden`, `Together`, and `WarpSweden` lanes.

**Verified live end-to-end, not just in theory:** 340ms+ (Stockholm-tunneled) → **114.5ms** via `Invoke-WebRequest https://api.asi1.ai/v1/models`, with the exit node and Mullvad SOCKS5 both still fully intact for the needled exchange/Polymarket domains (confirmed `170.62.100.249`, Mullvad AS212238, Stockholm still showing as the general egress IP).

The `Sweden` lane also had its WARP calls (`$warp mode warp+doh`, `$warp vnet $SwedenVnet`) stripped entirely — WeCrypto trading is Tailscale + Mullvad SOCKS5 only now, no Cloudflare/WARP dependency (WARP "drops off," per the user, and is reserved for LeakSnipe).

**Landed in PR #106**, live in `G:\WECRYP` right now (this was applied directly to the real machine during the session, not just committed to git).

### DNS — also fixed and live

- Tailnet global nameservers set to **Mullvad** (`194.242.2.2` + `2a07:e340::2`), per explicit instruction ("max out mullvad dns"). Benchmarked head-to-head against Cloudflare 1.1.1.1/Google 8.8.8.8/Quad9 9.9.9.9/CF-Gateway 172.64.36.1 — Mullvad tied for fastest once warmed up (~337-339ms, all measured while behind the exit node, so the WireGuard-to-Stockholm hop dominates and floors everyone close together). Set via `POST /api/v2/tailnet/{tailnet}/dns/nameservers`.
- **Real split DNS achieved** (distinct from the nameserver setting above): the box had a catch-all NRPT rule (`.` → `100.100.100.100`) forcing literally every DNS query through MagicDNS/Mullvad, on top of the correct `.ts.net`-scoped rule that should be the only one. Running `tailscale set --accept-dns=false` on `mauro` removed the catch-all while leaving the `.ts.net` rule intact — confirmed via `Get-DnsClientNrptPolicy` before/after. This is a genuinely different fix from the ASI1 punch route above (DNS *resolution* path vs. actual *traffic* path) and both were needed.
- Tailscale DNS search paths checked (`GET /api/v2/tailnet/{tailnet}/dns/searchpaths` → `{"searchPaths":["ts.net"]}`, the auto-managed MagicDNS entry, not user-removable). **Not relevant to the speed problem** — search domains only expand unqualified (no-dot) hostnames, never touch fully-qualified names like `api.asi1.ai` or any exchange domain. Nothing to do here unless the user names a specific new domain to add.

### ACL — already correct, no changes needed

Full `grants` section audited (was left half-reviewed in an earlier version of this doc): `svc:wecrypto` grant (443, from `autogroup:member`/`tag:trading`/`tag:core`/`tag:research`), subnet route grant (`192.168.18.0/24`, from `autogroup:member`/`tag:trading`/`tag:core`), `tag:exit-node` → `autogroup:internet`, plus the admin/trading/research tag grants — all present and correctly scoped. The ACL patch work described in `docs/HANDOFF-wsl-tailscale-warp-stack.md` had already landed in a prior session; nothing left to do there.

### Not done, no longer in scope unless asked again

- Cloudflare Access Application for `wecrypto.leaksnipe.win` — deprioritized, see correction note at the top of this section.
- Cloudflare Gateway FQDN-list domain-by-domain audit — same.
- Tailscale Serve verification (`https://mauro.prairiedog-godzilla.ts.net/`) — not re-checked this session, was working as of the prior handoff doc, probably still fine, just not re-verified.
- Windows desktop app build (`npm run build:installer`) — infra exists (`electron-builder` + NSIS, `productName: "WE-CRYPTO-Polymarket-v2.15.6"` in `package.json`), stale builds in `dist/` from June still carry the old `WE-CRYPTO-Kalshi-15m-*` filename (only `productName` got renamed). Never got to this — lower priority than the network work, pick up if asked.
- **Rotate/revoke the Tailscale API key** (`tskey-api-kN4aZRZ8NH11CNTRL-…`) — user's own stated intent ("will revoke when done"). It was used extensively this session (devices, routes, ACL, DNS nameservers/searchpaths — all via `Authorization: Bearer` in ephemeral shell commands, never written to a file). Treat as likely-dead in any future session either way.
