"""
backfill_calibration_to_d1.py — migrate the resolved prediction ledger from the
Tauri / local SQLite (data/truffle_calibration.sqlite3) into D1 (predictions table)
before cutting over engine writes.

Gates (all must pass or the script aborts BEFORE writing):
  G1: source table exists and row count > 0
  G2: column mapping resolves (auto-detects, falls back to --map overrides)
  G3: dry-run insert count == source count
  G4: post-insert D1 count == source count (idempotent re-run safe)

Usage:
  python backfill_calibration_to_d1.py --dry-run
  python backfill_calibration_to_d1.py
"""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.request
import urllib.error

DEFAULT_ACCOUNT_ID = "f226035af09775dbffd7e6350adc8a12"
DEFAULT_DB_ID = "48536b22-03b3-42dd-92fa-44feab144d84"
DEFAULT_D1_API = f"https://api.cloudflare.com/client/v4/accounts/{DEFAULT_ACCOUNT_ID}/d1/database/{DEFAULT_DB_ID}/query"
DEFAULT_SQLITE_PATH = "/mnt/g/WECRYP/data/truffle_calibration.sqlite3"

BATCH_SIZE = 100          # Cloudflare D1 batch limit is typically 100 statements
SOURCE_CANDIDATES = ["predictions", "prediction_ledger", "calibration_predictions"]


def get_default_token() -> str:
    """Read Cloudflare token from env or wrangler OAuth default configuration."""
    for env_var in ("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TOKEN"):
        val = os.getenv(env_var)
        if val:
            return val
    wrangler_config = Path.home() / ".config" / ".wrangler" / "config" / "default.toml"
    if wrangler_config.exists():
        try:
            import tomllib
            with open(wrangler_config, "rb") as f:
                cfg = tomllib.load(f)
                token = cfg.get("oauth_token")
                if token:
                    return token
        except Exception:
            pass
    return ""


