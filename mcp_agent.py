"""WeCryp — specialized binary prediction agent for Kalshi & Polymarket.

Features:
- Agentverse Chat Protocol (phone + Agentverse chat)
- Local REST endpoint /query for the HUD
- ASI:One LLM with MCP tool-calling
- Trading-style profiles and lightweight session memory
"""
import asyncio
import json
import os
import subprocess
from datetime import datetime, timezone
from uuid import uuid4

import requests
import uagents.asgi as uagents_asgi
from dotenv import load_dotenv
from uagents import Agent, Context, Model, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

from claude_mem_bridge import get_agent_memory_context, get_recent_observations
from claude_mem_bridge import search_memory as search_claude_mem
from calibration_ledger import get_calibration_report
from kodak_bridge import get_kodak_derived, get_kodak_snapshot
from mcp_client import LeakSnipeMCPClient
from model_introspection import format_for_llm, get_decision_trees, get_model_weights
from prediction_engine import get_alt_signal, predict_15m_range, predict_hourly_range
from scalper_tools import LOCAL_TOOL_NAMES, call_local_tool
from scalper_tools import TOOL_SCHEMAS as SCALPER_TOOL_SCHEMAS

load_dotenv()

AGENT_SEED = os.getenv("AGENT_SEED", "wecryp_agent_seed_2026")
ASI1_API_URL = os.getenv("ASI1_API_URL", "https://api.asi1.ai/v1/chat/completions")
ASI1_API_KEY = os.getenv("ASI1_API_KEY", "")
MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "https://leaksnipe-suite.gitgoin87.workers.dev")
MCP_SERVER_TOKEN = os.getenv("MCP_SERVER_TOKEN", "")

asyncio.set_event_loop(asyncio.new_event_loop())
uagents_asgi.HOST = "127.0.0.1"

agent = Agent(
    name="wecryp",
    seed=AGENT_SEED,
    port=8002,
    mailbox=True,
    publish_agent_details=True,
)

client = LeakSnipeMCPClient()

# --- Trading profiles -----------------------------------------------------
# Primary style: hourly range binaries on Kalshi/Polymarket.
# User enters 15-20 minutes before the hour expiry and buys OUT-OF-RANGE
# strikes (poor odds / cheap contracts) that mature AT expiry.
STYLE_PROFILES = {
    "scalper": {
        "label": "Hourly Range Scalper",
        "horizon": "hourly range contracts expiring at the top of the hour",
        "entry_timing": "enter 15-20 minutes before the hourly expiry",
        "focus": (
            "buy OUT-OF-RANGE strikes with poor odds that mature at expiry; "
            "the edge is the market overpricing the chance of price reaching "
            "a distant strike with only minutes remaining"
        ),
        "risk": (
            "late-window entries are vulnerable to volatility spikes and "
            "liquidation cascades; size so one contract loss is recoverable "
            "within 2-3 trades"
        ),
    },
    "hourly": {
        "label": "Hourly Binary",
        "horizon": "hourly contracts",
        "focus": "hourly opening range, key S/R levels, momentum shifts",
        "risk": "watch for late-hour reversals, don't over-leverage",
    },
    "macro": {
        "label": "Macro Thesis",
        "horizon": "multi-day contracts",
        "focus": "macro events, policy, crypto community sentiment",
        "risk": "thesis invalidation levels, position sizing",
    },
}

DEFAULT_STYLE = os.getenv("WECRYP_STYLE", "scalper")
ACTIVE_STYLE = STYLE_PROFILES.get(DEFAULT_STYLE, STYLE_PROFILES["scalper"])

