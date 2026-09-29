const fs = require('fs');
let code = fs.readFileSync('g:/WECRYPTO/electron/multi-drive-logger-handlers.js', 'utf8');
code = code.split('\\`').join('`');
code = code.split('\\n').join('\n');
fs.writeFileSync('g:/WECRYPTO/electron/multi-drive-logger-handlers.js', code, 'utf8');
console.log('Fixed syntax errors');
