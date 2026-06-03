import sys

with open('src/core/predictions.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_logic = "if (volCrash && wickRejection && timeStall) {"
new_logic = "if (volCrash || wickRejection || timeStall) {"

if old_logic in text:
    text = text.replace(old_logic, new_logic)
    
    # Also fix the comment line above it
    old_comment = '// "ALL" Rule: Exhaustion requires all 3 conditions'
    new_comment = '// "OR" Rule: Exhaustion requires ANY of the 3 conditions'
    if old_comment in text:
        text = text.replace(old_comment, new_comment)
        
    with open('src/core/predictions.js', 'w', encoding='utf-8') as f:
        f.write(text)
    print("Patched predictions.js to use OR logic for exhaustion")
else:
    print("Could not find exhaustion logic in predictions.js")
