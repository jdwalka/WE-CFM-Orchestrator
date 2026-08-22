/**
 * ================================================================
 * Async Refresh Engine — Event-Driven Real-Time Updates
 * 
 * Replaces interval-based polling with continuous async streams.
 * Multiple data flows run in parallel without blocking the UI.
 * 
 * Architecture:
 * - AsyncRefreshEngine: Main orchestrator
 * - DataStreams: Independent async generators for each data type
 * - EventBus: Broadcasts updates to UI subscribers
 * - Priority Queue: Prioritizes urgent updates (settlements, alerts)
 * 
 * Benefits:
 * ✓ Predictions run every 30s in background (non-blocking)
 * ✓ Polymarket balance updates every 5s
 * ✓ Market data updates on settlement boundaries
 * ✓ UI never waits for data — updates push in
 * ✓ Graceful degradation if any source fails
 * ================================================================
 */

(function () {
    'use strict';

    class EventBus {
        constructor() {
            this.subscribers = new Map();
        }

        on(event, callback) {
            if (!this.subscribers.has(event)) {
                this.subscribers.set(event, []);
            }
            this.subscribers.get(event).push(callback);
            return () => {
                const idx = this.subscribers.get(event).indexOf(callback);
                if (idx > -1) this.subscribers.get(event).splice(idx, 1);
            };
        }

        emit(event, data) {
            if (!this.subscribers.has(event)) return;
            for (const cb of [...this.subscribers.get(event)]) {
                try { cb(data); } catch (e) {
                    console.error(`[EventBus] ${event} handler error:`, e.message);
                }
            }
        }

        once(event, callback) {
            const unsub = this.on(event, (data) => {
                unsub();
                callback(data);
            });
            return unsub;
        }
    }

    class AsyncRefreshEngine {
        constructor() {
            this.bus = new EventBus();
            this.running = false;
            this.runId = 0;
            this.streams = new Map();
            this.clockOffsetMs = 0;
            this.clockSource = 'system';
            this.clockSyncedAt = 0;
            this.clockSyncInFlight = null;
            this.clockResyncIntervalMs = 15 * 60 * 1000;
            this.fetchLocks = new Map();
            this.fetchLastRun = new Map();
            this.etFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                timeZoneName: 'short'
            });
            this.timeSyncSources = [
                {
                    name: 'time.akamai.com',
                    url: 'https://time.akamai.com/',
                    isText: true,
                    parse: (text) => {
                        const secs = parseInt(text, 10);
                        return isNaN(secs) ? null : secs * 1000;
                    }
                },
                {
                    name: 'timeapi.io/america-new_york',
                    url: 'https://timeapi.io/api/Time/current/zone?timeZone=America/New_York',
                    parse: (json) => this.parseTimeApiTimestamp(json, 'America/New_York')
                },
                // worldtimeapi endpoints removed (now returning HTTP 410).
                {
                    name: 'timeapi.io/utc',
                    url: 'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
                    parse: (json) => this.parseTimeApiTimestamp(json, 'UTC')
                }
            ];

            this.metrics = {
                totalUpdates: 0,
                lastUpdateTs: 0,
                streamStates: {}
            };

            console.log('[AsyncRefreshEngine] Initialized (async, event-driven architecture)');
        }

        /**
         * Start all async streams
         */
        async start() {
            if (this.running) {
                console.warn('[AsyncRefreshEngine] Already running');
                return;
            }

            this.running = true;
            this.runId++;
            const currentRunId = this.runId;
            this.metrics.startMs = Date.now();
            console.log(`[AsyncRefreshEngine] ⚡ Starting async streams... (runId: ${currentRunId})`);

            await this.syncClock(true);

            // Fire all streams in parallel — they run independently and never block startup.
            void this.streamPredictions(currentRunId).catch(err => console.error('[AsyncRefreshEngine] predictions stream failed:', err));
            void this.streamOrderBookImbalance(currentRunId).catch(err => console.error('[AsyncRefreshEngine] order-book stream failed:', err));
            void this.streamMarketData(currentRunId).catch(err => console.error('[AsyncRefreshEngine] market stream failed:', err));
            void this.streamSettlementPulse(currentRunId).catch(err => console.error('[AsyncRefreshEngine] settlement stream failed:', err));

            return this.getMetrics();
        }

        /**
         * Stop all streams
         */
        stop() {
            this.running = false;
            console.log('[AsyncRefreshEngine] ⏹ Stopping streams');
            this.streams.clear();
        }

        nowMs() {
            return Date.now() + this.clockOffsetMs;
        }

        parseTimeApiTimestamp(json, fallbackTimeZone = 'UTC') {
            if (!json) return null;
            const parts = {
                year: Number(json.year),
                month: Number(json.month),
                day: Number(json.day),
                hour: Number(json.hour),
                minute: Number(json.minute),
                second: Number(json.seconds),
                milli: Number(json.milliSeconds || 0),
            };
            if (!Object.values(parts).every(Number.isFinite)) return null;

            const timeZone = json.timeZone || fallbackTimeZone;
            if (timeZone === 'UTC' || timeZone === 'Etc/UTC') {
                return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.milli);
            }
            return this.zonedTimePartsToUtcMs(parts, timeZone);
        }

        zonedTimePartsToUtcMs(parts, timeZone) {
            const targetMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.milli);
            let utcMs = targetMs;

            for (let i = 0; i < 3; i++) {
                const renderedMs = this.renderTimeZonePartsAsUtcMs(utcMs, timeZone);
                if (!Number.isFinite(renderedMs)) return null;
                const nextUtcMs = utcMs - (renderedMs - targetMs);
                if (Math.abs(nextUtcMs - utcMs) < 1) return nextUtcMs;
                utcMs = nextUtcMs;
            }

            return utcMs;
        }

        renderTimeZonePartsAsUtcMs(utcMs, timeZone) {
            try {
                const formatter = new Intl.DateTimeFormat('en-US', {
                    timeZone,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hourCycle: 'h23',
                });
                const formatted = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map(part => [part.type, part.value]));
                const milli = ((utcMs % 1000) + 1000) % 1000;
                return Date.UTC(
                    Number(formatted.year),
                    Number(formatted.month) - 1,
                    Number(formatted.day),
                    Number(formatted.hour),
                    Number(formatted.minute),
                    Number(formatted.second),
                    milli
                );
            } catch (_) {
                return null;
            }
        }

        async syncClock(force = false) {
            if (!force && this.clockSyncInFlight) return this.clockSyncInFlight;

            const ageMs = this.clockSyncedAt ? (this.nowMs() - this.clockSyncedAt) : Infinity;
            if (!force && ageMs < this.clockResyncIntervalMs) {
                return { source: this.clockSource, offsetMs: this.clockOffsetMs, ageMs };
            }

            const run = (async () => {
                // Sequential fallback (not Promise.any race): racing aborted every
                // losing source and spammed NetworkHealth with false "timeapi DEGRADED"
                // even when Akamai already won the clock sync.
                const fetchSource = async (source, timeoutMs = 4000) => {
                    const ctrl = new AbortController();
                    const timeoutId = setTimeout(() => {
                        try {
                            ctrl.abort(new DOMException(`Async refresh fetch timed out after ${timeoutMs}ms`, 'TimeoutError'));
                        } catch (_) {
                            try { ctrl.abort(); } catch (_) { }
                        }
                    }, timeoutMs);
                    try {
                        const res = await fetch(source.url, { signal: ctrl.signal, cache: 'no-store' });
                        if (!res.ok) throw new Error(`${source.name} HTTP ${res.status}`);
                        const data = source.isText ? await res.text() : await res.json();
                        const sourceMs = source.parse(data);
                        if (!Number.isFinite(sourceMs)) throw new Error(`${source.name} returned invalid timestamp`);
                        return { ...source, sourceMs };
                    } finally {
                        clearTimeout(timeoutId);
                    }
                };

                try {
                    let winner = null;
                    let lastErr = null;
                    for (const source of this.timeSyncSources) {
                        try {
                            // Prefer fast text sources (Akamai ~200ms); give JSON APIs more headroom.
                            const timeoutMs = source.isText ? 2500 : 5000;
                            winner = await fetchSource(source, timeoutMs);
                            break;
                        } catch (err) {
                            lastErr = err;
                        }
                    }
                    if (!winner) throw lastErr || new Error('all clock sources failed');

                    const localMs = Date.now();
                    const offsetMs = winner.sourceMs - localMs;
                    this.clockOffsetMs = offsetMs;
                    this.clockSource = winner.name;
                    this.clockSyncedAt = localMs;
                    console.log(
                        `[AsyncRefreshEngine] Clock synced via ${winner.name} ` +
                        `(offset ${offsetMs >= 0 ? '+' : ''}${offsetMs}ms, ` +
                        `ET ${this.formatEasternTime(winner.sourceMs)})`
                    );
                    return { source: winner.name, offsetMs, sourceMs: winner.sourceMs, syncedAt: localMs };
                } catch (err) {
                    console.warn('[AsyncRefreshEngine] Clock sync failed; keeping last known offset.', err.message);
                    if (!this.clockSyncedAt) {
                        this.clockOffsetMs = 0;
                        this.clockSource = 'system';
                    }
                    return { source: this.clockSource, offsetMs: this.clockOffsetMs, error: err.message };
                }
            })();

            this.clockSyncInFlight = run.finally(() => {
                if (this.clockSyncInFlight === run) this.clockSyncInFlight = null;
            });

            return this.clockSyncInFlight;
        }

        formatEasternTime(ts = this.nowMs()) {
            try {
                const parts = this.etFormatter.formatToParts(new Date(ts));
                const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
                return `${map.month}/${map.day}/${map.year} ${map.hour}:${map.minute}:${map.second} ${map.timeZoneName || 'ET'}`;
            } catch (_) {
                return new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' });
            }
        }

        /**
         * STREAM 1: Predictions (30s cycle)
         * Runs in background continuously. UI gets notified of new predictions via event.
         */
        async streamPredictions(runId) {
            const streamId = 'predictions';
            let cycle = 0;
            // Visible UI: 30s. Hidden / headless Canada node: 45s (less CPU, same decision quality).
            const cycleMs = () => (typeof document !== 'undefined' && document.hidden) ? 45_000 : 30_000;
            let nextRunAt = this.nextAlignedAt(cycleMs());

            while (this.running && this.runId === runId) {
                try {
                    await this.sleepUntil(nextRunAt);
                    if (!this.running || this.runId !== runId) break;

                    cycle++;
                    const cycleStart = this.nowMs();
                    const period = cycleMs();

                    // Trigger prediction run asynchronously
                    if (window.PredictionEngine?.runAll) {
                        const predictionPromise = Promise.resolve().then(() => window.PredictionEngine.runAll());

                        // Timeout guard: 22s (lighter candle/walk-forward should finish well under this)
                        const predictions = await Promise.race([
                            predictionPromise,
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Predictions timeout (22s)')), 22000)
                            )
                        ]);

                        const elapsedMs = this.nowMs() - cycleStart;

                        // Emit event so UI can update (non-blocking)
                        this.bus.emit('predictions:updated', {
                            predictions: window._predictions || {},
                            cycle,
                            elapsedMs,
                            timestamp: this.nowMs()
                        });

                        this.metrics.totalUpdates++;
                        this.metrics.lastUpdateTs = this.nowMs();
                        this.setStreamState(streamId, {
                            status: 'ok',
                            cycle,
                            detail: `${elapsedMs}ms`,
                        });

                        console.log(`[Stream:Predictions] Cycle ${cycle} complete (${elapsedMs}ms, period=${period}ms)`);
                    }

                    nextRunAt = this.nextAlignedAt(period, nextRunAt + period);
                } catch (err) {
                    console.warn(`[Stream:Predictions] Error:`, err.message);
                    this.setStreamState(streamId, {
                        status: 'error',
                        cycle,
                        detail: err.message,
                    });
                    await this.sleepUntil(this.nowMs() + 5_000);
                    nextRunAt = this.nextAlignedAt(cycleMs());
                }
            }
        }

        /**
         * STREAM 1b: Order book imbalance (fast, async, no REST dependency)
         * Samples live WebSocket books independently from the heavier prediction
         * cycle and asks the prediction engine to rescore only when imbalance is
         * meaningful or changing fast.
         */
        async streamOrderBookImbalance(runId) {
            const streamId = 'orderbook-imbalance';
            const coins = () => (window.PREDICTION_COINS || [])
                .map(c => c && c.sym)
                .filter(Boolean);
            let cycle = 0;
            const lastBySym = {};
            const lastRescoreTs = {};    // Per-coin rescore cooldown tracker
            const RESCORE_COOLDOWN_MS = 12_000; // Min 12s between rescores per coin (was 10s)
            const OBSERVE_COOLDOWN_MS = 4000; // Min 4s between tuner observations per coin
            const lastObserveTs = {};

            while (this.running && this.runId === runId) {
                try {
                    const hidden = typeof document !== 'undefined' && document.hidden;
                    // Visible: 1.5s sample. Hidden: 8s (was 5s idle still spinning).
                    const intervalMs = hidden ? 8000 : 1500;
                    await this.sleep(intervalMs);
                    if (!this.running || this.runId !== runId) break;
                    if (hidden) continue; // Skip all work when tab is backgrounded

                    cycle++;
                    const nowMs = this.nowMs();
                    const updates = [];
                    for (const sym of coins()) {
                        const book = window.OB?.getFreshBook?.(sym, 3000) || window.OB?.books?.[sym] || null;
                        const balance = window.OB?.getBalanceMetrics?.(sym) || null;
                        const imbalance = Number(balance?.imbalance?.value ?? 0);
                        const band = balance?.imbalance?.band || 'unknown';
                        const ageMs = book?.timestamp ? Math.max(0, nowMs - book.timestamp) : Infinity;
                        if (!book || ageMs > 3500) continue;

                        const prev = lastBySym[sym] || {};
                        const delta = Math.abs(imbalance - Number(prev.imbalance || 0));
                        const absImb = Math.abs(imbalance);
                        const closeMs = (() => {
                            const close = window.PredictionMarkets?.getCoin?.(sym)?.kalshi15m?.closeTime;
                            if (!close) return null;
                            const ms = new Date(close).getTime() - nowMs;
                            return Number.isFinite(ms) ? ms : null;
                        })();
                        const closeValueWindow = Number.isFinite(closeMs) && closeMs <= 210000 && closeMs >= 45000;

                        // Throttled adaptive tuner observation — skip if called recently
                        const observeAge = nowMs - (lastObserveTs[sym] || 0);
                        if (observeAge >= OBSERVE_COOLDOWN_MS) {
                            try {
                                window._adaptiveTuner?.observeLiveMarketState?.(sym, {
                                    pred: window._predictions?.[sym] || window._lastPrediction?.[sym] || null,
                                    cfm: window._cfmAll?.[sym] || window.CFMEngine?.getAll?.()?.[sym] || null,
                                    secsLeft: Number.isFinite(closeMs) ? closeMs / 1000 : null,
                                    bookImbalance: imbalance,
                                    buyRatio: balance?.flow?.buyRatio,
                                    reason: 'orderbook-imbalance-scan',
                                });
                                lastObserveTs[sym] = nowMs;
                            } catch (_) {}
                        }

                        const shouldRescore = closeValueWindow
                            || absImb >= 0.20
                            || delta >= 0.07
                            || /strong|extreme/.test(String(band));

                        lastBySym[sym] = { imbalance, band, ts: nowMs };
                        if (!shouldRescore) continue;

                        // Per-coin rescore cooldown — prevents computePrediction from
                        // being called every 1s during close windows (was causing freeze)
                        const rescoreAge = nowMs - (lastRescoreTs[sym] || 0);
                        if (rescoreAge < RESCORE_COOLDOWN_MS) continue;

                        let prediction = null;
                        if (window.PredictionEngine?.rescoreLiveMicrostructure) {
                            prediction = window.PredictionEngine.rescoreLiveMicrostructure(sym, {
                                reason: closeValueWindow ? 'close-window-book-scan' : 'orderbook-imbalance-scan',
                            });
                            lastRescoreTs[sym] = nowMs;
                        }
                        updates.push({ sym, imbalance, band, delta, closeMs, rescored: !!prediction });
                        await this.sleep(0); // Yield to prevent UI freeze during mass repricing
                    }

                    if (updates.length) {
                        this.bus.emit('orderbook:imbalance', {
                            cycle,
                            updates,
                            timestamp: nowMs,
                        });
                    }

                    this.setStreamState(streamId, {
                        status: 'ok',
                        cycle,
                        detail: updates.length ? `${updates.length} cues` : 'heartbeat',
                    });
                } catch (err) {
                    console.warn(`[Stream:OrderBookImbalance] Error:`, err.message);
                    this.setStreamState(streamId, {
                        status: 'error',
                        cycle,
                        detail: err.message,
                    });
                    await this.sleep(3000);
                }
            }
        }

        /**
         * STREAM 3: Market Data (adaptive frequency)
         * Fetches market data on a dynamic schedule.
         * Fast during settlement windows, slower during quiet periods.
         */
        async streamMarketData(runId) {
            const streamId = 'market-data';
            let cycle = 0;

            while (this.running && this.runId === runId) {
                try {
                    const msUntilSettlement = this.msUntilNextSettlementBoundary();
                    const nearBoundary = msUntilSettlement < 60000; // < 1 min before boundary
                    const desiredInterval = document.hidden ? 60000 : (nearBoundary ? 3000 : 15000);
                    const nextRunAt = this.nextAlignedAt(desiredInterval);

                    await this.sleepUntil(nextRunAt);
                    if (!this.running || this.runId !== runId) break;

                    cycle++;
                    const start = this.nowMs();

                    // Fetch market data (non-blocking call)
                    let fetchResult = null;
                    if (window.fetchAll) {
                        fetchResult = await this.runLockedFetch('fetchAll', () => Promise.race([
                            Promise.resolve().then(() => window.fetchAll(false, false)),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Market data timeout')), 20000)
                            )
                        ]), {
                            minGapMs: nearBoundary ? 1500 : 5000,
                            force: false,
                        });

                        const elapsedMs = this.nowMs() - start;

                        if (!fetchResult?.skipped) {
                            this.bus.emit('market:data-updated', {
                                cycle,
                                elapsedMs,
                                nextIntervalMs: desiredInterval,
                                timestamp: this.nowMs()
                            });
                        }

                        this.setStreamState(streamId, {
                            status: fetchResult?.skipped ? 'debounced' : 'ok',
                            cycle,
                            detail: fetchResult?.skipped
                                ? `${fetchResult.reason} (${fetchResult.ageMs}ms old)`
                                : `${elapsedMs}ms, next ${desiredInterval}ms`,
                        });
                    }
                } catch (err) {
                    console.warn(`[Stream:MarketData] Error:`, err.message);
                    this.setStreamState(streamId, {
                        status: 'error',
                        cycle,
                        detail: err.message,
                    });
                    await this.sleepUntil(this.nowMs() + 20000);
                }
            }
        }

        /**
         * STREAM 4: Settlement Pulses (quarterly)
         * Fires at every :00/:15/:30/:45 boundary.
         * Triggers high-priority data fetches and contract list updates.
         */
        async streamSettlementPulse(runId) {
            const streamId = 'settlement-pulse';
            let pulseCount = 0;

            while (this.running && this.runId === runId) {
                try {
                    const nextBoundaryTs = this.nextSettlementBoundaryTs();

                    // Wait until next settlement boundary
                    await this.sleepUntil(nextBoundaryTs + 100); // +100ms buffer

                    if (!this.running || this.runId !== runId) break;

                    pulseCount++;
                    const now = new Date();
                    const label = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                    console.log(`[Stream:SettlementPulse] ⚡ ${label} — PULSE #${pulseCount}`);

                    // High-priority market data fetch (no cache)
                    if (window.fetchAll) {
                        await this.runLockedFetch('fetchAll', () => Promise.race([
                            Promise.resolve().then(() => window.fetchAll(true, true)),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Settlement fetch timeout')), 15000)
                            )
                        ]), { force: true });
                    }

                    // Update Polymarket contracts
                    if (window.PredictionMarkets?.fetchAll) {
                        await this.runLockedFetch(
                            'prediction-markets-fetchAll',
                            () => window.PredictionMarkets.fetchAll(),
                            { force: true, minGapMs: 1000 }
                        );
                    }

                    this.bus.emit('settlement:pulse', {
                        pulseCount,
                        time: label,
                        timestamp: this.nowMs()
                    });

                    this.setStreamState(streamId, {
                        status: 'ok',
                        cycle: pulseCount,
                        detail: `pulse @ ${label}`,
                    });
                } catch (err) {
                    console.warn(`[Stream:SettlementPulse] Error:`, err.message);
                    this.setStreamState(streamId, {
                        status: 'error',
                        cycle: pulseCount,
                        detail: err.message,
                    });
                }
            }
        }

        /**
         * Helper: Calculate ms until next settlement boundary (:00/:15/:30/:45)
         */
        msUntilNextSettlementBoundary() {
            return Math.max(1000, this.nextSettlementBoundaryTs() - this.nowMs());
        }

        /**
         * Helper: Return the next absolute quarter-hour boundary timestamp.
         */
        nextSettlementBoundaryTs() {
            const now = this.nowMs();
            const nextBoundary = Math.ceil(now / 900_000) * 900_000;
            return nextBoundary;
        }

        /**
         * Helper: Return the next absolute boundary for a cadence, optionally
         * anchored to an existing target to avoid cumulative jitter.
         */
        nextAlignedAt(periodMs, anchorTs = this.nowMs()) {
            const base = Math.floor(anchorTs / periodMs) * periodMs;
            const next = base + periodMs;
            return Math.max(this.nowMs(), next);
        }

        setStreamState(streamId, state = {}) {
            this.metrics.streamStates[streamId] = {
                status: state.status || 'ok',
                cycle: state.cycle ?? null,
                detail: state.detail || '',
                lastSeen: this.nowMs(),
            };
        }

        async runLockedFetch(key, fn, options = {}) {
            const { force = false, minGapMs = 0 } = options;
            const now = this.nowMs();
            const inFlight = this.fetchLocks.get(key);

            if (inFlight) {
                if (!force) return inFlight;
                try { await inFlight; } catch (_) {}
            }

            const lastRun = this.fetchLastRun.get(key) || 0;
            const ageMs = Math.max(0, now - lastRun);
            if (!force && minGapMs > 0 && ageMs < minGapMs) {
                return { skipped: true, reason: 'debounced', ageMs };
            }

            const run = Promise.resolve()
                .then(fn)
                .finally(() => {
                    if (this.fetchLocks.get(key) === run) this.fetchLocks.delete(key);
                    this.fetchLastRun.set(key, this.nowMs());
                });

            this.fetchLocks.set(key, run);
            return run;
        }

        /**
         * Helper: Sleep until an absolute timestamp.
         */
        sleepUntil(targetTs) {
            return this.sleep(Math.max(0, targetTs - this.nowMs()));
        }

        /**
         * Helper: Non-blocking sleep
         */
        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        /**
         * Expose event subscriptions to UI
         */
        on(event, callback) {
            return this.bus.on(event, callback);
        }

        /**
         * Get current engine metrics
         */
        getMetrics() {
            return {
                ...this.metrics,
                running: this.running,
                uptime: this.nowMs() - (this.metrics.startMs || this.nowMs()),
                clockSource: this.clockSource,
                clockOffsetMs: this.clockOffsetMs,
                clockSyncedAt: this.clockSyncedAt,
                clockTimeET: this.formatEasternTime(this.nowMs())
            };
        }

        /**
         * Expose debug log
         */
        getStatus() {
            const status = [];
            status.push('═══════════════════════════════════════════');
            status.push('AsyncRefreshEngine Status');
            status.push('═══════════════════════════════════════════');
            status.push(`Running: ${this.running ? '✓ YES' : '✗ NO'}`);
            status.push(`Clock: ${this.clockSource} (offset ${this.clockOffsetMs >= 0 ? '+' : ''}${this.clockOffsetMs}ms)`);
            status.push(`Now ET: ${this.formatEasternTime(this.nowMs())}`);
            status.push(`Total Updates: ${this.metrics.totalUpdates}`);
            status.push(`Last Update: ${this.formatEasternTime(this.metrics.lastUpdateTs || this.nowMs())}`);
            status.push('Stream States:');
            for (const [stream, state] of Object.entries(this.metrics.streamStates)) {
                if (state && typeof state === 'object') {
                    const seen = state.lastSeen ? this.formatEasternTime(state.lastSeen) : 'n/a';
                    const cycle = state.cycle != null ? ` cycle ${state.cycle}` : '';
                    status.push(`  ${stream}: ${state.status}${cycle} — ${state.detail || 'heartbeat'} @ ${seen}`);
                } else {
                    status.push(`  ${stream}: ${state}`);
                }
            }
            status.push('═══════════════════════════════════════════');
            return status.join('\n');
        }
    }

    // ── Global Instance ────────────────────────────────────────────
    window.AsyncRefreshEngine = AsyncRefreshEngine;
    window._asyncRefreshEngine = new AsyncRefreshEngine();
    window.WeCryptoClock = {
        nowMs: () => window._asyncRefreshEngine?.nowMs?.() ?? Date.now(),
        formatEasternTime: (ts) => window._asyncRefreshEngine?.formatEasternTime?.(ts),
        syncClock: (force = false) => window._asyncRefreshEngine?.syncClock?.(force),
        getStatus: () => window._asyncRefreshEngine?.getMetrics?.()
    };

    console.log('[AsyncRefreshEngine] Ready — use window._asyncRefreshEngine.start() to begin');
})();
