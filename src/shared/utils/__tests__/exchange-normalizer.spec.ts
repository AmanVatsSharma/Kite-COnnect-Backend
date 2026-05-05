/**
 * @file exchange-normalizer.spec.ts
 * @module shared
 * @description Unit tests for exchange-normalizer utility.
 * @author BharatERP
 * @created 2026-04-17
 * @updated 2026-04-17
 */
import {
  normalizeExchange,
  denormalizeExchange,
  KITE_TO_CANONICAL,
  VORTEX_TO_CANONICAL,
} from '../exchange-normalizer';

describe('exchange-normalizer', () => {
  describe('KITE_TO_CANONICAL map', () => {
    it('contains all expected Kite exchanges', () => {
      expect(KITE_TO_CANONICAL).toEqual({
        NSE: 'NSE',
        BSE: 'BSE',
        NFO: 'NFO',
        CDS: 'CDS',
        MCX: 'MCX',
        BCD: 'BCD',
        BFO: 'BFO',
      });
    });
  });

  describe('VORTEX_TO_CANONICAL map', () => {
    it('contains all expected Vortex exchanges', () => {
      expect(VORTEX_TO_CANONICAL).toEqual({
        NSE_EQ: 'NSE',
        NSE_FO: 'NFO',
        NSE_CUR: 'CDS',
        MCX_FO: 'MCX',
      });
    });
  });

  describe('normalizeExchange', () => {
    it('normalizes Kite exchange codes to canonical', () => {
      expect(normalizeExchange('NSE', 'kite')).toBe('NSE');
      expect(normalizeExchange('NFO', 'kite')).toBe('NFO');
      expect(normalizeExchange('MCX', 'kite')).toBe('MCX');
      expect(normalizeExchange('BSE', 'kite')).toBe('BSE');
      expect(normalizeExchange('CDS', 'kite')).toBe('CDS');
      expect(normalizeExchange('BCD', 'kite')).toBe('BCD');
      expect(normalizeExchange('BFO', 'kite')).toBe('BFO');
    });

    it('normalizes Vortex exchange codes to canonical', () => {
      expect(normalizeExchange('NSE_EQ', 'vortex')).toBe('NSE');
      expect(normalizeExchange('NSE_FO', 'vortex')).toBe('NFO');
      expect(normalizeExchange('NSE_CUR', 'vortex')).toBe('CDS');
      expect(normalizeExchange('MCX_FO', 'vortex')).toBe('MCX');
    });

    it('returns unknown exchange codes unchanged for Kite', () => {
      expect(normalizeExchange('UNKNOWN_EXCHANGE', 'kite')).toBe(
        'UNKNOWN_EXCHANGE',
      );
    });

    it('returns unknown exchange codes unchanged for Vortex', () => {
      expect(normalizeExchange('BSE', 'vortex')).toBe('BSE');
      expect(normalizeExchange('UNKNOWN', 'vortex')).toBe('UNKNOWN');
    });
  });

  describe('denormalizeExchange', () => {
    it('denormalizes canonical to Kite exchange codes', () => {
      expect(denormalizeExchange('NSE', 'kite')).toBe('NSE');
      expect(denormalizeExchange('NFO', 'kite')).toBe('NFO');
      expect(denormalizeExchange('MCX', 'kite')).toBe('MCX');
      expect(denormalizeExchange('BSE', 'kite')).toBe('BSE');
      expect(denormalizeExchange('CDS', 'kite')).toBe('CDS');
      expect(denormalizeExchange('BCD', 'kite')).toBe('BCD');
      expect(denormalizeExchange('BFO', 'kite')).toBe('BFO');
    });

    it('denormalizes canonical to Vortex exchange codes', () => {
      expect(denormalizeExchange('NSE', 'vortex')).toBe('NSE_EQ');
      expect(denormalizeExchange('NFO', 'vortex')).toBe('NSE_FO');
      expect(denormalizeExchange('CDS', 'vortex')).toBe('NSE_CUR');
      expect(denormalizeExchange('MCX', 'vortex')).toBe('MCX_FO');
    });

    it('returns unknown canonical codes unchanged for Kite', () => {
      expect(denormalizeExchange('UNKNOWN', 'kite')).toBe('UNKNOWN');
    });

    it('returns unmapped canonical codes unchanged for Vortex', () => {
      expect(denormalizeExchange('BSE', 'vortex')).toBe('BSE');
      expect(denormalizeExchange('BCD', 'vortex')).toBe('BCD');
      expect(denormalizeExchange('BFO', 'vortex')).toBe('BFO');
    });
  });
});
