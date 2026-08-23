function FindProxyForURL(url, host) {
  var h = host.toLowerCase();
  var needles = [
    'binance', 'bybit', 'okx', 'kraken', 'kucoin', 'mexc', 'bitfinex',
    'gateio', 'crypto.com', 'coinbase', 'coingecko', 'coinmarketcap',
    'dexscreener', 'hyperliquid', 'hypurrscan', 'polymarket', 'kalshi',
    'pyth.network', 'dourolabs.app', 'etherscan', 'bscscan', 'blockscout',
    'ripple.com', 'xrplcluster', 'bitget', 'bingx', 'whitebit',
    'bitstamp', 'bitso', 'bitvavo', 'upbit', 'deribit', 'mempool.space',
    'blockchair', 'blockcypher', 'whale-alert', 'lbank', 'lbkex', 'coinw',
    'ourbit', 'bullish', 'weex', 'chain.so', 'timeapi.io'
  ];
  for (var i = 0; i < needles.length; i++) {
    if (h.indexOf(needles[i]) !== -1) {
      return 'SOCKS5 127.0.0.1:18090; DIRECT';
    }
  }
  return 'DIRECT';
}