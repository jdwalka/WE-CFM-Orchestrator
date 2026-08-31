"""
Tests for the WECRYPTO Nuclear Engine — OEQ computation, exit logic, and OHLCV fetch.

Run: python -m pytest tests/engines/test_wecrypto_nuclear.py -v
"""
import sys
import os
import types
import importlib
import numpy as np

ENGINES_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'engines')
sys.path.insert(0, ENGINES_DIR)


def _import_nuclear():
    """Import the nuclear engine, stubbing Kafka/requests to avoid runtime deps."""
    kafka_stub = types.ModuleType('kafka')

    class _KafkaConsumerStub:
        def __init__(self, *a, **kw): pass
        def subscribe(self, *a, **kw): pass
        def poll(self, *a, **kw): return {}
        def close(self): pass

    kafka_stub.KafkaConsumer = _KafkaConsumerStub
    kafka_stub.KafkaProducer = type('KafkaProducer', (), {
        '__init__': lambda self, *a, **kw: None,
        'send': lambda self, *a, **kw: None,
        'flush': lambda self: None,
        'close': lambda self: None,
    })
    sys.modules['kafka'] = kafka_stub

    # Remove cached module if present
    mod_name = 'wecrypto_nuclear'
    if mod_name in sys.modules:
        del sys.modules[mod_name]

    mod = importlib.import_module(mod_name)
    return mod


def test_oeq_computation_basic():
    """OEQ should return valid metrics for a simple price series."""
    mod = _import_nuclear()
    prices   = [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0]
    volumes  = [1000.0] * 8
    open_price = 100.0
    sigma = 0.01
    lam = 0.005

    result = mod.WecryptoNuclear._compute_oeq(prices, volumes, open_price, sigma, lam)

    assert 'oeq' in result
    assert 's_base' in result
    assert 'p_pct' in result
    assert 'd_pct' in result
    assert 'f_anomaly' in result
    assert 'dist_pct' in result
    assert result['p_pct'] > 0
    assert result['oeq'] > 0


def test_oeq_volume_dampening():
    """High volume surge (f_anomaly) should compress the OEQ tanh argument."""
    mod = _import_nuclear()
    prices = [100.0, 102.0, 104.0, 106.0, 108.0]
    normal_vols = [1000.0, 1000.0, 1000.0, 1000.0, 1000.0]
    surge_vols = [1000.0, 1000.0, 1000.0, 1000.0, 10000.0]
    open_price = 100.0
    sigma = 0.01
    lam = 0.005

    normal = mod.WecryptoNuclear._compute_oeq(prices, normal_vols, open_price, sigma, lam)
    surge = mod.WecryptoNuclear._compute_oeq(prices, surge_vols, open_price, sigma, lam)

    assert surge['f_anomaly'] > normal['f_anomaly']
    assert abs(surge['oeq']) <= abs(normal['oeq'])


def test_oeq_downtrend_negative_thrust():
    """Falling prices should produce negative p_pct (kinetic thrust)."""
    mod = _import_nuclear()
    prices = [110.0, 108.0, 106.0, 104.0, 102.0, 100.0, 98.0, 96.0]
    volumes = [1000.0] * 8
    result = mod.WecryptoNuclear._compute_oeq(prices, volumes, 110.0, 0.01, 0.005)
    assert result['p_pct'] < 0


def test_oeq_f_anomaly_clamped():
    """f_anomaly should be clamped between F_ANOMALY_FLOOR and F_ANOMALY_CEIL."""
    mod = _import_nuclear()
    prices = [100.0, 101.0, 102.0, 103.0, 104.0]
    volumes = [1.0, 1.0, 1.0, 1.0, 1000.0]
    result = mod.WecryptoNuclear._compute_oeq(prices, volumes, 100.0, 0.01, 0.005)
    assert result['f_anomaly'] <= mod.F_ANOMALY_CEIL

    volumes2 = [1000.0, 1000.0, 1000.0, 1000.0, 0.01]
    result2 = mod.WecryptoNuclear._compute_oeq(prices, volumes2, 100.0, 0.01, 0.005)
    assert result2['f_anomaly'] >= mod.F_ANOMALY_FLOOR


