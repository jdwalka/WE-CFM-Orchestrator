/**
 * Advanced market microstructure signal helpers.
 *
 * Exposes window.MicrostructureSignals for predictions.js. The helpers are
 * intentionally defensive because live order book payloads vary by exchange.
 */
(function () {
  'use strict';

  function clamp(value, min = -1, max = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(min, Math.min(max, n));
  }

  function toLevel(level) {
    if (Array.isArray(level)) {
      return { price: Number(level[0]), size: Number(level[1]) };
    }
    if (level && typeof level === 'object') {
      return {
        price: Number(level.price ?? level.p ?? level[0]),
        size: Number(level.size ?? level.quantity ?? level.amount ?? level.qty ?? level[1]),
      };
    }
    return { price: NaN, size: NaN };
  }

  function normalizeLevels(levels, limit) {
    return (Array.isArray(levels) ? levels : [])
      .slice(0, Math.max(1, Number(limit) || 1))
      .map(toLevel)
      .filter(level => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size >= 0);
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  async function fetchFundingRateBybit(symbol, timeoutMs = 5000) {
    const sym = `${String(symbol || '').toUpperCase()}USDT`;
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&limit=1`;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => {
      try {
        controller.abort(new DOMException(`Bybit funding fetch timed out after ${timeoutMs}ms`, 'TimeoutError'));
      } catch (_) {
        try { controller.abort(); } catch (_) { }
      }
    }, timeoutMs) : null;
    try {
      const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
      const data = await response.json();
      const latest = data?.result?.list?.[0];
      return {
        rate: Number(latest?.fundingRate) || 0,
        nextTime: Number(latest?.nextFundingTime) || 0,
        timestamp: Number(latest?.fundingRateTimestamp) || Date.now(),
      };
    } catch (err) {
      console.warn(`[MicroSignals] Funding rate fetch failed for ${symbol}:`, err?.message || err);
      return { rate: 0, nextTime: 0, timestamp: Date.now() };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function analyzeFundingPressure(fundingRate) {
    const rate = Number(fundingRate) || 0;
    const absRate = Math.abs(rate);
    const normal = 0.0005;
    const high = 0.001;
    const extreme = 0.0015;

    if (absRate < 0.00001) {
      return { signal: 0, pressure: 'neutral', strength: 0 };
    }

    const side = rate > 0 ? -1 : 1;
    let pressure = rate > 0 ? 'long_bias' : 'short_bias';
    let signal = 0;
    let strength = 0;

    if (absRate >= extreme) {
      pressure = rate > 0 ? 'extreme_long_heavy' : 'extreme_short_heavy';
      strength = clamp((absRate - extreme) / 0.001, 0, 1);
      signal = side * (0.65 + strength * 0.35);
    } else if (absRate >= high) {
      pressure = rate > 0 ? 'high_long_bias' : 'high_short_bias';
      strength = (absRate - high) / (extreme - high);
      signal = side * (0.45 + strength * 0.20);
    } else if (absRate >= normal) {
      strength = (absRate - normal) / (high - normal);
      signal = side * (0.15 + strength * 0.15);
    }

    return { signal: clamp(signal), pressure, strength: clamp(strength, 0, 1) };
  }

  function parseDepthOptions(levelsOrOptions) {
    if (levelsOrOptions && typeof levelsOrOptions === 'object') {
      const requested = Array.isArray(levelsOrOptions.levels)
        ? levelsOrOptions.levels
        : [levelsOrOptions.levels || 10, levelsOrOptions.maxLevels || 20];
      return {
        levelList: Array.from(new Set(requested.map(n => Math.max(1, Number(n) || 1)))).sort((a, b) => a - b),
        balance: levelsOrOptions.balance || null,
      };
    }
    const max = Math.max(20, Number(levelsOrOptions) || 20);
    return { levelList: [10, max], balance: null };
  }

  function levelWeight(index, levels) {
    const slope = levels <= 10 ? 0.22 : 0.15;
    return 1 / (1 + index * slope);
  }

  function summarizeWeightedDepth(rows, levels) {
    return rows.slice(0, levels).reduce((acc, row, index) => {
      const weight = levelWeight(index, levels);
      const notional = row.price * row.size;
      acc.rawSize += row.size;
      acc.rawNotional += notional;
      acc.weightedSize += row.size * weight;
      acc.weightedNotional += notional * weight;
      acc.levels = index + 1;
      return acc;
    }, {
      levels: 0,
      rawSize: 0,
      rawNotional: 0,
      weightedSize: 0,
      weightedNotional: 0,
    });
  }

  function classifyLiquidity(levels) {
    const l10 = levels.level10 || {};
    const l20 = levels.level20 || l10;
    const notional10 = Number(l10.totalNotional) || 0;
    const notional20 = Number(l20.totalNotional) || notional10;
    const score = clamp(Math.log10(Math.max(1, notional20)) / 8, 0, 1);
    return {
      notional10,
      notional20,
      weighted20: Number(l20.weightedTotalNotional) || 0,
      depthExpansion: notional10 > 0 ? notional20 / notional10 : 0,
      score,
      band: score >= 0.78 ? 'deep' : score >= 0.58 ? 'healthy' : score >= 0.38 ? 'thin' : 'fragile',
    };
  }

  function analyzeOrderBookImbalance(book, levelsOrOptions = 20) {
    const opts = parseDepthOptions(levelsOrOptions);
    const maxLevels = Math.max(...opts.levelList, 20);
    const bids = normalizeLevels(book?.bids, maxLevels);
    const asks = normalizeLevels(book?.asks, maxLevels);
    if (bids.length < 2 || asks.length < 2) {
      return { imbalance: 0, distribution: {}, depth: {}, levels: {}, velocity: { value: 0 }, liquidity: {}, error: 'Insufficient book data' };
    }

    const bidNear = bids.slice(0, 3).reduce((sum, row) => sum + row.size, 0);
    const askNear = asks.slice(0, 3).reduce((sum, row) => sum + row.size, 0);
    const bidMid = bids.slice(3, 8).reduce((sum, row) => sum + row.size, 0);
    const askMid = asks.slice(3, 8).reduce((sum, row) => sum + row.size, 0);
    const bidDeep = bids.slice(8).reduce((sum, row) => sum + row.size, 0);
    const askDeep = asks.slice(8).reduce((sum, row) => sum + row.size, 0);
    const levelSummaries = {};
    opts.levelList.forEach(levelCount => {
      const bid = summarizeWeightedDepth(bids, levelCount);
      const ask = summarizeWeightedDepth(asks, levelCount);
      const weightedTotal = bid.weightedNotional + ask.weightedNotional;
      const totalNotional = bid.rawNotional + ask.rawNotional;
      levelSummaries[`level${levelCount}`] = {
        levels: levelCount,
        bid,
        ask,
        bidTotal: bid.weightedNotional,
        askTotal: ask.weightedNotional,
        bidNotional: bid.rawNotional,
        askNotional: ask.rawNotional,
        weightedTotalNotional: weightedTotal,
        totalNotional,
        imbalance: weightedTotal > 0 ? clamp((bid.weightedNotional - ask.weightedNotional) / weightedTotal) : 0,
      };
    });

    const level10 = levelSummaries.level10 || Object.values(levelSummaries)[0];
    const level20 = levelSummaries.level20 || Object.values(levelSummaries)[Object.values(levelSummaries).length - 1] || level10;
    const blendImbalance = clamp((level10?.imbalance || 0) * 0.62 + (level20?.imbalance || 0) * 0.38);
    const velocitySource = opts.balance?.velocity || book?.balance?.velocity || book?.depthMetrics?.velocity || {};
    const velocity = {
      value: clamp(Number(velocitySource.value) || 0),
      shortPerMin: Number(velocitySource.shortPerMin) || 0,
      windowPerMin: Number(velocitySource.windowPerMin) || 0,
      windowDelta: Number(velocitySource.windowDelta) || 0,
      accel: Number(velocitySource.accel) || 0,
      band: velocitySource.band || 'stable',
      direction: velocitySource.direction || 'flat',
    };
    const liquidity = opts.balance?.liquidity || book?.balance?.liquidity || book?.depthMetrics?.liquidity || classifyLiquidity(levelSummaries);

    return {
      imbalance: blendImbalance,
      distribution: { bidNear, bidMid, bidDeep, askNear, askMid, askDeep },
      depth: {
        bidTotal: level20?.bidTotal || 0,
        askTotal: level20?.askTotal || 0,
        spread: Math.max(0, asks[0].price - bids[0].price),
        levels: levelSummaries,
        liquidity,
        velocity,
      },
      levels: levelSummaries,
      velocity,
      liquidity,
    };
  }

  function imbalanceToSignal(imbalance, distribution, meta) {
    const source = imbalance && typeof imbalance === 'object' ? imbalance : meta;
    const value = clamp(imbalance && typeof imbalance === 'object' ? imbalance.imbalance : imbalance);
    const velocity = clamp(source?.velocity?.value ?? 0);
    const liquidity = source?.liquidity || source?.depth?.liquidity || {};
    const liquidityScore = Number.isFinite(Number(liquidity.score)) ? Number(liquidity.score) : 0.65;
    const absValue = Math.abs(value);
    if (absValue < 0.10 && Math.abs(velocity) < 0.18) {
      return { signal: 0, strength: 0, type: 'balanced', velocity, liquidity, levels: source?.levels || {} };
    }

    let magnitude = 0.15;
    let type = value > 0 ? 'slight_buy_bias' : 'slight_sell_bias';
    if (absValue >= 0.50) {
      magnitude = 0.55 + Math.min(0.45, (absValue - 0.50) * 0.90);
      type = value > 0 ? 'strong_buy_wall' : 'strong_sell_wall';
    } else if (absValue >= 0.25) {
      magnitude = 0.35 + (absValue - 0.25) * 0.80;
      type = value > 0 ? 'moderate_buy_bias' : 'moderate_sell_bias';
    } else {
      magnitude = 0.15 + (absValue - 0.10) * 1.33;
    }

    const direction = Math.sign(value || velocity || 0);
    const velocityAligned = direction && Math.sign(velocity) === direction ? Math.abs(velocity) : 0;
    const velocityOpposed = direction && Math.sign(velocity) === -direction ? Math.abs(velocity) : 0;
    const liquidityDampen = liquidityScore < 0.38 ? 0.65 : liquidityScore < 0.58 ? 0.82 : 1;
    const adjustedMagnitude = magnitude * (1 + velocityAligned * 0.22) * (1 - velocityOpposed * 0.22) * liquidityDampen;

    return {
      signal: clamp(direction * adjustedMagnitude + velocity * 0.12),
      strength: clamp(absValue, 0, 1),
      type,
      velocity,
      velocityBand: source?.velocity?.band || 'stable',
      liquidity,
      levels: source?.levels || source?.depth?.levels || {},
    };
  }

  function detectLiquidityVacuum(book, midPrice, lookupLevels = 30) {
    const mid = Number(midPrice) || 0;
    const bids = normalizeLevels(book?.bids, lookupLevels).sort((a, b) => b.price - a.price);
    const asks = normalizeLevels(book?.asks, lookupLevels).sort((a, b) => a.price - b.price);
    if (!mid || bids.length < 3 || asks.length < 3) {
      return { vacuumFound: false, zones: [], zonesCount: 0, risk: 0, error: 'Invalid inputs' };
    }

    function collectZones(rows, side) {
      const gaps = [];
      for (let i = 0; i < rows.length - 1; i++) {
        gaps.push(Math.abs(rows[i + 1].price - rows[i].price));
      }
      const baseGap = median(gaps) || Math.max(mid * 0.0001, 0.000001);
      const avgSize = rows.reduce((sum, row) => sum + row.size, 0) / rows.length || 0;
      const zones = [];

      for (let i = 0; i < rows.length - 1; i++) {
        const current = rows[i];
        const next = rows[i + 1];
        const gap = Math.abs(next.price - current.price);
        const localSize = (current.size + next.size) / 2;
        const gapIntensity = clamp((gap / baseGap - 1.5) / 3, 0, 1);
        const thinIntensity = avgSize > 0 ? clamp(1 - localSize / avgSize, 0, 1) : 0;
        const intensity = Math.max(gapIntensity, thinIntensity * 0.75);

        if (intensity >= 0.25) {
          zones.push({
            side,
            lower: Math.min(current.price, next.price),
            upper: Math.max(current.price, next.price),
            gap,
            gapPct: gap / mid,
            intensity,
          });
        }
      }

      return zones;
    }

    const zones = collectZones(bids, 'bid').concat(collectZones(asks, 'ask'));
    const risk = zones.reduce((max, zone) => Math.max(max, zone.intensity), 0);
    return {
      vacuumFound: zones.length > 0,
      zones,
      zonesCount: zones.length,
      risk: clamp(risk, 0, 1),
    };
  }

  function vacuumToSignal(vacuumData) {
    const zones = Array.isArray(vacuumData?.zones) ? vacuumData.zones : [];
    if (!vacuumData?.vacuumFound || zones.length === 0) {
      return { signal: 0, type: 'none', risk: 0 };
    }

    const upside = zones
      .filter(zone => zone.side === 'ask')
      .reduce((max, zone) => Math.max(max, zone.intensity), 0);
    const downside = zones
      .filter(zone => zone.side === 'bid')
      .reduce((max, zone) => Math.max(max, zone.intensity), 0);
    const signal = clamp((upside - downside) * 0.75);
    const risk = clamp(Math.max(upside, downside, Number(vacuumData.risk) || 0), 0, 1);

    let type = 'mixed_vacuum';
    if (signal > 0.05) type = 'upside_vacuum';
    if (signal < -0.05) type = 'downside_vacuum';
    return { signal, type, risk, upside, downside };
  }

  window.MicrostructureSignals = {
    fetchFundingRateBybit,
    analyzeFundingPressure,
    analyzeOrderBookImbalance,
    imbalanceToSignal,
    detectLiquidityVacuum,
    vacuumToSignal,
  };
})();
