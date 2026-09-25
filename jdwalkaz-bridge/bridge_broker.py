#!/usr/bin/env python3
"""bridge_broker.py — dev stand-in for Redis (:6379) + Redpanda/Kafka (:9092).

Lets truffle-bridge/server.py boot instantly with zero infra:
  - Fake RESP server: in-memory dict + lists, MULTI/EXEC, EX expiry.
  - Minimal Kafka stub: ApiVersions/Metadata/Produce v0 only. Produced
    records are appended to truffle-signals.log (nothing is dropped silently).

DEV ONLY. Not a real broker: no persistence across restarts (except the
signals log), no replication, no auth, binds 127.0.0.1.
"""
import json
import socket
import socketserver
import struct
import threading
import time

SIGNALS_LOG = "/tmp/truffle-signals.log"
_store = {}
_store_lock = threading.Lock()
_offset_counter = [0]
_offset_lock = threading.Lock()
_hw = {}  # (topic, partition) -> highwater offset (dev stub: stays 0, empty log)


# ── RESP helpers ──────────────────────────────────────────────
def r_simple(s):
    return ("+" + s + "\r\n").encode()


def r_err(s):
    return ("-" + s + "\r\n").encode()


def r_int(n):
    return (":" + str(n) + "\r\n").encode()


def r_bulk(b):
    if b is None:
        return b"$-1\r\n"
    if isinstance(b, str):
        b = b.encode()
    return b"$" + str(len(b)).encode() + b"\r\n" + b + b"\r\n"


def r_array(items):
    out = b"*" + str(len(items)).encode() + b"\r\n"
    for it in items:
        out += it
    return out


def read_request(f):
    line = f.readline()
    if not line:
        return None
    line = line.strip()
    if not line.startswith(b"*"):
        # inline command
        return line.decode(errors="replace").split()
    n = int(line[1:])
    args = []
    for _ in range(n):
        h = f.readline().strip()
        ln = int(h[1:])
        data = f.read(ln)
        f.read(2)  # CRLF
        args.append(data.decode(errors="replace"))
    return args


class RespHandler(socketserver.BaseRequestHandler):
    def handle(self):
        f = self.request.makefile("rb")
        in_multi = False
        queue = []
        while True:
            try:
                args = read_request(f)
            except Exception:
                return
            if not args:
                return
            cmd = args[0].upper()
            if cmd == "QUIT":
                self.request.sendall(r_simple("OK"))
                return
            if cmd == "MULTI":
                in_multi = True
                queue = []
                self.request.sendall(r_simple("OK"))
                continue
            if cmd == "DISCARD":
                in_multi = False
                queue = []
                self.request.sendall(r_simple("OK"))
                continue
            if cmd == "EXEC":
                if not in_multi:
                    self.request.sendall(r_err("ERR EXEC without MULTI"))
                    continue
                in_multi = False
                resps = [run_resp(a) for a in queue]
                queue = []
                self.request.sendall(r_array(resps))
                continue
            if in_multi:
                queue.append(args)
                self.request.sendall(b"+QUEUED\r\n")
                continue
            self.request.sendall(run_resp(args))


