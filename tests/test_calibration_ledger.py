import importlib.util
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from calibration_ledger import DEFAULT_DB_PATH, _initialize, ledger_path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "merge_calibration_ledgers.py"
SPEC = importlib.util.spec_from_file_location("merge_calibration_ledgers", SCRIPT_PATH)
merge_calibration_ledgers = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(merge_calibration_ledgers)


def prediction_row(key: str, low: float = 1000.0) -> dict:
    timestamp = "2026-01-01T00:00:00+00:00"
    expiry = "2026-01-01T01:00:00+00:00"
    return {
        "prediction_key": key,
        "timestamp_utc": timestamp,
        "band": "test-band",
        "low": low,
        "high": low + 100,
        "expiry_utc": expiry,
        "p_touch": 0.12,
        "p_normal": 0.08,
        "p_student_t": 0.14,
        "tail_adjustment": 1.2,
        "alt_aligned": 1,
        "minutes_to_expiry": 60,
        "model_version": "truffle-tail-v2",
        "touched": 1,
        "resolved_at_utc": expiry,
        "brier": 0.7744,
        "normal_brier": 0.8464,
        "outcome_bucket": "model_right_tail_arrived",
        "resolution_source": "coinbase_1m_v2",
        "outcome_window_start_utc": timestamp,
        "outcome_window_end_utc": expiry,
        "outcome_candles_used": 60,
        "tail_arrived": 1,
        "p_base": 0.14,
        "p_calibrated": 0.12,
        "calibration_factor": 1.0,
    }


def create_ledger(path: Path, rows: list[dict]) -> None:
    with sqlite3.connect(path) as connection:
        _initialize(connection)
        columns = merge_calibration_ledgers.PREDICTION_COLUMNS
        column_list = ", ".join(columns)
        placeholders = ", ".join("?" for _ in columns)
        connection.executemany(
            f"INSERT INTO predictions ({column_list}) VALUES ({placeholders})",
            [tuple(row[column] for column in columns) for row in rows],
        )
        connection.commit()


def read_prediction(path: Path, key: str) -> tuple:
    columns = merge_calibration_ledgers.PREDICTION_COLUMNS
    with sqlite3.connect(path) as connection:
        return connection.execute(
            f"SELECT {', '.join(columns)} FROM predictions WHERE prediction_key=?",
            (key,),
        ).fetchone()


class CalibrationLedgerPathTest(unittest.TestCase):
    def test_environment_variable_configures_ledger_path(self):
        with TemporaryDirectory() as directory:
            configured_path = Path(directory) / "configured.sqlite3"
            with patch.dict("os.environ", {"CALIBRATION_LEDGER_PATH": str(configured_path)}):
                self.assertEqual(ledger_path(), configured_path)

    def test_default_ledger_path_is_used_without_environment_variable(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(ledger_path(), DEFAULT_DB_PATH)


class MergeCalibrationLedgersTest(unittest.TestCase):
    def test_dry_run_reports_plan_without_mutating_target(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.sqlite3"
            source = root / "source.sqlite3"
            shared = prediction_row("shared")
            new = prediction_row("new")
            create_ledger(target, [shared])
            create_ledger(source, [shared, new])

            summary = merge_calibration_ledgers.merge_ledgers(source, target, execute=False)

            self.assertEqual(summary["inserted"], 1)
            self.assertEqual(summary["duplicates"], 1)
            self.assertEqual(summary["conflicts"], 0)
            with sqlite3.connect(target) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM predictions").fetchone()[0], 1)

    def test_execute_inserts_new_rows_and_preserves_resolution_metadata(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.sqlite3"
            source = root / "source.sqlite3"
            shared = prediction_row("shared")
            inserted = prediction_row("inserted")
            create_ledger(target, [shared])
            create_ledger(source, [shared, inserted])

            summary = merge_calibration_ledgers.merge_ledgers(source, target, execute=True)

            self.assertEqual(summary["inserted"], 1)
            self.assertIsNotNone(summary["backup_path"])
            merged_row = read_prediction(target, "inserted")
            source_row = tuple(inserted[column] for column in merge_calibration_ledgers.PREDICTION_COLUMNS)
            self.assertEqual(merged_row, source_row)
            self.assertIn("coinbase_1m_v2", merged_row)

    def test_conflict_aborts_merge_and_leaves_target_unchanged(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.sqlite3"
            source = root / "source.sqlite3"
            target_row = prediction_row("conflicting", low=1000.0)
            source_row = prediction_row("conflicting", low=1001.0)
            create_ledger(target, [target_row])
            create_ledger(source, [source_row])

            with self.assertRaises(merge_calibration_ledgers.MergeConflictError):
                merge_calibration_ledgers.merge_ledgers(source, target, execute=True)

            with sqlite3.connect(target) as connection:
                self.assertEqual(
                    connection.execute("SELECT low FROM predictions WHERE prediction_key='conflicting'").fetchone()[0],
                    1000.0,
                )


if __name__ == "__main__":
    unittest.main()
