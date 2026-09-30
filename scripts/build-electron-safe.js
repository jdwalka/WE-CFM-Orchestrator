#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { builderArgsFor } = require('./electron-builder-args');

const rootDir = path.resolve(__dirname, '..');
const packagePath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const mode = (rawArgs.find(arg => !arg.startsWith('--')) || 'win').toLowerCase();

function timestampLabel(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function sanitizeLabel(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function fail(message, details = []) {
  console.error(`[build-electron-safe] ${message}`);
  for (const detail of details) console.error(`  - ${detail}`);
  process.exit(1);
}

function assertNoSiblingDistDirs() {
  const offenders = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => /^dist[-_]/i.test(name));

  if (offenders.length) {
    fail('Only the top-level dist/ build directory is allowed. Remove sibling output folders before building.', offenders);
  }
}

function targetPlan(buildLabel) {
  const productName = pkg.build?.productName || pkg.productName || pkg.name || 'app';
  const targets = new Set();

  if (mode === 'portable') {
    targets.add('portable');
  } else if (mode === 'nsis' || mode === 'installer') {
    targets.add('installer');
  } else if (mode === 'win' || mode === 'windows' || mode === 'all') {
    targets.add('portable');
    targets.add('installer');
  } else {
    fail(`Unknown build mode "${mode}". Use win, portable, or nsis.`);
  }

  const artifacts = [];
  if (targets.has('portable')) {
    artifacts.push(`${productName}-portable-${buildLabel}-x64.exe`);
  }
  if (targets.has('installer')) {
    artifacts.push(`${productName}-installer-${buildLabel}-x64.exe`);
  }

  return { targets, artifacts };
}

function assertNoArtifactOverwrite(artifacts) {
  const distDir = path.join(rootDir, 'dist');
  for (const artifact of artifacts) {
    const artifactPath = path.join(distDir, artifact);
    if (fs.existsSync(artifactPath)) {
      fail('Refusing to overwrite an existing .exe artifact.', [artifactPath]);
    }
  }
}

function assertExtraResourcesExist() {
  const resources = pkg.build?.extraResources || [];
  const missing = [];

  for (const resource of resources) {
    if (!resource || typeof resource !== 'object' || !resource.from) continue;
    const sourcePath = path.resolve(rootDir, resource.from);
    if (!fs.existsSync(sourcePath)) {
      // Check potential fallback locations for proxy binary
      const fileName = path.basename(resource.from);
      const fallbacks = [
        path.join(rootDir, 'proxy', 'target', 'release', fileName),
        path.join(rootDir, 'proxy', 'target', 'debug', fileName),
        path.join(rootDir, 'proxy', 'target', 'release', 'we_crypto_proxy.exe'),
        path.join(rootDir, 'proxy', 'target', 'x86_64-pc-windows-gnu', 'release', 'we_crypto_proxy.exe'),
      ];

      let found = false;
      for (const fallbackPath of fallbacks) {
        if (fs.existsSync(fallbackPath)) {
          fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
          fs.copyFileSync(fallbackPath, sourcePath);
          console.log(`[build-electron-safe] Auto-restored missing extra resource from fallback: ${fallbackPath} -> ${sourcePath}`);
          found = true;
          break;
        }
      }

      if (!found) {
        // Try building proxy if cargo is present
        try {
          const cargoRes = spawnSync('cargo', ['build', '--release', '--manifest-path', path.join(rootDir, 'proxy', 'Cargo.toml')], { stdio: 'ignore' });
          for (const fallbackPath of fallbacks) {
            if (fs.existsSync(fallbackPath)) {
              fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
              fs.copyFileSync(fallbackPath, sourcePath);
              console.log(`[build-electron-safe] Compiled and restored extra resource via Cargo: ${sourcePath}`);
              found = true;
              break;
            }
          }
        } catch (_) {}
      }

      if (!found) {
        const allowMissing = process.env.WECRYPTO_ALLOW_MISSING_EXTRA_RESOURCES === '1' || process.env.ALLOW_MISSING_EXTRA_RESOURCES === '1' || process.env.CI === 'true';
        if (allowMissing) {
          console.warn(`[build-electron-safe] Warning: Creating placeholder for missing extraResource: ${sourcePath}`);
          fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
          fs.writeFileSync(sourcePath, '');
        } else {
          missing.push(sourcePath);
        }
      }
    }
  }

  if (missing.length) {
    fail('Refusing to package without required extraResources (set WECRYPTO_ALLOW_MISSING_EXTRA_RESOURCES=1 to override).', missing);
  }
}

function createConfig(buildLabel, targets) {
  const buildConfig = JSON.parse(JSON.stringify(pkg.build || {}));
  buildConfig.directories = {
    ...(buildConfig.directories || {}),
    output: 'dist',
  };

  if (targets.has('portable')) {
    buildConfig.portable = {
      ...(buildConfig.portable || {}),
      artifactName: `\${productName}-portable-${buildLabel}-\${arch}.\${ext}`,
    };
  }

  if (targets.has('installer')) {
    buildConfig.nsis = {
      ...(buildConfig.nsis || {}),
      artifactName: `\${productName}-installer-${buildLabel}-\${arch}.\${ext}`,
    };
  }

  return buildConfig;
}

assertNoSiblingDistDirs();
assertExtraResourcesExist();

const buildLabel = sanitizeLabel(process.env.WECRYPTO_BUILD_LABEL) || `build-${timestampLabel()}`;
const { targets, artifacts } = targetPlan(buildLabel);
assertNoArtifactOverwrite(artifacts);

console.log(`[build-electron-safe] Build label: ${buildLabel}`);
console.log('[build-electron-safe] Planned artifacts:');
for (const artifact of artifacts) console.log(`  dist/${artifact}`);

if (dryRun) process.exit(0);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecrypto-electron-builder-'));
const configPath = path.join(tmpDir, 'electron-builder.json');
fs.writeFileSync(configPath, JSON.stringify(createConfig(buildLabel, targets), null, 2));

const builderCli = path.join(rootDir, 'node_modules', 'electron-builder', 'cli.js');

const result = spawnSync(process.execPath, [builderCli, ...builderArgsFor(targets, configPath)], {
  cwd: rootDir,
  env: {
    ...process.env,
    WECRYPTO_BUILD_LABEL: buildLabel,
  },
  stdio: 'inherit',
});

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (_) {
  // Temporary builder config cleanup failure should not hide the build result.
}

process.exit(result.status ?? 1);
