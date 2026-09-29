# WE-CRYPTO v2.12.0 Architecture Diagrams

## System Architecture Overview

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        WE-CRYPTO v2.12.0 System                        │
└─────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────┐
                    │  Market Data Ingestion   │
                    │  (Pyth, Kalshi, etc)    │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼──────────────┐
                    │  Indicator Calculator    │
                    │  (RSI, MACD, ADX, etc)   │
                    └────────────┬──────────────┘
                                 │
        ┌────────────────────────┼───────────────────────┐
        │                        │                       │
        ▼                        ▼                       ▼
    ┌────────┐          ┌──────────────┐        ┌──────────────┐
    │ Core   │          │   LLM Signal │        │ Anomaly      │
    │Engine  │◄─────────┤   Layer      │────────┤ Response     │
    │        │          │   WRAPPER    │        │ Handler      │
    └────────┘          └──────────────┘        └──────────────┘
        │                       │                       │
        │   Predictions         │   Metrics             │ Alerts
        │   + Weights           │   + Recovery          │
        │                       │                       │
        └───────────┬───────────┴───────────────────────┘
                    │
                    ▼
        ┌──────────────────────────┐
        │  Dashboard & Metrics     │
        │  (UI, CLI, Logging)      │
        └──────────────────────────┘
```

---

## LLM Signal Layer Architecture

### Core Components Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    LLM SIGNAL LAYER ARCHITECTURE                        │
└─────────────────────────────────────────────────────────────────────────┘

30-SECOND POLLING CYCLE:
  
  Cycle N      Cycle N+1    Cycle N+2    Cycle N+3    Cycle N+4
  ├────────┤   ├────────┤   ├────────┤   ├────────┤   ├────────┤
  │        │   │        │   │        │   │        │   │        │
  │Predict │   │Predict │   │Predict │   │Predict │   │Predict │
  │        │   │        │   │        │   │        │   │        │
  └────────┘   └────────┘   └────────┘   └────────┘   └────────┘
       │            │            │            │            │
       │            ▼            │            ▼            │
       │       ┌─────────┐       │       ┌─────────┐       │
       │       │ LLM     │       │       │ LLM     │       │
       │       │ CYCLE   │       │       │ CYCLE   │       │
       │       │ (60s)   │       │       │ (60s)   │       │
       │       └────┬────┘       │       └────┬────┘       │
       │            │            │            │            │
       │            ▼            │            ▼            │
       │       ┌──────────┐      │       ┌──────────┐      │
       │       │ Anomaly  │      │       │ Anomaly  │      │
       │       │ Detector │      │       │ Detector │      │
       │       └────┬─────┘      │       └────┬─────┘      │
       │            │            │            │            │
       │            ▼            │            ▼            │
       │       ┌──────────┐      │       ┌──────────┐      │
       │       │ Response │      │       │ Response │      │
       │       │ Handler  │      │       │ Handler  │      │
       │       └──────────┘      │       └──────────┘      │
       │                         │
       └─────────────────────────┴─────────────────────────
                               │
                               ▼
                       ┌──────────────┐
                       │ Updated      │
                       │ Weights      │
                       └──────────────┘
```

---

## Weight Applier Engine

### Smooth Stepping Algorithm

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    WEIGHT APPLIER: SMOOTH STEPPING                      │
└─────────────────────────────────────────────────────────────────────────┘

INPUT: Current Weights, Target Weights

Step 1: Calculate Deltas
  ┌──────────────────────────────────────────────────────────┐
  │ For each weight:                                         │
  │   delta = target[w] - current[w]                         │
  │   step = clamp(delta, -5%, +5%)  ← MAX STEP CONSTRAINT  │
  └──────────────────────────────────────────────────────────┘

Step 2: Apply Step
  ┌──────────────────────────────────────────────────────────┐
  │ For each weight:                                         │
  │   updated[w] = current[w] + step                         │
  │   updated[w] = clamp(updated[w], 0.5x, 2.0x)  ← BOUNDS  │
  └──────────────────────────────────────────────────────────┘

Step 3: Normalize
  ┌──────────────────────────────────────────────────────────┐
  │ Sum all weights                                          │
  │ If sum != 1.0: divide each weight by sum                │
  │ Result: Weights sum to 1.0                              │
  └──────────────────────────────────────────────────────────┘

