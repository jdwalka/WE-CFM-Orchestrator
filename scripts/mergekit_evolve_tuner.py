#!/usr/bin/env python3
"""
WE|||CRYPTO — MergeKit Evolutionary Weight & Hyperparameter Tuner
Optimizes model merge methods, hyperparameters, and feature weights
against historical accuracy and Brier score for 5m & 15m crypto contracts.
"""

import os
import sys
import math
import random
import json
import copy
import argparse
from typing import Dict, List, Tuple, Any

try:
    import yaml
except ImportError:
    yaml = None

# Baseline indicator keys used across WeCrypto
INDICATOR_KEYS = [
    "ema", "hma", "vwap", "obv", "bands", "williamsR", "momentum",
    "volume", "flow", "book", "macd", "rsi", "stochrsi", "cci",
    "fearGreed", "imbalanceVelocity", "tradeFlow", "toxicity", "spoof", "iceberg"
]

BASE_WEIGHTS = {
    "book": 0.22,
    "flow": 0.20,
    "momentum": 0.12,
    "volume": 0.08,
    "ema": 0.06,
    "hma": 0.05,
    "vwap": 0.05,
    "macd": 0.05,
    "rsi": 0.04,
    "obv": 0.03,
    "bands": 0.03,
    "williamsR": 0.02,
    "stochrsi": 0.02,
    "cci": 0.01,
    "fearGreed": 0.01,
    "imbalanceVelocity": 0.005,
    "tradeFlow": 0.005,
    "toxicity": 0.002,
    "spoof": 0.002,
    "iceberg": 0.002,
}

REGIME_WEIGHT_MULTS = {
    "trending_smooth": {"ema": 1.5, "hma": 1.4, "vwap": 1.3, "obv": 1.2, "bands": 0.7, "williamsR": 0.7, "momentum": 0.5},
    "trending_volatile": {"volume": 1.5, "flow": 1.4, "book": 1.3, "macd": 1.2, "ema": 1.1, "bands": 0.8, "momentum": 2.0},
    "ranging": {"bands": 1.6, "williamsR": 1.5, "cci": 1.4, "rsi": 1.3, "stochrsi": 1.3, "ema": 0.7, "hma": 0.6, "momentum": 0.1},
    "choppy": {"book": 0.4, "flow": 0.4, "macd": 0.5, "ema": 0.6, "bands": 0.6, "momentum": 0.3},
    "neutral": {},
}

MERGE_METHODS = ["della", "sce", "nearswap", "arcee_fusion", "ties", "slerp"]


def clamp(val: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(max_val, val))


def normalize_l1(weights: Dict[str, float]) -> Dict[str, float]:
    total = sum(abs(v) for v in weights.values())
    if total <= 0:
        count = len(weights) or 1
        return {k: 1.0 / count for k in weights}
    return {k: max(0.0, v / total) for k, v in weights.items()}


def vector_magnitude(v: Dict[str, float]) -> float:
    return math.sqrt(sum(val * val for val in v.values())) or 1e-8


def dot_product(v1: Dict[str, float], v2: Dict[str, float]) -> float:
    return sum(v1.get(k, 0.0) * v2.get(k, 0.0) for k in v1)


def slerp(v0: Dict[str, float], v1: Dict[str, float], t: float = 0.5) -> Dict[str, float]:
    keys = list(set(v0.keys()).union(v1.keys()))
    mag0 = vector_magnitude(v0)
    mag1 = vector_magnitude(v1)

    u0 = {k: v0.get(k, 0.0) / mag0 for k in keys}
    u1 = {k: v1.get(k, 0.0) / mag1 for k in keys}

    dot = clamp(dot_product(u0, u1), -1.0, 1.0)
    if abs(dot) > 0.9995:
        out = {k: (1.0 - t) * v0.get(k, 0.0) + t * v1.get(k, 0.0) for k in keys}
        return normalize_l1(out)

    theta = math.acos(dot)
    sin_theta = math.sin(theta)
    scale0 = math.sin((1.0 - t) * theta) / sin_theta
    scale1 = math.sin(t * theta) / sin_theta
    interp_mag = (1.0 - t) * mag0 + t * mag1

    out = {k: max(0.0, (scale0 * u0[k] + scale1 * u1[k]) * interp_mag) for k in keys}
    return normalize_l1(out)


