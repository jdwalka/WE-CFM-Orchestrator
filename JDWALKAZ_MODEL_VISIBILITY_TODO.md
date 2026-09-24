# Jdwalkaz Model Visibility & Tail-Risk Upgrade — Master TODO

Source: Jdwalkaz’s grounded model-internals review.

Priority order is intentional: **P0 fixes blind spots that can lose money**,
**P1 adds diagnostic visibility**, and **P2 improves execution-venue context**.

---

## 0. Pre-Work / Model Truth Audit

- [x] **Audit the real probability path in `prediction_engine.py`.**
  - Locate `_band_probability()` and every call in `strike_probs` and `decay_table`.
  - Confirm whether it currently uses:
    - Gaussian normal approximation,
    - fitted Student-t CDF,
    - or a partially wired Student-t helper that is not consumed.
  - Record the result in this file before changing pricing.

- [x] **Remove stale metadata from `model_introspection.py`.**
  - Current parameter metadata says:
    `probability_model: "normal approximation, time-decayed sigma, momentum drift"`.
  - Make this description dynamically match the actual pricing implementation.
  - Never let `/weights` describe a model different from the one running.

- [ ] **Define the canonical model snapshot schema.**
  - Every prediction should carry:
    - `generated_at`
    - `symbol`
    - `expiry`
    - `spot`
    - `band`
    - `p_touch`
    - `p_model`
    - `p_normal`
    - `tail_adjustment`
    - `inputs_used`
    - `model_version`
  - This makes calibration and HUD visibility possible later.

---

## P0-1. Price Fat Tails in the Decay Table

**Goal:** Stop systematically underpricing the exact wick/touch events that cause losses.

- [x] **Wire the fitted Student-t distribution into strike pricing.**
  - Use the existing `student_t_df` fit as the primary tail model.
  - Replace Gaussian band probabilities in:
    - `strike_probs`
    - `decay_table`
  - Keep the normal-model probability available as `p_normal` for comparison.

- [ ] **Implement time-decayed Student-t volatility.**
  - Preserve the current time-decay behavior.
  - Scale the Student-t distribution using the same remaining-time sigma logic.
  - Include momentum drift as before.

- [ ] **Add a Gaussian fallback.**
  - If the Student-t fit is unstable or has insufficient samples:
    - fall back to normal pricing,
    - set `p_model = "normal_fallback"`,
    - expose `tail_model_status: "unstable_fit"`.

- [ ] **Add a normal + jump mixture alternative.**
  - Optional second model:
    - primary Student-t,
    - comparison normal/jump mixture.
  - Output both if feasible:
    - `p_student_t`
    - `p_jump_mixture`

- [x] **Expose the tail comparison in model output.**
  - For every strike:
    - `p_normal`
    - `p_student_t`
    - `tail_delta = p_student_t - p_normal`
    - `tail_premium_cents = tail_delta * 100`
  - This makes tail blindness measurable.

- [x] **Update `/weights` introspection.**
  - Show:
    - `probability_model`
    - `student_t_df`
    - `fit_sample_size`
    - `fit_status`
    - `normal_fallback_active`

- [ ] **Tests**
  - Student-t CDF returns a valid probability for representative z-scores.
  - Tail probability exceeds the normal probability for the same z-score.
  - `df` near 4.62 produces materially fatter tails than normal.
  - Degenerate/insufficient data falls back cleanly.
  - `decay_table` probabilities remain within `[0, 1]` and are monotonic where expected.

**Acceptance**

- Jdwalkaz can say: “This band is priced at 18¢ under Student-t versus 12¢ under normal; the extra 6¢ is tail premium.”

---

## P0-2. Cross-Asset Lead-Lag / Alt Alignment Gate

**Goal:** Formalize the SOL/ETH lead-lag and taker-flow alignment instinct.

- [ ] **Add rolling return blocks.**
  - For SOL, ETH, and BTC:
    - 1m return
    - 5m return
    - 15m return
  - Store timestamps and source venue.

