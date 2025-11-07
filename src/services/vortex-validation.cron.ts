import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { VortexInstrumentService } from './vortex-instrument.service';
import { VortexProviderService } from '../providers/vortex-provider.service';

@Injectable()
export class VortexValidationCronService {
  private readonly logger = new Logger(VortexValidationCronService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly viService: VortexInstrumentService,
    private readonly vortexProvider: VortexProviderService,
  ) {
    this.enabled = String(this.config.get('VALIDATION_CRON_ENABLED', 'true')) === 'true';
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async nightlyValidation() {
    if (!this.enabled) return;
    try {
      const exchanges: Array<'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'> = ['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO'];
      for (const ex of exchanges) {
        // eslint-disable-next-line no-console
        console.log(`[VortexValidationCron] Running nightly dry-run validation for ${ex}`);
        const res = await this.viService.validateAndCleanupInstruments(
          {
            exchange: ex,
            batch_size: 1000,
            auto_cleanup: false,
            dry_run: true,
            include_invalid_list: false,
          },
          this.vortexProvider,
        );
        this.logger.log(
          `[VortexValidationCron] ${ex}: tested=${res.summary.tested} invalid=${res.summary.invalid_ltp} errors=${res.summary.errors}`,
        );
      }
    } catch (e) {
      this.logger.error('[VortexValidationCron] Nightly validation failed', e as any);
    }
  }
}


