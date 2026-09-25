/**
 * ================================================================
 * Calibration Curve Analysis
 * Isotonic regression: predicted_confidence → actual_win_rate
 * Detect overconfidence patterns
 * ================================================================
 */

(function () {
    'use strict';

    const OVERNIGHT_EMPIRICAL_HORIZON_DECILES = {
        '0-5m': [
            { predicted_prob: 0.0049, empirical_freq: 0.0114, count: 788 },
            { predicted_prob: 0.1431, empirical_freq: 0.24,   count: 25 },
            { predicted_prob: 0.2563, empirical_freq: 0.20,   count: 10 },
            { predicted_prob: 0.3476, empirical_freq: 0.20,   count: 10 },
            { predicted_prob: 0.4455, empirical_freq: 0.375,  count: 8 },
            { predicted_prob: 0.5594, empirical_freq: 0.75,   count: 8 },
            { predicted_prob: 0.617,  empirical_freq: 1.0,    count: 3 },
            { predicted_prob: 0.7463, empirical_freq: 1.0,    count: 6 },
            { predicted_prob: 0.861,  empirical_freq: 0.0,    count: 1 },
            { predicted_prob: 0.9811, empirical_freq: 0.8571, count: 7 }
        ],
        '6-15m': [
            { predicted_prob: 0.01,   empirical_freq: 0.0266, count: 1655 },
            { predicted_prob: 0.1473, empirical_freq: 0.162,  count: 142 },
            { predicted_prob: 0.2472, empirical_freq: 0.3375, count: 80 },
            { predicted_prob: 0.3453, empirical_freq: 0.4795, count: 73 },
            { predicted_prob: 0.4441, empirical_freq: 0.6071, count: 56 },
            { predicted_prob: 0.545,  empirical_freq: 0.6154, count: 26 },
            { predicted_prob: 0.642,  empirical_freq: 0.7727, count: 22 },
            { predicted_prob: 0.7475, empirical_freq: 0.70,   count: 10 },
            { predicted_prob: 0.859,  empirical_freq: 1.0,    count: 5 },
            { predicted_prob: 0.9701, empirical_freq: 0.8571, count: 7 }
        ],
        '16-30m': [
            { predicted_prob: 0.0143, empirical_freq: 0.0244, count: 2627 },
            { predicted_prob: 0.1458, empirical_freq: 0.19,   count: 279 },
            { predicted_prob: 0.2488, empirical_freq: 0.404,  count: 198 },
            { predicted_prob: 0.3454, empirical_freq: 0.5933, count: 150 },
            { predicted_prob: 0.4448, empirical_freq: 0.7581, count: 124 },
            { predicted_prob: 0.5439, empirical_freq: 0.6557, count: 61 },
            { predicted_prob: 0.6442, empirical_freq: 0.60,   count: 25 },
            { predicted_prob: 0.7222, empirical_freq: 0.60,   count: 5 },
            { predicted_prob: 0.8115, empirical_freq: 0.50,   count: 2 },
            { predicted_prob: 0.9999, empirical_freq: 1.0,    count: 13 }
        ],
        '31-60m': [
            { predicted_prob: 0.0156, empirical_freq: 0.0275, count: 4371 },
            { predicted_prob: 0.1461, empirical_freq: 0.2986, count: 777 },
            { predicted_prob: 0.2433, empirical_freq: 0.5018, count: 554 },
            { predicted_prob: 0.3436, empirical_freq: 0.5572, count: 341 },
            { predicted_prob: 0.4438, empirical_freq: 0.7137, count: 227 },
            { predicted_prob: 0.5384, empirical_freq: 0.7333, count: 120 },
            { predicted_prob: 0.6464, empirical_freq: 0.8649, count: 37 },
            { predicted_prob: 0.7174, empirical_freq: 0.8889, count: 9 },
            { predicted_prob: 0.86,   empirical_freq: 1.0,    count: 1 },
            { predicted_prob: 0.9857, empirical_freq: 1.0,    count: 22 }
        ]
    };

    function smoothDecilesWithLaplacePrior(deciles) {
        return deciles.map(d => {
            const n = d.count || 0;
            const pred = d.predicted_prob;
            const rawFreq = d.empirical_freq;
            if (n >= 10) {
                return { x: pred, y: rawFreq };
            }
            // Bayesian Laplace shrinkage toward prior for small-sample buckets (N < 10)
            const smoothedFreq = (n * rawFreq + 2 * pred) / (n + 2);
            return { x: pred, y: smoothedFreq };
        });
    }

    class CalibrationAnalyzer {
        constructor(options = {}) {
            this.predictions = [];  // {confidence, outcome}
            this.calibrationModel = null;
            this.metrics = null;

            if (options.seedOvernight !== false) {
                this.seedFromOvernightDeciles(options.horizon || '6-15m');
            }

            console.log('[CalibrationAnalyzer] Initialized (pre-seeded with overnight empirical deciles)');
        }

        /**
         * Pre-seed isotonic model from empirical overnight deciles with Laplace smoothing
         */
        seedFromOvernightDeciles(horizon = '6-15m') {
            const deciles = OVERNIGHT_EMPIRICAL_HORIZON_DECILES[horizon] || OVERNIGHT_EMPIRICAL_HORIZON_DECILES['6-15m'];
            const smoothed = smoothDecilesWithLaplacePrior(deciles);
            const xs = smoothed.map(s => s.x);
            const ys = smoothed.map(s => s.y);
            this.calibrationModel = {
                xs,
                ys,
                f: ys,
                horizon,
                seeded: true,
            };
            return this.calibrationModel;
        }

        /**
         * Add prediction-outcome pair
         * @param {number} confidence - predicted confidence [0,1]
         * @param {number} outcome - actual result [0 or 1]
         * @param {object} metadata - optional {regime, exchange, coin, horizon}
         */
        add(confidence, outcome, metadata = {}) {
            this.predictions.push({
                confidence: Math.max(0, Math.min(1, confidence)),
                outcome: outcome === 1 || outcome === true ? 1 : 0,
                timestamp: Date.now(),
                ...metadata,
            });

            if (this.predictions.length > 20000) {
                this.predictions.shift();
            }
        }

        /**
         * Recompute calibration curve (isotonic regression)
         * @param {number} minSamples - minimum to fit (default 30)
         */
        fit(minSamples = 30) {
            if (this.predictions.length < minSamples) {
                console.warn(`[CalibrationAnalyzer] Only ${this.predictions.length} samples, need ${minSamples}`);
                return false;
            }

            const confidences = this.predictions.map(p => p.confidence);
            const outcomes = this.predictions.map(p => p.outcome);

            try {
                const isotonic = window.QuantStatUtils.isotonicRegression(confidences, outcomes);
                this.calibrationModel = isotonic;
                this.computeMetrics();
                return true;
            } catch (err) {
                console.error('[CalibrationAnalyzer] Fit error:', err.message);
                return false;
            }
        }

        /**
         * Compute calibration metrics
         */
        computeMetrics() {
            if (!this.calibrationModel) return;

            const iso = this.calibrationModel;
            const n = this.predictions.length;

            // Calibration error
            const calibError = window.QuantStatUtils.calibrationError(
                this.predictions.map(p => p.confidence),
                this.predictions.map(p => p.outcome),
                10
            );

            // Brier Score (mean squared error of probabilities)
            let brierScore = 0;
            for (let i = 0; i < n; i++) {
                brierScore += Math.pow(this.predictions[i].confidence - this.predictions[i].outcome, 2);
            }
            brierScore /= n;

            // Win rate at different confidence levels
            const winRateByConfidence = this.binAnalysis(10);

            // Overconfidence detection
            const overconfidence = this.detectOverconfidence();

            this.metrics = {
                n_samples: n,
                calibration_error: calibError.error,
                brier_score: brierScore,
                max_calibration_error: calibError.byBin.reduce((m, b) => Math.max(m, b.error), 0),
                win_rate_by_confidence: winRateByConfidence,
                overconfidence: overconfidence,
                calibration_by_bin: calibError.byBin,
            };

            return this.metrics;
        }

        /**
         * Win rate analysis in confidence bins
         */
        binAnalysis(numBins = 10) {
            const bins = Array(numBins).fill(0).map(() => ({
                preds: [],
                outcomes: [],
            }));

            for (let pred of this.predictions) {
                const bin = Math.min(numBins - 1, Math.floor(pred.confidence * numBins));
                bins[bin].preds.push(pred.confidence);
                bins[bin].outcomes.push(pred.outcome);
            }

            const result = [];
            for (let i = 0; i < numBins; i++) {
                const bin = bins[i];
                if (bin.outcomes.length > 0) {
                    const winRate = bin.outcomes.reduce((a, b) => a + b) / bin.outcomes.length;
                    const avgConfidence = bin.preds.reduce((a, b) => a + b) / bin.preds.length;

                    result.push({
                        bin: i,
                        confidence_min: i / numBins,
                        confidence_max: (i + 1) / numBins,
                        avg_confidence: avgConfidence,
                        win_rate: winRate,
                        count: bin.outcomes.length,
                        accuracy_gap: winRate - avgConfidence,  // gap > 0 = underconfident, < 0 = overconfident
                    });
                }
            }

            return result;
        }

        /**
         * Detect overconfidence regions
         * Flagged if predicted confidence >> actual win rate
         */
        detectOverconfidence() {
            const bins = this.binAnalysis(10);
            const overconfident = [];

            for (let bin of bins) {
                if (bin.avg_confidence > 0.75 && bin.win_rate < 0.60) {
                    overconfident.push({
                        region: `${bin.confidence_min.toFixed(2)}-${bin.confidence_max.toFixed(2)}`,
                        predicted: bin.avg_confidence,
                        actual: bin.win_rate,
                        gap: bin.avg_confidence - bin.win_rate,
                        count: bin.count,
                    });
                }
            }

            return {
                detected: overconfident.length > 0,
                regions: overconfident,
                score: overconfident.length,  // number of overconfident bins
            };
        }

        /**
         * Apply calibration correction to new confidence
         * Maps through isotonic model: pred_confidence → calibrated_confidence
         * 
         * @param {number} rawConfidence - raw model output
         * @returns {number} calibrated confidence
         */
        calibrate(rawConfidence) {
            if (!this.calibrationModel) return rawConfidence;

            const iso = this.calibrationModel;
            const x = Math.max(0, Math.min(1, rawConfidence));
            if (!iso.xs || !iso.f || iso.xs.length === 0) {
                return x;
            }

            const sorted = iso.xs.map((v, i) => ({ x: v, y: iso.f[i] }))
                .sort((a, b) => a.x - b.x);

            if (x <= sorted[0].x) return sorted[0].y;
            if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

            for (let i = 0; i < sorted.length - 1; i++) {
                const left = sorted[i];
                const right = sorted[i + 1];
                if (x >= left.x && x <= right.x) {
                    const dx = right.x - left.x;
                    if (dx <= 1e-12) return right.y;
                    const t = (x - left.x) / dx;
                    return left.y + t * (right.y - left.y);
                }
            }

            return x;
        }

        /**
         * Regime-specific calibration
         * 
         * @param {string} regime - CHOP|TREND|CASCADE|MANIA
         * @returns {object} calibration stats for regime
         */
        regimeCalibration(regime) {
            const regimePreds = this.predictions.filter(p => p.regime === regime);

            if (regimePreds.length < 10) {
                return { regime, samples: regimePreds.length, status: 'insufficient_data' };
            }

            const confs = regimePreds.map(p => p.confidence);
            const outcomes = regimePreds.map(p => p.outcome);

            const winRate = outcomes.reduce((a, b) => a + b) / outcomes.length;
            const avgConf = confs.reduce((a, b) => a + b) / confs.length;

            const calibError = window.QuantStatUtils.calibrationError(confs, outcomes, 5);

            return {
                regime: regime,
                samples: regimePreds.length,
                avg_confidence: avgConf,
                win_rate: winRate,
                calibration_error: calibError.error,
                under_over_confident: avgConf > winRate ? 'OVERCONFIDENT' : 'UNDERCONFIDENT',
            };
        }

        /**
         * Coin-specific calibration
         */
        coinCalibration(coin) {
            const coinPreds = this.predictions.filter(p => p.coin === coin);

            if (coinPreds.length < 10) {
                return { coin, samples: coinPreds.length, status: 'insufficient_data' };
            }

            const confs = coinPreds.map(p => p.confidence);
            const outcomes = coinPreds.map(p => p.outcome);

            const winRate = outcomes.reduce((a, b) => a + b) / outcomes.length;
            const avgConf = confs.reduce((a, b) => a + b) / confs.length;
            const calibError = window.QuantStatUtils.calibrationError(confs, outcomes, 5);

            return {
                coin: coin,
                samples: coinPreds.length,
                avg_confidence: avgConf,
                win_rate: winRate,
                calibration_error: calibError.error,
            };
        }

        /**
         * Overall calibration score (0-100)
         * 100 = perfectly calibrated
         * <50 = poorly calibrated (overconfident)
         */
        calibrationScore() {
            if (!this.metrics) return 0;

            // Based on calibration error + Brier score
            const calibErr = Math.max(0, 0.15 - this.metrics.calibration_error);
            const brierPenalty = Math.min(this.metrics.brier_score, 0.25);

            const score = (calibErr / 0.15) * 50 + (1 - brierPenalty / 0.25) * 50;
            return Math.max(0, Math.min(100, score));
        }

        /**
         * Export data for visualization
         */
        export() {
            return {
                predictions: this.predictions,
                metrics: this.metrics,
                calibration_score: this.calibrationScore(),
                model: this.calibrationModel ? {
                    fitted_values: this.calibrationModel.f,
                    original_x: this.calibrationModel.xs,
                    original_y: this.calibrationModel.ys,
                } : null,
            };
        }

        /**
         * Reset
         */
        reset(options = {}) {
            this.predictions = [];
            this.calibrationModel = null;
            this.metrics = null;
            if (options.reseed !== false) {
                this.seedFromOvernightDeciles(options.horizon || '6-15m');
            }
        }
    }

    const targetScope = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this);
    targetScope.CalibrationAnalyzer = CalibrationAnalyzer;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = CalibrationAnalyzer;
    }
    console.log('[CalibrationAnalyzer] Loaded');
})();
