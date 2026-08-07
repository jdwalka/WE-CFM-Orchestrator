/**
 * orbital-redpanda-bridge.js
 * Ingestion bridge for the Orbital Matrix.
 * Pushes raw high-velocity ticks into Redpanda topics via KafkaJS.
 */

const { Kafka } = require('kafkajs');
const { createQuantumStateTracker } = require('../orbital/quantum-state');

const KAFKA_BROKERS = process.env.KAFKA_BROKERS
    ? process.env.KAFKA_BROKERS.split(',')
    : ['localhost:9092'];

let producer = null;
let kafka = null;
let lastProducedAt = null;
let inFlightSends = 0;
let queuedTicks = 0;
let sentTicks = 0;
let sentBatches = 0;
let failedTicks = 0;
let droppedTicks = 0;
let lastDroppedTicksReported = 0;

const MAX_ACTIVITY_EVENTS = 12;
const recentEvents = [];
const TOPICS = {
    s: 'wecrypto.orbital.s',
    p: 'wecrypto.orbital.p',
    d: 'wecrypto.orbital.d',
    f: 'wecrypto.orbital.f'
};
const PRODUCE_MIN_INTERVAL_MS = Math.max(0, Number(process.env.WECRYPTO_ORBITAL_PRODUCE_MIN_MS || 0));
const PRODUCE_MAX_IN_FLIGHT = Math.max(1, Number(process.env.WECRYPTO_ORBITAL_PRODUCE_MAX_IN_FLIGHT || 32));
const PRODUCE_BATCH_MAX_MESSAGES = Math.max(1, Number(process.env.WECRYPTO_ORBITAL_BATCH_MAX || 256));
const PRODUCE_FLUSH_INTERVAL_MS = Math.max(1, Number(process.env.WECRYPTO_ORBITAL_FLUSH_MS || 20));
const PRODUCE_QUEUE_MAX_MESSAGES = Math.max(PRODUCE_BATCH_MAX_MESSAGES, Number(process.env.WECRYPTO_ORBITAL_QUEUE_MAX || 4096));
const lastProducedKeyAt = new Map();
const topicQueues = new Map();
let flushTimer = null;
const quantumStateTracker = createQuantumStateTracker();

function enrichOrbitalPayload(orbital, asset, payload, timestamp = Date.now()) {
    return quantumStateTracker.enrich(orbital, asset, payload, timestamp);
}

// Per-topic message counters (for the UI status widget)
const messageCounts = {
    's': 0,
    'p': 0,
    'd': 0,
    'f': 0
};

// Last-tick timestamps per orbital (ISO string, for decay detection in UI)
const lastTickAt = {
    's': null,
    'p': null,
    'd': null,
    'f': null
};

function recordBridgeEvent(level, message, meta = {}) {
    recentEvents.unshift({
        ts: Date.now(),
        level: level || 'info',
        message: String(message || '').trim(),
        source: 'bridge',
        meta: meta && typeof meta === 'object' ? meta : {}
    });
    if (recentEvents.length > MAX_ACTIVITY_EVENTS) {
        recentEvents.length = MAX_ACTIVITY_EVENTS;
    }
}

async function initRedpanda() {
    if (producer) return;

    console.log('[OrbitalBridge] Initializing Redpanda Bridge...');
    kafka = new Kafka({
        clientId: 'wecrypto-ingestor',
        brokers: KAFKA_BROKERS,
        retry: {
            initialRetryTime: 100,
            retries: 8
        }
    });

    producer = kafka.producer();

    try {
        await producer.connect();
        console.log('[OrbitalBridge] Connected to Redpanda.');
        recordBridgeEvent('success', 'Kafka producer connected', { brokers: KAFKA_BROKERS });
    } catch (err) {
        console.error('[OrbitalBridge] Failed to connect to Redpanda:', err.message);
        recordBridgeEvent('error', 'Kafka producer failed to connect', { error: err.message });
        producer = null;
    }
}

/**
 * Gracefully disconnect the KafkaJS producer.
 * Called by the startup orchestrator on shutdown.
 */
