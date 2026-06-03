import sys

with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
    text = f.read()

helpers = """function calcCVD(candles, period) {
  const recent = candles.slice(-period);
  let cvd = 0;
  for (const c of recent) {
    const range = (c.h - c.l) || 0.0001;
    const body = c.c - c.o;
    const delta = (c.v || 0) * (body / range);
    cvd += delta;
  }
  return cvd;
}

function calcVolumeProfile(candles) {
  const profile = {};
  if (candles.length === 0) return profile;
  const step = candles[candles.length-1].c * 0.001;
  if (step === 0) return profile;
  for (const c of candles) {
    const bucket = Math.round(c.c / step) * step;
    profile[bucket] = (profile[bucket] || 0) + (c.v || 0);
  }
  return profile;
}

  function calcVWAP(candles) {"""

if 'function calcCVD' not in text:
    text = text.replace('  function calcVWAP(candles) {', helpers)
    with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
        f.write(text)
    print("Fixed missing helpers in predictions.js")
else:
    print("Helpers already exist.")