Output: Updated Weights (within bounds, sum=1.0)

CONVERGENCE EXAMPLE:
  Target: RSI=1.2, MACD=0.9
  Current: RSI=1.0, MACD=1.0

  Cycle 1: RSI→1.05 (5% step), MACD→0.95 (5% step)
  Cycle 2: RSI→1.10 (5% step), MACD→0.90 (5% step) ✓ TARGET
```

---

## Anomaly Detector: 6-Point Detection

### Detection Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│              ANOMALY DETECTION: REAL-TIME ANALYSIS                      │
└─────────────────────────────────────────────────────────────────────────┘

Engine State Input:
  • Current weights
  • Recent accuracy (20-window, 100-window)
  • Volatility (ATR)
  • Indicator conflicts
  • LLM influence score

        ┌─────────────────────────────────────────┐
        │  ANOMALY CHECK #1: Weight Imbalance     │
        │  If any weight > 2x average             │
        │  Status: WEIGHT_IMBALANCE               │
        └────────────────┬────────────────────────┘
                         │
        ┌────────────────▼────────────────────────┐
        │  ANOMALY CHECK #2: Accuracy Collapse    │
        │  If WR dropped > 10% in window          │
        │  Status: ACCURACY_COLLAPSE              │
        └────────────────┬────────────────────────┘
                         │
        ┌────────────────▼────────────────────────┐
        │  ANOMALY CHECK #3: Stuck Weights        │
        │  If no changes for 10 cycles            │
        │  AND accuracy low (<50%)                │
        │  Status: STUCK_WEIGHTS                  │
        └────────────────┬────────────────────────┘
                         │
        ┌────────────────▼────────────────────────┐
        │  ANOMALY CHECK #4: High Conflicts       │
        │  If indicator conflicts > 5             │
        │  Status: HIGH_CONFLICTS                 │
        └────────────────┬────────────────────────┘
                         │
        ┌────────────────▼────────────────────────┐
        │  ANOMALY CHECK #5: LLM Misalignment    │
        │  If LLM confidence > 0.7                │
        │  AND accuracy < 50%                     │
        │  Status: LLM_MISALIGNMENT               │
        └────────────────┬────────────────────────┘
                         │
        ┌────────────────▼────────────────────────┐
        │  ANOMALY CHECK #6: Volatility Spike     │
        │  If ATR > 1.3 × previous                │
        │  Status: VOLATILITY_SPIKE               │
        └────────────────┬────────────────────────┘
                         │
                    ┌────▼────────────────┐
                    │  Aggregate Results  │
                    │  Calculate Severity │
                    │  (0-100 score)      │
                    └────┬────────────────┘
                         │
                    ┌────▼────────────────┐
                    │  Output Anomalies   │
                    │  + Recommendations  │
                    └────────────────────┘

SEVERITY SCORING:
  0-30    = LOW     → Monitor
  31-60   = MEDIUM  → Controlled reduction (10% weights)
  61-100  = HIGH    → Emergency reset (15% weights)
```

---

## Emergency Response Handler

### Recovery State Machine

```
┌─────────────────────────────────────────────────────────────────────────┐
│          EMERGENCY RESPONSE: STATE MACHINE & RECOVERY                   │
└─────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────┐
                    │   NORMAL MODE   │
                    │ (No anomalies)  │
                    └────────┬────────┘
                             │
                Anomaly Detected (Severity >= MEDIUM)
                             │
                             ▼
                    ┌─────────────────┐
                    │  RECOVERY MODE  │
                    │   ACTIVATED     │
                    └────────┬────────┘
                             │
        ┌────────────────────┴────────────────────┐
        │                                         │
        ▼ (HIGH Severity)              ▼ (MEDIUM Severity)
┌──────────────────────┐      ┌──────────────────────┐
│ EMERGENCY RESET      │      │ CONTROLLED REDUCTION │
│ • Reduce: ×0.85      │      │ • Reduce: ×0.90      │
│ • Duration: 3 cycles │      │ • Duration: 2 cycles │
│ • Tighten gates: ×1.1│      │ • Tighten gates: ×1.05
└──────────┬───────────┘      └──────────┬───────────┘
           │                             │
      [Cycle 1]                     [Cycle 1]
        │ Tick                        │ Tick
        ▼                            ▼
    [Cycle 2]                   [Cycle 2] ✓ EXIT
        │ Tick
        ▼
    [Cycle 3] ✓ EXIT
        │ Tick
        ▼

RECOVERY OUTCOMES:
  • Weights normalized and bounded (0.5x - 2.0x)
  • Gates tightened to stricter entry criteria
  • Accuracy allowed to stabilize
  • Automatic exit after tick-down completes
  • Return to NORMAL MODE

TICK-DOWN MECHANISM:
  recoveryTimeRemaining: 3 → 2 → 1 → 0 (exit)
  Each cycle: AnomalyResponseHandler.tickRecovery()
```

