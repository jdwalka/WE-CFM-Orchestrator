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
import random
import re
import time

def enforce_freshness(payload: dict, source: str) -> None:
    '''Lane 2 timestamp staleness gate'''
    if not payload:
        return
    import time
    from datetime import datetime, timezone
    
    # Check collector_timestamp, timestamp_utc, time, or ts
    ts_str = payload.get("collector_timestamp") or payload.get("timestamp_utc") or payload.get("time") or payload.get("ts")
    if ts_str:
        try:
            # Handle ISO formats
            dt = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - dt).total_seconds()
        except Exception:
            age = 0
            
        if age > 60:
            raise ValueError(f"STALE: {source} data is {age:.1f}s old")
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import requests

from calibration_buckets import bucket_key
from market_data import compute_stats, get_hourly_candles, get_spot
from staleness_guard import MarketData, StalenessGuard, Verdict

# ---------------------------------------------------------------------------
# Model parameters (single source of truth; exposed via /weights)
# ---------------------------------------------------------------------------
LOOKBACK_HOURS = 4380
LIVE_VOLATILITY_HOURS = 24
BODY_PERCENTILE = 0.60
MOMENTUM_LOOKBACK_HOURS = 6
BIAS_THRESHOLD = 0.10
UPPER_RANGE_FACTOR = 0.45
LOWER_RANGE_FACTOR = 0.55
CENTER_SHIFT_FACTOR = 0.30
DRIFT_FACTOR = 0.40
MIN_RANGE_PCT = 0.25
HIGH_REGIME_MIN_RANGE_PCT = 0.50
VOLATILITY_SPIKE_PERCENTILE = 0.85
PROBABILITY_CORRECTION_MAX_FACTOR = 4.0

# Fat-tail / wick / regime parameters
HOUR_SAMPLE_SIZE = 4380               # hours of candles for distribution fitting
SPIKE_THRESHOLD_PCT = 0.3            # 1-minute move classified as a "spike"
FINAL_MINUTES_WINDOW = 15            # final minutes of hour for wick stats
REGIME_LOOKBACK_HOURS = 4380      # 30 days of hourly candles
DECAY_TABLE_MINUTES = [30, 20, 15, 10, 5, 1]
RESIDUAL_FLAG_THRESHOLD_CENTS = 5.0  # flag ladder bands >5¢ above model
ARTIFACT_RESIDUAL_THRESHOLD_CENTS = 30.0
STUDENT_T_DF_DEFAULT = 4.0           # fallback if empirical fit is unstable
TAIL_ADJUSTMENT_MAX_CENTS = 0.15
TAIL_SPIKE_COMPONENT_MAX_CENTS = 0.075
TAIL_WICK_COMPONENT_MAX_CENTS = 0.075
TAIL_LIQUIDATION_COMPONENT_MAX_CENTS = 0.05
LIQUIDATION_BURST_DEFAULT_USD = 500_000
LIQUIDATION_BURST_MIN_SAMPLES = 1
WICK_RATIO_MIN_BODY_PCT = 0.01       # ignore near-zero-body ratio artifacts
WICK_RATIO_MAX = 10.0                 # clamp one-candle ratio spikes
TAIL_SPIKE_FREQUENCY_MIN = 0.0005
TAIL_WICK_SLOPE_MIN = 0.10
ALT_ALIGNMENT_RATIO_UP = 0.55
ALT_ALIGNMENT_RATIO_DOWN = 0.45
ALT_ALIGNMENT_MINUTES = 10
ALT_ALIGNMENT_ENABLED = False
ALT_LEAD_LAG_MINUTES = [1, 2, 3, 4, 5]
ALT_LEAD_LAG_SAMPLE_SIZE = 120
ALT_SIGNAL_MIN_STRENGTH = 0.002
LEAD_LAG_BACKTEST_MIN_LAGS = 3
LEAD_LAG_BACKTEST_MIN_CORRELATION = 0.05
LEAD_LAG_BACKTEST_MIN_CONSISTENT_LAGS = 3
CROSS_VENUE_DIVERGENCE_HISTORY_SIZE = 100
CROSS_VENUE_DIVERGENCE_MIN_HISTORY = 20
CROSS_VENUE_TAIL_PROBABILITY_MAX = 0.20
CROSS_VENUE_TAIL_ADJUSTMENT = 0.15
CROSS_VENUE_REGIME_ACTIVATE_READINGS = 2
CROSS_VENUE_REGIME_DEACTIVATE_READINGS = 3
DIVERGENCE_ADJUSTMENT_MAX_CENTS = 0.15
SETTLEMENT_HOLD_PRIOR = 1.0
SETTLEMENT_HOLD_PRIOR_STRENGTH = 30.0
SETTLEMENT_HOLD_MIN_SAMPLES = 20
POSITIONING_FUNDING_NORMALIZATION = 0.001
POSITIONING_OI_DELTA_NORMALIZATION = 5.0
POSITIONING_SKEW_MAX_PCT = 0.03
COINBASE_L2_URL = "http://127.0.0.1:8793"
V_RATIO_WHIPSAW_THRESHOLD = 0.005
WICK_TREND_FLAT_SLOPE = 0.05
SPOT_STALENESS_MIN_PCT_OF_SPOT = 0.0003
SPOT_STALENESS_BAND_WIDTH_PCT = 0.10
KALSHI_SETTLEMENT_VENUE = "CF Benchmarks RTI"
KALSHI_SETTLEMENT_RULE = "60-second RTI average before expiry"
KALSHI_MARKETS_URL = "https://api.elections.kalshi.com/trade-api/v2/markets"
KALSHI_15M_SERIES = "KXBTC15M"

_HEADERS = {"User-Agent": "wecryp-jdwalkaz/1.0 (+https://agentverse.ai)"}
COINBASE_CANDLES = "https://api.exchange.coinbase.com/products/BTC-USD/candles"
BINANCE_SPOT_URL = "https://api.binance.com/api/v3/ticker/bookTicker"
OKX_SPOT_URL = "https://www.okx.com/api/v5/market/ticker"
BINANCE_FUTURES_URL = "https://fapi.binance.com/fapi/v1"
MARKET_DATA_WORKER_URL = os.getenv(
    "MARKET_DATA_WORKER_URL", "https://scalper-market-data.gitgoin87.workers.dev"
)
KODAK_ARCHIVER_URL = os.getenv(
    "KODAK_ARCHIVER_URL", "https://kodak-market-archiver.gitgoin87.workers.dev"
).rstrip("/")

# Resilient /kalshi/bands parameters (upstream intermittently 502s on rate-limit)
BANDS_CACHE_TTL_SECONDS = 60.0
BANDS_MAX_ATTEMPTS = 3
BANDS_BASE_DELAY_SECONDS = 0.4
BANDS_JITTER_SECONDS = 0.25
BANDS_RETRYABLE_STATUSES = {429, 502, 503, 504}
_bands_cache = {"data": None, "ts": 0.0}

_TICKER_STRIKE_RE = re.compile(r"-([BS])(\d{4,})$")

_cross_venue_divergence_history = []
_open_interest_history = []

# ---------------------------------------------------------------------------
# Ladder Memory Engine (LME) — four-force physics state detector
# Singleton persists across predict_hourly_range() calls for memory kernel.
# ---------------------------------------------------------------------------
_lme_engine = None  # type: ignore  # LME instance, lazy-imported


def _lme_step(
    spot: float,
    current_hourly_range: float,
    band_edges: list,
) -> dict:
    """
    Run one LME tick. Fetches Coinbase L2 book (30 levels, 2s timeout).
    Never raises — returns {"available": False, "error": ...} on any failure.
    Called once per predict_hourly_range() invocation; the singleton LME
    preserves rung memory (touch counts, strength decay) across calls.
    """
    global _lme_engine
    try:
        import urllib.request as _ur
        import json as _json
        from lme_codex import LME, fetch_band_edges as _fe  # noqa: PLC0415

        if _lme_engine is None:
            _lme_engine = LME()
            _lme_engine.hour_open = spot  # anchor to first call this hour

        # Fetch Coinbase L2 book — lightweight, 2s timeout, 30 levels
        bids: list = []
        asks: list = []
        try:
            _book_req = _ur.Request(
                "https://api.exchange.coinbase.com/products/BTC-USD/book?level=2",
                headers={"User-Agent": "wecryp-lme/1.0"},
            )
            with _ur.urlopen(_book_req, timeout=2.0) as _r:
                _book = _json.loads(_r.read().decode())
            bids = [
                (float(p), float(p) * float(s))
                for p, s, _ in _book.get("bids", [])[:30]
            ]
            asks = [
                (float(p), float(p) * float(s))
                for p, s, _ in _book.get("asks", [])[:30]
            ]
        except Exception:
            pass  # wall scan degrades to zeros — LME still runs for recoil force

        out = _lme_engine.step(
            price=spot,
            t=time.time(),
            bids=bids,
            asks=asks,
            band_edges=band_edges,
        )
        out["available"] = True
        out["book_levels"] = len(bids)
        return out

    except Exception as exc:
        return {"available": False, "error": str(exc)}


