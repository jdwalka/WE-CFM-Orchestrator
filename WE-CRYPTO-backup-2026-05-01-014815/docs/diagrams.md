# System Diagrams (SVG Format - Mobile Friendly)

These diagrams render on all devices including iPhone.

---

## 1. Core Cycle: 30-Second Learning Loop

```svg
<svg viewBox="0 0 1000 150" xmlns="http://www.w3.org/2000/svg">
  <!-- Define gradients -->
  <defs>
    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#1e90ff;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0066cc;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="grad2" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#228b22;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#00aa00;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="grad3" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#ff8c00;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#ff6600;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="grad4" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#9370db;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#7744aa;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="grad5" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#20b2aa;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#008888;stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <!-- Box 1: Fetch -->
  <rect x="20" y="30" width="120" height="80" fill="url(#grad1)" rx="5" stroke="#000" stroke-width="2"/>
  <text x="80" y="65" text-anchor="middle" fill="white" font-size="12" font-weight="bold">📊 Fetch</text>
  <text x="80" y="85" text-anchor="middle" fill="white" font-size="10">Historical Markets</text>
  <text x="80" y="100" text-anchor="middle" fill="white" font-size="9">(Every 30s)</text>
  
  <!-- Arrow 1 -->
  <path d="M 140 70 L 170 70" stroke="#333" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>
  <text x="155" y="65" text-anchor="middle" fill="#666" font-size="9">Settlement</text>
  
  <!-- Box 2: Calculate -->
  <rect x="170" y="30" width="120" height="80" fill="url(#grad2)" rx="5" stroke="#000" stroke-width="2"/>
  <text x="230" y="65" text-anchor="middle" fill="white" font-size="12" font-weight="bold">🧮 Calculate</text>
  <text x="230" y="85" text-anchor="middle" fill="white" font-size="10">Signal Accuracy</text>
  <text x="230" y="100" text-anchor="middle" fill="white" font-size="9">Per Coin</text>
  
  <!-- Arrow 2 -->
  <path d="M 290 70 L 320 70" stroke="#333" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>
  <text x="305" y="65" text-anchor="middle" fill="#666" font-size="9">Win Rate %</text>
  
  <!-- Box 3: Tune -->
  <rect x="320" y="30" width="120" height="80" fill="url(#grad3)" rx="5" stroke="#000" stroke-width="2"/>
  <text x="380" y="65" text-anchor="middle" fill="white" font-size="12" font-weight="bold">📈 Auto-Tune</text>
  <text x="380" y="85" text-anchor="middle" fill="white" font-size="10">Weights</text>
  <text x="380" y="100" text-anchor="middle" fill="white" font-size="9">Boost/Reduce</text>
  
  <!-- Arrow 3 -->
  <path d="M 440 70 L 470 70" stroke="#333" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>
  <text x="455" y="65" text-anchor="middle" fill="#666" font-size="9">New Weights</text>
  
  <!-- Box 4: Predict -->
  <rect x="470" y="30" width="120" height="80" fill="url(#grad4)" rx="5" stroke="#000" stroke-width="2"/>
  <text x="530" y="65" text-anchor="middle" fill="white" font-size="12" font-weight="bold">🎲 Predict</text>
  <text x="530" y="85" text-anchor="middle" fill="white" font-size="10">Generate</text>
  <text x="530" y="100" text-anchor="middle" fill="white" font-size="9">UP/DOWN</text>
  
  <!-- Arrow 4 -->
  <path d="M 590 70 L 620 70" stroke="#333" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>
  <text x="605" y="65" text-anchor="middle" fill="#666" font-size="9">Display</text>
  
  <!-- Box 5: Display -->
  <rect x="620" y="30" width="120" height="80" fill="url(#grad5)" rx="5" stroke="#000" stroke-width="2"/>
  <text x="680" y="65" text-anchor="middle" fill="white" font-size="12" font-weight="bold">✅ User Sees</text>
  <text x="680" y="85" text-anchor="middle" fill="white" font-size="10">Real-Time Card</text>
  <text x="680" y="100" text-anchor="middle" fill="white" font-size="9">Portfolio WR</text>
  
  <!-- Feedback arrow (curved) -->
  <path d="M 680 110 Q 400 200 80 110" stroke="#ff0000" stroke-width="2" fill="none" stroke-dasharray="5,5" marker-end="url(#arrowhead-red)"/>
  <text x="380" y="180" text-anchor="middle" fill="#ff0000" font-size="10" font-weight="bold">Feedback Loop</text>
  
  <!-- Arrow markers -->
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#333" />
    </marker>
    <marker id="arrowhead-red" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#ff0000" />
    </marker>
  </defs>
</svg>
```

