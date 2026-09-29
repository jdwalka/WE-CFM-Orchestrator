#!/usr/bin/env node
// ================================================================
// WE|||CRYPTO — MergeKit Recipe Generator (JavaScript / Node.js)
// Generates formal, reproducible MergeKit YAML configs for crypto foresight LLMs.
// Supports: DELLA, SCE, Nearswap, Arcee Fusion, TIES, DARE-TIES, Multi-SLERP.
// ================================================================

'use strict';

const fs = require('fs');
const path = require('path');

let yaml;
try {
  yaml = require('js-yaml');
} catch (_) {
  yaml = null;
}

const PRECONFIGURED_TEMPLATES = {
  della: {
    name: 'DELLA Crypto Foresight',
    merge_method: 'della',
    base_model: 'models/crypto-base-foresight-8b',
    dtype: 'bfloat16',
    models: [
      { model: 'models/crypto-orderbook-clob-8b', parameters: { weight: 0.45, density: 0.75, epsilon: 0.012 } },
      { model: 'models/crypto-momentum-breakout-8b', parameters: { weight: 0.35, density: 0.70, epsilon: 0.015 } },
      { model: 'models/crypto-kalshi-15m-sniper-8b', parameters: { weight: 0.55, density: 0.80, epsilon: 0.010 } },
    ],
    parameters: { density: 0.75, epsilon: 0.012, normalize: true, int8_mask: true, lambda: 1.05 },
    metadata: { target_horizons: ['5m', '15m'], underlyings: ['BTC', 'ETH', 'SOL', 'XRP'], sniper_mode: 'pre_open_lead_in' },
  },
  sce: {
    name: 'SCE Variance-Weighted Fusion',
    merge_method: 'sce',
    base_model: 'models/crypto-base-foresight-8b',
    dtype: 'bfloat16',
    models: [
      { model: 'models/crypto-tape-flow-8b', parameters: { weight: 0.40, variance_penalty: 0.15 } },
      { model: 'models/crypto-volatility-regime-8b', parameters: { weight: 0.35, variance_penalty: 0.20 } },
      { model: 'models/crypto-orderbook-clob-8b', parameters: { weight: 0.45, variance_penalty: 0.10 } },
    ],
    parameters: { variance_scale: 25.0, consensus_threshold: 0.60, erase_conflicts: true, normalize: true },
    metadata: { target_horizons: ['5m', '15m'], regime_filter: 'volatile_breakout_and_chop' },
  },
  nearswap: {
    name: 'Nearswap Specialist Interpolation',
    merge_method: 'nearswap',
    base_model: 'models/crypto-base-foresight-8b',
    dtype: 'bfloat16',
    models: [
      { model: 'models/crypto-regime-ranging-8b', parameters: { weight: 0.50 } },
      { model: 'models/crypto-regime-trending-8b', parameters: { weight: 0.50 } },
    ],
    parameters: { tau: 0.65, blend_factor: 0.50, preserve_divergence: true, normalize: true },
    metadata: { target_horizons: ['5m', '15m'], regime_affinity: ['ranging', 'trending_smooth', 'trending_volatile'] },
  },
  arcee_fusion: {
    name: 'Arcee Fusion Importance Routing',
    merge_method: 'arcee_fusion',
    base_model: 'models/crypto-base-foresight-8b',
    dtype: 'bfloat16',
    models: [
      { model: 'models/crypto-macro-sentiment-8b', parameters: { weight: 0.50, importance_metric: 'relative_entropy' } },
      { model: 'models/crypto-pin-risk-defense-8b', parameters: { weight: 0.50, importance_metric: 'relative_entropy' } },
    ],
    parameters: { iqr_multiplier: 1.2, quantile_low: 0.25, quantile_high: 0.75, min_kl_threshold: 0.005, normalize: true },
    metadata: { target_horizons: ['5m', '15m'], sniper_mode: 'strike_pin_defense' },
  },
  ties: {
    name: 'TIES Orderbook & Macro Consolidation',
    merge_method: 'ties',
    base_model: 'models/crypto-base-foresight-8b',
    dtype: 'bfloat16',
    models: [
      { model: 'models/crypto-orderbook-clob-8b', parameters: { weight: 0.50, density: 0.75 } },
      { model: 'models/crypto-macro-sentiment-8b', parameters: { weight: 0.50, density: 0.75 } },
    ],
    parameters: { top_k: 0.75, lambda: 1.00, normalize: true, sign_resolve: 'majority_consensus' },
    metadata: { target_horizons: ['5m', '15m'], consensus_mode: 'disjoint_sign_elected' },
  },
  dare_ties: {
    name: 'DARE-TIES Crypto 15M Sniper',
    merge_method: 'dare_ties',
    base_model: 'models/crypto-base-foresight-8b',
    dtype: 'bfloat16',
    models: [
      { model: 'models/crypto-kalshi-15m-sniper-8b', parameters: { weight: 0.60, density: 0.55 } },
      { model: 'models/crypto-momentum-breakout-8b', parameters: { weight: 0.40, density: 0.50 } },
    ],
    parameters: { top_k: 0.60, lambda: 1.10, drop_rate: 0.45, rescale: true, normalize: true },
    metadata: { target_horizons: ['15m'], horizon_sweet_spot: '3.0m_to_6.0m_remaining' },
  },
  multi_slerp: {
    name: 'Multi-SLERP Barycentric Hypersphere',
    merge_method: 'multi_slerp',
    base_model: 'models/crypto-base-foresight-8b',
    dtype: 'bfloat16',
    models: [
      { model: 'models/crypto-orderbook-clob-8b', parameters: { weight: 0.40 } },
      { model: 'models/crypto-tape-flow-8b', parameters: { weight: 0.35 } },
      { model: 'models/crypto-kalshi-15m-sniper-8b', parameters: { weight: 0.25 } },
    ],
    parameters: { slerp_t: [0.40, 0.35, 0.25], normalize: true, interpolation: 'geodesic_hypersphere' },
    metadata: { target_horizons: ['5m', '15m'], geometric_curvature: 'hyperspherical' },
  },
};

