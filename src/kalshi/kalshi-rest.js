/**
 * Kalshi REST API Client
 * 
 * Wraps kalshi-typescript SDK for portfolio management, orders, and account data.
 * Complements kalshi-ws.js (WebSocket for real-time market data).
 * 
 * Usage:
 *   const client = new KalshiRestClient(apiKeyId, privateKeyPem);
 *   const balance = await client.getBalance();
 *   const portfolio = await client.getPortfolio();
 */

// SafeGuard: kalshi-typescript is a Node.js module, only available in Electron/Node context
const kalshiTypeScript = (typeof require !== 'undefined') ? require('kalshi-typescript') : null;
const { Configuration, PortfolioApi, OrdersApi, EventsApi, MarketApi } = kalshiTypeScript || {};

// Optional contract queue manager to handle early/overlapping contracts
let ContractQueue = null;
try {
  ContractQueue = require('../core/contract-queue-manager');
} catch (e) {
  ContractQueue = null;
}

// ─────────────────────────────────────────────────────────────
// Clock-skew compensation
//
// Kalshi rejects requests whose KALSHI-ACCESS-TIMESTAMP drifts too far from
// its own clock (401 "header_timestamp_expired"). kalshi-typescript signs
// with a raw Date.now(), so any local clock drift breaks auth on every
// call. We patch its signer to add a measured offset (shared with the WSS
// signer in electron/kalshi-credentials.js via kalshi-clock.js), and
// self-heal by recalibrating + retrying once whenever that error is seen.
//
// Browser: this file is also loaded as a <script> (no require). Use no-op
// fallbacks so parse/eval succeeds; real calibration only runs in Node/Electron.
// ─────────────────────────────────────────────────────────────
const _kalshiClock = (typeof require !== 'undefined')
  ? (() => { try { return require('./kalshi-clock'); } catch (_) { return null; } })()
  : null;
const calibrateKalshiClock = _kalshiClock?.calibrateKalshiClock || (async () => 0);
const getKalshiClockOffsetMs = _kalshiClock?.getKalshiClockOffsetMs || (() => 0);
const resetKalshiClockCalibration = _kalshiClock?.resetKalshiClockCalibration || (() => {});

if (kalshiTypeScript) {
  try {
    const { KalshiAuth } = require('kalshi-typescript/dist/auth');
    KalshiAuth.prototype.generateAuthHeaders = function (method, reqPath) {
      const timestampStr = String(Date.now() + getKalshiClockOffsetMs());
      const signature = this.signPssText(timestampStr + method + reqPath);
      return {
        'KALSHI-ACCESS-KEY': this.apiKey,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestampStr,
      };
    };

    const axios = require('axios');
    axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        const config = error.config;
        const code = error.response?.data?.error?.code;
        if (config && !config._kalshiClockRetried && error.response?.status === 401 && code === 'header_timestamp_expired') {
          config._kalshiClockRetried = true;
          resetKalshiClockCalibration();
          const urlMatch = String(config.url || '').match(/^(https?:\/\/[^/]+\/trade-api\/v2)/);
          const baseUrl = (config.baseURL ? `${config.baseURL.replace(/\/$/, '')}` : null)
            || (urlMatch ? urlMatch[1] : null)
            || 'https://api.elections.kalshi.com/trade-api/v2';
          await calibrateKalshiClock(baseUrl);
          return axios(config);
        }
        return Promise.reject(error);
      }
    );
  } catch (_) {
    // kalshi-typescript internals unavailable — clock-skew patch skipped, falls back to library default
  }
}

class KalshiRestClient {
  constructor(apiKeyId, privateKeyPem, environment = 'production') {
    this.apiKeyId = apiKeyId;
    this.privateKeyPem = privateKeyPem;
    this.environment = environment;
    this.baseUrl = environment === 'demo' 
      ? 'https://demo-api.kalshi.co/trade-api/v2'
      : 'https://api.elections.kalshi.com/trade-api/v2';
    
    this.config = new Configuration({
      apiKey: apiKeyId,
      privateKeyPem: privateKeyPem,
      basePath: this.baseUrl
    });
    
    this.portfolioApi = new PortfolioApi(this.config);
    this.ordersApi = new OrdersApi(this.config);
    this.eventsApi = new EventsApi(this.config);
    this.marketApi = new MarketApi(this.config);

    // Kick off clock calibration immediately so the first signed request
    // already carries a corrected timestamp instead of relying on the
    // retry-on-401 path in the response interceptor above.
    calibrateKalshiClock(this.baseUrl);

    // Monitoring
    this.stats = {
      calls: 0,
      errors: 0,
      lastCall: null,
      lastError: null
    };
  }

