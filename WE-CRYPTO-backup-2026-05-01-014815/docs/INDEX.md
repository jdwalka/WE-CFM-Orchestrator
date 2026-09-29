# 📚 WE-CRYPTO Documentation Index

Complete guide to understanding, deploying, and extending the self-teaching prediction engine.

---

## 🚀 Quick Navigation

### For First-Time Users
1. **[README.md](../README.md)** — Start here! Landing page with overview
2. **[Getting Started](./GETTING-STARTED.md)** — Installation and first run
3. **[Dashboard Guide](./DASHBOARD.md)** — Understanding the UI

### For Developers
1. **[Architecture](./ARCHITECTURE.md)** — System design with Mermaid diagrams
2. **[Signals](./SIGNALS.md)** — How each indicator works
3. **[Learning Engine](./LEARNING-ENGINE.md)** — Adaptive tuning deep dive
4. **[API Reference](./API.md)** — Console commands and endpoints

### For Operations
1. **[Deployment](./DEPLOYMENT.md)** — Production setup
2. **[Configuration](./CONFIGURATION.md)** — Environment variables and settings
3. **[Troubleshooting](./TROUBLESHOOTING.md)** — Common issues and fixes
4. **[Performance](./PERFORMANCE.md)** — Monitoring and metrics

### For Contributors
1. **[Contributing](../CONTRIBUTING.md)** — How to contribute
2. **[Development Setup](./DEVELOPMENT.md)** — Setting up dev environment
3. **[Testing](./TESTING.md)** — Running and writing tests

---

## 📖 Documentation Structure

### Core Documentation

#### [README.md](../README.md)
- **What it is:** Landing page with overview
- **Audience:** Everyone
- **Read time:** 5 min
- **Key sections:** Features, quick start, architecture diagrams

#### [GETTING-STARTED.md](./GETTING-STARTED.md)
- **What it is:** Installation and setup guide
- **Audience:** New users
- **Read time:** 10 min
- **Key sections:** Prerequisites, installation, first run, troubleshooting

#### [ARCHITECTURE.md](./ARCHITECTURE.md)
- **What it is:** System design with detailed Mermaid diagrams
- **Audience:** Developers, architects
- **Read time:** 15 min
- **Key sections:**
  - System overview flow
  - Three-layer learning stack
  - Real-time polling cycle
  - Signal architecture
  - Data flow diagrams

#### [SIGNALS.md](./SIGNALS.md)
- **What it is:** Deep dive into each indicator
- **Audience:** Developers, quants
- **Read time:** 20 min
- **Key sections:**
  - RSI (overbought/sold detection)
  - MACD (momentum)
  - CCI (mean reversion)
  - Fisher Transform
  - ADX (trend strength)
  - ATR (volatility)
  - Order book imbalance
  - Kalshi probability extraction
  - Crowd fade detection

#### [LEARNING-ENGINE.md](./LEARNING-ENGINE.md)
- **What it is:** How adaptive tuning works
- **Audience:** Developers, ML engineers
- **Read time:** 20 min
- **Key sections:**
  - Signal accuracy tracking
  - Weight adjustment algorithm
  - Trending detection
  - Audit trail logging
  - Three-tier learning (real-time, snapshot, walk-forward)

#### [API.md](./API.md)
- **What it is:** Console commands and debugging
- **Audience:** Developers, traders
- **Read time:** 10 min
- **Key sections:**
  - Historical scorecard API
  - Adaptive weights API
  - Learning diagnostics
  - Manual tuning commands
  - Debug helpers

#### [DASHBOARD.md](./DASHBOARD.md)
- **What it is:** UI guide and interpretation
- **Audience:** Traders, analysts
- **Read time:** 10 min
- **Key sections:**
  - Accuracy scorecard
  - Trending analysis
  - Confidence visualization
  - Real-time updates
  - Status indicators

#### [CONFIGURATION.md](./CONFIGURATION.md)
- **What it is:** Environment setup and tuning parameters
- **Audience:** DevOps, sysadmins
- **Read time:** 15 min
- **Key sections:**
  - Environment variables
  - API credentials
  - Tuning parameters
  - Gate thresholds
  - Signal weights

#### [DEPLOYMENT.md](./DEPLOYMENT.md)
- **What it is:** Production deployment guide
- **Audience:** DevOps, infrastructure
- **Read time:** 15 min
- **Key sections:**
  - Build process
  - Pre-deployment checks
  - Staging validation
  - Production rollout
  - Monitoring setup

#### [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- **What it is:** Common issues and solutions
- **Audience:** Everyone
- **Read time:** 10 min
- **Key sections:**
  - "No settled data" errors
  - Weights not updating
  - Low accuracy
  - Network issues
  - Performance problems

#### [PERFORMANCE.md](./PERFORMANCE.md)
- **What it is:** Metrics, benchmarking, optimization
- **Audience:** Analysts, DevOps
- **Read time:** 15 min
- **Key sections:**
  - Expected accuracy timeline
  - Per-coin benchmarks
  - Historical performance
  - Profit factor analysis
  - Optimization tips

