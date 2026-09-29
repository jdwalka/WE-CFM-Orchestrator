/**
 * Tor-routed Fetch IPC Bridge
 *
 * Generic authenticated/anonymized fetch proxy for the renderer, routing
 * blockchain-explorer and .onion requests through a local Tor SOCKS5 proxy.
 * Extracted out of the old kalshi-ipc-bridge.js, which it had nothing to do
 * with -- consumed by src/feeds/blockchain-scan.js, src/infra/tor-routing-layer.js,
 * src/infra/endpoint-transport.js, src/prediction-markets/prediction-markets.js.
 */

const electron = require('electron');
const ipcMain = electron.ipcMain || electron;
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch2 = require('node-fetch'); // Use node-fetch for agent support

// Default to 9050 (Tor daemon), but we can fall back to 9150 (Tor Browser) if needed.
// Mullvad Browser doesn't run Tor, so they need either tor.exe or Tor Browser.
const torAgent9050 = new SocksProxyAgent('socks5://127.0.0.1:9050');
const torAgent9150 = new SocksProxyAgent('socks5://127.0.0.1:9150');

function registerTorFetchBridge(targetIpc = ipcMain) {
  if (!targetIpc || typeof targetIpc.handle !== 'function') return;
  try { targetIpc.removeHandler('ipc:fetch'); } catch (_) {}

  targetIpc.handle('ipc:fetch', async (event, url, opts = {}) => {
  const isOnion = /\.onion/i.test(url);
  const wantTor = (isOnion || opts.useTor === true) && opts.useTor !== false;

  const prepareHeaders = () => ({
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(opts.headers || {}),
  });

  const getBody = () => {
    if (opts.body == null) return undefined;
    return typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  };

  // Try Tor first ONLY if explicitly requested or for .onion domains
  if (wantTor) {
    try {
      const fetchOpts = {
        method: opts.method || 'GET',
        headers: prepareHeaders(),
        body: getBody(),
        agent: opts.torPort === 9150 ? torAgent9150 : torAgent9050,
        timeout: opts.timeout || 6000,
      };
      const res = await fetch2(url, fetchOpts);
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } catch (torErr) {
      if (isOnion) {
        console.error(`[IPC Fetch] Tor error for .onion ${url}:`, torErr.message);
        return { ok: false, status: 0, error: `Tor required for onion: ${torErr.message}` };
      }
      console.debug(`[IPC Fetch] Tor offline (${torErr.message}), falling back to direct fetch: ${url}`);
    }
  }

  // Direct HTTPS fetch (fast & reliable)
  try {
    const fetchOpts = {
      method: opts.method || 'GET',
      headers: prepareHeaders(),
      body: getBody(),
      signal: AbortSignal.timeout(opts.timeout || 10000),
    };
    const res = await fetch(url, fetchOpts);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (directErr) {
    console.error(`[IPC Fetch] Direct fetch error for ${url}:`, directErr.message);
    return { ok: false, status: 0, error: directErr.message };
  }
  });
}

registerTorFetchBridge(ipcMain);

module.exports = { registerTorFetchBridge };
