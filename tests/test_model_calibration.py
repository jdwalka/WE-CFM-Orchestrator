import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import calibration_ledger
import prediction_engine


class TailAdjustmentTests(unittest.TestCase):
    def test_either_condition_triggers_bounded_adjustment(self):
        spike_only = prediction_engine.get_tail_diagnostics({
            "late_window_spike_frequency_per_hour": 0.0006,
            "wick_ratio_slope": 0.0,
        })
        self.assertTrue(spike_only["evidence"]["spike_condition_met"])
        self.assertFalse(spike_only["evidence"]["wick_condition_met"])
        self.assertGreater(spike_only["tail_adjustment"], 0.0)
        self.assertLessEqual(
            spike_only["tail_adjustment"],
            prediction_engine.TAIL_ADJUSTMENT_MAX_CENTS,
        )

        wick_only = prediction_engine.get_tail_diagnostics({
            "late_window_spike_frequency_per_hour": 0.0,
            "per_hour": [{"avg_wick_ratio": value} for value in (0, 0, 0, 0, 2)],
        })
        self.assertFalse(wick_only["evidence"]["spike_condition_met"])
        self.assertTrue(wick_only["evidence"]["wick_condition_met"])
        self.assertGreater(wick_only["tail_adjustment"], 0.0)

        both = prediction_engine.get_tail_diagnostics({
            "late_window_spike_frequency_per_hour": 1.2,
            "per_hour": [{"avg_wick_ratio": value} for value in (0, 4, 8, 12, 16)],
            "late_window_spike_frequency_per_hour": 1.0,
            "per_hour": [{"avg_wick_ratio": value} for value in (0, 1, 2, 3, 4)],
        })
        self.assertEqual(
            both["tail_adjustment"],
            prediction_engine.TAIL_ADJUSTMENT_MAX_CENTS,
        )
        self.assertEqual(both["tail_adjustment_cents"], 15.0)
        self.assertFalse(both["evidence"]["requires_both_conditions"])

    def test_adjustment_is_additive_and_capped(self):
        self.assertEqual(prediction_engine._apply_tail_adjustment(0.98, 0.03), 1.0)
        self.assertEqual(prediction_engine._apply_tail_adjustment(0.02, -0.03), 0.0)
        self.assertAlmostEqual(prediction_engine._apply_tail_adjustment(0.40, 0.03), 0.43)

    def test_probability_correction_cannot_exceed_four_times_base(self):
        corrected = prediction_engine._apply_probability_correction(
            0.32177,
            {"correction_factor": 4.7421, "floor": 0.0005},
        )
        self.assertEqual(corrected, 1.0)
        self.assertEqual(
            prediction_engine._apply_probability_correction(0.90, {"correction_factor": 4.7421}),
            1.0,
        )

    def test_settlement_hold_shrinks_small_samples_toward_prior(self):
        hold = prediction_engine._conditional_settlement_hold(
            100.0,
            101.0,
            {
                "windows": [
                    {"prints": [100.5, 100.5, 100.5, 100.5]},
                    {"prints": [100.5, 101.6, 101.7, 101.8]},
                ]
            },
        )
        self.assertEqual(hold["touched_samples"], 2)
        self.assertEqual(hold["estimator"], "empirical_bayes_shrinkage")
        self.assertAlmostEqual(hold["hold_given_touch"], 0.9688, places=4)

    def test_artifact_residual_flags_are_symmetric(self):
        self.assertTrue(prediction_engine._artifact_residual(30.6))
        self.assertTrue(prediction_engine._artifact_residual(-30.6))
        self.assertFalse(prediction_engine._artifact_residual(29.9))


class CalibrationLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.original_db_path = calibration_ledger.DB_PATH
        calibration_ledger.DB_PATH = Path(self.temporary_directory.name) / "ledger.sqlite3"

    def tearDown(self):
        calibration_ledger.DB_PATH = self.original_db_path

    def insert_resolved_prediction(self, connection, suffix, regime, minutes,
                                   probability, touched):
        now = datetime.now(timezone.utc)
        key = calibration_ledger._prediction_key(now, suffix, now + timedelta(hours=1))
        calibration_ledger.record_prediction(
            timestamp=now,
            band=suffix,
            low=100.0,
            high=101.0,
            expiry=now + timedelta(hours=1),
            p_touch=probability,
            p_normal=probability,
            p_student_t=probability,
            tail_adjustment=0.0,
            alt_aligned=False,
            minutes_to_expiry=minutes,
            p_base=probability,
            p_calibrated=probability,
            calibration_factor=1.0,
            regime=regime,
        )
        connection.execute(
            """
            UPDATE predictions
            SET touched=?, resolved_at_utc=?, brier=?, normal_brier=?
            WHERE prediction_key=?
            """,
            (touched, now.isoformat(), (probability - touched) ** 2,
             (probability - touched) ** 2, key),
        )
        connection.commit()

    def test_probability_correction_blends_windows_and_enforces_max_factor(self):
        now = datetime.now(timezone.utc)
        for index in range(200):
            timestamp = now - timedelta(minutes=index)
            expiry = timestamp + timedelta(hours=1)
            calibration_ledger.record_prediction(
                timestamp=timestamp,
                band=f"dual-window-{index}",
                low=100.0,
                high=101.0,
                expiry=expiry,
                p_touch=0.01,
                p_normal=0.01,
                p_student_t=0.01,
                tail_adjustment=0.0,
                alt_aligned=False,
                minutes_to_expiry=30,
                p_base=0.01,
                p_calibrated=0.01,
                calibration_factor=1.0,
            )

        with calibration_ledger._connect() as connection:
            calibration_ledger._initialize(connection)
            for index in range(200):
                timestamp = now - timedelta(minutes=index)
                expiry = timestamp + timedelta(hours=1)
                band = f"dual-window-{index}"
                key = calibration_ledger._prediction_key(timestamp, band, expiry)
                connection.execute(
                    """
                    UPDATE predictions
                    SET touched=?, resolved_at_utc=?, brier=?, normal_brier=?
                    WHERE prediction_key=?
                    """,
                    (
                        0 if index < 50 else 1,
                        timestamp.isoformat(),
                        (0.01 - (0 if index < 50 else 1)) ** 2,
                        (0.01 - (0 if index < 50 else 1)) ** 2,
                        key,
                    ),
                )
            connection.commit()
            correction = calibration_ledger._probability_correction(connection)

        self.assertTrue(correction["active"])
        self.assertEqual(correction["samples"], 100)
        self.assertEqual(correction["correction_factor"], 4.0)
        self.assertEqual(correction["max_factor"], 4.0)
        self.assertEqual(correction["source"], "recent_100_regime_break")
        self.assertTrue(correction["window_blend"]["regime_break"])
        self.assertEqual(correction["window_blend"]["recent_count"], 50)
        self.assertEqual(correction["window_blend"]["recent_raw_ratio"], 0.0)
        self.assertEqual(correction["window_blend"]["older_count"], 150)
        self.assertEqual(correction["window_blend"]["older_raw_ratio"], 100.0)
        self.assertEqual(correction["window_blend"]["window_gap"], 1.0)

    def test_regime_and_expiry_buckets_include_brier_scores(self):
        with calibration_ledger._connect() as connection:
            calibration_ledger._initialize(connection)
            self.insert_resolved_prediction(
                connection, "high-short", "HIGH", 3, 0.80, 1
            )
            self.insert_resolved_prediction(
                connection, "high-mid", "HIGH", 12, 0.20, 0
            )
            self.insert_resolved_prediction(
                connection, "low-short", "LOW", 3, 0.70, 1
            )
            self.insert_resolved_prediction(
                connection, "low-mid", "LOW", 20, 0.30, 0
            )

        report = calibration_ledger.get_calibration_report()
        buckets = report["regime_expiry_buckets"]
        self.assertEqual(set(buckets), {"HIGH", "LOW"})
        self.assertEqual(set(buckets["HIGH"]), {"0-5m", "6-15m"})
        self.assertEqual(set(buckets["LOW"]), {"0-5m", "16-30m"})
        self.assertEqual(buckets["HIGH"]["0-5m"]["brier"], 0.04)
        self.assertEqual(buckets["LOW"]["16-30m"]["brier"], 0.09)
        self.assertEqual(report["distribution_selection"]["active_distribution"], "student_t")

    def test_tail_replay_reduces_gap_without_exceeding_cap(self):
        with calibration_ledger._connect() as connection:
            calibration_ledger._initialize(connection)
            for index in range(12):
                self.insert_resolved_prediction(
                    connection, f"tail-{index}", "HIGH", 3, 0.08, 1 if index < 6 else 0
                )

        report = calibration_ledger.get_calibration_report()
        correction = report["tail_probability_correction"]
        self.assertTrue(correction["active"])
        raw_probability = 0.08
        probability_correction = {
            "correction_factor": correction["factor"],
            "floor": correction.get("floor", 0.0),
        }
        adjusted_probability = prediction_engine._apply_tail_adjustment(
            prediction_engine._apply_probability_correction(
                raw_probability, probability_correction
            ),
            prediction_engine.TAIL_ADJUSTMENT_MAX_CENTS,
        )
        self.assertEqual(adjusted_probability, 0.31)
        self.assertAlmostEqual(0.50 - adjusted_probability, 0.19)


if __name__ == "__main__":
    unittest.main()
