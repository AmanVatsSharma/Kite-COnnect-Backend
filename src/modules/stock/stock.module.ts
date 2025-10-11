import { Module } from '@nestjs/common';
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
import { KiteConnectService } from '../../services/kite-connect.service';
import { RedisService } from '../../services/redis.service';
import { RequestBatchingService } from '../../services/request-batching.service';
import { MarketDataGateway } from '../../gateways/market-data.gateway';
import { MarketDataStreamService } from '../../services/market-data-stream.service';
import { HealthController } from '../../controllers/health.controller';
import { AuthController } from '../../controllers/auth.controller';
import { MetricsService } from '../../services/metrics.service';
import { ApiKeyService } from '../../services/api-key.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Instrument, MarketData, Subscription, ApiKey, KiteSession]),
    ScheduleModule.forRoot(),
  ],
  controllers: [StockController, HealthController, AuthController],
  providers: [
    StockService,
    KiteConnectService,
    RedisService,
    ApiKeyService,
    RequestBatchingService,
    MarketDataGateway,
    MarketDataStreamService,
    ApiKeyGuard,
    MetricsService,
  ],
  exports: [StockService, MarketDataGateway, MarketDataStreamService],
})
export class StockModule {}
