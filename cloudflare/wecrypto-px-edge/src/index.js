export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get('symbol') || 'BTC').toUpperCase();
    const cacheKey = `px:${symbol}:1h`;

    // 1. For /px queries, check Workers KV for the last hourly snapshot
    if (url.pathname.startsWith('/px')) {
      const cacheKey = `px:${symbol}:1h`;
      try {
        const cached = await env.PX_KV.get(cacheKey, 'json');
        if (cached) {
          return Response.json(cached, {
            headers: {
              'content-type': 'application/json',
              'x-cache': 'HIT',
              'access-control-allow-origin': '*',
            },
          });
        }
      } catch (e) {
        console.error('[wecrypto-px-edge] KV read error:', e);
      }
    }

    // 2. Fall through to Truffle tunnel origin (proxies /px, /cascade, etc.)
    try {
      const targetUrl = `${env.TRUFFLE_ORIGIN}${url.pathname}${url.search}`;
      const fetchOpts = {
        method: req.method,
        headers: req.headers,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fetchOpts.body = req.body;
      }
      const response = await fetch(targetUrl, fetchOpts);

      if (response.ok && url.pathname.startsWith('/px')) {
        const data = await response.json();
        // Cache snapshot in KV for fast repeated pulls (TTL 300s)
        try {
          const cacheKey = `px:${symbol}:1h`;
          await env.PX_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
        } catch (_) {}

        return Response.json(data, {
          status: response.status,
          headers: {
            'content-type': 'application/json',
            'x-cache': 'MISS',
            'access-control-allow-origin': '*',
          },
        });
      }

      return response;
    } catch (err) {
      return Response.json({
        status: 'error',
        message: `Upstream fetch failed: ${err.message}`,
      }, { status: 502 });
    }
  },
};
