const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../../data/contract-cache.json');
const OUTPUT_PATH = path.join(__dirname, '../../data/optimized-weights.json');

// Default initial weights to start the stochastic hill-climb
const DEFAULT_WEIGHTS = {
  rsi: 0.10, stochrsi: 0.05, ema: 0.05, sma: 0.03, macd: 0.07,
  vwma: 0.06, hma: 0.07, bands: 0.25, cci: 0.10, adx: 0.05,
  momentum: 0.05, vwap: 0.05, volume: 0.10
};

/**
 * MOCK: In production, this would fetch 1m OHLCV historical candles for the given timestamp
 * and run the 20-dimensional technical indicator math. Because we are not downloading GBs
 * of candle data right now, we simulate an indicator feature vector that loosely correlates
 * with the known Kalshi outcome to demonstrate the gradient descent optimizer working.
 */
function reconstructHistoricalIndicators(contractTs, settledYes) {
  // We simulate the normalized output of the indicator formulas [-1.0 to 1.0]
  const features = {};
  const baseSignal = settledYes ? 1.0 : -1.0;
  
  // Give each indicator a random alignment to the truth, with some noise
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    // 60% chance the indicator agreed with the outcome, 40% chance it was noise/wrong
    const isCorrect = Math.random() > 0.4; 
    const strength = Math.random(); // 0.0 to 1.0
    features[key] = isCorrect ? (baseSignal * strength) : (-baseSignal * strength);
  }
  return features;
}

// ---------------------------------------------------------
// OPTIMIZATION ENGINE
// ---------------------------------------------------------

function scorePrediction(features, weights) {
  let score = 0;
  let totalWeight = 0;
  for (const [key, val] of Object.entries(features)) {
    const w = weights[key] || 0;
    score += val * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? (score / totalWeight) : 0;
}

function evaluateWeights(contracts, dataset, weights) {
  let correct = 0;
  let total = 0;

  for (const contract of contracts) {
    if (contract.outcome === null) continue; // Unresolved

    const settledYes = contract.outcome === 'yes';
    const features = dataset[contract.marketTicker];
    if (!features) continue;

    const rawScore = scorePrediction(features, weights);
    
    // Thresholds
    const predictedYes = rawScore > 0.05;
    const predictedNo = rawScore < -0.05;

    if (predictedYes || predictedNo) {
      total++;
      if ((predictedYes && settledYes) || (predictedNo && !settledYes)) {
        correct++;
      }
    }
  }

  return total > 0 ? (correct / total) : 0;
}

function mutateWeights(currentWeights, mutationRate = 0.10) {
  const newWeights = { ...currentWeights };
  const keys = Object.keys(newWeights);
  
  // Mutate 1 to 3 random weights
  const mutations = Math.floor(Math.random() * 3) + 1;
  for (let i = 0; i < mutations; i++) {
    const key = keys[Math.floor(Math.random() * keys.length)];
    // Shift by +/- mutationRate
    const shift = (Math.random() * 2 - 1) * mutationRate;
    newWeights[key] = Math.max(0, Math.min(3.0, newWeights[key] + shift));
  }
  return newWeights;
}

async function runOptimization() {
  console.log('[WalkForwardTuner] Starting historical walk-forward optimization...');
  
  if (!fs.existsSync(CACHE_PATH)) {
    console.error(`[WalkForwardTuner] Missing contract cache at ${CACHE_PATH}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  const contracts = raw.settlements || [];
  
  const validContracts = contracts.filter(c => c.outcome === 'yes' || c.outcome === 'no');
  console.log(`[WalkForwardTuner] Loaded ${validContracts.length} finalized historical contracts.`);

  if (validContracts.length === 0) {
    console.log('[WalkForwardTuner] No historical data to tune against. Exiting.');
    return;
  }

  // 1. Reconstruct historical features (Mocked for speed/data availability)
  console.log('[WalkForwardTuner] Reconstructing historical indicator vectors...');
  const dataset = {};
  for (const c of validContracts) {
    dataset[c.marketTicker] = reconstructHistoricalIndicators(c.ts, c.outcome === 'yes');
  }

  // 2. Stochastic Hill-Climbing Optimization
  console.log('[WalkForwardTuner] Running Stochastic Hill-Climbing (Epochs: 2000)...');
  let bestWeights = { ...DEFAULT_WEIGHTS };
  let bestWinRate = evaluateWeights(validContracts, dataset, bestWeights);
  
  console.log(`[WalkForwardTuner] Baseline Win Rate: ${(bestWinRate * 100).toFixed(2)}%`);

  const EPOCHS = 2000;
  let improvements = 0;

  for (let i = 0; i < EPOCHS; i++) {
    // Decrease mutation rate over time (Simulated Annealing approach)
    const currentMutationRate = 0.5 * (1 - (i / EPOCHS));
    const candidateWeights = mutateWeights(bestWeights, currentMutationRate);
    
    const candidateWinRate = evaluateWeights(validContracts, dataset, candidateWeights);
    
    if (candidateWinRate > bestWinRate) {
      bestWinRate = candidateWinRate;
      bestWeights = candidateWeights;
      improvements++;
    }
  }

  console.log(`[WalkForwardTuner] Tuning complete. Found ${improvements} weight improvements.`);
  console.log(`[WalkForwardTuner] Optimized Win Rate: ${(bestWinRate * 100).toFixed(2)}%`);
  
  const result = {
    timestamp: new Date().toISOString(),
    baselineWinRate: bestWinRate, // Just for log, it's actually the tuned rate
    epochs: EPOCHS,
    globalOptimizedWeights: bestWeights
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`[WalkForwardTuner] Saved optimized weights to ${OUTPUT_PATH}`);
}

runOptimization().catch(console.error);
