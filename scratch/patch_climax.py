import sys

with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Replace VOL_CLIMAX_SELL
old_sell = """    // 8. VOL_CLIMAX_SELL
    if (n >= 22) {
      const avgVol = average(candles.slice(-21, -1).map(c => c.v || 0));
      const lastVol = candles[n - 1].v || 0;
      const volMult = avgVol > 0 ? lastVol / avgVol : 0;
      const lastBar = candles[n - 1];
      const body = absVal(lastBar.c - lastBar.o);
      const range = (lastBar.h - lastBar.l) || 0.00001;
      if (volMult >= 2.5 && lastBar.c < lastBar.o && body / range > 0.45) {
        const severity = volMult > 4 ? 'critical' : 'alert';
        flags.push({ id: 'VOL_CLIMAX_SELL', severity, bias: 'bullish', label: 'Vol Climax Sell', desc: `Volume ${volMult.toFixed(1)}x avg on large bearish bar — potential capitulation bottom`, strength: clamp(volMult / 6, 0.3, 0.9) });
      }
    }"""

new_sell = """    // 8. VOL_CLIMAX_SELL (FIXED: Respect Breakouts)
    if (n >= 22) {
      const avgVol = average(candles.slice(-21, -1).map(c => c.v || 0));
      const lastVol = candles[n - 1].v || 0;
      const volMult = avgVol > 0 ? lastVol / avgVol : 0;
      const lastBar = candles[n - 1];
      const body = absVal(lastBar.c - lastBar.o);
      const range = (lastBar.h - lastBar.l) || 0.00001;
      // Breakout Guard: If body fills >80% of range, it's a massive trend dump, NOT capitulation yet.
      // Exhaustion requires some wick rejection (body < 70% of range).
      if (volMult >= 2.5 && lastBar.c < lastBar.o && body / range > 0.45 && body / range <= 0.75) {
        const severity = volMult > 4 ? 'critical' : 'alert';
        flags.push({ id: 'VOL_CLIMAX_SELL', severity, bias: 'bullish', label: 'Vol Climax Sell', desc: `Volume ${volMult.toFixed(1)}x avg on large bearish bar with wick — potential capitulation bottom`, strength: clamp(volMult / 6, 0.3, 0.9) });
      }
    }"""

# Replace VOL_CLIMAX_BUY
old_buy = """    // 9. VOL_CLIMAX_BUY
    if (n >= 22) {
      const avgVol = average(candles.slice(-21, -1).map(c => c.v || 0));
      const lastVol = candles[n - 1].v || 0;
      const volMult = avgVol > 0 ? lastVol / avgVol : 0;
      const lastBar = candles[n - 1];
      const body = absVal(lastBar.c - lastBar.o);
      const range = (lastBar.h - lastBar.l) || 0.00001;
      if (volMult >= 2.5 && lastBar.c > lastBar.o && body / range > 0.45) {
        const severity = volMult > 4 ? 'critical' : 'alert';
        flags.push({ id: 'VOL_CLIMAX_BUY', severity, bias: 'bearish', label: 'Vol Climax Buy', desc: `Volume ${volMult.toFixed(1)}x avg on large bullish bar — potential euphoria top`, strength: clamp(volMult / 6, 0.3, 0.9) });
      }
    }"""

new_buy = """    // 9. VOL_CLIMAX_BUY (FIXED: Respect Breakouts)
    if (n >= 22) {
      const avgVol = average(candles.slice(-21, -1).map(c => c.v || 0));
      const lastVol = candles[n - 1].v || 0;
      const volMult = avgVol > 0 ? lastVol / avgVol : 0;
      const lastBar = candles[n - 1];
      const body = absVal(lastBar.c - lastBar.o);
      const range = (lastBar.h - lastBar.l) || 0.00001;
      // Breakout Guard: If body fills >80% of range, it's a massive short squeeze / trend continuation.
      // Exhaustion requires some wick rejection (body < 70% of range).
      if (volMult >= 2.5 && lastBar.c > lastBar.o && body / range > 0.45 && body / range <= 0.75) {
        const severity = volMult > 4 ? 'critical' : 'alert';
        flags.push({ id: 'VOL_CLIMAX_BUY', severity, bias: 'bearish', label: 'Vol Climax Buy', desc: `Volume ${volMult.toFixed(1)}x avg on large bullish bar with wick — potential euphoria top`, strength: clamp(volMult / 6, 0.3, 0.9) });
      }
    }"""

if old_sell in text:
    text = text.replace(old_sell, new_sell)
    print("Patched VOL_CLIMAX_SELL")
else:
    print("Could not find VOL_CLIMAX_SELL block")

if old_buy in text:
    text = text.replace(old_buy, new_buy)
    print("Patched VOL_CLIMAX_BUY")
else:
    print("Could not find VOL_CLIMAX_BUY block")

with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
    f.write(text)
