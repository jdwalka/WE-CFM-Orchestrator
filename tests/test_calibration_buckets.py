import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import subprocess
import sys

import calibration_buckets
import calibration_ledger
from calibration_buckets import (
    BucketConfig,
    BucketedCalibration,
    bucket_key,
    replay_resolved_outcomes,
)


class BucketedCalibrationTests(unittest.TestCase):
    def test_bucket_key_matches_expiry_edges(self):
        self.assertEqual(bucket_key(0), "0-5m")
        self.assertEqual(bucket_key(5), "0-5m")
        self.assertEqual(bucket_key(6), "6-15m")
        self.assertEqual(bucket_key(30), "16-30m")
        self.assertEqual(bucket_key(60), "31-60m")
        self.assertEqual(bucket_key(75), "31-60m")

    def test_thin_bucket_falls_back_to_global(self):
        calibration = BucketedCalibration(2.0)
        for _ in range(29):
            calibration.record(0.10, 1, 3, "MID")
        factor, source = calibration.factor_for(3, "MID")
        self.assertEqual(factor, 2.0)
        self.assertEqual(source, "global")

    def test_expiry_bucket_factor_activates_after_min_samples(self):
        calibration = BucketedCalibration(2.0)
        for _ in range(30):
            calibration.record(0.10, 1, 3, "UNKNOWN")
        factor, source = calibration.factor_for(3, "UNKNOWN")
        self.assertGreater(factor, 2.0)
        self.assertLess(factor, 4.0)
        self.assertEqual(source, "regime:UNKNOWN:0-5m")

    def test_regime_layer_takes_priority_over_expiry_layer(self):
        calibration = BucketedCalibration(2.0)
        for _ in range(40):
            calibration.record(0.10, 0, 3, "UNKNOWN")
        for _ in range(40):
            calibration.record(0.10, 1, 3, "MID")
        factor, source = calibration.factor_for(3, "MID")
        self.assertAlmostEqual(factor, 10 / 3)
        self.assertEqual(source, "regime:MID:0-5m")

    def test_rolling_window_drops_old_samples(self):
        calibration = BucketedCalibration(
            1.0,
            BucketConfig(min_samples=2, rolling_window=3),
        )
        calibration.record(0.10, 1, 3, "UNKNOWN")
        calibration.record(0.10, 1, 3, "UNKNOWN")
        calibration.record(0.10, 0, 3, "UNKNOWN")
        calibration.record(0.20, 0, 3, "UNKNOWN")
        calibration.record(0.30, 0, 3, "UNKNOWN")
        stats = calibration.by_expiry["0-5m"]
        self.assertEqual(stats.count, 3)
        self.assertAlmostEqual(stats.sum_predicted, 0.60)
        self.assertEqual(stats.sum_realized, 0)

    def test_apply_respects_floor_and_probability_cap(self):
        calibration = BucketedCalibration(4.0)
        self.assertEqual(calibration.apply(0.0001, 3)["p_calibrated"], 0.0005)
        self.assertEqual(calibration.apply(1.0, 3)["p_calibrated"], 1.0)

    def test_replay_improvement_is_signed_global_minus_bucketed(self):
        rows = [(0.10, 1, 3, "UNKNOWN") for _ in range(40)]
        replay = replay_resolved_outcomes(rows, global_factor=1.0)
        bucket = replay["buckets"]["0-5m"]
        self.assertGreater(replay["overall_improvement"], 0.0)
        self.assertGreater(bucket["improvement"], 0.0)
        self.assertLessEqual(replay["max_bucket_degradation"], 0.02)
        self.assertIn("reliability", bucket["diagnostics"]["bucketed"])
        self.assertIn("resolution", bucket["diagnostics"]["bucketed"])


class BucketedCorrectionReportTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.original_db_path = calibration_ledger.DB_PATH
        calibration_ledger.DB_PATH = Path(self.temporary_directory.name) / "ledger.sqlite3"

    def tearDown(self):
        calibration_ledger.DB_PATH = self.original_db_path

    def test_report_block_activates_after_passing_gate(self):
        now = datetime.now(timezone.utc)
        with calibration_ledger._connect() as connection:
            calibration_ledger._initialize(connection)
            for index in range(40):
                key = calibration_ledger._prediction_key(
                    now, f"band-{index}", now + timedelta(hours=1)
                )
                connection.execute(
                    """
                    INSERT OR IGNORE INTO predictions (
                        prediction_key, timestamp_utc, band, low, high, expiry_utc,
                        p_touch, p_normal, p_student_t, p_base, p_calibrated,
                        calibration_factor, tail_adjustment, alt_aligned,
                        regime, minutes_to_expiry, time_to_expiry_bucket,
                        model_version, touched, resolved_at_utc, brier, normal_brier
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0.81, 0.81)
                    """,
                    (
                        key,
                        now.isoformat(),
                        f"band-{index}",
                        100.0,
                        101.0,
                        (now + timedelta(hours=1)).isoformat(),
                        0.10,
                        0.10,
                        0.10,
                        0.10,
                        0.10,
                        1.0,
                        0.0,
                        0,
                        "UNKNOWN",
                        3,
                        "0-5m",
                        calibration_ledger.MODEL_VERSION,
                        now.isoformat(),
                    ),
                )
            connection.commit()
            report = calibration_ledger._bucketed_correction(connection)

        self.assertTrue(report["active"])
        self.assertEqual(report["live_path"], "active")
        self.assertEqual(report["samples"], 40)
        self.assertIn("current_factors", report)
        self.assertIn("overall_improvement", report)
        self.assertIn("max_bucket_degradation", report)


class ReplayCLITests(unittest.TestCase):
    SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "backtest_calibration_buckets.py"

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.ledger_path = Path(self.temporary_directory.name) / "ledger.sqlite3"

    def insert_resolved_prediction(self, connection, suffix, minutes, probability, touched):
        now = datetime.now(timezone.utc)
        connection.execute(
            """
            INSERT OR IGNORE INTO predictions (
                prediction_key, timestamp_utc, band, low, high, expiry_utc,
                p_touch, p_normal, p_student_t, p_base, p_calibrated,
                calibration_factor, tail_adjustment, alt_aligned,
                regime, minutes_to_expiry, time_to_expiry_bucket,
                model_version, touched, resolved_at_utc, brier, normal_brier
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"cli-{suffix}",
                now.isoformat(),
                suffix,
                100.0,
                101.0,
                (now + timedelta(hours=1)).isoformat(),
                probability,
                probability,
                probability,
                probability,
                probability,
                1.0,
                0.0,
                0,
                "UNKNOWN",
                minutes,
                bucket_key(minutes),
                calibration_ledger.MODEL_VERSION,
                touched,
                now.isoformat(),
                (probability - touched) ** 2,
                (probability - touched) ** 2,
            ),
        )

    def create_ledger(self, count):
        with sqlite3.connect(self.ledger_path) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS predictions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    prediction_key TEXT NOT NULL UNIQUE,
                    timestamp_utc TEXT NOT NULL,
                    band TEXT NOT NULL,
                    low REAL NOT NULL,
                    high REAL NOT NULL,
                    expiry_utc TEXT NOT NULL,
                    p_touch REAL NOT NULL,
                    p_normal REAL NOT NULL,
                    p_student_t REAL NOT NULL,
                    p_base REAL,
                    p_calibrated REAL,
                    calibration_factor REAL,
                    tail_adjustment REAL NOT NULL,
                    alt_aligned INTEGER NOT NULL,
                    regime TEXT NOT NULL DEFAULT 'UNKNOWN',
                    minutes_to_expiry INTEGER NOT NULL,
                    time_to_expiry_bucket TEXT NOT NULL DEFAULT '31-60m',
                    model_version TEXT NOT NULL,
                    touched INTEGER,
                    resolved_at_utc TEXT,
                    brier REAL,
                    normal_brier REAL
                );
                """
            )
            for index in range(count):
                self.insert_resolved_prediction(
                    connection,
                    f"row-{index}",
                    31,
                    0.10,
                    1 if index % 4 == 0 else 0,
                )
            connection.commit()

    def test_checkpoint_mode_skips_before_3000_resolved(self):
        self.create_ledger(40)
        result = subprocess.run(
            [
                sys.executable,
                str(self.SCRIPT_PATH),
                "--ledger",
                str(self.ledger_path),
                "--global-factor",
                "2.3783",
                "--checkpoint",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "checkpoint_not_reached")
        self.assertEqual(payload["checkpoints"], [3000, 3500])

    def test_default_replay_reads_live_global_factor(self):
        self.create_ledger(40)
        result = subprocess.run(
            [
                sys.executable,
                str(self.SCRIPT_PATH),
                "--ledger",
                str(self.ledger_path),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["resolved_count"], 40)
        self.assertIn("checkpoint", payload)


if __name__ == "__main__":
    unittest.main()