def della_merge(base_weights: Dict[str, float], target_weights: Dict[str, float], density: float = 0.75, epsilon: float = 0.01) -> Dict[str, float]:
    keys = list(set(base_weights.keys()).union(target_weights.keys()))
    deltas = {k: target_weights.get(k, 0.0) - base_weights.get(k, 0.0) for k in keys}
    max_abs_delta = max([abs(d) for d in deltas.values()] + [1e-8])

    merged_deltas = {}
    for k in keys:
        d = deltas[k]
        abs_d = abs(d)
        mag_score = clamp((abs_d - epsilon) / max_abs_delta, 0.0, 1.0)
        p_keep = clamp(density * 0.5 + mag_score * 0.5, 0.1, 1.0)
        if p_keep >= 0.5 or abs_d >= max_abs_delta * 0.75:
            merged_deltas[k] = d / max(0.1, p_keep)
        else:
            merged_deltas[k] = 0.0

    out = {k: max(0.001, base_weights.get(k, 0.0) + merged_deltas.get(k, 0.0)) for k in keys}
    return normalize_l1(out)


def sce_merge(base_weights: Dict[str, float], candidate_models: List[Dict[str, float]], variance_scale: float = 25.0) -> Dict[str, float]:
    if not candidate_models:
        return dict(base_weights)
    keys = list(set(base_weights.keys()).union(*[m.keys() for m in candidate_models]))
    out = {}
    for k in keys:
        values = [m.get(k, base_weights.get(k, 0.0)) for m in candidate_models]
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        stability = 1.0 / (1.0 + variance * variance_scale)
        base_val = base_weights.get(k, 0.0)
        out[k] = max(0.005, mean * stability + base_val * (1.0 - stability))
    return normalize_l1(out)


def nearswap(base_weights: Dict[str, float], target_weights: Dict[str, float], tau: float = 0.65) -> Dict[str, float]:
    keys = list(set(base_weights.keys()).union(target_weights.keys()))
    out = {}
    for k in keys:
        w0 = base_weights.get(k, 0.0)
        w1 = target_weights.get(k, 0.0)
        denom = max(1e-6, abs(w0) + abs(w1))
        local_sim = 1.0 - abs(w0 - w1) / denom
        if local_sim >= tau:
            out[k] = 0.5 * w0 + 0.5 * w1
        else:
            out[k] = w0
    return normalize_l1(out)


def arcee_fusion(base_weights: Dict[str, float], target_weights: Dict[str, float], iqr_mult: float = 1.2) -> Dict[str, float]:
    keys = list(set(base_weights.keys()).union(target_weights.keys()))
    norm_base = normalize_l1(base_weights)
    norm_target = normalize_l1(target_weights)

    scores = []
    score_map = {}
    for k in keys:
        p = max(1e-5, norm_target.get(k, 1e-5))
        q = max(1e-5, norm_base.get(k, 1e-5))
        kl = abs(p * math.log(p / q)) + abs(p - q)
        score_map[k] = kl
        scores.append(kl)

    scores.sort()
    n = len(scores)
    q1 = scores[int(n * 0.25)] if n > 0 else 0
    median = scores[int(n * 0.50)] if n > 0 else 0
    q3 = scores[int(n * 0.75)] if n > 0 else 0
    iqr = q3 - q1
    threshold = median + iqr_mult * iqr

    out = {}
    for k in keys:
        if score_map.get(k, 0.0) >= threshold:
            out[k] = target_weights.get(k, base_weights.get(k, 0.0))
        else:
            out[k] = base_weights.get(k, 0.0)
    return normalize_l1(out)


