# SuperGrok + xAI Console — Full Stack Playbook

**Goal:** Use *both* SuperGrok (consumer) and [console.x.ai](https://console.x.ai) (developer API) for maximum edge — they do **not** share billing or rate limits.

---

## 1. Two products, two jobs

| Product | Where | What you use it for | Bills |
|---------|--------|---------------------|--------|
| **SuperGrok** | grok.com / X app | Interactive research, DeepSearch, Big Brain, voice, charting ideas, reading settlements, “explain this wall” | Monthly sub |
| **xAI Console API** | console.x.ai | **WECRYPTO automation**, 5m PTB Grok overlay, 15m regime LLM, batch backtests, Grok Build CLI | API credits ($/token) |
| **Grok Build** (this IDE) | Grok Build TUI | Code, agents, repo work on WECRYPTO / LeakSnipe / tunnels | SuperGrok / Build access |

> Your `secrets/XAI_API_KEY.txt` is already present — console path is ready. SuperGrok does **not** inject that key; keep API funded separately.

---

## 2. Console.x.ai checklist

1. Open **https://console.x.ai** → API keys → create/rotate key (`xai-…`).
2. **Fund API credits on the team** (usage meter, **not** SuperGrok invoice).  
   - Without credits you get `403 permission-denied: team doesn't have any credits`.  
   - SuperGrok monthly sub does **not** unlock `api.x.ai`.
3. Drop **one** active key in:
   - `G:\wecryp\secrets\XAI_API_KEY.txt` (preferred), **or**
   - `XAI_API_KEY=xai-...` in `.env`
   - If the file has multiple keys, the loader uses the **last** `xai-…` match.
4. Preferred models (2026-08):

| Use | Model | Notes |
|-----|--------|--------|
| Live trading LLM | **`grok-4.5`** | Flagship; agentic + low hallucination |
| High-volume / batch | **`grok-4.3`** or `XAI_MODEL_FAST` | Cheaper $/M tokens |
| Offline backtest batch | `npm run backtest:llm-batch-submit` | Uses Batch API |

5. Set env (also defaults in code):
   ```env
   LLM_PROVIDER=xai
   XAI_MODEL=grok-4.5
   XAI_MODEL_FAST=grok-4.3
   XAI_PRIMARY_ALL=true
   ```
6. Restart Electron after changing secrets / credits.

### Quick key health check

```powershell
cd G:\wecryp
node -e "const fs=require('fs');const k=fs.readFileSync('secrets/XAI_API_KEY.txt','utf8').match(/xai-[A-Za-z0-9_-]+/gi).pop();fetch('https://api.x.ai/v1/models',{headers:{Authorization:'Bearer '+k}}).then(async r=>console.log(r.status, (await r.text()).slice(0,200)))"
```

| Status | Meaning |
|--------|---------|
| `200` | Key + credits OK |
| `400` Incorrect API key | Revoke/recreate key in console |
| `403` no credits | Buy credits for the team URL in the error body |

### Env knobs (defaults now in code)

```env
XAI_MODEL=grok-4.5
XAI_MODEL_FAST=grok-4.3
XAI_PRIMARY_ALL=true          # Grok first for ALL horizons (not only 5m)
XAI_MAX_TOKENS=2000
LLM_PROVIDER=xai
```

Set `XAI_PRIMARY_ALL=false` to only force Grok on 5m PTB (old behavior).

---

## 3. What WECRYPTO already does with Grok

| Path | File | Behavior |
|------|------|----------|
| 5m PTB overlay | `src/llm/five-min-claude-overlay.js` + `llm_signal_assistant.js` | Specialized BUY UP/DOWN/WAIT for Polymarket/polycool PTB |
| Live analysis cascade | `callAPI()` | **xAI → asi1 → openai → claude → gemini → openrouter** when key present |
| Batch offline | `backtest/llm-batch-backtest.js` | `POST /v1/batches` for multi-day coin×horizon scoring |
| Diagnostics | `llm:getDiagnostics` / network health | Shows fiveMinuteProvider / model |

After this update, **15m Kalshi snapshots also prefer Grok** when `XAI_PRIMARY_ALL=true`.

---

## 4. How to use SuperGrok (human-in-the-loop) for trading edge

Do **not** paste API keys into SuperGrok chat. Do paste **redacted** market state:

### Daily ritual (15–30 min)

1. **Pre-open (or every 15m slot)** — SuperGrok DeepSearch / reasoning:
   - “BTC 15m session: Asia vs NY Open historically; what invalidates a long?”
   - Paste last 3 Kalshi outcomes + model dir (no keys).
2. **When book walls fire** (your OB logs):
   - “BTC ask wall 36 @ 63517 eaten in 5s — classify as absorption vs spoof for 15m Kalshi UP.”
3. **Post-session** — feed settlement CSV / journal snippets:
   - “Cluster losses by session + conf bucket; propose gate changes.”
4. **Tunnel / ZT / Canada node** — architecture questions stay in SuperGrok + Grok Build (this chat).

### SuperGrok modes that matter

- **DeepSearch / web**: macro, Kalshi rules, oracle/PTB nuances  
- **Big Brain / heavy reasoning**: conflict resolution when model vs market diverge  
- **Code (Grok Build)**: implement the plan in the repo (you’re already here)

---

## 5. Full exploitation map

```
┌─────────────────────────────────────────────────────────────┐
│ SUPERGROK (interactive)                                      │
│  Research · post-mortems · strategy · DeepSearch · voice    │
└──────────────────────────┬──────────────────────────────────┘
                           │ human judgment
┌──────────────────────────▼──────────────────────────────────┐
│ GROK BUILD (this agent)                                      │
│  Code · agents · backtests · tunnels · ALWAYS_TRADE toggles │
└──────────────────────────┬──────────────────────────────────┘
                           │ ship to repo
┌──────────────────────────▼──────────────────────────────────┐
│ XAI CONSOLE API → WECRYPTO                                   │
│  Live: grok-4.5 on 5m PTB + 15m regime / conflict LLM       │
│  Batch: grok-4.5/4.3 offline accuracy scoring               │
│  Fallback: asi1 → openai → claude → gemini                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│ EXECUTION                                                    │
│  Canada Tailscale node · ALWAYS_TRADE · Kalshi WS books     │
│  leaksnipe.win ZT for private surfaces                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Recommended next automations (API-backed)

| Priority | Feature | Status |
|----------|---------|--------|
| **P0** | Fund console team + valid key; boot log `xAI Grok PRIMARY (model=grok-4.5…)` | **You:** buy credits |
| **P1** | 15m Kalshi → Grok every ~60s via quant-layer (`window._grokLive`) | **Wired** |
| **P2** | Meta-label confidence ± from Grok conf (ALWAYS_TRADE still fires) | **Wired** |
| **P3** | `TRADING_POLICY` → Kalshi entry + signal gates | **Wired** |
| **P4** | `npm run backtest:llm-batch-submit -- --model grok-4.5` | Ready after credits |
| **P5** | AI Gateway `ai.leaksnipe.win` → `api.x.ai` | Optional next |

---

## 7. Verify after restart

Console should show something like:

```text
[LLMSignalAssistant] Initialized ✓ ENABLED (provider=xai, model=grok-4.5)
[LLMSignalAssistant] xAI Grok PRIMARY (model=grok-4.5, fast=grok-4.3, allHorizons=true)
```

On a 5m/15m analysis cycle:

```text
[LLM] is5mPtb=… useXai=true model=grok-4.5 path=xai→asi1→…
[LLM] trying xai (grok-4.5)
```

If you see `useXai=false`, key not loaded — check `secrets/XAI_API_KEY.txt` and restart main process (not only renderer refresh).

---

## 8. Cost control (console)

- Live loop: prefer **grok-4.5** only on “tricky” / floor 15m fires (already gated in five-min overlay).  
- Mass offline: **batch API** + `XAI_MODEL_FAST=grok-4.3`.  
- Watch console usage dashboard; set spend alerts.  
- SuperGrok subscription is fixed monthly — use it heavily for *thinking*; put *automation* on API.

---

## 9. Quick commands

```powershell
# Offline Grok batch (needs console credits)
cd G:\WECRYP
npm run backtest:llm-batch-submit -- --coins BTC,ETH,SOL,XRP --days 14 --horizons 15,60 --model grok-4.5

# Score when complete
npm run backtest:llm-batch-score -- --latest --wait
```

---

## 10. On-chain side-scan (BTC / ETH / SOL)

Grok does **not** stream raw blockchain. A compressor (`src/feeds/onchain-side-scan.js` → `window.OnChainFlow`) runs every ~12s:

| Coin | Chain inputs | Whale / CEX |
|------|--------------|-------------|
| **BTC** | mempool.space fees + vsize (via ChainRouter) | Whale Alert exchange flows + CexFlow VPIN |
| **ETH** | Alchemy gas / congestion | Whale Alert + CexFlow |
| **SOL** | Helius/RPC TPS | Whale Alert (solana) + CexFlow |

**Split-second path (mechanical):** `sizeMultiplier(coin, modelDir)` → 0.5–1.5; disagree chain lean vs model dampens confidence in floating-orchestrator.

**Grok path:** on burst or ~60s floor, compact packet is attached to 5m/15m snapshots (`onChainSideScan`). Console must have API credits.

```js
// DevTools
OnChainFlow.get('BTC')
OnChainFlow.packetForGrok('ETH')
OnChainFlow.sizeMultiplier('SOL', 'UP')
```

---

## 11. SuperGrok daily prompts (copy-paste)

Use these in **grok.com** (not the API). Redact keys / account IDs.

1. **Pre-session:** `BTC/ETH 15m Kalshi Asia open: list 3 invalidation rules for a model UP lean when book shows ask walls at round numbers.`
2. **Wall event:** `Ask wall eaten in <10s on BTC — absorption vs spoof checklist for next 15m binary; output: side, size mult 0.5–1.5, kill conditions.`
3. **Post-session:** paste win/loss table → `cluster by session + conf bucket; propose minEdge and ALWAYS_TRADE dampeners only if EV < 0 after fees.`
4. **Code plan:** switch to Grok Build (this IDE) to implement the changes.

---

*Updated 2026-08-02: env `LLM_PROVIDER=xai`, Grok meta-label, TRADING_POLICY on Kalshi entry, last-key secret loader. **Blocker:** fund console team credits.*
