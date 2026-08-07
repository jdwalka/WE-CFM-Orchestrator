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
const { Configuration, PortfolioApi, OrdersApi } = kalshiTypeScript || {};

// Optional contract queue manager to handle early/overlapping contracts
let ContractQueue = null;
try {
  ContractQueue = require('../core/contract-queue-manager');
} catch (e) {
  ContractQueue = null;
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
   * Cancel all orders
   */
  async cancelAllOrders(filters = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      const response = await this.ordersApi.cancelAllOrders(filters);
      return {
        success: true,
        data: response.data,
        cancelledCount: response.data?.orders_cancelled || 0,
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
   * Get event details
   */
  async getEvent(eventId) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      const response = await this.portfolioApi.getEvent({ eventId });
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
   * Get all events with optional filtering
   */
  async getEvents(filters = {}) {
    try {
      this.stats.calls++;
      this.stats.lastCall = Date.now();
      
      const params = {
        eventTicker: filters.eventTicker,
        withNestedMarkets: filters.withNestedMarkets || false,
        ...filters
      };
      
      const response = await this.portfolioApi.getEvents(params);
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
      
      const response = await this.portfolioApi.getMultivariateEvents(filters);
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
      
      const response = await this.portfolioApi.getEventMetadata({ eventId });
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
      
      const response = await this.portfolioApi.getMarketCandlesticksByEvent({
        seriesId,
        eventId,
        ...params
      });
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
      
      const response = await this.portfolioApi.getEventForecastPercentilesHistory({
        seriesId,
        eventId,
        ...params
      });
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
