#!/usr/bin/env python3
import asyncio
import sys
import json
import time
import os
import argparse
import logging
from collections import deque
import websockets

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [%(levelname)s] - CEX-HF-%(message)s',
    handlers=[
        logging.StreamHandler()
    ]
)
log = logging.getLogger("cex_high_freq_monitor")

# Configurable constants
WINDOW_10S = 10.0
WINDOW_60S = 60.0

class HighFreqTradeMonitor:
    def __init__(self, symbol: str):
        self.symbol = symbol.upper()
        self.log_file_path = f"logs/cex_high_freq_{self.symbol.lower()}.log"
        self.json_file_path = f"WECRYP0-data/cex_high_freq_{self.symbol.lower()}.json"
        
        # Ensure directories exist
        os.makedirs("logs", exist_ok=True)
        os.makedirs("WECRYP0-data", exist_ok=True)
        
        # Setup file logger
        file_handler = logging.FileHandler(self.log_file_path, mode='a', encoding='utf-8')
        file_handler.setFormatter(logging.Formatter('%(asctime)s - [%(levelname)s] - %(message)s'))
        log.addHandler(file_handler)
        
        # Sliding deques for trades (time, price, qty, is_buy)
        self.trades = deque()
        
        # VPIN calculation states
        # Standard volume bucket size in USD (approx. $50,000 USD worth of volume)
        self.bucket_vol_usd = 50000.0
        self.current_bucket_buy_vol = 0.0
        self.current_bucket_sell_vol = 0.0
        self.vpin_buckets = deque(maxlen=50) # rolling window of 50 volume buckets
        
        # Latest calculated states
        self.metrics = {
            "symbol": self.symbol,
            "connected": False,
            "ts": 0.0,
            "price": 0.0,
            "buy_pct_1m": 50.0,
            "sell_pct_1m": 50.0,
            "trades_per_sec": 0.0,
            "whale_trades_1m_10k": 0,
            "whale_trades_1m_50k": 0,
            "vpin": 0.0,
            "last_update": 0.0
        }
        
    def add_trade(self, price: float, qty: float, is_buy: bool):
        now = time.time()
        trade_val_usd = price * qty
        self.trades.append((now, price, qty, trade_val_usd, is_buy))
        
        # Process VPIN volume buckets
        if is_buy:
            self.current_bucket_buy_vol += trade_val_usd
        else:
            self.current_bucket_sell_vol += trade_val_usd
            
        total_bucket_vol = self.current_bucket_buy_vol + self.current_bucket_sell_vol
        if total_bucket_vol >= self.bucket_vol_usd:
            # We reached the volume bucket size, close the bucket
            buy_share = self.current_bucket_buy_vol
            sell_share = self.current_bucket_sell_vol
            abs_diff = abs(buy_share - sell_share)
            self.vpin_buckets.append((abs_diff, total_bucket_vol))
            
            # Reset bucket variables
            self.current_bucket_buy_vol = 0.0
            self.current_bucket_sell_vol = 0.0
            
    def compute_metrics(self):
        now = time.time()
        # Evict old trades from window
        while self.trades and now - self.trades[0][0] > WINDOW_60S:
            self.trades.popleft()
            
        recent_trades = list(self.trades)
        if not recent_trades:
            self.metrics["trades_per_sec"] = 0.0
            self.metrics["buy_pct_1m"] = 50.0
            self.metrics["sell_pct_1m"] = 50.0
            self.metrics["whale_trades_1m_10k"] = 0
            self.metrics["whale_trades_1m_50k"] = 0
            self.metrics["ts"] = now
            self.metrics["last_update"] = now
            return
            
        # Price is latest trade price
        self.metrics["price"] = recent_trades[-1][1]
        self.metrics["ts"] = recent_trades[-1][0]
        
        # Trades per second (10s window)
        trades_10s = [t for t in recent_trades if now - t[0] <= WINDOW_10S]
        self.metrics["trades_per_sec"] = len(trades_10s) / WINDOW_10S
        
        # Buy/Sell split (60s window)
        buy_vol = sum(t[3] for t in recent_trades if t[4])
        sell_vol = sum(t[3] for t in recent_trades if not t[4])
        total_vol = buy_vol + sell_vol
        
        if total_vol > 0:
            self.metrics["buy_pct_1m"] = (buy_vol / total_vol) * 100.0
            self.metrics["sell_pct_1m"] = 100.0 - self.metrics["buy_pct_1m"]
        else:
            self.metrics["buy_pct_1m"] = 50.0
            self.metrics["sell_pct_1m"] = 50.0
            
        # Whale trades (60s window)
        self.metrics["whale_trades_1m_10k"] = sum(1 for t in recent_trades if t[3] >= 10000.0)
        self.metrics["whale_trades_1m_50k"] = sum(1 for t in recent_trades if t[3] >= 50000.0)
        
        # VPIN score
        if len(self.vpin_buckets) > 0:
            sum_diffs = sum(b[0] for b in self.vpin_buckets)
            sum_vols = sum(b[1] for b in self.vpin_buckets)
            if sum_vols > 0:
                self.metrics["vpin"] = sum_diffs / sum_vols
            else:
                self.metrics["vpin"] = 0.0
        else:
            # Fallback VPIN proxy if no buckets are closed yet
            if total_vol > 0:
                self.metrics["vpin"] = abs(buy_vol - sell_vol) / total_vol
            else:
                self.metrics["vpin"] = 0.0
                
        self.metrics["last_update"] = now
        
    def write_state(self):
        try:
            temp_path = self.json_file_path + ".tmp"
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(self.metrics, f, indent=2)
            os.replace(temp_path, self.json_file_path)
        except Exception as e:
            log.error(f"Failed to write state JSON for {self.symbol}: {e}")

    async def connect_binance(self, stop_event: asyncio.Event):
        uri = f"wss://stream.binance.us:9443/ws/{self.symbol.lower()}usdt@trade"
        log.info(f"Connecting to Binance Spot stream: {uri}")
        
        while not stop_event.is_set():
            try:
                async with websockets.connect(uri, ping_interval=20, ping_timeout=10) as ws:
                    self.metrics["connected"] = True
                    log.info(f"Connected to Binance Spot WebSocket for {self.symbol}")
                    
                    while not stop_event.is_set():
                        try:
                            msg_str = await asyncio.wait_for(ws.recv(), timeout=1.0)
                            msg = json.loads(msg_str)
                            
                            price = float(msg.get("p", 0))
                            qty = float(msg.get("q", 0))
                            is_buy = not msg.get("m", False)
                            
                            if price > 0 and qty > 0:
                                self.add_trade(price, qty, is_buy)
                                
                                # Log large block trades immediately to file
                                trade_val = price * qty
                                if trade_val >= 20000.0:
                                    log.info(f"🚨 LARGE TRADE: {'BUY' if is_buy else 'SELL'} {self.symbol} | ${trade_val:,.2f} at ${price:,.4f}")
                                    
                        except asyncio.TimeoutError:
                            continue
                            
            except websockets.exceptions.ConnectionClosed:
                self.metrics["connected"] = False
                log.warning(f"Binance Spot WS connection closed for {self.symbol}. Reconnecting...")
                await asyncio.sleep(2.0)
            except Exception as e:
                self.metrics["connected"] = False
                log.error(f"Binance Spot WS error for {self.symbol}: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5.0)

    async def connect_bitget(self, stop_event: asyncio.Event):
        uri = "wss://ws.bitget.com/v2/ws/public"
        log.info(f"Connecting to Bitget Spot stream for {self.symbol} (fallback): {uri}")
        
        while not stop_event.is_set():
            try:
                async with websockets.connect(uri, ping_interval=20, ping_timeout=10) as ws:
                    self.metrics["connected"] = True
                    log.info(f"Connected to Bitget WebSocket for {self.symbol}")
                    
                    # Subscribe to Spot trade channel
                    sub_msg = {
                        "op": "subscribe",
                        "args": [
                            {
                                "instType": "SPOT",
                                "channel": "trade",
                                "instId": f"{self.symbol}USDT"
                            }
                        ]
                    }
                    await ws.send(json.dumps(sub_msg))
                    
                    while not stop_event.is_set():
                        try:
                            msg_str = await asyncio.wait_for(ws.recv(), timeout=1.0)
                            msg = json.loads(msg_str)
                            
                            if "data" in msg:
                                for t in msg["data"]:
                                    price = float(t.get("price", 0))
                                    qty = float(t.get("size", 0))
                                    side = t.get("side", "").lower()
                                    is_buy = (side == "buy")
                                    
                                    if price > 0 and qty > 0:
                                        self.add_trade(price, qty, is_buy)
                                        trade_val = price * qty
                                        if trade_val >= 20000.0:
                                            log.info(f"🚨 LARGE TRADE (Bitget): {'BUY' if is_buy else 'SELL'} {self.symbol} | ${trade_val:,.2f} at ${price:,.4f}")
                                            
                        except asyncio.TimeoutError:
                            continue
                            
            except websockets.exceptions.ConnectionClosed:
                self.metrics["connected"] = False
                log.warning(f"Bitget WS connection closed for {self.symbol}. Reconnecting...")
                await asyncio.sleep(2.0)
            except Exception as e:
                self.metrics["connected"] = False
                log.error(f"Bitget WS error for {self.symbol}: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5.0)

    async def metrics_writer_loop(self, stop_event: asyncio.Event):
        log.info(f"Starting metrics writer loop for {self.symbol}")
        while not stop_event.is_set():
            self.compute_metrics()
            self.write_state()
            await asyncio.sleep(2.0)
            
        # Final cleanup write
        self.metrics["connected"] = False
        self.compute_metrics()
        self.write_state()
        log.info(f"Metrics writer loop stopped for {self.symbol}")

async def listen_stdin(stop_event: asyncio.Event):
    """Listens for standard input closing or 'stop' command to gracefully shut down."""
    loop = asyncio.get_event_loop()
    
    def read_line():
        try:
            return sys.stdin.readline()
        except Exception:
            return ""

    try:
        while not stop_event.is_set():
            line = await loop.run_in_executor(None, read_line)
            if not line: # EOF
                log.info("Received EOF on stdin. Triggering shutdown.")
                stop_event.set()
                break
            cmd = line.strip().lower()
            if cmd == "stop":
                log.info("Received 'stop' command on stdin. Triggering shutdown.")
                stop_event.set()
                break
    except Exception as e:
        log.debug(f"Stdin reader exception: {e}")

def run_monitor(symbol: str, multiprocessing_stop_event=None):
    """Entrypoint that can be called via multiprocessing or direct run."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    stop_event = asyncio.Event()
    
    async def supervisor():
        monitor = HighFreqTradeMonitor(symbol)
        
        if symbol.upper() == "HYPE":
            ws_task = asyncio.create_task(monitor.connect_bitget(stop_event))
        else:
            ws_task = asyncio.create_task(monitor.connect_binance(stop_event))
            
        writer_task = asyncio.create_task(monitor.metrics_writer_loop(stop_event))
        stdin_task = asyncio.create_task(listen_stdin(stop_event))
        
        async def check_mp_event():
            while not stop_event.is_set():
                if multiprocessing_stop_event and multiprocessing_stop_event.is_set():
                    log.info("Multiprocessing stop event set. Triggering shutdown.")
                    stop_event.set()
                    break
                await asyncio.sleep(1.0)
                
        mp_task = asyncio.create_task(check_mp_event())
        
        await asyncio.gather(ws_task, writer_task, stdin_task, mp_task, return_exceptions=True)
        log.info(f"Shutdown complete for {symbol} child process.")
        
    try:
        loop.run_until_complete(supervisor())
    except KeyboardInterrupt:
        log.info(f"KeyboardInterrupt caught in run_monitor for {symbol}")
        stop_event.set()
        loop.run_until_complete(asyncio.sleep(0.5))
    finally:
        loop.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WECRYPTO High-Frequency CEX Flow Monitor")
    parser.add_argument("--symbol", type=str, required=True, help="Coin symbol (e.g. BTC, ETH, HYPE)")
    args = parser.parse_args()
    
    run_monitor(args.symbol)
