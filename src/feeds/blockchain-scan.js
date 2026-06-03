// ================================================================
// blockchain-scan.js  — Live on-chain metrics for all 7 tracked coins
// Pulls from free public APIs: mempool.space, Blockscout, Solana RPC,
// XRPL Cluster, BSC Blockscout, Blockchair, Hyperliquid
// window.BlockchainScan.get(sym), .getAll(), .start(), .stop()
// ================================================================

(function () {
  'use strict';

  const CACHE = {};
  let _timer = null;
  const INTERVAL_MS = 45000; // poll every 45 s

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtCompact(n) {
    n = parseFloat(n);
    if (isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(2);
  }

  function fmtHashrate(h) {
    const n = parseFloat(h);
    if (isNaN(n)) return h;
    if (n >= 1e18) return (n / 1e18).toFixed(2) + ' EH/s';
    if (n >= 1e15) return (n / 1e15).toFixed(2) + ' PH/s';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + ' TH/s';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GH/s';
    return n.toFixed(2) + ' H/s';
  }

  function fmtBytes(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }

  function scoreLabel(s) {
    if (s > 0.15) return 'BULLISH';
    if (s < -0.1) return 'BEARISH';
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

  function _etherscanV2Url(module, action) {
    const qs = new URLSearchParams({
      chainid: '1',
      module: String(module || ''),
      action: String(action || ''),
    });
    const apiKey = _readEnvLike('ETHERSCAN_API_KEY');
    if (apiKey) qs.set('apikey', apiKey);
    return `https://api.etherscan.io/v2/api?${qs.toString()}`;
  }

  async function _solRpcNodes() {
    const nodes = [];
    const alchemyKey = await _getAlchemyKey();
    nodes.push(`https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}`);
    nodes.push('https://api.mainnet-beta.solana.com');
    let heliusKey = _readEnvLike('HELIUS_API_KEY');
    if (!heliusKey && window.electron && window.electron.readFile) {
      try {
        const txt = await window.electron.readFile('secrets/HELIUS_API_KEYS.txt');
        if (txt) heliusKey = txt.split('\n')[0].trim();
      } catch (e) { }
    }
    if (heliusKey) nodes.push(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`);
    return nodes;
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

  async function _alchemy(chain) {
    const key = await _getAlchemyKey();
    return `https://${chain}-mainnet.g.alchemy.com/v2/${key}`;
  }

  async function safeJson(url, opts) {
    const isPost = opts && opts.method && opts.method.toUpperCase() === 'POST';

    // Add timeout controller (10 second hard limit)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      try {
        controller.abort(new DOMException('Blockchain scan timed out after 10000ms', 'TimeoutError'));
      } catch (_) {
        try { controller.abort(); } catch (_) { }
      }
    }, 20000);
    const signal = controller.signal;

    try {
      // 🚀 FORCE ROUTE THROUGH TOR SOCKS5 IPC BRIDGE
      if (window.electron && typeof window.electron.ipcFetch === 'function') {
        const fetchOpts = { ...opts };
        if (isPost && opts.body) {
          fetchOpts.body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
        }
        const res = await window.electron.ipcFetch(url, fetchOpts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return typeof res.text === 'string' ? JSON.parse(res.text) : res.text;
      }

      // Fallback for non-electron environments
      if (isPost && typeof window.suppFetch === 'function') {
        const body = opts.body ? JSON.parse(opts.body) : null;
        const response = await window.suppFetch(url, { method: 'POST', body, headers: opts.headers, signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }

      if (!isPost && window.resilientFetch) {
        try {
          const r = await window.resilientFetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        } catch (e) {
          const r = await fetch(url, { ...opts, signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }
      }

      const r = await fetch(url, { ...opts, signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function safeJsonAny(urls, opts) {
    let lastErr = null;
    for (const url of urls) {
      try {
        return await safeJson(url, opts);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('all endpoints failed');
  }

  // ── BTC — mempool.space + Alchemy ──────────────────────────────────────────
  async function fetchBTC() {
    try {
      const BTC_RPC = await _alchemy('bitcoin');
      const [mR, fR, hR, aR] = await Promise.allSettled([
        safeJsonAny([
          'https://mempool.space/api/mempool',
        ]),
        safeJsonAny([
          'https://mempool.space/api/v1/fees/recommended',
        ]),
        safeJsonAny([
          'https://mempool.space/api/blocks/tip/height',
        ]),
        safeJson(BTC_RPC, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getmempoolinfo', params: [] })
        })
      ]);
      let m = mR.status === 'fulfilled' ? mR.value : {};
      const f = fR.status === 'fulfilled' ? fR.value : {};
      const height = hR.status === 'fulfilled' ? hR.value : null;
      
      if (aR.status === 'fulfilled' && aR.value?.result) {
        if (!m.vsize) m.vsize = aR.value.result.bytes;
        if (!m.count) m.count = aR.value.result.size;
      }

      const vsize = m.vsize || 0;
      const feeFast = f.fastestFee || 0;
      const score = vsize > 200e6 ? 0.55 : vsize > 80e6 ? 0.25 : vsize < 5e6 ? -0.1 : 0;
      return {
        sym: 'BTC', label: 'Bitcoin', chain: 'Bitcoin Network',
        source: 'mempool.space / Alchemy', explorerUrl: 'https://mempool.space',
        metrics: [
          { k: 'Mempool Txs', v: (m.count || 0).toLocaleString() },
          { k: 'Mempool Size', v: fmtBytes(vsize) },
          { k: 'Fee Fast', v: feeFast ? `${feeFast} sat/vB` : '—' },
          { k: 'Fee Med', v: f.halfHourFee ? `${f.halfHourFee} sat/vB` : '—' },
          { k: 'Fee Slow', v: f.minimumFee ? `${f.minimumFee} sat/vB` : '—' },
          { k: 'Block Height', v: height != null ? Number(height).toLocaleString() : '—' },
        ],
        congestion: vsize > 150e6 ? 'HIGH' : vsize > 60e6 ? 'MED' : 'LOW',
        score, signal: scoreLabel(score), ts: Date.now(),
      };
    } catch (e) {
      console.debug('[BlockchainScan] BTC fetch error:', e.message);
      return { sym: 'BTC', label: 'Bitcoin', chain: 'Bitcoin Network', error: e.message, metrics: [], score: 0 };
    }
  }

  // ── ETH — Alchemy PRIMARY, Etherscan fallback ────────────────────────────────
  async function fetchETH() {
    try {
      const BASE_RPC = await _alchemy('base');
      const ETH_RPC = await _alchemy('eth');
      
      let gas = null;
      let block = 0;
      let baseGasGwei = 0;

      // Primary: Alchemy (most reliable)
      try {
        const [blockR, gasR, baseGasR] = await Promise.allSettled([
          safeJson(ETH_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
          }),
          safeJson(ETH_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_gasPrice', params: [] })
          }),
          safeJson(BASE_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_gasPrice', params: [] })
          }),
        ]);

        if (blockR.status === 'fulfilled' && blockR.value?.result) {
          block = parseInt(blockR.value.result, 16) || 0;
        }
        if (gasR.status === 'fulfilled' && gasR.value?.result) {
          const gasWei = parseInt(gasR.value.result, 16);
          const gasGwei = gasWei / 1e9;
          gas = {
            StandardGasPrice: gasGwei,
            SafeGasPrice: gasGwei * 0.8,
            FastGasPrice: gasGwei * 1.2
          };
        }
        if (baseGasR.status === 'fulfilled' && baseGasR.value?.result) {
          const baseGasWei = parseInt(baseGasR.value.result, 16);
          baseGasGwei = baseGasWei / 1e9;
        }
      } catch (e) {
        console.debug('[BlockchainScan] Alchemy primary failed for ETH, trying Etherscan:', e.message);
      }

      // Fallback: Etherscan if Alchemy fails to get gas
      if (!gas) {
        try {
          const [blockR, gasR] = await Promise.allSettled([
            safeJson(_etherscanV2Url('proxy', 'eth_blockNumber')),
            safeJson(_etherscanV2Url('gastracker', 'gasoracle')),
          ]);
          if (blockR.status === 'fulfilled') {
            block = parseInt(blockR.value?.result, 16) || block;
          }
          if (gasR.status === 'fulfilled' && gasR.value?.result && gasR.value.result.SafeGasPrice) {
            gas = gasR.value.result;
          }
        } catch (e) {
          console.debug('[BlockchainScan] Etherscan fallback failed:', e.message);
        }
      }

      // Safe defaults
      gas = gas || {};
      const gasAvg = parseFloat(gas.ProposeGasPrice || gas.StandardGasPrice || gas.SafeGasPrice || gas.average || 0);
      const gasFast = parseFloat(gas.FastGasPrice || gasAvg || 0);
      const gasSlow = parseFloat(gas.SafeGasPrice || gasAvg * 0.8 || 0);

      if (!block && !gasAvg) throw new Error('All ETH sources failed');

      const score = gasAvg > 60 ? 0.5 : gasAvg > 25 ? 0.2 : gasAvg < 5 ? -0.15 : 0;
      return {
        sym: 'ETH', label: 'Ethereum / Base', chain: 'Ethereum Mainnet',
        source: block ? 'Alchemy' : 'Etherscan', explorerUrl: 'https://etherscan.io',
        metrics: [
          { k: 'L1 Gas Avg', v: gasAvg ? `${gasAvg.toFixed(1)} Gwei` : '—' },
          { k: 'L1 Gas Fast', v: gasFast ? `${gasFast.toFixed(1)} Gwei` : '—' },
          { k: 'Base L2 Gas', v: baseGasGwei ? `${baseGasGwei.toFixed(4)} Gwei` : '—' },
          { k: 'Block Height', v: block ? block.toLocaleString() : '—' },
          { k: 'Txs Today', v: '—' },
          { k: 'Total Addrs', v: '—' },
        ],
        congestion: gasAvg > 50 ? 'HIGH' : gasAvg > 20 ? 'MED' : 'LOW',
        score, signal: scoreLabel(score), ts: Date.now(),
      };
    } catch (e) {
      console.debug('[BlockchainScan] ETH fetch error:', e.message);
      return { sym: 'ETH', label: 'Ethereum / Base', chain: 'Ethereum Mainnet', error: e.message, metrics: [], score: 0 };
    }
  }
        metrics: [
          { k: 'L1 Gas Avg', v: gasAvg ? `${gasAvg.toFixed(1)} Gwei` : '—' },
          { k: 'L1 Gas Fast', v: gasFast ? `${gasFast.toFixed(1)} Gwei` : '—' },
          { k: 'Base L2 Gas', v: baseGasGwei ? `${baseGasGwei.toFixed(4)} Gwei` : '—' },
          { k: 'Block Height', v: block ? block.toLocaleString() : '—' },
          { k: 'Txs Today', v: '—' },
          { k: 'Total Addrs', v: '—' },
        ],
        congestion: gasAvg > 50 ? 'HIGH' : gasAvg > 20 ? 'MED' : 'LOW',
        score, signal: scoreLabel(score), ts: Date.now(),
      };
    } catch (e) {
      console.debug('[BlockchainScan] ETH fetch error:', e.message);
      return { sym: 'ETH', label: 'Ethereum', chain: 'Ethereum Mainnet', error: e.message, metrics: [], score: 0 };
    }
  }

  // ── SOL — Solana mainnet JSON-RPC (multiple fallbacks) ─────────────────
  async function fetchSOL() {
    const SOL_RPC_NODES = await _solRpcNodes();
    for (const SOL_RPC of SOL_RPC_NODES) {
      try {
        const [perfR, epochR] = await Promise.allSettled([
          safeJson(SOL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPerformanceSamples', params: [10] }),
          }),
          safeJson(SOL_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getEpochInfo', params: [] }),
          }),
        ]);
        const samples = perfR.status === 'fulfilled' ? (perfR.value.result || []) : [];
        const epoch = epochR.status === 'fulfilled' ? (epochR.value.result || {}) : {};

        // Skip this RPC if both calls failed
        if (!samples.length && !epoch.epoch) continue;

        const avgTPS = samples.length
          ? Math.round(samples.reduce((s, x) => s + (x.numTransactions / (x.samplePeriodSecs || 60)), 0) / samples.length)
          : 0;
        const peakTPS = samples.length
          ? Math.round(Math.max(...samples.map(x => x.numTransactions / (x.samplePeriodSecs || 60))))
          : 0;
        const score = avgTPS > 3000 ? 0.5 : avgTPS > 1500 ? 0.2 : avgTPS < 500 ? -0.2 : 0;
        return {
          sym: 'SOL', label: 'Solana', chain: 'Solana Mainnet',
          source: `Solana RPC (${SOL_RPC.includes('ankr') ? 'Ankr' : 'Public'})`, explorerUrl: 'https://solscan.io',
          metrics: [
            { k: 'Avg TPS', v: avgTPS.toLocaleString() },
            { k: 'Peak TPS', v: peakTPS.toLocaleString() },
            { k: 'Epoch', v: epoch.epoch != null ? epoch.epoch.toLocaleString() : '—' },
            { k: 'Slot Height', v: epoch.absoluteSlot != null ? epoch.absoluteSlot.toLocaleString() : '—' },
            { k: 'Slot Index', v: epoch.slotIndex != null ? epoch.slotIndex.toLocaleString() : '—' },
            { k: 'Samples', v: samples.length ? `${samples.length} blocks` : '—' },
          ],
          congestion: avgTPS > 3000 ? 'HIGH' : avgTPS > 1500 ? 'MED' : 'LOW',
          score, signal: scoreLabel(score), ts: Date.now(),
        };
      } catch (e) {
        console.debug(`[BlockchainScan] SOL RPC ${SOL_RPC} failed:`, e.message);
        continue;  // Try next RPC
      }
    }

    // All RPC nodes failed
    console.warn('[BlockchainScan] SOL: All RPC nodes failed');
    return { sym: 'SOL', label: 'Solana', chain: 'Solana Mainnet', error: 'All RPC nodes failed', metrics: [], score: 0 };
  }

  // ── XRP — XRPL public JSON-RPC (s1 primary, s2 fallback) ─────────────────
  async function fetchXRP() {
    try {
      const XRP_NODES = [
        'https://s1.ripple.com:51234',
        'https://s2.ripple.com:51234',
        'https://xrplcluster.com',
      ];
      let data = null;
      for (const node of XRP_NODES) {
        try {
          data = await safeJson(node, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'server_info', params: [{}] }),
          });
          if (data?.result) break;
        } catch (e) { /* try next */ }
      }
      if (!data) data = {};
      const info = data.result?.info || {};
      const ledger = info.validated_ledger || {};
      const loadFactor = info.load_factor || 1;
      const score = loadFactor > 256 ? 0.4 : loadFactor > 16 ? 0.15 : 0;
      return {
        sym: 'XRP', label: 'XRP Ledger', chain: 'XRPL',
        source: 'XRPL Cluster', explorerUrl: 'https://xrpscan.com',
        metrics: [
          { k: 'Ledger Index', v: ledger.seq != null ? ledger.seq.toLocaleString() : '—' },
          { k: 'Txns/Ledger', v: ledger.txn_count != null ? ledger.txn_count.toLocaleString() : '—' },
          { k: 'Base Fee', v: ledger.base_fee_xrp != null ? `${ledger.base_fee_xrp} XRP` : '—' },
          { k: 'Load Factor', v: loadFactor.toLocaleString() },
          { k: 'Server State', v: info.server_state || '—' },
          { k: 'Peers', v: info.peers != null ? info.peers.toString() : '—' },
        ],
        congestion: loadFactor > 256 ? 'HIGH' : loadFactor > 16 ? 'MED' : 'LOW',
        score, signal: scoreLabel(score), ts: Date.now(),
      };
    } catch (e) {
      console.debug('[BlockchainScan] XRP fetch error:', e.message);
      return { sym: 'XRP', label: 'XRP Ledger', chain: 'XRPL', error: e.message, metrics: [], score: 0 };
    }
  }

  // ── BNB — BSC Blockscout → public BSC JSON-RPC fallback ───────────────────
  async function _bscRpcNodes() {
    const nodes = [];
    const alchemyKey = await _getAlchemyKey();
    nodes.push(`https://bnb-mainnet.g.alchemy.com/v2/${alchemyKey}`);
    nodes.push('https://rpc.ankr.com/bsc');
    nodes.push('https://bsc-dataseed.binance.org');
    nodes.push('https://bsc-dataseed1.defibit.io');
    nodes.push('https://bsc-dataseed1.ninicoin.io');
    return nodes;
  }

  async function fetchBNBviaRPC() {
    const BSC_RPC_NODES = await _bscRpcNodes();
    for (const node of BSC_RPC_NODES) {
      try {
        const [gpR, bnR] = await Promise.allSettled([
          safeJson(node, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] })
          }),
          safeJson(node, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] })
          }),
        ]);
        const gpWei = gpR.status === 'fulfilled' ? parseInt(gpR.value.result, 16) : 0;
        const block = bnR.status === 'fulfilled' ? parseInt(bnR.value.result, 16) : 0;
        if (!gpWei && !block) continue;
        const gasGwei = gpWei / 1e9;
        const score = gasGwei > 8 ? 0.4 : gasGwei > 3 ? 0.1 : 0;
        return {
          sym: 'BNB', label: 'BNB Chain', chain: 'BSC Mainnet',
          source: new URL(node).hostname, explorerUrl: 'https://bscscan.com',
          metrics: [
            { k: 'Gas Price', v: gasGwei ? `${gasGwei.toFixed(2)} Gwei` : '—' },
            { k: 'Block Height', v: block ? block.toLocaleString() : '—' },
            { k: 'Gas Fast', v: gasGwei ? `${(gasGwei * 1.2).toFixed(2)} Gwei` : '—' },
            { k: 'Gas Slow', v: gasGwei ? `${(gasGwei * 0.8).toFixed(2)} Gwei` : '—' },
            { k: 'RPC Node', v: new URL(node).hostname },
            { k: 'Status', v: 'LIVE' },
          ],
          congestion: gasGwei > 5 ? 'HIGH' : gasGwei > 2 ? 'MED' : 'LOW',
          score, signal: scoreLabel(score), ts: Date.now(),
        };
      } catch (_) { /* try next node */ }
    }
    throw new Error('All BSC RPC nodes unavailable');
  }

  async function fetchBNB() {
    try {
      // Primary: Alchemy (most reliable)
      try {
        const [gpR, bnR] = await Promise.allSettled([
          safeJson('https://bnb-mainnet.g.alchemy.com/v2/UNcUYppLXPl4s0jAkQe_J', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] })
          }),
          safeJson('https://bnb-mainnet.g.alchemy.com/v2/UNcUYppLXPl4s0jAkQe_J', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] })
          }),
        ]);
        const gpWei  = gpR.status === 'fulfilled' ? parseInt(gpR.value.result, 16) : 0;
        const block  = bnR.status === 'fulfilled' ? parseInt(bnR.value.result, 16) : 0;
        if (gpWei || block) {
          const gasGwei = gpWei / 1e9;
          const score   = gasGwei > 8 ? 0.4 : gasGwei > 3 ? 0.1 : 0;
          return {
            sym: 'BNB', label: 'BNB Chain', chain: 'BSC Mainnet',
            source: 'Alchemy', explorerUrl: 'https://bscscan.com',
            metrics: [
              { k: 'Gas Price',    v: gasGwei ? `${gasGwei.toFixed(2)} Gwei` : '—' },
              { k: 'Block Height', v: block   ? block.toLocaleString()        : '—' },
              { k: 'Gas Fast',     v: gasGwei ? `${(gasGwei * 1.2).toFixed(2)} Gwei` : '—' },
              { k: 'Gas Slow',     v: gasGwei ? `${(gasGwei * 0.8).toFixed(2)} Gwei` : '—' },
              { k: 'RPC Node',     v: 'Alchemy' },
              { k: 'Status',       v: 'LIVE' },
            ],
            congestion: gasGwei > 5 ? 'HIGH' : gasGwei > 2 ? 'MED' : 'LOW',
            score, signal: scoreLabel(score), ts: Date.now(),
          };
        }
      } catch (e) {
        console.debug('[BlockchainScan] Alchemy primary failed for BNB, trying BSC RPC:', e.message);
      }
      
      // Fallback: BSC RPC nodes
      return await fetchBNBviaRPC();
    } catch (e) {
      console.debug('[BlockchainScan] BNB fetch error:', e.message);
      return { sym: 'BNB', label: 'BNB Chain', chain: 'BSC Mainnet', error: e.message, metrics: [], score: 0 };
    }
  }

  // ── DOGE — Blockchair + Alchemy ────────────────────────────────────────────
  async function fetchDOGE() {
    try {
      const DOGE_RPC = await _alchemy('dogecoin');
      const [blockchairR, alchemyR] = await Promise.allSettled([
        safeJson('https://api.blockchair.com/dogecoin/stats'),
        safeJson(DOGE_RPC, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getmempoolinfo', params: [] })
        })
      ]);
      const data = blockchairR.status === 'fulfilled' ? blockchairR.value : {};
      const s = data.data || {};
      const txs24h = s.transactions_24h || 0;
      
      let mempoolTxs = s.mempool_transactions;
      if (alchemyR.status === 'fulfilled' && alchemyR.value?.result) {
        if (mempoolTxs == null) mempoolTxs = alchemyR.value.result.size;
      }

      const score = txs24h > 100000 ? 0.4 : txs24h > 50000 ? 0.2 : 0;
      return {
        sym: 'DOGE', label: 'Dogecoin', chain: 'Dogecoin Network',
        source: 'Blockchair / Alchemy', explorerUrl: 'https://blockchair.com/dogecoin',
        metrics: [
          { k: 'Txs 24h', v: txs24h ? txs24h.toLocaleString() : '—' },
          { k: 'Mempool Txs', v: mempoolTxs != null ? mempoolTxs.toLocaleString() : '—' },
          { k: 'Block Height', v: s.best_block_height ? s.best_block_height.toLocaleString() : '—' },
          { k: 'Hashrate 24h', v: s.hashrate_24h ? fmtHashrate(s.hashrate_24h) : '—' },
          { k: 'Difficulty', v: s.difficulty ? Number(s.difficulty).toExponential(2) : '—' },
          { k: 'Outputs 24h', v: s.outputs_24h ? s.outputs_24h.toLocaleString() : '—' },
        ],
        congestion: (mempoolTxs || 0) > 5000 ? 'HIGH' : (mempoolTxs || 0) > 1000 ? 'MED' : 'LOW',
        score, signal: scoreLabel(score), ts: Date.now(),
      };
    } catch (e) {
      console.debug('[BlockchainScan] DOGE fetch error:', e.message);
      return { sym: 'DOGE', label: 'Dogecoin', chain: 'Dogecoin Network', error: e.message, metrics: [], score: 0 };
    }
  }

  // ── HYPE — Hyperliquid L1 ──────────────────────────────────────────────────
  async function fetchHYPE() {
    try {
      const HYPE_RPC = await _alchemy('hyperliquid');
      const [infoR, rpcR] = await Promise.allSettled([
        safeJson('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        }),
        safeJson(HYPE_RPC, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
        })
      ]);
      const data = infoR.status === 'fulfilled' ? infoR.value : null;
      const meta = Array.isArray(data) ? data[0] : {};
      const ctxs = Array.isArray(data) ? data[1] : [];
      const idx = (meta?.universe || []).findIndex(a => a.name === 'HYPE');
      const ctx = idx >= 0 ? ctxs[idx] : null;
      const funding = ctx ? parseFloat(ctx.funding || 0) : 0;
      const oi = ctx ? parseFloat(ctx.openInterest || 0) : 0;
      const vol = ctx ? parseFloat(ctx.dayNtlVlm || 0) : 0;
      const score = funding < -0.001 ? 0.3 : funding > 0.001 ? -0.2 : 0;
      
      const block = rpcR.status === 'fulfilled' && rpcR.value?.result ? parseInt(rpcR.value.result, 16) : null;
      
      return {
        sym: 'HYPE', label: 'HyperLiquid', chain: 'Hyperliquid L1',
        source: 'Hyperliquid / Alchemy', explorerUrl: 'https://hypurrscan.io',
        metrics: [
          { k: 'Funding Rate', v: ctx ? `${(funding * 100).toFixed(4)}%/hr` : '—' },
          { k: 'Open Interest', v: oi ? `$${fmtCompact(oi)}` : '—' },
          { k: 'Day Volume', v: vol ? `$${fmtCompact(vol)}` : '—' },
          { k: 'Block Height', v: block ? block.toLocaleString() : '—' },
          { k: 'Mark Price', v: ctx?.markPx ? `$${parseFloat(ctx.markPx).toFixed(4)}` : '—' },
          { k: 'Prev Day Px', v: ctx?.prevDayPx ? `$${parseFloat(ctx.prevDayPx).toFixed(4)}` : '—' },
        ],
        congestion: Math.abs(funding) > 0.001 ? 'HIGH' : 'LOW',
        score, signal: scoreLabel(score), ts: Date.now(),
      };
    } catch (e) {
      console.debug('[BlockchainScan] HYPE fetch error:', e.message);
      return { sym: 'HYPE', label: 'HyperLiquid', chain: 'Hyperliquid L1', error: e.message, metrics: [], score: 0 };
    }
  }

  // ── Main fetch orchestrator ────────────────────────────────────────────────
  const FETCHERS = [
    { sym: 'BTC', fn: fetchBTC },
    { sym: 'ETH', fn: fetchETH },
    { sym: 'SOL', fn: fetchSOL },
    { sym: 'XRP', fn: fetchXRP },
    { sym: 'BNB', fn: fetchBNB },
    { sym: 'DOGE', fn: fetchDOGE },
    { sym: 'HYPE', fn: fetchHYPE },
  ];

  async function fetchAll() {
    const results = await Promise.allSettled(FETCHERS.map(f => f.fn()));
    FETCHERS.forEach(({ sym }, i) => {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value?.sym) {
        CACHE[r.value.sym] = r.value;
      } else {
        CACHE[sym] = {
          sym, error: r.reason?.message || 'fetch failed',
          label: sym, chain: '—', source: '—', metrics: [],
          score: 0, signal: 'NEUTRAL', ts: Date.now(),
        };
      }
    });
    window.dispatchEvent(new CustomEvent('blockchain-scan-update', { detail: { ...CACHE } }));
    return { ...CACHE };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.BlockchainScan = {
    get: (sym) => CACHE[sym] || null,
    getAll: () => ({ ...CACHE }),
    fetchAll,
    fmtCompact,
    fmtHashrate,
    start: () => {
      if (_timer) return;
      fetchAll();
      _timer = setInterval(fetchAll, INTERVAL_MS);
    },
    stop: () => { clearInterval(_timer); _timer = null; },
  };

})();
