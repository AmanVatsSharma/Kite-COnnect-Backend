/**
 * File:        src/infra/redis/redis.service.spec.ts
 * Module:      infra/redis
 * Purpose:     Unit tests for RedisService — circuit breaker, subscribe dispatcher, ioredis API, graceful degradation
 * Author:      BharatERP
 * Last-updated: 2026-04-19
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import { RedisClientFactory } from './redis-client.factory';
import { MetricsService } from '@infra/observability/metrics.service';

const makeMockClient = (statusOverride = 'ready', overrides: any = {}) => ({
  status: statusOverride,
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  exists: jest.fn().mockResolvedValue(0),
  incr: jest.fn().mockResolvedValue(1),
  decr: jest.fn().mockResolvedValue(0),
  expire: jest.fn().mockResolvedValue(1),
  ttl: jest.fn().mockResolvedValue(-1),
  pttl: jest.fn().mockResolvedValue(-1),
  hset: jest.fn().mockResolvedValue(1),
  hget: jest.fn().mockResolvedValue(null),
  hgetall: jest.fn().mockResolvedValue({}),
  hdel: jest.fn().mockResolvedValue(1),
  lpush: jest.fn().mockResolvedValue(1),
  rpop: jest.fn().mockResolvedValue(null),
  lrange: jest.fn().mockResolvedValue([]),
  ltrim: jest.fn().mockResolvedValue('OK'),
  scan: jest.fn().mockResolvedValue(['0', []]),
  publish: jest.fn().mockResolvedValue(1),
  subscribe: jest.fn().mockResolvedValue(1),
  unsubscribe: jest.fn().mockResolvedValue(1),
  on: jest.fn().mockReturnThis(),
  ping: jest.fn().mockResolvedValue('PONG'),
  ...overrides,
});

const makeFactory = (clientStatus = 'ready', defaultOverrides: any = {}) => {
  const defaultClient = makeMockClient(clientStatus, defaultOverrides);
  const pubClient = makeMockClient('ready');
  const subClient = makeMockClient('ready');
  return {
    isConfigured: jest.fn().mockReturnValue(clientStatus !== 'unconfigured'),
    getClient: jest.fn((name: string) => {
      if (name === 'default') return clientStatus === 'unconfigured' ? null : defaultClient;
      if (name === 'pubsub-pub') return pubClient;
      if (name === 'pubsub-sub') return subClient;
      return null;
    }),
    getMode: jest.fn().mockReturnValue('standard'),
    _defaultClient: defaultClient,
    _subClient: subClient,
    _pubClient: pubClient,
  };
};

const makeMetrics = () => ({
  redisOpsTotal: { labels: jest.fn().mockReturnValue({ inc: jest.fn() }) },
  redisCircuitState: { set: jest.fn() },
  redisConnected: { labels: jest.fn().mockReturnValue({ set: jest.fn() }) },
});

const makeConfig = (overrides: Record<string, any> = {}) => ({
  get: jest.fn((k: string, d?: any) => overrides[k] ?? d),
});

describe('RedisService', () => {
  let service: RedisService;
  let factory: ReturnType<typeof makeFactory>;
  let metrics: ReturnType<typeof makeMetrics>;

  const build = async (factoryStatus = 'ready', defaultOverrides: any = {}, configOverrides: Record<string, any> = {}) => {
    factory = makeFactory(factoryStatus, defaultOverrides);
    metrics = makeMetrics();
    const module = await Test.createTestingModule({
      providers: [
        RedisService,
        { provide: RedisClientFactory, useValue: factory },
        { provide: MetricsService, useValue: metrics },
        { provide: ConfigService, useValue: makeConfig(configOverrides) },
      ],
    }).compile();
    service = module.get(RedisService);
    await service.onModuleInit();
  };

  afterEach(() => jest.clearAllMocks());

  // ── isRedisAvailable ─────────────────────────────────────────────────────

  describe('isRedisAvailable', () => {
    it('returns true when default client status is ready', async () => {
      await build('ready');
      expect(service.isRedisAvailable()).toBe(true);
    });

    it('returns false when default client status is connecting', async () => {
      await build('connecting');
      expect(service.isRedisAvailable()).toBe(false);
    });

    it('returns false when factory returns null client', async () => {
      await build('unconfigured');
      expect(service.isRedisAvailable()).toBe(false);
    });
  });

  // ── get / set / del ──────────────────────────────────────────────────────

  describe('set', () => {
    it('calls setex with TTL when ttl provided', async () => {
      await build();
      await service.set('foo', { x: 1 }, 60);
      expect(factory._defaultClient.setex).toHaveBeenCalledWith('foo', 60, JSON.stringify({ x: 1 }));
    });

    it('calls set without TTL when no ttl', async () => {
      await build();
      await service.set('foo', 'bar');
      expect(factory._defaultClient.set).toHaveBeenCalledWith('foo', JSON.stringify('bar'));
    });

    it('returns silently when no client', async () => {
      await build('unconfigured');
      await expect(service.set('x', 1)).resolves.toBeUndefined();
    });
  });

  describe('get', () => {
    it('returns parsed JSON on HIT', async () => {
      await build();
      factory._defaultClient.get.mockResolvedValue(JSON.stringify({ x: 1 }));
      expect(await service.get<{ x: number }>('foo')).toEqual({ x: 1 });
    });

    it('returns null on MISS', async () => {
      await build();
      factory._defaultClient.get.mockResolvedValue(null);
      expect(await service.get('foo')).toBeNull();
    });

    it('increments hitCount on HIT', async () => {
      await build();
      factory._defaultClient.get.mockResolvedValue(JSON.stringify('val'));
      await service.get('k');
      expect(service.getStats().hits).toBe(1);
    });

    it('increments missCount on MISS', async () => {
      await build();
      await service.get('k');
      expect(service.getStats().misses).toBe(1);
    });
  });

  describe('del', () => {
    it('calls ioredis del', async () => {
      await build();
      await service.del('foo');
      expect(factory._defaultClient.del).toHaveBeenCalledWith('foo');
    });
  });

  // ── tryAcquireLock ───────────────────────────────────────────────────────

  describe('tryAcquireLock', () => {
    it('returns true when ioredis returns OK with NX/PX positional args', async () => {
      await build();
      factory._defaultClient.set.mockResolvedValue('OK');
      expect(await service.tryAcquireLock('lock:k', 5000)).toBe(true);
      expect(factory._defaultClient.set).toHaveBeenCalledWith('lock:k', '1', 'NX', 'PX', 5000);
    });

    it('returns false when lock already held (ioredis returns null)', async () => {
      await build();
      factory._defaultClient.set.mockResolvedValue(null);
      expect(await service.tryAcquireLock('lock:k', 5000)).toBe(false);
    });
  });

  // ── scanDelete ──────────────────────────────────────────────────────────

  describe('scanDelete', () => {
    it('compares cursor as STRING "0" — not number 0', async () => {
      await build();
      // cursor '0' on first call means done
      factory._defaultClient.scan.mockResolvedValue(['0', ['k1', 'k2']]);
      factory._defaultClient.del.mockResolvedValue(2);
      const deleted = await service.scanDelete('k*');
      expect(deleted).toBe(2);
    });

    it('continues iterating until cursor is "0"', async () => {
      await build();
      factory._defaultClient.scan
        .mockResolvedValueOnce(['42', ['k1']])
        .mockResolvedValueOnce(['0', ['k2']]);
      factory._defaultClient.del.mockResolvedValue(1);
      const deleted = await service.scanDelete('k*');
      expect(deleted).toBe(2);
      expect(factory._defaultClient.scan).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when no client', async () => {
      await build('unconfigured');
      expect(await service.scanDelete('*')).toBe(0);
    });
  });

  // ── subscribe dispatcher ─────────────────────────────────────────────────

  describe('subscribe dispatcher', () => {
    it('registers ONE message listener on subClient, fans out to multiple callbacks', async () => {
      await build();
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      await service.subscribe('chan:x', cb1);
      await service.subscribe('chan:x', cb2);

      // Find the 'message' listener registered on subClient
      const messageCall = factory._subClient.on.mock.calls.find(([ev]: [string]) => ev === 'message');
      expect(messageCall).toBeDefined();
      const handler = messageCall![1];

      // Simulate ioredis firing 'message'
      handler('chan:x', JSON.stringify({ tick: 1 }));
      expect(cb1).toHaveBeenCalledWith({ tick: 1 });
      expect(cb2).toHaveBeenCalledWith({ tick: 1 });
    });

    it('calls ioredis subscribe only ONCE per channel (deduplication)', async () => {
      await build();
      await service.subscribe('chan:y', jest.fn());
      await service.subscribe('chan:y', jest.fn());
      expect(factory._subClient.subscribe).toHaveBeenCalledTimes(1);
    });

    it('removes callbacks and calls ioredis unsubscribe on unsubscribe()', async () => {
      await build();
      const cb = jest.fn();
      await service.subscribe('chan:z', cb);
      await service.unsubscribe('chan:z');

      const messageCall = factory._subClient.on.mock.calls.find(([ev]: [string]) => ev === 'message');
      const handler = messageCall![1];
      handler('chan:z', JSON.stringify({ v: 1 }));
      expect(cb).not.toHaveBeenCalled();
      expect(factory._subClient.unsubscribe).toHaveBeenCalledWith('chan:z');
    });
  });

  // ── circuit breaker ──────────────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('opens after THRESHOLD consecutive failures, skips subsequent ops', async () => {
      await build('ready', {}, { REDIS_CIRCUIT_BREAKER_THRESHOLD: 3, REDIS_CIRCUIT_BREAKER_RESET_MS: 30000 });
      factory._defaultClient.get.mockRejectedValue(new Error('ECONNREFUSED'));

      await service.get('k'); // failure 1
      await service.get('k'); // failure 2
      await service.get('k'); // failure 3 → OPEN

      factory._defaultClient.get.mockClear();
      await service.get('k'); // skipped — circuit OPEN
      expect(factory._defaultClient.get).not.toHaveBeenCalled();
      expect(service.getStats().circuitBreaker.state).toBe('OPEN');
    });

    it('transitions OPEN → HALF_OPEN after resetMs, then CLOSED on success', async () => {
      await build('ready', {}, { REDIS_CIRCUIT_BREAKER_THRESHOLD: 2, REDIS_CIRCUIT_BREAKER_RESET_MS: 1 });

      factory._defaultClient.get.mockRejectedValue(new Error('err'));
      await service.get('k'); // failure 1
      await service.get('k'); // failure 2 → OPEN

      await new Promise(r => setTimeout(r, 10)); // wait past resetMs=1ms

      // Next call: HALF_OPEN probe — succeeds
      factory._defaultClient.get.mockResolvedValue(JSON.stringify('ok'));
      await service.get('k');
      expect(service.getStats().circuitBreaker.state).toBe('CLOSED');
    });

    it('getStats() returns expected shape', async () => {
      await build();
      const stats = service.getStats();
      expect(stats).toHaveProperty('connected');
      expect(stats).toHaveProperty('circuitBreaker.state');
      expect(stats).toHaveProperty('circuitBreaker.consecutiveFailures');
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
    });
  });

  // ── publish ──────────────────────────────────────────────────────────────

  describe('publish', () => {
    it('publishes JSON-serialized message to pubClient', async () => {
      await build();
      await service.publish('ch', { data: 1 });
      expect(factory._pubClient.publish).toHaveBeenCalledWith('ch', JSON.stringify({ data: 1 }));
    });
  });

  // ── hash ops ─────────────────────────────────────────────────────────────

  describe('hset / hget / hgetall / hdel', () => {
    it('hset serializes value', async () => {
      await build();
      await service.hset('h', 'f', { v: 1 });
      expect(factory._defaultClient.hset).toHaveBeenCalledWith('h', 'f', JSON.stringify({ v: 1 }));
    });

    it('hget deserializes value', async () => {
      await build();
      factory._defaultClient.hget.mockResolvedValue(JSON.stringify({ v: 1 }));
      expect(await service.hget('h', 'f')).toEqual({ v: 1 });
    });

    it('hgetall returns empty object on null response', async () => {
      await build();
      factory._defaultClient.hgetall.mockResolvedValue(null);
      expect(await service.hgetall('h')).toEqual({});
    });
  });

  // ── market data domain ────────────────────────────────────────────────────

  describe('cacheMarketData / getCachedMarketData', () => {
    it('uses market_data:{token} key', async () => {
      await build();
      await service.cacheMarketData(12345, { ltp: 100 }, 30);
      expect(factory._defaultClient.setex).toHaveBeenCalledWith('market_data:12345', 30, expect.any(String));
    });
  });
});
