# Handoff — Polymarket PTB + model-guided AI inference

**Date:** 2026-08-14  
**Repo:** `G:\WECRYP` (GitHub: `JohnDaWalka/WE-CFM-Orchestrator`)  
**Branch:** `feat/inference-truth-guard`  
**Last pushed commit:** `4410e5e6` — TokenMix empty-content fix (`enable_thinking:false`)  
**Workspace note:** primary app is **G:\WECRYP**, not only `C:\Users\gitgo\WE-CFM-Orchestrator`.

---

## User intent (do not lose this)

1. **AI must quote Polymarket’s published Price-to-Beat (PTB)** — never invent from Pyth/CEX/RTI/RTDS TWAP/title scrape.
2. **Spot for path = Pyth only** for AI prompts.
3. **Use quantitative model data** (PredictionEngine score/direction/confidence/regime/indicators) to **guide** inference (blend with Polymarket odds + PTB path — not ignore model).
4. TokenMix = DeepSeek cost/detail workhorse; dual-fire with ASI1; truth-guard mid-contract.
5. Cloudflare tunnel `wecrypto.leaksnipe.win` → `:3450` authorized earlier; leave alone unless asked.

---

## What is already PUSHED (`origin/feat/inference-truth-guard`)

| Commit | What |
|--------|------|
| `3d410d50` | PR #71 Polymarket-only overhaul (merged to main previously) |
| `2b887a77` | Mid-contract **InferenceTruthGuard** |
| `b7b815ea` | Dual-fire ASI1 + TokenMix; inference cold-start persist |
| `4410e5e6` | **TokenMix empty content**: DeepSeek spends `max_tokens` on hidden `reasoning_tokens` → `content=""` → error `Unexpected LLM API response format (tokenmix) keys=[choic…]`. Fix: default `enable_thinking:false`, diagnostics, rescue retry. |

### TokenMix root cause (fixed in tree, needs Electron restart)

- Large prompts + thinking ON + `max_tokens≈1400` → `finish_reason=length`, `reasoning_tokens=1400`, `content=""`.
- CLI short probes looked fine; live app failed ~27s.
- Verify: `node tools/test-tokenmix-class.js` → SUCCESS ~2s.
- Env: `TOKENMIX_ENABLE_THINKING=0` (default), optional `=1` + higher max tokens.

---

## What is LOCAL / UNCOMMITTED (critical — finish or commit)

```
M  public/index.html
M  src/kalshi/prediction-markets.js
M  src/llm/asi1-precontract-advisor.js
M  src/llm/five-min-claude-overlay.js
M  src/llm/grok-range-overlay.js
M  src/llm/specialized_prompt.js
?? src/llm/oracle-snapshot.js          # NEW — must be committed if index.html loads it
?? src/llm/inference-relay.js          # authored earlier, dual-fire not fully swapped
?? cloudflared/                        # ignore unless needed
?? tools/probe-tokenmix.js             # may already be on remote from 4410e5e
?? tools/test-tokenmix-class.js
```

### PTB / oracle work done in working tree (not fully finished)

**Root cause of wrong AI PTB**

1. **Immutable lock allowed `polymarket-rtds-twap30`** as trusted source. Boundary clock locked RTDS open TWAP as PTB; real event-page/candles PTB could **never replace** it.
2. **AI snapshots** often omitted `priceToBeatSource` and used RTI/CEX as spot fallback.
3. **`resolveFiveMinTarget`** (in prompts) did **not** prefer `poly5m/poly15m.priceToBeatNum` / oracle block — models invented dollar levels.
4. **`oracle-snapshot.js` existed but was never loaded** in `index.html`.

**Fixes applied (working tree)**

