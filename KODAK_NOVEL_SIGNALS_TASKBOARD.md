# Kodak Novel Signals Taskboard

## Deployed lane — `kodak-market-archiver`

- [x] Dedicated Cloudflare Worker separated from poker KV.
- [x] `KODAK_KV` namespace (`kodak-market-kv`) and minute cron.
- [x] Per-minute Coinbase/Binance convergence history with gap velocity.
- [x] Liquidation persistence with 15-minute burst pressure.
- [x] Wall snapshot history with pull detection.
- [x] Final-five-minute settlement archive.
- [x] Authorized `POST /collect` plus read-only signal endpoints.
- [x] Regression tests for all four derived signals.

## Agent lanes

### Convergence Velocity Agent
- [ ] Point cron at the existing Kodak collector snapshot URL.
- [ ] Set `MARKET_SNAPSHOT_URL` and, if needed, `MARKET_SNAPSHOT_TOKEN`.
- [ ] Backtest `signal=converging_up` against above-spot strike arrivals.
- [ ] Backtest `signal=diverging` against range widening.
- [ ] Replace the fixed 0.0008 elevation threshold with a rolling 90th percentile.

### Liquidation Cascade Agent
- [ ] Push `binance_liq_feed` events into `POST /collect`.
- [ ] Correlate burst pressure with late-window tail arrivals.
- [ ] Add a gated feature to the tail model once the lead-lag relationship backtests.
- [ ] Tune the $500k burst threshold from the stored history.

### Wall-Pull Agent
- [ ] Emit venue `bid_walls` and `ask_walls` maps as `{ price: size }`.
- [ ] Validate wall pulls against two-minute breaks.
- [ ] Add pull events to the microstructure diagnostics panel.

### Funding Term-Structure Agent
- [ ] Store per-minute funding across all seven venues.
- [ ] Backtest funding spread against volatility expansion.
- [ ] Feed a validated spread term into `volatility_spike_multiplier`.

### Regime Fingerprint Agent
- [ ] Persist `(sigma_hourly, wick_ratio, divergence_pct, funding_spread, hour_of_day)`.
- [ ] Cluster hourly fingerprints and evaluate per-cluster Brier scores.
- [ ] Gate cluster correction factors behind the existing calibration threshold.

### Settlement Model Agent
- [ ] Read the final-five-minute archive from `/settlement`.
- [ ] Replace `settlement_hold_given_touch` with empirical-Bayes shrinkage.
- [ ] Re-run the tail calibration gate after at least one full week of archive rows.
