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
import time
from datetime import datetime, timezone
from uuid import uuid4
import sys

for p in ["/mnt/g/WECRYP", "/home/mauro/leaksnipe-mcp-agent", os.path.dirname(os.path.abspath(__file__))]:
    if p not in sys.path:
        sys.path.insert(0, p)

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

# Load environment variables with explicit paths and override=True
script_dir = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(script_dir, ".env"), override=True)
load_dotenv("/home/mauro/leaksnipe-mcp-agent/.env", override=True)
load_dotenv("/mnt/g/WECRYP/.env", override=True)

# Use AGENT_SEED_PHRASE (new Agentverse account seed) with fallback to AGENT_SEED
AGENT_SEED = os.getenv("AGENT_SEED_PHRASE", os.getenv("AGENT_SEED", "wecryp_agent_seed_2026"))
ASI1_API_URL = os.getenv("ASI1_API_URL", "https://api.asi1.ai/v1/chat/completions")
ASI1_API_KEY = os.getenv("ASI1_API_KEY", "")
MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "https://leaksnipe-suite.gitgoin87.workers.dev")
MCP_SERVER_TOKEN = os.getenv("MCP_SERVER_TOKEN", "")

asyncio.set_event_loop(asyncio.new_event_loop())
uagents_asgi.HOST = "0.0.0.0"

TRUFFLE_ENDPOINT = os.getenv("TRUFFLE_ENDPOINT", "https://truffle.leaksnipe.win")

