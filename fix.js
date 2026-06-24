const fs = require('fs');
const path = require('path');

const file = path.join('g:', 'WECRYP', 'src', 'kalshi', 'prediction-markets.js');
let code = fs.readFileSync(file, 'utf8');

// The mangled block:
/*
        const settlementLiveDirection = hasSettlementComparison
          ? (settlementPriceDeltaNum >= 0 ? 'UP' : 'DOWN')
          : null;
        
        return {
          ts,
          m,
          ...
          settlementLiveDirection,
    const patterns = COIN_PATTERNS[sym] || [new RegExp(`\\b${String(sym).toLowerCase()}\\b`, 'i')];
    return patterns.some(re => re.test(text));
  }
*/

// I will rebuild fetchPolymarket5MBySlug by finding its start and the next function.
const startIdx = code.indexOf('async function fetchPolymarket5MBySlug(sym) {');
const nextFuncIdx = code.indexOf('function polymarketSentiment(markets, sym) {');

const fixedFunction = `  async function fetchPolymarket5MBySlug(sym) {
    const coinSlugPrefix = POLY_5M_COIN_SLUGS[sym];
    if (!coinSlugPrefix) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    const candidates = [windowTs, windowTs + 300, windowTs + 600, windowTs + 900, windowTs - 300];

    const results = await Promise.all(candidates.map(async (ts) => {
      const slug = \`\${coinSlugPrefix}-updown-5m-\${ts}\`;
      try {
        const hit = await fetchPolymarket5MMarketCandidate(sym, slug);
        const m = hit?.market;
        if (!m) return null;
        const upProb = _parseUpProb(m);
        if (upProb === null) return null;
        const clobSnapshot = await fetchPolymarketClobMarketSnapshot(sym, m);
        const clobProb = Number(clobSnapshot?.upProbability);
        const liveUpProb = Number.isFinite(clobProb) && clobProb >= 0.01 && clobProb <= 0.99 ? clobProb : upProb;
        const title = m.question || m.title || \`\${sym} Up or Down 5M\`;
        const endDate = m.endDate || m.end_date_iso || m.end_date || null;
        const startDate = m.eventStartTime || m.events?.[0]?.startTime || null;
        const volume = parseFloat(m.volume24hr || m.volumeNum || m.volume || 0) || 0;
        const marketSlug = m.slug || slug;
        const startMs = startDate ? new Date(startDate).getTime() : ts * 1000;
        const [cryptoWindow, rtds] = await Promise.all([
          fetchPolymarketCryptoWindowPrice(sym, startMs),
          fetchPolymarketRtdsSnapshot(sym, startMs),
        ]);
        let priceToBeatSource = null;
        let priceToBeatNum = null;

        if (title) {
          const match = title.match(/\\$([0-9,.]+)/);
          if (match) {
            priceToBeatNum = parseFloat(match[1].replace(/,/g, ''));
            if (Number.isFinite(priceToBeatNum)) priceToBeatSource = 'polymarket-title';
          }
        }

        if (startMs <= Date.now() + 10000) {
          if (priceToBeatNum == null) {
            priceToBeatNum = _parseGenericPriceToBeat(JSON.stringify({
              market: {
                priceToBeat: m.priceToBeat,
                price_to_beat: m.price_to_beat,
                eventMetadata: m.eventMetadata,
              },
              event: m.events?.[0] || m._eventFallback || null,
            }), marketSlug);
            if (Number.isFinite(priceToBeatNum)) priceToBeatSource = 'gamma-market-metadata';
          }

          if (priceToBeatNum == null && Number.isFinite(cryptoWindow?.openPrice)) {
            priceToBeatNum = cryptoWindow.openPrice;
            priceToBeatSource = 'polymarket-crypto-price';
          }

          if (priceToBeatNum == null) {
            priceToBeatNum = await fetchPolymarketPriceToBeat(marketSlug);
            if (Number.isFinite(priceToBeatNum)) priceToBeatSource = 'polymarket-eventMetadata';
          }

          if (priceToBeatNum == null && Number.isFinite(rtds?.openingPriceNum)) {
            priceToBeatNum = rtds.openingPriceNum;
            priceToBeatSource = 'polymarket-rtds-chainlink-open';
          }
        }

        let chainlinkCurrentPriceNum = toPositiveFiniteNumber(cryptoWindow?.closePrice);
        let chainlinkCurrentPriceTs = toPositiveFiniteNumber(cryptoWindow?.timestamp);
        if (chainlinkCurrentPriceNum == null) {
          chainlinkCurrentPriceNum = toPositiveFiniteNumber(rtds?.currentPriceNum);
          chainlinkCurrentPriceTs = toPositiveFiniteNumber(rtds?.currentPriceTs);
        }
        const pythCurrent = await getFreshPythLazerPrice(sym);
        const currentPriceNum = pythCurrent?.price ?? chainlinkCurrentPriceNum;
        const currentPriceTs = pythCurrent?.timestamp ?? chainlinkCurrentPriceTs;
        const currentPriceSource = pythCurrent?.source || 'polymarket-chainlink';
        const oracleBasisNum = pythCurrent && chainlinkCurrentPriceNum != null
          ? pythCurrent.price - chainlinkCurrentPriceNum
          : null;
        const currentPriceJustification = pythCurrent
          ? 'Pyth Lazer real-time price compared with Polymarket Chainlink opening PTB; settlement remains Chainlink.'
          : 'Polymarket Chainlink current price fallback; Pyth Lazer was unavailable or stale.';
        const priceToBeat = _formatPolyPriceToBeat(priceToBeatNum);
        const hasLiveComparison = currentPriceNum != null && Number.isFinite(priceToBeatNum) && priceToBeatNum > 0;
        const priceDeltaNum = hasLiveComparison ? currentPriceNum - priceToBeatNum : null;
        const priceDeltaPct = hasLiveComparison ? priceDeltaNum / priceToBeatNum : null;
        const liveDirection = hasLiveComparison
          ? (priceDeltaNum >= 0 ? 'UP' : 'DOWN')
          : null;
        const hasSettlementComparison = chainlinkCurrentPriceNum != null && Number.isFinite(priceToBeatNum) && priceToBeatNum > 0;
        const settlementPriceDeltaNum = hasSettlementComparison ? chainlinkCurrentPriceNum - priceToBeatNum : null;
        const settlementLiveDirection = hasSettlementComparison
          ? (settlementPriceDeltaNum >= 0 ? 'UP' : 'DOWN')
          : null;

        return {
          ts,
          m,
          hit,
          liveUpProb,
          upProb,
          clobProb,
          volume,
          title,
          marketSlug,
          endDate,
          startDate,
          priceToBeat,
          priceToBeatNum,
          priceToBeatSource,
          currentPriceNum,
          currentPriceTs,
          currentPriceSource,
          currentPriceJustification,
          pythCurrent,
          chainlinkCurrentPriceNum,
          chainlinkCurrentPriceTs,
          oracleBasisNum,
          priceDeltaNum,
          priceDeltaPct,
          liveDirection,
          settlementPriceDeltaNum,
          settlementLiveDirection,
          hasLiveComparison,
          clobSnapshot
        };
      } catch (err) {
        console.warn(\`[PredictionMarkets] Poly5M slug fetch failed for \${sym} \${slug}:\`, err?.message || err);
        return null;
      }
    }));

    const validResults = results.filter(r => r !== null);
    if (validResults.length === 0) {
      _poly5mCache[sym] = { data: null, windowTs, fetchedAt: Date.now() };
      return null;
    }

    let primary = null;
    for (const ts of candidates) {
      primary = validResults.find(r => r.ts === ts);
      if (primary) break;
    }

    if (!primary) {
      _poly5mCache[sym] = { data: null, windowTs, fetchedAt: Date.now() };
      return null;
    }

    const markets = validResults.sort((a, b) => a.ts - b.ts).map(r => ({
      question: r.title,
      yes: r.liveUpProb,
      gammaYes: r.upProb,
      clobYes: Number.isFinite(r.clobProb) ? r.clobProb : null,
      vol24h: r.volume,
      endDate: r.endDate,
      slug: r.marketSlug,
      targetPrice: r.priceToBeat,
      targetPriceNum: r.priceToBeatNum,
      currentPriceNum: r.currentPriceNum,
      currentPriceSource: r.currentPriceSource,
      chainlinkCurrentPriceNum: r.chainlinkCurrentPriceNum,
      oracleBasisNum: r.oracleBasisNum,
      priceDeltaNum: r.priceDeltaNum,
      liveDirection: r.liveDirection,
      settlementLiveDirection: r.settlementLiveDirection,
      discoverySource: r.hit.source || 'gamma-markets-slug',
    }));

    const data = {
      probability: primary.liveUpProb,
      gammaProbability: primary.upProb,
      clobProbability: Number.isFinite(primary.clobProb) ? primary.clobProb : null,
      volume: primary.volume,
      title: primary.title,
      slug: primary.marketSlug,
      closeTime: primary.endDate,
      endDate: primary.endDate,
      startDate: primary.startDate,
      bestBid: primary.clobSnapshot?.bestBid ?? (parseFloat(primary.m.bestBid || primary.m.best_bid || 0) || null),
      bestAsk: primary.clobSnapshot?.bestAsk ?? (parseFloat(primary.m.bestAsk || primary.m.best_ask || 0) || null),
      liquidity: parseFloat(primary.m.liquidityNum || primary.m.liquidity || 0) || 0,
      targetPrice: primary.priceToBeat,
      targetPriceNum: primary.priceToBeatNum,
      targetPriceApprox: primary.priceToBeatSource === 'polymarket-rtds-chainlink-open',
      priceToBeat: primary.priceToBeat,
      priceToBeatNum: primary.priceToBeatNum,
      priceToBeatSource: primary.priceToBeatSource,
      currentPrice: _formatPolyPriceToBeat(primary.currentPriceNum),
      currentPriceNum: primary.currentPriceNum,
      currentPriceTs: primary.currentPriceTs,
      currentPriceSource: primary.currentPriceSource,
      currentPriceAgeMs: primary.pythCurrent?.ageMs ?? null,
      currentPriceJustification: primary.currentPriceJustification,
      chainlinkCurrentPriceNum: primary.chainlinkCurrentPriceNum,
      chainlinkCurrentPriceTs: primary.chainlinkCurrentPriceTs,
      oracleBasisNum: primary.oracleBasisNum,
      settlementPriceDeltaNum: primary.settlementPriceDeltaNum,
      settlementLiveDirection: primary.settlementLiveDirection,
      priceDelta: primary.priceDeltaNum != null ? _formatPolyPriceToBeat(Math.abs(primary.priceDeltaNum)) : null,
      priceDeltaNum: primary.priceDeltaNum,
      priceDeltaPct: primary.priceDeltaPct,
      liveDirection: primary.liveDirection,
      liveSignal: primary.liveDirection,
      liveState: primary.hasLiveComparison ? (primary.priceDeltaNum >= 0 ? 'above' : 'below') : 'unknown',
      clobConditionId: primary.clobSnapshot?.conditionId || primary.m.conditionId || primary.m.condition_id || null,
      clobTokenIds: _polyClobTokenIds(primary.m),
      clobUpAssetId: primary.clobSnapshot?.upAssetId || null,
      clobDownAssetId: primary.clobSnapshot?.downAssetId || null,
      clobSnapshotTs: primary.clobSnapshot?.ts || null,
      discoverySource: primary.hit.source || 'gamma-markets-slug',
      fallbackJustification: primary.hit.fallbackJustification || null,
      markets,
      _source: primary.hit.source === 'gamma-markets-slug' ? 'poly5m-slug' : \`poly5m-\${primary.hit.source || 'fallback'}\`,
      _windowTs: primary.ts,
    };
    _poly5mCache[sym] = { data, windowTs, fetchedAt: Date.now() };
    return data;
  }

  function matchesPolymarketCoin(m, sym) {
    const text = \`\${m.question || m.title || ''} \${m.description || ''}\`;
    const q = text.toLowerCase();
    if (POLY_BAD_KW.some(b => q.includes(b))) return false;
    const patterns = COIN_PATTERNS[sym] || [new RegExp(\`\\\\b\${String(sym).toLowerCase()}\\\\b\`, 'i')];
    return patterns.some(re => re.test(text));
  }
`;

const newCode = code.substring(0, startIdx) + fixedFunction + '\n' + code.substring(nextFuncIdx);
fs.writeFileSync(file, newCode, 'utf8');