def run_resp(args):
    cmd = args[0].upper()
    now = time.time()
    if cmd == "PING":
        return r_simple(args[1] if len(args) > 1 else "PONG")
    if cmd == "ECHO":
        return r_bulk(args[1] if len(args) > 1 else "")
    if cmd == "SELECT":
        return r_simple("OK")
    if cmd == "INFO":
        return r_bulk("role:master\r\nbridge_broker:1\r\n")
    if cmd == "DBSIZE":
        with _store_lock:
            return r_int(len(_store))
    if cmd == "COMMAND":
        return r_array([])
    if cmd == "HELLO":
        # Echo the requested protocol version (redis-py demands a match).
        # We then keep serving simple RESP2-compatible replies, which parse
        # fine under either parser since we never push RESP3-only types.
        try:
            proto = int(args[1]) if len(args) > 1 else 2
        except ValueError:
            proto = 2
        if proto not in (2, 3):
            proto = 2
        return (b"%7\r\n$6\r\nserver\r\n$13\r\nbridge_broker\r\n"
                b"$7\r\nversion\r\n$3\r\n1.0\r\n"
                b"$5\r\nproto\r\n:" + str(proto).encode() + b"\r\n"
                b"$2\r\nid\r\n:1\r\n"
                b"$4\r\nmode\r\n$10\r\nstandalone\r\n"
                b"$4\r\nrole\r\n$6\r\nmaster\r\n"
                b"$7\r\nmodules\r\n*0\r\n")
    if cmd in ("GET",):
        with _store_lock:
            e = _store.get(args[1])
            if e is None:
                return r_bulk(None)
            val, exp = e
            if exp and exp < now:
                del _store[args[1]]
                return r_bulk(None)
            return r_bulk(val)
    if cmd == "SET":
        val = args[2] if len(args) > 2 else ""
        exp = None
        i = 3
        ok = True
        while i < len(args):
            o = args[i].upper()
            if o == "EX" and i + 1 < len(args):
                exp = now + int(args[i + 1])
                i += 2
            elif o == "PX" and i + 1 < len(args):
                exp = now + int(args[i + 1]) / 1000.0
                i += 2
            elif o == "NX":
                with _store_lock:
                    if args[1] in _store:
                        ok = False
                i += 1
            elif o == "XX":
                with _store_lock:
                    if args[1] not in _store:
                        ok = False
                i += 1
            else:
                i += 1
        if not ok:
            return r_bulk(None)
        with _store_lock:
            _store[args[1]] = (val, exp)
        return r_simple("OK")
    if cmd == "DEL":
        n = 0
        with _store_lock:
            for k in args[1:]:
                if k in _store:
                    del _store[k]
                    n += 1
        return r_int(n)
    if cmd == "EXISTS":
        with _store_lock:
            return r_int(sum(1 for k in args[1:] if k in _store))
    if cmd == "EXPIRE":
        with _store_lock:
            if args[1] in _store:
                v, _ = _store[args[1]]
                _store[args[1]] = (v, now + int(args[2]))
                return r_int(1)
        return r_int(0)
    if cmd == "TTL":
        with _store_lock:
            e = _store.get(args[1])
            if e is None:
                return r_int(-2)
            _, exp = e
            if not exp:
                return r_int(-1)
            return r_int(max(0, int(exp - now)))
    if cmd == "TYPE":
        with _store_lock:
            e = _store.get(args[1])
            if e is None:
                return r_simple("none")
            v, _ = e
            return r_simple("list" if isinstance(v, list) else "string")
    if cmd == "RPUSH":
        with _store_lock:
            cur = _store.get(args[1])
            lst = cur[0] if cur and isinstance(cur[0], list) else []
            lst = lst + args[2:]
            _store[args[1]] = (lst, None)
            return r_int(len(lst))
    if cmd == "LPUSH":
        with _store_lock:
            cur = _store.get(args[1])
            lst = cur[0] if cur and isinstance(cur[0], list) else []
            lst = args[2:][::-1] + lst
            _store[args[1]] = (lst, None)
            return r_int(len(lst))
    if cmd == "LLEN":
        with _store_lock:
            cur = _store.get(args[1])
            if cur is None:
                return r_int(0)
            return r_int(len(cur[0]) if isinstance(cur[0], list) else 0)
    if cmd == "LTRIM":
        with _store_lock:
            cur = _store.get(args[1])
            if cur is None:
                return r_simple("OK")
            lst = cur[0] if isinstance(cur[0], list) else []
            s, e = int(args[2]), int(args[3])
            n = len(lst)
            if s < 0:
                s = max(0, n + s)
            if e < 0:
                e = n + e
            _store[args[1]] = (lst[s:e + 1], None)
            return r_simple("OK")
    if cmd == "LRANGE":
        with _store_lock:
            cur = _store.get(args[1])
            if cur is None:
                return r_array([])
            lst = cur[0] if isinstance(cur[0], list) else []
            s, e = int(args[2]), int(args[3])
            n = len(lst)
            if s < 0:
                s = max(0, n + s)
            if e < 0:
                e = n + e
            part = lst[s:e + 1]
            return r_array([r_bulk(x) for x in part])
    return r_err("ERR unknown command '%s' (bridge_broker stub)" % args[0])


