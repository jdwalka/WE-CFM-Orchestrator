/**
 * Kalshi Worker Client
 * 
 * Library for Electron app to communicate with standalone Kalshi worker.
 * No direct coupling — clean separation of concerns.
 * 
 * Usage:
 *   const client = new KalshiWorkerClient('http://127.0.0.1:3050');
 *   const balance = await client.getBalance();
 *   const markets = await client.getMarkets();
 */

class KalshiWorkerClient {
  constructor(workerUrl = 'http://127.0.0.1:3050') {
    this.workerUrl = workerUrl;
    this.connected = false;
    this.cache = {
      balance: null,
      markets: {},
      events: {},
      positions: [],
      orders: []
    };
  }

  /**
   * Check if worker is running
   */
  async healthCheck() {
    try {
      const res = await fetch(`${this.workerUrl}/health`);
      const data = await res.json();
      this.connected = res.ok;
      return {
        healthy: res.ok,
        ...data
      };
    } catch (error) {
      this.connected = false;
      return {
        healthy: false,
        error: error.message
      };
    }
  }

  /**
   * Get worker status
   */
  async getStatus() {
    try {
      const res = await fetch(`${this.workerUrl}/status`);
      const data = await res.json();
      return data;
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Get balance
   */
  async getBalance(noCache = false) {
    if (!noCache && this.cache.balance) {
      return this.cache.balance;
    }

    try {
      const res = await fetch(`${this.workerUrl}/balance`);
      if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
      
      const data = await res.json();
      if (data.success) {
        this.cache.balance = data;
      }
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get markets
   */
  async getMarkets(limit = 50, noCache = false) {
    const cacheKey = `markets_${limit}`;
    if (!noCache && this.cache[cacheKey]) {
      return this.cache[cacheKey];
    }

    try {
      const res = await fetch(`${this.workerUrl}/markets?limit=${limit}`);
      if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
      
      const data = await res.json();
      if (data.success) {
        this.cache[cacheKey] = data;
      }
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get events
   */
  async getEvents(eventTicker = null, noCache = false) {
    const cacheKey = `events_${eventTicker || 'all'}`;
    if (!noCache && this.cache[cacheKey]) {
      return this.cache[cacheKey];
    }

    try {
      const url = eventTicker
        ? `${this.workerUrl}/events?ticker=${encodeURIComponent(eventTicker)}`
        : `${this.workerUrl}/events`;
      
      const res = await fetch(url);
      if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
      
      const data = await res.json();
      if (data.success) {
        this.cache[cacheKey] = data;
      }
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get positions
   */
  async getPositions(noCache = false) {
    if (!noCache && this.cache.positions.length > 0) {
      return { success: true, data: { positions: this.cache.positions } };
    }

    try {
      const res = await fetch(`${this.workerUrl}/positions`);
      if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
      
      const data = await res.json();
      if (data.success && data.data?.positions) {
        this.cache.positions = data.data.positions;
      }
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get orders
   */
  async getOrders(noCache = false) {
    if (!noCache && this.cache.orders.length > 0) {
      return { success: true, data: { orders: this.cache.orders } };
    }

    try {
      const res = await fetch(`${this.workerUrl}/orders`);
      if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
      
      const data = await res.json();
      if (data.success && data.data?.orders) {
        this.cache.orders = data.data.orders;
      }
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Place order
   */
  async placeOrder(orderRequest) {
    try {
      const res = await fetch(`${this.workerUrl}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'placeOrder',
          params: orderRequest
        })
      });

      const data = await res.json();
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId) {
    try {
      const res = await fetch(`${this.workerUrl}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'cancelOrder',
          params: { orderId }
        })
      });

      const data = await res.json();
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel all orders
   */
  async cancelAllOrders(filters = {}) {
    try {
      const res = await fetch(`${this.workerUrl}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'cancelAllOrders',
          params: { filters }
        })
      });

      const data = await res.json();
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get single market
   */
  async getMarket(marketId) {
    try {
      const res = await fetch(`${this.workerUrl}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'getMarket',
          params: { marketId }
        })
      });

      const data = await res.json();
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get trades for market
   */
  async getTrades(marketId, filters = {}) {
    try {
      const res = await fetch(`${this.workerUrl}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'getTrades',
          params: { marketId, filters }
        })
      });

      const data = await res.json();
      return data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache = {
      balance: null,
      markets: {},
      events: {},
      positions: [],
      orders: []
    };
  }

  /**
   * Poll for balance updates (every N ms)
   */
  pollBalance(intervalMs = 5000, callback) {
    const interval = setInterval(async () => {
      const balance = await this.getBalance(true);
      if (callback) callback(balance);
    }, intervalMs);

    return () => clearInterval(interval);
  }

  /**
   * Poll for orders updates
   */
  pollOrders(intervalMs = 3000, callback) {
    const interval = setInterval(async () => {
      const orders = await this.getOrders(true);
      if (callback) callback(orders);
    }, intervalMs);

    return () => clearInterval(interval);
  }
}

// Export for Electron renderer
if (typeof window !== 'undefined') {
  window.KalshiWorkerClient = KalshiWorkerClient;
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = KalshiWorkerClient;
}
