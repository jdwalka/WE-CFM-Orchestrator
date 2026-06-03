const https = require('https');

const OPEN_SOON_WINDOW_MS = 90 * 60 * 1000;
const MIN_TARGET_CLOSE_LEAD_MS = 6 * 60 * 1000;

function pickTargetCloseTime(markets, minLeadMs = 0) {
  const now = Date.now();
  const byClose = new Map();
  for (const m of (Array.isArray(markets) ? markets : [])) {
    const closeMs = Date.parse(m.close_time);
    if (!Number.isFinite(closeMs)) continue;
    const openMs = Date.parse(m.open_time);
    const existing = byClose.get(closeMs) || {
      closeMs,
      count: 0,
      hasActive: false,
      opensSoon: false,
    };
    existing.count += 1;
    if (Number.isFinite(openMs) && openMs <= now && closeMs >= now) existing.hasActive = true;
    if (Number.isFinite(openMs) && openMs > now && (openMs - now) <= OPEN_SOON_WINDOW_MS) existing.opensSoon = true;
    byClose.set(closeMs, existing);
  }
  const entries = [...byClose.values()];
  if (!entries.length) return null;

  const activeOrSoon = entries.filter(e =>
    (e.hasActive || e.opensSoon) &&
    e.closeMs >= now &&
    (e.closeMs - now) >= minLeadMs
  );
  const upcomingWithLead = entries.filter(e => e.closeMs >= now && (e.closeMs - now) >= minLeadMs);
  const upcoming = entries.filter(e => e.closeMs >= now);
  const pool = activeOrSoon.length
    ? activeOrSoon
    : (upcomingWithLead.length ? upcomingWithLead : (upcoming.length ? upcoming : entries));
  pool.sort((a, b) => {
    // Prefer soonest actionable close bucket, then deepest ladder.
    if (a.closeMs !== b.closeMs) return a.closeMs - b.closeMs;
    return b.count - a.count;
  });
  return new Date(pool[0].closeMs).toISOString();
}