/**
 * Validates a MergeKit recipe object
 */
function validateRecipe(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== 'object') {
    errors.push('Recipe must be a non-null object');
    return { valid: false, errors };
  }
  if (!recipe.merge_method) errors.push('Missing required property: merge_method');
  if (!recipe.base_model) errors.push('Missing required property: base_model');
  if (!Array.isArray(recipe.models) || recipe.models.length === 0) {
    errors.push('Recipe must have a non-empty models array');
  } else {
    recipe.models.forEach((m, idx) => {
      if (!m.model) errors.push(`Model at index ${idx} is missing "model" path/identifier`);
    });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Formats recipe object into standard MergeKit YAML text
 */
function toYamlString(recipe) {
  if (yaml && typeof yaml.dump === 'function') {
    const header = `# ================================================================\n` +
      `# MergeKit Recipe: ${recipe.name || recipe.merge_method.toUpperCase() + ' Crypto Foresight'}\n` +
      `# Generated by WeCrypto MergeKit Engine (G:\\WECRYP)\n` +
      `# Application: 5-minute & 15-minute crypto prediction contracts\n` +
      `# ================================================================\n\n`;
    return header + yaml.dump(recipe, { indent: 2, lineWidth: 100 });
  }

  // Fallback YAML stringifier
  let out = `# ================================================================\n`;
  out += `# MergeKit Recipe: ${recipe.name || recipe.merge_method.toUpperCase() + ' Crypto Foresight'}\n`;
  out += `# Generated by WeCrypto MergeKit Engine (G:\\WECRYP)\n`;
  out += `# ================================================================\n\n`;
  out += `merge_method: ${recipe.merge_method}\n`;
  out += `base_model: ${recipe.base_model}\n`;
  out += `dtype: ${recipe.dtype || 'bfloat16'}\n\n`;

  if (Array.isArray(recipe.models)) {
    out += `models:\n`;
    recipe.models.forEach(m => {
      out += `  - model: ${m.model}\n`;
      if (m.parameters && Object.keys(m.parameters).length > 0) {
        out += `    parameters:\n`;
        for (const [k, v] of Object.entries(m.parameters)) {
          if (Array.isArray(v)) out += `      ${k}: [${v.join(', ')}]\n`;
          else out += `      ${k}: ${v}\n`;
        }
      }
    });
    out += `\n`;
  }

  if (recipe.parameters && Object.keys(recipe.parameters).length > 0) {
    out += `parameters:\n`;
    for (const [k, v] of Object.entries(recipe.parameters)) {
      if (Array.isArray(v)) out += `  ${k}: [${v.join(', ')}]\n`;
      else out += `  ${k}: ${v}\n`;
    }
  }

  return out;
}

/**
 * Build a recipe with custom parameters and overrides
 */
function buildRecipe(options = {}) {
  const method = options.merge_method || options.method || 'della';
  const base = PRECONFIGURED_TEMPLATES[method] ? JSON.parse(JSON.stringify(PRECONFIGURED_TEMPLATES[method])) : {
    name: `${method.toUpperCase()} Custom Recipe`,
    merge_method: method,
    base_model: options.base_model || 'models/crypto-base-foresight-8b',
    dtype: options.dtype || 'bfloat16',
    models: options.models || [],
    parameters: options.parameters || {},
  };

  if (options.base_model) base.base_model = options.base_model;
  if (options.dtype) base.dtype = options.dtype;
  if (options.models) base.models = options.models;
  if (options.parameters) base.parameters = { ...base.parameters, ...options.parameters };
  if (options.metadata) base.metadata = { ...base.metadata, ...options.metadata };
  if (options.name) base.name = options.name;

  return base;
}

/**
 * Converts runtime indicator weights map to a MergeKit representation
 */
function convertRuntimeWeightsToRecipe(weights, options = {}) {
  const method = options.merge_method || 'della';
  const coin = options.coin || 'BTC';
  const horizon = options.horizon || '15m';

  const models = [
    {
      model: `models/crypto-${coin.toLowerCase()}-orderbook-specialist-8b`,
      parameters: {
        weight: weights.book ?? 0.30,
        density: options.density ?? 0.75,
      },
    },
    {
      model: `models/crypto-${coin.toLowerCase()}-momentum-specialist-8b`,
      parameters: {
        weight: (weights.momentum ?? 0.20) + (weights.ema ?? 0.10),
        density: options.density ?? 0.70,
      },
    },
    {
      model: `models/crypto-${coin.toLowerCase()}-flow-specialist-8b`,
      parameters: {
        weight: (weights.flow ?? 0.20) + (weights.vwap ?? 0.10),
        density: options.density ?? 0.80,
      },
    },
  ];

  return buildRecipe({
    name: `${coin} ${horizon} Runtime MergeKit Spec`,
    merge_method: method,
    base_model: options.base_model || 'models/crypto-base-foresight-8b',
    models,
    parameters: {
      density: options.density ?? 0.75,
      epsilon: options.epsilon ?? 0.012,
      tau: options.tau ?? 0.65,
      normalize: true,
    },
    metadata: {
      underlyings: [coin.toUpperCase()],
      target_horizons: [horizon],
      runtime_source: 'wecrypto_orbital_weights',
      indicator_count: Object.keys(weights).length,
    },
  });
}

// CLI runner
if (require.main === module) {
  const args = process.argv.slice(2);
  const helpRequested = args.includes('--help') || args.includes('-h');
  const listRequested = args.includes('--list-templates');

  if (helpRequested) {
    console.log(`
WE|||CRYPTO MergeKit Recipe Generator
Usage:
  node recipe_generator.js [options]

Options:
  --template <name>     Template to generate (${Object.keys(PRECONFIGURED_TEMPLATES).join(', ')})
  --output <path>       Output file path (.yaml)
  --list-templates      List all available preconfigured templates
  --validate <file>     Validate an existing MergeKit YAML config file
  --help, -h            Show this help message
`);
    process.exit(0);
  }

  if (listRequested) {
    console.log('Available Preconfigured Templates:');
    for (const [key, tpl] of Object.entries(PRECONFIGURED_TEMPLATES)) {
      console.log(`  - ${key.padEnd(14)} : ${tpl.name} (${tpl.models.length} models)`);
    }
    process.exit(0);
  }

  const validateIdx = args.indexOf('--validate');
  if (validateIdx !== -1 && args[validateIdx + 1]) {
    const filePath = args[validateIdx + 1];
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = yaml ? yaml.load(content) : null;
      if (!parsed) {
        console.error('Validation failed: Unable to parse YAML');
        process.exit(1);
      }
      const val = validateRecipe(parsed);
      if (val.valid) {
        console.log(`✔ ${filePath} is a valid MergeKit configuration.`);
        process.exit(0);
      } else {
        console.error(`✖ Validation errors in ${filePath}:`, val.errors);
        process.exit(1);
      }
    } catch (e) {
      console.error(`Error reading ${filePath}:`, e.message);
      process.exit(1);
    }
  }

  const templateIdx = args.indexOf('--template');
  const templateName = templateIdx !== -1 ? args[templateIdx + 1] : 'della';
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;

  const recipe = buildRecipe({ method: templateName });
  const yamlContent = toYamlString(recipe);

  if (outputPath) {
    fs.writeFileSync(outputPath, yamlContent, 'utf8');
    console.log(`✔ Recipe saved to ${outputPath}`);
  } else {
    console.log(yamlContent);
  }
}

module.exports = {
  PRECONFIGURED_TEMPLATES,
  buildRecipe,
  validateRecipe,
  toYamlString,
  convertRuntimeWeightsToRecipe,
};
