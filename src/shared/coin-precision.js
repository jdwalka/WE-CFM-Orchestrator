/**
 * Centralized Authoritative Per-Coin Precision Utility
 * 
 * Rules:
 * - BTC: 2 decimals (.00 cents)
 * - ETH: 2 decimals (.00 cents)
 * - SOL: 2 decimals (.00 cents)
 * - BNB: 2 decimals (.00 cents)
 * - HYPE: 2 decimals (.00 cents)
 * - XRP: 4 decimals (.0000)
 * - DOGE: 4 decimals (.0000)
 *
 * Supports Browser (window.CoinPrecision) and Node.js (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.CoinPrecision = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COIN_PRECISION_CONFIG = {
    BTC:  { decimals: 2, deltaDecimals: 2, minDisplay: 2, maxDisplay: 2 },
    ETH:  { decimals: 2, deltaDecimals: 2, minDisplay: 2, maxDisplay: 2 },
    SOL:  { decimals: 2, deltaDecimals: 2, minDisplay: 2, maxDisplay: 2 },
    BNB:  { decimals: 2, deltaDecimals: 2, minDisplay: 2, maxDisplay: 2 },
    HYPE: { decimals: 2, deltaDecimals: 2, minDisplay: 2, maxDisplay: 2 },
    XRP:  { decimals: 4, deltaDecimals: 4, minDisplay: 4, maxDisplay: 4 },
    DOGE: { decimals: 4, deltaDecimals: 4, minDisplay: 4, maxDisplay: 4 },
  };

  /**
   * Normalizes any coin input (symbol, slug, ticker, URL fragment) to standard uppercase symbol.
   * Examples:
   *   'btc' -> 'BTC'
   *   'btc-updown-15m-1725450000' -> 'BTC'
   *   'KXETH15M' -> 'ETH'
   *   'sol/usd' -> 'SOL'
   *   'XRP-USD' -> 'XRP'
   */
  function normalizeCoinSymbol(coinOrSlug) {
    if (!coinOrSlug) return 'BTC';
    if (typeof coinOrSlug === 'object' && coinOrSlug !== null) {
      coinOrSlug = coinOrSlug.sym || coinOrSlug.symbol || coinOrSlug.coin || coinOrSlug.slug || '';
    }
    const raw = String(coinOrSlug).trim();
    if (!raw) return 'BTC';

    const upper = raw.toUpperCase();
    if (COIN_PRECISION_CONFIG[upper]) return upper;

    // Check slug prefixes: btc-updown-..., doge-5m-...
    const slugMatch = raw.match(/^(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)\b/i);
    if (slugMatch) return slugMatch[1].toUpperCase();

    // Check Kalshi ticker format: KXETH15M, KXDOGE5M, KXBTC15M
    const kalshiMatch = raw.match(/^KX(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)/i);
    if (kalshiMatch) return kalshiMatch[1].toUpperCase();

    // Check pair formats: BTC-USD, BTC/USD, BTCUSD, XXRPZUSD, XDOGEZUSD
    const pairMatch = raw.match(/\b(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)\b/i);
    if (pairMatch) return pairMatch[1].toUpperCase();

    // Kraken symbols
    if (upper.includes('XXRP')) return 'XRP';
    if (upper.includes('XDOGE')) return 'DOGE';
    if (upper.includes('XETH') || upper.includes('XETHZ')) return 'ETH';
    if (upper.includes('XXBT') || upper.includes('XXBTZ')) return 'BTC';

    // Fallback: extract leading letters
    const clean = upper.replace(/[^A-Z]/g, '').slice(0, 5);
    return clean || 'BTC';
  }

  /**
   * Returns exact decimal precision for a coin.
   * BTC & ETH -> 2 (.00 cents)
   * XRP & DOGE -> 4 (.0000)
   */
  function getCoinDecimals(coinOrSlug, value) {
    const sym = normalizeCoinSymbol(coinOrSlug);
    const cfg = COIN_PRECISION_CONFIG[sym];
    if (cfg) return cfg.decimals;

    // Unknown asset: inspect magnitude
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && n < 1) return 4;
    return 2;
  }

  /**
   * Returns decimal precision for price differences / deltas / spreads.
   */
  function getCoinDeltaDecimals(coinOrSlug, value) {
    const sym = normalizeCoinSymbol(coinOrSlug);
    const cfg = COIN_PRECISION_CONFIG[sym];
    if (cfg) return cfg.deltaDecimals;

    const n = Number(value);
    if (Number.isFinite(n) && Math.abs(n) > 0 && Math.abs(n) < 1) return 4;
    return 2;
  }

  /**
   * Rounds price to coin's canonical precision.
   */
  function roundCoinPrice(coinOrSlug, value) {
    const n = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]+/g, '')) : Number(value);
    if (!Number.isFinite(n)) return null;
    const d = getCoinDecimals(coinOrSlug, n);
    const f = 10 ** d;
    return Math.round(n * f) / f;
  }

  /**
   * Formats coin price with proper commas and fixed decimals.
   * e.g. BTC: "$65,432.10", XRP: "$0.5842", XRP @ $1.2: "$1.2000"
   */
  function formatCoinPrice(coinOrSlug, value, options = {}) {
    const {
      prefix = '$',
      useGrouping = true,
      fallback = '—',
      minDecimals,
      maxDecimals,
      allowZero = false,
    } = options;

    if (value === null || value === undefined || value === '') return fallback;
    const n = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]+/g, '')) : Number(value);
    if (!Number.isFinite(n) || (!allowZero && n <= 0)) return fallback;

    const sym = normalizeCoinSymbol(coinOrSlug);
    const defaultDec = getCoinDecimals(sym, n);
    const minD = minDecimals !== undefined ? minDecimals : defaultDec;
    const maxD = maxDecimals !== undefined ? maxDecimals : defaultDec;

    const formatted = n.toLocaleString('en-US', {
      minimumFractionDigits: minD,
      maximumFractionDigits: maxD,
      useGrouping,
    });

    return `${prefix}${formatted}`;
  }

  /**
   * Formats signed price delta (e.g. +$0.0025, -$0.0012 for XRP; +$12.50 for BTC)
   */
  function formatCoinDelta(coinOrSlug, delta, options = {}) {
    const {
      prefix = '$',
      showSign = true,
      useGrouping = true,
      fallback = '—',
      minDecimals,
      maxDecimals,
    } = options;

    if (delta === null || delta === undefined || delta === '') return fallback;
    const n = typeof delta === 'string' ? parseFloat(delta.replace(/[^0-9.-]+/g, '')) : Number(delta);
    if (!Number.isFinite(n)) return fallback;

    const sym = normalizeCoinSymbol(coinOrSlug);
    const defaultDec = getCoinDeltaDecimals(sym, n);
    const minD = minDecimals !== undefined ? minDecimals : defaultDec;
    const maxD = maxDecimals !== undefined ? maxDecimals : defaultDec;

    const sign = n > 0 ? (showSign ? '+' : '') : (n < 0 ? '-' : '');
    const absFormatted = Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: minD,
      maximumFractionDigits: maxD,
      useGrouping,
    });

    return `${sign}${prefix}${absFormatted}`;
  }

  /**
   * Formats strike / price-to-beat value.
   */
  function formatCoinStrike(coinOrSlug, strike, options = {}) {
    return formatCoinPrice(coinOrSlug, strike, options);
  }

  /**
   * Human-friendly full display name for the 7 majors.
   */
  const COIN_NAMES = {
    BTC: 'Bitcoin',
    ETH: 'Ethereum',
    SOL: 'Solana',
    XRP: 'XRP',
    DOGE: 'Dogecoin',
    BNB: 'BNB',
    HYPE: 'Hyperliquid',
  };

  function getCoinDisplayName(coinOrSlug) {
    const sym = normalizeCoinSymbol(coinOrSlug);
    return COIN_NAMES[sym] || sym;
  }

  /**
   * Formats notional dollar volume / liquidity cleanly without IEEE-754 floating-point noise.
   * e.g. 2572.4642000000003 -> "$2,572.46"
   * e.g. 15000 -> "$15,000"
   */
  function formatNotional(value, options = {}) {
    const { prefix = '$', fallback = '$0.00', decimals } = options;
    if (value === null || value === undefined || value === '') return fallback;
    const n = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]+/g, '')) : Number(value);
    if (!Number.isFinite(n) || n === 0) return fallback;

    const abs = Math.abs(n);
    let d = 2;
    if (decimals !== undefined) {
      d = decimals;
    } else if (abs >= 1000 && Math.abs(n - Math.round(n)) < 0.001) {
      d = 0;
    }

    const formatted = n.toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
      useGrouping: true,
    });
    return `${prefix}${formatted}`;
  }

  /**
   * Formats time-to-close (TTC) in seconds to clean human-readable duration.
   * e.g. 627 -> "10m 27s"
   * e.g. 45 -> "45s"
   */
  function formatTtc(seconds) {
    if (seconds === null || seconds === undefined) return 'unknown time';
    const s = Number(seconds);
    if (!Number.isFinite(s)) return 'unknown time';
    if (s <= 0) return 'closed';
    if (s < 60) return `${Math.round(s)}s`;
    const mins = Math.floor(s / 60);
    const secs = Math.round(s % 60);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }

  return {
    COIN_PRECISION_CONFIG,
    COIN_NAMES,
    normalizeCoinSymbol,
    getCoinDisplayName,
    getCoinDecimals,
    getCoinDeltaDecimals,
    roundCoinPrice,
    formatCoinPrice,
    formatCoinDelta,
    formatCoinStrike,
    formatNotional,
    formatTtc,
  };
}));
