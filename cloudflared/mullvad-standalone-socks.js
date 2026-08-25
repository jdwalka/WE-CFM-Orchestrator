'use strict';
const net = require('net');
const os = require('os');

const PORT = Number(process.env.MULLVAD_SOCKS_PORT || 18090);
const BIND = process.env.MULLVAD_SOCKS_BIND || '127.0.0.1';

// Auto-detect tunnel local address if present, otherwise connect without binding
function resolveTunnelAddress() {
  const envAddr = process.env.MULLVAD_TUNNEL_LOCAL_ADDR;
  const ifaces = os.networkInterfaces();
  const allIps = [];
  
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        allIps.push({ name: name.toLowerCase(), ip: a.address });
      }
    }
  }

  if (envAddr && allIps.some(i => i.ip === envAddr)) {
    return envAddr;
  }

  // Look for wireguard/wecrypto/mullvad/wsl/10.6* interface
  const tunnelIface = allIps.find(i => 
    i.name.includes('wireguard') || 
    i.name.includes('wecrypto') || 
    i.name.includes('mullvad') || 
    i.name.includes('wsl') || 
    i.ip.startsWith('10.6')
  );

  return tunnelIface ? tunnelIface.ip : undefined;
}

const TUNNEL_LOCAL_ADDR = resolveTunnelAddress();
console.log(`[mullvad-standalone-socks] Binding outbound to: ${TUNNEL_LOCAL_ADDR || 'Default Route'}`);

function replySocks(socket, rep, port) {
  const addrType = 1;
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
      client.write(Buffer.from([0x05, 0x00]));
      state = 'request';
    }

    if (state === 'request') {
      if (buffer.length < 4) return;
      const ver = buffer[0];
      const cmd = buffer[1];
      const atyp = buffer[3];
      let host, port, headerLen;

      if (atyp === 0x01) {
        if (buffer.length < 10) return;
        host = [buffer[4], buffer[5], buffer[6], buffer[7]].join('.');
        port = buffer.readUInt16BE(8);
        headerLen = 10;
      } else if (atyp === 0x03) {
        const dlen = buffer[4];
        if (buffer.length < 5 + dlen + 2) return;
        host = buffer.slice(5, 5 + dlen).toString('utf8');
        port = buffer.readUInt16BE(5 + dlen);
        headerLen = 5 + dlen + 2;
      } else {
        replySocks(client, 0x08, 0);
        client.end();
        return;
      }

      const remaining = buffer.slice(headerLen);
      state = 'connecting';
      client.removeListener('data', onData);
      client.pause();

      const connectOpts = { host, port, noDelay: true };
      if (TUNNEL_LOCAL_ADDR) connectOpts.localAddress = TUNNEL_LOCAL_ADDR;

      const dest = net.connect(connectOpts, () => {
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
  console.log(`[mullvad-standalone-socks] ${BIND}:${PORT} -> tunnel ${TUNNEL_LOCAL_ADDR || 'default'}`);
});
