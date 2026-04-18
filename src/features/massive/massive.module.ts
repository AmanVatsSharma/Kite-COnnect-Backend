/**
 * @file massive.module.ts
 * @module massive
 * @description NestJS module for the Massive (formerly Polygon.io) market data provider and instrument sync.
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-19
 */
import { Global, Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { MassiveRestClient } from './infra/massive-rest.client';
import { MassiveWebSocketClient } from './infra/massive-websocket.client';
import { MassiveProviderService } from './infra/massive-provider.service';
import { MassiveInstrument } from './domain/massive-instrument.entity';
import { MassiveInstrumentSyncService } from './application/massive-instrument-sync.service';
import { AdminMassiveController } from './interface/admin-massive.controller';
import { MarketDataModule } from '@features/market-data/market-data.module';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { UniversalInstrument } from '@features/market-data/domain/universal-instrument.entity';

@Global()
@Module({
  imports: [
    ConfigModule,
    ScheduleModule,
    TypeOrmModule.forFeature([MassiveInstrument, InstrumentMapping, UniversalInstrument]),
    forwardRef(() => MarketDataModule),
  ],
  controllers: [AdminMassiveController],
  providers: [MassiveRestClient, MassiveWebSocketClient, MassiveProviderService, MassiveInstrumentSyncService],
  exports: [MassiveProviderService, MassiveInstrumentSyncService],
})
export class MassiveModule {}
