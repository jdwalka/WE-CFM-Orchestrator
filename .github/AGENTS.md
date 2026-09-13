# Custom Agents

This repository includes workspace-specific agents for the WE CFM Orchestrator project.

- `WE CFM Orchestrator Agent` — specialized for crypto prediction-market orchestration, signal routing, Kalshi contract alignment, Electron desktop UI, and trading analytics in this codebase.
- `Quant Regime Agent` — specialized for Hurst exponent, variance ratio, entropy, and regime-adaptive quant analysis.
- `Kalshi Orderbook Agent` — specialized for order book depth, bid/ask imbalance, liquidity walls, and execution timing.
- `Smart Money Flow Agent` — specialized for spoofing heuristics, iceberg detection, absorption, delta, and order-flow toxicity.
- `Signal Clarity Agent` — specialized for UP/DOWN, YES/NO, green/red label semantics, confidence presentation, and execution cue clarity.

## Security Scanning Policy

- Default GitHub code scanner: **CodeQL** via `.github/workflows/codeql.yml`.
- Default GitLab SAST scanner: **Semgrep** via `.gitlab-ci.yml`.
- Do not use **HawkScan** or **StackHawk** for routine code changes; use the static scanners above.
