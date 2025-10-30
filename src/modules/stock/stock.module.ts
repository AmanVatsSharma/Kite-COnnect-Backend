import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { Instrument } from '../../entities/instrument.entity';
import { MarketData } from '../../entities/market-data.entity';
import { Subscription } from '../../entities/subscription.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { KiteSession } from '../../entities/kite-session.entity';
import { ApiKeyGuard } from '../../guards/api-key.guard';
import { KiteProviderService } from '../../providers/kite-provider.service';
import { RedisService } from '../../services/redis.service';
import { RequestBatchingService } from '../../services/request-batching.service';
import { MarketDataGateway } from '../../gateways/market-data.gateway';
import { MarketDataStreamService } from '../../services/market-data-stream.service';
import { HealthController } from '../../controllers/health.controller';
import {
  AuthController,
  VortexAuthController,
} from '../../controllers/auth.controller';
import { MetricsService } from '../../services/metrics.service';
import { ApiKeyService } from '../../services/api-key.service';
import { AdminController } from '../../controllers/admin.controller';
import { AdminGuard } from '../../guards/admin.guard';
import { MetricsInterceptor } from '../../interceptors/metrics.interceptor';
import { MarketDataProviderResolverService } from '../../services/market-data-provider-resolver.service';
import { VortexProviderService } from '../../providers/vortex-provider.service';
import { InstrumentMapping } from '../../entities/instrument-mapping.entity';
import { VortexSession } from '../../entities/vortex-session.entity';
import { VortexInstrument } from '../../entities/vortex-instrument.entity';
import { VortexInstrumentService } from '../../services/vortex-instrument.service';
import { NativeWebSocketGateway } from '../../gateways/native-websocket.gateway';
import { ProviderQueueService } from '../../services/provider-queue.service';
import { LtpMemoryCacheService } from '../../services/ltp-memory-cache.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Instrument,
      MarketData,
      Subscription,
      ApiKey,
      KiteSession,
      InstrumentMapping,
      VortexSession,
      VortexInstrument,
    ]),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    StockController,
    HealthController,
    AuthController,
    VortexAuthController,
    AdminController,
  ],
  providers: [
    StockService,
    KiteProviderService,
    VortexProviderService,
    VortexInstrumentService,
    MarketDataProviderResolverService,
    RedisService,
    ApiKeyService,
    RequestBatchingService,
    ProviderQueueService,
    LtpMemoryCacheService,
    MarketDataGateway,
    NativeWebSocketGateway,
    MarketDataStreamService,
    ApiKeyGuard,
    MetricsService,
    AdminGuard,
    MetricsInterceptor,
  ],
  exports: [
    StockService,
    MarketDataGateway,
    MarketDataStreamService,
    VortexInstrumentService,
  ],
})
export class StockModule {}
