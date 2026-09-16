"""Model introspection: exposes model weights (parameters) and decision trees.

Weights are imported directly from prediction_engine's module constants, so
/weights always reports the parameters the engine actually runs with — no
duplicated hand-typed table that can drift out of sync.

The decision tree mirrors the documented strategy in brain.py SYSTEM_PROMPT
(Sections 3-6): buy cheap out-of-range strikes on a directional-or-reversion
thesis, then exit into the live book on convergence toward par.
"""
import json
from typing import Any

import prediction_engine as engine
from prediction_engine import predict_hourly_range

# --- Documented strategy bounds (brain.py SYSTEM_PROMPT Sections 3-6) ------
ENTRY_WINDOW_MINUTES = (15, 20)       # T-20m to T-15m before contract expiry
CHEAP_ASK_CENTS_MAX = 20              # "single digits to ~20 cents"
CONVERGENCE_EXIT_CENTS = (95, 99)     # sell into the live book here
FINAL_WINDOW_NO_ENTRY_SECONDS = 90    # final window is elevated-risk


def get_model_weights() -> dict[str, Any]:
    """Live prediction plus the engine's actual parameter values."""
    prediction = predict_hourly_range()
    volatility = prediction.get("volatility", {}) if isinstance(prediction, dict) else {}
    return {
        "prediction": prediction,
        "parameters": {
            "lookback_hours": engine.LOOKBACK_HOURS,
            "live_volatility_hours": engine.LIVE_VOLATILITY_HOURS,
            "body_percentile": engine.BODY_PERCENTILE,
            "momentum_lookback_hours": engine.MOMENTUM_LOOKBACK_HOURS,
            "bias_threshold": engine.BIAS_THRESHOLD,
            "upper_range_factor": engine.UPPER_RANGE_FACTOR,
            "lower_range_factor": engine.LOWER_RANGE_FACTOR,
            "center_shift_factor": engine.CENTER_SHIFT_FACTOR,
            "drift_factor": engine.DRIFT_FACTOR,
            "min_range_pct": engine.MIN_RANGE_PCT,
            "high_regime_min_range_pct": engine.HIGH_REGIME_MIN_RANGE_PCT,
            "volatility_spike_percentile": engine.VOLATILITY_SPIKE_PERCENTILE,
            "probability_correction_max_factor": engine.PROBABILITY_CORRECTION_MAX_FACTOR,
            "divergence_adjustment_max_cents": engine.DIVERGENCE_ADJUSTMENT_MAX_CENTS,
            "artifact_residual_threshold_cents": engine.ARTIFACT_RESIDUAL_THRESHOLD_CENTS,
            "probability_model": (
                "Student-t fat-tail distribution with time-decayed sigma and "
                "momentum drift; normal model retained for comparison"
            ),
            "student_t_df": volatility.get("student_t_df"),
            "fit_sample_size": volatility.get("log_returns_sample_size"),
            "fit_status": volatility.get("fit_status"),
            "normal_fallback_active": volatility.get("normal_fallback_active"),
            "tail_adjustment_max_cents": engine.TAIL_ADJUSTMENT_MAX_CENTS,
            "tail_spike_component_max_cents": engine.TAIL_SPIKE_COMPONENT_MAX_CENTS,
            "tail_wick_component_max_cents": engine.TAIL_WICK_COMPONENT_MAX_CENTS,
            "wick_ratio_min_body_pct": engine.WICK_RATIO_MIN_BODY_PCT,
            "wick_ratio_max": engine.WICK_RATIO_MAX,
            "tail_spike_frequency_min": engine.TAIL_SPIKE_FREQUENCY_MIN,
            "tail_wick_slope_min": engine.TAIL_WICK_SLOPE_MIN,
            "tail_adjustment_requires_both_conditions": False,
            "alt_alignment_ratio_up": engine.ALT_ALIGNMENT_RATIO_UP,
            "alt_alignment_ratio_down": engine.ALT_ALIGNMENT_RATIO_DOWN,
            "alt_alignment_minutes": engine.ALT_ALIGNMENT_MINUTES,
            "alt_alignment_enabled": engine.ALT_ALIGNMENT_ENABLED,
        },
        "source": "prediction_engine.py module constants",
    }


