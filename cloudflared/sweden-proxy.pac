function FindProxyForURL(url, host) {
  var h = host.toLowerCase();

  // Local, AI inference, and Polymarket direct traffic
  if (h === 'localhost' || h === '127.0.0.1' || h.indexOf('asi1.ai') !== -1 || h.indexOf('fetch-ai') !== -1 || h.indexOf('openai') !== -1 || h.indexOf('anthropic') !== -1 || h.indexOf('x.ai') !== -1 || h.indexOf('deepseek') !== -1 || h.indexOf('polymarket') !== -1) {
    return 'DIRECT';
  }

  var needles = [
    'binance', 'bybit', 'okx', 'kraken', 'kucoin', 'mexc', 'bitfinex',
    'gateio', 'crypto.com', 'coinbase', 'coingecko', 'coinmarketcap',
    'dexscreener', 'hyperliquid', 'hypurrscan',
    'etherscan', 'bscscan', 'blockscout',
    'ripple.com', 'xrplcluster', 'bitget', 'bingx', 'whitebit',
    'bitstamp', 'bitso', 'bitvavo', 'upbit', 'deribit', 'mempool.space',
    'blockchair', 'blockcypher', 'whale-alert', 'lbank', 'lbkex', 'coinw',
    'ourbit', 'bullish', 'weex', 'chain.so'
  ];
  for (var i = 0; i < needles.length; i++) {
    if (h.indexOf(needles[i]) !== -1) {
      return 'SOCKS5 10.64.0.1:1080; SOCKS5 127.0.0.1:18090; DIRECT';
    }
  }
  return 'DIRECT';
}