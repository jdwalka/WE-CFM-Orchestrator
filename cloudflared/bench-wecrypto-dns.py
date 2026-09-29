#!/usr/bin/env python3
"""Resolve WeCrypto hosts via LAN / CF Gateway / Mullvad / 1.1.1.1.
Prints NS (authoritative), query ms, A-record sets, and whether geo answers differ.
"""
from __future__ import annotations

import json
import os
import socket
import statistics
import struct
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOMAINS = json.loads((ROOT / "wecrypto-split-domains.json").read_text())
HOSTS = list(dict.fromkeys(DOMAINS["swedenHosts"] + DOMAINS["directHosts"]))
RESOLVERS = [
    ("192.168.18.1", "LAN"),
    ("172.64.36.1", "CF-GW"),
    ("194.242.2.2", "Mullvad"),
    ("1.1.1.1", "CF-pub"),
]


def encode_name(name: str) -> bytes:
    out = b""
    for label in name.rstrip(".").split("."):
        p = label.encode()
        out += bytes([len(p)]) + p
    return out + b"\x00"


def parse_name(buf: bytes, offset: int):
    labels = []
    jumped = False
    end = offset
    for _ in range(32):
        if offset >= len(buf):
            break
        l = buf[offset]
        if l == 0:
            if not jumped:
                end = offset + 1
            break
        if l & 0xC0 == 0xC0:
            ptr = ((l & 0x3F) << 8) | buf[offset + 1]
            if not jumped:
                end = offset + 2
            offset = ptr
            jumped = True
            continue
        offset += 1
        labels.append(buf[offset : offset + l].decode("ascii", "replace"))
        offset += l
        if not jumped:
            end = offset
    return ".".join(labels), end


