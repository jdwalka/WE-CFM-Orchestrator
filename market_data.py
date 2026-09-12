"""Live market data for BTC hourly range predictions."""
from datetime import datetime, timezone

import requests

COINBASE_SPOT = "https://api.coinbase.com/v2/prices/BTC-USD/spot"
COINBASE_CANDLES = "https://api.exchange.coinbase.com/products/BTC-USD/candles"

# Coinbase's exchange API (candles) has been observed rejecting requests with
# no User-Agent header (confirmed from a Cloudflare Worker this session,
# where fetch() sends none by default). python-requests sends a default UA
# so this hasn't bitten this code yet, but setting it explicitly costs
# nothing and removes the risk if that default ever gets stricter.
_HEADERS = {"User-Agent": "wecryp-truffle/1.0 (+https://agentverse.ai)"}

def get_spot() -> dict:
    """Current BTC spot with an explicit source stamp.

    BRTI is the canonical settlement oracle, but no authenticated BRTI feed is
    configured in this deployment yet. Coinbase spot is therefore a stamped
    fallback rather than an implicit source.
    """
    try:
        r = requests.get(COINBASE_SPOT, headers=_HEADERS, timeout=10)
        r.raise_for_status()
        price = float(r.json()["data"]["amount"])
        return {
            "price": price,
            "source": "coinbase_spot_fallback",
            "canonical_source": "BRTI",
            "error": None,
        }
    except (requests.RequestException, KeyError, ValueError, TypeError) as e:
        return {
            "price": None,
            "source": "unavailable",
            "canonical_source": "BRTI",
            "error": str(e),
        }

def get_hourly_candles(count: int = 24) -> list:
    """Recent hourly candles from Coinbase Exchange.

    Returns list of dicts: time, low, high, open, close, volume
    Sorted oldest -> newest.
    """
    try:
        r = requests.get(
            COINBASE_CANDLES,
            params={"granularity": 3600},
            headers=_HEADERS,
            timeout=15,
        )
        r.raise_for_status()
        cols = ["time", "low", "high", "open", "close", "volume"]
        candles = [dict(zip(cols, c)) for c in r.json()]
        candles.sort(key=lambda c: c["time"])
        return candles[-count:]
    except (requests.RequestException, KeyError, ValueError, TypeError):
        return []

def compute_stats(candles: list) -> dict:
    """Compute hourly range stats from candles."""
    if not candles:
        return {}
    ranges = [c["high"] - c["low"] for c in candles]
    bodies = [abs(c["close"] - c["open"]) for c in candles]
    ranges_sorted = sorted(ranges)
    n = len(ranges_sorted)
    median_range = (
        ranges_sorted[n // 2] if n % 2 else (ranges_sorted[n // 2 - 1] + ranges_sorted[n // 2]) / 2
    )
    last = candles[-1]
    avg_range = sum(ranges) / len(ranges)
    avg_body = sum(bodies) / len(bodies)
    return {
        "avg_hourly_range": round(avg_range, 2),
        "median_hourly_range": round(median_range, 2),
        "avg_hourly_body": round(avg_body, 2),
        "last_close": last["close"],
        "last_open": last["open"],
        "last_high": last["high"],
        "last_low": last["low"],
        "last_volume": round(last["volume"], 2),
        "candles_used": len(candles),
    }

def get_market_context() -> str:
    """Build a live market context string for the system prompt."""
    spot = get_spot()
    candles = get_hourly_candles(24)
    stats = compute_stats(candles)

    if spot["price"] is None and not stats:
        return "LIVE DATA UNAVAILABLE — ask user for current price."

    lines = [
        f"Timestamp: {datetime.now(timezone.utc).isoformat()} (UTC)",
        f"Current BTC spot (Coinbase): ${spot['price']:,.2f}" if spot["price"] else "Spot unavailable",
    ]

    if stats:
        lines += [
            f"Last hour: open ${stats['last_open']:,.2f}, high ${stats['last_high']:,.2f}, "
            f"low ${stats['last_low']:,.2f}, close ${stats['last_close']:,.2f}",
            f"24h hourly range stats: avg ${stats['avg_hourly_range']:,.2f}, "
            f"median ${stats['median_hourly_range']:,.2f}",
            f"24h avg hourly body (open->close): ${stats['avg_hourly_body']:,.2f}",
            f"Last hour volume: {stats['last_volume']:,.2f} BTC",
        ]

    return "\n".join(lines)

if __name__ == "__main__":
    print(get_market_context())