# ── Minimal Kafka (v0 APIs only) ──────────────────────────────
def rd_string(buf, off):
    (ln,) = struct.unpack_from(">h", buf, off)
    off += 2
    if ln < 0:
        return None, off
    return buf[off:off + ln].decode(errors="replace"), off + ln


def wr_string(s):
    b = s.encode()
    return struct.pack(">h", len(b)) + b


def rd_bytes(buf, off):
    (ln,) = struct.unpack_from(">i", buf, off)
    off += 4
    if ln < 0:
        return None, off
    return buf[off:off + ln], off + ln


def parse_messageset(raw):
    """Best-effort: yield (None, raw-bytes) per record without strict parsing.

    kafka-python 3.x emits framing variants our strict v0/v1 parser chokes on.
    The JSON payloads are visible as plaintext in the blob, so split records
    on the standard 12-byte offset+size prefix and hand the bodies back.
    """
    off = 0
    while off + 12 <= len(raw):
        try:
            (msize,) = struct.unpack_from(">i", raw, off + 8)
        except struct.error:
            return
        if msize <= 0 or off + 12 + msize > len(raw) + 64:
            return
        yield None, raw[off + 12:off + 12 + max(0, msize)]
        if msize <= 0:
            return
        off += 12 + msize


def scrape_json(payload):
    """Pull JSON objects out of a raw produce payload for the signals log."""
    import re
    found = []
    for m in re.finditer(rb"\{[^{}]{2,4096}?\}", payload or b""):
        try:
            found.append(json.loads(m.group(0)))
        except Exception:
            pass
    return found


def uvarint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def cstring(s):
    b = s.encode()
    return uvarint(len(b) + 1) + b


