/**
 * @file canonical-symbol.spec.ts
 * @module shared
 * @description Unit tests for canonical-symbol utility.
 * @author BharatERP
 * @created 2026-04-17
 * @updated 2026-04-17
 */
import {
  computeCanonicalSymbol,
  parseCanonicalSymbol,
  formatExpiryDate,
  CanonicalSymbolInput,
} from '../canonical-symbol';

describe('canonical-symbol', () => {
  describe('formatExpiryDate', () => {
    it('formats a date to YYYYMMDD', () => {
      expect(formatExpiryDate(new Date(2025, 3, 24))).toBe('20250424');
    });

    it('zero-pads single-digit months and days', () => {
      expect(formatExpiryDate(new Date(2025, 0, 5))).toBe('20250105');
    });

    it('handles December correctly', () => {
      expect(formatExpiryDate(new Date(2025, 11, 31))).toBe('20251231');
    });
  });

  describe('computeCanonicalSymbol', () => {
    it('generates equity symbol (EQ)', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NSE',
        underlying: 'RELIANCE',
        instrument_type: 'EQ',
      };
      expect(computeCanonicalSymbol(input)).toBe('NSE:RELIANCE');
    });

    it('generates index symbol (IDX)', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NSE',
        underlying: 'NIFTY',
        instrument_type: 'IDX',
      };
      expect(computeCanonicalSymbol(input)).toBe('NSE:NIFTY:IDX');
    });

    it('generates future symbol (FUT)', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NFO',
        underlying: 'NIFTY',
        instrument_type: 'FUT',
        expiry: new Date(2025, 3, 24),
      };
      expect(computeCanonicalSymbol(input)).toBe('NFO:NIFTY:FUT:20250424');
    });

    it('generates call option symbol (CE)', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NFO',
        underlying: 'NIFTY',
        instrument_type: 'CE',
        expiry: new Date(2025, 3, 24),
        strike: 22000,
      };
      expect(computeCanonicalSymbol(input)).toBe('NFO:NIFTY:CE:20250424:22000');
    });

    it('generates put option symbol (PE)', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NFO',
        underlying: 'NIFTY',
        instrument_type: 'PE',
        expiry: new Date(2025, 3, 24),
        strike: 22000,
      };
      expect(computeCanonicalSymbol(input)).toBe('NFO:NIFTY:PE:20250424:22000');
    });

    it('handles fractional strike prices', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NFO',
        underlying: 'BANKNIFTY',
        instrument_type: 'CE',
        expiry: new Date(2025, 3, 24),
        strike: 22000.5,
      };
      expect(computeCanonicalSymbol(input)).toBe(
        'NFO:BANKNIFTY:CE:20250424:22000.5',
      );
    });

    it('handles null expiry for equity', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'BSE',
        underlying: 'TCS',
        instrument_type: 'EQ',
        expiry: null,
        strike: null,
      };
      expect(computeCanonicalSymbol(input)).toBe('BSE:TCS');
    });

    it('handles case-insensitive instrument_type', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NSE',
        underlying: 'INFY',
        instrument_type: 'eq',
      };
      expect(computeCanonicalSymbol(input)).toBe('NSE:INFY');
    });
  });

  describe('parseCanonicalSymbol', () => {
    it('parses equity symbol (2 parts)', () => {
      const result = parseCanonicalSymbol('NSE:RELIANCE');
      expect(result).toEqual({
        exchange: 'NSE',
        underlying: 'RELIANCE',
        instrument_type: 'EQ',
      });
    });

    it('parses index symbol (3 parts)', () => {
      const result = parseCanonicalSymbol('NSE:NIFTY:IDX');
      expect(result).toEqual({
        exchange: 'NSE',
        underlying: 'NIFTY',
        instrument_type: 'IDX',
      });
    });

    it('parses future symbol (4 parts)', () => {
      const result = parseCanonicalSymbol('NFO:NIFTY:FUT:20250424');
      expect(result).toEqual({
        exchange: 'NFO',
        underlying: 'NIFTY',
        instrument_type: 'FUT',
        expiry: '20250424',
      });
    });

    it('parses call option symbol (5 parts)', () => {
      const result = parseCanonicalSymbol('NFO:NIFTY:CE:20250424:22000');
      expect(result).toEqual({
        exchange: 'NFO',
        underlying: 'NIFTY',
        instrument_type: 'CE',
        expiry: '20250424',
        strike: 22000,
        option_type: 'CE',
      });
    });

    it('parses put option symbol (5 parts)', () => {
      const result = parseCanonicalSymbol('NFO:NIFTY:PE:20250424:22000');
      expect(result).toEqual({
        exchange: 'NFO',
        underlying: 'NIFTY',
        instrument_type: 'PE',
        expiry: '20250424',
        strike: 22000,
        option_type: 'PE',
      });
    });

    it('parses fractional strike correctly', () => {
      const result = parseCanonicalSymbol('NFO:BANKNIFTY:CE:20250424:22000.5');
      expect(result.strike).toBe(22000.5);
    });

    it('roundtrips equity symbol', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NSE',
        underlying: 'RELIANCE',
        instrument_type: 'EQ',
      };
      const symbol = computeCanonicalSymbol(input);
      const parsed = parseCanonicalSymbol(symbol);
      expect(parsed.exchange).toBe('NSE');
      expect(parsed.underlying).toBe('RELIANCE');
      expect(parsed.instrument_type).toBe('EQ');
    });

    it('roundtrips future symbol', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NFO',
        underlying: 'NIFTY',
        instrument_type: 'FUT',
        expiry: new Date(2025, 3, 24),
      };
      const symbol = computeCanonicalSymbol(input);
      const parsed = parseCanonicalSymbol(symbol);
      expect(parsed.exchange).toBe('NFO');
      expect(parsed.underlying).toBe('NIFTY');
      expect(parsed.instrument_type).toBe('FUT');
      expect(parsed.expiry).toBe('20250424');
    });

    it('roundtrips option symbol', () => {
      const input: CanonicalSymbolInput = {
        exchange: 'NFO',
        underlying: 'NIFTY',
        instrument_type: 'CE',
        expiry: new Date(2025, 3, 24),
        strike: 22000,
      };
      const symbol = computeCanonicalSymbol(input);
      const parsed = parseCanonicalSymbol(symbol);
      expect(parsed.exchange).toBe('NFO');
      expect(parsed.underlying).toBe('NIFTY');
      expect(parsed.instrument_type).toBe('CE');
      expect(parsed.expiry).toBe('20250424');
      expect(parsed.strike).toBe(22000);
      expect(parsed.option_type).toBe('CE');
    });
  });
});
