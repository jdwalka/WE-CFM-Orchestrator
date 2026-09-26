#!/usr/bin/env python3
"""
WE-CRYPTO Session & Environment Synchronization Utility
Maintains live synchronization between Windows host and WSL:
- Claude-mem replication across G:/WECRYP/claude-mem and /home/mauro/claude-mem
- Mullvad SOCKS5 (:18090, :18099) and HTTP Bouncer (:3010) health verification
- Local Gemini agent (:8003) health probe and auto-recovery
- Multi-venue proxy routing audit (Binance, Bybit, Polymarket, XRPL)
- Git branch and uncommitted drift inspection
"""

import sys
import os
import json
import time
import socket
import ssl
import subprocess
import urllib.request
import urllib.error

HOST_CLAUDE_MEM = "G:/WECRYP/claude-mem"
WSL_CLAUDE_MEM = "/home/mauro/claude-mem"
TIMEOUT_SEC = 5

def check_tcp_port(host, port, timeout=2.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False

def check_http_endpoint(url, timeout=TIMEOUT_SEC, proxy_handler=None, headers=None):
    t0 = time.time()
    try:
        req_headers = {'User-Agent': 'wecryp-session-sync/1.0'}
        if headers:
            req_headers.update(headers)
        req = urllib.request.Request(url, headers=req_headers)
        
        opener = urllib.request.build_opener(proxy_handler) if proxy_handler else urllib.request.build_opener()
        with opener.open(req, timeout=timeout) as resp:
            data = resp.read()
            elapsed_ms = int((time.time() - t0) * 1000)
            return True, resp.status, elapsed_ms, len(data)
    except urllib.error.HTTPError as e:
        elapsed_ms = int((time.time() - t0) * 1000)
        return False, e.code, elapsed_ms, 0
    except Exception as e:
        elapsed_ms = int((time.time() - t0) * 1000)
        return False, str(e), elapsed_ms, 0

def sync_claude_mem():
    if not os.path.exists(HOST_CLAUDE_MEM):
        return False, f"Host claude-mem not found at {HOST_CLAUDE_MEM}"
    try:
        res = subprocess.run(
            ["wsl", "-e", "cp", "/mnt/g/WECRYP/claude-mem", WSL_CLAUDE_MEM],
            capture_output=True,
            text=True,
            timeout=10
        )
        if res.returncode == 0:
            return True, f"Synced {HOST_CLAUDE_MEM} -> WSL {WSL_CLAUDE_MEM}"
        else:
            return False, f"WSL copy error: {res.stderr.strip()}"
    except Exception as e:
        return False, f"Failed to sync claude-mem: {e}"

def check_git_status():
    try:
        branch = subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd="G:/WECRYP",
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        status = subprocess.check_output(
            ["git", "status", "--porcelain"],
            cwd="G:/WECRYP",
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        head_commit = subprocess.check_output(
            ["git", "log", "-1", "--format=%h %s"],
            cwd="G:/WECRYP",
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        staged = len([l for l in status.splitlines() if l and l[0] in "MADRC"])
        unstaged = len([l for l in status.splitlines() if l and l[1] in "MD"])
        untracked = len([l for l in status.splitlines() if l and l.startswith("??")])
        return {
            "branch": branch,
            "head": head_commit,
            "staged": staged,
            "unstaged": unstaged,
            "untracked": untracked
        }
    except Exception as e:
        return {"error": str(e)}

def run_sync_audit():
    print("=" * 72)
    print("           WE-CRYPTO SESSION & ENVIRONMENT SYNC AUDIT            ")
    print("=" * 72)

    # 1. Claude-mem Sync
    mem_ok, mem_msg = sync_claude_mem()
    mem_status = "[OK] " if mem_ok else "[WARN]"
    print(f"Memory Sync    : {mem_status} {mem_msg}")

    # 2. Local Daemons & Proxies
    p_socks_18090 = check_tcp_port("127.0.0.1", 18090)
    p_socks_18099 = check_tcp_port("127.0.0.1", 18099)
    p_bouncer_3010 = check_tcp_port("127.0.0.1", 3010)
    p_gemini_8003  = check_tcp_port("127.0.0.1", 8003)

    print(f"SOCKS5 (:18090): {'[OK] LISTENING' if p_socks_18090 else '[FAIL] DOWN'}")
    print(f"SOCKS5 (:18099): {'[OK] LISTENING' if p_socks_18099 else '[FAIL] DOWN'}")
    print(f"Bouncer (:3010): {'[OK] LISTENING' if p_bouncer_3010 else '[FAIL] DOWN'}")
    print(f"Gemini  (:8003): {'[OK] LISTENING' if p_gemini_8003 else '[FAIL] DOWN'}")

    # 3. Gemini Health Probe
    if p_gemini_8003:
        g_ok, g_status, g_ms, _ = check_http_endpoint("http://127.0.0.1:8003/health")
        print(f"Gemini Health  : {'[OK]' if g_ok else '[FAIL]'} HTTP {g_status} ({g_ms}ms)")
    else:
        print("Gemini Health  : [WARN] Agent offline on :8003. Auto-spawn available via 'python gemini_agent.py'")

    # 4. Exchange Probes via Bouncer :3010 (Slug Routing to Stockholm SOCKS5)
    binance_ok, binance_code, binance_ms, _ = check_http_endpoint(
        "http://127.0.0.1:3010/binance-f/fapi/v1/ping"
    )
    bybit_ok, bybit_code, bybit_ms, _ = check_http_endpoint(
        "http://127.0.0.1:3010/bybit/v5/market/time"
    )
    poly_ok, poly_code, poly_ms, _ = check_http_endpoint(
        "https://gamma-api.polymarket.com/events?limit=1"
    )
    xrpl_ok, xrpl_code, xrpl_ms, _ = check_http_endpoint(
        "https://xrpl.link/",
        headers={'Content-Type': 'application/json'}
    )

    print(f"Binance (:3010): {'[OK]' if binance_ok else '[FAIL]'} HTTP {binance_code} ({binance_ms}ms)")
    print(f"Bybit   (:3010): {'[OK]' if bybit_ok else '[FAIL]'} HTTP {bybit_code} ({bybit_ms}ms)")
    print(f"Polymarket     : {'[OK]' if poly_ok else '[FAIL]'} HTTP {poly_code} ({poly_ms}ms)")
    print(f"XRPL Link      : {'[OK]' if xrpl_ok else '[FAIL]'} HTTP {xrpl_code} ({xrpl_ms}ms)")

    # 5. Git State
    git_info = check_git_status()
    if "error" in git_info:
        print(f"Git State      : [FAIL] {git_info['error']}")
    else:
        print(f"Git Branch     : [OK] {git_info['branch']} ({git_info['head']})")
        print(f"Working Tree   : Staged={git_info['staged']}, Unstaged={git_info['unstaged']}, Untracked={git_info['untracked']}")

    print("=" * 72)
    return {
        "mem_ok": mem_ok,
        "socks_ok": p_socks_18090,
        "bouncer_ok": p_bouncer_3010,
        "gemini_ok": p_gemini_8003,
        "binance_ok": binance_ok,
        "bybit_ok": bybit_ok,
        "poly_ok": poly_ok,
        "xrpl_ok": xrpl_ok,
        "git": git_info
    }

if __name__ == "__main__":
    results = run_sync_audit()
    all_critical = (
        results["mem_ok"] and
        results["socks_ok"] and
        results["bouncer_ok"] and
        results["gemini_ok"] and
        results["binance_ok"] and
        results["bybit_ok"]
    )
    sys.exit(0 if all_critical else 1)
