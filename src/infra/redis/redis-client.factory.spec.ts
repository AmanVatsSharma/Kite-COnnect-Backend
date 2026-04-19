/**
 * File:        src/infra/redis/redis-client.factory.spec.ts
 * Module:      infra/redis
 * Purpose:     Unit tests for RedisClientFactory — verifies branching, lifecycle, and client access
 * Author:      BharatERP
 * Last-updated: 2026-04-19
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '@infra/observability/metrics.service';
import { RedisClientFactory } from './redis-client.factory';

// Mock ioredis so no real connections happen
jest.mock('ioredis', () => {
  const mockClient = {
    status: 'ready',
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    on: jest.fn().mockReturnThis(),
    once: jest.fn().mockReturnThis(),
    ping: jest.fn().mockResolvedValue('PONG'),
  };
  const MockRedis: any = jest.fn().mockImplementation(() => ({ ...mockClient }));
  const MockCluster = jest.fn().mockImplementation(() => ({ ...mockClient }));
  MockRedis.Cluster = MockCluster;
  return { default: MockRedis, Redis: MockRedis, Cluster: MockCluster };
});

const makeConfig = (overrides: Record<string, any> = {}) => ({
  get: jest.fn((key: string, def?: any) => {
    if (key in overrides) return overrides[key];
    return def;
  }),
});

const makeMetrics = () => ({
  redisConnected: { labels: jest.fn().mockReturnValue({ set: jest.fn() }) },
  redisCircuitState: { set: jest.fn() },
});

describe('RedisClientFactory', () => {
  let factory: RedisClientFactory;

  const build = async (configOverrides: Record<string, any> = {}) => {
    const config = makeConfig({ REDIS_CONNECT_TIMEOUT_MS: 100, ...configOverrides });
    const metrics = makeMetrics();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisClientFactory,
        { provide: ConfigService, useValue: config },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();
    factory = module.get(RedisClientFactory);
    await factory.onModuleInit();
    return factory;
  };

  afterEach(async () => {
    try { await factory?.onModuleDestroy(); } catch {}
    jest.clearAllMocks();
  });

  it('returns null clients when no Redis config provided', async () => {
    await build({ REDIS_HOST: undefined, REDIS_URL: undefined, REDIS_SENTINEL_HOSTS: undefined, REDIS_CLUSTER_NODES: undefined });
    expect(factory.isConfigured()).toBe(false);
    expect(factory.getClient('default')).toBeNull();
    expect(factory.getClient('io-adapter-pub')).toBeNull();
  });

  it('creates 5 named clients in standard mode', async () => {
    await build({ REDIS_HOST: 'localhost' });
    expect(factory.isConfigured()).toBe(true);
    expect(factory.getMode()).toBe('standard');
    const names = ['default', 'pubsub-pub', 'pubsub-sub', 'io-adapter-pub', 'io-adapter-sub'] as const;
    for (const name of names) {
      expect(factory.getClient(name)).not.toBeNull();
    }
  });

  it('returns mode=sentinel when REDIS_SENTINEL_HOSTS is set', async () => {
    await build({ REDIS_SENTINEL_HOSTS: 'sentinel1:26379', REDIS_SENTINEL_NAME: 'mymaster' });
    expect(factory.getMode()).toBe('sentinel');
  });

  it('returns mode=cluster when REDIS_CLUSTER_NODES is set', async () => {
    await build({ REDIS_CLUSTER_NODES: 'node1:7001,node2:7002' });
    expect(factory.getMode()).toBe('cluster');
  });

  it('calls connect() on all 5 clients during onModuleInit', async () => {
    await build({ REDIS_HOST: 'localhost' });
    const IORedis = require('ioredis').default;
    const allInstances: any[] = IORedis.mock.results.map((r: any) => r.value);
    const connectCalls = allInstances.filter((i: any) => i.connect && i.connect.mock && i.connect.mock.calls.length > 0);
    expect(connectCalls.length).toBeGreaterThanOrEqual(5);
  });

  it('quits all clients on onModuleDestroy', async () => {
    await build({ REDIS_HOST: 'localhost' });
    const IORedis = require('ioredis').default;
    const instancesBefore = IORedis.mock.results.map((r: any) => r.value);
    await factory.onModuleDestroy();
    const quitCalls = instancesBefore.filter((i: any) => i.quit && i.quit.mock && i.quit.mock.calls.length > 0);
    expect(quitCalls.length).toBeGreaterThanOrEqual(5);
  });
});
