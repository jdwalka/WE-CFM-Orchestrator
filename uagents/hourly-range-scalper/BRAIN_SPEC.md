# Hourly Range Scalper — Brain Spec

This folder is the "brain" half of the uAgent: the decision layer that gets
handed a live market snapshot and returns one structured trade decision.
The "architecture" half — agent identity, Agentverse/mailbox registration,
message handlers, actual order placement on Kalshi/Polymarket — is out of
scope here and assumed to live in whatever you're building in WSL against
the [uAgents framework](https://docs.agentverse.ai/documentation/create-agents/local-agent-u-agent).

- `brain.py` — the system prompt, the `MarketSnapshot` / `Decision` data
  contracts, prompt assembly, and response parsing. Import this from your
  uAgent's message handler; call `decide(snapshot, llm_call)` once per cycle.
- This file — why the prompt says what it says, what's confirmed vs.
  assumed, and what to double-check before this trades real size.

## Your trading profile, formalized

You described the strategy in five parts. Here's how each maps into
`SYSTEM_PROMPT` in `brain.py`, plus the interpretive calls I made where your
description was shorthand — check these against what you actually meant:

| You said | Formalized as | My interpretation call |
|---|---|---|
| "Hourly Range Scalper — enters 15-20 min before expiry" | Section 2 | Entry window is T-20m to T-15m before the contract's own settlement timestamp, not the top of the hour. Prefer the earlier end (T-20m) when a setup qualifies throughout the window. |
| "Buys out-of-range strikes (poor odds/cheap) that mature at expiry" | Section 3 | "Out of range" = spot is currently outside [low, high] at entry. "Mature at expiry" I read as "I expect it in-range by the time it settles" — not literally "hold to settlement" (that's contradicted by your own next point about cashing out early), so I treated it as the *thesis*, not the *exit plan*. |
| "Top or bottom of range whichever direction or possible reversal is most likely... range set toward center to give price room all 30mins" | Section 4 | Read as two separate decisions: (1) which side of spot to target, driven by a directional-or-reversal read; (2) which specific band on that side, biased toward the middle of the recent ~30-minute range rather than a tail band, so ordinary volatility — not a 3-sigma move — can carry price in. If "center" meant something more specific (e.g. a volatility-implied midpoint from options pricing, or literally the market's own composite/mid-of-ladder price), tell me and I'll tighten this. |
| "...settles exactly within range usually cashing out early because it comes to 100% settlement before the hour is up" | Section 5 | This is the exit rule: once the band contains spot and the position has converged toward ~95-99¢, sell into the live book rather than holding to the literal settlement timestamp. I did not hardcode a numeric convergence threshold as gospel — 95-99¢ is a reasonable default, adjust it in the prompt if your real fills say otherwise. |
| "ranges are binary YES/NO, not PTB" | Section 1 | Made this the first thing the brain reads, since it's the most consequential distinction: PTB brackets are mutually exclusive and only one side ever pays, whereas each range contract here trades and exits independently on its own book — even when it's listed as one rung of a wider Kalshi band ladder. |
| "Coinbase BRTI (real-time, single wick can settle) vs Polymarket TWAP (averages...)" [message cut off before finishing] | Section 6 | See below — I corrected "Coinbase BRTI" to CF Benchmarks' BRTI (a multi-exchange composite, not a Coinbase-only feed) and refined "single wick can settle it" to what's actually documented: a 60-second average, so a genuine single tick gets diluted, but a sustained push through most of that final minute doesn't. |

## Settlement — what's confirmed vs. still open

**Kalshi (confirmed, multiple independent sources):** Kalshi settles Bitcoin
contracts — at every duration, 15-minute through yearly — against a simple
average of one-per-second reads of the CF Benchmarks Bitcoin Real-Time Index
(BRTI) over the 60 seconds immediately before the settlement timestamp. BRTI
itself is a continuous multi-exchange composite, not a single venue's tick.
Practical read: a lone wick is diluted across ~60 samples and usually won't
flip settlement by itself, but a move sustained through most of that final
minute will, because nothing smooths beyond that window.

**Polymarket — SUPERSEDED 2026-09-10, see market_data.py's module
docstring for the full writeup.** The changelog-based "hourly defaults to
60s TWAP" note above turned out to be wrong once checked against live
markets, not just docs. Verified by reading real, currently-open BTC
markets' own descriptions directly (via `gamma-api.polymarket.com`):

- `btc-updown-{5m,15m,4h}-<unix_ts>` events genuinely settle off a
  Chainlink TWAP — but live text for 5m, 15m, *and* 4h instances all cite
  the same `btc-usd-twap-60s-streams` URL, contradicting the changelog's
  claim that 5m uses a 30s lookback. **No hourly (1h) variant of this
  product exists at all.**
- The only genuinely hourly-cadence BTC product on Polymarket —
  `bitcoin-up-or-down-<date>-<hour><am|pm>-et` — settles off a single
  Binance 1-hour candle's open vs. close. Confirmed live: no TWAP, no
  averaging. This is the exact "single last-price snapshot" exploit shape
  Section 6 (above) says Polymarket moved away from — apparently only for
  the timestamp-slugged product line, not this one.
- `bitcoin-price-on-<date>` daily events are real `[low, high]` band
  ladders — the only Polymarket product structurally shaped like
  `CandidateBand` — but settle off a single Binance 1-*minute* candle
  close. Also not a TWAP, and daily cadence, not hourly.

**No Polymarket product is simultaneously hourly, banded, AND
TWAP-settled.** `market_data.build_polymarket_snapshot()` defaults to the
daily band ladder (closest structural fit) and sets
`settlement_window_seconds=0` honestly — a single close tick, materially
higher single-tick risk than Section 6 assumes for "Polymarket" generally.
It is **not** wired into `mcp_agent.py`'s live scalper cycle pending a
decision on which product line to actually trade; Kalshi is wired in and
unaffected by any of this.

**Kalshi's range-contract structure (now reasonably confirmed):** Kalshi's
Bitcoin band ladder does slice price into adjacent bands where, at
settlement, only one band ultimately resolves YES — but per Kalshi's own
market design (see sailgp.com source below), *"traders can take positions on
individual bands independently"*: each band is its own priced YES/NO
contract with its own live bid/ask that you can enter and exit before
settlement, not a single winner-take-all pool you lock capital into like a
Pick-the-Bracket product. That's the distinction Section 1 cares about, and
it holds: even though only one band resolves YES, every band you can see on
the board is independently tradable right now, which is what lets the brain's
Section 5 early-exit rule ("sell into the live book once converged") actually
work. Kalshi also separately confirms tick-by-tick trades and Level-2
order-book depth are published per Bitcoin contract. This is still
inference from third-party/industry sources, not Kalshi's raw API schema —
verify the specific ticker family (e.g. via Kalshi's market/orderbook
endpoints) shows a live, independently-quoted book for the exact band you're
about to trade before sizing up.

Sources (secondary/industry except where noted as Polymarket's own docs —
re-verify against Kalshi's and Polymarket's live rules pages before this
trades size):
- [Polymarket changelog — Chainlink TWAP resolution for crypto up/down markets (Aug 7, 2026)](https://docs.polymarket.com/changelog/predictions#aug-7-2026) — **Polymarket's own docs**
- [Polymarket — Chainlink TWAP Prices (RTDS/SDK reference)](https://docs.polymarket.com/market-data/chainlink-twap) — **Polymarket's own docs**
- [Kalshi Bitcoin Prediction Markets: How BTC Trading Works](https://sailgp.com/prediction-markets/kalshi/bitcoin)
- [How Kalshi Settles Bitcoin: The CF Benchmarks Real-Time Index, 60-Second Averaging, and Edge Cases](https://predictionmarketspicks.com/articles/how-kalshi-settles-bitcoin)
- [Kalshi Bitcoin Markets by Frequency](https://predictionmarketspicks.com/articles/kalshi-bitcoin-markets-by-frequency)
- [How Bitcoin Price Contracts Work On Kalshi — OddsShopper](https://www.oddsshopper.com/articles/prediction-markets/kalshi-bitcoin-price-markets)
- [Polymarket switches crypto settlements to TWAP pricing August 7](https://predictionnews.com/story/polymarket-upgrades-crypto-markets-with-twap-pricing-model)
- [The five second trick that drained millions from Polymarket](https://crypto.news/polymarket-five-second-exploit-manipulation-twap-fix/)
- [Chainlink TWAP Data Streams Now Settle Polymarket's 5- and 15-Minute Crypto Markets](https://genfinity.io/2026/08/12/chainlink-twap-data-streams-polymarket-crypto-markets/)

## Wiring it into your uAgent

`brain.py` has no uAgents/Agentverse imports on purpose — it's pure
reasoning, testable with `python brain.py` on its own. In your uAgent's
architecture code, the integration point is roughly:

```python
from brain import MarketSnapshot, CandidateBand, decide

@agent.on_interval(period=30.0)  # or however often your architecture polls
async def scalper_cycle(ctx: Context):
    snapshot = build_snapshot_from_live_data(...)   # your architecture's job
    decision = decide(snapshot, llm_call=your_llm_client.chat)
    if decision.action == "ENTER_RANGE" and decision.confidence >= YOUR_THRESHOLD:
        await place_order(decision)                  # your architecture's job, with its own limits
    ctx.logger.info(decision)
```

`llm_call` just needs to accept the `[{"role", "content"}, ...]` message list
`build_messages()` produces and return the model's raw text reply — swap in
ASI1, an OpenAI-compatible endpoint, or whatever the rest of this stack is
already using (this repo already has an `Asi1Client` in `src/infra/` used
the same way by `src/llm/agentverse-hunter.js`, if you want to reuse it here
too rather than adding a second LLM client).

## Before this touches real money

1. **Polymarket TWAP window — reopened 2026-09-10**: see the superseded
   note above. There's no hourly+banded+TWAP product on Polymarket at all;
   this is now a product-line decision (which of the 3 to trade), not a
   number to fill in. Still open — needs Mar's call before Polymarket goes
   live in `mcp_agent.py`'s scalper cycle.
2. ~~Confirm the exact Kalshi ticker family~~ — **reasonably confirmed
   2026-09-10**: Kalshi's band-ladder design lets you trade and exit each
   band independently even though only one resolves YES (see sources above).
   Still verify the specific ticker's orderbook endpoint shows a live,
   independently-quoted book before sizing up.
3. Sanity-check the 95-99¢ convergence/exit threshold in Section 5 against
   your own fill data — it's a reasonable default, not a backtested number.
   This one can't be resolved by research; it needs real fills from the
   execution layer once built.
4. `size_hint` is deliberately relative — decide your own real position-size
   and max-concurrent-exposure rules in the architecture layer; nothing in
   this brain should be trusted with an actual dollar figure.