---

## 2. Three-Layer Adaptive Stack

```svg
<svg viewBox="0 0 800 300" xmlns="http://www.w3.org/2000/svg">
  <!-- Real-Time Layer -->
  <rect x="20" y="20" width="240" height="100" fill="#ffcccc" rx="8" stroke="#cc0000" stroke-width="3"/>
  <text x="140" y="45" text-anchor="middle" font-size="14" font-weight="bold">🔴 Real-Time (30s)</text>
  <text x="140" y="70" text-anchor="middle" font-size="11">• Poll Markets</text>
  <text x="140" y="90" text-anchor="middle" font-size="11">• Rapid Accuracy Check</text>
  <text x="140" y="110" text-anchor="middle" font-size="11">• Fast Gate Adjust ±4-8%</text>
  
  <!-- Snapshot Layer -->
  <rect x="280" y="20" width="240" height="100" fill="#ffe6cc" rx="8" stroke="#ff8800" stroke-width="3"/>
  <text x="400" y="45" text-anchor="middle" font-size="14" font-weight="bold">🟠 Snapshot (1h)</text>
  <text x="400" y="70" text-anchor="middle" font-size="11">• Aggregate 60 min</text>
  <text x="400" y="90" text-anchor="middle" font-size="11">• Market Regime Detection</text>
  <text x="400" y="110" text-anchor="middle" font-size="11">• Weight Tuning ±8%</text>
  
  <!-- Walk-Forward Layer -->
  <rect x="540" y="20" width="240" height="100" fill="#ffffcc" rx="8" stroke="#cccc00" stroke-width="3"/>
  <text x="660" y="45" text-anchor="middle" font-size="14" font-weight="bold">🟡 Walk-Forward (daily)</text>
  <text x="660" y="70" text-anchor="middle" font-size="11">• 14-day Window</text>
  <text x="660" y="90" text-anchor="middle" font-size="11">• Baseline Optimization</text>
  <text x="660" y="110" text-anchor="middle" font-size="11">• Seasonal Adjust</text>
  
  <!-- Arrows down -->
  <path d="M 140 120 L 140 160" stroke="#333" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>
  <path d="M 400 120 L 400 160" stroke="#333" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>
  <path d="M 660 120 L 660 160" stroke="#333" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>
  
  <!-- Central Processing Box -->
  <rect x="200" y="160" width="400" height="80" fill="#e6f3ff" rx="8" stroke="#0066cc" stroke-width="3"/>
  <text x="400" y="185" text-anchor="middle" font-size="13" font-weight="bold">🎲 Generate Live Predictions</text>
  <text x="400" y="210" text-anchor="middle" font-size="11">Aggregate all 3 layers</text>
  <text x="400" y="230" text-anchor="middle" font-size="11">Apply regime filters & gates</text>
  
  <!-- Arrow to Scorecard -->
  <path d="M 400 240 L 400 270" stroke="#333" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>
  
  <!-- Bottom Boxes -->
  <rect x="150" y="270" width="150" height="25" fill="#ccffcc" rx="5" stroke="#00cc00" stroke-width="2"/>
  <text x="225" y="287" text-anchor="middle" font-size="11" font-weight="bold">📊 Accuracy Scorecard</text>
  
  <rect x="320" y="270" width="160" height="25" fill="#ffccff" rx="5" stroke="#cc00cc" stroke-width="2"/>
  <text x="400" y="287" text-anchor="middle" font-size="11" font-weight="bold">🧠 Learning Engine</text>
  
  <rect x="490" y="270" width="150" height="25" fill="#ffcccc" rx="5" stroke="#cc0000" stroke-width="2"/>
  <text x="565" y="287" text-anchor="middle" font-size="11" font-weight="bold">Feedback Loop ↑</text>
  
  <!-- Arrow markers -->
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#333" />
    </marker>
  </defs>
</svg>
```

