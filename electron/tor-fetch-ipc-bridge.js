/**
 * Tor-routed Fetch IPC Bridge
 *
 * Generic authenticated/anonymized fetch proxy for the renderer, routing
 * blockchain-explorer and .onion requests through a local Tor SOCKS5 proxy.
 * Extracted out of the old kalshi-ipc-bridge.js, which it had nothing to do
 * with -- consumed by src/feeds/blockchain-scan.js, src/infra/tor-routing-layer.js,
 * src/infra/endpoint-transport.js, src/prediction-markets/prediction-markets.js.
 */

const { ipcMain } = require('electron');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch2 = require('node-fetch'); // Use node-fetch for agent support

// Default to 9050 (Tor daemon), but we can fall back to 9150 (Tor Browser) if needed.
// Mullvad Browser doesn't run Tor, so they need either tor.exe or Tor Browser.
const torAgent9050 = new SocksProxyAgent('socks5://127.0.0.1:9050');
const torAgent9150 = new SocksProxyAgent('socks5://127.0.0.1:9150');

ipcMain.handle('ipc:fetch', async (event, url, opts = {}) => {
  try {
    const isBlockchain = /mempool\.space|blockchair\.com|etherscan\.io|blockscout\.com|xrplcluster\.com|alchemy\.com/.test(url);
    const useTor = isBlockchain || /\.onion/i.test(url) || opts.useTor === true;

    // We use node-fetch to pass the SOCKS5 agent
    const fetchFn = useTor ? fetch2 : fetch;

    const fetchOpts = {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json', ...(opts.headers || {}) },
    };

    if (useTor) {
      console.log(`[IPC Fetch] Routing via .TOR (SOCKS5): ${url}`);
      fetchOpts.agent = opts.torPort === 9150 ? torAgent9150 : torAgent9050;
    } else {
      fetchOpts.signal = AbortSignal.timeout(10000);
    }

    const res = await fetchFn(url, fetchOpts);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    console.error(`[IPC Fetch] Error fetching ${url}:`, err.message);
    return { ok: false, status: 0, error: err.message };
  }
});
