'use strict';

function builderArgsFor(targets, configPath) {
  const args = ['--config', configPath, '--win'];
  if (targets.size === 1) {
    if (targets.has('portable')) args.push('portable');
    if (targets.has('installer')) args.push('nsis');
  }
  args.push('--publish', 'never');
  return args;
}

module.exports = { builderArgsFor };
