import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Redis from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis.RedisClientType;
  private subscriber: Redis.RedisClientType;
  private publisher: Redis.RedisClientType;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.initializeRedis();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private async initializeRedis() {
    try {
      const redisConfig = {
        host: this.configService.get('REDIS_HOST', 'localhost'),
        port: this.configService.get('REDIS_PORT', 6379),
        password: this.configService.get('REDIS_PASSWORD', ''),
        db: 0,
      };

      // Create main client
      this.client = Redis.createClient(redisConfig);
      
      // Create subscriber client
      this.subscriber = Redis.createClient(redisConfig);
      
      // Create publisher client
      this.publisher = Redis.createClient(redisConfig);

      // Connect all clients
      await Promise.all([
        this.client.connect(),
        this.subscriber.connect(),
        this.publisher.connect(),
      ]);

      this.logger.log('Redis clients connected successfully');
    } catch (error) {
      this.logger.error('Failed to connect to Redis', error);
      throw error;
    }
  }

  async disconnect() {
    try {
      await Promise.all([
        this.client?.disconnect(),
        this.subscriber?.disconnect(),
        this.publisher?.disconnect(),
      ]);
      this.logger.log('Redis clients disconnected');
    } catch (error) {
      this.logger.error('Error disconnecting Redis clients', error);
    }
  }

  // Cache operations
  async set(key: string, value: any, ttl?: number): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value);
      if (ttl) {
        await this.client.setEx(key, ttl, serializedValue);
      } else {
        await this.client.set(key, serializedValue);
      }
    } catch (error) {
      this.logger.error(`Error setting cache key ${key}`, error);
      throw error;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      this.logger.error(`Error getting cache key ${key}`, error);
      return null;
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.error(`Error deleting cache key ${key}`, error);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      this.logger.error(`Error checking cache key ${key}`, error);
      return false;
    }
  }

  // Hash operations for market data
  async hset(key: string, field: string, value: any): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value);
      await this.client.hSet(key, field, serializedValue);
    } catch (error) {
      this.logger.error(`Error setting hash field ${key}:${field}`, error);
      throw error;
    }
  }

  async hget<T>(key: string, field: string): Promise<T | null> {
    try {
      const value = await this.client.hGet(key, field);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      this.logger.error(`Error getting hash field ${key}:${field}`, error);
      return null;
    }
  }

  async hgetall<T>(key: string): Promise<Record<string, T>> {
    try {
      const hash = await this.client.hGetAll(key);
      const result: Record<string, T> = {};
      
      for (const [field, value] of Object.entries(hash)) {
        result[field] = JSON.parse(value);
      }
      
      return result;
    } catch (error) {
      this.logger.error(`Error getting all hash fields ${key}`, error);
      return {};
    }
  }

  async hdel(key: string, field: string): Promise<void> {
    try {
      await this.client.hDel(key, field);
    } catch (error) {
      this.logger.error(`Error deleting hash field ${key}:${field}`, error);
      throw error;
    }
  }

  // List operations for market data streams
  async lpush(key: string, value: any): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value);
      await this.client.lPush(key, serializedValue);
    } catch (error) {
      this.logger.error(`Error pushing to list ${key}`, error);
      throw error;
    }
  }

  async rpop<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.rPop(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      this.logger.error(`Error popping from list ${key}`, error);
      return null;
    }
  }

  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    try {
      const values = await this.client.lRange(key, start, stop);
      return values.map(value => JSON.parse(value));
    } catch (error) {
      this.logger.error(`Error getting list range ${key}`, error);
      return [];
    }
  }

  // Pub/Sub operations
  async publish(channel: string, message: any): Promise<void> {
    try {
      const serializedMessage = JSON.stringify(message);
      await this.publisher.publish(channel, serializedMessage);
    } catch (error) {
      this.logger.error(`Error publishing to channel ${channel}`, error);
      throw error;
    }
  }

  async subscribe(channel: string, callback: (message: any) => void): Promise<void> {
    try {
      await this.subscriber.subscribe(channel, (message) => {
        try {
          const parsedMessage = JSON.parse(message);
          callback(parsedMessage);
        } catch (error) {
          this.logger.error(`Error parsing message from channel ${channel}`, error);
        }
      });
    } catch (error) {
      this.logger.error(`Error subscribing to channel ${channel}`, error);
      throw error;
    }
  }

  async unsubscribe(channel: string): Promise<void> {
    try {
      await this.subscriber.unsubscribe(channel);
    } catch (error) {
      this.logger.error(`Error unsubscribing from channel ${channel}`, error);
      throw error;
    }
  }

  // Market data specific methods
  async cacheMarketData(instrumentToken: number, data: any, ttl: number = 60): Promise<void> {
    const key = `market_data:${instrumentToken}`;
    await this.set(key, data, ttl);
  }

  async getCachedMarketData(instrumentToken: number): Promise<any> {
    const key = `market_data:${instrumentToken}`;
    return await this.get(key);
  }

  async cacheQuote(tokens: string[], data: any, ttl: number = 30): Promise<void> {
    const key = `quotes:${tokens.join(',')}`;
    await this.set(key, data, ttl);
  }

  async getCachedQuote(tokens: string[]): Promise<any> {
    const key = `quotes:${tokens.join(',')}`;
    return await this.get(key);
  }
}
