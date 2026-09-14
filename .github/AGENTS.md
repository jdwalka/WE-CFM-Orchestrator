# Custom Agents

This repository includes workspace-specific agents for the WE CFM Orchestrator project.

## Runtime routing (mandatory)

- The Windows host is authoritative. Do development directly in `G:\WECRYP`.
- Do not create persistent files, caches, node modules, databases, logs, archives, or backups under the WSL Linux filesystem.
- Use `/mnt/g/WECRYP` from WSL for every repository operation; temporary WSL paths may be used only for short-lived execution and must be removed when the task completes.
- Do not delete existing WSL files for the purpose of housekeeping; leave current WSL contents untouched unless a task explicitly requires them.

- `WE CFM Orchestrator Agent` — specialized for crypto prediction-market orchestration, signal routing, Kalshi contract alignment, Electron desktop UI, and trading analytics in this codebase.
- `Quant Regime Agent` — specialized for Hurst exponent, variance ratio, entropy, and regime-adaptive quant analysis.
- `Kalshi Orderbook Agent` — specialized for order book depth, bid/ask imbalance, liquidity walls, and execution timing.
- `Smart Money Flow Agent` — specialized for spoofing heuristics, iceberg detection, absorption, delta, and order-flow toxicity.
- `Signal Clarity Agent` — specialized in UP/DOWN, YES/NO, green/red label semantics, confidence presentation, and execution cue clarity.
- `ASI1 GitHub Agent` — reviews pull requests and implements `/asi1 fix` requests from the GitHub UI.
- `Calibration Storage Agent` — specialized in calibration storage errors, D1 migration, and authoritative ledger consolidation.
- `Dependency Independence Agent` — specialized in removing Tauri/GAMD local-proxy coupling from the prediction pipeline.
- `Model Calibration Agent` — specialized in tail-adjustment tuning, regime-conditional calibration, and backtested probability corrections.
- `Trade Ladder Agent` — specialized in `p_settle`, decay-aware entry scoring, and settlement-venue-aware strike ladders.
- `Signal Hygiene Agent` — specialized in gating unstable lead-lag, wick-slope, divergence, and funding/OI signals.
- `Worker Health Agent` — specialized in observability, `/health` endpoints, and degraded-state surfacing.

## Security Scanning Policy

- Default GitHub code scanner: **CodeQL** via `.github/workflows/code.yml`.
- Default GitLab SAST scanner: **Semgrep** via `.gitlab-ci.yml`.
- Do not use **HawkScan** or **StackHawk** for routine code changes; use the static scanners above.
