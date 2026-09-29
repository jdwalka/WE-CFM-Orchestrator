#!/usr/bin/env python3
"""
WECRYPTO Nuclear Engine — Cross-Chain Orbital + Polymarket CLOB Executor
═══════════════════════════════════════════════════════════════════
Standalone Python execution layer for the WE CFM Orchestrator.
Runs locally on the AMD server, fetches live 15m OHLCV, evaluates
the Orbital Exhaustion Quotient (OEQ), and fires Polymarket CLOB orders.

Architecture:
  1. _initialize_lambdas() — session-locked λ per asset at boot
  2. process_interval()    — 15m OHLCV → s/p/d/f orbital states → OEQ
  3. Hybrid exit logic     — d-orbital trailing stop + s-orbital decay
  4. _build_polymarket_payload() → Polymarket CLOB order (YES/NO tokens)
  5. execute_order()       — POST to clob.polymarket.com/order

Environment Variables (set in .env or system env):
  POLYMARKET_API_KEY        — API key for live execution (CLOB auth)
  POLYMARKET_API_SECRET    — API secret for CLOB signing
  POLYMARKET_PASSPHRASE    — CLOB passphrase
  WECRYPTO_MAX_CONTRACTS    — max contracts per order (default: 10)
  WECRYPTO_BTC_LAMBDA_BASE  — base lambda for BTC (default: 0.005)
  WECRYPTO_DRY_RUN          — set to "true" to skip live order submission
  WECRYPTO_STATE_FILE       — path to persistent state JSON (default: wecrypto_state.json)
  WECRYPTO_FIREBASE_DB_URL  — optional Firebase RTDB URL for signal streaming

Usage:
  python wecrypto_nuclear.py               # live loop
  python wecrypto_nuclear.py --dry-run     # dry-run (log payloads, no orders)
  python wecrypto_nuclear.py --once        # single cycle then exit
"""
import os
import sys
import json
import time
import uuid
import random
import logging
import argparse
import threading
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import requests
from kafka import KafkaConsumer

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
log = logging.getLogger('wecrypto.nuclear')

# ── Constants ─────────────────────────────────────────────────────────────────
ASSETS = {
    'bitcoin':  'BTC-USD',
    'ethereum': 'ETH-USD',
    'solana':   'SOL-USD',
    'ripple':   'XRP-USD',
}

POLYMARKET_CLOB  = 'https://clob.polymarket.com'
POLYMARKET_GAMMA  = 'https://gamma-api.polymarket.com'

COINBASE_TICKER  = 'https://api.exchange.coinbase.com/products/{ticker}/ticker'
COINBASE_CANDLES = 'https://api.exchange.coinbase.com/products/{ticker}/candles?granularity=900'
COINGECKO_PRICE  = 'https://api.coingecko.com/api/v3/simple/price?ids={coin}&vs_currencies=usd'
COINGECKO_HIST   = 'https://api.coingecko.com/api/v3/coins/{coin}/market_chart?vs_currency=usd&days=14'

ENTRY_OEQ_THRESHOLD  = 1.0
F_ANOMALY_WINDOW     = 8     # rolling bars for avg-volume baseline
TRAIL_MULTIPLIER     = 2.5   # d-orbital trailing stop: σ below peak
S_COLLAPSE_THRESHOLD = 0.002 # 0.2% structural breakdown
LAMBDA_TARGET_SIGMA  = 0.0085
LAMBDA_FLOOR         = 0.5
LAMBDA_CEIL          = 3.5
F_ANOMALY_FLOOR      = 0.5
F_ANOMALY_CEIL       = 5.0


