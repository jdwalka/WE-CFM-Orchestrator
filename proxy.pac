function FindProxyForURL(url, host) {
  if (host.includes('bybit') || host.includes('binance') || host.includes('kalshi') || host.includes('polymarket') || host.includes('coingecko') || host.includes('coinbase')) {
    return 'SOCKS5 127.0.0.1:9050';
  }
  return 'DIRECT';
}
