/**
 * load-weights.js
 * Node.js module consumed by all backtest / tuner scripts.
 * Returns the three canonical weight objects from predictions-weights.json.
 *
 * Usage:
 *   const { COMPOSITE_WEIGHTS, REGIME_WEIGHT_MULTS, PER_COIN_INDICATOR_BIAS }
 *     = require('../src/core/load-weights');
 */
'use strict';

const path = require('path');
const data = require('./predictions-weights.json');

module.exports = {
    COMPOSITE_WEIGHTS: data.COMPOSITE_WEIGHTS,
    REGIME_WEIGHT_MULTS: data.REGIME_WEIGHT_MULTS,
    PER_COIN_INDICATOR_BIAS: data.PER_COIN_INDICATOR_BIAS,
    SHORT_HORIZON_FILTERS: data.SHORT_HORIZON_FILTERS,
    /** Absolute path to the JSON file — used for write-back. */
    WEIGHTS_PATH: path.join(__dirname, 'predictions-weights.json'),
};
