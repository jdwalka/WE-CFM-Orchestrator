#!/usr/bin/env node
'use strict';

/**
 * Intelligent Build Dispatcher
 * Automatically detects whether the build is running in a Cloud/Web environment
 * (e.g. Cloudflare Pages, Vercel, Netlify, Docker, Linux CI) vs. a local Electron desktop packager.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

// Check environment hints
const isCloudOrWebCI = Boolean(
  process.env.CF_PAGES ||
  process.env.VERCEL ||
  process.env.NETLIFY ||
  process.env.BUILD_TARGET === 'web' ||
  process.env.CLOUDFLARE_PAGES ||
  (process.env.CI && process.platform === 'linux' && !process.env.BUILD_ELECTRON)
);

const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

if (isCloudOrWebCI) {
  console.log('[build-dispatch] Web / Cloud CI deployment detected. Running `vite build`...');
  const res = spawnSync(npxCmd, ['vite', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
    shell: true
  });
  process.exit(res.status ?? 0);
} else {
  console.log('[build-dispatch] Local Desktop environment detected. Running Electron builder...');
  const res = spawnSync(process.execPath, [path.join(__dirname, 'build-electron-safe.js'), 'win'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env
  });
  process.exit(res.status ?? 0);
}
