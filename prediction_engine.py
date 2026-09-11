"""WeCryp prediction engine — fat-tailed core for hourly range binaries.

Upgrades over the prior normal/lognormal approximation:
1. Student-t distribution fit on 200+ hourly log-returns so violent wicks
   are not systematically underpriced.
2. Remaining-window probabilities computed per live Kalshi strike band.
3. Wick & tail metrics from Coinbase 1-minute candles.
4. Volatility regime classification vs. trailing 30-day distribution.
5. Time-decay table (20/15/10/5 min) for strike probabilities.

The output JSON block is backwards-compatible with the prior engine plus new
keys: regime, strike_probs, ladder_residuals, wick_stats, decay_table.
"""
import math
import os
from datetime import datetime, timedelta, timezone

import requests

from market_data import get_spot, get_hourly_candles, compute_stats

# ---------------------------------------------------------------------------
# Model parameters (single source of truth; exposed via /weights)
# ---------------------------------------------------------------------------
LOOKBACK_HOURS = 24
BODY_PERCENTILE = 0.60
MOMENTUM_LOOKBACK_HOURS = 6
BIAS_THRESHOLD = 0.10
UPPER_RANGE_FACTOR = 0.45
LOWER_RANGE_FACTOR = 0.55
CENTER_SHIFT_FACTOR = 0.30
DRIFT_FACTOR = 0.40
MIN_RANGE_PCT = 0.25

# Fat-tail / wick / regime parameters
HOUR_SAMPLE_SIZE = 200               # hours of candles for distribution fitting
SPIKE_THRESHOLD_PCT = 0.3            # 1-minute move classified as a "spike"
FINAL_MINUTES_WINDOW = 15            # final minutes of hour for wick stats
REGIME_LOOKBACK_HOURS = 24 * 30      # 30 days of hourly candles
DECAY_TABLE_MINUTES = [20, 15, 10, 5]
RESIDUAL_FLAG_THRESHOLD_CENTS = 5.0  # flag ladder bands >5¢ above model
STUDENT_T_DF_DEFAULT = 4.0           # fallback if empirical fit is unstable

_HEADERS = {"User-Agent": "wecryp-truffle/1.0 (+https://agentverse.ai)"}
COINBASE_CANDLES = "https://api.exchange.coinbase.com/products/BTC-USD/candles"
MARKET_DATA_WORKER_URL = os.getenv(
    "MARKET_DATA_WORKER_URL", "https://scalper-market-data.gitgoin87.workers.dev"
)


# ---------------------------------------------------------------------------
# Data access
# ---------------------------------------------------------------------------
def get_minute_candles(count: int = 360) -> list:
    """Fetch recent Coinbase 1-minute candles for wick analytics."""
    try:
        r = requests.get(
            COINBASE_CANDLES,
            params={"granularity": 60},
            headers=_HEADERS,
            timeout=15,
        )
        r.raise_for_status()
        cols = ["time", "low", "high", "open", "close", "volume"]
        candles = [dict(zip(cols, c)) for c in r.json()]
        candles.sort(key=lambda c: c["time"])
        return candles[-count:]
    except Exception:
        return []


def get_hourly_candle_history(total_hours: int = REGIME_LOOKBACK_HOURS) -> list:
    """Fetch up to 30 days of hourly candles by paging Coinbase backwards."""
    end = datetime.now(timezone.utc)
    all_candles = []
    seen = set()
    cols = ["time", "low", "high", "open", "close", "volume"]

    for _ in range(5):
        start = end - timedelta(hours=299)
        try:
            r = requests.get(
                COINBASE_CANDLES,
                params={
                    "granularity": 3600,
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                },
                headers=_HEADERS,
                timeout=15,
            )
            r.raise_for_status()
            data = r.json()
        except Exception:
            break

        for c in data:
            if c[0] not in seen:
                seen.add(c[0])
                all_candles.append(dict(zip(cols, c)))

        if len(all_candles) >= total_hours:
            break

        earliest = min(c["time"] for c in all_candles)
        end = datetime.fromtimestamp(earliest - 1, tz=timezone.utc)

    all_candles.sort(key=lambda c: c["time"])
    return all_candles[-total_hours:]


