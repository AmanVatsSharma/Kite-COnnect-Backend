import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { RequestAuditLog } from '../entities/request-audit-log.entity';
import { ConfigService } from '@nestjs/config';

/**
 * AuditCleanupCronService
 *
 * Periodically purges old rows from request_audit_logs based on a retention
 * window (in days) controlled via AUDIT_LOG_RETENTION_DAYS env (default: 90).
 *
 * This keeps the audit table bounded while still providing enough history
 * for abuse detection and forensic analysis.
 */
@Injectable()
export class AuditCleanupCronService {
  private readonly logger = new Logger(AuditCleanupCronService.name);

  private readonly retentionDays: number;

  constructor(
    @InjectRepository(RequestAuditLog)
    private readonly auditRepo: Repository<RequestAuditLog>,
    private readonly configService: ConfigService,
  ) {
    const raw = Number(
      this.configService.get('AUDIT_LOG_RETENTION_DAYS', '90'),
    );
    this.retentionDays = Number.isFinite(raw) && raw > 0 ? raw : 90;
    // eslint-disable-next-line no-console
    console.log(
      '[AuditCleanupCronService] Initialized with retentionDays=',
      this.retentionDays,
    );
  }

  /**
   * Run once per day at 04:00 server time.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanupOldAudits(): Promise<void> {
    try {
      const cutoff = new Date(
        Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
      );
      const result = await this.auditRepo.delete({
        ts: LessThan(cutoff),
      });

      this.logger.log(
        `Audit log cleanup complete. retentionDays=${this.retentionDays}, deleted=${result.affected || 0}`,
      );
      // eslint-disable-next-line no-console
      console.log('[AuditCleanupCronService] Cleanup summary', {
        retentionDays: this.retentionDays,
        deleted: result.affected || 0,
      });
    } catch (e) {
      this.logger.warn('Audit log cleanup failed', e as any);
      // eslint-disable-next-line no-console
      console.error(
        '[AuditCleanupCronService] Cleanup error',
        (e as any)?.message ?? e,
      );
    }
  }
}


