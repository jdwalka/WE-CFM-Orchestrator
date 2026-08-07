const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

const scripts = Array.from(indexHtml.matchAll(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g), match => match[1]);

function scriptIndex(src) {
  const idx = scripts.indexOf(src);
  if (idx === -1) {
    throw new Error(`Missing script tag for ${src}`);
  }
  return idx;
}

function assertBefore(before, after) {
  const beforeIdx = scriptIndex(before);
  const afterIdx = scriptIndex(after);
  if (beforeIdx >= afterIdx) {
    throw new Error(`${before} must load before ${after}`);
  }
}

const splitModules = [
  '../src/core/app/observability.js',
  '../src/core/app/kalshi-polling.js',
  '../src/core/app/orderbook-hud.js',
  '../src/core/app/ui-components.js',
];

for (const modulePath of splitModules) {
  assertBefore(modulePath, '../src/core/app-core.js');
  assertBefore(modulePath, '../src/core/ui/render-layer.js');
  assertBefore(modulePath, '../src/core/app-init.js');
}

const moduleExports = [
  ['src/core/app/observability.js', 'window.APP_OBSERVABILITY'],
  ['src/core/app/kalshi-polling.js', 'window.APP_KALSHI_POLLING'],
  ['src/core/app/orderbook-hud.js', 'window.APP_ORDERBOOK_HUD'],
  ['src/core/app/ui-components.js', 'window.APP_UI_COMPONENTS'],
];

for (const [modulePath, namespace] of moduleExports) {
  const source = fs.readFileSync(path.join(root, modulePath), 'utf8');
  if (!source.includes(`Object.assign(window, ${namespace});`)) {
    throw new Error(`${modulePath} must publish ${namespace} functions as legacy globals`);
  }
}

console.log('app module wiring ok');