def ties_merge(base_weights: Dict[str, float], delta_vectors: List[Dict[str, float]], top_k: float = 0.75, lmbda: float = 1.0) -> Dict[str, float]:
    if not delta_vectors:
        return dict(base_weights)
    keys = list(base_weights.keys())

    # 1. Trim smallest deltas per vector
    trimmed = []
    for vec in delta_vectors:
        items = sorted(vec.items(), key=lambda x: abs(x[1]), reverse=True)
        keep_count = max(1, int(len(items) * top_k))
        kept_keys = set(k for k, _ in items[:keep_count])
        trimmed.append({k: vec.get(k, 0.0) if k in kept_keys else 0.0 for k in keys})

    # 2. Elect signs
    elected_sign = {}
    for k in keys:
        s = sum(v.get(k, 0.0) for v in trimmed)
        elected_sign[k] = 1 if s > 0 else (-1 if s < 0 else 0)

    # 3. Disjoint merge
    merged_deltas = {}
    for k in keys:
        ts = elected_sign[k]
        if ts == 0:
            merged_deltas[k] = 0.0
            continue
        agreeing = [v.get(k, 0.0) for v in trimmed if (v.get(k, 0.0) > 0 and ts > 0) or (v.get(k, 0.0) < 0 and ts < 0)]
        merged_deltas[k] = (sum(agreeing) / len(agreeing)) * lmbda if agreeing else 0.0

    out = {k: max(0.01, base_weights.get(k, 0.0) + merged_deltas.get(k, 0.0)) for k in keys}
    return normalize_l1(out)


def lookahead_trajectory(current_prob_up: float, tape_velocity: Dict[str, float], book_imbalance: Dict[str, float], minutes_remaining: float, deadband: float = 0.015) -> Dict[str, Any]:
    vel = tape_velocity.get("velocity", 0.0)
    accel = tape_velocity.get("acceleration", 0.0)
    imb_ratio = book_imbalance.get("ratio", 0.5)

    decay_factor = clamp(minutes_remaining / 15.0, 0.15, 1.0)
    flow_bias = (imb_ratio - 0.5) * 0.30
    mom_bias = (vel * 0.6 + accel * 0.4) * 0.25

    # Deadband suppression
    deadband_engaged = False
    if abs(flow_bias) < deadband:
        flow_bias = 0.0
        deadband_engaged = True
    if abs(mom_bias) < deadband:
        mom_bias = 0.0
        deadband_engaged = True

    t1 = clamp(current_prob_up + (flow_bias * 0.7 + mom_bias * 0.3) * (1.0 / decay_factor), 0.05, 0.95)
    t2 = clamp(current_prob_up + (flow_bias * 0.4 + mom_bias * 0.6), 0.05, 0.95)
    t_exp = clamp(current_prob_up + (flow_bias * 0.2 + mom_bias * 0.8) * decay_factor, 0.02, 0.98)

    return {
        "t1": round(t1, 3),
        "t2": round(t2, 3),
        "t_exp": round(t_exp, 3),
        "deadband_engaged": deadband_engaged,
    }


def generate_synthetic_historical_dataset(num_samples: int = 200, horizon: int = 15) -> List[Dict[str, Any]]:
    """
    Generates a realistic benchmark of historical 5m / 15m crypto contract scenarios
    spanning trending, ranging, and choppy regimes.
    """
    random.seed(42)
    regimes = ["trending_smooth", "trending_volatile", "ranging", "choppy", "neutral"]
    coins = ["BTC", "ETH", "SOL", "XRP"]
    samples = []

    for i in range(num_samples):
        regime = random.choice(regimes)
        coin = random.choice(coins)
        mins_remaining = round(random.uniform(1.0, 14.5), 1)

        # Generate realistic signal vector
        true_bias = random.choice([-1, 1]) * random.uniform(0.1, 0.8)
        signal_vec = {}
        for k in INDICATOR_KEYS:
            noise = random.gauss(0, 0.3)
            signal_vec[k] = clamp(true_bias + noise, -1.0, 1.0)

        vel = clamp(true_bias * 0.5 + random.gauss(0, 0.2), -1.0, 1.0)
        accel = clamp(vel * 0.4 + random.gauss(0, 0.1), -1.0, 1.0)
        ratio = clamp(0.5 + true_bias * 0.2 + random.gauss(0, 0.08), 0.1, 0.9)

        # Underlying moves with true_bias + random shock
        final_move = true_bias * 15.0 + random.gauss(0, 6.0)
        actual_outcome = 1 if final_move > 0 else 0

        samples.append({
            "id": f"rec_{i:04d}",
            "coin": coin,
            "horizon": horizon,
            "regime": regime,
            "signals": signal_vec,
            "tape_velocity": {"velocity": vel, "acceleration": accel},
            "book_imbalance": {"ratio": ratio},
            "minutes_remaining": mins_remaining,
            "actual_outcome": actual_outcome,
            "price_change_bps": round(final_move, 2),
        })

    return samples