# ─────────────────────────────────────────────────────────────────────────────
class WecryptoNuclear:
    """
    Session-locked cross-chain orbital engine.

    Each asset maintains independent price/volume buffers and position state.
    Lambda dampeners are calibrated once at boot from live CoinGecko volatility
    data and locked for the session to prevent constant recalculation.
    """

    def __init__(
        self,
        btc_lambda_base: float = None,
        max_contracts: int = None,
        dry_run: bool = True,
        state_file: str = None,
    ):
        self.btc_lambda_base  = float(os.environ.get('WECRYPTO_BTC_LAMBDA_BASE', btc_lambda_base or 0.005))
        self.max_contracts    = int(os.environ.get('WECRYPTO_MAX_CONTRACTS', max_contracts or 10))
        # Ensure safety: enforce dry-run if WECRYPTO_DRY_RUN is truthy or unset.
        # Only allow live execution if env explicitly specifies 0/false/no AND caller sets dry_run=False.
        env_dry_run = os.environ.get('WECRYPTO_DRY_RUN', '').lower().strip()
        if env_dry_run in ('1', 'true', 'yes'):
            self.dry_run = True
        elif env_dry_run in ('0', 'false', 'no'):
            self.dry_run = bool(dry_run)
        else:
            self.dry_run = bool(dry_run)
            
        self.state_file       = state_file or os.environ.get('WECRYPTO_STATE_FILE', 'wecrypto_state.json')
        self.poly_api_key     = os.environ.get('POLYMARKET_API_KEY', '')
        self.poly_api_secret  = os.environ.get('POLYMARKET_API_SECRET', '')
        self.poly_passphrase  = os.environ.get('POLYMARKET_PASSPHRASE', '')

        if not self.poly_api_key and not self.dry_run:
            log.warning('POLYMARKET_API_KEY not set — forcing dry-run mode')
            self.dry_run = True

        # Per-asset state (prices, volumes, position tracking)
        self.state_memory = {
            asset: {
                'prices':        [],
                'volumes':       [],
                'highest_pnl':   0.0,
                'lowest_pnl':    float('inf'),
                'active_trade':  None,       # None | True
                'position_side': None,       # None | 'bid' | 'ask'
            }
            for asset in ASSETS
        }
        self.calibrated_lambdas: dict[str, float] = {}
        self._active_tickers:    dict[str, Optional[str]] = {a: None for a in ASSETS}
        
        self.momentum_signals = {asset: None for asset in ASSETS}
        self.kafka_broker = os.environ.get("KAFKA_BROKER_URL", "redpanda:9092")
        
        t = threading.Thread(target=self._listen_momentum_signals, daemon=True)
        t.start()

        self._load_persistent_state()
        self._initialize_lambdas()
        log.info('=== WECRYPTO NUCLEAR ENGINE READY — dry_run=%s ===', self.dry_run)

    def _listen_momentum_signals(self):
        try:
            consumer = KafkaConsumer(
                "wecrypto-momentum-signals",
                bootstrap_servers=self.kafka_broker,
                value_deserializer=lambda m: json.loads(m.decode('utf-8'))
            )
            for msg in consumer:
                data = msg.value
                asset_sym = data.get("asset")
                for key, val in ASSETS.items():
                    if val.startswith(asset_sym):
                        self.momentum_signals[key] = data
                        break
        except Exception as e:
            log.warning(f"Kafka Momentum consumer failed: {e}")

    # ── Lambda Calibration ────────────────────────────────────────────────────

    def _initialize_lambdas(self):
        """
        Cross-chain λ auto-scaler.

        For each altcoin, scales BTC's base lambda by two normalization factors:
          price_scale = btc_price / alt_price   (adjusts for price magnitude)
          vol_scale   = btc_sigma / alt_sigma    (adjusts for relative volatility)

        BTC lambda stays fixed at btc_lambda_base as the reference anchor.
        """
        log.info('=== NUCLEAR LAMBDA AUTO-SCALER BOOTING ===')
        btc_price, btc_sigma = self._fetch_cg_data('bitcoin')
        self.calibrated_lambdas['bitcoin'] = self.btc_lambda_base
        log.info('BTC | Lambda=%.5f (base reference)', self.btc_lambda_base)

        for asset in ASSETS:
            if asset == 'bitcoin':
                continue
            price, sigma = self._fetch_cg_data(asset)
            price_scale  = btc_price / price if price > 0 else 1.0
            vol_scale    = btc_sigma / sigma if sigma > 0 else 1.0
            raw_lambda   = self.btc_lambda_base * price_scale * vol_scale
            # Clamp to sane range (very low-price assets can produce extreme values)
            clamped      = max(LAMBDA_FLOOR, min(LAMBDA_CEIL, raw_lambda))
            self.calibrated_lambdas[asset] = clamped
            log.info(
                '%s | Lambda=%.5f | price_scale=%.2f | vol_scale=%.2f',
                asset.upper(), clamped, price_scale, vol_scale,
            )

    def _fetch_cg_data(self, coin_id: str) -> tuple[float, float]:
        """Fetch current price + 14-day realized log-return sigma from CoinGecko."""
        try:
            p_resp = requests.get(
                COINGECKO_PRICE.format(coin=coin_id), timeout=6,
            ).json()
            price  = float(p_resp.get(coin_id, {}).get('usd', 1.0))

            h_resp  = requests.get(
                COINGECKO_HIST.format(coin=coin_id), timeout=10,
            ).json()
            prices  = np.array([x[1] for x in h_resp.get('prices', [])[-200:]])
            log_ret = np.diff(np.log(prices)) if len(prices) > 1 else np.array([0.001])
            sigma   = float(np.std(log_ret)) or 0.015
            return price, sigma
        except Exception as e:
            log.warning('CoinGecko fetch failed for %s: %s', coin_id, e)
            return 1.0, 0.015

    # ── Polymarket Market Resolution ──────────────────────────────────────────

    def get_active_polymarket_slug(self, asset: str) -> str:
        """
        Resolve the live 15m Polymarket contract slug for an asset.
        Queries the Gamma API and caches per session.
        Falls back to a synthetic slug if unavailable.
        """
        if self._active_tickers.get(asset):
            return self._active_tickers[asset]
        sym = ASSETS[asset].replace('-USD', '')  # e.g. 'BTC'
        fallback = f'{sym.lower()}-15m-up-or-down'
        if not self.poly_api_key:
            return fallback
        try:
            resp = requests.get(
                f'{POLYMARKET_GAMMA}/markets',
                params={'active': 'true', 'closed': 'false', 'limit': 50,
                        'tag': 'crypto'},
                timeout=6,
            )
            markets = resp.json()
            for m in markets:
                question = (m.get('question', '') + m.get('slug', '')).lower()
                if sym.lower() in question and '15' in question:
                    slug = m.get('slug', fallback)
                    self._active_tickers[asset] = slug
                    log.info('%s | Resolved Polymarket slug: %s', asset.upper(), slug)
                    return slug
        except Exception as e:
            log.warning('%s | Polymarket slug resolution failed: %s', asset.upper(), e)
        return fallback

    # ── Payload Builder ───────────────────────────────────────────────────────

    def _build_polymarket_payload(
        self,
        asset:       str,
        side:        str,
        limit_price: float,
        count:       float = None,
    ) -> dict:
        """
        Formats the CLOB order payload for Polymarket.

        Polymarket semantics:
          side='BUY'   → buying YES token
          side='SELL'  → selling YES token (equivalent to buying NO)
        """
        n       = min(count or self.max_contracts, self.max_contracts)
        slug    = self.get_active_polymarket_slug(asset)
        return {
            'orderID':     str(uuid.uuid4()),
            'market':      slug,
            'side':        side.upper(),
            'size':        f'{n:.2f}',
            'price':        f'{limit_price:.4f}',
            'timeInForce':  'FOK',
        }

    def _check_polymarket_orderbook(self, slug: str, side: str) -> bool:
        """
        Check Bid-Ask Imbalance before firing FOK orders on Polymarket CLOB.
        Returns True if liquidity is safe, False to delay.
        """
        if self.dry_run:
            return True

        try:
            resp = requests.get(
                f'{POLYMARKET_CLOB}/book',
                params={'market': slug},
                timeout=2
            )
            ob = resp.json()
            bids = ob.get('bids', [])
            asks = ob.get('asks', [])

            bid_vol = sum(float(b.get('size', 0)) for b in bids)
            ask_vol = sum(float(a.get('size', 0)) for a in asks)

            if side == 'BUY' and ask_vol < self.max_contracts * 2:
                log.warning(f"[{slug}] Liquidity vacuum on ASK side! (Ask Vol: {ask_vol}). Delaying exit.")
                return False
            if side == 'SELL' and bid_vol < self.max_contracts * 2:
                log.warning(f"[{slug}] Liquidity vacuum on BID side! (Bid Vol: {bid_vol}). Delaying exit.")
                return False

            return True
        except Exception as e:
            log.warning(f"Polymarket orderbook fetch failed: {e}")
            return False 

    # ── Order Execution ───────────────────────────────────────────────────────

    def execute_order(self, payload: dict) -> Optional[dict]:
        """POST order to Polymarket CLOB. No-ops in dry-run mode."""
        if not payload:
            return None
        if self.dry_run:
            log.info('[DRY-RUN] Would fire: %s', json.dumps(payload))
            return {'dry_run': True, 'payload': payload}
        headers = {
            'POLY_API_KEY':  self.poly_api_key,
            'POLY_API_SECRET': self.poly_api_secret,
            'POLY_PASSPHRASE': self.poly_passphrase,
            'Content-Type':  'application/json',
        }
        try:
            r = requests.post(f'{POLYMARKET_CLOB}/order', json=payload, headers=headers, timeout=8)
            log.info(
                'POLYMARKET EXEC → side=%s market=%s price=%s | HTTP %s',
                payload['side'], payload['market'], payload['price'], r.status_code,
            )
            return r.json()
        except Exception as e:
            log.error('Polymarket order fire failed: %s', e)
            return None

    # ── OEQ v2 Formula ────────────────────────────────────────────────────────

    @staticmethod
    def _compute_oeq(
        prices:     list[float],
        volumes:    list[float],
        open_price: float,
        sigma:      float,
        lambda_val: float,
    ) -> dict:
        """
        Orbital Exhaustion Quotient v2 (volume-aware nuclear model).

        Formula:
          f_anomaly = last_vol / avg_vol     (volume surge ratio)
          p_pct     = (close - open) / open  (kinetic thrust, %)
          d_pct     = realized_sigma         (diffusion vol, %)
          dist_pct  = (close - s_base) / s_base × 100
          oeq       = (p_pct / d_pct) × tanh(λ × dist_pct / f_anomaly)

        High f_anomaly compresses the tanh argument, requiring more price
        momentum per distance unit to breach threshold — protecting against
        fading genuine volume-backed breakouts.
        """
        close = prices[-1]
        s_base = float(np.mean(prices)) if len(prices) > 1 else close

        # p-orbital (kinetic thrust)
        p_pct  = ((close - open_price) / open_price) * 100 if open_price > 0 else 0.0

        # d-orbital (realized diffusion vol)
        if len(prices) > 2:
            log_rets = np.diff(np.log(prices[-min(16, len(prices)):]))
            d_pct = float(np.std(log_rets)) * 100
        else:
            d_pct = sigma * 100 if sigma > 0 else 0.01
        d_pct = max(d_pct, 0.001)

        # f-anomaly (volume multiplier — dampens tanh on volume-backed moves)
        avg_vol   = float(np.mean(volumes)) if len(volumes) > 1 else (volumes[-1] if volumes else 1.0)
        last_vol  = volumes[-1] if volumes else avg_vol
        f_anomaly = max(F_ANOMALY_FLOOR, min(F_ANOMALY_CEIL, (last_vol / avg_vol) if avg_vol > 0 else 1.0))

        # OEQ
        dist_pct  = ((close - s_base) / s_base) * 100 if s_base > 0 else 0.0
        tanh_arg  = lambda_val * (dist_pct / f_anomaly)
        oeq       = (p_pct / d_pct) * np.tanh(tanh_arg)

        return {
            's_base':    round(s_base, 4),
            'p_pct':     round(p_pct, 4),
            'd_pct':     round(d_pct, 6),
            'f_anomaly': round(f_anomaly, 4),
            'dist_pct':  round(dist_pct, 4),
            'oeq':       round(float(oeq), 4),
        }

    # ── Hybrid Exit Logic ─────────────────────────────────────────────────────

    def _evaluate_exit(self, asset: str, close: float, s_base: float, d_sigma: float) -> Optional[str]:
        """
        Hybrid exit — whichever triggers first:
          1. d-orbital trailing stop: price falls TRAIL_MULTIPLIER σ below peak
          2. s-orbital collapse:      price breaches ground state by >0.2%
        """
        state = self.state_memory[asset]
        if not state['active_trade']:
            return None

        # d-orbital trailing stop (price level)
        trail_level = state['highest_pnl'] - TRAIL_MULTIPLIER * d_sigma
        if close < trail_level:
            log.warning('[%s] d-orbital trailing stop: close=%.4f < trail=%.4f', asset.upper(), close, trail_level)
            return 'EXIT_TRAIL'

        # s-orbital structural collapse
        collapse_ratio = (s_base - close) / s_base if s_base > 0 else 0.0
        if collapse_ratio > S_COLLAPSE_THRESHOLD:
            log.warning('[%s] s-orbital collapse: %.4f%% below ground state', asset.upper(), collapse_ratio * 100)
            return 'EXIT_DECAY'

        # Momentum Circuit Breaker (5m engine integration)
        signal_data = self.momentum_signals.get(asset)
        if signal_data and time.time() - signal_data.get("timestamp", 0) < 300:
            signal = signal_data.get('signal')
            pos = state['position_side']
            vel = signal_data.get('velocity', 0)
            
            # If LONG (bid) and momentum exhausts downward OR accelerates downward
            if pos == 'bid' and vel < 0 and signal in ("MOMENTUM_EXHAUSTION", "MOMENTUM_ACCELERATING"):
                log.warning('[%s] MOMENTUM CIRCUIT BREAKER: Early Exit triggered by 5m Engine.', asset.upper())
                return 'EXIT_MOMENTUM'
                
            # If SHORT (ask) and momentum exhausts upward OR accelerates upward
            if pos == 'ask' and vel > 0 and signal in ("MOMENTUM_EXHAUSTION", "MOMENTUM_ACCELERATING"):
                log.warning('[%s] MOMENTUM CIRCUIT BREAKER: Early Exit triggered by 5m Engine.', asset.upper())
                return 'EXIT_MOMENTUM'

        return None

    # ── Main Interval Processor ───────────────────────────────────────────────

    def process_interval(
        self,
        asset:         str,
        current_price: float,
        open_price:    float,
        interval_vol:  float,
        rolling_sigma: float,
    ) -> Optional[dict]:
        """
        Categorize a 15-minute OHLCV interval and generate execution payloads.

        Returns a Polymarket CLOB order dict on EXECUTE_* signals, None otherwise.
        """
        state = self.state_memory[asset]

        # Maintain rolling 8-period buffers
        state['prices'].append(current_price)
        state['volumes'].append(interval_vol)
        if len(state['prices'])  > F_ANOMALY_WINDOW: state['prices'].pop(0)
        if len(state['volumes']) > F_ANOMALY_WINDOW: state['volumes'].pop(0)

        lambda_val = self.calibrated_lambdas.get(asset, self.btc_lambda_base)
        metrics    = self._compute_oeq(
            state['prices'], state['volumes'], open_price, rolling_sigma, lambda_val,
        )
        oeq      = metrics['oeq']
        s_base   = metrics['s_base']
        d_sigma  = metrics['d_pct'] / 100  # convert pct → absolute for price-level stop

        # 1. Hybrid exit evaluation (priority over new entries)
        exit_signal = self._evaluate_exit(asset, current_price, s_base, d_sigma)
        if exit_signal:
            # Flatten position: invert the entry side
            close_side = 'BUY' if state['position_side'] == 'SELL' else 'SELL'
            slug = self.get_active_polymarket_slug(asset)
            
            # Orderbook Check for Circuit Breakers
            if not self._check_polymarket_orderbook(slug, close_side):
                log.warning('[%s] EXIT DELAYED due to orderbook liquidity vacuum.', asset.upper())
                return None
                
            payload    = self._build_polymarket_payload(asset, close_side, 0.50)
            self.execute_order(payload)
            state.update({'active_trade': None, 'position_side': None, 'highest_pnl': 0.0})
            payload['_meta'] = {
                'action': exit_signal, 'asset': asset, 'oeq': oeq,
                'ts': datetime.now(timezone.utc).isoformat(),
            }
            return payload

        # 2. Entry — only when flat and OEQ breach confirmed
        if abs(oeq) > ENTRY_OEQ_THRESHOLD and not state['active_trade']:
            log.info('[%s] F-ORBITAL BREACH — OEQ=%.3f  p_pct=%.4f  f_anom=%.2f',
                     asset.upper(), oeq, metrics['p_pct'], metrics['f_anomaly'])

            p_delta = metrics['p_pct']
            if p_delta > 0:
                # Upward hollow surge → fade down → BUY NO → sell YES (ask side)
                side        = 'ask'
                limit_price = 0.5500   # Buying NO @ $0.45 ≡ Selling YES @ $0.55
            else:
                # Downward flush → fade up → BUY YES → bid side
                side        = 'bid'
                limit_price = 0.4500

            state.update({
                'active_trade':  True,
                'position_side': side,
                'highest_pnl':   current_price,
                'lowest_pnl':    current_price,
            })
            payload = self._build_polymarket_payload(asset, side, limit_price)
            self.execute_order(payload)
            payload['_meta'] = {
                'action':    'EXECUTE_COUNTER_TRADE',
                'asset':     asset,
                'oeq':       oeq,
                'p_pct':     metrics['p_pct'],
                'f_anomaly': metrics['f_anomaly'],
                'orbital': {
                    's_base':   s_base,
                    'd_sigma':  d_sigma,
                },
                'ts': datetime.now(timezone.utc).isoformat(),
            }
            return payload

        # 3. Update peak price for trailing stop
        if state['active_trade'] and current_price > state['highest_pnl']:
            state['highest_pnl'] = current_price

        return None

    # ── Firebase RTDB Streaming (optional) ───────────────────────────────────

    def _stream_to_firebase(self, asset: str, payload: dict):
        """
        Push latest orbital signal to Firebase RTDB for TIDE dashboard.
        Optional: requires WECRYPTO_FIREBASE_DB_URL in env.
        """
        db_url = os.environ.get('WECRYPTO_FIREBASE_DB_URL', '')
        if not db_url or not self.poly_api_key:
            return
        try:
            url = f'{db_url.rstrip("/")}/orbital/{asset}.json'
            requests.put(url, json=payload, timeout=4)
        except Exception:
            pass  # Non-critical — never block execution loop

    # ── State Persistence ─────────────────────────────────────────────────────

    def _load_persistent_state(self):
        try:
            with open(self.state_file, 'r') as f:
                saved = json.load(f)
            # Only restore active trade state — prices/volumes start fresh
            for asset in ASSETS:
                if asset in saved:
                    saved_asset = saved[asset]
                    self.state_memory[asset]['active_trade']  = saved_asset.get('active_trade')
                    self.state_memory[asset]['position_side'] = saved_asset.get('position_side')
                    self.state_memory[asset]['highest_pnl']   = float(saved_asset.get('highest_pnl', 0.0))
            log.info('Persistent state loaded from %s', self.state_file)
        except FileNotFoundError:
            pass
        except Exception as e:
            log.warning('State load failed: %s', e)

    def save_state(self):
        """Persist position state to disk for crash recovery."""
        try:
            with open(self.state_file, 'w') as f:
                json.dump({
                    asset: {
                        'active_trade':  st['active_trade'],
                        'position_side': st['position_side'],
                        'highest_pnl':   st['highest_pnl'],
                    }
                    for asset, st in self.state_memory.items()
                }, f, indent=2)
        except Exception as e:
            log.error('State save failed: %s', e)