- [ ] **Add taker flow inputs.**
  - Per venue, preferably Binance and OKX:
    - taker buy volume
    - taker sell volume
    - `taker_buy_sell_ratio`
  - Fallback to available venue data and flag `partial_data: true`.

- [ ] **Implement the alignment gate.**
  - Fire only when:
    - SOL and ETH ratios are both `> 0.55`, or
    - both are `< 0.45`,
    - simultaneously,
    - and persist for at least 10 minutes.
  - Output:
    - `aligned: true`
    - `direction: "up" | "down"`
    - `duration_minutes`

- [ ] **Implement lead-lag correlation.**
  - Compute correlation of alt returns at time `t` against BTC returns at:
    - `t+1`
    - `t+2`
    - `t+3`
    - `t+4`
    - `t+5`
  - Report:
    - best lag
    - correlation at that lag
    - sample size
    - confidence/validity flag

- [x] **Create the unified `alt_signal` object.**
  - Schema:
    ```json
    {
      "direction": "up|down|neutral",
      "strength": 0.0,
      "aligned": false,
      "lead_lag_corr": 0.0,
      "best_lag_minutes": null,
      "sol": {
        "return_1m": 0.0,
        "return_5m": 0.0,
        "return_15m": 0.0,
        "taker_buy_sell_ratio": null
      },
      "eth": {
        "return_1m": 0.0,
        "return_5m": 0.0,
        "return_15m": 0.0,
        "taker_buy_sell_ratio": null
      },
      "duration_minutes": 0,
      "data_quality": "full|partial|insufficient"
    }
    ```

- [ ] **Make `aligned: true` a visible warning.**
  - Add `alt_alignment_warning` to the prediction snapshot.
  - Jdwalkaz should explicitly explain whether the gate says pass or warning.

- [ ] **Tests**
  - Aligned up case: both ratios `> 0.55` for 10 minutes.
  - Aligned down case: both ratios `< 0.45` for 10 minutes.
  - Mixed direction case: `aligned: false`.
  - Duration under 10 minutes: `aligned: false`.
  - Missing ETH or SOL data: `data_quality: "partial"` or `"insufficient"`.
  - Lead-lag correlation is stable and correct on synthetic data.

**Acceptance**

- Jdwalkaz can say: “SOL and ETH taker flow are both aligned upward for 12 minutes and SOL leads BTC by 2 minutes; this is an active tail-risk warning.”

---

## P0-3. Calibration Ledger — “Model Right / Tail Arrived”

**Goal:** Stop arguing about whether losses are variance or miscalibration.

- [ ] **Create the prediction ledger.**
  - Store every priced strike:
    - prediction id
    - timestamp
    - symbol
    - band
    - expiry
    - `p_touch`
    - model version
    - inputs used
  - Use SQLite or a durable JSONL file with a small migration-safe schema.

- [x] **Create the outcome ledger.**
  - At expiry, record:
    - whether the band was touched
    - max favorable move
    - max adverse move
    - time of touch
    - spot at expiry
    - settlement source

- [x] **Classify outcomes.**
  - Add explicit labels:
    - `model_right`
    - `model_wrong`
    - `tail_arrived`
    - `model_right_tail_arrived`
    - `model_wrong_no_tail`
  - Define `tail_arrived` using an objective threshold, not vibes.

- [x] **Compute Brier scores.**
  - Overall Brier score.
  - Buckets:
    - all predictions
    - normal-market buckets
    - late-window buckets
    - `tail_arrived`
    - `aligned_alt_signal`
    - Student-t vs normal comparison

- [x] **Track calibration over time.**
  - Rolling windows:
    - last 50
    - last 200
    - all-time
  - Show:
    - Brier score
    - average predicted probability
    - realized frequency
    - calibration gap

- [x] **Expose calibration to Jdwalkaz and the HUD.**
  - Add `/calibration` endpoint.
  - Include a compact calibration block in the model snapshot.
  - Add an MCP tool:
    `get_calibration_report`.

- [ ] **Tests**
  - Perfect predictions get Brier score `0`.
  - Confident wrong predictions get high Brier scores.
  - Outcome joins never duplicate rows.
  - Expiry marking is idempotent.
  - Tail buckets are classified consistently.

