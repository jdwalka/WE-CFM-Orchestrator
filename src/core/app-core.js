// ================================================================
// Application Shell
// ================================================================


  const {
    _obsNum, _obsNormRegime, _obsPct, _obsEsc, _obsLatencyBuckets, 
    _obsGetQuantDriftSnapshot, _obsEmergencyToolsSummary, _obsBuildMetrics, _obsRenderHist
  } = window.APP_OBSERVABILITY || window;

  const startKalshiPolling = (window.APP_KALSHI_POLLING && window.APP_KALSHI_POLLING.startKalshiPolling) || (() => {});
  const stopKalshiPolling = (window.APP_KALSHI_POLLING && window.APP_KALSHI_POLLING.stopKalshiPolling) || (() => {});
  const loadKalshiHistoricalContracts = (window.APP_KALSHI_POLLING && window.APP_KALSHI_POLLING.loadKalshiHistoricalContracts) || (() => {});
  const scheduleNewContractRetries = (window.APP_KALSHI_POLLING && window.APP_KALSHI_POLLING.scheduleNewContractRetries) || (() => {});

  const {
    startDepthLive, updateDepthBook, updateDepthAlerts, updateDepthRawWalls, 
    updateDepthAnalyzer, drawLiqMap, initOBHud, drawOrbital, refreshCexFlow
  } = window.APP_ORDERBOOK_HUD || window;

  const {
    predictionCard, normalizePredictionCardData, getPredictionCoinMeta, 
    buildMarketDebugPanel, buildQuickDecisionPanel, getDecisionRationale,
    computeQuickMACD, formatSuborbital, evaluateSignal, buildCoinPeriodicTable,
    computeEntryQuality, detectMarketRegime, computeGroundState, buildOpportunitiesPanel,
    buildFifteenMinuteMovePlan, countConfirmingSignals, calcEdge, buildNarrativeCallouts,
    marketRow
  } = window.APP_UI_COMPONENTS || window;

let refreshTimer = null;

async function restoreLogsFromBackupIfNeeded() {
    try {
      const hasLocalLogs =
        (Array.isArray(window._predLog) && window._predLog.length > 0) ||
        (Array.isArray(window._marketSettlementLog) && window._marketSettlementLog.length > 0) ||
        (Array.isArray(window._kalshiErrors) && window._kalshiErrors.length > 0) ||
        (Array.isArray(window._orchLog) && window._orchLog.length > 0);

      if (hasLocalLogs) return;
      if (!window.dataStore?.readFile) return;

      for (const dir of LOG_BACKUP_TARGETS) {
        const fp = `${dir}\\wecrypto-log-backup.json`;
        const res = await window.dataStore.readFile(fp);
        if (!res?.ok || !res.content) continue;

        const parsed = JSON.parse(res.content);
        window._predLog = capArray(parsed.predLog);
        window._marketSettlementLog = capArray(parsed.marketLog);
        window._kalshiErrors = capArray(parsed.kalshiErrors);
        window._orchLog = capArray(parsed.orchLog);
        window._marketPredictionTrail = capTrailMap(parsed.marketTrail);
        capRuntimeLogs();

        try {
          localStorage.setItem(PRED_LOG_STORE, JSON.stringify(window._predLog));
          localStorage.setItem(MARKET_LOG_STORE, JSON.stringify(window._marketSettlementLog));
          localStorage.setItem(KALSHI_ERR_STORE, JSON.stringify(window._kalshiErrors));
          localStorage.setItem(ORCH_LOG_STORE, JSON.stringify(window._orchLog));
          localStorage.setItem(MARKET_TRAIL_STORE, JSON.stringify(window._marketPredictionTrail));
        } catch (err) { console.error('[Error caught]', err);  }

        console.log(`[LogBackup] Restored logs from ${fp}`);
        break;
      }
    } catch (e) {
      console.warn('[LogBackup] Restore from backup failed:', e.message);
    }
  }

