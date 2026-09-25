"""jdwalkaz persistent memory — SQLite store + Electron-safe JSON snapshot.

Single-writer design: the WSL oracle agent owns all writes. The Windows
Electron HUD never touches SQLite directly (cross-boundary file locking on
the DrvFs mount is unreliable); it reads
``data/jdwalkaz_memory_snapshot.json`` instead, which is refreshed on every
write. The snapshot is a plain JSON array the renderer can load with the
existing ``window.electron.readFile`` bridge — no SQLite dependency.

Tables:
  memories(id, created_at, kind, key, summary, detail, importance,
           source, expires_at)
  memories_fts — FTS5 index over summary/detail/key (optional; LIKE
           fallback when FTS5 is unavailable), kept in sync by triggers.
  context_state(key, value, updated_at) — rolling key/value context
           (e.g. desk_status, open_loops).

Stdlib only. DB location: $JDWALKAZ_MEMORY_DB, else
<repo>/data/jdwalkaz_memory.sqlite3 (data/ is gitignored).
"""

import argparse
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_DB_PATH = Path(
    os.environ.get(
        "JDWALKAZ_MEMORY_DB",
        str(REPO_ROOT / "data" / "jdwalkaz_memory.sqlite3"),
    )
)
SNAPSHOT_FILENAME = "jdwalkaz_memory_snapshot.json"

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL DEFAULT 'note',
  key TEXT,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  importance REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT '',
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS context_state(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
"""

FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(summary, detail, key, content='memories', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, detail, key)
  VALUES (new.id, new.summary, new.detail, new.key);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, detail, key)
  VALUES ('delete', old.id, old.summary, old.detail, old.key);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, detail, key)
  VALUES ('delete', old.id, old.summary, old.detail, old.key);
  INSERT INTO memories_fts(rowid, summary, detail, key)
  VALUES (new.id, new.summary, new.detail, new.key);
END;
"""

# Tight patterns for things that must never land in long-term memory.
_SECRET_PATTERNS = [
    r"sk-[A-Za-z0-9]{16,}",
    r"ghp_[A-Za-z0-9]{20,}",
    r"github_pat_[A-Za-z0-9_]+",
    r"glpat-[A-Za-z0-9_.\-]+",
    r"xox[bap]-[A-Za-z0-9\-]+",
    r"AKIA[0-9A-Z]{16}",
]
_SECRET_RES = [re.compile(p) for p in _SECRET_PATTERNS]


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _connect(db_path=None) -> sqlite3.Connection:
    path = Path(db_path) if db_path else DEFAULT_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")  # portable across the DrvFs boundary; no WAL
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db(db_path=None) -> str:
    """Create schema (idempotent). Returns the DB path used."""
    path = Path(db_path) if db_path else DEFAULT_DB_PATH
    conn = _connect(path)
    try:
        conn.executescript(SCHEMA)
        try:
            conn.executescript(FTS_SCHEMA)
            # Backfill the index for rows predating FTS creation.
            conn.execute(
                "INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"
            )
            fts = True
        except sqlite3.Error:
            fts = False
        conn.commit()
    finally:
        conn.close()
    export_snapshot(path)
    return str(path)


def _has_fts(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
    ).fetchone()
    return row is not None


def _reject_secrets(text: str) -> None:
    for rx in _SECRET_RES:
        if rx.search(text or ""):
            raise ValueError("refusing to store a likely secret/key/token")


def write_memory(kind="note", summary="", detail="", importance=0.5,
                 source="", key=None, expires_at=None, db_path=None) -> int:
    """Store one memory. Returns the row id. Refreshes the snapshot."""
    summary = (summary or "").strip()
    if not summary:
        raise ValueError("summary is required")
    _reject_secrets(summary + "\n" + (detail or ""))
    try:
        importance = max(0.0, min(1.0, float(importance)))
    except (TypeError, ValueError):
        importance = 0.5
    conn = _connect(db_path)
    try:
        cur = conn.execute(
            "INSERT INTO memories(kind, key, summary, detail, importance, source, expires_at)"
            " VALUES(?,?,?,?,?,?,?)",
            [kind or "note", key, summary, detail or "", importance,
             source or "", expires_at],
        )
        mid = cur.lastrowid
        conn.commit()
    finally:
        conn.close()
    export_snapshot(db_path)
    return mid


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


def _not_expired_clause() -> str:
    return "(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))"


def _fts_query(user_query: str) -> str:
    tokens = re.findall(r"[A-Za-z0-9_]{2,}", user_query or "")
    return " ".join(f'"{t}"' for t in tokens[:12])


def recall_memories(query, limit=5, kind=None, db_path=None) -> list:
    """Best-match recall (FTS5 when available, LIKE fallback)."""
    try:
        limit = max(1, min(50, int(limit or 5)))
    except (TypeError, ValueError):
        limit = 5
    conn = _connect(db_path)
    try:
        params: list = []
        kind_clause = ""
        if kind:
            kind_clause = "AND m.kind = ?"
            params.append(kind)
        fq = _fts_query(query or "")
        if fq and _has_fts(conn):
            try:
                rows = conn.execute(
                    "SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid"
                    f" WHERE memories_fts MATCH ? AND {_not_expired_clause()} {kind_clause}"
                    " ORDER BY rank, m.importance DESC, m.id DESC LIMIT ?",
                    [fq, *params, limit],
                ).fetchall()
                return [_row_to_dict(r) for r in rows]
            except sqlite3.Error:
                pass  # fall through to LIKE
        like = f"%{query or ''}%"
        rows = conn.execute(
            "SELECT m.* FROM memories m"
            f" WHERE {_not_expired_clause()} {kind_clause}"
            " AND (m.summary LIKE ? OR m.detail LIKE ? OR m.key LIKE ?)"
            " ORDER BY m.importance DESC, m.id DESC LIMIT ?",
            [*params, like, like, like, limit],
        ).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        conn.close()


def recent_memories(limit=5, kind=None, db_path=None) -> list:
    """Newest memories first."""
    try:
        limit = max(1, min(50, int(limit or 5)))
    except (TypeError, ValueError):
        limit = 5
    conn = _connect(db_path)
    try:
        if kind:
            rows = conn.execute(
                "SELECT * FROM memories"
                f" WHERE {_not_expired_clause()} AND kind = ?"
                " ORDER BY id DESC LIMIT ?",
                [kind, limit],
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM memories"
                f" WHERE {_not_expired_clause()}"
                " ORDER BY id DESC LIMIT ?",
                [limit],
            ).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        conn.close()


def forget_memory(memory_id, db_path=None) -> bool:
    """Delete one memory. Returns True when a row was removed."""
    conn = _connect(db_path)
    try:
        cur = conn.execute("DELETE FROM memories WHERE id = ?", [int(memory_id)])
        conn.commit()
        removed = cur.rowcount > 0
    finally:
        conn.close()
    if removed:
        export_snapshot(db_path)
    return removed


def set_context(key, value, db_path=None) -> None:
    """Upsert a rolling context key/value. Refreshes the snapshot."""
    if not key:
        raise ValueError("key is required")
    _reject_secrets(str(value or ""))
    conn = _connect(db_path)
    try:
        conn.execute(
            "INSERT INTO context_state(key, value, updated_at) VALUES(?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value,"
            " updated_at=excluded.updated_at",
            [key, str(value or ""), _utcnow()],
        )
        conn.commit()
    finally:
        conn.close()
    export_snapshot(db_path)


def get_context(key=None, db_path=None) -> dict:
    """Whole context map, or one key."""
    conn = _connect(db_path)
    try:
        if key:
            row = conn.execute(
                "SELECT key, value, updated_at FROM context_state WHERE key = ?",
                [key],
            ).fetchone()
            return dict(row) if row else {}
        rows = conn.execute(
            "SELECT key, value, updated_at FROM context_state ORDER BY key"
        ).fetchall()
        return {r["key"]: {"value": r["value"], "updated_at": r["updated_at"]} for r in rows}
    finally:
        conn.close()


def memory_stats(db_path=None) -> dict:
    """Counts for HUD/diagnostics."""
    conn = _connect(db_path)
    try:
        total = conn.execute("SELECT COUNT(*) AS n FROM memories").fetchone()["n"]
        kinds = {
            r["kind"]: r["n"]
            for r in conn.execute(
                "SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind"
            ).fetchall()
        }
        ctx = conn.execute("SELECT COUNT(*) AS n FROM context_state").fetchone()["n"]
        return {"total_memories": total, "by_kind": kinds,
                "context_keys": ctx, "fts": _has_fts(conn),
                "db": str(db_path or DEFAULT_DB_PATH)}
    finally:
        conn.close()


def snapshot_path(db_path=None) -> Path:
    base = Path(db_path) if db_path else DEFAULT_DB_PATH
    return base.parent / SNAPSHOT_FILENAME


def export_snapshot(db_path=None) -> str:
    """Write the Electron-readable JSON snapshot atomically."""
    snap = snapshot_path(db_path)
    payload = {
        "exported_at": _utcnow(),
        "stats": memory_stats(db_path),
        "context": get_context(db_path=db_path),
        "recent": recent_memories(20, db_path=db_path),
    }
    tmp = snap.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    os.replace(tmp, snap)
    return str(snap)


def format_context_for_prompt(query, recent_n=3, recall_n=5,
                              max_chars=3000, db_path=None) -> str:
    """Compact memory block for injection into the agent's prompt."""
    lines = []
    for m in recent_memories(recent_n, db_path=db_path):
        lines.append(f"- [recent · {m['kind']} · {m['created_at'][:10]}] {m['summary']}")
    if query:
        for m in recall_memories(query, limit=recall_n, db_path=db_path):
            line = f"- [recall · {m['kind']} · {m['created_at'][:10]}] {m['summary']}"
            if line not in lines:
                lines.append(line)
    if not lines:
        return ""
    out = "Persistent memory (jdwalkaz):\n" + "\n".join(lines)
    return out[:max_chars]


def _cli() -> None:
    ap = argparse.ArgumentParser(description="jdwalkaz persistent memory")
    ap.add_argument("--db", default=None, help="SQLite path (default $JDWALKAZ_MEMORY_DB)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    w = sub.add_parser("write")
    w.add_argument("summary")
    w.add_argument("--kind", default="note")
    w.add_argument("--detail", default="")
    w.add_argument("--importance", type=float, default=0.5)
    w.add_argument("--source", default="cli")
    w.add_argument("--key", default=None)
    r = sub.add_parser("recall")
    r.add_argument("query", nargs="?", default="")
    r.add_argument("--limit", type=int, default=5)
    rc = sub.add_parser("recent")
    rc.add_argument("--limit", type=int, default=5)
    s = sub.add_parser("context-set")
    s.add_argument("key")
    s.add_argument("value")
    cg = sub.add_parser("context-get")
    cg.add_argument("key", nargs="?", default=None)
    f = sub.add_parser("forget")
    f.add_argument("id", type=int)
    sub.add_parser("stats")
    sub.add_parser("snapshot")
    args = ap.parse_args()

    if args.cmd == "init":
        print(init_db(args.db))
    elif args.cmd == "write":
        print(write_memory(args.kind, args.summary, args.detail,
                           args.importance, args.source, args.key, db_path=args.db))
    elif args.cmd == "recall":
        print(json.dumps(recall_memories(args.query, args.limit, db_path=args.db), indent=1))
    elif args.cmd == "recent":
        print(json.dumps(recent_memories(args.limit, db_path=args.db), indent=1))
    elif args.cmd == "context-set":
        set_context(args.key, args.value, db_path=args.db)
        print("ok")
    elif args.cmd == "context-get":
        print(json.dumps(get_context(args.key, db_path=args.db), indent=1))
    elif args.cmd == "forget":
        print("removed" if forget_memory(args.id, db_path=args.db) else "not-found")
    elif args.cmd == "stats":
        print(json.dumps(memory_stats(args.db), indent=1))
    elif args.cmd == "snapshot":
        print(export_snapshot(args.db))


if __name__ == "__main__":
    _cli()
