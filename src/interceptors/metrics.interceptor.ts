import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from '../services/metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const method = req?.method || 'UNKNOWN';
    const route = req?.route?.path || req?.url || 'unknown';
    const apiKeyLabel = this.extractApiKeyLabel(req);
    const countryLabel = 'unknown'; // Placeholder until GeoIP enrichment is added
    const start = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse();
          const status = res?.statusCode || 200;
          const duration = Number(process.hrtime.bigint() - start) / 1e9;
          try {
            this.metrics.httpRequestsTotal
              .labels(method, route, String(status))
              .inc();
            this.metrics.httpRequestDuration
              .labels(method, route, String(status))
              .observe(duration);
            this.metrics.httpRequestsByApiKeyTotal
              .labels(apiKeyLabel, route)
              .inc();
            this.metrics.httpRequestsByCountryTotal
              .labels(countryLabel, route)
              .inc();
          } catch {
            // Metrics must never break the request path
          }
        },
        error: () => {
          const res = context.switchToHttp().getResponse();
          const status = res?.statusCode || 500;
          const duration = Number(process.hrtime.bigint() - start) / 1e9;
          try {
            this.metrics.httpRequestsTotal
              .labels(method, route, String(status))
              .inc();
            this.metrics.httpRequestDuration
              .labels(method, route, String(status))
              .observe(duration);
            this.metrics.httpRequestsByApiKeyTotal
              .labels(apiKeyLabel, route)
              .inc();
            this.metrics.httpRequestsByCountryTotal
              .labels(countryLabel, route)
              .inc();
          } catch {
            // Ignore metrics errors
          }
        },
      }),
    );
  }

  private extractApiKeyLabel(req: any): string {
    try {
      const headerKey =
        (req?.headers?.['x-api-key'] as string) ||
        (req?.headers?.['X-API-KEY'] as string) ||
        '';
      const queryKey =
        (req?.query?.['api_key'] as string) ||
        (req?.query?.['apikey'] as string) ||
        '';
      const raw = (headerKey || queryKey || '').toString();
      if (!raw) return 'none';
      // Truncate to first 12 chars to keep label cardinality manageable.
      return raw.length > 12 ? `${raw.slice(0, 12)}…` : raw;
    } catch {
      return 'none';
    }
  }
}
