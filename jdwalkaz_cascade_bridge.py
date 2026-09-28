"""
Jdwalkaz Agentverse / ASI1 Protocol Bridge — v2 (hardened)
Module: jdwalkaz_cascade_bridge.py
Port: 127.0.0.1:8002
"""

import json
import logging
import os
from dataclasses import asdict
from typing import Any, Dict

from aiohttp import web
from aiohttp.web_exceptions import HTTPRequestEntityTooLarge

from amm_cascade_exhaustion import (
    AmmCascadeExhaustionCalculator,
    AmmPoolDepthBand,
    LiquidationBucket,
    VenueSkew,
    FlowSnapshot,
    CascadeTelemetryPacket,
    CascadeInputError,
    CascadeComputationError,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("jdwalkaz-cascade")

calculator = AmmCascadeExhaustionCalculator()
MAX_BODY_BYTES = 1_000_000  # 1 MB — reject oversized payloads early


def format_asi1_context(packet: CascadeTelemetryPacket) -> str:
    quiet = packet.metadata.get("quiet_tape_flag", 0)
    quiet_note = (
        " [QUIET TAPE: no forced flow in window — exhaustion NOT confirmed]"
        if quiet else ""
    )
    return (
        f"[LIQUIDITY_MECHANICS_OVERLAY]\n"
        f"Symbol: {packet.symbol} | Spot: {packet.spot_price}\n"
        f"Cascade State: {packet.verdict} (Coherence: {packet.cascade_coherence_index})\n"
        f"Vaporization Ratio (V_flush): {packet.vaporization_ratio} (Target: >0.82)\n"
        f"Sub-Orbital Wall Density: {packet.sub_orbital_wall_density} "
        f"(Pending Leverage / AMM Depth)\n"
        f"Inertia Delta: {packet.bonding_inertia_delta} | "
        f"Absorption: {packet.metadata.get('absorption_ratio', 0.0)}x\n"
        f"Venue Skew Adjustment: {packet.venue_skew_adjustment} "
        f"(positive = bid-heavy depth supports upside)\n"
        f"Execution Directive: {packet.recommended_action}{quiet_note}\n"
        f"[CRITICAL]: AMMs do not support failing bids. If Wall Density > 0.65, "
        f"do NOT catch falling knives."
    )


def _parse_bands(raw: Any) -> list:
    if not isinstance(raw, list):
        raise CascadeInputError("amm_bands must be a list")
    bands = []
    for i, b in enumerate(raw):
        if not isinstance(b, dict):
            raise CascadeInputError(f"amm_bands[{i}] must be an object")
        for key in ("low", "high", "depth"):
            if key not in b:
                raise CascadeInputError(f"amm_bands[{i}] missing '{key}'")
        try:
            bands.append(AmmPoolDepthBand(
                lower_price=float(b["low"]),
                upper_price=float(b["high"]),
                virtual_liquidity_depth=float(b["depth"]),
            ))
        except (ValueError, TypeError) as exc:
            raise CascadeInputError(f"amm_bands[{i}] invalid numeric value: {exc}") from exc
    return bands


def _parse_queue(raw: Any) -> list:
    if not isinstance(raw, list):
        raise CascadeInputError("liquidation_queue must be a list")
    queue = []
    for i, q in enumerate(raw):
        if not isinstance(q, dict):
            raise CascadeInputError(f"liquidation_queue[{i}] must be an object")
        for key in ("price", "vol"):
            if key not in q:
                raise CascadeInputError(f"liquidation_queue[{i}] missing '{key}'")
        try:
            queue.append(LiquidationBucket(
                trigger_price=float(q["price"]),
                notional_volume=float(q["vol"]),
                leverage_multiple=float(q.get("leverage", 10.0)),
            ))
        except (ValueError, TypeError) as exc:
            raise CascadeInputError(f"liquidation_queue[{i}] invalid numeric value: {exc}") from exc
    return queue


def _parse_skew(raw: Any) -> VenueSkew:
    if not isinstance(raw, dict):
        return VenueSkew()  # absent -> neutral, engine handles None-equivalent
    try:
        return VenueSkew(
            l_ratio=float(raw.get("l_ratio", 0.0)),
            divergence_pct=float(raw.get("divergence_pct", 0.0)),
            funding_skew=float(raw.get("funding_skew", 0.0)),
            active=bool(raw.get("active", False)),
            max_skew_pct=float(raw.get("max_skew_pct", 0.03)),
        )
    except (ValueError, TypeError) as exc:
        raise CascadeInputError(f"venue_skew invalid field: {exc}") from exc


def _parse_flow(raw: Any) -> FlowSnapshot:
    if not isinstance(raw, dict):
        raise CascadeInputError("flow must be an object")
    try:
        return FlowSnapshot(
            forced_liquidation_volume=float(raw.get("forced_vol", 0.0)),
            discretionary_taker_buy_volume=float(raw.get("taker_buy_vol", 0.0)),
            discretionary_taker_sell_volume=float(raw.get("taker_sell_vol", 0.0)),
            amm_price_velocity=float(raw.get("amm_vel", 0.0)),
            oracle_price_velocity=float(raw.get("oracle_vel", 0.0)),
            window_sec=float(raw.get("window_sec", 300.0)),
        )
    except (ValueError, TypeError) as exc:
        raise CascadeInputError(f"flow invalid numeric field: {exc}") from exc


async def handle_cascade_audit(request: web.Request) -> web.Response:
    """
    Endpoint exposed to WECRYPTO / Jdwalkaz HUD: POST /jdwalkaz/cascade-audit
    """
    try:
        if request.content_length and request.content_length > MAX_BODY_BYTES:
            return web.json_response(
                {"ok": False, "error": "payload too large"}, status=413)

        try:
            data: Dict[str, Any] = await request.json()
        except (json.JSONDecodeError, ValueError):
            return web.json_response(
                {"ok": False, "error": "invalid JSON body"}, status=400)

        if not isinstance(data, dict):
            return web.json_response(
                {"ok": False, "error": "body must be a JSON object"}, status=400)

        symbol = str(data.get("symbol", "BTC"))[:16]  # sanitize
        try:
            spot = float(data.get("spot", 0.0))
        except (ValueError, TypeError):
            return web.json_response(
                {"ok": False, "error": "'spot' must be a positive number"},
                status=400)

        if spot <= 0.0:
            return web.json_response(
                {"ok": False, "error": "'spot' must be a positive number"},
                status=400)

        bands = _parse_bands(data.get("amm_bands", []))
        queue = _parse_queue(data.get("liquidation_queue", []))
        flow = _parse_flow(data.get("flow", {}))
        skew = _parse_skew(data.get("venue_skew"))

        packet = calculator.calculate_metrics(
            symbol, spot, bands, queue, flow, venue_skew=skew)
        asi1_context = format_asi1_context(packet)

        return web.json_response({
            "ok": True,
            "telemetry": asdict(packet),
            "asi1_context_prompt": asi1_context,
            "jdwalkaz_gate": {
                "allow_reversion_entry":
                    packet.verdict == "FLUSH_EXHAUSTED_ABSORPTION_DETECTED",
                "force_halt_knife_catch":
                    packet.verdict == "VOID_SLIP_ACTIVE",
            },
        })

    except CascadeInputError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    except CascadeComputationError as exc:
        log.error("computation error: %s", exc)
        return web.json_response({"ok": False, "error": str(exc)}, status=500)
    except HTTPRequestEntityTooLarge:
        return web.json_response({"ok": False, "error": "payload too large"},
                                 status=413)
    except Exception as exc:  # noqa: BLE001 — last-resort guard, never 500 raw
        log.exception("unhandled error in cascade-audit")
        return web.json_response(
            {"ok": False, "error": "internal error"}, status=500)


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response(
        {"status": "healthy", "service": "jdwalkaz-cascade-engine", "version": "2.0"}
    )


async def handle_query(request: web.Request) -> web.Response:
    """POST /query — ASI1-desk contract: {query} -> {ok, content}."""
    try:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid JSON"},
                                     status=400)
        query = str((data or {}).get("query", "")).strip()
        if not query:
            return web.json_response({"ok": False, "error": "empty query"},
                                     status=400)
        from datetime import datetime, timezone
        lines = [f"jdwalkaz snapshot {datetime.now(timezone.utc).isoformat()}"]
        try:
            from market_data import get_spot as _get_spot
            snap = _get_spot() or {}
            price = snap.get("price") or snap.get("amount") or snap.get("spot")
            if price:
                lines.append(
                    f"BTC SPOT: ${float(price):,.2f} "
                    f"src={snap.get('source', 'coinbase')}")
            else:
                lines.append(f"BTC SPOT unavailable: {snap}")
        except Exception as e:
            lines.append(f"spot error: {e}")
        lines.append("Full cascade verdict needs bands: POST "
                     "/jdwalkaz/cascade-audit {symbol, spot, amm_bands[], "
                     "liquidation_queue[], flow{}}.")
        lines.append(f"QUERY: {query[:500]}")
        return web.json_response({"ok": True, "content": "\n".join(lines)})
    except Exception:
        log.exception("unhandled error in query")
        return web.json_response({"ok": False, "error": "internal error"},
                                 status=500)


def create_jdwalkaz_app() -> web.Application:
    app = web.Application(client_max_size=MAX_BODY_BYTES)
    app.router.add_post("/jdwalkaz/cascade-audit", handle_cascade_audit)
    app.router.add_post("/query", handle_query)
    app.router.add_get("/health", handle_health)
    return app


if __name__ == "__main__":
    # Bind 0.0.0.0 (not loopback): the Windows portproxy + WSL relay reach
    # us via the WSL eth0 address, which loopback-bound sockets reject.
    _host = os.environ.get("JDWALKAZ_BIND", "0.0.0.0")
    app = create_jdwalkaz_app()
    print(f"Jdwalkaz AMM Cascade Bridge bound to http://{_host}:8004")
    web.run_app(app, host=_host, port=8004)
