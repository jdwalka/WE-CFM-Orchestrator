"""Exchange activity scanner for orbital market-share bucketing.

Pings CCXT public ticker endpoints for a small exchange set, aggregates 24h BTC
quote volume, and buckets exchanges into orbital tiers:
- s-orbital: core market makers (> 15%)
- p-orbital: primary contenders (5% - 15%)
- d-orbital: dynamic mid-tiers (1% - 5%)
- f-orbital: fringe / specialized (< 1%)
"""

from __future__ import annotations

import argparse
import time
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

try:
    import ccxt
except ImportError as exc:  # pragma: no cover - runtime dependency guard
    raise SystemExit(
        "ccxt is required for this script. Install it with: pip install ccxt"
    ) from exc


DEFAULT_EXCHANGE_IDS: Tuple[str, ...] = (
    "binance",
    "pionex",
    "bybit",
    "bitmart",
    "gate",
    "ascendex",
    "okx",
    "mexc",
    "whitebit",
    "bitget",
    "kucoin",
    "htx",
    "coinbase",
    "kraken",
    "gemini",
)

ORBITAL_LABELS = {
    "s": "s-orbital (Core Market Makers | > 15% Weight)",
    "p": "p-orbital (Primary Contenders | 5% - 15% Weight)",
    "d": "d-orbital (Dynamic Mid-Tiers | 1% - 5% Weight)",
    "f": "f-orbital (Fringe/Specialized | < 1% Weight)",
}


@dataclass
class ExchangeSnapshot:
    exchange_id: str
    volume: float
    weight_pct: float


def parse_exchange_ids(raw: Optional[str]) -> List[str]:
    if not raw:
        return list(DEFAULT_EXCHANGE_IDS)
    items = [part.strip().lower() for part in raw.split(",") if part.strip()]
    return items or list(DEFAULT_EXCHANGE_IDS)


def resolve_symbol(exchange_id: str, default_symbol: str) -> str:
    if exchange_id in {"coinbase", "kraken", "gemini"}:
        return "BTC/USD"
    return default_symbol


def fetch_exchange_activity(exchange_id: str, default_symbol: str = "BTC/USDT") -> float:
    """Fetches 24h BTC quote volume from a CCXT exchange."""

    if not hasattr(ccxt, exchange_id):
        print(f"[-] {exchange_id} is not supported by CCXT. Skipping.")
        return 0.0

    symbol = resolve_symbol(exchange_id, default_symbol)
    exchange_class = getattr(ccxt, exchange_id)
    exchange = exchange_class({"enableRateLimit": True})

    try:
        ticker = exchange.fetch_ticker(symbol)
    except ccxt.BadSymbol:
        print(f"[-] {exchange_id} does not support {symbol}.")
        return 0.0
    except Exception as exc:
        print(f"[-] Failed to fetch data for {exchange_id}: {type(exc).__name__}")
        return 0.0

    volume = ticker.get("quoteVolume") or 0
    if not volume:
        base_vol = ticker.get("baseVolume") or 0
        last_price = ticker.get("last") or 0
        volume = base_vol * last_price

    try:
        return float(volume or 0)
    except (TypeError, ValueError):
        return 0.0


def assign_orbital(weight_pct: float) -> str:
    if weight_pct >= 15.0:
        return "s"
    if weight_pct >= 5.0:
        return "p"
    if weight_pct >= 1.0:
        return "d"
    return "f"


def build_snapshots(exchange_ids: Sequence[str], pause_seconds: float, default_symbol: str) -> List[ExchangeSnapshot]:
    volumes: Dict[str, float] = {}
    total = 0.0

    for exchange_id in exchange_ids:
        vol = fetch_exchange_activity(exchange_id, default_symbol=default_symbol)
        if vol > 0:
            volumes[exchange_id] = vol
            total += vol
        time.sleep(pause_seconds)

    if total <= 0:
        return []

    snapshots = [
        ExchangeSnapshot(exchange_id=exchange_id, volume=vol, weight_pct=(vol / total) * 100.0)
        for exchange_id, vol in sorted(volumes.items(), key=lambda item: item[1], reverse=True)
    ]
    return snapshots


def print_orbital_report(snapshots: Iterable[ExchangeSnapshot]) -> None:
    buckets = {key: [] for key in ORBITAL_LABELS}
    for snap in snapshots:
        orbital = assign_orbital(snap.weight_pct)
        buckets[orbital].append(
            f"{snap.exchange_id.capitalize():<12} | Vol: ${snap.volume:14,.2f} | Weight: {snap.weight_pct:5.2f}%"
        )

    print("\n" + "=" * 65)
    print(" ORBITAL COHERENCE: EXCHANGE DISTRIBUTION")
    print("=" * 65)
    for orbital_key in ("s", "p", "d", "f"):
        print(f"\n### {ORBITAL_LABELS[orbital_key]}")
        print("-" * 65)
        rows = buckets[orbital_key]
        if not rows:
            print("No signals mapped to this orbital in the current snapshot.")
            continue
        for row in rows:
            print(row)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Scan exchange BTC volume and bucket by orbital share.")
    parser.add_argument(
        "--exchanges",
        default=",".join(DEFAULT_EXCHANGE_IDS),
        help="Comma-separated CCXT exchange ids to scan.",
    )
    parser.add_argument(
        "--pause-seconds",
        type=float,
        default=0.5,
        help="Pause between exchange requests to respect free endpoint limits.",
    )
    parser.add_argument(
        "--symbol",
        default="BTC/USDT",
        help="Default BTC symbol for non-fiat exchanges.",
    )
    args = parser.parse_args(argv)

    exchange_ids = parse_exchange_ids(args.exchanges)
    print("WECRYPTO: Initializing Orbital Coherence Market Scan...\n")

    snapshots = build_snapshots(exchange_ids, max(0.0, args.pause_seconds), args.symbol)
    if not snapshots:
        print("No activity detected. Check network connection or endpoint limits.")
        return 1

    print_orbital_report(snapshots)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
