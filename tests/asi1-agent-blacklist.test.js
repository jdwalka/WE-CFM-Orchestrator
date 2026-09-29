'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAgentBlacklisted, filterAllowedAgents, BLOCKED_AGENT_ADDRESSES, BLOCKED_KEYWORDS } = require('../src/shared/asi1-agent-blacklist');

test('ASI1 Agent Blacklist blocks exact address and aliases', () => {
  // 1. Exact address
  assert.equal(isAgentBlacklisted('agent1qdyxpj3m8d9ssg9l98asa40y3kh8r8mvl8twzyp7hpewscf4742dyl4fj9s'), true);

  // 2. Blacklisted keywords & authors
  assert.equal(isAgentBlacklisted('dreamnet'), true);
  assert.equal(isAgentBlacklisted('DreamNet Agent v2'), true);
  assert.equal(isAgentBlacklisted('spiderclaw'), true);
  assert.equal(isAgentBlacklisted('Spiderclaw Scanner'), true);
  assert.equal(isAgentBlacklisted('B Ducar'), true);
  assert.equal(isAgentBlacklisted('b-ducar'), true);
  assert.equal(isAgentBlacklisted('bducar'), true);

  // 3. Allowed legitimate agents
  assert.equal(isAgentBlacklisted('agent1qw27dykr22mkr8nrp4l8gd8k0xs7xskv578n8l4kllmkkrca6wrxs5zna6f'), false);
  assert.equal(isAgentBlacklisted('Polymarket Live Data Agent'), false);
});

test('filterAllowedAgents strips blacklisted entities from agent lists', () => {
  const input = [
    'agent1qw27dykr22mkr8nrp4l8gd8k0xs7xskv578n8l4kllmkkrca6wrxs5zna6f',
    'agent1qdyxpj3m8d9ssg9l98asa40y3kh8r8mvl8twzyp7hpewscf4742dyl4fj9s',
    'spiderclaw',
    'Polymarket Scout',
    { name: 'B Ducar Intel', address: 'agent1qfake' },
    { name: 'Legit Scout', address: 'agent1qlegit' }
  ];

  const filtered = filterAllowedAgents(input);
  assert.equal(filtered.length, 3);
  assert.equal(filtered[0], 'agent1qw27dykr22mkr8nrp4l8gd8k0xs7xskv578n8l4kllmkkrca6wrxs5zna6f');
  assert.equal(filtered[1], 'Polymarket Scout');
  assert.deepEqual(filtered[2], { name: 'Legit Scout', address: 'agent1qlegit' });
});
