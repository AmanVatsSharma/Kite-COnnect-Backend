import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../../services/redis.service';

@Injectable()
export class FalconAuthService {
  private readonly logger = new Logger(FalconAuthService.name);

  constructor(private redis: RedisService) {}

  async cacheAccessToken(token: string, ttlSeconds = 24 * 3600) {
    try {
      await this.redis.set('kite:access_token', token, ttlSeconds);
      this.logger.log(`[FalconAuthService] Cached access token with TTL=${ttlSeconds}s`);
    } catch (e) {
      this.logger.error('[FalconAuthService] Failed caching access token', e as any);
    }
  }
}


