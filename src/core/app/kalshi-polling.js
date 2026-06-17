// Kalshi Polling Logic
(function() {
function startKalshiPolling() {
    if (!window._asyncRefreshEngine) {
      console.warn('[WE] Async engine not loaded yet — skipping Kalshi polling setup');
      return;
    }

    // Subscribe to balance updates from async engine
    const unsub = window._asyncRefreshEngine.on('kalshi:balance-updated', (data) => {
      // Update UI badge with new balance
      const badge = document.getElementById('kalshiBadge');
      const balanceEl = document.getElementById('kalshiBalance');
      if (badge && balanceEl) {
        badge.hidden = false;
        const dollars = (data.balance / 100).toFixed(2);
        balanceEl.textContent = `$${dollars}`;
        balanceEl.classList.add('updating');
        setTimeout(() => balanceEl.classList.remove('updating'), 300);
      }
      console.log(`[Kalshi] Balance updated: $${(data.balance / 100).toFixed(2)}`);
    });

    console.log('[WE] Kalshi polling connected to async engine');
    return unsub;
  }

function stopKalshiPolling() {
    // Unsubscribe handled via returned unsub function from startKalshiPolling()
    if (kalshiPollTimer) {
      clearInterval(kalshiPollTimer);
      kalshiPollTimer = null;
    }
  }

function loadKalshiHistoricalContracts() {
    if (!window._kalshiLog || !Array.isArray(window._kalshiLog)) return;
    const seen = new Set();
    let loaded = 0;

    window._kalshiLog.forEach(contract => {
      // Deduplicate by sym + resolved_at
      const key = `${contract.sym}|${contract.resolved_at}`;
      if (!seen.has(key)) {
        seen.add(key);
        // Only add settled contracts (those with outcome)
        if (contract.outcome && contract._settled) {
          // Ensure contractCache exists
          if (!window.contractCache) window.contractCache = [];

          window.contractCache.push({
            sym: contract.sym,
            direction: contract.direction,
            confidence: contract.confidence,
            settlement_price: contract.settlement_price,
            market_status: contract.market_status,
            resolved_price: contract.resolved_price,
            created_at: contract.created_at,
            resolved_at: contract.resolved_at,
            outcome: contract.outcome,
            modelCorrect: contract.modelCorrect,
            marketCorrect: contract.marketCorrect,
            fadeCorrect: contract.fadeCorrect
          });
          loaded++;
        }
      }
    });

    if (loaded > 0) {
      console.log(`✅ [KalshiHistoricalLoader] Loaded ${loaded} historical contracts from _kalshiLog`);
    }
  }

function scheduleNewContractRetries() {
    let retryIdx = 0;
    function attempt() {
      if (retryIdx >= _CONTRACT_RETRY_DELAYS.length) {
        console.info('[WE] 🔚 New-contract retry sequence exhausted');
        return;
      }
      const delay = _CONTRACT_RETRY_DELAYS[retryIdx] * 1000;
      retryIdx++;
      setTimeout(async () => {
        if (document.hidden) { attempt(); return; } // tab hidden — defer
        const pmAll = window.PredictionMarkets?.getAll?.() || {};
        const ready = _CONTRACT_SYMS.filter(s => pmAll[s]?.kalshi15m?.ticker);
        if (ready.length === _CONTRACT_SYMS.length) {
          console.info('[WE] ✅ All 7 new Kalshi 15M contracts loaded — retry done');
          return; // all coins have fresh contracts — stop
        }
        console.info(`[WE] 🔄 New-contract retry #${retryIdx} — ${ready.length}/7 ready (${ready.join(',') || 'none'}) — fetching…`);
        if (feedText) feedText.textContent = `🔄 Awaiting new contracts (${ready.length}/7)…`;
        await window.PredictionMarkets?.fetchAll?.();
        // Re-check after fetch
        const pmAll2 = window.PredictionMarkets?.getAll?.() || {};
        const ready2 = _CONTRACT_SYMS.filter(s => pmAll2[s]?.kalshi15m?.ticker);
        if (ready2.length === _CONTRACT_SYMS.length) {
          console.info('[WE] ✅ All 7 new Kalshi 15M contracts loaded after fetch — retry done');
          if (feedText) feedText.textContent = `✅ New contracts ready`;
          return;
        }
        attempt(); // still missing some — schedule next retry
      }, delay);
    }
    // Kick off first retry 10s after the boundary pulse completes
    setTimeout(attempt, 10_000);
  }
window.APP_KALSHI_POLLING = {
  startKalshiPolling, stopKalshiPolling, loadKalshiHistoricalContracts, scheduleNewContractRetries
};
})();
