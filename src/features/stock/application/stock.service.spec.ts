import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StockService } from '@features/stock/application/stock.service';
import { Instrument } from '@features/market-data/domain/instrument.entity';
import { MarketData } from '@features/market-data/domain/market-data.entity';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { MarketDataProviderResolverService } from '@features/market-data/application/market-data-provider-resolver.service';
import { VortexInstrumentService } from '@features/stock/application/vortex-instrument.service';
import { NativeWsService } from '@features/market-data/application/native-ws.service';
import { LtpMemoryCacheService } from '@features/market-data/application/ltp-memory-cache.service';
import { MetricsService } from '@infra/observability/metrics.service';
import { Subscription } from '@features/market-data/domain/subscription.entity';
import { KiteConnectService } from '@features/kite-connect/application/kite-connect.service';
import { RedisService } from '@infra/redis/redis.service';
import { RequestBatchingService } from '@features/market-data/application/request-batching.service';
import { MarketDataGateway } from '@features/market-data/interface/market-data.gateway';

describe('StockService', () => {
  let service: StockService;
  let instrumentRepository: Repository<Instrument>;
  let marketDataRepository: Repository<MarketData>;
  let subscriptionRepository: Repository<Subscription>;
  let kiteConnectService: KiteConnectService;
  let redisService: RedisService;
  let requestBatchingService: RequestBatchingService;
  let marketDataGateway: MarketDataGateway;

  const mockInstrumentRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockMarketDataRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockSubscriptionRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };

  const mockKiteConnectService = {
    getInstruments: jest.fn(),
    getQuote: jest.fn(),
    getLTP: jest.fn(),
    getOHLC: jest.fn(),
    getHistoricalData: jest.fn(),
  };

  const mockRedisService = {
    getCachedQuote: jest.fn(),
    cacheQuote: jest.fn(),
    cacheMarketData: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
  };

  const mockRequestBatchingService = {
    getQuote: jest.fn(),
    getLTP: jest.fn(),
    getOHLC: jest.fn(),
  };

  const mockMarketDataGateway = {
    broadcastMarketData: jest.fn(),
  };

  const mockProviderResolver = {
    resolveForHttp: jest.fn(async () => ({})),
    getGlobalProviderName: jest.fn(async () => 'vortex'),
    resolveForWebsocket: jest.fn(async () => ({ getTicker: () => ({}) })),
  };

  const mockLtpCache = {
    get: jest.fn(),
    getMany: jest.fn(() => ({})),
    set: jest.fn(),
  };

  const mockMetrics = {
    ltpCacheHitTotal: { labels: () => ({ inc: () => {} }) },
    providerQueueDepth: { labels: () => ({ set: () => {} }) },
  } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StockService,
        {
          provide: getRepositoryToken(Instrument),
          useValue: mockInstrumentRepository,
        },
        {
          provide: getRepositoryToken(MarketData),
          useValue: mockMarketDataRepository,
        },
        {
          provide: getRepositoryToken(Subscription),
          useValue: mockSubscriptionRepository,
        },
        {
          provide: getRepositoryToken(InstrumentMapping),
          useValue: { findOne: jest.fn(), save: jest.fn(), create: jest.fn((v) => v) },
        },
        {
          provide: KiteConnectService,
          useValue: mockKiteConnectService,
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
        {
          provide: RequestBatchingService,
          useValue: mockRequestBatchingService,
        },
        {
          provide: MarketDataGateway,
          useValue: mockMarketDataGateway,
        },
        { provide: MarketDataProviderResolverService, useValue: mockProviderResolver },
        { provide: VortexInstrumentService, useValue: {} },
        { provide: NativeWsService, useValue: { broadcastMarketData: jest.fn() } },
        { provide: LtpMemoryCacheService, useValue: mockLtpCache },
        { provide: MetricsService, useValue: mockMetrics },
      ],
    }).compile();

    service = module.get<StockService>(StockService);
    instrumentRepository = module.get<Repository<Instrument>>(
      getRepositoryToken(Instrument),
    );
    marketDataRepository = module.get<Repository<MarketData>>(
      getRepositoryToken(MarketData),
    );
    subscriptionRepository = module.get<Repository<Subscription>>(
      getRepositoryToken(Subscription),
    );
    kiteConnectService = module.get<KiteConnectService>(KiteConnectService);
    redisService = module.get<RedisService>(RedisService);
    requestBatchingService = module.get<RequestBatchingService>(
      RequestBatchingService,
    );
    marketDataGateway = module.get<MarketDataGateway>(MarketDataGateway);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('storeMarketData forwards realtime then enqueues async persistence', async () => {
    const forwardSpy = jest
      .spyOn(service, 'forwardRealtimeTick')
      .mockResolvedValue(undefined);
    const enqueueSpy = jest
      .spyOn(service, 'enqueuePersistMarketData')
      .mockImplementation(() => {});
    mockMarketDataRepository.create.mockReturnValue({} as any);
    mockMarketDataRepository.save.mockResolvedValue({} as any);
    await service.storeMarketData(26000, {
      last_price: 100,
      ohlc: { open: 1, high: 2, low: 0.5, close: 1.5 },
      volume: 10,
    });
    expect(forwardSpy).toHaveBeenCalledWith(
      26000,
      expect.objectContaining({ last_price: 100 }),
    );
    expect(enqueueSpy).toHaveBeenCalledWith(
      26000,
      expect.objectContaining({ last_price: 100 }),
    );
    forwardSpy.mockRestore();
    enqueueSpy.mockRestore();
  });

  describe('getInstruments', () => {
    it('should return instruments with filters', async () => {
      const mockInstruments = [
        {
          instrument_token: 738561,
          tradingsymbol: 'RELIANCE',
          name: 'Reliance Industries Limited',
          exchange: 'NSE',
        },
      ];

      const mockQueryBuilder = {
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(1),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockInstruments),
      };

      mockInstrumentRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

      const result = await service.getInstruments({
        exchange: 'NSE',
        limit: 10,
        offset: 0,
      });

      expect(result).toEqual({
        instruments: mockInstruments,
        total: 1,
      });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'instrument.exchange = :exchange',
        { exchange: 'NSE' },
      );
    });
  });

  describe('getQuotes', () => {
    it('should return cached quotes when available', async () => {
      const mockCachedQuotes = {
        '738561': {
          instrument_token: 738561,
          last_price: 2500.5,
        },
      };

      mockRedisService.getCachedQuote.mockResolvedValue(mockCachedQuotes);

      const result = await service.getQuotes([738561]);

      expect(result).toEqual(mockCachedQuotes);
      expect(mockRedisService.getCachedQuote).toHaveBeenCalledWith(['738561']);
    });

    it('should fetch quotes from API when not cached', async () => {
      const mockQuotes = {
        '738561': {
          instrument_token: 738561,
          last_price: 2500.5,
        },
      };

      mockRedisService.getCachedQuote.mockResolvedValue(null);
      mockRequestBatchingService.getQuote.mockResolvedValue(mockQuotes);

      const result = await service.getQuotes([738561]);

      expect(result).toEqual(mockQuotes);
      expect(mockRequestBatchingService.getQuote).toHaveBeenCalledWith([
        '738561',
      ], expect.anything());
      expect(mockRedisService.cacheQuote).toHaveBeenCalledWith(
        ['738561'],
        mockQuotes,
        30,
      );
    });
  });

  describe('searchInstruments', () => {
    it('should search instruments by trading symbol or name', async () => {
      const mockInstruments = [
        {
          instrument_token: 738561,
          tradingsymbol: 'RELIANCE',
          name: 'Reliance Industries Limited',
        },
      ];

      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockInstruments),
      };

      mockInstrumentRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

      const result = await service.searchInstruments('RELIANCE', 10);

      expect(result).toEqual(mockInstruments);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'UPPER(instrument.tradingsymbol) LIKE :query',
        { query: '%RELIANCE%' },
      );
    });
  });
});
