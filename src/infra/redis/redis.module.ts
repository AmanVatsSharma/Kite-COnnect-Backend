/**
 * File:        src/infra/redis/redis.module.ts
 * Module:      infra/redis
 * Purpose:     Global Redis module that provides all Redis infrastructure services
 *
 * Exports:
 *   - RedisClientFactory    — named ioredis client factory (5 clients)
 *   - RedisService          — cache/pubsub/lock operations with circuit breaker
 *   - RedisHealthIndicator  — PING-based health check with latency
 *
 * Depends on:
 *   - ConfigModule          — env var access for all Redis services
 *
 * Side-effects:
 *   - Factory opens up to 5 TCP connections to Redis on module init
 *
 * Key invariants:
 *   - @Global() — all exports available everywhere without explicit imports
 *   - RedisClientFactory initialized before RedisService (NestJS DI handles ordering)
 *
 * Read order:
 *   1. providers  — instantiation order
 *   2. exports    — what other modules can inject
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-19
 */
import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisClientFactory } from './redis-client.factory';
import { RedisService } from './redis.service';
import { RedisHealthIndicator } from './redis-health.indicator';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisClientFactory, RedisService, RedisHealthIndicator],
  exports: [RedisClientFactory, RedisService, RedisHealthIndicator],
})
export class RedisModule {}