function test() {
  const url = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXXRP&status=open&limit=100';
  console.log('Fetching', url);
  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const markets = json.markets || [];
        console.log('Total fetched:', markets.length);
        
        const uniqueMarkets = Array.from(new Map(markets.map(m => [m.ticker, m])).values());
        console.log('Unique markets:', uniqueMarkets.length);
        
        const targetClose = pickTargetCloseTime(uniqueMarkets, MIN_TARGET_CLOSE_LEAD_MS);
        console.log('Picked Target Close:', targetClose);
        
function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function parseContractPrice(...candidates) {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseStrikeFromTicker(ticker) {
  if (!ticker) return null;
  const m = String(ticker).match(/-T([0-9.]+)$/);
  if (!m) return null;
  return toFiniteNumber(m[1]);
}

function isYesAboveContract(market = {}) {
  const strikeType = String(market.strike_type || '').toLowerCase();
  const yesText = String(market.yes_sub_title || market.subtitle || market.title || '').toLowerCase();
  if (strikeType.includes('below') || strikeType.includes('under')) return false;
  if (strikeType.includes('above') || strikeType.includes('over') || strikeType.includes('greater')) return true;
  if (yesText.includes('below') || yesText.includes('under')) return false;
  return true;
}

function estimateStepFromStrikes(strikes) {
  if (!Array.isArray(strikes) || strikes.length < 2) return 1;
  let best = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    const d = strikes[i] - strikes[i - 1];
    if (Number.isFinite(d) && d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) && best > 0 ? best : 1;
}

function buildRangesFromContracts(markets) {
  const contracts = (Array.isArray(markets) ? markets : []).map(m => {
    const floor = toFiniteNumber(m.floor_strike) ?? toFiniteNumber(m.floor_price);
    const cap = toFiniteNumber(m.cap_strike) ?? toFiniteNumber(m.cap_price);
    const strike = floor ?? cap ?? parseStrikeFromTicker(m.ticker);
    const yesPriceRaw = parseContractPrice(
      m.yes_price_dollars,
      m.yes_price,
      m.yes_ask_dollars,
      m.last_price_dollars,
      m.last_price
    );
    const noPriceRaw = parseContractPrice(
      m.no_price_dollars,
      m.no_price,
      m.no_ask_dollars
    );
    const yesPrice = Number.isFinite(yesPriceRaw) ? yesPriceRaw : 0;
    const noPrice = Number.isFinite(noPriceRaw) ? noPriceRaw : (yesPrice <= 1 ? (1 - yesPrice) : (100 - yesPrice));
    const rawProb = yesPrice > 1 ? yesPrice / 100 : yesPrice;
    const prob = clamp01(rawProb);
    return {
      ticker: m.ticker,
      status: m.status || 'unknown',
      closeTime: m.close_time,
      floor,
      cap,
      strike,
      yesPrice,
      noPrice,
      prob,
      yesIsAbove: isYesAboveContract(m),
    };
  });

  const bounded = contracts
    .filter(c => Number.isFinite(c.floor) && Number.isFinite(c.cap) && c.cap > c.floor)
    .map(c => ({
      ticker: c.ticker,
      low: c.floor,
      high: c.cap,
      yesPrice: c.yesPrice,
      noPrice: c.noPrice,
      prob: c.prob,
      closeTime: c.closeTime,
      status: c.status,
    }));
  if (bounded.length) return bounded;

  const thresholds = contracts
    .filter(c => Number.isFinite(c.strike))
    .sort((a, b) => a.strike - b.strike);
  if (thresholds.length < 2) return [];

  const strikes = thresholds.map(t => t.strike);
  const step = estimateStepFromStrikes(strikes);
  const exceedance = thresholds.map(t => {
    const pYes = clamp01(t.prob);
    if (pYes == null) return null;
    return t.yesIsAbove ? pYes : (1 - pYes);
  });

  const synthetic = [];
  const firstEx = exceedance[0];
  if (firstEx != null) {
    synthetic.push({
      ticker: `${thresholds[0].ticker}|tail-lower`,
      low: thresholds[0].strike - step,
      high: thresholds[0].strike,
      yesPrice: thresholds[0].yesPrice,
      noPrice: thresholds[0].noPrice,
      prob: clamp01(1 - firstEx),
      closeTime: thresholds[0].closeTime,
      status: thresholds[0].status,
    });
  }

  for (let i = 0; i < thresholds.length - 1; i++) {
    const lowC = thresholds[i];
    const highC = thresholds[i + 1];
    const pLow = exceedance[i];
    const pHigh = exceedance[i + 1];
    synthetic.push({
      ticker: `${lowC.ticker}|band`,
      low: lowC.strike,
      high: highC.strike,
      yesPrice: lowC.yesPrice,
      noPrice: lowC.noPrice,
      prob: (pLow != null && pHigh != null) ? clamp01(pLow - pHigh) : clamp01(lowC.prob),
      closeTime: lowC.closeTime || highC.closeTime,
      status: lowC.status,
    });
  }

  const last = thresholds[thresholds.length - 1];
  const lastEx = exceedance[exceedance.length - 1];
  if (lastEx != null) {
    synthetic.push({
      ticker: `${last.ticker}|tail-upper`,
      low: last.strike,
      high: last.strike + step,
      yesPrice: last.yesPrice,
      noPrice: last.noPrice,
      prob: clamp01(lastEx),
      closeTime: last.closeTime,
      status: last.status,
    });
  }
  return synthetic;
}

        if (targetClose) {
          const filtered = uniqueMarkets.filter(m => {
            const ms = Date.parse(m.close_time);
            return Number.isFinite(ms) && new Date(ms).toISOString() === targetClose;
          });
          console.log('Markets in target close bucket:', filtered.length);
          if (filtered.length > 0) {
            console.log('Sample market:', filtered[0].ticker, filtered[0].status, filtered[0].close_time, filtered[0].open_time);
            const ranges = buildRangesFromContracts(filtered);
            console.log('Ranges parsed:', ranges.length);
            if (ranges.length > 0) {
              console.log('First range:', ranges[0].ticker, ranges[0].low, ranges[0].high);
            } else {
              console.log('Contracts sample 0 strike_type:', filtered[0].strike_type, 'yes_sub_title:', filtered[0].yes_sub_title);
              console.log('Contracts threshold count:', filtered.filter(m => {
                 let s = toFiniteNumber(m.floor_strike) ?? toFiniteNumber(m.floor_price) ?? toFiniteNumber(m.cap_strike) ?? toFiniteNumber(m.cap_price) ?? parseStrikeFromTicker(m.ticker);
                 return Number.isFinite(s);
              }).length);
            }
          }
        }

        
      } catch (e) {
        console.error('Parse error:', e, data.substring(0, 100));
      }
    });
  }).on('error', (e) => {
    console.error(e);
  });
}

test();
