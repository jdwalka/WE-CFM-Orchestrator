#!/usr/bin/env python3
"""
LME-CODEX — Ladder Memory Engine, Codex edition
================================================
Four-force physics on price:
  1. Rung potential wells  (Gaussian attraction at round numbers + Kalshi band edges)
  2. Anti-gravity recoil   (velocity-gated repulsion — the H-pattern)
  3. Damped spring MR      (underdamped oscillator, zeta<1 → overshoot)
  4. Memory kernel         (rung strength decays + touch reinforcement)

Usage:
    python lme_codex.py              # MOCK mode (synthetic tape, runs anywhere)
    python lme_codex.py --live       # LIVE: Coinbase spot + Kalshi bands via ladder worker
    python lme_codex.py --live --interval 5

Live feeds (all public / read-only):
    Spot:      Coinbase REST /v2/prices/BTC-USD/spot
    L2 book:   Coinbase Exchange /products/BTC-USD/book?level=2
    Band edges: https://kalshi-ladder-worker.gitgoin87.workers.dev/edges
                (falls back to https://api.elections.kalshi.com/... if worker down)

NEVER places orders. Read-only state machine.
"""

import argparse
import json
import math
import time
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

# ─────────────────────────────────────────────────────────────
# CONFIG — hand-tuned first pass; earn params from calibration
# ─────────────────────────────────────────────────────────────

CFG = {
    "round_step":       100.0,   # rung spacing ($)
    "proximity":        250.0,   # rung relevance radius ($)
    "touch_tol":         15.0,   # touch detection tolerance ($)
    "decay_lambda":       0.02,  # memory decay per min (half-life ≈ 35 min)
    "v_gate":             8.0,   # anti-gravity velocity gate ($/min)
    "k_bg":               2.5,   # recoil force constant
    "omega":              0.15,  # spring stiffness (rad/min)
    "zeta":               0.35,  # damping ratio (<1 = underdamped = H overshoot)
    "wall_band":         30.0,   # order-book scan band around rung ($)
    "arm_threshold":      0.5,   # |f_recoil| to ARM signal
    "median_range":     341.63,  # trailing median hourly BTC range ($) — recalibrate weekly
    "p75_range":        466.10,  # trailing 75th pct hourly range ($)
}

# Feed endpoints
COINBASE_SPOT  = "https://api.coinbase.com/v2/prices/BTC-USD/spot"
COINBASE_BOOK  = "https://api.exchange.coinbase.com/products/BTC-USD/book?level=2"
KALSHI_WORKER  = "https://kalshi-ladder-worker.gitgoin87.workers.dev/edges"
KALSHI_DIRECT  = ("https://api.elections.kalshi.com/trade-api/v2/markets"
                  "?series_ticker=KXBTC&status=open&limit=100")


# ─────────────────────────────────────────────────────────────
# DATA LAYER
# ─────────────────────────────────────────────────────────────

