/**
 * File:        market-movers.module.ts
 * Module:      market-movers
 * Description: NestJS module wiring for market-movers feature.
 *
 * Exports:
 *   - MarketMoversModule
 *
 * Depends on:
 *   - RedisModule           — cache layer
 *   - ScheduleModule        — cron job support
 *
 * Side-effects:
 *   - None (module only wires dependencies)
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-24
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from '@infra/redis/redis.module';
import { MarketMoversController } from './interface/market-movers.controller';
import { MarketMoversService } from './application/market-movers.service';
import { MarketMoversCronService } from './application/market-movers-cron.service';

@Module({
  imports: [
    ScheduleModule,
    RedisModule,
  ],
  controllers: [MarketMoversController],
  providers: [MarketMoversService, MarketMoversCronService],
  exports: [MarketMoversService],
})
export class MarketMoversModule {}