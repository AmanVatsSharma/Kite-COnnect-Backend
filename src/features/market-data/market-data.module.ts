import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from '@infra/redis/redis.module';
import { KiteConnectModule } from '../kite-connect/kite-connect.module';
import { StockModule } from '../stock/stock.module';
import { MassiveModule } from '../massive/massive.module';
import { BinanceModule } from '../binance/binance.module';
import { AuthModule } from '../auth/auth.module'; // Import AuthModule
import { AdminModule } from '../admin/admin.module';

import { MarketDataGateway } from './interface/market-data.gateway';
import { MarketDataGatewaySubscriptionRegistry } from './interface/market-data-gateway-subscription.registry';
import { NativeWebSocketGateway } from './interface/native-websocket.gateway';
import { MarketDataStreamService } from './application/market-data-stream.service';
import { MarketDataProviderResolverService } from './application/market-data-provider-resolver.service';
import { NativeWsService } from './application/native-ws.service';
import { ProviderQueueService } from './application/provider-queue.service';
import { RequestBatchingService } from './application/request-batching.service';
import { FnoQueryParserService } from './application/fno-query-parser.service';
import { LtpMemoryCacheService } from './application/ltp-memory-cache.service';
import { MarketDataWsInterestService } from './application/market-data-ws-interest.service';
import { InstrumentRegistryService } from './application/instrument-registry.service';
import { MarketDataProvider } from './infra/market-data.provider';

import { MarketData } from './domain/market-data.entity';
import { Instrument } from './domain/instrument.entity';
import { InstrumentMapping } from './domain/instrument-mapping.entity';
import { Subscription } from './domain/subscription.entity';
import { UniversalInstrument } from './domain/universal-instrument.entity';
import { ApiKey } from '../auth/domain/api-key.entity'; // Import ApiKey

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MarketData,
      Instrument,
      InstrumentMapping,
      Subscription,
      UniversalInstrument,
      ApiKey, // Add ApiKey to features
    ]),
    ConfigModule,
    RedisModule,
    KiteConnectModule,
    MassiveModule,
    BinanceModule,
    forwardRef(() => AuthModule), // Add AuthModule to imports
    forwardRef(() => StockModule),
    forwardRef(() => AdminModule),
  ],
  providers: [
    MarketDataGatewaySubscriptionRegistry,
    MarketDataStreamService,
    MarketDataProviderResolverService,
    MarketDataGateway,
    NativeWebSocketGateway,
    NativeWsService,
    ProviderQueueService,
    RequestBatchingService,
    FnoQueryParserService,
    LtpMemoryCacheService,
    MarketDataWsInterestService,
    InstrumentRegistryService,
    // MarketDataProvider is an interface/abstract class usually, but if it's a provider here:
    // It seems MarketDataProvider is just an interface file. Checked file list: market-data.provider.ts.
    // I will exclude it from providers if it's just an interface.
  ],
  exports: [
    MarketDataStreamService,
    MarketDataProviderResolverService,
    MarketDataGateway,
    NativeWebSocketGateway,
    NativeWsService,
    ProviderQueueService,
    RequestBatchingService,
    FnoQueryParserService,
    LtpMemoryCacheService,
    MarketDataWsInterestService,
    InstrumentRegistryService,
    TypeOrmModule
  ],
})
export class MarketDataModule {}
