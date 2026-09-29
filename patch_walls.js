const fs = require('fs');
let code = fs.readFileSync('/home/mauro/leaksnipe-mcp-agent/kodak-collector.js', 'utf8');

const wallCode = `
// ---------- WALL TRACKING ----------
const WALLS_CACHE_FILE = require('path').join('/tmp', \`kodak_walls_\${SYMBOL}.json\`);

function trackWalls(currentBooks, currentSpot) {
  let prevWalls = {};
  try {
    if (fs.existsSync(WALLS_CACHE_FILE)) {
      prevWalls = JSON.parse(fs.readFileSync(WALLS_CACHE_FILE, 'utf8'));
    }
  } catch(_) {}
  
  const now = Date.now();
  const nextWalls = {};
  let pulledWalls = [];
  
  for (const [venue, book] of Object.entries(currentBooks)) {
    if (!book || !book.ok) continue;
    
    // Group all current walls
    const currentVenueWalls = [...(book.bid_walls || []), ...(book.ask_walls || [])];
    
    nextWalls[venue] = currentVenueWalls.map(w => {
      // Find matching wall from previous (same price, roughly same size)
      const prev = (prevWalls[venue] || []).find(pw => Math.abs(pw.p - w.p) < (w.p * 0.0001));
      return {
        p: w.p,
        s: w.s,
        firstSeen: prev ? prev.firstSeen : now,
        lastSeen: now
      };
    });
    
    // Check for pulled walls
    const prevVenueWalls = prevWalls[venue] || [];
    for (const pw of prevVenueWalls) {
      // If a previous wall is no longer in current walls
      const stillExists = currentVenueWalls.some(w => Math.abs(w.p - pw.p) < (pw.p * 0.0001));
      if (!stillExists) {
        // Wall disappeared!
        // Was it pulled or executed? 
        // We consider it PULLED if the price hasn't crossed it (within a safe distance)
        // Or if it just disappeared right as price approached it.
        // Let's use a simple distance metric: if price is within 1% and it vanished without massive volume printed.
        // Actually, the instruction says: "flag WALL_PULL when a large bid level disappears within N seconds of price approaching."
        const distToSpot = Math.abs(pw.p - currentSpot) / currentSpot;
        if (distToSpot < 0.01) {
           const ageSec = (now - pw.firstSeen) / 1000;
           if (ageSec > 10) {
             pulledWalls.push({
               venue,
               price: pw.p,
               size: pw.s,
               dist_to_spot_pct: (distToSpot * 100).toFixed(2),
               flag: "WALL_PULL"
             });
           }
        }
      }
    }
  }
  
  try {
    fs.writeFileSync(WALLS_CACHE_FILE, JSON.stringify(nextWalls));
  } catch(_) {}
  
  return pulledWalls;
}
`;

code = code.replace("// ---------- DERIVATIVES ----------", wallCode + "\n// ---------- DERIVATIVES ----------");

const applyWallCode = `
  computeDerived();
  
  const cbMid = out.derived.coinbase_mid || (out.spot.coinbase && out.spot.coinbase.last) || 75000;
  out.derived.wall_pulls = trackWalls(out.books, cbMid);
  
  console.log(JSON.stringify(out, null, 2));
`;

code = code.replace("computeDerived();\n  console.log(JSON.stringify(out, null, 2));", applyWallCode);
fs.writeFileSync('/home/mauro/leaksnipe-mcp-agent/kodak-collector.js', code);
