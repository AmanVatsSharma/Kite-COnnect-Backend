/**
 * @file binance.module.ts
 * @module binance
 * @description NestJS module for the Binance.com (global) Spot market-data provider and instrument sync.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 */
import { Global, Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { BinanceRestClient } from './infra/binance-rest.client';
import { BinanceProviderService } from './infra/binance-provider.service';
import { BinanceInstrument } from './domain/binance-instrument.entity';
import { BinanceInstrumentSyncService } from './application/binance-instrument-sync.service';
import { AdminBinanceController } from './interface/admin-binance.controller';
import { MarketDataModule } from '@features/market-data/market-data.module';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { UniversalInstrument } from '@features/market-data/domain/universal-instrument.entity';

@Global()
@Module({
  imports: [
    ConfigModule,
    ScheduleModule,
    TypeOrmModule.forFeature([
      BinanceInstrument,
      InstrumentMapping,
      UniversalInstrument,
    ]),
    forwardRef(() => MarketDataModule),
  ],
  controllers: [AdminBinanceController],
  providers: [
    BinanceRestClient,
    BinanceProviderService,
    BinanceInstrumentSyncService,
  ],
  exports: [BinanceProviderService, BinanceInstrumentSyncService],
})
export class BinanceModule {}
