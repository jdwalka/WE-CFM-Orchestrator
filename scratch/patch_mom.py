import sys

with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Replace Math.sign(mom) with a local momentum calculation
old_lvn_logic = "lvnSig = Math.sign(mom) * 0.6;"
new_lvn_logic = "const _lvnMom = closes.length > 6 ? closes[closes.length-1] - closes[closes.length-7] : (lastPrice - candles[Math.max(0, candles.length-2)].c);\n      lvnSig = Math.sign(_lvnMom) * 0.6;"

if old_lvn_logic in text:
    text = text.replace(old_lvn_logic, new_lvn_logic)
    with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
        f.write(text)
    print("Fixed LVN momentum scope issue.")
else:
    print("Could not find LVN logic.")
