/**
 * @file falcon-instrument.service.spec.ts
 * @module falcon
 * @description Unit tests for FalconInstrumentService sync preflight and Kite delegation.
 * @author BharatERP
 * @created 2026-03-28
 */
import { FalconInstrumentService } from './falcon-instrument.service';
import { FalconInstrument } from '@features/falcon/domain/falcon-instrument.entity';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { KiteProviderService } from '@features/kite-connect/infra/kite-provider.service';
import { FalconProviderAdapter } from '@features/falcon/infra/falcon-provider.adapter';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Repository } from 'typeorm';

describe('FalconInstrumentService', () => {
  let service: FalconInstrumentService;
  let falconRepo: {
    find: jest.Mock;
    upsert: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mappingRepo: { upsert: jest.Mock };
  let kite: jest.Mocked<
    Pick<
      KiteProviderService,
      'refreshSession' | 'isClientInitialized' | 'getInstruments'
    >
  >;

  beforeEach(() => {
    falconRepo = {
      find: jest.fn(),
      upsert: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((x) => x as FalconInstrument),
      createQueryBuilder: jest.fn(),
    };
    mappingRepo = {
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    kite = {
      refreshSession: jest.fn().mockResolvedValue(undefined),
      isClientInitialized: jest.fn(),
      getInstruments: jest.fn(),
    };
    const config = {
      get: jest.fn((k: string, d?: string) => d ?? ''),
    } as unknown as ConfigService;
    const schedulerRegistry = {
      deleteCronJob: jest.fn(),
      addCronJob: jest.fn(),
    } as unknown as SchedulerRegistry;
    const falconAdapter = {} as FalconProviderAdapter;
    const redisService = { get: jest.fn(), set: jest.fn(), del: jest.fn() } as any;
    service = new FalconInstrumentService(
      falconRepo as unknown as Repository<FalconInstrument>,
      mappingRepo as unknown as Repository<InstrumentMapping>,
      kite as unknown as KiteProviderService,
      falconAdapter,
      config,
      schedulerRegistry,
      redisService,
    );
  });

  it('returns skipped when Kite client is not initialized after preflight', async () => {
    kite.isClientInitialized.mockReturnValue(false);
    const res = await service.syncFalconInstruments();
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toBe('kite_client_unavailable');
    expect(kite.getInstruments).not.toHaveBeenCalled();
  });

  it('returns skipped when Kite returns no rows', async () => {
    kite.isClientInitialized.mockReturnValue(true);
    kite.getInstruments.mockResolvedValue([]);
    const res = await service.syncFalconInstruments();
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toBe('no_rows_from_kite');
  });

  it('upserts instruments when Kite returns rows', async () => {
    kite.isClientInitialized.mockReturnValue(true);
    kite.getInstruments.mockResolvedValue([
      {
        instrument_token: 1,
        exchange_token: 1,
        tradingsymbol: 'TEST',
        name: 'Test',
        last_price: 1,
        expiry: '',
        strike: 0,
        tick_size: 0.05,
        lot_size: 1,
        instrument_type: 'EQ',
        segment: 'NSE',
        exchange: 'NSE',
      },
    ]);
    falconRepo.find.mockResolvedValue([]);
    falconRepo.createQueryBuilder = jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    });

    const res = await service.syncFalconInstruments(undefined, undefined, undefined, {
      reconcile: false,
    });
    expect(res.skipped).toBeUndefined();
    expect(falconRepo.upsert).toHaveBeenCalled();
    expect(mappingRepo.upsert).toHaveBeenCalled();
    expect(res.synced).toBeGreaterThanOrEqual(0);
    expect(res.updated).toBeGreaterThanOrEqual(0);
  });
});
