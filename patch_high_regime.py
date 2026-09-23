import re
with open('/mnt/g/WECRYP/prediction_engine.py', 'r') as f:
    code = f.read()

# I want to patch the calculation of p_touch in predict_hourly_range
target = r'''            p_touch = _apply_tail_adjustment\(p_calibrated, band_tail_adjustment\)
            settlement_hold = _conditional_settlement_hold\(low, high, settlement_history\)
            p_settle = p_touch \* settlement_hold\["hold_given_touch"\]
            fair_value = p_touch \* 100'''

replacement = '''            p_touch = _apply_tail_adjustment(p_calibrated, band_tail_adjustment)
            
            # Interim live rule: in HIGH regime, model fair values are floors.
            if stats.get("regime", "") == "HIGH":
                p_touch = max(p_touch, 0.76)
                
            settlement_hold = _conditional_settlement_hold(low, high, settlement_history)
            p_settle = p_touch * settlement_hold["hold_given_touch"]
            fair_value = p_touch * 100'''

if "Interim live rule: in HIGH regime" not in code:
    code = re.sub(target, replacement, code)
    with open('/mnt/g/WECRYP/prediction_engine.py', 'w') as f:
        f.write(code)
