"""Persistent prediction/outcome ledger for Truffle calibration."""
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import requests

DB_PATH = Path(__file__).with_name("data") / "truffle_calibration.sqlite3"
MODEL_VERSION = "truffle-tail-v2"
_HEADERS = {"User-Agent": "wecryp-truffle/1.0 (+https://agentverse.ai)"}
_TAIL_EVENT_NORMAL_P = 0.20
DISTRIBUTION_FALLBACK_MIN_SAMPLE = 500
DISTRIBUTION_FALLBACK_BRIER_IMPROVEMENT = 0.05
PROBABILITY_CORRECTION_PRIOR_STRENGTH = 200.0
PROBABILITY_CORRECTION_MIN_SAMPLES = 30
PROBABILITY_CORRECTION_MAX_SHRINK = 0.85
PROBABILITY_CORRECTION_FLOOR = 0.0005
TAIL_PROBABILITY_THRESHOLD = 0.20
TAIL_CORRECTION_MIN_SAMPLES = 30
TAIL_CORRECTION_PRIOR_STRENGTH = 100.0
TAIL_CORRECTION_MAX_FACTOR = 5.0


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def _initialize(connection: sqlite3.Connection) -> None:
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
            outcome_candles_used INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_predictions_expiry
            ON predictions(expiry_utc, resolved_at_utc);
        CREATE INDEX IF NOT EXISTS idx_predictions_bucket
            ON predictions(outcome_bucket);
        """
    )
    connection.commit()
    _migrate(connection)


def _migrate(connection: sqlite3.Connection) -> None:
    columns = {
        row[1] for row in connection.execute("PRAGMA table_info(predictions)")
    }
    migrations = {
        "p_base": "ALTER TABLE predictions ADD COLUMN p_base REAL",
        "p_calibrated": "ALTER TABLE predictions ADD COLUMN p_calibrated REAL",
        "calibration_factor": "ALTER TABLE predictions ADD COLUMN calibration_factor REAL",
        "tail_arrived": "ALTER TABLE predictions ADD COLUMN tail_arrived INTEGER",
        "resolution_source": "ALTER TABLE predictions ADD COLUMN resolution_source TEXT",
        "outcome_window_start_utc": "ALTER TABLE predictions ADD COLUMN outcome_window_start_utc TEXT",
        "outcome_window_end_utc": "ALTER TABLE predictions ADD COLUMN outcome_window_end_utc TEXT",
        "outcome_candles_used": "ALTER TABLE predictions ADD COLUMN outcome_candles_used INTEGER",
    }
    for column, statement in migrations.items():
        if column not in columns:
            connection.execute(statement)
    connection.execute(
        "UPDATE predictions SET p_base = COALESCE(p_base, p_student_t) "
        "WHERE p_base IS NULL"
    )
    connection.execute(
        "UPDATE predictions SET calibration_factor = COALESCE(calibration_factor, 1.0) "
        "WHERE calibration_factor IS NULL"
    )
    connection.commit()


def _prediction_key(timestamp: datetime, band: str, expiry: datetime) -> str:
    return f"{timestamp.isoformat()}|{band}|{expiry.isoformat()}"


def _fetch_minute_candles(start: datetime, end: datetime) -> list[dict]:
    """Fetch the 1-minute candles that cover [start, end)."""
    try:
        response = requests.get(
            "https://api.exchange.coinbase.com/products/BTC-USD/candles",
            params={"granularity": 60, "start": start.isoformat(), "end": end.isoformat()},
            headers=_HEADERS,
            timeout=15,
        )
        response.raise_for_status()
        cols = ["time", "low", "high", "open", "close", "volume"]
        candles = [dict(zip(cols, row)) for row in response.json()]
        start_epoch = int(start.timestamp())
        end_epoch = int(end.timestamp())
        return [
            candle for candle in candles
            if start_epoch < candle["time"] <= end_epoch
        ]
    except (requests.RequestException, KeyError, ValueError, TypeError):
        return []


def record_prediction(
    timestamp: datetime,
    band: str,
    low: float,
    high: float,
    expiry: datetime,
    p_touch: float,
    p_normal: float,
    p_student_t: float,
    tail_adjustment: float,
    alt_aligned: bool,
    minutes_to_expiry: int,
    p_base: float | None = None,
    p_calibrated: float | None = None,
    calibration_factor: float = 1.0,
) -> bool:
    """Append one prediction; duplicate timestamp/band/expiry rows are ignored."""
    try:
        with _connect() as connection:
            _initialize(connection)
            connection.execute(
                """
                INSERT OR IGNORE INTO predictions (
                    prediction_key, timestamp_utc, band, low, high, expiry_utc,
                    p_touch, p_normal, p_student_t, p_base, p_calibrated,
                    calibration_factor, tail_adjustment, alt_aligned,
                    minutes_to_expiry, model_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _prediction_key(timestamp, band, expiry),
                    timestamp.isoformat(),
                    band,
                    float(low),
                    float(high),
                    expiry.isoformat(),
                    float(p_touch),
                    float(p_normal),
                    float(p_student_t),
                    float(p_base if p_base is not None else p_student_t),
                    float(p_calibrated if p_calibrated is not None else p_touch),
                    float(calibration_factor),
                    float(tail_adjustment),
                    int(alt_aligned),
                    int(minutes_to_expiry),
                    MODEL_VERSION,
                ),
            )
            connection.commit()
        return True
    except sqlite3.Error:
        return False


