"""
staleness_guard.py — pre-call gate for BTC ladder directional calls.
Drop into Antigravity; call `guard.decide()` before any YES/NO recommendation.

Rules enforced:
  R1: Ladder must be a cache MISS, or a fresh spot pull must be < FRESH_SPOT_MAX_S old.
  R1b: Cache-hit ladder > CACHE_HIT_MAX_AGE_S old or served age_seconds > SERVED_MAX_AGE_S = void outright.
  R2: Spot delta since fair computation must be < STALE_DELTA_PTS, else ladder is void.
  R3: If user's screen price disagrees with feed spot by > SCREEN_DIVERGENCE_PTS,
      user screen wins and the feed read is void (3 overrides today proved this).
  R4: No drift/momentum narrative may be built from a cache-hit ladder. Ever.
"""

import time
from dataclasses import dataclass, field

# --- thresholds (tune once, here) ---
FRESH_SPOT_MAX_S      = 45       # spot pull older than this = stale
STALE_DELTA_PTS       = 25.0     # spot moved this much since fair was computed = void
SCREEN_DIVERGENCE_PTS = 30.0     # user screen vs feed disagreement = feed loses
CACHE_HIT_MAX_AGE_S   = 90       # cache-hit ladder older than this = void outright
SERVED_MAX_AGE_S      = 45       # served payload age_seconds threshold for entry


@dataclass
class MarketData:
    spot: float                      # feed spot price
    spot_pulled_at: float            # unix ts of the spot pull
    ladder_cache: str                # "hit" or "miss"
    ladder_collector_ts: float       # unix ts of ladder snapshot
    spot_at_fair: float              # spot the ladder's fairs were computed at
    screen_spot: float | None = None # user's live screen price, if provided
    age_seconds: float | None = None # served payload age_seconds, if provided


@dataclass
class Verdict:
    allowed: bool
    reasons: list[str] = field(default_factory=list)
    effective_spot: float | None = None   # which price to trust (screen wins ties)

    def __str__(self):
        status = "ALLOW" if self.allowed else "BLOCK"
        return f"[{status}] " + " | ".join(self.reasons)


class StalenessGuard:
    def decide(self, d: MarketData) -> Verdict:
        v = Verdict(allowed=True)
        now = time.time()

        # R3 first: the user's screen is ground truth on divergence
        spot = d.spot
        if d.screen_spot is not None:
            if abs(d.screen_spot - d.spot) > SCREEN_DIVERGENCE_PTS:
                v.reasons.append(
                    f"R3: screen {d.screen_spot:.0f} vs feed {d.spot:.0f} "
                    f"diverges > {SCREEN_DIVERGENCE_PTS:.0f} pts — feed VOID, screen wins"
                )
                spot = d.screen_spot
        v.effective_spot = spot

        # R1: spot freshness
        spot_age = now - d.spot_pulled_at
        if spot_age > FRESH_SPOT_MAX_S:
            v.allowed = False
            v.reasons.append(
                f"R1: spot pull {spot_age:.0f}s old (max {FRESH_SPOT_MAX_S}s) — "
                f"re-pull spot before any directional call"
            )

        # R2: ladder void if spot moved since fairs were computed
        delta = spot - d.spot_at_fair
        if abs(delta) > STALE_DELTA_PTS:
            v.allowed = False
            v.reasons.append(
                f"R2: spot moved {delta:+.0f} pts since fair computation "
                f"(max {STALE_DELTA_PTS:.0f}) — ladder fairs VOID, re-pull cache-miss"
            )

        # R1b: cache-hit ladder age / served age_seconds
        if d.ladder_cache == "hit":
            ladder_age = now - d.ladder_collector_ts
            served_age = d.age_seconds if d.age_seconds is not None else ladder_age
            if served_age > SERVED_MAX_AGE_S:
                v.allowed = False
                v.reasons.append(
                    f"R1b: served payload {served_age:.0f}s old (max {SERVED_MAX_AGE_S}s) — "
                    f"force cache-miss re-pull"
                )
            elif ladder_age > CACHE_HIT_MAX_AGE_S:
                v.allowed = False
                v.reasons.append(
                    f"R1b: cache-hit ladder {ladder_age:.0f}s old "
                    f"(max {CACHE_HIT_MAX_AGE_S}s) — force cache-miss re-pull"
                )
            else:
                v.reasons.append(
                    f"R4: cache-hit ladder ({ladder_age:.0f}s old) — "
                    f"NO drift/momentum narrative permitted from this snapshot"
                )

        if v.allowed and not v.reasons:
            v.reasons.append("fresh cache-miss data — cleared for directional call")
        return v


# --- usage ---
if __name__ == "__main__":
    guard = StalenessGuard()

    # the 14:45 failure, replayed: cache hit, spot moved 150 pts, screen said 76,643
    bad = MarketData(
        spot=76556.0, spot_pulled_at=time.time() - 300,
        ladder_cache="hit", ladder_collector_ts=time.time() - 300,
        spot_at_fair=76706.0, screen_spot=76643.0,
    )
    print(guard.decide(bad))
    # -> [BLOCK] R3 screen wins | R1 spot stale | R2 fairs void | R1b ladder stale

    # clean case
    good = MarketData(
        spot=76643.0, spot_pulled_at=time.time(),
        ladder_cache="miss", ladder_collector_ts=time.time(),
        spot_at_fair=76643.0, screen_spot=76640.0,
    )
    print(guard.decide(good))
    # -> [ALLOW] fresh cache-miss data — cleared for directional call
