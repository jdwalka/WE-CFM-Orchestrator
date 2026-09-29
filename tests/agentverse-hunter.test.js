/**
 * Tests for Agentverse Autonomous Contract Hunter & Agent Audit Engine
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AgentverseHunter = require('../src/llm/agentverse-hunter');

test('Agentverse roster has all 7 audited agents with valid agent1q addresses', () => {
  const roster = AgentverseHunter.AUDITED_AGENTVERSE_ROSTER;
  assert.equal(roster.length, 7, 'Expected 7 audited Agentverse agents');

  for (const agent of roster) {
    assert.ok(agent.id, 'Agent must have an id');
    assert.ok(agent.name, 'Agent must have a name');
    assert.ok(agent.address.startsWith('agent1q'), `Address ${agent.address} must start with agent1q`);
    assert.ok(agent.address.length >= 60, `Address ${agent.address} must be at least 60 chars`);
    assert.ok(agent.role, 'Agent must have a role');
    assert.ok(agent.capability, 'Agent must have a capability');
    assert.ok(Array.isArray(agent.tags) && agent.tags.length > 0, 'Agent must have tags');
    assert.ok(typeof agent.rating === 'number' && agent.rating > 0, 'Agent must have a positive rating');
  }

  const polyLive = roster.find((a) => a.id === 'polymarket-live');
  assert.ok(polyLive, 'Polymarket Live agent should exist');
  assert.equal(polyLive.address, 'agent1qw27dykr22mkr8nrp4l8gd8k0xs7xskv578n8l4kllmkkrca6wrxs5zna6f');

  const whale = roster.find((a) => a.id === 'whale-radar');
  assert.ok(whale, 'Crypto Whale Radar agent should exist');
  assert.equal(whale.address, 'agent1q240kxgq5u77auplgtypuwtzwe9suk9asayfuczernje4wzzthvzq59agj5');

  const vedetta = roster.find((a) => a.id === 'vedetta-divergence');
  assert.ok(vedetta, 'Vedetta agent should exist');
  assert.equal(vedetta.address, 'agent1qg6hwwk7zltxq7pamh4ufw04kjywl2ntrkgspmvhdq5yc3mkkjjmk872mxn');
});

test('buildHuntPrompt includes market snapshot and structured schema', () => {
  const prompt = AgentverseHunter.buildHuntPrompt({
    coins: ['BTC', 'ETH'],
    BTC: {
      spot: 81200,
      ptb15m: 81000,
      ptb1h: 80500,
      pinRisk: { distanceBps: 4.2 },
    },
    ETH: {
      spot: 2450,
      ptb15m: 2440,
    },
  });

  assert.ok(prompt.includes('AUTONOMOUS CONTRACT & INTEL HUNT MISSION'));
  assert.ok(prompt.includes('BTC: Spot=$81,200.00 | 15m PTB=$81,000.00 | 1h PTB=$80,500.00 | Strike Status=[PIN RISK DEFENDED: 4.2 bps]'));
  assert.ok(prompt.includes('ETH: Spot=$2,450.00 | 15m PTB=$2,440.00'));

  assert.ok(prompt.includes('Polymarket Live Data Agent'));
  assert.ok(prompt.includes('Crypto Whale Radar'));
  assert.ok(prompt.includes('Vedetta Sentiment & Divergence'));
  assert.ok(prompt.includes('"scoutedOpportunities"'));
});

test('startAutonomousScheduler initializes with 60s cue countdown and status', () => {
  const sched = AgentverseHunter.startAutonomousScheduler({ bootDelayMs: 60_000, intervalMs: 300_000 });
  assert.equal(sched.status, 'CUED');
  assert.ok(sched.cuedTargetMs > Date.now());

  const status = AgentverseHunter.getHunterStatus();
  assert.equal(status.status, 'CUED');
  assert.ok(status.cuedSecondsLeft > 50 && status.cuedSecondsLeft <= 60);
  assert.equal(status.roster.length, 7);

  AgentverseHunter.stopAutonomousScheduler();
  assert.equal(AgentverseHunter.getHunterStatus().status, 'IDLE');
});

test('getHunterStatus reflects latest hunt and audit caches', () => {
  const status = AgentverseHunter.getHunterStatus();
  assert.ok(status.hasOwnProperty('isHunting'));
  assert.ok(status.hasOwnProperty('latestHunt'));
  assert.ok(status.hasOwnProperty('lastAudit'));
});
