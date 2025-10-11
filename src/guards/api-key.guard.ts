import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, TooManyRequestsException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../entities/api-key.entity';
import { RedisService } from '../services/redis.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    private redisService: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const apiKey = req.headers['x-api-key'] || req.query['api_key'];
    if (!apiKey || typeof apiKey !== 'string') {
      throw new UnauthorizedException('Missing x-api-key');
    }

    const keyRecord = await this.apiKeyRepo.findOne({ where: { key: apiKey, is_active: true } });
    if (!keyRecord) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Rate limit per minute using Redis token bucket
    const bucketKey = `ratelimit:${apiKey}:${new Date().getUTCFullYear()}${new Date().getUTCMonth()}${new Date().getUTCDate()}${new Date().getUTCHours()}${new Date().getUTCMinutes()}`;
    const current = (await this.redisService.get<number>(bucketKey)) || 0;
    if (current >= keyRecord.rate_limit_per_minute) {
      throw new TooManyRequestsException('Rate limit exceeded');
    }

    await this.redisService.set(bucketKey, current + 1, 65); // expire slightly > 1 minute

    // Attach tenant to request
    req.tenant = { id: keyRecord.tenant_id, apiKeyId: keyRecord.id };

    return true;
  }
}
