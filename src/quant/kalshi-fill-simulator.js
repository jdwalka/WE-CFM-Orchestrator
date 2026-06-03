/**
 * ================================================================
 * Kalshi 15m Binary Fill Simulator
 * Models quote->fill drift, spread widening, queue priority,
 * partial fills, and liquidity collapse risk.
 * ================================================================
 */

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof root !== 'undefined') {
        root.KalshiFillSimulator = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const EPS = 1e-9;

    function clamp(value, min, max) {
        const n = Number(value);
        if (!Number.isFinite(n)) return min;
        return Math.min(max, Math.max(min, n));
    }

    function toNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function bpsToPrice(price, bps) {
        return (Number(price) * Number(bps)) / 20000;
    }

    function createSeededRng(seed) {
        let state = (Number(seed) >>> 0) || 1;
        return function next() {
            state += 0x6D2B79F5;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function normalizeParams(input = {}) {
        const warnings = [];

        const deterministic = input.deterministic !== false;
        const seed = toNumber(input.seed, 12345);

        const side = String(input.side || 'BUY_YES').toUpperCase();
        if (!['BUY_YES', 'BUY_NO', 'SELL_YES', 'SELL_NO'].includes(side)) {
            warnings.push('Invalid side; defaulting to BUY_YES');
        }

        const normalized = {
            deterministic,
            seed,
            side: ['BUY_YES', 'BUY_NO', 'SELL_YES', 'SELL_NO'].includes(side) ? side : 'BUY_YES',
            quotePrice: clamp(toNumber(input.quotePrice, 0.5), 0.01, 0.99),
            midPrice: clamp(toNumber(input.midPrice, input.quotePrice ?? 0.5), 0.01, 0.99),
            spreadBps: clamp(toNumber(input.spreadBps, 90), 1, 5000),
            latencyMs: clamp(toNumber(input.latencyMs, 250), 0, 30000),
            volatilityBpsPerSec: clamp(toNumber(input.volatilityBpsPerSec, 30), 0, 5000),
            adverseSelection: clamp(toNumber(input.adverseSelection, 0.6), 0, 1.5),
            queueAhead: clamp(toNumber(input.queueAhead, 8), 0, 100000),
            queueOutflowPerSec: clamp(toNumber(input.queueOutflowPerSec, 2.5), 0.01, 50000),
            orderSize: clamp(toNumber(input.orderSize, 10), 1, 1000000),
            visibleSize: clamp(toNumber(input.visibleSize, 200), 1, 1000000),
            liquidityScore: clamp(toNumber(input.liquidityScore, 0.75), 0, 1),
            collapseProbability: clamp(toNumber(input.collapseProbability, 0.04), 0, 1),
            collapseSeverity: clamp(toNumber(input.collapseSeverity, 0.5), 0, 1),
            maxSlippageBps: clamp(toNumber(input.maxSlippageBps, 1200), 1, 5000),
            minFillProbability: clamp(toNumber(input.minFillProbability, 0.01), 0, 1),
            maxFillProbability: clamp(toNumber(input.maxFillProbability, 0.995), 0, 1),
        };

        if (normalized.minFillProbability >= normalized.maxFillProbability) {
            warnings.push('minFillProbability >= maxFillProbability; resetting to defaults');
            normalized.minFillProbability = 0.01;
            normalized.maxFillProbability = 0.995;
        }

        if (normalized.orderSize > normalized.visibleSize * 10) {
            warnings.push('orderSize is >10x visibleSize; partial-fill probability will be very low');
        }

        return { params: normalized, warnings };
    }

    function estimateFill(input = {}) {
        const { params, warnings } = normalizeParams(input);
        const rng = params.deterministic ? null : createSeededRng(params.seed);

        const latencySec = params.latencyMs / 1000;
        const driftBpsRaw = latencySec * params.volatilityBpsPerSec * params.adverseSelection;
        const driftBps = Math.min(params.maxSlippageBps, Math.max(0, driftBpsRaw));

        const spreadWidenBps = Math.min(
            2500,
            params.spreadBps * (1 + (1 - params.liquidityScore) * 1.4 + params.collapseProbability * 1.8)
        );

        const queueCleared = params.queueOutflowPerSec * latencySec;
        const queueProgress = clamp(queueCleared / (params.queueAhead + EPS), 0, 1.5);
        const queueFillProb = clamp(queueProgress, 0, 1);

        const sizePressure = clamp(params.orderSize / (params.visibleSize + EPS), 0, 10);
        const partialFillRatio = clamp(
            (params.visibleSize / (params.orderSize + params.queueAhead + EPS)) * params.liquidityScore,
            0,
            1
        );

        const baseFill = queueFillProb * (1 - Math.min(0.9, sizePressure * 0.35));
        const collapseHit = params.collapseProbability * params.collapseSeverity;
        const fillProbabilityRaw = baseFill * (1 - collapseHit) * (0.4 + 0.6 * params.liquidityScore);
        const fillProbability = clamp(
            fillProbabilityRaw,
            params.minFillProbability,
            params.maxFillProbability
        );

        const sideSign = params.side.startsWith('BUY') ? 1 : -1;
        const expectedSlippageBps = clamp(
            driftBps + spreadWidenBps * 0.5 * (0.3 + 0.7 * sizePressure),
            0,
            params.maxSlippageBps
        );

        const expectedFillPrice = clamp(
            params.quotePrice + sideSign * bpsToPrice(params.quotePrice, expectedSlippageBps),
            0.001,
            0.999
        );

        const realizedFill = params.deterministic
            ? fillProbability
            : (rng() <= fillProbability ? 1 : 0);

        const realizedPartial = params.deterministic
            ? partialFillRatio
            : clamp(partialFillRatio + (rng() - 0.5) * 0.2, 0, 1);

        return {
            params,
            warnings,
            expected: {
                slippageBps: expectedSlippageBps,
                fillProbability,
                partialFillRatio,
                spreadWidenBps,
                latencyDriftBps: driftBps,
                fillPrice: expectedFillPrice,
            },
            realized: {
                fillHappened: params.deterministic ? fillProbability >= 0.5 : realizedFill === 1,
                fillProbabilitySampled: fillProbability,
                partialFillRatio: realizedPartial,
                fillPrice: expectedFillPrice,
            },
            diagnostics: {
                queueProgress,
                collapseHit,
                sizePressure,
                deterministic: params.deterministic,
            },
        };
    }

    function simulateBatch(trades = [], options = {}) {
        if (!Array.isArray(trades)) {
            return {
                results: [],
                summary: {
                    total: 0,
                    avgFillProbability: 0,
                    avgSlippageBps: 0,
                    fillRate: 0,
                },
                warnings: ['simulateBatch expects an array'],
            };
        }

        const deterministic = options.deterministic !== false;
        const baseSeed = toNumber(options.seed, 12345);
        const results = [];
        const warnings = [];

        let fillProbSum = 0;
        let slippageSum = 0;
        let fillCount = 0;

        for (let i = 0; i < trades.length; i++) {
            const trade = trades[i] || {};
            const sim = estimateFill({
                ...trade,
                deterministic,
                seed: baseSeed + i * 9973,
            });

            fillProbSum += sim.expected.fillProbability;
            slippageSum += sim.expected.slippageBps;
            if (sim.realized.fillHappened) fillCount++;
            if (sim.warnings.length) warnings.push(...sim.warnings.map(w => `[${i}] ${w}`));

            results.push({
                index: i,
                trade,
                ...sim,
            });
        }

        const total = results.length;
        return {
            results,
            summary: {
                total,
                avgFillProbability: total ? fillProbSum / total : 0,
                avgSlippageBps: total ? slippageSum / total : 0,
                fillRate: total ? fillCount / total : 0,
            },
            warnings,
        };
    }

    return {
        estimateFill,
        simulateBatch,
    };
});