**Acceptance**

- Jdwalkaz can say: “Over 200 predictions, late-window tail buckets have Brier 0.31 versus 0.18 overall; the model is underpricing late-window tails.”

---

## P1-4. Weekend / Hour-of-Day Regime Split

**Goal:** Stop calling Saturday liquidity a LOW volatility regime by accident.

- [ ] **Split trailing quantiles by day type.**
  - Add:
    - `trailing_25th_pct_weekday`
    - `trailing_75th_pct_weekday`
    - `trailing_25th_pct_weekend`
    - `trailing_75th_pct_weekend`

- [ ] **Add hour-of-day volatility profile.**
  - Build a 24-hour realized volatility/range profile.
  - Include sample count per bucket.

- [ ] **Use day-type + hour bucket for regime classification.**
  - Compare the current range against the matching:
    - day type
    - hour bucket
  - Add:
    - `regime_reference_bucket`
    - `regime_reference_sample_size`

- [ ] **Keep the old global regime for continuity.**
  - Output:
    - `regime_global`
    - `regime_day_type_hour`
  - Use the refined regime for pricing when sample size is sufficient.

- [ ] **Tests**
  - Weekend-only data returns a valid weekend bucket.
  - Sparse hour buckets degrade to day-type or global classification.
  - Classification flags insufficient sample size.

---

## P1-5. Order Book Depth and Imbalance

**Goal:** Make thin books and wall structures first-class wick-risk inputs.

- [ ] **Add per-venue depth snapshot.**
  - Venues:
    - Coinbase
    - OKX
    - Binance
    - Bybit
  - For each:
    - top-25 bid depth in USD
    - top-25 ask depth in USD
    - depth imbalance ratio
    - source timestamp

- [ ] **Add a wall detector.**
  - Detect a single level exceeding an configurable percentage of total side depth.
  - Output:
    - wall side
    - wall price
    - wall size
    - wall share

- [ ] **Add book pressure metrics.**
  - `bid_ask_depth_ratio`
  - `thin_side_usd`
  - `thin_side_warning`
  - `book_data_age_ms`

- [ ] **Feed book pressure into tail risk.**
  - Do not directly change base probability yet.
  - First expose it in diagnostics.
  - Later use it to scale `tail_adjustment`.

- [ ] **Tests**
  - A 13:1 bid/ask ratio is reported accurately.
  - Wall detection finds an obvious synthetic wall.
  - Missing venue data does not break the snapshot.
  - Stale book data is explicitly flagged.

---

## P1-6. Late-Window Wick Risk in Pricing

**Goal:** Consume the existing wick statistics instead of computing them for display only.

- [x] **Compute wick-ratio trend.**
  - Add:
    - `wick_ratio_current`
    - `wick_ratio_slope`
    - `wick_ratio_5h_trend`
    - `wick_ratio_trend_status`

- [ ] **Compute late-window spike trend.**
  - Add:
    - `late_window_spike_frequency`
    - `late_window_spike_trend`
    - `recent_late_window_spikes`

- [x] **Add `tail_adjustment` to every strike.**
  - Base inputs:
    - late-window spike frequency
    - wick-ratio trend
    - depth imbalance (when available)
  - Output:
    - `tail_adjustment`
    - `p_touch_raw`
    - `p_touch_adjusted`
    - `tail_adjustment_reason`

- [x] **Apply the adjustment to the decay table.**
  - Tail probability should widen as late-window wick pressure rises.
  - Clamp adjustments to prevent unrealistic probabilities.

- [ ] **Tests**
  - Rising wick ratio increases tail probability.
  - Zero late-window spikes produces little or no adjustment.
  - Adjustment is bounded and always leaves probability in `[0, 1]`.
  - Reason string identifies which inputs drove the adjustment.

---

## Calibration Audit — 2026-09-12

