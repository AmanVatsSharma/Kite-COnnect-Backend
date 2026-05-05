/**
 * @file falcon.module.ts
 * @module falcon
 * @description Falcon (Kite) instruments feature module.
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-04-14
 */
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { FalconController } from './interface/falcon.controller';
import { AdminFalconController } from './interface/admin-falcon.controller';
import { FalconInstrument } from './domain/falcon-instrument.entity';
import { FalconInstrumentService } from './application/falcon-instrument.service';
import { FalconProviderAdapter } from './infra/falcon-provider.adapter';
import { FalconAuthService } from './application/falcon-auth.service';
import { AdminGuard } from '@features/admin/guards/admin.guard';
import { RedisModule } from '@infra/redis/redis.module';
import { StockModule } from '../stock/stock.module';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [
    ScheduleModule,
    TypeOrmModule.forFeature([FalconInstrument]),
    RedisModule,
    forwardRef(() => StockModule),
    AuthModule,
    MarketDataModule,
  ],
  controllers: [FalconController, AdminFalconController],
  providers: [
    FalconInstrumentService,
    FalconProviderAdapter,
    FalconAuthService,
    AdminGuard,
  ],
  exports: [FalconInstrumentService, FalconProviderAdapter],
})
export class FalconModule {}
