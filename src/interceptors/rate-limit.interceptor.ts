import { CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../services/redis.service';

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly windowSec: number;
  private readonly perKeyLimit: number;
  private readonly perIpLimit: number;

  constructor(private readonly redis: RedisService, private readonly config: ConfigService) {
    this.windowSec = Number(config.get('RATE_LIMIT_WINDOW_SEC', 60));
    this.perKeyLimit = Number(config.get('RATE_LIMIT_PER_KEY', 180));
    this.perIpLimit = Number(config.get('RATE_LIMIT_PER_IP', 360));
  }

  async guardRequest(req: any): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const windowStart = now - (now % this.windowSec);
      const route = (req?.route?.path || req?.url || 'unknown').replace(/[^a-zA-Z0-9:_/-]/g, '');
      const ip = (req?.ip || req?.connection?.remoteAddress || 'unknown').toString();
      const apiKey = (req?.headers?.['x-api-key'] || req?.query?.['api_key'] || 'anonymous').toString();

      // Per API key limit
      const keyCounter = `rate:key:${apiKey}:${route}:${windowStart}`;
      const keyCount = await this.redis.incr(keyCounter);
      if (keyCount === 1) await this.redis.expire(keyCounter, this.windowSec);
      if (this.perKeyLimit > 0 && keyCount > this.perKeyLimit) {
        throw new HttpException(
          {
            success: false,
            message: 'Too many requests for this API key',
            limit: this.perKeyLimit,
            window_sec: this.windowSec,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Per IP limit
      const ipCounter = `rate:ip:${ip}:${route}:${windowStart}`;
      const ipCount = await this.redis.incr(ipCounter);
      if (ipCount === 1) await this.redis.expire(ipCounter, this.windowSec);
      if (this.perIpLimit > 0 && ipCount > this.perIpLimit) {
        throw new HttpException(
          {
            success: false,
            message: 'Too many requests from this IP',
            limit: this.perIpLimit,
            window_sec: this.windowSec,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // If Redis not available or error occurred, do not block the request
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    return from(this.guardRequest(req)).pipe(mergeMap(() => next.handle()));
  }
}


