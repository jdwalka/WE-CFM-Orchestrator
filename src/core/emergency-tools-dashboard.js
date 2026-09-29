// ═══════════════════════════════════════════════════════════════════════════════
// EMERGENCY TOOLS DASHBOARD & EXPERIMENTAL TOOLBOX
// ═══════════════════════════════════════════════════════════════════════════════
// Exposes all experimental tools + crash diagnostics in single DevTools API
// Usage: window.__EMERGENCY_TOOLS.catalog() → lists all available tools
//        window.__EMERGENCY_TOOLS.enable('whale-alert') → activate tool
//        window.__EMERGENCY_TOOLS.dashboard() → opens full tools UI

(function () {
    'use strict';

    const TOOL_MANIFEST = {
        'whale-alert': {
            name: 'Whale Alert Monitor',
            enabled: () => !!window.WhaleAlertMonitor,
            desc: 'Real-time whale transactions across BTC/ETH/BNB',
            api: () => window.WhaleAlertMonitor,
            commands: {
                'start': (chains = ['eth', 'bitcoin']) => {
                    const cb = (alert) => console.log('[🐳 Whale]', alert);
                    window.WhaleAlertMonitor?.startMonitoring(chains, cb);
                },
                'stop': () => window.WhaleAlertMonitor?.stopMonitoring(),
                'stats': () => window.WhaleAlertMonitor?.stats(),
                'get': (chain) => window.WhaleAlertMonitor?.getWhaleTransactions(chain),
            }
        },
        'dex-activity': {
            name: 'DEX Activity Monitor',
            enabled: () => !!window.DEXActivityMonitor,
            desc: 'Multi-DEX swap tracking (Uniswap, SushiSwap, 1inch)',
            api: () => window.DEXActivityMonitor,
            commands: {
                'start': (chains = ['ethereum']) => {
                    const cb = (activity) => console.log('[🔄 DEX]', activity);
                    window.DEXActivityMonitor?.startMonitoring(chains, cb);
                },
                'stop': () => window.DEXActivityMonitor?.stopMonitoring(),
                'stats': () => window.DEXActivityMonitor?.stats(),
            }
        },
        'portfolio-intel': {
            name: 'Portfolio Intelligence',
            enabled: () => !!window.PortfolioIntel,
            desc: 'Track top holder allocation + concentration risk',
            api: () => window.PortfolioIntel,
            commands: {
                'top-holders': (coin = 'BTC', limit = 10) => window.PortfolioIntel?.getTopHolders(coin, limit),
                'concentration': (coin = 'BTC') => window.PortfolioIntel?.getConcentration(coin),
                'watch': (address) => window.PortfolioIntel?.watchAddress(address),
            }
        },
        'holder-metrics': {
            name: 'Holder Metrics',
            enabled: () => !!window.HolderMetrics,
            desc: 'Holder count, age, accumulation/distribution patterns',
            api: () => window.HolderMetrics,
            commands: {
                'age-distribution': (coin = 'BTC') => window.HolderMetrics?.getAgeDistribution(coin),
                'active-addresses': (coin = 'BTC') => window.HolderMetrics?.getActiveAddresses(coin),
                'accumulation-phase': (coin = 'BTC') => window.HolderMetrics?.detectAccumulation(coin),
            }
        },
        'cex-flow': {
            name: 'CEX Flow Monitor',
            enabled: () => !!window.CEXFlowMonitor,
            desc: 'Exchange inflow/outflow tracking (Coinbase, Kraken, Binance)',
            api: () => window.CEXFlowMonitor,
            commands: {
                'start': () => window.CEXFlowMonitor?.start(),
                'stop': () => window.CEXFlowMonitor?.stop(),
                'flows': (coin = 'BTC', hours = 24) => window.CEXFlowMonitor?.getFlows(coin, hours),
                'stats': () => window.CEXFlowMonitor?.stats(),
            }
        },
        'social-sentiment': {
            name: 'Social Sentiment Feed',
            enabled: () => !!window.SocialSentiment,
            desc: 'Twitter/Reddit/LunarCrush sentiment aggregation',
            api: () => window.SocialSentiment,
            commands: {
                'fetch': (coin = 'BTC') => window.SocialSentiment?.fetch(coin),
                'trend': (coin = 'BTC', hours = 24) => window.SocialSentiment?.getTrend(coin, hours),
            }
        },
        'shell-router': {
            name: 'Shell Router (Veto System)',
            enabled: () => !!window.ShellRouter,
            desc: 'Multi-exchange routing with veto/override capability',
            api: () => window.ShellRouter,
            commands: {
                'veto': (marketId) => window.ShellRouter?.veto(marketId),
                'override': (marketId, direction) => window.ShellRouter?.override(marketId, direction),
                'status': () => window.ShellRouter?.status(),
            }
        },
        'signal-router-cfm': {
            name: 'CFM Signal Router',
            enabled: () => !!window.CFMRouter,
            desc: 'CFM multi-signal routing + momentum surge detection',
            api: () => window.CFMRouter,
            commands: {
                'route': (sym) => window.CFMRouter?.route(sym),
                'check-early-exit': (sym) => window.CFMRouter?.checkEarlyExit(sym),
                'packets': (sym) => window.CFMRouter?.getCFMPackets(sym),
            }
        },
        'pyth-momentum-exit': {
            name: 'Pyth Momentum Exit System',
            enabled: () => !!window.PythMomentumExit,
            desc: 'Real-time momentum reversal exit signals',
            api: () => window.PythMomentumExit,
            commands: {
                'check': (sym) => window.PythMomentumExit?.checkExit(sym),
                'stats': () => window.PythMomentumExit?.stats(),
            }
        },
        'adaptive-learning': {
            name: 'Adaptive Learning Engine',
            enabled: () => !!window.AdaptiveLearningEngine,
            desc: 'Real-time signal weight tuning + accuracy tracking',
            api: () => window.AdaptiveLearningEngine,
            commands: {
                'weights': (coin = 'BTC') => window.AdaptiveLearningEngine?.getWeights(coin),
                'accuracy': (coin = 'BTC', window = 100) => window.AdaptiveLearningEngine?.getAccuracy(coin, window),
                'tune': (coin = 'BTC', direction) => window.AdaptiveLearningEngine?.tune(coin, direction),
            }
        },
        'contract-accuracy': {
            name: 'Contract Win-Rate Calculator',
            enabled: () => !!window.ContractWinRateCalculator,
            desc: 'Real-time settlement accuracy + model performance',
            api: () => window.ContractWinRateCalculator,
            commands: {
                'scorecard': (coin = 'BTC') => window.ContractWinRateCalculator?.scorecard(coin),
                'find-inversions': () => window.ContractWinRateCalculator?.findInversions(),
            }
        },

    };

    const __EMERGENCY_TOOLS = {
        /**
         * List all available tools + status
         */
        catalog() {
            const output = [];
            output.push('╔════════════════════════════════════════════════════════╗');
            output.push('║          EXPERIMENTAL TOOLS CATALOG                    ║');
            output.push('╚════════════════════════════════════════════════════════╝');
            output.push('');

            Object.entries(TOOL_MANIFEST).forEach(([key, tool]) => {
                const status = tool.enabled() ? '✅ ACTIVE' : '⚠️ PENDING';
                const fullName = tool.name.padEnd(32);
                output.push(`${status}  ${fullName}  ${tool.desc}`);
            });

            output.push('');
            output.push('Usage:');
            output.push('  window.__EMERGENCY_TOOLS.enable("whale-alert")');
            output.push('  window.__EMERGENCY_TOOLS.run("whale-alert", "start", ["eth"])');
            output.push('  window.__EMERGENCY_TOOLS.dashboard()');

            return output.join('\n');
        },

        /**
         * Enable/activate a specific tool
         */
        enable(toolKey) {
            const tool = TOOL_MANIFEST[toolKey];
            if (!tool) {
                console.error(`❌ Unknown tool: ${toolKey}. Use catalog() to list available.`);
                return;
            }

            if (tool.enabled()) {
                console.log(`✅ ${tool.name} is already active`);
                console.log(`📖 Available commands:`, Object.keys(tool.commands));
                return;
            }

            console.log(`⏳ Attempting to activate ${tool.name}...`);
            // Most tools auto-initialize via their respective JS files
            // If not active after HTML load, the feed may have failed
            if (tool.api()) {
                console.log(`✅ ${tool.name} is now available`);
                console.log(`📖 Commands:`, Object.keys(tool.commands));
            } else {
                console.warn(`⚠️ ${tool.name} did not initialize. Check DevTools Errors tab.`);
            }
        },

        /**
         * Execute a command on a specific tool
         */
        run(toolKey, command, args = []) {
            const tool = TOOL_MANIFEST[toolKey];
            if (!tool) {
                console.error(`❌ Unknown tool: ${toolKey}`);
                return;
            }

            const cmd = tool.commands[command];
            if (!cmd) {
                console.error(`❌ Unknown command "${command}" for ${toolKey}. Available: ${Object.keys(tool.commands).join(', ')}`);
                return;
            }

            try {
                console.log(`🔧 Running: ${toolKey}.${command}(${args.map(a => JSON.stringify(a)).join(', ')})`);
                return cmd(...args);
            } catch (e) {
                console.error(`❌ Error executing ${toolKey}.${command}:`, e.message);
            }
        },

        /**
         * Crash diagnostics: analyze recent failures
         */
        crashDiagnostics() {
            const diag = {
                timestamp: new Date().toISOString(),
                recentErrors: [],
                marketLog: [],
                failedContracts: [],
                latencyGuards: null,
                tradeJournal: null,
                forensic: null,
            };

            // Gather recent errors from all sources
            if (window._kalshiErrors) {
                diag.recentErrors = window._kalshiErrors.slice(-20);
            }

            // Find failed/suspect contracts
            if (window._marketSettlementLog) {
                const recent = window._marketSettlementLog.slice(-100);
                const suspect = recent.filter(e => {
                    const probCollapse = e.entryProb > 0.6 && e.actualOutcome === 'NO';
                    const probInversion = e.dirConflict || e._dirConflict;
                    const timeToSettle = (e.settledTs || e.resolved_at || 0) - (e.ts || 0);
                    const rapidCollapse = timeToSettle < 20_000; // < 20 seconds

                    return probCollapse || probInversion || rapidCollapse;
                });
                diag.failedContracts = suspect;
            }

            // Check recent 15m resolution log
            if (window._15mResolutionLog) {
                const recent = window._15mResolutionLog.slice(-50);
                const failures = recent.filter(e => {
                    return (e.modelCorrect === false || e.outcome === 'NO') && e.entryProb > 0.5;
                });
                diag.recentResolutions = failures;
            }

            // Latency guard visibility for 15m binaries
            if (window._marketSettlementLog) {
                const recentSet = window._marketSettlementLog.slice(-100);
                const guarded = recentSet.filter(e => e.executionGuard?.blocked);
                const hardLate = recentSet.filter(e => e.executionGuard?.hardLate);
                diag.latencyGuards = {
                    blocked: guarded.length,
                    hardLate: hardLate.length,
                    sample: guarded.slice(-5),
                };
            }

            // Quant trade journal summary
            const journal = window.QuantCore?.journal || window._tradeJournal || null;
            if (journal?.summary) {
                diag.tradeJournal = journal.summary();
            }

            if (window.MarketDebug?.replayIncident) {
                try {
                    diag.forensic = window.MarketDebug.replayIncident({ topN: 2 });
                } catch (e) {
                    diag.forensic = { error: e.message };
                }
            }

            return diag;
        },

        /**
         * Find the 2 contracts that caused recent losses
         */
        findRecentFailures(lookbackHours = 1) {
            if (window.MarketDebug?.suspects) {
                try {
                    const replay = window.MarketDebug.replayIncident({
                        topN: 10,
                        lookbackMs: Math.max(1, lookbackHours) * 3600 * 1000,
                    });
                    const suspects = replay?.suspects || [];
                    if (suspects.length) {
                        return suspects.map(s => ({
                            source: 'forensics',
                            sym: s.sym,
                            ts: s.entry?.ts,
                            settledTs: s.settlement?.ts,
                            entryProb: s.entry?.confidence,
                            actualOutcome: s.settlement?.outcome,
                            failureReasons: [s.classification?.key || 'UNKNOWN'],
                            conciseRootCause: s.conciseRootCause,
                        }));
                    }
                } catch (_) { }
            }

            const now = Date.now();
            const cutoff = now - (lookbackHours * 3600 * 1000);

            const candidates = [];

            // Search _marketSettlementLog
            if (window._marketSettlementLog) {
                window._marketSettlementLog.forEach(e => {
                    const ts = e.settledTs || e.resolved_at || e.ts || 0;
                    if (ts < cutoff) return;

                    const probCollapse = e.entryProb > 0.6 && e.actualOutcome === 'NO';
                    const modelWrong = e.modelCorrect === false;
                    const flagged = e._dirConflict || e._wickStraddle || e._nearRef;

                    if (probCollapse || modelWrong || flagged) {
                        candidates.push({
                            source: 'market',
                            ...e,
                            failureReasons: [
                                probCollapse ? 'high-prob-collapse' : '',
                                modelWrong ? 'model-wrong' : '',
                                flagged ? 'flagged' : '',
                            ].filter(Boolean),
                        });
                    }
                });
            }

            // Also search _15mResolutionLog
            if (window._15mResolutionLog) {
                window._15mResolutionLog.forEach(e => {
                    const ts = e.settledTs || e.resolved_at || e.ts || 0;
                    if (ts < cutoff) return;

                    if ((e.modelCorrect === false && e.entryProb > 0.5) ||
                        (e.outcome === 'NO' && e.entryProb > 0.6)) {
                        candidates.push({
                            source: '15m-resolution',
                            ...e,
                            failureReasons: e.modelCorrect === false ? 'model-wrong' : 'outcome-no',
                        });
                    }
                });
            }

            // Sort by entry probability (highest first) + most recent
            candidates.sort((a, b) => {
                if ((b.entryProb || 0) !== (a.entryProb || 0)) {
                    return (b.entryProb || 0) - (a.entryProb || 0);
                }
                return (b.ts || 0) - (a.ts || 0);
            });

            return candidates.slice(0, 10); // Return top 10 candidates (user mentioned 2)
        },

        /**
         * Full tools dashboard UI
         */
        async dashboard() {
            // Find container
            let container = document.getElementById('emergency-tools-dashboard');
            if (container) {
                container.remove();
            }

            // Create modal
            const modal = document.createElement('div');
            modal.id = 'emergency-tools-dashboard';
            modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.95);
        z-index: 20000;
        overflow-y: auto;
        padding: 20px;
        font-family: 'Jetbrains Mono', monospace;
        color: #ccc;
      `;

            // Build content
            let html = `
        <div style="max-width: 1400px; margin: 0 auto;">
          <div style="position: relative; margin-bottom: 20px;">
            <h1 style="margin: 0; color: #fff; font-size: 24px;">
              🚨 EMERGENCY TOOLS DASHBOARD
            </h1>
            <button onclick="document.getElementById('emergency-tools-dashboard').remove()" 
              style="position: absolute; top: 0; right: 0; background: #900; border: none; color: #fff; padding: 8px 16px; cursor: pointer; border-radius: 4px;">
              CLOSE
            </button>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px;">
            <!-- Crash Diagnostics -->
            <div style="background: #1a1a1a; border: 2px solid #f00; border-radius: 8px; padding: 16px;">
              <h2 style="margin-top: 0; color: #f00;">⚠️ CRASH DIAGNOSTICS</h2>
              <div id="crash-diag" style="font-size: 12px; white-space: pre-wrap; overflow-x: auto; background: #0a0a0a; padding: 8px; border-radius: 4px; max-height: 300px; overflow-y: auto;">
                Loading...
              </div>
            </div>

            <!-- Recent Failures -->
            <div style="background: #1a1a1a; border: 2px solid #fa0; border-radius: 8px; padding: 16px;">
              <h2 style="margin-top: 0; color: #fa0;">🔍 RECENT FAILURES (Last Hour)</h2>
              <div id="recent-failures" style="font-size: 12px; white-space: pre-wrap; overflow-x: auto; background: #0a0a0a; padding: 8px; border-radius: 4px; max-height: 300px; overflow-y: auto;">
                Loading...
              </div>
            </div>
          </div>

                    <div style="background: #1a1a1a; border: 2px solid #08f; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
                        <h2 style="margin-top: 0; color: #08f;">🧪 FORENSIC REPLAY (Collapsed Contracts)</h2>
                        <div id="incident-replay" style="font-size: 12px; white-space: pre-wrap; overflow-x: auto; background: #0a0a0a; padding: 8px; border-radius: 4px; max-height: 260px; overflow-y: auto;">
                            Loading...
                        </div>
                    </div>

          <!-- Tools Grid -->
          <h2 style="color: #0f0;">📦 ACTIVE TOOLS</h2>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">
      `;

            Object.entries(TOOL_MANIFEST).forEach(([key, tool]) => {
                const status = tool.enabled() ? '✅' : '⚠️';
                const commands = Object.keys(tool.commands).join(', ');
                html += `
          <div style="background: #1a1a1a; border: 1px solid #444; border-radius: 8px; padding: 12px;">
            <h3 style="margin-top: 0; color: #0f0; font-size: 14px;">${status} ${tool.name}</h3>
            <p style="margin: 0; font-size: 11px; color: #888;">${tool.desc}</p>
            <div style="margin-top: 8px; font-size: 10px; color: #666;">
              <strong>Commands:</strong> ${commands}
            </div>
            <button onclick="window.__EMERGENCY_TOOLS.run('${key}', Object.keys(window.__EMERGENCY_TOOLS.catalog())[0])" 
              style="margin-top: 8px; background: #0a0; color: #000; border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-weight: 700; font-size: 11px;">
              ACTIVATE
            </button>
          </div>
        `;
            });

            html += `
          </div>
        </div>
      `;

            modal.innerHTML = html;
            document.body.appendChild(modal);

            // Populate crash diagnostics
            setTimeout(() => {
                const diag = this.crashDiagnostics();
                document.getElementById('crash-diag').textContent = JSON.stringify(diag, null, 2);

                const failures = this.findRecentFailures(1);
                const failureText = failures.length ?
                    failures.map(f => `${f.sym} @${new Date(f.ts || f.settledTs || Date.now()).toLocaleTimeString()}: ${f.entryProb ? Math.round(f.entryProb * 100) + '%' : '?'} → ${f.actualOutcome || f.outcome || '?'} ${f.conciseRootCause ? '| ' + f.conciseRootCause : ''}`).join('\n')
                    : 'None found';
                document.getElementById('recent-failures').textContent = failureText;

                let replayText = 'Market forensics unavailable';
                try {
                    const replay = window.MarketDebug?.replayIncident?.({ topN: 2 })
                        || window.MarketForensics?.replay?.({ topN: 2 });
                    if (replay?.suspects?.length) {
                        replayText = replay.suspects.map((s, i) => {
                            const entryTs = s.entry?.ts ? new Date(s.entry.ts).toISOString() : 'n/a';
                            const settleTs = s.settlement?.ts ? new Date(s.settlement.ts).toISOString() : 'n/a';
                            const flags = [
                                s.indicators?.directionConflict ? 'dirConflict' : null,
                                s.indicators?.wickStraddle ? 'wick' : null,
                                s.indicators?.nearRef ? 'nearRef' : null,
                                s.settlement?.mismatch ? 'mismatch' : null,
                            ].filter(Boolean).join(', ') || 'none';
                            return [
                                `#${i + 1} ${s.sym} ${s.ticker ? '(' + s.ticker + ')' : ''}`,
                                `entry=${entryTs} conf=${s.entry?.confidence != null ? Math.round(s.entry.confidence * 100) + '%' : 'n/a'} model=${s.entry?.modelDir || 'n/a'}`,
                                `settle=${settleTs} outcome=${s.settlement?.outcome || 'n/a'} source=${s.settlement?.source || 'n/a'}`,
                                `flags=[${flags}] latency=${s.estimatedContribution?.settleLatencyMs ?? 'n/a'}ms lat=${s.estimatedContribution?.latencyPct ?? 0}% slip=${s.estimatedContribution?.slippagePct ?? 0}%`,
                                `root-cause=${s.classification?.key || 'UNKNOWN'} :: ${s.classification?.reason || 'n/a'}`,
                            ].join('\n');
                        }).join('\n\n');
                    }
                } catch (e) {
                    replayText = `Forensic replay error: ${e.message}`;
                }
                document.getElementById('incident-replay').textContent = replayText;
            }, 100);
        },

        /**
         * Instant crash report for analysis
         */
        crashReport() {
            const diag = this.crashDiagnostics();
            const failures = this.findRecentFailures(1);

            return {
                timestamp: new Date().toISOString(),
                diagnostics: diag,
                topFailures: failures.slice(0, 5),
                toolStatus: Object.entries(TOOL_MANIFEST).reduce((acc, [key, tool]) => {
                    acc[key] = tool.enabled();
                    return acc;
                }, {}),
            };
        },
    };

    // Export to window
    window.__EMERGENCY_TOOLS = __EMERGENCY_TOOLS;

    // Auto-print catalog on boot
    console.log(__EMERGENCY_TOOLS.catalog());
    console.log('\n💡 Quick start: window.__EMERGENCY_TOOLS.dashboard()');

})();
