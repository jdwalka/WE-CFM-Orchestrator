const Redis = require('ioredis');

// Connect to the local Redis instance (adjust URL if needed)
const redisSub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

console.log('[Test-Redis-Sub] Connecting to Redis broker...');

redisSub.on('connect', () => {
    console.log('[Test-Redis-Sub] Connected successfully. Subscribing to all orbital ticks...');
    // PSubscribe allows us to listen to pattern matches (e.g. all orbital ticks)
    redisSub.psubscribe('orbital:ticks:*', (err, count) => {
        if (err) {
            console.error('[Test-Redis-Sub] Subscription error:', err.message);
        } else {
            console.log(`[Test-Redis-Sub] Subscribed to ${count} pattern(s). Waiting for data...`);
        }
    });
});

redisSub.on('pmessage', (pattern, channel, message) => {
    try {
        const payload = JSON.parse(message);
        console.log(`\n[TICK] Channel: ${channel}`);
        console.log(`       Source: ${payload.source}`);
        console.log(`       Data:   ${JSON.stringify(payload)}`);
        console.log(`       Delay:  ${Date.now() - payload.ts}ms`);
    } catch (e) {
        console.error('[Test-Redis-Sub] Failed to parse message on', channel, ':', message);
    }
});

redisSub.on('error', (err) => {
    console.error('[Test-Redis-Sub] Connection error:', err.message);
});
