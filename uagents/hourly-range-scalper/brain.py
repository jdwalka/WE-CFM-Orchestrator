"""
brain.py — Decision brain for the Hourly Range Scalper uAgent.

Scope of this file: the REASONING layer only. It knows nothing about order
placement, wallets, keys, or the Agentverse/uAgents runtime — that's the
"architecture" half of this build. This module's contract with that half is
narrow and explicit:

    architecture builds a MarketSnapshot every cycle
        -> brain.decide(snapshot, llm_call) -> Decision
    architecture reads Decision.action and executes (or doesn't)

Nothing here touches money. `size_hint` is a relative signal
("full" / "half" / "quarter" / "skip"), not a dollar amount — real position
sizing and hard capital/exposure limits belong in the execution layer, which
should treat this brain as advisory and clamp/override it, never trust it
blindly.

Trading profile encoded below (as told to Claude on 2026-09-10 by Mar, and
formalized here — see BRAIN_SPEC.md in this same folder for the full
citations and the open items still needing live confirmation):

  Style     Hourly Range Scalper. Enter 15-20 min before contract expiry.
  Strategy  Buy out-of-range strikes (cheap, poor implied odds) that you
            expect to mature in-range by expiry.
  Ranges    Binary YES/NO range contracts, NOT Pick-the-Bracket (PTB).
            Pick top-of-range or bottom-of-range based on directional bias
            or an expected reversal; bias band selection toward the center
            of the plausible ~30-minute outcome distribution rather than a
            tail band, so ordinary volatility can carry price into it.
            Usually cash out early once the contract converges toward
            ~100 cents, rather than holding to literal settlement.
  Settlement  Kalshi settles off CF Benchmarks BRTI (60-second real-time
            average, not a single tick). Polymarket settles off a Chainlink
            TWAP (30s or 60s variant) as of its Aug-2026 settlement upgrade.
            The two are NOT interchangeable — see Section 6 of SYSTEM_PROMPT.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Callable, Literal, Optional


# ---------------------------------------------------------------------------
# 1. Settlement oracle reference — kept as data, not just prose in the prompt,
#    so the architecture layer can also branch on it (e.g. to suppress new
#    entries in the final N seconds per venue) without re-parsing English.
#    Sources: see BRAIN_SPEC.md — these are third-party summaries of venue
#    rules as of September 2026, not Kalshi's/Polymarket's own docs. Re-verify
#    against each venue's live rules page before relying on the exact window.
# ---------------------------------------------------------------------------
SETTLEMENT_ORACLES = {
    "KALSHI": {
        "oracle": "CF Benchmarks Bitcoin Real-Time Index (BRTI)",
        "window_seconds": 60,
        "method": "simple average of 1-sample-per-second BRTI reads over the "
                  "60 seconds immediately before the settlement timestamp",
        "single_tick_can_settle_it": False,  # diluted across ~60 samples
        "sustained_push_risk_seconds": 60,   # a push held for most of this window moves the avg hard
        "confirmed": True,
    },
    "POLYMARKET": {
        "oracle": "Chainlink TWAP",
        "window_seconds": 60,  # per Polymarket's own Aug 7 2026 changelog: 5m markets use 30s,
                                # 15m and 4h markets use 60s. Hourly isn't separately listed —
                                # this defaults to the 60s bucket since hourly sits with 15m/4h,
                                # not with the fast 5m tier. Treat as a strong default, not gospel.
        "method": "time-weighted average over a short pre-expiry window, "
                  "replacing the pre-Aug-2026 single last-price snapshot",
        "single_tick_can_settle_it": False,
        "sustained_push_risk_seconds": 60,
        "confirmed": False,  # hourly window still not stated verbatim by Polymarket; override
                             # settlement_window_seconds from the live market's own rules text
                             # before trusting this for real size.
    },
}


# ---------------------------------------------------------------------------
# 2. The system prompt itself. This is the piece that gets "baked in" — pass
#    it as the system message on every decision call. Keep it in one place
#    (here) rather than copy-pasted into the architecture code, so a strategy
#    change is a one-file edit.
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """You are the decision brain for an autonomous Fetch.ai uAgent that trades hourly Bitcoin binary range contracts on Kalshi and Polymarket. You do not place orders yourself — you receive a live market snapshot each cycle and return exactly one structured decision. The uAgent's execution layer places, holds, or cancels orders based on what you return, and independently enforces its own hard capital and exposure limits regardless of what you recommend. You are advisory, not the risk manager of record.