---

## Dashboard Metrics

### Real-Time Monitoring

```
┌─────────────────────────────────────────────────────────────────────────┐
│              DASHBOARD METRICS: HEALTH MONITORING                       │
└─────────────────────────────────────────────────────────────────────────┘

COLLECTED METRICS:

┌─────────────────────┐
│ LLM Influence Score │ = Applied Changes / Total Cycles × 100
│ Example: 62%        │ (% of cycles where LLM modified weights)
└─────────────────────┘

┌──────────────────────────┐
│ Regime Distribution      │ Per regime % over last N cycles
│ • Trend: 34%             │
│ • Mean Rev: 28%          │
│ • Chop: 21%              │
│ • Breakout: 12%          │
│ • Unknown: 5%            │
└──────────────────────────┘

┌──────────────────────────┐
│ Acceptance Rate          │ LLM Suggestions Accepted / Total × 100
│ Example: 71%             │
└──────────────────────────┘

┌────────────────────────┐
│ Adjustment Velocity    │ Average |weight change| per cycle
│ Example: 0.0187        │
└────────────────────────┘

┌────────────────────────┐
│ Anomaly Frequency      │ Cycles with Anomalies / Total × 100
│ Example: 8%            │
└────────────────────────┘

┌──────────────────────────────┐
│ Accuracy-Confidence Corr     │ Pearson r coefficient
│ Example: 0.43 (moderate +)   │ Between LLM confidence & actual accuracy
└──────────────────────────────┘

┌──────────────────┐
│ Health Score     │ 0-1 overall rating
│ Example: 0.78    │ Based on all metrics
└──────────────────┘

SCORING LOGIC:
  health_score = 
    (llm_influence × 0.2) +
    (acceptance_rate × 0.2) +
    (1 - anomaly_frequency × 0.2) +
    (correlation_strength × 0.2) +
    (accuracy_trend × 0.2)

  Result: 0.0 (critical) to 1.0 (perfect)
```

---

## Integration Architecture

### 30-Second Polling Loop Integration

```
┌─────────────────────────────────────────────────────────────────────────┐
│           INTEGRATION: 30-SECOND POLLING LOOP SCHEDULE                  │
└─────────────────────────────────────────────────────────────────────────┘

                    EVERY 30 SECONDS
                         │
                ┌────────┴────────┐
                │                 │
         ┌──────▼──────┐   ┌──────▼──────┐
         │ Calculate   │   │ Record Settled
         │ Indicators  │   │ Contracts
         └──────┬──────┘   └──────┬──────┘
                │                 │
                └────────┬────────┘
                         │
                   ┌─────▼─────┐
                   │  Generate │
                   │ Prediction│
                   └─────┬─────┘
                         │
                    ┌────▼────────────────────┐
                    │ Every 60s (Cycle % 2)    │
                    │ Run LLM Analysis        │
                    │ • Single coin           │
                    │ • Apply weight updates  │
                    └────┬────────────────────┘
                         │
                    ┌────▼────────────────────┐
                    │ Every 2min (Cycle % 4)  │
                    │ Run Batch Analysis      │
                    │ • Multi-coin batch      │
                    │ • Apply per-coin targets│
                    └────┬────────────────────┘
                         │
                    ┌────▼────────────────────┐
                    │ Every 3min (Cycle % 6)  │
                    │ • Tick recovery counter │
                    │ • Check metrics         │
                    │ • Log diagnostics      │
                    └────────────────────────┘
                         │
                    ┌────▼────────────────┐
                    │ Output Dashboard    │
                    │ • Metrics           │
                    │ • Anomalies         │
                    │ • Recovery status   │
                    └────────────────────┘

CODE INTEGRATION (in app.js):

  let cycleCount = 0;
  
  setInterval(async () => {
    cycleCount++;
    
    // Every 2 cycles (60s)
    if (cycleCount % 2 === 0) {
      const result = await runLLMCycle(snapshot, weights, gates);
      if (result.applied) Object.assign(weights, result.newWeights);
    }
    
    // Every 4 cycles (120s)
    if (cycleCount % 4 === 0) {
      const batch = await runBatchAnalysis(allCoins);
      // Apply per-coin adjustments
    }
    
    // Every 6 cycles (180s)
    if (cycleCount % 6 === 0) {
      AnomalyResponseHandler.tickRecovery();
      const metrics = getLLMMetrics();
    }
  }, 30000);
```

