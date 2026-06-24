#!/usr/bin/env python3
"""
WECRYPTO Ultra-Low-Latency Sniper Execution Engine
══════════════════════════════════════════════════
Listens to Kafka trigger topics and shoots orders instantly over a hot Kalshi WS channel.
"""

import asyncio
import json
import logging
import os
import sys
import time
import uuid
import base64
from typing import Optional

from aiokafka import AIOKafkaConsumer
import websockets

# Try importing cryptography for hot RSA-SHA256 signature generation
try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(name)s | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger('wecrypto.sniper')

# Configuration
KAFKA_BROKER = os.environ.get("KAFKA_BROKER", "localhost:9092")
TRIGGER_TOPIC = os.environ.get("TRIGGER_TOPIC", "whale-alerts")
KALSHI_WS_URL = os.environ.get("KALSHI_WS_URL", "wss://api.elections.kalshi.com/trade-api/v2/ws")

API_KEY_ID = os.environ.get("KALSHI_API_KEY_ID", "")
PRIVATE_KEY_PEM = os.environ.get("KALSHI_PRIVATE_KEY_PEM", "").replace("\\n", "\n").strip()

class WECryptoSniper:
    def __init__(self):
        self.kalshi_ws = None
        self.scout_mode = False
        self.running = True

    def _generate_signature(self, timestamp: str) -> Optional[str]:
        """Generate RSA-SHA256 signature with PSS padding for WebSocket upgrade."""
        if not HAS_CRYPTO:
            log.error("cryptography package missing. Cannot sign auth headers.")
            return None
        if not PRIVATE_KEY_PEM:
            log.error("KALSHI_PRIVATE_KEY_PEM is not set.")
            return None
        try:
            message = f"{timestamp}GET/trade-api/v2/ws"
            private_key = load_pem_private_key(PRIVATE_KEY_PEM.encode('utf-8'), password=None)
            signature = private_key.sign(
                message.encode('utf-8'),
                padding.PSS(
                    mgf=padding.MGF1(hashes.SHA256()),
                    salt_length=padding.PSS.DIGEST_LENGTH
                ),
                hashes.SHA256()
            )
            return base64.b64encode(signature).decode('utf-8')
        except Exception as e:
            log.error(f"Signature generation failed: {e}")
            return None

    async def connect_kalshi(self):
        """Maintains a persistent, hot, authenticated WebSocket connection."""
        while self.running:
            try:
                timestamp = str(int(time.time() * 1000))
                signature = self._generate_signature(timestamp)
                
                headers = {}
                if signature and API_KEY_ID:
                    headers = {
                        'KALSHI-ACCESS-KEY': API_KEY_ID,
                        'KALSHI-ACCESS-SIGNATURE': signature,
                        'KALSHI-ACCESS-TIMESTAMP': timestamp,
                    }
                    log.info("Connecting to Kalshi WebSocket with access credentials...")
                else:
                    log.warning("No Kalshi credentials configured. Connecting unauthenticated.")

                async with websockets.connect(KALSHI_WS_URL, extra_headers=headers) as ws:
                    self.kalshi_ws = ws
                    log.info("✓ Kalshi WebSocket connected and hot.")
                    
                    # Connection keep-alive and event loop
                    async for message in ws:
                        data = json.loads(message)
                        
                        # Handle Kalshi's ping frames to keep connection alive
                        if data.get("cmd") == "ping" or data.get("type") == "ping":
                            await ws.send(json.dumps({"cmd": "pong"}))
                            continue
                            
                        # Handle order fills or responses
                        if "status" in data:
                            log.info(f"Kalshi WS message received: {data}")

            except (websockets.exceptions.ConnectionClosed, Exception) as e:
                log.warning(f"Kalshi WS connection dropped: {e}. Reconnecting in 2s...")
                self.kalshi_ws = None
                await asyncio.sleep(2)

    async def execute_trade(self, signal_data: dict):
        """Places a v2 limit order over WebSocket, with immediate REST fallback if offline."""
        ticker = signal_data.get("target_ticker")
        side = signal_data.get("side", "yes").lower()  # 'yes' or 'no'
        
        # Max bid price validation/conversion to cents (int [1, 99])
        raw_price = signal_data.get("max_bid", 0.50)
        price_cents = int(round(raw_price * 100))
        price_cents = max(1, min(99, price_cents))

        count = int(signal_data.get("count", 10))
        client_order_id = f"snip-{uuid.uuid4().hex[:12]}"

        # If WS is active, fire over WebSocket (hot path: ~5ms)
        if self.kalshi_ws and self.kalshi_ws.open:
            payload = {
                "id": int(time.time() * 1000),
                "cmd": "order_create",
                "val": {
                    "ticker": ticker,
                    "action": "buy",
                    "side": side,
                    "count": count,
                    "type": "limit",
                    "price": price_cents,
                    "client_order_id": client_order_id
                }
            }
            try:
                await self.kalshi_ws.send(json.dumps(payload))
                log.warning(f"⚡ ORDER FIRED OVER WS -> Ticker: {ticker} | Side: {side} | Price: {price_cents}¢ | Count: {count}")
                return
            except Exception as e:
                log.error(f"WS transmit failed: {e}. Falling back to REST...")

        # Fallback path: REST execution (cold path: ~150ms)
        log.warning(f"WS offline or failed. Initiating REST execution fallback for {ticker}...")
        await self._execute_rest_fallback(ticker, side, price_cents, count, client_order_id)

    async def _execute_rest_fallback(self, ticker: str, side: str, price_cents: int, count: int, client_order_id: str):
        """Asynchronously triggers Kalshi REST order post as a fallback."""
        import requests
        
        token = os.environ.get("KALSHI_API_TOKEN", "")
        limit_price = price_cents / 100.0
        
        # Map side to Kalshi V2 REST actions
        # YES side -> 'bid'; NO side -> 'ask'
        rest_side = 'bid' if side == 'yes' else 'ask'
        
        payload = {
            'ticker':           ticker,
            'client_order_id':  client_order_id,
            'side':             rest_side,
            'count':            f'{count:.2f}',
            'price':            f'{limit_price:.4f}',
            'time_in_force':    'immediate_or_cancel',
        }
        
        headers = {
            'Content-Type':  'application/json',
        }
        
        if token:
            headers['Authorization'] = f'Bearer {token}'
        else:
            # Generate upgrade-style headers for REST
            timestamp = str(int(time.time() * 1000))
            body_str = json.dumps(payload)
            msg = timestamp + "POST" + "/trade-api/v2/portfolio/events/orders" + body_str
            
            if HAS_CRYPTO and PRIVATE_KEY_PEM and API_KEY_ID:
                try:
                    private_key = load_pem_private_key(PRIVATE_KEY_PEM.encode('utf-8'), password=None)
                    signature = private_key.sign(
                        msg.encode('utf-8'),
                        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
                        hashes.SHA256()
                    )
                    sig_b64 = base64.b64encode(signature).decode('utf-8')
                    headers['KALSHI-ACCESS-KEY'] = API_KEY_ID
                    headers['KALSHI-ACCESS-SIGNATURE'] = sig_b64
                    headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp
                except Exception as e:
                    log.error(f"Failed to sign REST fallback request: {e}")
                    return
            else:
                log.error("No token or signing keys available for REST fallback.")
                return

        url = "https://trading-api.kalshi.com/trade-api/v2/portfolio/events/orders"
        try:
            loop = asyncio.get_running_loop()
            r = await loop.run_in_executor(
                None, 
                lambda: requests.post(url, json=payload, headers=headers, timeout=5)
            )
            log.info(f"REST Fallback order response (HTTP {r.status_code}): {r.text}")
        except Exception as e:
            log.error(f"REST Fallback order fire failed: {e}")


    async def listen_for_triggers(self):
        """Asynchronous Kafka consumer listening for the overarching trigger."""
        while self.running:
            try:
                log.info(f"Connecting AIOKafkaConsumer to {KAFKA_BROKER}...")
                consumer = AIOKafkaConsumer(
                    TRIGGER_TOPIC,
                    bootstrap_servers=KAFKA_BROKER,
                    value_deserializer=lambda m: json.loads(m.decode('utf-8')),
                    group_id="wecrypto-sniper-group"
                )
                
                await consumer.start()
                log.info(f"✓ Listening for mempool triggers on topic: {TRIGGER_TOPIC}")
                
                try:
                    async for msg in consumer:
                        signal = msg.value
                        log.warning(f"ALERT DETECTED: volume={signal.get('volume')} | target={signal.get('target_ticker')}")
                        
                        self.scout_mode = True
                        await self.execute_trade(signal)
                        self.scout_mode = False
                finally:
                    await consumer.stop()
            except Exception as e:
                log.error(f"Kafka consumer connection failed: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5)

    def stop(self):
        self.running = False

async def main():
    # Verify environment variables
    if not API_KEY_ID or not PRIVATE_KEY_PEM:
        log.warning("Warning: KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY_PEM not set in env.")
    if not HAS_CRYPTO:
        log.warning("Warning: 'cryptography' library not installed. Signature checks will fail.")

    sniper = WECryptoSniper()
    try:
        await asyncio.gather(
            sniper.connect_kalshi(),
            sniper.listen_for_triggers()
        )
    except KeyboardInterrupt:
        sniper.stop()
        log.info("Shutdown sniper daemon.")

if __name__ == "__main__":
    asyncio.run(main())
