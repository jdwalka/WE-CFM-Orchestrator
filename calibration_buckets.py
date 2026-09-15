"""Expiry-bucketed probability correction for Truffle calibration."""
from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field

BUCKET_EDGES = ((5, "0-5m"), (15, "6-15m"), (30, "16-30m"), (60, "31-60m"))
ACTIVATION_OVERALL_BRIER_IMPROVEMENT = 0.004
ACTIVATION_MAX_BUCKET_DEGRADATION = 0.02


@dataclass(frozen=True)
class BucketConfig:
    prior_strength: float = 200.0
    min_samples: int = 30
    max_factor: float = 4.0
    min_factor: float = 1.0
    floor: float = 0.0005
    rolling_window: int = 200


@dataclass
class BucketStats:
    sum_predicted: float = 0.0
    sum_realized: float = 0.0
    count: int = 0
    window: deque = field(default_factory=deque)

    def record(self, predicted: float, realized: int, window_size: int) -> None:
        predicted = float(predicted)
        realized = 1 if realized else 0
        self.window.append((predicted, realized))
        self.sum_predicted += predicted
        self.sum_realized += realized
        while len(self.window) > window_size:
            old_predicted, old_realized = self.window.popleft()
            self.sum_predicted -= old_predicted
            self.sum_realized -= old_realized
        self.count = len(self.window)


def bucket_key(minutes_to_expiry: float) -> str:
    minutes = max(0, int(minutes_to_expiry))
    for upper_bound, bucket in BUCKET_EDGES:
        if minutes <= upper_bound:
            return bucket
    return BUCKET_EDGES[-1][1]


def brier_score(probability: float, realized: int) -> float:
    probability = min(1.0, max(0.0, float(probability)))
    return (probability - (1 if realized else 0)) ** 2


def _mean(values) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def _reliability_resolution(
    probabilities,
    outcomes,
    base_rate: float,
) -> dict:
    probabilities = list(float(value) for value in probabilities)
    outcomes = [1 if value else 0 for value in outcomes]
    count = len(probabilities)
    if not count:
        return {
            "count": 0,
            "avg_predicted_probability": None,
            "realized_frequency": None,
            "calibration_gap": None,
            "reliability": None,
            "resolution": None,
            "uncertainty": round(base_rate * (1.0 - base_rate), 6),
        }
    avg_predicted = _mean(probabilities)
    realized_frequency = _mean(outcomes)
    return {
        "count": count,
        "avg_predicted_probability": round(avg_predicted, 6),
        "realized_frequency": round(realized_frequency, 6),
        "calibration_gap": round(realized_frequency - avg_predicted, 6),
        "reliability": round((avg_predicted - realized_frequency) ** 2, 6),
        "resolution": round((realized_frequency - base_rate) ** 2, 6),
        "uncertainty": round(base_rate * (1.0 - base_rate), 6),
    }


def posterior_factor(
    stats: BucketStats,
    prior_factor: float,
    config: BucketConfig,
) -> float | None:
    if stats.count < config.min_samples or stats.sum_predicted <= 0:
        return None
    raw_ratio = stats.sum_realized / stats.sum_predicted
    prior_weight = config.prior_strength
    evidence_weight = stats.count
    posterior = (
        prior_weight * prior_factor + evidence_weight * raw_ratio
    ) / (prior_weight + evidence_weight)
    return max(config.min_factor, min(config.max_factor, posterior))


class BucketedCalibration:
    def __init__(self, global_factor: float, config: BucketConfig | None = None):
        self.global_factor = float(global_factor)
        self.config = config or BucketConfig()
        self.by_regime: dict[str, dict[str, BucketStats]] = defaultdict(
            lambda: defaultdict(BucketStats)
        )
        self.by_expiry: dict[str, BucketStats] = defaultdict(BucketStats)

    def record(
        self,
        predicted: float,
        realized: int,
        minutes_to_expiry: float,
        regime: str = "UNKNOWN",
    ) -> None:
        expiry_bucket = bucket_key(minutes_to_expiry)
        self.by_expiry[expiry_bucket].record(
            predicted, realized, self.config.rolling_window
        )
        self.by_regime[str(regime or "UNKNOWN")][expiry_bucket].record(
            predicted, realized, self.config.rolling_window
        )

    def factor_for(
        self,
        minutes_to_expiry: float,
        regime: str = "UNKNOWN",
    ) -> tuple[float, str]:
        expiry_bucket = bucket_key(minutes_to_expiry)
        factor = posterior_factor(
            self.by_regime[str(regime or "UNKNOWN")][expiry_bucket],
            self.global_factor,
            self.config,
        )
        if factor is not None:
            return factor, f"regime:{regime}:{expiry_bucket}"
        factor = posterior_factor(
            self.by_expiry[expiry_bucket], self.global_factor, self.config
        )
        if factor is not None:
            return factor, f"expiry:{expiry_bucket}"
        return self.global_factor, "global"

    def apply(
        self,
        probability: float,
        minutes_to_expiry: float,
        regime: str = "UNKNOWN",
    ) -> dict:
        factor, source = self.factor_for(minutes_to_expiry, regime)
        calibrated = max(
            self.config.floor,
            min(1.0, float(probability) * factor),
        )
        return {
            "p_base": float(probability),
            "p_calibrated": calibrated,
            "calibration_factor": round(factor, 4),
            "calibration_regime": source,
        }

    def snapshot(self) -> dict:
        buckets = {}
        for name, stats in self.by_expiry.items():
            factor = posterior_factor(stats, self.global_factor, self.config)
            buckets[name] = {
                "count": stats.count,
                "sum_predicted": round(stats.sum_predicted, 4),
                "sum_realized": round(stats.sum_realized, 2),
                "raw_ratio": round(
                    stats.sum_realized / stats.sum_predicted, 4
                ) if stats.sum_predicted > 0 else None,
                "factor": round(factor, 4) if factor is not None else None,
                "source": "bucket" if factor is not None else "global_fallback",
            }
        return {
            "correction_factor": round(self.global_factor, 4),
            "bucketed": True,
            "buckets": buckets,
            "config": {
                "prior_strength": self.config.prior_strength,
                "min_samples": self.config.min_samples,
                "max_factor": self.config.max_factor,
                "min_factor": self.config.min_factor,
                "floor": self.config.floor,
                "rolling_window": self.config.rolling_window,
            },
        }


