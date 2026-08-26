function FindProxyForURL(url, host) {
  var h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1') {
    return 'DIRECT';
  }
  if (h.indexOf('bybit') !== -1 || h.indexOf('binance') !== -1 || h.indexOf('kalshi') !== -1 || h.indexOf('polymarket') !== -1 || h.indexOf('coingecko') !== -1 || h.indexOf('coinbase') !== -1) {
    return 'SOCKS5 127.0.0.1:9050; DIRECT';
  }
  return 'DIRECT';
}
