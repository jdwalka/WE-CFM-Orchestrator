"""Persistent prediction/outcome ledger for Truffle calibration."""
import math
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import httpx
from calibration_buckets import replay_resolved_outcomes

LEDGER_PATH_ENV_VAR = "CALIBRATION_LEDGER_PATH"
DEFAULT_DB_PATH = Path(__file__).with_name("data") / "truffle_calibration.sqlite3"
DB_PATH = DEFAULT_DB_PATH
MODEL_VERSION = "truffle-tail-v2"
_HEADERS = {"User-Agent": "wecryp-truffle/1.0 (+https://agentverse.ai)"}
_TAIL_EVENT_NORMAL_P = 0.20
DISTRIBUTION_FALLBACK_MIN_SAMPLE = 500
DISTRIBUTION_FALLBACK_BRIER_IMPROVEMENT = 0.05
PROBABILITY_CORRECTION_PRIOR_STRENGTH = 200.0
PROBABILITY_CORRECTION_MIN_SAMPLES = 12
PROBABILITY_CORRECTION_MAX_SHRINK = 0.85
PROBABILITY_CORRECTION_MAX_FACTOR = 4.0
PROBABILITY_CORRECTION_MIN_FACTOR = 1.0
PROBABILITY_CORRECTION_RECENT_WEIGHT = 0.60
PROBABILITY_CORRECTION_RECENT_WINDOW = 50
PROBABILITY_CORRECTION_TRAILING_WINDOW = 200
PROBABILITY_CORRECTION_REGIME_BREAK_WINDOW = 100
PROBABILITY_CORRECTION_REGIME_BREAK_GAP = 0.15
PROBABILITY_CORRECTION_FLOOR = 0.0005
TAIL_PROBABILITY_THRESHOLD = 0.30
TAIL_CORRECTION_MIN_SAMPLES = 10
TAIL_CORRECTION_PRIOR_STRENGTH = 100.0
TAIL_CORRECTION_MAX_FACTOR = 2.0
TAIL_UNDERPREDICTION_GAP = 0.03
TIME_TO_EXPIRY_BUCKETS = (
    (5, "0-5m"),
    (15, "6-15m"),
    (30, "16-30m"),
    (60, "31-60m"),
)


def _connect() -> sqlite3.Connection:
    database_path = ledger_path()
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path, timeout=10)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass
    try:
        connection.execute("PRAGMA busy_timeout=5000")
    except sqlite3.OperationalError:
        pass
    return connection


def ledger_path() -> Path:
    configured_path = os.getenv(LEDGER_PATH_ENV_VAR)
    if configured_path:
        return Path(configured_path).expanduser()
    return Path(DB_PATH)


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
        "regime": "ALTER TABLE predictions ADD COLUMN regime TEXT DEFAULT 'UNKNOWN'",
        "time_to_expiry_bucket": (
            "ALTER TABLE predictions ADD COLUMN time_to_expiry_bucket TEXT"
        ),
        "resolution_source": "ALTER TABLE predictions ADD COLUMN resolution_source TEXT",
        "outcome_window_start_utc": "ALTER TABLE predictions ADD COLUMN outcome_window_start_utc TEXT",
        "outcome_window_end_utc": "ALTER TABLE predictions ADD COLUMN outcome_window_end_utc TEXT",
        "outcome_candles_used": "ALTER TABLE predictions ADD COLUMN outcome_candles_used INTEGER",
        "cascade_active": "ALTER TABLE predictions ADD COLUMN cascade_active INTEGER",
        "burst_pressure": "ALTER TABLE predictions ADD COLUMN burst_pressure REAL",
        "cascade_skew": "ALTER TABLE predictions ADD COLUMN cascade_skew REAL",
        "settlement_hold_given_touch": "ALTER TABLE predictions ADD COLUMN settlement_hold_given_touch REAL",
        "p_settle": "ALTER TABLE predictions ADD COLUMN p_settle REAL",
        "final_print_brti": "ALTER TABLE predictions ADD COLUMN final_print_brti REAL",
        "settled": "ALTER TABLE predictions ADD COLUMN settled INTEGER",
        "settlement_held": "ALTER TABLE predictions ADD COLUMN settlement_held INTEGER",
        "settle_brier": "ALTER TABLE predictions ADD COLUMN settle_brier REAL",
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
    connection.execute(
        """
        UPDATE predictions
        SET time_to_expiry_bucket = CASE
            WHEN minutes_to_expiry <= 5 THEN '0-5m'
            WHEN minutes_to_expiry <= 15 THEN '6-15m'
            WHEN minutes_to_expiry <= 30 THEN '16-30m'
            ELSE '31-60m'
        END
        WHERE time_to_expiry_bucket IS NULL OR time_to_expiry_bucket = ''
        """
    )
    connection.commit()


