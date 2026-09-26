/**
 * Comprehensive Geo-Fenced & Multi-Venue Connectivity Diagnostic
 * Tests direct egress from Windows LAN, as well as via proxy bouncer (:3010)
 */

async function checkEgressIp() {
  try {
    const res = await fetch('https://am.i.mullvad.net/json', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      return {
        ip: data.ip,
        country: data.country,
        city: data.city,
        mullvadExit: data.mullvad_exit_ip,
        mullvadServer: data.mullvad_exit_ip_hostname || data.mullvad_server_type
      };
    }
  } catch (_) {}
  try {
    const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      return { ip: data.ip, country: data.country, city: data.city, org: data.org };
    }
  } catch (e) {
    return { error: e.message };
  }
}

async function probeUrl(name, url, options = {}) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(options.timeout || 6000),
    });
    const latency = Date.now() - start;
    let sample = '';
    try {
      const text = await res.text();
      sample = text.slice(0, 100).replace(/\s+/g, ' ');
    } catch (_) {}
    return {
      name,
      status: res.status,
      ok: res.ok,
      latencyMs: latency,
      detail: sample,
    };
  } catch (err) {
    return {
      name,
      status: 'ERR',
      ok: false,
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

async function runAllDiagnostics() {
  console.log('================================================================');
  console.log('   WECRYPTO GEO-FENCED & MULTI-VENUE CONNECTIVITY AUDIT');
  console.log('   Timestamp:', new Date().toISOString());
  console.log('================================================================\n');

  console.log('[1] Checking Direct Host LAN Egress IP...');
  const egress = await checkEgressIp();
  console.log('Host Egress Details:', JSON.stringify(egress, null, 2));

  console.log('\n[2] Probing Direct Exchange APIs (Host LAN Direct)...');
  const directProbes = [
    { name: 'Binance FAPI Direct', url: 'https://fapi.binance.com/fapi/v1/ping' },
    { name: 'Bybit V5 Direct', url: 'https://api.bybit.com/v5/market/time' },
    { name: 'OKX Market Direct', url: 'https://aws.okx.com/api/v5/market/time' },
    { name: 'Hyperliquid Direct', url: 'https://api.hyperliquid.xyz/info', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) },
    { name: 'dYdX V4 Direct', url: 'https://indexer.dydx.trade/v4/time' },
    { name: 'Deribit Direct', url: 'https://www.deribit.com/api/v2/public/get_time' },
    { name: 'Coinbase Direct', url: 'https://api.exchange.coinbase.com/time', headers: { 'User-Agent': 'WeCrypto/2.15' } },
    { name: 'Crypto.com Direct', url: 'https://api.crypto.com/exchange/v1/public/get-instruments' },
    { name: 'Pyth Hermes Direct', url: 'https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xe62df6e8354a6a02c80576fe79e442d7bbc1192fa53b5cb5624db4539e7136f4' },
    { name: 'Polymarket Gamma Direct', url: 'https://gamma-api.polymarket.com/events?limit=1' },
  ];

  for (const target of directProbes) {
    const res = await probeUrl(target.name, target.url, {
      method: target.method || 'GET',
      headers: target.headers,
      body: target.body,
    });
    const statusLabel = res.ok ? '✓ OK ' : `✗ ${res.status}`;
    console.log(`  [${statusLabel}] ${target.name.padEnd(25)} ${String(res.latencyMs + 'ms').padStart(7)}  ${res.error || res.detail || ''}`);
  }

  console.log('\n[3] Probing Proxied Routes via HTTP Bouncer (:3010 -> :18090 Stockholm)...');
  const proxiedProbes = [
    { name: 'Binance via :3010', url: 'http://127.0.0.1:3010/binance-f/fapi/v1/ping' },
    { name: 'Bybit via :3010', url: 'http://127.0.0.1:3010/bybit/v5/market/time' },
  ];

  for (const target of proxiedProbes) {
    const res = await probeUrl(target.name, target.url);
    const statusLabel = res.ok ? '✓ OK ' : `✗ ${res.status}`;
    console.log(`  [${statusLabel}] ${target.name.padEnd(25)} ${String(res.latencyMs + 'ms').padStart(7)}  ${res.error || res.detail || ''}`);
  }

  console.log('\n================================================================');
  console.log('   DIAGNOSTIC COMPLETE');
  console.log('================================================================');
}

runAllDiagnostics().catch(console.error);
