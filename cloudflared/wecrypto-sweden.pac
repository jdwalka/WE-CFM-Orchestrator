function FindProxyForURL(url, host) {
  if (isPlainHostName(host) ||
      shExpMatch(host, "*.local") ||
      shExpMatch(host, "*.prairiedog-godzilla.ts.net") ||
      shExpMatch(host, "localhost") ||
      shExpMatch(host, "127.*") ||
      isInNet(host, "10.0.0.0", "255.0.0.0") ||
      isInNet(host, "172.16.0.0", "255.240.0.0") ||
      isInNet(host, "192.168.0.0", "255.255.0.0") ||
      isInNet(host, "100.64.0.0", "255.192.0.0") ||
      isInNet(host, "127.0.0.0", "255.0.0.0")) {
    return "DIRECT";
  }
  if (shExpMatch(host, "*.argotunnel.com") ||
      shExpMatch(host, "*.cfargotunnel.com") ||
      shExpMatch(host, "*.cloudflare-gateway.com") ||
      shExpMatch(host, "*.cloudflareaccess.com") ||
      shExpMatch(host, "*.leaksnipe.win") ||
      dnsDomainIs(host, "leaksnipe.win")) {
    return "DIRECT";
  }
  return "HTTPS 19itm901rl.proxy.cloudflare-gateway.com:443";
}