class DivergenceRegime:
    """Hysteresis for the cross-venue dispersion regime.

    Two consecutive elevated readings activate the regime; three consecutive
    normal readings deactivate it. This prevents a dispersion print sitting on
    the rolling 90th percentile from flipping the adjustment on every snapshot.
    """

    def __init__(
        self,
        activate_after: int = CROSS_VENUE_REGIME_ACTIVATE_READINGS,
        deactivate_after: int = CROSS_VENUE_REGIME_DEACTIVATE_READINGS,
        max_adjustment_cents: float = DIVERGENCE_ADJUSTMENT_MAX_CENTS,
    ):
        self.activate_after = activate_after
        self.deactivate_after = deactivate_after
        self.max_adjustment_cents = max_adjustment_cents
        self.state = "normal"
        self.elevated_streak = 0
        self.normal_streak = 0

    def reset(self) -> None:
        self.state = "normal"
        self.elevated_streak = 0
        self.normal_streak = 0

    def update(self, current_pct: float, rolling_90th_pct: float | None) -> dict:
        elevated = (
            rolling_90th_pct is not None
            and math.isfinite(float(rolling_90th_pct))
            and current_pct > float(rolling_90th_pct)
        )
        if elevated:
            self.elevated_streak += 1
            self.normal_streak = 0
        else:
            self.normal_streak += 1
            self.elevated_streak = 0

        if self.state == "normal" and self.elevated_streak >= self.activate_after:
            self.state = "elevated"
        elif self.state == "elevated" and self.normal_streak >= self.deactivate_after:
            self.state = "normal"

        adjustment = self.max_adjustment_cents if self.state == "elevated" else 0.0
        return {
            "regime": self.state,
            "active": self.state == "elevated",
            "raw_active": elevated,
            "tail_adjustment": adjustment,
            "tail_adjustment_cents": adjustment * 100,
            "elevated_streak": self.elevated_streak,
            "normal_streak": self.normal_streak,
        }


_cross_venue_divergence_regime = DivergenceRegime()


def _format_kalshi_strike(value) -> str:
    """Format a Kalshi BTC strike at the venue's 2-decimal settlement precision."""
    if value is None or not isinstance(value, (int, float)) or not math.isfinite(value):
        return "—"
    return f"${value:,.2f}"


# ---------------------------------------------------------------------------
# Data access
# ---------------------------------------------------------------------------

def _fetch_edge_calibration() -> dict:
    """Fetch live calibration data from the edge worker."""
    import os
    import requests
    edge_secret = os.environ.get("SCALPER_API_SECRET")
    if edge_secret:
        try:
            r = requests.get(
                "https://scalper.leaksnipe.win/calibration/latest", 
                headers={"Authorization": f"Bearer {edge_secret}"}, 
                timeout=2
            )
            if r.ok:
                data = r.json().get("data")
                if data:
                    return data
        except Exception:
            pass
    return {}

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


def _bands_backoff_delay(attempt: int) -> float:
    delay = BANDS_BASE_DELAY_SECONDS * (2 ** (attempt - 1))
    return delay + random.uniform(-BANDS_JITTER_SECONDS, BANDS_JITTER_SECONDS)


def normalize_band_strike(contract: dict) -> dict:
    """Trust the ticker-encoded strike over the stored (floor'd) strike field.

    Live data confirmed the scaling: ticker KXBTC-26SEP1304-B75750 pairs with
    stored strike 75700 -- the ticker number is dollars directly (no /10).
    When the two disagree by >= $25 the ticker wins and the row is stamped
    strike_source: "ticker".
    """
    try:
        match = _TICKER_STRIKE_RE.search(str(contract.get("ticker", "")))
        if not match:
            return contract
        ticker_strike = int(match.group(2))
        stored = contract.get("strike")
        if stored is not None and abs(ticker_strike - float(stored)) >= 25:
            return {**contract, "strike": ticker_strike, "strike_source": "ticker"}
        return contract
    except (TypeError, ValueError):
        return contract


def _normalize_bands_payload(payload: dict) -> dict:
    bands = payload.get("candidate_bands")
    if isinstance(bands, list):
        payload["candidate_bands"] = [normalize_band_strike(b) for b in bands if isinstance(b, dict)]
        return payload
    if isinstance(bands, dict):
        for key, value in list(bands.items()):
            if isinstance(value, list):
                bands[key] = [normalize_band_strike(b) for b in value if isinstance(b, dict)]
        payload["candidate_bands"] = bands
        return payload
    return payload


def _fetch_bands_from_snapshot() -> dict:
    """Fallback: pull the Kalshi ladder out of the Kodak collector snapshot."""
    try:
        from kodak_bridge import get_kodak_snapshot

        snapshot = get_kodak_snapshot(include_model=False)
        kalshi = snapshot.get("contracts", {}).get("kalshi_kxbtc", {})
        if not isinstance(kalshi, dict) or not kalshi.get("ok"):
            raise ValueError("snapshot fallback: no kalshi_kxbtc contracts")
        return kalshi
    except Exception as exc:
        raise ValueError(f"snapshot fallback failed: {exc}") from exc


