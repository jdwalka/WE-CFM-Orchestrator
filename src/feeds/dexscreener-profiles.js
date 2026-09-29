// ================================================================
// dexscreener-profiles.js — Fetch latest token profiles and updates
// ================================================================
(function () {
  'use strict';

  const DEX_BASE = 'https://api.dexscreener.com';

  async function _fetchProfiles(endpoint) {
    // If ProxyOrchestrator exists, use it for resilience/rate-limiting
    if (window._proxyOrchestrator) {
      try {
        const data = await window._proxyOrchestrator.fetch(`${DEX_BASE}/${endpoint}/v1`, {
          endpoint: 'dexscreener',
          cacheType: 'market-data',
          retries: 2,
          requestOptions: {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          }
        });
        
        // ProxyOrchestrator returns the parsed JSON automatically
        return Array.isArray(data) ? data : (data?.data || data || []);
      } catch (err) {
        console.warn(`[DexScreenerProfiles] Proxy fetch failed for ${endpoint}:`, err.message);
        // Fallthrough to direct fetch
      }
    }

    // Direct fallback
    try {
      const res = await fetch(`${DEX_BASE}/${endpoint}/v1`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      
      if (!res.ok) {
        return Promise.reject(new Error(`DexScreenerProfiles HTTP ${res.status}`));
      }
      
      const json = await res.json();
      return Array.isArray(json) ? json : (json?.data || json || []);
    } catch (err) {
      console.warn(`[DexScreenerProfiles] Direct fetch failed for ${endpoint}:`, err.message);
      return [];
    }
  }

  const DexScreenerProfiles = {
    /**
     * Get the latest token profiles added to DexScreener
     * @returns {Promise<Array>} Array of token profiles
     */
    async getLatestProfiles() {
      return _fetchProfiles('token-profiles/latest');
    },

    /**
     * Get the most recently updated token profiles on DexScreener
     * @returns {Promise<Array>} Array of token profiles
     */
    async getRecentUpdates() {
      return _fetchProfiles('token-profiles/recent-updates');
    },

    /**
     * Get the latest community takeovers (CTOs) added to DexScreener
     * @returns {Promise<Array>} Array of token profiles
     */
    async getLatestCommunityTakeovers() {
      return _fetchProfiles('community-takeovers/latest');
    }
  };

  window.DexScreenerProfiles = DexScreenerProfiles;

  // Background Watchdog: Poll DexScreener profiles periodically
  setTimeout(() => {
    async function pollDexScreener() {
      try {
        const latest = await DexScreenerProfiles.getLatestProfiles();
        const ctos = await DexScreenerProfiles.getLatestCommunityTakeovers();
        console.log(`[DexScreener] Fetched ${latest.length} latest profiles, ${ctos.length} community takeovers`);
        // We can hook this into window.OB or other notification buses if needed later
        window._latestDexProfiles = { latest, ctos, ts: Date.now() };
      } catch (err) {
        console.warn('[DexScreener] Background poll failed:', err.message);
      }
    }
    
    // Poll every 5 minutes
    pollDexScreener();
    setInterval(pollDexScreener, 5 * 60 * 1000);
  }, 10000); // Wait 10s after startup to not block initial loading

})();