def _bucket(p_touch: float, p_normal: float, touched: bool) -> str:
    model_right = (p_touch >= 0.5) == touched
    if touched and p_normal < _TAIL_EVENT_NORMAL_P:
        return "model_right_tail_arrived" if model_right else "model_wrong_tail_arrived"
    if touched and p_normal < 0.5:
        return "model_right_underpriced_tail" if model_right else "model_wrong_underpriced_tail"
    return "model_right" if model_right else "model_wrong"


def resolve_pending_predictions() -> int:
    """Resolve predictions against the price path from prediction time to expiry."""
    now = datetime.now(timezone.utc)
    try:
        with _connect() as connection:
            _initialize(connection)
            rows = connection.execute(
                """
                SELECT id, low, high, timestamp_utc, expiry_utc, p_touch, p_normal
                FROM predictions
                WHERE (resolved_at_utc IS NULL OR resolution_source IS NULL
                       OR tail_arrived IS NULL)
                  AND expiry_utc < ?
                ORDER BY expiry_utc
                LIMIT 200
                """,
                (now.isoformat(),),
            ).fetchall()
    except sqlite3.Error:
        return 0

    if not rows:
        return 0

    candle_cache = {}
    resolved = 0
    for prediction_id, low, high, timestamp_text, expiry_text, p_touch, p_normal in rows:
        expiry = datetime.fromisoformat(expiry_text)
        timestamp = datetime.fromisoformat(timestamp_text)
        if expiry <= timestamp:
            continue
        candle_key = (timestamp.isoformat(), expiry.isoformat())
        if candle_key not in candle_cache:
            candle_cache[candle_key] = _fetch_minute_candles(timestamp, expiry)
        candles = candle_cache[candle_key]
        if not candles:
            continue
        touched = any(candle["high"] >= low and candle["low"] <= high for candle in candles)
        bucket = _bucket(float(p_touch), float(p_normal), touched)
        brier = (float(p_touch) - (1 if touched else 0)) ** 2
        normal_brier = (float(p_normal) - (1 if touched else 0)) ** 2
        try:
            with _connect() as connection:
                _initialize(connection)
                connection.execute(
                    """
                    UPDATE predictions
                    SET touched=?, resolved_at_utc=?, brier=?, normal_brier=?,
                        outcome_bucket=?, tail_arrived=?, resolution_source=?,
                        outcome_window_start_utc=?, outcome_window_end_utc=?,
                        outcome_candles_used=?
                    WHERE id=? AND (resolved_at_utc IS NULL OR resolution_source IS NULL
                                    OR tail_arrived IS NULL)
                    """,
                    (
                        int(touched),
                        now.isoformat(),
                        brier,
                        normal_brier,
                        bucket,
                        int(touched and float(p_normal) < _TAIL_EVENT_NORMAL_P),
                        "coinbase_1m_v2",
                        timestamp.isoformat(),
                        expiry.isoformat(),
                        len(candles),
                        prediction_id,
                    ),
                )
                connection.commit()
            resolved += 1
        except sqlite3.Error:
            continue
    return resolved


def _window_stats(connection: sqlite3.Connection, where: str, args: tuple = ()) -> dict:
    rows = connection.execute(
        f"""
        SELECT COUNT(*), AVG(p_touch), AVG(touched), AVG(brier), AVG(normal_brier)
        FROM predictions
        WHERE resolved_at_utc IS NOT NULL {where}
        """,
        args,
    ).fetchone()
    count, avg_p, realized, brier, normal_brier = rows
    if not count:
        return {"count": 0}
    return {
        "count": int(count),
        "avg_predicted_probability": round(float(avg_p or 0), 4),
        "realized_frequency": round(float(realized or 0), 4),
        "calibration_gap": round(float((realized or 0) - (avg_p or 0)), 4),
        "brier": round(float(brier or 0), 4),
        "normal_brier": round(float(normal_brier or 0), 4),
    }


