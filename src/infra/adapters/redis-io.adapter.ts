import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger } from '@nestjs/common';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;

  async connectToRedis(): Promise<void> {
    try {
      const url = `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
      const pubClient = createClient({ url, socket: { family: 4 } });
      const subClient = pubClient.duplicate();

      pubClient.on('error', (err) => this.logger.warn(`[RedisIoAdapter] pub error: ${err.message}`));
      subClient.on('error', (err) => this.logger.warn(`[RedisIoAdapter] sub error: ${err.message}`));

      await Promise.race([
        Promise.all([pubClient.connect(), subClient.connect()]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connect timeout')), 5000)),
      ]);

      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log('[RedisIoAdapter] Socket.IO Redis adapter connected');
    } catch (err: any) {
      this.logger.warn(
        `[RedisIoAdapter] Redis unavailable (${err.message}) — Socket.IO running without distributed adapter (single-node mode)`,
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

