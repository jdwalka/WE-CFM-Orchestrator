const { LLMAssistant } = require('./src/llm/llm_integration.js');
const fs = require('fs');
const llm = require('./src/llm/llm_signal_assistant.js');

async function main() {
  llm.enabled = true;
  const snapshot = {
    coin: 'BTC',
    horizonMinutes: 15,
    currentPrice: 60000,
    priceToBeatNum: 60000,
    indicators: {}
  };
  console.log("Analyzing snapshot...");
  const res = await llm.analyzeSnapshot(snapshot);
  console.log("Result:", JSON.stringify(res, null, 2));
}

main().catch(console.error);
