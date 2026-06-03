---
layout: default
title: Home
---

# 🚀 WE-CRYPTO

## Self-Teaching Crypto Prediction Engine

Real-time UP/DOWN market direction predictions with **automatic adaptive learning**

<div style="text-align: center; margin: 40px 0;">
  <a href="https://github.com/JohnDaWalka/WE-CFM-Orchestrator" class="btn btn-primary">View on GitHub</a>
  <a href="./docs/" class="btn btn-secondary">Read Docs</a>
  <a href="./quickstart/" class="btn btn-success">Quick Start</a>
</div>

---

## ⚡ What Makes It Special

### 🧠 It Learns
Instead of static prediction weights, **WE-CRYPTO learns in real-time**:
- Analyzes accuracy of each signal (RSI, MACD, CCI, etc.)
- Automatically boosts high-accuracy signals (+5% per cycle)
- Automatically reduces low-accuracy signals (-5% per cycle)
- **Adapts weights every 2 minutes** based on live market performance

### 📊 It's Accurate
- Starting accuracy: **52-55%** vs 50% random
- After 1 week: **54-58%** with adaptive tuning
- Target: **60%+** in stable market regimes

### 🔗 It Integrates Everywhere
Pulls historical settlement data from:
- **Kalshi** — Prediction markets
- **Polymarket** — Crypto prediction contracts
- **Coinbase** — Prediction market data

### ⚙️ It Works Automatically
- 30-second polling cycle
- Real-time accuracy scorecard
- Automatic weight tuning (no manual intervention)
- Full debug panel in browser console

---

## 🎯 Key Features

| Feature | Details |
|---------|---------|
| **🎲 Predictions** | 15-minute UP/DOWN with confidence scores |
| **🧬 Multi-Signal** | RSI, MACD, CCI, Fisher, ADX, ATR + market signals |
| **📚 Historical Data** | 300+ settled contracts from 3 exchanges |
| **⚡ Real-Time** | 30-second polling, 60-second decision windows |
| **🎓 Auto-Learning** | Tuning every 2 minutes with trending detection |
| **🔐 Secure** | Electron IPC bridge, environment-based secrets |
| **📈 Dashboard** | Real-time accuracy trending + tuning logs |
| **🔧 Debug** | Console commands for inspection & manual tuning |

---

## 📈 Real-Time Accuracy Scorecard

```
Coin   Total   MODEL%   MKT%    Trend
─────────────────────────────────────
BTC    42      57% ↑    51%     ↑↑ 7/8
ETH    38      52% →    49%     → 4/8
SOL    35      61% ↑    54%     ↑↑ 6/8
XRP    39      48% ↓    50%     ↓↓ 3/8
DOGE   41      55% →    52%     → 5/8
```

---

## 🚀 Quick Start

### Installation

```bash
git clone https://github.com/JohnDaWalka/WE-CFM-Orchestrator.git
cd we-crypto
pnpm install
cp .env.example .env
# Edit .env with API credentials
pnpm run start:dev
```