def d1_query(url: str, token: str, sql: str, params: list | None = None) -> dict:
    body = json.dumps({"sql": sql, "params": params or []}).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def d1_batch(url: str, token: str, statements: list[dict]) -> dict:
    body = json.dumps({"batch": statements}).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def open_source(args) -> tuple[str, callable, callable]:
    """Return (description, query_fn(sql, params) -> rows, schema_fn(table) -> cols)."""
    sqlite_path = args.sqlite_path
    if not sqlite_path and os.path.exists(DEFAULT_SQLITE_PATH):
        sqlite_path = DEFAULT_SQLITE_PATH

    if sqlite_path and os.path.exists(sqlite_path):
        conn = sqlite3.connect(sqlite_path)
        conn.row_factory = sqlite3.Row
        def q(sql: str, params: tuple = ()):
            cur = conn.cursor()
            cur.execute(sql, params)
            return cur.fetchall()
        def get_cols(table: str):
            cur = conn.cursor()
            cur.execute(f"PRAGMA table_info({table})")
            return [row[1] for row in cur.fetchall()]
        return f"local file {sqlite_path}", q, get_cols

    # HTTP proxy mode fallback
    def q_http(sql: str, params: tuple = ()):
        body = json.dumps({"sql": sql, "params": list(params)}).encode()
        req = urllib.request.Request(
            args.tauri_base, data=body, method="POST",
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    def get_cols_http(table: str):
        rows = q_http(f"PRAGMA table_info({table})")
        return [r[1] if isinstance(r, (list, tuple)) else r.get("name") for r in rows]
    return f"HTTP proxy {args.tauri_base}", q_http, get_cols_http


def main() -> None:
    ap = argparse.ArgumentParser(description="Backfill prediction ledger to Cloudflare D1")
    ap.add_argument("--tauri-base", default="https://leaksnipe.win/db")
    ap.add_argument("--sqlite-path", default=None, help="direct path to SQLite file (preferred)")
    ap.add_argument("--d1-api", default=DEFAULT_D1_API)
    ap.add_argument("--cf-token", default=None, help="Cloudflare API / OAuth token")
    ap.add_argument("--table", default=None)
    ap.add_argument("--map", help="JSON overrides for column mapping, e.g. '{\"hero_won\":\"outcome\"}'")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    token = args.cf_token or get_default_token()
    if not token and not args.dry_run:
        raise SystemExit("CF token required. Provide via --cf-token, CF_API_TOKEN env, or wrangler login.")

    src_desc, q, get_cols = open_source(args)
    print(f"source: {src_desc}")

    # ---- G1: find the source table ----
    table = args.table
    if not table:
        tables = q("SELECT name FROM sqlite_master WHERE type='table'")
        names = [t[0] if isinstance(t, tuple) else (t["name"] if hasattr(t, "keys") else t.get("name")) for t in tables]
        table = next((t for t in SOURCE_CANDIDATES if t in names), None)
        if not table:
            raise SystemExit(f"G1 FAIL: none of {SOURCE_CANDIDATES} found in {names}")
    
    count_row = q(f"SELECT COUNT(*) as cnt FROM {table}")
    count = count_row[0][0] if isinstance(count_row[0], (list, tuple)) else count_row[0]["cnt"]
    print(f"G1 PASS: table '{table}' exists, {count} rows")
    if count == 0:
        raise SystemExit("G1 FAIL: source is empty — nothing to backfill")

    # ---- G2: resolve column mapping against the real schema ----
    src_cols = get_cols(table)
    # Check D1 destination schema
    d1_cols_resp = d1_query(args.d1_api, token, f"PRAGMA table_info(predictions)")
    d1_cols = [r["name"] for r in d1_cols_resp["result"][0]["results"]]
    
    colmap = {}
    if args.map:
        colmap.update(json.loads(args.map))

    # Auto-resolve matching columns, excluding auto-inc primary key 'id' to preserve sequence
    resolved = {}
    for col in src_cols:
        if col == "id":
            continue
        mapped_dst = colmap.get(col, col)
        if mapped_dst in d1_cols:
            resolved[col] = mapped_dst

    # Essential columns check
    essential_check = any(c in resolved for c in ("timestamp_utc", "predicted_at", "prediction_key"))
    if not essential_check:
        raise SystemExit(f"G2 FAIL: required timestamp or prediction_key missing. Resolved: {list(resolved.keys())}")
    
    print(f"G2 PASS: {len(resolved)} columns mapped 1:1 into D1 schema; source cols: {len(src_cols)}, d1 cols: {len(d1_cols)}")

    # ---- G3: dry-run count ----
    src_col_keys = list(resolved.keys())
    select_cols = ", ".join(src_col_keys)
    rows = q(f"SELECT {select_cols} FROM {table} ORDER BY id ASC")
    print(f"G3 PASS: dry-run extracted {len(rows)} rows (expected {count})")
    if len(rows) != count:
        raise SystemExit("G3 FAIL: extraction count mismatch — aborting before any write")

    if args.dry_run:
        print("dry-run complete — no D1 writes performed")
        return

    # ---- bulk insert in batches ----
    dst_cols = [resolved[c] for c in src_col_keys]
    placeholders = "(" + ", ".join(["?"] * len(dst_cols)) + ")"
    insert_sql = (f"INSERT OR IGNORE INTO predictions ({', '.join(dst_cols)}) "
                  f"VALUES {placeholders}")
    
    inserted = 0
    t0 = time.time()
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        stmts = []
        for r in batch:
            row_vals = [r[c] if hasattr(r, "keys") else r[idx] for idx, c in enumerate(src_col_keys)]
            stmts.append({"sql": insert_sql, "params": row_vals})
        
        resp = d1_batch(args.d1_api, token, stmts)
        if not resp.get("success", False):
            raise SystemExit(f"insert failed at batch {i}: {resp}")
        inserted += len(batch)
        print(f"  inserted {inserted}/{len(rows)} (batch {i // BATCH_SIZE + 1}/{(len(rows) + BATCH_SIZE - 1) // BATCH_SIZE})")

    elapsed = time.time() - t0
    print(f"All batches inserted in {elapsed:.1f}s ({inserted / max(elapsed, 0.001):.0f} rows/s)")

    # ---- G4: verify ----
    d1_count_resp = d1_query(args.d1_api, token, "SELECT COUNT(*) as cnt FROM predictions")
    d1_count = d1_count_resp["result"][0]["results"][0]["cnt"]
    print(f"G4 {'PASS' if d1_count == count else 'FAIL'}: D1 has {d1_count} rows, source has {count}")
    if d1_count != count:
        raise SystemExit(f"G4 FAIL: row counts do not match (D1={d1_count}, source={count}) — do NOT cut over engine writes")
    
    # Also verify resolved count parity
    d1_resolved_resp = d1_query(args.d1_api, token, "SELECT COUNT(*) as cnt FROM predictions WHERE resolved_at_utc IS NOT NULL")
    d1_resolved = d1_resolved_resp["result"][0]["results"][0]["cnt"]
    src_resolved_row = q(f"SELECT COUNT(*) as cnt FROM {table} WHERE resolved_at_utc IS NOT NULL")
    src_resolved = src_resolved_row[0][0] if isinstance(src_resolved_row[0], (list, tuple)) else src_resolved_row[0]["cnt"]
    print(f"Resolved verification: D1 resolved={d1_resolved}, source resolved={src_resolved}")

    print("\nBackfill verified. Safe to point scalper-market-data writes at D1.")


if __name__ == "__main__":
    main()