| File | Change |
|------|--------|
| `prediction-markets.js` | `POLY5M_PTB_LOCK_VERSION = **10**`; trusted sources = event-page, chainlink-candles, gamma priceToBeat only. **Removed** `rtds-twap30` from lock set. Boundary rollover no longer locks RTDS as PTB (provisional open TWAP is spot context only). Candle open locks as `polymarket-chainlink-candles`. |
| `oracle-snapshot.js` | Strict Pyth spot + Polymarket window PTB; reject rtds/title/provisional sources. |
| `public/index.html` | Loads `oracle-snapshot.js` **before** truth-guard / advisors. |
| `specialized_prompt.js` | `resolvePolymarketPtb`, `formatOracleStrictBlock`, ORACLE LAW in 5m/15m system+user prompts — **must quote exact Polymarket PTB**. |
| `asi1-precontract-advisor.js` | OracleSnapshot first; Pyth-only spot; strip non-canonical PTB. |
| `grok-range-overlay.js` | Pyth-only price; filter PTB; attach `polymarketOracle` block. |
| `five-min-claude-overlay.js` | Canonical PTB filter; poly5m + polymarketOracle on snapshot. |

### NOT finished (do these next)

1. **`llm_signal_assistant.js` still has OLD local `resolveFiveMinTarget`** (~line 395) that only looks at loose `priceToBeat` / `target` fields — **does not** use `resolvePolymarketPtb` from specialized_prompt.  
   - Import `resolvePolymarketPtb` / `resolveFiveMinTarget` from `./specialized_prompt` and **delete or replace** the local copy.  
   - In `analyzeSnapshot`, **sanitize snapshot** before prompts: null out non-canonical PTB; ensure `polymarketOracle` present.

2. **Model-guided inference** (user asked just before handoff) — **partial only**:
   - Range prompts already have a “QUANTITATIVE MODEL PREDICTION” section (direction/conf/score).
   - 5m prompt has model direction/confidence but thin on indicators/agreement.
   - Need a shared **`formatModelGuideBlock(snapshot)`** in `specialized_prompt.js` that always injects:
     - `modelDirection`, `score`, `confidence`, `regime`
     - top indicator labels (RSI/EMA/VWAP/momentum/book) if `snapshot.indicators` present
     - agreement with path (Pyth vs Polymarket PTB)
     - rule: *blend model with Polymarket odds + PTB path; do not ignore model; if conflict, say so in notes*
   - Enrich **asi1 / grok-range / five-min** snapshot builders to pack full pred:
     ```js
     pred = PredictionEngine.get(sym) || getPrediction?.(sym)
     // attach: score, direction/signal, confidence, regime, indicators (trimmed), agreement
     ```
   - Truth-guard already has optional `modelScore` vote; ensure advisors always pass it (partially done).

3. **`inference-relay.js`** — multi-stage TokenMix short/OB + ASI1 medium/long + synthesis **not wired** into dual-fire path yet.

4. **Commit + push** uncommitted PTB/oracle files (include `oracle-snapshot.js` or UI 404s the script).

5. **Electron full restart** required after any main/renderer LLM changes (no hot reload of main `require` of `llm_signal_assistant`).

---

## Canonical PTB policy (v10)

**May lock / may go to AI as PTB**

- `polymarket-event-page`
- `polymarket-chainlink-candles`
- `gamma-market` / `gamma-event-metadata` / `gamma-price-to-beat`

**Must NOT lock / must NOT be quoted as PTB to AI**

- `polymarket-rtds-twap30` (boundary open proxy only)
- title `$` scrape, `gamma-market-field`, provisional, Coinbase/Binance/RTI/Gecko/crypto-price microservice

**Spot for AI path:** Pyth only (`PythBrowser` / `_pythPrices` / OracleSnapshot.getPythSpot).

Lock version bump **v9 → v10** purges bad RTDS locks from localStorage on next load.

---

## How AI inference is fired today

```
Renderer:
  asi1-precontract-advisor / grok-range-overlay / five-min-claude-overlay
    → electron.invoke('llm:analyzeSnapshot', snapshot)

Main (electron/main.js):
  LLMSignalAssistant.analyzeSnapshot(snapshot)
    → specialized_prompt (5m | range 15m/60m | generic)
    → callAPI: dual-fire ASI1+TokenMix (pre-contract) or cascade
```

**Dual-fire:** ASI1 + TokenMix in parallel; winner by agreement/confidence; truth-guard can nullify mid-window.

---

