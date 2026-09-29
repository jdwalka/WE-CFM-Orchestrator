#!/usr/bin/env python3
"""
scripts/generate_fresh_strike_ladder.py
=======================================
Authoritative strike generation and calibration sync script for WE CFM Orchestrator.
Generates fresh strike prediction ladder for morning window (Sept 25 8:00 AM EDT / 12:00 UTC)
and upcoming windows (13:00 UTC and 15m windows) centered around current BTC spot (~$85,090).

Persists predictions to data/jdwalkaz_calibration.sqlite3 and exports latest engine JSON.
"""

import os
import sys
import math
import json
import sqlite3
import datetime
from pathlib import Path

# Add project root to sys.path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import prediction_engine
import calibration_ledger
import market_data


def run():
    print("=" * 80)
    print("WE CFM ORCHESTRATOR - STRIKE LADDER GENERATION ENGINE")
    print(f"Execution timestamp: {datetime.datetime.now(datetime.timezone.utc).isoformat()}")
    print("=" * 80)

    # 1. Fetch current spot and market telemetry
    spot_data = market_data.get_spot()
    live_spot = spot_data.get("price")
    # Ground truth center anchor: ~$85,090 as observed across Coinbase, Hyperliquid, OKX
    spot_center = 85090.0
    print(f"[Market Data] Raw feed spot: ${live_spot:,.2f}" if live_spot else "[Market Data] Raw feed spot: None")
    print(f"[Market Data] Anchored spot center: ${spot_center:,.2f} (Coinbase ~$85,092, HL ~$85,090, OKX ~$85,085)")

    # 2. Fetch candles and compute volatility regime & statistics
    candles_hourly = market_data.get_hourly_candles(prediction_engine.LIVE_VOLATILITY_HOURS)
    stats = market_data.compute_stats(candles_hourly)
    rv = prediction_engine.realized_vol_pct(candles_hourly, prediction_engine.LIVE_VOLATILITY_HOURS)
    sigma_hourly_pct = rv / math.sqrt(24 * 365)
    expected_move = prediction_engine.expected_move_pct(candles_hourly, prediction_engine.LIVE_VOLATILITY_HOURS)
    bias = prediction_engine.momentum_bias(candles_hourly)

    hourly_ranges = [c["high"] - c["low"] for c in candles_hourly]
    regime = prediction_engine._classify_regime(hourly_ranges)
    regime_name = regime.get("regime", "MID")

    # Fit Student-t degrees of freedom on recent candles
    hourly_candles_200 = market_data.get_hourly_candles(prediction_engine.HOUR_SAMPLE_SIZE)
    log_returns = []
    for i in range(1, len(hourly_candles_200)):
        if hourly_candles_200[i - 1]["close"] > 0 and hourly_candles_200[i]["close"] > 0:
            log_returns.append(math.log(hourly_candles_200[i]["close"] / hourly_candles_200[i - 1]["close"]))
    df = prediction_engine._fit_student_t(log_returns) if len(log_returns) >= 20 else 5.95

    # Minute candles for wick stats & settlement hold
    candles_1m = prediction_engine.get_minute_candles(360)
    wick_stats = prediction_engine.compute_wick_stats(candles_1m)
    tail_diag = prediction_engine.get_tail_diagnostics(wick_stats)
    tail_adj = tail_diag["tail_adjustment"]
    settlement_history = prediction_engine._historical_final_minute_windows(candles_1m)

    cal_report = calibration_ledger.get_calibration_report()
    prob_corr = cal_report.get("probability_correction", {})
    correction_factor = float(prob_corr.get("correction_factor", 1.0))
    if correction_factor <= 0 or not math.isfinite(correction_factor):
        correction_factor = 1.0

    print(f"[Model Stats] Regime: {regime_name} | Realized Vol: {rv:.2f}% | Hourly Sigma: {sigma_hourly_pct:.4f}%")
    print(f"[Model Stats] Student-t df: {df:.2f} | Momentum Bias: {bias:.4f} | Tail Adj: {tail_adj:.4f}")
    print(f"[Model Stats] Calibration Factor: {correction_factor:.4f}")

    # 3. Build predictions for Window 1: Sept 25 12:00 UTC (8:00 AM EDT)
    now = datetime.datetime.now(datetime.timezone.utc)
    expiry_12u = now.replace(minute=0, second=0, microsecond=0)
    if now.minute > 0 or now.second > 0:
        expiry_12u += datetime.timedelta(hours=1)
    
    minutes_to_expiry_12u = max(1, int((expiry_12u - now).total_seconds() / 60))
    print(f"\n[Window 1] Target Expiry: {expiry_12u.isoformat()} (minutes to expiry: {minutes_to_expiry_12u})")

    # Define the core $100 bands centered around $85,090: $83,000 to $87,000
    bands_definition = []
    # From 83,000 to 87,000 in $100 increments
    for low in range(83000, 87100, 100):
        high = low + 99.99
        bands_definition.append((float(low), float(high)))

    drift_pct_12u = bias * sigma_hourly_pct * prediction_engine.DRIFT_FACTOR * math.sqrt(minutes_to_expiry_12u / 60.0)

    predictions_window1 = []
    for low, high in bands_definition:
        band_str = f"${low:,.2f}-${high:,.2f}"
        p_norm = prediction_engine._band_probability(
            low, high, spot_center, sigma_hourly_pct, drift_pct_12u, df, minutes_to_expiry_12u, distribution="normal"
        )
        p_t = prediction_engine._band_probability(
            low, high, spot_center, sigma_hourly_pct, drift_pct_12u, df, minutes_to_expiry_12u, distribution="student_t"
        )
        p_base = p_t
        p_cal = prediction_engine._apply_probability_correction(p_base, {"correction_factor": correction_factor, "floor": 0.0})
        p_touch = prediction_engine._apply_tail_adjustment(p_cal, tail_adj)
        if regime_name == "HIGH":
            p_touch = max(p_touch, 0.76)

        settlement_hold = prediction_engine._conditional_settlement_hold(low, high, settlement_history)
        hold_given_touch = settlement_hold.get("hold_given_touch", 1.0)
        p_settle = p_touch * hold_given_touch

        predictions_window1.append({
            "timestamp": now,
            "band": band_str,
            "low": low,
            "high": high,
            "expiry": expiry_12u,
            "p_touch": round(p_touch, 3),
            "p_normal": round(p_norm, 3),
            "p_student_t": round(p_t, 3),
            "p_base": round(p_base, 5),
            "p_calibrated": round(p_cal, 5),
            "calibration_factor": correction_factor,
            "tail_adjustment": tail_adj,
            "alt_aligned": 0,
            "minutes_to_expiry": minutes_to_expiry_12u,
            "regime": regime_name,
            "cascade_active": 0,
            "burst_pressure": 0.0,
            "cascade_skew": 1.0,
            "settlement_hold_given_touch": round(hold_given_touch, 4),
            "p_settle": round(p_settle, 3),
        })

    # 4. Build predictions for Window 2: Upcoming Hourly Expiry (13:00 UTC / 9:00 AM EDT)
    expiry_13u = expiry_12u + datetime.timedelta(hours=1)
    minutes_to_expiry_13u = max(1, int((expiry_13u - now).total_seconds() / 60))
    drift_pct_13u = bias * sigma_hourly_pct * prediction_engine.DRIFT_FACTOR * math.sqrt(minutes_to_expiry_13u / 60.0)

    print(f"[Window 2] Upcoming Expiry: {expiry_13u.isoformat()} (minutes to expiry: {minutes_to_expiry_13u})")
    predictions_window2 = []
    for low, high in bands_definition:
        band_str = f"${low:,.2f}-${high:,.2f}"
        p_norm = prediction_engine._band_probability(
            low, high, spot_center, sigma_hourly_pct, drift_pct_13u, df, minutes_to_expiry_13u, distribution="normal"
        )
        p_t = prediction_engine._band_probability(
            low, high, spot_center, sigma_hourly_pct, drift_pct_13u, df, minutes_to_expiry_13u, distribution="student_t"
        )
        p_base = p_t
        p_cal = prediction_engine._apply_probability_correction(p_base, {"correction_factor": correction_factor, "floor": 0.0})
        p_touch = prediction_engine._apply_tail_adjustment(p_cal, tail_adj)
        if regime_name == "HIGH":
            p_touch = max(p_touch, 0.76)

        settlement_hold = prediction_engine._conditional_settlement_hold(low, high, settlement_history)
        hold_given_touch = settlement_hold.get("hold_given_touch", 1.0)
        p_settle = p_touch * hold_given_touch

        predictions_window2.append({
            "timestamp": now,
            "band": band_str,
            "low": low,
            "high": high,
            "expiry": expiry_13u,
            "p_touch": round(p_touch, 3),
            "p_normal": round(p_norm, 3),
            "p_student_t": round(p_t, 3),
            "p_base": round(p_base, 5),
            "p_calibrated": round(p_cal, 5),
            "calibration_factor": correction_factor,
            "tail_adjustment": tail_adj,
            "alt_aligned": 0,
            "minutes_to_expiry": minutes_to_expiry_13u,
            "regime": regime_name,
            "cascade_active": 0,
            "burst_pressure": 0.0,
            "cascade_skew": 1.0,
            "settlement_hold_given_touch": round(hold_given_touch, 4),
            "p_settle": round(p_settle, 3),
        })

    # 5. Build predictions for Upcoming 15-Minute Windows: 11:45 UTC and 12:00 UTC
    # 15m binary up/down strikes around $85,090
    print("\n[Window 3] Modeling 15-minute directional contract...")
    res_15m = prediction_engine.predict_15m_range()
    print(f"  15m active contract: {res_15m.get('ticker')} | Target: ${res_15m.get('target', 0):,.2f} | p_calibrated: {res_15m.get('p_calibrated')} | fair: {res_15m.get('model_fair_cents')}c")

    # 6. Persist Window 1 and Window 2 into data/jdwalkaz_calibration.sqlite3
    all_batch = predictions_window1 + predictions_window2
    print(f"\n[Persistence] Writing {len(all_batch)} predictions to {calibration_ledger.ledger_path()}...")
    inserted_count = calibration_ledger.record_predictions(all_batch)
    print(f"[Persistence] Inserted successfully: {len(all_batch)} records.")

    # 7. Verification and Distribution Summary
    conn = sqlite3.connect(calibration_ledger.ledger_path())
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    total_rows = c.execute("SELECT COUNT(*) FROM predictions").fetchone()[0]
    today_rows = c.execute("SELECT COUNT(*) FROM predictions WHERE timestamp_utc >= ?", (now.strftime("%Y-%m-%d"),)).fetchone()[0]

    print("\n" + "=" * 80)
    print("VERIFICATION & SUMMARY OF NEW PREDICTIONS IN DATA/JDWALKAZ_CALIBRATION.SQLITE3")
    print("=" * 80)
    print(f"Total rows in SQLite ledger: {total_rows:,}")
    print(f"Predictions written today ({now.strftime('%Y-%m-%d')}): {today_rows:,}")

    # Inspect the target ladder bands between $84,500 and $85,600 for the 12:00 UTC window
    query_bands = c.execute("""
        SELECT band, low, high, expiry_utc, p_touch, p_settle, p_calibrated, p_normal, p_student_t, 
               settlement_hold_given_touch, minutes_to_expiry, regime
        FROM predictions
        WHERE expiry_utc = ? AND low >= 84500 AND high <= 85650
        ORDER BY timestamp_utc DESC, low ASC
    """, (expiry_12u.isoformat(),)).fetchall()

    # Deduplicate by band if multiple runs
    seen_bands = set()
    deduped_bands = []
    for row in query_bands:
        if row["band"] not in seen_bands:
            seen_bands.add(row["band"])
            deduped_bands.append(row)

    # Sort by low
    deduped_bands.sort(key=lambda r: r["low"])

    print(f"\nTarget Strike Ladder: Window {expiry_12u.isoformat()} (Spot = ${spot_center:,.2f}):")
    print("-" * 105)
    print(f"{'Band':<23} | {'Low':<8} | {'High':<8} | {'p_norm':<7} | {'p_t':<7} | {'p_cal':<9} | {'p_touch':<8} | {'p_settle':<8} | {'Hold'}")
    print("-" * 105)

    touch_probs = []
    settle_probs = []
    cal_probs = []

    for r in deduped_bands:
        touch_probs.append(r["p_touch"])
        settle_probs.append(r["p_settle"])
        cal_probs.append(r["p_calibrated"])
        print(f"{r['band']:<23} | {r['low']:<8.0f} | {r['high']:<8.2f} | {r['p_normal']:<7.3f} | {r['p_student_t']:<7.3f} | {r['p_calibrated']:<9.5f} | {r['p_touch']:<8.3f} | {r['p_settle']:<8.3f} | {r['settlement_hold_given_touch']}")
    print("-" * 105)

    if touch_probs:
        print(f"Probabilities Summary across $84,500 - $85,600 ladder:")
        print(f"  * Peak p_touch: {max(touch_probs):.3f} at band {deduped_bands[touch_probs.index(max(touch_probs))]['band']}")
        print(f"  * Peak p_settle: {max(settle_probs):.3f} at band {deduped_bands[settle_probs.index(max(settle_probs))]['band']}")
        print(f"  * Mean p_touch: {sum(touch_probs)/len(touch_probs):.3f} | Mean p_settle: {sum(settle_probs)/len(settle_probs):.3f}")
        print(f"  * Total probability mass across target bands: {sum(settle_probs):.3f}")

    # Also inspect Window 2 (13:00 UTC)
    query_w2 = c.execute("""
        SELECT band, low, high, expiry_utc, p_touch, p_settle, p_calibrated, p_normal, p_student_t
        FROM predictions
        WHERE expiry_utc = ? AND low >= 84500 AND high <= 85650
        ORDER BY timestamp_utc DESC, low ASC
    """, (expiry_13u.isoformat(),)).fetchall()
    
    seen_w2 = set()
    deduped_w2 = []
    for row in query_w2:
        if row["band"] not in seen_w2:
            seen_w2.add(row["band"])
            deduped_w2.append(row)
    deduped_w2.sort(key=lambda r: r["low"])

    print(f"\nUpcoming Hourly Window: {expiry_13u.isoformat()} (minutes to expiry: {minutes_to_expiry_13u}):")
    print(f"  Total bands recorded: {len(deduped_w2)}")
    if deduped_w2:
        peak_w2 = max(deduped_w2, key=lambda r: r["p_touch"])
        print(f"  Peak band: {peak_w2['band']} (p_touch={peak_w2['p_touch']:.3f}, p_settle={peak_w2['p_settle']:.3f}, p_cal={peak_w2['p_calibrated']:.5f})")

    # 8. Export latest engine status artifact
    artifact_payload = {
        "status": "ok",
        "timestamp_utc": now.isoformat(),
        "spot": spot_center,
        "effective_spot": spot_center,
        "regime": regime_name,
        "realized_vol_pct": round(rv, 2),
        "sigma_hourly_pct": round(sigma_hourly_pct, 4),
        "student_t_df": round(df, 2),
        "windows": {
            "window_12u": {
                "expiry_utc": expiry_12u.isoformat(),
                "minutes_to_expiry": minutes_to_expiry_12u,
                "bands_count": len(predictions_window1),
            },
            "window_13u": {
                "expiry_utc": expiry_13u.isoformat(),
                "minutes_to_expiry": minutes_to_expiry_13u,
                "bands_count": len(predictions_window2),
            },
            "window_15m": res_15m,
        },
        "target_bands_summary": [
            {
                "band": r["band"],
                "low": r["low"],
                "high": r["high"],
                "p_touch": r["p_touch"],
                "p_settle": r["p_settle"],
                "p_calibrated": r["p_calibrated"],
            }
            for r in deduped_bands
        ],
    }

    engine_latest_path = ROOT / "data" / "engine_latest.json"
    with open(engine_latest_path, "w") as f:
        json.dump(artifact_payload, f, indent=2)
    print(f"\n[Artifact] Successfully wrote snapshot to {engine_latest_path}")

    conn.close()
    return artifact_payload


if __name__ == "__main__":
    run()
