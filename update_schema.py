import sqlite3
from pathlib import Path

DB_PATH = Path("/mnt/g/WECRYP/tmp/calibration/ledger.sqlite3")
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
def update():
    with sqlite3.connect(DB_PATH) as conn:
        try:
            conn.execute("ALTER TABLE predictions ADD COLUMN p_settle REAL")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE predictions ADD COLUMN settlement_hold_given_touch REAL")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE predictions ADD COLUMN held INTEGER")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE predictions ADD COLUMN insufficient_samples INTEGER")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE predictions ADD COLUMN final_60s_brti TEXT")
        except sqlite3.OperationalError:
            pass
update()
print("Schema updated!")
