import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const REQUIRED_ORDER = [
  "src/feeds/wallet-cache.js",
  "src/feeds/whale-alert-monitor.js",
  "src/feeds/dex-activity-monitor.js",
  "src/feeds/portfolio-intel.js",
  "src/feeds/wallet-intel-config.js",
];

test("Wallet Intel loads every monitor in dependency order", async () => {
  const html = await readFile("public/index.html", "utf8");
  const positions = REQUIRED_ORDER.map(path => ({
    path,
    position: html.indexOf(`../${path}`),
  }));

  for (const { path, position } of positions) {
    assert.notEqual(position, -1, `${path} is missing from public/index.html`);
  }
  assert.deepEqual(
    [...positions].sort((left, right) => left.position - right.position).map(row => row.path),
    REQUIRED_ORDER,
    "Wallet Intel scripts must load in dependency order"
  );
});