def http_get(url: str, timeout: float = 5.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "LME-Codex/2.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def fetch_spot() -> float:
    """Coinbase spot (BRTI proxy — this IS the settlement-relevant price)."""
    return float(http_get(COINBASE_SPOT)["data"]["amount"])


def fetch_book(depth_levels: int = 50):
    """Coinbase L2 → (bids, asks) as [(price, notional), ...]"""
    book = http_get(COINBASE_BOOK)
    bids = [(float(p), float(p) * float(s)) for p, s, _ in book["bids"][:depth_levels]]
    asks = [(float(p), float(p) * float(s)) for p, s, _ in book["asks"][:depth_levels]]
    return bids, asks


def fetch_band_edges() -> list[float]:
    """
    Kalshi KXBTC hourly band edges — the real structural walls.
    Returns flat list of price levels (both low and high edge of each band).
    Primary: our ladder worker (5s cache, fast). Fallback: Kalshi API direct.
    """
    # Primary: ladder worker /edges endpoint
    try:
        data = http_get(KALSHI_WORKER, timeout=3.0)
        edges = []
        for e in data.get("edges", []):
            edges.extend([e["low"], e["high"]])
        if edges:
            return edges
    except Exception:
        pass

    # Fallback: Kalshi API direct
    try:
        data = http_get(KALSHI_DIRECT, timeout=5.0)
        edges = []
        for m in data.get("markets", []):
            if m.get("strike_type") != "between":
                continue
            lo = m.get("floor_strike")
            hi = m.get("cap_strike")
            if lo is not None:
                edges.append(float(lo))
            if hi is not None:
                edges.append(float(hi))
        return edges
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────
# PHYSICS CORE
# ─────────────────────────────────────────────────────────────

@dataclass
class Rung:
    level: float
    strength: float = 1.0
    sigma: float = 15.0
    touches: int = 0
    last_touch_t: float = 0.0
    wall_depth: float = 0.0       # $-notional resting in ±wall_band
    wall_pressure: float = 0.0   # +1 = bid wall, -1 = ask wall
    kind: str = "round"           # "round" | "band_edge"


def detect_rungs(price: float, band_edges: list[float]) -> list[Rung]:
    """Round-number rungs ± band edge rungs within proximity."""
    rungs, seen = [], set()
    base = math.floor(price / CFG["round_step"]) * CFG["round_step"]
    for k in (-2, -1, 0, 1, 2):
        lvl = base + k * CFG["round_step"]
        if abs(lvl - price) <= CFG["proximity"]:
            rungs.append(Rung(
                level=lvl,
                sigma=CFG["round_step"] * 0.15,
                kind="round",
            ))
            seen.add(round(lvl, 2))
    for e in band_edges:
        lvl = float(e)
        if abs(lvl - price) <= CFG["proximity"] and round(lvl, 2) not in seen:
            rungs.append(Rung(
                level=lvl,
                strength=1.5,                     # band edges are stronger structural walls
                sigma=CFG["round_step"] * 0.10,   # tighter pull radius
                kind="band_edge",
            ))
    return rungs


def wall_scan(rung: Rung, bids: list, asks: list) -> None:
    """Resting notional within ±wall_band — mutates rung in place."""
    band = CFG["wall_band"]
    bid_notional = sum(sz for p, sz in bids if abs(p - rung.level) <= band)
    ask_notional = sum(sz for p, sz in asks if abs(p - rung.level) <= band)
    total = bid_notional + ask_notional
    rung.wall_depth    = total
    rung.wall_pressure = (bid_notional - ask_notional) / total if total > 0 else 0.0


def anti_gravity(price: float, velocity: float, rung: Rung) -> float:
    """
    F_bg = -k_bg · speed_gate · G(x-x_rung) · strength · sign(-v)
    Velocity-gated: slow drift → ~0 force (rung breaks, trend regime).
    Fast tag (v > v_gate) → full recoil → H-pattern.
    """
    gate   = math.exp(-((price - rung.level) ** 2) / (2 * (rung.sigma * 0.5) ** 2))
    speed  = min(abs(velocity) / CFG["v_gate"], 1.0)
    dirn   = -math.copysign(1.0, velocity) if velocity != 0 else 0.0
    return CFG["k_bg"] * speed * gate * dirn * rung.strength


def spring_accel(price: float, velocity: float, rung: Rung) -> float:
    """
    ẍ = -ω²(x - x_rung) - 2ζωv
    zeta < 1 → underdamped → H-pattern overshoot
    """
    return (-(CFG["omega"] ** 2) * (price - rung.level)
            - 2 * CFG["zeta"] * CFG["omega"] * velocity)


def regime(current_range: float) -> str:
    """
    Master switch. The physics is only trustworthy in chop.
    Above p75 → trend → ignore all rung signals (rungs break, not recoil).
    """
    if current_range > CFG["p75_range"]:
        return "TREND — rungs break, recoil signals DISABLED"
    if current_range < 0.5 * CFG["median_range"]:
        return "DEAD CHOP — max recoil probability, H-pattern strongest"
    return "NORMAL — recoil favored, size down"


# ─────────────────────────────────────────────────────────────
# ENGINE
# ─────────────────────────────────────────────────────────────

@dataclass
class LME:
    """Ladder Memory Engine — stateful, step() per tick."""
    rungs:      list  = field(default_factory=list)
    hist:       deque = field(default_factory=lambda: deque(maxlen=600))
    last_price: Optional[float] = None
    last_t:     Optional[float] = None
    hour_open:  Optional[float] = None

    def step(self, price: float, t: float, bids: list, asks: list,
             band_edges: list[float]) -> dict:
        if self.hour_open is None:
            self.hour_open = price
        current_range = abs(price - self.hour_open)

        # velocity ($/min) from finite difference
        v = 0.0
        if self.last_price is not None and self.last_t and t > self.last_t:
            v = (price - self.last_price) / (t - self.last_t) * 60.0

        # refresh rungs + update memory + wall scan
        self.rungs = detect_rungs(price, band_edges)
        for r in self.rungs:
            if self.last_price is not None and r.last_touch_t:
                dt_min = (t - r.last_touch_t) / 60.0
                r.strength *= math.exp(-CFG["decay_lambda"] * max(dt_min, 0))
            if self.last_price is not None and abs(r.level - self.last_price) <= CFG["touch_tol"]:
                r.touches   += 1
                r.strength  += 0.4 * (1 + 0.1 * r.touches)   # superlinear reinforcement
                r.last_touch_t = t
            wall_scan(r, bids, asks)

        nearest  = min(self.rungs, key=lambda r: abs(r.level - price))
        f_recoil = anti_gravity(price, v, nearest)
        f_spring = spring_accel(price, v, nearest)

        self.hist.append((t, price, v))
        self.last_price, self.last_t = price, t

        trend_regime = current_range > CFG["p75_range"]
        armed        = abs(f_recoil) > CFG["arm_threshold"] and not trend_regime

        return {
            "spot":           price,
            "vel_min":        round(v, 1),
            "range_so_far":   round(current_range, 1),
            "regime":         regime(current_range),
            "nearest_rung":   nearest.level,
            "rung_kind":      nearest.kind,
            "dist":           round(price - nearest.level, 1),
            "rung_touches":   nearest.touches,
            "rung_strength":  round(nearest.strength, 2),
            "wall_depth_usd": round(nearest.wall_depth, 0),
            "wall_pressure":  round(nearest.wall_pressure, 2),
            "f_recoil":       round(f_recoil, 3),
            "f_spring":       round(f_spring, 3),
            "signal":         "ARMED" if armed else ("REGIME_OFF" if trend_regime else "idle"),
            "read":           self._interpret(nearest, v, f_recoil, armed, trend_regime),
            "all_rungs":      [
                {"level": r.level, "kind": r.kind, "strength": round(r.strength, 2),
                 "wall": round(r.wall_depth, 0), "dist": round(price - r.level, 1)}
                for r in self.rungs
            ],
        }

    @staticmethod
    def _interpret(r: Rung, v: float, f_recoil: float, armed: bool,
                   trend: bool) -> str:
        if trend:
            return "TREND regime — rung signals suppressed, rungs break not recoil"
        if armed:
            side    = "DOWN-recoil (H)" if f_recoil > 0 else "UP-recoil (inverted H)"
            wall    = "bid" if r.wall_pressure > 0 else "ask"
            wall_sz = r.wall_depth
            return (f"ARMED: v={v:+.0f}/min into {wall} wall "
                    f"${wall_sz:,.0f} @ {r.level:.0f} [{r.kind}] → expect {side}")
        if abs(v) >= CFG["v_gate"] * 0.7:
            return f"approaching {r.level:.0f} at speed — watch for gate open"
        if r.wall_depth < 50_000:
            return f"{r.level:.0f} NO wall (${r.wall_depth:,.0f}) — fast break will NOT recoil"
        return (f"idle — drift toward {r.level:.0f}, "
                f"wall {'solid' if r.wall_depth > 200_000 else 'thin'} "
                f"${r.wall_depth:,.0f}")


# ─────────────────────────────────────────────────────────────
# MOCK TAPE — synthetic chop with rung tag at step 12
# ─────────────────────────────────────────────────────────────

def mock_tape(i: int, base: float = 76_674.0) -> float:
    import random
    random.seed(i)
    drift = 0.0
    if i in (10, 11, 12):
        drift = 30.0   # fast push into the 76,700 rung
    if i in (13, 14, 15):
        drift = -25.0  # the H-recoil
    return base + drift + random.uniform(-8, 8)


def mock_book(price: float):
    bids = [(price - d, (price - d) * (2.0 + (d % 7))) for d in range(5, 150, 5)]
    asks = [(price + d, (price + d) * (2.0 + (d % 5))) for d in range(5, 150, 5)]
    # Stack a real ask wall just above 76,700 — the setup that fires ARMED
    asks += [(76_706.9, 76_706.9 * 660.0), (76_709.5, 76_709.5 * 316.0)]
    return bids, asks


# ─────────────────────────────────────────────────────────────
# MAIN LOOP
# ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="LME-Codex Ladder Memory Engine")
    ap.add_argument("--live",     action="store_true", help="Use live feeds")
    ap.add_argument("--interval", type=float, default=10.0, help="Poll interval seconds")
    ap.add_argument("--verbose",  action="store_true", help="Show all rungs table")
    args = ap.parse_args()

    engine = LME()
    mode   = "LIVE" if args.live else "MOCK"

    print("=" * 72)
    print(f"LME-CODEX v2.0 — Ladder Memory Engine [{mode}] | read-only")
    print("=" * 72)
    if args.live:
        print("  Spot:  Coinbase REST  |  Book: Coinbase L2  |  Bands: Kalshi ladder worker")
    else:
        print("  Synthetic tape — fast tag into $76,700 wall at step 12 → watch ARMED fire")
    print()

    i = 0
    try:
        while True:
            t = time.time()
            if args.live:
                try:
                    price      = fetch_spot()
                    bids, asks = fetch_book()
                    edges      = fetch_band_edges()
                    if not edges:
                        print("  [WARN] Kalshi returned 0 band edges — using round-number rungs only")
                except Exception as e:
                    print(f"  [feed error: {e}] retrying in {args.interval}s...")
                    time.sleep(args.interval)
                    continue
            else:
                price      = mock_tape(i)
                bids, asks = mock_book(price)
                edges      = [76_500, 76_600, 76_700, 76_800, 76_900]

            out = engine.step(price, t, bids, asks, edges)

            # ── output ─────────────────────────────────────────────────────
            print(f"\n[{time.strftime('%H:%M:%S')}]  step={i:03d}  "
                  f"spot=${out['spot']:,.1f}  v={out['vel_min']:+.0f}/min  "
                  f"range={out['range_so_far']:.0f}")
            print(f"  regime : {out['regime']}")
            print(f"  rung   : ${out['nearest_rung']:,.0f} [{out['rung_kind']}]  "
                  f"dist={out['dist']:+.1f}  "
                  f"touches={out['rung_touches']}  strength={out['rung_strength']:.2f}")
            print(f"  wall   : ${out['wall_depth_usd']:>12,.0f}  "
                  f"pressure={out['wall_pressure']:+.2f}  "
                  f"({'bid wall ▲' if out['wall_pressure'] > 0.1 else 'ask wall ▼' if out['wall_pressure'] < -0.1 else 'no wall'})")
            print(f"  forces : recoil={out['f_recoil']:+.3f}  spring={out['f_spring']:+.3f}")
            sig_bar = "🔴 ARMED" if out['signal'] == "ARMED" else ("⚪ REGIME_OFF" if out['signal'] == "REGIME_OFF" else "⚫ idle")
            print(f"  signal : {sig_bar}")
            print(f"  read   : {out['read']}")

            if args.verbose:
                print(f"  {'RUNG':>10}  {'KIND':>10}  {'DIST':>8}  {'STRENGTH':>9}  {'WALL $':>12}")
                for r in out["all_rungs"]:
                    print(f"  {r['level']:>10,.0f}  {r['kind']:>10}  "
                          f"{r['dist']:>+8.1f}  {r['strength']:>9.2f}  {r['wall']:>12,.0f}")

            i += 1
            time.sleep(args.interval)

    except KeyboardInterrupt:
        print("\n[stopped]")


if __name__ == "__main__":
    main()
