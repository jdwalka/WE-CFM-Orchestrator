// Test CoinMarketCap Pro API integration
// Run with: node test-cmc-api.js

const fs = require('fs');
const path = require('path');

// Load CMC feed module
const cmcFeedPath = path.join(__dirname, 'src/feeds/coinmarketcap-pro-feed.js');
if (!fs.existsSync(cmcFeedPath)) {
  console.error('❌ CMC feed not found at:', cmcFeedPath);
  process.exit(1);
}

// Mock browser globals for Node.js
global.localStorage = {
  getItem: () => '8e6b728e402b4fdab69fa87aed758ab1',
  setItem: () => {},
  removeItem: () => {}
};

global.window = {
  fetch: fetch,
  XMLHttpRequest: undefined,
  localStorage: global.localStorage
};
global.document = {};

// Load the CMC feed
require(cmcFeedPath);

const cmcFeed = window._cmcProFeed;

async function testCMCAPI() {
  console.log('🔍 Testing CoinMarketCap Pro API...\n');
  
  try {
    // Test 1: Get cryptocurrency listings (most stable endpoint)
    console.log('Test 1: Fetching cryptocurrency listings...');
    const listings = await cmcFeed.getLatestListings({ limit: 5 });
    if (listings && listings.length > 0) {
      console.log('✅ Listings success. Sample:');
      listings.slice(0, 2).forEach(coin => {
        console.log(`   ${coin.name} (${coin.symbol}): $${coin.quote?.USD?.price?.toFixed(2) || 'N/A'}`);
      });
    } else {
      console.log('⚠️  No listings returned');
    }
    
    // Test 2: Get global metrics (BTC dominance, volume)
    console.log('\nTest 2: Fetching global metrics...');
    const global = await cmcFeed.getGlobalMetrics();
    if (global) {
      console.log('✅ Global metrics success:');
      console.log(`   BTC dominance: ${global.btc_dominance?.toFixed(1) || 'N/A'}%`);
      console.log(`   Altcoin market cap: $${(global.altcoin_market_cap / 1e9)?.toFixed(2) || 'N/A'}B`);
      console.log(`   Total 24h volume: $${(global.total_24h_volume / 1e9)?.toFixed(2) || 'N/A'}B`);
    } else {
      console.log('⚠️  No global metrics returned');
    }
    
    // Test 3: Get Fear & Greed Index
    console.log('\nTest 3: Fetching Fear & Greed Index...');
    const fng = await cmcFeed.getFearGreedIndex();
    if (fng) {
      console.log('✅ Fear & Greed success:');
      console.log(`   Value: ${fng.value}`);
      console.log(`   Status: ${fng.value_classification}`);
      console.log(`   Last updated: ${fng.timestamp}`);
    } else {
      console.log('⚠️  No Fear & Greed data returned');
    }
    
    // Test 4: Get specific coin quote (BTC)
    console.log('\nTest 4: Fetching BTC quote...');
    const btc = await cmcFeed.getLatestQuote('1'); // CoinMarketCap ID for BTC
    if (btc) {
      console.log('✅ BTC quote success:');
      console.log(`   Price: $${btc.quote?.USD?.price?.toFixed(2) || 'N/A'}`);
      console.log(`   24h change: ${btc.quote?.USD?.percent_change_24h?.toFixed(2) || 'N/A'}%`);
      console.log(`   Market cap: $${(btc.quote?.USD?.market_cap / 1e9)?.toFixed(2) || 'N/A'}B`);
    } else {
      console.log('⚠️  No BTC quote returned');
    }
    
    console.log('\n✅ All tests completed.');
    console.log('📊 API appears to be working. Ready to build.\n');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response body:', error.response.body);
    }
    process.exit(1);
  }
}

// Run tests
testCMCAPI();
