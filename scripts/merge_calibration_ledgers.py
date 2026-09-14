#!/usr/bin/env python3
"""Safely merge a source calibration ledger into the repository ledger."""

import argparse
import sqlite3
import sys
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from calibration_ledger import ledger_path


PREDICTION_COLUMNS = (
    "prediction_key",
    "timestamp_utc",
    "band",
    "low",
    "high",
    "expiry_utc",
    "p_touch",
    "p_normal",
    "p_student_t",
    "tail_adjustment",
    "alt_aligned",
    "minutes_to_expiry",
    "model_version",
    "touched",
    "resolved_at_utc",
    "brier",
    "normal_brier",
    "outcome_bucket",
    "resolution_source",
    "outcome_window_start_utc",
    "outcome_window_end_utc",
    "outcome_candles_used",
    "tail_arrived",
    "p_base",
    "p_calibrated",
    "calibration_factor",
)


class MergeConflictError(RuntimeError):
    pass


def _readonly_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)


def _validate_connection(connection: sqlite3.Connection, label: str) -> set[str]:
    table_name = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='predictions'"
    ).fetchone()
    if table_name is None:
        raise ValueError(f"{label} does not contain a predictions table")

    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise ValueError(f"{label} failed SQLite integrity check: {integrity}")

    columns = {row[1] for row in connection.execute("PRAGMA table_info(predictions)")}
    missing_columns = set(PREDICTION_COLUMNS) - columns
    if missing_columns:
        raise ValueError(
            f"{label} is missing calibration columns: {sorted(missing_columns)}"
        )
    return columns


def _fetch_rows(connection: sqlite3.Connection) -> dict[str, tuple]:
    column_list = ", ".join(PREDICTION_COLUMNS)
    return {
        row[0]: row
        for row in connection.execute(
            f"SELECT {column_list} FROM predictions"
        )
    }


def _create_backup(target_path: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup_path = target_path.with_name(
        f"{target_path.name}.pre-merge-{timestamp}.sqlite3"
    )
    with closing(sqlite3.connect(target_path)) as source_connection:
        with sqlite3.connect(backup_path) as backup_connection:
            source_connection.backup(backup_connection)
    return backup_path


def merge_ledgers(source_path: Path, target_path: Path, execute: bool) -> dict:
    source_path = Path(source_path)
    target_path = Path(target_path)
    if not source_path.is_file():
        raise FileNotFoundError(f"source ledger does not exist: {source_path}")
    if not target_path.is_file():
        raise FileNotFoundError(f"target ledger does not exist: {target_path}")
    if source_path.resolve() == target_path.resolve():
        raise ValueError("source and target ledgers must be different files")

    with closing(_readonly_connection(source_path)) as source_connection:
        _validate_connection(source_connection, "source ledger")
        source_rows = _fetch_rows(source_connection)

    with closing(sqlite3.connect(target_path, timeout=10)) as target_connection:
        _validate_connection(target_connection, "target ledger")
        target_connection.execute("BEGIN IMMEDIATE")
        target_rows = _fetch_rows(target_connection)

        overlap = source_rows.keys() & target_rows.keys()
        duplicates = sum(
            source_rows[key] == target_rows[key] for key in overlap
        )
        conflicts = sorted(key for key in overlap if source_rows[key] != target_rows[key])
        if conflicts:
            target_connection.rollback()
            raise MergeConflictError(
                f"{len(conflicts)} conflicting prediction keys; "
                f"first conflict: {conflicts[0]}"
            )

        rows_to_insert = [
            source_rows[key] for key in source_rows.keys() - target_rows.keys()
        ]
        summary = {
            "source_path": str(source_path),
            "target_path": str(target_path),
            "source_predictions": len(source_rows),
            "target_predictions": len(target_rows),
            "duplicates": duplicates,
            "conflicts": len(conflicts),
            "inserted": len(rows_to_insert),
            "executed": execute,
            "backup_path": None,
        }

        if not execute:
            target_connection.rollback()
            return summary

        target_connection.rollback()
        backup_path = _create_backup(target_path)
        target_connection.execute("BEGIN IMMEDIATE")
        current_target_rows = _fetch_rows(target_connection)
        if current_target_rows.keys() != target_rows.keys():
            target_connection.rollback()
            raise RuntimeError("target ledger changed while preparing the backup")

        column_list = ", ".join(PREDICTION_COLUMNS)
        placeholders = ", ".join("?" for _ in PREDICTION_COLUMNS)
        target_connection.executemany(
            f"INSERT INTO predictions ({column_list}) VALUES ({placeholders})",
            rows_to_insert,
        )
        post_merge_count = target_connection.execute(
            "SELECT COUNT(*) FROM predictions"
        ).fetchone()[0]
        if post_merge_count != len(target_rows) + len(rows_to_insert):
            target_connection.rollback()
            raise RuntimeError("post-merge row count did not match the merge plan")

        integrity = target_connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            target_connection.rollback()
            raise RuntimeError(f"target ledger failed post-merge integrity check: {integrity}")

        target_connection.commit()
        summary["backup_path"] = str(backup_path)
        return summary


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="read-only source ledger, typically the live WSL copy",
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=None,
        help="repository ledger; defaults to CALIBRATION_LEDGER_PATH or the module default",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="apply the merge; without this flag the script only reports the plan",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    target = args.target or ledger_path()
    summary = merge_ledgers(args.source, target, execute=args.execute)
    mode = "MERGED" if summary["executed"] else "DRY RUN"
    print(f"{mode}: source={summary['source_predictions']} target={summary['target_predictions']}")
    print(
        f"inserted={summary['inserted']} duplicates={summary['duplicates']} "
        f"conflicts={summary['conflicts']}"
    )
    if summary["backup_path"]:
        print(f"backup={summary['backup_path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
