import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

function generateRequestId(): string {
  try {
    // Fast, low-collision ID: timestamp + random
    const ts = Date.now().toString(36);
    const rnd = Math.floor(Math.random() * 1e9).toString(36);
    return `${ts}-${rnd}`;
  } catch {
    return `${Date.now()}`;
  }
}

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const incoming = (req?.headers?.['x-request-id'] as string) || (req?.headers?.['x-correlation-id'] as string);
    const id = incoming || generateRequestId();
    (req as any).requestId = id;
    try { res.setHeader('x-request-id', id); } catch {}
    return next.handle().pipe(
      tap({
        next: () => {
          try { res.setHeader('x-request-id', id); } catch {}
        },
        error: () => {
          try { res.setHeader('x-request-id', id); } catch {}
        },
      })
    );
  }
}