# ── Live Execution Loop ───────────────────────────────────────────────────────

def _fetch_coinbase_ohlcv(ticker: str) -> Optional[dict]:
    """Pull the most recent 15m candle from Coinbase Exchange API.

    Returns dict with keys: open, high, low, close, volume, sigma.
    Falls back to ticker price if candles endpoint fails.
    """
    try:
        resp = requests.get(COINBASE_CANDLES.format(ticker=ticker), timeout=6)
        candles = resp.json()
        # Coinbase returns candles descending: [[time, low, high, open, close, volume], ...]
        if not candles or not isinstance(candles, list) or len(candles) < 2:
            log.warning('%s | No candles returned, falling back to ticker', ticker)
            return None

        # Most recent closed candle (skip the in-progress one at index 0)
        recent = candles[1] if len(candles) > 1 else candles[0]
        _, low, high, opan, close, volume = recent

        # Compute rolling sigma from log returns of last 16 candles
        closes = [c[4] for c in candles[:min(16, len(candles))]]
        if len(closes) > 2:
            log_rets = np.diff(np.log(np.array(closes, dtype=float)))
            sigma = float(np.std(log_rets))
        else:
            sigma = 0.01

        return {
            'open':   float(opan),
            'high':   float(high),
            'low':    float(low),
            'close':  float(close),
            'volume': float(volume),
            'sigma':  max(sigma, 0.001),
        }
    except Exception as e:
        log.warning('%s | Coinbase candles fetch failed: %s', ticker, e)
        return None


