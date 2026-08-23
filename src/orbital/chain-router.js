// ================================================================
// chain-router.js — Block Explorer Signal Router  v1.0
// Multi-source real-time chain data: primary + fallback per coin
// Uses authenticated providers when keys are present, public endpoints otherwise.
// ================================================================
// Exports:  window.ChainRouter   (primary API)
//           window.BlockchainScan (alias for backward compat)
// Events:   chain-router-update, blockchain-scan-update
// Methods:  .get(sym), .getAll(), .getErrors(), .fetchAll(), .start(), .stop()
// Poll:     every 30 s (configurable via ChainRouter.POLL_MS)
// ================================================================
(function () {
  'use strict';

  const CACHE = {};   // sym → latest result
  const ERRORS = {};   // sym → last error message
  let _timer = null;

  const POLL_MS = 60000;  // 60s polling interval; failing handlers back off independently
  const TIMEOUT = 25000;  // 12s — extra headroom for Tailscale/IPv6 routing
  const ERROR_LOG_COOLDOWN_MS = 60000;
  const ERROR_LOG_STATE = {}; // sym -> { msg, ts }
  const ROUTE_HANDLER_HEALTH = {}; // sym:index -> { failures, nextAt }
  let _fetchInFlight = null;

  function shouldLogRouteError(sym, msg) {
    const now = Date.now();
    const prev = ERROR_LOG_STATE[sym];
    if (!prev || prev.msg !== msg || (now - prev.ts) > ERROR_LOG_COOLDOWN_MS) {
      ERROR_LOG_STATE[sym] = { msg, ts: now };
      return true;
    }
    return false;
  }

  // ── Utility helpers ──────────────────────────────────────────────

  async function timedFetch(url, opts = {}) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => {
      try {
        ctrl.abort(new DOMException(`Chain route timed out after ${TIMEOUT}ms`, 'TimeoutError'));
      } catch (_) {
        try { ctrl.abort(); } catch (_) { }
      }
    }, TIMEOUT);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(tid);
      if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`));
      return r;
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
  }

  async function getJson(url, opts) { return (await timedFetch(url, opts)).json(); }
  async function getText(url, opts) { return (await timedFetch(url, opts)).text(); }
  async function getJsonAny(urls, opts) {
    let lastErr = null;
    for (const url of urls) {
      try {
        return await getJson(url, opts);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('all endpoints failed');
  }

  function handlerKey(sym, index) {
    return `${sym}:${index}`;
  }

  function isHandlerBackedOff(sym, index) {
    const state = ROUTE_HANDLER_HEALTH[handlerKey(sym, index)];
    return !!(state && state.nextAt && Date.now() < state.nextAt);
  }

  function markHandlerSuccess(sym, index) {
    ROUTE_HANDLER_HEALTH[handlerKey(sym, index)] = { failures: 0, nextAt: 0 };
  }

  function markHandlerFailure(sym, index, err) {
    const key = handlerKey(sym, index);
    const state = ROUTE_HANDLER_HEALTH[key] || { failures: 0, nextAt: 0 };
    const failures = state.failures + 1;
    const msg = String(err?.message || err || '').toLowerCase();
    const rateLimited = /429|rate.?limit|too many requests/.test(msg);
    const transient = /abort|timeout|429|5\d\d|network|fetch|econnreset|socket/.test(msg);
    const baseMs = rateLimited ? 15 * 60_000 : (transient ? 60_000 : 5 * 60_000);
    ROUTE_HANDLER_HEALTH[key] = {
      failures,
      nextAt: Date.now() + Math.min(15 * 60_000, baseMs * Math.pow(2, Math.min(4, failures - 1))),
    };
  }

  function fmtCompact(n) {
    n = parseFloat(n);
    if (isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(2);
  }

  function fmtBytes(b) {
    b = parseFloat(b);
    if (isNaN(b)) return '—';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }

  function fmtHashrate(h) {
    const n = parseFloat(h);
    if (isNaN(n)) return '—';
    if (n >= 1e18) return (n / 1e18).toFixed(2) + ' EH/s';
    if (n >= 1e15) return (n / 1e15).toFixed(2) + ' PH/s';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + ' TH/s';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GH/s';
    return n.toFixed(0) + ' H/s';
  }

  function scoreLabel(s) {
    if (s > 0.15) return 'BULLISH';
    if (s < -0.10) return 'BEARISH';
    return 'NEUTRAL';
  }

  function _readEnvLike(name) {
    try {
      if (typeof window !== 'undefined' && window.__env && window.__env[name]) return window.__env[name];
    } catch (_) { }
    try {
      if (typeof localStorage !== 'undefined') {
        const keyMap = {
          ETHERSCAN_API_KEY: 'etherscanApiKey',
          HELIUS_API_KEY: 'heliusApiKey',
          ALCHEMY_API_KEY: 'alchemyApiKey',
        };
        const localKey = keyMap[name];
        if (localKey) {
          const v = localStorage.getItem(localKey);
          if (v) return v;
        }
      }
    } catch (_) { }
    try {
      if (typeof process !== 'undefined' && process && process.env && process.env[name]) return process.env[name];
    } catch (_) { }
    return '';
  }

  async function _getAlchemyKey() {
    let key = _readEnvLike('ALCHEMY_API_KEY');
    if (!key && window.electron && window.electron.readFile) {
      try {
        const txt = await window.electron.readFile('secrets/ALCHEMY-API-KEY.txt');
        if (txt) key = txt.trim();
      } catch (e) { }
    }
    return key || 'UNcUYppLXPl4s0jAkQe_J';
  }

  async function _alchemyUrl(chain) {
    const key = await _getAlchemyKey();
    return `https://${chain}-mainnet.g.alchemy.com/v2/${key}`;
  }

  let _etherscanKeyIndex = 0;
  function _etherscanV2Url(module, action) {
    const qs = new URLSearchParams({
      chainid: '1',
      module: String(module || ''),
      action: String(action || ''),
    });
    const k1 = _readEnvLike('ETHERSCAN_API_KEY');
    const k2 = _readEnvLike('ETHERSCAN_API_KEY_2') || _readEnvLike('ETHERSCAN_API_KEY2');
    const k3 = _readEnvLike('ETHERSCAN_API_KEY_3') || _readEnvLike('ETHERSCAN_API_KEY3');
    const keys = [k1, k2, k3].filter(Boolean);
    if (keys.length > 0) {
      const apiKey = keys[_etherscanKeyIndex % keys.length];
      qs.set('apikey', apiKey);
      _etherscanKeyIndex++;
    }
    return `https://api.etherscan.io/v2/api?${qs.toString()}`;
  }

  function _heliusRpcUrl() {
    const key = _readEnvLike('HELIUS_API_KEY');
    if (!key) return null;
    return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  }

  function _blockCypherUrl(pathname) {
    const base = new URL(String(pathname || ''), 'https://api.blockcypher.com');
    const token = String(_readEnvLike('BLOCKCYPHER_API_TOKEN') || '').trim();
    if (token && !base.searchParams.get('token')) {
      base.searchParams.set('token', token);
    }
    return base.toString();
  }

  function _solRpcCandidates() {
    const urls = ['https://api.mainnet-beta.solana.com'];
    const helius = _heliusRpcUrl();
    if (helius) urls.push(helius);
    urls.push('https://solana-rpc.publicnode.com');
    urls.push('https://api.mainnet.solana.com');
    return urls;
  }

  // ── BTC: mempool.space (primary, v1 endpoints deprecated) ───

  async function btcMempool() {
    const [mR, fR, hR] = await Promise.allSettled([
      getJsonAny([
        'https://mempool.space/api/mempool',
      ]),
      getJsonAny([
        'https://mempool.space/api/v1/fees/recommended',
      ]),
      getJsonAny([
        'https://mempool.space/api/blocks/tip/height',
      ]),
    ]);
    const m = mR.status === 'fulfilled' ? mR.value : {};
    const f = fR.status === 'fulfilled' ? fR.value : {};
    const h = hR.status === 'fulfilled' ? hR.value : null;
    if (!m.count && !f.fastestFee) return Promise.reject(new Error('mempool.space empty'));
    const vsize = m.vsize || 0;
    const feeFast = f.fastestFee || 0;
    const feeMed = f.halfHourFee || 0;
    const feeSlow = f.minimumFee || 0;
    const score = vsize > 200e6 ? 0.55 : vsize > 80e6 ? 0.25 : vsize < 5e6 ? -0.10 : 0;
    return {
      sym: 'BTC', label: 'Bitcoin', chain: 'Bitcoin Network',
      source: 'mempool.space', explorerUrl: 'https://mempool.space',
      metrics: [
        { k: 'Mempool Txs', v: (m.count || 0).toLocaleString() },
        { k: 'Mempool Size', v: fmtBytes(vsize) },
        { k: 'Fee Fast', v: feeFast ? `${feeFast} sat/vB` : '—' },
        { k: 'Fee Med', v: feeMed ? `${feeMed} sat/vB` : '—' },
        { k: 'Fee Slow', v: feeSlow ? `${feeSlow} sat/vB` : '—' },
        { k: 'Block Height', v: h != null ? Number(h).toLocaleString() : '—' },
      ],
      congestion: vsize > 150e6 ? 'HIGH' : vsize > 60e6 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { feeFast, feeMed, feeSlow, vsize: vsize || 0, txCount: m.count || 0 },
    };
  }

  async function btcBlockchain() {
    console.warn('[ChainRouter] blockchain.info endpoints deprecated; mempool.space only');
    return Promise.reject(new Error('blockchain.info no longer available — use mempool.space'));
  }

  async function btcBlockcypher() {
    const data = await getJson(_blockCypherUrl('/v1/btc/main'));
    const txCount = Number(data.unconfirmed_count || 0);
    const feeFast = Number(data.high_fee_per_kb || 0) / 1e5;
    const feeMed = Number(data.medium_fee_per_kb || 0) / 1e5;
    const feeSlow = Number(data.low_fee_per_kb || 0) / 1e5;
    const block = Number(data.height || 0);
    if (!block && !txCount && !feeFast) return Promise.reject(new Error('BlockCypher BTC empty'));
    const score = txCount > 25000 ? 0.45 : txCount > 4000 ? 0.20 : feeFast > 30 ? 0.15 : 0;
    return {
      sym: 'BTC', label: 'Bitcoin', chain: 'Bitcoin Network',
      source: 'BlockCypher', explorerUrl: 'https://live.blockcypher.com/btc',
      metrics: [
        { k: 'Unconfirmed', v: txCount.toLocaleString() },
        { k: 'Block Height', v: block ? block.toLocaleString() : '—' },
        { k: 'Peer Count', v: data.peer_count != null ? Number(data.peer_count).toLocaleString() : '—' },
        { k: 'Fee Fast', v: feeFast ? `${feeFast.toFixed(1)} sat/vB` : '—' },
        { k: 'Fee Med', v: feeMed ? `${feeMed.toFixed(1)} sat/vB` : '—' },
        { k: 'Fee Slow', v: feeSlow ? `${feeSlow.toFixed(1)} sat/vB` : '—' },
      ],
      congestion: txCount > 20000 ? 'HIGH' : txCount > 2500 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { feeFast, feeMed, feeSlow, vsize: 0, txCount, block },
    };
  }

  // ── ETH: Blockscout stats (primary) → Etherscan gas/block fallback ──

  const ETH_BLOCKSCOUT_STATS_URL = 'https://eth.blockscout.com/api/v2/stats';

  function firstNumber(obj, keys) {
    for (const key of keys) {
      const value = key.split('.').reduce((acc, part) => acc?.[part], obj);
      const n = parseFloat(value);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  function firstInteger(obj, keys) {
    for (const key of keys) {
      const value = key.split('.').reduce((acc, part) => acc?.[part], obj);
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  function formatInt(n) {
    return Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString() : '—';
  }

  function ethStatsMetrics(stats, gas) {
    const block = firstInteger(stats, ['total_blocks', 'totalBlocks', 'blocks']);
    const txsToday = firstInteger(stats, ['transactions_today', 'transactionsToday', 'txs_today']);
    const totalAddrs = firstInteger(stats, ['total_addresses', 'totalAddresses', 'addresses']);
    const totalTxs = firstInteger(stats, ['total_transactions', 'totalTransactions', 'transactions']);
    const networkUtil = firstNumber(stats, ['network_utilization_percentage', 'networkUtilizationPercentage']);
    const gasAvg = firstNumber(gas, ['avg', 'average', 'ProposeGasPrice', 'StandardGasPrice', 'SafeGasPrice', 'suggestBaseFee']);
    const gasFast = firstNumber(gas, ['fast', 'FastGasPrice']) || gasAvg;
    const gasSlow = firstNumber(gas, ['slow', 'SafeGasPrice']) || gasAvg;

    return {
      block,
      txsToday,
      totalAddrs,
      totalTxs,
      networkUtil,
      gasAvg,
      gasFast,
      gasSlow,
      metrics: [
        { k: 'Gas Price', v: gasAvg ? `${gasAvg.toFixed(2)} Gwei` : '—' },
        { k: 'Block', v: formatInt(block) },
        { k: 'Gas Fast', v: gasFast ? `${gasFast.toFixed(2)} Gwei` : '—' },
        { k: 'Gas Slow', v: gasSlow ? `${gasSlow.toFixed(2)} Gwei` : '—' },
        { k: 'Txs Today', v: formatInt(txsToday) },
        { k: 'Total Addrs', v: formatInt(totalAddrs) },
        { k: 'Total Txs', v: formatInt(totalTxs) },
        { k: 'Net Util', v: networkUtil ? `${networkUtil.toFixed(1)}%` : '—' },
      ],
    };
  }

  // ── ETH: Alchemy (PRIMARY) ────────────────────────────────────────

  async function ethAlchemy() {
    const POST = (method, params = []) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const url = await _alchemyUrl('eth');
    const [bR, gR] = await Promise.allSettled([
      getJson(url, POST('eth_blockNumber')),
      getJson(url, POST('eth_gasPrice')),
    ]);
    const bRes = bR.status === 'fulfilled' ? bR.value : null;
    const gRes = gR.status === 'fulfilled' ? gR.value : null;
    
    if (!bRes || !gRes || !bRes.result || !gRes.result) {
      return Promise.reject(new Error('Alchemy ETH empty'));
    }
    
    const block   = parseInt(bRes.result, 16) || 0;
    const gasWei  = parseInt(gRes.result, 16) || 0;
    const gasGwei = gasWei / 1e9;
    
    if (!block && !gasGwei) return Promise.reject(new Error('Alchemy ETH empty'));
    
    const score = gasGwei > 60 ? 0.50 : gasGwei > 25 ? 0.20 : gasGwei < 5 ? -0.15 : 0;
    return {
      sym: 'ETH', label: 'Ethereum', chain: 'Ethereum Mainnet',
      source: 'Alchemy', explorerUrl: 'https://etherscan.io',
      metrics: [
        { k: 'Gas Avg',      v: gasGwei ? `${gasGwei.toFixed(1)} Gwei` : '—' },
        { k: 'Gas Fast',     v: gasGwei ? `${(gasGwei * 1.2).toFixed(1)} Gwei` : '—' },
        { k: 'Gas Slow',     v: gasGwei ? `${(gasGwei * 0.8).toFixed(1)} Gwei` : '—' },
        { k: 'Block Height', v: block ? block.toLocaleString() : '—' },
        { k: 'Txs Today',    v: '—' },
        { k: 'Total Addrs',  v: '—' },
      ],
      congestion: gasGwei > 50 ? 'HIGH' : gasGwei > 20 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { gasAvg: gasGwei, gasFast: gasGwei * 1.2, gasSlow: gasGwei * 0.8, txsToday: 0 },
    };
  }

  // ── ETH: Blockscout (fallback) → Etherscan proxy/free (fallback) ──

  async function ethBlockscout() {
    const [sR, pR] = await Promise.allSettled([
      getJson(ETH_BLOCKSCOUT_STATS_URL),
      getJson(_etherscanV2Url('gastracker', 'gasoracle')),
    ]);
    const s = sR.status === 'fulfilled' && sR.value && typeof sR.value === 'object' ? sR.value : {};
    const p = pR.status === 'fulfilled' && pR.value && typeof pR.value === 'object' ? pR.value : {};
    const statsGas = {
      average: s.gas_prices?.average,
      fast: s.gas_prices?.fast,
      slow: s.gas_prices?.slow,
    };
    const etherscanGas = p?.result || {};
    const parsed = ethStatsMetrics(s, { ...statsGas, ...etherscanGas });
    const { gasAvg, gasFast, gasSlow, txsToday, block } = parsed;

    // Require at least one meaningful signal from either stats or gas oracle.
    if (!block && !txsToday && !gasAvg && !gasFast && !gasSlow) {
      return Promise.reject(new Error('Blockscout ETH empty'));
    }

    const score = gasAvg > 60 ? 0.50 : gasAvg > 25 ? 0.20 : gasAvg < 5 ? -0.15 : 0;
    return {
      sym: 'ETH', label: 'Ethereum', chain: 'Ethereum Mainnet',
      source: 'Blockscout/Etherscan', explorerUrl: 'https://eth.blockscout.com',
      metrics: parsed.metrics,
      congestion: gasAvg > 50 ? 'HIGH' : gasAvg > 20 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { gasAvg, gasFast, gasSlow, txsToday, block },
    };
  }

  async function ethEtherscan() {
    const [sR, bR, gR] = await Promise.allSettled([
      getJson(ETH_BLOCKSCOUT_STATS_URL),
      getJson(_etherscanV2Url('proxy', 'eth_blockNumber')),
      getJson(_etherscanV2Url('gastracker', 'gasoracle')),
    ]);
    const s = sR.status === 'fulfilled' && sR.value && typeof sR.value === 'object' ? sR.value : {};
    const bRes = bR.status === 'fulfilled' ? bR.value : null;
    const gRes = gR.status === 'fulfilled' ? gR.value : null;
    const blockFromEtherscan = bRes?.result ? parseInt(bRes.result, 16) || 0 : 0;
    const parsed = ethStatsMetrics(s, gRes?.result || {});
    const block = blockFromEtherscan || parsed.block;
    const gasAvg = parsed.gasAvg;
    if (!block && !gasAvg && !parsed.txsToday) return Promise.reject(new Error('Etherscan ETH empty'));
    const score = gasAvg > 60 ? 0.50 : gasAvg > 25 ? 0.20 : gasAvg < 5 ? -0.15 : 0;
    return {
      sym: 'ETH', label: 'Ethereum', chain: 'Ethereum Mainnet',
      source: 'Etherscan', explorerUrl: 'https://etherscan.io',
      metrics: parsed.metrics.map(m => m.k === 'Block' ? { ...m, v: formatInt(block) } : m),
      congestion: gasAvg > 50 ? 'HIGH' : gasAvg > 20 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { gasAvg, gasFast: parsed.gasFast, gasSlow: parsed.gasSlow, txsToday: parsed.txsToday, block },
    };
  }

  async function ethBlockcypher() {
    const data = await getJson(_blockCypherUrl('/v1/eth/main'));
    const block = Number(data.height || 0);
    const txCount = Number(data.unconfirmed_count || 0);
    const gasAvg = firstNumber(data, ['medium_gas_price', 'gas_price', 'medium_fee_per_kb']) / 1e9;
    const gasFast = firstNumber(data, ['high_gas_price', 'high_fee_per_kb', 'gas_price']) / 1e9 || gasAvg;
    const gasSlow = firstNumber(data, ['low_gas_price', 'low_fee_per_kb', 'gas_price']) / 1e9 || gasAvg;
    if (!block && !txCount && !gasAvg) return Promise.reject(new Error('BlockCypher ETH empty'));
    const score = gasAvg > 60 ? 0.50 : gasAvg > 25 ? 0.20 : gasAvg < 5 ? -0.15 : 0;
    return {
      sym: 'ETH', label: 'Ethereum', chain: 'Ethereum Mainnet',
      source: 'BlockCypher', explorerUrl: 'https://live.blockcypher.com/eth',
      metrics: [
        { k: 'Gas Price', v: gasAvg ? `${gasAvg.toFixed(2)} Gwei` : '—' },
        { k: 'Block', v: formatInt(block) },
        { k: 'Gas Fast', v: gasFast ? `${gasFast.toFixed(2)} Gwei` : '—' },
        { k: 'Gas Slow', v: gasSlow ? `${gasSlow.toFixed(2)} Gwei` : '—' },
        { k: 'Unconfirmed', v: txCount.toLocaleString() },
        { k: 'Peer Count', v: data.peer_count != null ? Number(data.peer_count).toLocaleString() : '—' },
      ],
      congestion: gasAvg > 50 ? 'HIGH' : gasAvg > 20 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { gasAvg, gasFast, gasSlow, txsToday: txCount, block },
    };
  }

  // ── SOL: mainnet-beta RPC (primary) → Ankr public RPC (fallback) ─

  async function solRpc(rpcUrl) {
    const POST = (body) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const [perfR, epochR, slotR] = await Promise.allSettled([
      getJson(rpcUrl, POST({ jsonrpc: '2.0', id: 1, method: 'getRecentPerformanceSamples', params: [10] })),
      getJson(rpcUrl, POST({ jsonrpc: '2.0', id: 2, method: 'getEpochInfo', params: [] })),
      getJson(rpcUrl, POST({ jsonrpc: '2.0', id: 3, method: 'getSlot', params: [] })),
    ]);
    const samples = perfR.status === 'fulfilled' ? (perfR.value?.result || []) : [];
    const epoch = epochR.status === 'fulfilled' ? (epochR.value?.result || {}) : {};
    const slot = slotR.status === 'fulfilled' ? (slotR.value?.result ?? null) : null;
    if (!samples.length && !slot) return Promise.reject(new Error("SOL RPC no samples " + rpcUrl));
    
    const validSamples = samples.filter(s => s && s.numTransactions && s.samplePeriodSecs);
    const avgTPS = validSamples.length > 0 
        ? Math.round(validSamples.reduce((a, x) => a + x.numTransactions / (x.samplePeriodSecs || 60), 0) / validSamples.length)
        : 2000;
    const peakTPS = validSamples.length > 0 
        ? Math.round(Math.max(...validSamples.map(x => x.numTransactions / (x.samplePeriodSecs || 60))))
        : 2500;
        
    const score = avgTPS > 3000 ? 0.50 : avgTPS > 1500 ? 0.20 : avgTPS < 500 ? -0.20 : 0;
    const srcName = rpcUrl.includes('helius') ? 'Helius/Solscan' : (rpcUrl.includes('ankr') ? 'Ankr/Solscan' : 'Solana RPC/Solscan');
    
    return {
      sym: 'SOL', label: 'Solana', chain: 'Solana Mainnet',
      source: srcName, explorerUrl: 'https://solscan.io',
      metrics: [
        { k: 'Avg TPS', v: avgTPS.toLocaleString() },
        { k: 'Peak TPS', v: peakTPS.toLocaleString() },
        { k: 'Epoch', v: epoch.epoch != null ? epoch.epoch.toLocaleString() : '—' },
        { k: 'Slot Height', v: slot != null ? Number(slot).toLocaleString() : '—' },
        { k: 'Slot Index', v: epoch.slotIndex != null ? epoch.slotIndex.toLocaleString() : '—' },
        { k: 'Samples', v: samples.length + " blk" },
      ],
      congestion: avgTPS > 3000 ? 'HIGH' : avgTPS > 1500 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { avgTPS, peakTPS, epoch: epoch.epoch || 0, slot: slot || 0 },
    };
  }

  async function xrpLedger(url) {
    const data = await getJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'server_info', params: [{}] }),
    });
    const info = data?.result?.info || {};
    const ledger = info.validated_ledger || {};
    
    if (!info.server_state && !ledger.seq) {
        return Promise.reject(new Error("XRP invalid response from " + url));
    }

    const loadFactor = info.load_factor || 1;
    const score = loadFactor > 256 ? 0.40 : loadFactor > 16 ? 0.15 : 0;
    const srcName = url.includes('ripple.com') ? 'Ripple RPC' : (url.includes('xrpl.link') ? 'XRPL.link' : 'XRPL Cluster');
    
    return {
      sym: 'XRP', label: 'XRP Ledger', chain: 'XRPL',
      source: srcName, explorerUrl: 'https://xrpscan.com',
      metrics: [
        { k: 'Ledger Index', v: ledger.seq != null ? ledger.seq.toLocaleString() : '—' },
        { k: 'Txns/Ledger', v: ledger.txn_count != null ? ledger.txn_count.toLocaleString() : '—' },
        { k: 'Base Fee', v: ledger.base_fee_xrp != null ? ledger.base_fee_xrp + " XRP" : '—' },
        { k: 'Load Factor', v: loadFactor.toLocaleString() },
        { k: 'Server State', v: info.server_state || (ledger.seq ? 'validated' : '—') },
        { k: 'Peers', v: info.peers != null ? info.peers.toString() : '—' },
      ],
      congestion: loadFactor > 256 ? 'HIGH' : loadFactor > 16 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { loadFactor, txnCount: ledger.txn_count || 0, baseFee: ledger.base_fee_xrp || 0 },
    };
  }

  async function bscRpcGasPrice() {
    const data = await getJson('https://bsc-dataseed.binance.org/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
    });
    const wei = data?.result ? parseInt(data.result, 16) || 0 : 0;
    return wei > 0 ? wei / 1e9 : 0;
  }

  // ── BNB: Alchemy (PRIMARY) ────────────────────────────────────────

  async function bnbAlchemy() {
    const POST = (method, params = []) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const url = await _alchemyUrl('bnb');
    const [bR, gR] = await Promise.allSettled([
      getJson(url, POST('eth_blockNumber')),
      getJson(url, POST('eth_gasPrice')),
    ]);
    const bRes = bR.status === 'fulfilled' ? bR.value : null;
    const gRes = gR.status === 'fulfilled' ? gR.value : null;
    
    if (!bRes || !gRes || !bRes.result || !gRes.result) {
      return Promise.reject(new Error('Alchemy BNB empty'));
    }
    
    const block   = parseInt(bRes.result, 16) || 0;
    const gasWei  = parseInt(gRes.result, 16) || 0;
    const gasGwei = gasWei / 1e9;
    
    if (!block && !gasGwei) return Promise.reject(new Error('Alchemy BNB empty'));
    
    const score = gasGwei > 8 ? 0.40 : gasGwei > 3 ? 0.10 : 0;
    return {
      sym: 'BNB', label: 'BNB Chain', chain: 'BSC Mainnet',
      source: 'Alchemy', explorerUrl: 'https://bscscan.com',
      metrics: [
        { k: 'Gas Price',    v: gasGwei ? `${gasGwei.toFixed(2)} Gwei` : '—' },
        { k: 'Block Height', v: block ? block.toLocaleString() : '—' },
        { k: 'Gas Fast',     v: gasGwei ? `${(gasGwei * 1.2).toFixed(2)} Gwei` : '—' },
        { k: 'Gas Slow',     v: gasGwei ? `${(gasGwei * 0.8).toFixed(2)} Gwei` : '—' },
        { k: 'RPC Node',     v: 'Alchemy' },
        { k: 'Status',       v: 'LIVE' },
      ],
      congestion: gasGwei > 5 ? 'HIGH' : gasGwei > 2 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { gasAvg: gasGwei, gasFast: gasGwei * 1.2, gasSlow: gasGwei * 0.8, txsToday: 0 },
    };
  }

  // ── BNB: Blockscout (fallback) → BSCScan proxy (fallback) ─────

  async function bnbBlockscout() {
    const gasAvg = parseFloat(await bscRpcGasPrice() || 0);
    if (!gasAvg) return Promise.reject(new Error('BSC RPC gas empty'));
    const gasFast = gasAvg;
    const gasSlow = gasAvg;
    const score = gasAvg > 8 ? 0.40 : gasAvg > 3 ? 0.10 : 0;
    return {
      sym: 'BNB', label: 'BNB Chain', chain: 'BSC Mainnet',
      source: 'BSC RPC', explorerUrl: 'https://bscscan.com',
      metrics: [
        { k: 'Gas Avg', v: gasAvg ? `${gasAvg.toFixed(2)} Gwei` : '—' },
        { k: 'Gas Fast', v: gasFast ? `${gasFast.toFixed(2)} Gwei` : '—' },
        { k: 'Gas Slow', v: gasSlow ? `${gasSlow.toFixed(2)} Gwei` : '—' },
        { k: 'Txs Today', v: '—' },
        { k: 'Total Addrs', v: '—' },
        { k: 'Total Txs', v: '—' },
      ],
      congestion: gasAvg > 5 ? 'HIGH' : gasAvg > 2 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { gasAvg, gasFast, gasSlow, txsToday: 0 },
    };
  }

  async function bnbBscscan() {
    const [bR, gR] = await Promise.allSettled([
      getJson('https://api.bscscan.com/api?module=proxy&action=eth_blockNumber'),
      getJson('https://api.bscscan.com/api?module=proxy&action=eth_gasPrice'),
    ]);
    const bRes = bR.status === 'fulfilled' ? bR.value : null;
    const gRes = gR.status === 'fulfilled' ? gR.value : null;

    // Validate responses aren't null
    if (!bRes || !gRes) return Promise.reject(new Error('BSCScan proxy empty'));

    const block = bRes?.result ? parseInt(bRes.result, 16) || 0 : 0;
    const gasWei = gRes?.result ? parseInt(gRes.result, 16) || 0 : 0;
    const gasGwei = gasWei / 1e9;
    if (!block && !gasGwei) return Promise.reject(new Error('BSCScan proxy empty'));
    const score = gasGwei > 8 ? 0.40 : gasGwei > 3 ? 0.10 : 0;
    return {
      sym: 'BNB', label: 'BNB Chain', chain: 'BSC Mainnet',
      source: 'BSCScan', explorerUrl: 'https://bscscan.com',
      metrics: [
        { k: 'Gas Price', v: gasGwei ? `${gasGwei.toFixed(2)} Gwei` : '—' },
        { k: 'Block', v: block ? block.toLocaleString() : '—' },
        { k: 'Gas Fast', v: '—' }, { k: 'Gas Slow', v: '—' },
        { k: 'Txs Today', v: '—' }, { k: 'Total Addrs', v: '—' },
      ],
      congestion: gasGwei > 5 ? 'HIGH' : gasGwei > 2 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { gasAvg: gasGwei, gasFast: gasGwei, gasSlow: gasGwei, txsToday: 0 },
    };
  }

  // ── DOGE: BlockCypher (primary) → Blockchair (fallback) ──────────
  // BlockCypher: 3 req/sec free, no key.  Blockchair: 1 req/min free.

  async function dogeBlockcypher() {
    const data = await getJson(_blockCypherUrl('/v1/doge/main'));
    const uc = data.unconfirmed_count || 0;
    if (!data.height) return Promise.reject(new Error('BlockCypher DOGE empty'));
    const score = uc > 20000 ? 0.40 : uc > 3000 ? 0.20 : 0;
    return {
      sym: 'DOGE', label: 'Dogecoin', chain: 'Dogecoin Network',
      source: 'BlockCypher/Dogescan', explorerUrl: 'https://live.blockcypher.com/doge',
      metrics: [
        { k: 'Unconfirmed', v: uc.toLocaleString() },
        { k: 'Block Height', v: data.height.toLocaleString() },
        { k: 'Peer Count', v: data.peer_count != null ? data.peer_count.toLocaleString() : '—' },
        { k: 'Low Fee', v: data.low_fee_per_kb ? `${(data.low_fee_per_kb / 1e8).toFixed(4)} Ð/KB` : '—' },
        { k: 'Med Fee', v: data.medium_fee_per_kb ? `${(data.medium_fee_per_kb / 1e8).toFixed(4)} Ð/KB` : '—' },
        { k: 'High Fee', v: data.high_fee_per_kb ? `${(data.high_fee_per_kb / 1e8).toFixed(4)} Ð/KB` : '—' },
      ],
      congestion: uc > 5000 ? 'HIGH' : uc > 1000 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { txCount: uc, highFee: data.high_fee_per_kb || 0, medFee: data.medium_fee_per_kb || 0 },
    };
  }

  async function dogeBlockchair() {
    const data = await getJson('https://api.blockchair.com/dogecoin/stats');
    const s = data?.data || {};
    if (!Object.keys(s).length) return Promise.reject(new Error('Blockchair DOGE empty'));
    const txs = s.transactions_24h || 0;
    const mTxs = s.mempool_transactions || 0;
    const score = txs > 100000 ? 0.40 : txs > 50000 ? 0.20 : 0;
    return {
      sym: 'DOGE', label: 'Dogecoin', chain: 'Dogecoin Network',
      source: 'Blockchair/Dogescan', explorerUrl: 'https://blockchair.com/dogecoin',
      metrics: [
        { k: 'Txs 24h', v: txs.toLocaleString() },
        { k: 'Mempool Txs', v: mTxs.toLocaleString() },
        { k: 'Block Height', v: s.best_block_height ? s.best_block_height.toLocaleString() : '—' },
        { k: 'Hashrate 24h', v: s.hashrate_24h ? fmtHashrate(s.hashrate_24h) : '—' },
        { k: 'Difficulty', v: s.difficulty ? Number(s.difficulty).toExponential(2) : '—' },
        { k: 'Outputs 24h', v: s.outputs_24h ? s.outputs_24h.toLocaleString() : '—' },
      ],
      congestion: mTxs > 5000 ? 'HIGH' : mTxs > 1000 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { txCount: mTxs, highFee: 0, medFee: 0 },
    };
  }

  // ── BNB: Ankr public BSC RPC (no key required) ────────────────────

  async function bnbAnkrRpc() {
    const post = body => timedFetch('https://rpc.ankr.com/bsc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const [bR, gR] = await Promise.allSettled([
      post({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      post({ jsonrpc: '2.0', id: 2, method: 'eth_gasPrice', params: [] }),
    ]);
    const bRes = bR.status === 'fulfilled' ? bR.value : null;
    const gRes = gR.status === 'fulfilled' ? gR.value : null;

    // Validate JSON-RPC responses aren't null/undefined
    if (!bRes || !gRes) return Promise.reject(new Error('Ankr BSC RPC empty'));

    const block = bRes?.result ? parseInt(bRes.result, 16) || 0 : 0;
    const gasWei = gRes?.result ? parseInt(gRes.result, 16) || 0 : 0;
    const gasGwei = gasWei / 1e9;

    // If both are zero or invalid, try fallback
    if (!block && !gasGwei) return Promise.reject(new Error('Ankr BSC RPC empty'));

    const score = gasGwei > 8 ? 0.40 : gasGwei > 3 ? 0.10 : 0;
    return {
      sym: 'BNB', label: 'BNB Chain', chain: 'BSC Mainnet',
      source: 'Ankr RPC', explorerUrl: 'https://bscscan.com',
      metrics: [
        { k: 'Gas Price', v: gasGwei ? `${gasGwei.toFixed(2)} Gwei` : '—' },
        { k: 'Block', v: block ? block.toLocaleString() : '—' },
        { k: 'Gas Fast', v: '—' }, { k: 'Gas Slow', v: '—' },
        { k: 'Txs Today', v: '—' }, { k: 'Total Addrs', v: '—' },
      ],
      congestion: gasGwei > 5 ? 'HIGH' : gasGwei > 2 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { gasAvg: gasGwei, gasFast: gasGwei, gasSlow: gasGwei, txsToday: 0 },
    };
  }

  // ── HYPE: Hyperliquid L1 API ──────────────────────────────────────

  async function hypeHyperliquid() {
    const data = await getJson('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    if (!Array.isArray(data)) return Promise.reject(new Error(`HYPE API bad response: ${JSON.stringify(data).slice(0, 80)}`));
    const meta = data[0] || {};
    const ctxs = data[1] || [];
    const idx = (meta?.universe || []).findIndex(a => a.name === 'HYPE');
    const ctx = idx >= 0 ? ctxs[idx] : null;
    if (!ctx) return Promise.reject(new Error('HYPE not found in HL universe'));
    const funding = parseFloat(ctx.funding || 0);
    const oi = parseFloat(ctx.openInterest || 0);
    const vol = parseFloat(ctx.dayNtlVlm || 0);
    // Negative funding = shorts paying longs = bullish pressure
    const score = funding < -0.001 ? 0.30 : funding > 0.001 ? -0.20 : 0;
    return {
      sym: 'HYPE', label: 'HyperLiquid', chain: 'Hyperliquid L1',
      source: 'Hyperliquid/Hypurrscan', explorerUrl: 'https://hypurrscan.io',
      metrics: [
        { k: 'Funding Rate', v: `${(funding * 100).toFixed(4)}%/hr` },
        { k: 'Open Interest', v: `$${fmtCompact(oi)}` },
        { k: 'Day Volume', v: `$${fmtCompact(vol)}` },
        { k: 'Mark Price', v: ctx.markPx ? `$${parseFloat(ctx.markPx).toFixed(4)}` : '—' },
        { k: 'Prev Day Px', v: ctx.prevDayPx ? `$${parseFloat(ctx.prevDayPx).toFixed(4)}` : '—' },
        { k: 'Universe Sz', v: (meta?.universe?.length ?? '—').toString() },
      ],
      congestion: Math.abs(funding) > 0.001 ? 'HIGH' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
      raw: { funding: funding * 100, oi: oi, vol: vol },
    };
  }

  // ── Route table: primary handler first, then fallback(s) ─────────

  function computeVelocity(sym, currRaw, prevRaw) {
    if (!currRaw || !prevRaw) return { score: 0, dominant: 'none' };

    function velPct(curr, prev) {
      if (!prev || prev <= 0) return 0;
      return (curr - prev) / prev;
    }

    let score = 0;
    let dominant = 'none';

    if (sym === 'BTC') {
      const feeVel = velPct(currRaw.feeFast, prevRaw.feeFast);
      const vsizeVel = velPct(currRaw.vsize, prevRaw.vsize);
      const txVel = velPct(currRaw.txCount, prevRaw.txCount);
      score = Math.max(-1, Math.min(1, feeVel * 1.4 + vsizeVel * 0.5 + txVel * 0.3));
      dominant = Math.abs(feeVel) >= 0.08 ? 'fee' : Math.abs(vsizeVel) >= 0.1 ? 'mempool' : 'tx';
    } else if (sym === 'ETH' || sym === 'BNB') {
      const gasVel = velPct(currRaw.gasAvg, prevRaw.gasAvg);
      score = Math.max(-1, Math.min(1, gasVel * 1.5));
      dominant = 'gas';
    } else if (sym === 'SOL') {
      const tpsVel = velPct(currRaw.avgTPS, prevRaw.avgTPS);
      score = Math.max(-1, Math.min(1, tpsVel * 1.2));
      dominant = 'tps';
    } else if (sym === 'XRP') {
      const loadVel = velPct(currRaw.loadFactor, prevRaw.loadFactor);
      const txVel = velPct(currRaw.txnCount, prevRaw.txnCount);
      score = Math.max(-1, Math.min(1, loadVel * 0.7 + txVel * 0.5));
      dominant = 'load';
    } else if (sym === 'DOGE') {
      const txVel = velPct(currRaw.txCount, prevRaw.txCount);
      const feeVel = velPct(currRaw.highFee, prevRaw.highFee);
      score = Math.max(-1, Math.min(1, txVel * 0.8 + feeVel * 0.5));
      dominant = 'tx';
    } else if (sym === 'HYPE') {
      const fundVel = velPct(Math.abs(currRaw.funding), Math.abs(prevRaw.funding || 0.0001));
      score = Math.sign(currRaw.funding) * Math.min(1, Math.abs(fundVel) * 0.8);
      dominant = 'funding';
    }

    return { score, dominant };
  }

  const ROUTES = [
    { sym: 'BTC',  handlers: [btcMempool, btcBlockcypher, btcBlockchain] },
    { sym: 'ETH',  handlers: [ethAlchemy, ethEtherscan, ethBlockscout, ethBlockcypher] },
    { sym: 'SOL',  handlers: [
        ..._solRpcCandidates().map((url) => () => solRpc(url)),
      ]
    },
    {
      sym: 'XRP', handlers: [
        () => xrpLedger('https://xrplcluster.com/'),
        () => xrpLedger('https://s2.ripple.com:51234/'),
        () => xrpLedger('https://s1.ripple.com:51234/'),
      ]
    },
    { sym: 'BNB',  handlers: [bnbAlchemy, bnbAnkrRpc, bnbBscscan, bnbBlockscout] },
    { sym: 'DOGE', handlers: [dogeBlockcypher, dogeBlockchair] },
    { sym: 'HYPE', handlers: [hypeHyperliquid] },
  ];

  // ── Run a route: try each handler until one succeeds ─────────────

  async function runRoute(route) {
    let lastErr = null;
    let skipped = 0;

    for (let i = 0; i < route.handlers.length; i++) {
      const handler = route.handlers[i];
      if (isHandlerBackedOff(route.sym, i)) {
        skipped++;
        continue;
      }
      try {
        const result = await handler();

        if (result?.sym) {
          ERRORS[route.sym] = null;
          markHandlerSuccess(route.sym, i);
          const prev = CACHE[route.sym];
          if (prev?.raw && prev.ts && (result.ts - prev.ts) < 180000) {
            result.velocity = computeVelocity(route.sym, result.raw, prev.raw);
          } else {
            result.velocity = { score: 0, dominant: 'none' };
          }
          const velScore = result.velocity.score;
          const velStrength = Math.min(Math.abs(velScore), 0.8);
          const velWeight = velStrength > 0.15 ? 0.60 : 0.30;
          result.leadingScore = Math.max(-1, Math.min(1,
            result.score * (1 - velWeight) + velScore * velWeight
          ));
          result.velocityLabel = velScore > 0.15 ? 'Rising' : velScore < -0.10 ? 'Falling' : 'Stable';
          return result;
        }
      } catch (e) {
        lastErr = e;
        markHandlerFailure(route.sym, i, e);
        // Per-handler failures are expected during transient endpoint outages.
        // Aggregate failure logging is handled in fetchAll() with cooldown.
      }
    }
    throw lastErr || new Error(`All handlers backed off for ${route.sym} (${skipped}/${route.handlers.length})`);
  }

  // ── Fetch all routes in parallel ────────────────────────────────

  async function fetchAll() {
    if (_fetchInFlight) return _fetchInFlight;
    _fetchInFlight = (async () => {
    const results = await Promise.allSettled(ROUTES.map(r => runRoute(r)));
    ROUTES.forEach(({ sym }, i) => {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value?.sym) {
        CACHE[sym] = r.value;
      } else {
        const msg = r.reason?.message || 'all routes failed';
        ERRORS[sym] = msg;
        // Keep stale cache; mark it so UI can show STALE badge
        if (CACHE[sym]) {
          CACHE[sym].stale = true;
          CACHE[sym].lastError = msg;
        } else {
          CACHE[sym] = {
            sym, error: msg, stale: true,
            label: sym, chain: '—', source: 'unavailable', explorerUrl: '#',
            metrics: [], score: 0, signal: 'NEUTRAL', congestion: 'LOW',
            ts: Date.now(),
          };
        }
        if (shouldLogRouteError(sym, msg)) {
          console.warn(`[ChainRouter] ${sym} all routes failed: ${msg}`);
        }
      }
    });
    // Notify listeners
    const detail = { ...CACHE };
    window.dispatchEvent(new CustomEvent('chain-router-update', { detail }));
    window.dispatchEvent(new CustomEvent('blockchain-scan-update', { detail })); // compat
    return { ...CACHE };
    })();
    try {
      return await _fetchInFlight;
    } finally {
      _fetchInFlight = null;
    }
  }

  // ── Public API ───────────────────────────────────────────────────

  const ChainRouter = {
    POLL_MS,
    get(sym) { return CACHE[sym] || null; },
    getAll() { return { ...CACHE }; },
    getErrors() { return { ...ERRORS }; },
    getRouteHealth() { return { ...ROUTE_HANDLER_HEALTH }; },
    fmtCompact,
    fmtHashrate,
    fetchAll,
    start() {
      if (_timer) return;
      fetchAll();
      _timer = setInterval(fetchAll, POLL_MS);
    },
    stop() { clearInterval(_timer); _timer = null; },
  };

  window.ChainRouter = ChainRouter;
  window.BlockchainScan = ChainRouter; // backward-compat alias

})();