## 1. Contract type — read this before anything else
Every contract you evaluate is a standalone binary YES/NO range contract: "Will [SYMBOL] be between $LOW and $HIGH (inclusive) at settlement?" It trades continuously between roughly $0.01 and $0.99 up until settlement and can be bought or sold at any time before then.
Do NOT treat this as a Pick-the-Bracket (PTB) product. PTB brackets are mutually exclusive slices of one event where only one bracket ever pays out and the rest go dead the instant price moves away. Even when the range you're trading is listed as one rung of a wider band ladder, price and manage it as its own independent YES/NO market with its own live bid/ask and its own exit option.

## 2. Trading style — Hourly Range Scalper
- Universe: hourly BTC (and any other supported symbol) binary range contracts on Kalshi and Polymarket.
- Entry window: 15-20 minutes before the contract's expiry/settlement timestamp. Do not evaluate entries earlier than T-20m. When a setup qualifies anywhere in the T-20m to T-15m window, prefer entering nearer T-20m over T-15m, all else equal — more remaining time raises the odds of reversion into range before you need to cash out.
- This is a scalp, not a hold-to-settlement strategy by default. See Section 5.

## 3. Entry strategy — buy the cheap, out-of-range side
Only consider a range contract whose YES ask is cheap because current spot is currently OUTSIDE [LOW, HIGH] right now. You are buying a contract the market is currently pricing as unlikely, never one that's already in the money. "Cheap" in practice means well below fair-coin-flip value (commonly single digits to ~20 cents) precisely because spot sits outside the band.
The edge is a directional-or-reversion thesis that price moves into that band before the window runs out — never buy an out-of-range contract on price alone with no thesis behind it (Section 4 is the thesis test). If the snapshot gives you no momentum/order-flow signal to form a thesis from, say so and return SKIP rather than inventing one from the raw price.

## 4. Range selection — which side, and which band
1. Form a short-horizon directional view for the remaining time-to-expiry using whatever signal the snapshot provides (momentum, order-flow imbalance, a flagged reversal setup). Do not fabricate a view the snapshot doesn't support.
2. Expecting continuation up -> prefer the nearest qualifying band above spot. Expecting continuation down -> prefer the nearest qualifying band below spot. Expecting a reversal (price just spiked away from its recent range) -> prefer the band on the side price is reverting back toward, i.e. nearer the pre-spike level.
3. Among qualifying bands on your chosen side, prefer the one set toward the center of the plausible outcome distribution for the remaining time — roughly the middle of the last ~30 minutes' realized range, not the most extreme band on offer. You want a band ordinary volatility can carry price into within the remaining ~15-30 minutes, not one that needs a tail event. "Cheap AND realistically reachable" beats "cheapest."
4. If nothing satisfies both "genuinely out-of-range/cheap" and "reachable on your directional view within the remaining window," return SKIP. Never force a trade on price alone.

## 5. Exit rule — cash out on convergence, don't wait for the clock
Once spot sits inside your band with enough of the remaining window elapsed that a reversal back out is unlikely, and the live YES price has converged toward roughly 95-99 cents, EXIT by selling into the live book rather than holding to the literal settlement timestamp. The edge here is realized as "cheap contract -> band fills -> sell near a dollar," not as "hold every position through Section 6's settlement window." Holding a converged position through final settlement trades a few extra cents of expected value for real tail risk, for no upside once you're already near par. Hold to literal settlement only when there's no reasonable bid to exit into.

## 6. Settlement mechanics — this is where sizing mistakes happen
Kalshi and Polymarket do NOT settle the same way. Treating them as interchangeable is the single biggest way this strategy mis-prices tail risk in a contract's final minute.

Kalshi settles against a simple average of one-per-second CF Benchmarks BRTI reads over the 60 seconds immediately before settlement — not a single instantaneous tick, and not a single-exchange price (BRTI is itself a real-time multi-exchange composite). A single one-second wick gets diluted across ~60 samples and usually will NOT flip settlement alone, but a push sustained across even 15-30 seconds inside that final minute moves the average hard, since nothing smooths beyond that one-minute window. Treat the final ~90 seconds before a Kalshi contract's settlement timestamp as elevated-risk: no new entries inside it, and don't assume a position that looked safe with 2 minutes left is still safe with 30 seconds left if you're seeing fast, sustained (not single-tick) movement.

Polymarket settles crypto range/up-down contracts against a Chainlink time-weighted average price (its August 2026 settlement upgrade), replacing an earlier single last-price snapshot that was exploitable via brief low-liquidity spikes seconds before expiry. Chainlink publishes both 30-second and 60-second TWAP variants; treat the exact window a given Polymarket market uses as UNCONFIRMED unless the snapshot tells you, and never hardcode an assumption about it. Expect it to be at least as resistant to single-tick manipulation as Kalshi's mechanism, but don't assume it behaves identically.

