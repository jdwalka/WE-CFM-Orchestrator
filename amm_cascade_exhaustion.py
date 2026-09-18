"""
AMM Cascade Exhaustion & Leverage Density Matrix — v2 (hardened)
Module: amm_cascade_exhaustion.py
Target Integration: Truffle (uAgents / ASI1.ai Agent Protocol @ 127.0.0.1:8002)

v2 changes:
  - FIXED: absorption_ratio saturation (normalized vs total taker volume, clamped)
  - FIXED: velocity_divergence saturation (clamped to [-5, 5])
  - ADDED: venue skew (cross-venue divergence + funding skew + depth L-ratio)
  - ADDED: input validation, NaN/inf guards, typed exceptions
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional
import math
import time


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class CascadeInputError(ValueError):
    """Raised on malformed or out-of-domain inputs."""


class CascadeComputationError(RuntimeError):
    """Raised when metric computation produces a non-finite result."""


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AmmPoolDepthBand:
    """Concentrated or constant-product liquidity band."""
    lower_price: float
    upper_price: float
    virtual_liquidity_depth: float  # Quote-token equivalent capacity


@dataclass(frozen=True)
class LiquidationBucket:
    """Aggregated liquidation collateral distributed across price steps."""
    trigger_price: float
    notional_volume: float
    leverage_multiple: float


@dataclass(frozen=True)
class VenueSkew:
    """
    Cross-venue positioning skew. Mirrors the live stack's positioning_skew:
      - l_ratio: order-book depth imbalance, [-1, 1]. Negative = bid-heavy
        (support below), positive = ask-heavy (resistance above).
      - divergence_pct: max cross-venue mid divergence vs reference, in %.
      - funding_skew: funding-rate dispersion across venues (per 8h).
    """
    l_ratio: float = 0.0
    divergence_pct: float = 0.0
    funding_skew: float = 0.0
    active: bool = False
    max_skew_pct: float = 0.03  # 3 bps-of-price cap on drift skew, matches live rule


@dataclass(frozen=True)
class FlowSnapshot:
    """Taker and liquidation flow over lookback window tau."""
    forced_liquidation_volume: float
    discretionary_taker_buy_volume: float
    discretionary_taker_sell_volume: float
    amm_price_velocity: float     # dP_amm / dt
    oracle_price_velocity: float  # dP_oracle / dt
    window_sec: float = 300.0


@dataclass
class CascadeTelemetryPacket:
    """Output contract transmitted to Truffle and ASI:One orchestrators."""
    timestamp_ms: int
    symbol: str
    spot_price: float
    vaporization_ratio: float
    sub_orbital_wall_density: float
    bonding_inertia_delta: float
    venue_skew_adjustment: float
    cascade_coherence_index: float
    verdict: str
    recommended_action: str
    metadata: Dict[str, float] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _require_finite(name: str, value: float, *, allow_negative: bool = True) -> float:
    """Reject NaN/inf and (optionally) negative values. Returns the float."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise CascadeInputError(f"{name} must be numeric, got {type(value).__name__}")
    v = float(value)
    if math.isnan(v) or math.isinf(v):
        raise CascadeInputError(f"{name} must be finite, got {v}")
    if not allow_negative and v < 0.0:
        raise CascadeInputError(f"{name} must be >= 0, got {v}")
    return v


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _safe_div(numerator: float, denominator: float, default: float) -> float:
    """Division that never explodes: below-floor denominators return default."""
    if abs(denominator) < 1e-9:
        return default
    return numerator / denominator


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class AmmCascadeExhaustionCalculator:
    """
    Quantifies liquidation exhaustion vs. leverage wall overhang in AMMs.
    All ratio outputs are clamped; no metric can saturate the coherence index
    on its own.
    """

    # Saturation guards (v2)
    ABSORPTION_RATIO_CAP = 5.0      # absorption_ratio hard clamp
    VELOCITY_DIVERGENCE_CAP = 5.0   # velocity divergence hard clamp
    MIN_FORCED_VOL_FLOOR = 1.0      # quote-token floor: below this, flush is "quiet"

    def __init__(
        self,
        slip_tolerance_bps: float = 250.0,   # 2.5% sub-orbital band
        vaporization_threshold: float = 0.82,
        density_threshold: float = 0.65,
        weight_vaporization: float = 2.4,
        weight_density: float = 3.0,
        weight_inertia: float = 1.8,
        weight_venue_skew: float = 1.2,      # v2: skew contribution to coherence
    ):
        self.slip_bps = _require_finite("slip_tolerance_bps", slip_tolerance_bps,
                                        allow_negative=False)
        self.theta_v = _require_finite("vaporization_threshold", vaporization_threshold)
        self.theta_rho = _require_finite("density_threshold", density_threshold)
        self.w_v = _require_finite("weight_vaporization", weight_vaporization)
        self.w_rho = _require_finite("weight_density", weight_density)
        self.w_i = _require_finite("weight_inertia", weight_inertia)
        self.w_s = _require_finite("weight_venue_skew", weight_venue_skew)

    # -- input validation ---------------------------------------------------

    def _validate_inputs(
        self,
        spot_price: float,
        amm_bands: List[AmmPoolDepthBand],
        liquidation_queue: List[LiquidationBucket],
        flow: FlowSnapshot,
        venue_skew: Optional[VenueSkew],
    ) -> None:
        spot_price = _require_finite("spot_price", spot_price, allow_negative=False)
        if spot_price <= 0.0:
            raise CascadeInputError("spot_price must be > 0")

        for i, band in enumerate(amm_bands):
            lo = _require_finite(f"amm_bands[{i}].lower_price", band.lower_price)
            hi = _require_finite(f"amm_bands[{i}].upper_price", band.upper_price)
            _require_finite(f"amm_bands[{i}].depth", band.virtual_liquidity_depth,
                            allow_negative=False)
            if hi <= lo:
                raise CascadeInputError(
                    f"amm_bands[{i}]: upper_price ({hi}) must exceed lower_price ({lo})")

        for i, liq in enumerate(liquidation_queue):
            _require_finite(f"liquidation_queue[{i}].trigger_price", liq.trigger_price)
            _require_finite(f"liquidation_queue[{i}].notional_volume",
                            liq.notional_volume, allow_negative=False)
            _require_finite(f"liquidation_queue[{i}].leverage_multiple",
                            liq.leverage_multiple, allow_negative=False)

        _require_finite("flow.forced_liquidation_volume",
                        flow.forced_liquidation_volume, allow_negative=False)
        _require_finite("flow.discretionary_taker_buy_volume",
                        flow.discretionary_taker_buy_volume, allow_negative=False)
        _require_finite("flow.discretionary_taker_sell_volume",
                        flow.discretionary_taker_sell_volume, allow_negative=False)
        _require_finite("flow.amm_price_velocity", flow.amm_price_velocity)
        _require_finite("flow.oracle_price_velocity", flow.oracle_price_velocity)
        _require_finite("flow.window_sec", flow.window_sec, allow_negative=False)
        if flow.window_sec <= 0.0:
            raise CascadeInputError("flow.window_sec must be > 0")

        if venue_skew is not None:
            _require_finite("venue_skew.l_ratio", venue_skew.l_ratio)
            _require_finite("venue_skew.divergence_pct", venue_skew.divergence_pct,
                            allow_negative=False)
            _require_finite("venue_skew.funding_skew", venue_skew.funding_skew)
            _require_finite("venue_skew.max_skew_pct", venue_skew.max_skew_pct,
                            allow_negative=False)

    # -- metrics -------------------------------------------------------------

    def compute_sub_orbital_depth(
        self,
        spot: float,
        bands: List[AmmPoolDepthBand],
    ) -> float:
        """Integrates AMM liquidity across [spot*(1-slip), spot]."""
        floor_price = spot * (1.0 - (self.slip_bps / 10_000.0))
        effective_depth = 0.0
        for band in bands:
            if band.upper_price < floor_price or band.lower_price > spot:
                continue
            overlap_low = max(floor_price, band.lower_price)
            overlap_high = min(spot, band.upper_price)
            if overlap_high > overlap_low:
                span = band.upper_price - band.lower_price
                if span > 0:
                    fraction = (overlap_high - overlap_low) / span
                    effective_depth += band.virtual_liquidity_depth * fraction
        return max(effective_depth, 1e-6)

    def compute_venue_skew_adjustment(self, skew: Optional[VenueSkew]) -> float:
        """
        Bounded drift skew in [-1, 1], positive = skew supports upside.
        Mirrors the live stack's rule: L-ratio depth imbalance, bounded,
        gated by cross-venue divergence percentile.
        """
        if skew is None or not skew.active:
            return 0.0
        # Depth imbalance term: negative L-ratio (bid-heavy) supports upside.
        depth_term = _clamp(-skew.l_ratio, -1.0, 1.0)
        # Divergence dampening: wide venue dispersion = unreliable skew signal.
        divergence_damp = _clamp(
            1.0 - (skew.divergence_pct / max(skew.max_skew_pct, 1e-9)), 0.0, 1.0
        )
        # Funding skew: negative funding (shorts paying) = capitulation/upside fuel.
        funding_term = _clamp(-skew.funding_skew * 1e4, -1.0, 1.0)  # scale per-8h rate (negative funding -> +upside)
        return _clamp(
            0.6 * depth_term * divergence_damp + 0.4 * funding_term, -1.0, 1.0
        )

    def calculate_metrics(
        self,
        symbol: str,
        spot_price: float,
        amm_bands: List[AmmPoolDepthBand],
        liquidation_queue: List[LiquidationBucket],
        flow: FlowSnapshot,
        venue_skew: Optional[VenueSkew] = None,
    ) -> CascadeTelemetryPacket:
        try:
            self._validate_inputs(spot_price, amm_bands, liquidation_queue,
                                  flow, venue_skew)
        except CascadeInputError:
            raise
        except Exception as exc:
            raise CascadeInputError(f"input validation failed: {exc}") from exc

        now_ms = int(time.time() * 1000)
        floor_price = spot_price * (1.0 - (self.slip_bps / 10_000.0))

        # 1. Pending fragile OI in the sub-orbital slip zone
        pending_fragile_oi = 0.0
        for liq in liquidation_queue:
            if floor_price <= liq.trigger_price <= spot_price:
                leverage_scalar = max(1.0, liq.leverage_multiple / 10.0)
                pending_fragile_oi += liq.notional_volume * leverage_scalar

        # 2. Available pool absorption capacity in that zone
        effective_pool_depth = self.compute_sub_orbital_depth(spot_price, amm_bands)

        # 3. Sub-Orbital Wall Density (rho_sub) — bounded, can't explode
        wall_density = _clamp(
            _safe_div(pending_fragile_oi, effective_pool_depth, default=0.0),
            0.0, 10.0,
        )

        # 4. Fragile OI Vaporization Ratio (V_flush)
        total_flushed = flow.forced_liquidation_volume
        denom_vaporization = total_flushed + pending_fragile_oi
        if denom_vaporization > self.MIN_FORCED_VOL_FLOOR:
            vaporization_ratio = _clamp(total_flushed / denom_vaporization, 0.0, 1.0)
        else:
            # Quiet tape: nothing flushed AND nothing pending -> treat as fully
            # vaporized, but flag it in metadata so downstream gates know this
            # is "no cascade data", not "confirmed exhaustion".
            vaporization_ratio = 1.0

        # 5. Bonding Inertia Delta (Delta_inertia) — v2 FIX
        #    absorption_ratio is now normalized against TOTAL taker volume,
        #    not forced volume. A quiet tape (forced_vol ~ 0) can no longer
        #    fabricate an infinite absorption ratio.
        total_taker = (flow.discretionary_taker_buy_volume
                       + flow.discretionary_taker_sell_volume)
        if total_taker > 0.0 and total_flushed > self.MIN_FORCED_VOL_FLOOR:
            # Buy-side share of flow, scaled by how much of it is absorbing
            # forced selling rather than just two-sided churn.
            buy_share = flow.discretionary_taker_buy_volume / total_taker  # [0, 1]
            absorption_ratio = _clamp(
                buy_share * (total_taker / (total_flushed + total_taker)) * 2.0,
                0.0, self.ABSORPTION_RATIO_CAP,
            )
        else:
            absorption_ratio = 0.0  # no forced flow to absorb -> neutral, not +inf

        # Velocity divergence — v2 FIX: clamped, zero-velocity handled explicitly
        if abs(flow.oracle_price_velocity) < 1e-9:
            if abs(flow.amm_price_velocity) < 1e-9:
                velocity_divergence = 0.0        # both flat: no divergence
            else:
                velocity_divergence = self.VELOCITY_DIVERGENCE_CAP * (
                    1.0 if flow.amm_price_velocity > 0 else -1.0
                )                                 # AMM moving, oracle flat: cap it
        else:
            velocity_divergence = _clamp(
                flow.amm_price_velocity / flow.oracle_price_velocity,
                -self.VELOCITY_DIVERGENCE_CAP, self.VELOCITY_DIVERGENCE_CAP,
            )

        bonding_inertia_delta = _clamp(
            velocity_divergence + (absorption_ratio * 0.5),
            -self.VELOCITY_DIVERGENCE_CAP - 2.5,
            self.VELOCITY_DIVERGENCE_CAP + 2.5,
        )

        # 6. Venue skew adjustment (v2)
        venue_skew_adjustment = self.compute_venue_skew_adjustment(venue_skew)

        # 7. Cascade Coherence Index (Phi_cascade)
        coherence_arg = (
            self.w_v * (vaporization_ratio - self.theta_v)
            - self.w_rho * (wall_density - self.theta_rho)
            + self.w_i * (bonding_inertia_delta - 1.0)
            + self.w_s * venue_skew_adjustment
        )
        cascade_coherence = _clamp(math.tanh(coherence_arg), -1.0, 1.0)

        # 8. Classification and tactical action
        #    v2: exhaustion verdict now REQUIRES positive absorption evidence,
        #    not merely an absence of liquidations. Quiet tape != confirmed
        #    exhaustion.
        exhaustion_confirmed = (
            cascade_coherence >= 0.35
            and wall_density < self.theta_rho
            and absorption_ratio > 0.10   # real buy-side evidence required
        )
        if exhaustion_confirmed:
            verdict = "FLUSH_EXHAUSTED_ABSORPTION_DETECTED"
            action = "PREPARE_REVERSION_BUY"
        elif cascade_coherence <= -0.45 or wall_density > 1.2:
            verdict = "VOID_SLIP_ACTIVE"
            action = "STAND_ASIDE_OR_HEDGE"
        else:
            verdict = "CASCADE_UNRESOLVED"
            action = "HOLD_FLAT_OBSERVE"

        # Final finiteness guard — never emit a non-finite packet
        outputs = {
            "vaporization_ratio": vaporization_ratio,
            "sub_orbital_wall_density": wall_density,
            "bonding_inertia_delta": bonding_inertia_delta,
            "venue_skew_adjustment": venue_skew_adjustment,
            "cascade_coherence_index": cascade_coherence,
        }
        for name, val in outputs.items():
            if math.isnan(val) or math.isinf(val):
                raise CascadeComputationError(f"{name} computed non-finite: {val}")

        return CascadeTelemetryPacket(
            timestamp_ms=now_ms,
            symbol=symbol.upper(),
            spot_price=spot_price,
            vaporization_ratio=round(vaporization_ratio, 4),
            sub_orbital_wall_density=round(wall_density, 4),
            bonding_inertia_delta=round(bonding_inertia_delta, 4),
            venue_skew_adjustment=round(venue_skew_adjustment, 4),
            cascade_coherence_index=round(cascade_coherence, 4),
            verdict=verdict,
            recommended_action=action,
            metadata={
                "effective_pool_depth": round(effective_pool_depth, 2),
                "pending_fragile_oi": round(pending_fragile_oi, 2),
                "forced_volume_window": round(total_flushed, 2),
                "absorption_ratio": round(absorption_ratio, 4),
                "velocity_divergence": round(velocity_divergence, 4),
                "quiet_tape_flag": int(total_flushed <= self.MIN_FORCED_VOL_FLOOR),
                "skew_active": int(venue_skew.active) if venue_skew else 0,
            },
        )
