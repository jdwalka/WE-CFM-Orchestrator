import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadLiveContractOdds(mockWindow) {
  const source = await readFile("src/core/app/ui-components.js", "utf8");
  const context = { window: mockWindow, console: { warn: () => {}, error: () => {} } };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "src/core/app/ui-components.js" });
  return context.window.APP_UI_COMPONENTS.liveContractOdds;
}

function mockPredictionMarkets(contract) {
  return { getCoin: () => ({ kalshi15m: contract }) };
}

test("below-live contract odds paint NO instead of a stale model UP call", async () => {
  const liveContractOdds = await loadLiveContractOdds({
    PredictionMarkets: mockPredictionMarkets({ probability: 0.22, strikeDir: "above" }),
  });

  const odds = liveContractOdds("ETH");
  assert.equal(odds.available, true);
  assert.equal(odds.side, "NO");
  assert.equal(odds.direction, "down");
  assert.equal(odds.label, "DOWN NO");
  assert.equal(odds.oppositeLabel, "UP YES");
  assert.equal(odds.yesPct, 22);
  assert.equal(odds.noPct, 78);
  assert.equal(odds.dominantPct, 78);
});

test("missing live odds force WAIT rather than a default UP lean", async () => {
  const liveContractOdds = await loadLiveContractOdds({
    PredictionMarkets: mockPredictionMarkets(null),
  });

  const odds = liveContractOdds("ETH");
  assert.equal(odds.available, false);
  assert.equal(odds.side, null);
  assert.equal(odds.direction, "wait");
  assert.equal(odds.label, "ODDS UNAVAILABLE");
  assert.equal(odds.dominantPct, null);
});

test("YES on a below-strike contract implies DOWN and uses red logic", async () => {
  const liveContractOdds = await loadLiveContractOdds({
    PredictionMarkets: mockPredictionMarkets({ probability: 0.81, strikeDir: "below" }),
  });

  const odds = liveContractOdds("BTC");
  assert.equal(odds.side, "YES");
  assert.equal(odds.direction, "down");
  assert.equal(odds.label, "DOWN YES");
  assert.equal(odds.oppositeLabel, "UP NO");
  assert.equal(odds.yesPct, 81);
  assert.equal(odds.noPct, 19);
  assert.equal(odds.dominantPct, 81);
});