const SCREENER_GECKO_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', LTC: 'litecoin', SOL: 'solana', AVAX: 'avalanche-2',
    DOT: 'polkadot', ATOM: 'cosmos', POL: 'polygon-ecosystem-token', ADA: 'cardano',
    XTZ: 'tezos', ARB: 'arbitrum', OP: 'optimism', SUI: 'sui', APT: 'aptos',
    SEI: 'sei-network', NEAR: 'near', BONK: 'bonk', PEPE: 'pepe', WIF: 'dogwifcoin',
    FLOKI: 'floki', JUP: 'jupiter-exchange-solana', AERO: 'aerodrome-finance',
    DYDX: 'dydx-chain', PYTH: 'pyth-network', RNDR: 'render-token', FET: 'fetch-ai',
    TAO: 'bittensor', XLM: 'stellar', LINK: 'chainlink', UNI: 'uniswap',
    AAVE: 'aave', ICP: 'internet-computer', HBAR: 'hedera-hashgraph',
    XRP: 'ripple', DOGE: 'dogecoin', HYPE: 'hyperliquid', BNB: 'binancecoin',
  };

const $ = (s, c) => (c || document).querySelector(s);

function normalizeTicker(t) {
    return {
      instrument_name: (t.i || t.instrument_name || '').replace(/_/g, ''),
      last: t.a ?? t.last,
      high: t.h ?? t.high,
      low: t.l ?? t.low,
      change: t.c ?? t.change,
      best_bid: t.b ?? t.best_bid,
      best_ask: t.k ?? t.best_ask,
      best_bid_size: t.bs ?? t.best_bid_size,
      best_ask_size: t.ks ?? t.best_ask_size,
      volume: t.v ?? t.volume,
      volume_value: t.vv ?? t.volume_value,
      timestamp: t.t ?? t.timestamp,
      source: 'crypto.com',
    };
  }

async function overlayBinance24hStats() {
    try {
      const stats = await fetchBinanceTickers();
      let updated = 0;
      stats.forEach(s => {
        const t = tickers[s.instrument_name];
        if (!t) return;
        // Overwrite 24h stats regardless of source — Binance has the authoritative 24h window
        t.high = s.high;
        t.low = s.low;
        t.change = s.change;
        t.volume = s.volume;
        t.volume_value = s.volume_value;
        t.best_bid = t.best_bid ?? s.best_bid;
        t.best_ask = t.best_ask ?? s.best_ask;
        updated++;
      });
      if (updated) refreshActiveView();
    } catch (e) {
      console.warn('[WE] Binance 24h overlay failed:', e.message);
    }
  }

const _CONTRACT_SYMS = ['BTC', 'ETH', 'XRP', 'DOGE', 'BNB'];

const _CONTRACT_RETRY_DELAYS = [15, 15, 15, 15, 30, 30, 30, 60, 60];


async function settlementPull() {
    const easternStamp = window.WeCryptoClock?.formatEasternTime?.() ||
      new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const label = easternStamp.match(/\b\d{2}:\d{2}\b/)?.[0] || easternStamp;
    console.info(`[WE] ⚡ Settlement pulse ${label} ET — blasting all CEXes + chain + markets`);
    if (feedText) feedText.textContent = `⚡ ${label} ET settlement…`;

    // Fire everything simultaneously — price blast + supporting data
    await Promise.allSettled([
      fetchAll(true, true),                           // all 6 CEXes race, no cache, no CDC window
      window.PredictionMarkets?.fetchAll?.(),         // fresh Kalshi/Polymarket probs for new contract
      window.BlockchainScan?.fetchAll?.(),            // fresh chain intelligence
      window.CexFlow?.fetchAll?.(),                   // fresh CEX flow snapshot
    ]);

    // Reset regular timer so streaming doesn't double-fire immediately after pulse
    resetTimer();
    console.info(`[WE] ⚡ Settlement pulse ${label} complete`);
    // Burst-retry until new Kalshi contracts appear (Kalshi lists them 2-4 min after boundary)
    scheduleNewContractRetries();
  }