  /**
   * Get account balance and summary info
   */
  async getBalance() {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      const response = await this.portfolioApi.getBalance();
      return {
        success: true,
        data: response.data,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      
      const errorCode = error.response?.status || 'UNKNOWN';
      const errorMsg = error.response?.data?.message || error.message;
      
      console.error(`[Kalshi REST] getBalance failed (${errorCode}):`, errorMsg);
      return {
        success: false,
        error: errorMsg,
        code: errorCode,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get active positions
   */
  async getPositions(filters = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      const response = await this.portfolioApi.getPositions(filters);
      return {
        success: true,
        data: response.data,
        count: response.data?.positions?.length || 0,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      
      console.error('[Kalshi REST] getPositions failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get order history
   */
  async getOrders(filters = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      const response = await this.ordersApi.getOrders(filters);
      return {
        success: true,
        data: response.data,
        count: response.data?.orders?.length || 0,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      
      console.error('[Kalshi REST] getOrders failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Place a new order
   */
  async placeOrder(orderRequest) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      // Validate required fields
      if (!orderRequest.market_ticker && !orderRequest.market_id) {
        return {
          success: false,
          error: 'market_ticker or market_id required',
          code: 'VALIDATION_ERROR',
          timestamp: Date.now()
        };
      }
      
      if (!orderRequest.side || !orderRequest.action || !orderRequest.quantity || orderRequest.yes_price === undefined) {
        return {
          success: false,
          error: 'side, action, quantity, yes_price required',
          code: 'VALIDATION_ERROR',
          timestamp: Date.now()
        };
      }

      // Delegate to ContractQueue if available to handle early/overlapping contracts
      if (ContractQueue && typeof ContractQueue.handleOrder === 'function') {
        try {
          const queued = await ContractQueue.handleOrder(orderRequest, this);
          return queued;
        } catch (err) {
          // fallback to direct submit
          console.warn('[Kalshi REST] ContractQueue.handleOrder failed, falling back to direct order:', err?.message || err);
        }
      }
      
      const response = await this.ordersApi.createOrder(orderRequest);
      return {
        success: true,
        data: response.data,
        orderId: response.data?.order_id,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      
      console.error('[Kalshi REST] placeOrder failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      const response = await this.ordersApi.cancelOrder(orderId);
      return {
        success: true,
        data: response.data,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      
      console.error('[Kalshi REST] cancelOrder failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Cancel all resting orders (optionally scoped by filters.ticker/eventTicker).
   * kalshi-typescript has no single "cancel all" endpoint, so this lists resting
   * orders first and batch-cancels their IDs.
   */
  async cancelAllOrders(filters = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();

      const resting = await this.ordersApi.getOrders(
        filters.ticker,
        filters.eventTicker,
        undefined,
        undefined,
        'resting',
        filters.limit || 200,
        undefined,
        filters.subaccount
      );
      const orderIds = (resting.data?.orders || []).map((o) => o.order_id).filter(Boolean);
      if (!orderIds.length) {
        return { success: true, data: { orders_cancelled: 0 }, cancelledCount: 0, timestamp: Date.now() };
      }

      const response = await this.ordersApi.batchCancelOrders({
        orders: orderIds.map((order_id) => ({ order_id }))
      });
      return {
        success: true,
        data: response.data,
        cancelledCount: orderIds.length,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;

      console.error('[Kalshi REST] cancelAllOrders failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get a single market by ticker
   */
  async getMarket(ticker) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();

      const response = await this.marketApi.getMarket(ticker);
      return {
        success: true,
        data: response.data,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      console.error('[Kalshi REST] getMarket failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get recent trades, optionally filtered by market ticker
   */
  async getTrades(ticker, filters = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();

      const response = await this.marketApi.getTrades(
        filters.limit,
        filters.cursor,
        ticker,
        filters.minTs,
        filters.maxTs,
        filters.isBlockTrade
      );
      return {
        success: true,
        data: response.data,
        count: response.data?.trades?.length || 0,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      console.error('[Kalshi REST] getTrades failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get event details
   */
  async getEvent(eventId) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();

      const response = await this.eventsApi.getEvent(eventId, true);
      return {
        success: true,
        data: response.data,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      console.error('[Kalshi REST] getEvent failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get all events with optional filtering. If filters.eventTicker is set,
   * fetches that single event (optionally with its nested markets);
   * otherwise lists events per the other filters.
   */
  async getEvents(filters = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();

      if (filters.eventTicker) {
        const response = await this.eventsApi.getEvent(filters.eventTicker, filters.withNestedMarkets !== false);
        const events = response.data?.event ? [response.data.event] : [];
        return {
          success: true,
          data: { events, markets: response.data?.markets || [] },
          count: events.length,
          marketCount: response.data?.markets?.length || 0,
          timestamp: Date.now()
        };
      }

      const response = await this.eventsApi.getEvents(
        filters.limit,
        filters.cursor,
        filters.withNestedMarkets,
        filters.withMilestones,
        filters.status,
        filters.seriesTicker,
        filters.minCloseTs,
        filters.minUpdatedTs
      );
      return {
        success: true,
        data: response.data,
        count: response.data?.events?.length || 0,
        marketCount: response.data?.markets?.length || 0,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      console.error('[Kalshi REST] getEvents failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get multivariate events
   */
  async getMultivariateEvents(filters = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();

      const response = await this.eventsApi.getMultivariateEvents(
        filters.limit,
        filters.cursor,
        filters.seriesTicker,
        filters.collectionTicker,
        filters.withNestedMarkets
      );
      return {
        success: true,
        data: response.data,
        count: response.data?.events?.length || 0,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      console.error('[Kalshi REST] getMultivariateEvents failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get event metadata
   */
  async getEventMetadata(eventId) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      const response = await this.eventsApi.getEventMetadata(eventId);
      return {
        success: true,
        data: response.data,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      console.error('[Kalshi REST] getEventMetadata failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get event candlesticks
   */
  async getMarketCandlesticksByEvent(seriesId, eventId, params = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      // NOTE: kalshi-typescript's signature is (ticker, seriesTicker, startTs, endTs,
      // periodInterval, options) — startTs/endTs/periodInterval are required by the API
      // but were never part of this method's params; pass them via `params` until callers
      // are updated to supply a time range.
      const response = await this.eventsApi.getMarketCandlesticksByEvent(
        eventId,
        seriesId,
        params.startTs,
        params.endTs,
        params.periodInterval,
        params
      );
      return {
        success: true,
        data: response.data,
        candleCount: response.data?.candlesticks?.length || 0,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      console.error('[Kalshi REST] getMarketCandlesticksByEvent failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get event forecast percentile history
   */
  async getEventForecastPercentilesHistory(seriesId, eventId, params = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      // NOTE: kalshi-typescript's signature is (ticker, seriesTicker, percentiles, startTs,
      // endTs, periodInterval, options) — percentiles/startTs/endTs/periodInterval are
      // required by the API but were never part of this method's params; pass them via
      // `params` until callers are updated to supply them.
      const response = await this.eventsApi.getEventForecastPercentilesHistory(
        eventId,
        seriesId,
        params.percentiles,
        params.startTs,
        params.endTs,
        params.periodInterval,
        params
      );
      return {
        success: true,
        data: response.data,
        historyCount: response.data?.forecast_percentiles?.length || 0,
        timestamp: Date.now()
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      console.error('[Kalshi REST] getEventForecastPercentilesHistory failed:', error.message);
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now()
      };
    }
  }

  /**
   * List markets (public endpoint — no auth required for market data)
   */
  async getMarkets(filters = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();

      const params = new URLSearchParams();
      if (filters.series_ticker) params.set('series_ticker', filters.series_ticker);
      if (filters.status) params.set('status', filters.status);
      if (filters.event_ticker) params.set('event_ticker', filters.event_ticker);
      if (filters.cursor) params.set('cursor', filters.cursor);
      if (filters.limit != null) params.set('limit', String(filters.limit));
      if (filters.search) params.set('search', filters.search);

      const url = `${this.baseUrl}/markets?${params.toString()}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      return {
        success: true,
        data,
        count: data?.markets?.length || 0,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.stats.errors++;
      this.stats.lastError = error.message;
      return {
        success: false,
        error: error.message,
        code: error.response?.status || 'UNKNOWN',
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Search markets by query
   */
  async searchMarkets(query, limit = 20) {
    try {
      const response = await this.getMarkets({
        search: query,
        limit
      });
      return response;
    } catch (error) {
      console.error('[Kalshi REST] searchMarkets failed:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Find event by ticker with nested markets
   */
  async findEventByTicker(eventTicker) {
    try {
      const response = await this.getEvents({
        eventTicker,
        withNestedMarkets: true
      });
      
      if (response.success && response.data?.events?.length > 0) {
        return {
          success: true,
          event: response.data.events[0],
          markets: response.data.markets || [],
          timestamp: Date.now()
        };
      }
      
      return {
        success: false,
        error: 'Event not found',
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[Kalshi REST] findEventByTicker failed:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get all markets for an event with nested structure
   */
  async getEventMarkets(eventTicker) {
    try {
      const eventRes = await this.findEventByTicker(eventTicker);
      if (!eventRes.success) {
        return eventRes;
      }
      
      return {
        success: true,
        event: eventRes.event,
        markets: eventRes.markets,
        count: eventRes.markets.length,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[Kalshi REST] getEventMarkets failed:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Get portfolio health metrics
   */
  getHealthMetrics() {
    return {
      uptime: Date.now() - (this.stats.createdAt || Date.now()),
      totalCalls: this.stats.calls,
      totalErrors: this.stats.errors,
      errorRate: this.stats.calls > 0 ? (this.stats.errors / this.stats.calls * 100).toFixed(2) + '%' : '0%',
      lastCallTime: this.stats.lastCall ? new Date(this.stats.lastCall).toISOString() : 'never',
      lastError: this.stats.lastError,
      environment: this.environment
    };
  }

  /**
   * Validate connection (ping)
   */
  async healthCheck() {
    try {
      const balance = await this.getBalance();
      return {
        status: balance.success ? 'healthy' : 'unhealthy',
        error: balance.success ? undefined : balance.error,
        details: balance,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: Date.now()
      };
    }
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = KalshiRestClient;
}
