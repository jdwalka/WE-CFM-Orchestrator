#!/usr/bin/env node
/**
 * WE-CRYPTO MCP Server
 * Standard Model Context Protocol (MCP) server over stdio
 * 
 * Provides AI pair programmers & autonomous agents with direct, real-time access to:
 * - Live WeCrypto Signals & Predictions (BTC, ETH, SOL, XRP, etc.)
 * - Kalshi & Polymarket Orderbook & CLOB Execution
 * - Quant Regime Analytics, Edge Weights, and LLM Diagnostics
 * - Cloudflare Tunnel Status (wecrypto.leaksnipe.win)
 */

const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const WECRYPTO_LOCAL_ORIGIN = process.env.WECRYPTO_LOCAL_ORIGIN || 'https://127.0.0.1:3450';
const WECRYPTO_FALLBACK_HTTP = 'http://127.0.0.1:3450';
const WECRYPTO_PUBLIC_ORIGIN = 'https://wecrypto.leaksnipe.win';
const PROXY_ORIGIN = process.env.PROXY_ORIGIN || 'http://127.0.0.1:3010';

// HTTPS agent ignoring self-signed local certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Fetch helper across local or public fallbacks
 */
async function fetchEndpoint(path, options = {}) {
  const urls = [
    `${WECRYPTO_LOCAL_ORIGIN}${path}`,
    `${WECRYPTO_FALLBACK_HTTP}${path}`,
    `${WECRYPTO_PUBLIC_ORIGIN}${path}`
  ];

  let lastError = null;
  for (const url of urls) {
    try {
      const res = await requestPromise(url, options);
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Failed to reach WeCrypto endpoint ${path} on all origins: ${lastError?.message || lastError}`);
}

function requestPromise(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOptions = {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(options.headers || {})
      },
      timeout: options.timeout || 8000,
      agent: isHttps ? httpsAgent : undefined
    };

    const req = client.request(parsed, reqOptions, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (_) {
              resolve({ raw: data, statusCode: res.statusCode });
            }
          } else {
            let errBody;
            try { errBody = JSON.parse(data); } catch (_) { errBody = data; }
            reject(new Error(`HTTP ${res.statusCode}: ${typeof errBody === 'object' ? JSON.stringify(errBody) : errBody}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${urlStr} timed out`));
    });

    if (options.body) {
      req.write(typeof options.body === 'object' ? JSON.stringify(options.body) : options.body);
    }
    req.end();
  });
}

/**
 * Fetch proxy URL helper (for Polymarket / Pyth / External feeds)
 */
async function fetchViaProxy(targetUrl) {
  const proxyUrl = `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(targetUrl)}`;
  return await requestPromise(proxyUrl, { timeout: 10000 });
}

// ── MCP Tool Definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'wecrypto_get_status',
    description: 'Get full health, running state, uptime, memory, and schema version of the WE-CRYPTO Orchestrator service.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'wecrypto_get_predictions',
    description: 'Get real-time market predictions, confidence ratings, price targets, and diagnostic metrics across all active coins (BTC, ETH, SOL, XRP).',
    inputSchema: {
      type: 'object',
      properties: {
        coin: {
          type: 'string',
          description: 'Optional coin symbol (e.g. BTC, ETH, SOL, XRP) to filter results.'
        }
      },
      required: []
    }
  },
  {
    name: 'wecrypto_get_signals',
    description: 'Get active directional signals (UP / DOWN / WAIT) with color-coding, model confidence, and timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        coin: {
          type: 'string',
          description: 'Optional coin symbol to filter.'
        }
      },
      required: []
    }
  },
  {
    name: 'wecrypto_get_settlements',
    description: 'Retrieve the settlement history, strike prices, actual outcomes, and prediction accuracy records.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of settlement records to return (default: 50).'
        }
      },
      required: []
    }
  },
  {
    name: 'wecrypto_get_stats',
    description: 'Get statistical win rates, profit factor, Brier score, and accuracy metrics by coin.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'wecrypto_get_kalshi_markets',
    description: 'Get current Kalshi contract prices, implied odds, strike directions, and orderbook liquidity for crypto 15m/1h prediction markets.',
    inputSchema: {
      type: 'object',
      properties: {
        coin: {
          type: 'string',
          description: 'Optional coin symbol (BTC, ETH, SOL).'
        }
      },
      required: []
    }
  },
  {
    name: 'wecrypto_get_network_status',
    description: 'Get real-time blockchain network congestion, gas prices, TPS, and mempool conditions.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'wecrypto_get_llm_diagnostics',
    description: 'Get LLM signal assistant diagnostic status (provider cooldowns, token usage, confidence ratings, and market regime analysis).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'wecrypto_get_live_debug',
    description: 'Fetch a live memory snapshot directly from the running Electron renderer (DQN weights, tape velocity, CFM scores, and orchestrator intent).',
    inputSchema: {
      type: 'object',
      properties: {
        coin: {
          type: 'string',
          description: 'Coin symbol (BTC, ETH, SOL, XRP) or leave empty for all.'
        }
      },
      required: []
    }
  },
  {
    name: 'wecrypto_get_edge_sync',
    description: 'Fetch edge model weights, sig_prob, and spin metrics used for high-speed VPS execution.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['weights', 'sig-prob', 'spin', 'all'],
          description: 'Type of edge data to retrieve (default: all).'
        }
      },
      required: []
    }
  },
  {
    name: 'wecrypto_poly_orderbook',
    description: 'Fetch real-time Polymarket CLOB orderbook depth, bid/ask spread, and liquidity walls for a market or token ID.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          description: 'Polymarket token ID / asset ID to inspect.'
        }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'wecrypto_poly_markets',
    description: 'Query active Polymarket prediction markets filtered by query or category (e.g. crypto, btc, eth, 15m).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search string for market title or question.'
        },
        limit: {
          type: 'number',
          description: 'Max markets to return (default: 10).'
        }
      },
      required: []
    }
  },
  {
    name: 'wecrypto_cloudflare_tunnel_status',
    description: 'Check Cloudflare Tunnel ingress health and public edge connectivity for wecrypto.leaksnipe.win.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

// ── Tool Handlers ─────────────────────────────────────────────────────────

async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'wecrypto_get_status': {
      const data = await fetchEndpoint('/api/status');
      return data;
    }

    case 'wecrypto_get_predictions': {
      const data = await fetchEndpoint('/api/predictions');
      if (args.coin && data.predictions) {
        const c = args.coin.toUpperCase();
        return {
          success: true,
          coin: c,
          prediction: data.predictions[c] || null,
          meta: data.meta
        };
      }
      return data;
    }

    case 'wecrypto_get_signals': {
      const data = await fetchEndpoint('/api/signals');
      if (args.coin && data.signals) {
        const c = args.coin.toUpperCase();
        return {
          success: true,
          coin: c,
          signal: data.signals[c] || null,
          meta: data.meta
        };
      }
      return data;
    }

    case 'wecrypto_get_settlements': {
      const data = await fetchEndpoint('/api/settlements');
      const limit = Number(args.limit) || 50;
      if (Array.isArray(data.settlements)) {
        return {
          success: true,
          total_count: data.settlements.length,
          settlements: data.settlements.slice(-limit)
        };
      }
      return data;
    }

    case 'wecrypto_get_stats': {
      return await fetchEndpoint('/api/stats');
    }

    case 'wecrypto_get_kalshi_markets': {
      const data = await fetchEndpoint('/api/kalshi-markets');
      if (args.coin && data.markets) {
        const c = args.coin.toUpperCase();
        return {
          success: true,
          coin: c,
          market: data.markets[c] || null,
          meta: data.meta
        };
      }
      return data;
    }

    case 'wecrypto_get_network_status': {
      return await fetchEndpoint('/api/network-status');
    }

    case 'wecrypto_get_llm_diagnostics': {
      return await fetchEndpoint('/api/llm-diagnostics');
    }

    case 'wecrypto_get_live_debug': {
      const query = args.coin ? `?coin=${encodeURIComponent(args.coin.toUpperCase())}` : '';
      return await fetchEndpoint(`/api/live-debug${query}`);
    }

    case 'wecrypto_get_edge_sync': {
      const type = args.type || 'all';
      if (type === 'weights') return await fetchEndpoint('/api/edge/weights');
      if (type === 'sig-prob') return await fetchEndpoint('/api/edge/sig-prob');
      if (type === 'spin') return await fetchEndpoint('/api/edge/spin');
      
      const [weights, sigProb, spin] = await Promise.allSettled([
        fetchEndpoint('/api/edge/weights'),
        fetchEndpoint('/api/edge/sig-prob'),
        fetchEndpoint('/api/edge/spin')
      ]);

      return {
        success: true,
        weights: weights.status === 'fulfilled' ? weights.value : { error: weights.reason?.message },
        sig_prob: sigProb.status === 'fulfilled' ? sigProb.value : { error: sigProb.reason?.message },
        spin: spin.status === 'fulfilled' ? spin.value : { error: spin.reason?.message }
      };
    }

    case 'wecrypto_poly_orderbook': {
      const tokenId = args.tokenId;
      const clobUrl = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;
      return await fetchViaProxy(clobUrl);
    }

    case 'wecrypto_poly_markets': {
      const limit = Number(args.limit) || 10;
      const query = args.query ? `&search=${encodeURIComponent(args.query)}` : '';
      const gammaUrl = `https://gamma-api.polymarket.com/markets?limit=${limit}${query}&active=true&closed=false`;
      return await fetchViaProxy(gammaUrl);
    }

    case 'wecrypto_cloudflare_tunnel_status': {
      let cfList = [];
      try {
        const out = execSync('cloudflared tunnel list --output json', { encoding: 'utf8', timeout: 5000 });
        cfList = JSON.parse(out);
      } catch (e) {
        try {
          const txt = execSync('cloudflared tunnel list', { encoding: 'utf8', timeout: 5000 });
          cfList = { raw: txt };
        } catch (err2) {
          cfList = { error: err2.message };
        }
      }

      let edgeProbe = null;
      try {
        const start = Date.now();
        const probeRes = await requestPromise('https://wecrypto.leaksnipe.win/api/status', { timeout: 6000 });
        edgeProbe = {
          reachable: true,
          latency_ms: Date.now() - start,
          status: probeRes
        };
      } catch (e) {
        edgeProbe = {
          reachable: false,
          error: e.message
        };
      }

      return {
        success: true,
        tunnel_name: 'wecrypto',
        public_url: 'https://wecrypto.leaksnipe.win',
        tunnels: cfList,
        edge_probe: edgeProbe
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC 2.0 stdio Transport ──────────────────────────────────────────

let activeCalls = 0;
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && activeCalls === 0) {
    process.exit(0);
  }
}

function sendResponse(id, result, error) {
  const msg = {
    jsonrpc: '2.0',
    id: id !== undefined ? id : null
  };
  if (error) {
    msg.error = {
      code: error.code || -32603,
      message: error.message || String(error)
    };
  } else {
    msg.result = result;
  }
  const payload = JSON.stringify(msg);
  process.stdout.write(`${payload}\n`);
}

async function processMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  const { id, method, params } = msg;

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'wecrypto-mcp-server',
        version: '1.0.0'
      }
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return;
  }

  if (method === 'ping') {
    sendResponse(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    activeCalls++;
    const { name, arguments: toolArgs } = params || {};
    try {
      const output = await handleToolCall(name, toolArgs);
      sendResponse(id, {
        content: [
          {
            type: 'text',
            text: typeof output === 'object' ? JSON.stringify(output, null, 2) : String(output)
          }
        ],
        isError: false
      });
    } catch (err) {
      sendResponse(id, {
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${err.message || String(err)}`
          }
        ],
        isError: true
      });
    } finally {
      activeCalls--;
      maybeExit();
    }
    return;
  }

  if (id !== undefined) {
    sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
  }
}

// Line buffer for stdin
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      processMessage(msg);
    } catch (err) {
      console.error('[WeCrypto MCP] JSON parse error:', err.message, 'line:', trimmed);
    }
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});

console.error('[WeCrypto MCP] Server active on stdio. Tailnet: prairiedog-godzilla.ts.net | Domain: wecrypto.leaksnipe.win');