## Verify checklist (next agent)

```powershell
cd G:\WECRYP
git status -sb
git branch --show-current   # expect feat/inference-truth-guard

# TokenMix
node tools/test-tokenmix-class.js

# After finishing sanitize + model block: commit
# git add public/index.html src/kalshi/prediction-markets.js src/llm/*.js
# git commit -m "fix(llm): Polymarket-only PTB for AI + oracle snapshot"
# git push

# Full restart Electron — do not rely on soft reload
```

**In UI after restart**

1. Open a coin’s 5m/15m market; compare app PTB to **polymarket.com event page** “Price to Beat”.
2. AI notes must say e.g. `PTB $XXXXX.XX` matching Polymarket, or `PTB pending` — never a random CEX level.
3. TokenMix rows: SUCCESS, not `keys=[choic…]`.
4. Console: `[Poly5M-PTB]` / `[Poly15M-PTB]` sources should be event-page/candles/gamma — not rtds after lock settles.
5. Model section in prompts / notes should reference model score or direction when PredictionEngine has data.

---

## Key files map

| Path | Role |
|------|------|
| `src/kalshi/prediction-markets.js` | Live poly5m/poly15m, PTB fetch/lock, boundary clock |
| `src/llm/oracle-snapshot.js` | Strict Pyth + Polymarket packet for AI |
| `src/llm/specialized_prompt.js` | All LLM prompt text + `resolvePolymarketPtb` |
| `src/llm/llm_signal_assistant.js` | Main analyzeSnapshot, cascade, TokenMix, dual-fire |
| `src/llm/asi1-precontract-advisor.js` | Renderer ASI1 pre-contract loop |
| `src/llm/grok-range-overlay.js` | 15m/60m range ASI1 loop |
| `src/llm/five-min-claude-overlay.js` | 5m Grok path (may be disabled via flag) |
| `src/llm/inference-truth-guard.js` | Nullify AI when raw path/book fights call |
| `src/llm/inference-state-store.js` | Persist briefs across restarts |
| `src/llm/inference-relay.js` | Planned multi-horizon relay (unwired) |
| `src/core/predictions.js` | PredictionEngine quant model |
| `electron/main.js` | `llm:analyzeSnapshot` IPC |
| `public/index.html` | Script load order |
| `secrets/tokenmix_api_key.txt` | TokenMix key (`sk-tm-…`) |
| `tools/test-tokenmix-class.js` | Integration probe |

---

## Suggested commit message (when ready)

```
fix(llm): AI quotes Polymarket PTB only; drop RTDS lock; wire OracleSnapshot

- PTB lock v10: trusted = event-page / chainlink-candles / gamma only
- Boundary clock no longer immutably locks RTDS TWAP as PTB
- OracleSnapshot + ORACLE STRICT prompt blocks; Pyth spot for AI
- (follow-up) sanitize analyzeSnapshot + formatModelGuideBlock from PredictionEngine
```

---

## PR status

- **#71** merged (Polymarket overhaul).
- **#72** / branch `feat/inference-truth-guard` — truth-guard + dual-fire + TokenMix fix pushed; **PTB oracle WIP uncommitted**.

Open PR when PTB sanitize + model guide block are done and smoke-tested with live Electron.

---

## Secrets / safety

- Never commit API keys or hardcoded Poly creds.
- Push was previously blocked by secrets in test files — use filter-repo/safe rewrite if that returns.
- Do not force-push main; branch push is fine.

---

## Immediate next 5 steps for the next session

1. ~~Replace `resolveFiveMinTarget` in `llm_signal_assistant.js`~~ DONE (`sanitizeOracleSnapshot` in analyzeSnapshot).
2. ~~Add `formatModelGuideBlock` + pack pred on advisors~~ DONE.
3. Commit `oracle-snapshot.js` + modified files; push branch.
4. Restart Electron; verify PTB matches Polymarket UI; TokenMix SUCCESS; model cited in notes.
5. Optionally wire `inference-relay.js` and merge PR.

---

*Updated after continue session: PTB sanitize + model guide implemented in tree; commit/push next.*
