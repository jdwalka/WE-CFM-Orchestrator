-- Calibration schema for the scalper prediction pipeline.
-- Local runtime uses SQLite (data/truffle_calibration.sqlite3); this schema is the D1-compatible equivalent.

CREATE TABLE IF NOT EXISTS calibration_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_utc TEXT NOT NULL,
  regime TEXT NOT NULL DEFAULT 'global',
  brier_score REAL,
  model_right_rate REAL,
  tail_arrival_rate REAL,
  correction_factor REAL NOT NULL DEFAULT 1.0,
  report_json TEXT NOT NULL
);

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
  tail_adjustment REAL NOT NULL DEFAULT 0,
  alt_aligned INTEGER NOT NULL DEFAULT 0,
  regime TEXT NOT NULL DEFAULT 'UNKNOWN',
  minutes_to_expiry INTEGER NOT NULL,
  time_to_expiry_bucket TEXT NOT NULL DEFAULT '31-60m',
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
  cascade_active INTEGER,
  burst_pressure REAL,
  cascade_skew REAL,
  settlement_hold_given_touch REAL,
  p_settle REAL,
  final_print_brti REAL,
  settled INTEGER,
  settlement_held INTEGER,
  settle_brier REAL
);

CREATE INDEX IF NOT EXISTS idx_predictions_expiry ON predictions(expiry_utc);
CREATE INDEX IF NOT EXISTS idx_predictions_resolved ON predictions(resolved_at_utc);
CREATE INDEX IF NOT EXISTS idx_predictions_regime_bucket ON predictions(regime, time_to_expiry_bucket);
