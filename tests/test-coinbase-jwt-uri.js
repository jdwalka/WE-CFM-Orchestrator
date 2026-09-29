#!/usr/bin/env node
const assert = require('assert');
const { normalizeCoinbaseJwtUri } = require('../src/infra/coinbase-jwt-utils');

console.log('\n[Coinbase JWT URI Normalization Tests]');

function test(name, expected, actual) {
  process.stdout.write(`  ${name.padEnd(60)}`);
  assert.strictEqual(actual, expected);
  console.log('PASS');
}

try {
  test(
    'Preserves explicit Coinbase host and query params',
    'POST api.exchange.coinbase.com/api/v3/brokerage/orders?test=1',
    normalizeCoinbaseJwtUri('POST', 'https://api.exchange.coinbase.com/api/v3/brokerage/orders?test=1')
  );

  test(
    'Adds default host for v3 brokerage path and preserves query',
    'GET api.coinbase.com/api/v3/brokerage/products?foo=bar',
    normalizeCoinbaseJwtUri('GET', '/api/v3/brokerage/products?foo=bar')
  );

  test(
    'Removes localhost proxy prefix and normalizes to Coinbase host',
    'GET api.coinbase.com/api/v3/brokerage/products?foo=bar',
    normalizeCoinbaseJwtUri('GET', 'http://127.0.0.1:3011/api/v3/brokerage/products?foo=bar')
  );

  test(
    'Handles /coinbase/ local proxy prefix with query string',
    'GET api.coinbase.com/api/v3/brokerage/products?foo=bar',
    normalizeCoinbaseJwtUri('GET', '/coinbase/api/v3/brokerage/products?foo=bar')
  );

  test(
    'Preserves explicit api.coinbase.com host variant',
    'GET api.coinbase.com/api/v3/brokerage/markets?limit=10',
    normalizeCoinbaseJwtUri('GET', 'https://api.coinbase.com/api/v3/brokerage/markets?limit=10')
  );

  console.log('\nAll Coinbase JWT URI normalization tests passed.');
  process.exit(0);
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