---

## 3. Signal Flow: 9 Indicators to Score

```svg
<svg viewBox="0 0 900 400" xmlns="http://www.w3.org/2000/svg">
  <!-- Inputs -->
  <g id="inputs">
    <rect x="20" y="20" width="100" height="60" fill="#e6f3ff" rx="5" stroke="#0066cc" stroke-width="2"/>
    <text x="70" y="40" text-anchor="middle" font-size="11" font-weight="bold">Close Price</text>
    <text x="70" y="60" text-anchor="middle" font-size="10">C</text>
  </g>
  
  <g id="inputs">
    <rect x="130" y="20" width="100" height="60" fill="#e6f3ff" rx="5" stroke="#0066cc" stroke-width="2"/>
    <text x="180" y="40" text-anchor="middle" font-size="11" font-weight="bold">High/Low</text>
    <text x="180" y="60" text-anchor="middle" font-size="10">H,L</text>
  </g>
  
  <g id="inputs">
    <rect x="240" y="20" width="100" height="60" fill="#e6f3ff" rx="5" stroke="#0066cc" stroke-width="2"/>
    <text x="290" y="40" text-anchor="middle" font-size="11" font-weight="bold">Volume</text>
    <text x="290" y="60" text-anchor="middle" font-size="10">V</text>
  </g>
  
  <g id="inputs">
    <rect x="350" y="20" width="100" height="60" fill="#e6f3ff" rx="5" stroke="#0066cc" stroke-width="2"/>
    <text x="400" y="40" text-anchor="middle" font-size="11" font-weight="bold">Book Pressure</text>
    <text x="400" y="60" text-anchor="middle" font-size="10">BP</text>
  </g>
  
  <!-- Indicators Layer -->
  <g id="indicators">
    <rect x="20" y="120" width="80" height="60" fill="#fff0f5" rx="5" stroke="#cc0066" stroke-width="2"/>
    <text x="60" y="135" text-anchor="middle" font-size="10" font-weight="bold">RSI</text>
    <text x="60" y="155" text-anchor="middle" font-size="9">Momentum</text>
    
    <rect x="110" y="120" width="80" height="60" fill="#fff0f5" rx="5" stroke="#cc0066" stroke-width="2"/>
    <text x="150" y="135" text-anchor="middle" font-size="10" font-weight="bold">MACD</text>
    <text x="150" y="155" text-anchor="middle" font-size="9">Trend</text>
    
    <rect x="200" y="120" width="80" height="60" fill="#fff0f5" rx="5" stroke="#cc0066" stroke-width="2"/>
    <text x="240" y="135" text-anchor="middle" font-size="10" font-weight="bold">CCI</text>
    <text x="240" y="155" text-anchor="middle" font-size="9">Cycles</text>
    
    <rect x="290" y="120" width="80" height="60" fill="#fff0f5" rx="5" stroke="#cc0066" stroke-width="2"/>
    <text x="330" y="135" text-anchor="middle" font-size="10" font-weight="bold">Fisher</text>
    <text x="330" y="155" text-anchor="middle" font-size="9">Reversal</text>
    
    <rect x="380" y="120" width="80" height="60" fill="#fff0f5" rx="5" stroke="#cc0066" stroke-width="2"/>
    <text x="420" y="135" text-anchor="middle" font-size="10" font-weight="bold">ADX</text>
    <text x="420" y="155" text-anchor="middle" font-size="9">Strength</text>
    
    <rect x="470" y="120" width="80" height="60" fill="#fff0f5" rx="5" stroke="#cc0066" stroke-width="2"/>
    <text x="510" y="135" text-anchor="middle" font-size="10" font-weight="bold">ATR</text>
    <text x="510" y="155" text-anchor="middle" font-size="9">Volatility</text>
    
    <rect x="560" y="120" width="80" height="60" fill="#fff0f5" rx="5" stroke="#cc0066" stroke-width="2"/>
    <text x="600" y="135" text-anchor="middle" font-size="10" font-weight="bold">OB</text>
    <text x="600" y="155" text-anchor="middle" font-size="9">Imbalance</text>
    
    <rect x="650" y="120" width="80" height="60" fill="#fff0f5" rx="5" stroke="#cc0066" stroke-width="2"/>
    <text x="690" y="135" text-anchor="middle" font-size="10" font-weight="bold">Kalshi %</text>
    <text x="690" y="155" text-anchor="middle" font-size="9">Market Prob</text>
    
    <rect x="740" y="120" width="80" height="60" fill="#fff0f5" rx="5" stroke="#cc0066" stroke-width="2"/>
    <text x="780" y="135" text-anchor="middle" font-size="10" font-weight="bold">Fade</text>
    <text x="780" y="155" text-anchor="middle" font-size="9">Contrarian</text>
  </g>
  
  <!-- Weighting Layer -->
  <g id="weights">
    <text x="60" y="210" text-anchor="middle" font-size="9" font-weight="bold">×1.2</text>
    <text x="150" y="210" text-anchor="middle" font-size="9" font-weight="bold">×0.9</text>
    <text x="240" y="210" text-anchor="middle" font-size="9" font-weight="bold">×1.0</text>
    <text x="330" y="210" text-anchor="middle" font-size="9" font-weight="bold">×1.1</text>
    <text x="420" y="210" text-anchor="middle" font-size="9" font-weight="bold">×0.8</text>
    <text x="510" y="210" text-anchor="middle" font-size="9" font-weight="bold">×1.05</text>
    <text x="600" y="210" text-anchor="middle" font-size="9" font-weight="bold">×1.3</text>
    <text x="690" y="210" text-anchor="middle" font-size="9" font-weight="bold">×1.15</text>
    <text x="780" y="210" text-anchor="middle" font-size="9" font-weight="bold">×0.95</text>
  </g>
  
  <!-- Aggregation Box -->
  <rect x="250" y="240" width="350" height="80" fill="#f0fff0" rx="8" stroke="#00cc00" stroke-width="3"/>
  <text x="425" y="265" text-anchor="middle" font-size="12" font-weight="bold">⚖️ Aggregation</text>
  <text x="425" y="290" text-anchor="middle" font-size="10">Weighted Sum + Regime Filter + Gate Check</text>
  <text x="425" y="310" text-anchor="middle" font-size="10">Apply regime-specific adjustments</text>
  
  <!-- Output -->
  <rect x="300" y="340" width="120" height="50" fill="#ffcccc" rx="5" stroke="#cc0000" stroke-width="2"/>
  <text x="360" y="360" text-anchor="middle" font-size="11" font-weight="bold">Score 0-100</text>
  <text x="360" y="380" text-anchor="middle" font-size="9">Confidence</text>
  
  <rect x="480" y="340" width="120" height="50" fill="#ffcccc" rx="5" stroke="#cc0000" stroke-width="2"/>
  <text x="540" y="360" text-anchor="middle" font-size="11" font-weight="bold">Direction</text>
  <text x="540" y="380" text-anchor="middle" font-size="9">UP or DOWN</text>
  
  <!-- Arrows -->
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#333" />
    </marker>
  </defs>
  
  <!-- Input to Indicator arrows -->
  <line x1="70" y1="80" x2="60" y2="120" stroke="#999" stroke-width="1" marker-end="url(#arrowhead)"/>
  <line x1="180" y1="80" x2="150" y2="120" stroke="#999" stroke-width="1" marker-end="url(#arrowhead)"/>
  <line x1="290" y1="80" x2="240" y2="120" stroke="#999" stroke-width="1" marker-end="url(#arrowhead)"/>
  <line x1="400" y1="80" x2="330" y2="120" stroke="#999" stroke-width="1" marker-end="url(#arrowhead)"/>
  
  <!-- Indicator to Aggregation -->
  <line x1="60" y1="180" x2="350" y2="240" stroke="#999" stroke-width="1" marker-end="url(#arrowhead)"/>
  <line x1="780" y1="180" x2="500" y2="240" stroke="#999" stroke-width="1" marker-end="url(#arrowhead)"/>
  
  <!-- Aggregation to Output -->
  <line x1="360" y1="320" x2="360" y2="340" stroke="#999" stroke-width="2" marker-end="url(#arrowhead)"/>
  <line x1="480" y1="320" x2="540" y2="340" stroke="#999" stroke-width="2" marker-end="url(#arrowhead)"/>
</svg>
```

