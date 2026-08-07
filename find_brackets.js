const fs = require('fs');
const code = fs.readFileSync('src/kalshi/prediction-markets.js', 'utf8');

let stack = [];
let i = 0;
while (i < code.length) {
    if (code[i] === '/' && code[i+1] === '/') {
        while (i < code.length && code[i] !== '\n') i++;
        continue;
    }
    if (code[i] === '/' && code[i+1] === '*') {
        i += 2;
        while (i < code.length && !(code[i] === '*' && code[i+1] === '/')) i++;
        i += 2;
        continue;
    }
    if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
        let quote = code[i];
        i++;
        while (i < code.length) {
            if (code[i] === '\\') { i += 2; continue; }
            if (code[i] === quote) break;
            i++;
        }
        i++;
        continue;
    }
    if (code[i] === '{') stack.push(i);
    if (code[i] === '}') {
        if (stack.length > 0) stack.pop();
        else console.log("Extra } at", i);
    }
    i++;
}

console.log("Unmatched { count:", stack.length);
if (stack.length > 0) {
    stack.forEach(pos => {
        let lines = code.substring(0, pos).split('\n');
        console.log("Unmatched { at line", lines.length);
        console.log(code.substring(pos, pos + 50));
    });
}
