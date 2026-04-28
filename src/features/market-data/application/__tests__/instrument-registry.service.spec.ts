/**
 * @file instrument-registry.service.spec.ts
 * @module market-data
 * @description Unit tests for InstrumentRegistryService in-memory maps.
 * @author BharatERP
 * @created 2026-04-17
 * @updated 2026-04-28
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InstrumentRegistryService } from '../instrument-registry.service';
import { UniversalInstrument } from '../../domain/universal-instrument.entity';
import { InstrumentMapping } from '../../domain/instrument-mapping.entity';

const mockUirRows = [
  { id: '42', canonical_symbol: 'NSE:RELIANCE', exchange: 'NSE', is_active: true },
  { id: '108', canonical_symbol: 'NFO:NIFTY:FUT:20250424', exchange: 'NFO', is_active: true },
];

const mockMappings = [
  { provider: 'kite', provider_token: '256265', instrument_token: null, uir_id: 42 },
  { provider: 'vortex', provider_token: 'NSE_EQ-22', instrument_token: 22, uir_id: 42 },
  { provider: 'kite', provider_token: '738561', instrument_token: null, uir_id: 108 },
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
      expect(service.getStats()).toMatchObject({ instruments: 2, mappings: 4 });

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
      expect(service.getStats()).toMatchObject({ instruments: 1, mappings: 1 });
    });
  });

  describe('getStats', () => {
    it('should return zero counts before warmMaps', () => {
      expect(service.getStats()).toMatchObject({ instruments: 0, mappings: 0 });
    });

    it('should return correct counts after warmMaps', async () => {
      await service.warmMaps();
      // 3 primary mapping entries + 1 secondary numeric index for the Vortex mapping = 4
      expect(service.getStats()).toMatchObject({ instruments: 2, mappings: 4 });
    });
  });

  describe('Vortex secondary numeric index', () => {
    it('resolves by full exchange-token key "NSE_EQ-22"', async () => {
      await service.warmMaps();
      expect(service.resolveProviderToken('vortex', 'NSE_EQ-22')).toBe(42);
    });

    it('resolves by numeric token 22 via secondary index', async () => {
      await service.warmMaps();
      expect(service.resolveProviderToken('vortex', 22)).toBe(42);
    });

    it('both lookups return the same UIR ID', async () => {
      await service.warmMaps();
      const byFull = service.resolveProviderToken('vortex', 'NSE_EQ-22');
      const byNumeric = service.resolveProviderToken('vortex', 22);
      expect(byFull).toBe(byNumeric);
    });

    it('collision: first uirId wins when two Vortex rows share an instrument_token', async () => {
      mappingRepoFind.mockResolvedValue([
        { provider: 'vortex', provider_token: 'NSE_EQ-99', instrument_token: 99, uir_id: 10 },
        { provider: 'vortex', provider_token: 'NSE_FO-99', instrument_token: 99, uir_id: 20 },
      ]);
      await service.warmMaps();
      // First entry (uirId=10) wins for the numeric secondary key
      expect(service.resolveProviderToken('vortex', 99)).toBe(10);
      // Primary keys for both are still intact
      expect(service.resolveProviderToken('vortex', 'NSE_EQ-99')).toBe(10);
      expect(service.resolveProviderToken('vortex', 'NSE_FO-99')).toBe(20);
    });

    it('Kite mapping with no instrument_token does not add secondary index', async () => {
      await service.warmMaps();
      // kite mapping has instrument_token: null, so no numeric secondary key
      expect(service.resolveProviderToken('kite', 256265)).toBe(42); // numeric string coercion still works for kite
      expect(service.resolveProviderToken('kite', null as any)).toBeUndefined();
    });
  });

  describe('getBestProviderForUirId', () => {
    it('NSE instrument with kite token → kite (Tier 1 exchange match)', async () => {
      await service.warmMaps();
      expect(service.getBestProviderForUirId(42)).toBe('kite');
    });

    it('NSE instrument with only vortex token → vortex (Tier 2 Indian fallback)', async () => {
      mappingRepoFind.mockResolvedValue([
        { provider: 'vortex', provider_token: 'NSE_EQ-22', uir_id: 42 },
      ]);
      await service.warmMaps();
      expect(service.getBestProviderForUirId(42)).toBe('vortex');
    });

    it('US instrument with massive token → massive (Tier 1 exchange match)', async () => {
      uirRepoFind.mockResolvedValue([
        { id: '200', canonical_symbol: 'US:AAPL', exchange: 'US', is_active: true },
      ]);
      mappingRepoFind.mockResolvedValue([
        { provider: 'massive', provider_token: 'AAPL', uir_id: 200 },
      ]);
      await service.warmMaps();
      expect(service.getBestProviderForUirId(200)).toBe('massive');
    });

    it('UIR ID with no tokens → undefined (Tier 3)', async () => {
      mappingRepoFind.mockResolvedValue([]);
      await service.warmMaps();
      expect(service.getBestProviderForUirId(42)).toBeUndefined();
    });

    it('unknown UIR ID → undefined', async () => {
      await service.warmMaps();
      expect(service.getBestProviderForUirId(9999)).toBeUndefined();
    });
  });

  describe('resolveProviderScopedSymbol', () => {
    // Custom fixture: include underlying + instrument_type so the underlying-fallback path is exercised.
    const scopedUirRows = [
      {
        id: '42',
        canonical_symbol: 'NSE:RELIANCE',
        exchange: 'NSE',
        underlying: 'RELIANCE',
        instrument_type: 'EQ',
        is_active: true,
      },
      {
        id: '43',
        canonical_symbol: 'BSE:RELIANCE',
        exchange: 'BSE',
        underlying: 'RELIANCE',
        instrument_type: 'EQ',
        is_active: true,
      },
      {
        id: '200',
        canonical_symbol: 'BINANCE:BTCUSDT',
        exchange: 'BINANCE',
        underlying: 'BTCUSDT',
        instrument_type: 'EQ',
        is_active: true,
      },
      {
        id: '300',
        canonical_symbol: 'NFO:NIFTY:FUT:20250424',
        exchange: 'NFO',
        underlying: 'NIFTY',
        instrument_type: 'FUT',
        is_active: true,
      },
    ];
    const scopedMappings = [
      { provider: 'kite',    provider_token: '256265',     instrument_token: null, uir_id: 42 },
      { provider: 'vortex',  provider_token: 'NSE_EQ-22',  instrument_token: 22,   uir_id: 42 },
      { provider: 'kite',    provider_token: '128083202',  instrument_token: null, uir_id: 43 },
      { provider: 'binance', provider_token: 'BTCUSDT',    instrument_token: null, uir_id: 200 },
      { provider: 'kite',    provider_token: '12345',      instrument_token: null, uir_id: 300 },
    ];

    beforeEach(async () => {
      uirRepoFind.mockResolvedValue(scopedUirRows);
      mappingRepoFind.mockResolvedValue(scopedMappings);
      await service.warmMaps();
    });

    it('numeric token resolves within provider scope (kite)', () => {
      const r = service.resolveProviderScopedSymbol('kite', '256265');
      expect(r).toMatchObject({ status: 'resolved', uirId: 42, canonical: 'NSE:RELIANCE', providerToken: '256265' });
    });

    it('numeric Vortex token resolves via secondary index', () => {
      const r = service.resolveProviderScopedSymbol('vortex', '22');
      expect(r).toMatchObject({ status: 'resolved', uirId: 42, canonical: 'NSE:RELIANCE', providerToken: 'NSE_EQ-22' });
    });

    it('Vortex EXCHANGE-TOKEN pair form resolves', () => {
      const r = service.resolveProviderScopedSymbol('vortex', 'NSE_EQ-22');
      expect(r).toMatchObject({ status: 'resolved', uirId: 42, providerToken: 'NSE_EQ-22' });
    });

    it('Vortex pair form is case-insensitive', () => {
      const r = service.resolveProviderScopedSymbol('vortex', 'nse_eq-22');
      expect(r).toMatchObject({ status: 'resolved', uirId: 42 });
    });

    it('exact canonical (NSE:RELIANCE) resolves only when provider has a mapping', () => {
      const kite = service.resolveProviderScopedSymbol('kite', 'NSE:RELIANCE');
      expect(kite.status).toBe('resolved');
      const massive = service.resolveProviderScopedSymbol('massive', 'NSE:RELIANCE');
      expect(massive.status).toBe('not_found');
    });

    it('underlying name (case-insensitive) — single EQ entry resolves directly', () => {
      // Kite has a token only for NSE:RELIANCE, not BSE — so underlying RELIANCE has only 1 in-provider entry.
      const r = service.resolveProviderScopedSymbol('kite', 'reliance');
      expect(r).toMatchObject({ status: 'resolved', uirId: 42, canonical: 'NSE:RELIANCE' });
    });

    it('underlying with multiple EQ entries (NSE+BSE) prefers NSE within the provider', () => {
      // Add a second kite mapping so RELIANCE has both NSE+BSE tokens in kite.
      mappingRepoFind.mockResolvedValue([
        ...scopedMappings,
        { provider: 'kite', provider_token: '128083203', instrument_token: null, uir_id: 43 },
      ]);
      return service.refresh().then(() => {
        const r = service.resolveProviderScopedSymbol('kite', 'RELIANCE');
        expect(r).toMatchObject({ status: 'resolved', uirId: 42, canonical: 'NSE:RELIANCE' });
      });
    });

    it('Binance underlying resolves to BINANCE canonical', () => {
      const r = service.resolveProviderScopedSymbol('binance', 'btcusdt');
      expect(r).toMatchObject({ status: 'resolved', uirId: 200, canonical: 'BINANCE:BTCUSDT', providerToken: 'BTCUSDT' });
    });

    it('underlying not in this provider catalog → not_found', () => {
      const r = service.resolveProviderScopedSymbol('vortex', 'BTCUSDT');
      expect(r.status).toBe('not_found');
    });

    it('FUT-only underlying does not auto-resolve (ambiguous)', () => {
      const r = service.resolveProviderScopedSymbol('kite', 'NIFTY');
      expect(r.status).toBe('ambiguous');
    });

    it('unknown identifier → not_found', () => {
      const r = service.resolveProviderScopedSymbol('kite', 'NOSUCHSYMBOL');
      expect(r.status).toBe('not_found');
    });

    it('empty / non-string identifier → not_found', () => {
      expect(service.resolveProviderScopedSymbol('kite', '').status).toBe('not_found');
      expect(service.resolveProviderScopedSymbol('kite', undefined as any).status).toBe('not_found');
    });
  });
});
