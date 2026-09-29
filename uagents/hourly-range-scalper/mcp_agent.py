"""
mcp_agent.py — uAgent wrapper for the Hourly Range Scalper.

This is the "architecture" half described in BRAIN_SPEC.md: Agentverse
identity + mailbox registration, Chat Protocol handlers, a REST status
endpoint for the HUD, and the ASI:One llm_call wired into brain.decide().
It also owns the money-adjacent decisions brain.py explicitly refuses to
make — see MAX_CONCURRENT_POSITIONS / MAX_POSITION_USD below. brain.py's
size_hint is advisory only and must never be read as a dollar figure.

Live data comes from the deployed scalper-market-data Cloudflare Worker
(cloudflare-worker/scalper-market-data.js in this same folder), not from
calling market_data.py's Kalshi/Coinbase clients directly — the Worker is
the single source of truth for both this agent and any other client (an
ASI1/Agentverse chat agent, the HUD) that needs live spot/contract data,
so a bug fix (e.g. the Coinbase User-Agent header issue found this
session) only has to happen in one place. market_data.py stays as the
tested Python reference implementation the Worker mirrors.

Still deliberately NOT in scope here (see HANDOFF.md):
  - prediction_engine.py (real momentum/order-flow signal — the Worker's
    momentum heuristic is a placeholder)
  - mcp_client.py
  - real order placement
  - Polymarket wired into the live scalper cycle — market_data.py documents
    a real structural gap (no Polymarket product is simultaneously
    hourly-cadence, banded, AND TWAP-settled) that needs a decision first.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict
from typing import Optional

import requests
from dotenv import load_dotenv

from uagents import Agent, Context, Model
from uagents.protocol import Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

from brain import CandidateBand, MarketSnapshot, decide

load_dotenv()

# ---------------------------------------------------------------------------
# Config — all overridable via .env (see .env.example in this folder)
# ---------------------------------------------------------------------------
AGENT_NAME = os.environ.get("AGENT_NAME", "hourly-range-scalper")
AGENT_SEED = os.environ.get("AGENT_SEED_PHRASE")
AGENT_PORT = int(os.environ.get("AGENT_PORT", "8001"))
SCALPER_INTERVAL_SECONDS = float(os.environ.get("SCALPER_INTERVAL_SECONDS", "30"))
SCALPER_CONFIDENCE_THRESHOLD = float(os.environ.get("SCALPER_CONFIDENCE_THRESHOLD", "0.55"))

# Execution layer's OWN hard limits. brain.py's size_hint is a relative
# advisory signal ("full"/"half"/"quarter"/"skip") — real position sizing
# and exposure caps belong here, per BRAIN_SPEC.md item 4. MAX_POSITION_USD
# defaults to 0 (no live orders) until an execution client actually exists.
MAX_CONCURRENT_POSITIONS = int(os.environ.get("MAX_CONCURRENT_POSITIONS", "1"))
MAX_POSITION_USD = float(os.environ.get("MAX_POSITION_USD", "0"))

ASI1_BASE_URL = os.environ.get("ASI1_BASE_URL", "https://api.asi1.ai/v1").rstrip("/")
ASI1_API_KEY = os.environ.get("ASI1_API_KEY") or os.environ.get("ASI_ONE_API_KEY")
ASI1_MODEL = os.environ.get("ASI1_MODEL", "asi1-mini")

MARKET_DATA_WORKER_URL = os.environ.get(
    "MARKET_DATA_WORKER_URL", "https://scalper-market-data.gitgoin87.workers.dev"
).rstrip("/")

logger = logging.getLogger(AGENT_NAME)


def asi1_llm_call(messages: list[dict]) -> str:
    """Minimal OpenAI-compatible ASI:One client matching the
    Callable[[list[dict]], str] signature brain.decide() expects.

    Deliberately single-account (mauro@leaksnipe.win, one API key, no
    rotation) rather than porting this repo's legacy multi-account key
    rotation in src/infra/asi1-client.js — that file's own open PR #193
    ("use only mauro@leaksnipe.win") is consolidating toward exactly this
    simpler shape, so there's nothing worth reusing there yet.
    """
    if not ASI1_API_KEY:
        raise RuntimeError(
            "ASI1_API_KEY (or ASI_ONE_API_KEY) is not set — see .env.example"
        )
    response = requests.post(
        f"{ASI1_BASE_URL}/chat/completions",
        headers={
            "Authorization": f"Bearer {ASI1_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": ASI1_MODEL,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": 800,
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"]


def build_snapshot_from_live_data() -> Optional[MarketSnapshot]:
    """Fetches a ready-made Kalshi MarketSnapshot from the deployed
    scalper-market-data Worker rather than calling market_data.py's
    Kalshi/Coinbase clients directly — the Worker is the single source of
    truth for live data (this agent, any ASI1/Agentverse chat agent, and
    the HUD all hit the same endpoint), so a bug fix only has to happen
    in one place. Falls back to calling market_data.py directly if the
    Worker request fails, so a Worker outage doesn't kill the whole cycle.

    Polymarket is deliberately NOT wired in here yet: market_data.py's
    module docstring documents a real structural gap (no Polymarket
    product is simultaneously hourly-cadence, banded, AND TWAP-settled)
    that needs a decision before it feeds the same scalper_cycle — see
    HANDOFF.md / BRAIN_SPEC.md.
    """
    try:
        response = requests.get(f"{MARKET_DATA_WORKER_URL}/snapshot/kalshi", timeout=15)
        response.raise_for_status()
        data = response.json()
        if "error" in data:
            raise RuntimeError(f"Worker returned an error: {data['error']}")
        return MarketSnapshot(
            venue=data["venue"],
            symbol=data["symbol"],
            spot=data["spot"],
            minutes_to_expiry=data["minutes_to_expiry"],
            candidate_bands=[CandidateBand(**b) for b in data["candidate_bands"]],
            momentum_signal=data.get("momentum_signal"),
            recent_30m_high=data.get("recent_30m_high"),
            recent_30m_low=data.get("recent_30m_low"),
            settlement_window_seconds=data.get("settlement_window_seconds"),
        )
    except Exception:
        logger.exception(
            "Failed to fetch snapshot from market-data Worker (%s) — "
            "falling back to market_data.py directly.", MARKET_DATA_WORKER_URL
        )
        try:
            from market_data import build_kalshi_snapshot

            return build_kalshi_snapshot()
        except Exception:
            logger.exception("Fallback to market_data.py also failed — skipping this cycle.")
            return None


# ---------------------------------------------------------------------------
# Agent identity + mailbox (see register_agent.py at the repo root for the
# one-time Agentverse registration step this agent expects to already have
# been done against this same AGENT_SEED_PHRASE / AGENTVERSE_KEY pair).
# ---------------------------------------------------------------------------
agent = Agent(
    name=AGENT_NAME,
    seed=AGENT_SEED,
    port=AGENT_PORT,
    mailbox=True,
)

chat_proto = Protocol(spec=chat_protocol_spec)


# ---------------------------------------------------------------------------
# Decision cycle
# ---------------------------------------------------------------------------
@agent.on_interval(period=SCALPER_INTERVAL_SECONDS)
async def scalper_cycle(ctx: Context):
    snapshot = build_snapshot_from_live_data()
    if snapshot is None:
        ctx.logger.debug(
            "No live snapshot yet (market_data.py not wired in) — skipping cycle."
        )
        return

    decision = decide(snapshot, llm_call=asi1_llm_call)
    ctx.storage.set("last_decision", json.dumps(asdict(decision)))
    ctx.logger.info(f"[{decision.action}] {decision.rationale}")

    if decision.action == "ENTER_RANGE" and decision.confidence < SCALPER_CONFIDENCE_THRESHOLD:
        ctx.logger.info(
            f"Confidence {decision.confidence:.2f} below threshold "
            f"{SCALPER_CONFIDENCE_THRESHOLD:.2f} — treating as SKIP."
        )
        return

    # Real order placement, MAX_CONCURRENT_POSITIONS / MAX_POSITION_USD
    # enforcement, and exit handling belong here once there's an execution
    # client to call. Not stubbed further — see HANDOFF.md open items
    # before this is allowed to touch real size.


# ---------------------------------------------------------------------------
# Chat Protocol — lets a human (or the HUD) ask this agent for its status
# ---------------------------------------------------------------------------
@chat_proto.on_message(model=ChatMessage)
async def handle_chat_message(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))

    raw = ctx.storage.get("last_decision")
    if raw is None:
        reply = "No decision cycle has run yet."
    else:
        d = json.loads(raw)
        reply = (
            f"Last decision: {d['action']} ({d['venue'] or '-'} {d['symbol'] or ''}) "
            f"confidence={d['confidence']:.2f} risk_flags={d['risk_flags']}\n"
            f"Rationale: {d['rationale']}"
        )
    await ctx.send(sender, ChatMessage(content=[TextContent(text=reply)]))


@chat_proto.on_message(model=ChatAcknowledgement)
async def handle_chat_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.debug(f"Chat ack from {sender} for {msg.acknowledged_msg_id}")


agent.include(chat_proto, publish_manifest=True)


# ---------------------------------------------------------------------------
# REST endpoint for the HUD — surfaces risk_flags + rationale so it's visible
# *why* the brain skipped something while watching it live (see HANDOFF.md).
# ---------------------------------------------------------------------------
class DecisionStatus(Model):
    action: str
    venue: Optional[str] = None
    symbol: Optional[str] = None
    confidence: float = 0.0
    size_hint: str = "skip"
    risk_flags: list[str] = []
    rationale: str = ""


@agent.on_rest_get("/decision", response=DecisionStatus)
async def get_last_decision(ctx: Context) -> DecisionStatus:
    raw = ctx.storage.get("last_decision")
    if raw is None:
        return DecisionStatus(action="NONE", rationale="No decision cycle has run yet.")
    d = json.loads(raw)
    return DecisionStatus(**{k: d[k] for k in DecisionStatus.model_fields if k in d})


if __name__ == "__main__":
    if not AGENT_SEED:
        raise SystemExit(
            "AGENT_SEED_PHRASE is not set — copy .env.example to .env and fill it "
            "in (see register_agent.py at the repo root for the one-time "
            "Agentverse registration step)."
        )
    agent.run()
