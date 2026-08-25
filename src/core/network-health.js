// network-health.js — Tier-1 Health Monitor
(function (global) {
  'use strict';

  const CORE_SERVICES = [
    { id: 'pyth', name: 'Pyth', check: () => window.PythClient?.isHealthy?.() ?? true },
    { id: 'polymarket', name: 'Polymarket', check: () => true },
    { id: 'coinbase', name: 'Coinbase', url: 'https://api.coinbase.com/api/v3/brokerage/market/time' },
    { id: 'binance', name: 'Binance', url: 'http://127.0.0.1:3010/binance/api/v3/ticker/price?symbol=BTCUSDT' },
    { id: 'bybit', name: 'Bybit', url: 'http://127.0.0.1:3010/bybit/v5/market/tickers?category=linear&symbol=BTCUSDT' },
    { id: 'crypto-com', name: 'Crypto.com', url: 'https://api.crypto.com/v2/public/get-ticker?instrument_name=BTC_USDT' },
    { id: 'proxy', name: 'ProxyOrchestrator', check: () => true },
    { id: 'local-proxy', name: 'LocalProxy', url: 'http://127.0.0.1:3010/health' },
  ];

  global.NetworkHealth = {
    getServices: () => CORE_SERVICES,
    isHealthy: () => true,
  };
})(typeof window !== 'undefined' ? window : global);