agent = Agent(
    name="Trufflezzz",
    seed=AGENT_SEED,
    port=8002,
    mailbox=True,
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
    {
        "type": "function",
        "function": {
            "name": "get_cascade_audit",
            "description": (
                "Live AMM cascade exhaustion, sub-orbital wall density, and "
                "leverage overhang metrics. Use before catching falling knives."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {
                        "type": "string",
                        "description": "Asset symbol, e.g. BTC, ETH, SOL. Default BTC.",
                    }
                },
            },
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


# --- Live Cascade Audit Engine ---------------------------------------------
def get_live_cascade_audit(symbol: str = "BTC") -> dict:
    """Generate fresh CascadeTelemetryPacket using live orderbook & flow data."""
    try:
        from amm_cascade_exhaustion import (
            AmmCascadeExhaustionCalculator,
            AmmPoolDepthBand,
            LiquidationBucket,
            VenueSkew,
            FlowSnapshot,
        )
        from truffle_cascade_bridge import format_asi1_context
        from prediction_engine import get_spot, get_positioning_skew
        from dataclasses import asdict

        spot_data = get_spot()
        spot = float(spot_data.get("price") or 65000.0)

        # Pull live positioning skew (Coinbase L2 L-ratio)
        skew_data = get_positioning_skew()
        l_ratio = float(skew_data.get("l_ratio") or 0.0) if skew_data.get("active") else 0.0

        # Build VenueSkew (-l_ratio mapped per engine convention)
        venue_skew = VenueSkew(
            l_ratio=l_ratio,
            divergence_pct=0.01,
            funding_skew=0.0,
            active=bool(skew_data.get("active", False)),
        )

        calc = AmmCascadeExhaustionCalculator()
        floor_price = spot * (1.0 - (calc.slip_bps / 10_000.0))
        depth = 500000.0
        bands = [AmmPoolDepthBand(lower_price=floor_price, upper_price=spot, virtual_liquidity_depth=depth)]
        queue = []
        flow = FlowSnapshot(
            forced_liquidation_volume=0.0,
            discretionary_taker_buy_volume=10000.0,
            discretionary_taker_sell_volume=10000.0,
            amm_price_velocity=0.0,
            oracle_price_velocity=0.0,
            window_sec=300.0,
        )
        packet = calc.calculate_metrics(
            symbol=symbol.upper(),
            spot_price=spot,
            amm_bands=bands,
            liquidation_queue=queue,
            flow=flow,
            venue_skew=venue_skew,
        )
        return {
            "ok": True,
            "telemetry": asdict(packet),
            "context_prompt": format_asi1_context(packet),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# --- Truffle inference policy ----------------------------------------------
# Full-live, unconditionally: every channel (HUD, mailbox, periodic, aux
# endpoints) gets live ASI1 inference. Cost is not a constraint.
# NOTE (2026-09-21): the old TRUFFLE_HUD_ONLY / HUD_ONLY_INFERENCE
# deterministic-only policy was removed permanently — silent deterministic
# fallbacks confused the HUD. The only deterministic output left is the
# last-resort fallback when ASI1 itself fails, and it says so explicitly.

_snapshot_cache = None
_snapshot_time = 0.0
_last_asi1_call_time = 0.0
_cached_truffle_summary = None
_cached_truffle_summary_time = 0.0
_cached_truffle_source = "none"

def _get_or_compute_snapshot():
    global _snapshot_cache, _snapshot_time
    now = time.time()
    if _snapshot_cache is not None and (now - _snapshot_time) < 60.0:
        return _snapshot_cache
    try:
        prediction = predict_hourly_range()
        prediction["kalshi_15m_model"] = predict_15m_range()
        kodak_derived = get_kodak_derived()
        if isinstance(prediction, dict) and "error" not in kodak_derived:
            prediction["cross_venue_market"] = kodak_derived
        cascade_res = get_live_cascade_audit("BTC")
        if cascade_res.get("ok"):
            prediction["cascade_exhaustion"] = cascade_res["telemetry"]
            cascade_overlay = "\n\n" + cascade_res["context_prompt"]
        else:
            cascade_overlay = ""
        _snapshot_cache = (prediction, cascade_overlay)
        _snapshot_time = now
        return _snapshot_cache
    except Exception as e:
        if _snapshot_cache is not None:
            return _snapshot_cache
        return ({}, "")


def generate_deterministic_truffle_summary(prediction: dict, cascade_overlay: str = "") -> str:
    """Pure deterministic model summary tailored specifically for @truffz.
    
    Synthesizes the quantitative prediction engine, Kalshi 15m model,
    and AMM cascade exhaustion telemetry into an actionable briefing
    with 0 external API calls and 0 token cost.
    """
    spot = float(prediction.get("spot") or prediction.get("current_price") or 0.0)
    if spot <= 0:
        try:
            from prediction_engine import get_spot
            spot_data = get_spot()
            spot = float(spot_data.get("price") or 0.0)
        except Exception:
            spot = 0.0

    # Hourly prediction parameters
    expected_low = prediction.get("expected_low") or prediction.get("range_low")
    expected_high = prediction.get("expected_high") or prediction.get("range_high")
    vol_pct = prediction.get("hourly_vol_pct") or prediction.get("volatility") or "—"
    regime = prediction.get("regime") or "NORMAL"
    direction = str(prediction.get("direction") or prediction.get("signal") or "NEUTRAL").upper()
    confidence = prediction.get("confidence") or "—"

    # Cascade telemetry
    cascade = prediction.get("cascade_exhaustion") or {}
    verdict = cascade.get("verdict") or "CASCADE_UNRESOLVED"
    coherence = cascade.get("cascade_coherence_index") or "—"
    v_flush = cascade.get("vaporization_ratio") or "—"
    wall_density = cascade.get("sub_orbital_wall_density") or 0.0
    action = cascade.get("recommended_action") or "HOLD_FLAT_OBSERVE"

    # Truffle Gate logic
    if verdict == "VOID_SLIP_ACTIVE" or (isinstance(wall_density, (int, float)) and wall_density > 0.65):
        truffle_gate = "🛑 FORCE HALT: VOID_SLIP / HIGH WALL DENSITY — DO NOT CATCH FALLING KNIVES"
    elif verdict == "FLUSH_EXHAUSTED_ABSORPTION_DETECTED":
        truffle_gate = "✅ REVERSION ENTRY PERMITTED: Cascade flush absorption confirmed"
    else:
        truffle_gate = f"ℹ️ GATE OPEN: Normal scalping flow ({action})"

    # Kalshi 15m
    k15 = prediction.get("kalshi_15m_model") or {}
    k15_fair = k15.get("fair") or k15.get("model_fair") or "—"
    k15_res = k15.get("residual") or "—"

    # Format numbers
    range_str = f"${expected_low:,.2f} – ${expected_high:,.2f}" if expected_low and expected_high else "Calculating..."
    spot_str = f"${spot:,.2f}" if spot > 0 else "—"

    return (
        f"🍄 @truffz MODEL SUMMARY [DETERMINISTIC ENGINE]\n"
        f"Strategy: Hourly Range Scalper & AMM Cascade Bridge\n"
        f"----------------------------------------------------\n"
        f"1. TRUFFLE GATE DIRECTIVE:\n"
        f"   Status: {truffle_gate}\n"
        f"   Cascade Verdict: {verdict} (Coherence: {coherence})\n"
        f"   Action: {action}\n\n"
        f"2. HOURLY RANGE TARGETS & BIAS:\n"
        f"   Coinbase Spot: {spot_str} (BRTI Settlement Anchor)\n"
        f"   Expected Range: {range_str}\n"
        f"   Directional Bias: {direction} (Conf: {confidence}, Regime: {regime})\n"
        f"   Kalshi 15m Fair: {k15_fair} (Residual: {k15_res})\n\n"
        f"3. LIQUIDITY & CASCADE MECHANICS:\n"
        f"   Sub-Orbital Wall Density: {wall_density} (Alert threshold: >0.65)\n"
        f"   Vaporization Ratio (V_flush): {v_flush} (Exhaustion target: >0.82)\n"
        f"   Settlement Notice: Settles on Coinbase BRTI average. Sudden late-window wicks count!\n\n"
        f"4. SCALPER EXECUTION RULE:\n"
        f"   Enter 15–20 min before expiry on out-of-range strikes with decaying premium. "
        f"Avoid catching falling knives if wall density is elevated."
    )


def get_or_refresh_truffle_model_summary(force_refresh: bool = False) -> tuple[str, str, float]:
    """Get or refresh the Truffle model summary.

    Always attempts a fresh live ASI1 inference when a key is present.
    Returns: (summary_content, source, cooldown_remaining_sec)
    source is either 'asi1' or 'deterministic' (deterministic = ASI1 failed
    or no key configured — last resort only, never a policy choice).
    """
    global _last_asi1_call_time, _cached_truffle_summary, _cached_truffle_summary_time, _cached_truffle_source
    now = time.time()

    prediction, cascade_overlay = _get_or_compute_snapshot()

    # 2. Live ASI1 call whenever a key is present.
    if ASI1_API_KEY:
        try:
            headers = {
                "Authorization": f"Bearer {ASI1_API_KEY}",
                "Content-Type": "application/json",
            }
            asi1_system_prompt = (
                "You are @truffz, the dedicated Truffle trading agent in WeCrypto specializing in Kalshi and Polymarket "
                "hourly range binary scalping and AMM cascade exhaustion mechanics. "
                "The user enters out-of-range strikes 15-20 min before expiry, settling on Coinbase BRTI average (single-wick settlement). "
                "Synthesize the quantitative prediction and cascade telemetry below into a concise (under 250 words), high-conviction "
                "Truffle Model Summary. "
                "Ground all numbers strictly in the provided data. "
                "Structure into: "
                "1) Truffle Gate Directive (verdict & knife-catch check), "
                "2) Expected Range & Key Strikes (Coinbase BRTI anchor), "
                "3) AMM Cascade & Liquidity (Wall Density & V_flush), "
                "4) Scalp Entry Timing & Settlement Risk."
            )
            import json as _json
            asi1_user_prompt = (
                f"QUANTITATIVE PREDICTION & TELEMETRY:\n{_json.dumps(prediction, indent=2)}\n\n"
                f"{cascade_overlay}\n\n"
                "Generate the operational Truffle Model Summary for @truffz now."
            )
            payload = {
                "model": "asi1",
                "messages": [
                    {"role": "system", "content": asi1_system_prompt},
                    {"role": "user", "content": asi1_user_prompt},
                ],
                "temperature": 0.15,
                "max_tokens": 1000,
            }
            resp = requests.post(ASI1_API_URL, headers=headers, json=payload, timeout=45)
            if resp.status_code == 200:
                data = resp.json()
                content = data["choices"][0]["message"].get("content") or ""
                if content:
                    _last_asi1_call_time = time.time()
                    _cached_truffle_summary = content.strip()
                    _cached_truffle_summary_time = time.time()
                    _cached_truffle_source = "asi1"
                    return (_cached_truffle_summary, "asi1", 0.0)
                else:
                    ch0 = data.get("choices", [{}])[0]
                    print(f"[truffle] model-summary ASI1 200 but empty content "
                          f"(finish={ch0.get('finish_reason')} refusal={ch0.get('message', {}).get('refusal')})", flush=True)
            else:
                print(f"[truffle] model-summary ASI1 HTTP {resp.status_code}: {resp.text[:200]}", flush=True)
        except Exception as ex:
            # Fall back to deterministic summary on any failure
            print(f"[truffle] model-summary ASI1 exception: {type(ex).__name__}: {ex}", flush=True)

    # 3. Deterministic summary fallback (ASI1 failed or no key — instantaneous)
    det_summary = generate_deterministic_truffle_summary(prediction, cascade_overlay)
    _cached_truffle_summary = det_summary
    _cached_truffle_summary_time = time.time()
    _cached_truffle_source = "deterministic"
    return (det_summary, "deterministic", 0.0)


def process_query(query: str, sender: str = "local") -> str:
    """Answer a query with live ASI1 inference — always. There is no
    deterministic-only mode anymore (removed 2026-09-21).
    Discrete quantitative intents still fetch their data block first, but it
    is synthesized into an ASI1 answer instead of dumped raw.
    """
    global _last_asi1_call_time
    q_clean = (query or "").strip()
    q_lower = q_clean.lower()

    # Discrete quantitative intents: fetch the data block for ASI1 synthesis.
    data_block = ""
    if any(k in q_lower for k in ["alt signal", "lead lag", "alt_signal"]):
        data_block = format_for_llm(get_alt_signal())
    elif any(k in q_lower for k in ["calibration", "brier"]):
        data_block = format_for_llm(get_calibration_report())
    elif any(k in q_lower for k in ["kalshi 15m", "15m model", "15m fair"]):
        data_block = format_for_llm(predict_15m_range())
    elif any(k in q_lower for k in ["weights", "parameters", "model weights"]):
        data_block = format_for_llm(get_model_weights())
    elif any(k in q_lower for k in ["decision tree", "trees"]):
        data_block = format_for_llm(get_decision_trees())
    elif any(k in q_lower for k in ["kodak", "orderbook depth"]):
        data_block = format_for_llm(get_kodak_snapshot("BTCUSDT"))
    elif any(k in q_lower for k in ["cascade audit", "cascade", "wall density", "knife catch"]):
        data_block = format_for_llm(get_live_cascade_audit("BTC"))

    # If asking for summary, live read, setup, advice, or general read:
    summary, source, cd_left = get_or_refresh_truffle_model_summary()
    print(f"[truffle] process_query sender={sender} summary_source={source} data_block={bool(data_block)} q={q_clean[:60]!r}", flush=True)

    is_summary_request = (
        not q_clean
        or any(k in q_lower for k in ["summary", "live read", "read on", "setup", "brief", "status", "truffle", "update"])
    )

    if is_summary_request and not data_block:
        if source != "asi1":
            return f"{summary}\n\n[Live ASI1 inference unavailable — deterministic fallback. Check ASI1 key/credits and retry.]"
        return summary

    # For conversational questions (live ASI1 whenever a key is present):
    can_call_asi1 = bool(ASI1_API_KEY)

    if can_call_asi1:
        # Single, targeted ASI1 inference call (NO tool looping to preserve credits)
        try:
            headers = {
                "Authorization": f"Bearer {ASI1_API_KEY}",
                "Content-Type": "application/json",
            }
            prediction, cascade_overlay = _get_or_compute_snapshot()
            import json as _json
            sys_prompt = (
                SYSTEM_PROMPT
                + f"\n\nLATEST TRUFFLE MODEL SUMMARY:\n{summary}\n\n"
                + f"QUANTITATIVE PREDICTION:\n{_json.dumps(prediction, indent=2)}\n"
                + cascade_overlay
            )
            if data_block:
                sys_prompt += f"\n\nREQUESTED DATA BLOCK (ground numbers in this):\n{data_block}\n"
            payload = {
                "model": "asi1",
                "messages": [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": q_clean},
                ],
                "max_tokens": 1000,
                "temperature": 0.15,
            }
            resp = requests.post(ASI1_API_URL, headers=headers, json=payload, timeout=45)
            if resp.status_code == 200:
                _last_asi1_call_time = time.time()
                ans = resp.json()["choices"][0]["message"].get("content") or ""
                if not ans:
                    # Transient empty completion — retry once before giving up.
                    ch0 = resp.json().get("choices", [{}])[0]
                    print(f"[truffle] process_query sender={sender} ASI1 200 empty "
                          f"(finish={ch0.get('finish_reason')} refusal={ch0.get('message', {}).get('refusal')}), retrying once", flush=True)
                    resp = requests.post(ASI1_API_URL, headers=headers, json=payload, timeout=45)
                    if resp.status_code == 200:
                        ans = resp.json()["choices"][0]["message"].get("content") or ""
                if ans:
                    _remember(sender, "user", q_clean)
                    _remember(sender, "assistant", ans)
                    print(f"[truffle] process_query sender={sender} source=asi1 chars={len(ans)}", flush=True)
                    return ans
            else:
                print(f"[truffle] process_query sender={sender} ASI1 HTTP {resp.status_code}: {resp.text[:200]}", flush=True)
        except Exception as ex:
            print(f"[truffle] process_query sender={sender} ASI1 exception: {type(ex).__name__}: {ex}", flush=True)

    # Last-resort fallback: ASI1 itself failed or no key is configured.
    # (There is no cooldown and no policy gate here — just retry.)
    print(f"[truffle] process_query sender={sender} source=deterministic-fallback q={q_clean[:60]!r}", flush=True)
    if data_block:
        ans = (
            f"{data_block}\n\n"
            f"[Live ASI1 synthesis failed — raw data above. Check ASI1 key/credits and retry anytime.]"
        )
    else:
        ans = (
            f"🍄 @truffz (Deterministic Engine — ASI1 unavailable):\n\n"
            f"{summary}\n\n"
            f"Regarding: '{q_clean[:80]}'\n"
            f"Deterministic models are aligned to the current hourly expiry bracket. "
            f"Maintain discipline on the 15-20m window and monitor BRTI wicks.\n\n"
            f"[Live ASI1 inference failed — check ASI1 key/credits and retry anytime.]"
        )
    _remember(sender, "user", q_clean)
    _remember(sender, "assistant", ans)
    return ans

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
        loop = asyncio.get_running_loop()
        answer = await loop.run_in_executor(None, lambda: process_query(text, sender=sender))
    except Exception as e:
        ctx.logger.error(f"Error in process_query for {sender}: {e}", exc_info=True)
        answer = f"Error processing query: {e}"
    ctx.logger.info(f"Dispatching response to {sender} ({len(answer)} chars)")
    status = await ctx.send(sender, ChatMessage(
        timestamp=datetime.now(timezone.utc),
        msg_id=uuid4(),
        content=[TextContent(type="text", text=answer)],
    ))
    ctx.logger.info(f"Response send status to {sender}: {status}")

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
    # /query is the HUD channel (asi1-desk + truffle:query IPC) — live inference.
    try:
        loop = asyncio.get_event_loop()
        answer = await loop.run_in_executor(None, lambda: process_query(msg.query))
        return HUDResponse(ok=True, content=answer)
    except (requests.RequestException, KeyError, ValueError, TypeError) as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_post("/weights", HUDQuery, HUDResponse)
async def handle_weights(ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        weights = await asyncio.get_event_loop().run_in_executor(None, get_model_weights)
        return HUDResponse(ok=True, content=format_for_llm(weights))
    except (requests.RequestException, KeyError, ValueError, TypeError) as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_post("/trees", HUDQuery, HUDResponse)
async def handle_trees(ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        trees = await asyncio.get_event_loop().run_in_executor(None, get_decision_trees)
        return HUDResponse(ok=True, content=format_for_llm(trees))
    except (requests.RequestException, KeyError, ValueError, TypeError) as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_post("/kodak", HUDQuery, HUDResponse)
async def handle_kodak(ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        loop = asyncio.get_event_loop()
        snapshot = await loop.run_in_executor(None, get_kodak_snapshot, msg.query or "BTCUSDT")
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
    signal = await asyncio.get_event_loop().run_in_executor(None, get_alt_signal)
    return HUDResponse(ok=True, content=format_for_llm(signal))


@agent.on_rest_post("/calibration", HUDQuery, HUDResponse)
async def handle_calibration(_ctx: Context, _msg: HUDQuery) -> HUDResponse:
    report = await asyncio.get_event_loop().run_in_executor(None, get_calibration_report)
    return HUDResponse(ok=True, content=format_for_llm(report))


@agent.on_rest_post("/tail-diagnostics", HUDQuery, HUDResponse)
async def handle_tail_diagnostics(_ctx: Context, _msg: HUDQuery) -> HUDResponse:
    prediction = await asyncio.get_event_loop().run_in_executor(None, predict_hourly_range)
    return HUDResponse(ok=True, content=format_for_llm(prediction.get("tail_diagnostics", {})))


@agent.on_rest_post("/kalshi-15m-model", HUDQuery, HUDResponse)
async def handle_kalshi_15m_model(_ctx: Context, _msg: HUDQuery) -> HUDResponse:
    model = await asyncio.get_event_loop().run_in_executor(None, predict_15m_range)
    return HUDResponse(ok=True, content=format_for_llm(model))


@agent.on_rest_post("/cascade", HUDQuery, HUDResponse)
async def handle_cascade_post(_ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        loop = asyncio.get_event_loop()
        res = await loop.run_in_executor(None, get_live_cascade_audit, msg.query or "BTC")
        return HUDResponse(ok=res.get("ok", False), content=format_for_llm(res))
    except Exception as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_post("/truffle/cascade-audit", HUDQuery, HUDResponse)
async def handle_cascade_audit_rest(_ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        loop = asyncio.get_event_loop()
        res = await loop.run_in_executor(None, get_live_cascade_audit, msg.query or "BTC")
        return HUDResponse(ok=res.get("ok", False), content=format_for_llm(res))
    except Exception as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_post("/truffle/model-summary", HUDQuery, HUDResponse)
async def handle_truffle_summary_post(_ctx: Context, msg: HUDQuery) -> HUDResponse:
    try:
        force = (msg.query or "").strip().lower() == "force"
        loop = asyncio.get_event_loop()
        summary, source, cd_left = await loop.run_in_executor(
            None, lambda: get_or_refresh_truffle_model_summary(force_refresh=force)
        )
        return HUDResponse(ok=True, content=summary)
    except Exception as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_get("/truffle/model-summary", HUDResponse)
async def handle_truffle_summary_get(_ctx: Context) -> HUDResponse:
    try:
        loop = asyncio.get_event_loop()
        summary, source, cd_left = await loop.run_in_executor(
            None, lambda: get_or_refresh_truffle_model_summary(force_refresh=False)
        )
        return HUDResponse(ok=True, content=summary)
    except Exception as e:
        return HUDResponse(ok=False, content=str(e))


@agent.on_rest_get("/summary", HUDResponse)
async def handle_summary_get(ctx: Context) -> HUDResponse:
    return await handle_truffle_summary_get(ctx)


@agent.on_rest_post("/summary", HUDQuery, HUDResponse)
async def handle_summary_post(ctx: Context, msg: HUDQuery) -> HUDResponse:
    return await handle_truffle_summary_post(ctx, msg)


@agent.on_interval(period=900.0)
async def periodic_truffle_refresh(ctx: Context):
    """Every 15 minutes, refresh the Truffle summary cache with live inference.
    """
    try:
        loop = asyncio.get_running_loop()
        summary, source, _ = await loop.run_in_executor(
            None, lambda: get_or_refresh_truffle_model_summary(force_refresh=False)
        )
        ctx.logger.info(f"Periodic Truffle Model Summary check [{source}]")
    except Exception as e:
        ctx.logger.warning(f"Periodic Truffle summary refresh failed: {e}")


@agent.on_event("startup")
async def startup(ctx: Context):
    connected = client.connect()
    if connected:
        ctx.logger.info(f"WeCryp ready — {len(client.tools)} MCP tools loaded")
    else:
        ctx.logger.warning("MCP connect failed — agent running without tools")

    agentverse_key = os.getenv("AGENTVERSE_KEY")
    if agentverse_key:
        try:
            from uagents.mailbox import (
                AgentverseConnectRequest,
                RegistrationRequest,
                register_in_agentverse,
            )
            req = AgentverseConnectRequest(user_token=agentverse_key, agent_type="uagent")
            profile = agent._build_registration_profile()
            reg_data = RegistrationRequest(
                address=agent.address,
                name=agent.name,
                handle="truffz",
                url=None,
                profile=profile,
                endpoints=agent._endpoints,
                protocols=list(agent.protocols.keys()),
                metadata=agent.metadata,
            )
            res = await register_in_agentverse(
                request=req,
                identity=agent._identity,
                prefix=agent._prefix,
                agentverse=agent._agentverse,
                agent_details=reg_data,
            )
            if res.success:
                ctx.logger.info("Auto-registered in Agentverse successfully via AGENTVERSE_KEY")
            else:
                ctx.logger.warning(f"Agentverse auto-registration detail: {res.detail}")
        except Exception as ex:
            ctx.logger.warning(f"Agentverse auto-registration error: {ex}")

@agent.on_event("shutdown")
async def shutdown(ctx: Context):
    client.close()

agent.include(chat_proto, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