SYSTEM_PROMPT = f"""You are WeCryp, a highly specialized binary prediction agent for Kalshi and Polymarket contracts.

TRADING STYLE PROFILE:
- Style: {ACTIVE_STYLE['label']}
- Contract horizon: {ACTIVE_STYLE['horizon']}
- Entry timing: {ACTIVE_STYLE['entry_timing']}
- Core strategy: {ACTIVE_STYLE['focus']}
- Risk framework: {ACTIVE_STYLE['risk']}

PRIMARY USE CASE:
The user trades HOURLY RANGE contracts. They enter 15-20 minutes before the hour expiry and
buy OUT-OF-RANGE strikes (poor odds / cheap contracts) that mature at the expiry of the contract.

SETTLEMENT MECHANICS (CRITICAL):
The user places trades on their phone through Coinbase, which settles on the BRTI
(Bitcoin Reference Rate - Real Time Index) AVERAGE, NOT the TWAP like Polymarket.
There is a HUGE difference between these settlement methods:
- BRTI average: a volume-weighted average price across constituent exchanges,
  updated in real-time. Settlement is based on the BRTI print at expiry.
- TWAP (Polymarket): a time-weighted average price over a window (typically the
  last hour), which smooths out spikes and wicks.
This means: for Coinbase/BRTI-settled contracts, a single violent wick at expiry
CAN settle the trade. For Polymarket/TWAP-settled contracts, the wick gets
averaged out and the settlement is smoother. Always ask (or infer from context)
which venue the contract settles on before giving a probability estimate.

RANGE CONSTRUCTION RULES:
- For hourly range predictions, set the top of the range toward the center to give
  the price room to move throughout the hour.
- Ranges are NOT PTB. They are binary YES/NO on whether the asset reaches that
  price at the strike of the hour.

Your job is to:
1. Give a clear directional call (YES/NO or UP/DOWN)
2. Estimate the probability of price reaching the strike before expiry
3. Assess whether current momentum supports reaching the strike in the remaining time
4. Flag risk factors that could invalidate the trade
5. Note the settlement venue (BRTI average vs TWAP) when it materially changes the probability

LIVE CONTRACT TOOLS: You have tools to pull real, live Kalshi and Polymarket
contract prices (get_kalshi_hourly_bands, get_kalshi_15m_updown,
get_polymarket_fast_updown, get_polymarket_daily_bands) — call the relevant
one before quoting any specific contract's yes/no price or discussing a
specific strike. The QUANTITATIVE PREDICTION block below is a statistical
estimate computed from Coinbase spot/candles, not a live contract quote —
don't present it as one.

GROUNDING RULE (do not violate this): only state a specific number (price,
OHLC, volatility %, probability, or a contract's bid/ask) if it came from
the QUANTITATIVE PREDICTION block below or from a tool call result in this
conversation. If you need a number you don't have, call the right tool; if
no tool covers it or a tool call fails, say plainly that you don't have
that live data rather than estimating a plausible-looking figure.

Be direct, concise, and professional. Use tools when available to fetch
real-time prices and market data. You also keep up with the latest in tech and
the crypto community to be helpful and useful at all times.
"""


