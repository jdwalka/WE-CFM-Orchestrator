import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop
from truffle_cascade_bridge import create_truffle_app

class TestTruffleCascadeBridge(AioHTTPTestCase):
    async def get_application(self):
        return create_truffle_app()

    @unittest_run_loop
    async def test_health_check(self):
        resp = await self.client.request("GET", "/health")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["service"], "truffle-cascade-engine")

    @unittest_run_loop
    async def test_valid_cascade_audit(self):
        payload = {
            "symbol": "BTC",
            "spot": 65000.0,
            "amm_bands": [
                {"low": 60000.0, "high": 70000.0, "depth": 500000.0}
            ],
            "liquidation_queue": [
                {"price": 64000.0, "vol": 10000.0, "leverage": 20.0}
            ],
            "flow": {
                "forced_vol": 50000.0,
                "taker_buy_vol": 40000.0,
                "taker_sell_vol": 5000.0,
                "amm_vel": 0.02,
                "oracle_vel": 0.02,
                "window_sec": 300.0
            },
            "venue_skew": {
                "l_ratio": -0.10,
                "divergence_pct": 0.01,
                "funding_skew": -0.00005,
                "active": True
            }
        }
        resp = await self.client.request("POST", "/truffle/cascade-audit", json=payload)
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertTrue(data["ok"])
        self.assertIn("telemetry", data)
        self.assertIn("asi1_context_prompt", data)
        self.assertIn("truffle_gate", data)
        self.assertIn("allow_reversion_entry", data["truffle_gate"])
        self.assertIn("force_halt_knife_catch", data["truffle_gate"])

    @unittest_run_loop
    async def test_malformed_spot(self):
        payload = {"spot": "not_a_number"}
        resp = await self.client.request("POST", "/truffle/cascade-audit", json=payload)
        self.assertEqual(resp.status, 400)
        data = await resp.json()
        self.assertFalse(data["ok"])

    @unittest_run_loop
    async def test_malformed_bands(self):
        payload = {
            "spot": 65000.0,
            "amm_bands": [{"low": "abc", "high": 70000.0, "depth": 100.0}]
        }
        resp = await self.client.request("POST", "/truffle/cascade-audit", json=payload)
        self.assertEqual(resp.status, 400)
        data = await resp.json()
        self.assertFalse(data["ok"])

if __name__ == "__main__":
    unittest.main()
