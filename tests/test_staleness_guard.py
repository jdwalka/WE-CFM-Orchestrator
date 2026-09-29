"""
Unit tests for StalenessGuard (rules R1, R1b, R2, R3, R4).
"""

import time
import unittest
from staleness_guard import (
    CACHE_HIT_MAX_AGE_S,
    FRESH_SPOT_MAX_S,
    SCREEN_DIVERGENCE_PTS,
    SERVED_MAX_AGE_S,
    STALE_DELTA_PTS,
    MarketData,
    StalenessGuard,
)


class TestStalenessGuard(unittest.TestCase):
    def setUp(self):
        self.guard = StalenessGuard()
        self.now = time.time()

    def test_clean_fresh_miss_cleared(self):
        data = MarketData(
            spot=76500.0,
            spot_pulled_at=self.now,
            ladder_cache="miss",
            ladder_collector_ts=self.now,
            spot_at_fair=76500.0,
            screen_spot=76502.0,
            age_seconds=0,
        )
        verdict = self.guard.decide(data)
        self.assertTrue(verdict.allowed)
        self.assertEqual(verdict.effective_spot, 76500.0)
        self.assertIn("fresh cache-miss data", str(verdict))

    def test_r1_stale_spot_blocked(self):
        data = MarketData(
            spot=76500.0,
            spot_pulled_at=self.now - 60,  # 60s > 45s max
            ladder_cache="miss",
            ladder_collector_ts=self.now,
            spot_at_fair=76500.0,
            screen_spot=None,
            age_seconds=0,
        )
        verdict = self.guard.decide(data)
        self.assertFalse(verdict.allowed)
        self.assertTrue(any("R1:" in r for r in verdict.reasons))

    def test_r2_spot_drift_since_fair_blocked(self):
        data = MarketData(
            spot=76535.0,  # +35 pts move > 25 pt max
            spot_pulled_at=self.now,
            ladder_cache="miss",
            ladder_collector_ts=self.now,
            spot_at_fair=76500.0,
            screen_spot=None,
            age_seconds=0,
        )
        verdict = self.guard.decide(data)
        self.assertFalse(verdict.allowed)
        self.assertTrue(any("R2:" in r for r in verdict.reasons))

    def test_r3_screen_divergence_wins(self):
        # Screen at 76600 vs feed at 76500 (100 pt diff > 30 pt threshold)
        data = MarketData(
            spot=76500.0,
            spot_pulled_at=self.now,
            ladder_cache="miss",
            ladder_collector_ts=self.now,
            spot_at_fair=76500.0,
            screen_spot=76600.0,
            age_seconds=0,
        )
        verdict = self.guard.decide(data)
        self.assertEqual(verdict.effective_spot, 76600.0)
        self.assertTrue(any("R3:" in r for r in verdict.reasons))
        # Since effective spot (76600) differs from spot_at_fair (76500) by 100 pts, R2 also blocks!
        self.assertFalse(verdict.allowed)

    def test_r1b_served_age_blocked(self):
        data = MarketData(
            spot=76500.0,
            spot_pulled_at=self.now,
            ladder_cache="hit",
            ladder_collector_ts=self.now - 50,
            spot_at_fair=76500.0,
            screen_spot=None,
            age_seconds=50.0,  # 50s > 45s SERVED_MAX_AGE_S
        )
        verdict = self.guard.decide(data)
        self.assertFalse(verdict.allowed)
        self.assertTrue(any("R1b:" in r for r in verdict.reasons))

    def test_r4_cache_hit_drift_suppressed(self):
        # Within tolerance age hit (e.g. 20s old)
        data = MarketData(
            spot=76500.0,
            spot_pulled_at=self.now,
            ladder_cache="hit",
            ladder_collector_ts=self.now - 20,
            spot_at_fair=76500.0,
            screen_spot=None,
            age_seconds=20.0,
        )
        verdict = self.guard.decide(data)
        self.assertTrue(verdict.allowed)
        self.assertTrue(any("R4:" in r and "NO drift/momentum narrative" in r for r in verdict.reasons))


if __name__ == "__main__":
    unittest.main()
