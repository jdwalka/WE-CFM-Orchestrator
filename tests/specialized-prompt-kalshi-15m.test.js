'use strict';

const assert = require('assert');
const {
  generateRangeSystemPrompt,
} = require('../src/llm/specialized_prompt.js');

const prompt = generateRangeSystemPrompt(15);

assert.match(prompt, /Kalshi 15-MINUTE/);
assert.match(prompt, /Kalshi target strike/);
assert.doesNotMatch(prompt, /Polymarket 15-MINUTE|Polymarket PTB/);

console.log('PASS 15m range prompt uses Kalshi strike semantics');
