/**
 * @file ws-provider-prefix.util.spec.ts
 * @module shared
 * @description Unit tests for parseProviderPrefix — provider-prefixed WS subscription syntax.
 * @author BharatERP
 * @created 2026-04-28
 * @updated 2026-04-28
 */

import { parseProviderPrefix } from './ws-provider-prefix.util';

describe('parseProviderPrefix', () => {
  describe('happy paths', () => {
    it.each([
      ['Falcon:reliance', 'kite', 'reliance'],
      ['falcon:RELIANCE', 'kite', 'RELIANCE'],
      ['Kite:738561', 'kite', '738561'],
      ['Vayu:26000', 'vortex', '26000'],
      ['vortex:NSE_EQ-26000', 'vortex', 'NSE_EQ-26000'],
      ['Massive:AAPL', 'massive', 'AAPL'],
      ['polygon:BTC-USD', 'massive', 'BTC-USD'],
      ['Binance:BTCUSDT', 'binance', 'BTCUSDT'],
      ['BINANCE:btcusdt', 'binance', 'btcusdt'],
    ])('parses %s → provider=%s, identifier=%s', (input, provider, identifier) => {
      const result = parseProviderPrefix(input);
      expect(result).toEqual({ provider, identifier, raw: input.trim() });
    });

    it('splits on FIRST colon only — preserves nested canonical', () => {
      expect(parseProviderPrefix('Falcon:NSE:RELIANCE')).toEqual({
        provider: 'kite',
        identifier: 'NSE:RELIANCE',
        raw: 'Falcon:NSE:RELIANCE',
      });
    });

    it('trims surrounding whitespace from input and identifier', () => {
      expect(parseProviderPrefix('  Vayu: 26000  ')).toEqual({
        provider: 'vortex',
        identifier: '26000',
        raw: 'Vayu: 26000',
      });
    });
  });

  describe('falls through (returns null)', () => {
    it('returns null for non-string inputs', () => {
      expect(parseProviderPrefix(undefined)).toBeNull();
      expect(parseProviderPrefix(null)).toBeNull();
      expect(parseProviderPrefix(26000)).toBeNull();
      expect(parseProviderPrefix({ provider: 'kite' })).toBeNull();
      expect(parseProviderPrefix(['Falcon:reliance'])).toBeNull();
    });

    it('returns null for empty / whitespace-only strings', () => {
      expect(parseProviderPrefix('')).toBeNull();
      expect(parseProviderPrefix('   ')).toBeNull();
    });

    it('returns null when there is no colon', () => {
      expect(parseProviderPrefix('Falcon')).toBeNull();
      expect(parseProviderPrefix('reliance')).toBeNull();
      expect(parseProviderPrefix('26000')).toBeNull();
    });

    it('returns null when prefix is empty (leading colon)', () => {
      expect(parseProviderPrefix(':reliance')).toBeNull();
    });

    it('returns null when identifier is empty (trailing colon)', () => {
      expect(parseProviderPrefix('Falcon:')).toBeNull();
      expect(parseProviderPrefix('Falcon:   ')).toBeNull();
    });

    it('returns null when prefix is not a known provider alias (preserves canonical pass-through)', () => {
      // NSE:RELIANCE is a canonical symbol — must NOT be treated as provider-prefixed.
      expect(parseProviderPrefix('NSE:RELIANCE')).toBeNull();
      expect(parseProviderPrefix('NFO:NIFTY24DECFUT')).toBeNull();
      expect(parseProviderPrefix('MCX:GOLD')).toBeNull();
      expect(parseProviderPrefix('BSE:RELIANCE')).toBeNull();
      expect(parseProviderPrefix('Bloomberg:AAPL')).toBeNull();
      expect(parseProviderPrefix('foo:bar')).toBeNull();
    });
  });
});