let kalshiPollTimer = null;


function startAsyncRefreshEngine() {
    if (_asyncRefreshEngineBooted) return;
    if (!window._asyncRefreshEngine?.start) {
      console.warn('[WE] Async refresh engine unavailable — keeping legacy timers active');
      return;
    }

    _asyncRefreshEngineBooted = true;

    window._asyncRefreshEngine.on('predictions:updated', () => {
      _lastPredictionRunTs = Date.now();
      predsLoaded = true;
      try { snapshotPredictions(); } catch (err) { console.error('[Error caught]', err);  }
      if (['predictions', 'cfm', 'universe'].includes(currentView)) {
        scheduleAsyncUiRefresh('predictions');
      }
      scheduleWebStatePublish('async-predictions', 100);
    });

    window._asyncRefreshEngine.on('orderbook:imbalance', (payload) => {
      // Live tuner already observes per-coin inside the stream — avoid re-scanning all coins here.
      if (payload?.updates?.length && ['predictions', 'cfm', 'universe'].includes(currentView)) {
        scheduleAsyncUiRefresh('orderbook');
      }
      scheduleWebStatePublish('async-orderbook', 50);
    });

    window._asyncRefreshEngine.on('market:data-updated', () => {
      if (['cfm', 'predictions', 'universe', 'markets5m', 'charts'].includes(currentView)) {
        scheduleAsyncUiRefresh('market');
      }
      scheduleWebStatePublish('async-market', 100);
    });

    window._asyncRefreshEngine.on('settlement:pulse', () => {
      scheduleAsyncUiRefresh('settlement', true);
      scheduleWebStatePublish('async-settlement', 100);
    });

    void window._asyncRefreshEngine.start().catch(err => {
      console.warn('[WE] Async refresh engine start failed:', err.message);
      _asyncRefreshEngineBooted = false;
      resetTimer();
    });
  }


let historicalPollTimer = null;

let historicalPollInFlight = false;

let settledFetcher = null;

let learningEngine = null;

async function getPredictionForCoin(symbol, timestamp) {
    if (!window.PredictionEngine) return null;
    try {
      return window.PredictionEngine.predict(symbol);
    } catch (err) {
      return null;
    }
  }

const _BUCKET_MS = 15 * 60 * 1000;

const MIN_FLIP_STREAK = 5;

let _webStatePublishTimer = null;

let _webStateHeartbeat = null;

let _lastWebStateSig = '';

function _push1mToChart(sym, bucket) {
    if (!chartSeries?.candles || chartTf !== '1m') return;
    const coin = WATCHLIST.find(c => c.sym === sym);
    if (!coin || coin.instrument !== chartCoin) return;
    const bar = {
      time: Math.floor(bucket.t / 1000),
      open: bucket.o,
      high: bucket.h,
      low: bucket.l,
      close: bucket.c,
    };
    try {
      chartSeries.candles.update(bar);
      chartSeries.volume.update({
        time: bar.time,
        value: bucket.v,
        color: bucket.c >= bucket.o ? 'rgba(38,212,126,0.3)' : 'rgba(255,75,110,0.3)',
      });
    } catch (err) { console.error('[Error caught]', err);  /* lightweight-charts may reject out-of-order bars */ }
  }


function tvlUsd(meta) { return meta ? parseFloat(meta.tvlUsd || 0) : 0; }

const GECKO_ID_TO_SYMBOL = Object.fromEntries(Object.entries(SCREENER_GECKO_IDS).map(([sym, id]) => [id, sym]));

function ensurePredictionsScrollTracker() {
    if (_predScrollTrackerBound || !content) return;
    content.addEventListener('scroll', () => {
      if (currentView === 'predictions') _predLastUserScrollTs = Date.now();
    }, { passive: true });
    _predScrollTrackerBound = true;
  }

let _activeViewRefreshTimer = null;

let _lastActiveViewRefreshTs = 0;

