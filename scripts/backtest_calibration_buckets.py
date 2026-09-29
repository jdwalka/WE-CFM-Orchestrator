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

RESOLVED_COUNT_CHECKPOINTS = (3000, 3500)


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
    parser = argparse.ArgumentParser(
        description=(
            "Replay resolved outcomes with the current global correction and "
            "the expiry/regime bucket fallback hierarchy."
        )
    )
    parser.add_argument("--ledger", type=Path, default=ledger_path())
    parser.add_argument(
        "--global-factor",
        type=float,
        default=None,
        help=(
            "Prior correction factor. Omit to read the live rolling global "
            "factor from the calibration report."
        ),
    )
    parser.add_argument("--rolling-window", type=int, default=200)
    parser.add_argument(
        "--checkpoint",
        action="store_true",
        help="Only run when a configured resolved-count checkpoint is reached.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Also write the replay JSON to this path.",
    )
    args = parser.parse_args()
    global_factor = args.global_factor
    if global_factor is None:
        import calibration_ledger

        with calibration_ledger._connect() as connection:
            calibration_ledger._initialize(connection)
            global_factor = float(
                calibration_ledger._probability_correction(connection).get(
                    "correction_factor", 1.0
                )
                or 1.0
            )

    connection = sqlite3.connect(args.ledger)
    try:
        resolved_count = connection.execute(
            """
            SELECT COUNT(*)
            FROM predictions
            WHERE resolved_at_utc IS NOT NULL
            """
        ).fetchone()[0]
    finally:
        connection.close()

    checkpoint_reached = next(
        (
            checkpoint
            for checkpoint in RESOLVED_COUNT_CHECKPOINTS
            if resolved_count >= checkpoint
        ),
        None,
    )
    if args.checkpoint and checkpoint_reached is None:
        print(
            json.dumps(
                {
                    "status": "checkpoint_not_reached",
                    "resolved": resolved_count,
                    "checkpoints": list(RESOLVED_COUNT_CHECKPOINTS),
                },
                indent=2,
            )
        )
        return 0

    result = replay(args.ledger, global_factor, args.rolling_window)
    result["resolved_count"] = resolved_count
    result["checkpoint"] = checkpoint_reached
    print(json.dumps(result, indent=2))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(result, indent=2) + "\n",
            encoding="utf-8",
        )
    return 0 if result["activation"]["enabled"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
