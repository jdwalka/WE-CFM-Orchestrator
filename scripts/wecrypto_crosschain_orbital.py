"""WECRYPTO cross-chain orbital engine scaffold.

This module provides safe, production-grade scaffolding for a 15-minute
cross-chain orbital loop across BTC/ETH/SOL/XRP with:
- lambda auto-scaling
- s/p/d/f orbital computation and OEQ score
- mean-reversion intent mapped to Kalshi V2 payload semantics
- hybrid exits (d-orbital trailing stop + s-orbital decay)

Execution is dry-run by default. Live order submission requires explicit CLI mode
and environment gating.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib import error, request


LOGGER = logging.getLogger("wecrypto_crosschain_orbital")
DEFAULT_ASSETS: Tuple[str, ...] = ("BTC", "ETH", "SOL", "XRP")


@dataclass
class CliConfig:
    """Runtime configuration assembled from CLI + environment."""

    mode: str
    interval_seconds: int
    assets: List[str]
    default_count: float
    default_price: float
    once: bool
    kalshi_base_url: str
    kalshi_token: Optional[str]
    kalshi_submit_env_enabled: bool
    kalshi_cache_path: Optional[Path]
    random_seed: int

    @property
    def dry_run(self) -> bool:
        """Returns True when network order submission is disabled."""
        return self.mode != "live-submit"


@dataclass
class OrbitalSnapshot:
    """Computed orbital values for one asset and one cycle."""

    asset: str
    price: float
    lambda_scale: float
    s_orbital: float
    p_orbital: float
    d_orbital: float
    f_orbital: float
    oeq: float


@dataclass
class PositionState:
    """Simple position state used for hybrid exit scaffolding."""

    open_side: Optional[str] = None  # "yes" or "no"
    entry_price: Optional[float] = None
    peak_oeq_abs: float = 0.0


@dataclass
class OrderIntent:
    """Order intent before Kalshi payload generation."""

    asset: str
    ticker: str
    side: str  # "yes" or "no"
    count: float
    price: float
    reason: str
    oeq: float


@dataclass
class MarketState:
    """In-memory state for orbital computations across loop ticks."""

    price_history: Dict[str, List[float]] = field(default_factory=dict)
    position_by_asset: Dict[str, PositionState] = field(default_factory=dict)

    def ensure_asset(self, asset: str) -> None:
        """Creates empty state records for a new asset if needed."""
        self.price_history.setdefault(asset, [])
        self.position_by_asset.setdefault(asset, PositionState())


class MockPriceFeed:
    """Deterministic mock feed for safe/offline scaffolding tests."""

    def __init__(self, assets: Sequence[str], seed: int) -> None:
        self._rng = random.Random(seed)
        self._last_price: Dict[str, float] = {}
        for asset in assets:
            base = {"BTC": 68000.0, "ETH": 3300.0, "SOL": 155.0, "XRP": 0.62}.get(
                asset, 100.0
            )
            self._last_price[asset] = base * (1 + self._rng.uniform(-0.01, 0.01))

    def next_prices(self) -> Dict[str, float]:
        """Returns next synthetic tick prices."""
        out: Dict[str, float] = {}
        for asset, prev in self._last_price.items():
            shock = self._rng.gauss(0, 0.0045)
            drift = 0.0002 if asset in ("BTC", "ETH") else 0.0001
            px = max(0.0001, prev * (1 + drift + shock))
            self._last_price[asset] = px
            out[asset] = px
        return out


def parse_assets(raw_assets: Optional[str]) -> List[str]:
    """Parses CSV asset list into uppercase symbols with validation."""
    if not raw_assets:
        return list(DEFAULT_ASSETS)
    assets = [item.strip().upper() for item in raw_assets.split(",") if item.strip()]
    if not assets:
        raise ValueError("asset override resolved to an empty list")
    return assets


def normalize_bool_env(value: Optional[str]) -> bool:
    """Parses typical truthy environment variable strings."""
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def load_cli_config(argv: Optional[Sequence[str]] = None) -> CliConfig:
    """Parses CLI args and merges required environment settings."""
    parser = argparse.ArgumentParser(
        description="WECRYPTO cross-chain orbital scaffold for Kalshi payload flow."
    )
    parser.add_argument(
        "--mode",
        choices=("dry-run", "live-submit"),
        default="dry-run",
        help="Execution mode; live-submit still requires env submit gate.",
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=900,
        help="Loop interval in seconds (default: 900, 15 minutes).",
    )
    parser.add_argument(
        "--assets",
        default=",".join(DEFAULT_ASSETS),
        help="Comma-separated asset list override (e.g., BTC,ETH,SOL).",
    )
    parser.add_argument(
        "--default-count",
        type=float,
        default=1.0,
        help="Fallback order count when no sizing override is present.",
    )
    parser.add_argument(
        "--default-price",
        type=float,
        default=0.5,
        help="Fallback order price in [0,1] if model-derived price unavailable.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one cycle and exit (recommended for testing).",
    )
    args = parser.parse_args(argv)

    assets = parse_assets(args.assets)
    if args.interval_seconds <= 0:
        raise ValueError("--interval-seconds must be > 0")
    if args.default_count <= 0:
        raise ValueError("--default-count must be > 0")
    if not (0.0 <= args.default_price <= 1.0):
        raise ValueError("--default-price must be in [0,1]")

    cache_env = os.getenv("WECRYPTO_KALSHI_CACHE_PATH")
    cache_path = Path(cache_env).expanduser() if cache_env else None

    return CliConfig(
        mode=args.mode,
        interval_seconds=args.interval_seconds,
        assets=assets,
        default_count=args.default_count,
        default_price=args.default_price,
        once=args.once,
        kalshi_base_url=os.getenv(
            "KALSHI_API_BASE_URL", "https://trading-api.kalshi.com/trade-api/v2"
        ).rstrip("/"),
        kalshi_token=os.getenv("KALSHI_API_TOKEN"),
        kalshi_submit_env_enabled=normalize_bool_env(os.getenv("KALSHI_ENABLE_SUBMIT")),
        kalshi_cache_path=cache_path,
        random_seed=int(os.getenv("WECRYPTO_RANDOM_SEED", "42")),
    )


def bounded(values: Iterable[float], floor: float, ceil: float) -> List[float]:
    """Clamps values into [floor, ceil]."""
    return [max(floor, min(ceil, v)) for v in values]


def compute_lambda_scale(prices: Sequence[float]) -> float:
    """Auto-scales lambda from recent realized volatility."""
    if len(prices) < 3:
        return 1.0
    returns: List[float] = []
    for i in range(1, len(prices)):
        prev = prices[i - 1]
        if prev <= 0:
            continue
        returns.append((prices[i] / prev) - 1.0)
    if not returns:
        return 1.0
    mean_ret = sum(returns) / len(returns)
    var = sum((r - mean_ret) ** 2 for r in returns) / max(1, len(returns) - 1)
    vol = math.sqrt(var)
    scaled = 1.0 + (vol * 40.0)
    return max(0.5, min(3.0, scaled))


def compute_orbitals(asset: str, prices: Sequence[float], lambda_scale: float) -> OrbitalSnapshot:
    """Computes s/p/d/f orbital components and OEQ for a single asset."""
    if not prices:
        raise ValueError(f"cannot compute orbitals for {asset}: empty prices")

    curr = prices[-1]
    prev = prices[-2] if len(prices) > 1 else curr
    ret = (curr / prev - 1.0) if prev > 0 else 0.0

    lookback = min(12, len(prices))
    window = prices[-lookback:]
    moving_avg = sum(window) / len(window)

    s_orbital = ret * lambda_scale
    p_orbital = ((curr - moving_avg) / moving_avg) * lambda_scale if moving_avg > 0 else 0.0

    if len(window) > 1:
        rets = [(window[i] / window[i - 1] - 1.0) for i in range(1, len(window)) if window[i - 1] > 0]
    else:
        rets = [0.0]
    d_orbital = math.sqrt(sum(r * r for r in rets) / len(rets)) * (lambda_scale * 0.75)

    accel = 0.0
    if len(prices) >= 3 and prices[-2] > 0 and prices[-3] > 0:
        r1 = prices[-1] / prices[-2] - 1.0
        r0 = prices[-2] / prices[-3] - 1.0
        accel = r1 - r0
    f_orbital = accel * (0.6 * lambda_scale)

    s_orbital, p_orbital, d_orbital, f_orbital = bounded(
        [s_orbital, p_orbital, d_orbital, f_orbital], -5.0, 5.0
    )
    oeq = (0.45 * s_orbital) + (0.25 * p_orbital) + (0.20 * d_orbital) + (0.10 * f_orbital)

    return OrbitalSnapshot(
        asset=asset,
        price=curr,
        lambda_scale=lambda_scale,
        s_orbital=s_orbital,
        p_orbital=p_orbital,
        d_orbital=d_orbital,
        f_orbital=f_orbital,
        oeq=oeq,
    )


def load_kalshi_cache(cache_path: Optional[Path]) -> Dict[str, str]:
    """Loads optional local active-ticker cache (JSON map or list records).

    TODO-safe integration helper:
    - Preferred shape: {"BTC": "KXCRYPTO-BTC-..."}
    - Also supports list records: [{"asset":"BTC","ticker":"..."}]
    """
    if cache_path is None:
        return {}
    if not cache_path.exists():
        LOGGER.debug("Kalshi cache path does not exist: %s", cache_path)
        return {}
    try:
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        LOGGER.warning("Failed to read Kalshi cache %s: %s", cache_path, exc)
        return {}

    out: Dict[str, str] = {}
    if isinstance(raw, dict):
        for key, value in raw.items():
            if isinstance(key, str) and isinstance(value, str):
                out[key.upper()] = value
    elif isinstance(raw, list):
        for item in raw:
            if (
                isinstance(item, dict)
                and isinstance(item.get("asset"), str)
                and isinstance(item.get("ticker"), str)
            ):
                out[item["asset"].upper()] = item["ticker"]
    return out


def lookup_active_ticker(asset: str, cache_map: Dict[str, str]) -> str:
    """Resolves active Kalshi ticker with safe placeholder fallback.

    Priority:
    1) local cache map (optional)
    2) placeholder deterministic ticker

    TODO: Replace fallback with live `/markets` query and strike/expiry routing.
    """
    if asset in cache_map:
        return cache_map[asset]
    return f"KXCRYPTO-{asset}-ACTIVE-PLACEHOLDER"


def choose_order_intent(
    orbital: OrbitalSnapshot,
    position: PositionState,
    ticker: str,
    default_count: float,
    default_price: float,
) -> Optional[OrderIntent]:
    """Maps OEQ and hybrid exit logic to order intent.

    Entry (mean reversion):
    - OEQ significantly positive -> short-reversion intent => buy NO
    - OEQ significantly negative -> long-reversion intent => buy YES

    Exit (hybrid):
    - d-orbital trailing stop on abs(OEQ) confidence
    - s-orbital decay threshold
    """
    entry_threshold = 0.015
    trailing_multiplier = 1.6
    s_decay_threshold = 0.003

    abs_oeq = abs(orbital.oeq)
    position.peak_oeq_abs = max(position.peak_oeq_abs, abs_oeq)

    if position.open_side is None:
        if orbital.oeq >= entry_threshold:
            side = "no"
            reason = "entry_reversion_oeq_positive"
        elif orbital.oeq <= -entry_threshold:
            side = "yes"
            reason = "entry_reversion_oeq_negative"
        else:
            return None

        return OrderIntent(
            asset=orbital.asset,
            ticker=ticker,
            side=side,
            count=default_count,
            price=derive_limit_price(orbital.oeq, default_price),
            reason=reason,
            oeq=orbital.oeq,
        )

    trailing_band = orbital.d_orbital * trailing_multiplier
    trailing_hit = abs_oeq < (position.peak_oeq_abs - trailing_band)
    s_decay_hit = abs(orbital.s_orbital) < s_decay_threshold

    if trailing_hit or s_decay_hit:
        close_side = "no" if position.open_side == "yes" else "yes"
        reason = "exit_trailing_stop" if trailing_hit else "exit_s_orbital_decay"
        return OrderIntent(
            asset=orbital.asset,
            ticker=ticker,
            side=close_side,
            count=default_count,
            price=derive_limit_price(orbital.oeq, default_price),
            reason=reason,
            oeq=orbital.oeq,
        )

    return None


def derive_limit_price(oeq: float, default_price: float) -> float:
    """Converts OEQ confidence into bounded prediction-market limit price."""
    centered = default_price + (oeq * 3.0)
    return max(0.01, min(0.99, centered))


def format_count(count: float) -> str:
    """Formats count as strict fixed-point with 2 decimals."""
    return f"{count:.2f}"


def format_price(price: float) -> str:
    """Formats price as strict fixed-point with 4 decimals."""
    return f"{price:.4f}"


def build_kalshi_v2_payload(intent: OrderIntent) -> Dict[str, str]:
    """Builds Kalshi V2-style order payload with fixed-point strings."""
    payload: Dict[str, str] = {
        "ticker": intent.ticker,
        "client_order_id": str(uuid.uuid4()),
        "type": "limit",
        "action": "buy",
        "side": intent.side,
        "count": format_count(intent.count),
    }
    price_key = "yes_price" if intent.side == "yes" else "no_price"
    payload[price_key] = format_price(intent.price)
    return payload


def submit_kalshi_order(payload: Dict[str, str], config: CliConfig) -> Dict[str, Any]:
    """Optionally submits payload to Kalshi HTTP API.

    Live submission only occurs when:
    - CLI mode is `live-submit`
    - KALSHI_ENABLE_SUBMIT is truthy
    - KALSHI_API_TOKEN is set
    """
    if config.dry_run:
        return {"submitted": False, "reason": "dry_run_mode"}
    if not config.kalshi_submit_env_enabled:
        return {"submitted": False, "reason": "env_submit_gate_disabled"}
    if not config.kalshi_token:
        return {"submitted": False, "reason": "missing_kalshi_api_token"}

    endpoint = f"{config.kalshi_base_url}/portfolio/orders"
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {config.kalshi_token}",
            "Content-Type": "application/json",
        },
    )

    try:
        with request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            parsed = json.loads(raw) if raw else {}
            return {"submitted": True, "status_code": resp.status, "response": parsed}
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        return {
            "submitted": False,
            "error": "http_error",
            "status_code": exc.code,
            "response_text": raw,
        }
    except (error.URLError, TimeoutError) as exc:
        return {"submitted": False, "error": "network_error", "message": str(exc)}


def update_position_state(position: PositionState, intent: OrderIntent) -> None:
    """Updates local position model after an intent is generated."""
    if position.open_side is None:
        position.open_side = intent.side
        position.entry_price = intent.price
        position.peak_oeq_abs = abs(intent.oeq)
        return

    # Any intent while open is treated as a close in this scaffold.
    position.open_side = None
    position.entry_price = None
    position.peak_oeq_abs = 0.0


def emit_payload_preview(intent: OrderIntent, payload: Dict[str, str], submit_result: Dict[str, Any], dry_run: bool) -> None:
    """Prints concise machine-readable output for logs/pipelines."""
    line = {
        "asset": intent.asset,
        "reason": intent.reason,
        "ticker": intent.ticker,
        "side": payload.get("side"),
        "count": payload.get("count"),
        "price": payload.get("yes_price") or payload.get("no_price"),
        "dry_run": dry_run,
        "submitted": submit_result.get("submitted", False),
    }
    print(json.dumps(line, separators=(",", ":"), sort_keys=True))


def run_single_cycle(config: CliConfig, state: MarketState, feed: MockPriceFeed, cache_map: Dict[str, str]) -> None:
    """Runs one orbital cycle across all configured assets."""
    latest_prices = feed.next_prices()

    for asset in config.assets:
        state.ensure_asset(asset)
        px = latest_prices[asset]
        history = state.price_history[asset]
        history.append(px)
        if len(history) > 96:
            del history[0 : len(history) - 96]

        lambda_scale = compute_lambda_scale(history)
        orbital = compute_orbitals(asset, history, lambda_scale)
        ticker = lookup_active_ticker(asset, cache_map)
        position = state.position_by_asset[asset]

        intent = choose_order_intent(
            orbital=orbital,
            position=position,
            ticker=ticker,
            default_count=config.default_count,
            default_price=config.default_price,
        )
        if intent is None:
            LOGGER.info(
                "asset=%s price=%.6f oeq=%.6f no_order",
                asset,
                orbital.price,
                orbital.oeq,
            )
            continue

        payload = build_kalshi_v2_payload(intent)
        submit_result = submit_kalshi_order(payload, config)
        emit_payload_preview(intent, payload, submit_result, config.dry_run)
        update_position_state(position, intent)


def run_loop(config: CliConfig) -> None:
    """Runs perpetual or once-only orbital cycles with robust guards."""
    if config.mode == "live-submit":
        LOGGER.warning(
            "Live-submit requested. Submission only proceeds when "
            "KALSHI_ENABLE_SUBMIT=true and KALSHI_API_TOKEN is set."
        )

    cache_map = load_kalshi_cache(config.kalshi_cache_path)
    feed = MockPriceFeed(config.assets, config.random_seed)
    state = MarketState()

    cycle = 0
    while True:
        cycle += 1
        started = time.time()
        try:
            run_single_cycle(config, state, feed, cache_map)
        except Exception as exc:  # pylint: disable=broad-except
            LOGGER.exception("cycle=%s failed: %s", cycle, exc)

        if config.once:
            break

        elapsed = time.time() - started
        sleep_for = max(0.0, config.interval_seconds - elapsed)
        LOGGER.info("cycle=%s complete; sleeping %.2fs", cycle, sleep_for)
        time.sleep(sleep_for)


def configure_logging() -> None:
    """Sets simple structured logging defaults."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Program entrypoint."""
    configure_logging()
    try:
        config = load_cli_config(argv)
    except Exception as exc:  # pylint: disable=broad-except
        LOGGER.error("Invalid configuration: %s", exc)
        return 2

    try:
        run_loop(config)
    except KeyboardInterrupt:
        LOGGER.info("Interrupted by user.")
        return 130
    except Exception as exc:  # pylint: disable=broad-except
        LOGGER.exception("Fatal runtime error: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
