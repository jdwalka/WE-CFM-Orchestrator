const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEIGHTS_PATH = path.join(ROOT, 'src', 'core', 'predictions-weights.json');
// GA injects into walk-forward-backtest.js because that is the script each
// evaluation actually runs.  predictions.js / regime-weights.js are updated
// by sync-weights.js only when the best DNA is committed at the end.
const INJECT_PATH = path.resolve(__dirname, 'walk-forward-backtest.js');
const SCRIPT_PATH = path.resolve(__dirname, 'walk-forward-backtest.js');
const LOGS_DIR = path.resolve(__dirname, '../backtest-logs');

// Keep a byte-for-byte snapshot for the finally-block restore
const originalInjectFile = fs.readFileSync(INJECT_PATH, 'utf8');
// Load base DNA from canonical JSON (contains COMPOSITE_WEIGHTS + REGIME_WEIGHT_MULTS)
const originalWeightsJson = fs.readFileSync(WEIGHTS_PATH, 'utf8');
const weightsData = JSON.parse(originalWeightsJson);

const POPULATION_SIZE = 10;
const GENERATIONS = 4;
const MUTATION_RATE = 0.3;
const MUTATION_SCALE = 0.15; // Max change +/- 0.15

// Build base DNA directly from the JSON — no regex surgery needed
function extractBaseDNA() {
  return {
    composite: JSON.parse(JSON.stringify(weightsData.COMPOSITE_WEIGHTS)),
    regimes: JSON.parse(JSON.stringify(weightsData.REGIME_WEIGHT_MULTS)),
  };
}

const baseDNA = extractBaseDNA();

// Create initial population
function createInitialPopulation() {
  const pop = [];
  for (let i = 0; i < POPULATION_SIZE; i++) {
    // Add baseline as the first agent, then mutate the rest
    pop.push(i === 0 ? JSON.parse(JSON.stringify(baseDNA)) : mutate(JSON.parse(JSON.stringify(baseDNA)), 1.5));
  }
  return pop;
}

function mutate(dna, intensity = 1.0) {
  const newDna = JSON.parse(JSON.stringify(dna));

  // Mutate composite
  for (const key of Object.keys(newDna.composite)) {
    if (Math.random() < MUTATION_RATE) {
      const change = (Math.random() * 2 - 1) * MUTATION_SCALE * intensity;
      newDna.composite[key] = Math.max(0.01, Math.min(0.5, newDna.composite[key] + change));
    }
  }

  // Mutate regimes
  for (const regime of Object.keys(newDna.regimes)) {
    for (const key of Object.keys(newDna.regimes[regime])) {
      if (Math.random() < MUTATION_RATE) {
        const change = (Math.random() * 2 - 1) * MUTATION_SCALE * 2 * intensity; // multipliers have larger range
        newDna.regimes[regime][key] = Math.max(0.1, Math.min(3.0, newDna.regimes[regime][key] + change));
      }
    }
  }

  return newDna;
}

function crossover(parentA, parentB) {
  const child = JSON.parse(JSON.stringify(parentA));

  // Crossover composite
  for (const key of Object.keys(child.composite)) {
    if (Math.random() < 0.5) child.composite[key] = parentB.composite[key];
  }

  // Crossover regimes
  for (const regime of Object.keys(child.regimes)) {
    for (const key of Object.keys(child.regimes[regime])) {
      if (parentB.regimes[regime] && parentB.regimes[regime][key]) {
        if (Math.random() < 0.5) child.regimes[regime][key] = parentB.regimes[regime][key];
      }
    }
  }

  // Occasionally mutate child
  return mutate(child, 0.5);
}

// Serialize a flat { key: val } object to a JS const declaration body
function serializeFlat(obj, indent) {
  const pad = ' '.repeat(indent);
  const lines = Object.entries(obj).map(([k, v]) => `${pad}  ${k}: ${v.toFixed(3)},`);
  return `{\n${lines.join('\n')}\n${pad}}`;
}

