/**
 * File:        src/infra/redis/redis.service.ts
 * Module:      infra/redis
 * Purpose:     Cache, pub/sub, and distributed-lock facade over named ioredis clients from RedisClientFactory. Adds circuit breaker, structured logging, and Prometheus metrics. All operations fail silently (safe defaults) when Redis is unavailable.
 *
 * Exports:
 *   - RedisService — @Injectable() service with 28 public methods
 *
 * Depends on:
 *   - RedisClientFactory   — provides named ioredis clients (default, pubsub-pub, pubsub-sub)
 *   - MetricsService       — redisOpsTotal, redisCircuitState counters/gauges
 *   - ConfigService        — REDIS_CIRCUIT_BREAKER_THRESHOLD, REDIS_CIRCUIT_BREAKER_RESET_MS
 *
 * Side-effects:
 *   - Reads/writes Redis on every public method call
 *   - Updates Prometheus metrics on every operation
 *
 * Key invariants:
 *   - isRedisAvailable() reflects live ioredis client.status, not a stored boolean
 *   - Subscribe dispatcher: one 'message' listener per subClient lifetime, fanout via Map
 *   - Circuit breaker wraps defaultClient ops only; pub/sub is circuit-breaker-exempt
 *   - scanDelete: ioredis scan returns [string, string[]] — cursor is string, compare !== '0'
 *
 * Read order:
 *   1. CircuitBreaker (private class) — state machine
 *   2. onModuleInit — client resolution and subscriber event wiring
 *   3. get/set/del — standard cache ops
 *   4. subscribe/unsubscribe/publish — pub/sub with dispatcher
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-19
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis, Cluster } from 'ioredis';
import { RedisClientFactory } from './redis-client.factory';
import { MetricsService } from '@infra/observability/metrics.service';

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

type CbState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

class CircuitBreaker {
  private state: CbState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
    private readonly metrics: MetricsService,
    private readonly logCtx: string,
  ) {
    this.setMetric();
  }

  /**
   * Returns true when the circuit is OPEN and the reset window has not elapsed.
   * Transitions OPEN → HALF_OPEN when the reset window elapses.
   */
  isOpen(): boolean {
    if (this.state === 'CLOSED') return false;
    if (this.state === 'HALF_OPEN') return false;
    // OPEN — check if reset window has elapsed
    if (Date.now() - this.openedAt >= this.resetMs) {
      this.state = 'HALF_OPEN';
      this.setMetric();
      return false; // allow the probe request through
    }
    return true;
  }

  recordSuccess(): void {
    if (this.state !== 'CLOSED') {
      this.state = 'CLOSED';
      this.setMetric();
    }
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
    if (this.state === 'HALF_OPEN' || this.failures >= this.threshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.setMetric();
    }
  }

  snapshot(): { state: CbState; consecutiveFailures: number; openedAt: number | null } {
    return {
      state: this.state,
      consecutiveFailures: this.failures,
      openedAt: this.state !== 'CLOSED' ? this.openedAt : null,
    };
  }

  private setMetric(): void {
    const val = this.state === 'CLOSED' ? 0 : this.state === 'OPEN' ? 1 : 2;
    this.metrics.redisCircuitState.set(val);
  }
}

