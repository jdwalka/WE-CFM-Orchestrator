const fs = require('fs');
const lines = fs.readFileSync('Kalshi-Recent-Activity-All-5-24-06.csv', 'utf8').split('\n');
const headers = lines[0].split(',').map(h => h.replace(/\"/g, '').trim());
const data = lines.slice(1).map(l => {
  const parts = l.split(',').map(p => p.replace(/\"/g, '').trim());
  return headers.reduce((acc, h, i) => { acc[h] = parts[i]; return acc; }, {});
});

let wins = 0;
let losses = 0;
let profit = 0;

console.log('--- RECENT SETTLEMENTS ---');
data.forEach(r => {
  if (r.type && r.type.toLowerCase() === 'settlement') {
    const amt = parseFloat(r.Amount_In_Dollars) || 0;
    const p = parseFloat(r.Profit_In_Dollars) || amt; // sometimes profit is in amount
    
    if (p > 0) wins++; else if (p <= 0) losses++; // Assume <=0 is a loss or neutral settlement (failed trade)
    profit += p;
    
    console.log(`Settlement: ${r.Market_Ticker?.padEnd(25)} | Profit: ${p.toFixed(2)} | Dir: ${r.Direction}`);
  }
});

console.log('\nWins:', wins, 'Losses:', losses, 'Total Profit:', profit.toFixed(2));
console.log('Win Rate:', wins+losses > 0 ? (wins / (wins+losses) * 100).toFixed(2) + '%' : '0%');
