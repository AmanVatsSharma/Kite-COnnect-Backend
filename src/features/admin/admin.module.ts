import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { AdminController } from './interface/admin.controller';
import { AdminGuard } from './guards/admin.guard';
import { RequestAuditLog } from './domain/request-audit-log.entity';
import { OriginAuditService } from './application/origin-audit.service';
import { AuditCleanupCronService } from './application/audit-cleanup.cron';
import { OriginAuditInterceptor } from '@shared/interceptors/origin-audit.interceptor';

import { RedisModule } from '@infra/redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { KiteConnectModule } from '../kite-connect/kite-connect.module';
import { StockModule } from '../stock/stock.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([RequestAuditLog]),
    ScheduleModule.forRoot(), // For cron
    ConfigModule,
    RedisModule,
    forwardRef(() => AuthModule),
    forwardRef(() => MarketDataModule),
    KiteConnectModule,
    forwardRef(() => StockModule)
  ],
  controllers: [AdminController],
  providers: [
    OriginAuditService,
    OriginAuditInterceptor,
    AdminGuard,
    AuditCleanupCronService,
  ],
  exports: [OriginAuditService, OriginAuditInterceptor],
})
export class AdminModule {}