class Genome:
    """
    Candidate individual for evolutionary tuning
    """
    def __init__(self, method: str = "della"):
        self.method = method
        self.slerp_t = random.uniform(0.2, 0.8)
        self.density = random.uniform(0.5, 0.95)
        self.epsilon = random.uniform(0.005, 0.04)
        self.tau = random.uniform(0.45, 0.80)
        self.variance_scale = random.uniform(10.0, 45.0)
        self.deadband = random.uniform(0.008, 0.030)
        self.iqr_mult = random.uniform(0.9, 1.8)
        self.top_k = random.uniform(0.5, 0.9)
        self.lmbda = random.uniform(0.7, 1.3)

        # Multiplier adjustments per indicator [0.5, 2.0]
        self.weights_mult = {k: random.uniform(0.6, 1.6) for k in INDICATOR_KEYS}

        self.fitness = 0.0
        self.brier_score = 1.0
        self.accuracy = 0.0
        self.ece = 1.0

    def mutate(self, rate: float = 0.20):
        if random.random() < 0.15:
            self.method = random.choice(MERGE_METHODS)
        if random.random() < rate:
            self.slerp_t = clamp(self.slerp_t + random.gauss(0, 0.08), 0.1, 0.9)
        if random.random() < rate:
            self.density = clamp(self.density + random.gauss(0, 0.06), 0.3, 0.98)
        if random.random() < rate:
            self.epsilon = clamp(self.epsilon + random.gauss(0, 0.005), 0.002, 0.05)
        if random.random() < rate:
            self.tau = clamp(self.tau + random.gauss(0, 0.05), 0.35, 0.90)
        if random.random() < rate:
            self.variance_scale = clamp(self.variance_scale + random.gauss(0, 4.0), 5.0, 60.0)
        if random.random() < rate:
            self.deadband = clamp(self.deadband + random.gauss(0, 0.004), 0.005, 0.045)
        if random.random() < rate:
            self.iqr_mult = clamp(self.iqr_mult + random.gauss(0, 0.12), 0.7, 2.5)

        for k in self.weights_mult:
            if random.random() < rate:
                self.weights_mult[k] = clamp(self.weights_mult[k] + random.gauss(0, 0.15), 0.2, 3.0)

    @classmethod
    def crossover(cls, parent1: "Genome", parent2: "Genome") -> "Genome":
        child = cls(method=random.choice([parent1.method, parent2.method]))
        alpha = random.random()

        child.slerp_t = clamp(alpha * parent1.slerp_t + (1 - alpha) * parent2.slerp_t, 0.1, 0.9)
        child.density = clamp(alpha * parent1.density + (1 - alpha) * parent2.density, 0.3, 0.98)
        child.epsilon = clamp(alpha * parent1.epsilon + (1 - alpha) * parent2.epsilon, 0.002, 0.05)
        child.tau = clamp(alpha * parent1.tau + (1 - alpha) * parent2.tau, 0.35, 0.90)
        child.variance_scale = clamp(alpha * parent1.variance_scale + (1 - alpha) * parent2.variance_scale, 5.0, 60.0)
        child.deadband = clamp(alpha * parent1.deadband + (1 - alpha) * parent2.deadband, 0.005, 0.045)
        child.iqr_mult = clamp(alpha * parent1.iqr_mult + (1 - alpha) * parent2.iqr_mult, 0.7, 2.5)

        for k in child.weights_mult:
            p_val = parent1.weights_mult[k] if random.random() < 0.5 else parent2.weights_mult[k]
            child.weights_mult[k] = p_val
        return child