const ASYNC_UI_REFRESH_GAPS = {
    microstructure: 4000,
    orderbook: 4000,
    market: 2000,
    predictions: 2500,
    settlement: 400,
    default: 2000,
  };

function scheduleAsyncUiRefresh(kind = 'default', force = false) {
    const gap = ASYNC_UI_REFRESH_GAPS[kind] || ASYNC_UI_REFRESH_GAPS.default;
    if (force) {
      if (_asyncUiRefreshTimer) {
        clearTimeout(_asyncUiRefreshTimer);
        _asyncUiRefreshTimer = null;
        _asyncUiRefreshCoalesce = false;
      }
      refreshActiveView(true);
      return;
    }
    if (_asyncUiRefreshTimer) {
      _asyncUiRefreshCoalesce = true;
      return;
    }
    const since = Date.now() - _lastActiveViewRefreshTs;
    const delay = Math.max(80, gap - since);
    _asyncUiRefreshTimer = setTimeout(() => {
      _asyncUiRefreshTimer = null;
      const again = _asyncUiRefreshCoalesce;
      _asyncUiRefreshCoalesce = false;
      refreshActiveView();
      if (again) scheduleAsyncUiRefresh(kind);
    }, delay);
  }

function refreshActiveView(force = false) {
    const now = Date.now();
    const minGap = (_asyncRefreshEngineBooted && window._asyncRefreshEngine?.running) ? 900 : 250;
    if (!force && now - _lastActiveViewRefreshTs < minGap) {
      if (!_activeViewRefreshTimer) {
        const waitMs = Math.max(80, minGap - (now - _lastActiveViewRefreshTs));
        _activeViewRefreshTimer = setTimeout(() => {
          _activeViewRefreshTimer = null;
          refreshActiveView(force);
        }, waitMs);
      }
      return;
    }
    _lastActiveViewRefreshTs = now;
    // NOTE: do NOT increment _rv here — refreshActiveView is a same-panel data refresh,
    // not navigation. Only render() (user nav click) should bump the version counter.
    const view = currentView;
    if (currentView === 'charts' && document.getElementById('chartContainer')) {
      updateChartMarketPanels();
      loadCandles({ showLoader: false, reuseChart: true });
      return;
    }
    if (currentView === 'cfm') {
      if (!force) {
        const sinceScroll = Date.now() - _cfmLastUserScrollTs;
        if (sinceScroll < CFM_SCROLL_IDLE_MS) {
          if (!_cfmDeferredRefreshTimer) {
            const waitMs = CFM_SCROLL_IDLE_MS - sinceScroll;
            _cfmDeferredRefreshTimer = setTimeout(() => {
              _cfmDeferredRefreshTimer = null;
              if (currentView === 'cfm') requestCFMRender();
            }, Math.max(120, waitMs));
          }
          return;
        }
      }
      if (_cfmDeferredRefreshTimer) {
        clearTimeout(_cfmDeferredRefreshTimer);
        _cfmDeferredRefreshTimer = null;
      }
      requestCFMRender(force);
      return;
    }
    if (currentView === 'predictions') {
      if (!force) {
        const sinceScroll = Date.now() - _predLastUserScrollTs;
        if (sinceScroll < PRED_SCROLL_IDLE_MS) {
          if (!_predDeferredRefreshTimer) {
            const waitMs = PRED_SCROLL_IDLE_MS - sinceScroll;
            _predDeferredRefreshTimer = setTimeout(() => {
              _predDeferredRefreshTimer = null;
              if (currentView === 'predictions') renderPredictions();
            }, Math.max(120, waitMs));
          }
          return;
        }
      }
      if (_predDeferredRefreshTimer) {
        clearTimeout(_predDeferredRefreshTimer);
        _predDeferredRefreshTimer = null;
      }
      renderPredictions();
      return;
    }
    if (currentView === 'screener') { renderScreener(); return; }
    if (currentView === 'universe') { renderUniverse(); return; }
    if (currentView === 'markets5m') { renderMarkets5M(); return; }
    if (currentView === 'polymarket') {
      if (window.PolymarketTerminal?.render) window.PolymarketTerminal.render();
      return;
    }
    if (currentView === 'debuglog') { renderDebugLog(); return; }
    if (currentView === 'observability') { renderObservability(); return; }
    if (currentView === 'hourly-ranges') return; // Panel manages its own 30s poll
    render();
  }

