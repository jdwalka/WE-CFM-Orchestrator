-- calibration_reports: one row per resolved prediction, feeding the
-- correction-factor and Brier replay loops.
CREATE TABLE IF NOT EXISTS calibration_reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id     TEXT NOT NULL UNIQUE,        -- e.g. KXBTC-26SEP1706:76400:A
  model_version     TEXT NOT NULL DEFAULT 'truffle-tail-v2',

  -- Strike identity
  band              TEXT NOT NULL,               -- '$76,400.00-$76,499.99'
  side              TEXT NOT NULL,               -- 'ABOVE_SPOT' | 'BELOW_SPOT'
  low               REAL NOT NULL,
  high              REAL NOT NULL,
  spot_at_prediction REAL NOT NULL,
  minutes_to_expiry INTEGER NOT NULL,

  -- Probability chain (as predicted at entry)
  p_base            REAL NOT NULL,               -- raw distribution prob
  p_calibrated      REAL,                        -- after bucketed factor
  p_final           REAL NOT NULL,               -- post tail/divergence/settle
  correction_factor REAL,                        -- factor applied at prediction time
  calibration_regime TEXT,                       -- e.g. 'expiry:31-60m', 'tail'

  -- Distribution params snapshot
  active_distribution TEXT NOT NULL DEFAULT 'student_t',
  student_t_df      REAL,
  sigma_hourly_pct  REAL,
  tail_adjustment   REAL,
  volatility_spike_multiplier REAL,

  -- Outcome + scoring
  outcome           INTEGER,                     -- 1 = touched/settled YES, 0 = NO
  resolved          INTEGER NOT NULL DEFAULT 0,  -- 0 = pending, 1 = resolved
  brier_model       REAL,                        -- (p_final - outcome)^2
  brier_normal      REAL,                        -- same using p_normal baseline
  settlement_held   INTEGER,                     -- B1: touch-and-hold vs touch-and-revert
  settlement_hold_given_touch REAL,

  -- Regime context at resolution
  regime            TEXT,                        -- 'MID' | 'HIGH' | 'LOW'
  expiry_bucket     TEXT,                        -- '0-5m'|'6-15m'|'16-30m'|'31-60m'
  wick_ratio        REAL,
  cross_venue_divergence_pct REAL,

  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_calrep_resolved_bucket
  ON calibration_reports (resolved, expiry_bucket, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calrep_regime_bucket
  ON calibration_reports (regime, expiry_bucket);
CREATE INDEX IF NOT EXISTS idx_calrep_pending
  ON calibration_reports (resolved, created_at)
  WHERE resolved = 0;

-- Windowed aggregates for the replay gate (bucketed Brier improvement check)
CREATE TABLE IF NOT EXISTS calibration_windows (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  window_type       TEXT NOT NULL,               -- 'recent_50'|'trailing_200'|'bucket:31-60m'|...
  count             INTEGER NOT NULL,
  sum_predicted     REAL NOT NULL,
  sum_realized      REAL NOT NULL,
  raw_ratio         REAL NOT NULL,
  factor            REAL NOT NULL,
  brier_model       REAL,
  brier_normal      REAL,
  whitelisted       INTEGER NOT NULL DEFAULT 0,
  computed_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calwin_type
  ON calibration_windows (window_type, computed_at DESC);
