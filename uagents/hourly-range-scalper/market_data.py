"""
market_data.py — live venue clients for Coinbase, Kalshi, and Polymarket.

Fills the pieces brain.py needs from the outside world: spot price, a
momentum signal, recent 30-minute high/low, and a list of CandidateBand
contracts with live yes_bid/yes_ask. Every field shape here was pulled from
each venue's actual live API during this session (2026-09-10), not assumed.

---------------------------------------------------------------------------
IMPORTANT — Polymarket structural finding (verified live, 2026-09-10)
---------------------------------------------------------------------------
BRAIN_SPEC.md's "Polymarket = Chainlink TWAP" note (from the Aug 7 2026
changelog) turns out to describe only ONE of at least three BTC product
lines Polymarket runs concurrently, and they do NOT share a settlement
mechanism:

  1. `btc-updown-{5m,15m,4h}-<unix_ts>` events — genuine Chainlink TWAP
     settlement. Confirmed live by reading each market's own description:
     the 5m, 15m, AND 4h instances checked this session all cite the same
     `btc-usd-twap-60s-streams` URL — i.e. live text says 60s even for the
     5m tier, which *contradicts* the changelog's claim that 5m markets use
     a 30s lookback. Trust the live per-market text over the changelog;
     `_parse_twap_window_seconds()` below reads it fresh every call rather
     than hardcoding either number. No hourly (1h) variant exists in this
     product line at all.
  2. `bitcoin-up-or-down-<date>-<hour><am|pm>-et` events — the only
     genuinely hourly-cadence BTC product on Polymarket — settle off a
     single Binance 1-HOUR candle's open vs. close. Confirmed by reading
     the live description text directly: no TWAP, no averaging at all.
     This is exactly the "single last-price snapshot" exploit shape
     BRAIN_SPEC.md's Section 6 says Polymarket moved *away* from in
     Aug 2026 — apparently only for product line #1, not this one.
  3. `bitcoin-price-on-<date>` events — real [low, high] band ladders,
     structurally the only Polymarket product that actually fits
     brain.py's CandidateBand contract (unlike #1/#2, which are plain
     Up/Down with no band). Daily cadence, and settle off a single
     Binance 1-MINUTE candle close — also not a TWAP.

Net effect: there is no Polymarket product that is simultaneously
hourly-cadence, banded, AND TWAP-settled. `build_polymarket_snapshot()`
below defaults to product line #3 (closest structural fit to
CandidateBand) and sets `settlement_window_seconds=0` honestly (a single
close tick, not an averaged window) rather than inheriting brain.py's
POLYMARKET default of 60s, which would understate this product's actual
single-tick settlement risk.

Per Mar (2026-09-10), the actual venue/cadence assignment for this
strategy is:
  - Hourly and 15-minute markets -> Kalshi + Coinbase (see
    get_kalshi_hourly_btc_bands / get_kalshi_updown below).
  - 5-minute "fast" markets -> Polymarket's Chainlink-TWAP product line
    (get_polymarket_twap_updown) plus polycool.app (see that function's
    docstring — polycool is a Polymarket front-end, not a separate venue).

Important: get_kalshi_updown() and get_polymarket_twap_updown() are
plain Up/Down (direction) markets with NO price band — they do not
produce CandidateBand output, and brain.py's Section 3-4 band-selection
logic doesn't apply to them as written. They're wired here as data
sources only; turning them into real scalper decisions needs a brain.py
extension (a direction-only decision shape, plus per-cadence entry-timing
logic — Section 2's "T-20m to T-15m" window assumes an hourly-scale
contract and doesn't make sense for a 5- or 15-minute one). Not done in
this file — see chat history / BRAIN_SPEC.md.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import requests

from brain import CandidateBand, MarketSnapshot

COINBASE_BASE = "https://api.exchange.coinbase.com"
KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"
POLYMARKET_GAMMA_BASE = "https://gamma-api.polymarket.com"
POLYMARKET_CLOB_BASE = "https://clob.polymarket.com"

REQUEST_TIMEOUT = 10


# ---------------------------------------------------------------------------
# Coinbase — spot price + recent candles (momentum signal, 30m high/low)
# ---------------------------------------------------------------------------

def get_coinbase_spot(product_id: str = "BTC-USD") -> float:
    r = requests.get(f"{COINBASE_BASE}/products/{product_id}/ticker", timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    return float(r.json()["price"])


def get_coinbase_recent_range(product_id: str = "BTC-USD", minutes: int = 30) -> dict:
    """1-minute candles over the trailing `minutes` window -> high, low, and
    a deliberately simple momentum heuristic. This is a placeholder, not a
    real signal engine (that's prediction_engine.py, not written yet) — it
    returns None rather than invent confidence it doesn't have, matching
    brain.py Section 3's own instruction to SKIP rather than fabricate a
    thesis when there's no real signal."""
    end = int(time.time())
    start = end - minutes * 60
    r = requests.get(
        f"{COINBASE_BASE}/products/{product_id}/candles",
        params={"start": start, "end": end, "granularity": 60},
        timeout=REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    candles = r.json()  # each: [time, low, high, open, close, volume]
    if not candles:
        return {"high": None, "low": None, "momentum_signal": None}

    candles_chrono = sorted(candles, key=lambda c: c[0])
    window_open = candles_chrono[0][3]
    window_close = candles_chrono[-1][4]
    window_high = max(c[2] for c in candles_chrono)
    window_low = min(c[1] for c in candles_chrono)

    span = window_high - window_low
    move = window_close - window_open
    momentum_signal = None
    if span > 0 and abs(move) >= span * 0.15:
        momentum_signal = "continuation_up" if move > 0 else "continuation_down"

    return {"high": window_high, "low": window_low, "momentum_signal": momentum_signal}


# ---------------------------------------------------------------------------
# Kalshi — hourly BTC band ladder (KXBTC series)
# ---------------------------------------------------------------------------

def get_kalshi_hourly_btc_bands(
    spot: float,
    series_ticker: str = "KXBTC",
    max_bands_each_side: int = 6,
) -> tuple[list[CandidateBand], float, str]:
    """Returns (candidate_bands, minutes_to_expiry, event_ticker) for the
    soonest-closing open KXBTC hourly event, filtered to the N nearest
    genuinely out-of-range "between" bands on each side of spot.

    Bands whose [floor, cap] contains spot are dropped (already in the
    money — not a Section 3 candidate). Open-ended tail bands
    (strike_type "greater"/"less", no finite cap or floor) are also
    dropped rather than given a fabricated width — CandidateBand has no
    concept of an unbounded band, and the real tail markets are always far
    from spot in practice (see live sample in this session: nearest ladder
    rungs are ~$100-wide, tail markets are $10k+ away).
    """
    r = requests.get(
        f"{KALSHI_BASE}/markets",
        params={"series_ticker": series_ticker, "status": "open", "limit": 1000},
        timeout=REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    markets = r.json()["markets"]
    if not markets:
        raise RuntimeError(f"No open Kalshi markets for series {series_ticker}")

    events: dict[str, list[dict]] = {}
    for m in markets:
        events.setdefault(m["event_ticker"], []).append(m)

    now = datetime.now(timezone.utc)
    event_ticker, event_markets = min(
        events.items(),
        key=lambda kv: datetime.fromisoformat(kv[1][0]["close_time"].replace("Z", "+00:00")),
    )
    close_time = datetime.fromisoformat(event_markets[0]["close_time"].replace("Z", "+00:00"))
    minutes_to_expiry = (close_time - now).total_seconds() / 60

    above, below = [], []
    for m in event_markets:
        if m.get("strike_type") != "between":
            continue  # skip open-ended tail rungs — see docstring
        low, high = m["floor_strike"], m["cap_strike"]
        yes_ask = round(float(m["yes_ask_dollars"]) * 100, 2)
        yes_bid = round(float(m["yes_bid_dollars"]) * 100, 2)
        if low > spot:
            above.append((low - spot, low, high, yes_ask, yes_bid))
        elif high < spot:
            below.append((spot - high, low, high, yes_ask, yes_bid))
        # bands containing spot are already ITM -> not a Section 3 candidate

    above.sort(key=lambda t: t[0])
    below.sort(key=lambda t: t[0])

    bands = [
        CandidateBand(low=low, high=high, yes_ask=yes_ask, yes_bid=yes_bid, side_vs_spot="ABOVE_SPOT")
        for _, low, high, yes_ask, yes_bid in above[:max_bands_each_side]
    ] + [
        CandidateBand(low=low, high=high, yes_ask=yes_ask, yes_bid=yes_bid, side_vs_spot="BELOW_SPOT")
        for _, low, high, yes_ask, yes_bid in below[:max_bands_each_side]
    ]
    return bands, minutes_to_expiry, event_ticker


def get_kalshi_updown(series_ticker: str = "KXBTC15M") -> dict:
    """Informational only — NOT a CandidateBand source. KXBTC15M ("BTC
    price up in next 15 mins?") is, unlike hourly KXBTC, a single
    greater_or_equal threshold market per interval — not a band ladder —
    confirmed live 2026-09-10: one open market at a time, ~10 unopened
    future ones queued on a rolling 15-minute cadence. It DOES use
    Kalshi's standard 60s BRTI average on both the open and close side
    (see rules_primary), so it's genuinely TWAP-like despite having no
    band structure — a materially different shape than KXBTC, not just a
    shorter version of it.
    """
    r = requests.get(
        f"{KALSHI_BASE}/markets",
        params={"series_ticker": series_ticker, "status": "open", "limit": 5},
        timeout=REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    markets = r.json()["markets"]
    if not markets:
        raise RuntimeError(f"No open Kalshi markets for series {series_ticker}")
    m = markets[0]
    now = datetime.now(timezone.utc)
    close_time = datetime.fromisoformat(m["close_time"].replace("Z", "+00:00"))
    return {
        "ticker": m["ticker"],
        "title": m.get("title"),
        "target_price": m.get("yes_sub_title"),
        "yes_bid_cents": round(float(m["yes_bid_dollars"]) * 100, 2),
        "yes_ask_cents": round(float(m["yes_ask_dollars"]) * 100, 2),
        "minutes_to_expiry": (close_time - now).total_seconds() / 60,
        "settlement_window_seconds": 60,  # BRTI 60s average, both sides — see docstring
        "settlement_method": "kalshi_brti_60s_avg_vs_open",
    }


def get_kalshi_orderbook(ticker: str) -> dict:
    """Raw orderbook depth for one Kalshi market ticker — not part of the
    MarketSnapshot contract, but useful for confirming real depth exists
    before sizing up (see BRAIN_SPEC.md item 2)."""
    r = requests.get(f"{KALSHI_BASE}/markets/{ticker}/orderbook", timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    return r.json()


def build_kalshi_snapshot(symbol: str = "BTC") -> MarketSnapshot:
    spot = get_coinbase_spot("BTC-USD" if symbol == "BTC" else f"{symbol}-USD")
    recent = get_coinbase_recent_range("BTC-USD" if symbol == "BTC" else f"{symbol}-USD")
    bands, minutes_to_expiry, _event_ticker = get_kalshi_hourly_btc_bands(spot)
    return MarketSnapshot(
        venue="KALSHI",
        symbol=symbol,
        spot=spot,
        minutes_to_expiry=minutes_to_expiry,
        candidate_bands=bands,
        momentum_signal=recent["momentum_signal"],
        recent_30m_high=recent["high"],
        recent_30m_low=recent["low"],
    )


# ---------------------------------------------------------------------------
# Polymarket — see module docstring for the three-product-line finding.
# ---------------------------------------------------------------------------

_TWAP_WINDOW_RE = re.compile(r"twap-(\d+)s-streams", re.IGNORECASE)


def _parse_twap_window_seconds(description: str) -> Optional[int]:
    """Reads the actual TWAP window off a market's own live description
    text (e.g. '...btc-usd-twap-60s-streams') rather than assuming a
    number — see module docstring for why the changelog-inferred default
    isn't trustworthy on its own."""
    match = _TWAP_WINDOW_RE.search(description or "")
    return int(match.group(1)) if match else None


def get_clob_yes_prices(token_id: str) -> tuple[Optional[float], Optional[float]]:
    """Best (yes_bid, yes_ask) in cents for one CLOB token, or (None, None)
    if the book is empty on that side."""
    yes_bid = yes_ask = None
    try:
        r = requests.get(
            f"{POLYMARKET_CLOB_BASE}/price",
            params={"token_id": token_id, "side": "buy"},
            timeout=REQUEST_TIMEOUT,
        )
        if r.ok:
            yes_bid = round(float(r.json()["price"]) * 100, 2)
    except (requests.RequestException, KeyError, ValueError):
        pass
    try:
        r = requests.get(
            f"{POLYMARKET_CLOB_BASE}/price",
            params={"token_id": token_id, "side": "sell"},
            timeout=REQUEST_TIMEOUT,
        )
        if r.ok:
            yes_ask = round(float(r.json()["price"]) * 100, 2)
    except (requests.RequestException, KeyError, ValueError):
        pass
    return yes_bid, yes_ask


_BAND_QUESTION_RE = re.compile(
    r"between\s*\$?([\d,]+)\s*and\s*\$?([\d,]+)|"
    r"less than\s*\$?([\d,]+)|"
    r"greater than\s*\$?([\d,]+)",
    re.IGNORECASE,
)


def _parse_band_from_question(question: str) -> Optional[tuple[float, float]]:
    match = _BAND_QUESTION_RE.search(question or "")
    if not match:
        return None
    lo_a, hi_a, lo_only, hi_only = match.groups()
    if lo_a and hi_a:
        return float(lo_a.replace(",", "")), float(hi_a.replace(",", ""))
    if lo_only:
        return None  # open-ended "less than $X" — same tail-rung problem as Kalshi, skip
    if hi_only:
        return None  # open-ended "greater than $X" — skip
    return None


def get_polymarket_daily_bitcoin_bands(
    spot: float,
    date: Optional[datetime] = None,
    max_bands_each_side: int = 6,
) -> tuple[list[CandidateBand], float, Optional[int], str]:
    """Returns (candidate_bands, minutes_to_expiry, settlement_window_seconds,
    event_slug) from the "Bitcoin price on <date>" daily band-ladder event —
    the only Polymarket product structurally matching CandidateBand. See
    module docstring: this settles off a single Binance 1-minute close, so
    settlement_window_seconds is 0 (or None if the live text doesn't say),
    never a fabricated TWAP number.
    """
    date = (date or datetime.now(timezone.utc)).astimezone(ZoneInfo("America/New_York"))
    slug = f"bitcoin-price-on-{date.strftime('%B').lower()}-{date.day}-{date.year}"
    r = requests.get(f"{POLYMARKET_GAMMA_BASE}/events", params={"slug": slug}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    events = r.json()
    if not events:
        raise RuntimeError(f"No Polymarket event found for slug {slug}")
    event = events[0]
    end_time = datetime.fromisoformat(event["endDate"].replace("Z", "+00:00"))
    minutes_to_expiry = (end_time - datetime.now(timezone.utc)).total_seconds() / 60

    settlement_window_seconds: Optional[int] = None
    above, below = [], []
    for m in event.get("markets", []):
        band = _parse_band_from_question(m.get("question", ""))
        if band is None:
            continue
        low, high = band
        if settlement_window_seconds is None:
            parsed = _parse_twap_window_seconds(m.get("description", ""))
            settlement_window_seconds = parsed if parsed is not None else 0

        import json as _json
        token_ids = _json.loads(m.get("clobTokenIds", "[]"))
        yes_bid = yes_ask = None
        if token_ids:
            yes_bid, yes_ask = get_clob_yes_prices(token_ids[0])
        if yes_bid is None or yes_ask is None:
            prices = _json.loads(m.get("outcomePrices", "[null, null]"))
            yes_bid = yes_ask = round(float(prices[0]) * 100, 2) if prices[0] is not None else None
        if yes_ask is None:
            continue

        if low > spot:
            above.append((low - spot, low, high, yes_ask, yes_bid or yes_ask))
        elif high < spot:
            below.append((spot - high, low, high, yes_ask, yes_bid or yes_ask))

    above.sort(key=lambda t: t[0])
    below.sort(key=lambda t: t[0])

    bands = [
        CandidateBand(low=low, high=high, yes_ask=yes_ask, yes_bid=yes_bid, side_vs_spot="ABOVE_SPOT")
        for _, low, high, yes_ask, yes_bid in above[:max_bands_each_side]
    ] + [
        CandidateBand(low=low, high=high, yes_ask=yes_ask, yes_bid=yes_bid, side_vs_spot="BELOW_SPOT")
        for _, low, high, yes_ask, yes_bid in below[:max_bands_each_side]
    ]
    return bands, minutes_to_expiry, settlement_window_seconds, slug


def build_polymarket_snapshot(symbol: str = "BTC") -> MarketSnapshot:
    if symbol != "BTC":
        raise NotImplementedError("Only BTC is wired for Polymarket so far")
    spot = get_coinbase_spot("BTC-USD")
    recent = get_coinbase_recent_range("BTC-USD")
    bands, minutes_to_expiry, settlement_window_seconds, _slug = get_polymarket_daily_bitcoin_bands(spot)
    return MarketSnapshot(
        venue="POLYMARKET",
        symbol=symbol,
        spot=spot,
        minutes_to_expiry=minutes_to_expiry,
        candidate_bands=bands,
        momentum_signal=recent["momentum_signal"],
        recent_30m_high=recent["high"],
        recent_30m_low=recent["low"],
        settlement_window_seconds=settlement_window_seconds,
    )


_TWAP_INTERVAL_SECONDS = {"5m": 300, "15m": 900, "4h": 14400}


def get_polymarket_twap_updown(interval: str = "5m") -> dict:
    """Informational only — NOT a CandidateBand source (plain Up/Down, no
    band). This is the genuinely Chainlink-TWAP-settled product line (see
    module docstring) — slugs are epoch-aligned to the interval boundary
    (`btc-updown-<interval>-<unix_ts>`), so the current window's slug is
    computed directly rather than searched for. Confirmed live 2026-09-10
    for interval in {"5m", "15m", "4h"} — there is NO "1h" variant.

    Note on "polycool.app" (per Mar, 2026-09-10): it's a mobile
    copy-trading/alerts front-end for Polymarket, not a separate data
    venue or API — trades placed through it still settle on Polymarket's
    own CLOB/contracts. This function (Polymarket's own Gamma + CLOB APIs)
    is the actual data source either way; nothing separate to integrate
    for "polycool" itself unless it turns out to expose its own public
    API later.
    """
    import json as _json

    if interval not in _TWAP_INTERVAL_SECONDS:
        raise ValueError(f"interval must be one of {list(_TWAP_INTERVAL_SECONDS)}")
    step = _TWAP_INTERVAL_SECONDS[interval]
    window_start_ts = (int(time.time()) // step) * step
    slug = f"btc-updown-{interval}-{window_start_ts}"
    r = requests.get(f"{POLYMARKET_GAMMA_BASE}/events", params={"slug": slug}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    events = r.json()
    if not events:
        raise RuntimeError(f"No Polymarket {interval} TWAP Up/Down event found for slug {slug}")
    market = events[0]["markets"][0]
    token_ids = _json.loads(market.get("clobTokenIds", "[]"))
    up_bid, up_ask = get_clob_yes_prices(token_ids[0]) if token_ids else (None, None)
    end_time = datetime.fromisoformat(market["endDate"].replace("Z", "+00:00"))
    return {
        "slug": slug,
        "question": market.get("question"),
        "up_bid_cents": up_bid,
        "up_ask_cents": up_ask,
        "minutes_to_expiry": (end_time - datetime.now(timezone.utc)).total_seconds() / 60,
        "settlement_window_seconds": _parse_twap_window_seconds(market.get("description", "")),
        "settlement_method": "chainlink_twap",
    }


def get_polymarket_hourly_updown(hour_et: Optional[datetime] = None) -> dict:
    """Informational only — NOT a CandidateBand source. Returns the live
    Up/Down market for the given ET hour (default: current). See module
    docstring: this is Binance-1H-candle settled, not TWAP, and has no
    band structure brain.py's CandidateBand can represent."""
    import json as _json

    hour_et = (hour_et or datetime.now(timezone.utc)).astimezone(ZoneInfo("America/New_York"))
    hour_12 = hour_et.hour % 12 or 12  # avoid %-I/%#I strftime flags (platform-specific)
    period = "am" if hour_et.hour < 12 else "pm"
    hour_str = f"{hour_12}{period}"
    slug = f"bitcoin-up-or-down-{hour_et.strftime('%B').lower()}-{hour_et.day}-{hour_et.year}-{hour_str}-et"
    r = requests.get(f"{POLYMARKET_GAMMA_BASE}/events", params={"slug": slug}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    events = r.json()
    if not events:
        raise RuntimeError(f"No Polymarket hourly Up/Down event found for slug {slug}")
    market = events[0]["markets"][0]
    token_ids = _json.loads(market.get("clobTokenIds", "[]"))
    up_bid, up_ask = get_clob_yes_prices(token_ids[0]) if token_ids else (None, None)
    return {
        "slug": slug,
        "question": market.get("question"),
        "up_bid_cents": up_bid,
        "up_ask_cents": up_ask,
        "settlement_window_seconds": _parse_twap_window_seconds(market.get("description", "")),
        "settlement_method": "binance_1h_candle_open_close",
    }