// ─── RedisService ─────────────────────────────────────────────────────────────

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  private defaultClient: Redis | Cluster | null = null;
  private pubClient: Redis | Cluster | null = null;
  private subClient: Redis | Cluster | null = null;

  private circuitBreaker: CircuitBreaker;

  /** Map from channel → Set of subscriber callbacks (single 'message' event dispatcher). */
  private readonly subscriptions = new Map<string, Set<(msg: any) => void>>();

  private hitCount = 0;
  private missCount = 0;

  constructor(
    private readonly factory: RedisClientFactory,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const threshold = this.config.get<number>('REDIS_CIRCUIT_BREAKER_THRESHOLD', 5);
    const resetMs = this.config.get<number>('REDIS_CIRCUIT_BREAKER_RESET_MS', 30_000);

    this.circuitBreaker = new CircuitBreaker(threshold, resetMs, this.metrics, RedisService.name);

    this.defaultClient = this.factory.getClient('default') as Redis | Cluster | null;
    this.pubClient = this.factory.getClient('pubsub-pub') as Redis | Cluster | null;
    this.subClient = this.factory.getClient('pubsub-sub') as Redis | Cluster | null;

    // Register ONE 'message' event listener for the subscriber dispatcher
    if (this.subClient) {
      (this.subClient as Redis).on('message', (channel: string, rawMessage: string) => {
        const callbacks = this.subscriptions.get(channel);
        if (!callbacks || callbacks.size === 0) return;
        let parsed: any;
        try {
          parsed = JSON.parse(rawMessage);
        } catch {
          parsed = rawMessage;
        }
        for (const cb of callbacks) {
          try {
            cb(parsed);
          } catch (err: any) {
            this.logger.error(`[RedisService] subscriber callback error on channel ${channel}: ${err?.message}`);
          }
        }
      });
    }

    if (this.defaultClient) {
      this.logger.log('[RedisService] Initialized with ioredis clients from RedisClientFactory');
    } else {
      this.logger.warn('[RedisService] No Redis client available — running in graceful degradation mode');
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Clients are owned and destroyed by RedisClientFactory — just clear local state
    this.subscriptions.clear();
    this.logger.log('[RedisService] Subscriptions cleared — clients managed by RedisClientFactory');
  }

  // ─── Availability ──────────────────────────────────────────────────────────

  /**
   * Returns true only when the default ioredis client reports 'ready' status.
   * Reflects live connection state — NOT a stored boolean flag.
   */
  isRedisAvailable(): boolean {
    return (this.defaultClient as Redis)?.status === 'ready';
  }

  /**
   * Returns a snapshot of service health: connection, circuit breaker state, hit/miss counters.
   */
  getStats(): {
    connected: boolean;
    circuitBreaker: { state: string; consecutiveFailures: number; openedAt: number | null };
    hits: number;
    misses: number;
  } {
    return {
      connected: this.isRedisAvailable(),
      circuitBreaker: this.circuitBreaker.snapshot(),
      hits: this.hitCount,
      misses: this.missCount,
    };
  }

  // ─── Core cache ops ───────────────────────────────────────────────────────

  /**
   * Set a value in Redis. Uses SETEX when ttl provided, SET otherwise.
   * Fails silently when Redis is unavailable.
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const client = this.defaultClient as Redis | null;
    if (!client) return;
    await this.withCircuitBreaker('set', async () => {
      const serialized = JSON.stringify(value);
      if (ttl) {
        await client.setex(key, ttl, serialized);
      } else {
        await client.set(key, serialized);
      }
    });
  }

  /**
   * Get a value from Redis. Returns null on MISS or when unavailable.
   * Increments hitCount / missCount for stats.
   */
  async get<T>(key: string): Promise<T | null> {
    const client = this.defaultClient as Redis | null;
    if (!client) return null;
    return this.withCircuitBreaker('get', async () => {
      const raw = await client.get(key);
      if (raw === null || raw === undefined) {
        this.missCount++;
        return null;
      }
      this.hitCount++;
      return JSON.parse(raw) as T;
    }, null);
  }

  /**
   * Delete a key from Redis. Fails silently when unavailable.
   */
  async del(key: string): Promise<void> {
    const client = this.defaultClient as Redis | null;
    if (!client) return;
    await this.withCircuitBreaker('del', () => client.del(key));
  }

  /**
   * Check if a key exists. Returns false when unavailable.
   */
  async exists(key: string): Promise<boolean> {
    const client = this.defaultClient as Redis | null;
    if (!client) return false;
    return this.withCircuitBreaker('exists', async () => {
      const result = await client.exists(key);
      return result === 1;
    }, false);
  }

  /**
   * Increment a key's integer value. Returns 0 when unavailable.
   */
  async incr(key: string): Promise<number> {
    const client = this.defaultClient as Redis | null;
    if (!client) return 0;
    return this.withCircuitBreaker('incr', () => client.incr(key), 0);
  }

  /**
   * Decrement a key's integer value. Returns 0 when unavailable.
   */
  async decr(key: string): Promise<number> {
    const client = this.defaultClient as Redis | null;
    if (!client) return 0;
    return this.withCircuitBreaker('decr', () => client.decr(key), 0);
  }

  /**
   * Set expiration on a key in seconds. Fails silently when unavailable.
   */
  async expire(key: string, seconds: number): Promise<void> {
    const client = this.defaultClient as Redis | null;
    if (!client) return;
    await this.withCircuitBreaker('expire', () => client.expire(key, seconds));
  }

  /**
   * Get remaining TTL for a key in milliseconds. Returns -2 when unavailable.
   */
  async pttl(key: string): Promise<number> {
    const client = this.defaultClient as Redis | null;
    if (!client) return -2;
    return this.withCircuitBreaker('pttl', () => client.pttl(key), -2);
  }

  /**
   * Try to acquire a distributed lock with NX and PX (milliseconds TTL).
   * Uses ioredis positional args: set(key, '1', 'NX', 'PX', ttlMs).
   * Returns false when unavailable or lock already held.
   */
  async tryAcquireLock(key: string, ttlMs: number): Promise<boolean> {
    const client = this.defaultClient as Redis | null;
    if (!client) return false;
    return this.withCircuitBreaker('tryAcquireLock', async () => {
      // ioredis positional NX/PX — cast to any to bypass overload TS checks
      const res = await (client as any).set(key, '1', 'NX', 'PX', ttlMs);
      return res === 'OK';
    }, false);
  }

  // ─── Hash ops ─────────────────────────────────────────────────────────────

  /**
   * Set a hash field. Value is JSON-serialized. Fails silently when unavailable.
   */
  async hset(key: string, field: string, value: any): Promise<void> {
    const client = this.defaultClient as Redis | null;
    if (!client) return;
    await this.withCircuitBreaker('hset', () => client.hset(key, field, JSON.stringify(value)));
  }

  /**
   * Get a hash field. Returns null on MISS or when unavailable.
   */
  async hget<T>(key: string, field: string): Promise<T | null> {
    const client = this.defaultClient as Redis | null;
    if (!client) return null;
    return this.withCircuitBreaker('hget', async () => {
      const raw = await client.hget(key, field);
      return raw ? (JSON.parse(raw) as T) : null;
    }, null);
  }

  /**
   * Get all hash fields. ioredis may return null — treated as empty object.
   */
  async hgetall<T>(key: string): Promise<Record<string, T>> {
    const client = this.defaultClient as Redis | null;
    if (!client) return {};
    return this.withCircuitBreaker('hgetall', async () => {
      const raw = await client.hgetall(key);
      if (!raw) return {};
      const result: Record<string, T> = {};
      for (const [f, v] of Object.entries(raw)) {
        result[f] = JSON.parse(v) as T;
      }
      return result;
    }, {});
  }

  /**
   * Delete a hash field. Fails silently when unavailable.
   */
  async hdel(key: string, field: string): Promise<void> {
    const client = this.defaultClient as Redis | null;
    if (!client) return;
    await this.withCircuitBreaker('hdel', () => client.hdel(key, field));
  }

  // ─── List ops ─────────────────────────────────────────────────────────────

  /**
   * Push a JSON-serialized value to the head of a list. Fails silently when unavailable.
   */
  async lpush(key: string, value: any): Promise<void> {
    const client = this.defaultClient as Redis | null;
    if (!client) return;
    await this.withCircuitBreaker('lpush', () => client.lpush(key, JSON.stringify(value)));
  }

  /**
   * Pop a value from the tail of a list. Returns null on empty list or unavailability.
   */
  async rpop<T>(key: string): Promise<T | null> {
    const client = this.defaultClient as Redis | null;
    if (!client) return null;
    return this.withCircuitBreaker('rpop', async () => {
      const raw = await client.rpop(key);
      return raw ? (JSON.parse(raw) as T) : null;
    }, null);
  }

  /**
   * Get a range of list elements, JSON-parsed. Returns empty array when unavailable.
   */
  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    const client = this.defaultClient as Redis | null;
    if (!client) return [];
    return this.withCircuitBreaker('lrange', async () => {
      const values = await client.lrange(key, start, stop);
      return values.map((v) => JSON.parse(v) as T);
    }, []);
  }

  /**
   * Get a range of list elements as raw strings (no JSON parsing).
   * Returns empty array when unavailable.
   */
  async lrangeRaw(key: string, start = 0, stop = -1): Promise<string[]> {
    const client = this.defaultClient as Redis | null;
    if (!client) return [];
    return this.withCircuitBreaker('lrangeRaw', () => client.lrange(key, start, stop), []);
  }

  /**
   * Push a raw string value to the head of a list and trim to maxLen entries.
   * Used for ring-buffer event logs. Fails silently when unavailable.
   */
  async lpushTrim(key: string, value: string, maxLen = 50): Promise<void> {
    const client = this.defaultClient as Redis | null;
    if (!client) return;
    await this.withCircuitBreaker('lpushTrim', async () => {
      await client.lpush(key, value);
      await client.ltrim(key, 0, maxLen - 1);
    });
  }

  // ─── Pub/Sub (NOT circuit-breaker-wrapped) ────────────────────────────────

  /**
   * Publish a JSON-serialized message to a Redis channel.
   * Uses the dedicated pub client. Fails silently when unavailable.
   */
  async publish(channel: string, message: any): Promise<void> {
    const client = this.pubClient as Redis | null;
    if (!client) return;
    try {
      await client.publish(channel, JSON.stringify(message));
      this.emit('publish', 'success');
    } catch (err: any) {
      this.logger.error(`[RedisService] publish error on channel ${channel}: ${err?.message}`);
      this.emit('publish', 'failure');
    }
  }

  /**
   * Subscribe to a Redis channel with a callback.
   * Deduplicates ioredis subscribe calls per channel — adds callback to dispatcher Set.
   * Fails silently when unavailable.
   */
  async subscribe(channel: string, callback: (message: any) => void): Promise<void> {
    const client = this.subClient as Redis | null;
    if (!client) return;
    try {
      const alreadySubscribed = this.subscriptions.has(channel);
      if (!alreadySubscribed) {
        await client.subscribe(channel);
        this.subscriptions.set(channel, new Set());
      }
      this.subscriptions.get(channel)!.add(callback);
      this.emit('subscribe', 'success');
    } catch (err: any) {
      this.logger.error(`[RedisService] subscribe error on channel ${channel}: ${err?.message}`);
      this.emit('subscribe', 'failure');
    }
  }

  /**
   * Unsubscribe from a Redis channel, clearing all callbacks.
   * Fails silently when unavailable.
   */
  async unsubscribe(channel: string): Promise<void> {
    const client = this.subClient as Redis | null;
    if (!client) return;
    try {
      this.subscriptions.delete(channel);
      await client.unsubscribe(channel);
      this.emit('unsubscribe', 'success');
    } catch (err: any) {
      this.logger.error(`[RedisService] unsubscribe error on channel ${channel}: ${err?.message}`);
      this.emit('unsubscribe', 'failure');
    }
  }

  // ─── Bulk ops ─────────────────────────────────────────────────────────────

  /**
   * Scan-and-delete all keys matching a glob pattern using SCAN to avoid blocking.
   * CRITICAL: ioredis SCAN returns [string, string[]] — cursor is a STRING; compare with '0'.
   * Returns the number of deleted keys (0 if Redis unavailable).
   */
  async scanDelete(pattern: string): Promise<number> {
    const client = this.defaultClient as Redis | null;
    if (!client) return 0;
    try {
      let cursor = '0';
      let deleted = 0;
      do {
        const [nextCursor, keys]: [string, string[]] = await client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await client.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== '0');
      this.logger.log(`[RedisService] scanDelete(${pattern}): deleted ${deleted} keys`);
      this.emit('scanDelete', 'success');
      return deleted;
    } catch (err: any) {
      this.logger.error(`[RedisService] scanDelete(${pattern}) failed: ${err?.message}`);
      this.emit('scanDelete', 'failure');
      return 0;
    }
  }

  // ─── Domain ops ───────────────────────────────────────────────────────────

  /**
   * Cache market data for an instrument token. Key format: market_data:{token}.
   */
  async cacheMarketData(instrumentToken: number, data: any, ttl = 60): Promise<void> {
    this.logger.debug(`Caching market data for instrument: ${instrumentToken}`);
    await this.set(`market_data:${instrumentToken}`, data, ttl);
  }

  /**
   * Get cached market data for an instrument token. Returns null on MISS.
   */
  async getCachedMarketData(instrumentToken: number): Promise<any> {
    this.logger.debug(`Retrieving cached market data for instrument: ${instrumentToken}`);
    return this.get(`market_data:${instrumentToken}`);
  }

  /**
   * Cache quote data for multiple tokens. Key format: quotes:{tokens}.
   */
  async cacheQuote(tokens: string[], data: any, ttl = 30): Promise<void> {
    const key = `quotes:${tokens.join(',')}`;
    await this.set(key, data, ttl);
  }

  /**
   * Get cached quote data for multiple tokens. Returns null on MISS.
   */
  async getCachedQuote(tokens: string[]): Promise<any> {
    const key = `quotes:${tokens.join(',')}`;
    return this.get(key);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Wraps a defaultClient operation with circuit breaker logic.
   * If circuit is OPEN, skips and returns fallback. Records success/failure.
   */
  private async withCircuitBreaker<T>(
    op: string,
    fn: () => Promise<T>,
    fallback?: T,
  ): Promise<T> {
    if (this.circuitBreaker.isOpen()) {
      this.emit(op, 'skipped');
      return fallback as T;
    }
    try {
      const result = await fn();
      this.circuitBreaker.recordSuccess();
      this.emit(op, 'success');
      return result;
    } catch (err: any) {
      this.circuitBreaker.recordFailure();
      this.logger.error(`[RedisService] ${op} error: ${err?.message}`);
      this.emit(op, 'failure');
      return fallback as T;
    }
  }

  /**
   * Increment the Prometheus ops counter for a given operation and result label.
   */
  private emit(op: string, result: 'success' | 'failure' | 'skipped'): void {
    try {
      this.metrics.redisOpsTotal.labels(op, result).inc();
    } catch {
      // metrics failures must not propagate
    }
  }
}