async function disconnectRedpanda() {
    if (!producer) return;
    try {
        await producer.disconnect();
        console.log('[OrbitalBridge] Producer disconnected.');
    } catch (err) {
        console.warn('[OrbitalBridge] Producer disconnect error:', err.message);
    } finally {
        recordBridgeEvent('info', 'Kafka producer disconnected');
        producer = null;
        kafka = null;
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        inFlightSends = 0;
        queuedTicks = 0;
        lastDroppedTicksReported = droppedTicks;
        topicQueues.clear();
        lastProducedKeyAt.clear();
    }
}

function getTopicQueue(topic) {
    let queue = topicQueues.get(topic);
    if (!queue) {
        queue = [];
        topicQueues.set(topic, queue);
    }
    return queue;
}

function dropOldestQueuedTick() {
    for (const queue of topicQueues.values()) {
        if (queue.length) {
            queue.shift();
            queuedTicks = Math.max(0, queuedTicks - 1);
            droppedTicks += 1;
            return true;
        }
    }
    return false;
}

function scheduleFlush(delayMs = PRODUCE_FLUSH_INTERVAL_MS) {
    if (!producer || flushTimer) return;
    flushTimer = setTimeout(flushQueuedTicks, delayMs);
    flushTimer.unref?.();
}

function flushQueuedTicks() {
    flushTimer = null;
    if (!producer || queuedTicks <= 0) return;

    while (producer && queuedTicks > 0 && inFlightSends < PRODUCE_MAX_IN_FLIGHT) {
        const topicMessages = [];
        let batchCount = 0;

        for (const [topic, queue] of topicQueues.entries()) {
            if (!queue.length) continue;
            const take = Math.min(queue.length, PRODUCE_BATCH_MAX_MESSAGES - batchCount);
            if (take <= 0) break;
            const messages = queue.splice(0, take);
            queuedTicks = Math.max(0, queuedTicks - messages.length);
            batchCount += messages.length;
            topicMessages.push({ topic, messages });
            if (batchCount >= PRODUCE_BATCH_MAX_MESSAGES) break;
        }

        if (!batchCount) break;

        inFlightSends += 1;
        producer.sendBatch({ topicMessages })
            .then(() => {
                sentTicks += batchCount;
                sentBatches += 1;
                if (sentBatches === 1 || sentBatches % 100 === 0) {
                    recordBridgeEvent('info', 'Orbital producer batch sent', {
                        batchCount,
                        sentTicks,
                        queuedTicks,
                        inFlightBatches: inFlightSends,
                    });
                }
            })
            .catch((err) => {
                failedTicks += batchCount;
                recordBridgeEvent('warn', 'Orbital producer batch failed', {
                    batchCount,
                    failedTicks,
                    error: err.message,
                });
                console.warn('[OrbitalBridge] Failed to produce batch:', err.message);
            })
            .finally(() => {
                inFlightSends = Math.max(0, inFlightSends - 1);
                if (queuedTicks > 0) scheduleFlush(1);
            });
    }

    if (queuedTicks > 0) scheduleFlush(1);
}

/**
 * Shared queue/throttle/flush enqueue logic for any topic this bridge produces
 * to. Callers own their own bookkeeping (message counts, last-tick timestamps,
 * milestone logging) since those are shaped differently per producer.
 * @param {string} topic       - Destination Kafka topic
 * @param {string} key         - Kafka message key (partition affinity)
 * @param {object} valueObj    - Payload to serialize as JSON
 * @param {string} throttleKey - Per-key throttle bucket (e.g. "s:BTC", "grok:ETH")
 */
function _enqueue(topic, key, valueObj, throttleKey) {
    if (!producer) return false;
    const now = Date.now();
    const lastForKey = lastProducedKeyAt.get(throttleKey) || 0;

    if (PRODUCE_MIN_INTERVAL_MS > 0 && now - lastForKey < PRODUCE_MIN_INTERVAL_MS) {
        droppedTicks += 1;
        return false;
    }

    if (queuedTicks >= PRODUCE_QUEUE_MAX_MESSAGES && !dropOldestQueuedTick()) {
        droppedTicks += 1;
        return false;
    }

    if (droppedTicks > lastDroppedTicksReported && (droppedTicks === 1 || droppedTicks % 1000 === 0)) {
        lastDroppedTicksReported = droppedTicks;
        recordBridgeEvent('warn', 'Orbital producer queue shedding oldest ticks', {
            queuedTicks,
            droppedTicks,
            queueLimit: PRODUCE_QUEUE_MAX_MESSAGES,
            inFlightBatches: inFlightSends,
        });
    }

    lastProducedKeyAt.set(throttleKey, now);
    getTopicQueue(topic).push({
        key,
        value: JSON.stringify(valueObj),
        timestamp: now.toString()
    });
    queuedTicks += 1;

    scheduleFlush(queuedTicks >= PRODUCE_BATCH_MAX_MESSAGES ? 1 : PRODUCE_FLUSH_INTERVAL_MS);
    return true;
}

