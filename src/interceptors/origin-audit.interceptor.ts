import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { OriginAuditService } from '../services/origin-audit.service';

/**
 * OriginAuditInterceptor
 *
 * Captures per-request origin metadata (API key, IP, UA, route, status, latency)
 * and forwards it to OriginAuditService for batched persistence.
 */
@Injectable()
export class OriginAuditInterceptor implements NestInterceptor {
  constructor(private readonly originAudit: OriginAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest();

    const start = Date.now();
    const method: string = req?.method || 'UNKNOWN';
    const route: string =
      (req?.route && req.route.path) || req?.url || 'unknown';

    const { apiKey, apiKeyId, tenantId } = this.extractApiKeyContext(req);
    const { ip, userAgent, origin } = this.extractOriginContext(req);

    return next.handle().pipe(
      tap({
        next: () => {
          const res = httpCtx.getResponse();
          const status: number = res?.statusCode || 200;
          const durationMs = Date.now() - start;
          this.originAudit
            .recordHttp({
              apiKey,
              apiKeyId,
              tenantId,
              route,
              method,
              status,
              ip,
              userAgent,
              origin,
              durationMs,
              // Placeholder for future geo/ASN enrichment
              country: null,
              asn: null,
            })
            .catch(() => {
              // Errors are already logged inside the service; ignore here.
            });
        },
        error: () => {
          const res = httpCtx.getResponse();
          const status: number = res?.statusCode || 500;
          const durationMs = Date.now() - start;
          this.originAudit
            .recordHttp({
              apiKey,
              apiKeyId,
              tenantId,
              route,
              method,
              status,
              ip,
              userAgent,
              origin,
              durationMs,
              country: null,
              asn: null,
            })
            .catch(() => {
              // Errors are already logged inside the service; ignore here.
            });
        },
      }),
    );
  }

  private extractApiKeyContext(req: any): {
    apiKey: string | null;
    apiKeyId: number | null;
    tenantId: string | null;
  } {
    try {
      const headerKey =
        (req?.headers?.['x-api-key'] as string) ||
        (req?.headers?.['X-API-KEY'] as string) ||
        '';
      const queryKey =
        (req?.query?.['api_key'] as string) ||
        (req?.query?.['apikey'] as string) ||
        '';
      const apiKey = (headerKey || queryKey || '').toString() || null;

      const tenantId =
        (req?.tenant && (req.tenant.id as string)) ||
        (req?.tenant_id as string) ||
        null;
      const apiKeyId =
        (req?.tenant && (req.tenant.apiKeyId as number)) || null;

      return { apiKey, apiKeyId, tenantId };
    } catch {
      return { apiKey: null, apiKeyId: null, tenantId: null };
    }
  }

  private extractOriginContext(req: any): {
    ip: string | null;
    userAgent: string | null;
    origin: string | null;
  } {
    try {
      const xfwd = req?.headers?.['x-forwarded-for'] as
        | string
        | string[]
        | undefined;
      let ip: string | null = null;
      if (Array.isArray(xfwd)) {
        ip = xfwd[0];
      } else if (typeof xfwd === 'string' && xfwd.length > 0) {
        ip = xfwd.split(',')[0]?.trim() || null;
      }
      if (!ip) {
        ip =
          (req?.ip as string) ||
          (req?.connection?.remoteAddress as string) ||
          (req?.socket?.remoteAddress as string) ||
          null;
      }

      const userAgent =
        (req?.headers?.['user-agent'] as string) ||
        (req?.headers?.['User-Agent'] as string) ||
        null;
      const originHeader =
        (req?.headers?.origin as string) ||
        (req?.headers?.Origin as string) ||
        (req?.headers?.referer as string) ||
        (req?.headers?.Referer as string) ||
        null;

      return {
        ip: ip || null,
        userAgent: userAgent || null,
        origin: originHeader || null,
      };
    } catch {
      return { ip: null, userAgent: null, origin: null };
    }
  }
}


