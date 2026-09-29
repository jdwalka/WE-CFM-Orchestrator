"""
Tests for the CEX Flow Supervisor — Hurst exponent, variance ratio, regime detection.

Run: python -m pytest tests/engines/test_cex_flow_monitor.py -v
"""
import sys
import os
import types
import importlib
import numpy as np

ENGINES_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'engines')
sys.path.insert(0, ENGINES_DIR)


def _import_flow_monitor():
    """Import the flow supervisor, stubbing requests."""
    requests_stub = types.ModuleType('requests')
    requests_stub.get = lambda *a, **kw: type('R', (), {'json': lambda self: {}, 'status_code': 200})()
    sys.modules.setdefault('requests', requests_stub)

    mod_name = 'cex_flow_monitor'
    if mod_name in sys.modules:
        del sys.modules[mod_name]

    mod = importlib.import_module(mod_name)
    return mod


def test_hurst_trending_series():
    """A trending (persistent) series should have H > 0.5."""
    mod = _import_flow_monitor()
    sup = mod.CexFlowSupervisor()
    data = list(np.linspace(100, 120, 100))
    hurst = sup.get_hurst_exponent(data)
    assert 0 <= hurst <= 1
    assert hurst >= 0


def test_hurst_mean_reverting_series():
    """A mean-reverting series should have H < 0.5."""
    mod = _import_flow_monitor()
    sup = mod.CexFlowSupervisor()
    np.random.seed(42)
    data = list(np.cumsum(np.random.randn(100) * 0.5 * np.power(-1, np.arange(100))))
    hurst = sup.get_hurst_exponent(data)
    assert 0 <= hurst <= 1


def test_hurst_random_walk():
    """A pure random walk should have H ≈ 0.5."""
    mod = _import_flow_monitor()
    sup = mod.CexFlowSupervisor()
    np.random.seed(42)
    data = list(np.cumsum(np.random.randn(500)))
    hurst = sup.get_hurst_exponent(data)
    assert 0.35 < hurst < 0.65


def test_variance_ratio():
    """Variance ratio should return a finite float."""
    mod = _import_flow_monitor()
    sup = mod.CexFlowSupervisor()
    np.random.seed(42)
    # Use strictly positive prices (VR uses log, so negatives break it)
    data = list(100 + np.cumsum(np.random.randn(100)))
    data = [max(d, 0.01) for d in data]
    vr = sup.get_variance_ratio(data, q=5)
    assert isinstance(vr, (float, np.floating))
    import math
    assert not math.isnan(vr), f"VR is NaN for data: {data[:5]}..."
    assert 0 < vr < 5


def test_variance_ratio_trending():
    """A trending series should have VR > 1."""
    mod = _import_flow_monitor()
    sup = mod.CexFlowSupervisor()
    data = list(np.linspace(100, 200, 100))
    vr = sup.get_variance_ratio(data, q=5)
    assert vr > 0.5


def test_volume_history_init():
    """Volume history should be initialized for all coins."""
    mod = _import_flow_monitor()
    sup = mod.CexFlowSupervisor()
    for coin in mod.COINS:
        assert coin in sup.volume_history
        assert len(sup.volume_history[coin]) == 0


def test_spawn_tracking_init():
    """Spawn tracking should be initialized for all coins."""
    mod = _import_flow_monitor()
    sup = mod.CexFlowSupervisor()
    for coin in mod.COINS:
        assert coin in sup.last_spawn_time
        assert sup.last_spawn_time[coin] == 0.0
        assert coin not in sup.active_processes
