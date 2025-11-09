import { Test, TestingModule } from '@nestjs/testing';
import { FalconController } from './controllers/falcon.controller';
import { FalconInstrumentService } from './services/falcon-instrument.service';
import { FalconProviderAdapter } from './services/falcon-provider.adapter';
import { RedisService } from '../../services/redis.service';

describe('FalconController', () => {
  let controller: FalconController;
  const mockInstruments: Partial<FalconInstrumentService> = {
    getFalconInstruments: jest.fn().mockResolvedValue({ instruments: [], total: 0 }),
    getFalconInstrumentStats: jest.fn().mockResolvedValue({ total: 0, by_exchange: {}, by_type: {}, active: 0, inactive: 0 }),
    getFalconInstrumentByToken: jest.fn().mockResolvedValue(null),
    getFalconInstrumentsBatch: jest.fn().mockResolvedValue({}),
    syncFalconInstruments: jest.fn().mockResolvedValue({ synced: 0, updated: 0 }),
    validateFalconInstruments: jest.fn().mockResolvedValue({ tested: 0, invalid_instruments: [] }),
  };
  const mockAdapter: Partial<FalconProviderAdapter> = {
    getLTP: jest.fn().mockResolvedValue({}),
  };
  const mockRedis: Partial<RedisService> = {
    set: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FalconController],
      providers: [
        { provide: FalconInstrumentService, useValue: mockInstruments },
        { provide: FalconProviderAdapter, useValue: mockAdapter },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    controller = module.get<FalconController>(FalconController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('health should return success', async () => {
    (mockAdapter.getLTP as any).mockResolvedValueOnce({ '26000': { last_price: 1 } });
    const res = await controller.health();
    expect(res.success).toBe(true);
    expect(res.provider).toBe('falcon');
  });
});