def _probability_correction(connection: sqlite3.Connection) -> dict:
    """Empirical-Bayes shrinkage of raw model probabilities toward outcomes."""
    row = connection.execute(
        """
        SELECT COUNT(*), SUM(p_base), SUM(touched)
        FROM (
            SELECT p_base, touched
            FROM predictions
            WHERE resolved_at_utc IS NOT NULL AND p_base IS NOT NULL
            ORDER BY resolved_at_utc DESC, id DESC
            LIMIT 200
        )
        """
    ).fetchone()
    sample_count, predicted_sum, realized_sum = row
    sample_count = int(sample_count or 0)
    predicted_sum = float(predicted_sum or 0.0)
    realized_sum = float(realized_sum or 0.0)

    if sample_count < PROBABILITY_CORRECTION_MIN_SAMPLES or predicted_sum <= 0:
        return {
            "correction_factor": 1.0,
            "active": False,
            "samples": sample_count,
            "sum_predicted": round(predicted_sum, 4),
            "sum_realized": round(realized_sum, 4),
            "raw_ratio": None,
            "posterior_ratio": 1.0,
            "prior_strength": PROBABILITY_CORRECTION_PRIOR_STRENGTH,
            "min_samples": PROBABILITY_CORRECTION_MIN_SAMPLES,
            "max_shrink": PROBABILITY_CORRECTION_MAX_SHRINK,
            "floor": PROBABILITY_CORRECTION_FLOOR,
            "reason": "insufficient resolved outcomes; correction disabled",
        }

    raw_ratio = realized_sum / predicted_sum
    evidence_weight = sample_count / (sample_count + PROBABILITY_CORRECTION_PRIOR_STRENGTH)
    posterior_ratio = evidence_weight * raw_ratio + (1.0 - evidence_weight)
    correction_factor = max(posterior_ratio, PROBABILITY_CORRECTION_MAX_SHRINK)
    return {
        "correction_factor": round(correction_factor, 4),
        "active": True,
        "samples": sample_count,
        "sum_predicted": round(predicted_sum, 4),
        "sum_realized": round(realized_sum, 4),
        "raw_ratio": round(raw_ratio, 4),
        "posterior_ratio": round(posterior_ratio, 4),
        "prior_strength": PROBABILITY_CORRECTION_PRIOR_STRENGTH,
        "min_samples": PROBABILITY_CORRECTION_MIN_SAMPLES,
        "max_shrink": PROBABILITY_CORRECTION_MAX_SHRINK,
        "floor": PROBABILITY_CORRECTION_FLOOR,
        "reason": (
            "raw realized/predicted ratio blended with a no-bias prior; "
            "factor clamped to prevent small-sample overcorrection"
        ),
    }


def _tail_probability_correction(connection: sqlite3.Connection) -> dict:
    """Empirical correction for the low-probability tail regime.

    This is intentionally separate from the global probability correction:
    the live miscalibration is concentrated in late-window tail events, and a
    global shrink would either overcorrect the mid-band or leave the tail
    regime underpriced. The correction is active only after enough resolved
    low-probability outcomes exist and is bounded so a small bad sample cannot
    turn noise into a trade signal.
    """
    row = connection.execute(
        """
        SELECT COUNT(*), SUM(p_touch), SUM(touched)
        FROM (
            SELECT p_touch, touched
            FROM predictions
            WHERE resolved_at_utc IS NOT NULL AND p_touch < ?
            ORDER BY resolved_at_utc DESC, id DESC
            LIMIT 200
        )
        """,
        (TAIL_PROBABILITY_THRESHOLD,),
    ).fetchone()
    sample_count, predicted_sum, realized_sum = row
    sample_count = int(sample_count or 0)
    predicted_sum = float(predicted_sum or 0.0)
    realized_sum = float(realized_sum or 0.0)

    if sample_count < TAIL_CORRECTION_MIN_SAMPLES or predicted_sum <= 0:
        return {
            "active": False,
            "samples": sample_count,
            "threshold": TAIL_PROBABILITY_THRESHOLD,
            "min_samples": TAIL_CORRECTION_MIN_SAMPLES,
            "max_factor": TAIL_CORRECTION_MAX_FACTOR,
            "factor": 1.0,
            "reason": "insufficient resolved tail outcomes; correction disabled",
        }

    raw_ratio = realized_sum / predicted_sum
    evidence_weight = sample_count / (sample_count + TAIL_CORRECTION_PRIOR_STRENGTH)
    posterior_ratio = evidence_weight * raw_ratio + (1.0 - evidence_weight)
    factor = max(1.0, min(posterior_ratio, TAIL_CORRECTION_MAX_FACTOR))
    return {
        "active": True,
        "samples": sample_count,
        "threshold": TAIL_PROBABILITY_THRESHOLD,
        "sum_predicted": round(predicted_sum, 4),
        "sum_realized": round(realized_sum, 4),
        "raw_ratio": round(raw_ratio, 4),
        "posterior_ratio": round(posterior_ratio, 4),
        "factor": round(factor, 4),
        "max_factor": TAIL_CORRECTION_MAX_FACTOR,
        "reason": (
            "bounded empirical-Bayes correction for the low-probability "
            "late-window regime"
        ),
    }


