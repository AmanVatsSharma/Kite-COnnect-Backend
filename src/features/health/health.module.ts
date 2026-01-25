import { Module, forwardRef } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './interface/health.controller';
import { RedisModule } from '@infra/redis/redis.module';
import { StockModule } from '../stock/stock.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { KiteConnectModule } from '../kite-connect/kite-connect.module';
import { ObservabilityModule } from '@infra/observability/observability.module';

@Module({
  imports: [
    TerminusModule,
    ConfigModule,
    RedisModule,
    forwardRef(() => StockModule),
    forwardRef(() => MarketDataModule),
    KiteConnectModule,
    ObservabilityModule
  ],
  controllers: [HealthController],
})
export class HealthModule {}
