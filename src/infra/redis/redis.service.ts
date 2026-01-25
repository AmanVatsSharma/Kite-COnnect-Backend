import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Redis from 'redis';

/**
 * RedisService - Handles all Redis operations with optional connection support
 *
 * Flow:
 * 1. On module init, attempts to connect to Redis
 * 2. If connection fails, logs warning and continues without Redis
 * 3. All operations check if Redis is connected before executing
 * 4. Returns safe defaults when Redis is not available
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis.RedisClientType;
  private subscriber: Redis.RedisClientType;
  private publisher: Redis.RedisClientType;

  // Flag to track if Redis is connected and available
  private isConnected: boolean = false;

  constructor(private configService: ConfigService) {
    console.log('[RedisService] Constructor called - initializing service');
  }

  async onModuleInit() {
    console.log(
      '[RedisService] onModuleInit - Attempting to initialize Redis connection',
    );
    await this.initializeRedis();
  }

  async onModuleDestroy() {
    console.log(
      '[RedisService] onModuleDestroy - Shutting down Redis connections',
    );
    await this.disconnect();
  }

  /**
   * Initialize Redis connection with fallback support
   * If Redis is not available, the application continues with a warning
   */
  private async initializeRedis() {
    try {
      console.log('[RedisService] Attempting to connect to Redis...');

      const redisConfig = {
        host: this.configService.get('REDIS_HOST', 'localhost'),
        port: this.configService.get('REDIS_PORT', 6379),
        password: this.configService.get('REDIS_PASSWORD', ''),
        db: 0,
      };

      console.log(
        `[RedisService] Redis config: ${redisConfig.host}:${redisConfig.port}`,
      );

      // Create main client
      this.client = Redis.createClient(redisConfig);

      // Create subscriber client
      this.subscriber = Redis.createClient(redisConfig);

      // Create publisher client
      this.publisher = Redis.createClient(redisConfig);

      // Add error handlers to prevent uncaught errors
      this.client.on('error', (err) => {
        console.error('[RedisService] Redis client error:', err.message);
        this.isConnected = false;
      });

      this.subscriber.on('error', (err) => {
        console.error('[RedisService] Redis subscriber error:', err.message);
        this.isConnected = false;
      });

      this.publisher.on('error', (err) => {
        console.error('[RedisService] Redis publisher error:', err.message);
        this.isConnected = false;
      });

      // Connect all clients with timeout
      console.log('[RedisService] Connecting Redis clients...');
      await Promise.race([
        Promise.all([
          this.client.connect(),
          this.subscriber.connect(),
          this.publisher.connect(),
        ]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Redis connection timeout')), 5000),
        ),
      ]);

      this.isConnected = true;
      this.logger.log('✅ Redis clients connected successfully');
      console.log('[RedisService] ✅ Redis is ready for use');
    } catch (error) {
      // Log warning but don't throw - allow app to continue without Redis
      this.isConnected = false;
      this.logger.warn(
        '⚠️  Redis connection failed - Application will continue without caching',
      );
      this.logger.warn(
        '⚠️  To enable Redis caching, please configure REDIS_HOST and ensure Redis is running',
      );
      console.warn(
        '[RedisService] ⚠️  REDIS NOT AVAILABLE - App running without cache',
      );
      console.warn(`[RedisService] Redis error: ${error.message}`);

      // Clean up any partially created clients
      try {
        await this.client?.disconnect();
        await this.subscriber?.disconnect();
        await this.publisher?.disconnect();
      } catch (cleanupError) {
        console.log('[RedisService] Cleanup after failed connection completed');
      }
    }
  }

  /**
   * Disconnect all Redis clients gracefully
   */
  async disconnect() {
    console.log('[RedisService] Disconnecting Redis clients...');
    if (!this.isConnected) {
      console.log(
        '[RedisService] Redis was not connected, skipping disconnect',
      );
      return;
    }

    try {
      await Promise.all([
        this.client?.disconnect(),
        this.subscriber?.disconnect(),
        this.publisher?.disconnect(),
      ]);
      this.isConnected = false;
      this.logger.log('Redis clients disconnected');
      console.log('[RedisService] ✅ Redis clients disconnected successfully');
    } catch (error) {
      this.logger.error('Error disconnecting Redis clients', error);
      console.error('[RedisService] Error during disconnect:', error.message);
    }
  }

  /**
   * Check if Redis is connected and available
   */
  isRedisAvailable(): boolean {
    return this.isConnected;
  }

  // Cache operations
  /**
   * Set a value in Redis cache
   * Returns silently if Redis is not available
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] set() called but Redis not available - key: ${key}`,
      );
      return;
    }

    try {
      const serializedValue = JSON.stringify(value);
      if (ttl) {
        await this.client.setEx(key, ttl, serializedValue);
      } else {
        await this.client.set(key, serializedValue);
      }
      console.log(
        `[RedisService] ✅ Set cache key: ${key} (TTL: ${ttl || 'none'})`,
      );
    } catch (error) {
      this.logger.error(`Error setting cache key ${key}`, error);
      console.error(
        `[RedisService] ❌ Error setting key ${key}:`,
        error.message,
      );
    }
  }

  /**
   * Increment a key in Redis
   * Returns 0 if Redis is not available
   */
  async incr(key: string): Promise<number> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] incr() called but Redis not available - key: ${key}`,
      );
      return 0;
    }

    try {
      const result = await this.client.incr(key);
      console.log(`[RedisService] ✅ Incremented key: ${key} = ${result}`);
      return result;
    } catch (error) {
      this.logger.error(`Error incrementing key ${key}`, error);
      console.error(
        `[RedisService] ❌ Error incrementing key ${key}:`,
        error.message,
      );
      return 0;
    }
  }

  /**
   * Decrement a key in Redis
   * Returns 0 if Redis is not available
   */
  async decr(key: string): Promise<number> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] decr() called but Redis not available - key: ${key}`,
      );
      return 0;
    }

    try {
      const result = await this.client.decr(key);
      console.log(`[RedisService] ✅ Decremented key: ${key} = ${result}`);
      return result;
    } catch (error) {
      this.logger.error(`Error decrementing key ${key}`, error);
      console.error(
        `[RedisService] ❌ Error decrementing key ${key}:`,
        error.message,
      );
      return 0;
    }
  }

  /**
   * Set expiration time for a key
   * Returns silently if Redis is not available
   */
  async expire(key: string, seconds: number): Promise<void> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] expire() called but Redis not available - key: ${key}`,
      );
      return;
    }

    try {
      await this.client.expire(key, seconds);
      console.log(
        `[RedisService] ✅ Set expiration for key: ${key} (${seconds}s)`,
      );
    } catch (error) {
      this.logger.error(`Error setting expire for key ${key}`, error);
      console.error(
        `[RedisService] ❌ Error setting expire for key ${key}:`,
        error.message,
      );
    }
  }

  /**
   * Get a value from Redis cache
   * Returns null if Redis is not available or key doesn't exist
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] get() called but Redis not available - key: ${key}`,
      );
      return null;
    }

    try {
      const value = await this.client.get(key);
      const result = value ? JSON.parse(value) : null;
      console.log(
        `[RedisService] ${result ? '✅' : 'ℹ️'} Get cache key: ${key} - ${result ? 'HIT' : 'MISS'}`,
      );
      return result;
    } catch (error) {
      this.logger.error(`Error getting cache key ${key}`, error);
      console.error(
        `[RedisService] ❌ Error getting key ${key}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Delete a key from Redis
   * Returns silently if Redis is not available
   */
  async del(key: string): Promise<void> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] del() called but Redis not available - key: ${key}`,
      );
      return;
    }

    try {
      await this.client.del(key);
      console.log(`[RedisService] ✅ Deleted cache key: ${key}`);
    } catch (error) {
      this.logger.error(`Error deleting cache key ${key}`, error);
      console.error(
        `[RedisService] ❌ Error deleting key ${key}:`,
        error.message,
      );
    }
  }

  /**
   * Try to acquire a distributed lock with NX and PX (milliseconds TTL)
   * Returns false if Redis is not available or lock already held.
   */
  async tryAcquireLock(key: string, ttlMs: number): Promise<boolean> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] tryAcquireLock() called but Redis not available - key: ${key}`,
      );
      return false;
    }
    try {
      // @ts-ignore - pass extended options; redis client supports NX/PX
      const res = await (this.client as any).set(key, '1', {
        NX: true,
        PX: ttlMs,
      });
      const ok = res === 'OK';
      if (ok) {
        console.log(`[RedisService] ✅ Acquired lock: ${key} for ${ttlMs}ms`);
      } else {
        console.log(`[RedisService] 🔒 Lock busy: ${key}`);
      }
      return ok;
    } catch (error) {
      this.logger.error(`Error acquiring lock ${key}`, error);
      console.error(
        `[RedisService] ❌ Error acquiring lock ${key}:`,
        (error as any)?.message,
      );
      return false;
    }
  }

  /**
   * Get remaining TTL for a key in milliseconds. Returns -2 if key does not exist or Redis not available.
   */
  async pttl(key: string): Promise<number> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] pttl() called but Redis not available - key: ${key}`,
      );
      return -2;
    }
    try {
      // @ts-ignore - use pTTL API when available
      const ttlMs = await (this.client as any).pTTL?.(key);
      if (typeof ttlMs === 'number') {
        return ttlMs;
      }
      // Fallback to TTL seconds and convert
      const ttlSec = await this.client.ttl(key);
      return ttlSec >= 0 ? ttlSec * 1000 : ttlSec; // -1 no expire, -2 missing
    } catch (error) {
      this.logger.error(`Error reading TTL for key ${key}`, error);
      console.error(
        `[RedisService] ❌ Error reading TTL for key ${key}:`,
        (error as any)?.message,
      );
      return -2;
    }
  }

  /**
   * Check if a key exists in Redis
   * Returns false if Redis is not available
   */
  async exists(key: string): Promise<boolean> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] exists() called but Redis not available - key: ${key}`,
      );
      return false;
    }

    try {
      const result = await this.client.exists(key);
      const exists = result === 1;
      console.log(
        `[RedisService] ${exists ? '✅' : 'ℹ️'} Key exists check: ${key} = ${exists}`,
      );
      return exists;
    } catch (error) {
      this.logger.error(`Error checking cache key ${key}`, error);
      console.error(
        `[RedisService] ❌ Error checking key ${key}:`,
        error.message,
      );
      return false;
    }
  }

  // Hash operations for market data
  /**
   * Set a hash field in Redis
   * Returns silently if Redis is not available
   */
  async hset(key: string, field: string, value: any): Promise<void> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] hset() called but Redis not available - key: ${key}, field: ${field}`,
      );
      return;
    }

    try {
      const serializedValue = JSON.stringify(value);
      await this.client.hSet(key, field, serializedValue);
      console.log(`[RedisService] ✅ Set hash field: ${key}:${field}`);
    } catch (error) {
      this.logger.error(`Error setting hash field ${key}:${field}`, error);
      console.error(
        `[RedisService] ❌ Error setting hash field ${key}:${field}:`,
        error.message,
      );
    }
  }

  /**
   * Get a hash field from Redis
   * Returns null if Redis is not available or field doesn't exist
   */
  async hget<T>(key: string, field: string): Promise<T | null> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] hget() called but Redis not available - key: ${key}, field: ${field}`,
      );
      return null;
    }

    try {
      const value = await this.client.hGet(key, field);
      const result = value ? JSON.parse(value) : null;
      console.log(
        `[RedisService] ${result ? '✅' : 'ℹ️'} Get hash field: ${key}:${field} - ${result ? 'HIT' : 'MISS'}`,
      );
      return result;
    } catch (error) {
      this.logger.error(`Error getting hash field ${key}:${field}`, error);
      console.error(
        `[RedisService] ❌ Error getting hash field ${key}:${field}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Get all hash fields from Redis
   * Returns empty object if Redis is not available
   */
  async hgetall<T>(key: string): Promise<Record<string, T>> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] hgetall() called but Redis not available - key: ${key}`,
      );
      return {};
    }

    try {
      const hash = await this.client.hGetAll(key);
      const result: Record<string, T> = {};

      for (const [field, value] of Object.entries(hash)) {
        result[field] = JSON.parse(value);
      }

      console.log(
        `[RedisService] ✅ Get all hash fields: ${key} (${Object.keys(result).length} fields)`,
      );
      return result;
    } catch (error) {
      this.logger.error(`Error getting all hash fields ${key}`, error);
      console.error(
        `[RedisService] ❌ Error getting all hash fields ${key}:`,
        error.message,
      );
      return {};
    }
  }

  /**
   * Delete a hash field from Redis
   * Returns silently if Redis is not available
   */
  async hdel(key: string, field: string): Promise<void> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] hdel() called but Redis not available - key: ${key}, field: ${field}`,
      );
      return;
    }

    try {
      await this.client.hDel(key, field);
      console.log(`[RedisService] ✅ Deleted hash field: ${key}:${field}`);
    } catch (error) {
      this.logger.error(`Error deleting hash field ${key}:${field}`, error);
      console.error(
        `[RedisService] ❌ Error deleting hash field ${key}:${field}:`,
        error.message,
      );
    }
  }

  // List operations for market data streams
  /**
   * Push a value to the left of a Redis list
   * Returns silently if Redis is not available
   */
  async lpush(key: string, value: any): Promise<void> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] lpush() called but Redis not available - key: ${key}`,
      );
      return;
    }

    try {
      const serializedValue = JSON.stringify(value);
      await this.client.lPush(key, serializedValue);
      console.log(`[RedisService] ✅ Pushed to list: ${key}`);
    } catch (error) {
      this.logger.error(`Error pushing to list ${key}`, error);
      console.error(
        `[RedisService] ❌ Error pushing to list ${key}:`,
        error.message,
      );
    }
  }

  /**
   * Pop a value from the right of a Redis list
   * Returns null if Redis is not available or list is empty
   */
  async rpop<T>(key: string): Promise<T | null> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] rpop() called but Redis not available - key: ${key}`,
      );
      return null;
    }

    try {
      const value = await this.client.rPop(key);
      const result = value ? JSON.parse(value) : null;
      console.log(
        `[RedisService] ${result ? '✅' : 'ℹ️'} Popped from list: ${key} - ${result ? 'VALUE' : 'EMPTY'}`,
      );
      return result;
    } catch (error) {
      this.logger.error(`Error popping from list ${key}`, error);
      console.error(
        `[RedisService] ❌ Error popping from list ${key}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Get a range of values from a Redis list
   * Returns empty array if Redis is not available
   */
  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] lrange() called but Redis not available - key: ${key}`,
      );
      return [];
    }

    try {
      const values = await this.client.lRange(key, start, stop);
      const result = values.map((value) => JSON.parse(value));
      console.log(
        `[RedisService] ✅ Get list range: ${key} [${start}:${stop}] (${result.length} items)`,
      );
      return result;
    } catch (error) {
      this.logger.error(`Error getting list range ${key}`, error);
      console.error(
        `[RedisService] ❌ Error getting list range ${key}:`,
        error.message,
      );
      return [];
    }
  }

  // Pub/Sub operations
  /**
   * Publish a message to a Redis channel
   * Returns silently if Redis is not available
   */
  async publish(channel: string, message: any): Promise<void> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] publish() called but Redis not available - channel: ${channel}`,
      );
      return;
    }

    try {
      const serializedMessage = JSON.stringify(message);
      await this.publisher.publish(channel, serializedMessage);
      console.log(`[RedisService] ✅ Published to channel: ${channel}`);
    } catch (error) {
      this.logger.error(`Error publishing to channel ${channel}`, error);
      console.error(
        `[RedisService] ❌ Error publishing to channel ${channel}:`,
        error.message,
      );
    }
  }

  /**
   * Subscribe to a Redis channel
   * Returns silently if Redis is not available
   */
  async subscribe(
    channel: string,
    callback: (message: any) => void,
  ): Promise<void> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] subscribe() called but Redis not available - channel: ${channel}`,
      );
      return;
    }

    try {
      await this.subscriber.subscribe(channel, (message) => {
        try {
          const parsedMessage = JSON.parse(message);
          callback(parsedMessage);
          console.log(
            `[RedisService] ✅ Received message from channel: ${channel}`,
          );
        } catch (error) {
          this.logger.error(
            `Error parsing message from channel ${channel}`,
            error,
          );
          console.error(
            `[RedisService] ❌ Error parsing message from channel ${channel}:`,
            error.message,
          );
        }
      });
      console.log(`[RedisService] ✅ Subscribed to channel: ${channel}`);
    } catch (error) {
      this.logger.error(`Error subscribing to channel ${channel}`, error);
      console.error(
        `[RedisService] ❌ Error subscribing to channel ${channel}:`,
        error.message,
      );
    }
  }

  /**
   * Unsubscribe from a Redis channel
   * Returns silently if Redis is not available
   */
  async unsubscribe(channel: string): Promise<void> {
    if (!this.isConnected) {
      console.log(
        `[RedisService] unsubscribe() called but Redis not available - channel: ${channel}`,
      );
      return;
    }

    try {
      await this.subscriber.unsubscribe(channel);
      console.log(`[RedisService] ✅ Unsubscribed from channel: ${channel}`);
    } catch (error) {
      this.logger.error(`Error unsubscribing from channel ${channel}`, error);
      console.error(
        `[RedisService] ❌ Error unsubscribing from channel ${channel}:`,
        error.message,
      );
    }
  }

  // Market data specific methods
  /**
   * Cache market data for an instrument
   * Returns silently if Redis is not available
   */
  async cacheMarketData(
    instrumentToken: number,
    data: any,
    ttl: number = 60,
  ): Promise<void> {
    console.log(
      `[RedisService] Caching market data for instrument: ${instrumentToken}`,
    );
    const key = `market_data:${instrumentToken}`;
    await this.set(key, data, ttl);
  }

  /**
   * Get cached market data for an instrument
   * Returns null if Redis is not available or data is not cached
   */
  async getCachedMarketData(instrumentToken: number): Promise<any> {
    console.log(
      `[RedisService] Retrieving cached market data for instrument: ${instrumentToken}`,
    );
    const key = `market_data:${instrumentToken}`;
    return await this.get(key);
  }

  /**
   * Cache quote data for multiple tokens
   * Returns silently if Redis is not available
   */
  async cacheQuote(
    tokens: string[],
    data: any,
    ttl: number = 30,
  ): Promise<void> {
    console.log(`[RedisService] Caching quote for tokens: ${tokens.join(',')}`);
    const key = `quotes:${tokens.join(',')}`;
    await this.set(key, data, ttl);
  }

  /**
   * Get cached quote data for multiple tokens
   * Returns null if Redis is not available or data is not cached
   */
  async getCachedQuote(tokens: string[]): Promise<any> {
    console.log(
      `[RedisService] Retrieving cached quote for tokens: ${tokens.join(',')}`,
    );
    const key = `quotes:${tokens.join(',')}`;
    return await this.get(key);
  }
}