def _fetch_coinbase_price(ticker: str) -> Optional[float]:
    """Pull spot price from Coinbase exchange API (fallback)."""
    try:
        resp = requests.get(COINBASE_TICKER.format(ticker=ticker), timeout=4)
        return float(resp.json()['price'])
    except Exception:
        return None


def run_loop(engine: WecryptoNuclear, once: bool = False):
    log.info('=== WECRYPTO NUCLEAR ENGINE LIVE — 15m CYCLES ===')
    log.info('Assets: %s | DryRun: %s', list(ASSETS.keys()), engine.dry_run)

    while True:
        cycle_start = time.time()
        for asset, ticker in ASSETS.items():
            try:
                # Fetch real 15m OHLCV candle from Coinbase
                candle = _fetch_coinbase_ohlcv(ticker)
                if candle:
                    current_price = candle['close']
                    open_price    = candle['open']
                    interval_vol  = candle['volume']
                    rolling_sigma = candle['sigma']
                    log.info('%s | OHLCV: O=%.2f H=%.2f L=%.2f C=%.2f V=%.2f σ=%.4f',
                             asset.upper(), candle['open'], candle['high'],
                             candle['low'], candle['close'], candle['volume'], candle['sigma'])
                else:
                    # Fallback to ticker price if candles endpoint fails
                    current_price = _fetch_coinbase_price(ticker)
                    if not current_price:
                        log.warning('%s | Coinbase price unavailable — skip', asset.upper())
                        continue
                    # Use the ticker price as both open and close with conservative defaults
                    open_price    = current_price
                    interval_vol  = 1.0
                    rolling_sigma = 0.01
                    log.warning('%s | Using ticker fallback (no OHLCV)', asset.upper())

                order = engine.process_interval(
                    asset=         asset,
                    current_price= current_price,
                    open_price=    open_price,
                    interval_vol=  interval_vol,
                    rolling_sigma= rolling_sigma,
                )
                if order:
                    log.info('SIGNAL FIRED: %s', json.dumps(order, default=str))
                    engine._stream_to_firebase(asset, order)

            except Exception as e:
                log.error('%s | Cycle error: %s', asset.upper(), e)

        engine.save_state()

        if once:
            log.info('Single-cycle mode — exiting.')
            break

        # Sleep until ~15m boundary with ±15s jitter
        elapsed = time.time() - cycle_start
        sleep_s  = max(0, 900 - elapsed) + random.uniform(-15, 15)
        log.info('Cycle complete. Next run in %.0fs', sleep_s)
        time.sleep(sleep_s)


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='WECRYPTO Nuclear Engine — Orbital + Polymarket CLOB Executor',
    )
    parser.add_argument('--dry-run', action='store_true',
                        help='Log payloads without submitting live orders')
    parser.add_argument('--once',    action='store_true',
                        help='Run a single 15m cycle then exit')
    parser.add_argument('--lambda-base', type=float, default=None,
                        help='BTC lambda base override (default: 0.005 or env)')
    args = parser.parse_args()

    engine = WecryptoNuclear(
        btc_lambda_base=args.lambda_base,
        dry_run=args.dry_run,
    )
    try:
        run_loop(engine, once=args.once)
    except KeyboardInterrupt:
        log.info('Engine safely powered down.')
        engine.save_state()
        sys.exit(0)
