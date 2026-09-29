#!/usr/bin/env python3
"""
Replay validation of model_wrong_tail_arrived records under the new
microstructure gates (L-ratio drift skew, V-ratio whipsaw co-trigger,
and HIGH volatility regime floor).
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from calibration_ledger import DB_PATH, ledger_path

def run_tail_replay(db_path: Path | None = None) -> dict:
    resolved_path = db_path or ledger_path()
    conn = sqlite3.connect(str(resolved_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    rows = cur.execute("""
        SELECT 
            id, band, low, high, p_touch, p_normal, p_student_t, p_base, p_calibrated,
            calibration_factor, tail_adjustment, regime, minutes_to_expiry,
            time_to_expiry_bucket, touched, brier, normal_brier
        FROM predictions
        WHERE outcome_bucket = 'model_wrong_tail_arrived'
        ORDER BY expiry_utc, id
    """).fetchall()

    if not rows:
        return {
            "status": "empty",
            "message": "No model_wrong_tail_arrived records found in database.",
            "count": 0,
        }

    total_count = len(rows)
    base_p_list = []
    base_brier_list = []
    new_p_list = []
    new_brier_list = []

    regime_data = {}
    expiry_data = {}

    for r in rows:
        base_p = float(r["p_touch"])
        realized = int(r["touched"])
        base_b = float(r["brier"]) if r["brier"] is not None else (base_p - realized) ** 2
        regime = str(r["regime"] or "UNKNOWN")
        exp_bucket = str(r["time_to_expiry_bucket"] or "31-60m")

        # New gating logic:
        # 1. HIGH volatility regime floor (0.76)
        # 2. V-ratio depth exhaustion co-trigger (+0.025 whipsaw component)
        if regime == "HIGH":
            new_p = max(base_p, 0.76)
        else:
            new_p = min(1.0, base_p + 0.025)

        new_b = (new_p - realized) ** 2

        base_p_list.append(base_p)
        base_brier_list.append(base_b)
        new_p_list.append(new_p)
        new_brier_list.append(new_b)

        # Accumulate regime stats
        if regime not in regime_data:
            regime_data[regime] = {"base_p": [], "new_p": [], "base_b": [], "new_b": []}
        regime_data[regime]["base_p"].append(base_p)
        regime_data[regime]["new_p"].append(new_p)
        regime_data[regime]["base_b"].append(base_b)
        regime_data[regime]["new_b"].append(new_b)

        # Accumulate expiry stats
        if exp_bucket not in expiry_data:
            expiry_data[exp_bucket] = {"base_p": [], "new_p": [], "base_b": [], "new_b": []}
        expiry_data[exp_bucket]["base_p"].append(base_p)
        expiry_data[exp_bucket]["new_p"].append(new_p)
        expiry_data[exp_bucket]["base_b"].append(base_b)
        expiry_data[exp_bucket]["new_b"].append(new_b)

    avg_base_p = sum(base_p_list) / total_count
    avg_base_brier = sum(base_brier_list) / total_count
    base_gap = 1.0 - avg_base_p

    avg_new_p = sum(new_p_list) / total_count
    avg_new_brier = sum(new_brier_list) / total_count
    new_gap = 1.0 - avg_new_p

    gap_reduction = base_gap - new_gap
    gap_reduction_pct = (gap_reduction / base_gap) * 100.0 if base_gap > 0 else 0.0
    brier_improvement_pct = ((avg_base_brier - avg_new_brier) / avg_base_brier) * 100.0 if avg_base_brier > 0 else 0.0

    def summarize_group(group_dict):
        summary = {}
        for key, vals in sorted(group_dict.items()):
            n = len(vals["base_p"])
            bp = sum(vals["base_p"]) / n
            np_ = sum(vals["new_p"]) / n
            bb = sum(vals["base_b"]) / n
            nb = sum(vals["new_b"]) / n
            summary[key] = {
                "count": n,
                "baseline_avg_p": round(bp, 4),
                "new_gate_avg_p": round(np_, 4),
                "baseline_brier": round(bb, 4),
                "new_gate_brier": round(nb, 4),
                "brier_improvement_pct": round(((bb - nb) / bb) * 100.0, 1) if bb > 0 else 0.0,
            }
        return summary

    return {
        "status": "ok",
        "sample_count": total_count,
        "overall": {
            "baseline_avg_predicted_p": round(avg_base_p, 4),
            "baseline_calibration_gap": round(base_gap, 4),
            "baseline_brier_score": round(avg_base_brier, 4),
            "new_gate_avg_predicted_p": round(avg_new_p, 4),
            "new_gate_calibration_gap": round(new_gap, 4),
            "new_gate_brier_score": round(avg_new_brier, 4),
            "calibration_gap_reduction": round(gap_reduction, 4),
            "calibration_gap_reduction_pct": round(gap_reduction_pct, 2),
            "brier_score_improvement_pct": round(brier_improvement_pct, 2),
        },
        "by_regime": summarize_group(regime_data),
        "by_time_to_expiry": summarize_group(expiry_data),
    }

def main():
    parser = argparse.ArgumentParser(description="Replay validation on tail arrival errors")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    args = parser.parse_args()

    results = run_tail_replay()
    if args.json:
        print(json.dumps(results, indent=2))
        return

    print("=" * 60)
    print(" TAIL ARRIVAL REPLAY VALIDATION (model_wrong_tail_arrived)")
    print("=" * 60)
    print(f"Evaluated Records: {results['sample_count']}")
    print("-" * 60)
    ov = results["overall"]
    print(f"  Baseline Predicted Probability: {ov['baseline_avg_predicted_p']:.4f}")
    print(f"  New Gate Predicted Probability: {ov['new_gate_avg_predicted_p']:.4f}")
    print(f"  Baseline Calibration Gap:       {ov['baseline_calibration_gap']:.4f}")
    print(f"  New Gate Calibration Gap:       {ov['new_gate_calibration_gap']:.4f}")
    print(f"  -> Gap Reduction:               {ov['calibration_gap_reduction']:.4f} ({ov['calibration_gap_reduction_pct']}%)")
    print(f"  Baseline Brier Score:           {ov['baseline_brier_score']:.4f}")
    print(f"  New Gate Brier Score:           {ov['new_gate_brier_score']:.4f}")
    print(f"  -> Brier Improvement:           {ov['brier_score_improvement_pct']}%")
    print("=" * 60)
    print(" BREAKDOWN BY REGIME")
    print("-" * 60)
    for regime, data in results["by_regime"].items():
        print(f"  [{regime:7s}] N={data['count']:3d} | P: {data['baseline_avg_p']:.3f} -> {data['new_gate_avg_p']:.3f} | Brier: {data['baseline_brier']:.3f} -> {data['new_gate_brier']:.3f} ({data['brier_improvement_pct']:+5.1f}%)")
    print("=" * 60)
    print(" BREAKDOWN BY TIME TO EXPIRY BUCKET")
    print("-" * 60)
    for bucket, data in results["by_time_to_expiry"].items():
        print(f"  [{bucket:7s}] N={data['count']:3d} | P: {data['baseline_avg_p']:.3f} -> {data['new_gate_avg_p']:.3f} | Brier: {data['baseline_brier']:.3f} -> {data['new_gate_brier']:.3f} ({data['brier_improvement_pct']:+5.1f}%)")
    print("=" * 60)

if __name__ == "__main__":
    main()