def get_kalshi_ladder() -> dict:
    """Fetch live Kalshi hourly band ladder from the market data worker."""
    try:
        r = requests.get(f"{MARKET_DATA_WORKER_URL}/kalshi/bands", timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Wick analytics
# ---------------------------------------------------------------------------
def compute_wick_stats(candles_1m: list) -> dict:
    """Compute wick/spike statistics from Coinbase 1-minute candles."""
    if len(candles_1m) < 60:
        return {
            "error": "insufficient 1m candle data",
            "candles_used": len(candles_1m),
        }

    by_hour = {}
    for c in candles_1m:
        hour_bucket = c["time"] // 3600
        by_hour.setdefault(hour_bucket, []).append(c)

    per_hour_stats = []
    late_spike_count = 0
    late_minutes_evaluated = 0
    spike_count = 0

    for hour_bucket, candles in sorted(by_hour.items()):
        if len(candles) < 50:
            continue

        candles.sort(key=lambda c: c["time"])
        max_1m_move_pct = 0.0
        wick_ratios = []

        for c in candles:
            if c["open"] <= 0:
                continue
            move_pct = abs(c["close"] - c["open"]) / c["open"] * 100
            max_1m_move_pct = max(max_1m_move_pct, move_pct)
            body = abs(c["close"] - c["open"])
            wick = c["high"] - c["low"]
            if body > 0:
                wick_ratios.append(wick / body)

        hour_stats = {
            "hour_bucket": hour_bucket,
            "max_1m_move_pct": round(max_1m_move_pct, 4),
            "avg_wick_ratio": round(sum(wick_ratios) / len(wick_ratios), 3) if wick_ratios else 0.0,
        }
        per_hour_stats.append(hour_stats)

        for c in candles:
            minute_of_hour = (c["time"] % 3600) // 60
            if minute_of_hour >= (60 - FINAL_MINUTES_WINDOW):
                late_minutes_evaluated += 1
                if c["open"] > 0:
                    move_pct = abs(c["close"] - c["open"]) / c["open"] * 100
                    if move_pct >= SPIKE_THRESHOLD_PCT:
                        late_spike_count += 1
            if c["open"] > 0:
                move_pct = abs(c["close"] - c["open"]) / c["open"] * 100
                if move_pct >= SPIKE_THRESHOLD_PCT:
                    spike_count += 1

    hours_analyzed = len(per_hour_stats)
    return {
        "candles_used": len(candles_1m),
        "hours_analyzed": hours_analyzed,
        "max_1m_move_pct": round(max((s["max_1m_move_pct"] for s in per_hour_stats), default=0.0), 4),
        "avg_wick_ratio": round(sum(s["avg_wick_ratio"] for s in per_hour_stats) / hours_analyzed, 3) if hours_analyzed else 0.0,
        "spike_threshold_pct": SPIKE_THRESHOLD_PCT,
        "total_spikes": spike_count,
        "spike_frequency_per_hour": round(spike_count / hours_analyzed, 3) if hours_analyzed else 0.0,
        "late_window_spikes": late_spike_count,
        "late_window_spike_frequency_per_hour": round(late_spike_count / hours_analyzed, 3) if hours_analyzed else 0.0,
        "late_minutes_evaluated": late_minutes_evaluated,
        "per_hour": per_hour_stats[-24:],
    }


# ---------------------------------------------------------------------------
# Distribution helpers
# ---------------------------------------------------------------------------
def _betacf(a, b, x):
    """Continued fraction for incomplete beta (Numerical Recipes)."""
    MAXIT = 200
    EPS = 3e-9
    FPMIN = 1e-30

    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < FPMIN:
        d = FPMIN
    d = 1.0 / d
    h = d

    for m in range(1, MAXIT + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        h *= d * c

        aa = -(a + m) * (b + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        h *= d * c

        if abs(d - 1.0) < EPS:
            break

    return h


def _incomplete_beta(x, a, b):
    """Regularized incomplete beta function."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0

    ln_beta = math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)
    front = math.exp(a * math.log(x) + b * math.log(1 - x) - ln_beta)

    if x < (a + 1) / (a + b + 2):
        return front * _betacf(a, b, x) / a
    return 1 - front * _betacf(b, a, 1 - x) / b


def _student_t_cdf(x, df):
    """Student-t cumulative distribution function."""
    if x == 0:
        return 0.5
    xx = df / (df + x * x)
    ib = _incomplete_beta(xx, df / 2.0, 0.5)
    return 1 - 0.5 * ib if x > 0 else 0.5 * ib


def _fit_student_t(log_returns: list):
    """Fit Student-t degrees of freedom from sample excess kurtosis."""
    if len(log_returns) < 20:
        return STUDENT_T_DF_DEFAULT

    mean = sum(log_returns) / len(log_returns)
    var = sum((r - mean) ** 2 for r in log_returns) / (len(log_returns) - 1)
    if var <= 0:
        return STUDENT_T_DF_DEFAULT

    kurt = sum((r - mean) ** 4 for r in log_returns) / len(log_returns) / (var ** 2)

    if kurt <= 3:
        return 30.0

    df = (4 * kurt - 6) / (kurt - 3)
    return max(2.1, min(100.0, df))


def _t_scale(sigma_hourly_pct, df):
    """Scale parameter matching sample variance under Student-t."""
    if df <= 2:
        return sigma_hourly_pct
    return sigma_hourly_pct * math.sqrt((df - 2) / df)


# ---------------------------------------------------------------------------
# Core engine
# ---------------------------------------------------------------------------
def realized_vol_pct(candles: list, lookback: int = LOOKBACK_HOURS) -> float:
    closes = [c["close"] for c in candles[-lookback:]]
    if len(closes) < 3:
        return 0.0
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var) * math.sqrt(24 * 365) * 100


def expected_move_pct(candles: list, lookback: int = LOOKBACK_HOURS) -> float:
    bodies_pct = []
    for c in candles[-lookback:]:
        if c["open"] > 0:
            bodies_pct.append(abs(c["close"] - c["open"]) / c["open"] * 100)
    if not bodies_pct:
        return 0.5
    bodies_pct.sort()
    n = len(bodies_pct)
    idx = int(n * BODY_PERCENTILE)
    return bodies_pct[idx] if idx < n else bodies_pct[-1]


def momentum_bias(candles: list, lookback: int = MOMENTUM_LOOKBACK_HOURS) -> float:
    closes = [c["close"] for c in candles[-lookback:]]
    if len(closes) < 2:
        return 0.0
    first = closes[0]
    last = closes[-1]
    if first == 0:
        return 0.0
    move_pct = (last - first) / first * 100
    return max(-1.0, min(1.0, move_pct / 2.0))


def _classify_regime(hourly_ranges: list) -> dict:
    """Classify current volatility regime vs trailing 30-day distribution."""
    if len(hourly_ranges) < 20:
        return {"regime": "UNKNOWN", "reason": "insufficient data"}

    sorted_ranges = sorted(hourly_ranges)
    n = len(sorted_ranges)
    q25 = sorted_ranges[int(n * 0.25)]
    q75 = sorted_ranges[int(n * 0.75)]
    current = hourly_ranges[-1]

    if current <= q25:
        regime = "LOW"
    elif current >= q75:
        regime = "HIGH"
    else:
        regime = "MID"

    return {
        "regime": regime,
        "current_hourly_range": round(current, 2),
        "trailing_25th_pct": round(q25, 2),
        "trailing_75th_pct": round(q75, 2),
        "lookback_hours": len(hourly_ranges),
    }


def _band_probability(
    low: float,
    high: float,
    spot: float,
    sigma_pct: float,
    drift_pct: float,
    df: float,
    minutes_remaining: int,
) -> float:
    """Probability that final price settles inside [low, high]."""
    if minutes_remaining <= 0 or spot <= 0 or high <= low:
        return 0.0

    time_frac = minutes_remaining / 60.0
    sigma = sigma_pct * math.sqrt(time_frac)
    if sigma <= 0.00001:
        return 0.0

    low_pct = (low - spot) / spot * 100
    high_pct = (high - spot) / spot * 100
    z_low = (low_pct - drift_pct) / sigma
    z_high = (high_pct - drift_pct) / sigma

    return max(0.0, _student_t_cdf(z_high, df) - _student_t_cdf(z_low, df))


def _probs_from_sigma(
    spot, upper, lower, sigma_hourly_pct, drift_pct, df, minutes_remaining
):
    """Compute in/above/below probabilities for a constructed range."""
    if minutes_remaining <= 0:
        return {"in_range": 1.0, "above_upper": 0.0, "below_lower": 0.0}

    time_frac = minutes_remaining / 60.0
    sigma = sigma_hourly_pct * math.sqrt(time_frac)
    if sigma <= 0.00001:
        return {"in_range": 1.0, "above_upper": 0.0, "below_lower": 0.0}

    upper_pct = (upper - spot) / spot * 100
    lower_pct = (lower - spot) / spot * 100
    z_up = (upper_pct - drift_pct) / sigma
    z_lo = (lower_pct - drift_pct) / sigma
    p_above = 1 - _student_t_cdf(z_up, df)
    p_below = _student_t_cdf(z_lo, df)
    p_in = max(0.0, 1 - p_above - p_below)
    return {
        "in_range": round(p_in, 3),
        "above_upper": round(p_above, 3),
        "below_lower": round(p_below, 3),
    }


def predict_hourly_range() -> dict:
    """Main entry: compute current hourly range prediction with probabilities."""
    now = datetime.now(timezone.utc)
    minutes_to_expiry = 60 - now.minute

    spot_data = get_spot()
    spot = spot_data["price"]
    candles = get_hourly_candles(24)
    stats = compute_stats(candles)

    if spot is None or not stats:
        return {
            "error": "Live data unavailable",
            "spot": spot,
            "timestamp": now.isoformat(),
        }

    rv = realized_vol_pct(candles)
    sigma_hourly_pct = rv / math.sqrt(24 * 365)
    expected_move = expected_move_pct(candles)
    bias = momentum_bias(candles)

    range_pct = max(expected_move, MIN_RANGE_PCT)
    center_shift = bias * range_pct * CENTER_SHIFT_FACTOR
    upper_pct = range_pct * UPPER_RANGE_FACTOR + center_shift
    lower_pct = range_pct * LOWER_RANGE_FACTOR - center_shift

    upper_bound = spot * (1 + upper_pct / 100)
    lower_bound = spot * (1 - lower_pct / 100)

    # --- Fat-tailed distribution (Student-t on 200+ hourly log-returns) ---
    hourly_candles_200 = get_hourly_candles(HOUR_SAMPLE_SIZE)
    log_returns = []
    for i in range(1, len(hourly_candles_200)):
        if hourly_candles_200[i - 1]["close"] > 0 and hourly_candles_200[i]["close"] > 0:
            log_returns.append(
                math.log(
                    hourly_candles_200[i]["close"] / hourly_candles_200[i - 1]["close"]
                )
            )
    df = _fit_student_t(log_returns)

    # Drift for remaining window
    drift_pct = bias * sigma_hourly_pct * DRIFT_FACTOR * math.sqrt(minutes_to_expiry / 60)

    # --- Per-strike probabilities from live Kalshi ladder ---
    ladder = get_kalshi_ladder()
    bands = ladder.get("candidate_bands", []) if isinstance(ladder, dict) else []

    strike_probs = []
    for band in bands:
        low, high = band.get("low"), band.get("high")
        ask, bid = band.get("yes_ask"), band.get("yes_bid")
        side = band.get("side_vs_spot", "ABOVE_SPOT")
        if low is None or high is None or ask is None:
            continue

        low_pct = (low - spot) / spot * 100
        high_pct = (high - spot) / spot * 100
        mid_pct = (low_pct + high_pct) / 2

        p_touch = _band_probability(
            low, high, spot, sigma_hourly_pct, drift_pct, df, minutes_to_expiry
        )

        fair_value = p_touch * 100
        residual = ask - fair_value

        strike_probs.append({
            "band": f"${low:,.0f}-${high:,.0f}",
            "side": side,
            "yes_ask": ask,
            "yes_bid": bid,
            "model_fair_cents": round(fair_value, 1),
            "residual_cents": round(residual, 1),
            "flagged": residual > RESIDUAL_FLAG_THRESHOLD_CENTS,
            "p_touch": round(p_touch, 3),
        })

    # --- Wick statistics (1m candles) ---
    candles_1m = get_minute_candles(360)
    wick_stats = compute_wick_stats(candles_1m)

    # --- Regime classification ---
    hourly_history = get_hourly_candle_history(REGIME_LOOKBACK_HOURS)
    hourly_ranges = [c["high"] - c["low"] for c in hourly_history if c["high"] and c["low"]]
    regime = _classify_regime(hourly_ranges)

    # --- Time-decay table ---
    decay_table = []
    for band in bands:
        low, high = band.get("low"), band.get("high")
        side = band.get("side_vs_spot", "ABOVE_SPOT")
        if low is None or high is None:
            continue
        low_pct = (low - spot) / spot * 100
        high_pct = (high - spot) / spot * 100
        mid_pct = (low_pct + high_pct) / 2
        row = {
            "band": f"${low:,.0f}-${high:,.0f}",
            "side": side,
        }
        for m in DECAY_TABLE_MINUTES:
            if minutes_to_expiry > m:
                p = _band_probability(
                    low, high, spot, sigma_hourly_pct, drift_pct, df, m
                )
                row[f"p_{m}m"] = round(p, 3)
        decay_table.append(row)

    full_hour_probs = _probs_from_sigma(spot, upper_bound, lower_bound, sigma_hourly_pct, drift_pct, df, 60)
    remaining_probs = _probs_from_sigma(spot, upper_bound, lower_bound, sigma_hourly_pct, drift_pct, df, minutes_to_expiry)

    return {
        "timestamp_utc": now.isoformat(),
        "minutes_to_hourly_expiry": minutes_to_expiry,
        "spot": spot,
        "range": {
            "upper": round(upper_bound, 2),
            "lower": round(lower_bound, 2),
            "upper_pct": round(upper_pct, 3),
            "lower_pct": round(lower_pct, 3),
        },
        "probabilities_full_hour": full_hour_probs,
        "probabilities_remaining": remaining_probs,
        "market_stats": stats,
        "volatility": {
            "realized_vol_annualized_pct": round(rv, 2),
            "sigma_hourly_pct": round(sigma_hourly_pct, 3),
            "expected_move_pct": round(expected_move, 3),
            "student_t_df": round(df, 2),
            "log_returns_sample_size": len(log_returns),
        },
        "regime": regime,
        "strike_probs": strike_probs,
        "ladder_residuals": [sp for sp in strike_probs if sp.get("flagged")],
        "wick_stats": wick_stats,
        "decay_table": decay_table,
        "settlement_note": (
            "Kalshi settles against 60s BRTI average — a sustained push through "
            "most of that final minute moves the average hard. Polymarket "
            "Chainlink TWAP: window unconfirmed, read off live market rules."
        ),
    }


if __name__ == "__main__":
    import json
    print(json.dumps(predict_hourly_range(), indent=2))
