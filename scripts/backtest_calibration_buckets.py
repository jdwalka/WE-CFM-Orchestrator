#!/usr/bin/env python3
"""Replay the resolved Truffle ledger with global and expiry-bucket corrections."""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from calibration_buckets import replay_resolved_outcomes
from calibration_ledger import ledger_path


def replay(
    database_path: Path,
    global_factor: float,
    rolling_window: int = 200,
) -> dict:
    connection = sqlite3.connect(database_path)
    try:
        rows = connection.execute(
            """
            SELECT p_base, touched, minutes_to_expiry, regime
            FROM predictions
            WHERE resolved_at_utc IS NOT NULL
              AND p_base IS NOT NULL
              AND touched IS NOT NULL
              AND minutes_to_expiry IS NOT NULL
            ORDER BY resolved_at_utc, id
            """
        ).fetchall()
    finally:
        connection.close()
    return replay_resolved_outcomes(rows, global_factor, rolling_window)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger", type=Path, default=ledger_path())
    parser.add_argument("--global-factor", type=float, required=True)
    parser.add_argument("--rolling-window", type=int, default=200)
    args = parser.parse_args()
    result = replay(args.ledger, args.global_factor, args.rolling_window)
    print(json.dumps(result, indent=2))
    return 0 if result["activation"]["enabled"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
