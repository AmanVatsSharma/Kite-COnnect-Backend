/**
 * File:        src/infra/adapters/redis-io.adapter.ts
 * Module:      infra/adapters
 * Purpose:     Socket.IO WebSocket adapter that wires distributed Redis pub/sub from RedisClientFactory. Falls back to single-node in-memory mode when Redis is unavailable or not configured.
 *
 * Exports:
 *   - RedisIoAdapter  — IoAdapter subclass; instantiated in main.ts bootstrap
 *
 * Depends on:
 *   - RedisClientFactory          — provides io-adapter-pub/sub named ioredis clients
 *   - @socket.io/redis-adapter    — createAdapter (standard/sentinel), createShardedAdapter (cluster)
 *
 * Side-effects:
 *   - Attaches Redis pub/sub adapter to Socket.IO server on createIOServer()
 *
 * Key invariants:
 *   - app.get(RedisClientFactory) is safe after NestFactory.create() completes
 *   - Cluster mode uses createShardedAdapter (SSUBSCRIBE-based, sharding-safe)
 *   - Does NOT create or own any Redis clients — all managed by factory
 *   - Falls back to single-node mode silently if Redis unavailable
 *
 * Read order:
 *   1. constructor — receives NestJS app context
 *   2. connectToRedis() — called by main.ts before app.listen()
 *   3. createIOServer() — called by Socket.IO framework
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-19
 */
import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { RedisClientFactory } from '@infra/redis/redis-client.factory';
import { Redis } from 'ioredis';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: any = null;

  constructor(private readonly app: INestApplicationContext) {
    super(app as any);
  }

  async connectToRedis(): Promise<void> {
    try {
      const factory = this.app.get(RedisClientFactory);

      if (!factory.isConfigured()) {
        this.logger.warn(
          '[RedisIoAdapter] Redis not configured — Socket.IO running in single-node mode',
        );
        return;
      }

      const pub = factory.getClient('io-adapter-pub') as Redis | null;
      const sub = factory.getClient('io-adapter-sub') as Redis | null;

      if (!pub || !sub || pub.status !== 'ready' || sub.status !== 'ready') {
        this.logger.warn(
          '[RedisIoAdapter] io-adapter clients not ready — Socket.IO running in single-node mode',
        );
        return;
      }

      if (factory.getMode() === 'cluster') {
        const { createShardedAdapter } = await import('@socket.io/redis-adapter');
        this.adapterConstructor = createShardedAdapter(pub as any, sub as any);
        this.logger.log('[RedisIoAdapter] Socket.IO sharded Redis adapter configured (cluster mode)');
      } else {
        this.adapterConstructor = createAdapter(pub as any, sub as any);
        this.logger.log('[RedisIoAdapter] Socket.IO Redis adapter configured');
      }
    } catch (err: any) {
      this.logger.warn(
        `[RedisIoAdapter] Failed to configure Redis adapter: ${err.message} — Socket.IO in single-node mode`,
      );
      this.adapterConstructor = null;
    }
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}

