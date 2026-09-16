import unittest

from prediction_engine import (
    _conditional_settlement_hold,
    _historical_final_minute_windows,
    _ranked_entry_scores,
)


class PredictionPipelineTest(unittest.TestCase):
    def test_historical_final_minute_windows_filter_and_count(self):
        candles = [
            {"time": 3539, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0},
            {"time": 3540, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0},
            {"time": 3541, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0},
        ]

        history = _historical_final_minute_windows(candles)

        self.assertEqual(history["window_count"], 1)
        self.assertEqual(history["print_count"], 4)
        self.assertEqual(history["windows"][0]["prints"][0], 100.0)

    def test_conditional_settlement_hold_uses_touched_windows(self):
        history = {
            "source": "test",
            "windows": [
                {"prints": [100.0, 100.0, 100.0, 100.0]},
                {"prints": [100.0, 120.0, 80.0, 100.0]},
                {"prints": [101.0, 120.0, 80.0, 107.0]},
                {"prints": [99.0, 99.0, 99.0, 99.0]},
            ],
        }

        hold = _conditional_settlement_hold(100.0, 101.0, history)

        self.assertTrue(hold["estimated"])
        self.assertEqual(hold["touched_samples"], 3)
        self.assertEqual(hold["held_samples"], 2)
        self.assertEqual(hold["estimator"], "empirical_bayes_shrinkage")
        self.assertAlmostEqual(hold["hold_given_touch"], 32 / 33, places=4)

    def test_conditional_settlement_hold_falls_back_without_touches(self):
        hold = _conditional_settlement_hold(
            100.0,
            101.0,
            {"source": "test", "windows": [{"prints": [99.0, 99.0, 99.0, 99.0]}]},
        )

        self.assertFalse(hold["estimated"])
        self.assertEqual(hold["hold_given_touch"], 1.0)

    def test_ranked_entry_scores_project_and_rank_edges(self):
        bands = [
            {
                "band": "a",
                "low": 100.0,
                "high": 101.0,
                "yes_ask": 20,
                "side_vs_spot": "ABOVE_SPOT",
            },
            {
                "band": "b",
                "low": 102.0,
                "high": 103.0,
                "yes_ask": 45,
                "side_vs_spot": "ABOVE_SPOT",
            },
        ]
        decay_table = [
            {
                "band": "$100.00-$101.00",
                "side": "ABOVE_SPOT",
                "p_15m": 0.50,
                "settlement_venue": "test-venue",
                "settlement_rule": "test-rule",
            },
            {
                "band": "$102.00-$103.00",
                "side": "ABOVE_SPOT",
                "p_15m": 0.70,
                "settlement_venue": "test-venue",
                "settlement_rule": "test-rule",
            },
        ]

        scores = _ranked_entry_scores(decay_table, bands)

        self.assertEqual(scores[0]["entry_rank"], 1)
        self.assertEqual(scores[0]["projected_fair_T15m"], 50.0)
        self.assertEqual(scores[0]["edge_at_entry"], 30.0)
        self.assertEqual(scores[1]["entry_rank"], 2)
        self.assertEqual(scores[1]["projected_fair_T15m"], 70.0)
        self.assertEqual(scores[1]["edge_at_entry"], 25.0)


if __name__ == "__main__":
    unittest.main()
