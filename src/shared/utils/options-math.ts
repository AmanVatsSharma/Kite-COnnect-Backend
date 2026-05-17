/**
 * @file options-math.ts
 * @module Options Pricing Math
 * @description Pure Black-Scholes options pricing and Greeks calculation utilities.
 *              No external dependencies — implements everything from scratch.
 *
 * Exports:
 *   - normalCDF(x) → number                         — Standard Normal CDF
 *   - blackScholesD1D2(...) → { d1, d2 }           — d1/d2 calculation
 *   - blackScholesCall(...) → number                — Call price
 *   - blackScholesPut(...) → number                 — Put price
 *   - delta(type, ...) → number                     — Delta Greek
 *   - gamma(...) → number                           — Gamma Greek
 *   - theta(type, ...) → number                     — Theta Greek
 *   - vega(...) → number                            — Vega Greek
 *   - impliedVolatility(...) → number | null        — IV via Newton-Raphson
 *   - daysToExpiry(expiry, from?) → number          — DTE in years
 *
 * Author: BharatERP
 * Last-updated: 2026-05-17
 */

// India market risk-free rate (RBI 91-day T-Bill ~6.5%)
export const RISK_FREE_RATE = 0.065;

/**
 * Standard Normal Cumulative Distribution Function
 * Abramowitz & Stegun approximation (error < 7.5e-8)
 * Handles extreme values gracefully (returns 0 or 1 for |x| > 37)
 */
export function normalCDF(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < -37) return 0;
  if (x > 37) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;

  const y =
    1.0 - (a1 * t + a2 * t2 + a3 * t3 + a4 * t4 + a5 * t5) * Math.exp(-absX * absX * 0.5);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Standard Normal Probability Density Function
 */
export function normalPDF(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes d1 and d2
 */
export function blackScholesD1D2(
  S: number, // Spot price
  K: number, // Strike price
  T: number, // Time to expiry (years)
  r: number, // Risk-free rate (annual, e.g., 0.065)
  sigma: number, // Implied volatility (annual, e.g., 0.20)
): { d1: number; d2: number } {
  if (T <= 0 || sigma <= 0) {
    // At expiry or zero volatility, handle edge case
    const d1 = S === K ? 0 : S > K ? Infinity : -Infinity;
    return { d1, d2: d1 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  return { d1, d2 };
}

/**
 * Black-Scholes Call Option Price
 */
export function blackScholesCall(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0) {
    // At expiry
    return Math.max(0, S - K);
  }

  const { d1, d2 } = blackScholesD1D2(S, K, T, r, sigma);
  const call = S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
  return Math.max(0, call);
}

/**
 * Black-Scholes Put Option Price
 */
export function blackScholesPut(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0) {
    // At expiry
    return Math.max(0, K - S);
  }

  const { d1, d2 } = blackScholesD1D2(S, K, T, r, sigma);
  const put = K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
  return Math.max(0, put);
}

/**
 * Delta — Rate of change of option price with respect to underlying price
 * Call: N(d1), Put: N(d1) - 1
 */
export function delta(
  type: 'call' | 'put',
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0) {
    // At expiry
    if (type === 'call') return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }

  const { d1 } = blackScholesD1D2(S, K, T, r, sigma);
  return type === 'call' ? normalCDF(d1) : normalCDF(d1) - 1;
}

/**
 * Gamma — Rate of change of delta with respect to underlying price
 * Same for calls and puts
 */
export function gamma(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0 || S <= 0) return 0;

  const { d1 } = blackScholesD1D2(S, K, T, r, sigma);
  return normalPDF(d1) / (S * sigma * Math.sqrt(T));
}

/**
 * Theta — Rate of change of option price with respect to time (per day)
 * Returns daily theta (divide annual by 365)
 *
 * Note: We negate and divide by 365 to convert annual theta to per-day
 */
export function theta(
  type: 'call' | 'put',
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0) return 0;

  const { d1, d2 } = blackScholesD1D2(S, K, T, r, sigma);
  const sqrtT = Math.sqrt(T);
  const term1 = (-S * normalPDF(d1) * sigma) / (2 * sqrtT);

  if (type === 'call') {
    const term2 = -r * K * Math.exp(-r * T) * normalCDF(d2);
    return (term1 + term2) / 365; // Daily theta
  } else {
    const term2 = r * K * Math.exp(-r * T) * normalCDF(-d2);
    return (term1 + term2) / 365; // Daily theta
  }
}

/**
 * Vega — Rate of change of option price with respect to volatility (per 1% change)
 * Same for calls and puts
 * Returns vega for 1% change in volatility (divide by 100)
 */
export function vega(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0) return 0;

  const { d1 } = blackScholesD1D2(S, K, T, r, sigma);
  // Vega for 1% change (divide by 100)
  return (S * normalPDF(d1) * Math.sqrt(T)) / 100;
}

/**
 * Calculate Implied Volatility using Newton-Raphson method
 * Inverts Black-Scholes to find sigma given market price
 *
 * @param marketPrice - Observed market price of the option
 * @param S - Spot price
 * @param K - Strike price
 * @param T - Time to expiry (years)
 * @param r - Risk-free rate
 * @param type - 'call' or 'put'
 * @param tolerance - Convergence tolerance (default 0.0001)
 * @param maxIterations - Max Newton-Raphson iterations (default 100)
 * @returns IV as decimal (e.g., 0.20 for 20%) or null if cannot converge
 */
