'use strict';
/**
 * Minimal SOCKS5 (CONNECT-only, no auth) server for the standalone
 * Mullvad WireGuard tunnel (Table = off, not the default route).
 * Every outbound connection is explicitly source-bound to the tunnel's
 * assigned local address so only traffic sent here goes through Mullvad;
 * everything else on the box stays on native Ethernet.
 */
const net = require('net');

const PORT = Number(process.env.MULLVAD_SOCKS_PORT || 18090);
const BIND = process.env.MULLVAD_SOCKS_BIND || '127.0.0.1';
const TUNNEL_LOCAL_ADDR = process.env.MULLVAD_TUNNEL_LOCAL_ADDR || '10.65.50.149';

function replySocks(socket, rep, port) {
  const addrType = 1; // IPv4
  const addrBuf = Buffer.alloc(4);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port || 0);
  socket.write(Buffer.concat([Buffer.from([0x05, rep, 0x00, addrType]), addrBuf, portBuf]));
}

const server = net.createServer((client) => {
  let state = 'greeting';
  let buffer = Buffer.alloc(0);

  function processBuffer() {
    if (state === 'greeting') {
      if (buffer.length < 2) return;
      const ver = buffer[0];
      const nmethods = buffer[1];
      if (buffer.length < 2 + nmethods) return;
      buffer = buffer.slice(2 + nmethods);
      client.write(Buffer.from([0x05, 0x00])); // no-auth
      state = 'request';
    }

    if (state === 'request') {
      if (buffer.length < 4) return;
      const ver = buffer[0];
      const cmd = buffer[1];
      const atyp = buffer[3];
      let host, port, headerLen;

      if (atyp === 0x01) { // IPv4
        if (buffer.length < 10) return;
        host = [buffer[4], buffer[5], buffer[6], buffer[7]].join('.');
        port = buffer.readUInt16BE(8);
        headerLen = 10;
      } else if (atyp === 0x03) { // Domain
        const dlen = buffer[4];
        if (buffer.length < 5 + dlen + 2) return;
        host = buffer.slice(5, 5 + dlen).toString('utf8');
        port = buffer.readUInt16BE(5 + dlen);
        headerLen = 5 + dlen + 2;
      } else {
        replySocks(client, 0x08, 0); // address type not supported
        client.end();
        return;
      }

      const remaining = buffer.slice(headerLen);
      state = 'connecting';
      client.removeListener('data', onData);
      client.pause();

      const dest = net.connect({ host, port, localAddress: TUNNEL_LOCAL_ADDR, noDelay: true }, () => {
        replySocks(client, 0x00, port);
        dest.setKeepAlive(true, 15000);
        client.setKeepAlive(true, 15000);
        if (remaining.length > 0) dest.write(remaining);
        client.pipe(dest);
        dest.pipe(client);
        client.resume();
      });

      client.on('error', () => { dest.destroy(); });
      dest.on('error', () => { client.destroy(); });
      client.on('close', () => dest.destroy());
      dest.on('close', () => client.destroy());
    }
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    processBuffer();
  }

  client.on('data', onData);
  client.on('error', () => {});
});

server.maxConnections = 256;
server.listen(PORT, BIND, () => {
  console.log(`[mullvad-standalone-socks] ${BIND}:${PORT} -> tunnel ${TUNNEL_LOCAL_ADDR}`);
});
server.on('error', (err) => {
  console.error('[mullvad-standalone-socks]', err.message);
  process.exit(1);
});
