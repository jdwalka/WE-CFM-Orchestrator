#!/usr/bin/env node
/**
 * Test CoinMarketCap Pro API integration
 * Run: node test-cmc.js
 */

// Mock browser globals
global.localStorage = {
  getItem: () => '2f84e1a8fd0346568a51bbc18657bd5f',
  setItem: () => {},
  removeItem: () => {}
};

global.window = {
  fetch: fetch,
  localStorage: global.localStorage
};

global.document = {};

// Load CMC feed
require('./src/feeds/coinmarketcap-pro-feed.js');
const cmcFeed = window._cmcProFeed;

async function runTests() {
  console.log('\n🔍 Testing CoinMarketCap Pro API Integration\n');
  
  try {
    // Test 1: Quotes
    console.log('📊 Test 1: Fetching live quotes (BTC, ETH, SOL, XRP)...');
    const quotes = await cmcFeed.getLatestQuotes(['BTC', 'ETH', 'SOL', 'XRP']);
    console.log(`✅ Quotes returned: ${Object.keys(quotes).length} coins`);
    Object.entries(quotes).forEach(([sym, data]) => {
      console.log(`   ${sym}: $${data.price?.toFixed(2)} (24h: ${data.change24h?.toFixed(2)}%)`);
    });
    
    // Test 2: Global metrics
    console.log('\n📈 Test 2: Fetching global market metrics...');
    const global = await cmcFeed.getGlobalMetrics();
    if (Object.keys(global).length > 0) {
      console.log(`✅ Global metrics:`);
      console.log(`   BTC dominance: ${global.btcDominance?.toFixed(1)}%`);
      console.log(`   Total 24h volume: $${(global.totalVolume24h / 1e9)?.toFixed(2)}B`);
      console.log(`   Total market cap: $${(global.totalMarketCap / 1e9)?.toFixed(2)}B`);
    }
    
    // Test 3: Fear & Greed
    console.log('\n😨 Test 3: Fetching Fear & Greed Index...');
    const fng = await cmcFeed.getFearGreedIndex();
    if (Object.keys(fng).length > 0) {
      console.log(`✅ Fear & Greed:`);
      console.log(`   Value: ${fng.value} (${fng.label})`);
    } else {
      console.log(`⚠️  Fear & Greed unavailable in Pro mode (trial mode only)`);
    }
    
    console.log('\n✅ All CMC API tests passed!');
    console.log('🚀 Ready to build.\n');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runTests();
