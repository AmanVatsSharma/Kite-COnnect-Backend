/**
 * @file instrument-registry.service.spec.ts
 * @module market-data
 * @description Unit tests for InstrumentRegistryService in-memory maps.
 * @author BharatERP
 * @created 2026-04-17
 * @updated 2026-04-17
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InstrumentRegistryService } from '../instrument-registry.service';
import { UniversalInstrument } from '../../domain/universal-instrument.entity';
import { InstrumentMapping } from '../../domain/instrument-mapping.entity';

const mockUirRows = [
  { id: '42', canonical_symbol: 'NSE:RELIANCE', is_active: true },
  { id: '108', canonical_symbol: 'NFO:NIFTY:FUT:20250424', is_active: true },
];

const mockMappings = [
  { provider: 'kite', provider_token: '256265', uir_id: 42 },
  { provider: 'vortex', provider_token: 'NSE_EQ-22', uir_id: 42 },
  { provider: 'kite', provider_token: '738561', uir_id: 108 },
];

describe('InstrumentRegistryService', () => {
  let service: InstrumentRegistryService;
  let uirRepoFind: jest.Mock;
  let mappingRepoFind: jest.Mock;

  beforeEach(async () => {
    uirRepoFind = jest.fn().mockResolvedValue(mockUirRows);
    mappingRepoFind = jest.fn().mockResolvedValue(mockMappings);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InstrumentRegistryService,
        {
          provide: getRepositoryToken(UniversalInstrument),
          useValue: { find: uirRepoFind },
        },
        {
          provide: getRepositoryToken(InstrumentMapping),
          useValue: { find: mappingRepoFind },
        },
      ],
    }).compile();

    service = module.get<InstrumentRegistryService>(
      InstrumentRegistryService,
    );
  });

  describe('warmMaps', () => {
    it('should populate all four maps correctly', async () => {
      await service.warmMaps();

      // uirIdToCanonical
      expect(service.getCanonicalSymbol(42)).toBe('NSE:RELIANCE');
      expect(service.getCanonicalSymbol(108)).toBe('NFO:NIFTY:FUT:20250424');

      // canonicalToUirId
      expect(service.resolveCanonicalSymbol('NSE:RELIANCE')).toBe(42);
      expect(service.resolveCanonicalSymbol('NFO:NIFTY:FUT:20250424')).toBe(108);

      // providerTokenToUirId
      expect(service.resolveProviderToken('kite', '256265')).toBe(42);
      expect(service.resolveProviderToken('vortex', 'NSE_EQ-22')).toBe(42);
      expect(service.resolveProviderToken('kite', '738561')).toBe(108);

      // uirIdToProviderTokens
      expect(service.getProviderToken(42, 'kite')).toBe('256265');
      expect(service.getProviderToken(42, 'vortex')).toBe('NSE_EQ-22');
      expect(service.getProviderToken(108, 'kite')).toBe('738561');
    });

    it('should query repos with correct filters', async () => {
      await service.warmMaps();

      expect(uirRepoFind).toHaveBeenCalledWith({
        where: { is_active: true },
      });
      expect(mappingRepoFind).toHaveBeenCalledWith({
        where: { uir_id: expect.anything() },
      });
    });
  });

  describe('resolveProviderToken', () => {
    it('should return UIR ID for known provider token', async () => {
      await service.warmMaps();
      expect(service.resolveProviderToken('kite', '256265')).toBe(42);
    });

    it('should accept numeric provider tokens', async () => {
      await service.warmMaps();
      expect(service.resolveProviderToken('kite', 256265)).toBe(42);
    });

    it('should return undefined for unmapped provider token', async () => {
      await service.warmMaps();
      expect(service.resolveProviderToken('kite', '999999')).toBeUndefined();
    });

    it('should return undefined for unknown provider', async () => {
      await service.warmMaps();
      expect(service.resolveProviderToken('unknown', '256265')).toBeUndefined();
    });
  });

  describe('getCanonicalSymbol', () => {
    it('should return canonical symbol for known UIR ID', async () => {
      await service.warmMaps();
      expect(service.getCanonicalSymbol(42)).toBe('NSE:RELIANCE');
    });

    it('should return undefined for unknown UIR ID', async () => {
      await service.warmMaps();
      expect(service.getCanonicalSymbol(9999)).toBeUndefined();
    });
  });

  describe('resolveCanonicalSymbol', () => {
    it('should return UIR ID for known canonical symbol', async () => {
      await service.warmMaps();
      expect(service.resolveCanonicalSymbol('NSE:RELIANCE')).toBe(42);
    });

    it('should return undefined for unknown canonical symbol', async () => {
      await service.warmMaps();
      expect(service.resolveCanonicalSymbol('BSE:UNKNOWN')).toBeUndefined();
    });
  });

  describe('getProviderToken', () => {
    it('should return provider token for known UIR ID and provider', async () => {
      await service.warmMaps();
      expect(service.getProviderToken(42, 'kite')).toBe('256265');
    });

    it('should return undefined for UIR ID with no mapping for given provider', async () => {
      await service.warmMaps();
      expect(service.getProviderToken(108, 'vortex')).toBeUndefined();
    });

    it('should return undefined for unknown UIR ID', async () => {
      await service.warmMaps();
      expect(service.getProviderToken(9999, 'kite')).toBeUndefined();
    });
  });

  describe('refresh', () => {
    it('should clear and repopulate all maps', async () => {
      await service.warmMaps();
      expect(service.getStats()).toEqual({ instruments: 2, mappings: 3 });

      // Return different data on refresh
      uirRepoFind.mockResolvedValue([
        { id: '1', canonical_symbol: 'NSE:TCS', is_active: true },
      ]);
      mappingRepoFind.mockResolvedValue([
        { provider: 'kite', provider_token: '100', uir_id: 1 },
      ]);

      await service.refresh();

      // Old data should be gone
      expect(service.getCanonicalSymbol(42)).toBeUndefined();
      expect(service.resolveProviderToken('kite', '256265')).toBeUndefined();

      // New data should be present
      expect(service.getCanonicalSymbol(1)).toBe('NSE:TCS');
      expect(service.resolveProviderToken('kite', '100')).toBe(1);
      expect(service.getStats()).toEqual({ instruments: 1, mappings: 1 });
    });
  });

  describe('getStats', () => {
    it('should return zero counts before warmMaps', () => {
      expect(service.getStats()).toEqual({ instruments: 0, mappings: 0 });
    });

    it('should return correct counts after warmMaps', async () => {
      await service.warmMaps();
      expect(service.getStats()).toEqual({ instruments: 2, mappings: 3 });
    });
  });
});
