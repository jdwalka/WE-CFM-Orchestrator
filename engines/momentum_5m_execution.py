import asyncio
from collections import deque
import time
import logging
import json
import os
import numpy as np
from aiokafka import AIOKafkaConsumer
from kafka import KafkaProducer

# Configure log formatting to clearly view momentum flags
logging.basicConfig(level=logging.INFO, format='%(asctime)s - [%(levelname)s] - %(message)s')

# --- HYPER-REACTIVE MOMENTUM CONFIGURATION ---
MIN_MOMENTUM_VELOCITY = 0.02  

# The 7 core assets for WECRYPTO prediction markets
COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE"]

class CoinMomentumTracker:
    def __init__(self, symbol, target_price=100.0, producer=None):
        self.symbol = symbol
        self.target_price = target_price
        self.producer = producer
        
        self.price_history = deque(maxlen=200)     
        self.velocity_history = deque(maxlen=50)   
        self.hourly_history = deque(maxlen=36000)
        
        self.resampled_prices = deque(maxlen=300) 
        self.last_resample_time = 0
        
    def add_tick(self, timestamp, price):
        self.price_history.append((timestamp, price))
        self.hourly_history.append((timestamp, price))
        
        # 1-second downsampling for regime metrics
        if timestamp - self.last_resample_time >= 1.0:
            self.resampled_prices.append(price)
            self.last_resample_time = timestamp
            
    def get_hourly_range(self):
        if not self.hourly_history:
            return None, None
        prices = [p[1] for p in self.hourly_history]
        return max(prices), min(prices)
        
    def get_hurst_exponent(self):
        if len(self.resampled_prices) < 100:
            return 0.5 
            
        prices = np.array(self.resampled_prices)
        lags = range(2, 20)
        
        tau = [np.sqrt(np.std(np.subtract(prices[lag:], prices[:-lag]))) for lag in lags]
        poly = np.polyfit(np.log(lags), np.log(tau), 1)
        return poly[0] * 2.0

    def get_variance_ratio(self, q=10):
        if len(self.resampled_prices) < q * 2:
            return 1.0
            
        prices = np.array(self.resampled_prices)
        returns = np.diff(np.log(prices))
        
        var_1 = np.var(returns)
        if var_1 == 0:
            return 1.0
            
        returns_q = np.log(prices[q:]) - np.log(prices[:-q])
        var_q = np.var(returns_q)
        
        vr = var_q / (q * var_1)
        return vr

    def analyze_momentum_vectors(self, current_price, velocity, acceleration):
        if velocity > 0:
            current_dir = "UPWARD 📈"
        elif velocity < 0:
            current_dir = "DOWNWARD 📉"
        else:
            current_dir = "STAGNANT ➡️"

        is_accelerating = (velocity * acceleration) > 0
        magnitude = abs(velocity)
        hourly_high, hourly_low = self.get_hourly_range()

        hurst = self.get_hurst_exponent()
        vr = self.get_variance_ratio(q=10)
        
        is_mean_reverting = hurst < 0.45 or vr < 0.8
        is_trending = hurst > 0.55 or vr > 1.2

        signal = None
        if magnitude >= MIN_MOMENTUM_VELOCITY:
            if is_mean_reverting:
                logging.info(f"🛡️ [{self.symbol}] IGNORING FAKE SPIKE (Mean-Reverting) | H: {hurst:.2f} | VR: {vr:.2f}")
            elif is_accelerating:
                flag_status = f"🔥 [{self.symbol}] MOMENTUM ACCELERATING | Vel: {velocity:.4f}%/s | Accel: {acceleration:.4f} | H: {hurst:.2f}"
                logging.info(flag_status)
                signal = "MOMENTUM_ACCELERATING"
            else:
                flag_status = f"⚠️ [{self.symbol}] MOMENTUM EXHAUSTION / SLOWDOWN | Vel: {velocity:.4f}%/s | Accel: {acceleration:.4f} | H: {hurst:.2f}"
                logging.info(flag_status)
                signal = "MOMENTUM_EXHAUSTION"
                
            if signal and self.producer:
                self.producer.send("wecrypto-momentum-signals", {
                    "asset": self.symbol,
                    "signal": signal,
                    "velocity": velocity,
                    "acceleration": acceleration,
                    "hurst": hurst,
                    "variance_ratio": vr,
                    "timestamp": time.time()
                })

        if hourly_high is not None and hourly_low is not None and hourly_high != hourly_low:
            range_pos = (current_price - hourly_low) / (hourly_high - hourly_low)
            if range_pos > 0.98:
                logging.info(f"🏔️ [{self.symbol}] Testing Hourly Highs at {hourly_high:.2f} (Breakout Watch)")
            elif range_pos < 0.02:
                logging.info(f"🌊 [{self.symbol}] Testing Hourly Lows at {hourly_low:.2f} (Breakdown Watch)")

kafka_broker = os.getenv("KAFKA_BROKER_URL", "redpanda:9092")
try:
    producer = KafkaProducer(
        bootstrap_servers=kafka_broker,
        value_serializer=lambda v: json.dumps(v).encode('utf-8')
    )
except Exception as e:
    logging.error(f"Failed to connect to Kafka producer: {e}")
    producer = None

trackers = {coin: CoinMomentumTracker(coin, producer=producer) for coin in COINS}

async def ingest_market_data():
    consumer = AIOKafkaConsumer(
        "wecrypto.orbital.s",
        bootstrap_servers=kafka_broker,
        value_deserializer=lambda m: json.loads(m.decode('utf-8'))
    )
    await consumer.start()
    try:
        logging.info("AIOKafkaConsumer started tracking wecrypto.orbital.s.")
        async for msg in consumer:
            data = msg.value
            asset = data.get("asset")
            price = data.get("price_usd") or data.get("price")
            if asset in trackers and price:
                trackers[asset].add_tick(time.time(), float(price))
    except Exception as e:
        logging.error(f"Kafka consumer error: {e}")
    finally:
        await consumer.stop()

async def monitor_market_dynamics():
    while True:
        await asyncio.sleep(0.2)  
        now = time.time()
        
        for coin in COINS:
            tracker = trackers[coin]
            
            if len(tracker.price_history) < 2:
                continue
                
            recent_points = [p for p in tracker.price_history if now - p[0] <= 3.5]
            if len(recent_points) < 2:
                continue
                
            oldest = recent_points[0]
            newest = recent_points[-1]
            time_diff = newest[0] - oldest[0]
            
            if time_diff > 0:
                raw_velocity = (newest[1] - oldest[1]) / time_diff
                norm_velocity = (raw_velocity / newest[1]) * 100 
                tracker.velocity_history.append((now, norm_velocity))
                
                if len(tracker.velocity_history) >= 2:
                    old_vel = tracker.velocity_history[-2]
                    new_vel = tracker.velocity_history[-1]
                    
                    v_time_diff = new_vel[0] - old_vel[0]
                    if v_time_diff > 0:
                        acceleration = (new_vel[1] - old_vel[1]) / v_time_diff
                        current_price = newest[1]
                        
                        tracker.analyze_momentum_vectors(current_price, norm_velocity, acceleration)

async def main():
    try:
        logging.info("Initializing Vector Momentum Orchestrator Engine for all 7 coins...")
        await asyncio.gather(
            ingest_market_data(),
            monitor_market_dynamics()
        )
    except Exception as e:
        logging.critical(f"Critical exception in core orchestrator execution loop: {e}")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Engine gracefully shut down by operator command.")
