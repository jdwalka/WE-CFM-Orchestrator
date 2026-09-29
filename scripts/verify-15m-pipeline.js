#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function read(relPath) {
  const abs = path.resolve(process.cwd(), relPath);
  return fs.readFileSync(abs, 'utf8');
}

function check(content, regex, label, failures) {
  if (!regex.test(content)) failures.push(label);
}

function main() {
  const failures = [];
  const orchestrator = read('src/ui/floating-orchestrator.js');
  const predictions = read('src/core/predictions.js');
  const app = read('src/core/app.js');

  check(orchestrator, /stageDiagnostics/, 'orchestrator missing stage diagnostics', failures);
  check(orchestrator, /EXCEPTIONAL_RECOVERY_TIMING_SCORE/, 'orchestrator missing tuned recovery guard', failures);
  check(orchestrator, /timingBlocks:\s*filteredTimingBlocks/, 'orchestrator missing filtered timing blocks', failures);
  check(predictions, /signalGate:\s*\{/, 'predictions missing signalGate diagnostics', failures);
  check(app, /Stage fails/, 'app debug panel missing stage-fail summary', failures);
  check(app, /Gate trace:/, 'app prediction cards missing gate trace row', failures);

  if (failures.length) {
    console.error('15m pipeline verification failed:');
    failures.forEach((item) => console.error(` - ${item}`));
    process.exitCode = 1;
    return;
  }

  console.log('15m pipeline verification passed.');
  console.log('- Stage diagnostics detected in orchestrator');
  console.log('- Signal gate diagnostics detected in prediction output');
  console.log('- Live suppression summary detected in debug UI');
}

main();
