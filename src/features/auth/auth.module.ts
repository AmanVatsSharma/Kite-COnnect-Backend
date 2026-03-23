import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AuthController, VortexAuthController } from './interface/auth.controller';
import { ApiKeyService } from './application/api-key.service';
import { AbuseDetectionService } from './application/abuse-detection.service';
import { ApiKey } from './domain/api-key.entity';
import { ApiKeyAbuseFlag } from './domain/api-key-abuse-flag.entity';
import { RequestAuditLog } from '@features/admin/domain/request-audit-log.entity';
import { VortexSession } from '@features/stock/domain/vortex-session.entity';
import { RedisModule } from '@infra/redis/redis.module';
import { KiteConnectModule } from '../kite-connect/kite-connect.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { StockModule } from '../stock/stock.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApiKey,
      ApiKeyAbuseFlag,
      RequestAuditLog,
      VortexSession,
    ]),
    ConfigModule,
    RedisModule,
    KiteConnectModule,
    forwardRef(() => MarketDataModule),
    forwardRef(() => StockModule),
    forwardRef(() => AdminModule),
  ],
  controllers: [AuthController, VortexAuthController],
  providers: [ApiKeyService, AbuseDetectionService],
  exports: [ApiKeyService, AbuseDetectionService, TypeOrmModule],
})
export class AuthModule {}
