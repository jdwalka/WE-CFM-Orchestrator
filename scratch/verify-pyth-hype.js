const PythSettlementValidator = require('../src/core/pyth-settlement.js');

async function run() {
  console.log('🔍 Testing Pyth Settlement Validator...');
  const validator = new PythSettlementValidator();

  const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const res = await validator.getPrices(coins);

  console.log('\n📊 Pyth Prices:');
  Object.entries(res.prices).forEach(([sym, data]) => {
    console.log(`  ${sym}: $${data.price} (Confidence: ${data.confidence}, Age: ${data.age_ms}ms)`);
  });

  if (res.errors && res.errors.length > 0) {
    console.warn('\n⚠️ Errors encountered:');
    res.errors.forEach(err => {
      console.warn(`  ${err.coin}: ${err.error}`);
    });
    process.exit(1);
  } else {
    console.log('\n✅ All Pyth prices fetched successfully!');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('❌ Verification script failed:', err.message);
  process.exit(1);
});
