// ================================================================
// exchange-registry.js — Centralized Exchange Metadata & Orchestration
// 
// Defines the geographic regions and orbital tiers (s, p, d, f) for all 
// ingested exchange data streams based on their liquidity and volatility profiles.
// ================================================================

(function () {
  'use strict';

  const REGIONS = {
    GLOBAL: 'Global / Offshore',
    ASIA: 'Asia',
    NA: 'North America',
    EU: 'Europe',
    MEA: 'Middle East & Africa',
    LATAM: 'Latin America',
  };

  const ORBITALS = {
    s: { label: 'Core Liquidity', weight: 1.0 },
    p: { label: 'Reactive/Momentum', weight: 0.8 },
    d: { label: 'High Beta/Specialized', weight: 0.5 },
    f: { label: 'Anomalous/Illiquid', weight: 0.2 },
  };

  // Structured from highest to lowest volume within each region
  const EXCHANGES = [
    // 🌐 Global / Offshore
    { id: 'BINANCE', name: 'Binance', region: REGIONS.GLOBAL, volumeUSD: 7596000000, trust: 10, orbital: 's' },
    { id: 'AZBIT', name: 'Azbit', region: REGIONS.GLOBAL, volumeUSD: 3481000000, trust: 7, orbital: 'p' },
    { id: 'BITMART', name: 'BitMart', region: REGIONS.GLOBAL, volumeUSD: 1837000000, trust: 8, orbital: 'p' },
    { id: 'BYBIT', name: 'Bybit', region: REGIONS.GLOBAL, volumeUSD: 1826000000, trust: 9, orbital: 's' },
    { id: 'GATE', name: 'Gate', region: REGIONS.GLOBAL, volumeUSD: 1662000000, trust: 9, orbital: 's' },
    { id: 'OKX', name: 'OKX', region: REGIONS.GLOBAL, volumeUSD: 1445000000, trust: 10, orbital: 's' },
    { id: 'LBANK', name: 'LBank', region: REGIONS.GLOBAL, volumeUSD: 1403000000, trust: 8, orbital: 'p' },
    { id: 'MEXC', name: 'MEXC', region: REGIONS.GLOBAL, volumeUSD: 1381000000, trust: 9, orbital: 'p' },
    { id: 'WEEX', name: 'WEEX', region: REGIONS.GLOBAL, volumeUSD: 1242000000, trust: 8, orbital: 'p' },
    { id: 'BITGET', name: 'Bitget', region: REGIONS.GLOBAL, volumeUSD: 1226000000, trust: 9, orbital: 's' },
    { id: 'KUCOIN', name: 'KuCoin', region: REGIONS.GLOBAL, volumeUSD: 1199000000, trust: 8, orbital: 'p' },
    { id: 'DIGIFINEX', name: 'DigiFinex', region: REGIONS.GLOBAL, volumeUSD: 1168000000, trust: 8, orbital: 'p' },
    { id: 'HTX', name: 'HTX', region: REGIONS.GLOBAL, volumeUSD: 1088000000, trust: 7, orbital: 'p' },
    { id: 'OURBIT', name: 'Ourbit', region: REGIONS.GLOBAL, volumeUSD: 1029000000, trust: 8, orbital: 'p' },
    { id: 'BULLISH', name: 'Bullish', region: REGIONS.GLOBAL, volumeUSD: 685020000, trust: 8, orbital: 'p' },
    { id: 'DERIBIT_SPOT', name: 'Deribit Spot', region: REGIONS.GLOBAL, volumeUSD: 9266000, trust: 7, orbital: 'd' },
    { id: 'HASHKEY_GLOBAL', name: 'HashKey Global', region: REGIONS.GLOBAL, volumeUSD: 724030, trust: 8, orbital: 'f' },
    { id: 'BITMEX', name: 'BitMEX', region: REGIONS.GLOBAL, volumeUSD: 55610, trust: 7, orbital: 'f' },

    // 🌏 Asia
    { id: 'PIONEX', name: 'Pionex', region: REGIONS.ASIA, volumeUSD: 2851000000, trust: 7, orbital: 'p' },
    { id: 'UPBIT', name: 'Upbit', region: REGIONS.ASIA, volumeUSD: 1011000000, trust: 8, orbital: 's' },
    { id: 'CDC', name: 'Crypto.com Exchange', region: REGIONS.ASIA, volumeUSD: 846380000, trust: 9, orbital: 's' },
    { id: 'BITHUMB', name: 'Bithumb', region: REGIONS.ASIA, volumeUSD: 521030000, trust: 7, orbital: 'p' },
    { id: 'BINGX', name: 'BingX', region: REGIONS.ASIA, volumeUSD: 495320000, trust: 9, orbital: 'p' },
    { id: 'BITRUE', name: 'Bitrue', region: REGIONS.ASIA, volumeUSD: 406040000, trust: 7, orbital: 'p' },
    { id: 'BITKAN', name: 'BitKan', region: REGIONS.ASIA, volumeUSD: 137870000, trust: 8, orbital: 'd' },
    { id: 'COINS_PH', name: 'Coins.ph', region: REGIONS.ASIA, volumeUSD: 57470000, trust: 8, orbital: 'd' },
    { id: 'HASHKEY', name: 'HashKey Exchange', region: REGIONS.ASIA, volumeUSD: 56990000, trust: 9, orbital: 'd' },
    { id: 'BITKUB', name: 'Bitkub', region: REGIONS.ASIA, volumeUSD: 56590000, trust: 8, orbital: 'd' },
    { id: 'BITBANK', name: 'Bitbank', region: REGIONS.ASIA, volumeUSD: 23460000, trust: 8, orbital: 'd' },
    { id: 'BITAZZA', name: 'Bitazza', region: REGIONS.ASIA, volumeUSD: 23030000, trust: 7, orbital: 'd' },
    { id: 'INDODAX', name: 'Indodax', region: REGIONS.ASIA, volumeUSD: 9845000, trust: 7, orbital: 'f' },

    // 🌎 North America
    { id: 'COINBASE', name: 'Coinbase Exchange', region: REGIONS.NA, volumeUSD: 1424000000, trust: 10, orbital: 's' },
    { id: 'KRAKEN', name: 'Kraken', region: REGIONS.NA, volumeUSD: 631160000, trust: 10, orbital: 's' },
    { id: 'GEMINI', name: 'Gemini', region: REGIONS.NA, volumeUSD: 26030000, trust: 9, orbital: 'd' },
    { id: 'BINANCE_US', name: 'Binance US', region: REGIONS.NA, volumeUSD: 14460000, trust: 8, orbital: 'd' },
    { id: 'GATE_US', name: 'Gate US', region: REGIONS.NA, volumeUSD: 249420, trust: 8, orbital: 'f' },

    // 🇪🇺 Europe
    { id: 'WHITEBIT', name: 'WhiteBIT', region: REGIONS.EU, volumeUSD: 1233000000, trust: 8, orbital: 'p' },
    { id: 'BITVAVO', name: 'Bitvavo', region: REGIONS.EU, volumeUSD: 200840000, trust: 9, orbital: 'p' },
    { id: 'BITSTAMP', name: 'Bitstamp by Robinhood', region: REGIONS.EU, volumeUSD: 199880000, trust: 10, orbital: 'p' },
    { id: 'BIT2ME', name: 'Bit2Me', region: REGIONS.EU, volumeUSD: 172060000, trust: 8, orbital: 'p' },
    { id: 'NIZA', name: 'Niza.io', region: REGIONS.EU, volumeUSD: 125210000, trust: 7, orbital: 'd' },
    { id: 'COINTR', name: 'CoinTR', region: REGIONS.EU, volumeUSD: 125000000, trust: 8, orbital: 'd' },
    { id: 'BYBIT_EU', name: 'Bybit EU', region: REGIONS.EU, volumeUSD: 22920000, trust: 7, orbital: 'd' },
    { id: 'BITCOINTRY', name: 'Bitcointry', region: REGIONS.EU, volumeUSD: 17850000, trust: 8, orbital: 'd' },
    { id: 'LUNO', name: 'Luno', region: REGIONS.EU, volumeUSD: 4406000, trust: 8, orbital: 'f' },

    // 🐪 Middle East & Africa
    { id: 'COINW', name: 'CoinW', region: REGIONS.MEA, volumeUSD: 1610000000, trust: 8, orbital: 'p' },
    { id: 'BITUNIX', name: 'Bitunix', region: REGIONS.MEA, volumeUSD: 322440000, trust: 8, orbital: 'p' },
    { id: 'LEVEX', name: 'LeveX', region: REGIONS.MEA, volumeUSD: 16890000, trust: 8, orbital: 'd' },
    { id: 'BACKPACK', name: 'Backpack Exchange', region: REGIONS.MEA, volumeUSD: 9038000, trust: 8, orbital: 'f' },
    { id: 'VALR', name: 'VALR', region: REGIONS.MEA, volumeUSD: 6720000, trust: 7, orbital: 'f' },

    // 🌮 Latin America
    { id: 'BITSO', name: 'Bitso', region: REGIONS.LATAM, volumeUSD: 6630000, trust: 8, orbital: 'f' },
  ];

  const ExchangeRegistry = {
    REGIONS,
    ORBITALS,
    EXCHANGES,
    getById: (id) => EXCHANGES.find(e => e.id === id),
    getByRegion: (region) => EXCHANGES.filter(e => e.region === region),
    getByOrbital: (orbital) => EXCHANGES.filter(e => e.orbital === orbital),
    getAll: () => EXCHANGES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExchangeRegistry;
  } else if (typeof window !== 'undefined') {
    window.ExchangeRegistry = ExchangeRegistry;
  }
})();
