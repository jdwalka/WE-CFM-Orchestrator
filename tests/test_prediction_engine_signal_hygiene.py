import unittest

import prediction_engine


class SignalHygieneTests(unittest.TestCase):
    def setUp(self):
        prediction_engine._cross_venue_divergence_history.clear()
        prediction_engine._open_interest_history.clear()

    def test_wick_ratio_trend_reports_direction_without_confusing_tail_pressure(self):
        rising = prediction_engine.get_tail_diagnostics({
            "per_hour": [
                {"avg_wick_ratio": 1.0},
                {"avg_wick_ratio": 1.0},
                {"avg_wick_ratio": 1.0},
                {"avg_wick_ratio": 2.0},
                {"avg_wick_ratio": 4.0},
            ],
            "late_window_spike_frequency_per_hour": 2.0,
        })
        falling = prediction_engine.get_tail_diagnostics({
            "per_hour": [
                {"avg_wick_ratio": 4.0},
                {"avg_wick_ratio": 2.0},
                {"avg_wick_ratio": 1.0},
                {"avg_wick_ratio": 1.0},
                {"avg_wick_ratio": 1.0},
            ],
            "late_window_spike_frequency_per_hour": 2.0,
        })
        flat = prediction_engine.get_tail_diagnostics({
            "per_hour": [{"avg_wick_ratio": 1.0}] * 5,
            "late_window_spike_frequency_per_hour": 2.0,
        })

        self.assertEqual(rising["wick_ratio_trend_status"], "rising")
        self.assertEqual(falling["wick_ratio_trend_status"], "falling")
        self.assertEqual(flat["wick_ratio_trend_status"], "flat")
        self.assertEqual(rising["tail_pressure_status"], "elevated")

    def test_lead_lag_gate_requires_stable_material_sign(self):
        stable = prediction_engine._lead_lag_backtest_gate({
            1: 0.10,
            2: 0.12,
            3: 0.14,
            4: 0.11,
            5: 0.13,
        })
        unstable = prediction_engine._lead_lag_backtest_gate({
            1: 0.20,
            2: -0.20,
            3: 0.20,
            4: -0.20,
            5: 0.20,
        })
        weak = prediction_engine._lead_lag_backtest_gate({1: 0.01, 2: 0.02, 3: 0.03})

        self.assertTrue(stable["passed"])
        self.assertFalse(unstable["passed"])
        self.assertFalse(weak["passed"])

        filtered, filter_status = prediction_engine._filter_alt_signal({
            "lead_lag_status": "unstable",
        })
        self.assertIsNone(filtered)
        self.assertEqual(filter_status["status"], "excluded")

    def test_cross_venue_divergence_activates_only_above_rolling_percentile(self):
        prediction_engine._cross_venue_divergence_history.extend([0.01] * 20)
        original = prediction_engine.get_cross_venue_spot_prices
        prediction_engine.get_cross_venue_spot_prices = lambda: [100.0, 100.2, 100.3]
        try:
            elevated = prediction_engine.get_cross_venue_divergence()
            prediction_engine._cross_venue_divergence_history.clear()
            prediction_engine._cross_venue_divergence_history.extend([0.01] * 20)
            prediction_engine.get_cross_venue_spot_prices = lambda: [100.0, 100.01]
            normal = prediction_engine.get_cross_venue_divergence()
        finally:
            prediction_engine.get_cross_venue_spot_prices = original

        self.assertTrue(elevated["active"])
        self.assertEqual(elevated["regime"], "elevated")
        self.assertEqual(elevated["tail_adjustment"], 0.15)
        self.assertFalse(normal["active"])
        self.assertEqual(normal["regime"], "normal")
        self.assertEqual(normal["tail_adjustment"], 0.0)

    def test_positioning_skew_is_mild_and_contrarian(self):
        crowded_long = prediction_engine._positioning_skew(0.001, 5.0)
        crowded_short = prediction_engine._positioning_skew(-0.001, 5.0)
        funding_only = prediction_engine._positioning_skew(0.001, None)

        self.assertLess(crowded_long, 0.0)
        self.assertGreater(crowded_short, 0.0)
        self.assertGreaterEqual(crowded_long, -0.03)
        self.assertLessEqual(crowded_short, 0.03)
        self.assertAlmostEqual(funding_only, -0.02)


if __name__ == "__main__":
    unittest.main()
