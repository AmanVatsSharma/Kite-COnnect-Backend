/**
 * File:        market-movers-cron.service.ts
 * Module:      market-movers
 * Description: Hourly cron to pre-warm the Redis cache for NSE+BSE gainers/losers/active.
 *              Runs on module init and then every hour via @nestjs/schedule.
 *
 * Exports:
 *   - MarketMoversCronService — implements OnModuleInit + cron jobs
 *
 * Depends on:
 *   - MarketMoversService     — actual fetch + cache logic
 *   - ConfigService           — MARKET_MOVERS_REFRESH_INTERVAL (cron expression)
 *
 * Side-effects:
 *   - Redis writes (cache warm), HTTP calls to data provider
 *   - Non-fatal: errors logged but not thrown
 *
 * Key invariants:
 *   - OnModuleInit skips if MARKET_MOVERS_PREWARM=false
 *   - Cron errors are caught and logged; service remains available for on-demand requests
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-24
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { MarketMoversService } from './market-movers.service';
import { MoversType } from '../interface/dto/market-movers.dto';

const EXCHANGES = ['NSE', 'BSE'] as const;
const MOVER_TYPES = [
  MoversType.GAINERS,
  MoversType.LOSERS,
  MoversType.ACTIVE,
] as const;

@Injectable()
export class MarketMoversCronService implements OnModuleInit {
  private readonly logger = new Logger(MarketMoversCronService.name);
  private readonly prewarmOnInit: boolean;

  constructor(
    private readonly movers: MarketMoversService,
    private readonly config: ConfigService,
  ) {
    this.prewarmOnInit =
      this.config.get<string>('MARKET_MOVERS_PREWARM', 'true') !== 'false';
  }

  async onModuleInit(): Promise<void> {
    if (this.prewarmOnInit) {
      this.logger.log('[MarketMoversCron] Pre-warming cache on startup');
      await this.warmCache();
    } else {
      this.logger.log(
        '[MarketMoversCron] Pre-warm disabled (MARKET_MOVERS_PREWARM=false)',
      );
    }
  }

  /**
   * Hourly cron job (at minute 5 past every hour).
   * Configurable via MARKET_MOVERS_CRON env var (default "5 * * * *").
   */
  @Cron('5 * * * *')
  async handleHourlyRefresh(): Promise<void> {
    const cronExpr =
      this.config.get<string>('MARKET_MOVERS_CRON', '5 * * * *');
    this.logger.log(
      `[MarketMoversCron] Hourly refresh triggered (cron=${cronExpr})`,
    );
    await this.warmCache();
  }

  /**
   * Iterates over all exchange × type combinations and pre-fetches each.
   * Errors are collected and logged; the job never throws.
   */
  private async warmCache(): Promise<void> {
    const errors: string[] = [];

    for (const exchange of EXCHANGES) {
      for (const type of MOVER_TYPES) {
        try {
          await this.movers.getMarketMovers(exchange, type);
          this.logger.debug(
            `[MarketMoversCron] Warmed cache: ${exchange}/${type}`,
          );
        } catch (err: any) {
          const msg = `[MarketMoversCron] Failed to warm ${exchange}/${type}: ${err?.message}`;
          this.logger.warn(msg);
          errors.push(msg);
        }
      }
    }

    if (errors.length === 0) {
      this.logger.log(
        `[MarketMoversCron] Cache warm completed: ${EXCHANGES.length} exchanges × ${MOVER_TYPES.length} types`,
      );
    } else {
      this.logger.warn(
        `[MarketMoversCron] Cache warm completed with ${errors.length} errors`,
      );
    }
  }
}