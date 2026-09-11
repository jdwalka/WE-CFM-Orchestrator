"""Model introspection: exposes model weights (parameters) and decision trees.

Weights are imported directly from prediction_engine's module constants, so
/weights always reports the parameters the engine actually runs with — no
duplicated hand-typed table that can drift out of sync.

The decision tree mirrors the documented strategy in brain.py SYSTEM_PROMPT
(Sections 3-6): buy cheap out-of-range strikes on a directional-or-reversion
thesis, then exit into the live book on convergence toward par.
"""
import json
from typing import Any, Dict

import prediction_engine as engine
from prediction_engine import predict_hourly_range

# --- Documented strategy bounds (brain.py SYSTEM_PROMPT Sections 3-6) ------
ENTRY_WINDOW_MINUTES = (15, 20)       # T-20m to T-15m before contract expiry
CHEAP_ASK_CENTS_MAX = 20              # "single digits to ~20 cents"
CONVERGENCE_EXIT_CENTS = (95, 99)     # sell into the live book here
FINAL_WINDOW_NO_ENTRY_SECONDS = 90    # final window is elevated-risk


def get_model_weights() -> Dict[str, Any]:
    """Live prediction plus the engine's actual parameter values."""
    prediction = predict_hourly_range()
    return {
        "prediction": prediction,
        "parameters": {
            "lookback_hours": engine.LOOKBACK_HOURS,
            "body_percentile": engine.BODY_PERCENTILE,
            "momentum_lookback_hours": engine.MOMENTUM_LOOKBACK_HOURS,
            "bias_threshold": engine.BIAS_THRESHOLD,
            "upper_range_factor": engine.UPPER_RANGE_FACTOR,
            "lower_range_factor": engine.LOWER_RANGE_FACTOR,
            "center_shift_factor": engine.CENTER_SHIFT_FACTOR,
            "drift_factor": engine.DRIFT_FACTOR,
            "min_range_pct": engine.MIN_RANGE_PCT,
            "probability_model": "normal approximation, time-decayed sigma, momentum drift",
        },
        "source": "prediction_engine.py module constants",
    }


def get_decision_trees() -> Dict[str, Any]:
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


def get_weights_endpoint() -> Dict[str, Any]:
    """REST endpoint handler for /weights."""
    return get_model_weights()


def get_trees_endpoint() -> Dict[str, Any]:
    """REST endpoint handler for /trees."""
    return get_decision_trees()


def format_for_llm(data: Dict[str, Any]) -> str:
    """Format introspection data as readable text for LLM context."""
    return json.dumps(data, indent=2, default=str)