def test_nuclear_engine_init_dry_run():
    """Engine should accept dry_run=True for safety."""
    mod = _import_nuclear()
    engine = mod.WecryptoNuclear(dry_run=True)
    assert engine.dry_run is True


def test_nuclear_engine_state_memory():
    """Each asset should have independent state memory."""
    mod = _import_nuclear()
    engine = mod.WecryptoNuclear(dry_run=True)
    for asset in mod.ASSETS:
        state = engine.state_memory[asset]
        assert 'prices' in state
        assert 'volumes' in state
        assert state['prices'] == []
        assert state['volumes'] == []


def test_process_interval_buffers():
    """process_interval should append to rolling price/volume buffers."""
    mod = _import_nuclear()
    engine = mod.WecryptoNuclear(dry_run=True)
    asset = 'bitcoin'
    engine.process_interval(asset=asset, current_price=50000, open_price=49800,
                             interval_vol=1000, rolling_sigma=0.01)
    state = engine.state_memory[asset]
    assert len(state['prices']) == 1
    assert len(state['volumes']) == 1
    assert state['prices'][-1] == 50000
    assert state['volumes'][-1] == 1000


def test_process_interval_buffer_cap():
    """Buffers should cap at F_ANOMALY_WINDOW entries."""
    mod = _import_nuclear()
    engine = mod.WecryptoNuclear(dry_run=True)
    asset = 'bitcoin'
    for i in range(mod.F_ANOMALY_WINDOW + 5):
        engine.process_interval(asset=asset, current_price=50000 + i,
                                 open_price=49800, interval_vol=1000,
                                 rolling_sigma=0.01)
    state = engine.state_memory[asset]
    assert len(state['prices']) <= mod.F_ANOMALY_WINDOW
    assert len(state['volumes']) <= mod.F_ANOMALY_WINDOW


def test_kalshi_payload_format():
    """Kalshi payload should use fixed-point strings."""
    mod = _import_nuclear()
    engine = mod.WecryptoNuclear(dry_run=True)
    payload = engine._build_kalshi_payload('bitcoin', 'bid', 0.5500, count=10)
    assert payload['side'] == 'bid'
    assert payload['count'] == '10.00'
    assert payload['price'] == '0.5500'
    assert payload['time_in_force'] == 'immediate_or_cancel'
    assert 'client_order_id' in payload
    assert 'ticker' in payload


def test_execute_order_dry_run():
    """In dry-run mode, execute_order should return a dry_run dict, not fire."""
    mod = _import_nuclear()
    engine = mod.WecryptoNuclear(dry_run=True)
    payload = {'ticker': 'TEST', 'side': 'bid', 'price': '0.50', 'count': '5.00'}
    result = engine.execute_order(payload)
    assert result is not None
    assert result.get('dry_run') is True


def test_fetch_coinbase_ohlcv_function_exists():
    """The real OHLCV fetch function should exist and be callable."""
    mod = _import_nuclear()
    assert hasattr(mod, '_fetch_coinbase_ohlcv')
    assert callable(mod._fetch_coinbase_ohlcv)
    assert hasattr(mod, '_fetch_coinbase_price')
    assert callable(mod._fetch_coinbase_price)
    assert hasattr(mod, 'COINBASE_CANDLES')


def test_no_mock_data_in_run_loop():
    """The run_loop source should not contain mock/random OHLCV generation."""
    import inspect
    mod = _import_nuclear()
    source = inspect.getsource(mod.run_loop)
    assert 'mock_open' not in source
    assert 'mock_vol' not in source
    assert 'mock_sigma' not in source
    assert '_fetch_coinbase_ohlcv' in source
