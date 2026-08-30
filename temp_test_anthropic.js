require('dotenv').config({ override: true });
console.log("TEST 1 - process.env.LLM_PRIMARY_PROVIDER:", process.env.LLM_PRIMARY_PROVIDER);
console.log("TEST 2 - process.env.ANTHROPIC_API_KEY:", !!process.env.ANTHROPIC_API_KEY);
const llm = require('./src/llm/llm_signal_assistant.js');

async function main() {
  console.log("Enabled:", llm.enabled);
  console.log("Primary Provider:", llm.provider);
  console.log("Anthropic Enabled:", llm.anthropicEnabled);

  const mockSnapshot = {
    coin: "BTC",
    horizon: "15m",
    price: 64000,
  };

  const result = await llm.analyzeSnapshot(mockSnapshot);
  console.log("Result Provider:", result.provider);
}

main().catch(console.error);
