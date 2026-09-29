/**
 * ================================================================
 * Trade Journal Schema + Export
 * JSONL format: write-on-every-trade, persist to localStorage + multi-drive cache
 * ================================================================
 */

(function () {
    'use strict';

    class TradeJournal {
        constructor(config = {}) {
            this.trades = [];
            this.maxTrades = config.max_trades || 20000;
            this.storageKey = config.storage_key || 'beta1_trade_journal';
            this.exportPath = config.export_path;  // for Node.js backends
            this.schemaVersion = '1.0.0';

            this.stats = {
                total: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
            };

            this.loadFromStorage();
            console.log('[TradeJournal] Initialized, loaded', this.trades.length, 'trades');
        }

        /**
         * Record trade execution
         * @param {object} trade - {
         *   asset: 'BTC'|'ETH'|...,
         *   prediction: 'UP'|'DOWN',
         *   confidence: 0-1,
         *   regime: 'TREND'|'CHOP'|...,
         *   signals: {rsi, macd, fisher, ...},
         *   market_state: {price, volume, bid_ask_spread, ...},
         *   fill_price: number,
         *   close_price: number,  // at contract settlement
         *   outcome: 'UP'|'DOWN'|'UNKNOWN',
         *   settled: true|false,
         *   metadata: {...}
         * }
         */
        recordTrade(trade) {
            const record = {
                schema_version: this.schemaVersion,
                id: this.generateId(),
                timestamp: Date.now(),
                timestamp_iso: new Date().toISOString(),
                asset: trade.asset,
                prediction: trade.prediction,
                confidence: trade.confidence || 0,
                regime: trade.regime || 'UNKNOWN',
                signals: trade.signals || {},
                market_state: trade.market_state || {},
                fill_price: trade.fill_price || 0,
                expected_fill_quality: trade.expected_fill_quality || null,
                realized_fill_quality: trade.realized_fill_quality || null,
                close_price: trade.close_price || null,
                outcome: trade.outcome || null,
                settled: trade.settled || false,
                settled_timestamp: trade.settled ? Date.now() : null,
                win: null,
                metadata: trade.metadata || {},
            };

            // Compute win/loss if outcome available
            if (record.outcome && record.outcome !== 'UNKNOWN') {
                const predictedUp = record.prediction === 'UP';
                const actualUp = record.outcome === 'UP';
                record.win = predictedUp === actualUp ? 1 : 0;

                this.stats.total++;
                if (record.win) {
                    this.stats.wins++;
                    this.stats.pnl++;
                } else {
                    this.stats.losses++;
                    this.stats.pnl--;
                }
            }

            this.trades.push(record);

            // Bounded storage
            if (this.trades.length > this.maxTrades) {
                this.trades.shift();
            }

            // Persist immediately
            this.persist();

            return record.id;
        }

        /**
         * Update trade with settlement data
         * @param {string} tradeId - trade ID to update
         * @param {object} update - {close_price, outcome, settled}
         */
        updateTrade(tradeId, update) {
            const trade = this.trades.find(t => t.id === tradeId);
            if (!trade) {
                console.warn('[TradeJournal] Trade not found:', tradeId);
                return false;
            }

            if (update.close_price !== undefined) trade.close_price = update.close_price;
            if (update.outcome !== undefined) trade.outcome = update.outcome;
            if (update.settled !== undefined) trade.settled = update.settled;
            if (update.expected_fill_quality !== undefined) {
                trade.expected_fill_quality = update.expected_fill_quality;
            }
            if (update.realized_fill_quality !== undefined) {
                trade.realized_fill_quality = update.realized_fill_quality;
            }
            if (trade.settled && !trade.settled_timestamp) {
                trade.settled_timestamp = Date.now();
            }

            // Recompute win/loss
            if (trade.outcome && trade.outcome !== 'UNKNOWN' && trade.win === null) {
                const predictedUp = trade.prediction === 'UP';
                const actualUp = trade.outcome === 'UP';
                trade.win = predictedUp === actualUp ? 1 : 0;

                this.stats.total++;
                if (trade.win) {
                    this.stats.wins++;
                    this.stats.pnl++;
                } else {
                    this.stats.losses++;
                    this.stats.pnl--;
                }
            }

            this.persist();
            return true;
        }

        /**
         * Generate trade ID
         */
        generateId() {
            return `TRD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }

        /**
         * Export as JSONL (one trade per line)
         * @returns {string} JSONL content
         */
        exportJsonl() {
            return this.trades
                .map(t => JSON.stringify(this.ensureSchema(t)))
                .join('\n');
        }

        ensureSchema(trade) {
            return {
                schema_version: trade.schema_version || this.schemaVersion,
                id: trade.id,
                timestamp: trade.timestamp,
                timestamp_iso: trade.timestamp_iso,
                asset: trade.asset,
                prediction: trade.prediction,
                confidence: trade.confidence,
                regime: trade.regime,
                signals: trade.signals || {},
                market_state: trade.market_state || {},
                fill_price: trade.fill_price,
                expected_fill_quality: trade.expected_fill_quality || null,
                realized_fill_quality: trade.realized_fill_quality || null,
                close_price: trade.close_price,
                outcome: trade.outcome,
                settled: !!trade.settled,
                settled_timestamp: trade.settled_timestamp || null,
                win: trade.win,
                metadata: trade.metadata || {},
            };
        }

        /**
         * Export as CSV
         * @returns {string} CSV content
         */
        exportCsv() {
            if (this.trades.length === 0) return '';

            const headers = [
                'id', 'timestamp_iso', 'asset', 'prediction', 'confidence', 'regime',
                'fill_price', 'exp_fill_prob', 'exp_slippage_bps', 'realized_slippage_bps',
                'close_price', 'outcome', 'win', 'settled'
            ];

            const rows = this.trades.map(t => [
                t.id,
                t.timestamp_iso,
                t.asset,
                t.prediction,
                t.confidence.toFixed(3),
                t.regime,
                t.fill_price.toFixed(8),
                t.expected_fill_quality?.fill_probability != null
                    ? Number(t.expected_fill_quality.fill_probability).toFixed(4)
                    : '',
                t.expected_fill_quality?.slippage_bps != null
                    ? Number(t.expected_fill_quality.slippage_bps).toFixed(2)
                    : '',
                t.realized_fill_quality?.slippage_bps != null
                    ? Number(t.realized_fill_quality.slippage_bps).toFixed(2)
                    : '',
                t.close_price ? t.close_price.toFixed(8) : '',
                t.outcome || '',
                t.win !== null ? t.win : '',
                t.settled ? 'yes' : 'no',
            ]);

            return [
                headers.join(','),
                ...rows.map(r => r.map(v => `"${v}"`).join(',')),
            ].join('\n');
        }

        /**
         * Performance summary
         */
        summary() {
            if (this.stats.total === 0) {
                return {
                    trades: 0,
                    status: 'no_settled_trades',
                };
            }

            const winRate = this.stats.wins / this.stats.total;
            const profitFactor = this.stats.losses > 0
                ? this.stats.wins / this.stats.losses
                : (this.stats.wins > 0 ? Infinity : 0);

            // Average confidence by outcome
            const settled = this.trades.filter(t => t.settled);
            const winners = settled.filter(t => t.win === 1);
            const losers = settled.filter(t => t.win === 0);

            const avgConfWin = winners.length > 0
                ? winners.reduce((a, b) => a + b.confidence, 0) / winners.length
                : 0;

            const avgConfLoss = losers.length > 0
                ? losers.reduce((a, b) => a + b.confidence, 0) / losers.length
                : 0;

            return {
                trades_settled: settled.length,
                trades_pending: this.trades.length - settled.length,
                total_trades: this.trades.length,
                schema_version: this.schemaVersion,
                wins: this.stats.wins,
                losses: this.stats.losses,
                win_rate: winRate,
                profit_factor: profitFactor,
                pnl: this.stats.pnl,
                avg_confidence_winners: avgConfWin,
                avg_confidence_losers: avgConfLoss,
                confidence_edge: avgConfWin - avgConfLoss,
            };
        }

        /**
         * Asset-specific summary
         */
        assetSummary(asset) {
            const assetTrades = this.trades.filter(t => t.asset === asset && t.settled);

            if (assetTrades.length === 0) {
                return { asset, trades: 0 };
            }

            const wins = assetTrades.filter(t => t.win === 1).length;
            const winRate = wins / assetTrades.length;

            return {
                asset: asset,
                trades: assetTrades.length,
                wins: wins,
                losses: assetTrades.length - wins,
                win_rate: winRate,
                avg_confidence: assetTrades.reduce((a, b) => a + b.confidence, 0) / assetTrades.length,
            };
        }

        /**
         * Regime-specific summary
         */
        regimeSummary(regime) {
            const regimeTrades = this.trades.filter(t => t.regime === regime && t.settled);

            if (regimeTrades.length === 0) {
                return { regime, trades: 0 };
            }

            const wins = regimeTrades.filter(t => t.win === 1).length;
            const winRate = wins / regimeTrades.length;

            return {
                regime: regime,
                trades: regimeTrades.length,
                win_rate: winRate,
                avg_confidence: regimeTrades.reduce((a, b) => a + b.confidence, 0) / regimeTrades.length,
            };
        }

        /**
         * Find outlier trades
         * @returns {array} trades with unusual parameters
         */
        findOutliers() {
            const settled = this.trades.filter(t => t.settled && t.win !== null);

            if (settled.length === 0) return [];

            const confidences = settled.map(t => t.confidence);
            const mean = confidences.reduce((a, b) => a + b) / confidences.length;
            const std = Math.sqrt(
                confidences.reduce((a, b) => a + Math.pow(b - mean, 2)) / confidences.length
            );

            // 2-sigma outliers
            return settled.filter(t => Math.abs(t.confidence - mean) > 2 * std);
        }

        /**
         * Persist to storage
         */
        persist() {
            try {
                // localStorage
                const jsonl = this.exportJsonl();
                if (typeof localStorage !== 'undefined' && localStorage.setItem) {
                    localStorage.setItem(this.storageKey, jsonl);
                }

                // Multi-drive cache (Windows)
                // if (typeof window !== 'undefined' && window.MultiDriveCache) {
                //     window.MultiDriveCache.set('trade_journal', jsonl);
                // }
            } catch (err) {
                console.error('[TradeJournal] Persist error:', err.message);
            }
        }

        /**
         * Load from storage
         */
        loadFromStorage() {
            try {
                if (typeof localStorage === 'undefined' || !localStorage.getItem) {
                    return;
                }

                const jsonl = localStorage.getItem(this.storageKey);
                if (!jsonl) return;

                const lines = jsonl.trim().split('\n');
                this.trades = lines
                    .map(line => {
                        try {
                            return JSON.parse(line);
                        } catch {
                            return null;
                        }
                    })
                    .filter(t => t !== null);

                // Recompute stats
                this.stats = { total: 0, wins: 0, losses: 0, pnl: 0 };
                for (let t of this.trades) {
                    if (t.settled && t.win !== null) {
                        this.stats.total++;
                        if (t.win) {
                            this.stats.wins++;
                            this.stats.pnl++;
                        } else {
                            this.stats.losses++;
                            this.stats.pnl--;
                        }
                    }
                }
            } catch (err) {
                console.error('[TradeJournal] Load error:', err.message);
            }
        }

        /**
         * Clear all trades
         */
        clear() {
            this.trades = [];
            this.stats = { total: 0, wins: 0, losses: 0, pnl: 0 };
            if (typeof localStorage !== 'undefined' && localStorage.removeItem) {
                localStorage.removeItem(this.storageKey);
            }
        }

        /**
         * Query trades
         */
        query(filters = {}) {
            let result = [...this.trades];

            if (filters.asset) {
                result = result.filter(t => t.asset === filters.asset);
            }

            if (filters.regime) {
                result = result.filter(t => t.regime === filters.regime);
            }

            if (filters.settled !== undefined) {
                result = result.filter(t => t.settled === filters.settled);
            }

            if (filters.min_confidence) {
                result = result.filter(t => t.confidence >= filters.min_confidence);
            }

            if (filters.after) {
                result = result.filter(t => t.timestamp >= filters.after);
            }

            return result;
        }
    }

    window.TradeJournal = TradeJournal;
    console.log('[TradeJournal] Loaded');
})();
