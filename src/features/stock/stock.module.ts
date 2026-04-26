import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';

import { StockInstrumentsController } from './interface/stock-instruments.controller';
import { StockQuotesController } from './interface/stock-quotes.controller';
import { StockSubscriptionsController } from './interface/stock-subscriptions.controller';
import { VayuController } from './interface/vayu.controller';
import { AdminVayuController } from './interface/admin-vayu.controller';
import { AdminGuard } from '@features/admin/guards/admin.guard';
import { StockService } from './application/stock.service';
import { VortexProviderService } from './infra/vortex-provider.service';
import { VortexInstrumentService } from './application/vortex-instrument.service';
import { VortexInstrumentLtpService } from './application/vortex-instrument-ltp.service';
import { VortexInstrumentSyncService } from './application/vortex-instrument-sync.service';
import { VortexInstrumentCleanupService } from './application/vortex-instrument-cleanup.service';
import { VortexInstrumentCacheService } from './application/vortex-instrument-cache.service';
import { VortexInstrumentSearchService } from './application/vortex-instrument-search.service';
import { VortexInstrumentReadService } from './application/vortex-instrument-read.service';
import { VayuEquityService } from './application/vayu-equity.service';
import { VayuFutureService } from './application/vayu-future.service';
import { VayuOptionService } from './application/vayu-option.service';
import { VayuSearchService } from './application/vayu-search.service';
import { VayuManagementService } from './application/vayu-management.service';
import { VayuMarketDataService } from './application/vayu-market-data.service';
import { VortexValidationCronService } from './application/vortex-validation.cron';
import { UniversalLtpService } from './application/universal-ltp.service';

import { VortexSession } from './domain/vortex-session.entity';
import { VortexInstrument } from './domain/vortex-instrument.entity';

import { RedisModule } from '@infra/redis/redis.module';
import { KiteConnectModule } from '../kite-connect/kite-connect.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AuthModule } from '../auth/auth.module'; // If guards or services needed
import { AdminModule } from '../admin/admin.module';
import { BinanceModule } from '../binance/binance.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      VortexSession,
      VortexInstrument,
    ]),
    ScheduleModule.forRoot(),
    ConfigModule,
    RedisModule,
    KiteConnectModule,
    BinanceModule,
    forwardRef(() => MarketDataModule),
    forwardRef(() => AuthModule), // For ApiKeyGuard/Service?
    forwardRef(() => AdminModule),
  ],
  controllers: [
    StockInstrumentsController,
    StockQuotesController,
    StockSubscriptionsController,
    VayuController,
    AdminVayuController,
  ],
  providers: [
    StockService,
    AdminGuard,
    VortexProviderService,
    VortexInstrumentLtpService,
    VortexInstrumentSyncService,
    VortexInstrumentCleanupService,
    VortexInstrumentCacheService,
    VortexInstrumentSearchService,
    VortexInstrumentReadService,
    VortexInstrumentService,
    VortexValidationCronService,
    VayuEquityService,
    VayuFutureService,
    VayuOptionService,
    VayuSearchService,
    VayuManagementService,
    VayuMarketDataService,
    UniversalLtpService,
  ],
  exports: [
    StockService,
    VortexProviderService,
    VortexInstrumentService,
  ],
})
export class StockModule {}
