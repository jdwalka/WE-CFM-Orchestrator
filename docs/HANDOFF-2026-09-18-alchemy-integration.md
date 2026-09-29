# Handoff: Alchemy Integration — 2026-09-18

Continuing this work in WSL. This doc captures everything established this
session on the Windows/Electron side so it doesn't need re-deriving.

## Goal

Integrate the full Alchemy API stack (data pulls, webhooks, debug/trace
tooling) across every chain the account key supports (ETH, SOL, BASE, BNB,
DOGE, BTC, HYPE), fill gaps in existing chain-data coverage, and — pending
further WSL-side investigation — surgically connect on-chain signal into
Trufflez without a rebuild.

## Keys

- Current/live key (gitgoin account): `G:\WECRYP\secrets\ALCHEMY-API-KEY-gitgoin.txt`
  → `alch_GfiiCTF-SbEW3LiLXIQ7e`
- Old/legacy key (different account, still hardcoded in 4 files — see Security
  below): `UNcUYppLXPl4s0jAkQe_J`, notes in
  `G:\WECRYP\secrets\ALCHEMY API KEY.txt` (has WSS URLs per chain) and
  `G:\WECRYP\secrets\ALCHEMY-API-KEY.txt`

## Security issues found (fix before/alongside feature work)

1. **Hardcoded Alchemy key** (the old `UNcUYppLXPl4s0jAkQe_J`, shipped in
   client-side/Electron-renderer JS — visible via devtools) in:
   - `src/orbital/alchemy-ws.js` line 14-15 (`ALCHEMY_WSS`/`ALCHEMY_KEY` consts)
   - `src/orbital/chain-router.js` `_getAlchemyKey()` fallback, line ~164
   - `src/feeds/blockchain-scan.js` — same pattern duplicated
   - `src/feeds/portfolio-intel.js` — same pattern duplicated
   Fix: one shared key-resolver module, env → Electron secrets file →
   localStorage, **no hardcoded fallback ever**.
2. **Inconsistent env var naming**: `chain-router.js`/`blockchain-scan.js`
   read `ALCHEMY_API_KEY`; `portfolio-intel.js` reads `window._env?.ALCHEMY_KEY`;
   `wallet-intel-config.js` writes to `localStorage.alchemyApiKey`. Neither
   name appears in `.env.example`. Standardize on `ALCHEMY_API_KEY`.
3. **`src/core/network-health.js`** mislabels public RPC probe results
   (`ethereum.publicnode.com`/`cloudflare-eth.com`) as "Alchemy RPC" in the
   health dashboard — misleading, not just insecure. Fix the label or point
   the probe at a real Alchemy endpoint.