- [x] Outcomes resolve over the prediction-to-expiry window, not the following hourly candle.
- [x] Rolling `last_50` / `last_200` windows count resolved outcomes, including newer unresolved rows.
- [x] Tail adjustment requires both late-window spike activity and an elevated wick-ratio slope.
- [x] Wick ratios ignore near-zero bodies and clamp single-candle artifacts.
- [x] Normal-vs-Student-t selection reports a 500-outcome Brier fallback threshold.
- [x] Ladder failures surface through `ladder_feed_status` instead of silent empty arrays.
- [x] Spot output stamps `coinbase_spot_fallback` while retaining BRTI as the canonical source.
- [x] Alt lead-lag output is diagnostic-only until its sign and calibration validate.
- [x] Kalshi settlement metadata distinguishes one-second wicks from sustained final-minute pushes.
- [ ] Add a live BRTI feed and replace the Coinbase spot fallback.
- [ ] Collect enough resolved outcomes to validate or reject the tail-underpricing hypothesis.

## P1-7. Coinbase CFM Contract Quotes

**Goal:** Give Jdwalkaz visibility into the actual Coinbase execution venue.

- [ ] **Find or build the Coinbase event-contract quote source.**
  - Prefer a supported public API.
  - If no API exists, create a careful periodic scraper.
  - Store:
    - band
    - yes bid
    - yes ask
    - expiry
    - scrape timestamp

- [ ] **Normalize the CFM quote ladder.**
  - Match the Kalshi band schema as closely as possible.
  - Include:
    - band low/high
    - bid/ask in cents
    - expiry
    - venue

- [ ] **Add cross-venue comparison.**
  - Compare:
    - Coinbase CFM price
    - Kalshi reference
    - model fair value
  - Output:
    - `executable_price`
    - `reference_price`
    - `model_fair`
    - `edge_vs_reference`
    - `edge_vs_model`

- [ ] **Expose to Jdwalkaz.**
  - Add MCP tool:
    `get_coinbase_cfm_ladder`.
  - Add `/cfm/ladder` endpoint if useful.
  - Include a compact version in the Kodak/model snapshot.

- [ ] **Tests**
  - Quotes normalize to cents.
  - Empty/missing ladders fail gracefully.
  - Stale quotes are visibly aged.

---

## P2-8. Settlement-Window BRTI 1-Second Reads

**Goal:** Measure how much final-minute wicks actually move the 60-second settlement average.

- [ ] **Capture BRTI prints.**
  - Store the last 60 one-second BRTI reads.
  - Include:
    - timestamp
    - BRTI value
    - source
    - data quality

- [ ] **Store the final-minute path each hour.**
  - Keep:
    - 60s average
    - min
    - max
    - final print
    - path range
    - wick impact on average

- [ ] **Compare print versus settlement average.**
  - Output:
    - `settlement_average`
    - `final_print`
    - `average_minus_print`
    - `wick_settlement_drag`

- [ ] **Build historical settlement stats.**
  - Track:
    - frequency that a late wick changes band settlement
    - average basis between final print and 60s average
    - distribution of final-minute range

- [ ] **Expose to Jdwalkaz.**
  - Add:
    - `/brti/settlement`
    - MCP tool `get_settlement_window_stats`

- [ ] **Tests**
  - Exactly 60 prints produce a valid average.
  - Missing prints are flagged rather than silently averaged.
  - Historical stats survive restart.

---

## P2-9. Funding and OI Rate-of-Change

**Goal:** Use positioning deltas, not just levels.

- [ ] **Capture funding history.**
  - Store current and previous funding snapshots.
  - Add:
    - `funding_delta_15m`
    - `funding_delta_30m`
    - `funding_rate`
    - venue

- [ ] **Capture OI history.**
  - Add:
    - `oi_delta_15m`
    - `oi_delta_30m`
    - `oi_current`
    - venue

- [ ] **Add positioning interpretation.**
  - Flag:
    - rapidly rising funding
    - rapidly falling funding
    - OI expansion
    - OI liquidation flush
  - Include confidence and data age.

- [ ] **Expose to Jdwalkaz.**
  - Add:
    - `/positioning`
    - MCP tool `get_positioning_deltas`
  - Include compact values in the main model snapshot.

- [ ] **Tests**
  - Deltas are computed from the correct timestamps.
  - Missing prior snapshots do not fake a delta.
  - Data ages are surfaced.