export function impliedVolatility(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  type: 'call' | 'put',
  tolerance = 0.0001,
  maxIterations = 100,
): number | null {
  // Edge cases
  if (marketPrice <= 0 || T <= 0 || S <= 0 || K <= 0) return null;

  // Check for arbitrage bounds
  const intrinsic = type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (marketPrice < intrinsic) return null; // Below intrinsic value

  const maxPrice = type === 'call' ? S : K * Math.exp(-r * T);
  if (marketPrice > maxPrice) return null; // Above maximum possible value

  // Initial guess using at-the-money approximation
  // ATM IV ≈ (C/P) / sqrt(T) * some constant (rough estimate)
  let sigma = 0.20; // Start with 20% IV as initial guess

  // Bound sigma to prevent explosion
  const SIGMA_MIN = 0.001; // 0.1%
  const SIGMA_MAX = 5.0; // 500%

  for (let i = 0; i < maxIterations; i++) {
    const price = type === 'call'
      ? blackScholesCall(S, K, T, r, sigma)
      : blackScholesPut(S, K, T, r, sigma);

    const diff = price - marketPrice;
    if (Math.abs(diff) < tolerance) {
      return sigma; // Converged!
    }

    // Vega for 1% change (positive, represents sensitivity)
    const v = vega(S, K, T, r, sigma) * 100; // Scale back for actual vega

    if (Math.abs(v) < 1e-10) {
      // Vega too small, can't converge
      break;
    }

    // Newton-Raphson update
    const delta = diff / v;
    sigma = sigma - delta;

    // Bound sigma
    if (sigma < SIGMA_MIN) sigma = SIGMA_MIN;
    if (sigma > SIGMA_MAX) sigma = SIGMA_MAX;

    // Check for convergence
    if (Math.abs(delta) < tolerance) {
      return sigma;
    }
  }

  // If Newton-Raphson fails, try bisection as fallback
  return bisectIV(marketPrice, S, K, T, r, type, SIGMA_MIN, SIGMA_MAX, tolerance);
}

/**
 * Bisection method for IV calculation (fallback if Newton-Raphson fails)
 */
function bisectIV(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  type: 'call' | 'put',
  sigmaLow: number,
  sigmaHigh: number,
  tolerance: number,
): number | null {
  const priceLow = type === 'call'
    ? blackScholesCall(S, K, T, r, sigmaLow)
    : blackScholesPut(S, K, T, r, sigmaLow);
  const priceHigh = type === 'call'
    ? blackScholesCall(S, K, T, r, sigmaHigh)
    : blackScholesPut(S, K, T, r, sigmaHigh);

  if (marketPrice < priceLow || marketPrice > priceHigh) {
    return null; // Out of range
  }

  for (let i = 0; i < 200; i++) {
    const sigmaMid = (sigmaLow + sigmaHigh) / 2;
    const priceMid = type === 'call'
      ? blackScholesCall(S, K, T, r, sigmaMid)
      : blackScholesPut(S, K, T, r, sigmaMid);

    if (Math.abs(priceMid - marketPrice) < tolerance) {
      return sigmaMid;
    }

    if (priceMid < marketPrice) {
      sigmaLow = sigmaMid;
    } else {
      sigmaHigh = sigmaMid;
    }
  }

  return (sigmaLow + sigmaHigh) / 2; // Best estimate
}

/**
 * Calculate days to expiry as fraction of year (for Black-Scholes T parameter)
 *
 * @param expiryDate - Expiry date string (YYYY-MM-DD format)
 * @param fromDate - Reference date (defaults to now)
 * @returns Time to expiry in years (actual/365 day count)
 */
export function daysToExpiry(expiryDate: string, fromDate?: Date): number {
  const expiry = new Date(expiryDate);
  const from = fromDate || new Date();

  // Set to market close (15:30 IST = 10:00 UTC)
  expiry.setUTCHours(10, 0, 0, 0);
  from.setUTCHours(10, 0, 0, 0);

  const diffMs = expiry.getTime() - from.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  // T should be in years for Black-Scholes (use actual/365 for India)
  return Math.max(0, diffDays / 365);
}

/**
 * Calculate Max Pain strike price
 * Max Pain is the strike where the sum of (|strike - spot| * OI) is maximized
 * This is where the maximum pain is inflicted on option holders at expiry
 *
 * @param strikes - Array of { strike, ce_oi, pe_oi }
 * @param spotPrice - Current spot/underlying price
 * @returns Max Pain strike
 */
export function calculateMaxPain(
  strikes: Array<{ strike: number; ce_oi?: number; pe_oi?: number }>,
  spotPrice: number,
): number {
  if (strikes.length === 0) return spotPrice;

  let maxPain = 0;
  let maxPainStrike = strikes[0].strike;

  for (const { strike, ce_oi = 0, pe_oi = 0 } of strikes) {
    // Calculate pain at this strike (assumes all options expire)
    // Call holders profit when price goes UP (pain = max(0, strike - spot) * OI)
    // Put holders profit when price goes DOWN (pain = max(0, spot - strike) * OI)
    const callPain = ce_oi * Math.max(0, strike - spotPrice);
    const putPain = pe_oi * Math.max(0, spotPrice - strike);
    const totalPain = callPain + putPain;

    if (totalPain > maxPain) {
      maxPain = totalPain;
      maxPainStrike = strike;
    }
  }

  return maxPainStrike;
}

/**
 * Calculate probability of option expiring in-the-money
 * Uses normal distribution: P(ITM) = N(|d2|) for calls, N(|-d2|) for puts
 */
export function probabilityITM(
  type: 'call' | 'put',
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0) {
    return type === 'call' ? (S > K ? 1 : 0) : (S < K ? 1 : 0);
  }

  const { d2 } = blackScholesD1D2(S, K, T, r, sigma);
  return type === 'call' ? normalCDF(d2) : normalCDF(-d2);
}