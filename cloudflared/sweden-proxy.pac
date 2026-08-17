function FindProxyForURL(url, host) {
  var h = host.toLowerCase();
  var needles = [
    'binance', 'bybit', 'okx', 'kraken', 'kucoin', 'mexc', 'bitfinex',
    'gateio', 'crypto.com', 'coinbase', 'coingecko', 'dexscreener',
    'hyperliquid', 'polymarket', 'kalshi', 'pyth.network', 'etherscan',
    'ripple.com', 'xrplcluster'
  ];
  for (var i = 0; i < needles.length; i++) {
    if (h.indexOf(needles[i]) !== -1) {
      return 'SOCKS5 10.64.0.1:1080; DIRECT';
    }
  }
  return 'DIRECT';
}
