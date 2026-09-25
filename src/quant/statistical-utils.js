/**
 * ================================================================
 * Statistical Utilities — Core Building Blocks
 * Isotonic regression, entropy, distributions, percentiles
 * ================================================================
 */

(function () {
    'use strict';

    /**
     * Isotonic Regression (PAV algorithm)
     * Monotone increasing regression: maps predictions → win rates
     * Detects overconfidence patterns (high pred, low actual outcome)
     * 
     * @param {number[]} x - predictions (confidence scores 0-1)
     * @param {number[]} y - outcomes (0 or 1)
     * @param {number[]} weights - optional sample weights (default 1)
     * @returns {object} { f: fitted values, theta: breakpoints, blocks: }
     */
    function isotonicRegression(x, y, weights) {
        if (!x || !y || x.length === 0 || x.length !== y.length) {
            throw new Error('isotonicRegression: x and y must have same non-zero length');
        }

        const n = x.length;
        weights = weights || Array(n).fill(1);

        // Sort by x values
        const indices = Array.from({ length: n }, (_, i) => i)
            .sort((i, j) => (x.at(i) ?? 0) - (x.at(j) ?? 0));

        const xs = indices.map(i => x.at(i));
        const ys = indices.map(i => y.at(i));
        const ws = indices.map(i => weights.at(i));

        // PAV (Pool Adjacent Violators) Algorithm
        let ghat = ys.slice();
        let gw = ws.slice();
        let blocks = Array.from({ length: n }, (_, i) => [i]);

        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < ghat.length - 1; i++) {
                const g_i = ghat.at(i);
                const g_next = ghat.at(i + 1);
                if (g_i > g_next) {
                    // Pool blocks i and i+1
                    const gw_i = gw.at(i);
                    const gw_next = gw.at(i + 1);
                    const newVal = (g_i * gw_i + g_next * gw_next) / (gw_i + gw_next);
                    ghat[i] = newVal;
                    ghat[i + 1] = newVal;
                    gw[i] = gw_i + gw_next;

                    // Merge blocks
                    blocks[i] = (blocks.at(i) || []).concat(blocks.at(i + 1) || []);
                    blocks.splice(i + 1, 1);
                    ghat.splice(i + 1, 1);
                    gw.splice(i + 1, 1);

                    changed = true;
                    break;
                }
            }
        }

        // Map back to original indices
        const f = Array(n);
        blocks.forEach((blockIndices, blockIdx) => {
            blockIndices.forEach(idx => {
                const origIdx = indices.at(idx);
                if (origIdx !== undefined) f[origIdx] = ghat.at(blockIdx);
            });
        });

        return {
            f: f,  // fitted values (monotone increasing)
            theta: ghat,  // unique fitted values
            blocks: blocks,  // block structure (used for MSE calc)
            xs: xs,  // sorted x values
            ys: ys,  // sorted y values
        };
    }

    /**
     * Calculate calibration error (mean absolute calibration error)
     * Compares predicted confidence vs actual win rate in bins
     * Low error = well-calibrated predictions
     * 
     * @param {number[]} predictions - predicted confidence [0,1]
     * @param {number[]} outcomes - actual outcomes [0,1]
     * @param {number} numBins - bins for calibration (default 10)
     * @returns {object} { error, byBin: [{pred, actual, count, error}] }
     */
    function calibrationError(predictions, outcomes, numBins = 10) {
        if (predictions.length === 0) return { error: 0, byBin: [] };

        const bins = Array(numBins).fill(0).map(() => ({ preds: [], outcomes: [] }));

        for (let i = 0; i < predictions.length; i++) {
            const predVal = predictions.at(i);
            const outVal = outcomes.at(i);
            if (predVal !== undefined && outVal !== undefined) {
                const bin = Math.min(numBins - 1, Math.floor(predVal * numBins));
                bins.at(bin)?.preds.push(predVal);
                bins.at(bin)?.outcomes.push(outVal);
            }
        }

        let totalError = 0;
        const byBin = bins
            .map((bin, idx) => {
                if (bin.preds.length === 0) return null;

                const avgPred = bin.preds.reduce((a, b) => a + b) / bin.preds.length;
                const avgOutcome = bin.outcomes.reduce((a, b) => a + b) / bin.outcomes.length;
                const error = Math.abs(avgPred - avgOutcome);
                totalError += error * bin.preds.length;

                return {
                    binIdx: idx,
                    pred: avgPred,
                    actual: avgOutcome,
                    count: bin.preds.length,
                    error: error,
                };
            })
            .filter(b => b !== null);

        return {
            error: totalError / predictions.length,
            byBin: byBin,
        };
    }

    /**
     * Population Stability Index (PSI)
     * Measures distribution shift between expected (baseline) and actual
     * PSI > 0.1 = significant shift, > 0.25 = major shift
     * 
     * @param {number[]} expected - baseline distribution (values)
     * @param {number[]} actual - current distribution (values)
     * @param {number} numBins - histogram bins (default 10)
     * @returns {number} PSI value
     */
    function populationStabilityIndex(expected, actual, numBins = 10) {
        if (!expected || !actual || expected.length === 0 || actual.length === 0) {
            return 0;
        }

        const minVal = Math.min(...expected, ...actual);
        const maxVal = Math.max(...expected, ...actual);
        const binWidth = (maxVal - minVal) / numBins || 1;

        const expectedDist = Array(numBins).fill(0);
        const actualDist = Array(numBins).fill(0);

        expected.forEach(val => {
            const bin = Math.floor((val - minVal) / binWidth);
            const idx = Math.min(numBins - 1, Math.max(0, bin));
            expectedDist[idx]++;
        });

        actual.forEach(val => {
            const bin = Math.floor((val - minVal) / binWidth);
            const idx = Math.min(numBins - 1, Math.max(0, bin));
            actualDist[idx]++;
        });

        // Normalize to probabilities
        const expProb = expectedDist.map(c => (c + 1) / (expected.length + numBins));
        const actProb = actualDist.map(c => (c + 1) / (actual.length + numBins));

        // Sum PSI across bins
        let psi = 0;
        for (let i = 0; i < numBins; i++) {
            const a = actProb.at(i) ?? 1e-10;
            const e = expProb.at(i) ?? 1e-10;
            psi += (a - e) * Math.log(a / e);
        }

        return psi;
    }

    /**
     * Kullback-Leibler Divergence
     * Asymmetric distance between two probability distributions
     * KL(P || Q) = sum(P(x) * log(P(x) / Q(x)))
     * 
     * @param {number[]} p - baseline distribution (probabilities, sums to 1)
     * @param {number[]} q - comparison distribution
     * @returns {number} KL divergence (0+ value)
     */
    function klDivergence(p, q) {
        if (!p || !q || p.length !== q.length) {
            throw new Error('klDivergence: arrays must have same length');
        }

        let kl = 0;
        for (let i = 0; i < p.length; i++) {
            const pVal = p.at(i) ?? 0;
            if (pVal > 1e-10) {  // avoid log(0)
                const qVal = Math.max(1e-10, q.at(i) ?? 1e-10);
                kl += pVal * Math.log(pVal / qVal);
            }
        }

        return kl;
    }

    /**
     * Entropy (information content of distribution)
     * H(X) = -sum(p(x) * log(p(x)))
     * Used for market uncertainty quantification
     * 
     * @param {number[]} probs - probability distribution (sums to ~1)
     * @returns {number} Entropy (bits if log2, nats if ln)
     */
    function entropy(probs) {
        let h = 0;
        for (let p of probs) {
            if (p > 1e-10) {
                h -= p * Math.log2(p);  // base-2: entropy in bits
            }
        }
        return h;
    }

    /**
     * Percentile calculation (linear interpolation)
     * @param {number[]} values - sorted array
     * @param {number} p - percentile (0-100)
     * @returns {number} percentile value
     */
    function percentile(values, p) {
        if (!values || values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const idx = (p / 100) * (sorted.length - 1);
        const lower = Math.floor(idx);
        const upper = Math.ceil(idx);
        const frac = idx - lower;

        if (lower === upper) return sorted[lower];
        return sorted[lower] * (1 - frac) + sorted[upper] * frac;
    }

    /**
     * Moving average (simple, exponential)
     * @param {number[]} values
     * @param {number} period - window size
     * @param {string} type - 'sma' or 'ema'
     * @returns {number[]} moving average
     */
    function movingAverage(values, period, type = 'sma') {
        if (!values || values.length === 0) return [];
        if (period <= 0) return values;

        if (type === 'sma') {
            const result = [];
            for (let i = 0; i < values.length; i++) {
                const start = Math.max(0, i - period + 1);
                const chunk = values.slice(start, i + 1);
                result.push(chunk.reduce((a, b) => a + b) / chunk.length);
            }
            return result;
        } else if (type === 'ema') {
            const result = [];
            const alpha = 2 / (period + 1);
            let ema = values.at(0) ?? 0;
            result.push(ema);

            for (let i = 1; i < values.length; i++) {
                const val = values.at(i) ?? 0;
                ema = val * alpha + ema * (1 - alpha);
                result.push(ema);
            }
            return result;
        }

        return values;
    }

    /**
     * Z-score normalization
     * @param {number[]} values
     * @returns {number[]} standardized values (mean=0, std=1)
     */
    function zscore(values) {
        if (values.length === 0) return [];

        const mean = values.reduce((a, b) => a + b) / values.length;
        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2)) / values.length;
        const std = Math.sqrt(variance) || 1;

        return values.map(v => (v - mean) / std);
    }

    /**
     * Min-Max scaling
     * @param {number[]} values
     * @param {number} min - target min (default 0)
     * @param {number} max - target max (default 1)
     * @returns {number[]} scaled values
     */
    function minMaxScale(values, min = 0, max = 1) {
        if (values.length === 0) return [];
        const dataMin = Math.min(...values);
        const dataMax = Math.max(...values);
        const range = dataMax - dataMin || 1;

        return values.map(v => {
            const normalized = (v - dataMin) / range;
            return normalized * (max - min) + min;
        });
    }

    /**
     * Covariance between two series
     * @param {number[]} x
     * @param {number[]} y
     * @returns {number} covariance
     */
    function covariance(x, y) {
        if (x.length === 0 || x.length !== y.length) return 0;

        const meanX = x.reduce((a, b) => a + b) / x.length;
        const meanY = y.reduce((a, b) => a + b) / y.length;

        let cov = 0;
        for (let i = 0; i < x.length; i++) {
            cov += ((x.at(i) ?? 0) - meanX) * ((y.at(i) ?? 0) - meanY);
        }

        return cov / (x.length - 1 || 1);
    }

    /**
     * Pearson correlation coefficient
     * @param {number[]} x
     * @param {number[]} y
     * @returns {number} correlation [-1, 1]
     */
    function correlation(x, y) {
        if (x.length === 0 || x.length !== y.length) return 0;

        const meanX = x.reduce((a, b) => a + b) / x.length;
        const meanY = y.reduce((a, b) => a + b) / y.length;

        let numSum = 0;
        let denomX = 0;
        let denomY = 0;

        for (let i = 0; i < x.length; i++) {
            const dx = (x.at(i) ?? 0) - meanX;
            const dy = (y.at(i) ?? 0) - meanY;
            numSum += dx * dy;
            denomX += dx * dx;
            denomY += dy * dy;
        }

        const denom = Math.sqrt(denomX * denomY);
        return denom === 0 ? 0 : numSum / denom;
    }

    /**
     * ADWIN (Adaptive Windowing) — drift detector
     * Maintains adaptive window of recent events
     * Detects sudden changes in distribution
     * 
     * @param {number} value - new data point
     * @param {number} delta - significance level (default 0.002)
     * @returns {boolean} true if drift detected
     */
    class ADWINDetector {
        constructor(delta = 0.002) {
            this.delta = delta;
            this.buckets = [];  // [{size, sum, variance}]
            this.total = 0;
            this.count = 0;
            this.lastDriftTime = 0;
        }

        add(value) {
            this.buckets.push({
                size: 1,
                sum: value,
                var: 0,
            });
            this.total += value;
            this.count++;

            // Compress buckets when too many
            if (this.buckets.length > 100) {
                this.compress();
            }

            return this.detectChange();
        }

        detectChange() {
            if (this.buckets.length < 2) return false;

            let driftDetected = false;
            const m = this.buckets.length;

            // Check all splits (windowing strategy)
            for (let k = 1; k < m; k++) {
                const w0 = this.sumBuckets(0, k);
                const w1 = this.sumBuckets(k, m);

                if (w0.n === 0 || w1.n === 0) continue;

                const m0 = w0.sum / w0.n;
                const m1 = w1.sum / w1.n;
                const v0 = w0.var / w0.n;
                const v1 = w1.var / w1.n;

                const epsilon = Math.sqrt((1 / (2 * w0.n)) * Math.log(2 * m / this.delta)) +
                    Math.sqrt((1 / (2 * w1.n)) * Math.log(2 * m / this.delta));

                if (Math.abs(m0 - m1) > epsilon) {
                    driftDetected = true;
                    this.lastDriftTime = Date.now();
                    // Remove older bucket (w0)
                    this.buckets.splice(0, k);
                    break;
                }
            }

            return driftDetected;
        }

        sumBuckets(start, end) {
            let sum = 0, sumVar = 0, n = 0;
            for (let i = start; i < end; i++) {
                if (i < this.buckets.length) {
                    const b = this.buckets.at(i);
                    if (b) {
                        sum += b.sum;
                        sumVar += b.var;
                        n += b.size;
                    }
                }
            }
            return { sum, var: sumVar, n };
        }

        compress() {
            if (this.buckets.length <= 50) return;

            // Merge oldest two buckets
            const b0 = this.buckets[0];
            const b1 = this.buckets[1];

            const newSum = b0.sum + b1.sum;
            const newN = b0.size + b1.size;
            const newVar = b0.var + b1.var;

            this.buckets[0] = {
                size: newN,
                sum: newSum,
                var: newVar,
            };

            this.buckets.splice(1, 1);
        }
    }

    /**
     * Quantile-Quantile plot statistics (for normality testing)
     * @param {number[]} values
     * @returns {object} { skewness, kurtosis, normality_score }
     */
    function qqStats(values) {
        if (values.length < 3) return { skewness: 0, kurtosis: 0, normality: 0 };

        const sorted = [...values].sort((a, b) => a - b);
        const mean = sorted.reduce((a, b) => a + b) / sorted.length;
        const std = Math.sqrt(sorted.reduce((a, b) => a + Math.pow(b - mean, 2)) / sorted.length) || 1;

        // Skewness
        let skew = 0;
        for (let x of sorted) {
            skew += Math.pow((x - mean) / std, 3);
        }
        skew /= sorted.length;

        // Kurtosis (excess)
        let kurt = 0;
        for (let x of sorted) {
            kurt += Math.pow((x - mean) / std, 4);
        }
        kurt = (kurt / sorted.length) - 3;

        // Jarque-Bera normality test (0-1 score, 1 = normal)
        const jb = (sorted.length / 6) * (skew * skew + (kurt * kurt) / 4);
        const normality = Math.exp(-jb);  // rough approximation

        return {
            skewness: skew,
            kurtosis: kurt,
            normality_score: normality,
        };
    }

    /**
     * Approximates the inverse normal CDF (probit function).
     */
    function norm_ppf(p) {
        if (!Number.isFinite(p) || p <= 0.0 || p >= 1.0) throw new Error("p must be in (0, 1)");
        
        const a1 = -3.969683028665376e+01, a2 =  2.209460984245205e+02,
              a3 = -2.759285104469687e+02, a4 =  1.383577518672690e+02,
              a5 = -3.066479806614716e+01, a6 =  2.506628277459239e+00;
        
        const b1 = -5.447609879822406e+01, b2 =  1.615858368580409e+02,
              b3 = -1.556989798598866e+02, b4 =  6.680131188771972e+01,
              b5 = -1.328068155288572e+01;
        
        const c1 = -7.784894002430293e-03, c2 = -3.223964580411365e-01,
              c3 = -2.400758277161838e+00, c4 = -2.549732539343734e+00,
              c5 =  4.374664141464968e+00, c6 =  2.938163982698783e+00;
        
        const d1 =  7.784695709041462e-03, d2 =  3.224671290700398e-01,
              d3 =  2.445134137142996e+00, d4 =  3.754408661907416e+00;
        
        const p_low = 0.02425, p_high = 1 - p_low;
        let q, r, x;
        
        if (0 < p && p < p_low) {
            q = Math.sqrt(-2 * Math.log(p));
            x = (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
                ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
        } else if (p_low <= p && p <= p_high) {
            q = p - 0.5;
            r = q * q;
            x = (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
                (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
        } else {
            q = Math.sqrt(-2 * Math.log(1 - p));
            x = -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
                 ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
        }
        return x;
    }

    /**
     * Calculates Binary Implied Volatility
     */
    function calculateBinaryIV(price, spot, strike, daysToExpiry, exchange = "polymarket", realizedVol = null) {
        let p = price;
        const ex = String(exchange || 'polymarket').toLowerCase();
        
        if (ex === "polymarket") {
            p = price / 1.02;
        } else if (ex === "kalshi") {
            p = price - (0.07 * price * (1 - price));
        }
        
        p = Math.max(0.001, Math.min(0.999, p));
        const T = daysToExpiry / 365.0;
        const d2 = norm_ppf(p);
        
        const logMoneyness = Math.log(spot / strike);
        const discriminant = (d2 * d2) + 2 * logMoneyness;
        
        if (discriminant < 0) {
            return { error: "Price violates no-arbitrage bounds for given Spot/Strike." };
        }
        
        const iv = (-d2 + Math.sqrt(discriminant)) / Math.sqrt(T);
        let vrp = null;
        
        if (realizedVol !== null && typeof realizedVol === 'number') {
            vrp = iv - realizedVol;
        }
        
        return {
            exchange: ex.charAt(0).toUpperCase() + ex.slice(1),
            adjusted_prob: Number(p.toFixed(4)),
            implied_vol: Number(iv.toFixed(4)),
            vrp: vrp !== null ? Number(vrp.toFixed(4)) : null
        };
    }

    /**
     * Exact Student-t density for nu=4 degrees of freedom
     */
    function student_t_pdf(x, nu = 4) {
        if (!Number.isFinite(x)) return 0;
        if (nu === 4) {
            return (3 / 8) * Math.pow(1 + (x * x) / 4, -2.5);
        }
        const num = Math.pow(1 + (x * x) / nu, -(nu + 1) / 2);
        return num / (Math.sqrt(nu) * 0.5);
    }

    /**
     * Exact closed-form Student-t CDF for nu=4 degrees of freedom:
     * F(t) = 0.5 + (t / (2 * sqrt(t^2 + 4))) * (1 + 2 / (t^2 + 4))
     */
    function student_t_cdf(t, nu = 4) {
        if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
        const denom = t * t + 4;
        return 0.5 + (t / (2 * Math.sqrt(denom))) * (1 + 2 / denom);
    }

    /**
     * Regularized Tail Boost Multiplier based on regime and burst pressure
     */
    function getTailBoostMultiplier(regimeName, burstPressure = 0) {
        if (burstPressure <= 0.35) return 1.0;
        const r = String(regimeName || '').toUpperCase();
        if (r.includes('HIGH') || r.includes('EXPLOSIVE') || r.includes('VOLATILE')) {
            return 1.58; // Regularized from 2.172x
        }
        if (r.includes('MID') || r.includes('ACCELERATING') || r.includes('TRENDING')) {
            return 1.21; // Regularized from 1.417x
        }
        if (r.includes('LOW') || r.includes('COMPRESSED') || r.includes('RANGING')) {
            return 1.05; // Anchored at 1.05x
        }
        return 1.85; // UNKNOWN regularized from 2.788x
    }

    // ── Expose API ──────────────────────────────────────────────────
    const targetScope = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this);
    targetScope.QuantStatUtils = {
        isotonicRegression,
        calibrationError,
        populationStabilityIndex,
        klDivergence,
        entropy,
        percentile,
        movingAverage,
        zscore,
        minMaxScale,
        covariance,
        correlation,
        ADWINDetector,
        qqStats,
        norm_ppf,
        calculateBinaryIV,
        student_t_pdf,
        student_t_cdf,
        getTailBoostMultiplier,
    };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = targetScope.QuantStatUtils;
    }

    console.log('[QuantStatUtils] Loaded: 17 utility functions');
})();