def dns_query(resolver: str, qname: str, qtype: int, timeout: float = 2.0):
    req = b"\x13\x37\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00"
    req += encode_name(qname) + struct.pack("!HH", qtype, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    t0 = time.time()
    try:
        s.sendto(req, (resolver, 53))
        data, _ = s.recvfrom(2048)
        ms = (time.time() - t0) * 1000
    except Exception as e:
        return {"ok": False, "ms": None, "err": type(e).__name__, "answers": []}
    finally:
        s.close()
    if len(data) < 12:
        return {"ok": False, "ms": ms, "err": "short", "answers": []}
    _id, flags, qdcount, ancount, _, _ = struct.unpack("!HHHHHH", data[:12])
    off = 12
    for _ in range(qdcount):
        _, off = parse_name(data, off)
        off += 4
    answers = []
    for _ in range(ancount):
        name, off = parse_name(data, off)
        if off + 10 > len(data):
            break
        typ, clas, ttl, rdlen = struct.unpack("!HHIH", data[off : off + 10])
        off += 10
        rdata = data[off : off + rdlen]
        off += rdlen
        if typ == 1 and rdlen == 4:
            answers.append(("A", socket.inet_ntoa(rdata), ttl))
        elif typ == 2:
            ns, _ = parse_name(data, off - rdlen)
            answers.append(("NS", ns, ttl))
        elif typ == 5:
            cname, _ = parse_name(data, off - rdlen)
            answers.append(("CNAME", cname, ttl))
        elif typ == 28 and rdlen == 16:
            answers.append(("AAAA", socket.inet_ntop(socket.AF_INET6, rdata), ttl))
    return {"ok": True, "ms": ms, "err": None, "answers": answers, "rcode": flags & 0xF}


def tcp443(ip: str, timeout: float = 0.9):
    t0 = time.time()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((ip, 443))
        return (time.time() - t0) * 1000
    except Exception:
        return None
    finally:
        s.close()


def main():
    print("egress check:", end=" ")
    try:
        import urllib.request

        with urllib.request.urlopen("https://api.ipify.org?format=json", timeout=8) as r:
            j = json.loads(r.read().decode())
            print(j.get("ip"), j.get("country_iso"), j.get("asn_org"))
    except Exception as e:
        print("fail", e)

    print("\n=== Authoritative NS (via 1.1.1.1) ===")
    ns_map = {}
    for host in HOSTS:
        apex = ".".join(host.split(".")[-2:])
        # handle co.uk-style skipped; these are all .com/.io/.app/.xyz/.net/.ai/.vision/.space
        if host.endswith(".com.au"):
            apex = ".".join(host.split(".")[-3:])
        r = dns_query("1.1.1.1", host if host.count(".") < 3 else apex, 2)
        ns = [a[1] for a in r.get("answers", []) if a[0] == "NS"]
        if not ns:
            r = dns_query("1.1.1.1", host, 2)
            ns = [a[1] for a in r.get("answers", []) if a[0] == "NS"]
        ns_map[host] = ns
        vendors = []
        blob = " ".join(ns).lower()
        for k, v in [
            ("cloudflare", "Cloudflare"),
            ("awsdns", "AWS Route53"),
            ("domaincontrol", "GoDaddy"),
            ("akam", "Akamai"),
            ("google", "Google"),
            ("nsone", "NS1"),
            ("dnsimple", "DNSimple"),
            ("azure", "Azure"),
            ("ultradns", "UltraDNS"),
            ("dynect", "Dyn"),
            ("ns.cloudflare", "Cloudflare"),
        ]:
            if k in blob and v not in vendors:
                vendors.append(v)
        print(f"  {host:42} {(vendors or ['?'])}  ns={ns[:3]}")

    print("\n=== A-record query ms + answer fingerprint ===")
    hdr = f"{'host':42} " + " ".join(f"{lab:16}" for _, lab in RESOLVERS) + " geo_diff"
    print(hdr)
    per_res = defaultdict(list)
    diffs = []
    tcp_rows = []
    for host in HOSTS:
        sets = {}
        cells = []
        for ip, lab in RESOLVERS:
            samples = []
            answers = []
            for _ in range(2):
                r = dns_query(ip, host, 1)
                if r["ok"] and r["ms"] is not None:
                    samples.append(r["ms"])
                    answers = [a[1] for a in r["answers"] if a[0] == "A"] or answers
            if samples:
                avg = statistics.mean(samples)
                per_res[lab].append(avg)
                cells.append(f"{avg:6.1f}/{len(answers)}A")
                sets[lab] = tuple(sorted(answers))
            else:
                cells.append(f"{'FAIL':>10}")
                sets[lab] = tuple()
        fingerprints = {v for v in sets.values() if v}
        geo = "DIFF" if len(fingerprints) > 1 else "same"
        if geo == "DIFF":
            diffs.append((host, sets))
        print(f"{host:42} " + " ".join(f"{c:16}" for c in cells) + f" {geo}")
        # TCP 443 to first A from Mullvad vs LAN if both present
        lan_a = sets.get("LAN") or ()
        mv_a = sets.get("Mullvad") or sets.get("CF-GW") or ()
        if lan_a:
            tcp_rows.append((host, "LAN-IP", lan_a[0], tcp443(lan_a[0])))
        if mv_a and (not lan_a or mv_a[0] != lan_a[0]):
            tcp_rows.append((host, "SE-IP", mv_a[0], tcp443(mv_a[0])))

    print("\n=== Resolver average query ms (successful only) ===")
    for ip, lab in RESOLVERS:
        xs = per_res[lab]
        if xs:
            print(f"  {lab:8} n={len(xs):3} avg={statistics.mean(xs):6.1f} med={statistics.median(xs):6.1f} min={min(xs):6.1f}")
        else:
            print(f"  {lab:8} no data")

    print("\n=== Hosts whose A-set differs by resolver (geo DNS) ===")
    if not diffs:
        print("  none")
    for host, sets in diffs:
        for lab, addrs in sets.items():
            print(f"  {host:42} {lab:8} {','.join(addrs) or '-'}")

    print("\n=== TCP/443 connect ms to resolved IPs (from current egress) ===")
    by_host = defaultdict(list)
    for host, kind, ip, ms in tcp_rows:
        by_host[host].append((kind, ip, ms))
    faster = 0
    for host, rows in by_host.items():
        parts = []
        for kind, ip, ms in rows:
            parts.append(f"{kind} {ip}={ms:.0f}ms" if ms is not None else f"{kind} {ip}=FAIL")
        print(f"  {host:42} " + " | ".join(parts))


if __name__ == "__main__":
    main()
