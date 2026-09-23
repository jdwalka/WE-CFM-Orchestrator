import re

with open("calibration_ledger.py", "r") as f:
    content = f.read()

# Replace requests with httpx
content = content.replace("import requests", "import httpx")
content = content.replace("requests.get(", "httpx.get(")
content = content.replace("requests.RequestException", "httpx.HTTPError")

# Add columns to _initialize
init_find = "            outcome_candles_used INTEGER\n        );"
init_replace = """            outcome_candles_used INTEGER,
            cascade_active INTEGER,
            burst_pressure REAL,
            cascade_skew REAL
        );"""
content = content.replace(init_find, init_replace)

# Add columns to _migrate
mig_find = '        "outcome_candles_used": "ALTER TABLE predictions ADD COLUMN outcome_candles_used INTEGER",\n    }'
mig_replace = """        "outcome_candles_used": "ALTER TABLE predictions ADD COLUMN outcome_candles_used INTEGER",
        "cascade_active": "ALTER TABLE predictions ADD COLUMN cascade_active INTEGER",
        "burst_pressure": "ALTER TABLE predictions ADD COLUMN burst_pressure REAL",
        "cascade_skew": "ALTER TABLE predictions ADD COLUMN cascade_skew REAL",
    }"""
content = content.replace(mig_find, mig_replace)

# Modify record_prediction signature
sig_find = """    minutes_to_expiry: int,
    p_base: float | None = None,
    p_calibrated: float | None = None,
    calibration_factor: float = 1.0,
    regime: str = "UNKNOWN",
) -> bool:"""
sig_replace = """    minutes_to_expiry: int,
    p_base: float | None = None,
    p_calibrated: float | None = None,
    calibration_factor: float = 1.0,
    regime: str = "UNKNOWN",
    cascade_active: bool = False,
    burst_pressure: float = 0.0,
    cascade_skew: float = 1.0,
) -> bool:"""
content = content.replace(sig_find, sig_replace)

# Modify record_prediction query
q_find = """                regime, minutes_to_expiry, time_to_expiry_bucket, model_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ","""
q_replace = """                regime, minutes_to_expiry, time_to_expiry_bucket, model_version,
                cascade_active, burst_pressure, cascade_skew
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ","""
content = content.replace(q_find, q_replace)

# Modify record_prediction args
args_find = """                _time_to_expiry_bucket(minutes_to_expiry),
                MODEL_VERSION,
            ),"""
args_replace = """                _time_to_expiry_bucket(minutes_to_expiry),
                MODEL_VERSION,
                int(cascade_active),
                float(burst_pressure),
                float(cascade_skew),
            ),"""
content = content.replace(args_find, args_replace)

with open("calibration_ledger.py", "w") as f:
    f.write(content)

print("Patched successfully")