def evaluate_individual(individual: Genome, dataset: List[Dict[str, Any]]) -> Tuple[float, float, float, float]:
    """
    Evaluates individual on dataset and computes Brier score, accuracy, ECE, and composite fitness.
    """
    # 1. Calculate raw indicator weights
    raw_weights = {}
    for k, base_w in BASE_WEIGHTS.items():
        mult = individual.weights_mult.get(k, 1.0)
        raw_weights[k] = base_w * mult
    base_normalized = normalize_l1(raw_weights)

    sq_errors = []
    correct_count = 0
    predictions = []
    actuals = []

    for sample in dataset:
        regime = sample.get("regime", "neutral")
        regime_mults = REGIME_WEIGHT_MULTS.get(regime, {})

        # Build target vector for regime
        regime_target = {k: base_normalized[k] * regime_mults.get(k, 1.0) for k in base_normalized}
        regime_target = normalize_l1(regime_target)

        # Merge according to individual method
        method = individual.method
        if method == "della":
            slerped = slerp(base_normalized, regime_target, individual.slerp_t)
            effective = della_merge(base_normalized, slerped, density=individual.density, epsilon=individual.epsilon)
        elif method == "sce":
            effective = sce_merge(base_normalized, [regime_target], variance_scale=individual.variance_scale)
        elif method == "nearswap":
            effective = nearswap(base_normalized, regime_target, tau=individual.tau)
        elif method == "arcee_fusion":
            effective = arcee_fusion(base_normalized, regime_target, iqr_mult=individual.iqr_mult)
        elif method == "ties":
            diff = {k: regime_target[k] - base_normalized[k] for k in base_normalized}
            effective = ties_merge(base_normalized, [diff], top_k=individual.top_k, lmbda=individual.lmbda)
        else:
            effective = slerp(base_normalized, regime_target, individual.slerp_t)

        # Weighted composite score
        sig_map = sample.get("signals", {})
        total_w = sum(effective.get(k, 0.0) for k in sig_map) or 1.0
        raw_score = sum(sig_map[k] * effective.get(k, 0.0) for k in sig_map) / total_w
        # Convert [-1, 1] to prob [0.05, 0.95]
        prob_up = clamp(0.5 + raw_score * 0.45, 0.05, 0.95)

        # Lookahead trajectory projection
        traj = lookahead_trajectory(
            current_prob_up=prob_up,
            tape_velocity=sample.get("tape_velocity", {}),
            book_imbalance=sample.get("book_imbalance", {}),
            minutes_remaining=sample.get("minutes_remaining", 15.0),
            deadband=individual.deadband,
        )

        p_forecast = traj["t_exp"]
        actual = sample.get("actual_outcome", 0)

        # Brier score calculation: (p - y)^2
        sq_errors.append((p_forecast - actual) ** 2)
        pred_dir = 1 if p_forecast >= 0.50 else 0
        if pred_dir == actual:
            correct_count += 1

        predictions.append(p_forecast)
        actuals.append(actual)

    n = len(dataset) or 1
    brier = sum(sq_errors) / n
    acc = (correct_count / n) * 100.0

    # Expected Calibration Error (ECE) over 5 bins
    ece = 0.0
    bins = [[] for _ in range(5)]
    for p, y in zip(predictions, actuals):
        bin_idx = min(4, int(p * 5))
        bins[bin_idx].append((p, y))
    for b in bins:
        if b:
            avg_p = sum(p for p, _ in b) / len(b)
            avg_y = sum(y for _, y in b) / len(b)
            ece += (len(b) / n) * abs(avg_p - avg_y)

    # Composite Fitness: Lower Brier is better, Higher Accuracy is better, Lower ECE is better
    fitness = 100.0 * (1.0 - brier) * 0.45 + acc * 0.45 + 100.0 * (1.0 - ece) * 0.10

    return fitness, brier, acc, ece


