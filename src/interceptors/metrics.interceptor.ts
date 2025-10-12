import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
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
    const start = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse();
          const status = res?.statusCode || 200;
          const duration = Number(process.hrtime.bigint() - start) / 1e9;
          this.metrics.httpRequestsTotal.labels(method, route, String(status)).inc();
          this.metrics.httpRequestDuration.labels(method, route, String(status)).observe(duration);
        },
        error: () => {
          const res = context.switchToHttp().getResponse();
          const status = res?.statusCode || 500;
          const duration = Number(process.hrtime.bigint() - start) / 1e9;
          this.metrics.httpRequestsTotal.labels(method, route, String(status)).inc();
          this.metrics.httpRequestDuration.labels(method, route, String(status)).observe(duration);
        },
      }),
    );
  }
}
