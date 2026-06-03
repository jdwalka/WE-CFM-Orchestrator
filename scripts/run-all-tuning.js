const AdaptiveLearningEngine = require('./src/core/adaptive-learning-engine.js');
const engine = new AdaptiveLearningEngine();

async function run() {
  const coins = ['BTC', 'ETH', 'SOL', 'XRP'];
  const allWeights = {};

  for (const coin of coins) {
    const res = await engine.runWalkForwardTuning(coin);
    if (res && res.coins && res.coins[coin]) {
      allWeights[coin] = res.coins[coin].optimizedWeights;
    }
  }

  const fs = require('fs');
  fs.writeFileSync('all_tuned_weights.json', JSON.stringify(allWeights, null, 2));
  console.log('Saved to all_tuned_weights.json');
}

run().catch(console.error);
