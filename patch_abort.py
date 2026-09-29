import re
with open('/mnt/g/WECRYP/prediction_engine.py', 'r') as f:
    code = f.read()

# I want to change:
#     if spot is None or not stats:
#         return {
#             "error": "Live data unavailable",
#             "spot": spot,
#             "timestamp": now.isoformat(),
#         }

target = r'''    if spot is None or not stats:
        return \{
            "error": "Live data unavailable",
            "spot": spot,
            "timestamp": now.isoformat\(\),
        \}'''

replacement = '''    if spot_data.get("error") == "STALE":
        return {
            "status": "STALE",
            "error": "STALE: timestamp gate aborted execution",
            "timestamp": now.isoformat(),
        }
    if spot is None or not stats:
        return {
            "error": "Live data unavailable",
            "spot": spot,
            "timestamp": now.isoformat(),
        }'''

code = re.sub(target, replacement, code)
with open('/mnt/g/WECRYP/prediction_engine.py', 'w') as f:
    f.write(code)
