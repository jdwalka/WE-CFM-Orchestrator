/**
 * ================================================================
 * MATH / WASM PROBABILITY DISTRIBUTIONS
 * ================================================================
 * Pure mathematical functions for probability, normal CDF,
 * and Black-Scholes pricing. Designed to wrap WASM modules with
 * high-performance JS fallbacks.
 */

/**
 * Standard Normal Cumulative Distribution Function (JS Fallback)
 * Approximates Phi(z) with error < 7.5e-8 (Abramowitz and Stegun 26.2.17)
 */
export function normal_cdf_js(z: number): number {
  if (z === 0) return 0.5;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2.0);
  
  // A&S approximation for erf(x)
  const t = 1.0 / (1.0 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  
  const erf = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * erf);
}

/**
 * Executes sub-millisecond CDF calculation.
 * Pluggable for compiled C++/Assembly WASM bridge.
 */
export function getProbability(zScore: number): number {
  return normal_cdf_js(zScore);
}

/**
 * Black-Scholes binary option implied fair value
 */
export function calculateBinaryFairValue(
  spotPrice: number,
  strikePrice: number,
  timeToExpiryDays: number,
  impliedVolatility: number
): number {
  if (timeToExpiryDays <= 0) {
    return spotPrice >= strikePrice ? 1.0 : 0.0;
  }
  const t = timeToExpiryDays / 365.0;
  const d2 = (Math.log(spotPrice / strikePrice) - 0.5 * impliedVolatility * impliedVolatility * t) /
    (impliedVolatility * Math.sqrt(t));
  return getProbability(d2);
}
