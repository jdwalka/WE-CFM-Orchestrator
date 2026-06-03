const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PREDICTIONS_PATH = path.resolve(__dirname, '../src/core/predictions.js');
const SCRIPT_PATH = path.resolve(__dirname, 'walk-forward-backtest.js');
const LOGS_DIR = path.resolve(__dirname, '../backtest-logs');

const originalFile = fs.readFileSync(PREDICTIONS_PATH, 'utf8');

const POPULATION_SIZE = 10;
const GENERATIONS = 4;
const MUTATION_RATE = 0.3; 
const MUTATION_SCALE = 0.15; // Max change +/- 0.15

// Extract base DNA from original predictions.js using regex
function extractBaseDNA() {
  const compositeMatch = originalFile.match(/const COMPOSITE_WEIGHTS = \{([^}]+)\};/);
  const regimeMatch = originalFile.match(/const REGIME_WEIGHT_MULTS = \{([\s\S]+?)\n\s*\};/);
  
  const extractWeights = (str) => {
    const weights = {};
    const lines = str.split('\n');
    for (const line of lines) {
      if (line.includes(':') && !line.trim().startsWith('//')) {
        const [k, v] = line.split(':');
        const key = k.trim();
        const val = parseFloat(v.split(',')[0].trim());
        if (!isNaN(val)) weights[key] = val;
      }
    }
    return weights;
  };

  const extractRegimes = (str) => {
    const regimes = {};
    const rgx = /([a-zA-Z_]+):\s*\{([^}]+)\}/g;
    let match;
    while ((match = rgx.exec(str)) !== null) {
      regimes[match[1]] = extractWeights(match[2]);
    }
    return regimes;
  };

  return {
    composite: extractWeights(compositeMatch[1]),
    regimes: extractRegimes(regimeMatch[1])
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

function injectDNA(dna) {
  let newFile = originalFile;
  
  // Inject composite
  let compositeStr = 'const COMPOSITE_WEIGHTS = {\n';
  for (const [k, v] of Object.entries(dna.composite)) {
    compositeStr += `    ${k}: ${v.toFixed(3)},\n`;
  }
  compositeStr += '  };';
  newFile = newFile.replace(/const COMPOSITE_WEIGHTS = \{([^}]+)\};/, compositeStr);
  
  // Inject regimes
  let regimeStr = 'const REGIME_WEIGHT_MULTS = {\n';
  for (const [regime, weights] of Object.entries(dna.regimes)) {
    if (Object.keys(weights).length === 0) {
      regimeStr += `    ${regime}: {},\n`;
      continue;
    }
    let rStr = [];
    for (const [k, v] of Object.entries(weights)) {
      rStr.push(`${k}: ${v.toFixed(3)}`);
    }
    regimeStr += `    ${regime}: { ${rStr.join(', ')} },\n`;
  }
  // Add neutral regime if missing
  if (!dna.regimes.neutral) regimeStr += `    neutral: {},\n`;
  regimeStr += '  };';
  
  newFile = newFile.replace(/const REGIME_WEIGHT_MULTS = \{([^}]+)\n\s*\};/s, regimeStr);
  fs.writeFileSync(PREDICTIONS_PATH, newFile, 'utf8');
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
        process.stdout.write(`Evaluating Agent ${i+1}/${POPULATION_SIZE}... `);
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
    fs.writeFileSync(PREDICTIONS_PATH, originalFile, 'utf8');
    console.log('\nRestored original predictions.js');
  }

  console.log(`\n=== SWARM COMPLETE ===`);
  console.log(`Ultimate Evolved Agent:`);
  console.log(`Win Rate: ${bestGlobal.wr.toFixed(2)}%`);
  console.log(`Total Trades: ${bestGlobal.trades}`);
  console.log(`Fitness: ${bestGlobal.fitness.toFixed(2)}`);
  
  fs.writeFileSync(path.join(LOGS_DIR, `ga-ultimate-${Date.now()}.json`), JSON.stringify(bestGlobal, null, 2));
  
  // Automatically inject the best DNA
  console.log('Injecting ultimate evolved DNA into predictions.js...');
  injectDNA(bestGlobal.dna);
}

runSwarm().catch(console.error);