def run_evolutionary_optimization(
    dataset: List[Dict[str, Any]],
    generations: int = 25,
    pop_size: int = 30,
    elite_count: int = 3,
    mutation_rate: float = 0.20,
    preferred_method: str = None,
) -> Genome:
    """
    Executes evolutionary optimization loop over candidate merge configurations.
    """
    print(f"[*] Initializing Population: size={pop_size}, generations={generations}, dataset_samples={len(dataset)}")

    population: List[Genome] = []
    for _ in range(pop_size):
        method = preferred_method if preferred_method else random.choice(MERGE_METHODS)
        g = Genome(method=method)
        population.append(g)

    best_ever: Genome = None

    for gen in range(1, generations + 1):
        for ind in population:
            ind.fitness, ind.brier_score, ind.accuracy, ind.ece = evaluate_individual(ind, dataset)

        population.sort(key=lambda x: x.fitness, reverse=True)
        current_best = population[0]

        if best_ever is None or current_best.fitness > best_ever.fitness:
            best_ever = copy.deepcopy(current_best)

        avg_fitness = sum(x.fitness for x in population) / len(population)
        avg_brier = sum(x.brier_score for x in population) / len(population)

        if gen == 1 or gen % 5 == 0 or gen == generations:
            print(
                f"[Gen {gen:02d}/{generations:02d}] "
                f"Best Fit={current_best.fitness:.2f} (Acc={current_best.accuracy:.1f}%, Brier={current_best.brier_score:.4f}, ECE={current_best.ece:.3f}) | "
                f"Avg Fit={avg_fitness:.2f} | Method={current_best.method.upper()}"
            )

        # Elitism: retain top individuals
        new_population = [copy.deepcopy(x) for x in population[:elite_count]]

        # Selection & reproduction
        while len(new_population) < pop_size:
            # Tournament selection
            t1 = random.sample(population, 3)
            p1 = max(t1, key=lambda x: x.fitness)
            t2 = random.sample(population, 3)
            p2 = max(t2, key=lambda x: x.fitness)

            child = Genome.crossover(p1, p2)
            child.mutate(rate=mutation_rate)
            if preferred_method:
                child.method = preferred_method
            new_population.append(child)

        population = new_population

    return best_ever


def export_results(best: Genome, output_json: str, output_yaml: str):
    """
    Exports optimized weights and MergeKit recipe to disk.
    """
    optimized_weights = {}
    for k, base_w in BASE_WEIGHTS.items():
        mult = best.weights_mult.get(k, 1.0)
        optimized_weights[k] = round(base_w * mult, 5)
    normalized_weights = normalize_l1(optimized_weights)
    for k in normalized_weights:
        normalized_weights[k] = round(normalized_weights[k], 4)

    profile = {
        "generator": "WeCrypto MergeKit Evolutionary Tuner",
        "method": best.method,
        "fitness": round(best.fitness, 3),
        "brier_score": round(best.brier_score, 4),
        "accuracy_pct": round(best.accuracy, 2),
        "ece": round(best.ece, 4),
        "hyperparameters": {
            "slerp_t": round(best.slerp_t, 3),
            "density": round(best.density, 3),
            "epsilon": round(best.epsilon, 4),
            "tau": round(best.tau, 3),
            "variance_scale": round(best.variance_scale, 2),
            "deadband": round(best.deadband, 4),
            "iqr_multiplier": round(best.iqr_mult, 3),
            "top_k": round(best.top_k, 3),
            "lambda": round(best.lmbda, 3),
        },
        "optimized_indicator_weights": normalized_weights,
    }

    if output_json:
        os.makedirs(os.path.dirname(os.path.abspath(output_json)), exist_ok=True)
        with open(output_json, "w", encoding="utf-8") as fp:
            json.dump(profile, fp, indent=2)
        print(f"[OK] Saved optimized profile to {output_json}")

    if output_yaml:
        os.makedirs(os.path.dirname(os.path.abspath(output_yaml)), exist_ok=True)
        # Construct YAML recipe
        recipe_dict = {
            "name": f"Evolved {best.method.upper()} Crypto Spec",
            "merge_method": best.method,
            "base_model": "models/crypto-base-foresight-8b",
            "dtype": "bfloat16",
            "models": [
                {"model": "models/crypto-orderbook-specialist-8b", "parameters": {"weight": normalized_weights.get("book", 0.3), "density": round(best.density, 3)}},
                {"model": "models/crypto-flow-specialist-8b", "parameters": {"weight": normalized_weights.get("flow", 0.25), "density": round(best.density, 3)}},
                {"model": "models/crypto-momentum-specialist-8b", "parameters": {"weight": normalized_weights.get("momentum", 0.2), "density": round(best.density, 3)}},
            ],
            "parameters": {
                "density": round(best.density, 3),
                "epsilon": round(best.epsilon, 4),
                "tau": round(best.tau, 3),
                "deadband": round(best.deadband, 4),
                "normalize": True,
            },
            "metadata": {
                "brier_score": round(best.brier_score, 4),
                "accuracy_pct": round(best.accuracy, 2),
                "target_horizons": ["5m", "15m"],
                "evolution_optimized": True,
            },
        }
        if yaml:
            header = "# Generated by WeCrypto MergeKit Evolutionary Tuner\n"
            content = header + yaml.dump(recipe_dict, sort_keys=False, indent=2)
        else:
            content = f"# Generated by WeCrypto MergeKit Evolutionary Tuner\nmerge_method: {best.method}\nbase_model: models/crypto-base-foresight-8b\n"
        with open(output_yaml, "w", encoding="utf-8") as fp:
            fp.write(content)
        print(f"[OK] Saved MergeKit YAML recipe to {output_yaml}")