// Replace a `const VARNAME = { ... }` block in src using brace-depth counting
function patchBlock(src, varName, newBody) {
  const re = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`);
  const m = re.exec(src);
  if (!m) return src;
  const braceStart = m.index + m[0].lastIndexOf('{');
  let depth = 0, braceEnd = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
  }
  if (braceEnd === -1) return src;
  return src.slice(0, braceStart) + newBody + src.slice(braceEnd + 1);
}

function detectIndent(src, varName) {
  const re = new RegExp(`^(\\s*)(?:const|let|var)\\s+${varName}\\s*=`, 'm');
  const m = re.exec(src);
  return m ? m[1].length : 0;
}

function injectDNA(dna) {
  let src = fs.readFileSync(INJECT_PATH, 'utf8');
  const compIndent = detectIndent(src, 'COMPOSITE_WEIGHTS');
  src = patchBlock(src, 'COMPOSITE_WEIGHTS', serializeFlat(dna.composite, compIndent));
  fs.writeFileSync(INJECT_PATH, src, 'utf8');
}

async function runBacktest(dna) {
  injectDNA(dna);
  return new Promise((resolve) => {
    const proc = spawn('node', [
      SCRIPT_PATH,
      '--coins=BTC,ETH,SOL,XRP',
      '--days=3',
      '--adaptive-switching'
    ], { cwd: path.resolve(__dirname, '..') });

    let stdout = '';
    proc.stdout.on('data', d => stdout += d);

    proc.on('close', code => {
      const wrMatches = [...stdout.matchAll(/Avg OOS WR:\s*(\d+\.\d+)%/gi)];
      const volumeMatches = [...stdout.matchAll(/\|\s*\d+\.\d+%\s*\|\s*(\d+)\s*\|/g)];

      let avgOosWr = 0;
      let totalTrades = 0;

      if (wrMatches.length > 0) {
        avgOosWr = wrMatches.reduce((acc, match) => acc + parseFloat(match[1]), 0) / wrMatches.length;
      }
      if (volumeMatches.length > 0) {
        totalTrades = volumeMatches.reduce((acc, match) => acc + parseInt(match[1], 10), 0);
      }

      // Fitness function: penalize configurations that don't trade at all
      let fitness = avgOosWr;
      if (totalTrades < 10) {
        fitness = fitness * (totalTrades / 10); // Penalty for low volume
      }

      resolve({ wr: avgOosWr, trades: totalTrades, fitness });
    });
  });
}

async function runSwarm() {
  console.log(`Starting GA Agent Swarm: ${POPULATION_SIZE} agents, ${GENERATIONS} generations...`);
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

  let population = createInitialPopulation();
  let bestGlobal = { fitness: 0, wr: 0, dna: null };

  try {
    for (let gen = 1; gen <= GENERATIONS; gen++) {
      console.log(`\n=== GENERATION ${gen} ===`);
      const results = [];

      for (let i = 0; i < POPULATION_SIZE; i++) {
        process.stdout.write(`Evaluating Agent ${i + 1}/${POPULATION_SIZE}... `);
        const start = Date.now();
        const metrics = await runBacktest(population[i]);
        const duration = ((Date.now() - start) / 1000).toFixed(1);

        console.log(`WR: ${metrics.wr.toFixed(2)}% | Trades: ${metrics.trades} | Fitness: ${metrics.fitness.toFixed(2)} (${duration}s)`);

        results.push({ dna: population[i], metrics });

        if (metrics.fitness > bestGlobal.fitness) {
          bestGlobal = { ...metrics, dna: JSON.parse(JSON.stringify(population[i])) };
          console.log(`  -> New Global Best! WR: ${metrics.wr.toFixed(2)}%`);
        }
      }

      // Select top 4 performers
      results.sort((a, b) => b.metrics.fitness - a.metrics.fitness);
      const elites = results.slice(0, 4).map(r => r.dna);

      // Breed next generation
      const nextGen = [...elites]; // Carry over top 4 unmodified

      while (nextGen.length < POPULATION_SIZE) {
        const parentA = elites[Math.floor(Math.random() * elites.length)];
        const parentB = elites[Math.floor(Math.random() * elites.length)];
        nextGen.push(crossover(parentA, parentB));
      }

      population = nextGen;

      // Save generation state
      fs.writeFileSync(path.join(LOGS_DIR, `ga-gen-${gen}-${Date.now()}.json`), JSON.stringify(results, null, 2));
    }
  } finally {
    // Always restore the inject target file
    fs.writeFileSync(INJECT_PATH, originalInjectFile, 'utf8');
    console.log('\nRestored walk-forward-backtest.js');
  }

  console.log(`\n=== SWARM COMPLETE ===`);
  console.log(`Ultimate Evolved Agent:`);
  console.log(`Win Rate: ${bestGlobal.wr.toFixed(2)}%`);
  console.log(`Total Trades: ${bestGlobal.trades}`);
  console.log(`Fitness: ${bestGlobal.fitness.toFixed(2)}`);

  fs.writeFileSync(path.join(LOGS_DIR, `ga-ultimate-${Date.now()}.json`), JSON.stringify(bestGlobal, null, 2));

  // Commit best DNA to predictions-weights.json, then sync to all JS files
  console.log('Committing evolved DNA to predictions-weights.json...');
  const jsonOut = JSON.parse(originalWeightsJson);
  jsonOut.COMPOSITE_WEIGHTS = bestGlobal.dna.composite;
  jsonOut.REGIME_WEIGHT_MULTS = bestGlobal.dna.regimes;
  fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(jsonOut, null, 2), 'utf8');
  try {
    execSync(`node "${path.join(ROOT, 'scripts', 'sync-weights.js')}"`, { stdio: 'inherit', cwd: ROOT });
  } catch (e) {
    console.error('sync-weights.js failed:', e.message);
  }
}

runSwarm().catch(console.error);