---

## Model Visibility Layer

These tasks make the model inspectable by both Jdwalkaz and the user.

- [ ] **Add `/model/snapshot`.**
  - Return one combined object:
    - model version
    - parameters
    - fitted distribution
    - current prediction
    - decay table
    - alt signal
    - wick/tail diagnostics
    - depth imbalance
    - regime split
    - calibration summary
    - CFM quotes
    - BRTI settlement window
    - funding/OI deltas

- [ ] **Add `/model/explain`.**
  - For a selected band, return:
    - normal probability
    - Student-t probability
    - tail adjustment
    - final probability
    - contribution of each major input
    - why the model changed the price

- [x] **Add MCP tools.**
  - `get_model_snapshot`
  - `get_model_explanation`
  - `get_alt_signal`
  - `get_tail_diagnostics`
  - `get_book_depth`
  - `get_calibration_report`
  - `get_settlement_window_stats`
  - `get_positioning_deltas`
  - `get_coinbase_cfm_ladder`

- [ ] **Update Jdwalkaz’s prompt/tool description.**
  - Jdwalkaz must know:
    - which tools are available,
    - when to call them,
    - how to explain tail risk,
    - how to report calibration confidence.

- [ ] **Add HUD panels.**
  - Tail premium panel:
    - normal vs Student-t pricing per strike.
  - Alt alignment panel:
    - SOL/ETH returns, flow ratios, aligned flag.
  - Book pressure panel:
    - depth imbalance and walls.
  - Calibration panel:
    - Brier score, buckets, sample count.
  - Settlement panel:
    - BRTI final-minute path and average.

---

## Data Persistence

- [ ] **Choose storage.**
  - SQLite is preferred for:
    - predictions
    - outcomes
    - calibration
    - BRTI settlement history
  - Keep raw JSONL snapshots for audit if useful.

- [ ] **Add retention policy.**
  - Keep at least 90 days of prediction/outcome history.
  - Compact raw prints after retention.

- [ ] **Make persistence restart-safe.**
  - Append before answering where possible.
  - Use idempotent keys:
    - prediction id
    - expiry id
    - settlement id

---

## Test Plan

- [ ] **Unit tests**
  - Student-t math
  - tail adjustment
  - alt alignment
  - lead-lag correlation
  - depth imbalance
  - calibration buckets
  - BRTI settlement average
  - funding/OI deltas

- [ ] **Integration tests**
  - Prediction ledger receives every priced strike.
  - Outcomes resolve after expiry.
  - `/model/snapshot` returns all required fields.
  - Jdwalkaz MCP tool descriptions remain accurate.

- [ ] **Regression tests**
  - Existing hourly range output remains backward compatible.
  - HUD does not break when optional feeds are unavailable.
  - Agent starts if SQLite storage is temporarily unavailable.

- [ ] **Operational validation**
  - Service stays healthy on `127.0.0.1:8002`.
  - No endpoint blocks the agent event loop.
  - No unbounded memory growth from stored prints or predictions.

---

## Release Plan

- [x] **Phase 1 — Blind-Spot Fixes**
  - Student-t pricing
  - Tail adjustment
  - Alt alignment
  - Calibration ledger

- [ ] **Phase 2 — Visibility**
  - Model snapshot/explain endpoints
  - Jdwalkaz MCP tools
  - HUD panels
  - Model metadata truth

- [ ] **Phase 3 — Refinement**
  - Weekend/hour regime
  - Book depth
  - Coinbase CFM quotes
  - BRTI settlement window
  - Funding/OI deltas

---

## Definition of Done

- Jdwalkaz prices strikes using the fitted fat-tail distribution.
- Jdwalkaz sees and explains SOL/ETH lead-lag alignment.
- Every prediction is logged and calibrated against its outcome.
- Model metadata matches the actual implementation.
- Tail adjustments are visible, bounded, and explained.
- The HUD shows normal vs fat-tail pricing and live risk gates.
- Jdwalkaz can explain, with data, whether a loss was:
  - variance,
  - bad calibration,
  - or a priced-but-ignored tail event.