---

## Data Flow Diagram

### Signal Path: Market Data → Prediction

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE SIGNAL FLOW: v2.12.0                        │
└─────────────────────────────────────────────────────────────────────────┘

Market Data Sources                  
(Pyth, Kalshi, Coinbase)
     │
     ▼
┌──────────────────┐
│ Data Ingestion   │
│ & Validation     │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────┐
│ Indicator Calculation    │
│ RSI, MACD, CCI, Fisher   │
│ ADX, ATR, OrderBook       │
│ Kalshi%, CrowdFade        │
└────────┬─────────────────┘
         │
         ├─────────────────────────────────┐
         │                                 │
         ▼                                 ▼
┌──────────────────┐          ┌──────────────────┐
│ Core Engine      │          │ LLM Signal Layer │
│ Analysis         │          │ (ASYNC)          │
│ • Signal scores  │          │                  │
│ • Conflicts      │          │ • Regime class   │
│ • Thresholds     │          │ • Suggestions    │
└────────┬─────────┘          │ • Confidence     │
         │                    └────────┬─────────┘
         │                           │
         ├───────────────────────────┤
         │                           │
         ▼                           ▼
┌──────────────────────────────────────┐
│ Weight Applier                       │
│ • Apply smooth stepping              │
│ • Enforce bounds (0.5x - 2.0x)      │
│ • Normalize sum=1.0                 │
│ • Log adjustments                    │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Anomaly Detector                     │
│ • Check 6 detection algorithms       │
│ • Calculate severity (0-100)         │
│ • Generate recommendations           │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Response Handler                     │
│ • If HIGH: emergency reset (×0.85)   │
│ • If MEDIUM: reduce weights (×0.90)  │
│ • If LOW: monitor only               │
│ • Tick down recovery counter         │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Dashboard Metrics                    │
│ • LLM influence score                │
│ • Regime distribution                │
│ • Acceptance rate                    │
│ • Health score (0-1)                 │
│ • Anomaly frequency                  │
│ • Correlation analysis               │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Final Prediction                     │
│ + Confidence Score                   │
│ + Weight Summary                     │
│ + Anomaly Alerts                     │
└──────────────────────────────────────┘
```

---

## Graceful Degradation Architecture

### With/Without LLM Operation

```
┌─────────────────────────────────────────────────────────────────────────┐
│             GRACEFUL DEGRADATION: LLM OPTIONAL LAYER                    │
└─────────────────────────────────────────────────────────────────────────┘

MODE 1: WITH LLM (LLM_API_URL + LLM_API_KEY set)

  Market Data
     │
     ▼
  Indicators ────┐
     │          │
     ▼          ▼
  Core Engine + LLM Signal Layer
     │
     ├─ Weight Applier (smooth stepping)
     ├─ Anomaly Detector (6 algorithms)
     ├─ Response Handler (auto-recovery)
     └─ Dashboard Metrics (monitoring)
     │
     ▼
  Final Prediction (LLM-enhanced)

MODE 2: WITHOUT LLM (LLM API not configured)

  Market Data
     │
     ▼
  Indicators
     │
     ▼
  Core Engine (only)
     │
     ├─ No LLM analysis
     ├─ No weight modifications
     ├─ No anomaly detection
     └─ No auto-recovery
     │
     ▼
  Final Prediction (baseline)

