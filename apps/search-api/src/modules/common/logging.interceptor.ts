import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('LoggingInterceptor');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const start = Date.now();
    const path = `${req.method} ${req.url}`;

    // Console for easy later debugging
    // eslint-disable-next-line no-console
    console.log(`[REQ] ${path}`);

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - start;
          this.logger.log(`[RES] ${path} ${ms}ms`);
        },
        error: (err) => {
          const ms = Date.now() - start;
          this.logger.error(`[ERR] ${path} ${ms}ms :: ${err?.message}`);
        },
      }),
    );
  }
}


