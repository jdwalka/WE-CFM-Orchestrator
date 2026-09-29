/**
 * exchange-fallback-handler.js — Multi-exchange fallback & automatic routing
 *
 * Handles API errors (403, 451, etc.) and automatically routes to alternative exchanges.
 * Priority order: Binance → Coinbase → OKX/OKC → Bybit → Kraken → Crypto.com → blockchain raw → CoinGecko
 *
 * Usage:
 *   const handler = new ExchangeFallbackHandler();
 *   const candles = await handler.fetchCandles('BTC', '15m');
 */

(function () {
  'use strict';

  // Exchange configurations with priority and capabilities
  const EXCHANGES = {
    BINANCE: {
      name: 'Binance',
      priority: 1,
      baseUrl: 'https://api.binance.com',
      candleEndpoint: '/api/v3/klines',
      capabilities: ['candles', 'orderbook', 'trades', 'futures'],
    },
    BINANCE_GRPC: {
      name: 'Binance gRPC',
      priority: 2,
      grpcUrl: 'grpc://binance.grpc.public/MarketDataService',
      capabilities: ['candles', 'orderbook', 'trades'],
    },
    COINBASE: {
      name: 'Coinbase',
      priority: 3,
      baseUrl: 'https://api.exchange.coinbase.com',
      candleEndpoint: '/products/{symbol}/candles',
      capabilities: ['candles', 'orderbook', 'trades'],
    },
    OKX: {
      name: 'OKX/OKC',
      priority: 4,
      baseUrl: 'https://www.okx.com',
      candleEndpoint: '/api/v5/market/candles',
      capabilities: ['candles', 'orderbook', 'trades'],
    },
    BYBIT: {
      name: 'Bybit',
      priority: 5,
      baseUrl: 'https://api.bybit.com',
      candleEndpoint: '/v5/market/kline',
      capabilities: ['candles', 'orderbook', 'trades', 'perpetuals'],
    },
    BYBIT_GRPC: {
      name: 'Bybit gRPC',
      priority: 6,
      grpcUrl: 'grpc://bybit.grpc.public/MarketDataService',
      capabilities: ['candles', 'orderbook', 'trades'],
    },
    UPBIT: {
      name: 'Upbit',
      priority: 6.1,
      baseUrl: 'https://api.upbit.com',
      candleEndpoint: '/v1/candles/minutes/{interval}',
      capabilities: ['candles', 'trades'],
    },
    BITGET: {
      name: 'Bitget',
      priority: 6.2,
      baseUrl: 'https://api.bitget.com',
      candleEndpoint: '/api/v2/spot/market/candles',
      capabilities: ['candles', 'trades'],
    },
    BINGX: {
      name: 'BingX',
      priority: 6.3,
      baseUrl: 'https://open-api.bingx.com',
      candleEndpoint: '/openApi/spot/v2/market/kline',
      capabilities: ['candles', 'trades'],
    },
    BITVAVO: {
      name: 'Bitvavo',
      priority: 6.4,
      baseUrl: 'https://api.bitvavo.com',
      candleEndpoint: '/v2/{market}/candles',
      capabilities: ['candles', 'trades'],
    },
    GEMINI: {
      name: 'Gemini',
      priority: 6.5,
      baseUrl: 'https://api.gemini.com',
      candleEndpoint: '/v2/candles/{symbol}/{timeframe}',
      capabilities: ['candles', 'trades'],
    },
    COINW: {
      name: 'CoinW',
      priority: 6.6,
      baseUrl: 'https://api.coinw.com',
      candleEndpoint: '/api/v1/public?command=returnKlines',
      capabilities: ['candles', 'trades'],
    },
    LBANK: {
      name: 'LBank',
      priority: 6.7,
      baseUrl: 'https://api.lbkex.com',
      candleEndpoint: '/v2/kline.do',
      capabilities: ['candles', 'trades'],
    },
    KRAKEN: {
      name: 'Kraken',
      priority: 7,
      baseUrl: 'https://api.kraken.com',
      candleEndpoint: '/0/public/OHLC',
      capabilities: ['candles', 'trades'],
    },
    CRYPTO_COM: {
      name: 'Crypto.com',
      priority: 8,
      baseUrl: 'https://api.crypto.com/v2',
      candleEndpoint: '/public/get-candlestick',
      capabilities: ['candles'],
    },
    BLOCKCHAIN_RAW: {
      name: 'Raw blockchain',
      priority: 9,
      baseUrl: '',
      candleEndpoint: '',
      capabilities: ['fallback-metrics'],
    },
    COINGECKO: {
      name: 'CoinGecko',
      priority: 10,
      baseUrl: 'https://api.coingecko.com/api/v3',
      candleEndpoint: '/coins/{id}/ohlc',
      capabilities: ['candles-historical'],
    },
  };

  // Symbol mappings for each exchange
  const SYMBOL_MAPS = {
    BINANCE: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT' },
    COINBASE: { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD' },
    OKX: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', DOGE: 'DOGE-USDT', BNB: 'BNB-USDT' },
    BYBIT: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT', HYPE: 'HYPEUSDT' },
    KRAKEN: { BTC: 'XBTUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT' },
    UPBIT: { BTC: 'USDT-BTC', ETH: 'USDT-ETH', SOL: 'USDT-SOL', XRP: 'USDT-XRP', DOGE: 'USDT-DOGE' },
    BITGET: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT', HYPE: 'HYPEUSDT' },
    BINGX: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', BNB: 'BNB-USDT', DOGE: 'DOGE-USDT', HYPE: 'HYPE-USDT' },
    BITVAVO: { BTC: 'BTC-EUR', ETH: 'ETH-EUR', SOL: 'SOL-EUR', XRP: 'XRP-EUR', DOGE: 'DOGE-EUR' },
    GEMINI: { BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'DOGEUSD' },
    COINW: { BTC: 'BTC_USDT', ETH: 'ETH_USDT', SOL: 'SOL_USDT', XRP: 'XRP_USDT', DOGE: 'DOGE_USDT' },
    LBANK: { BTC: 'btc_usdt', ETH: 'eth_usdt', SOL: 'sol_usdt', XRP: 'xrp_usdt', DOGE: 'doge_usdt' },
    CRYPTO_COM: { BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD' },
    COINGECKO: { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin' },
  };


  class ExchangeFallbackHandler {
    constructor({ escalationThreshold = 5 } = {}) {
      this.priorityOrder = Object.values(EXCHANGES)
        .sort((a, b) => a.priority - b.priority)
        .map(e => Object.keys(EXCHANGES).find(k => EXCHANGES[k].name === e.name));

      this.failureLog = {}; // Track failures per exchange
      this.circuitBreakers = {}; // Active circuit breakers per exchange
      this.escalationThreshold = escalationThreshold;
      this.escalationState = {}; // Track if escalation triggered per exchange
      this.useCacheOrAlternate = {}; // Track if we should force cache/alternate per exchange
    }

    /**
     * Fetch candles with automatic fallback
     * @param {string} symbol - Coin symbol (BTC, ETH, etc.)
     * @param {string} interval - Candle interval (1m, 5m, 15m, 1h, etc.)
     * @param {number} limit - Number of candles to fetch
     * @returns {Promise<Array>} - Candle data in standard format
     */
    async fetchCandles(symbol, interval = '15m', limit = 300) {
      console.info(`[ExchangeFallback] Fetching ${symbol} ${interval} candles...`);

      // gRPC first when handler is registered (priority 2 in EXCHANGES, tried before REST)
      if (typeof window.grpcBinanceHandler === 'function') {
        try {
          const grpcKey = 'BINANCE_GRPC';
          const candles = await this._fetchFromExchange(grpcKey, symbol, interval, limit);
          if (candles && candles.length > 0) {
            console.info(`[ExchangeFallback] ✓ ${symbol} via ${grpcKey} (gRPC)`);
            return candles;
          }
        } catch (e) {
          console.warn(`[ExchangeFallback] gRPC failed for ${symbol}:`, e.message);
        }
      }

      for (const exchangeKey of this.priorityOrder) {
        if (exchangeKey === 'BINANCE_GRPC' || exchangeKey === 'BYBIT_GRPC') continue;
        try {
          // Check if exchange is already failing (circuit breaker)
          if (this.isCircuitOpen(exchangeKey)) {
            console.debug(`[ExchangeFallback] ${EXCHANGES[exchangeKey].name} circuit open, skipping`);
            continue;
          }

          // Escalation: If persistent failure, optionally force cache/alternate
          if (this.useCacheOrAlternate[exchangeKey]) {
            console.warn(`[ExchangeFallback] ESCALATION: Forcing cache/alternate for ${EXCHANGES[exchangeKey].name}`);
            // Here you could return cached data or alternate source if available
            // For demo, just throw to skip
            throw new Error('Escalation: Using cache/alternate source');
          }

          const exchange = EXCHANGES[exchangeKey];
          const symbolMap = SYMBOL_MAPS[exchangeKey];

          // Check if symbol is available on this exchange
          if (!symbolMap || !symbolMap[symbol]) {
            console.debug(`[ExchangeFallback] ${exchange.name} doesn't support ${symbol}`);
            continue;
          }

          console.debug(`[ExchangeFallback] Trying ${exchange.name}...`);
          const candles = await this._fetchFromExchange(exchangeKey, symbol, interval, limit);

          if (candles && candles.length > 0) {
            console.info(`[ExchangeFallback] ✓ ${exchange.name} succeeded, got ${candles.length} candles`);
            this.recordSuccess(exchangeKey);
            return candles;
          }
        } catch (err) {
          const msg = err.message || '';
          if (msg.includes('401') || msg.includes('403') || msg.includes('Quota') || msg.includes('Rate Limited') || msg.includes('Forbidden')) {
            console.warn(`[ExchangeFallback] Auth/Quota error on ${EXCHANGES[exchangeKey].name}. Immediate fast-fail and circuit break.`);
            this.failureLog[exchangeKey] = this.escalationThreshold;
            this.recordFailure(exchangeKey, err);
            if (!this.escalationState[exchangeKey]) {
              this.escalate(exchangeKey, err);
            }
            continue; // Try next exchange immediately
          }

          this.recordFailure(exchangeKey, err);
          // Escalation: If threshold reached, escalate
          if (this.failureLog[exchangeKey] >= this.escalationThreshold && !this.escalationState[exchangeKey]) {
            this.escalate(exchangeKey, err);
          }
          console.warn(`[ExchangeFallback] ${EXCHANGES[exchangeKey].name} failed:`, err.message);
          continue; // Try next exchange
        }
      }

      // All exchanges failed
      console.error('[ExchangeFallback] ✗ All exchanges exhausted for', symbol);
      throw new Error(`Failed to fetch ${symbol} candles from all exchanges`);
    }

    /**
     * Fetch from specific exchange with standard normalization
     */
    async _fetchFromExchange(exchangeKey, symbol, interval, limit) {
      const exchange = EXCHANGES[exchangeKey];
      const exchangeSymbol = SYMBOL_MAPS[exchangeKey] ? SYMBOL_MAPS[exchangeKey][symbol] : symbol;

      let url;
      switch (exchangeKey) {
        case 'BINANCE':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?symbol=${exchangeSymbol}&interval=${this._binanceInterval(interval)}&limit=${limit}`;
          const binResp = await fetch(url);
          if (!binResp.ok) {
            if (binResp.status === 403) throw new Error('403 Forbidden - IP or region blocked');
            throw new Error(`HTTP ${binResp.status}`);
          }
          const binData = await binResp.json();
          return binData.map(c => ({
            timestamp: c[0],
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[7]),
            source: 'BINANCE'
          }));

        case 'BINANCE_GRPC':
          // Pseudo-code: Replace with actual gRPC client call if available
          // Example: const grpcData = await fetchBinanceGrpcCandles(exchangeSymbol, interval, limit);
          // return grpcData;
          throw new Error('Binance gRPC not implemented (stub)');

        case 'COINBASE':
          url = `${exchange.baseUrl}${exchange.candleEndpoint.replace('{symbol}', exchangeSymbol)}?granularity=${this._coinbaseGranularity(interval)}&limit=${Math.min(limit, 300)}`;
          const cbResp = await fetch(url, { headers: { Accept: 'application/json' } });
          if (!cbResp.ok) throw new Error(`HTTP ${cbResp.status}`);
          const cbData = await cbResp.json();
          return (Array.isArray(cbData) ? cbData : []).map(c => ({
            timestamp: Number(c[0]) * 1000,
            open: parseFloat(c[3]),
            high: parseFloat(c[2]),
            low: parseFloat(c[1]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5] || 0),
            source: 'COINBASE'
          })).filter(c => Number.isFinite(c.close)).reverse();

        case 'OKX':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?instId=${exchangeSymbol}&bar=${this._okxBar(interval)}&limit=${Math.min(limit, 300)}`;
          const okxResp = await fetch(url, { headers: { Accept: 'application/json' } });
          if (!okxResp.ok) throw new Error(`HTTP ${okxResp.status}`);
          const okxData = await okxResp.json();
          return (Array.isArray(okxData?.data) ? okxData.data : []).map(c => ({
            timestamp: Number(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5] || 0),
            source: 'OKX'
          })).filter(c => Number.isFinite(c.close)).reverse();

        case 'BYBIT':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?category=spot&symbol=${exchangeSymbol}&interval=${this._bybitInterval(interval)}&limit=${limit}`;
          const byResp = await fetch(url);
          if (!byResp.ok) {
            if (byResp.status === 403) throw new Error('403 Forbidden - IP or region blocked');
            throw new Error(`HTTP ${byResp.status}`);
          }
          const byData = await byResp.json();
          if (!byData.result || !byData.result.list) throw new Error('Invalid response format');
          return byData.result.list.map(c => ({
            timestamp: parseInt(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[7]),
            source: 'BYBIT'
          })).reverse();

        case 'BYBIT_GRPC':
          // Pseudo-code: Replace with actual gRPC client call if available
          // Example: const grpcData = await fetchBybitGrpcCandles(exchangeSymbol, interval, limit);
          // return grpcData;
          throw new Error('Bybit gRPC not implemented (stub)');

        case 'UPBIT':
          const upbitInt = this._upbitInterval(interval);
          if (!upbitInt) throw new Error('Unsupported interval for Upbit');
          url = `${exchange.baseUrl}${upbitInt}?market=${exchangeSymbol}&count=${Math.min(limit, 200)}`;
          const upResp = await fetch(url);
          if (!upResp.ok) throw new Error(`HTTP ${upResp.status}`);
          const upData = await upResp.json();
          return upData.map(c => ({
            timestamp: c.timestamp,
            open: parseFloat(c.opening_price),
            high: parseFloat(c.high_price),
            low: parseFloat(c.low_price),
            close: parseFloat(c.trade_price),
            volume: parseFloat(c.candle_acc_trade_volume),
            source: 'UPBIT'
          })).reverse();

        case 'BITGET':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?symbol=${exchangeSymbol}&granularity=${this._bitgetInterval(interval)}&limit=${limit}`;
          const bgResp = await fetch(url);
          if (!bgResp.ok) throw new Error(`HTTP ${bgResp.status}`);
          const bgData = await bgResp.json();
          if (!bgData.data) throw new Error('Invalid Bitget response');
          return bgData.data.map(c => ({
            timestamp: parseInt(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5]),
            source: 'BITGET'
          })); // Bitget is ascending (oldest first)

          case 'BINGX':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?symbol=${exchangeSymbol}&interval=${this._bingxInterval(interval)}&limit=${limit}`;
          const bxResp = await fetch(url);
          if (!bxResp.ok) throw new Error(`HTTP ${bxResp.status}`);
          const bxData = await bxResp.json();
          if (!bxData.data) throw new Error('Invalid BingX response');
          const bxList = Array.isArray(bxData.data) ? bxData.data : [];
          const bxReversed = bxList.length > 1 && bxList[0].time > bxList[bxList.length - 1].time ? [...bxList].reverse() : bxList;
          return bxReversed.map(c => ({
            timestamp: parseInt(c.time),
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            volume: parseFloat(c.volume || c.vol || 0),
            source: 'BINGX'
          }));

        case 'BITVAVO':
          url = `${exchange.baseUrl}/v2/${exchangeSymbol}/candles?interval=${this._bitvavoInterval(interval)}&limit=${Math.min(limit, 1000)}`;
          const bvResp = await fetch(url);
          if (!bvResp.ok) throw new Error(`HTTP ${bvResp.status}`);
          const bvData = await bvResp.json();
          const bvReversed = bvData.length > 1 && bvData[0][0] > bvData[bvData.length - 1][0] ? [...bvData].reverse() : bvData;
          return bvReversed.map(c => ({
            timestamp: parseInt(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5]),
            source: 'BITVAVO'
          }));

        case 'GEMINI':
          url = `${exchange.baseUrl}/v2/candles/${exchangeSymbol}/${this._geminiInterval(interval)}`;
          const gmResp = await fetch(url);
          if (!gmResp.ok) throw new Error(`HTTP ${gmResp.status}`);
          const gmData = await gmResp.json();
          const gmReversed = gmData.length > 1 && gmData[0][0] > gmData[gmData.length - 1][0] ? [...gmData].reverse() : gmData;
          return gmReversed.map(c => ({
            timestamp: parseInt(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5]),
            source: 'GEMINI'
          }));

        case 'COINW':
          throw new Error('CoinW REST Klines unsupported without auth signature');

        case 'LBANK':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?symbol=${exchangeSymbol}&size=${limit}&type=${this._lbankInterval(interval)}`;
          const lbResp = await fetch(url);
          if (!lbResp.ok) throw new Error(`HTTP ${lbResp.status}`);
          const lbData = await lbResp.json();
          if (!lbData.data) throw new Error('Invalid LBank response');
          const lbReversed = lbData.data.length > 1 && lbData.data[0][0] > lbData.data[lbData.data.length - 1][0] ? [...lbData.data].reverse() : lbData.data;
          return lbReversed.map(c => ({
            timestamp: parseInt(c[0] * 1000), // LBank sends seconds usually
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5]),
            source: 'LBANK'
          }));

        case 'KRAKEN':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?pair=${exchangeSymbol}&interval=${this._krakenInterval(interval)}`;
          const krResp = await fetch(url);
          if (!krResp.ok) throw new Error(`HTTP ${krResp.status}`);
          const krData = await krResp.json();
          const pairKey = Object.keys(krData.result)[0];
          if (!pairKey) throw new Error('No data from Kraken');
          return krData.result[pairKey].map(c => ({
            timestamp: c[0] * 1000,
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[6]),
            source: 'KRAKEN'
          }));

        case 'CRYPTO_COM':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?instrument_name=${exchangeSymbol}&timeframe=${this._cryptoComInterval(interval)}&limit=${limit}`;
          const ccResp = await fetch(url);
          if (!ccResp.ok) throw new Error(`HTTP ${ccResp.status}`);
          const ccData = await ccResp.json();
          if (!ccData.result) throw new Error('Invalid response format');
          return ccData.result.map(c => ({
            timestamp: c.t * 1000,
            open: parseFloat(c.o),
            high: parseFloat(c.h),
            low: parseFloat(c.l),
            close: parseFloat(c.c),
            volume: parseFloat(c.v),
            source: 'CRYPTO_COM'
          }));

        case 'COINGECKO':
          url = `${exchange.baseUrl}${exchange.candleEndpoint}?vs_currency=usd&days=${this._coingeckoDays(interval)}&interval=${this._coingeckoInterval(interval)}`;
          if (typeof window.coinGeckoUrl === 'function') url = window.coinGeckoUrl(url);

          // Retry logic with exponential backoff for CoinGecko (rate limit sensitive)
          const backoffMs = [1000, 2000, 4000];
          let cgResp;
          let cgAttempt = 0;
          while (cgAttempt <= 3) {
            const fetchOptions = typeof window.withCoinGeckoAuth === 'function' ? window.withCoinGeckoAuth(url) : {};
            cgResp = await fetch(url, fetchOptions);
            if (cgResp.ok) break;

            if (cgResp.status === 429 && cgAttempt < 3) {
              const backoff = backoffMs[Math.min(cgAttempt, backoffMs.length - 1)];
              console.warn(`[ExchangeFallback] CoinGecko 429 (attempt ${cgAttempt + 1}/4), backoff ${backoff}ms`);
              await new Promise(r => setTimeout(r, backoff));
              cgAttempt++;
            } else {
              break;
            }
          }

          if (!cgResp.ok) {
            if (cgResp.status === 429) throw new Error('429 Rate Limited - max retries exhausted');
            if (cgResp.status === 401) throw new Error('401 Unauthorized - API key invalid');
            throw new Error(`HTTP ${cgResp.status}`);
          }
          const cgData = await cgResp.json();
          return cgData.map(c => ({
            timestamp: c[0],
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: 0, // CoinGecko doesn't provide volume in OHLC
            source: 'COINGECKO'
          }));

          case 'BLOCKCHAIN_RAW':
          if (window.BlockchainScan && typeof window.BlockchainScan.get === 'function') {
            const chain = window.BlockchainScan.get(symbol);
            if (chain && !chain.error) {
              return [];
            }
          }
          throw new Error('Raw blockchain metrics unavailable');

        default:
          throw new Error(`Unknown exchange: ${exchangeKey}`);
      }
    }

    /**
     * Convert standard interval to Binance format
     */
    _binanceInterval(interval) {
      const map = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
      return map[interval] || '15m';
    }

    /**
     * Convert standard interval to Bybit format
     */
    _bybitInterval(interval) {
      const map = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
      return map[interval] || '15';
    }

    _coinbaseGranularity(interval) {
      const map = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 21600, '1d': 86400 };
      return map[interval] || 900;
    }

    /**
     * Convert standard interval to Kraken format
     */
    _krakenInterval(interval) {
      const map = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
      return map[interval] || 15;
    }

    /**
     * Convert standard interval to Crypto.com format
     */
    _cryptoComInterval(interval) {
      const map = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
      return map[interval] || '15m';
    }

    /**
     * Convert standard interval to CoinGecko format
     */
    _coingeckoDays(interval) {
      const days = { '1m': 1, '5m': 1, '15m': 7, '1h': 30, '4h': 90, '1d': 365 };
      return days[interval] || 7;
    }

    _okxBar(interval) {
      const map = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
      return map[interval] || '15m';
    }

    _upbitInterval(interval) {
      const map = {
        '1m': '/v1/candles/minutes/1',
        '5m': '/v1/candles/minutes/5',
        '15m': '/v1/candles/minutes/15',
        '1h': '/v1/candles/minutes/60',
        '4h': '/v1/candles/minutes/240',
        '1d': '/v1/candles/days'
      };
      return map[interval] || '/v1/candles/minutes/15';
    }

    _bitgetInterval(interval) {
      const map = { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day' };
      return map[interval] || '15min';
    }

    _bingxInterval(interval) {
      const map = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
      return map[interval] || '15m';
    }

    _coingeckoInterval(interval) {
      return this._coingeckoDays(interval) > 1 ? '' : '';
    }

    /**
     * Check if circuit breaker is open for exchange
     */
    isCircuitOpen(exchangeKey) {
      if (!window.ApiCircuitBreaker) return false;
      const breaker = window.ApiCircuitBreaker.getBreaker(`exchange-${exchangeKey}`, { threshold: 5 });
      return breaker.getState().state === 'OPEN';
    }

    /**
     * Record success for exchange
     */
    recordSuccess(exchangeKey) {
      if (!this.failureLog[exchangeKey]) this.failureLog[exchangeKey] = 0;
      this.failureLog[exchangeKey] = 0; // Reset counter
      this.escalationState[exchangeKey] = false;
      this.useCacheOrAlternate[exchangeKey] = false;
    }

    /**
     * Record failure for exchange
     */
    recordFailure(exchangeKey, err) {
      if (!this.failureLog[exchangeKey]) this.failureLog[exchangeKey] = 0;
      this.failureLog[exchangeKey]++;

      // Trip circuit breaker after escalationThreshold consecutive failures
      if (this.failureLog[exchangeKey] >= this.escalationThreshold && window.ApiCircuitBreaker) {
        const breaker = window.ApiCircuitBreaker.getBreaker(`exchange-${exchangeKey}`, { threshold: this.escalationThreshold });
        breaker.trip();
      }
    }

    /**
     * Escalate persistent provider failure: log, alert, and switch to cache/alternate
     */
    escalate(exchangeKey, err) {
      this.escalationState[exchangeKey] = true;
      this.useCacheOrAlternate[exchangeKey] = true;
      const msg = `[ExchangeFallback] ESCALATION: ${EXCHANGES[exchangeKey].name} failed ${this.failureLog[exchangeKey]} times. Escalating: switching to cache/alternate and alerting user.`;
      console.error(msg);
      // User alert: dispatch a custom event for UI or use alert for demo
      if (typeof window !== 'undefined') {
        if (window.dispatchEvent && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('provider-escalation', {
            detail: {
              provider: EXCHANGES[exchangeKey].name,
              failures: this.failureLog[exchangeKey],
              error: err ? (err.message || String(err)) : undefined
            }
          }));
        } else if (window.alert) {
          window.alert(msg);
        }
      }
    }

    /**
     * Get fallback status
     */
    getStatus() {
      return {
        priorityOrder: this.priorityOrder,
        failureLog: this.failureLog,
        escalationState: this.escalationState,
        useCacheOrAlternate: this.useCacheOrAlternate,
        exchanges: Object.keys(EXCHANGES).map(k => ({
          name: EXCHANGES[k].name,
          priority: EXCHANGES[k].priority,
          failures: this.failureLog[k] || 0,
          escalated: !!this.escalationState[k],
          usingCacheOrAlternate: !!this.useCacheOrAlternate[k],
        })),
      };
    }
  }

  // ─── Export to window ───────────────────────────────────────────────────
  window.ExchangeFallbackHandler = ExchangeFallbackHandler;

  console.info('[ExchangeFallbackHandler] Loaded: Multi-exchange fallback with automatic routing');
})();