### First Run
1. Opens prediction dashboard (http://localhost:3000)
2. Starts 30-second polling cycle
3. Fetches historical settled contracts (first 60 seconds)
4. Shows accuracy scorecard after ~120 seconds
5. Begins automatic weight tuning

### Production Deployment

```bash
pnpm run build:portable:release
# Result: dist/WE-CRYPTO-Kalshi-15m-v2.15.5-portable-<build-label>-x64.exe
# Deploy and run — no dependencies needed!
```

---

## 🧠 How It Works

### The Learning Loop

```
Fetch settled contracts (Kalshi, Polymarket, Coinbase)
         ↓
Calculate signal accuracy vs actual market outcome
         ↓
Identify high-accuracy signals (52%+)
         ↓
Identify low-accuracy signals (45%-)
         ↓
Boost high performers, reduce underperformers
         ↓
Next prediction uses new weights
         ↓
Repeat every 2 minutes
```

### Real-Time Example

```
Time: 14:32:00
- Fetch last 5 hours of settled markets
- RSI accuracy: 58% (20 contracts) → BOOST by 5%
- MACD accuracy: 42% (20 contracts) → REDUCE by 5%
- CCI accuracy: 50% (20 contracts) → HOLD (neutral)
- Fisher: 56% but trending down → REDUCE by 8% (faster)

Time: 14:34:00 (new prediction)
Uses new weights automatically!
```

---

## 📊 Architecture Overview

```
Historical Data Sources
(Kalshi, Polymarket, Coinbase)
         ↓
Historical Settlement Fetcher
         ↓
Accuracy Calculator
         ↓
Adaptive Learning Engine
         ↓
Weight Tuning (every 2 min)
         ↓
Signal Model
         ↓
Live Predictions (UP/DOWN + Confidence)
         ↓
Real-Time Dashboard
```

---

## 📚 Documentation

- **[🏗️ Architecture](./docs/ARCHITECTURE.md)** — System design with diagrams
- **[🧬 Signals](./docs/SIGNALS.md)** — All 9 indicators explained
- **[🎓 Learning Engine](./docs/LEARNING-ENGINE.md)** — Adaptive tuning deep dive
- **[📖 Full Index](./docs/INDEX.md)** — All documentation organized

---

## 💡 Console Commands

### Check Current Status
```javascript
window._historicalScorecard      // View accuracy scorecard
window._adaptiveWeights          // View current signal weights
window.AdaptiveLearner.getDiagnostics()  // Full diagnostics
```

### Manual Control
```javascript
window.AdaptiveLearner.autoTuneWeights()  // Force tuning
window.AdaptiveLearner.getAllReports()    // Get signal accuracy
window.AdaptiveLearner.reset()            // Reset learning
```

---

## 🎓 What's Current in v2.15.5

### 🔒 Release Hygiene & Clock Safety
- TimeAPI New York responses are converted with timezone-aware parsing
- Local start/build commands no longer run cloud checks implicitly
- Release/prod commands run cloud, Firebase, and secret-scan preflight explicitly
- Electron runtime and package builder versions are aligned

### ✨ Adaptive Learning System
- Historical settlement fetcher from Kalshi/Polymarket/Coinbase
- Automatic signal weight tuning every 2 minutes
- Per-signal accuracy tracking and trending
- Real-time accuracy scorecard
- Console debug commands

### 🔧 IPC Bridge Fix
- Restored context bridge for Kalshi API access
- Fixed `Cannot read properties of undefined (reading 'invoke')` error
- All three preload scripts updated

### 📊 Enhanced Dashboard
- Accuracy scorecard with MODEL%, MKT%, FADE%, TREND%
- Historical data integration
- Real-time tuning event logging

---

## 🔐 Security

✅ Credentials stored in environment variables  
✅ No API keys in source code  
✅ Electron IPC security hardening  
✅ All prediction data is public (Kalshi/Polymarket)  
✅ HTTPS only for API calls  

---

## 🤝 Contributing

We welcome contributions! Areas to enhance:

- [ ] Additional signal types (Volume, On-Chain, etc.)
- [ ] Machine learning optimization
- [ ] Multi-timeframe analysis
- [ ] Cross-coin correlation
- [ ] WebSocket live updates
- [ ] Video tutorials
- [ ] API client libraries

---

## 📞 Support

- **💬 GitHub Issues** — [Report bugs](https://github.com/JohnDaWalka/WE-CFM-Orchestrator/issues)
- **📖 Documentation** — [Read the docs](./docs/)
- **🐛 Troubleshooting** — [Common issues](./docs/TROUBLESHOOTING.md)

---

## 📜 License

MIT License — See [LICENSE](https://github.com/JohnDaWalka/WE-CFM-Orchestrator/blob/main/LICENSE)

---

<div style="text-align: center; margin-top: 60px; padding: 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 10px; color: white;">
  <h3>⚡ Ready to predict?</h3>
  <p>Deploy WE-CRYPTO and watch it learn in real-time</p>
  <a href="./docs/GETTING-STARTED.md" class="btn btn-light" style="margin-top: 20px;">Get Started Now</a>
</div>
