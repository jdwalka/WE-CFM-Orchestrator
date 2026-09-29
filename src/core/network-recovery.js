// Coordinated graceful reconnect after wake, manual refresh, or long idle.
(function () {
    'use strict';

    if (window.NetworkRecovery) return;

    const MIN_HIDDEN_MS = 45_000;
    const RECOVERY_COOLDOWN_MS = 12_000;
    const STAGGER_MS = 350;
    const CRITICAL_WAIT_MS = 10_000;

    let recoveryRenderTimer = null;
    let lastHiddenAt = 0;
    let recoveryInFlight = false;
    let lastRecoveryAt = 0;

    function scheduleUiRefresh() {
        if (typeof window.render !== 'function') return;
        if (recoveryRenderTimer) clearTimeout(recoveryRenderTimer);
        recoveryRenderTimer = setTimeout(() => {
            recoveryRenderTimer = null;
            try { window.render(); } catch (_) { }
        }, 800);
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitForCriticalHealthy(maxMs) {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            const summary = window.NetworkHealth?.getSummary?.();
            if (summary && summary.criticalHealthy >= summary.criticalTotal) return true;
            await sleep(500);
        }
        return false;
    }

    async function runGracefulRecovery(reason = 'manual') {
        if (recoveryInFlight) return { ok: false, skipped: 'in-flight' };
        const manual = String(reason).startsWith('manual');
        if (!manual && Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) {
            return { ok: false, skipped: 'cooldown' };
        }

        recoveryInFlight = true;
        lastRecoveryAt = Date.now();
        const nh = window.NetworkHealth;

        try {
            console.info(`[NetworkRecovery] Starting graceful recovery (${reason})`);
            nh?.beginRecovery?.(reason);
            nh?.syncLiveProbe?.();

            nh?.setRecoveryPhase?.('kalshi-wss');
            try { window.KalshiWS?.forceRetry?.(`recovery:${reason}`); } catch (_) { }
            try { window.forceKalshiWsRetry?.(`recovery:${reason}`); } catch (_) { }
            await sleep(STAGGER_MS);

            nh?.setRecoveryPhase?.('exchange-ws');
            try { window.ExchangeWS?.gracefulReconnect?.(); } catch (_) { }
            try { window.ExchangeWS?.warmOptionalWsRoutes?.(`recovery:${reason}`); } catch (_) { }
            await sleep(STAGGER_MS);

            nh?.setRecoveryPhase?.('pyth');
            try { window.EndpointTransport?.ensureKalshiWs?.(); } catch (_) { }
            await sleep(STAGGER_MS);

            nh?.setRecoveryPhase?.('tickers');
            if (typeof window.fetchAll === 'function') {
                await window.fetchAll(true);
            }
            await sleep(STAGGER_MS);

            nh?.setRecoveryPhase?.('markets');
            if (typeof window.PredictionMarkets?.fetchAll === 'function') {
                await window.PredictionMarkets.fetchAll().catch(() => { });
            }
            await sleep(STAGGER_MS);

            nh?.setRecoveryPhase?.('optional');
            try { window.ExchangeWS?.warmOptionalWsRoutes?.('optional-phase'); } catch (_) { }
            if (typeof window.BlockchainScan?.fetchAll === 'function') {
                await window.BlockchainScan.fetchAll().catch(() => { });
            }
            nh?.syncLiveProbe?.();
            await sleep(400);
            if (typeof window.CexFlow?.fetchAll === 'function') {
                await window.CexFlow.fetchAll().catch(() => { });
            }

            nh?.setRecoveryPhase?.('verify');
            nh?.syncLiveProbe?.();
            await waitForCriticalHealthy(CRITICAL_WAIT_MS);
            nh?.setRecoveryPhase?.('done');

            console.info('[NetworkRecovery] Graceful recovery complete');
            return { ok: true, reason };
        } catch (err) {
            console.warn('[NetworkRecovery] Recovery failed:', err?.message || err);
            return { ok: false, error: err?.message || String(err) };
        } finally {
            nh?.endRecovery?.();
            recoveryInFlight = false;
            try {
                window.dispatchEvent(new CustomEvent('network-recovery-complete', {
                    detail: { reason, at: Date.now() },
                }));
            } catch (_) { }
            scheduleUiRefresh();
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            lastHiddenAt = Date.now();
            return;
        }
        const hiddenMs = lastHiddenAt ? Date.now() - lastHiddenAt : 0;
        if (hiddenMs >= MIN_HIDDEN_MS) {
            void runGracefulRecovery(`wake:${Math.round(hiddenMs / 1000)}s`);
        } else {
            window.NetworkHealth?.syncLiveProbe?.();
        }
    });

    window.addEventListener('pageshow', (event) => {
        if (event.persisted) void runGracefulRecovery('bfcache-restore');
    });

    window.addEventListener('online', () => {
        void runGracefulRecovery('browser-online');
    });

    window.NetworkRecovery = {
        run: runGracefulRecovery,
        isRunning: () => recoveryInFlight,
    };
})();
