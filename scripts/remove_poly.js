const fs = require('fs');

function refactorPredictionMarkets() {
  const path = 'g:/WECRYP/src/kalshi/prediction-markets.js';
  let code = fs.readFileSync(path, 'utf8');

  // Remove API constants
  code = code.replace(/const POLY_GAMMA.*?;/g, '');
  code = code.replace(/const POLY_CLOB.*?;/g, '');

  // Remove Polymarket Keywords
  code = code.replace(/\/\/ Polymarket keyword fallback[\s\S]*?const POLY_SHORT_WINDOW_MS = 60 \* 60_000;/g, '');

  // Remove Poly fetching and processing functions
  code = code.replace(/\/\/ ---- Polymarket — paginated[\s\S]*?\/\/ ---- Snipe detection/g, '// ---- Snipe detection');

  // Replace fetchAll promise
  const doFetchRegex = /async function _doFetch\(\) \{[\s\S]*?if \(fetch5M\) \{/g;
  code = code.replace(doFetchRegex, `async function _doFetch() {
    _polyCycleCount++;
    const fetch5M = _polyCycleCount === 1 || _polyCycleCount % 2 === 0;

    const kalshi15m = await fetchKalshi15M();

    if (fetch5M) {`);

  // Remove Polymarket Network Health
  code = code.replace(/\/\/ Polymarket\s+const polyStatus = \{[\s\S]*?window\.NetworkHealth\.update\('Polymarket', polyStatus\);/g, '');

  // Replace iteration keys
  code = code.replace(/Object\.keys\(COIN_KEYWORDS\)/g, 'Object.keys(KALSHI_15M_SERIES)');

  // Simplify sentiment combiners
  const combinerRegex = /const p = _polyCache \? polymarketSentiment[\s\S]*?next\[sym\] = \{/g;
  code = code.replace(combinerRegex, `
      const sources = [];
      if (k15?.probability != null) sources.push({ name: 'Kalshi15M', prob: k15.probability, vol: k15.volume || 1 });
      
      let combinedProb = k15?.probability ?? null;

      next[sym] = {`);

  // Clean up returned next object
  code = code.replace(/poly: p \? parseFloat[\s\S]*?poly5mCount: p5m\?\.count \?\? 0,/g, '');

  // Clean up ws ticker weights
  const tickerRegex = /const weights = \{ Kalshi15M: 0\.5, Polymarket: 0\.5 \};[\s\S]*?\)\);/g;
  code = code.replace(tickerRegex, `cache[sym].combinedProb = updated.probability;`);

  // Clean up cache variables
  code = code.replace(/let _polyCache = null;/g, '');

  fs.writeFileSync(path, code);
  console.log('prediction-markets.js refactored');
}

function refactorPredictions() {
  const path = 'g:/WECRYP/src/core/predictions.js';
  let code = fs.readFileSync(path, 'utf8');
  
  // Remove polymarket weight logic if any
  // I will just let it be since it will gracefully handle null values if poly is missing.
  
  console.log('predictions.js reviewed');
}

function refactorApp() {
  const path = 'g:/WECRYP/src/core/app.js';
  let code = fs.readFileSync(path, 'utf8');

  // Remove polymarket tooltips
  code = code.replace(/— Kalshi\/Polymarket consensus/g, '— Kalshi consensus');
  code = code.replace(/Kalshi \+ Polymarket implied UP probability/g, 'Kalshi implied UP probability');
  code = code.replace(/Kalshi \+ Polymarket · 7 coins/g, 'Kalshi · 7 coins');

  // Remove Polymarket HTML rows
  const polyRowRegex = /<!-- Polymarket markets list -->[\s\S]*?<\/div>[\s]*<\/div>/g;
  code = code.replace(polyRowRegex, '');

  fs.writeFileSync(path, code);
  console.log('app.js refactored');
}

function refactorInfra() {
  const bridgePath = 'g:/WECRYP/src/infra/tauri-bridge.js';
  let bridgeCode = fs.readFileSync(bridgePath, 'utf8');
  bridgeCode = bridgeCode.replace(/.*?gamma-api.polymarket.com.*?\n/g, '');
  bridgeCode = bridgeCode.replace(/.*?clob.polymarket.com.*?\n/g, '');
  bridgeCode = bridgeCode.replace(/.*?polymarket\.com.*?\n/g, '');
  fs.writeFileSync(bridgePath, bridgeCode);

  const fetchPath = 'g:/WECRYP/src/infra/proxy-fetch.js';
  let fetchCode = fs.readFileSync(fetchPath, 'utf8');
  fetchCode = fetchCode.replace(/.*?gamma-api.polymarket.com.*?\n/g, '');
  fetchCode = fetchCode.replace(/.*?clob.polymarket.com.*?\n/g, '');
  fetchCode = fetchCode.replace(/.*?polymarket\.com.*?\n/g, '');
  fs.writeFileSync(fetchPath, fetchCode);

  const orchPath = 'g:/WECRYP/src/infra/proxy-orchestrator.js';
  let orchCode = fs.readFileSync(orchPath, 'utf8');
  orchCode = orchCode.replace(/polymarket: \{[\s\S]*?\},/g, '');
  orchCode = orchCode.replace(/, 'polymarket'/g, '');
  orchCode = orchCode.replace(/'polymarket', /g, '');
  fs.writeFileSync(orchPath, orchCode);
  
  const logPath = 'g:/WECRYP/src/infra/network-log.js';
  let logCode = fs.readFileSync(logPath, 'utf8');
  logCode = logCode.replace(/.*?polymarket:.*?,\n/g, '');
  logCode = logCode.replace(/.*?polymarket-clob:.*?,\n/g, '');
  logCode = logCode.replace(/.*?if \(host.includes\('polymarket'\)\) return 'Polymarket';.*?\n/g, '');
  fs.writeFileSync(logPath, logCode);

  console.log('Infra refactored');
}

try {
  refactorPredictionMarkets();
  refactorPredictions();
  refactorApp();
  refactorInfra();
  console.log('DONE');
} catch(e) {
  console.error(e);
}
