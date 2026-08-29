#!/usr/bin/env python3
"""HTTP CONNECT proxy for WeCrypto directHosts.

Windows Electron sockets are captured by Tailscale RouteAll/exit.
WSL sockets with a Windows Ethernet /32 punch reach ASI1 in ~15ms.
Listen on 127.0.0.1 and the WSL vNIC so Windows can CONNECT through us.
"""
import socket
import threading
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080


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
    threading.Thread(target=listen, args=("127.0.0.1",), daemon=True).start()
    listen("::1")


if __name__ == "__main__":
    main()
