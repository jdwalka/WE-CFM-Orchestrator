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

from market_data import compute_stats, get_hourly_candles, get_spot

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
TAIL_ADJUSTMENT_MAX = 0.50
WICK_RATIO_MIN_BODY_PCT = 0.01       # ignore near-zero-body ratio artifacts
WICK_RATIO_MAX = 10.0                 # clamp one-candle ratio spikes
TAIL_SPIKE_FREQUENCY_MIN = 0.001
TAIL_WICK_SLOPE_MIN = 0.50
ALT_ALIGNMENT_RATIO_UP = 0.55
ALT_ALIGNMENT_RATIO_DOWN = 0.45
ALT_ALIGNMENT_MINUTES = 10
ALT_LEAD_LAG_MINUTES = [1, 2, 3, 4, 5]
ALT_LEAD_LAG_SAMPLE_SIZE = 120

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
    except (requests.RequestException, KeyError, ValueError):
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
        except (requests.RequestException, KeyError, ValueError):
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
        payload = r.json()
        if not isinstance(payload, dict):
            return {
                "status": "error",
                "candidate_bands": [],
                "error": "market data worker returned a non-object ladder payload",
            }
        payload.setdefault("candidate_bands", [])
        payload["status"] = "ok"
        payload["error"] = None
        return payload
    except requests.RequestException as e:
        return {"status": "error", "candidate_bands": [], "error": str(e)}