def get_kalshi_ladder(force_refresh: bool = True) -> dict:
    '''Resilient Kalshi hourly band ladder with Lane 1 backoff, freshness enforcement, and market hours gating.'''
    now = time.time()
    if force_refresh:
        _bands_cache["data"] = None
        _bands_cache["ts"] = 0.0
    cached = _bands_cache["data"]
    if (
        not force_refresh
        and cached is not None
        and now - _bands_cache["ts"] < BANDS_CACHE_TTL_SECONDS
        and cached.get("status") == "ok"
        and cached.get("minutes_to_expiry", 0) <= 65
    ):
        served_age = cached.get("age_seconds", 0) + (now - _bands_cache["ts"])
        if served_age <= BANDS_CACHE_TTL_SECONDS:
            return {
                **deepcopy(cached),
                "status": "ok",
                "error": None,
                "_cache": "hit",
                "cache": "hit",
                "age_seconds": round(served_age, 1),
                "_source": "cache",
                "_ts": _bands_cache["ts"],
            }

    last_primary_error = None
    
    # Lane 1: retry with backoff (3 attempts, 2s/4s/8s)
    delays = [2, 4, 8]
    for attempt in range(3):
        try:
            params = {"fresh": "1"} if force_refresh else {}
            response = requests.get(
                f"{MARKET_DATA_WORKER_URL}/kalshi/bands",
                params=params,
                headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json()
            
            # Lane 2: enforce freshness
            enforce_freshness(payload, "ladder")

            # Check market status: if Kalshi hourly market is closed or contract > 65m away
            status = payload.get("status", "ok")
            minutes_to_expiry = payload.get("minutes_to_expiry")
            is_closed = (
                status == "MARKET_CLOSED"
                or (isinstance(minutes_to_expiry, (int, float)) and minutes_to_expiry > 65)
            )

            if is_closed:
                error_msg = payload.get("error") or (
                    f"Kalshi hourly market closed (event {payload.get('event_ticker')} expires in {minutes_to_expiry:.0f}m)"
                    if minutes_to_expiry else "Kalshi hourly market closed"
                )
                res = {
                    "status": "MARKET_CLOSED",
                    "error": error_msg,
                    "candidate_bands": [],
                    "minutes_to_expiry": minutes_to_expiry,
                    "event_ticker": payload.get("event_ticker"),
                    "market_active": False,
                    "collector_timestamp": payload.get("collector_timestamp"),
                    "_cache": "miss",
                    "_source": "primary_worker",
                    "_ts": time.time(),
                }
                _bands_cache["data"] = None  # Do not cache closed market as valid ladder
                _bands_cache["ts"] = 0.0
                return res
            
            payload = _normalize_bands_payload(payload)
            
            # Lane 1: Add collector_timestamp freshness check to ladder response
            if "collector_timestamp" not in payload:
                from datetime import datetime, timezone
                payload["collector_timestamp"] = datetime.now(timezone.utc).isoformat()
                
            payload = {
                **deepcopy(payload),
                "status": "ok",
                "error": None,
                "_cache": "miss",
                "_source": "primary_worker",
                "_ts": time.time(),
            }
            _bands_cache["data"] = deepcopy(payload)
            _bands_cache["ts"] = time.time()
            return payload
        except requests.exceptions.RequestException as e:
            last_primary_error = str(e)
            if attempt < 2:
                time.sleep(delays[attempt])
        except ValueError as e:
            last_primary_error = str(e)
            if attempt < 2:
                time.sleep(delays[attempt])

    # Middle lane: our own kalshi-ladder-worker (strictly Kalshi hourly
    # "between" bands). Used when the primary market-data worker is down
    # (it was overwritten by an assets deploy) and before the kodak
    # snapshot fallback. Shape-mapped into candidate_bands.
    # NOTE: aliased datetime import — get_kalshi_ladder has a local
    # `from datetime import ...` further down that shadows the module name
    # for the whole function scope; plain datetime.now() raises
    # UnboundLocalError on paths that skip that import.
    from datetime import datetime as _dt, timezone as _tz
    try:
        ladder_base = os.getenv(
            "LADDER_WORKER_URL", "https://ladder.leaksnipe.win").rstrip("/")
        lres = requests.get(
            f"{ladder_base}/ladder",
            params={"symbol": "BTC"},
            headers={"User-Agent": "wecrypto-engine/1.0"},
            timeout=15,
        )
        lres.raise_for_status()
        ldata = lres.json()
        lbands = [b for b in (ldata.get("bands") or []) if isinstance(b, dict)]
        lbands = [b for b in lbands
                  if isinstance(b.get("low"), (int, float))
                  and isinstance(b.get("high"), (int, float))]
        # Our ladder worker emits Kalshi fp quote fields as strings
        # ("0.0100"); the strike loop needs floats for residual math.
        for _b in lbands:
            for _k in ("yes_ask", "yes_bid",
                       "yes_ask_dollars", "yes_bid_dollars"):
                try:
                    if _b.get(_k) is not None:
                        _b[_k] = float(_b[_k])
                except (TypeError, ValueError):
                    _b[_k] = None
        if lbands:
            expiries = [b.get("minutes_to_expiry") for b in lbands
                        if isinstance(b.get("minutes_to_expiry"), (int, float))]
            payload = _normalize_bands_payload({
                "candidate_bands": lbands,
                "minutes_to_expiry": min(expiries) if expiries else None,
                "event_ticker": "KXBTC-hourly",
                "market_active": True,
                # Freshness is proven by this live fetch (just completed),
                # not by the KV write timestamp (60s TTL races the 60s gate).
                "collector_timestamp": _dt.now(_tz.utc).isoformat(),
                "kv_fetched_at": ldata.get("fetched_at"),
                "status": "ok",
                "error": None,
                "_cache": "miss",
                "_source": "ladder_worker",
                "_primary_error": last_primary_error,
                "_ts": time.time(),
            })
            enforce_freshness(payload, "ladder_worker")
            _bands_cache["data"] = deepcopy(payload)
            _bands_cache["ts"] = time.time()
            return payload
        last_primary_error = "ladder_worker: empty band list"
    except Exception as e:
        last_primary_error = f"ladder_worker: {e}"

    # When force_refresh=True, never fall back to snapshot — API must succeed or return FEED_DOWN
    if force_refresh:
        # Lanes 1-3 already attempted; no more retries, no snapshot fallback.
        return {
            "status": "FEED_DOWN",
            "error": "force_refresh=true: Kalshi ladder API unreachable after retries; refusing stale fallback",
            "candidate_bands": [],
            "_primary_error": last_primary_error,
            "_cache": "stale_refused",
            "_ts": time.time(),
        }

    try:
        ladder = _fetch_bands_from_snapshot()
        enforce_freshness(ladder, "snapshot_ladder")
        payload = {
            **deepcopy(ladder),
            "candidate_bands": ladder.get("markets", []),
            "status": "ok",
            "error": None,
            "_cache": "miss",
            "_source": "snapshot_fallback",
            "_primary_error": last_primary_error,
            "_ts": time.time(),
        }
        payload = _normalize_bands_payload(payload)
        _bands_cache["data"] = deepcopy(payload)
        _bands_cache["ts"] = time.time()
        return payload
    except ValueError as fallback_error:
        # Lane 1: explicit FEED_DOWN status - never serve stale quotes as live
        return {
            "status": "FEED_DOWN",
            "error": str(fallback_error),
            "candidate_bands": [],
            "_primary_error": last_primary_error,
            "_cache": "stale_refused"
        }



def _percentile(values: list, percentile: float) -> float | None:
    """Return a deterministic percentile without external dependencies."""
    ordered = sorted(value for value in values if isinstance(value, (int, float)) and math.isfinite(value))
    if not ordered:
        return None
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def get_cross_venue_spot_prices() -> list[float]:
    """Fetch concurrent BTC spot prices from Coinbase, Binance, and OKX."""
    prices = []
    coinbase = get_spot()
    if coinbase.get("price") is not None:
        prices.append(float(coinbase["price"]))

    try:
        response = requests.get(
            BINANCE_SPOT_URL,
            params={"symbol": "BTCUSDT"},
            headers=_HEADERS,
            timeout=10,
        )
        response.raise_for_status()
        price = float(response.json()[0]["price"])
        if math.isfinite(price) and price > 0:
            prices.append(price)
    except (requests.RequestException, KeyError, IndexError, TypeError, ValueError):
        pass

    try:
        response = requests.get(
            OKX_SPOT_URL,
            params={"instId": "BTC-USDT"},
            headers=_HEADERS,
            timeout=10,
        )
        response.raise_for_status()
        price = float(response.json()["data"][0]["last"])
        if math.isfinite(price) and price > 0:
            prices.append(price)
    except (requests.RequestException, KeyError, IndexError, TypeError, ValueError):
        pass
    return prices


def get_cross_venue_divergence() -> dict:
    """Measure cross-venue spot dispersion against its rolling 90th percentile."""
    prices = get_cross_venue_spot_prices()
    if len(prices) < 2:
        return {
            "current_pct": None,
            "rolling_90th_pct_pct": None,
            "active": False,
            "regime": "unavailable",
            "sample_size": len(prices),
            "history_size": len(_cross_venue_divergence_history),
            "tail_adjustment": 0.0,
            "reason": "fewer than two venue prices available",
        }

    median_price = _median(prices)
    current = ((max(prices) - min(prices)) / median_price) * 100 if median_price > 0 else 0.0
    threshold = (
        _percentile(_cross_venue_divergence_history, 0.90)
        if len(_cross_venue_divergence_history) >= CROSS_VENUE_DIVERGENCE_MIN_HISTORY
        else None
    )
    _cross_venue_divergence_history.append(current)
    del _cross_venue_divergence_history[:-CROSS_VENUE_DIVERGENCE_HISTORY_SIZE]
    regime_state = _cross_venue_divergence_regime.update(current, threshold)
    active = regime_state["active"]
    return {
        "current_pct": round(current, 5),
        "rolling_90th_pct_pct": round(threshold, 5) if threshold is not None else None,
        "active": active,
        "regime": "elevated" if active else "normal",
        "sample_size": len(prices),
        "history_size": len(_cross_venue_divergence_history),
        "raw_tail_adjustment": CROSS_VENUE_TAIL_ADJUSTMENT if regime_state["raw_active"] else 0.0,
        "tail_adjustment": regime_state["tail_adjustment"],
        "tail_adjustment_cents": regime_state["tail_adjustment_cents"],
        "divergence_adjustment_max_cents": DIVERGENCE_ADJUSTMENT_MAX_CENTS,
        "hysteresis": {
            "activate_readings": CROSS_VENUE_REGIME_ACTIVATE_READINGS,
            "deactivate_readings": CROSS_VENUE_REGIME_DEACTIVATE_READINGS,
            "raw_active": regime_state["raw_active"],
            "elevated_streak": regime_state["elevated_streak"],
            "normal_streak": regime_state["normal_streak"],
        },
        "reason": (
            "cross-venue dispersion exceeds its rolling 90th percentile"
            if active
            else "cross-venue dispersion is within its rolling 90th percentile"
        ),
    }


def get_coinbase_l2_features() -> dict:
    """Fetch live L-ratio, V-ratio, and tau_res from local Coinbase L2 collector (port 8793)."""
    l_data = None
    v_data = None
    try:
        r = requests.get(f"{COINBASE_L2_URL}/l_ratio", timeout=0.25)
        if r.ok:
            l_data = r.json()
    except Exception:
        pass

    try:
        r = requests.get(f"{COINBASE_L2_URL}/v_ratio", timeout=0.25)
        if r.ok:
            v_data = r.json()
    except Exception:
        pass

    l_ratio = l_data.get("l_ratio") if isinstance(l_data, dict) else None
    v_ratio = v_data.get("v_ratio") if isinstance(v_data, dict) else None
    tau_res_s = v_data.get("tau_res_s") if isinstance(v_data, dict) else None

    return {
        "l_ratio": float(l_ratio) if l_ratio is not None and math.isfinite(l_ratio) else None,
        "v_ratio": float(v_ratio) if v_ratio is not None and math.isfinite(v_ratio) else None,
        "tau_res_s": float(tau_res_s) if tau_res_s is not None and math.isfinite(tau_res_s) else None,
        "l_data": l_data or {},
        "v_data": v_data or {},
        "active": l_ratio is not None and math.isfinite(l_ratio),
    }


def _positioning_skew(funding_rate: float | None, open_interest_delta_pct: float | None) -> float:
    """Mild contrarian skew from funding, amplified by OI expansion (legacy fallback)."""
    if funding_rate is None or not math.isfinite(funding_rate):
        return 0.0
    funding_component = max(
        -1.0,
        min(1.0, -funding_rate / POSITIONING_FUNDING_NORMALIZATION),
    )
    if open_interest_delta_pct is None or not math.isfinite(open_interest_delta_pct):
        return max(-POSITIONING_SKEW_MAX_PCT, min(POSITIONING_SKEW_MAX_PCT, funding_component * 0.02))

    oi_component = max(
        -1.0,
        min(1.0, open_interest_delta_pct / POSITIONING_OI_DELTA_NORMALIZATION),
    )
    skew = funding_component * 0.02 + funding_component * oi_component * 0.01
    return max(-POSITIONING_SKEW_MAX_PCT, min(POSITIONING_SKEW_MAX_PCT, skew))


def get_positioning_skew() -> dict:
    """Order-book depth imbalance (L-ratio) positioning used as a bounded drift skew."""
    l2 = get_coinbase_l2_features()
    l_ratio = l2.get("l_ratio")

    # If L-ratio from Coinbase L2 is available, use it directly (replacing geo-blocked Binance futures)
    if l_ratio is not None and math.isfinite(l_ratio):
        skew = max(-POSITIONING_SKEW_MAX_PCT, min(POSITIONING_SKEW_MAX_PCT, l_ratio * POSITIONING_SKEW_MAX_PCT))
        return {
            "source": "coinbase_l2_depth",
            "l_ratio": round(l_ratio, 5),
            "v_ratio": round(l2["v_ratio"], 6) if l2.get("v_ratio") is not None else None,
            "tau_res_s": round(l2["tau_res_s"], 4) if l2.get("tau_res_s") is not None else None,
            "funding_rate": None,
            "open_interest": None,
            "open_interest_delta_pct": None,
            "skew_pct": round(skew, 5),
            "active": True,
            "max_skew_pct": POSITIONING_SKEW_MAX_PCT,
            "rule": "order-book depth imbalance (L-ratio) bounded drift skew",
        }

    # Fallback to legacy funding rate if L2 collector is not reachable
    funding_rate = None
    open_interest = None
    try:
        response = requests.get(
            f"{BINANCE_FUTURES_URL}/premiumIndex",
            params={"symbol": "BTCUSDT"},
            headers=_HEADERS,
            timeout=1,
        )
        response.raise_for_status()
        funding_rate = float(response.json()["lastFundingRate"])
    except (requests.RequestException, KeyError, TypeError, ValueError):
        pass

    try:
        response = requests.get(
            f"{BINANCE_FUTURES_URL}/openInterest",
            params={"symbol": "BTCUSDT"},
            headers=_HEADERS,
            timeout=1,
        )
        response.raise_for_status()
        open_interest = float(response.json()["openInterest"])
    except (requests.RequestException, KeyError, TypeError, ValueError):
        pass

    open_interest_delta_pct = None
    if open_interest is not None and math.isfinite(open_interest) and open_interest > 0:
        previous = _open_interest_history[-1] if _open_interest_history else None
        if previous is not None and previous > 0:
            open_interest_delta_pct = ((open_interest - previous) / previous) * 100
        _open_interest_history.append(open_interest)
        del _open_interest_history[:-CROSS_VENUE_DIVERGENCE_HISTORY_SIZE]

    skew = _positioning_skew(funding_rate, open_interest_delta_pct)
    return {
        "source": "binance_futures_fallback",
        "l_ratio": None,
        "v_ratio": None,
        "tau_res_s": None,
        "funding_rate": funding_rate,
        "open_interest": open_interest,
        "open_interest_delta_pct": (
            round(open_interest_delta_pct, 5)
            if open_interest_delta_pct is not None
            else None
        ),
        "skew_pct": round(skew, 5),
        "active": funding_rate is not None,
        "max_skew_pct": POSITIONING_SKEW_MAX_PCT,
        "rule": "contrarian funding with OI expansion as confidence",
    }


def _parse_kalshi_time(value) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def get_kalshi_15m_contract(series_ticker: str = KALSHI_15M_SERIES) -> dict | None:
    """Fetch the nearest live Kalshi 15m up/down market."""
    try:
        response = requests.get(
            KALSHI_MARKETS_URL,
            params={"series_ticker": series_ticker, "status": "open", "limit": 100},
            headers=_HEADERS,
            timeout=15,
        )
        response.raise_for_status()
        markets = response.json().get("markets", [])
    except (requests.RequestException, AttributeError, ValueError):
        return None

    now = datetime.now(timezone.utc)
    candidates = []
    for market in markets:
        close_time = _parse_kalshi_time(market.get("close_time"))
        target = market.get("floor_strike")
        if target is None:
            target = market.get("floor_price")
        try:
            target = float(target)
        except (TypeError, ValueError):
            continue
        if close_time is None or close_time <= now or target <= 0:
            continue
        candidates.append((close_time, target, market))
    if not candidates:
        return None
    _, target, market = min(candidates, key=lambda row: row[0])
    close_time = _parse_kalshi_time(market.get("close_time"))
    return {
        "ticker": market.get("ticker"),
        "title": market.get("title"),
        "subtitle": market.get("yes_sub_title") or market.get("subtitle"),
        "strike_type": market.get("strike_type"),
        "target": target,
        "close_time": close_time,
        "yes_bid": market.get("yes_bid"),
        "yes_ask": market.get("yes_ask"),
    }


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


def _lead_lag_backtest_gate(lag_averages: dict) -> dict:
    """Require sign-consistent, material lag evidence before signal output."""
    values = [value for value in lag_averages.values() if isinstance(value, (int, float))]
    if len(values) < LEAD_LAG_BACKTEST_MIN_LAGS:
        return {
            "passed": False,
            "status": "excluded",
            "reason": "insufficient lag windows",
            "consistent_lags": 0,
            "average_correlation": 0.0,
        }

    average_correlation = sum(values) / len(values)
    if abs(average_correlation) < LEAD_LAG_BACKTEST_MIN_CORRELATION:
        return {
            "passed": False,
            "status": "excluded",
            "reason": "average lead-lag correlation below floor",
            "consistent_lags": 0,
            "average_correlation": round(average_correlation, 4),
        }

    direction = 1 if average_correlation > 0 else -1
    consistent_lags = sum(
        1 for value in values if value * direction >= LEAD_LAG_BACKTEST_MIN_CORRELATION
    )
    passed = consistent_lags >= LEAD_LAG_BACKTEST_MIN_CONSISTENT_LAGS
    return {
        "passed": passed,
        "status": "stable" if passed else "excluded",
        "reason": (
            "lead-lag sign is stable and material"
            if passed
            else "lead-lag sign is unstable across lag windows"
        ),
        "consistent_lags": consistent_lags,
        "average_correlation": round(average_correlation, 4),
    }


def _filter_alt_signal(signal: dict | None) -> tuple[dict | None, dict]:
    """Suppress unstable lead-lag signals instead of emitting neutral noise."""
    if not isinstance(signal, dict) or signal.get("lead_lag_status") != "stable":
        return None, {
            "gated": True,
            "status": "excluded",
            "reason": "lead-lag backtest gate rejected the signal",
        }
    gate = signal.get("lead_lag_backtest", {})
    return signal, {
        "gated": True,
        "status": "stable",
        "reason": gate.get("reason", "lead-lag backtest gate passed"),
    }


def get_alt_signal() -> dict:
    """Cross-asset SOL/ETH lead-lag and taker-flow alignment gate."""
    if not ALT_ALIGNMENT_ENABLED:
        return None
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

    lead_lag_backtest = _lead_lag_backtest_gate(lag_averages)
    lead_lag_status = "stable" if lead_lag_backtest["passed"] else "unstable"
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
    strength_is_actionable = strength >= ALT_SIGNAL_MIN_STRENGTH
    if not strength_is_actionable:
        direction = "neutral"
        aligned = False
    return {
        "direction": direction,
        "strength": round(strength, 6),
        "strength_status": "actionable" if strength_is_actionable else "below_floor",
        "strength_floor": ALT_SIGNAL_MIN_STRENGTH,
        "aligned": aligned,
        "lead_lag_corr": round(best_correlation, 4),
        "best_lag_minutes": best_lag,
        "lead_lag_status": lead_lag_status,
        "lead_lag_averages": {str(lag): round(value, 4) for lag, value in lag_averages.items()},
        "lead_lag_backtest": lead_lag_backtest,
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


def get_tail_diagnostics(
    wick_stats: dict,
    liquidations: dict | None = None,
    l2_features: dict | None = None,
) -> dict:
    """Late-window wick trend, liquidation cascade, and L2 whipsaw velocity co-trigger."""
    per_hour = wick_stats.get("per_hour", []) if isinstance(wick_stats, dict) else []
    wick_ratios = [h.get("avg_wick_ratio", 0.0) for h in per_hour[-12:]]
    slope = _linear_slope(wick_ratios[-5:])
    late_frequency = wick_stats.get("late_window_spike_frequency_per_hour", 0.0)
    spike_condition_met = late_frequency > TAIL_SPIKE_FREQUENCY_MIN
    wick_condition_met = slope >= TAIL_WICK_SLOPE_MIN
    spike_component = (
        min(TAIL_SPIKE_COMPONENT_MAX_CENTS, late_frequency * 0.20)
        if spike_condition_met
        else 0.0
    )
    wick_component = (
        min(TAIL_WICK_COMPONENT_MAX_CENTS, slope * 0.04)
        if wick_condition_met
        else 0.0
    )

    # Whipsaw gate: V-ratio (flow velocity / resting depth scaled by fitted tau_res) as second co-trigger
    l2 = l2_features if isinstance(l2_features, dict) else get_coinbase_l2_features()
    v_ratio = l2.get("v_ratio")
    tau_res_s = l2.get("tau_res_s")
    v_ratio_active = v_ratio is not None and math.isfinite(v_ratio)
    v_condition_met = v_ratio_active and v_ratio >= V_RATIO_WHIPSAW_THRESHOLD
    price_trigger_met = spike_condition_met or wick_condition_met
    whipsaw_co_triggered = price_trigger_met and v_condition_met
    whipsaw_component = (
        min(0.025, v_ratio * 2.0)
        if whipsaw_co_triggered
        else 0.0
    )

    # Gated liquidation cascade feature
    liq = liquidations or {}
    liq_burst = bool(liq.get("burst", False))
    liq_notional = float(liq.get("notional_usd_15m", 0.0) or 0.0)
    liq_long_share = liq.get("long_share")
    events_count = int(liq.get("events_15m", 0) or 0)
    liq_gated_passed = liq_burst and events_count >= LIQUIDATION_BURST_MIN_SAMPLES

    liq_component = 0.0
    liq_skew_direction = "neutral"
    if liq_gated_passed:
        liq_component = min(
            TAIL_LIQUIDATION_COMPONENT_MAX_CENTS,
            (liq_notional / LIQUIDATION_BURST_DEFAULT_USD) * 0.025,
        )
        if liq_long_share is not None:
            if liq_long_share >= 0.65:
                liq_skew_direction = "down"
            elif liq_long_share <= 0.35:
                liq_skew_direction = "up"

    adjustment = min(
        TAIL_ADJUSTMENT_MAX_CENTS,
        spike_component + wick_component + liq_component + whipsaw_component,
    )
    if slope > WICK_TREND_FLAT_SLOPE:
        trend_status = "rising"
    elif slope < -WICK_TREND_FLAT_SLOPE:
        trend_status = "falling"
    else:
        trend_status = "flat"
    tail_status = "elevated" if adjustment > 0 else "normal"
    return {
        "late_window_spike_frequency_per_hour": late_frequency,
        "wick_ratio_current": round(wick_ratios[-1], 3) if wick_ratios else 0.0,
        "wick_ratio_slope": round(slope, 4),
        "wick_ratio_5h_trend": [round(value, 3) for value in wick_ratios[-5:]],
        "wick_ratio_trend_status": trend_status,
        "tail_pressure_status": tail_status,
        "tail_adjustment": round(adjustment, 4),
        "tail_adjustment_cents": round(adjustment * 100, 2),
        "evidence": {
            "spike_condition_met": spike_condition_met,
            "wick_condition_met": wick_condition_met,
            "v_ratio_condition_met": v_condition_met,
            "whipsaw_co_triggered": whipsaw_co_triggered,
            "v_ratio": round(v_ratio, 6) if v_ratio_active else None,
            "tau_res_s": round(tau_res_s, 4) if tau_res_s is not None else None,
            "requires_both_conditions": False,
            "spike_component": round(spike_component, 4),
            "wick_component": round(wick_component, 4),
            "whipsaw_component": round(whipsaw_component, 4),
            "liquidation_component": round(liq_component, 4),
        },
        "whipsaw_gate": {
            "co_triggered": whipsaw_co_triggered,
            "price_trigger": price_trigger_met,
            "depth_exhaustion_trigger": v_condition_met,
            "v_ratio": round(v_ratio, 6) if v_ratio_active else None,
            "v_ratio_threshold": V_RATIO_WHIPSAW_THRESHOLD,
            "tau_res_s": round(tau_res_s, 4) if tau_res_s is not None else None,
            "component_cents": round(whipsaw_component * 100, 2),
        },
        "liquidation_cascade": {
            "burst": liq_burst,
            "notional_usd_15m": liq_notional,
            "long_share": liq_long_share,
            "gated_feature_active": liq_gated_passed,
            "skew_direction": liq_skew_direction,
            "component_cents": round(liq_component * 100, 2),
        },
        "tail_adjustment_reason": (
            f"late_window_spike_frequency={late_frequency:.3f} "
            f"(required >{TAIL_SPIKE_FREQUENCY_MIN:.3f}); "
            f"wick_ratio_slope={slope:.3f} "
            f"(required >={TAIL_WICK_SLOPE_MIN:.3f}); "
            f"whipsaw_co_triggered={whipsaw_co_triggered}; "
            f"liq_burst={liq_burst} (skew={liq_skew_direction})"
        ),
    }


def _apply_tail_adjustment(probability: float, adjustment: float) -> float:
    """Apply a signed tail adjustment capped at the configured cent bound."""
    bounded_adjustment = max(
        -TAIL_ADJUSTMENT_MAX_CENTS,
        min(TAIL_ADJUSTMENT_MAX_CENTS, adjustment),
    )
    return min(1.0, max(0.0, probability + bounded_adjustment))


def _apply_probability_correction(probability: float, correction: dict) -> float:
    """Apply bounded empirical-Bayes calibration to a raw model probability."""
    factor = float(correction.get("correction_factor", 1.0) or 1.0)
    floor = float(correction.get("floor", 0.0) or 0.0)
    max_factor = float(
        correction.get("max_factor", PROBABILITY_CORRECTION_MAX_FACTOR)
        or PROBABILITY_CORRECTION_MAX_FACTOR
    )
    bounded_probability = probability * min(max(factor, 0.0), max_factor)
    return min(1.0, max(bounded_probability, floor, 0.0))


def _artifact_residual(residual_cents) -> bool:
    if residual_cents is None:
        return False
    return abs(float(residual_cents)) > ARTIFACT_RESIDUAL_THRESHOLD_CENTS


def _historical_final_minute_windows(candles_1m: list) -> dict:
    """Build final-minute print windows from available 1-minute candles."""
    windows = []
    for candle in candles_1m:
        if candle.get("time", 0) % 3600 != 3540:
            continue
        prints = [candle.get("open"), candle.get("high"), candle.get("low"), candle.get("close")]
        if any(
            value is None
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value <= 0
            for value in prints
        ):
            continue
        windows.append({
            "timestamp_utc": datetime.fromtimestamp(candle["time"], tz=timezone.utc).isoformat(),
            "prints": prints,
        })
    return {
        "windows": windows,
        "source": "coinbase_1m_ohlc_proxy",
        "window_count": len(windows),
        "print_count": len(windows) * 4,
    }


def _conditional_settlement_hold(low: float, high: float, settlement_history: dict) -> dict:
    """Estimate P(60s average stays in the band | a final-minute print touched it)."""
    touched_count = 0
    held_count = 0
    for window in settlement_history.get("windows", []):
        prints = window.get("prints", [])
        if not prints:
            continue
        touched = any(low <= print_ <= high for print_ in prints)
        settlement_average = sum(prints) / len(prints)
        held = low <= settlement_average <= high
        if touched:
            touched_count += 1
            held_count += int(held)

    empirical_hold = held_count / touched_count if touched_count else SETTLEMENT_HOLD_PRIOR
    if touched_count < SETTLEMENT_HOLD_MIN_SAMPLES:
        hold_given_touch = (
            SETTLEMENT_HOLD_PRIOR * SETTLEMENT_HOLD_PRIOR_STRENGTH
            + empirical_hold * touched_count
        ) / (SETTLEMENT_HOLD_PRIOR_STRENGTH + touched_count)
    else:
        hold_given_touch = empirical_hold
    return {
        "hold_given_touch": round(hold_given_touch, 4),
        "touched_samples": touched_count,
        "held_samples": held_count,
        "estimated": touched_count > 0,
        "estimator": (
            "empirical"
            if touched_count >= SETTLEMENT_HOLD_MIN_SAMPLES
            else "empirical_bayes_shrinkage"
        ),
        "prior": SETTLEMENT_HOLD_PRIOR,
        "prior_strength": SETTLEMENT_HOLD_PRIOR_STRENGTH,
        "source": settlement_history.get("source", "unavailable"),
    }


def _ranked_entry_scores(decay_table: list, bands: list, horizon_minutes: int = 15) -> list:
    """Rank projected T-15m fair values against current YES asks."""
    bands_by_label = {}
    for band in bands:
        low, high = band.get("low"), band.get("high")
        if low is None or high is None:
            continue
        bands_by_label[f"{_format_kalshi_strike(low)}-{_format_kalshi_strike(high)}"] = band

    scores = []
    for row in decay_table:
        projected_probability = row.get(f"p_{horizon_minutes}m")
        band = bands_by_label.get(row.get("band"), {})
        ask = band.get("yes_ask")
        if projected_probability is None or ask is None:
            continue
        projected_fair = projected_probability * 100
        edge = projected_fair - ask
        if abs(edge) > ARTIFACT_RESIDUAL_THRESHOLD_CENTS:
            continue
        scores.append({
            "band": row.get("band"),
            "side": row.get("side"),
            "low": band.get("low"),
            "high": band.get("high"),
            "current_yes_ask": ask,
            "projected_fair_T15m": round(projected_fair, 1),
            "edge_at_entry": round(edge, 1),
            "settlement_venue": row.get("settlement_venue"),
            "settlement_rule": row.get("settlement_rule"),
        })

    scores.sort(key=lambda score: score["edge_at_entry"], reverse=True)
    for rank, score in enumerate(scores, start=1):
        score["entry_rank"] = rank
    return scores


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


def predict_hourly_range(force_refresh: bool = True, screen_spot: float | None = None) -> dict:
    """Main entry: compute current hourly range prediction with probabilities."""
    now = datetime.now(timezone.utc)
    minutes_to_expiry = 60 - now.minute

    spot_data = get_spot()
    spot = spot_data["price"]
    candles = get_hourly_candles(LIVE_VOLATILITY_HOURS)
    stats = compute_stats(candles)

    if spot_data.get("error") == "STALE":
        return {
            "status": "STALE",
            "error": "STALE: timestamp gate aborted execution",
            "timestamp": now.isoformat(),
        }
    if spot is None or not stats:
        return {
            "error": "Live data unavailable",
            "spot": spot,
            "timestamp": now.isoformat(),
        }

    rv = realized_vol_pct(candles, LIVE_VOLATILITY_HOURS)
    sigma_hourly_pct = rv / math.sqrt(24 * 365)
    expected_move = expected_move_pct(candles, LIVE_VOLATILITY_HOURS)
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
    edge_cal = _fetch_edge_calibration()
    edge_tail = edge_cal.get("tail_risk_prob")
    if edge_tail is not None:
        tail_probability_correction = {
            "active": True,
            "factor": 2.0,
            "threshold": float(edge_tail),
            "reason": "edge calibration aggressive fat-tail active",
        }
    else:
        tail_probability_correction = calibration_report.get("tail_probability_correction", {
            "active": False,
            "factor": 1.0,
            "threshold": 0.20,
            "reason": "calibration report unavailable; tail correction disabled",
        })
    bucketed_correction = calibration_report.get("bucketed_correction", {
        "active": False,
        "current_factors": {},
    })

    def correction_for_probability(probability: float) -> dict:
        if bucketed_correction.get("active"):
            per_bucket_whitelist = (
                bucketed_correction.get("activation", {}).get("per_bucket_whitelist", False)
            )
            expiry_bucket = bucketed_correction.get("current_factors", {}).get(
                bucket_key(minutes_to_expiry)
            )
            bucket_allowed = (
                not per_bucket_whitelist
                or expiry_bucket.get("whitelisted", False)
                if expiry_bucket
                else False
            )
            if expiry_bucket and expiry_bucket.get("factor") and bucket_allowed:
                return {
                    "correction_factor": expiry_bucket["factor"],
                    "floor": probability_correction.get("floor", 0.0),
                    "max_factor": PROBABILITY_CORRECTION_MAX_FACTOR,
                    "regime": f"expiry:{bucket_key(minutes_to_expiry)}",
                }
        if (
            tail_probability_correction.get("active")
            and probability < tail_probability_correction.get("threshold", 0.20)
        ):
            return {
                "correction_factor": tail_probability_correction.get("factor", 1.0),
                "floor": probability_correction.get("floor", 0.0),
                "max_factor": PROBABILITY_CORRECTION_MAX_FACTOR,
                "regime": "tail",
            }
        return {
            "correction_factor": probability_correction.get("correction_factor", 1.0),
            "floor": probability_correction.get("floor", 0.0),
            "max_factor": PROBABILITY_CORRECTION_MAX_FACTOR,
            "regime": "global",
        }

    baseline_candles = get_hourly_candles(LOOKBACK_HOURS)
    baseline_rv = realized_vol_pct(baseline_candles, LOOKBACK_HOURS)
    baseline_sigma_hourly_pct = baseline_rv / math.sqrt(24 * 365)
    hourly_ranges = [
        candle["high"] - candle["low"]
        for candle in baseline_candles
        if candle.get("high") and candle.get("low")
    ]
    current_hourly_range = hourly_ranges[-1] if hourly_ranges else 0.0
    spike_threshold = 0.0
    if hourly_ranges:
        sorted_ranges = sorted(hourly_ranges[:-1] or hourly_ranges)
        spike_threshold = sorted_ranges[
            min(len(sorted_ranges) - 1, int(len(sorted_ranges) * VOLATILITY_SPIKE_PERCENTILE))
        ]
    volatility_spike_multiplier = (
        current_hourly_range / spike_threshold
        if spike_threshold > 0 and current_hourly_range > spike_threshold
        else 1.0
    )
    sigma_hourly_pct = max(
        sigma_hourly_pct,
        baseline_sigma_hourly_pct * volatility_spike_multiplier,
    )

    regime = _classify_regime(hourly_ranges)
    regime_range_floor = (
        HIGH_REGIME_MIN_RANGE_PCT
        if regime.get("regime") == "HIGH"
        else MIN_RANGE_PCT
    )
    range_pct = max(expected_move, regime_range_floor)
    center_shift = bias * range_pct * CENTER_SHIFT_FACTOR
    upper_pct = range_pct * UPPER_RANGE_FACTOR + center_shift
    lower_pct = range_pct * LOWER_RANGE_FACTOR - center_shift

    upper_bound = spot * (1 + upper_pct / 100)
    lower_bound = spot * (1 - lower_pct / 100)

    # --- Fat-tailed distribution (Student-t on 200+ hourly log-returns + Edge override) ---
    hourly_candles_200 = get_hourly_candles(HOUR_SAMPLE_SIZE)
    log_returns = []
    for i in range(1, len(hourly_candles_200)):
        if hourly_candles_200[i - 1]["close"] > 0 and hourly_candles_200[i]["close"] > 0:
            log_returns.append(math.log(hourly_candles_200[i]["close"] / hourly_candles_200[i - 1]["close"]))
    df_fitted = _fit_student_t(log_returns)
    df = float(edge_cal.get("student_t_factor", df_fitted))

    cross_venue_divergence = get_cross_venue_divergence()
    positioning_skew = get_positioning_skew()

    # Drift for remaining window
    drift_pct = bias * sigma_hourly_pct * DRIFT_FACTOR * math.sqrt(minutes_to_expiry / 60)
    drift_pct += positioning_skew["skew_pct"]

    # --- Per-strike probabilities from live Kalshi ladder ---
    ladder = get_kalshi_ladder(force_refresh=force_refresh)
    bands = ladder.get("candidate_bands", []) if isinstance(ladder, dict) else []
    ladder_cache_flag = ladder.get("_cache") or ladder.get("cache") or "miss"
    ladder_feed_status = {
        "status": ladder.get("status", "error") if isinstance(ladder, dict) else "error",
        "error": ladder.get("error") if isinstance(ladder, dict) else "invalid ladder payload",
        "candidate_band_count": len(bands),
        "usable_band_count": 0,
        "event_ticker": ladder.get("event_ticker"),
        "minutes_to_expiry": ladder.get("minutes_to_expiry"),
        "market_active": ladder.get("market_active", True if bands else False),
        "_cache": ladder_cache_flag,
        "cache": ladder_cache_flag,
        "age_seconds": ladder.get("age_seconds"),
        "computed_at": ladder.get("computed_at"),
        "_source": ladder.get("_source"),
        "collector_timestamp": ladder.get("collector_timestamp"),
    }

    # --- Ladder Memory Engine (LME) — state detection tick ---
    # Extract flat edge list from candidate_bands (both low and high of each band).
    # Uses the same ladder already fetched — no extra network call.
    _lme_band_edges = []
    for _b in bands:
        if isinstance(_b, dict):
            if _b.get("low") is not None:
                _lme_band_edges.append(float(_b["low"]))
            if _b.get("high") is not None:
                _lme_band_edges.append(float(_b["high"]))
    lme_snapshot = _lme_step(
        spot=spot,
        current_hourly_range=current_hourly_range,
        band_edges=_lme_band_edges,
    )

    # Staleness Guard pre-call gate (R1, R1b, R2, R3, R4)
    fresh_spot_data = get_spot()
    if fresh_spot_data.get("price") is not None:
        spot_data = fresh_spot_data
        spot = spot_data["price"]

    ladder_ts_raw = ladder.get("computed_at") or ladder.get("collector_timestamp")
    ladder_ts = time.time()
    if ladder_ts_raw:
        try:
            ladder_ts = datetime.fromisoformat(str(ladder_ts_raw).replace("Z", "+00:00")).timestamp()
        except Exception:
            ladder_ts = time.time()
    elif "_ts" in ladder:
        ladder_ts = float(ladder["_ts"])

    guard = StalenessGuard()
    market_data = MarketData(
        spot=spot,
        spot_pulled_at=spot_data.get("pulled_at", time.time()),
        ladder_cache=ladder_cache_flag,
        ladder_collector_ts=ladder_ts,
        spot_at_fair=spot,
        screen_spot=screen_spot,
        age_seconds=ladder.get("age_seconds"),
    )
    staleness_verdict = guard.decide(market_data)
    if staleness_verdict.effective_spot is not None:
        spot = staleness_verdict.effective_spot

    # Rule R4: No drift/momentum narrative permitted from a cache-hit ladder. Ever.
    if ladder_cache_flag == "hit":
        drift_pct = 0.0
        positioning_skew = {**positioning_skew, "skew_pct": 0.0, "drift_suppressed": True}

    # --- Wick statistics must precede pricing so tail pressure is consumed ---
    candles_1m = get_minute_candles(360)
    wick_stats = compute_wick_stats(candles_1m)
    tail_diagnostics = get_tail_diagnostics(wick_stats)
    tail_adjustment = tail_diagnostics["tail_adjustment"]
    settlement_history = _historical_final_minute_windows(candles_1m)

    def cross_venue_adjustment_for_probability(probability: float) -> float:
        if (
            cross_venue_divergence["active"]
            and probability <= CROSS_VENUE_TAIL_PROBABILITY_MAX
        ):
            return cross_venue_divergence["tail_adjustment"]
        return 0.0

    def total_tail_adjustment(probability: float) -> float:
        return round(tail_adjustment + cross_venue_adjustment_for_probability(probability), 4)

    strike_probs = []
    for band in bands:
        low, high = band.get("low"), band.get("high")
        ask, bid = band.get("yes_ask"), band.get("yes_bid")
        side = band.get("side_vs_spot", "ABOVE_SPOT")
        band_is_valid = (
            low is not None
            and high is not None
            and isinstance(low, (int, float))
            and isinstance(high, (int, float))
            and math.isfinite(low)
            and math.isfinite(high)
        )
        band_label = (
            f"{_format_kalshi_strike(low)}-{_format_kalshi_strike(high)}"
            if band_is_valid
            else "n/a"
        )
        row = {
            "band": band_label,
            "side": side,
            "yes_ask": ask,
            "yes_bid": bid,
            "model_fair_cents": None,
            "residual_cents": None,
            "flagged": False,
            "fair_status": "invalid_band",
            "fair_stale": None,
            "fair_recomputed": False,
            "fair_staleness": {
                "status": "invalid_band",
                "threshold_points": None,
                "spot_delta_points": None,
            },
            "spot_at_fair": round(spot, 2),
            "settlement_venue": KALSHI_SETTLEMENT_VENUE,
            "settlement_rule": KALSHI_SETTLEMENT_RULE,
            "p_normal": None,
            "p_student_t": None,
            "p_selected": None,
            "selected_distribution": active_distribution,
            "p_base": None,
            "p_calibrated": None,
            "calibration_factor": None,
            "calibration_regime": None,
            "tail_delta": None,
            "tail_premium_cents": None,
            "p_touch_raw": None,
            "tail_adjustment": tail_adjustment,
            "cross_venue_tail_adjustment": 0.0,
            "divergence_regime": cross_venue_divergence["regime"],
            "p_touch_adjusted": None,
            "p_touch": None,
            "p_settle": None,
            "settlement_hold_given_touch": None,
            "settlement_hold_samples": None,
            "insufficient_samples": None,
            "settlement_hold_source": settlement_history["source"],
            "low": low,
            "high": high,
        }

        if band_is_valid:
            p_normal = _band_probability(
                low, high, spot, sigma_hourly_pct, drift_pct, df, minutes_to_expiry,
                distribution="normal",
            )
            p_student_t = _band_probability(
                low, high, spot, sigma_hourly_pct, drift_pct, df, minutes_to_expiry
            )
            p_selected = p_normal if active_distribution == "normal" else p_student_t
            p_base = p_selected
            selected_correction = correction_for_probability(p_base)
            p_calibrated = _apply_probability_correction(p_base, selected_correction)
            cross_venue_adjustment = cross_venue_adjustment_for_probability(p_base)
            band_tail_adjustment = total_tail_adjustment(p_base)
            p_touch = _apply_tail_adjustment(p_calibrated, band_tail_adjustment)
            
            # Interim live rule: in HIGH regime, model fair values are floors.
            if stats.get("regime", "") == "HIGH":
                p_touch = max(p_touch, 0.76)
                
            settlement_hold = _conditional_settlement_hold(low, high, settlement_history)
            p_settle = p_touch * settlement_hold["hold_given_touch"]
            fair_value = p_touch * 100
            residual = ask - fair_value if ask is not None else None
            tail_delta = p_student_t - p_normal

            row.update({
                "model_fair_cents": round(fair_value, 1),
                "residual_cents": round(residual, 1) if residual is not None else None,
                "flagged": (
                    residual is not None
                    and (residual > RESIDUAL_FLAG_THRESHOLD_CENTS or _artifact_residual(residual))
                ),
                "fair_status": "ok" if ask is not None else "fair_only",
                "p_normal": round(p_normal, 3),
                "p_student_t": round(p_student_t, 3),
                "p_selected": round(p_selected, 3),
                "p_base": round(p_base, 5),
                "p_calibrated": round(p_calibrated, 5),
                "calibration_factor": selected_correction["correction_factor"],
                "calibration_regime": selected_correction["regime"],
                "tail_delta": round(tail_delta, 3),
                "tail_premium_cents": round(tail_delta * 100, 1),
                "p_touch_raw": round(p_base, 3),
                "tail_adjustment": band_tail_adjustment,
                "cross_venue_tail_adjustment": cross_venue_adjustment,
                "p_touch_adjusted": round(p_touch, 3),
                "p_touch": round(p_touch, 3),
                "p_settle": round(p_settle, 3),
                "settlement_hold_given_touch": settlement_hold["hold_given_touch"],
                "settlement_hold_samples": settlement_hold["touched_samples"],
                "insufficient_samples": settlement_hold.get("insufficient_samples", False),
            })
        strike_probs.append(row)

    live_spot_data = get_spot()
    live_spot = live_spot_data.get("price")
    spot_delta_at_return = (
        live_spot - spot
        if live_spot is not None and isinstance(live_spot, (int, float))
        else None
    )
    for strike in strike_probs:
        if strike["fair_status"] == "invalid_band":
            continue
        band_width = strike["high"] - strike["low"]
        staleness_threshold = max(
            abs(spot) * SPOT_STALENESS_MIN_PCT_OF_SPOT,
            abs(band_width) * SPOT_STALENESS_BAND_WIDTH_PCT,
        )
        strike["fair_staleness"] = {
            "status": "current",
            "threshold_points": round(staleness_threshold, 2),
            "spot_delta_points": round(spot_delta_at_return, 2) if spot_delta_at_return is not None else None,
        }
        if spot_delta_at_return is None:
            strike["fair_stale"] = None
            strike["fair_recomputed"] = False
            continue
        if abs(spot_delta_at_return) <= staleness_threshold:
            strike["fair_stale"] = False
            strike["fair_recomputed"] = False
            continue

        low = strike["low"]
        high = strike["high"]
        p_normal = _band_probability(
            low, high, live_spot, sigma_hourly_pct, drift_pct, df, minutes_to_expiry,
            distribution="normal",
        )
        p_student_t = _band_probability(
            low, high, live_spot, sigma_hourly_pct, drift_pct, df, minutes_to_expiry
        )
        p_selected = p_normal if active_distribution == "normal" else p_student_t
        p_base = p_selected
        selected_correction = correction_for_probability(p_base)
        p_calibrated = _apply_probability_correction(p_base, selected_correction)
        cross_venue_adjustment = cross_venue_adjustment_for_probability(p_base)
        band_tail_adjustment = total_tail_adjustment(p_base)
        p_touch = _apply_tail_adjustment(p_calibrated, band_tail_adjustment)
        settlement_hold = _conditional_settlement_hold(strike["low"], strike["high"], settlement_history)
        p_settle = p_touch * settlement_hold["hold_given_touch"]
        fair_value = p_touch * 100
        ask = strike.get("yes_ask")
        residual = ask - fair_value if ask is not None else None
        tail_delta = p_student_t - p_normal

        strike["model_fair_initial_cents"] = strike["model_fair_cents"]
        strike.update({
            "model_fair_cents": round(fair_value, 1),
            "residual_cents": round(residual, 1) if residual is not None else None,
            "flagged": (
                residual is not None
                and (residual > RESIDUAL_FLAG_THRESHOLD_CENTS or _artifact_residual(residual))
            ),
            "fair_status": "recomputed_after_spot_move",
            "fair_stale": True,
            "fair_recomputed": True,
            "fair_staleness": {
                "status": "stale_recomputed",
                "threshold_points": round(staleness_threshold, 2),
                "spot_delta_points": round(spot_delta_at_return, 2),
            },
            "spot_at_fair": round(live_spot, 2),
            "p_normal": round(p_normal, 3),
            "p_student_t": round(p_student_t, 3),
            "p_selected": round(p_selected, 3),
            "p_base": round(p_base, 5),
            "p_calibrated": round(p_calibrated, 5),
            "calibration_factor": selected_correction["correction_factor"],
            "calibration_regime": selected_correction["regime"],
            "tail_delta": round(tail_delta, 3),
            "tail_premium_cents": round(tail_delta * 100, 1),
            "p_touch_raw": round(p_base, 3),
            "tail_adjustment": band_tail_adjustment,
            "cross_venue_tail_adjustment": cross_venue_adjustment,
            "p_touch_adjusted": round(p_touch, 3),
            "p_touch": round(p_touch, 3),
            "p_settle": round(p_settle, 3),
            "settlement_hold_given_touch": settlement_hold["hold_given_touch"],
            "settlement_hold_samples": settlement_hold["touched_samples"],
            "insufficient_samples": settlement_hold.get("insufficient_samples", False),
        })

    ladder_feed_status["usable_band_count"] = sum(
        1 for strike in strike_probs if strike["fair_status"] != "invalid_band"
    )

    # Regime classification was computed before range construction so HIGH
    # volatility can widen the model range before ladder probabilities.

    # --- Time-decay table ---
    decay_table = []
    for band in bands:
        low, high = band.get("low"), band.get("high")
        side = band.get("side_vs_spot", "ABOVE_SPOT")
        if low is None or high is None:
            continue
        row = {
            "band": f"{_format_kalshi_strike(low)}-{_format_kalshi_strike(high)}",
            "side": side,
            "settlement_venue": KALSHI_SETTLEMENT_VENUE,
            "settlement_rule": KALSHI_SETTLEMENT_RULE,
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
                selected_correction = correction_for_probability(p_base)
                p_calibrated = _apply_probability_correction(p_base, selected_correction)
                band_tail_adjustment = total_tail_adjustment(p_base)
                adjusted = _apply_tail_adjustment(p_calibrated, band_tail_adjustment)
                row[f"p_{m}m"] = round(adjusted, 3)
                row[f"p_normal_{m}m"] = round(p_normal, 3)
                row[f"p_student_t_{m}m"] = round(p_student_t, 3)
                row[f"p_base_{m}m"] = round(p_base, 5)
                row[f"p_calibrated_{m}m"] = round(p_calibrated, 5)
                row[f"calibration_factor_{m}m"] = selected_correction["correction_factor"]
                row[f"calibration_regime_{m}m"] = selected_correction["regime"]
                row[f"selected_distribution_{m}m"] = active_distribution
                row[f"tail_adjustment_{m}m"] = band_tail_adjustment
        decay_table.append(row)

    entry_scores = _ranked_entry_scores(decay_table, bands)

    # Hard gate: block directional entry recommendations and residuals if stale
    if not staleness_verdict.allowed:
        entry_scores = []
        for strike in strike_probs:
            strike["fair_status"] = "stale_blocked"
            strike["flagged"] = False
            strike["residual_cents"] = None
            strike["staleness_block_reasons"] = staleness_verdict.reasons

    raw_alt_signal = get_alt_signal()
    alt_signal, lead_lag_filter = _filter_alt_signal(raw_alt_signal)

    from calibration_ledger import record_predictions
    batch_records = []
    for strike in strike_probs:
        if strike["fair_status"] == "invalid_band":
            continue
        batch_records.append({
            "timestamp": now,
            "band": strike["band"],
            "low": strike["low"],
            "high": strike["high"],
            "expiry": now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1),
            "p_touch": strike["p_touch_adjusted"],
            "p_normal": strike["p_normal"],
            "p_student_t": strike["p_student_t"],
            "tail_adjustment": strike["tail_adjustment"],
            "alt_aligned": alt_signal.get("aligned", False) if alt_signal else False,
            "minutes_to_expiry": minutes_to_expiry,
            "p_base": strike["p_base"],
            "p_calibrated": strike["p_calibrated"],
            "calibration_factor": strike["calibration_factor"],
            "regime": regime.get("regime", "UNKNOWN"),
            "settlement_hold_given_touch": strike.get("settlement_hold_given_touch"),
            "p_settle": strike.get("p_settle"),
        })
    record_predictions(batch_records)
    calibration_report = get_calibration_report()

    full_hour_probs = _probs_from_sigma(
        spot, upper_bound, lower_bound, sigma_hourly_pct, drift_pct, df, 60,
        active_distribution
    )
    remaining_probs = _probs_from_sigma(
        spot, upper_bound, lower_bound, sigma_hourly_pct, drift_pct, df,
        minutes_to_expiry, active_distribution
    )

    result = {
        "status": "STALE_DATA_BLOCKED" if not staleness_verdict.allowed else "ok",
        "blocked": not staleness_verdict.allowed,
        "staleness_verdict": str(staleness_verdict),
        "staleness_reasons": staleness_verdict.reasons,
        "effective_spot": staleness_verdict.effective_spot,
        "ladder_cache": ladder_cache_flag,
        "ladder_age_seconds": ladder.get("age_seconds"),
        "timestamp_utc": now.isoformat(),
        "minutes_to_hourly_expiry": minutes_to_expiry,
        "spot": round(spot, 2),
        "spot_at_fair": round(spot, 2),
        "spot_at_return": round(live_spot, 2) if live_spot is not None else None,
        "spot_delta_at_return": round(spot_delta_at_return, 2) if spot_delta_at_return is not None else None,
        "fair_staleness_policy": {
            "min_spot_pct": SPOT_STALENESS_MIN_PCT_OF_SPOT,
            "band_width_pct": SPOT_STALENESS_BAND_WIDTH_PCT,
            "action": "recompute_and_flag",
        },
        "spot_source": spot_data.get("source", "unavailable"),
        "canonical_spot_source": spot_data.get("canonical_source", "BRTI"),
        "settlement_venue": KALSHI_SETTLEMENT_VENUE,
        "settlement_rule": KALSHI_SETTLEMENT_RULE,
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
            "baseline_realized_vol_annualized_pct": round(baseline_rv, 2),
            "sigma_hourly_pct": round(sigma_hourly_pct, 3),
            "baseline_sigma_hourly_pct": round(baseline_sigma_hourly_pct, 3),
            "volatility_spike_multiplier": round(volatility_spike_multiplier, 3),
            "volatility_spike_threshold": round(spike_threshold, 2),
            "current_hourly_range": round(current_hourly_range, 2),
            "expected_move_pct": round(expected_move, 3),
            "student_t_df": round(df, 2),
            "log_returns_sample_size": len(log_returns),
            "fit_status": "fitted" if len(log_returns) >= 20 else "unstable_fit_fallback",
            "normal_fallback_active": len(log_returns) < 20,
            "active_distribution": active_distribution,
        },
        "tail_diagnostics": tail_diagnostics,
        "cross_venue_divergence": cross_venue_divergence,
        "divergence_regime": cross_venue_divergence["regime"],
        "positioning_skew": positioning_skew,
        "wick_ratio_5h_trend": tail_diagnostics["wick_ratio_5h_trend"],
        "wick_ratio_trend_status": tail_diagnostics["wick_ratio_trend_status"],
        "lead_lag_status": lead_lag_filter["status"],
        "lead_lag_filter": lead_lag_filter,
        "calibration": calibration_report,
        "distribution_selection": distribution_selection,
        "probability_correction": probability_correction,
        "tail_probability_correction": tail_probability_correction,
        "ladder_feed_status": ladder_feed_status,
        "regime": regime,
        "strike_probs": strike_probs,
        "ladder_residuals": [] if not staleness_verdict.allowed else [sp for sp in strike_probs if sp.get("flagged")],
        "wick_stats": wick_stats,
        "decay_table": decay_table,
        "entry_scores": entry_scores,
        "settlement_history": {
            "source": settlement_history["source"],
            "window_count": settlement_history["window_count"],
            "print_count": settlement_history["print_count"],
            "rule": KALSHI_SETTLEMENT_RULE,
        },
        "settlement_note": (
            "Kalshi settles against 60s BRTI average — a sustained push through "
            "most of that final minute moves the average hard. Polymarket "
            "Chainlink TWAP: window unconfirmed, read off live market rules."
        ),
    }
    if alt_signal is not None:
        result["alt_signal"] = alt_signal
        result["alt_alignment_warning"] = alt_signal.get("aligned", False)
    return result


def predict_15m_range(contract: dict | None = None, series_ticker: str = KALSHI_15M_SERIES) -> dict:
    """Model fair for the active Kalshi 15-minute up/down contract."""
    now = datetime.now(timezone.utc)
    contract = contract or get_kalshi_15m_contract(series_ticker)
    if not contract:
        return {
            "timestamp_utc": now.isoformat(),
            "error": "no_live_kalshi_15m_contract",
            "settlement_venue": KALSHI_SETTLEMENT_VENUE,
            "settlement_rule": KALSHI_SETTLEMENT_RULE,
        }

    spot_data = get_spot()
    spot = spot_data.get("price")
    candles = get_minute_candles(360)
    if spot is None or len(candles) < 20:
        return {
            "timestamp_utc": now.isoformat(),
            "ticker": contract.get("ticker"),
            "error": "live_data_unavailable",
            "spot": spot,
            "settlement_venue": KALSHI_SETTLEMENT_VENUE,
            "settlement_rule": KALSHI_SETTLEMENT_RULE,
        }

    target = float(contract["target"])
    close_time = contract["close_time"]
    seconds_to_expiry = max(0, (close_time - now).total_seconds())
    minutes_to_expiry = max(0.25, seconds_to_expiry / 60)
    if seconds_to_expiry <= 0:
        return {
            "timestamp_utc": now.isoformat(),
            "ticker": contract.get("ticker"),
            "error": "contract_expired",
        }

    closes = [float(c["close"]) for c in candles if c.get("close")]
    log_returns = [
        math.log(closes[i] / closes[i - 1])
        for i in range(1, len(closes))
        if closes[i - 1] > 0 and closes[i] > 0
    ]
    pct_returns = [
        (closes[i] / closes[i - 1] - 1) * 100
        for i in range(1, len(closes))
        if closes[i - 1] > 0 and closes[i] > 0
    ]
    if len(pct_returns) < 20:
        return {
            "timestamp_utc": now.isoformat(),
            "ticker": contract.get("ticker"),
            "error": "insufficient_volatility_samples",
            "sample_count": len(pct_returns),
        }

    mean_return = sum(pct_returns) / len(pct_returns)
    variance = sum((value - mean_return) ** 2 for value in pct_returns) / (len(pct_returns) - 1)
    minute_sigma_pct = math.sqrt(max(0.0, variance))
    sigma_pct = max(0.0001, minute_sigma_pct * math.sqrt(minutes_to_expiry))
    drift_pct = sum(pct_returns[-15:]) / len(pct_returns[-15:]) * 0.40
    df = _fit_student_t(log_returns)

    target_pct = (target - spot) / spot * 100
    z_score = (target_pct - drift_pct) / sigma_pct
    strike_dir = str(contract.get("strike_type") or contract.get("subtitle") or "").lower()
    below = "below" in strike_dir or "under" in strike_dir
    p_above = 1 - _student_t_cdf(z_score, df)
    p_base = p_above if not below else 1 - p_above

    from calibration_ledger import get_calibration_report
    calibration_report = get_calibration_report()
    probability_correction = calibration_report.get("probability_correction", {})
    tail_probability_correction = calibration_report.get("tail_probability_correction", {})
    if (
        tail_probability_correction.get("active")
        and p_base < tail_probability_correction.get("threshold", 0.20)
    ):
        correction_factor = tail_probability_correction.get("factor", 1.0)
        calibration_regime = "tail"
    else:
        correction_factor = probability_correction.get("correction_factor", 1.0)
        calibration_regime = "global"
    p_calibrated = _apply_probability_correction(p_base, {
        "correction_factor": correction_factor,
        "floor": probability_correction.get("floor", 0.0),
    })
    tail_adjustment = get_tail_diagnostics(compute_wick_stats(candles))["tail_adjustment"]
    p_final = _apply_tail_adjustment(p_calibrated, tail_adjustment)

    raw_ask = contract.get("yes_ask_dollars", contract.get("yes_ask"))
    try:
        ask_cents = float(raw_ask) * (100 if float(raw_ask) > 1 else 1)
    except (TypeError, ValueError):
        ask_cents = None

    fair_cents = p_final * 100
    residual_cents = ask_cents - fair_cents if ask_cents is not None else None

    live_spot_data = get_spot()
    live_spot = live_spot_data.get("price")
    spot_delta = live_spot - spot if live_spot is not None else None
    staleness_threshold = max(abs(spot) * 0.0003, abs(target - spot) * 0.10)
    fair_stale = spot_delta is not None and abs(spot_delta) > staleness_threshold
    if fair_stale:
        live_target_pct = (target - live_spot) / live_spot * 100
        live_z = (live_target_pct - drift_pct) / sigma_pct
        live_p_above = 1 - _student_t_cdf(live_z, df)
        p_base = live_p_above if not below else 1 - live_p_above
        p_calibrated = _apply_probability_correction(p_base, {
            "correction_factor": correction_factor,
            "floor": probability_correction.get("floor", 0.0),
        })
        p_final = _apply_tail_adjustment(p_calibrated, tail_adjustment)
        fair_cents = p_final * 100
        residual_cents = ask_cents - fair_cents if ask_cents is not None else None

    return {
        "timestamp_utc": now.isoformat(),
        "ticker": contract.get("ticker"),
        "contract_title": contract.get("title"),
        "strike_dir": "below" if below else "above",
        "target": round(target, 2),
        "spot": round(spot, 2),
        "spot_at_return": round(live_spot, 2) if live_spot is not None else None,
        "spot_delta_at_return": round(spot_delta, 2) if spot_delta is not None else None,
        "minutes_to_expiry": round(minutes_to_expiry, 2),
        "seconds_to_expiry": round(seconds_to_expiry),
        "model_fair_cents": round(fair_cents, 1),
        "residual_cents": round(residual_cents, 1) if residual_cents is not None else None,
        "flagged": (
            residual_cents is not None
            and (
                residual_cents > RESIDUAL_FLAG_THRESHOLD_CENTS
                or _artifact_residual(residual_cents)
            )
        ),
        "fair_status": "ok" if ask_cents is not None else "fair_only",
        "fair_stale": fair_stale,
        "fair_recomputed": fair_stale,
        "fair_staleness": {
            "threshold_points": round(staleness_threshold, 2),
            "spot_delta_points": round(spot_delta, 2) if spot_delta is not None else None,
        },
        "p_base": round(p_base, 5),
        "p_calibrated": round(p_calibrated, 5),
        "p_final": round(p_final, 5),
        "calibration_factor": correction_factor,
        "calibration_regime": calibration_regime,
        "tail_adjustment": tail_adjustment,
        "sigma_15m_pct": round(sigma_pct, 5),
        "student_t_df": round(df, 2),
        "market_ask_cents": ask_cents,
        "settlement_venue": KALSHI_SETTLEMENT_VENUE,
        "settlement_rule": KALSHI_SETTLEMENT_RULE,
    }


if __name__ == "__main__":
    import json
    from pathlib import Path
    result = predict_hourly_range()
    print(json.dumps(result, indent=2))
    # Artifact for the hourly-ranges panel MODEL column (read by the app
    # via window.electron IPC 'data:engineLatest'). Atomic write so readers
    # never see a half-written file. NEVER overwrite good data with an
    # error payload: a transient candle/venue failure must not wipe the
    # last good board (that clobber is what blanked the panel).
    try:
        from pathlib import Path as _Pl
        _artifact_dir = _Pl(__file__).with_name("data")
        _artifact_dir.mkdir(parents=True, exist_ok=True)
        _good = bool(result.get("strike_probs")) and not result.get("error")
        _target = (_artifact_dir / "engine_latest.json"
                   if _good else _artifact_dir / "engine_latest.error.json")
        _tmp = _artifact_dir / "engine_latest.json.tmp"
        _tmp.write_text(json.dumps(result))
        _tmp.replace(_target)
        if not _good:
            print("artifact: error payload kept out of engine_latest.json")
    except Exception as _e:
        print(f"artifact write skipped: {_e}")
