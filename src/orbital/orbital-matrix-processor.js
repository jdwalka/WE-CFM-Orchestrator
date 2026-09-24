/**
 * orbital-matrix-processor.js
 * The Synchronous Consumer (The Coherence Loop).
 *
 * Implements the Time-Windowed Barrier logic for the Orbital Matrix:
 * every 15 minutes it synthesizes buffered ticks into a matrix element
 * and dispatches it to Firebase via the OrbitalBroadcaster.
 */

const { Kafka } = require('kafkajs');
const fs = require('fs');
const path = require('path');
const OrbitalBroadcaster = require('./orbital-firebase-broadcaster');

const ORBITAL_LOG_DIR = path.join(__dirname, '..', '..', 'logs', 'orbital');
let _orbitalLogDirReady = false;

function appendOrbitalLog(element) {
    try {
        if (!_orbitalLogDirReady) {
            fs.mkdirSync(ORBITAL_LOG_DIR, { recursive: true });
            _orbitalLogDirReady = true;
        }
        const day = new Date().toISOString().slice(0, 10);
        const file = path.join(ORBITAL_LOG_DIR, `${day}.jsonl`);
        fs.appendFileSync(file, JSON.stringify({ loggedAt: Date.now(), ...element }) + '\n');
    } catch (err) {
        console.warn('[OrbitalProcessor] Local log append failed:', err.message);
    }
}

const KAFKA_BROKERS      = process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['127.0.0.1:9092', 'localhost:9092'];
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

function latestRingData(state, ring) {
    const ticks = state?.[ring];
    return Array.isArray(ticks) && ticks.length ? ticks[ticks.length - 1].data : {};
}

function extractQuantumStates(orbitals) {
    const canonicalShell = {
        s_core: 's',
        p_momentum: 'p',
        d_complex: 'd',
        f_diffuse: 'f',
    };
    return Object.fromEntries(Object.entries(orbitals).map(([shell, payload]) => [
        canonicalShell[shell] || shell[0],
        payload?.quantum_state || {
            shell: canonicalShell[shell] || shell[0],
            ion_charge: '0',
            net_charge: 0,
            coherence: 0,
            electron_count: 0,
            subatomic_orbital_count: 0,
            subshells: [],
        },
    ]));
}

// Shared Kafka client for the consumer
const kafka = new Kafka({
    clientId: 'orbital-matrix-processor',
    brokers: KAFKA_BROKERS,
    connectionTimeout: 8000,
    requestTimeout: 30000,
    retry: { initialRetryTime: 200, retries: 10 }
});

// The consumer must be created fresh on every start. KafkaJS cannot reliably
// reconnect a consumer instance after disconnect() — reusing one throws
// "write after end" on the torn-down socket. So this holds the *current*
// instance and is recreated by startProcessor / nulled by stopProcessor.
let consumer = null;

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
    // Idempotency guard: if a previous run left the consumer connected and
    // running (e.g. an orchestrator restart that skipped stopProcessor), tear
    // it down first. Subscribing on an already-running consumer makes KafkaJS
    // throw "Cannot subscribe to topic while consumer is running".
    if (consumerRunning || consumer) {
        await stopProcessor();
    }

    // Fresh instance per start — a disconnected KafkaJS consumer cannot be reused.
    consumer = kafka.consumer({ groupId: 'orbital-coherence-group' });
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
    if (!consumer) {
        consumerRunning = false;
        return;
    }
    try {
        await consumer.disconnect();
    } finally {
        consumer = null; // discard — a disconnected consumer cannot be reused
        consumerRunning = false;
        buffer.clear();
        bufferedTicks = 0;
    }
}

let _predictedFundingsCache = { ts: 0, data: {} };

async function fetchPredictedFundings() {
    if (Date.now() - _predictedFundingsCache.ts < 60_000 && Object.keys(_predictedFundingsCache.data).length) {
        return _predictedFundingsCache.data;
    }
    try {
        const res = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'predictedFundings' }),
        });
        if (res.ok) {
            const list = await res.json();
            const map = {};
            if (Array.isArray(list)) {
                for (const item of list) {
                    const [coin, venueList] = item;
                    if (Array.isArray(venueList)) {
                        const hlPred = venueList.find(v => v[0] === 'hl' || v[0] === 'hyperliquid') || venueList[0];
                        if (hlPred && hlPred[1]?.fundingRate != null) {
                            map[coin] = parseFloat(hlPred[1].fundingRate) * 100;
                        }
                    }
                }
            }
            _predictedFundingsCache = { ts: Date.now(), data: map };
            return map;
        }
    } catch (e) {
        console.warn('[OrbitalProcessor] Failed to fetch Hyperliquid predictedFundings:', e.message);
    }
    return _predictedFundingsCache.data;
}

/**
 * Execute the 15-minute synchronization barrier for all buffered assets.
 * For each asset:
 *   1. Cross-reference price check (CoinGecko vs Coinbase divergence)
 *   2. Orbital decay detection (any orbital silent for > 15s)
 *   3. Synthesize matrix element
 *   4. Dispatch to Firebase via OrbitalBroadcaster
 */
async function runBarrier() {
    const now = Date.now();
    console.log(`[OrbitalProcessor] 15-min barrier executing at ${new Date().toISOString()}`);

    const predictedFundings = await fetchPredictedFundings().catch(() => ({}));

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
        const pRing = latestRingData(state, 'p');
        const dRing = latestRingData(state, 'd');
        const fRing = latestRingData(state, 'f');

        // Wire Hyperliquid predictedFundings into cascade_skew input:
        // Cross-referencing predicted rate against live rate indicates positioning unwind / cascade skew
        const hlPredicted = predictedFundings[asset] ?? dRing?.predicted_funding ?? dRing?.predictedFunding ?? null;
        const liveFunding = dRing?.funding_rate ?? dRing?.funding_pct ?? pRing?.funding ?? null;
        let cascadeSkew = 0;
        if (hlPredicted != null && liveFunding != null) {
            cascadeSkew = (hlPredicted - liveFunding) * 10;
        } else if (dRing?.cascade_skew != null) {
            cascadeSkew = Number(dRing.cascade_skew);
        }

        const dComplexEnhanced = {
            ...dRing,
            predicted_funding: hlPredicted,
            cascade_skew: cascadeSkew,
        };

        const orbitals = {
            s_core:     latestSCore.data,
            p_momentum: pRing,
            d_complex:  dComplexEnhanced,
            f_diffuse:  fRing,
        };

        const element = {
            asset,
            timestamp:         Math.floor(now / 1000),
            atomic_weight_class: determineWeightClass(asset),
            decayed_orbitals:  decayed.length > 0 ? decayed : undefined,
            orbitals,
            cascade_skew:      cascadeSkew,
            quantum_states:    extractQuantumStates(orbitals),
        };

        // ── 4. Dispatch to TIDE ─────────────────────────────────────────────────
        try {
            OrbitalBroadcaster.pushMatrixElement(element);
            console.log(`[OrbitalProcessor] [${asset}] Dispatched. Cascade Skew: ${cascadeSkew.toFixed(4)}. Decayed: [${decayed.join(', ') || 'none'}]`);
        } catch (err) {
            console.error(`[OrbitalProcessor] [${asset}] Dispatch failed:`, err.message);
        }

        // ── 5. Durable local log ────────────────────────────────────────────────
        // Cheap, durable, survives restart: one JSONL line per synthesized element.
        appendOrbitalLog(element);
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
