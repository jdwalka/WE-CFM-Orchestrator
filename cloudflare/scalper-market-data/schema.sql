-- Calibration schema for the scalper prediction pipeline.
-- Local runtime uses SQLite; this schema is the D1-compatible equivalent.

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
  minutes_to_expiry INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  touched INTEGER,
  resolved_at_utc TEXT,
  brier REAL,
  normal_brier REAL,
  outcome_bucket TEXT,
  tail_arrived INTEGER
);

CREATE INDEX IF NOT EXISTS idx_predictions_expiry ON predictions(expiry_utc);
CREATE INDEX IF NOT EXISTS idx_predictions_resolved ON predictions(resolved_at_utc);
