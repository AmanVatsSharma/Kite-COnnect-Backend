import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RequestAuditLog } from '../entities/request-audit-log.entity';

interface HttpAuditParams {
  apiKey?: string | null;
  apiKeyId?: number | null;
  tenantId?: string | null;
  route: string;
  method: string;
  status: number;
  ip?: string | null;
  userAgent?: string | null;
  origin?: string | null;
  durationMs?: number | null;
  country?: string | null;
  asn?: string | null;
  meta?: any;
}

interface WsAuditParams {
  apiKey?: string | null;
  apiKeyId?: number | null;
  tenantId?: string | null;
  event: string;
  status?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  origin?: string | null;
  durationMs?: number | null;
  country?: string | null;
  asn?: string | null;
  meta?: any;
}

/**
 * OriginAuditService
 *
 * Central service to record lightweight audit events for HTTP and WebSocket
 * traffic. Uses a simple in-memory buffer + batch flush to Postgres to
 * minimize per-request overhead.
 */
@Injectable()
export class OriginAuditService {
  private readonly logger = new Logger(OriginAuditService.name);

  private buffer: Partial<RequestAuditLog>[] = [];
  private flushScheduled = false;

  // Basic safety limits
  private readonly maxBufferSize = 1000;
  private readonly flushIntervalMs = 1000;

  constructor(
    @InjectRepository(RequestAuditLog)
    private readonly auditRepo: Repository<RequestAuditLog>,
  ) {}

  /**
   * Public helper for HTTP audits (fire-and-forget from interceptors).
   */
  async recordHttp(params: HttpAuditParams): Promise<void> {
    try {
      const entry: Partial<RequestAuditLog> = {
        kind: 'http',
        route_or_event: params.route,
        method: params.method,
        status: params.status,
        api_key: params.apiKey || null,
        api_key_id: params.apiKeyId ?? null,
        tenant_id: params.tenantId || null,
        ip: params.ip || null,
        user_agent: params.userAgent || null,
        origin: params.origin || null,
        country: params.country || null,
        asn: params.asn || null,
        duration_ms:
          typeof params.durationMs === 'number'
            ? Math.round(params.durationMs)
            : null,
        meta: params.meta ?? null,
      };
      this.enqueue(entry);
    } catch (e) {
      // Console for easy later debugging, but never block the request path
      // eslint-disable-next-line no-console
      console.error('[OriginAuditService] Failed to enqueue HTTP audit', {
        error: (e as any)?.message ?? e,
      });
    }
  }

  /**
   * Public helper for WebSocket connection / event audits.
   */
  async recordWsEvent(params: WsAuditParams): Promise<void> {
    try {
      const entry: Partial<RequestAuditLog> = {
        kind: 'ws',
        route_or_event: params.event,
        method: null,
        status: params.status ?? null,
        api_key: params.apiKey || null,
        api_key_id: params.apiKeyId ?? null,
        tenant_id: params.tenantId || null,
        ip: params.ip || null,
        user_agent: params.userAgent || null,
        origin: params.origin || null,
        country: params.country || null,
        asn: params.asn || null,
        duration_ms:
          typeof params.durationMs === 'number'
            ? Math.round(params.durationMs)
            : null,
        meta: params.meta ?? null,
      };
      this.enqueue(entry);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[OriginAuditService] Failed to enqueue WS audit', {
        error: (e as any)?.message ?? e,
      });
    }
  }

  /**
   * Add an entry to the in-memory buffer and schedule a batch flush.
   */
  private enqueue(entry: Partial<RequestAuditLog>): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.maxBufferSize) {
      // Flush immediately when buffer is full
      this.flushSoon(0);
    } else if (!this.flushScheduled) {
      this.flushSoon(this.flushIntervalMs);
    }
  }

  /**
   * Schedule a flush, ensuring only one timer is active.
   */
  private flushSoon(delayMs: number): void {
    this.flushScheduled = true;
    setTimeout(() => {
      this.flush()
        .catch((err) => {
          this.logger.warn(
            '[OriginAuditService] Flush failed; entries will be retried on next flush',
            err as any,
          );
          // Console for easy later debugging
          // eslint-disable-next-line no-console
          console.error(
            '[OriginAuditService] Flush error',
            (err as any)?.message ?? err,
          );
        })
        .finally(() => {
          this.flushScheduled = false;
          // If new items arrived during flush, schedule another round.
          if (this.buffer.length > 0) {
            this.flushSoon(this.flushIntervalMs);
          }
        });
    }, Math.max(0, delayMs));
  }

  /**
   * Flush buffered entries to Postgres in a single batch.
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Take a snapshot and clear buffer first to minimize contention
    const batch = this.buffer;
    this.buffer = [];

    try {
      const entities = batch.map((e) => this.auditRepo.create(e));
      await this.auditRepo.save(entities, { chunk: 100 });
      // eslint-disable-next-line no-console
      console.log(
        '[OriginAuditService] Flushed audit batch',
        JSON.stringify({ count: entities.length }),
      );
    } catch (e) {
      // On failure, re-queue entries (best-effort) so they are retried later.
      this.buffer.unshift(...batch);
      this.logger.warn(
        '[OriginAuditService] Failed to save audit batch; will retry',
        e as any,
      );
      // eslint-disable-next-line no-console
      console.error(
        '[OriginAuditService] Error saving audit batch',
        (e as any)?.message ?? e,
      );
    }
  }
}