4. **Git remotes have PATs embedded in plaintext URL** in `G:\WECRYP\.git\config`
   — 2 GitHub PATs + 1 GitLab PAT, visible via `git remote -v`. User has
   explicitly deferred rotating these ("not now — proceed with Alchemy
   work") — still outstanding, not forgotten, just deprioritized by user.
5. `src/feeds/blockchain-scan.js` looks like dead/superseded code —
   `chain-router.js` already sets `window.BlockchainScan = ChainRouter` as a
   back-compat alias. Confirm nothing else loads blockchain-scan.js directly
   before deleting.

## Current Alchemy integration state (as of this session)

| File | Role | Alchemy usage |
|---|---|---|
| `src/orbital/alchemy-ws.js` | Browser WS feed | ETH `newHeads` + `alchemy_minedTransactions` only |
| `src/orbital/chain-router.js` | Multi-chain polling router, per-symbol fallback chains (`ROUTES` table) | Alchemy wired as one fallback handler for **ETH and BNB only**; BTC already has an Alchemy Bitcoin endpoint in its fallback chain. **SOL, DOGE, HYPE, BASE do not use Alchemy at all** — BASE isn't in `ROUTES` at all yet. |
| `src/feeds/portfolio-intel.js` | Most complete usage | `alchemy_getTokenBalances`, `alchemy_getAssetTransfers` across BTC/ETH/SOL/BNB/BASE/HYPE |
| `src/feeds/blockchain-scan.js` | Likely dead code | Duplicate of chain-router's old logic |
| `cloudflared/proxy-runner.js` | Local-only HTTP→Mullvad-SOCKS5 bouncer, port 3010 | Has `'alchemy': 'https://eth-mainnet.g.alchemy.com'` in its prefix map — Alchemy traffic already routes through here |

No `eth_getLogs` or `debug_traceTransaction` usage exists anywhere in the
repo. No webhook receiver infrastructure exists anywhere in the repo.

## Live network topology (verified this session, not assumed)

- `cloudflared` tunnel is **actively running**, config at
  `C:\Users\gitgo\.cloudflared\config.yml` (real file, last modified
  2026-09-17 — supersedes the Aug 24 memory saying Cloudflare was
  deprioritized; that applied to a different, earlier plan).
- **`wecrypto.leaksnipe.win` → `https://127.0.0.1:3450`** — the Electron
  companion web service (`electron/wecrypto-web-service.js`, Express, has
  existing `/api/*` GET routes: predictions, signals, settlements, stats,
  network-status). **This is the right home for a new Alchemy webhook
  receiver** — no new tunnel config needed, it's already public.
- **`truffle.leaksnipe.win` → `http://127.0.0.1:8040`** — this is Trufflez's
  real public ingress. Port 8040 on Windows is served by `wslrelay.exe`,
  confirming **Trufflez actually runs inside WSL (Ubuntu)**, not natively on
  Windows, despite `mcp_agent.py` living at `G:\WECRYP\mcp_agent.py` (which
  the Windows filesystem view shows, but the running process is WSL-side).
  Windows port 8002 (what `mcp_agent.py`'s source says it binds) is NOT
  actually Trufflez on this machine right now — that port is occupied by an
  unrelated `svchost.exe`. The HUD component `src/ui/asi1-desk.js` hits
  `127.0.0.1:8002` directly for local use; that only works when WSL is
  actively relaying it through to that port.
- `asi1/gdrive/git/mcproute/mcp-portal.leaksnipe.win` → all `127.0.0.1:8032`
  (currently nothing listening on 8032 in this check — may only run
  on-demand). Shared MCP routing hub, not yet identified in source.
- Config file has a note: *"Token tunnel ignores this file; keep in sync
  with dashboard public hostnames"* — meaning Cloudflare's dashboard may have
  routes (e.g. `audit.leaksnipe.win`, mentioned by user, not in this file)
  that this local YAML doesn't reflect. Not yet verified against the
  dashboard/API.

## Trufflez / ASI1 architecture summary

- `G:\WECRYP\mcp_agent.py` — Fetch.ai uAgent, `name="trufflez"`, trades
  **Kalshi/Polymarket binary prediction contracts** on BTC/crypto price
  ranges (not on-chain DEX activity). ~15 tool schemas: cascade-exhaustion
  audits, cross-venue snapshots, alt-signals, calibration reports, plus tools
  proxied through `LeakSnipeMCPClient` → `leaksnipe-suite.gitgoin87.workers.dev`
  (a Cloudflare Worker).
- Two channels both hit `process_query()`: iPhone via Agentverse mailbox
  (works independent of desktop app), and the HUD (`asi1-desk.js`) via direct
  local HTTP to the agent's own REST layer.
- **Checked the `leaksnipe-suite` Worker's Cloudflare bindings directly — no
  ALCHEMY/RPC/CHAIN/SOLANA/WEBHOOK binding exists.** Its bindings are
  entirely poker/infra-ops (GitHub/GitLab/Tailscale/Cloudflare tokens, D1,
  poker-hand KV/R2) — same surface as the LeakSnipe Suite MCP tool set.
  Same for `wecrypto-cloudflare` (the wildcard catch-all worker that would
  serve `truffle.`/`audit.` subdomains if they had no explicit route) — only
  a D1 binding, nothing chain-related.
- **GitHub code search for "alchemy"/"geyser"/"grpc" across gitgoin87's repos
  hit a rate limit (403) before returning results — UNRESOLVED.** Could not
  rule out on-chain logic baked into worker source without a secret binding
  (e.g. calling free/public RPC endpoints with no key). Retry once rate
  limit clears.
- User states Trufflez "already picks up everything" on-chain via
  `truffle.leaksnipe.win`/`audit.leaksnipe.win` and has "a robust setup" —
  **this has not been verified from the Windows side.** Since Trufflez runs
  in WSL, the actual tool-wiring code needs to be found and read from inside
  WSL (`\\wsl.localhost\Ubuntu\...` or directly once working in a WSL
  session) — this is the next concrete step.
- Trade execution: `src/core/ExecutionEngine.ts`, listens for `EXECUTE_TRADE`
  on an internal `eventBus`, enforces a hard 3% max-drawdown kill switch
  (`triggerKillSwitch` → force-liquidate via `RISK_LIMIT_BREACH`). The
  actual broker order call is a **stub** (comment: "will interface with
  PolymarketRouter or KalshiRouter") — real order placement, if implemented,
  is presumably in `electron/polymarket-clob-manager.js` (unexamined this
  session).

## Backlog / explicitly deferred

- **Solana gRPC (Geyser) node integration** — user asked for this to go on
  the todo list, not implemented yet. Alchemy supports Solana gRPC/Geyser
  streaming; this would be a new addition, no existing code touches it.
- Rotate the 3 exposed git PATs (GitHub ×2, GitLab ×1) — user said "not now."
- Retry GitHub code search (rate-limited this session) for alchemy/geyser/grpc
  hits across gitgoin87 repos.
- Verify Cloudflare dashboard tunnel routes against local `config.yml`
  (the file itself says it may be out of sync for token-based tunnels).
- Identify what's actually on `127.0.0.1:8032` (asi1/mcp-portal hub) — not
  found in source this session.

## Proposed plan (not yet started — pending WSL-side findings)

1. Security remediation (see above) — shared key resolver, kill hardcoded
   fallbacks, standardize env var name, fix network-health.js mislabel.
2. Fill missing chain coverage in `chain-router.js`'s `ROUTES` table: add
   Alchemy fallback handlers for SOL/DOGE/HYPE, add a new BASE route entirely
   (doesn't exist today).
3. New `src/orbital/alchemy-methods.js` — shared wrapper for
   `getBlockByNumber`/`getLogs`/`traceTransaction`(`debug_traceTransaction`,
   `callTracer`)/`getTokenBalances`/`getAssetTransfers`, replacing the
   duplicated ad hoc JSON-RPC calls in chain-router/portfolio-intel.
4. Alchemy Notify webhook receiver on `electron/wecrypto-web-service.js`
   (port 3450, already public at `wecrypto.leaksnipe.win`) — new
   `POST /api/webhooks/alchemy` route, signature-verified via
   `ALCHEMY_WEBHOOK_SIGNING_KEY`. New helper `src/infra/alchemy-webhooks.js`.
5. Trufflez tie-in: **pending WSL investigation** — find and read the actual
   agent code/config in WSL before deciding whether to add a new tool schema
   or whether it's genuinely already wired (per user) and just needs
   surfacing/confirming.
6. Solana gRPC/Geyser — backlog, no timeline yet.

All future edits to `G:\WECRYP` should happen in an isolated git worktree,
not the live checkout — this is a running trading app.
