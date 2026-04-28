/**
 * @file market-data-stream.service.spec.ts
 * @module market-data
 * @description Unit tests for tick hot path ordering and synthetic pulse behavior.
 * @author BharatERP
 * @created 2026-03-24
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MarketDataStreamService } from './market-data-stream.service';
import { MarketDataProviderResolverService } from './market-data-provider-resolver.service';
import { StockService } from '@features/stock/application/stock.service';
import { RedisService } from '@infra/redis/redis.service';
import { LtpMemoryCacheService } from './ltp-memory-cache.service';
import { MetricsService } from '@infra/observability/metrics.service';
import { MarketDataWsInterestService } from './market-data-ws-interest.service';
import { InstrumentRegistryService } from './instrument-registry.service';

describe('MarketDataStreamService', () => {
  let service: MarketDataStreamService;
  const forwardRealtimeTick = jest.fn().mockResolvedValue(undefined);
  const enqueuePersistMarketData = jest.fn();
  const syntheticInc = jest.fn();

  async function createModule(configGet: jest.Mock) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketDataStreamService,
        {
          provide: MarketDataProviderResolverService,
          useValue: {
            getGlobalProviderName: jest.fn(async () => 'vortex'),
            getResolvedInternalProviderNameForWebsocket: jest.fn(
              async () => 'vortex',
            ),
            resolveForWebsocket: jest.fn(async () => ({
              initializeTicker: () => null,
              getTicker: () => null,
            })),
            getEnabledProviders: jest.fn(() => []),
            getProvider: jest.fn(() => ({
              initializeTicker: () => null,
              getTicker: () => null,
            })),
          },
        },
        {
          provide: StockService,
          useValue: {
            forwardRealtimeTick,
            enqueuePersistMarketData,
            syncInstruments: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: { publish: jest.fn(), get: jest.fn() },
        },
        {
          provide: LtpMemoryCacheService,
          useValue: { set: jest.fn(), getMany: jest.fn(() => ({})) },
        },
        {
          provide: MetricsService,
          useValue: {
            marketDataStreamTicksIngestedTotal: {
              labels: () => ({ inc: jest.fn() }),
            },
            marketDataSyntheticTickTotal: { inc: syntheticInc },
            marketDataStreamTickerConnected: {
              labels: () => ({ set: jest.fn() }),
            },
            providerQueueDepth: { labels: () => ({ set: jest.fn() }) },
            marketDataStreamQueueDroppedTotal: {
              labels: () => ({ inc: jest.fn() }),
            },
            marketDataStreamBatchSeconds: {
              labels: () => ({ observe: jest.fn() }),
            },
            ltpCacheHitTotal: { labels: () => ({ inc: jest.fn() }) },
            ltpCacheMissTotal: { labels: () => ({ inc: jest.fn() }) },
          },
        },
        {
          provide: MarketDataWsInterestService,
          useValue: {
            getInterestedTokens: jest.fn(() => [1]),
            addInterest: jest.fn(),
            removeInterest: jest.fn(),
          },
        },
        {
          provide: InstrumentRegistryService,
          useValue: {
            resolveProviderToken: jest.fn((provider: string, token: number) => token),
            getCanonicalSymbol: jest.fn((uirId: number) => `NSE:MOCK_${uirId}`),
            getProviderToken: jest.fn((uirId: number) => String(uirId)),
            // Default to no routing target so the 500ms batch processor noops in tests that
            // call subscribeToInstruments without overriding this — prevents the interval from
            // throwing repeatedly and hanging the process.
            getBestProviderForUirId: jest.fn(() => undefined),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: configGet },
        },
      ],
    }).compile();
    return module.get(MarketDataStreamService);
  }

  beforeEach(async () => {
    forwardRealtimeTick.mockClear();
    enqueuePersistMarketData.mockClear();
    syntheticInc.mockClear();
    const configGet = jest.fn().mockReturnValue('0');
    service = await createModule(configGet);
  });

  afterEach(async () => {
    // subscribeToInstruments() starts a 500ms batch interval; tear it down so the
    // process can exit cleanly. onModuleDestroy() clears all timers and tickers.
    try { await service.onModuleDestroy(); } catch {}
  });

  it('handleTicks calls forwardRealtimeTick before enqueuePersistMarketData', async () => {
    const order: string[] = [];
    forwardRealtimeTick.mockImplementation(async () => {
      order.push('forward');
    });
    enqueuePersistMarketData.mockImplementation(() => {
      order.push('enqueue');
    });
    await (service as any).handleTicks('vortex', [
      { instrument_token: 42, last_price: 100 },
    ]);
    expect(order).toEqual(['forward', 'enqueue']);
    expect(forwardRealtimeTick).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ instrument_token: 42, last_price: 100 }),
    );
    expect(enqueuePersistMarketData).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ instrument_token: 42 }),
    );
  });

  it('runSyntheticPulse emits synthetic tick when upstream is stale', async () => {
    forwardRealtimeTick.mockClear();
    syntheticInc.mockClear();
    await (service as any).handleTicks('vortex', [
      { instrument_token: 1, last_price: 50 },
    ]);
    forwardRealtimeTick.mockClear();
    (service as any).lastUpstreamAt.set(1, Date.now() - 2000);
    await (service as any).runSyntheticPulse(500);
    expect(forwardRealtimeTick).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ last_price: 50 }),
      { syntheticLast: true },
    );
    expect(syntheticInc).toHaveBeenCalled();
  });

  it('runSyntheticPulse skips when no payload for token', async () => {
    forwardRealtimeTick.mockClear();
    await (service as any).runSyntheticPulse(500);
    expect(forwardRealtimeTick).not.toHaveBeenCalled();
  });

  describe('forced provider routing (Provider:identifier WS prefix)', () => {
    it('subscribeToInstruments stores forcedProvider per UIR', async () => {
      await service.subscribeToInstruments([100, 200], 'ltp', 'cli-1', 'kite');
      const map = (service as any).forcedProviderByUir as Map<number, string>;
      expect(map.get(100)).toBe('kite');
      expect(map.get(200)).toBe('kite');
    });

    it('un-prefixed subscribe leaves forcedProviderByUir untouched', async () => {
      await service.subscribeToInstruments([100], 'ltp', 'cli-1');
      const map = (service as any).forcedProviderByUir as Map<number, string>;
      expect(map.has(100)).toBe(false);
    });

    it('first-writer wins on conflicting pin (warns, keeps original)', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      await service.subscribeToInstruments([100], 'ltp', 'cli-1', 'kite');
      await service.subscribeToInstruments([100], 'ltp', 'cli-2', 'vortex');
      const map = (service as any).forcedProviderByUir as Map<number, string>;
      expect(map.get(100)).toBe('kite');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already pinned to kite'));
      warnSpy.mockRestore();
    });

    it('clears forced pin when last client unsubscribes', async () => {
      await service.subscribeToInstruments([100], 'ltp', 'cli-1', 'kite');
      await service.unsubscribeFromInstruments([100], 'cli-1');
      const map = (service as any).forcedProviderByUir as Map<number, string>;
      expect(map.has(100)).toBe(false);
    });

    it('keeps forced pin while other clients still subscribe', async () => {
      await service.subscribeToInstruments([100], 'ltp', 'cli-1', 'kite');
      await service.subscribeToInstruments([100], 'ltp', 'cli-2', 'kite');
      await service.unsubscribeFromInstruments([100], 'cli-1');
      const map = (service as any).forcedProviderByUir as Map<number, string>;
      expect(map.get(100)).toBe('kite');
    });
  });
});
