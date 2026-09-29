'use strict';
/**
 * Windows localhost relay: Electron → 127.0.0.1:18080 → WSL CONNECT proxy.
 * Windows node cannot bind Ethernet to 34.149.190.89 while Sweden exit is on
 * (Tailscale WFP EACCES). WSL can. Keep WSL hudproxy.py listening on :18080.
 */
const net = require('net');
const { execFileSync } = require('child_process');

function wslIp() {
  if (process.env.ASI1_WSL_IP) return process.env.ASI1_WSL_IP.trim();
  const out = execFileSync('wsl.exe', ['-d', 'Ubuntu', '--', 'hostname', '-I'], {
    encoding: 'utf8',
  });
  const ip = (out || '').trim().split(/\s+/).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
  if (!ip) throw new Error('no WSL IPv4');
  return ip;
}

const BIND = '127.0.0.1';
const PORT = Number(process.env.ASI1_WINDOWS_PROXY_PORT || 18080);
let UP = wslIp();
console.log(`[asi1-wsl-relay] ${BIND}:${PORT} → ${UP}:18080`);

net.createServer((client) => {
  const up = net.connect({ host: UP, port: PORT, noDelay: true }, () => {
    client.pipe(up);
    up.pipe(client);
  });
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
}).listen(PORT, BIND, () => {
  console.log(`[asi1-wsl-relay] listening`);
});
