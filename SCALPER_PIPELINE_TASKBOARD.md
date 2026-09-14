# Scalper Pipeline Task Board

Generated 2026-09-14 from the live incident review. Owner agents are defined
in `.github/agents/` and listed in `.github/AGENTS.md`.

## Follow-up taskboard
- Expiry-bucketed calibration: see `CALIBRATION_BUCKETS_TASKBOARD.md`.

## Architecture correction (verified live)
- **Ledger split-brain is resolved.** There is one authoritative runtime ledger:
  `G:\WECRYP\data\truffle_calibration.sqlite3` — 2209 predictions / 2137 resolved.
- `wecryp-truffle.service` now imports repo modules first, falls back to the WSL venv for
  bridge modules, and points `CALIBRATION_LEDGER_PATH` at the consolidated ledger.
- `scalper-market-data` is a data proxy Worker, not the prediction engine. It is deployed with
  the `CALIBRATION_DB` D1 binding and full observability.
- The local prediction engine continues to use SQLite; D1 is available for Worker health and
  future Cloudflare-native persistence.
- `scalper-market-data` is a **data proxy Worker** (Coinbase/Kalshi/Polymarket),
  not the prediction engine. Source snapshot: `cloudflare/scalper-market-data/src/index.js`.
- Live Worker version: `7eb4c2a0-0299-430a-a8d9-e731e6352968`.
- D1 database: `scalper-calibration` — `48536b22-03b3-42dd-92fa-44feab144d84`.
- `/health` is healthy and reports storage reachable, calibration available, and fresh spot/ladder feeds.
- The prediction/calibration engine runs locally via Truffle
  (`prediction_engine.py` + `calibration_ledger.py`), not on Workers.

## Fixes

### A0. Ledger split-brain — CRITICAL (Calibration Storage Agent)
- [x] Repoint the Truffle service to import repo modules from `G:\WECRYP`
- [x] Back up and merge the 2173-row WSL ledger into the authoritative repo ledger
- [x] Keep WSL only for the venv; no persistent data under WSL (AGENTS.md routing rule)

### A1. Calibration storage failure — CRITICAL (Calibration Storage Agent)
- [x] Decide D1 vs SQLite: engine is local, so SQLite is the default runtime store
- [x] If D1 is wanted for Cloudflare-native redundancy: create `scalper-calibration` D1
- [x] Bind as `CALIBRATION_DB`; draft schema in `cloudflare/scalper-market-data/schema.sql`
- [x] Degrade to `correction_factor: 1.0` + surfaced error (keep current behavior)

### A2. Tauri DB proxy dependency — HIGH (Dependency Independence Agent)
- [x] Audit `tauri_db_*` calls and local-machine fetches
- [x] Make optional with short timeout + cached-last-good fallback
- [x] Hourly model must not depend on GAMD/laptop uptime

### A3. `we-cfm-orchestrator` observability — LOW (Worker Health Agent)
- [x] Enable observability on `scalper-market-data` (head_sampling_rate 1)
- [x] Flip observability to enabled on `we-cfm-orchestrator` (head_sampling_rate 1)

### A4. Tail adjustment never fires — MEDIUM (Model Calibration Agent)
- [x] Backtest OR-logic with smaller per-condition adjustments vs lower thresholds
- [x] Candidate: spike freq > 0.0005 OR wick slope >= 0.25, cap ±3 cents
- [x] Ship only with backtest evidence

### A5. Lead-lag instability — MEDIUM (Signal Hygiene Agent)
- [x] Extend rolling sample to >= 6h OR exclude `lead_lag_status != "stable"` from output
- [x] Backtest gate before `influence_active` can be true

### A6. Silent degraded output — MEDIUM (Worker Health Agent)
- [x] Add top-level `degraded: true` when calibration is unavailable
- [x] Keep `distribution_selection.reason` but elevate visibility

## Additions

### B1. `p_settle` column — HIGH (Trade Ladder Agent)
- [x] `p_settle = p_touch × P(BRTI 60s average holds | touch)` from historical final-minute prints
- [x] Expose both `p_touch` and `p_settle` on ladder rows

### B2. Cross-venue divergence input — HIGH (Signal Hygiene Agent)
- [x] When divergence exceeds its rolling 90th percentile, widen far tails
- [x] Flag `divergence_regime: "elevated"`

### B3. Regime-conditional calibration — HIGH after A1 (Model Calibration Agent)
- [x] Bucket correction factors by regime (MID/LOW/HIGH) and TTL bucket (20/15/10/5m)
- [x] Store per-bucket Brier scores in the authoritative ledger

### B4. Decay-aware entry scoring — HIGH (Trade Ladder Agent)
- [x] Project fair at T-15m from the decay table
- [x] Emit ranked `edge_at_entry = projected_fair_T15m − current_yes_ask`

### B5. Funding/OI positioning input — MEDIUM (Signal Hygiene Agent)
- [x] Mild skew: positive funding + heavy OI → wider upside tails, and vice versa

### B6. Wick-slope leading indicator — MEDIUM (Signal Hygiene Agent)
- [x] Expose `wick_ratio_5h_trend` standalone with `rising`/`flat`/`falling` status

### B7. Settlement-venue-aware ladder — LOW (Trade Ladder Agent)
- [ ] Separate probabilities for BRTI vs TWAP venues when added to ladder

### B8. Health endpoint — LOW (Worker Health Agent)
- [x] `/health`: storage reachable, last calibration write, feed status, spot freshness

## Execution order
1. A0 + A1 (storage and single authoritative ledger — everything depends on it)
2. A2 (cut local-machine dependency)
3. B1 + B4 (trade-decision changes)
4. A4 + B2 + B3 (model quality)
5. A5 + A6 + B5–B8 (hygiene)

Live actions completed with user approval on 2026-09-14: ledger merge, D1
creation/schema, `scalper-market-data` deployment, and `wecryp-truffle.service`
restart.
