import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { Instrument } from '../../entities/instrument.entity';
import { MarketData } from '../../entities/market-data.entity';
import { Subscription } from '../../entities/subscription.entity';
import { KiteConnectService } from '../../services/kite-connect.service';
import { RedisService } from '../../services/redis.service';
import { RequestBatchingService } from '../../services/request-batching.service';
import { MarketDataGateway } from '../../gateways/market-data.gateway';
import { MarketDataStreamService } from '../../services/market-data-stream.service';
import { HealthController } from '../../controllers/health.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Instrument, MarketData, Subscription]),
    ScheduleModule.forRoot(),
  ],
  controllers: [StockController, HealthController],
  providers: [
    StockService,
    KiteConnectService,
    RedisService,
    RequestBatchingService,
    MarketDataGateway,
    MarketDataStreamService,
  ],
  exports: [StockService, MarketDataGateway, MarketDataStreamService],
})
export class StockModule {}
