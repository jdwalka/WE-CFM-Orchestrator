/**
 * SignalSchedulerAgent
 *
 * Lightweight browser-side work scheduler for fetch-heavy prediction loops.
 * It keeps price, momentum, validation, and background lanes from stampeding
 * external APIs while preserving simple Promise semantics for callers.
 */
(function () {
  'use strict';

  const DEFAULT_LANES = {
    microstructure: { concurrency: 4, gapMs: 10, maxJobMs: 25000 },
    price: { concurrency: 3, gapMs: 25, maxJobMs: 20000 },
    momentum: { concurrency: 3, gapMs: 75, maxJobMs: 22000 },
    validation: { concurrency: 1, gapMs: 250, maxJobMs: 15000 },
    background: { concurrency: 2, gapMs: 150, maxJobMs: 25000 },
  };

  const DEFAULT_PROVIDERS = {
    default: { cooldownMs: 0, cooldownMaxMs: 30000, circuitThreshold: 4, circuitMs: 60000 },
  };

  function now() {
    return Date.now();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function normalizeLaneConfig(config) {
    const laneConfig = { ...DEFAULT_LANES, ...(config || {}) };
    const lanes = {};
    Object.entries(laneConfig).forEach(([name, lane]) => {
      lanes[name] = {
        concurrency: Math.max(1, Number(lane.concurrency) || 1),
        gapMs: Math.max(0, Number(lane.gapMs) || 0),
        maxJobMs: Math.max(0, Number(lane.maxJobMs) || 0),
        active: 0,
        lastStart: 0,
        queue: [],
        timer: null,
      };
    });
    return lanes;
  }

  function normalizeProviderConfig(config) {
    return { ...DEFAULT_PROVIDERS, ...(config || {}) };
  }

  class SignalSchedulerAgent {
    constructor(options = {}) {
      this.lanes = normalizeLaneConfig(options.lanes);
      this.providers = normalizeProviderConfig(options.providers);
      this.providerState = new Map();
      this.pendingDedupe = new Map();
      this.sourceSnapshots = new Map();
      this.boundaryState = new Map();
      this.sequence = 0;
    }

    schedule(work, options = {}) {
      if (typeof work !== 'function') {
        return Promise.reject(new TypeError('SignalSchedulerAgent.schedule requires a function'));
      }

      const laneName = this.lanes[options.lane] ? options.lane : 'background';
      const dedupeKey = options.dedupeKey ? String(options.dedupeKey) : null;
      if (dedupeKey && this.pendingDedupe.has(dedupeKey)) {
        return this.pendingDedupe.get(dedupeKey);
      }

      const promise = new Promise((resolve, reject) => {
        const requestedDelayMs = Math.max(0, Number(options.delayMs) || 0);
        const adaptiveBoundary = options.boundary
          ? this.computeAdaptiveBoundary({
            ...options.boundary,
            laneGapMs: this.lanes[laneName]?.gapMs || 0,
          })
          : null;
        const effectiveDelayMs = adaptiveBoundary
          ? Math.max(0, Number(adaptiveBoundary.recommendedDelayMs) || 0)
          : requestedDelayMs;

        const job = {
          id: ++this.sequence,
          work,
          options,
          provider: options.provider || 'default',
          earliestAt: now() + effectiveDelayMs,
          priority: Number(options.priorityBoost) || 0,
          createdAt: now(),
          boundary: adaptiveBoundary,
          resolve,
          reject,
        };

        const lane = this.lanes[laneName];
        lane.queue.push(job);
        this._pumpLane(laneName);
      });

      if (dedupeKey) {
        this.pendingDedupe.set(dedupeKey, promise);
        promise.finally(() => this.pendingDedupe.delete(dedupeKey)).catch(() => {});
      }

      return promise;
    }

    computeAdaptiveBoundary(boundary = {}) {
      const nowTs = now();
      const baseIntervalMs = Math.max(250, Number(boundary.baseIntervalMs) || Number(boundary.laneGapMs) || 1500);
      const minIntervalMs = Math.max(100, Number(boundary.minIntervalMs) || 150);
      const maxIntervalMs = Math.max(minIntervalMs, Number(boundary.maxIntervalMs) || 120000);

      const cumulativeVolume = Math.max(0, Number(boundary.cumulativeVolume) || 0);
      const volumeThreshold = Math.max(0, Number(boundary.volumeThreshold) || 0);
      const txCount = Math.max(0, Number(boundary.txCount) || 0);
      const txThreshold = Math.max(0, Number(boundary.txThreshold) || 0);
      const volumeProgress = Math.max(
        volumeThreshold > 0 ? cumulativeVolume / volumeThreshold : 0,
        txThreshold > 0 ? txCount / txThreshold : 0
      );
      const volumeTickTriggered = volumeProgress >= 1;

      const sigmaMean = Math.max(1e-9, Number(boundary.sigmaMean) || Number(boundary.sigmaAvg) || 0);
      const sigmaNow = Math.max(1e-9, Number(boundary.sigmaNow) || Number(boundary.sigmaLocal) || 0);
      const hasVolatilityWindow = sigmaMean > 0 && sigmaNow > 0;
      const volatilityRatio = hasVolatilityWindow ? sigmaMean / sigmaNow : 1;
      let elasticIntervalMs = hasVolatilityWindow
        ? baseIntervalMs * volatilityRatio
        : baseIntervalMs;

      const expiryTs = Number(boundary.expiryTs) || Number(boundary.contractExpiryTs) || 0;
      const remainingMs = expiryTs > nowTs ? expiryTs - nowTs : null;
      let decayMultiplier = 1;
      if (remainingMs != null) {
        if (remainingMs <= 1 * 60 * 1000) decayMultiplier = 0.08;
        else if (remainingMs <= 5 * 60 * 1000) decayMultiplier = 0.16;
        else if (remainingMs <= 15 * 60 * 1000) decayMultiplier = 0.34;
        else if (remainingMs <= 30 * 60 * 1000) decayMultiplier = 0.56;
        else if (remainingMs <= 60 * 60 * 1000) decayMultiplier = 0.78;
      }

      elasticIntervalMs *= decayMultiplier;
      if (volumeTickTriggered) {
        elasticIntervalMs = Math.min(elasticIntervalMs, Math.max(minIntervalMs, baseIntervalMs * 0.2));
      }

      const blockIntervalMs = Math.max(0, Number(boundary.blockIntervalMs) || Number(boundary.slotIntervalMs) || 0);
      const lastBlockTs = Number(boundary.lastBlockTs) || Number(boundary.lastFinalityTs) || 0;
      let blockAlignedDelayMs = null;
      if (blockIntervalMs > 0) {
        const anchor = lastBlockTs > 0 ? lastBlockTs : nowTs;
        const elapsed = Math.max(0, nowTs - anchor);
        const remainder = elapsed % blockIntervalMs;
        blockAlignedDelayMs = remainder === 0 ? 0 : (blockIntervalMs - remainder);
      }

      let recommendedDelayMs = elasticIntervalMs;
      if (blockAlignedDelayMs != null) recommendedDelayMs = Math.min(recommendedDelayMs, blockAlignedDelayMs);
      recommendedDelayMs = Math.max(minIntervalMs, Math.min(maxIntervalMs, Math.round(recommendedDelayMs)));

      const volPressure = hasVolatilityWindow ? Math.min(3, Math.max(0, sigmaNow / sigmaMean)) : 1;
      const kineticPressure = Math.max(0, (Math.min(2, volumeProgress) * 0.55) + (volPressure * 0.45));
      const orbitalTier = kineticPressure >= 1.6 ? 'f'
        : kineticPressure >= 1.25 ? 'd'
          : kineticPressure >= 0.85 ? 'p'
            : 's';

      return {
        mode: blockAlignedDelayMs != null ? 'network_elastic' : 'kinetic_elastic',
        recommendedDelayMs,
        baseIntervalMs,
        minIntervalMs,
        maxIntervalMs,
        volumeTickTriggered,
        volumeProgress: Number(volumeProgress.toFixed(4)),
        volatilityRatio: Number(volatilityRatio.toFixed(4)),
        decayMultiplier: Number(decayMultiplier.toFixed(4)),
        blockAlignedDelayMs,
        orbitalTier,
        kineticPressure: Number(kineticPressure.toFixed(4)),
        remainingMs,
        computedAt: nowTs,
      };
    }

    inferLaneFromUrl(url, fallback = 'background') {
      const provider = this.inferProviderFromUrl(url);
      if (provider === 'llm' || provider === 'kalshi') return 'validation';
      if (/orderbook|depth|l2|book|trades|recent-trade|histories/i.test(String(url || ''))) {
        return 'microstructure';
      }
      if (['pyth-lazer', 'coinbase', 'binance', 'kraken', 'bybit', 'okx', 'cdc'].includes(provider)) {
        return 'price';
      }
      if (['gecko', 'cmc', 'mempool', 'blockscout', 'solana', 'hyperliquid'].includes(provider)) {
        return 'momentum';
      }
      return fallback;
    }

    inferProviderFromUrl(url) {
      try {
        const host = new URL(String(url), window.location.href).hostname.toLowerCase();
        if (host.includes('pyth')) return 'pyth-lazer';
        if (host.includes('coinbase')) return 'coinbase';
        if (host.includes('binance')) return 'binance';
        if (host.includes('kraken')) return 'kraken';
        if (host.includes('bybit')) return 'bybit';
        if (host.includes('okx')) return 'okx';
        if (host.includes('crypto.com')) return 'cdc';
        if (host.includes('coingecko')) return 'gecko';
        if (host.includes('coinmarketcap')) return 'cmc';
        if (host.includes('kalshi')) return 'kalshi';
        if (host.includes('polymarket')) return 'polymarket';
        if (host.includes('mempool.space')) return 'mempool';
        if (host.includes('blockscout')) return 'blockscout';
        if (host.includes('solana')) return 'solana';
        if (host.includes('hyperliquid')) return 'hyperliquid';
        if (host.includes('openai') || host.includes('generativelanguage') || host.includes('googleapis')) return 'llm';
        return host.replace(/^api\./, '').split('.')[0] || 'default';
      } catch (_) {
        return 'default';
      }
    }

    markSourceFresh(provider, data, timestamp = now()) {
      this.sourceSnapshots.set(String(provider || 'default'), { data, timestamp: Number(timestamp) || now() });
    }

    getFreshSourceSnapshot(provider, ttlMs = 3000) {
      const entry = this.sourceSnapshots.get(String(provider || 'default'));
      if (!entry) return null;
      if (now() - entry.timestamp > Math.max(0, Number(ttlMs) || 0)) return null;
      return entry.data;
    }

    getHealthStatus() {
      const lanes = {};
      Object.entries(this.lanes).forEach(([name, lane]) => {
        lanes[name] = { active: lane.active, queued: lane.queue.length, gapMs: lane.gapMs };
      });
      const providers = {};
      this.providerState.forEach((state, name) => {
        providers[name] = {
          failures: state.failures,
          cooldownUntil: state.cooldownUntil,
          circuitUntil: state.circuitUntil,
          adaptiveBoundary: this.boundaryState.get(name) || null,
        };
      });
      return { lanes, providers, dedupe: this.pendingDedupe.size };
    }

    _pumpLane(laneName) {
      const lane = this.lanes[laneName];
      if (!lane || lane.timer || lane.active >= lane.concurrency || lane.queue.length === 0) return;

      const delayForGap = Math.max(0, lane.gapMs - (now() - lane.lastStart));
      if (delayForGap > 0) {
        lane.timer = setTimeout(() => {
          lane.timer = null;
          this._pumpLane(laneName);
        }, delayForGap);
        return;
      }

      lane.queue.sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
      const nextIndex = lane.queue.findIndex(job => job.earliestAt <= now());
      if (nextIndex === -1) {
        const nextAt = Math.min(...lane.queue.map(job => job.earliestAt));
        lane.timer = setTimeout(() => {
          lane.timer = null;
          this._pumpLane(laneName);
        }, Math.max(0, nextAt - now()));
        return;
      }

      const [job] = lane.queue.splice(nextIndex, 1);
      lane.active++;
      lane.lastStart = now();

      this._runJob(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          lane.active--;
          this._pumpLane(laneName);
        });

      this._pumpLane(laneName);
    }

    async _runJob(job) {
      const providerName = String(job.provider || 'default');
      const provider = this.providers[providerName] || this.providers.default || DEFAULT_PROVIDERS.default;
      const state = this._providerState(providerName);
      const laneName = this.lanes[job.options?.lane] ? job.options.lane : 'background';
      const lane = this.lanes[laneName];
      const waitUntil = Math.max(state.cooldownUntil || 0, state.circuitUntil || 0, job.earliestAt || 0);
      if (waitUntil > now()) {
        await sleep(waitUntil - now());
      }

      try {
        if (job.boundary) this.boundaryState.set(providerName, job.boundary);
        const timeoutMs = Number(job.options.timeoutMs) || Number(lane?.maxJobMs) || 0;
        const result = timeoutMs > 0
          ? await this._withTimeout(job.work, timeoutMs, job.options.tag)
          : await job.work();
        state.failures = 0;
        state.circuitUntil = 0;
        state.cooldownUntil = now() + Math.max(0, Number(provider.cooldownMs) || 0);
        return result;
      } catch (err) {
        state.failures++;
        const threshold = Math.max(1, Number(provider.circuitThreshold) || 4);
        const baseCooldown = Math.max(0, Number(provider.cooldownMs) || 0);
        const maxCooldown = Math.max(baseCooldown, Number(provider.cooldownMaxMs) || 30000);
        const backoff = Math.min(maxCooldown, baseCooldown * Math.pow(2, Math.max(0, state.failures - 1)));
        state.cooldownUntil = now() + backoff;
        if (state.failures >= threshold) {
          state.circuitUntil = now() + Math.max(0, Number(provider.circuitMs) || 60000);
        }
        throw err;
      }
    }

    _providerState(providerName) {
      if (!this.providerState.has(providerName)) {
        this.providerState.set(providerName, { failures: 0, cooldownUntil: 0, circuitUntil: 0 });
      }
      return this.providerState.get(providerName);
    }

    _withTimeout(work, timeoutMs, tag) {
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Scheduled task timed out${tag ? `: ${tag}` : ''}`)), timeoutMs);
      });
      return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
    }
  }

  window.SignalSchedulerAgent = SignalSchedulerAgent;
})();
