import sys

with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1

for i, line in enumerate(lines):
    if 'const PER_COIN_INDICATOR_BIAS = {' in line:
        start_idx = i
        break

if start_idx != -1:
    # Find the end of this object definition
    brace_count = 0
    for i in range(start_idx, len(lines)):
        brace_count += lines[i].count('{')
        brace_count -= lines[i].count('}')
        if brace_count == 0:
            end_idx = i
            break

if start_idx != -1 and end_idx != -1:
    new_weights = """  const PER_COIN_INDICATOR_BIAS = {
    BTC: { // RETUNED 2026-05-28: MOMENTUM & MICROSTRUCTURE FIRST
      // Trend & Momentum (massively boosted to catch trends)
      momentum: 2.50,
      vwma: 2.00,
      obv: 1.50,
      hma: 1.20,
      supertrend: 1.50,
      
      // Microstructure / Orderbook (boosted to reflect live selling/buying pressure)
      book: 2.50,
      flow: 2.50,
      volume: 1.50,
      
      // Mean Reversion (suppressed to prevent catching falling knives)
      williamsR: 0.80,
      keltner: 0.60,
      fisher: 0.60,
      bands: 0.50,
      cci: 0.60,
      rsi: 0.50,
      
      // Structural
      structure: 0.80,
      vwap: 0.80,
      
      // Sentimental
      fearGreed: 1.2,
    },
    ETH: { // RETUNED 2026-05-28: MOMENTUM & MICROSTRUCTURE FIRST
      momentum: 2.20,
      vwma: 1.80,
      obv: 1.20,
      hma: 1.00,
      supertrend: 1.20,
      
      book: 2.20,
      flow: 2.20,
      volume: 1.20,
      
      williamsR: 0.80,
      keltner: 0.60,
      fisher: 0.60,
      bands: 0.50,
      cci: 0.60,
      rsi: 0.50,
      
      structure: 0.80,
      vwap: 1.10,
      
      fearGreed: 1.1,
    },
    SOL: { // RETUNED 2026-05-28: MOMENTUM & MICROSTRUCTURE FIRST
      momentum: 2.50,
      vwma: 1.80,
      obv: 1.50,
      hma: 1.00,
      supertrend: 1.50,
      
      book: 2.50,
      flow: 2.50,
      volume: 1.91,
      
      williamsR: 0.80,
      keltner: 0.60,
      fisher: 0.60,
      bands: 0.70,
      cci: 0.60,
      rsi: 0.50,
      
      structure: 1.00,
      vwap: 1.20,
      
      fearGreed: 1.0,
    },
    XRP: { // RETUNED 2026-05-28: MOMENTUM & MICROSTRUCTURE FIRST
      momentum: 2.00,
      vwma: 1.50,
      obv: 1.50,
      hma: 0.80,
      supertrend: 1.00,
      
      book: 2.00,
      flow: 2.00,
      volume: 1.50,
      
      williamsR: 0.80,
      keltner: 0.50,
      fisher: 0.60,
      bands: 0.50,
      cci: 0.60,
      rsi: 0.50,
      
      structure: 1.00,
      vwap: 1.50,
      
      fearGreed: 0.7,
    },
    HYPE: { // KEEP AS IS
      williamsR: 6.5, fisher: 5.0, cci: 4.5, bands: 3.0, keltner: 2.0, rsi: 1.5, stochrsi: 1.2, structure: 0.8,
      obv: 0.5, persistence: 0.4, vwap: 0.3, ema: 0.3, cmf: 0.3, adx: 0.3, ichimoku: 0.2, sma: 0.0, vwma: 0.2, supertrend: 0.1,
      momentum: 0.05, hma: 0.05, macd: 0.1, volume: 0.3, mfi: 0.3, fearGreed: 1.8,
    },
    DOGE: { // KEEP AS IS
      obv: 4.5, volume: 3.5, cmf: 3.0, bands: 2.5, mfi: 2.0, structure: 1.8, fisher: 1.8, keltner: 1.212, cci: 1.012, williamsR: 0.824,
      rsi: 0.5, persistence: 0.252, ema: 0.277, macd: 0.181, ichimoku: 0.177, adx: 0.105, hma: 0.296, sma: 0.0, supertrend: 0.197, vwap: 0.102,
      stochrsi: 0.068, momentum: 0.052, vwma: 0.029, fearGreed: 2.0,
    },
    BNB: { // KEEP AS IS
      sma: 5.0, mfi: 4.5, ema: 4.0, vwap: 3.5, hma: 3.0, vwma: 2.5, volume: 3.5,
      momentum: 2.0, persistence: 2.0, macd: 1.5, ichimoku: 2.0, supertrend: 2.0, cmf: 1.5, obv: 0.5, fisher: 0.831, cci: 0.34, adx: 0.505,
      structure: 0.065, keltner: 0.093, williamsR: 0.089, bands: 0.093, rsi: 0.071, stochrsi: 0.089, fearGreed: 0.8,
    },
  };\n"""
    
    lines[start_idx:end_idx+1] = [new_weights]
    
    with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print("SUCCESS")
else:
    print("Could not find PER_COIN_INDICATOR_BIAS block")
