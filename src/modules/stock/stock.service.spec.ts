import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StockService } from './stock.service';
import { Instrument } from '../../entities/instrument.entity';
import { MarketData } from '../../entities/market-data.entity';
import { Subscription } from '../../entities/subscription.entity';
import { KiteConnectService } from '../../services/kite-connect.service';
import { RedisService } from '../../services/redis.service';
import { RequestBatchingService } from '../../services/request-batching.service';
import { MarketDataGateway } from '../../gateways/market-data.gateway';

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
  };

  const mockRequestBatchingService = {
    getQuote: jest.fn(),
    getLTP: jest.fn(),
    getOHLC: jest.fn(),
  };

  const mockMarketDataGateway = {
    broadcastMarketData: jest.fn(),
  };

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
      ],
    }).compile();

    service = module.get<StockService>(StockService);
    instrumentRepository = module.get<Repository<Instrument>>(getRepositoryToken(Instrument));
    marketDataRepository = module.get<Repository<MarketData>>(getRepositoryToken(MarketData));
    subscriptionRepository = module.get<Repository<Subscription>>(getRepositoryToken(Subscription));
    kiteConnectService = module.get<KiteConnectService>(KiteConnectService);
    redisService = module.get<RedisService>(RedisService);
    requestBatchingService = module.get<RequestBatchingService>(RequestBatchingService);
    marketDataGateway = module.get<MarketDataGateway>(MarketDataGateway);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
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

      mockInstrumentRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

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
        { exchange: 'NSE' }
      );
    });
  });

  describe('getQuotes', () => {
    it('should return cached quotes when available', async () => {
      const mockCachedQuotes = {
        '738561': {
          instrument_token: 738561,
          last_price: 2500.50,
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
          last_price: 2500.50,
        },
      };

      mockRedisService.getCachedQuote.mockResolvedValue(null);
      mockRequestBatchingService.getQuote.mockResolvedValue(mockQuotes);

      const result = await service.getQuotes([738561]);

      expect(result).toEqual(mockQuotes);
      expect(mockRequestBatchingService.getQuote).toHaveBeenCalledWith(['738561']);
      expect(mockRedisService.cacheQuote).toHaveBeenCalledWith(['738561'], mockQuotes, 30);
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

      mockInstrumentRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.searchInstruments('RELIANCE', 10);

      expect(result).toEqual(mockInstruments);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'instrument.tradingsymbol LIKE :query',
        { query: '%RELIANCE%' }
      );
    });
  });
});
