"""
Tests for the CEX High-Frequency Trade Monitor — VPIN, whale detection, metrics.

Run: python -m pytest tests/engines/test_cex_high_freq_monitor.py -v
"""
import sys
import os
import time
import types
import importlib

ENGINES_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'engines')
sys.path.insert(0, ENGINES_DIR)


def _import_high_freq():
    """Import the high-freq monitor, stubbing websockets."""
    ws_stub = types.ModuleType('websockets')

    class _WSConnStub:
        def __aenter__(self): return self
        def __aexit__(self, *a): pass
        async def recv(self):
            import asyncio; await asyncio.sleep(0.01); return '{}'
        async def send(self, msg): pass

    ws_stub.connect = lambda *a, **kw: _WSConnStub()
    sys.modules['websockets'] = ws_stub

    mod_name = 'cex_high_freq_monitor'
    if mod_name in sys.modules:
        del sys.modules[mod_name]

    mod = importlib.import_module(mod_name)
    return mod


def test_init_defaults():
    """Monitor should initialize with correct defaults."""
    mod = _import_high_freq()
    monitor = mod.HighFreqTradeMonitor('BTC')
    assert monitor.symbol == 'BTC'
    assert monitor.bucket_vol_usd == 50000.0
    assert len(monitor.vpin_buckets) == 0
    assert monitor.current_bucket_buy_vol == 0.0
    assert monitor.current_bucket_sell_vol == 0.0


def test_add_buy_trade():
    """Buy trades should accumulate in the buy bucket."""
    mod = _import_high_freq()
    monitor = mod.HighFreqTradeMonitor('BTC')
    monitor.add_trade(price=50000, qty=0.5, is_buy=True)
    assert monitor.current_bucket_buy_vol > 0
    assert monitor.current_bucket_sell_vol == 0


def test_add_sell_trade():
    """Sell trades should accumulate in the sell bucket."""
    mod = _import_high_freq()
    monitor = mod.HighFreqTradeMonitor('BTC')
    monitor.add_trade(price=50000, qty=0.5, is_buy=False)
    assert monitor.current_bucket_sell_vol > 0
    assert monitor.current_bucket_buy_vol == 0


def test_vpin_bucket_close():
    """A bucket should close when volume reaches the threshold."""
    mod = _import_high_freq()
    monitor = mod.HighFreqTradeMonitor('BTC')
    monitor.add_trade(price=50000, qty=1.0, is_buy=True)
    assert len(monitor.vpin_buckets) == 1
    assert monitor.current_bucket_buy_vol == 0.0


def test_vpin_score_computed():
    """compute_metrics should populate vpin after bucket closes."""
    mod = _import_high_freq()
    monitor = mod.HighFreqTradeMonitor('BTC')
    monitor.add_trade(price=50000, qty=1.0, is_buy=True)
    monitor.add_trade(price=50000, qty=1.0, is_buy=True)
    monitor.compute_metrics()
    assert 'vpin' in monitor.metrics
    assert 0 <= monitor.metrics['vpin'] <= 1


def test_whale_detection():
    """Large trades should increment whale counters."""
    mod = _import_high_freq()
    monitor = mod.HighFreqTradeMonitor('BTC')
    monitor.add_trade(price=50000, qty=1.0, is_buy=True)
    monitor.compute_metrics()
    assert monitor.metrics['whale_trades_1m_10k'] >= 1


def test_whale_50k_detection():
    """Trades over $50k should increment the higher whale counter."""
    mod = _import_high_freq()
    monitor = mod.HighFreqTradeMonitor('BTC')
    monitor.add_trade(price=60000, qty=1.0, is_buy=True)
    monitor.compute_metrics()
    assert monitor.metrics['whale_trades_1m_50k'] >= 1


def test_metrics_keys():
    """compute_metrics should populate all expected metric keys."""
    mod = _import_high_freq()
    monitor = mod.HighFreqTradeMonitor('BTC')
    monitor.add_trade(price=50000, qty=0.1, is_buy=True)
    monitor.compute_metrics()
    expected = {'vpin', 'whale_trades_1m_10k', 'whale_trades_1m_50k', 'trades_per_sec'}
    assert expected.issubset(set(monitor.metrics.keys()))


def test_trade_history_tracking():
    """Trades should be tracked in self.trades with timestamps."""
    mod = _import_high_freq()
    monitor = mod.HighFreqTradeMonitor('BTC')
    monitor.add_trade(price=50000, qty=0.1, is_buy=True)
    monitor.add_trade(price=50100, qty=0.2, is_buy=False)
    assert len(monitor.trades) == 2
    t = monitor.trades[-1]
    assert t[1] == 50100  # price
    assert t[2] == 0.2    # qty
    assert t[4] is False   # is_buy
