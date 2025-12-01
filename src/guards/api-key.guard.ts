import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from '../entities/api-key.entity';
import { ApiKeyService } from '../services/api-key.service';
import { AbuseDetectionService } from '../services/abuse-detection.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    private apiKeyService: ApiKeyService,
    private abuseDetection: AbuseDetectionService,
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

    // Strict abuse / resell enforcement: block keys marked as abusive.
    try {
      const status = await this.abuseDetection.getStatusForApiKey(apiKey);
      if (status?.blocked) {
        this.logger.warn(
          `Blocked API key used on REST route; key=${apiKey} risk_score=${status.risk_score}`,
        );
        // eslint-disable-next-line no-console
        console.log('[ApiKeyGuard] Blocked API key rejected', {
          apiKey,
          tenant_id: keyRecord.tenant_id,
          risk_score: status.risk_score,
          reasons: status.reason_codes,
        });
        throw new ForbiddenException({
          success: false,
          code: 'key_blocked_for_abuse',
          message:
            'This API key has been blocked due to suspected reselling or abusive usage. Contact support for review.',
          risk_score: status.risk_score,
          reasons: status.reason_codes,
        });
      }
    } catch (e) {
      if (e instanceof ForbiddenException) {
        throw e;
      }
      this.logger.warn(
        `Abuse detection check failed for key=${apiKey}; continuing request`,
        e as any,
      );
      // eslint-disable-next-line no-console
      console.error(
        '[ApiKeyGuard] Abuse detection check failed – continuing',
        {
          apiKey,
          tenant_id: keyRecord.tenant_id,
          error: (e as any)?.message ?? e,
        },
      );
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