def replay_resolved_outcomes(
    rows,
    global_factor: float,
    rolling_window: int = 200,
) -> dict:
    """Chronological out-of-sample replay of global vs bucketed corrections.

    The factor is selected before each outcome is recorded, so every score uses
    only prior resolved outcomes. Per-bucket `improvement` is signed as
    `global_brier - bucketed_brier`; positive values mean bucketing helped.
    """
    config = BucketConfig(rolling_window=rolling_window)
    calibration = BucketedCalibration(global_factor, config)
    global_scores: dict[str, list[float]] = defaultdict(list)
    bucketed_scores: dict[str, list[float]] = defaultdict(list)
    global_probabilities: dict[str, list[float]] = defaultdict(list)
    bucketed_probabilities: dict[str, list[float]] = defaultdict(list)
    outcomes_by_bucket: dict[str, list[int]] = defaultdict(list)

    for p_base, realized, minutes_to_expiry, regime in rows:
        bucket = bucket_key(minutes_to_expiry)
        global_probability = float(p_base) * calibration.global_factor
        bucketed = calibration.apply(p_base, minutes_to_expiry, regime)
        bucketed_probability = bucketed["p_calibrated"]
        global_scores[bucket].append(brier_score(global_probability, realized))
        bucketed_scores[bucket].append(
            brier_score(bucketed_probability, realized)
        )
        global_probabilities[bucket].append(global_probability)
        bucketed_probabilities[bucket].append(bucketed_probability)
        outcomes_by_bucket[bucket].append(1 if realized else 0)
        calibration.record(p_base, realized, minutes_to_expiry, regime)

    all_outcomes = [
        outcome
        for outcomes in outcomes_by_bucket.values()
        for outcome in outcomes
    ]
    base_rate = _mean(all_outcomes)
    all_global = [
        score for scores in global_scores.values() for score in scores
    ]
    all_bucketed = [
        score for scores in bucketed_scores.values() for score in scores
    ]
    global_brier = _mean(all_global)
    bucketed_brier = _mean(all_bucketed)
    overall_improvement = global_brier - bucketed_brier

    bucket_report = {}
    max_degradation = -float("inf")
    for bucket in sorted(outcomes_by_bucket):
        bucket_global_brier = _mean(global_scores[bucket])
        bucket_bucketed_brier = _mean(bucketed_scores[bucket])
        improvement = bucket_global_brier - bucket_bucketed_brier
        max_degradation = max(max_degradation, -improvement)
        bucket_report[bucket] = {
            "count": len(global_scores[bucket]),
            "global_brier": round(bucket_global_brier, 6),
            "bucketed_brier": round(bucket_bucketed_brier, 6),
            "improvement": round(improvement, 6),
            "diagnostics": {
                "global": _reliability_resolution(
                    global_probabilities[bucket],
                    outcomes_by_bucket[bucket],
                    base_rate,
                ),
                "bucketed": _reliability_resolution(
                    bucketed_probabilities[bucket],
                    outcomes_by_bucket[bucket],
                    base_rate,
                ),
            },
        }

    enabled = (
        overall_improvement >= ACTIVATION_OVERALL_BRIER_IMPROVEMENT
        and max_degradation <= ACTIVATION_MAX_BUCKET_DEGRADATION
    )
    return {
        "status": "ok",
        "samples": len(all_global),
        "global_factor": round(calibration.global_factor, 4),
        "global_brier": round(global_brier, 6),
        "bucketed_brier": round(bucketed_brier, 6),
        "overall_improvement": round(overall_improvement, 6),
        "max_bucket_degradation": round(max_degradation, 6),
        "activation": {
            "enabled": enabled,
            "required_overall_improvement": ACTIVATION_OVERALL_BRIER_IMPROVEMENT,
            "max_bucket_degradation": ACTIVATION_MAX_BUCKET_DEGRADATION,
        },
        "buckets": bucket_report,
        "current_factors": calibration.snapshot()["buckets"],
        "config": calibration.snapshot()["config"],
    }