# ---------------------------------------------------------------------------
# Wick analytics
# ---------------------------------------------------------------------------
def _median(values: list) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2.0


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
            body_pct = body / c["open"] * 100
            if body_pct >= WICK_RATIO_MIN_BODY_PCT:
                wick_ratios.append(min(WICK_RATIO_MAX, wick / body))

        median_wick_ratio = _median(wick_ratios)
        hour_stats = {
            "hour_bucket": hour_bucket,
            "max_1m_move_pct": round(max_1m_move_pct, 4),
            "avg_wick_ratio": round(median_wick_ratio, 3),
            "median_wick_ratio": round(median_wick_ratio, 3),
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
        "wick_ratio_min_body_pct": WICK_RATIO_MIN_BODY_PCT,
        "wick_ratio_max": WICK_RATIO_MAX,
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


def _normal_cdf(x: float) -> float:
    """Standard normal cumulative distribution function."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


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


def _linear_slope(values: list) -> float:
    """Least-squares slope, normalized by the mean for readable trend values."""
    values = [v for v in values if isinstance(v, (int, float))]
    if len(values) < 3 or not values:
        return 0.0
    mean = sum(values) / len(values)
    if mean == 0:
        return 0.0
    x_mean = (len(values) - 1) / 2
    y_mean = mean
    numerator = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(values))
    denominator = sum((i - x_mean) ** 2 for i in range(len(values)))
    return numerator / denominator if denominator else 0.0


def _correlation(left: list, right: list) -> float:
    """Pearson correlation for equal-length lists."""
    if len(left) != len(right) or len(left) < 3:
        return 0.0
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum((x - left_mean) * (y - right_mean) for x, y in zip(left, right))
    left_sq = sum((x - left_mean) ** 2 for x in left)
    right_sq = sum((y - right_mean) ** 2 for y in right)
    denominator = math.sqrt(left_sq * right_sq)
    return numerator / denominator if denominator else 0.0


def _get_alt_candles(product: str, count: int) -> list:
    try:
        response = requests.get(
            f"https://api.exchange.coinbase.com/products/{product}/candles",
            params={"granularity": 60},
            headers=_HEADERS,
            timeout=10,
        )
        response.raise_for_status()
        cols = ["time", "low", "high", "open", "close", "volume"]
        candles = [dict(zip(cols, row)) for row in response.json()]
        candles.sort(key=lambda c: c["time"])
        return candles[-count:]
    except (requests.RequestException, KeyError, ValueError, TypeError):
        return []


def _get_binance_taker_ratios(symbol: str, count: int) -> list:
    """Return per-minute taker buy/sell ratios from Binance klines."""
    try:
        response = requests.get(
            "https://api.binance.com/api/v3/klines",
            params={"symbol": symbol, "interval": "1m", "limit": count},
            headers=_HEADERS,
            timeout=10,
        )
        response.raise_for_status()
        ratios = []
        for row in response.json():
            volume = float(row[5])
            taker_buy = float(row[9])
            ratios.append({
                "time": int(row[0]) // 1000,
                "ratio": taker_buy / volume if volume else 0.5,
            })
        return ratios
    except (requests.RequestException, KeyError, ValueError, TypeError, ZeroDivisionError):
        return []


def _get_okx_taker_ratios(inst_id: str, count: int) -> list:
    """Aggregate OKX public trades into per-minute taker buy/sell ratios."""
    try:
        response = requests.get(
            "https://www.okx.com/api/v5/market/trades",
            params={"instId": inst_id, "limit": 500},
            headers=_HEADERS,
            timeout=10,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != "0":
            return []
        by_minute = {}
        for trade in payload.get("data", []):
            timestamp = int(trade["ts"]) // 1000
            minute = timestamp - timestamp % 60
            size = float(trade["sz"])
            entry = by_minute.setdefault(minute, {"buy": 0.0, "sell": 0.0})
            entry["buy" if trade.get("side") == "buy" else "sell"] += size
        ratios = []
        for minute in sorted(by_minute)[-count:]:
            entry = by_minute[minute]
            total = entry["buy"] + entry["sell"]
            if total:
                ratios.append({"time": minute, "ratio": entry["buy"] / total})
        return ratios
    except (requests.RequestException, KeyError, ValueError, TypeError, ZeroDivisionError):
        return []


def _get_taker_ratios(asset: str) -> list:
    """Return per-minute taker ratios, preferring Binance and falling back to OKX."""
    if asset == "ETH":
        ratios = _get_binance_taker_ratios("ETHUSDT", 20)
        return ratios if ratios else _get_okx_taker_ratios("ETH-USDT", 20)
    if asset == "SOL":
        ratios = _get_binance_taker_ratios("SOLUSDT", 20)
        return ratios if ratios else _get_okx_taker_ratios("SOL-USDT", 20)
    return []


def _alt_lead_lag_correlation(alt_returns: dict, btc_returns: list) -> dict:
    """Correlate alt returns at t with BTC returns at t+lag."""
    btc_by_time = {item["time"]: item["return"] for item in btc_returns}
    result = {}
    for lag in ALT_LEAD_LAG_MINUTES:
        correlations = []
        for asset, returns in alt_returns.items():
            left, right = [], []
            for item in returns:
                future_time = item["time"] + lag * 60
                if future_time in btc_by_time:
                    left.append(item["return"])
                    right.append(btc_by_time[future_time])
                if len(left) >= ALT_LEAD_LAG_SAMPLE_SIZE:
                    break
            if len(left) >= 30:
                correlations.append({
                    "asset": asset,
                    "correlation": round(_correlation(left, right), 4),
                    "sample_size": len(left),
                })
        result[f"lag_{lag}m"] = correlations
    return result


def get_alt_signal() -> dict:
    """Cross-asset SOL/ETH lead-lag and taker-flow alignment gate."""
    btc = _get_alt_candles("BTC-USD", 240)
    eth = _get_alt_candles("ETH-USD", 240)
    sol = _get_alt_candles("SOL-USD", 240)
    if not btc or not eth or not sol:
        return {
            "direction": "neutral",
            "strength": 0.0,
            "aligned": False,
            "lead_lag_corr": 0.0,
            "best_lag_minutes": None,
            "data_quality": "insufficient",
            "error": "alt or BTC candle data unavailable",
        }

    def returns(candles: list) -> list:
        values = []
        for previous, current in zip(candles, candles[1:]):
            if previous["close"] > 0 and current["close"] > 0:
                values.append({
                    "time": current["time"],
                    "return": math.log(current["close"] / previous["close"]),
                })
        return values

    btc_returns = returns(btc)
    eth_returns = returns(eth)
    sol_returns = returns(sol)
    lag_stats = _alt_lead_lag_correlation(
        {"ETH": eth_returns, "SOL": sol_returns}, btc_returns
    )
    best_lag = None
    best_correlation = 0.0
    lag_averages = {}
    for lag in ALT_LEAD_LAG_MINUTES:
        values = lag_stats.get(f"lag_{lag}m", [])
        if not values:
            continue
        average_correlation = sum(v["correlation"] for v in values) / len(values)
        lag_averages[lag] = average_correlation
        if abs(average_correlation) > abs(best_correlation):
            best_correlation = average_correlation
            best_lag = lag

    def lead_lag_is_stable() -> bool:
        if len(lag_averages) < 3:
            return False
        positive = sum(1 for value in lag_averages.values() if value >= 0.05)
        negative = sum(1 for value in lag_averages.values() if value <= -0.05)
        return positive >= 3 or negative >= 3

    lead_lag_status = "stable" if lead_lag_is_stable() else "unstable"
    if lead_lag_status == "unstable":
        best_lag = None
        best_correlation = 0.0

    eth_ratios = _get_taker_ratios("ETH")
    sol_ratios = _get_taker_ratios("SOL")
    data_quality = "full" if eth_ratios and sol_ratios else "partial"
    aligned = False
    direction = "neutral"
    duration_minutes = 0
    if eth_ratios and sol_ratios:
        eth_by_time = {item["time"]: item["ratio"] for item in eth_ratios}
        sol_by_time = {item["time"]: item["ratio"] for item in sol_ratios}
        common_times = sorted(set(eth_by_time) & set(sol_by_time))
        consecutive = 0
        max_consecutive = 0
        last_direction = "neutral"
        for timestamp in common_times:
            eth_ratio = eth_by_time[timestamp]
            sol_ratio = sol_by_time[timestamp]
            if eth_ratio > ALT_ALIGNMENT_RATIO_UP and sol_ratio > ALT_ALIGNMENT_RATIO_UP:
                current_direction = "up"
            elif eth_ratio < ALT_ALIGNMENT_RATIO_DOWN and sol_ratio < ALT_ALIGNMENT_RATIO_DOWN:
                current_direction = "down"
            else:
                current_direction = "neutral"
            if current_direction != "neutral":
                if current_direction == last_direction:
                    consecutive += 1
                else:
                    consecutive = 1
                    last_direction = current_direction
                max_consecutive = max(max_consecutive, consecutive)
            else:
                consecutive = 0
                last_direction = "neutral"
        duration_minutes = max_consecutive
        aligned = max_consecutive >= ALT_ALIGNMENT_MINUTES
        direction = last_direction if aligned else "neutral"

    def recent_return(values: list, minutes: int) -> float:
        if not values:
            return 0.0
        selected = values[-minutes:]
        return round(math.exp(sum(item["return"] for item in selected)) - 1, 6)

    eth_return_5m = recent_return(eth_returns, 5)
    sol_return_5m = recent_return(sol_returns, 5)
    if direction == "neutral":
        if eth_return_5m >= 0 and sol_return_5m >= 0:
            direction = "up"
        elif eth_return_5m <= 0 and sol_return_5m <= 0:
            direction = "down"

    strength = max(abs(eth_return_5m), abs(sol_return_5m))
    return {
        "direction": direction,
        "strength": round(strength, 6),
        "aligned": aligned,
        "lead_lag_corr": round(best_correlation, 4),
        "best_lag_minutes": best_lag,
        "lead_lag_status": lead_lag_status,
        "influence_active": False,
        "validation_status": "diagnostic_only_until_backtested",
        "eth": {
            "return_1m": recent_return(eth_returns, 1),
            "return_5m": eth_return_5m,
            "return_15m": recent_return(eth_returns, 15),
            "taker_buy_sell_ratio": round(eth_ratios[-1]["ratio"], 4) if eth_ratios else None,
        },
        "sol": {
            "return_1m": recent_return(sol_returns, 1),
            "return_5m": sol_return_5m,
            "return_15m": recent_return(sol_returns, 15),
            "taker_buy_sell_ratio": round(sol_ratios[-1]["ratio"], 4) if sol_ratios else None,
        },
        "duration_minutes": duration_minutes,
        "lead_lag_by_lag": lag_stats,
        "data_quality": data_quality,
    }


def get_tail_diagnostics(wick_stats: dict) -> dict:
    """Late-window wick trend used by the tail adjustment."""
    per_hour = wick_stats.get("per_hour", []) if isinstance(wick_stats, dict) else []
    wick_ratios = [h.get("avg_wick_ratio", 0.0) for h in per_hour[-12:]]
    slope = _linear_slope(wick_ratios[-5:])
    late_frequency = wick_stats.get("late_window_spike_frequency_per_hour", 0.0)
    spike_condition_met = late_frequency > TAIL_SPIKE_FREQUENCY_MIN
    wick_condition_met = slope >= TAIL_WICK_SLOPE_MIN
    if spike_condition_met and wick_condition_met:
        spike_component = min(0.30, late_frequency * 0.12)
        wick_component = min(0.20, slope * 0.10)
        adjustment = min(TAIL_ADJUSTMENT_MAX, spike_component + wick_component)
    else:
        spike_component = 0.0
        wick_component = 0.0
        adjustment = 0.0
    status = "elevated" if adjustment >= 0.15 else "normal"
    return {
        "late_window_spike_frequency_per_hour": late_frequency,
        "wick_ratio_current": round(wick_ratios[-1], 3) if wick_ratios else 0.0,
        "wick_ratio_slope": round(slope, 4),
        "wick_ratio_5h_trend": [round(value, 3) for value in wick_ratios[-5:]],
        "wick_ratio_trend_status": status,
        "tail_adjustment": round(adjustment, 4),
        "evidence": {
            "spike_condition_met": spike_condition_met,
            "wick_condition_met": wick_condition_met,
            "requires_both_conditions": True,
            "spike_component": round(spike_component, 4),
            "wick_component": round(wick_component, 4),
        },
        "tail_adjustment_reason": (
            f"late_window_spike_frequency={late_frequency:.3f} "
            f"(required >{TAIL_SPIKE_FREQUENCY_MIN:.3f}); "
            f"wick_ratio_slope={slope:.3f} "
            f"(required >={TAIL_WICK_SLOPE_MIN:.3f})"
        ),
    }


def _apply_tail_adjustment(probability: float, adjustment: float) -> float:
    """Raise the chance of a touch without allowing adjustment to exceed bounds."""
    return min(1.0, max(0.0, probability * (1.0 + adjustment)))


def _apply_probability_correction(probability: float, correction: dict) -> float:
    """Shrink a raw model probability using empirical-Bayes calibration."""
    factor = float(correction.get("correction_factor", 1.0) or 1.0)
    floor = float(correction.get("floor", 0.0) or 0.0)
    return max(probability * factor, floor)


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
    distribution: str = "student_t",
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

    if distribution == "normal":
        return max(0.0, _normal_cdf(z_high) - _normal_cdf(z_low))
    return max(0.0, _student_t_cdf(z_high, df) - _student_t_cdf(z_low, df))


def _probs_from_sigma(
    spot, upper, lower, sigma_hourly_pct, drift_pct, df, minutes_remaining,
    distribution: str = "student_t"
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
    if distribution == "normal":
        cdf = _normal_cdf
    else:
        cdf = lambda value: _student_t_cdf(value, df)
    p_above = 1 - cdf(z_up)
    p_below = cdf(z_lo)
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
    from calibration_ledger import get_calibration_report
    calibration_report = get_calibration_report()
    distribution_selection = calibration_report.get("distribution_selection", {
        "active_distribution": "student_t",
        "reason": "calibration report unavailable; Student-t default retained",
    })
    active_distribution = distribution_selection.get("active_distribution", "student_t")
    probability_correction = calibration_report.get("probability_correction", {
        "correction_factor": 1.0,
        "active": False,
        "floor": 0.0,
        "reason": "calibration report unavailable; correction disabled",
    })

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
    ladder_feed_status = {
        "status": ladder.get("status", "error") if isinstance(ladder, dict) else "error",
        "error": ladder.get("error") if isinstance(ladder, dict) else "invalid ladder payload",
        "candidate_band_count": len(bands),
        "usable_band_count": 0,
    }

    # --- Wick statistics must precede pricing so tail pressure is consumed ---
    candles_1m = get_minute_candles(360)
    wick_stats = compute_wick_stats(candles_1m)
    tail_diagnostics = get_tail_diagnostics(wick_stats)
    tail_adjustment = tail_diagnostics["tail_adjustment"]

    strike_probs = []
    for band in bands:
        low, high = band.get("low"), band.get("high")
        ask, bid = band.get("yes_ask"), band.get("yes_bid")
        side = band.get("side_vs_spot", "ABOVE_SPOT")
        if low is None or high is None or ask is None:
            continue

        low_pct = (low - spot) / spot * 100
        high_pct = (high - spot) / spot * 100
        p_normal = _band_probability(
            low, high, spot, sigma_hourly_pct, drift_pct, df, minutes_to_expiry,
            distribution="normal",
        )
        p_student_t = _band_probability(
            low, high, spot, sigma_hourly_pct, drift_pct, df, minutes_to_expiry
        )
        p_selected = p_normal if active_distribution == "normal" else p_student_t
        p_base = p_selected
        p_calibrated = _apply_probability_correction(p_base, probability_correction)
        p_touch = _apply_tail_adjustment(p_calibrated, tail_adjustment)

        fair_value = p_touch * 100
        residual = ask - fair_value
        tail_delta = p_student_t - p_normal

        strike_probs.append({
            "band": f"${low:,.0f}-${high:,.0f}",
            "side": side,
            "yes_ask": ask,
            "yes_bid": bid,
            "model_fair_cents": round(fair_value, 1),
            "residual_cents": round(residual, 1),
            "flagged": residual > RESIDUAL_FLAG_THRESHOLD_CENTS,
            "p_normal": round(p_normal, 3),
            "p_student_t": round(p_student_t, 3),
            "p_selected": round(p_selected, 3),
            "selected_distribution": active_distribution,
            "p_base": round(p_base, 5),
            "p_calibrated": round(p_calibrated, 5),
            "calibration_factor": probability_correction.get("correction_factor", 1.0),
            "tail_delta": round(tail_delta, 3),
            "tail_premium_cents": round(tail_delta * 100, 1),
            "p_touch_raw": round(p_base, 3),
            "tail_adjustment": tail_adjustment,
            "p_touch_adjusted": round(p_touch, 3),
            "p_touch": round(p_touch, 3),
            "low": low,
            "high": high,
        })

    ladder_feed_status["usable_band_count"] = len(strike_probs)

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
        row = {
            "band": f"${low:,.0f}-${high:,.0f}",
            "side": side,
        }
        for m in DECAY_TABLE_MINUTES:
            if minutes_to_expiry > m:
                p = _band_probability(
                    low, high, spot, sigma_hourly_pct, drift_pct, df, m
                )
                p_normal = _band_probability(
                    low, high, spot, sigma_hourly_pct, drift_pct, df, m,
                    distribution="normal",
                )
                p_student_t = p
                p_selected = p_normal if active_distribution == "normal" else p_student_t
                p_base = p_selected
                p_calibrated = _apply_probability_correction(p_base, probability_correction)
                adjusted = _apply_tail_adjustment(p_calibrated, tail_adjustment)
                row[f"p_{m}m"] = round(adjusted, 3)
                row[f"p_normal_{m}m"] = round(p_normal, 3)
                row[f"p_student_t_{m}m"] = round(p_student_t, 3)
                row[f"p_base_{m}m"] = round(p_base, 5)
                row[f"p_calibrated_{m}m"] = round(p_calibrated, 5)
                row[f"calibration_factor_{m}m"] = probability_correction.get(
                    "correction_factor", 1.0
                )
                row[f"selected_distribution_{m}m"] = active_distribution
                row[f"tail_adjustment_{m}m"] = tail_adjustment
        decay_table.append(row)

    alt_signal = get_alt_signal()

    from calibration_ledger import record_prediction
    for strike in strike_probs:
        record_prediction(
            timestamp=now,
            band=strike["band"],
            low=strike["low"],
            high=strike["high"],
            expiry=now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1),
            p_touch=strike["p_touch_adjusted"],
            p_normal=strike["p_normal"],
            p_student_t=strike["p_student_t"],
            tail_adjustment=strike["tail_adjustment"],
            alt_aligned=alt_signal.get("aligned", False),
            minutes_to_expiry=minutes_to_expiry,
            p_base=strike["p_base"],
            p_calibrated=strike["p_calibrated"],
            calibration_factor=strike["calibration_factor"],
        )
    calibration_report = get_calibration_report()

    full_hour_probs = _probs_from_sigma(
        spot, upper_bound, lower_bound, sigma_hourly_pct, drift_pct, df, 60,
        active_distribution
    )
    remaining_probs = _probs_from_sigma(
        spot, upper_bound, lower_bound, sigma_hourly_pct, drift_pct, df,
        minutes_to_expiry, active_distribution
    )

    return {
        "timestamp_utc": now.isoformat(),
        "minutes_to_hourly_expiry": minutes_to_expiry,
        "spot": spot,
        "spot_source": spot_data.get("source", "unavailable"),
        "canonical_spot_source": spot_data.get("canonical_source", "BRTI"),
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
            "fit_status": "fitted" if len(log_returns) >= 20 else "unstable_fit_fallback",
            "normal_fallback_active": len(log_returns) < 20,
            "active_distribution": active_distribution,
        },
        "tail_diagnostics": tail_diagnostics,
        "alt_signal": alt_signal,
        "alt_alignment_warning": alt_signal.get("aligned", False),
        "calibration": calibration_report,
        "distribution_selection": distribution_selection,
        "probability_correction": probability_correction,
        "ladder_feed_status": ladder_feed_status,
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
