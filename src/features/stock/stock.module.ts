import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';

import { StockController } from './interface/stock.controller';
import { VayuController } from './interface/vayu.controller';
import { StockService } from './application/stock.service';
import { VortexProviderService } from './infra/vortex-provider.service';
import { VortexInstrumentService } from './application/vortex-instrument.service';
import { VayuEquityService } from './application/vayu-equity.service';
import { VayuFutureService } from './application/vayu-future.service';
import { VayuOptionService } from './application/vayu-option.service';
import { VayuSearchService } from './application/vayu-search.service';
import { VayuManagementService } from './application/vayu-management.service';
import { VayuMarketDataService } from './application/vayu-market-data.service';
import { VortexValidationCronService } from './application/vortex-validation.cron';

import { VortexSession } from './domain/vortex-session.entity';
import { VortexInstrument } from './domain/vortex-instrument.entity';

import { RedisModule } from '@infra/redis/redis.module';
import { KiteConnectModule } from '../kite-connect/kite-connect.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AuthModule } from '../auth/auth.module'; // If guards or services needed
import { AdminModule } from '../admin/admin.module';

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
    forwardRef(() => MarketDataModule),
    forwardRef(() => AuthModule), // For ApiKeyGuard/Service?
    forwardRef(() => AdminModule),
  ],
  controllers: [
    StockController,
    VayuController,
  ],
  providers: [
    StockService,
    VortexProviderService,
    VortexInstrumentService,
    VortexValidationCronService,
    VayuEquityService,
    VayuFutureService,
    VayuOptionService,
    VayuSearchService,
    VayuManagementService,
    VayuMarketDataService,
  ],
  exports: [
    StockService,
    VortexProviderService,
    VortexInstrumentService,
  ],
})
export class StockModule {}
