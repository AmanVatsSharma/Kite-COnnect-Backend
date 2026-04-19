/**
 * File:        src/infra/redis/redis-client.factory.ts
 * Module:      infra/redis
 * Purpose:     Central factory that creates and manages all 5 named ioredis clients with exponential backoff, Sentinel/Cluster support, and no-op graceful degradation when Redis is unconfigured.
 *
 * Exports:
 *   - RedisClientName                      — union of the 5 named client keys
 *   - RedisMode                            — 'standard' | 'sentinel' | 'cluster'
 *   - RedisClientFactory                   — @Injectable() factory service
 *
 * Depends on:
 *   - ioredis              — Redis client library with built-in reconnect/Sentinel/Cluster
 *   - @nestjs/config       — env var access via ConfigService
 *   - MetricsService       — updates redisConnected gauge on ready/end events
 *
 * Side-effects:
 *   - Opens up to 5 TCP connections to Redis on onModuleInit
 *   - Registers event listeners per client (ready, error, reconnecting, end, close)
 *
 * Key invariants:
 *   - lazyConnect: true on all clients — explicit connect() in onModuleInit
 *   - getClient() returns null (not throws) when unconfigured or exhausted retries
 *   - retryStrategy returns undefined after maxRetries to stop reconnection
 *   - Cluster mode detected by REDIS_CLUSTER_NODES, Sentinel by REDIS_SENTINEL_HOSTS
 *
 * Read order:
 *   1. RedisClientName, RedisMode — types
 *   2. buildClient() — branching logic per mode
 *   3. onModuleInit / onModuleDestroy — lifecycle
 *   4. getClient / getMode / isConfigured — public accessors
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-19
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { Redis, Cluster, RedisOptions } from 'ioredis';
import { MetricsService } from '@infra/observability/metrics.service';

export type RedisClientName =
  | 'default'
  | 'pubsub-pub'
  | 'pubsub-sub'
  | 'io-adapter-pub'
  | 'io-adapter-sub';

export type RedisMode = 'standard' | 'sentinel' | 'cluster';

const CLIENT_NAMES: RedisClientName[] = [
  'default',
  'pubsub-pub',
  'pubsub-sub',
  'io-adapter-pub',
  'io-adapter-sub',
];

@Injectable()
export class RedisClientFactory implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisClientFactory.name);
  private readonly clients = new Map<RedisClientName, Redis | Cluster | null>();
  private mode: RedisMode = 'standard';
  private configured = false;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const clusterNodes = this.config.get<string>('REDIS_CLUSTER_NODES', '');
    const sentinelHosts = this.config.get<string>('REDIS_SENTINEL_HOSTS', '');
    const hasHost = this.config.get<string>('REDIS_HOST', '');
    const hasUrl = this.config.get<string>('REDIS_URL', '');

    if (!clusterNodes && !sentinelHosts && !hasHost && !hasUrl) {
      this.logger.warn(
        '[RedisClientFactory] No Redis configuration found — running without Redis (graceful degradation)',
      );
      for (const name of CLIENT_NAMES) {
        this.clients.set(name, null);
      }
      return;
    }

    if (clusterNodes) {
      this.mode = 'cluster';
    } else if (sentinelHosts) {
      this.mode = 'sentinel';
    } else {
      this.mode = 'standard';
    }

    this.configured = true;
    const timeoutMs = this.config.get<number>('REDIS_CONNECT_TIMEOUT_MS', 5000);

    for (const name of CLIENT_NAMES) {
      const client = this.buildClient(name);
      this.clients.set(name, client);
    }

    try {
      await Promise.race([
        Promise.allSettled(
          CLIENT_NAMES.map((name) => {
            const client = this.clients.get(name);
            if (!client) return Promise.resolve();
            return (client as Redis).connect?.() ?? Promise.resolve();
          }),
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Redis connect timeout after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
      this.logger.log('[RedisClientFactory] All Redis clients connected successfully');
    } catch (err: any) {
      this.logger.warn(
        `[RedisClientFactory] Initial connect failed: ${err.message} — clients will retry in background`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const [name, client] of this.clients) {
      if (!client) continue;
      try {
        await (client as Redis).quit();
        this.logger.log(`[RedisClientFactory] Client '${name}' disconnected`);
      } catch (err: any) {
        this.logger.debug(
          `[RedisClientFactory] Error quitting '${name}': ${err.message}`,
        );
      }
    }
    this.clients.clear();
  }

  getClient(name: RedisClientName): Redis | Cluster | null {
    return this.clients.get(name) ?? null;
  }

  getMode(): RedisMode {
    return this.mode;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  private buildClient(name: RedisClientName): Redis | Cluster {
    const maxRetries = this.config.get<number>('REDIS_MAX_RETRIES', 10);
    const connectTimeout = this.config.get<number>('REDIS_CONNECT_TIMEOUT_MS', 5000);
    const password = this.config.get<string>('REDIS_PASSWORD', '') || undefined;

    const retryStrategy = (times: number): number | undefined => {
      if (times > maxRetries) {
        this.logger.warn(
          `[RedisClientFactory] Client '${name}' exhausted ${maxRetries} retries — stopping`,
        );
        return undefined;
      }
      const delay = Math.min(Math.pow(2, times) * 100, 3000);
      this.logger.debug(
        `[RedisClientFactory] Client '${name}' retry #${times}, waiting ${delay}ms`,
      );
      return delay;
    };

    if (this.mode === 'cluster') {
      const nodes = this.config
        .get<string>('REDIS_CLUSTER_NODES', '')
        .split(',')
        .map((n) => {
          const [host, port] = n.trim().split(':');
          return { host, port: parseInt(port, 10) || 7000 };
        });
      const cluster = new Cluster(nodes, {
        lazyConnect: true,
        clusterRetryStrategy: retryStrategy,
        redisOptions: { password, connectTimeout, lazyConnect: true } as RedisOptions,
      });
      this.wireEvents(name, cluster as unknown as Redis);
      return cluster;
    }

    if (this.mode === 'sentinel') {
      const sentinels = this.config
        .get<string>('REDIS_SENTINEL_HOSTS', '')
        .split(',')
        .map((h) => {
          const [host, port] = h.trim().split(':');
          return { host, port: parseInt(port, 10) || 26379 };
        });
      const sentinelName = this.config.get<string>('REDIS_SENTINEL_NAME', 'mymaster');
      const client = new IORedis({
        sentinels,
        name: sentinelName,
        password,
        connectTimeout,
        lazyConnect: true,
        retryStrategy,
      });
      this.wireEvents(name, client);
      return client;
    }

    // Standard mode
    const url = this.config.get<string>('REDIS_URL', '');
    let client: Redis;
    if (url) {
      client = new IORedis(url, { lazyConnect: true, retryStrategy } as any);
    } else {
      client = new IORedis({
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: this.config.get<number>('REDIS_PORT', 6379),
        password,
        db: 0,
        connectTimeout,
        lazyConnect: true,
        retryStrategy,
      });
    }
    this.wireEvents(name, client);
    return client;
  }

  private wireEvents(name: RedisClientName, client: Redis): void {
    client.on('ready', () => {
      this.logger.log(`[RedisClientFactory] Client '${name}' ready`);
      this.metrics.redisConnected.labels(name).set(1);
    });
    client.on('error', (err: Error) => {
      this.logger.warn(`[RedisClientFactory] Client '${name}' error: ${err.message}`);
    });
    client.on('reconnecting', () => {
      this.logger.debug(`[RedisClientFactory] Client '${name}' reconnecting...`);
    });
    client.on('end', () => {
      this.logger.warn(`[RedisClientFactory] Client '${name}' connection ended`);
      this.metrics.redisConnected.labels(name).set(0);
    });
    client.on('close', () => {
      this.logger.debug(`[RedisClientFactory] Client '${name}' socket closed`);
      this.metrics.redisConnected.labels(name).set(0);
    });
  }
}
