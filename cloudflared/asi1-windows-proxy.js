'use strict';
/**
 * Windows CONNECT proxy for ASI1 (and other directHosts).
 * Run with Windows node, not WSL. Listens on 127.0.0.1:18080.
 * No idle timeout — asi1-ultra can run >60s.
 */
const net = require('net');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* */ }

const PORT = Number(process.env.ASI1_WINDOWS_PROXY_PORT || 18080);
const BIND = process.env.ASI1_WINDOWS_PROXY_BIND || '127.0.0.1';

const server = net.createServer((client) => {
  client.once('data', (buf) => {
    const head = buf.toString('utf8');
    const line = head.split('\r\n')[0] || '';
    const m = line.match(/^CONNECT\s+([^:\s]+):(\d+)/i);
    if (!m) {
      client.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
      return;
    }
    const host = m[1];
    const port = Number(m[2]);
    const localAddress = process.env.ASI1_PROXY_LOCAL_ADDR || '192.168.18.38';
    const dest = net.connect({ host, port, noDelay: true, localAddress }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.indexOf('\r\n\r\n');
      const leftover = rest >= 0 ? buf.slice(rest + 4) : Buffer.alloc(0);
      if (leftover.length) dest.write(leftover);
      client.pipe(dest);
      dest.pipe(client);
    });
    dest.setKeepAlive(true, 15000);
    client.setKeepAlive(true, 15000);
    dest.setTimeout(0);
    client.setTimeout(0);
    dest.on('error', () => client.destroy());
    client.on('error', () => dest.destroy());
  });
});

server.maxConnections = 256;
server.listen(PORT, BIND, () => {
  console.log(`[asi1-windows-proxy] ${BIND}:${PORT}`);
});
server.on('error', (err) => {
  console.error('[asi1-windows-proxy]', err.message);
  process.exit(1);
});
