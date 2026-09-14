# Calibration Bucket Taskboard

## Completed
- [x] Implement expiry-bucketed posterior correction (`calibration_buckets.py`).
- [x] Add chronological replay harness (`scripts/backtest_calibration_buckets.py`).
- [x] Enforce the pre-registered gate: overall Brier improvement ≥ 0.01 and per-bucket degradation ≤ 0.02.
- [x] Use signed per-bucket `improvement = global_brier - bucketed_brier`.
- [x] Add per-bucket reliability/resolution diagnostics.
- [x] Expose `bucketed_correction` in the calibration report as `report_only`.
- [x] Keep live prediction fairs on the existing global correction.
- [x] Add regression tests for bucket edges, fallback hierarchy, rolling windows, caps, and report behavior.

## Current Gate Result
- Resolved samples: 2,497
- Global Brier: 0.081876
- Bucketed Brier: 0.075539
- Overall improvement: 0.006337
- Max degradation: 0.000048
- Decision: **disabled**, below the 0.01 pre-registered improvement gate

## Next
- [ ] Re-run the replay near 3,000 resolved outcomes.
- [ ] Re-run again near 3,500 resolved outcomes.
- [ ] Enable only after the pre-registered gate passes; do not lower thresholds retroactively.
- [ ] If 0–5m degradation persists, evaluate a pre-registered low-probability scaling floor.
- [ ] After two passing runs, wire `BucketedCalibration` into `prediction_engine.py` behind a feature flag.
- [ ] Rebuild the Electron app so the packaged UI includes the latest source fixes.
