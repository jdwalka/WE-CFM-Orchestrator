import re
with open('/mnt/g/WECRYP/prediction_engine.py', 'r') as f:
    code = f.read()

# 1. lookback_hours: 168 -> 4380
code = code.replace("LOOKBACK_HOURS = 168", "LOOKBACK_HOURS = 4380")

# 2. fit_sample_size: 199 -> full 1m candle history (~260k rows, pyth_1m source)
# we can't easily fetch 260k 1m rows live. For now we fetch 4380 1h rows
code = code.replace("HOUR_SAMPLE_SIZE = 200", "HOUR_SAMPLE_SIZE = 4380")
code = code.replace("REGIME_LOOKBACK_HOURS = 24 * 30", "REGIME_LOOKBACK_HOURS = 4380")

# 3. "keep live_volatility_hours: 24" -> no change

with open('/mnt/g/WECRYP/prediction_engine.py', 'w') as f:
    f.write(code)
