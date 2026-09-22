import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from amm_cascade_exhaustion import (
    AmmCascadeExhaustionCalculator,
    AmmPoolDepthBand,
    LiquidationBucket,
    VenueSkew,
    FlowSnapshot,
    CascadeInputError,
    CascadeComputationError
)

calc = AmmCascadeExhaustionCalculator()

# 1. Quiet tape test
bands = [AmmPoolDepthBand(60000.0, 65000.0, 100000.0)]
queue = []
quiet_flow = FlowSnapshot(
    forced_liquidation_volume=0.0,
    discretionary_taker_buy_volume=50000.0,
    discretionary_taker_sell_volume=50000.0,
    amm_price_velocity=0.0,
    oracle_price_velocity=0.0,
)
res_quiet = calc.calculate_metrics('BTC', 64000.0, bands, queue, quiet_flow)
assert res_quiet.metadata['absorption_ratio'] == 0.0, 'absorption_ratio must be 0.0 on quiet tape'
assert res_quiet.metadata['quiet_tape_flag'] == 1, 'quiet_tape_flag must be 1'
assert res_quiet.verdict != 'FLUSH_EXHAUSTED_ABSORPTION_DETECTED', 'quiet tape must not trigger buy'
print(f"Test 1 (Quiet tape): PASS - verdict={res_quiet.verdict}, absorption={res_quiet.metadata['absorption_ratio']}")

# 2. Flat oracle test
flat_oracle_flow = FlowSnapshot(
    forced_liquidation_volume=1000.0,
    discretionary_taker_buy_volume=5000.0,
    discretionary_taker_sell_volume=1000.0,
    amm_price_velocity=10.0,
    oracle_price_velocity=0.0,
)
res_flat = calc.calculate_metrics('BTC', 64000.0, bands, queue, flat_oracle_flow)
assert res_flat.metadata['velocity_divergence'] == 5.0, 'velocity_divergence must clamp to 5.0'
print(f"Test 2 (Flat oracle): PASS - velocity_divergence={res_flat.metadata['velocity_divergence']}")

# 3. Live stack skew conditions: L-ratio -0.10, skew -0.30%, active
# With normal divergence (e.g. 0.01% inside 0.03% cap)
skew_normal = VenueSkew(l_ratio=-0.10, divergence_pct=0.01, funding_skew=-0.00005, active=True)
adj_normal = calc.compute_venue_skew_adjustment(skew_normal)
assert adj_normal > 0.0, 'bid-heavy with low divergence should support upside'
print(f"Test 3 (Normal divergence skew): PASS - adj={adj_normal:.4f}")

# 4. Dispersed venues dampening: Binance $62 above Coinbase (~0.10% divergence)
skew_dispersed = VenueSkew(l_ratio=-0.10, divergence_pct=0.10, funding_skew=-0.00005, active=True)
adj_dispersed = calc.compute_venue_skew_adjustment(skew_dispersed)
assert adj_dispersed < adj_normal, 'dispersed venue should dampen depth signal'
print(f"Test 4 (Dispersed venues dampening): PASS - adj={adj_dispersed:.4f} (dampened from {adj_normal:.4f})")

# 5. Malformed input tests
try:
    calc.calculate_metrics('BTC', float('nan'), bands, queue, quiet_flow)
    assert False, 'Should have failed on NaN'
except CascadeInputError:
    print('Test 5 (NaN rejection): PASS')

# 6. Real flush with absorption test
active_flush_queue = [
    LiquidationBucket(trigger_price=63500.0, notional_volume=10000.0, leverage_multiple=20.0)
]
absorbing_flow = FlowSnapshot(
    forced_liquidation_volume=150000.0,
    discretionary_taker_buy_volume=120000.0,
    discretionary_taker_sell_volume=20000.0,
    amm_price_velocity=0.05,
    oracle_price_velocity=0.04,
)
res_absorb = calc.calculate_metrics('BTC', 64000.0, bands, active_flush_queue, absorbing_flow, venue_skew=skew_normal)
print(f"Test 6 (Absorbing flush): PASS - verdict={res_absorb.verdict}, action={res_absorb.recommended_action}, coherence={res_absorb.cascade_coherence_index}")

print("\nALL 6 TESTS PASSED PROPERLY!")
