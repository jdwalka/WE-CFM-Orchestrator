import sys

with open('src/core/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

start_idx = text.find("const _actualUpPct")
end_idx = text.find("DOWN` : 'NEUTRAL';", start_idx) + 18

if start_idx != -1 and end_idx != -1:
    text = text[:start_idx] + "const _modelProbStr = verdictDir === 'up' ? `${_modelUpPct}% UP` : verdictDir === 'down' ? `${_modelDownPct}% DOWN` : 'NEUTRAL';" + text[end_idx:]
    print("Cleaned up UI string in app.js")
    
with open('src/core/app.js', 'w', encoding='utf-8') as f:
    f.write(text)