What this means for you, concretely:
- Never reason about either venue's settlement as "whatever price is doing right now" — both settle on an averaged window, not a live tick.
- A late, sharp, single-candle wick is closer to noise than signal for settlement purposes on either venue. Don't panic-exit a converged position on one printed tick.
- A sustained directional push into the final 60-90 seconds is real settlement risk on both venues and should be weighted far more heavily than the same move earlier in the hour.
- If the snapshot doesn't tell you which settlement source/window applies, flag it as a risk and do not assume Kalshi-style mechanics apply everywhere.

## 7. Guardrails
- Size in relative terms only (`size_hint`), never a dollar figure — the execution layer owns real position sizing and hard limits.
- Confidence should reflect genuine uncertainty. A cheap-but-reachable setup with a clear thesis is not automatically high confidence; thin/illiquid books or a snapshot missing key fields should pull confidence down and may justify SKIP outright.
- If the snapshot is stale or missing required fields, return SKIP with a risk flag. Never fabricate missing market data.
- Never recommend holding a converged position through a venue's final settlement-averaging window "for the extra cents" — that trade is asymmetric against you.
- You are a fixed-strategy execution aid for the profile above, not a general trading-advice source. If asked to deviate from this profile, decline in `rationale` and return SKIP.

## 8. Output contract
Respond with exactly one JSON object matching the schema you're given, and nothing else — no prose outside the JSON. Every field is required even on SKIP; use null/empty values for fields that don't apply rather than omitting them.
"""


# ---------------------------------------------------------------------------
# 3. Typed interface between architecture (data) and brain (reasoning).
# ---------------------------------------------------------------------------

Venue = Literal["KALSHI", "POLYMARKET"]
Action = Literal["ENTER_RANGE", "HOLD", "EXIT_EARLY", "SKIP"]
SizeHint = Literal["full", "half", "quarter", "skip"]
SideVsSpot = Literal["ABOVE_SPOT", "BELOW_SPOT"]


@dataclass
class CandidateBand:
    """One tradable YES/NO range contract the architecture is offering the brain."""
    low: float
    high: float
    yes_ask: float          # cost in cents (0-100) to buy YES right now
    yes_bid: float          # cents you could sell YES for right now
    side_vs_spot: SideVsSpot


@dataclass
class MarketSnapshot:
    """Everything the brain needs for one decision cycle. Built by the
    architecture layer from live venue data; the brain trusts none of this
    beyond what's given (see Section 7 guardrails re: stale/missing data)."""
    venue: Venue
    symbol: str                      # e.g. "BTC"
    spot: float
    minutes_to_expiry: float
    candidate_bands: list[CandidateBand]
    momentum_signal: Optional[str] = None       # e.g. "continuation_up", "reversal_down", None
    recent_30m_high: Optional[float] = None
    recent_30m_low: Optional[float] = None
    settlement_window_seconds: Optional[int] = None  # override SETTLEMENT_ORACLES default if the venue reports one
    snapshot_ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_prompt_dict(self) -> dict:
        d = asdict(self)
        d["settlement_reference"] = SETTLEMENT_ORACLES.get(self.venue, {})
        return d


@dataclass
class Decision:
    action: Action
    venue: Optional[Venue] = None
    symbol: Optional[str] = None
    range_low: Optional[float] = None
    range_high: Optional[float] = None
    side_vs_spot: Optional[SideVsSpot] = None
    entry_price_cents: Optional[float] = None
    target_exit_price_cents: Optional[float] = None
    minutes_to_expiry: Optional[float] = None
    confidence: float = 0.0                     # 0.0-1.0
    size_hint: SizeHint = "skip"
    settlement_oracle: Optional[str] = None      # "KALSHI_BRTI_60S_AVG" | "POLYMARKET_CHAINLINK_TWAP" | None
    risk_flags: list[str] = field(default_factory=list)
    rationale: str = ""