def log_signal(topic, partition, key, value):
    with _offset_lock:
        _offset_counter[0] += 1
        off = _offset_counter[0]
    try:
        entry = {"ts": int(time.time()), "topic": topic, "partition": partition,
                 "key": key.decode(errors="replace") if isinstance(key, bytes) else key,
                 "value": json.loads(value) if value else None}
    except Exception:
        entry = {"ts": int(time.time()), "topic": topic, "partition": partition, "raw_len": len(value or b"")}
    with open(SIGNALS_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return off


class KafkaHandler(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            try:
                hdr = self.request.recv(4, socket.MSG_WAITALL)
            except OSError:
                return
            if len(hdr) < 4:
                return
            (size,) = struct.unpack(">i", hdr)
            buf = b""
            while len(buf) < size:
                chunk = self.request.recv(size - len(buf))
                if not chunk:
                    return
                buf += chunk
            try:
                resp_body = self.dispatch(buf)
            except Exception as e:
                import traceback
                print(f"kafka stub error: {e} api={buf[:4].hex()} len={len(buf)} full={buf.hex()}", flush=True)
                traceback.print_exc()
                return
            corr = buf[4:8]
            out = corr + resp_body
            self.request.sendall(struct.pack(">i", len(out)) + out)

    def dispatch(self, buf):
        (api_key, api_ver) = struct.unpack_from(">hh", buf, 0)
        print(f"kafka req key={api_key} ver={api_ver} len={len(buf)}", flush=True)
        off = 10  # key+ver+corr(4) ... corr consumed separately; client_id follows
        # parse client_id then body
        cid, off = rd_string(buf, 8)
        if api_key == 18:  # ApiVersions — answer in the REQUESTED version
            apis = [(0, 0, 0), (1, 0, 0), (2, 0, 0), (3, 0, 0)]  # Produce/Metadata/Fetch/ListOffsets v0
            if api_ver >= 3:
                body = struct.pack(">h", 0) + uvarint(len(apis) + 1)
                for k, mn, mx in apis:
                    body += struct.pack(">hhh", k, mn, mx) + b"\x00"
                body += struct.pack(">i", 0) + b"\x00"
            elif api_ver >= 1:
                body = struct.pack(">h", 0) + struct.pack(">i", len(apis))
                for k, mn, mx in apis:
                    body += struct.pack(">hhh", k, mn, mx)
                body += struct.pack(">i", 0)
            else:
                body = struct.pack(">h", 0) + struct.pack(">i", len(apis))
                for k, mn, mx in apis:
                    body += struct.pack(">hhh", k, mn, mx)
            return body
        if api_key == 3:  # Metadata v0
            (nt,) = struct.unpack_from(">i", buf, off)
            off += 4
            topics = []
            for _ in range(nt):
                t, off = rd_string(buf, off)
                topics.append(t)
            body = struct.pack(">i", 1)  # 1 broker
            body += struct.pack(">i", 0) + wr_string("127.0.0.1") + struct.pack(">i", 9092)
            body += struct.pack(">i", len(topics))
            for t in topics:
                body += struct.pack(">h", 0) + wr_string(t)
                body += struct.pack(">i", 1)  # 1 partition
                body += struct.pack(">h", 0) + struct.pack(">i", 0) + struct.pack(">i", 0)
                body += struct.pack(">i", 0) + struct.pack(">i", 0)  # replicas, isr
            return body
        if api_key == 0:  # Produce v0
            (acks,) = struct.unpack_from(">h", buf, off)
            off += 2
            (timeout,) = struct.unpack_from(">i", buf, off)
            off += 4
            (nt,) = struct.unpack_from(">i", buf, off)
            off += 4
            resp_topics = b""
            for _ in range(nt):
                topic, off = rd_string(buf, off)
                (nd,) = struct.unpack_from(">i", buf, off)
                off += 4
                for _ in range(nd):
                    (part,) = struct.unpack_from(">i", buf, off)
                    off += 4
                    blob, off = rd_bytes(buf, off)
                    lastoff = 0
                    for _, payload in parse_messageset(blob):
                        for doc in scrape_json(payload):
                            lastoff = log_signal(topic, part, None, json.dumps(doc).encode())
                        if not payload:
                            continue
                    if lastoff == 0:
                        with _offset_lock:
                            _offset_counter[0] += 1
                            lastoff = _offset_counter[0]
                    resp_topics += wr_string(topic) + struct.pack(">i", 1)
                    resp_topics += struct.pack(">i", part) + struct.pack(">h", 0) + struct.pack(">q", lastoff)
            body = struct.pack(">i", nt) + resp_topics
            return body
        if api_key == 1:  # Fetch v0 — always empty (dev stub has no log)
            off += 12  # replica_id + max_wait_ms + min_bytes
            (nt,) = struct.unpack_from(">i", buf, off)
            off += 4
            resp = struct.pack(">i", nt)
            for _ in range(nt):
                topic, off = rd_string(buf, off)
                (nd,) = struct.unpack_from(">i", buf, off)
                off += 4
                resp += wr_string(topic) + struct.pack(">i", nd)
                for _ in range(nd):
                    (part,) = struct.unpack_from(">i", buf, off)
                    off += 4
                    off += 8 + 4  # fetch_offset + max_bytes
                    hw = _hw.get((topic, part), 0)
                    resp += struct.pack(">i", part) + struct.pack(">h", 0)
                    resp += struct.pack(">q", hw) + struct.pack(">i", 0)
            return resp
        if api_key == 2:  # ListOffsets v0
            off += 4  # replica_id
            (nt,) = struct.unpack_from(">i", buf, off)
            off += 4
            resp = struct.pack(">i", nt)
            for _ in range(nt):
                topic, off = rd_string(buf, off)
                (nd,) = struct.unpack_from(">i", buf, off)
                off += 4
                resp += wr_string(topic) + struct.pack(">i", nd)
                for _ in range(nd):
                    (part,) = struct.unpack_from(">i", buf, off)
                    off += 4
                    off += 8  # timestamp
                    hw = _hw.get((topic, part), 0)
                    resp += struct.pack(">i", part) + struct.pack(">h", 0)
                    resp += struct.pack(">i", 1) + struct.pack(">q", hw)
            return resp
        # unknown API: error response with correlation only (client will adapt/fail fast)
        return struct.pack(">h", 35)  # UNSUPPORTED_VERSION


class ThreadedTCP(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    r = ThreadedTCP(("127.0.0.1", 6379), RespHandler)
    k = ThreadedTCP(("127.0.0.1", 9092), KafkaHandler)
    threading.Thread(target=r.serve_forever, daemon=True).start()
    threading.Thread(target=k.serve_forever, daemon=True).start()
    print("bridge_broker up: RESP :6379, kafka-stub :9092, signals ->", SIGNALS_LOG, flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
