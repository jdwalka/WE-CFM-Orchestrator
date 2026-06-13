/**
 * orbital-matrix-processor.js
 * The Synchronous Consumer (The Coherence Loop).
 *
 * Implements the Time-Windowed Barrier logic for the Orbital Matrix:
 * every 15 minutes it synthesizes buffered ticks into a matrix element
 * and dispatches it to Firebase via the OrbitalBroadcaster.
 */

const { Kafka } = require('kafkajs');
const OrbitalBroadcaster = require('./orbital-firebase-broadcaster');

const KAFKA_BROKERS      = process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'];
const INTERVAL_MS        = 15 * 60 * 1000; // 15 minutes
const BARRIER_TOLERANCE_MS  = 15 * 1000;   // 15 seconds — orbital is "decayed" if no tick in this window
const MAX_PRICE_DELTA_PCT   = 0.005;        // 0.5% divergence threshold between CoinGecko and Coinbase
const BUFFER_RETENTION_MS = Math.max(30_000, Number(process.env.WECRYPTO_ORBITAL_BUFFER_RETENTION_MS || 120_000));
const BUFFER_MAX_TICKS_PER_RING = Math.max(8, Number(process.env.WECRYPTO_ORBITAL_BUFFER_MAX_TICKS || 120));

// In-Memory Buffer: Map<Asset, { s: Tick[], p: Tick[], d: Tick[], f: Tick[] }>
// Each Tick = { data: object, ts: number (epoch ms) }
const buffer = new Map();
let bufferedTicks = 0;
let droppedBufferedTicks = 0;

function getOrCreateAssetState(asset) {
    if (!buffer.has(asset)) {
        buffer.set(asset, { s: [], p: [], d: [], f: [] });
    }
    return buffer.get(asset);
}

function pushBoundedTick(state, type, tick) {
    const ring = state[type];
    if (!ring) return false;

    ring.push(tick);
    bufferedTicks += 1;

    const cutoff = tick.ts - BUFFER_RETENTION_MS;
    while (ring.length && (ring.length > BUFFER_MAX_TICKS_PER_RING || ring[0].ts < cutoff)) {
        ring.shift();
        droppedBufferedTicks += 1;
    }

    return true;
}

function findLatestBySource(ticks, source) {
    for (let i = ticks.length - 1; i >= 0; i -= 1) {
        if (ticks[i]?.data?.source === source) return ticks[i];
    }
    return null;
}

// Shared Kafka client for the consumer
const kafka = new Kafka({
    clientId: 'orbital-matrix-processor',
    brokers: KAFKA_BROKERS,
    retry: { initialRetryTime: 200, retries: 10 }
});

const consumer = kafka.consumer({ groupId: 'orbital-coherence-group' });

// The setInterval handle for the barrier loop (returned so the orchestrator can clear it)
let barrierInterval = null;
let consumerRunning = false;

/**
 * Start the Matrix Processor:
 *   1. Connects the KafkaJS consumer to Redpanda
 *   2. Subscribes to all 4 orbital topics
 *   3. Buffers incoming messages in memory
 *   4. Runs the 15-min Time-Windowed Barrier on a setInterval
 *
 * @returns {NodeJS.Timeout} The barrier interval handle (for clean shutdown via clearInterval)
 */
async function startProcessor() {
    await consumer.connect();
    console.log('[OrbitalProcessor] Connected to Redpanda.');

    const topics = [
        'wecrypto.orbital.s',
        'wecrypto.orbital.p',
        'wecrypto.orbital.d',
        'wecrypto.orbital.f'
    ];

    for (const topic of topics) {
        await consumer.subscribe({ topic, fromBeginning: false });
    }

    await consumer.run({
        eachMessage: async ({ topic, message }) => {
            const asset   = message.key ? message.key.toString() : null;
            if (!asset) return;

            let payload;
            try { payload = JSON.parse(message.value.toString()); }
            catch (e) { return; }

            const type = topic.split('.').pop(); // 's', 'p', 'd', 'f'

            const state = getOrCreateAssetState(asset);
            if (!state[type]) return; // guard against unknown type

            pushBoundedTick(state, type, { data: payload, ts: Date.now() });
        }
    });
    consumerRunning = true;

    console.log('[OrbitalProcessor] Consumer running. Starting 15-min coherence barrier...');

    // Time-Windowed Barrier
    barrierInterval = setInterval(() => runBarrier(), INTERVAL_MS);

    return barrierInterval;
}

async function stopProcessor() {
    if (barrierInterval) {
        clearInterval(barrierInterval);
        barrierInterval = null;
    }
    if (!consumerRunning) return;
    try {
        await consumer.disconnect();
    } finally {
        consumerRunning = false;
        buffer.clear();
    }
}