function formatAddress(addr) {
    return addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : '—';
  }

function formatUtc4Time(input) {
    const ms = typeof input === 'number' ? input : new Date(input).getTime();
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms - (4 * 60 * 60 * 1000)).toISOString().slice(11, 19);
  }
window.formatUtc4Time = formatUtc4Time;

const FILTER_GROUPS = {
    all: { label: 'All', pred: () => true },
    portfolio: { label: 'Modeled', pred: c => PORTFOLIO_HOLDINGS.some(h => h.sym === c.sym) },
    core: { label: 'Core', pred: c => c.group === 'core' },
    meme: { label: 'Memes', pred: c => c.group === 'meme' },
    defi: { label: 'DeFi', pred: c => c.group === 'defi' },
    layer2: { label: 'L2', pred: c => c.group === 'layer2' },
    layer1: { label: 'L1', pred: c => c.group === 'layer1' },
    ai: { label: 'AI', pred: c => c.group === 'ai' },
  };

let _markets5mCountdown = null;

let _markets5mFetchKickTs = 0;

let _markets5mPolyRefreshKickTs = 0;








let _llmObsStats = { completions: 0, queues: 0, accepted: 0, rejected: 0, provider: 'none', model: 'none', enabled: false };

let _telegramStatus = { connected: false, apiId: '', apiHash: '', channelToListen: 'polycool_copytrade_channel' };

let _telegramAuthRequest = null;

let _telegramFeeds = [];




async function loadCandles(options = {}) {
    const stage = document.getElementById('chartStage');
    if (!stage) return;
    const showLoader = options.showLoader !== false;

    // Map our TF labels to CDC API values
    const tfMap = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1D': '1D', '1W': '1W' };
    const tf = tfMap[chartTf] || '1h';

    try {
      if (showLoader) setChartLoading(true);
      const candles = await fetchCandlesticks(chartCoin, tf);
      chartSnapshot = tickers[chartCoin] || null;
      const series = candles
        .map(c => ({
          time: Math.floor(c[0] / 1000),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5] || 0),
        }))
        .sort((a, b) => a.time - b.time);

      ensureChart(stage);
      applyChartPriceFormat();
      chartRawCandles = series;
      chartSeries.candles.setData(series.map(({ volume, ...rest }) => rest));
      chartSeries.volume.setData(series.map(c => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,212,126,0.3)' : 'rgba(255,75,110,0.3)',
      })));
      updateChartOverlays();
      updateChartMarketPanels();

      // Zoom: short TFs show a tight window so candles are large and readable.
      // Longer TFs show all data (fitContent).
      // barSpacing is set explicitly per-TF so candle widths look right regardless of chart width.
      const ZOOM_WINDOW = { '1m': 60, '3m': 60, '5m': 80, '15m': 120 };
      const BAR_SPACING = { '1m': 5, '3m': 7, '5m': 9, '15m': 9 };
      const total = series.length;
      const show = ZOOM_WINDOW[chartTf];
      const bs = BAR_SPACING[chartTf];
      if (candleChart) {
        if (bs) candleChart.timeScale().applyOptions({ barSpacing: bs });
        if (show && total > show) {
          candleChart.timeScale().setVisibleLogicalRange({ from: total - show - 1, to: total - 1 });
        } else {
          candleChart.timeScale().fitContent();
        }
      }
      setChartLoading(false);

    } catch (err) {
      console.error('Candles error:', err);
      const container = document.getElementById('chartContainer');
      if (container && !candleChart) container.innerHTML = `<div class="error-notice">⚠ Could not load candles: ${err.message}</div>`;
      setChartLoading(false);
    }
  }

let cfmStarted = false;

let _cfmStarting = false;

