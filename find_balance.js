const fs = require('fs');
const code = fs.readFileSync('src/kalshi/prediction-markets.js', 'utf8');

let stack = [];
let i = 0;
let line = 1;

let lineBalances = [];

while (i < code.length) {
    if (code[i] === '\n') {
        lineBalances.push({ line, balance: stack.length });
        line++;
    }

    if (code[i] === '/' && code[i+1] === '/') {
        while (i < code.length && code[i] !== '\n') { i++; }
        continue;
    }
    if (code[i] === '/' && code[i+1] === '*') {
        i += 2;
        while (i < code.length && !(code[i] === '*' && code[i+1] === '/')) {
            if (code[i] === '\n') {
                lineBalances.push({ line, balance: stack.length });
                line++;
            }
            i++;
        }
        i += 2;
        continue;
    }
    if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
        let quote = code[i];
        i++;
        while (i < code.length) {
            if (code[i] === '\\') { i += 2; continue; }
            if (code[i] === '\n') {
                lineBalances.push({ line, balance: stack.length });
                line++;
            }
            if (code[i] === quote) break;
            i++;
        }
        i++;
        continue;
    }
    if (code[i] === '{') stack.push(line);
    if (code[i] === '}') {
        if (stack.length > 0) stack.pop();
    }
    i++;
}

// Check balance at function definitions to spot the jump
let funcs = [
  "async function fetchPolymarketRtdsSnapshot",
  "async function fetchPolymarket5MBySlug",
  "function matchesPolymarketCoin",
  "function polymarketSentiment",
  "function polymarket5mSentiment"
];

funcs.forEach(f => {
  let idx = code.indexOf(f);
  if (idx !== -1) {
    let funcLine = code.substring(0, idx).split('\n').length;
    let b = lineBalances.find(x => x.line === funcLine);
    console.log(f, "at line", funcLine, "starts with balance", b ? b.balance : 'unknown');
  }
});
