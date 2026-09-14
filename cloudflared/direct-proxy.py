#!/usr/bin/env python3
"""HTTP CONNECT proxy for WeCrypto geofenced market data.

Binds only to 127.0.0.1:PORT for localhost-only access (not exposed to network).
Enforces an allowlist of geofenced endpoints to prevent abuse as an unrestricted
outbound proxy. All CONNECT requests to non-whitelisted hosts are rejected with 403.
HTTP CONNECT proxy for WeCrypto directHosts.

Windows Electron sockets are captured by Tailscale RouteAll/exit.
WSL sockets with a Windows Ethernet /32 punch reach ASI1 in ~15ms.
Listen on 127.0.0.1 and the WSL vNIC so Windows can CONNECT through us.
"""
import socket
import threading
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080

# Allowlist of permitted CONNECT destinations (geofenced endpoints only).
# Add only the specific hosts required for market data and trading logic.
# Format: 'hostname:port' or 'hostname' (port matched independently).
ALLOWED_DESTINATIONS = {
    'api.polymarket.com:443',
    'clob.polymarket.com:443',
    'polymarket.com:443',
    'binance.com:443',
    'api.binance.com:443',
    'api1.binance.com:443',
    'api2.binance.com:443',
    'api3.binance.com:443',
    'fapi.binance.com:443',
    'dapi.binance.com:443',
    'stream.binance.com:443',
    'fstream.binance.com:443',
    'dstream.binance.com:443',
}


def is_allowed(host, port):
    """Check if destination is in allowlist."""
    dest = f"{host}:{port}"
    return dest in ALLOWED_DESTINATIONS


def pipe(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        try:
            b.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client):
    try:
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < 8192:
            chunk = client.recv(1024)
            if not chunk:
                return
            buf += chunk
        line = buf.split(b"\r\n", 1)[0].decode("ascii", "replace")
        parts = line.split()
        if len(parts) < 2 or parts[0].upper() != "CONNECT":
            client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n")
            return
        host, port = parts[1].rsplit(":", 1)
        port = int(port)
        
        # Security: Whitelist check before connecting
        if not is_allowed(host, port):
            client.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return
        
        dest = socket.create_connection((host, port), timeout=8)
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        t = threading.Thread(target=pipe, args=(dest, client), daemon=True)
        t.start()
        pipe(client, dest)
        t.join(timeout=1)
        dest.close()
    except Exception:
        try:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
        except OSError:
            pass
    finally:
        try:
            client.close()
        except OSError:
            pass


def listen(bind):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((bind, PORT))
    s.listen(128)
    print(f"direct-proxy listen {bind}:{PORT} (allowlist enforced)", flush=True)
    family = socket.AF_INET6 if ":" in bind else socket.AF_INET
    s = socket.socket(family, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((bind, PORT))
    s.listen(128)
    print(f"direct-proxy listen {bind}:{PORT}", flush=True)
    while True:
        c, _ = s.accept()
        threading.Thread(target=handle, args=(c,), daemon=True).start()


def main():
    listen("127.0.0.1")
    threading.Thread(target=listen, args=("127.0.0.1",), daemon=True).start()
    listen("::1")


if __name__ == "__main__":
    main()
