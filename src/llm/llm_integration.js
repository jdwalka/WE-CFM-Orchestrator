/**
 * LLM Engine Integration Helper
 * 
 * Drop-in utilities to connect LLM signal assistant to your 30-second engine loop
 * Non-blocking, safe-gated, fully instrumented
 */

const LLMAssistant = require("../llm/llm_signal_assistant");
const FirebaseAI  = require("../llm/firebase-ai-signal-assistant");
const fs = require("fs");
const path = require("path");

class LLMIntegration {
  constructor() {
    this.stats = {
      cycles: 0,
      suggestions: 0,
      applied: 0,
      errors: 0,
    };

    this.lastInfluence = {};
  }

  /**
   * Build snapshot from engine state
   */
  buildSnapshot(coin, engineState) {
    const {
      volatility,
      indicators,
      weights,
      recentAccuracy,
      orderbook,
      conflicts,
      horizonMinutes,
      horizon,
      venue,
      marketType,
      onChainSideScan,
      onChainRecent,
      market,
      direction,
      confidence,
    } = engineState;

    return {
      coin,
      volatility: volatility || 0,
      orderbook: orderbook || { imbalance: 0.5, buyPressure: 0.5 },
      indicators: indicators || {},
      weights: weights || {},
      recentAccuracy: recentAccuracy || { winRate: 0.5, trend: 0 },
      conflicts: conflicts || [],
      horizonMinutes: horizonMinutes || 15,
      horizon: horizon || 'h15',
      venue: venue || null,
      marketType: marketType || null,
      onChainSideScan: onChainSideScan || null,
      onChainRecent: onChainRecent || onChainSideScan || null,
      market: market || null,
      direction: direction || null,
      confidence: confidence || null,
    };
  }

  /**
   * Main integration point: call this from your 30-second loop
   * 
   * Usage:
   *   const { changed, newWeights } = await llmIntegration.analyze(
   *     "BTC",
   *     engineState,
   *     currentWeights
   *   );
   *   if (changed) Object.assign(weights, newWeights);
   */
  async analyze(coin, engineState, currentWeights) {
    this.stats.cycles++;

    try {
      // Build snapshot
      const snapshot = this.buildSnapshot(coin, engineState);

      // Call LLM (non-blocking, so fire and forget is ok)
      const llmOutput = await LLMAssistant.analyzeSnapshot(snapshot);
      this.stats.suggestions++;

      // Apply weights with safety gates
      const { changed, newWeights } = LLMAssistant.applyWeights(
        llmOutput,
        currentWeights
      );

      if (changed) {
        this.stats.applied++;
        this.lastInfluence[coin] = {
          timestamp: Date.now(),
          regime: llmOutput.regime,
          confidence: llmOutput.confidence,
          applied: true,
        };
      }

      // Firebase AI Logic: non-blocking signal narration (parallel, no await)
      FirebaseAI.summarizeSignal(coin, { ...snapshot, ...llmOutput })
        .then(narration => {
          if (narration) {
            if (!this.lastInfluence[coin]) this.lastInfluence[coin] = {};
            this.lastInfluence[coin].narration = narration;
            this.lastInfluence[coin].narrationTs = Date.now();
          }
        })
        .catch(() => {});

      // Log for forensics (async, don't block)
      this.logAsync(coin, snapshot, llmOutput, changed).catch(() => {});

      return { changed, newWeights, llmOutput };
    } catch (err) {
      this.stats.errors++;
      console.error("[LLMIntegration] Analysis error:", err.message);
      return { changed: false, newWeights: currentWeights, llmOutput: null };
    }
  }

  /**
   * Batch analyze multiple coins (useful for screener mode)
   */
  async analyzeBatch(coins, getEngineState, getWeights) {
    const results = {};

    for (const coin of coins) {
      const engineState = getEngineState(coin);
      const weights = getWeights(coin);

      if (engineState && weights) {
        results[coin] = await this.analyze(coin, engineState, weights);
      }
    }

    return results;
  }

  /**
   * Async logging (doesn't block the main loop)
   */
  async logAsync(coin, input, output, applied) {
    return new Promise((resolve) => {
      setImmediate(() => {
        try {
          const logDir = path.join(process.cwd(), "logs", "llm");
          if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
          }

          const filename = path.join(logDir, `${coin}-${Date.now()}.json`);

          fs.writeFileSync(
            filename,
            JSON.stringify(
              {
                timestamp: new Date().toISOString(),
                coin,
                input,
                output,
                applied,
              },
              null,
              2
            )
          );

          resolve();
        } catch (err) {
          console.warn(
            "[LLMIntegration] Logging failed:",
            err.message
          );
          resolve(); // don't fail the promise
        }
      });
    });
  }

  /**
   * Get influence metrics for dashboard
   */
  getInfluenceMetrics() {
    const total = this.stats.cycles;
    if (total === 0) return { score: 0, applied: 0, total: 0 };

    return {
      score: Math.round((this.stats.applied / this.stats.suggestions * 100) || 0),
      applied: this.stats.applied,
      total: this.stats.suggestions,
      errorRate: Math.round((this.stats.errors / this.stats.cycles * 100) || 0),
    };
  }

  /**
   * Get Gemini narration for a coin (written by FirebaseAI after each cycle)
   */
  getNarration(coin) {
    return this.lastInfluence[coin]?.narration || null;
  }

  /**
   * Get per-coin influence tracking
   */
  getCoinInfluence(coin) {
    return this.lastInfluence[coin] || null;
  }

  /**
   * Display pretty stats
   */
  displayStats() {
    const metrics = this.getInfluenceMetrics();
    return `
╔════════════════════════════════╗
║  LLM INTEGRATION METRICS       ║
╠════════════════════════════════╣
║ Cycles: ${this.stats.cycles.toString().padEnd(24)} ║
║ Suggestions: ${this.stats.suggestions.toString().padEnd(20)} ║
║ Applied: ${this.stats.applied.toString().padEnd(23)} ║
║ Errors: ${this.stats.errors.toString().padEnd(24)} ║
║ Influence Score: ${metrics.score}% ${' '.repeat(19)} ║
║ Error Rate: ${metrics.errorRate}% ${' '.repeat(20)} ║
╚════════════════════════════════╝
    `.trim();
  }

  /**
   * Reset stats (useful for benchmarking)
   */
  reset() {
    this.stats = { cycles: 0, suggestions: 0, applied: 0, errors: 0 };
    this.lastInfluence = {};
  }
}

// Export singleton
module.exports = new LLMIntegration();

console.log("[LLMIntegration] Module loaded");