/**
 * Pushes a single tick to an orbital topic.
 * @param {string} orbital - 's', 'p', 'd', or 'f'
 * @param {string} asset   - Ticker symbol (e.g. 'BTC', 'HYPE')
 * @param {object} payload - Raw data object to serialize as JSON
 */
function produceOrbitalTick(orbital, asset, payload) {
    if (!producer) return false;

    const topic = TOPICS[orbital];
    if (!topic) return false;
    const now = Date.now();
    const enrichedPayload = enrichOrbitalPayload(orbital, asset, payload, now);
    const throttleKey = `${orbital}:${asset}`;

    if (!_enqueue(topic, asset, enrichedPayload, throttleKey)) return false;

    messageCounts[orbital] = (messageCounts[orbital] || 0) + 1;
    const isoNow = new Date(now).toISOString();
    lastTickAt[orbital] = isoNow;
    lastProducedAt = isoNow;
    if (messageCounts[orbital] === 1 || (messageCounts[orbital] % 1000) === 0) {
        recordBridgeEvent('info', `Orbital ${orbital} active`, {
            orbital,
            asset,
            count: messageCounts[orbital],
            queuedTicks,
            topic
        });
    }

    return true;
}

// Grok session-memory tick stream — separate topic from the orbital s/p/d/f
// feed (different signal type, see scripts/redpanda-init-topics.js).
const GROK_TOPIC = 'wecrypto.grok.ticks';
let grokMessageCount = 0;
let grokLastTickAt = null;

/**
 * Pushes a single Grok session-memory sample tick to wecrypto.grok.ticks.
 * @param {string} coin    - Ticker symbol (e.g. 'BTC')
 * @param {object} payload - Raw sample object to serialize as JSON
 */
function produceGrokTick(coin, payload) {
    if (!producer) return false;
    const now = Date.now();
    const throttleKey = `grok:${coin}`;

    if (!_enqueue(GROK_TOPIC, coin, payload, throttleKey)) return false;

    grokMessageCount += 1;
    grokLastTickAt = new Date(now).toISOString();
    if (grokMessageCount === 1 || grokMessageCount % 1000 === 0) {
        recordBridgeEvent('info', 'Grok tick stream active', {
            coin,
            count: grokMessageCount,
            queuedTicks,
            topic: GROK_TOPIC,
        });
    }

    return true;
}

/**
 * Returns current stats for the UI status widget.
 */
function getBridgeStats() {
    const totalMessages = Object.values(messageCounts).reduce((sum, count) => sum + Number(count || 0), 0);
    const activeOrbitals = Object.entries(lastTickAt)
        .filter(([, ts]) => !!ts)
        .map(([orbital]) => orbital);
    return {
        connected: !!producer,
        messageCounts: { ...messageCounts },
        lastTickAt: { ...lastTickAt },
        totalMessages,
        activeOrbitals,
        lastProducedAt,
        inFlightSends,
        inFlightBatches: inFlightSends,
        queuedTicks,
        sentTicks,
        sentBatches,
        failedTicks,
        droppedTicks,
        produceMinIntervalMs: PRODUCE_MIN_INTERVAL_MS,
        produceMaxInFlight: PRODUCE_MAX_IN_FLIGHT,
        produceBatchMaxMessages: PRODUCE_BATCH_MAX_MESSAGES,
        produceFlushIntervalMs: PRODUCE_FLUSH_INTERVAL_MS,
        produceQueueMaxMessages: PRODUCE_QUEUE_MAX_MESSAGES,
        recentEvents: recentEvents.map((event) => ({ ...event })),
        grok: {
            topic: GROK_TOPIC,
            messageCount: grokMessageCount,
            lastTickAt: grokLastTickAt,
        },
    };
}

module.exports = {
    initRedpanda,
    disconnectRedpanda,
    enrichOrbitalPayload,
    produceOrbitalTick,
    produceGrokTick,
    getBridgeStats
};