def get_calibration_report() -> dict:
    """Rolling and bucketed Brier/calibration report for recent predictions."""
    now = datetime.now(timezone.utc)
    resolve_pending_predictions()
    try:
        with _connect() as connection:
            _initialize(connection)
            prediction_count = connection.execute(
                "SELECT COUNT(*) FROM predictions"
            ).fetchone()[0]
            if not prediction_count:
                return {"status": "empty", "model_version": MODEL_VERSION}

            report = {
                "status": "ok",
                "model_version": MODEL_VERSION,
                "windows": {
                    "last_50": _window_stats(
                        connection,
                        "AND id IN (SELECT id FROM predictions "
                        "WHERE resolved_at_utc IS NOT NULL "
                        "ORDER BY resolved_at_utc DESC, id DESC LIMIT 50)",
                    ),
                    "last_200": _window_stats(
                        connection,
                        "AND id IN (SELECT id FROM predictions "
                        "WHERE resolved_at_utc IS NOT NULL "
                        "ORDER BY resolved_at_utc DESC, id DESC LIMIT 200)",
                    ),
                    "all_time": _window_stats(connection, ""),
                },
                "buckets": {},
            }
            buckets = connection.execute(
                "SELECT DISTINCT outcome_bucket FROM predictions "
                "WHERE outcome_bucket IS NOT NULL"
            ).fetchall()
            for (bucket,) in buckets:
                report["buckets"][bucket] = _window_stats(
                    connection, "AND outcome_bucket=?", (bucket,)
                )
            report["alt_alignment"] = {
                "aligned": _window_stats(connection, "AND alt_aligned=1"),
                "not_aligned": _window_stats(connection, "AND alt_aligned=0"),
            }
            report["tail_underpricing"] = _window_stats(
                connection, "AND p_student_t > p_normal"
            )
            report["tail_arrival"] = {
                "arrived": _window_stats(connection, "AND tail_arrived=1"),
                "not_arrived": _window_stats(connection, "AND tail_arrived=0"),
            }
            report["ledger_health"] = {
                "total_predictions": prediction_count,
                "resolved": connection.execute(
                    "SELECT COUNT(*) FROM predictions WHERE resolved_at_utc IS NOT NULL"
                ).fetchone()[0],
                "pending": connection.execute(
                    "SELECT COUNT(*) FROM predictions WHERE resolved_at_utc IS NULL"
                ).fetchone()[0],
                "expired_unresolved": connection.execute(
                    "SELECT COUNT(*) FROM predictions WHERE resolved_at_utc IS NULL AND expiry_utc < ?",
                    (now.isoformat(),),
                ).fetchone()[0],
                "resolution_source": "coinbase_1m_v2",
            }
            report["distribution_selection"] = _distribution_selection(report)
            report["probability_correction"] = _probability_correction(connection)
            report["tail_probability_correction"] = _tail_probability_correction(connection)
            return report
    except sqlite3.Error as error:
        return {"status": "storage_error", "error": str(error)}


def _distribution_selection(report: dict) -> dict:
    stats = report.get("windows", {}).get("last_200", {})
    count = int(stats.get("count") or 0)
    brier = float(stats.get("brier") or 0.0)
    normal_brier = float(stats.get("normal_brier") or 0.0)
    active = "student_t"
    reason = "insufficient calibration sample; Student-t remains the fat-tail default"
    if count >= DISTRIBUTION_FALLBACK_MIN_SAMPLE:
        improvement = (brier - normal_brier) / brier if brier > 0 else 0.0
        if improvement >= DISTRIBUTION_FALLBACK_BRIER_IMPROVEMENT:
            active = "normal"
            reason = "normal model improved Brier by at least 5% over the last 200 resolved outcomes"
        else:
            reason = "Student-t retained on the rolling 200-outcome Brier comparison"
    return {
        "active_distribution": active,
        "fallback_min_resolved_sample": DISTRIBUTION_FALLBACK_MIN_SAMPLE,
        "required_brier_improvement": DISTRIBUTION_FALLBACK_BRIER_IMPROVEMENT,
        "reason": reason,
    }
