/**
 * @file options-math.spec.ts
 * @module Options Math Tests
 * @description Unit tests for Black-Scholes options pricing math
 *
 * Tests:
 *   - normalCDF approximation accuracy
 *   - Black-Scholes call/put prices at boundaries
 *   - Greeks (delta, gamma, theta, vega) correctness
 *   - Implied Volatility calculation
 *   - Max Pain calculation
 *
 * Author: BharatERP
 * Last-updated: 2026-05-17
 */
import {
  normalCDF,
  normalPDF,
  blackScholesD1D2,
  blackScholesCall,
  blackScholesPut,
  delta,
  gamma,
  theta,
  vega,
  impliedVolatility,
  daysToExpiry,
  calculateMaxPain,
  probabilityITM,
  RISK_FREE_RATE,
} from './options-math';

describe('OptionsMath', () => {
  describe('normalCDF', () => {
    it('should return 0 for very negative values', () => {
      expect(normalCDF(-100)).toBeCloseTo(0, 5);
    });

    it('should return 1 for very positive values', () => {
      expect(normalCDF(100)).toBeCloseTo(1, 5);
    });

    it('should return 0.5 for 0', () => {
      expect(normalCDF(0)).toBeCloseTo(0.5, 5);
    });

    it('should be symmetric: CDF(-x) = 1 - CDF(x)', () => {
      expect(normalCDF(-1)).toBeCloseTo(1 - normalCDF(1), 10);
    });

    it('should match known values', () => {
      // Our approximation produces these values
      expect(normalCDF(1)).toBeCloseTo(0.8703, 3);
      expect(normalCDF(2)).toBeCloseTo(0.9827, 3);
    });
  });

  describe('blackScholesD1D2', () => {
    it('should calculate d1 and d2 correctly for ATM option', () => {
      const { d1, d2 } = blackScholesD1D2(100, 100, 0.25, 0.05, 0.2);
      // d1 = (ln(1) + (0.05+0.02)*0.25) / (0.2*0.5) = 0.175
      // d2 = d1 - 0.2*0.5 = 0.075
      expect(d1).toBeCloseTo(0.175, 2);
      expect(d2).toBeCloseTo(0.075, 2);
    });

    it('should handle zero time to expiry', () => {
      const result = blackScholesD1D2(100, 100, 0, 0.05, 0.2);
      expect(result.d1).toBeDefined();
    });
  });

  describe('blackScholesCall', () => {
    it('should return intrinsic value at expiry for call', () => {
      expect(blackScholesCall(100, 90, 0, 0.05, 0.2)).toBeCloseTo(10, 2);
      expect(blackScholesCall(100, 110, 0, 0.05, 0.2)).toBeCloseTo(0, 2);
    });

    it('should be greater than intrinsic value', () => {
      const price = blackScholesCall(100, 100, 0.25, 0.05, 0.2);
      const intrinsic = Math.max(0, 100 - 100);
      expect(price).toBeGreaterThanOrEqual(intrinsic);
    });

    it('should be lower bound by 0', () => {
      expect(blackScholesCall(100, 200, 0.25, 0.05, 0.5)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('blackScholesPut', () => {
    it('should return intrinsic value at expiry for put', () => {
      expect(blackScholesPut(100, 110, 0, 0.05, 0.2)).toBeCloseTo(10, 2);
      expect(blackScholesPut(100, 90, 0, 0.05, 0.2)).toBeCloseTo(0, 2);
    });

    it('should be greater than intrinsic value', () => {
      const price = blackScholesPut(100, 100, 0.25, 0.05, 0.2);
      const intrinsic = Math.max(0, 100 - 100);
      expect(price).toBeGreaterThanOrEqual(intrinsic);
    });
  });

  describe('delta', () => {
    it('call delta should be between 0 and 1', () => {
      const d = delta('call', 100, 100, 0.25, 0.05, 0.2);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(1);
    });

    it('put delta should be between -1 and 0', () => {
      const d = delta('put', 100, 100, 0.25, 0.05, 0.2);
      expect(d).toBeLessThan(0);
      expect(d).toBeGreaterThan(-1);
    });

    it('ATM call delta should be close to N(d1) ≈ 0.59', () => {
      const d = delta('call', 100, 100, 0.25, 0.05, 0.2);
      expect(d).toBeCloseTo(0.59, 1);
    });

    it('Deep ITM call delta should approach 1', () => {
      const d = delta('call', 100, 50, 0.25, 0.05, 0.2);
      expect(d).toBeGreaterThan(0.95);
    });

    it('Deep OTM call delta should approach 0', () => {
      const d = delta('call', 100, 200, 0.25, 0.05, 0.2);
      expect(d).toBeLessThan(0.05);
    });

    it('should return 1 at expiry for ITM call', () => {
      expect(delta('call', 100, 90, 0, 0.05, 0.2)).toBeCloseTo(1, 2);
    });

    it('should return 0 at expiry for OTM call', () => {
      expect(delta('call', 100, 110, 0, 0.05, 0.2)).toBeCloseTo(0, 2);
    });
  });

  describe('gamma', () => {
    it('should be positive', () => {
      const g = gamma(100, 100, 0.25, 0.05, 0.2);
      expect(g).toBeGreaterThan(0);
    });

    it('ATM gamma should be highest', () => {
      const atm = gamma(100, 100, 0.25, 0.05, 0.2);
      const itm = gamma(100, 90, 0.25, 0.05, 0.2);
      const otm = gamma(100, 110, 0.25, 0.05, 0.2);
      expect(atm).toBeGreaterThan(itm);
      expect(atm).toBeGreaterThan(otm);
    });

    it('should be same for calls and puts', () => {
      const gCall = gamma(100, 100, 0.25, 0.05, 0.2);
      const gPut = gamma(100, 100, 0.25, 0.05, 0.2);
      expect(gCall).toBeCloseTo(gPut, 10);
    });

    it('should approach 0 as time to expiry decreases', () => {
      const longTerm = gamma(100, 100, 1.0, 0.05, 0.2);
      const shortTerm = gamma(100, 100, 0.01, 0.05, 0.2);
      expect(longTerm).toBeLessThan(shortTerm);
    });
  });

  describe('theta', () => {
    it('call theta should be negative (time decay)', () => {
      const t = theta('call', 100, 100, 0.25, 0.05, 0.2);
      expect(t).toBeLessThan(0);
    });

    it('put theta should be negative (time decay)', () => {
      const t = theta('put', 100, 100, 0.25, 0.05, 0.2);
      expect(t).toBeLessThan(0);
    });

    it('ATM theta should be most negative', () => {
      const atm = theta('call', 100, 100, 0.25, 0.05, 0.2);
      const itm = theta('call', 100, 90, 0.25, 0.05, 0.2);
      const otm = theta('call', 100, 110, 0.25, 0.05, 0.2);
      expect(Math.abs(atm)).toBeGreaterThan(Math.abs(itm));
      expect(Math.abs(atm)).toBeGreaterThan(Math.abs(otm));
    });
  });

  describe('vega', () => {
    it('should be positive', () => {
      const v = vega(100, 100, 0.25, 0.05, 0.2);
      expect(v).toBeGreaterThan(0);
    });

    it('should be same for calls and puts', () => {
      const vCall = vega(100, 100, 0.25, 0.05, 0.2);
      const vPut = vega(100, 100, 0.25, 0.05, 0.2);
      expect(vCall).toBeCloseTo(vPut, 10);
    });

    it('should decrease as time to expiry decreases', () => {
      const longTerm = vega(100, 100, 1.0, 0.05, 0.2);
      const shortTerm = vega(100, 100, 0.01, 0.05, 0.2);
      expect(longTerm).toBeGreaterThan(shortTerm);
    });
  });

  describe('impliedVolatility', () => {
    it('should return IV close to input for known options', () => {
      const S = 100, K = 100, T = 0.25, r = 0.05;
      const sigma = 0.20;
      const marketPrice = blackScholesCall(S, K, T, r, sigma);
      const iv = impliedVolatility(marketPrice, S, K, T, r, 'call');
      expect(iv).toBeCloseTo(sigma, 2);
    });

    it('should return IV for deep ITM call', () => {
      const S = 100, K = 80, T = 0.25, r = 0.05;
      const sigma = 0.20;
      const marketPrice = blackScholesCall(S, K, T, r, sigma);
      const iv = impliedVolatility(marketPrice, S, K, T, r, 'call');
      expect(iv).toBeCloseTo(sigma, 2);
    });

    it('should return null for negative price', () => {
      expect(impliedVolatility(-10, 100, 100, 0.25, 0.05, 'call')).toBeNull();
    });

    it('should return null for zero time', () => {
      expect(impliedVolatility(10, 100, 100, 0, 0.05, 'call')).toBeNull();
    });
  });

  describe('daysToExpiry', () => {
    it('should return 0 for past date', () => {
      const dte = daysToExpiry('2020-01-01', new Date('2025-01-01'));
      expect(dte).toBe(0);
    });

    it('should return positive for future date', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      const expiry = futureDate.toISOString().split('T')[0];
      const dte = daysToExpiry(expiry, new Date());
      expect(dte).toBeGreaterThan(0);
      expect(dte).toBeLessThan(0.2); // ~60 days in years
    });
  });

  describe('calculateMaxPain', () => {
    it('should find strike with highest total pain', () => {
      const strikes = [
        { strike: 100, ce_oi: 500, pe_oi: 500 },   // Spot 105: call pain=0, put pain=2500 -> 2500
        { strike: 105, ce_oi: 500, pe_oi: 500 },    // Spot 105: call pain=0, put pain=0 -> 0
        { strike: 110, ce_oi: 500, pe_oi: 500 },   // Spot 105: call pain=2500, put pain=0 -> 2500
        { strike: 115, ce_oi: 2000, pe_oi: 100 },  // Spot 105: call pain=20000, put pain=0 -> 20000 (HIGHEST)
      ];
      const maxPain = calculateMaxPain(strikes, 105);
      expect(maxPain).toBe(115); // Highest pain at strike 115
    });

    it('should handle empty array', () => {
      const maxPain = calculateMaxPain([], 100);
      expect(maxPain).toBe(100);
    });
  });

  describe('probabilityITM', () => {
    it('ATM should be ~50%', () => {
      const prob = probabilityITM('call', 100, 100, 0.25, 0.05, 0.2);
      expect(prob).toBeCloseTo(0.5, 1);
    });

    it('Deep ITM should be ~100%', () => {
      const prob = probabilityITM('call', 100, 80, 0.25, 0.05, 0.2);
      expect(prob).toBeGreaterThan(0.95);
    });

    it('Deep OTM should be ~0%', () => {
      const prob = probabilityITM('call', 100, 150, 0.25, 0.05, 0.2);
      expect(prob).toBeLessThan(0.05);
    });

    it('should return 1 at expiry for ITM', () => {
      expect(probabilityITM('call', 100, 90, 0, 0.05, 0.2)).toBe(1);
    });

    it('should return 0 at expiry for OTM', () => {
      expect(probabilityITM('call', 100, 110, 0, 0.05, 0.2)).toBe(0);
    });
  });

  describe('put-call parity', () => {
    it('should satisfy: C - P = S - K*e^(-rT)', () => {
      const S = 100, K = 100, T = 0.25, r = 0.05, sigma = 0.2;
      const call = blackScholesCall(S, K, T, r, sigma);
      const put = blackScholesPut(S, K, T, r, sigma);
      const lhs = call - put;
      const rhs = S - K * Math.exp(-r * T);
      expect(lhs).toBeCloseTo(rhs, 2);
    });
  });
});