/**
 * Execute the 15-minute synchronization barrier for all buffered assets.
 * For each asset:
 *   1. Cross-reference price check (CoinGecko vs Coinbase divergence)
 *   2. Orbital decay detection (any orbital silent for > 15s)
 *   3. Synthesize matrix element
 *   4. Dispatch to Firebase via OrbitalBroadcaster
 */
function runBarrier() {
    const now = Date.now();
    console.log(`[OrbitalProcessor] 15-min barrier executing at ${new Date().toISOString()}`);

    for (const [asset, state] of buffer.entries()) {
        // ── 1. Cross-Reference Price Check ──────────────────────────────────────
        // Find the most-recent CoinGecko tick and most-recent Coinbase tick
        // separately (each message is single-source, so we search by source field).
        const cgTick  = findLatestBySource(state.s, 'coingecko');
        const cbTick  = findLatestBySource(state.s, 'coinbase');
        const cgPrice = cgTick?.data?.price_usd;
        const cbPrice = cbTick?.data?.price_usd;

        if (cgPrice && cbPrice) {
            const delta = Math.abs(cgPrice - cbPrice) / cbPrice;
            if (delta > MAX_PRICE_DELTA_PCT) {
                console.warn(
                    `[OrbitalProcessor] [${asset}] Price divergence ${(delta * 100).toFixed(3)}% ` +
                    `(CoinGecko $${cgPrice.toFixed(2)} vs Coinbase $${cbPrice.toFixed(2)}) — sync blocked.`
                );
                continue; // skip this asset this cycle
            }
        }

        // Need at least one s-tick to proceed
        const latestS = state.s.length ? state.s[state.s.length - 1] : null;
        if (!latestS) continue;

        // ── 2. Barrier Synchronization — Orbital Decay Detection ────────────────
        const decayed = [];
        for (const ring of ['s', 'p', 'd', 'f']) {
            const latest = state[ring].length ? state[ring][state[ring].length - 1] : null;
            if (!latest || (now - latest.ts) > BARRIER_TOLERANCE_MS) {
                decayed.push(`orbital_${ring}`);
            }
        }

        // ── 3. Payload Synthesis ────────────────────────────────────────────────
        // Use the latest tick from each orbital ring.
        // Prefer Coinbase price for s_core (more liquid / lower latency).
        const latestSCore = cbTick || latestS;

        const element = {
            asset,
            timestamp:         Math.floor(now / 1000),
            atomic_weight_class: determineWeightClass(asset),
            decayed_orbitals:  decayed.length > 0 ? decayed : undefined,
            orbitals: {
                s_core:     latestSCore.data,
                p_momentum: state.p.length ? state.p[state.p.length - 1].data : {},
                d_complex:  state.d.length ? state.d[state.d.length - 1].data : {},
                f_diffuse:  state.f.length ? state.f[state.f.length - 1].data : {}
            }
        };

        // ── 4. Dispatch to TIDE ─────────────────────────────────────────────────
        try {
            OrbitalBroadcaster.pushMatrixElement(element);
            console.log(`[OrbitalProcessor] [${asset}] Dispatched. Decayed: [${decayed.join(', ') || 'none'}]`);
        } catch (err) {
            console.error(`[OrbitalProcessor] [${asset}] Dispatch failed:`, err.message);
        }
    }
}

/**
 * Map asset symbol to its atomic weight class (used by orbital-firebase-broadcaster).
 */
function determineWeightClass(asset) {
    const classes = {
        'BTC':  'Noble Gas',
        'ETH':  'Alkali Metal',
        'HYPE': 'Reactive Non-Metal',
        'SOL':  'Transition Metal',
        'XRP':  'Transition Metal',
        'DOGE': 'Transition Metal',
        'BNB':  'Transition Metal'
    };
    return classes[asset] || 'Transition Metal';
}

/**
 * Returns the latest known price for each buffered asset.
 * Prefers Coinbase source; falls back to any available s-tick.
 */
function getLatestPrices() {
    const prices = {};
    for (const [asset, state] of buffer.entries()) {
        if (!state.s.length) continue;
        // Prefer Coinbase tick (lowest latency)
        const cbTick = findLatestBySource(state.s, 'coinbase');
        const cgTick = findLatestBySource(state.s, 'coingecko');
        prices[asset] = cbTick?.data?.price_usd ?? cgTick?.data?.price_usd ?? null;
    }
    return prices;
}

function getBufferStats() {
    const assets = {};
    for (const [asset, state] of buffer.entries()) {
        assets[asset] = {
            s: state.s.length,
            p: state.p.length,
            d: state.d.length,
            f: state.f.length,
        };
    }
    return {
        assets,
        bufferedTicks,
        droppedBufferedTicks,
        retentionMs: BUFFER_RETENTION_MS,
        maxTicksPerRing: BUFFER_MAX_TICKS_PER_RING,
    };
}

module.exports = { startProcessor, stopProcessor, getLatestPrices, getBufferStats };
