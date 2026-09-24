import sqlite3
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

import calibration_ledger
from prediction_engine import _apply_probability_correction


OUTCOMES = [
    (0.252, 1),
    (0.041, 0),
    (0.007, 0),
    (0.002, 0),
    (0.001, 0),
    (0.000, 0),
    (0.167, 0),
    (0.026, 0),
    (0.005, 0),
    (0.001, 0),
    (0.000, 0),
    (0.000, 0),
]


class CalibrationTailCorrectionTest(unittest.TestCase):
    def setUp(self):
        self._temporary_directory = TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self._original_db_path = calibration_ledger.DB_PATH
        calibration_ledger.DB_PATH = Path(self._temporary_directory.name) / "jdwalkaz_calibration.sqlite3"

    def tearDown(self):
        calibration_ledger.DB_PATH = self._original_db_path

    def _build_ledger(self):
        now = datetime.now(timezone.utc)
        initialization_connection = calibration_ledger._connect()
        calibration_ledger._initialize(initialization_connection)
        initialization_connection.close()
        pending_rows = []
        for index, (probability, touched) in enumerate(OUTCOMES):
            timestamp = now - timedelta(minutes=index)
            expiry = timestamp + timedelta(hours=1)
            self.assertTrue(
                calibration_ledger.record_prediction(
                    timestamp=timestamp,
                    band=f"test-{index}",
                    low=77400 + index * 100,
                    high=77500 + index * 100,
                    expiry=expiry,
                    p_touch=probability,
                    p_normal=probability,
                    p_student_t=probability,
                    tail_adjustment=0.0,
                    alt_aligned=False,
                    minutes_to_expiry=60,
                    p_base=probability,
                    p_calibrated=probability,
                    calibration_factor=1.0,
                )
            )
            pending_rows.append(
                (
                    touched,
                    expiry.isoformat(),
                    (probability - touched) ** 2,
                    touched,
                    calibration_ledger._prediction_key(timestamp, f"test-{index}", expiry),
                )
            )
        connection = calibration_ledger._connect()
        for row in pending_rows:
            connection.execute(
                """
                UPDATE predictions
                SET touched=?, resolved_at_utc=?, brier=?,
                    outcome_bucket='model_wrong_underpriced_tail',
                    tail_arrived=?, resolution_source='coinbase_1m_v2'
                WHERE prediction_key=?
                """,
                row,
            )
        connection.commit()
        connection.close()
        return calibration_ledger._connect()

    def test_low_sample_tail_correction_closes_calibration_gap(self):
        connection = self._build_ledger()
        self.addCleanup(connection.close)
        correction = calibration_ledger._tail_probability_correction(connection)
        self.assertTrue(correction["active"])
        self.assertEqual(correction["samples"], 12)
        self.assertGreater(correction["underprediction_gap"], 0.03)
        self.assertLessEqual(correction["factor"], 2.0)

        corrected = [
            _apply_probability_correction(
                probability,
                {
                    "correction_factor": correction["factor"],
                    "floor": calibration_ledger.PROBABILITY_CORRECTION_FLOOR,
                },
            )
            for probability, _ in OUTCOMES
        ]
        realized_frequency = sum(touched for _, touched in OUTCOMES) / len(OUTCOMES)
        corrected_gap = abs(sum(corrected) / len(corrected) - realized_frequency)
        self.assertLess(corrected_gap, 0.02)

    def test_probability_correction_activates_at_twelve_samples(self):
        connection = self._build_ledger()
        self.addCleanup(connection.close)
        correction = calibration_ledger._probability_correction(connection)
        self.assertTrue(correction["active"])
        self.assertEqual(correction["samples"], 12)
        self.assertEqual(correction["min_samples"], 12)


if __name__ == "__main__":
    unittest.main()
