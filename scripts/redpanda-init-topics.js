/**
 * redpanda-init-topics.js
 * Pre-creates the 4 WE-CRYPTO orbital topics in Redpanda.
 *
 * Safe to run multiple times — topics already existing are treated as success.
 * Called by the orbital-startup-orchestrator before the producer connects.
 *
 * Usage (standalone):
 *   node scripts/redpanda-init-topics.js
 *
 * Usage (programmatic):
 *   const { createOrbitalTopics } = require('./scripts/redpanda-init-topics');
 *   await createOrbitalTopics();
 */

'use strict';

const { Kafka } = require('kafkajs');

const KAFKA_BROKERS = process.env.KAFKA_BROKERS
    ? process.env.KAFKA_BROKERS.split(',')
    : ['localhost:9092'];

// Topic configuration
// retention.ms: how long to keep messages before purging
// partitions: 3 gives reasonable parallelism for a single-node setup
// replication: 1 (single Redpanda node in docker-compose)
const ORBITAL_TOPICS = [
    {
        topic:             'wecrypto.orbital.s',
        numPartitions:     3,
        replicationFactor: 1,
        configEntries: [
            { name: 'retention.ms',         value: String(60 * 60 * 1000) }, // 1 hour
            { name: 'cleanup.policy',        value: 'delete' },
            { name: 'compression.type',      value: 'snappy' }
        ]
    },
    {
        topic:             'wecrypto.orbital.p',
        numPartitions:     3,
        replicationFactor: 1,
        configEntries: [
            { name: 'retention.ms',         value: String(60 * 60 * 1000) }, // 1 hour
            { name: 'cleanup.policy',        value: 'delete' },
            { name: 'compression.type',      value: 'snappy' }
        ]
    },
    {
        topic:             'wecrypto.orbital.d',
        numPartitions:     3,
        replicationFactor: 1,
        configEntries: [
            { name: 'retention.ms',         value: String(60 * 60 * 1000) }, // 1 hour
            { name: 'cleanup.policy',        value: 'delete' },
            { name: 'compression.type',      value: 'snappy' }
        ]
    },
    {
        topic:             'wecrypto.orbital.f',
        numPartitions:     3,
        replicationFactor: 1,
        configEntries: [
            // f-orbital (Kalshi sentiment) is polled every 30s — 30min retention is plenty
            { name: 'retention.ms',         value: String(30 * 60 * 1000) }, // 30 minutes
            { name: 'cleanup.policy',        value: 'delete' },
            { name: 'compression.type',      value: 'snappy' }
        ]
    }
];

// Grok session-memory tick stream — separate from the orbital s/p/d/f feed
// (different signal type: Grok sample ticks, not quantum-orbital metrics).
// Low volume (4 coins every 20s), single topic keyed by coin symbol is enough.
const GROK_TOPICS = [
    {
        topic:             'wecrypto.grok.ticks',
        numPartitions:     3,
        replicationFactor: 1,
        configEntries: [
            { name: 'retention.ms',         value: String(6 * 60 * 60 * 1000) }, // 6 hours — audit trail, not hot-consumed
            { name: 'cleanup.policy',        value: 'delete' },
            { name: 'compression.type',      value: 'snappy' }
        ]
    }
];

/**
 * Create (or verify) a list of Kafka topics. Skips topics that already exist
 * without throwing. Shared by createOrbitalTopics()/createGrokTopics().
 */
async function _createTopics(topicList, label) {
    const kafka = new Kafka({
        clientId: 'wecrypto-admin',
        brokers: KAFKA_BROKERS,
        retry: { initialRetryTime: 300, retries: 5 }
    });

    const admin = kafka.admin();

    try {
        await admin.connect();
        console.log(`[TopicInit] Connected to Redpanda admin API (${label}).`);

        // Fetch existing topics so we can report skips accurately
        const existing = await admin.listTopics();
        console.log(`[TopicInit] Existing topics: ${existing.length > 0 ? existing.join(', ') : '(none)'}`);

        const toCreate = topicList.filter(t => !existing.includes(t.topic));

        if (toCreate.length === 0) {
            console.log(`[TopicInit] All ${label} topics already exist. Nothing to create.`);
            return;
        }

        const result = await admin.createTopics({
            waitForLeaders: true,
            topics: toCreate
        });

        if (result) {
            toCreate.forEach(t => console.log(`[TopicInit] ✓ Created topic: ${t.topic}`));
        } else {
            console.warn('[TopicInit] createTopics returned false — topics may already exist.');
        }

        topicList.filter(t => existing.includes(t.topic)).forEach(t =>
            console.log(`[TopicInit] ✓ Topic already exists (skipped): ${t.topic}`)
        );

    } catch (err) {
        console.error(`[TopicInit] Failed to create ${label} topics:`, err.message);
        throw err;
    } finally {
        await admin.disconnect().catch(() => {});
    }
}

/**
 * Create (or verify) all orbital Kafka topics.
 */
async function createOrbitalTopics() {
    return _createTopics(ORBITAL_TOPICS, 'orbital');
}

/**
 * Create (or verify) the Grok session-memory tick topic.
 */
async function createGrokTopics() {
    return _createTopics(GROK_TOPICS, 'grok');
}

/**
 * Create (or verify) every topic this app produces to.
 */
async function createAllTopics() {
    await createOrbitalTopics();
    await createGrokTopics();
}

module.exports = { createOrbitalTopics, createGrokTopics, createAllTopics };

// Allow standalone execution
if (require.main === module) {
    createAllTopics()
        .then(() => { console.log('[TopicInit] Done.'); process.exit(0); })
        .catch((err) => { console.error('[TopicInit] Fatal:', err); process.exit(1); });
}
