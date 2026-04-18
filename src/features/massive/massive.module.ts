/**
 * @file massive.module.ts
 * @module massive
 * @description NestJS module for the Massive (formerly Polygon.io) market data provider.
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-18
 */
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MassiveRestClient } from './infra/massive-rest.client';
import { MassiveWebSocketClient } from './infra/massive-websocket.client';
import { MassiveProviderService } from './infra/massive-provider.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [MassiveRestClient, MassiveWebSocketClient, MassiveProviderService],
  exports: [MassiveProviderService],
})
export class MassiveModule {}
