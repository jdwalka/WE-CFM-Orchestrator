#!/usr/bin/env python3
"""
WE|||CRYPTO — MergeKit Recipe Generator (Python)
Generates formal, reproducible MergeKit YAML configs for crypto foresight LLMs.
Supports: DELLA, SCE, Nearswap, Arcee Fusion, TIES, DARE-TIES, Multi-SLERP.
"""

import sys
import os
import argparse
import copy

try:
    import yaml
except ImportError:
    yaml = None

PRECONFIGURED_TEMPLATES = {
    "della": {
        "name": "DELLA Crypto Foresight",
        "merge_method": "della",
        "base_model": "models/crypto-base-foresight-8b",
        "dtype": "bfloat16",
        "models": [
            {"model": "models/crypto-orderbook-clob-8b", "parameters": {"weight": 0.45, "density": 0.75, "epsilon": 0.012}},
            {"model": "models/crypto-momentum-breakout-8b", "parameters": {"weight": 0.35, "density": 0.70, "epsilon": 0.015}},
            {"model": "models/crypto-kalshi-15m-sniper-8b", "parameters": {"weight": 0.55, "density": 0.80, "epsilon": 0.010}},
        ],
        "parameters": {"density": 0.75, "epsilon": 0.012, "normalize": True, "int8_mask": True, "lambda": 1.05},
        "metadata": {"target_horizons": ["5m", "15m"], "underlyings": ["BTC", "ETH", "SOL", "XRP"], "sniper_mode": "pre_open_lead_in"},
    },
    "sce": {
        "name": "SCE Variance-Weighted Fusion",
        "merge_method": "sce",
        "base_model": "models/crypto-base-foresight-8b",
        "dtype": "bfloat16",
        "models": [
            {"model": "models/crypto-tape-flow-8b", "parameters": {"weight": 0.40, "variance_penalty": 0.15}},
            {"model": "models/crypto-volatility-regime-8b", "parameters": {"weight": 0.35, "variance_penalty": 0.20}},
            {"model": "models/crypto-orderbook-clob-8b", "parameters": {"weight": 0.45, "variance_penalty": 0.10}},
        ],
        "parameters": {"variance_scale": 25.0, "consensus_threshold": 0.60, "erase_conflicts": True, "normalize": True},
        "metadata": {"target_horizons": ["5m", "15m"], "regime_filter": "volatile_breakout_and_chop"},
    },
    "nearswap": {
        "name": "Nearswap Specialist Interpolation",
        "merge_method": "nearswap",
        "base_model": "models/crypto-base-foresight-8b",
        "dtype": "bfloat16",
        "models": [
            {"model": "models/crypto-regime-ranging-8b", "parameters": {"weight": 0.50}},
            {"model": "models/crypto-regime-trending-8b", "parameters": {"weight": 0.50}},
        ],
        "parameters": {"tau": 0.65, "blend_factor": 0.50, "preserve_divergence": True, "normalize": True},
        "metadata": {"target_horizons": ["5m", "15m"], "regime_affinity": ["ranging", "trending_smooth", "trending_volatile"]},
    },
    "arcee_fusion": {
        "name": "Arcee Fusion Importance Routing",
        "merge_method": "arcee_fusion",
        "base_model": "models/crypto-base-foresight-8b",
        "dtype": "bfloat16",
        "models": [
            {"model": "models/crypto-macro-sentiment-8b", "parameters": {"weight": 0.50, "importance_metric": "relative_entropy"}},
            {"model": "models/crypto-pin-risk-defense-8b", "parameters": {"weight": 0.50, "importance_metric": "relative_entropy"}},
        ],
        "parameters": {"iqr_multiplier": 1.2, "quantile_low": 0.25, "quantile_high": 0.75, "min_kl_threshold": 0.005, "normalize": True},
        "metadata": {"target_horizons": ["5m", "15m"], "sniper_mode": "strike_pin_defense"},
    },
    "ties": {
        "name": "TIES Orderbook & Macro Consolidation",
        "merge_method": "ties",
        "base_model": "models/crypto-base-foresight-8b",
        "dtype": "bfloat16",
        "models": [
            {"model": "models/crypto-orderbook-clob-8b", "parameters": {"weight": 0.50, "density": 0.75}},
            {"model": "models/crypto-macro-sentiment-8b", "parameters": {"weight": 0.50, "density": 0.75}},
        ],
        "parameters": {"top_k": 0.75, "lambda": 1.00, "normalize": True, "sign_resolve": "majority_consensus"},
        "metadata": {"target_horizons": ["5m", "15m"], "consensus_mode": "disjoint_sign_elected"},
    },
    "dare_ties": {
        "name": "DARE-TIES Crypto 15M Sniper",
        "merge_method": "dare_ties",
        "base_model": "models/crypto-base-foresight-8b",
        "dtype": "bfloat16",
        "models": [
            {"model": "models/crypto-kalshi-15m-sniper-8b", "parameters": {"weight": 0.60, "density": 0.55}},
            {"model": "models/crypto-momentum-breakout-8b", "parameters": {"weight": 0.40, "density": 0.50}},
        ],
        "parameters": {"top_k": 0.60, "lambda": 1.10, "drop_rate": 0.45, "rescale": True, "normalize": True},
        "metadata": {"target_horizons": ["15m"], "horizon_sweet_spot": "3.0m_to_6.0m_remaining"},
    },
    "multi_slerp": {
        "name": "Multi-SLERP Barycentric Hypersphere",
        "merge_method": "multi_slerp",
        "base_model": "models/crypto-base-foresight-8b",
        "dtype": "bfloat16",
        "models": [
            {"model": "models/crypto-orderbook-clob-8b", "parameters": {"weight": 0.40}},
            {"model": "models/crypto-tape-flow-8b", "parameters": {"weight": 0.35}},
            {"model": "models/crypto-kalshi-15m-sniper-8b", "parameters": {"weight": 0.25}},
        ],
        "parameters": {"slerp_t": [0.40, 0.35, 0.25], "normalize": True, "interpolation": "geodesic_hypersphere"},
        "metadata": {"target_horizons": ["5m", "15m"], "geometric_curvature": "hyperspherical"},
    },
}