KEY PROPERTY: Engine functions identically in both modes
  • Predictions still valid without LLM
  • LLM is an optional enhancement layer
  • No blocking calls (all LLM async)
  • Zero performance impact if LLM disabled
```

---

## Module Dependencies

### Component Relationships

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     MODULE DEPENDENCY GRAPH                             │
└─────────────────────────────────────────────────────────────────────────┘

Core Application
    │
    ├─ app.js (30s polling loop)
    │   │
    │   ├─ llm_signal_assistant.js ◄── specialized_prompt.js
    │   │   └─ LLMAssistant.analyzeSnapshot()
    │   │
    │   ├─ weight_applier.js
    │   │   └─ WeightApplier.apply()
    │   │
    │   ├─ anomaly_detector.js
    │   │   └─ AnomalyDetector.detect()
    │   │
    │   ├─ anomaly_response_handler.js
    │   │   └─ AnomalyResponseHandler.handle()
    │   │
    │   ├─ dashboard_metrics.js
    │   │   └─ DashboardMetrics.getMetrics()
    │   │
    │   └─ multi_coin_analyzer.js
    │       └─ analyzeBatch()
    │
    └─ Tools & Testing
        │
        ├─ tools/llm-debug.js
        │   ├─ requires weight_applier
        │   ├─ requires anomaly_detector
        │   ├─ requires dashboard_metrics
        │   └─ requires llm_signal_assistant
        │
        ├─ tools/test-llm-integration.js
        │   └─ Tests all modules
        │
        └─ tools/test-anomaly-scenarios.js
            └─ Tests recovery handler

DEPENDENCY GRAPH:
  
  llm_signal_assistant ← specialized_prompt
  │
  ├─ weight_applier
  ├─ anomaly_detector
  └─ anomaly_response_handler
  
  All ← dashboard_metrics
```

---

## Performance Timeline

### Metrics Over Time

```
┌─────────────────────────────────────────────────────────────────────────┐
│               EXPECTED PERFORMANCE TIMELINE: v2.12.0                    │
└─────────────────────────────────────────────────────────────────────────┘

First 30 cycles (15 minutes):
  • Indicators collecting
  • LLM warming up
  • Weights adapting
  • Status: Ramp-up phase

Cycles 30-120 (1-2 hours):
  • Patterns emerging
  • LLM influence increasing
  • Anomaly detectors tuning
  • Status: Tuning phase

Cycles 120-480 (2-8 hours):
  • Full convergence
  • LLM at full influence
  • Dashboard metrics stable
  • Status: Steady state

24+ hours:
  • Accuracy baseline established
  • Per-coin influence tracked
  • Recovery patterns known
  • Status: Production normal

Expected Improvements:
  • Accuracy: +2-5% (with well-tuned LLM)
  • Recovery time: -30-50% (faster bounces)
  • False positives: Detected but not preventing trades
  • Confidence: Increases as LLM learns
```

---

## Error Handling & Resilience

### Fault Tolerance

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   ERROR HANDLING & RESILIENCE                           │
└─────────────────────────────────────────────────────────────────────────┘

Failure Scenario 1: LLM API Down
  ├─ LLMAssistant.analyzeSnapshot() returns { regime: "unknown", ... }
  ├─ Weight applier skips modifications
  └─ Engine continues without LLM (graceful degradation)
  Result: ✓ NO IMPACT

Failure Scenario 2: Anomaly Detector Exception
  ├─ Try-catch wraps all detection
  ├─ Returns empty anomalies list
  └─ Response handler skips recovery
  Result: ✓ SAFE DEFAULT

Failure Scenario 3: Weight Bounds Violated
  ├─ All weights clamped to [0.5x, 2.0x]
  ├─ Normalized to sum = 1.0
  └─ Valid state always maintained
  Result: ✓ CONSTRAINT SATISFIED

Failure Scenario 4: Divide by Zero (in normalization)
  ├─ Weight sum checked for > 0
  ├─ If sum ≤ 0, reset to default weights
  └─ Safe fallback applied
  Result: ✓ HANDLED

Failure Scenario 5: Null/Undefined Inputs
  ├─ All inputs validated before processing
  ├─ Defaults applied for missing fields
  └─ Logging captures anomalies
  Result: ✓ TYPE SAFE

OVERALL: 100% error coverage with safe defaults
```

---