let _cfmRenderSeq = 0;

let _cfmLastUserScrollTs = 0;

let _cfmDeferredRefreshTimer = null;

let _cfmRenderThrottleTimer = null;

let _cfmLastRenderTs = 0;

let _cfmScrollTrackerBound = false;

const CFM_SCROLL_IDLE_MS = 900;

const CFM_MIN_RENDER_GAP_MS = 1200;

const SUBORBITALS = [
    // ---- Shell 1s: Price Benchmarks (ALL coins) ----
    { num: 1, sym: 'CFM', name: 'CFM Rate', shell: '1s', key: 'cfmRate', fmt: 'price', desc: 'VWM partition average (CF Benchmarks method)', weight: 'all' },
    { num: 2, sym: 'VWP', name: 'VWAP-15', shell: '1s', key: 'vwap15', fmt: 'price', desc: 'Volume-weighted average price (15min)', weight: 'all' },
    { num: 3, sym: 'TWP', name: 'TWAP-15', shell: '1s', key: 'twap15', fmt: 'price', desc: 'Time-weighted average price (15min)', weight: 'all' },
    { num: 4, sym: 'SPT', name: 'Spot', shell: '1s', key: 'lastPrice', fmt: 'price', desc: 'Latest spot price across sources', weight: 'all' },

    // ---- Shell 2s: Momentum Oscillators (ALL coins) ----
    { num: 5, sym: 'RSI', name: 'RSI(14)', shell: '2s', key: '_rsi', fmt: 'num1', desc: 'Relative Strength Index — overbought/oversold', weight: 'all' },
    { num: 6, sym: 'MOM', name: 'Momentum', shell: '2s', key: 'momentum', fmt: 'pct3', desc: 'Rate of change over 5 polling cycles', weight: 'all' },
    { num: 7, sym: 'MCD', name: 'MACD', shell: '2s', key: '_macd', fmt: 'sign4', desc: 'VWAP-TWAP divergence (MACD proxy)', weight: 'all' },

    // ---- Shell 2p: Trend Signals (ALL coins) ----
    { num: 8, sym: 'EMA', name: 'EMA 9/21', shell: '2p', key: '_emaCross', fmt: 'pct3', desc: 'Fast/slow EMA crossover spread', weight: 'all' },
    { num: 9, sym: 'TRD', name: 'Trend', shell: '2p', key: 'trend', fmt: 'trend', desc: '15-min window direction', weight: 'all' },

    // ---- Shell 3s: Volume & Flow (ALL coins) ----
    { num: 10, sym: 'OBV', name: 'OBV Slope', shell: '3s', key: '_obvSlope', fmt: 'sign2', desc: 'On-Balance Volume — accumulation/distribution', weight: 'all' },
    { num: 11, sym: 'VDL', name: 'Vol Delta', shell: '3s', key: '_volRatio', fmt: 'ratio', desc: 'Buy vs sell volume ratio', weight: 'all' },
    { num: 12, sym: 'ATR', name: 'Volatility', shell: '3s', key: '_atrPct', fmt: 'pct2', desc: 'ATR as percentage of price', weight: 'all' },

    // ---- Shell 3p: Order Book Micro (MID + HEAVY only) ----
    { num: 13, sym: 'BAS', name: 'Bid-Ask', shell: '3p', key: 'bidAsk', fmt: 'pct4', desc: 'Bid-ask spread — market tightness', weight: 'mid' },
    { num: 14, sym: 'BKI', name: 'Book Imbal', shell: '3p', key: '_bookImbal', fmt: 'sign2', desc: 'Order book bid/ask weight imbalance', weight: 'mid' },
    { num: 15, sym: 'AGR', name: 'Aggressor', shell: '3p', key: '_aggrBuy', fmt: 'pct1', desc: 'Buy-side aggressor ratio from trade tape', weight: 'mid' },

    // ---- Shell 3d: Cross-Exchange Arbitrage (MID + HEAVY only) ----
    { num: 16, sym: 'XSP', name: 'X-Spread', shell: '3d', key: 'spread', fmt: 'pct3', desc: 'Cross-exchange price divergence', weight: 'mid' },
    { num: 17, sym: 'CVG', name: 'Convergence', shell: '3d', key: 'convergence', fmt: 'pct3', desc: 'How tightly sources agree (lower=better)', weight: 'mid' },
    { num: 18, sym: 'SRC', name: 'Sources', shell: '3d', key: 'sourceCount', fmt: 'of4', desc: 'Number of active constituent exchanges', weight: 'mid' },

    // ---- Shell 3d+: Derivatives (MID + HEAVY) ----
    { num: 19, sym: 'FND', name: 'Funding Rate', shell: '3d', key: '_funding', fmt: 'fundingRate', desc: 'Perp futures funding rate — +longs pay, -shorts pay', weight: 'mid' },
    { num: 20, sym: 'OI', name: 'Open Interest', shell: '3d', key: '_oi', fmt: 'compactUsd', desc: 'Total open interest in futures markets', weight: 'mid' },
    { num: 21, sym: 'SQZ', name: 'Squeeze Risk', shell: '3d', key: '_squeezeScore', fmt: 'squeeze', desc: 'Liquidation cascade / squeeze probability', weight: 'mid' },

    // ---- Shell 4s: CVD + Coinbase Premium (HEAVY only) ----
    { num: 22, sym: 'CVD', name: 'Cum Vol Delta', shell: '4s', key: '_cvdSlope', fmt: 'sign2', desc: 'CVD slope — buyer/seller exhaustion detector', weight: 'heavy' },
    { num: 23, sym: 'CBP', name: 'CB Premium', shell: '4s', key: '_cbPremium', fmt: 'pct3', desc: 'Coinbase price vs CFM rate — institutional flow proxy', weight: 'heavy' },
    { num: 24, sym: 'CBS', name: 'CB Spread', shell: '4s', key: 'cbSpread', fmt: 'pct4', desc: 'Coinbase buy-sell spread', weight: 'heavy' },

    // ---- Shell 4f: Deep Microstructure (HEAVY only) ----
    { num: 25, sym: 'DXV', name: 'DEX Vol', shell: '4f', key: '_dexVol', fmt: 'compactUsd', desc: 'On-chain DEX 24h volume', weight: 'heavy' },
    { num: 26, sym: 'DXL', name: 'DEX Liq', shell: '4f', key: '_dexLiq', fmt: 'compactUsd', desc: 'On-chain DEX liquidity depth', weight: 'heavy' },
  ];


