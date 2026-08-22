# Handoff: DOM-API refactor for render-layer.js innerHTML sinks

## Origin
Sourcery's `opengrep` static analysis blocked PR #94 (`dev`→`main`) with 4
findings, all "user-controlled data in `innerHTML`" in
`src/core/ui/render-layer.js`, at the two `content.innerHTML = ...`
assignments in `renderDebugLog()` (~line 1671) and the predictions-panel
render function (~line 3658). Both are pre-existing patterns already on
`dev` — not introduced by PR #94's fast-forward merge.

This document is the plan for actually fixing them, handed off rather than
implemented blind: this is live trading-dashboard rendering code with no
Electron display available in the cloud sandbox that did this audit, so a
rewrite here couldn't be visually verified before landing. Whoever picks
this up needs to run it in the real Electron app and eyeball both debug
views before merging.

## What's actually risky vs. not

I read every value interpolated into both flagged template literals plus
the six table-row builders that feed `renderDebugLog()`
(`accRows`, `zoneRows`, `velRows`, `settlementRows`, `missedRows`,
`pendingRows`, all in `renderDebugLog()`, lines ~1503-1658). Conclusion:

- **Mostly false-positive-shaped**: counts, percentages, internal enum
  strings (`'improving'`/`'declining'`/`'rising'`/`'falling'`), and symbols
  drawn from the hardcoded `COINS = ['BTC','ETH','SOL','XRP','DOGE','BNB','HYPE']`
  array (line 1501) — not externally controlled.
- **One already fixed**: `aiDesc` (LLM-generated setup description,
  predictions-panel block) is passed through `escapeHtml()` (defined at
  render-layer.js:179) before interpolation. Good as-is.
- **The one real, narrow risk**: `settlementRows`, `missedRows`, and
  `pendingRows` (renderDebugLog, ~lines 1601-1658) interpolate `e.sym`
  raw — `<td style="font-weight:700">${e.sym}</td>` etc. — and `e.sym` is
  NOT drawn from the `COINS` allowlist there. It comes from
  `mergedLog`/`allData` (line 1466-1499), built from
  `window.MarketResolver.getLog()`, `window._15mResolutionLog`,
  `window._marketSettlementLog`, and `window.getHistoricalContracts()`,
  normalized via `(e.sym || e.symbol || e.coin || '').toUpperCase()`
  (line 1489) — `.toUpperCase()` doesn't strip HTML metacharacters. If any
  upstream Polymarket/market-resolver code ever persists a malformed
  ticker/symbol string (corrupted cache entry, unexpected API shape), it
  renders unescaped here. Also two other unescaped fields worth
  double-checking: `e.orchestratorAction` and `e.missedOpportunity?.action`
  (both interpolated raw into badge spans) — these should be internal
  enum-like strings but I didn't trace their full origin.
- Two leaf values in the predictions-panel block also aren't escaped:
  `s.desc` (scalp-setup description, used as the fallback when no
  `aiDesc` exists — line ~3666 area) and `cardErr.message` (a caught JS
  `Error.message`, predictions-panel block, render error fallback). Neither
  is obviously externally reachable today, but they're cheap to close off.

## Proposed fix

1. Add a tiny safe-DOM builder, e.g.:
   ```js
   function h(tag, attrs, ...children) {
     const node = document.createElement(tag);
     if (attrs) for (const [k, v] of Object.entries(attrs)) {
       if (v == null) continue;
       if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
       else if (k === 'className') node.className = v;
       else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
       else node.setAttribute(k, v);
     }
     for (const child of children.flat(Infinity)) {
       if (child == null || child === false) continue;
       node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
     }
     return node;
   }
   ```
   `document.createTextNode`/`.textContent` are injection-safe by
   construction — the browser never parses them as markup, so this removes
   the need to hand-audit every interpolation once adopted.

2. Convert `tbl()` and `card()` (render-layer.js:1660-1670) from
   string-returning template functions to `h()`-based element builders.

3. Convert the six row builders (`accRows`, `zoneRows`, `velRows`,
   `settlementRows`, `missedRows`, `pendingRows`) from returning joined
   `<tr>...</tr>` HTML strings to returning arrays of real `<tr>` elements
   built with `h()`, with every dynamic value (especially `e.sym`,
   `e.orchestratorAction`, `e.missedOpportunity?.action`) passed as a
   `h()` child (safe) rather than string-interpolated.

4. Replace both flagged `content.innerHTML = \`...\`` assignments with
   `content.replaceChildren(...)`, built from `h()` calls for the outer
   skeleton (header bars, KPI cards, section wrappers) plus the now-DOM-node
   outputs of `tbl()`/`card()`.

5. Escape `s.desc` and `cardErr.message` (or just route them through the
   same `h()` textContent path) while at it.

## Explicitly out of scope for a first pass — flag, don't silently skip

`buildQuickDecisionPanel()`, `buildMarketDebugPanel()`, and
`predictionCard()` are called from inside the second flagged block and
still return HTML strings internally with their own interpolations. Fully
closing the sink means converting those too, or at minimum auditing their
interpolated values the same way this doc audited `renderDebugLog()`'s row
builders. I did not have room to do that in this pass — treat it as the
next chunk of the same job, not as done.

## Testing note
`node --check` will pass on any syntactically-valid version of this, but
proves nothing about correctness here — this is DOM-construction logic
that needs the real renderer. Run `make dev-compose` or the app's normal
Electron launch, open both the Settlement Debug Log and the 15-minute
prediction panel, and confirm they render identically to before (same
data, same styling, same interactivity — buttons, the accuracy-source
`<select>`, HC overlay toggle) before merging.
