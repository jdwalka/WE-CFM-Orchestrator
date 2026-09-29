const fs = require('fs');
const acorn = require('acorn');

const code = fs.readFileSync('g:/WECRYP/src/kalshi/prediction-markets.js', 'utf8');

try {
  acorn.parse(code, { ecmaVersion: 2022 });
  console.log("Syntax OK!");
} catch (err) {
  console.log("Syntax error at:", err.loc.line, err.loc.column);
  console.log("Error message:", err.message);
}
