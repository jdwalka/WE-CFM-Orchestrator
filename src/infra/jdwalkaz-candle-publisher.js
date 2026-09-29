/**
 * jdwalkaz-candle-publisher.js
 * Bridges live WECRYPTO market ticks / candles into Redpanda topic `wecrypto.prices.ticks`.
 * Aggregates incoming sub-second ticks into 1-minute OHLCV candles and publishes them upon minute close.
 */

'use strict';

const { Kafka } = require('kafkajs');

const REDPANDA_BROKERS = process.env.REDPANDA_BROKERS
  ? process.env.REDPANDA_BROKERS.split(',')
  : (process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['127.0.0.1:9092']);

let kafka = null;
let producer = null;
let isConnected = false;
let isConnecting = false;

// Active 1m candle buckets per symbol: Map<symbol, { minute, o, h, l, c, v, count }>
const activeBuckets = new Map();

/**
 * Initialize Redpanda Kafka producer
 */
async function init() {
  if (producer || isConnecting) return;
  isConnecting = true;

  try {
    kafka = new Kafka({
      clientId: 'wecrypto-jdwalkaz-publisher',
      brokers: REDPANDA_BROKERS,
      connectionTimeout: 5000,
      requestTimeout: 15000,
      retry: {
        initialRetryTime: 300,
        retries: 5,
      },
    });

    producer = kafka.producer({
      allowAutoTopicCreation: true,
    });

    await producer.connect();
    isConnected = true;
    console.log(`[JdwalkazCandlePublisher] Connected to Redpanda at ${REDPANDA_BROKERS.join(',')}`);
  } catch (err) {
    console.warn(`[JdwalkazCandlePublisher] Redpanda connection warning: ${err.message}`);
    isConnected = false;
  } finally {
    isConnecting = false;
  }
}

/**
 * Send a closed candle directly to topic `wecrypto.prices.ticks`
 */
async function publishCandle(symbol, candle) {
  if (!producer || !isConnected) {
    await init();
  }
  if (!producer || !isConnected) return false;

  try {
    const sym = symbol.toUpperCase().replace('USDT', '').replace('USD', '').replace('Crypto.', '').split('/')[0];
    const payload = {
      symbol: sym,
      ts: candle.ts || Date.now(),
      o: Number(candle.o || candle.c || 0),
      h: Number(candle.h || candle.c || 0),
      l: Number(candle.l || candle.c || 0),
      c: Number(candle.c || 0),
      v: Number(candle.v || 0),
    };

    await producer.send({
      topic: 'wecrypto.prices.ticks',
      messages: [
        {
          key: sym,
          value: JSON.stringify(payload),
        },
      ],
    });
    return true;
  } catch (err) {
    console.warn(`[JdwalkazCandlePublisher] Send error for ${symbol}:`, err.message);
    return false;
  }
}

/**
 * Ingest an incoming price tick. Aggregates ticks into 1-minute OHLCV candles
 * and emits to Redpanda when a minute boundaries roll.
 */
function onTick(rawSymbol, price, volume = 0, timestamp = Date.now()) {
  const px = Number(price);
  if (!Number.isFinite(px) || px <= 0) return;

  const symbol = rawSymbol.toUpperCase().replace('USDT', '').replace('USD', '').replace('Crypto.', '').split('/')[0];
  const minute = Math.floor(timestamp / 60000) * 60000;

  let bucket = activeBuckets.get(symbol);

  if (bucket && bucket.minute !== minute) {
    // Current minute closed! Publish the closed candle
    const closedCandle = {
      symbol,
      ts: bucket.minute,
      o: bucket.o,
      h: bucket.h,
      l: bucket.l,
      c: bucket.c,
      v: bucket.v,
    };
    publishCandle(symbol, closedCandle).catch(() => {});

    // Start fresh bucket for the new minute
    bucket = {
      minute,
      o: px,
      h: px,
      l: px,
      c: px,
      v: Number(volume) || 0,
      count: 1,
    };
    activeBuckets.set(symbol, bucket);
  } else if (!bucket) {
    bucket = {
      minute,
      o: px,
      h: px,
      l: px,
      c: px,
      v: Number(volume) || 0,
      count: 1,
    };
    activeBuckets.set(symbol, bucket);
  } else {
    // Update existing bucket
    bucket.h = Math.max(bucket.h, px);
    bucket.l = Math.min(bucket.l, px);
    bucket.c = px;
    bucket.v += (Number(volume) || 0);
    bucket.count++;
  }
}

module.exports = {
  init,
  onTick,
  publishCandle,
};

// Standalone test verification
if (require.main === module) {
  (async () => {
    await init();
    console.log('[JdwalkazCandlePublisher] Test emitting 1m candle...');
    const ok = await publishCandle('BTC', {
      ts: Date.now(),
      o: 76500.0,
      h: 76550.0,
      l: 76480.0,
      c: 76520.0,
      v: 12.5,
    });
    console.log(`[JdwalkazCandlePublisher] Published test candle: ${ok ? 'SUCCESS' : 'FAILED'}`);
    if (producer) await producer.disconnect();
  })();
}