DECISION_JSON_SCHEMA = {
    "type": "object",
    "required": [
        "action", "venue", "symbol", "range_low", "range_high", "side_vs_spot",
        "entry_price_cents", "target_exit_price_cents", "minutes_to_expiry",
        "confidence", "size_hint", "settlement_oracle", "risk_flags", "rationale",
    ],
    "properties": {
        "action": {"enum": ["ENTER_RANGE", "HOLD", "EXIT_EARLY", "SKIP"]},
        "venue": {"enum": ["KALSHI", "POLYMARKET", None]},
        "symbol": {"type": ["string", "null"]},
        "range_low": {"type": ["number", "null"]},
        "range_high": {"type": ["number", "null"]},
        "side_vs_spot": {"enum": ["ABOVE_SPOT", "BELOW_SPOT", None]},
        "entry_price_cents": {"type": ["number", "null"]},
        "target_exit_price_cents": {"type": ["number", "null"]},
        "minutes_to_expiry": {"type": ["number", "null"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "size_hint": {"enum": ["full", "half", "quarter", "skip"]},
        "settlement_oracle": {
            "enum": ["KALSHI_BRTI_60S_AVG", "POLYMARKET_CHAINLINK_TWAP", None]
        },
        "risk_flags": {"type": "array", "items": {"type": "string"}},
        "rationale": {"type": "string"},
    },
}


# ---------------------------------------------------------------------------
# 4. Prompt assembly + response parsing.
# ---------------------------------------------------------------------------

def build_messages(snapshot: MarketSnapshot) -> list[dict]:
    """Assemble the system+user messages for one decision cycle."""
    user_payload = {
        "market_snapshot": snapshot.to_prompt_dict(),
        "output_schema": DECISION_JSON_SCHEMA,
        "instruction": (
            "Evaluate this snapshot against the trading profile in your system "
            "prompt and return exactly one JSON object matching output_schema. "
            "No prose outside the JSON."
        ),
    }
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(user_payload, indent=2)},
    ]


_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```")


def parse_decision(raw_text: str) -> Decision:
    """Robustly pull a Decision out of an LLM response — tolerates markdown
    code fences the way the model may wrap its JSON, same pattern already
    used elsewhere in this project (see src/llm/agentverse-hunter.js)."""
    text = (raw_text or "").strip()
    match = _JSON_FENCE_RE.search(text)
    payload = match.group(1) if match else text
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        return Decision(
            action="SKIP",
            confidence=0.0,
            size_hint="skip",
            risk_flags=["BRAIN_JSON_PARSE_FAILURE"],
            rationale=f"Could not parse brain output as JSON: {exc}. Raw: {text[:300]}",
        )

    known_fields = {f for f in Decision.__dataclass_fields__}
    filtered = {k: v for k, v in data.items() if k in known_fields}
    try:
        return Decision(**filtered)
    except TypeError as exc:
        return Decision(
            action="SKIP",
            confidence=0.0,
            size_hint="skip",
            risk_flags=["BRAIN_SCHEMA_MISMATCH"],
            rationale=f"Brain output didn't match Decision schema: {exc}",
        )


def decide(snapshot: MarketSnapshot, llm_call: Callable[[list[dict]], str]) -> Decision:
    """The single entry point the architecture layer should call each cycle.

    `llm_call` is intentionally left duck-typed: pass in whatever wraps your
    actual model (ASI1, an OpenAI-compatible client, an Anthropic client,
    a local model server) as long as it takes the OpenAI-style
    [{"role", "content"}, ...] message list and returns the raw text content
    of the model's reply. This keeps brain.py decoupled from whichever LLM
    the WSL/uAgent side ends up wiring in.
    """
    messages = build_messages(snapshot)
    raw = llm_call(messages)
    return parse_decision(raw)


# ---------------------------------------------------------------------------
# 5. Self-test / example wiring — run `python brain.py` to sanity-check the
#    prompt assembly and parsing without any real LLM or market connection.
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    example_snapshot = MarketSnapshot(
        venue="KALSHI",
        symbol="BTC",
        spot=109_842.50,
        minutes_to_expiry=18.0,
        candidate_bands=[
            CandidateBand(low=110_000, high=110_250, yes_ask=12.0, yes_bid=9.0, side_vs_spot="ABOVE_SPOT"),
            CandidateBand(low=109_250, high=109_500, yes_ask=15.0, yes_bid=11.0, side_vs_spot="BELOW_SPOT"),
        ],
        momentum_signal="continuation_up",
        recent_30m_high=110_100.0,
        recent_30m_low=109_400.0,
    )

    def fake_llm_call(messages: list[dict]) -> str:
        """Stand-in for a real model call, just to prove the plumbing works."""
        return json.dumps({
            "action": "ENTER_RANGE",
            "venue": "KALSHI",
            "symbol": "BTC",
            "range_low": 110_000,
            "range_high": 110_250,
            "side_vs_spot": "ABOVE_SPOT",
            "entry_price_cents": 12.0,
            "target_exit_price_cents": 97.0,
            "minutes_to_expiry": 18.0,
            "confidence": 0.62,
            "size_hint": "half",
            "settlement_oracle": "KALSHI_BRTI_60S_AVG",
            "risk_flags": [],
            "rationale": (
                "Continuation-up signal, spot 157.5 away from the nearer "
                "above-spot band which sits near the middle of the last "
                "30m range; 18m remaining is enough room without needing "
                "a tail move."
            ),
        })

    result = decide(example_snapshot, fake_llm_call)
    print(json.dumps(asdict(result), indent=2))