def get_decision_trees() -> dict[str, Any]:
    """Entry/exit decision tree, mirroring brain.py SYSTEM_PROMPT Sections 3-6."""
    return {
        "entry_tree": {
            "root": "ENTER_RANGE?",
            "gates": [
                {
                    "id": "contract_type",
                    "condition": "standalone binary YES/NO range contract (not PTB)",
                    "on_fail": "SKIP",
                },
                {
                    "id": "entry_window",
                    "condition": "15 <= minutes_to_expiry <= 20",
                    "on_fail": "SKIP — outside the documented entry window",
                },
                {
                    "id": "out_of_range",
                    "condition": "spot currently OUTSIDE [band_low, band_high]",
                    "on_fail": "SKIP — band already contains spot; not this strategy's edge",
                },
                {
                    "id": "cheap_ask",
                    "condition": "yes_ask_cents <= 20",
                    "on_fail": "SKIP — contract not cheap enough",
                },
                {
                    "id": "thesis",
                    "condition": "directional-or-reversion thesis from momentum/order-flow",
                    "on_fail": "SKIP — no thesis; never buy on price alone",
                },
                {
                    "id": "reachable",
                    "condition": "band reachable by ordinary volatility in remaining window",
                    "on_fail": "SKIP — needs a tail event; 'cheap AND reachable' beats 'cheapest'",
                },
            ],
            "action_on_all_pass": "ENTER_RANGE — buy the cheap out-of-range strike",
            "side_selection": {
                "continuation_up": "nearest qualifying band ABOVE spot",
                "continuation_down": "nearest qualifying band BELOW spot",
                "reversal": "band on the side price is reverting toward",
            },
            "band_preference": (
                "toward the center of the plausible outcome distribution "
                "(~middle of the last 30m realized range), not the most extreme band"
            ),
        },
        "exit_tree": {
            "root": "has_position?",
            "branches": [
                {
                    "condition": "spot inside band AND reversal unlikely AND yes_price >= 95",
                    "action": "EXIT_EARLY — sell into the live book",
                },
                {
                    "condition": "no reasonable bid to exit into",
                    "action": "HOLD to literal settlement",
                },
                {
                    "condition": "otherwise",
                    "action": "HOLD",
                },
            ],
        },
        "settlement": {
            "KALSHI": {
                "oracle": "CF Benchmarks BRTI (multi-exchange composite)",
                "window_seconds": 60,
                "method": "simple average of 1-per-second reads over the final 60s",
                "single_wick_can_settle": False,
                "single_one_second_wick_can_settle": False,
                "sustained_push_through_final_minute_can_settle": True,
                "note": "one violent 1-second print cannot move the 60-read average much; a sustained push through most of the final minute can",
            },
            "POLYMARKET": {
                "oracle": "Chainlink TWAP",
                "window_seconds": None,
                "method": "time-weighted average over a short pre-expiry window",
                "single_wick_can_settle": False,
                "note": "exact window (30s or 60s) UNCONFIRMED; read off live market rules",
            },
            "COINBASE": "BRTI average (same CF Benchmarks composite Kalshi uses)",
        },
        "no_new_entry_guard": {
            "condition": "within final ~90 seconds before settlement timestamp",
            "action": "suppress new entries",
        },
    }


def get_weights_endpoint() -> dict[str, Any]:
    """REST endpoint handler for /weights."""
    return get_model_weights()


def get_trees_endpoint() -> dict[str, Any]:
    """REST endpoint handler for /trees."""
    return get_decision_trees()


def format_for_llm(data: dict[str, Any]) -> str:
    """Format introspection data as readable text for LLM context."""
    return json.dumps(data, indent=2, default=str)