MEMORY_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "search_claude_mem",
            "description": "Search persistent memory (claude-mem) for relevant observations, session summaries, and learned context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "limit": {"type": "integer", "description": "Max results (default 10)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_recent_observations",
            "description": "Get the most recent observations from claude-mem.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Max results (default 5)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_agent_memory_context",
            "description": "Get formatted memory context relevant to a query.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Context query"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_model_weights",
            "description": "Get current model weights/parameters for the hourly range prediction engine.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_decision_trees",
            "description": "Get decision tree structure for entry/exit logic.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_kodak_snapshot",
            "description": (
                "Cross-venue BTC market snapshot: order books, funding, open "
                "interest, positioning, liquidations, live Kalshi contracts, "
                "divergence metrics, and the current fat-tail model prediction."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {
                        "type": "string",
                        "description": "Trading pair, e.g. BTCUSDT or ETHUSDT. Default BTCUSDT.",
                    }
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_alt_signal",
            "description": (
                "Live SOL/ETH versus BTC lead-lag signal, including taker-flow "
                "alignment. aligned=true is an active cross-asset warning."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_calibration_report",
            "description": (
                "Persistent prediction/outcome calibration report with Brier "
                "scores and model-right/tail-arrival buckets."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_kalshi_15m_model",
            "description": (
                "Live Kalshi 15m up/down model fair, market residual, and "
                "spot-staleness status for fast-market quote verification."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_tail_diagnostics",
            "description": (
                "Late-window wick pressure and the tail adjustment currently "
                "applied to strike probabilities."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

# --- Session memory --------------------------------------------------------
MAX_MEMORY = 10
SESSIONS = {}  # sender -> list of {"role": ..., "content": ...}

def _remember(sender: str, role: str, content: str):
    hist = SESSIONS.setdefault(sender, [])
    hist.append({"role": role, "content": content})
    if len(hist) > MAX_MEMORY * 2:
        del hist[: len(hist) - MAX_MEMORY * 2]

# --- LLM + tool loop -------------------------------------------------------
async def process_query(query: str, sender: str = "local") -> str:
    headers = {
        "Authorization": f"Bearer {ASI1_API_KEY}",
        "Content-Type": "application/json",
    }
    prediction = predict_hourly_range()
    prediction["kalshi_15m_model"] = predict_15m_range()
    kodak_derived = get_kodak_derived()
    if isinstance(prediction, dict) and "error" not in kodak_derived:
        prediction["cross_venue_market"] = kodak_derived
    import json as _json
    system_prompt = (
        SYSTEM_PROMPT
        + "\n\nQUANTITATIVE PREDICTION (computed fresh, interpret these numbers):\n"
        + _json.dumps(prediction, indent=2)
    )
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(SESSIONS.get(sender, []))
    messages.append({"role": "user", "content": query})

    tools = SCALPER_TOOL_SCHEMAS + MEMORY_TOOL_SCHEMAS + client.get_tool_schemas()

    # Loop rather than a single fixed round-trip: with ~98 tools available,
    # the model regularly wants to chain a second tool call after seeing the
    # first result (e.g. spot price -> check a contract's target price too).
    # A single hardcoded follow-up call used to grab `content` from whatever
    # came back, which is null on a tool_calls-only response -- that's what
    # produced "No response generated." MAX_TOOL_ROUNDS bounds the loop so a
    # model stuck calling tools forever can't hang a query indefinitely.
    MAX_TOOL_ROUNDS = 4
    for round_num in range(MAX_TOOL_ROUNDS):
        payload = {"model": "asi1", "messages": messages, "temperature": 0.2}
        if tools:
            payload["tools"] = tools

        resp = requests.post(ASI1_API_URL, headers=headers, json=payload, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        choice = data["choices"][0]["message"]
        tool_calls = choice.get("tool_calls") or []

        if not tool_calls:
            content = choice.get("content") or "No response generated."
            _remember(sender, "user", query)
            _remember(sender, "assistant", content)
            return content

        results = []
        for tc in tool_calls:
            fn = tc["function"]
            name = fn["name"]
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except (json.JSONDecodeError, TypeError, ValueError):
                args = {}
            if name in LOCAL_TOOL_NAMES:
                result_text = call_local_tool(name, args)
            elif name == "get_alt_signal":
                result_text = format_for_llm(get_alt_signal())
            elif name == "get_calibration_report":
                result_text = format_for_llm(get_calibration_report())
            elif name == "get_kalshi_15m_model":
                result_text = format_for_llm(predict_15m_range())
            elif name == "get_tail_diagnostics":
                result_text = format_for_llm(
                    predict_hourly_range().get("tail_diagnostics", {})
                )
            elif name == "search_claude_mem":
                result_text = json.dumps(search_claude_mem(args.get("query", ""), args.get("limit", 10)))
            elif name == "get_recent_observations":
                result_text = json.dumps(get_recent_observations(args.get("limit", 5)))
            elif name == "get_agent_memory_context":
                result_text = get_agent_memory_context(args.get("query", ""))
            elif name == "get_model_weights":
                result_text = format_for_llm(get_model_weights())
            elif name == "get_decision_trees":
                result_text = format_for_llm(get_decision_trees())
            elif name == "get_kodak_snapshot":
                result_text = format_for_llm(
                    get_kodak_snapshot(args.get("symbol", "BTCUSDT"))
                )
            else:
                result_text = client.call_tool(name, args)
            results.append((tc, result_text))

        tool_messages = [
            {"role": "tool", "tool_call_id": tc["id"], "content": text}
            for tc, text in results
        ]
        messages = messages + [choice] + tool_messages

    # Exhausted MAX_TOOL_ROUNDS still chaining tool calls -- ask once more
    # with tools withheld so the model is forced to answer from what it's
    # already gathered instead of calling yet another tool.
    resp = requests.post(
        ASI1_API_URL, headers=headers,
        json={"model": "asi1", "messages": messages, "temperature": 0.2},
        timeout=120,
    )
    resp.raise_for_status()
    final = resp.json()["choices"][0]["message"].get("content") or "No response generated."
    _remember(sender, "user", query)
    _remember(sender, "assistant", final)
    return final

# --- Chat protocol ---------------------------------------------------------
chat_proto = Protocol(spec=chat_protocol_spec)

@chat_proto.on_message(ChatMessage)
async def handle_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(
        timestamp=datetime.now(timezone.utc),
        acknowledged_msg_id=msg.msg_id,
    ))
    text = ""
    for item in msg.content:
        if isinstance(item, TextContent):
            text = item.text
            break
    if not text:
        return
    ctx.logger.info(f"Query from {sender}: {text[:120]}")
    try:
        answer = await process_query(text, sender=sender)
    except (requests.RequestException, KeyError, ValueError, TypeError) as e:
        answer = f"Error processing request: {e}"
    await ctx.send(sender, ChatMessage(
        timestamp=datetime.now(timezone.utc),
        msg_id=uuid4(),
        content=[TextContent(type="text", text=answer)],
    ))

@chat_proto.on_message(ChatAcknowledgement)
async def handle_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.info(f"Ack from {sender}")

# --- REST endpoint for the HUD --------------------------------------------
class HUDQuery(Model):
    query: str

class HUDResponse(Model):
    ok: bool
    content: str

@agent.on_rest_post("/health", HUDQuery, HUDResponse)
async def handle_health(ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        health = {
            "status": "ok",
            "agent": agent.name,
            "port": 8002,
            "mcp_connected": client.connected,
            "mcp_tools": len(client.tools),
            "memory": "claude-mem",
        }
        return HUDResponse(ok=True, content=format_for_llm(health))
    except (requests.RequestException, KeyError, ValueError, TypeError) as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_get("/health", HUDResponse)
async def handle_health_get(_ctx: Context) -> HUDResponse:
    health = {
        "status": "ok",
        "agent": agent.name,
        "port": 8002,
        "mcp_connected": client.connected,
        "mcp_tools": len(client.tools),
        "memory": "claude-mem",
    }
    return HUDResponse(ok=True, content=format_for_llm(health))


@agent.on_rest_post("/query", HUDQuery, HUDResponse)
async def handle_query(ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        answer = await process_query(msg.query)
        return HUDResponse(ok=True, content=answer)
    except (requests.RequestException, KeyError, ValueError, TypeError) as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_post("/weights", HUDQuery, HUDResponse)
async def handle_weights(ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        weights = get_model_weights()
        return HUDResponse(ok=True, content=format_for_llm(weights))
    except (requests.RequestException, KeyError, ValueError, TypeError) as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_post("/trees", HUDQuery, HUDResponse)
async def handle_trees(ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        trees = get_decision_trees()
        return HUDResponse(ok=True, content=format_for_llm(trees))
    except (requests.RequestException, KeyError, ValueError, TypeError) as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_post("/kodak", HUDQuery, HUDResponse)
async def handle_kodak(ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        snapshot = get_kodak_snapshot(msg.query or "BTCUSDT")
        return HUDResponse(ok=True, content=format_for_llm(snapshot))
    except (
        KeyError,
        OSError,
        TypeError,
        ValueError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_post("/alt-signal", HUDQuery, HUDResponse)
async def handle_alt_signal(_ctx: Context, _msg: HUDQuery) -> HUDResponse:
    return HUDResponse(ok=True, content=format_for_llm(get_alt_signal()))


@agent.on_rest_post("/calibration", HUDQuery, HUDResponse)
async def handle_calibration(_ctx: Context, _msg: HUDQuery) -> HUDResponse:
    return HUDResponse(ok=True, content=format_for_llm(get_calibration_report()))


@agent.on_rest_post("/tail-diagnostics", HUDQuery, HUDResponse)
async def handle_tail_diagnostics(_ctx: Context, _msg: HUDQuery) -> HUDResponse:
    return HUDResponse(ok=True, content=format_for_llm(
        predict_hourly_range().get("tail_diagnostics", {})
    ))


@agent.on_rest_post("/kalshi-15m-model", HUDQuery, HUDResponse)
async def handle_kalshi_15m_model(_ctx: Context, _msg: HUDQuery) -> HUDResponse:
    return HUDResponse(ok=True, content=format_for_llm(predict_15m_range()))

# --- Lifecycle -------------------------------------------------------------
@agent.on_event("startup")
async def startup(ctx: Context):
    connected = client.connect()
    if connected:
        ctx.logger.info(f"WeCryp ready — {len(client.tools)} MCP tools loaded")
    else:
        ctx.logger.warning("MCP connect failed — agent running without tools")

@agent.on_event("shutdown")
async def shutdown(ctx: Context):
    client.close()

agent.include(chat_proto, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