def _prediction_key(timestamp: datetime, band: str, expiry: datetime) -> str:
    return f"{timestamp.isoformat()}|{band}|{expiry.isoformat()}"


def _fetch_minute_candles(start: datetime, end: datetime) -> list[dict]:
    """Fetch the 1-minute candles that cover [start, end)."""
    try:
        response = httpx.get(
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
    except (httpx.HTTPError, KeyError, ValueError, TypeError):
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
    regime: str = "UNKNOWN",
    cascade_active: bool = False,
    burst_pressure: float = 0.0,
    cascade_skew: float = 1.0,
    settlement_hold_given_touch: float | None = None,
    p_settle: float | None = None,
) -> bool:
    """Append one prediction; duplicate timestamp/band/expiry rows are ignored."""
    connection = None
    try:
        connection = _connect()
        _initialize(connection)
        connection.execute(
            """
            INSERT OR IGNORE INTO predictions (
                prediction_key, timestamp_utc, band, low, high, expiry_utc,
                p_touch, p_normal, p_student_t, p_base, p_calibrated,
                calibration_factor, tail_adjustment, alt_aligned,
                regime, minutes_to_expiry, time_to_expiry_bucket, model_version,
                cascade_active, burst_pressure, cascade_skew,
                settlement_hold_given_touch, p_settle
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                str(regime),
                int(minutes_to_expiry),
                _time_to_expiry_bucket(minutes_to_expiry),
                MODEL_VERSION,
                int(cascade_active),
                float(burst_pressure),
                float(cascade_skew),
                float(settlement_hold_given_touch) if settlement_hold_given_touch is not None else None,
                float(p_settle) if p_settle is not None else None,
            ),
        )
        connection.commit()
        return True
    except (sqlite3.Error, Exception):
        return False
    finally:
        if connection is not None:
            connection.close()


def _bucket(p_touch: float, p_normal: float, touched: bool) -> str:
    model_right = (p_touch >= 0.5) == touched
    if touched and p_normal < _TAIL_EVENT_NORMAL_P:
        return "model_right_tail_arrived" if model_right else "model_wrong_tail_arrived"
    if touched and p_normal < 0.5:
        return "model_right_underpriced_tail" if model_right else "model_wrong_underpriced_tail"
    return "model_right" if model_right else "model_wrong"


def _time_to_expiry_bucket(minutes_to_expiry: int) -> str:
    minutes = max(0, int(minutes_to_expiry))
    for upper_bound, bucket in TIME_TO_EXPIRY_BUCKETS:
        if minutes <= upper_bound:
            return bucket
    return TIME_TO_EXPIRY_BUCKETS[-1][1]


def resolve_pending_predictions() -> int:
    """Resolve predictions against the price path from prediction time to expiry."""
    now = datetime.now(timezone.utc)
    try:
        with closing(_connect()) as connection:
            _initialize(connection)
            rows = connection.execute(
                """
                SELECT id, low, high, timestamp_utc, expiry_utc, p_touch, p_normal, p_settle
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
    for row in rows:
        prediction_id, low, high, timestamp_text, expiry_text, p_touch, p_normal = row[:7]
        p_settle = row[7] if len(row) > 7 else None
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

        # Settlement resolution from final minute candle (60s BRTI print proxy)
        final_candle = candles[-1]
        final_print_brti = round(
            (final_candle["open"] + final_candle["high"] + final_candle["low"] + final_candle["close"]) / 4.0,
            2,
        )
        settled = int(low <= final_print_brti <= high)
        settlement_held = int(settled) if touched else 0
        settle_brier = round((float(p_settle) - settled) ** 2, 6) if p_settle is not None else None

        try:
            with closing(_connect()) as connection:
                _initialize(connection)
                connection.execute(
                    """
                    UPDATE predictions
                    SET touched=?, resolved_at_utc=?, brier=?, normal_brier=?,
                        outcome_bucket=?, tail_arrived=?, resolution_source=?,
                        outcome_window_start_utc=?, outcome_window_end_utc=?,
                        outcome_candles_used=?,
                        final_print_brti=?, settled=?, settlement_held=?, settle_brier=?
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
                        final_print_brti,
                        settled,
                        settlement_held,
                        settle_brier,
                        prediction_id,
                    ),
                )
                connection.commit()
            resolved += 1
        except sqlite3.Error:
            continue
    return resolved


def backfill_settlement_history(limit_expiries: int = 100) -> dict:
    """Backfill final-60s BRTI print, settled status, and settlement_held for resolved predictions."""
    try:
        with closing(_connect()) as connection:
            _initialize(connection)
            expiries = [
                row[0] for row in connection.execute(
                    """
                    SELECT DISTINCT expiry_utc
                    FROM predictions
                    WHERE resolved_at_utc IS NOT NULL AND final_print_brti IS NULL
                    ORDER BY expiry_utc DESC
                    LIMIT ?
                    """,
                    (limit_expiries,),
                ).fetchall()
            ]
    except sqlite3.Error as exc:
        return {"status": "error", "error": str(exc), "updated_predictions": 0}

    if not expiries:
        return {"status": "ok", "message": "all resolved predictions have final_print_brti", "updated_predictions": 0}

    total_updated = 0
    for expiry_text in expiries:
        try:
            expiry = datetime.fromisoformat(expiry_text)
            start = expiry - timedelta(minutes=2)
            candles = _fetch_minute_candles(start, expiry)
            if not candles:
                continue
            final_candle = candles[-1]
            final_print_brti = round(
                (final_candle["open"] + final_candle["high"] + final_candle["low"] + final_candle["close"]) / 4.0,
                2,
            )
            with closing(_connect()) as connection:
                rows = connection.execute(
                    """
                    SELECT id, low, high, touched, p_settle
                    FROM predictions
                    WHERE expiry_utc = ? AND final_print_brti IS NULL
                    """,
                    (expiry_text,),
                ).fetchall()
                for pid, low, high, touched, p_settle in rows:
                    settled = int(low <= final_print_brti <= high)
                    settlement_held = int(settled) if touched else 0
                    settle_brier = round((float(p_settle) - settled) ** 2, 6) if p_settle is not None else None
                    connection.execute(
                        """
                        UPDATE predictions
                        SET final_print_brti=?, settled=?, settlement_held=?, settle_brier=?
                        WHERE id=?
                        """,
                        (final_print_brti, settled, settlement_held, settle_brier, pid),
                    )
                    total_updated += 1
                connection.commit()
        except Exception:
            continue

    return {"status": "ok", "expiries_processed": len(expiries), "updated_predictions": total_updated}


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
    """Dual-window empirical-Bayes correction with stale-regime fallback."""
    rows = connection.execute(
        """
        SELECT p_base, touched
            FROM predictions
            WHERE resolved_at_utc IS NOT NULL AND p_base IS NOT NULL
            ORDER BY resolved_at_utc DESC, id DESC
            LIMIT ?
        """
        , (PROBABILITY_CORRECTION_RECENT_WINDOW + PROBABILITY_CORRECTION_TRAILING_WINDOW,)
    ).fetchall()

    def window_stats(window):
        predicted = sum(
            max(float(row[0] or 0.0), PROBABILITY_CORRECTION_FLOOR)
            for row in window
        )
        realized = sum(1.0 for row in window if row[1])
        count = len(window)
        ratio = realized / predicted if predicted > 0 else 1.0
        realized_frequency = realized / count if count else None
        return {
            "count": count,
            "predicted": predicted,
            "realized": realized,
            "ratio": ratio,
            "realized_frequency": realized_frequency,
        }

    recent = window_stats(
        rows[:PROBABILITY_CORRECTION_RECENT_WINDOW]
    )
    older = window_stats(
        rows[
            PROBABILITY_CORRECTION_RECENT_WINDOW:
            PROBABILITY_CORRECTION_RECENT_WINDOW + PROBABILITY_CORRECTION_TRAILING_WINDOW
        ]
    )
    total_count = len(rows)
    total_predicted = sum(
        max(float(row[0] or 0.0), PROBABILITY_CORRECTION_FLOOR) for row in rows
    )
    total_realized = sum(1.0 for row in rows if row[1])

    if total_count < PROBABILITY_CORRECTION_MIN_SAMPLES or total_predicted <= 0:
        return {
            "correction_factor": 1.0,
            "active": False,
            "samples": total_count,
            "sum_predicted": round(total_predicted, 4),
            "sum_realized": round(total_realized, 4),
            "raw_ratio": None,
            "posterior_ratio": 1.0,
            "prior_strength": PROBABILITY_CORRECTION_PRIOR_STRENGTH,
            "min_samples": PROBABILITY_CORRECTION_MIN_SAMPLES,
            "min_factor": PROBABILITY_CORRECTION_MIN_FACTOR,
            "max_factor": PROBABILITY_CORRECTION_MAX_FACTOR,
            "floor": PROBABILITY_CORRECTION_FLOOR,
            "reason": "insufficient resolved outcomes; correction disabled",
        }

    window_gap = 0.0
    if recent["realized_frequency"] is not None and older["realized_frequency"] is not None:
        window_gap = abs(
            recent["realized_frequency"] - older["realized_frequency"]
        )
    regime_break = window_gap > PROBABILITY_CORRECTION_REGIME_BREAK_GAP

    if regime_break:
        selected = window_stats(rows[:PROBABILITY_CORRECTION_REGIME_BREAK_WINDOW])
        raw_ratio = selected["ratio"]
        source = "recent_100_regime_break"
    elif older["count"]:
        raw_ratio = (
            PROBABILITY_CORRECTION_RECENT_WEIGHT * recent["ratio"]
            + (1.0 - PROBABILITY_CORRECTION_RECENT_WEIGHT) * older["ratio"]
        )
        selected = {
            "count": recent["count"] + older["count"],
            "predicted": recent["predicted"] + older["predicted"],
            "realized": recent["realized"] + older["realized"],
        }
        source = "dual_window_blend"
    else:
        raw_ratio = recent["ratio"]
        selected = recent
        source = "recent_window_only"

    evidence_count = selected["count"]
    posterior_ratio = (
        raw_ratio * evidence_count + PROBABILITY_CORRECTION_MIN_FACTOR * PROBABILITY_CORRECTION_PRIOR_STRENGTH
    ) / (evidence_count + PROBABILITY_CORRECTION_PRIOR_STRENGTH)
    correction_factor = min(
        max(posterior_ratio, PROBABILITY_CORRECTION_MIN_FACTOR),
        PROBABILITY_CORRECTION_MAX_FACTOR,
    )

    return {
        "correction_factor": round(correction_factor, 4),
        "active": True,
        "samples": evidence_count,
        "sum_predicted": round(selected["predicted"], 4),
        "sum_realized": round(selected["realized"], 4),
        "raw_ratio": round(raw_ratio, 4),
        "source": source,
        "window_blend": {
            "recent_weight": PROBABILITY_CORRECTION_RECENT_WEIGHT,
            "recent_window": PROBABILITY_CORRECTION_RECENT_WINDOW,
            "trailing_window": PROBABILITY_CORRECTION_TRAILING_WINDOW,
            "recent_count": recent["count"],
            "recent_raw_ratio": round(recent["ratio"], 4),
            "older_count": older["count"],
            "older_raw_ratio": round(older["ratio"], 4),
            "window_gap": round(window_gap, 4),
            "regime_break_gap": PROBABILITY_CORRECTION_REGIME_BREAK_GAP,
            "regime_break": regime_break,
            "source": source,
        },
        "posterior_ratio": round(posterior_ratio, 4),
        "prior_strength": PROBABILITY_CORRECTION_PRIOR_STRENGTH,
        "min_samples": PROBABILITY_CORRECTION_MIN_SAMPLES,
        "min_factor": PROBABILITY_CORRECTION_MIN_FACTOR,
        "max_factor": PROBABILITY_CORRECTION_MAX_FACTOR,
        "floor": PROBABILITY_CORRECTION_FLOOR,
        "reason": (
            "recent-100 correction after a regime break"
            if regime_break
            else "60/40 recent-to-trailing window blend with a no-bias prior"
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

    avg_predicted = predicted_sum / sample_count
    avg_realized = realized_sum / sample_count
    underprediction_gap = avg_realized - avg_predicted
    if underprediction_gap <= TAIL_UNDERPREDICTION_GAP:
        return {
            "active": False,
            "samples": sample_count,
            "threshold": TAIL_PROBABILITY_THRESHOLD,
            "min_samples": TAIL_CORRECTION_MIN_SAMPLES,
            "max_factor": TAIL_CORRECTION_MAX_FACTOR,
            "factor": 1.0,
            "avg_predicted_probability": round(avg_predicted, 4),
            "realized_frequency": round(avg_realized, 4),
            "underprediction_gap": round(underprediction_gap, 4),
            "reason": "no material tail underprediction in rolling outcomes",
        }

    raw_ratio = avg_realized / avg_predicted
    evidence_weight = sample_count / (sample_count + TAIL_CORRECTION_PRIOR_STRENGTH)
    posterior_ratio = evidence_weight * raw_ratio + (1.0 - evidence_weight)
    factor = max(1.0, min(raw_ratio, TAIL_CORRECTION_MAX_FACTOR))
    return {
        "active": True,
        "samples": sample_count,
        "threshold": TAIL_PROBABILITY_THRESHOLD,
        "sum_predicted": round(predicted_sum, 4),
        "sum_realized": round(realized_sum, 4),
        "avg_predicted_probability": round(avg_predicted, 4),
        "realized_frequency": round(avg_realized, 4),
        "underprediction_gap": round(underprediction_gap, 4),
        "raw_ratio": round(raw_ratio, 4),
        "posterior_ratio": round(posterior_ratio, 4),
        "factor": round(factor, 4),
        "max_factor": TAIL_CORRECTION_MAX_FACTOR,
        "reason": (
            "bounded empirical-Bayes correction for the low-probability "
            "late-window regime"
        ),
    }


def _bucketed_correction(connection: sqlite3.Connection) -> dict:
    """Report-only expiry/regime bucket correction and replay gate."""
    global_factor = float(
        _probability_correction(connection).get("correction_factor", 1.0) or 1.0
    )
    rows = connection.execute(
        """
        SELECT p_base, touched, minutes_to_expiry, regime
        FROM predictions
        WHERE resolved_at_utc IS NOT NULL
          AND p_base IS NOT NULL
          AND touched IS NOT NULL
          AND minutes_to_expiry IS NOT NULL
        ORDER BY resolved_at_utc, id
        """
    ).fetchall()
    if not rows:
        return {
            "status": "empty",
            "active": False,
            "live_path": "report_only",
            "reason": "no resolved outcomes available for bucket replay",
        }

    replay = replay_resolved_outcomes(rows, global_factor)
    enabled = replay["activation"]["enabled"]
    return {
        **replay,
        "active": enabled,
        "live_path": "active" if enabled else "report_only",
        "reason": (
            "bucketed replay passed the pre-registered Brier gate"
            if enabled
            else "bucketed replay failed the pre-registered Brier gate; global correction retained"
        ),
    }


def get_calibration_report() -> dict:
    """Rolling and bucketed Brier/calibration report for recent predictions."""
    now = datetime.now(timezone.utc)
    resolve_pending_predictions()
    try:
        with closing(_connect()) as connection:
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
            report["regime_expiry_buckets"] = {}
            regime_rows = connection.execute(
                """
                SELECT regime, time_to_expiry_bucket
                FROM predictions
                WHERE resolved_at_utc IS NOT NULL
                  AND regime IS NOT NULL
                  AND time_to_expiry_bucket IS NOT NULL
                GROUP BY regime, time_to_expiry_bucket
                ORDER BY regime, time_to_expiry_bucket
                """
            ).fetchall()
            for regime, expiry_bucket in regime_rows:
                report["regime_expiry_buckets"].setdefault(regime, {})[expiry_bucket] = (
                    _window_stats(
                        connection,
                        "AND regime=? AND time_to_expiry_bucket=?",
                        (regime, expiry_bucket),
                    )
                )
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
            report["bucketed_correction"] = _bucketed_correction(connection)

            # Settlement diagnostics and recent 60-second BRTI print outcomes
            settlement_row = connection.execute(
                """
                SELECT 
                    COUNT(*),
                    SUM(CASE WHEN touched = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN settled = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN settlement_held = 1 THEN 1 ELSE 0 END),
                    AVG(settlement_hold_given_touch),
                    AVG(settle_brier)
                FROM predictions
                WHERE resolved_at_utc IS NOT NULL AND final_print_brti IS NOT NULL
                """
            ).fetchone()
            total_resolved_settlements, total_touched, total_settled, total_held, avg_pred_hold, avg_settle_brier = settlement_row
            realized_hold_rate = (total_held / total_touched) if (total_touched and total_touched > 0) else None
            report["settlement_diagnostics"] = {
                "total_resolved_with_brti": total_resolved_settlements or 0,
                "touched_count": total_touched or 0,
                "settled_inside_count": total_settled or 0,
                "settlement_held_count": total_held or 0,
                "realized_hold_rate": round(realized_hold_rate, 4) if realized_hold_rate is not None else None,
                "avg_predicted_hold": round(float(avg_pred_hold), 4) if avg_pred_hold is not None else None,
                "settlement_gap": round(realized_hold_rate - avg_pred_hold, 4) if (realized_hold_rate is not None and avg_pred_hold is not None) else None,
                "settle_brier": round(float(avg_settle_brier), 6) if avg_settle_brier is not None else None,
            }
            recent_settlement_rows = connection.execute(
                """
                SELECT band, expiry_utc, low, high, final_print_brti, touched, settled, settlement_held, settlement_hold_given_touch
                FROM predictions
                WHERE resolved_at_utc IS NOT NULL AND final_print_brti IS NOT NULL
                ORDER BY expiry_utc DESC, id DESC
                LIMIT 12
                """
            ).fetchall()
            report["recent_settlements"] = [
                {
                    "band": r[0],
                    "expiry_utc": r[1],
                    "low": r[2],
                    "high": r[3],
                    "final_print_brti": r[4],
                    "touched": bool(r[5]),
                    "settled": bool(r[6]),
                    "settlement_held": bool(r[7]),
                    "settlement_hold_given_touch": r[8],
                }
                for r in recent_settlement_rows
            ]
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
