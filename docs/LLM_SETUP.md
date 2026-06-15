# LLM Signal Assistant — Setup & Usage Guide

## 📌 Quick Start

### 1. Set Environment Variables (PowerShell)

```powershell
$env:OPENROUTER_API_KEY = "sk-or-v1-..."  # Your OpenRouter API key
$env:OPENROUTER_MODEL = "~openai/gpt-latest"
$env:LLM_PROVIDER = "openrouter"
```

### 2. Test the LLM Layer

```powershell
node tools\test-llm.js
```

Expected output:
- 4 test scenarios (Trend, Mean Reversion, Chop, Breakout)
- Each shows regime classification + weight suggestions
- Diagnostics at end

### 3. Wire Into Engine Loop (Optional)

In your 30-second polling cycle in `src/core/app.js`:

```javascript
const LLMAssistant = require("./llm/llm_signal_assistant");

// After computing indicators and raw prediction:
async function runLLMAnalysis(snapshot, weights) {
  const llmOutput = await LLMAssistant.analyzeSnapshot(snapshot);
  
  // Apply only if safe (high confidence, within gates)
  const { changed, newWeights } = LLMAssistant.applyWeights(llmOutput, weights);
  
  if (changed) {
    // Log the influence
    LLMAssistant.logAnalysis(snapshot.coin, snapshot, llmOutput, true);
    // Merge new weights into engine
    Object.assign(weights, newWeights);
  }
}
```

## 🏗️ Architecture

### Core Responsibilities

**A. Regime Classification**
- Reads: volatility, orderbook imbalance, indicator values, recent accuracy
- Outputs: regime + confidence + recommended gate
- Regimes: `trend_continuation` | `mean_reversion` | `chop_noise` | `breakout_volatility`

**B. Conflict Resolution**
- Detects when indicators diverge (RSI up vs MACD down)
- Suggests which signal historically wins in current regime
- Recommends weight adjustments

**C. Sanity Checking**
- Flags stale data (>60s old)
- Detects indicator saturation (RSI > 90 / < 10)
- Warns on weight contradictions
- Alerts on accuracy collapse

### Safety Gates

Weight adjustments are capped at **±5%** per cycle and only applied if:
- **Confidence ≥ 0.6** — LLM must be at least 60% sure
- **Regime ≠ "unknown"** — Cannot adjust if regime is uncertain
- **Max adjustment: 1.05x or 0.95x** — Never boost > 2.0x or reduce < 0.3x

### Non-Blocking Design

LLM runs **asynchronously** alongside the core engine:

```
Core Loop (30s):
  ├─ Fetch indicators ✓ blocking
  ├─ Calculate raw prediction ✓ blocking
  ├─ Spawn LLM analysis (async) → logged to logs/llm/
  └─ Display prediction (uses current weights)
```

## 📊 Outputs

### Console Output

```
🧪 TEST: Trend Continuation (Strong Signals)
📥 INPUT: BTC at volatility 0.015, RSI 65, MACD +0.0025
⏳ Calling LLM...
📤 LLM OUTPUT:
   Regime: trend_continuation
   Confidence: 82.0%
   📈 Increase: RSI, Fisher
   📉 Decrease: MACD
🔧 SIMULATED WEIGHT APPLICATION:
   ✓ Weights adjusted:
      RSI: 1.20x → 1.24x (+3.3%)
      Fisher: 1.10x → 1.13x (+2.7%)
```

### Log Files

Every LLM analysis is logged to `logs/llm/{coin}-{timestamp}.json`:

```json
{
  "timestamp": "2026-05-01T00:34:28Z",
  "coin": "BTC",
  "input": {
    "volatility": 0.015,
    "indicators": { "RSI": 65, "MACD": 0.0025, ... },
    "weights": { "RSI": 1.2, "MACD": 0.9, ... }
  },
  "output": {
    "regime": "trend_continuation",
    "confidence": 0.82,
    "suggestions": { ... }
  },
  "applied": true
}
```

## 🎯 Metrics

Access LLM diagnostics anytime:

```javascript
const diag = LLMAssistant.getDiagnostics();
console.log(diag);
// {
//   enabled: true,
//   api_url: "https://...",
//   model: "~openai/gpt-latest",
//   stats: {
//     total_calls: 142,
//     successes: 138,
//     failures: 4,
//     success_rate: "97.2%",
//     influence_count: 47
//   }
// }
```

**Key metric: influence_count / total_calls = % of cycles where LLM modified weights**

## 🔧 Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `OPENROUTER_API_KEY` | *(required if openrouter)* | OpenRouter API key |
| `OPENROUTER_MODEL` | `~openai/gpt-latest` | OpenRouter model to use |
| `LLM_PROVIDER` | `auto` | Set to `openrouter` to force OpenRouter |
| `LLM_API_URL` | `https://api.openai.com/v1/chat/completions` | Your compatible LLM provider endpoint |
| `LLM_API_KEY` | *(required if compatible)* | Compatible API key (never commit!) |
| `LLM_MODEL` | `gpt-4-mini` | Model to use (gpt-4, claude-3, etc.) |

## 🚀 Next Steps

1. **Test with real API key**: Set `OPENROUTER_API_KEY` and run `node tools\test-llm.js`
2. **Monitor influence**: Track how often LLM suggestions are applied
3. **Tune prompts**: Refine regime definitions based on live performance
4. **Measure edge**: Compare accuracy with/without LLM layer
5. **Merge to main**: Once stable, merge `feature/llm-signal-layer` → `main`

## 🐛 Debugging

### LLM Disabled?
Check that your chosen provider's API key is set:
```powershell
$env:OPENROUTER_API_KEY
```

### API Errors?
Check `logs/llm/` for detailed error logs:
```powershell
Get-Content logs\llm\BTC-*.json | tail -1 | jq .output.warnings
```

### Stuck on "unknown" regime?
LLM is unsure. Check:
1. Input snapshot quality (all indicators present?)
2. API response parsing (valid JSON?)
3. Confidence threshold (currently 0.6, maybe too high?)

## 📚 References

- Main module: `src/llm/llm_signal_assistant.js`
- Test harness: `tools/test-llm.js`
- Integration hooks: `src/core/app.js` (30-second loop)
- Logs: `logs/llm/` (per-coin, per-timestamp)