def validate_recipe(recipe: dict) -> tuple[bool, list[str]]:
    errors = []
    if not isinstance(recipe, dict):
        return False, ["Recipe must be a dictionary"]
    if not recipe.get("merge_method"):
        errors.append("Missing required field: merge_method")
    if not recipe.get("base_model"):
        errors.append("Missing required field: base_model")
    models = recipe.get("models")
    if not isinstance(models, list) or len(models) == 0:
        errors.append("Recipe must contain a non-empty models list")
    else:
        for idx, m in enumerate(models):
            if not isinstance(m, dict) or not m.get("model"):
                errors.append(f"Model at index {idx} missing 'model' path")
    return len(errors) == 0, errors


def build_recipe(method: str = "della", **overrides) -> dict:
    template = PRECONFIGURED_TEMPLATES.get(method)
    if template:
        recipe = copy.deepcopy(template)
    else:
        recipe = {
            "name": f"{method.upper()} Custom Recipe",
            "merge_method": method,
            "base_model": "models/crypto-base-foresight-8b",
            "dtype": "bfloat16",
            "models": [],
            "parameters": {},
        }
    if "base_model" in overrides:
        recipe["base_model"] = overrides["base_model"]
    if "models" in overrides:
        recipe["models"] = overrides["models"]
    if "parameters" in overrides:
        recipe["parameters"].update(overrides["parameters"])
    if "metadata" in overrides:
        recipe["metadata"].update(overrides["metadata"])
    return recipe


def to_yaml_string(recipe: dict) -> str:
    if yaml is not None:
        header = (
            f"# ================================================================\n"
            f"# MergeKit Recipe: {recipe.get('name', 'Crypto Foresight')}\n"
            f"# Generated by WeCrypto MergeKit Engine (G:\\WECRYP)\n"
            f"# Application: 5-minute & 15-minute crypto prediction contracts\n"
            f"# ================================================================\n\n"
        )
        return header + yaml.dump(recipe, sort_keys=False, indent=2)

    # Fallback simple formatter
    lines = [
        f"# MergeKit Recipe: {recipe.get('name', 'Crypto Foresight')}",
        f"merge_method: {recipe.get('merge_method')}",
        f"base_model: {recipe.get('base_model')}",
        f"dtype: {recipe.get('dtype', 'bfloat16')}\n",
        "models:",
    ]
    for m in recipe.get("models", []):
        lines.append(f"  - model: {m.get('model')}")
        if m.get("parameters"):
            lines.append("    parameters:")
            for k, v in m["parameters"].items():
                lines.append(f"      {k}: {v}")
    if recipe.get("parameters"):
        lines.append("\nparameters:")
        for k, v in recipe["parameters"].items():
            lines.append(f"  {k}: {v}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="WE|||CRYPTO MergeKit Recipe Generator (Python)")
    parser.add_argument("--template", "-t", choices=list(PRECONFIGURED_TEMPLATES.keys()), default="della", help="Recipe template")
    parser.add_argument("--output", "-o", help="Output file path (.yaml)")
    parser.add_argument("--list-templates", action="store_true", help="List available templates")
    parser.add_argument("--validate", help="Validate an existing YAML recipe")
    args = parser.parse_args()

    if args.list_templates:
        print("Available Preconfigured Templates:")
        for k, v in PRECONFIGURED_TEMPLATES.items():
            print(f"  - {k.ljust(14)} : {v['name']} ({len(v['models'])} models)")
        sys.exit(0)

    if args.validate:
        if yaml is None:
            print("PyYAML required for validation", file=sys.stderr)
            sys.exit(1)
        with open(args.validate, "r") as fp:
            data = yaml.safe_load(fp)
        valid, errors = validate_recipe(data)
        if valid:
            print(f"[OK] {args.validate} is a valid MergeKit configuration.")
            sys.exit(0)
        else:
            print(f"[FAIL] Errors in {args.validate}:", errors, file=sys.stderr)
            sys.exit(1)

    recipe = build_recipe(args.template)
    yaml_text = to_yaml_string(recipe)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as fp:
            fp.write(yaml_text)
        print(f"[OK] Recipe saved to {args.output}")
    else:
        print(yaml_text)


if __name__ == "__main__":
    main()
