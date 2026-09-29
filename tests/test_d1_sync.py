"""
tests/test_d1_sync.py — Unit tests for backfill_calibration_to_d1.py
"""

import os
import sqlite3
import sys
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch, MagicMock

import backfill_calibration_to_d1 as sync_module


class TestD1Sync(unittest.TestCase):
    def setUp(self):
        self.temp_dir = TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_calibration.sqlite3"
        self._init_sqlite()

    def tearDown(self):
        self.temp_dir.cleanup()

    def _init_sqlite(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE predictions (
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
                    tail_adjustment REAL NOT NULL DEFAULT 0,
                    alt_aligned INTEGER NOT NULL DEFAULT 0,
                    minutes_to_expiry INTEGER NOT NULL,
                    model_version TEXT NOT NULL,
                    touched INTEGER,
                    resolved_at_utc TEXT,
                    brier REAL,
                    normal_brier REAL,
                    outcome_bucket TEXT,
                    tail_arrived INTEGER,
                    resolution_source TEXT,
                    outcome_window_start_utc TEXT,
                    outcome_window_end_utc TEXT,
                    outcome_candles_used INTEGER,
                    p_base REAL,
                    p_calibrated REAL,
                    calibration_factor REAL,
                    regime TEXT NOT NULL DEFAULT 'UNKNOWN',
                    time_to_expiry_bucket TEXT NOT NULL DEFAULT '31-60m',
                    cascade_active INTEGER,
                    burst_pressure REAL,
                    cascade_skew REAL,
                    settlement_hold_given_touch REAL,
                    p_settle REAL,
                    final_print_brti REAL,
                    settled INTEGER,
                    settlement_held INTEGER,
                    settle_brier REAL
                )
            """)
            # Insert sample rows
            now = datetime.now(timezone.utc)
            conn.execute("""
                INSERT INTO predictions (
                    prediction_key, timestamp_utc, band, low, high, expiry_utc,
                    p_touch, p_normal, p_student_t, minutes_to_expiry, model_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                f"{now.isoformat()}|$80000-$80100",
                now.isoformat(),
                "$80,000.00-$80,100.00",
                80000.0,
                80100.0,
                (now + timedelta(hours=1)).isoformat(),
                0.25,
                0.20,
                0.25,
                60,
                "truffle-tail-v2"
            ))
            conn.commit()

    def test_staleness_calculation(self):
        now = datetime.now(timezone.utc)
        fresh_ts = (now - timedelta(minutes=5)).isoformat()
        stale_ts = (now - timedelta(minutes=200)).isoformat()

        age, is_stale = sync_module.check_staleness(fresh_ts, max_age_minutes=60)
        self.assertFalse(is_stale)
        self.assertAlmostEqual(age, 5.0, delta=1.0)

        age, is_stale = sync_module.check_staleness(stale_ts, max_age_minutes=60)
        self.assertTrue(is_stale)
        self.assertAlmostEqual(age, 200.0, delta=1.0)

    def test_token_discovery_from_env(self):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "test_token_123"}):
            tok = sync_module.get_default_token()
            self.assertEqual(tok, "test_token_123")

    def test_account_and_database_ids(self):
        with patch.dict(os.environ, {
            "CLOUDFLARE_ACCOUNT_ID": "acct_test",
            "CLOUDFLARE_DATABASE_ID": "db_test"
        }):
            self.assertEqual(sync_module.get_account_id(), "acct_test")
            self.assertEqual(sync_module.get_database_id(), "db_test")

    def test_open_source(self):
        args = MagicMock()
        args.sqlite_path = str(self.db_path)
        desc, q, get_cols = sync_module.open_source(args)
        self.assertIn("local file", desc)
        cols = get_cols("predictions")
        self.assertIn("prediction_key", cols)
        rows = q("SELECT COUNT(*) FROM predictions")
        self.assertEqual(rows[0][0], 1)


if __name__ == "__main__":
    unittest.main()