def main():
    parser = argparse.ArgumentParser(description="WE|||CRYPTO MergeKit Evolutionary Weight Tuner")
    parser.add_argument("--generations", "-g", type=int, default=20, help="Number of evolution generations")
    parser.add_argument("--pop-size", "-p", type=int, default=25, help="Population size")
    parser.add_argument("--horizon", type=int, choices=[5, 15], default=15, help="Target horizon (5 or 15 mins)")
    parser.add_argument("--method", "-m", choices=MERGE_METHODS, help="Constrain to specific merge method")
    parser.add_argument("--dataset", "-d", help="Path to historical evaluation JSON dataset")
    parser.add_argument("--samples", type=int, default=250, help="Synthetic sample count if no dataset provided")
    parser.add_argument("--output-json", default="configs/mergekit/evolved_weights_latest.json", help="Path for JSON output")
    parser.add_argument("--output-yaml", default="configs/mergekit/evolved_mergekit_recipe.yaml", help="Path for YAML recipe output")
    args = parser.parse_args()

    if args.dataset and os.path.exists(args.dataset):
        with open(args.dataset, "r", encoding="utf-8") as fp:
            dataset = json.load(fp)
        print(f"[OK] Loaded {len(dataset)} evaluation records from {args.dataset}")
    else:
        dataset = generate_synthetic_historical_dataset(num_samples=args.samples, horizon=args.horizon)
        print(f"[*] Generated {len(dataset)} synthetic calibrated benchmark samples for {args.horizon}m contracts")

    best = run_evolutionary_optimization(
        dataset=dataset,
        generations=args.generations,
        pop_size=args.pop_size,
        preferred_method=args.method,
    )

    print("\n================================================================")
    print("EVOLUTIONARY TUNING COMPLETED SUCCESSFULLY")
    print(f"Winning Method: {best.method.upper()}")
    print(f"Fitness Score:  {best.fitness:.3f}")
    print(f"Brier Score:    {best.brier_score:.4f} (Lower is better)")
    print(f"Accuracy:       {best.accuracy:.2f}%")
    print(f"Calibration ECE:{best.ece:.4f}")
    print(f"Deadband Filter:{best.deadband:.4f}")
    print("================================================================")

    export_results(best, args.output_json, args.output_yaml)


if __name__ == "__main__":
    main()
