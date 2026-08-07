#!/usr/bin/env python3
import time
import json
import os
import sys
import subprocess
import logging
from collections import deque
import numpy as np
import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [%(levelname)s] - CEX-SUPERVISOR-%(message)s',
    handlers=[
        logging.StreamHandler()
    ]
)
log = logging.getLogger("cex_flow_monitor")

# Configure file logging
os.makedirs("logs", exist_ok=True)
os.makedirs("WECRYP0-data", exist_ok=True)
file_handler = logging.FileHandler("logs/cex_flow_monitor.log", mode='a', encoding='utf-8')
file_handler.setFormatter(logging.Formatter('%(asctime)s - [%(levelname)s] - %(message)s'))
log.addHandler(file_handler)

COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE"]
POLL_INTERVAL_S = 15.0
COOLDOWN_PERIOD_S = 120.0 # 2 minutes before killing a monitor

class CexFlowSupervisor:
    def __init__(self):
        # Recent volume history (symbol -> deque of recent trade volumes in USD)
        self.volume_history = {coin: deque(maxlen=240) for coin in COINS} # 1 hour at 15s interval
        self.last_spawn_time = {coin: 0.0 for coin in COINS}
        self.active_processes = {} # symbol -> { "process": Popen, "log_file": File, "spawned_at": float }
        self.state_file_path = "WECRYP0-data/cex_flow_state.json"
        
    def get_hurst_exponent(self, data):
        if len(data) < 30:
            return 0.5
        prices = np.array(data)
        lags = range(2, min(15, len(data) // 2))
        try:
            tau = [np.sqrt(np.std(np.subtract(prices[lag:], prices[:-lag]))) for lag in lags]
            # Handle possible zero std or empty list
            tau = [t for t in tau if t > 0]
            if len(tau) < 2:
                return 0.5
            lags_log = np.log(list(lags)[:len(tau)])
            poly = np.polyfit(lags_log, np.log(tau), 1)
            return poly[0] * 2.0
        except Exception:
            return 0.5

    def get_variance_ratio(self, data, q=5):
        if len(data) < q * 2:
            return 1.0
        try:
            prices = np.array(data)
            returns = np.diff(np.log(prices))
            var_1 = np.var(returns)
            if var_1 == 0:
                return 1.0
            returns_q = np.log(prices[q:]) - np.log(prices[:-q])
            var_q = np.var(returns_q)
            return var_q / (q * var_1)
        except Exception:
            return 1.0

    def fetch_coin_stats(self, symbol: str):
        """Fetches ticker and recent trade volume for a symbol from public APIs."""
        buy_vol = 0.0
        sell_vol = 0.0
        price = 0.0
        vol_24h = 0.0
        
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        
        try:
            # 1. Binance Spot REST API (Used for BTC, ETH, SOL, XRP, DOGE, BNB)
            if symbol != "HYPE":
                url_ticker = f"https://api.binance.us/api/v3/ticker/24hr?symbol={symbol}USDT"
                url_trades = f"https://api.binance.us/api/v3/trades?symbol={symbol}USDT&limit=100"
                
                ticker_resp = requests.get(url_ticker, headers=headers, timeout=5)
                trades_resp = requests.get(url_trades, headers=headers, timeout=5)
                
                if ticker_resp.status_code == 200:
                    t_data = ticker_resp.json()
                    price = float(t_data.get("lastPrice", 0))
                    vol_24h = float(t_data.get("quoteVolume", 0))
                    
                if trades_resp.status_code == 200:
                    trades = trades_resp.json()
                    for t in trades:
                        qty = float(t.get("qty", 0))
                        px = float(t.get("price", 0))
                        val = qty * px
                        is_buy = not t.get("isBuyerMaker", False)
                        if is_buy:
                            buy_vol += val
                        else:
                            sell_vol += val
            else:
                # 2. Bitget Spot REST API for HYPE
                url_ticker = "https://api.bitget.com/api/v2/spot/market/tickers?symbol=HYPEUSDT"
                url_trades = "https://api.bitget.com/api/v2/spot/market/fills?symbol=HYPEUSDT&limit=100"
                
                ticker_resp = requests.get(url_ticker, headers=headers, timeout=5)
                trades_resp = requests.get(url_trades, headers=headers, timeout=5)
                
                if ticker_resp.status_code == 200:
                    t_data = ticker_resp.json().get("data", [{}])[0]
                    price = float(t_data.get("lastPr", 0))
                    vol_24h = float(t_data.get("usdtVol", 0))
                    
                if trades_resp.status_code == 200:
                    trades = trades_resp.json().get("data", [])
                    for t in trades:
                        qty = float(t.get("size", 0))
                        px = float(t.get("price", 0))
                        val = qty * px
                        side = t.get("side", "").lower()
                        if side == "buy":
                            buy_vol += val
                        else:
                            sell_vol += val
                            
        except Exception as e:
            log.warning(f"Error fetching stats for {symbol}: {e}")
            
        recent_trade_vol = buy_vol + sell_vol
        total_vol = buy_vol + sell_vol
        buy_pct = (buy_vol / total_vol * 100.0) if total_vol > 0 else 50.0
        sell_pct = 100.0 - buy_pct
        
        return price, vol_24h, recent_trade_vol, buy_pct, sell_pct

    def evaluate_and_manage(self):
        log.info("Running CEX Flow Supervisor cycle...")
        now = time.time()
        
        current_state = {
            "ts": now,
            "active_monitors": [],
            "coins": {}
        }
        
        for coin in COINS:
            price, vol_24h, recent_vol, buy_pct, sell_pct = self.fetch_coin_stats(coin)
            
            # Store price/volume stats
            self.volume_history[coin].append(recent_vol if recent_vol > 0 else 1.0)
            
            # Compute Volume Multiplier
            vol_list = list(self.volume_history[coin])
            if len(vol_list) > 5:
                mean_vol = np.mean(vol_list[:-1])
                vol_mult = recent_vol / mean_vol if mean_vol > 0 else 1.0
            else:
                vol_mult = 1.0
                
            # Compute Hurst & VR regime metrics
            hurst = self.get_hurst_exponent(vol_list)
            vr = self.get_variance_ratio(vol_list)
            

            
            # Classification
            if sell_pct > 58:
                signal = "DISTRIBUTING"
                color = "red"
            elif buy_pct > 58:
                signal = "ACCUMULATING"
                color = "green"
            elif vol_mult > 2.0 and abs(buy_pct - sell_pct) < 6:
                signal = "VOLATILE"
                color = "orange"
            elif vol_mult < 0.5:
                signal = "QUIET"
                color = "faint"
            else:
                signal = "NEUTRAL"
                color = "muted"
                
            current_state["coins"][coin] = {
                "price": price,
                "vol_24h": vol_24h,
                "recent_vol_usd": recent_vol,
                "vol_mult": vol_mult,
                "buy_pct": buy_pct,
                "sell_pct": sell_pct,
                "signal": signal,
                "color": color,
                "hurst_v": hurst,
                "vr_v": vr
            }
            
            # Supervisor Spawning Heuristics
            # Trigger when:
            # 1. Volume multiplier > 2.0x
            # 2. Volume trend is persistent (Hurst > 0.52 or Variance Ratio > 1.1)
            is_spike = vol_mult > 2.0
            is_persistent = hurst > 0.52 or vr > 1.1
            
            is_monitored = coin in self.active_processes
            
            if is_spike and is_persistent and not is_monitored:
                # Spawn child process
                log.info(f"🔥 Vol spike detected on {coin} (Mult: {vol_mult:.2f}x, H: {hurst:.2f}). Spawning high-freq monitor...")
                log_file = open(f"logs/cex_high_freq_{coin.lower()}_process.log", "a", encoding="utf-8")
                
                try:
                    p = subprocess.Popen(
                        [sys.executable, "engines/cex_high_freq_monitor.py", "--symbol", coin],
                        stdin=subprocess.PIPE,
                        stdout=log_file,
                        stderr=log_file,
                        text=True
                    )
                    self.active_processes[coin] = {
                        "process": p,
                        "log_file": log_file,
                        "spawned_at": now
                    }
                    self.last_spawn_time[coin] = now
                    log.info(f"✅ Spawned high-freq child process for {coin} (PID: {p.pid})")
                except Exception as e:
                    log.error(f"Failed to spawn child process for {coin}: {e}")
                    log_file.close()
                    
            elif is_monitored:
                # Check if it should be terminated
                # Conditions:
                # 1. Vol mult dropped below 1.2x AND elapsed time since spawn > cooldown
                # 2. Hard timeout of 30 minutes (1800 seconds)
                elapsed = now - self.active_processes[coin]["spawned_at"]
                should_cool = vol_mult < 1.2 and elapsed > COOLDOWN_PERIOD_S
                should_timeout = elapsed > 1800.0
                
                # Check if process is still alive
                p_obj = self.active_processes[coin]["process"]
                if p_obj.poll() is not None:
                    # Child exited on its own or crashed
                    log.warning(f"⚠️ High-freq monitor for {coin} exited unexpectedly (Exit Code: {p_obj.returncode})")
                    self.active_processes[coin]["log_file"].close()
                    del self.active_processes[coin]
                elif should_cool or should_timeout:
                    log.info(f"❄️ Cool down or timeout reached for {coin}. Terminating child process...")
                    try:
                        # Send stdin "stop" command for graceful exit
                        p_obj.stdin.write("stop\n")
                        p_obj.stdin.flush()
                        
                        # Wait up to 5s, then force terminate if still running
                        for _ in range(5):
                            if p_obj.poll() is not None:
                                break
                            time.sleep(1.0)
                        else:
                            log.warning(f"Child process for {coin} didn't exit gracefully. Killing...")
                            p_obj.kill()
                            
                    except Exception as e:
                        log.warning(f"Error terminating child process for {coin}: {e}")
                        p_obj.kill()
                        
                    p_obj.wait()
                    self.active_processes[coin]["log_file"].close()
                    del self.active_processes[coin]
                    log.info(f"❌ Terminated child process for {coin}")
                    
        # Write state to JSON file
        current_state["active_monitors"] = list(self.active_processes.keys())
        try:
            temp_path = self.state_file_path + ".tmp"
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(current_state, f, indent=2)
            os.replace(temp_path, self.state_file_path)
        except Exception as e:
            log.error(f"Failed to write supervisor state: {e}")
            
    def shutdown(self):
        log.info("Shutdown signal received. Terminating all active child processes...")
        for coin, info in list(self.active_processes.items()):
            p_obj = info["process"]
            try:
                p_obj.stdin.write("stop\n")
                p_obj.stdin.flush()
                p_obj.wait(timeout=3.0)
            except Exception:
                p_obj.kill()
            info["log_file"].close()
            log.info(f"❌ Stopped monitor for {coin}")
        self.active_processes.clear()

def main():
    supervisor = CexFlowSupervisor()
    log.info("CEX Flow Supervisor started.")
    try:
        while True:
            cycle_start = time.time()
            try:
                supervisor.evaluate_and_manage()
            except Exception as e:
                log.error(f"Exception in supervisor cycle: {e}")
                
            elapsed = time.time() - cycle_start
            sleep_time = max(0.1, POLL_INTERVAL_S - elapsed)
            time.sleep(sleep_time)
    except KeyboardInterrupt:
        log.info("Supervisor exiting via keyboard interrupt...")
    finally:
        supervisor.shutdown()

if __name__ == "__main__":
    main()
