// ═══════════════════════════════════════════════════════════════════════════════
// CRASH ANALYSIS & FAILURE INVESTIGATION
// ═══════════════════════════════════════════════════════════════════════════════
// Investigates the 2-contract collapse: 60% → 2% in 18 seconds
// Usage: window.CrashAnalysis.investigate()

(function () {
    'use strict';

    const CrashAnalysis = {
        /**
         * Deep investigation of recent contract failures
         */
        async investigate() {
            console.clear();
            console.log('═══════════════════════════════════════════════════════════════════');
            console.log('🔴 CRASH INVESTIGATION: 60% → 2% PROBABILITY COLLAPSE (18 seconds)');
            console.log('═══════════════════════════════════════════════════════════════════\n');

            const report = {
                timestamp: new Date().toISOString(),
                summary: {},
                candidates: [],
                analysis: {},
                recommendations: [],
            };

            // ─────────────────────────────────────────────────────────────────────────
            // PHASE 1: Find all contracts that went from high prob to loss
            // ─────────────────────────────────────────────────────────────────────────
            console.log('📊 PHASE 1: Searching for high-prob collapses in _marketSettlementLog...\n');

            const marketLog = window._marketSettlementLog || [];
            const suspects = [];

            marketLog.forEach((contract, idx) => {
                // Entry probability: how confident we were when we made the prediction
                const entryProb = contract.entryProb || contract.modelProbUp || 0;

                // Actual outcome: what the market says happened
                const outcome = contract.actualOutcome || contract.outcome || contract.result;

                // Did we lose? YES prob entry but outcome was NO/LOSS
                const lost = entryProb > 0.55 && (outcome === 'NO' || outcome === 'LOSS' || contract.modelCorrect === false);

                // Time from entry to settlement
                const entryTime = contract.ts || contract.entryTime || 0;
                const settleTime = contract.settledTs || contract.resolved_at || 0;
                const timeToSettleMs = settleTime - entryTime;

                // Rapid collapse: < 20 seconds is VERY unusual
                const rapidCollapse = timeToSettleMs > 0 && timeToSettleMs < 20_000;

                if (lost) {
                    const collapse = {
                        index: idx,
                        sym: contract.sym,
                        entryProb: (entryProb * 100).toFixed(1) + '%',
                        outcome: outcome || '?',
                        timeToSettleMs,
                        settleTime: new Date(settleTime).toLocaleTimeString(),
                        flags: [],
                        data: contract,
                    };

                    // Check for failure flags
                    if (rapidCollapse) collapse.flags.push('⚡ RAPID COLLAPSE (<20s)');
                    if (contract._dirConflict) collapse.flags.push('⚠️ DIR CONFLICT');
                    if (contract._wickStraddle) collapse.flags.push('🔀 WICK STRADDLE');
                    if (contract._nearRef) collapse.flags.push('📌 NEAR REF');
                    if (contract._proxyMismatch) collapse.flags.push('🔗 PROXY MISMATCH');

                    suspects.push(collapse);
                }
            });

            // Sort by entry probability (highest first)
            suspects.sort((a, b) => parseFloat(b.entryProb) - parseFloat(a.entryProb));

            report.candidates = suspects.slice(0, 10);

            console.log(`Found ${suspects.length} high-prob losses in _marketSettlementLog`);
            if (suspects.length > 0) {
                console.log('Top 5 candidates (sorted by entry probability):\n');
                suspects.slice(0, 5).forEach((s, i) => {
                    console.log(`${i + 1}. ${s.sym} @ ${s.settleTime}`);
                    console.log(`   Entry: ${s.entryProb} → Outcome: ${s.outcome}`);
                    console.log(`   Settlement time: ${s.timeToSettleMs}ms (${(s.timeToSettleMs / 1000).toFixed(1)}s)`);
                    console.log(`   Flags: ${s.flags.length > 0 ? s.flags.join(' ') : 'NONE'}\n`);
                });
            }

            // ─────────────────────────────────────────────────────────────────────────
            // PHASE 2: Check 15-minute resolution log for timing mismatches
            // ─────────────────────────────────────────────────────────────────────────
            console.log('\n📊 PHASE 2: Checking _15mResolutionLog for timing/settlement issues...\n');

            const resolutionLog = window._15mResolutionLog || [];
            const timingIssues = [];

            resolutionLog.forEach((entry) => {
                // Check if model was correct but settlement was wrong
                const modelCorrect = entry.modelCorrect !== false;
                const settlementCorrect = entry.outcome === 'YES' || entry.settledTs > 0;

                if (!modelCorrect || !settlementCorrect) {
                    timingIssues.push({
                        sym: entry.sym,
                        ts: new Date(entry.ts).toLocaleTimeString(),
                        modelCorrect,
                        settlementCorrect,
                        outcome: entry.outcome,
                        entry,
                    });
                }
            });

            console.log(`Found ${timingIssues.length} timing/settlement mismatches`);
            if (timingIssues.length > 0) {
                console.log('Top timing issues:\n');
                timingIssues.slice(0, 5).forEach((t, i) => {
                    console.log(`${i + 1}. ${t.sym} @ ${t.ts}`);
                    console.log(`   Model correct: ${t.modelCorrect} | Settlement correct: ${t.settlementCorrect}`);
                    console.log(`   Outcome: ${t.outcome}\n`);
                });
            }

            report.analysis.timingIssues = timingIssues;

            // ─────────────────────────────────────────────────────────────────────────
            // PHASE 3: Check for Kalshi API errors or proxy mismatches
            // ─────────────────────────────────────────────────────────────────────────
            console.log('\n📊 PHASE 3: Searching for API errors or proxy mismatches...\n');

            const kalshiErrors = window._kalshiErrors || [];
            const recentErrors = kalshiErrors.filter(e => {
                const errTime = e.timestamp || 0;
                const now = Date.now();
                return (now - errTime) < (60 * 60 * 1000); // Last hour
            });

            console.log(`Found ${recentErrors.length} errors in _kalshiErrors (last hour)\n`);
            if (recentErrors.length > 0) {
                recentErrors.slice(0, 5).forEach((err, i) => {
                    console.log(`${i + 1}. ${err.error || err.message}`);
                    console.log(`   Time: ${new Date(err.timestamp).toLocaleTimeString()}`);
                    console.log(`   Context: ${err.context || 'N/A'}\n`);
                });
            }

            report.analysis.errors = recentErrors;

            // ─────────────────────────────────────────────────────────────────────────
            // PHASE 4: Candle close price vs Polymarket strike analysis
            // ─────────────────────────────────────────────────────────────────────────
            console.log('\n📊 PHASE 4: Analyzing candle closes vs Polymarket strike prices...\n');

            const candleIssues = suspects.slice(0, 5).map(s => {
                const contract = s.data;
                return {
                    sym: s.sym,
                    polymarketFloor: contract.floor_price,
                    polymarketStrike: contract.strikeDir,
                    closePrice: contract.close_price,
                    closeSnapshots: contract.closeSnapshots || [],
                    refPrice: contract.refPrice,
                    issue: this._analyzeCandleVsStrike(contract),
                };
            });

            console.log('Candle/Strike analysis:\n');
            candleIssues.forEach(issue => {
                console.log(`${issue.sym}:`);
                console.log(`  Polymarket floor: ${issue.polymarketFloor} | Strike: ${issue.polymarketStrike}`);
                console.log(`  Close price: ${issue.closePrice}`);
                console.log(`  Analysis: ${issue.issue}\n`);
            });

            report.analysis.candleIssues = candleIssues;

            // ─────────────────────────────────────────────────────────────────────────
            // PHASE 5: Generate recommendations
            // ─────────────────────────────────────────────────────────────────────────
            console.log('\n🔧 PHASE 5: RECOMMENDATIONS\n');

            const recommendations = [];

            if (suspects.some(s => s.flags.includes('⚡ RAPID COLLAPSE (<20s)'))) {
                recommendations.push({
                    severity: 'CRITICAL',
                    issue: 'Rapid probability collapse detected',
                    cause: 'Possible Polymarket data mismatch or candle close proxy failure',
                    action: 'Add real-time validation: compare model direction vs actual Polymarket settlement within 5 seconds of close',
                    code: 'Add strike_price validation against candle close + last RTI quote',
                });
            }

            if (suspects.some(s => s.flags.includes('🔀 WICK STRADDLE'))) {
                recommendations.push({
                    severity: 'HIGH',
                    issue: 'Wick straddle (price touched both sides)',
                    cause: 'Entry was on wrong side of wick',
                    action: 'Tighten wick detection threshold or wait for close confirmation',
                });
            }

            if (suspects.some(s => s.flags.includes('⚠️ DIR CONFLICT'))) {
                recommendations.push({
                    severity: 'HIGH',
                    issue: 'Direction conflict between signals',
                    cause: 'Model + CFM signals disagreed',
                    action: 'Require >70% signal consensus before trading',
                });
            }

            if (recentErrors.length > 0) {
                recommendations.push({
                    severity: 'MEDIUM',
                    issue: `${recentErrors.length} API errors detected`,
                    cause: 'Kalshi API, proxy, or settlement data unreliability',
                    action: 'Implement error circuit breaker: 3 consecutive errors = stand-aside for 2 minutes',
                });
            }

            recommendations.forEach((rec, i) => {
                console.log(`${i + 1}. [${rec.severity}] ${rec.issue}`);
                console.log(`   Cause: ${rec.cause}`);
                console.log(`   Action: ${rec.action}`);
                if (rec.code) console.log(`   Code: ${rec.code}`);
                console.log();
            });

            report.recommendations = recommendations;

            // ─────────────────────────────────────────────────────────────────────────
            // EXPORT REPORT
            // ─────────────────────────────────────────────────────────────────────────
            console.log('\n💾 EXPORTING FULL REPORT...\n');
            window._crashAnalysisReport = report;
            console.log('✅ Full report saved to: window._crashAnalysisReport');
            console.log('   Download: window.__EMERGENCY_TOOLS.crashReport()');

            return report;
        },

        /**
         * Analyze if candle close price matches Polymarket strike
         */
        _analyzeCandleVsStrike(contract) {
            const floor = contract.floor_price;
            const close = contract.close_price;
            const strikeDir = contract.strikeDir;

            if (!floor || !close) return 'Missing price data';

            const isAbove = close > floor;
            const expectedDir = isAbove ? 'UP' : 'DOWN';

            if (expectedDir === strikeDir) {
                return '✓ Match: close direction matches Polymarket strike';
            } else {
                return `❌ MISMATCH: Expected ${expectedDir} but Polymarket has ${strikeDir}`;
            }
        },

        /**
         * Export crash report to file
         */
        async exportReport() {
            const report = window._crashAnalysisReport;
            if (!report) {
                console.warn('⚠️ No crash report available. Run investigate() first.');
                return;
            }

            const csv = this._reportToCSV(report);
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = url;
            link.download = `crash-analysis-${new Date().getTime()}.csv`;
            link.click();

            console.log('✅ Crash report exported to CSV');
        },

        _reportToCSV(report) {
            let csv = 'Crash Analysis Report\n';
            csv += `Generated: ${report.timestamp}\n\n`;

            csv += 'SUSPECT CONTRACTS\n';
            csv += 'Sym,Entry Prob,Outcome,Time to Settle (ms),Settlement Time,Flags\n';
            report.candidates.forEach(c => {
                csv += `${c.sym},${c.entryProb},${c.outcome},${c.timeToSettleMs},${c.settleTime},"${c.flags.join('; ')}"\n`;
            });

            csv += '\n\nRECOMMENDATIONS\n';
            csv += 'Severity,Issue,Cause,Action\n';
            report.recommendations.forEach(r => {
                csv += `${r.severity},"${r.issue}","${r.cause}","${r.action}"\n`;
            });

            return csv;
        },
    };

    window.CrashAnalysis = CrashAnalysis;

    console.log('✅ [CRASH] Analysis module loaded');
    console.log('💡 Quick start: window.CrashAnalysis.investigate()');

})();
