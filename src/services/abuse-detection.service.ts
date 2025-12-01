import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RequestAuditLog } from '../entities/request-audit-log.entity';
import { ApiKeyAbuseFlag } from '../entities/api-key-abuse-flag.entity';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

export interface ApiKeyAbuseStatus {
  api_key: string;
  blocked: boolean;
  risk_score: number;
  reason_codes: string[];
}

/**
 * AbuseDetectionService
 *
 * Periodically scans recent request_audit_logs to identify API keys that look
 * like they are being resold or abused (many unique IPs, very high volume, etc.)
 * and maintains a per-key ApiKeyAbuseFlag record.
 */
@Injectable()
export class AbuseDetectionService {
  private readonly logger = new Logger(AbuseDetectionService.name);

  private readonly windowMinutes: number;
  private readonly uniqueIpThreshold: number;
  private readonly totalReqThreshold: number;
  private readonly blockScoreThreshold: number;

  constructor(
    @InjectRepository(RequestAuditLog)
    private readonly auditRepo: Repository<RequestAuditLog>,
    @InjectRepository(ApiKeyAbuseFlag)
    private readonly abuseRepo: Repository<ApiKeyAbuseFlag>,
    private readonly configService: ConfigService,
  ) {
    this.windowMinutes = this.getNumberEnv(
      'ABUSE_WINDOW_MINUTES',
      10,
      1,
      120,
    );
    this.uniqueIpThreshold = this.getNumberEnv(
      'ABUSE_UNIQUE_IP_THRESHOLD',
      20,
      3,
      1000,
    );
    this.totalReqThreshold = this.getNumberEnv(
      'ABUSE_TOTAL_REQ_THRESHOLD',
      1000,
      100,
      100000,
    );
    this.blockScoreThreshold = this.getNumberEnv(
      'ABUSE_BLOCK_SCORE_THRESHOLD',
      100,
      10,
      10000,
    );

    // eslint-disable-next-line no-console
    console.log('[AbuseDetectionService] Config', {
      windowMinutes: this.windowMinutes,
      uniqueIpThreshold: this.uniqueIpThreshold,
      totalReqThreshold: this.totalReqThreshold,
      blockScoreThreshold: this.blockScoreThreshold,
    });
  }

  private getNumberEnv(
    key: string,
    def: number,
    min: number,
    max: number,
  ): number {
    const raw = Number(this.configService.get(key, String(def)));
    if (!Number.isFinite(raw)) return def;
    return Math.max(min, Math.min(max, raw));
  }

  /**
   * Exposed for other services / guards that need to know if a key is blocked.
   */
  async getStatusForApiKey(apiKey: string): Promise<ApiKeyAbuseStatus | null> {
    if (!apiKey) return null;
    try {
      const flag = await this.abuseRepo.findOne({
        where: { api_key: apiKey },
      });
      if (!flag) return null;
      return {
        api_key: flag.api_key,
        blocked: flag.blocked,
        risk_score: flag.risk_score,
        reason_codes: flag.reason_codes || [],
      };
    } catch (e) {
      this.logger.warn(
        `Failed to read abuse status for apiKey=${apiKey}`,
        e as any,
      );
      // eslint-disable-next-line no-console
      console.error(
        '[AbuseDetectionService] getStatusForApiKey error',
        (e as any)?.message ?? e,
      );
      return null;
    }
  }

  getBlockScoreThreshold(): number {
    return this.blockScoreThreshold;
  }

  /**
   * Cron job: scan recent audit logs and update per-key abuse flags.
   * Runs every 5 minutes by default.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async scanForAbuse(): Promise<void> {
    try {
      const cutoff = new Date(
        Date.now() - this.windowMinutes * 60 * 1000,
      ).toISOString();

      // Aggregate recent HTTP+WS events by API key.
      const rows = await this.auditRepo
        .createQueryBuilder('a')
        .select('a.api_key', 'api_key')
        .addSelect('COUNT(*)', 'total')
        .addSelect('COUNT(DISTINCT a.ip)', 'unique_ips')
        .where('a.ts >= :cutoff', { cutoff })
        .andWhere('a.api_key IS NOT NULL')
        .groupBy('a.api_key')
        .getRawMany<{
          api_key: string;
          total: string;
          unique_ips: string;
        }>();

      if (!rows.length) {
        // eslint-disable-next-line no-console
        console.log(
          '[AbuseDetectionService] scanForAbuse: no recent activity in window',
          { windowMinutes: this.windowMinutes },
        );
        return;
      }

      for (const row of rows) {
        const apiKey = row.api_key;
        const total = Number(row.total) || 0;
        const uniqueIps = Number(row.unique_ips) || 0;

        const { score, reasons } = this.computeRiskScore(total, uniqueIps);

        let flag = await this.abuseRepo.findOne({
          where: { api_key: apiKey },
        });
        if (!flag) {
          flag = this.abuseRepo.create({
            api_key: apiKey,
            tenant_id: null,
            risk_score: score,
            reason_codes: reasons,
            blocked: score >= this.blockScoreThreshold,
            last_seen_at: new Date(),
          });
        } else {
          // For strict enforcement, once blocked we keep it blocked until admin unblocks.
          const newBlocked =
            flag.blocked || score >= this.blockScoreThreshold;
          flag.risk_score = score;
          flag.reason_codes = reasons;
          flag.blocked = newBlocked;
          flag.last_seen_at = new Date();
        }

        await this.abuseRepo.save(flag);
      }

      // eslint-disable-next-line no-console
      console.log(
        '[AbuseDetectionService] scanForAbuse completed',
        JSON.stringify({
          windowMinutes: this.windowMinutes,
          keysEvaluated: rows.length,
        }),
      );
    } catch (e) {
      this.logger.warn('scanForAbuse failed', e as any);
      // eslint-disable-next-line no-console
      console.error(
        '[AbuseDetectionService] scanForAbuse error',
        (e as any)?.message ?? e,
      );
    }
  }

  private computeRiskScore(
    totalRequests: number,
    uniqueIps: number,
  ): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    if (uniqueIps >= this.uniqueIpThreshold) {
      const over = uniqueIps - this.uniqueIpThreshold;
      score += 50 + over * 5;
      reasons.push('many_ips');
    }

    if (totalRequests >= this.totalReqThreshold) {
      const over = totalRequests - this.totalReqThreshold;
      const extra = Math.min(over / 100, 200); // Cap contribution
      score += 20 + Math.round(extra);
      reasons.push('high_volume');
    }

    if (uniqueIps >= this.uniqueIpThreshold * 2) {
      score += 50;
      reasons.push('extremely_many_ips');
    }

    if (score === 0) {
      reasons.push('within_normal_limits');
    }

    return { score, reasons };
  }
}


