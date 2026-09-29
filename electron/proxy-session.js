'use strict';

/**
 * proxy-session — isolated SOCKS5 session for outbound API calls.
 *
 * - No auth (Mullvad local bridge), remote DNS via SOCKS5h behavior.
 * - fetchWithRetry: exponential backoff, STRICT by default (fail closed to
 *   protect the Swedish geo-fence on exchange traffic). Callers hitting our
 *   own global workers (poker analysis) may pass allowClearnetFallback:true.
 * - verifySwedishEgress(): startup sanity check, expects SE exit.
 */

const { app, session, net } = require('electron');

let proxiedSession = null;

async function initProxiedSession(port = 1080) {
  await app.whenReady();
  proxiedSession = session.fromPartition('persist:socks5-bridge');
  await proxiedSession.setProxy({
    proxyRules: `socks5://127.0.0.1:${port}`,
    proxyBypassRules: '<local>;localhost',
  });
  return proxiedSession;
}

function fetchWithRetry(url, options = {}, payload = null, retries = 3, backoffMs = 1000) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining, isFallback = false) => {
      const activeSession = isFallback ? session.defaultSession : proxiedSession;
      if (!activeSession) {
        reject(new Error('proxy session not initialized — call initProxiedSession first'));
        return;
      }
      const request = net.request({
        method: options.method || 'POST',
        url,
        session: activeSession,
        headers: options.headers || { 'Content-Type': 'application/json' },
      });
      const fail = (err, left) => {
        if (left > 0) {
          const wait = backoffMs * (2 ** (retries - left));
          console.warn(`[Proxy] request failed, retry in ${wait}ms (${left} left): ${err.message}`);
          setTimeout(() => attempt(left - 1, isFallback), wait);
        } else if (options.allowClearnetFallback && !isFallback) {
          console.error('[Proxy] SOCKS5 bridge dead — clearnet fallback (own API only).');
          attempt(0, true);
        } else {
          reject(new Error(`Retries exhausted: ${err.message}`));
        }
      };
      request.on('response', (response) => {
        let body = '';
        response.on('data', (c) => { body += c.toString(); });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch { resolve(body); }
          } else {
            fail(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 200)}`), remaining);
          }
        });
      });
      request.on('error', (err) => fail(err, remaining));
      if (payload) request.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
      request.end();
    };
    attempt(retries);
  });
}

async function verifySwedishEgress() {
  try {
    const geo = await fetchWithRetry('https://ipinfo.io/json', { method: 'GET' }, null, 2, 1000);
    const country = geo && geo.country;
    console.log(`[Bridge] egress ${geo.ip || '?'} | ${country || '?'} (${(geo && geo.city) || '?'})`);
    if (country && country !== 'SE') console.warn(`[Bridge] exit is ${country}, not SE — exchange calls stay strict-blocked.`);
    else if (country === 'SE') console.log('[Bridge] Swedish routing confirmed.');
    return country;
  } catch (err) {
    console.error('[Bridge] SOCKS5 unreachable:', err.message);
    return null;
  }
}

module.exports = { initProxiedSession, fetchWithRetry, verifySwedishEgress };
