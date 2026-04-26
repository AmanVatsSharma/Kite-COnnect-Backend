import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { getDatabaseConfig } from './config/database.config';

import { RedisModule } from '@infra/redis/redis.module';
import { AppConfigModule } from '@infra/app-config/app-config.module';
import { AuthModule } from './features/auth/auth.module';
import { AdminModule } from './features/admin/admin.module';
import { MarketDataModule } from './features/market-data/market-data.module';
import { KiteConnectModule } from './features/kite-connect/kite-connect.module';
import { StockModule } from './features/stock/stock.module';
import { FalconModule } from './features/falcon/falcon.module';
import { MassiveModule } from './features/massive/massive.module';
import { BinanceModule } from './features/binance/binance.module';
import { HealthModule } from './features/health/health.module';
import { ObservabilityModule } from './infra/observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) =>
        getDatabaseConfig(configService),
      inject: [ConfigService],
    }),
    ObservabilityModule,
    RedisModule,
    AppConfigModule,
    AuthModule,
    AdminModule,
    MarketDataModule,
    KiteConnectModule,
    StockModule,
    FalconModule,
    MassiveModule,
    BinanceModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
