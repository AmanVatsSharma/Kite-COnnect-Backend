import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../entities/api-key.entity';
import { ApiKeyService } from '../services/api-key.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    private apiKeyService: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const apiKey = req.headers['x-api-key'] || req.query['api_key'];
    if (!apiKey || typeof apiKey !== 'string') {
      throw new UnauthorizedException('Missing x-api-key');
    }

    const keyRecord = await this.apiKeyRepo.findOne({
      where: { key: apiKey, is_active: true },
    });
    if (!keyRecord) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Per-API-key HTTP rate limiting via ApiKeyService (Redis-backed).
    try {
      await this.apiKeyService.incrementHttpUsage(
        apiKey,
        keyRecord.rate_limit_per_minute,
      );
    } catch (err) {
      if (err instanceof Error && err.message === 'Rate limit exceeded') {
        // Structured error for callers + logs for debugging.
        this.logger.warn(
          `Per-API-key HTTP rate limit exceeded for key=${apiKey} tenant=${keyRecord.tenant_id}`,
        );
        // eslint-disable-next-line no-console
        console.log(
          '[ApiKeyGuard] HTTP rate limit exceeded',
          JSON.stringify({
            apiKey,
            tenant_id: keyRecord.tenant_id,
            limitPerMinute: keyRecord.rate_limit_per_minute,
          }),
        );
        throw new BadRequestException({
          success: false,
          code: 'rate_limit_exceeded',
          message: 'Rate limit exceeded for this API key',
          limit_per_minute: keyRecord.rate_limit_per_minute,
        });
      }
      // Any infra errors from the limiter should not block the request.
      this.logger.warn(
        `Failed to enforce per-API-key HTTP rate limit for key=${apiKey} – continuing without throttling`,
        err as any,
      );
      // eslint-disable-next-line no-console
      console.error(
        '[ApiKeyGuard] Failed to enforce HTTP rate limit – continuing without throttling',
        {
          apiKey,
          tenant_id: keyRecord.tenant_id,
          error: (err as any)?.message ?? err,
        },
      );
    }

    // Attach tenant to request
    req.tenant = { id: keyRecord.tenant_id, apiKeyId: keyRecord.id };

    return true;
  }
}