---

## 4. 30-Second Polling Timeline

```
┌─ 0s ──┬── 5s ──┬── 10s ──┬── 15s ──┬── 20s ──┬── 25s ──┬── 30s ──┐
│       │        │         │         │         │         │         │
│ Start │ Fetch  │ Parse   │ Calc    │ Record  │ Check   │ Display │
│       │Kalshi  │ Results │Accuracy │Contrib  │Tuning?  │Results  │
│       │Poly    │         │         │         │(2-min)  │         │
│       │Coinbase│         │         │         │         │         │
│       │        │         │         │         │         │         │
└───────┴────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
        Fetcher Phase          Learner Phase      Display Phase
        (5-10s)                (10-20s)           (25-30s)

Every 2 minutes (120 seconds):
├─ 120s: AUTO-TUNE WEIGHTS
│  ├─ Boost high-accuracy signals (+5%)
│  ├─ Reduce low-accuracy signals (-5%)
│  └─ Apply trending acceleration (×1.5 or ×1.3)
│
├─ 150s: NEXT PREDICTION CYCLE USES NEW WEIGHTS
│
└─ 180s: REPEAT
```

---

## 5. Adaptive Learning Loop

```
STEP 1: Fetch Historical Markets (every 30s)
│
├─ Kalshi API: /markets?status=settled
├─ Polymarket API: resolved contracts
└─ Coinbase API: prediction outcomes
         │
         ↓
STEP 2: Calculate Accuracy Per Coin
│
├─ Compare model prediction to market outcome
├─ Track: RSI accuracy, MACD accuracy, CCI accuracy... (9 total)
└─ Maintain rolling history (last 20 samples per signal)
         │
         ↓
STEP 3: Every 2 Minutes — Check Signal Performance
│
├─ RSI: 58% WR (20 samples) → OUTPERFORMER ✅
├─ MACD: 42% WR (20 samples) → UNDERPERFORMER ❌
├─ CCI: 50% WR (20 samples) → NEUTRAL ⏸️
└─ Fisher: 56% WR, trending DOWN (-5% last hour) → PENALIZE ❌
         │
         ↓
STEP 4: Apply Tuning Rules
│
├─ IF WR > 55%: BOOST by 5%
│  └─ IF trend improving +5%: Apply ×1.5 acceleration
│
├─ IF WR < 45%: REDUCE by 5%
│  └─ IF trend degrading -5%: Apply ×1.3 penalty
│
└─ IF 45-55%: HOLD current weight
         │
         ↓
STEP 5: Update Weights (apply 0.3x minimum, 2.0x maximum caps)
│
├─ window._adaptiveWeights updated
├─ Tuning event logged
└─ Next prediction uses new weights IMMEDIATELY
         │
         ↓
STEP 6: Next Prediction (30s cycle)
│
├─ All 9 signals calculated
├─ New weights applied
└─ Score updated
         │
         ↓
STEP 7: Compare to Market Outcome
│
├─ Prediction vs actual market result
├─ Accuracy recorded
└─ LOOP BACK to STEP 1 (every 30s)
```

---

## Summary

**All diagrams are now in SVG format — fully compatible with iPhone and all mobile devices!**

- ✅ Renders on Safari (iPhone)
- ✅ Renders on Chrome/Firefox (Android)
- ✅ Renders on desktop browsers
- ✅ No external dependencies
- ✅ Embedded directly in markdown

Use these diagrams instead of Mermaid for better mobile support.