#### [TESTING.md](./TESTING.md)
- **What it is:** Running and writing tests
- **Audience:** Developers
- **Read time:** 10 min
- **Key sections:**
  - Running tests
  - Test structure
  - Writing new tests
  - Backtest validation

#### [DEVELOPMENT.md](./DEVELOPMENT.md)
- **What it is:** Setting up development environment
- **Audience:** Contributors
- **Read time:** 10 min
- **Key sections:**
  - Node.js setup
  - Dependencies
  - Dev server
  - Hot reload
  - Debug tools

---

## 🎯 Use Case Guides

### I want to...

#### ...understand the system at a glance
→ [README.md](../README.md) + [ARCHITECTURE.md](./ARCHITECTURE.md)

#### ...get it running locally
→ [GETTING-STARTED.md](./GETTING-STARTED.md)

#### ...deploy to production
→ [DEPLOYMENT.md](./DEPLOYMENT.md) + [CONFIGURATION.md](./CONFIGURATION.md)

#### ...debug an accuracy issue
→ [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) + [API.md](./API.md)

#### ...understand how signals work
→ [SIGNALS.md](./SIGNALS.md)

#### ...understand adaptive learning
→ [LEARNING-ENGINE.md](./LEARNING-ENGINE.md)

#### ...monitor performance
→ [PERFORMANCE.md](./PERFORMANCE.md) + [DASHBOARD.md](./DASHBOARD.md)

#### ...contribute improvements
→ [Contributing](../CONTRIBUTING.md) + [DEVELOPMENT.md](./DEVELOPMENT.md)

#### ...write a new signal
→ [SIGNALS.md](./SIGNALS.md) + [DEVELOPMENT.md](./DEVELOPMENT.md)

#### ...optimize parameters
→ [CONFIGURATION.md](./CONFIGURATION.md) + [PERFORMANCE.md](./PERFORMANCE.md)

---

## 📊 Architecture Overview

```
Historical Data
(Kalshi, Polymarket, Coinbase)
        ↓
Historical Settlement Fetcher
(fetches settled contracts)
        ↓
Accuracy Calculator
(model vs actual)
        ↓
Adaptive Learning Engine
(measures signal accuracy)
        ↓
Auto-Tuning (every 2 min)
(adjusts weights)
        ↓
Signal Model
(uses new weights)
        ↓
Live Predictions
(UP/DOWN with confidence)
        ↓
Dashboard & Console
(real-time visualization)
```

---

## 🔄 Learning Cycle

```
30 seconds:  Fetch historical contracts
120 seconds: Calculate accuracy per signal
120 seconds: Auto-tune weights (if 2 min passed)
             Boost 52%+ signals, reduce 45%- signals
∞:           Use new weights in predictions
```

---

## 📁 File Organization

```
docs/
├── INDEX.md                      ← You are here
├── README.md                     ← Main landing page (in root)
├── GETTING-STARTED.md            ← Installation & first run
├── ARCHITECTURE.md               ← System design + Mermaid diagrams
├── SIGNALS.md                    ← Signal details
├── LEARNING-ENGINE.md            ← Adaptive tuning algorithm
├── API.md                        ← Console commands
├── DASHBOARD.md                  ← UI guide
├── CONFIGURATION.md              ← Environment setup
├── DEPLOYMENT.md                 ← Production guide
├── TROUBLESHOOTING.md            ← Common issues
├── PERFORMANCE.md                ← Metrics & benchmarks
├── TESTING.md                    ← Testing guide
└── DEVELOPMENT.md                ← Dev environment setup
```

---

## 🚀 Quick Links

### Start Here
- [README.md](../README.md) — Overview
- [GETTING-STARTED.md](./GETTING-STARTED.md) — Setup

### Core Concepts
- [ARCHITECTURE.md](./ARCHITECTURE.md) — System design
- [LEARNING-ENGINE.md](./LEARNING-ENGINE.md) — How it learns
- [SIGNALS.md](./SIGNALS.md) — Indicators explained

### How-To Guides
- [API.md](./API.md) — Console commands
- [CONFIGURATION.md](./CONFIGURATION.md) — Setup
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Deploy
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Debug

### Reference
- [PERFORMANCE.md](./PERFORMANCE.md) — Metrics
- [DASHBOARD.md](./DASHBOARD.md) — UI
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Dev setup
- [TESTING.md](./TESTING.md) — Tests

---

## 📞 Support

- **Questions?** Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- **API help?** See [API.md](./API.md)
- **Performance?** Review [PERFORMANCE.md](./PERFORMANCE.md)
- **Deployment?** Read [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## ✅ Checklist: Where to Read Next

- [ ] Read [README.md](../README.md) (5 min)
- [ ] Skim [ARCHITECTURE.md](./ARCHITECTURE.md) (10 min)
- [ ] Review [GETTING-STARTED.md](./GETTING-STARTED.md) (10 min)
- [ ] Explore [LEARNING-ENGINE.md](./LEARNING-ENGINE.md) (15 min)
- [ ] Bookmark [API.md](./API.md) for reference
- [ ] Familiarize with [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

---

**Last Updated:** 2026-05-01  
**Version:** 2.11.0-adaptive-learning  
**Status:** Production-ready