const FEE_PCT = 0;














let predsLoaded = false;







let _depthLiveCleanup = null;

let _depthBookSym = null, _depthBookFn = null;






let _drawLiqRetryPending = false;




let _cexActiveSym = 'BTC';


function showPanelRenderError(view, token, error) {
    if (token !== _rv || currentView !== view) return;
    const message = error?.message || String(error || 'Unknown panel error');
    console.error('[render] Panel error:', error);
    content.innerHTML = `<div class="error-notice">⚠ Panel error: ${escapeHtml(message)}<br><small>${escapeHtml(error?.stack || '')}</small></div>`;
  }

function runPanelRender(view, fn, token = _rv) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        result.catch(error => showPanelRenderError(view, token, error));
      }
      return result;
    } catch (error) {
      showPanelRenderError(view, token, error);
      return null;
    }
  }

let _pmReadyDebounceTimer = null;

let _lastPmReadyRefresh = 0;

const _bootGuard = setTimeout(() => {
    if (Object.keys(tickers).length === 0) {
      console.warn('[boot] Initial feeds still establishing after 10s — triggering fallback fetch');
      _fetchAttempted = true;
      if (typeof setFeedStatus === 'function') {
        setFeedStatus('loading');
      }
      render();
      if (typeof fetchAll === 'function') {
        fetchAll(true).catch(() => {});
      }
    }
  }, 10000);
window._bootGuard = _bootGuard;

