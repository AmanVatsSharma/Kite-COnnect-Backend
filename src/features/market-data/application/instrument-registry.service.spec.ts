/**
 * @file instrument-registry.service.spec.ts
 * @module market-data
 * @description Unit tests for InstrumentRegistryService, focusing on derivative symbol resolution.
 * @author AmanVatsSharma
 * @created 2026-05-26
 * @updated 2026-05-26
 */

import { Test, TestingModule } from '@nestjs/testing';
import { InstrumentRegistryService } from './instrument-registry.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UniversalInstrument } from '../domain/universal-instrument.entity';
import { InstrumentMapping } from '../domain/instrument-mapping.entity';

describe('InstrumentRegistryService', () => {
  let service: InstrumentRegistryService;
  let mockUirRepo: any;
  let mockMappingRepo: any;

  const mockInstruments = [
    {
      id: '1',
      canonical_symbol: 'MCX:GOLD26JUN26FUT',
      exchange: 'MCX',
      underlying: 'GOLD',
      instrument_type: 'FUT',
      expiry: new Date('2026-06-26'),
      isin: null,
    },
    {
      id: '2',
      canonical_symbol: 'MCX:GOLD30JUL26FUT',
      exchange: 'MCX',
      underlying: 'GOLD',
      instrument_type: 'FUT',
      expiry: new Date('2026-07-30'),
      isin: null,
    },
    {
      id: '3',
      canonical_symbol: 'NFO:NIFTY26JUN26FUT',
      exchange: 'NFO',
      underlying: 'NIFTY',
      instrument_type: 'FUT',
      expiry: new Date('2026-06-26'),
      isin: null,
    },
    {
      id: '4',
      canonical_symbol: 'NFO:BANKNIFTY26JUN26FUT',
      exchange: 'NFO',
      underlying: 'BANKNIFTY',
      instrument_type: 'FUT',
      expiry: new Date('2026-06-26'),
      isin: null,
    },
    {
      id: '5',
      canonical_symbol: 'NSE:RELIANCE',
      exchange: 'NSE',
      underlying: 'RELIANCE',
      instrument_type: 'EQ',
      expiry: null,
      isin: null,
    },
    {
      id: '6',
      canonical_symbol: 'MCX:GOLD26JUN26CE61000',
      exchange: 'MCX',
      underlying: 'GOLD',
      instrument_type: 'CE',
      expiry: new Date('2026-06-26'),
      strike: 61000,
      isin: null,
    },
  ];

  beforeEach(async () => {
    mockUirRepo = {
      find: jest.fn().mockResolvedValue(mockInstruments),
    };
    mockMappingRepo = {
      find: jest.fn().mockResolvedValue([]),
    };

    service = new InstrumentRegistryService(mockUirRepo, mockMappingRepo);
    await service.onModuleInit();
  });

  describe('resolveDerivativeSymbol', () => {
    it('should resolve MCX:GOLD:FUT to nearest expiry', () => {
      const result = service.resolveDerivativeSymbol('MCX:GOLD:FUT');
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.canonical).toBe('MCX:GOLD26JUN26FUT');
        expect(result.uirId).toBe(1);
        expect(result.expiry).toEqual(new Date('2026-06-26'));
      }
    });

    it('should resolve NFO:NIFTY:FUT to NFO contract', () => {
      const result = service.resolveDerivativeSymbol('NFO:NIFTY:FUT');
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.canonical).toBe('NFO:NIFTY26JUN26FUT');
        expect(result.uirId).toBe(3);
      }
    });

    it('should resolve GOLD:FUT (no exchange) to MCX first via preference', () => {
      const result = service.resolveDerivativeSymbol('GOLD:FUT');
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.canonical).toBe('MCX:GOLD26JUN26FUT');
      }
    });

    it('should return not_found for invalid underlying', () => {
      const result = service.resolveDerivativeSymbol('MCX:INVALID:FUT');
      expect(result.status).toBe('not_found');
      if (result.status === 'not_found') {
        expect(result.reason).toContain('not found');
      }
    });

    it('should return not_found for wrong exchange', () => {
      const result = service.resolveDerivativeSymbol('NSE:GOLD:FUT');
      expect(result.status).toBe('not_found');
    });

    it('should resolve NFO:BANKNIFTY:FUT correctly', () => {
      const result = service.resolveDerivativeSymbol('NFO:BANKNIFTY:FUT');
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.canonical).toBe('NFO:BANKNIFTY26JUN26FUT');
      }
    });

    it('should handle CE type', () => {
      const result = service.resolveDerivativeSymbol('MCX:GOLD:CE');
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.canonical).toBe('MCX:GOLD26JUN26CE61000');
        expect(result.instrument_type).toBe('CE');
      }
    });

    it('should return not_found for non-derivative type', () => {
      const result = service.resolveDerivativeSymbol('MCX:GOLD:EQ');
      expect(result.status).toBe('not_found');
    });

    it('should return not_found for invalid format', () => {
      const result = service.resolveDerivativeSymbol('GOLD');
      expect(result.status).toBe('not_found');
      if (result.status === 'not_found') {
        expect(result.reason).toContain('Invalid derivative symbol format');
      }
    });
  });

  describe('resolveFlexSymbol (existing behavior)', () => {
    it('should resolve plain RELIANCE to NSE:RELIANCE', () => {
      const result = service.resolveFlexSymbol('RELIANCE');
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.canonical).toBe('NSE:RELIANCE');
        expect(result.uirId).toBe(5);
      }
    });

    it('should return not_found for unknown symbol', () => {
      const result = service.resolveFlexSymbol('UNKNOWN');
      expect(result.status).toBe('not_found');
    });
  });
});