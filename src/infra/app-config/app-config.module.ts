/**
 * @file app-config.module.ts
 * @module infra/app-config
 * @description Global module exposing AppConfigService (DB-backed key-value store for
 *   runtime operator configuration). Import once in AppModule; available globally thereafter.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14
 */
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from './app-config.entity';
import { AppConfigService } from './app-config.service';
import { RedisModule } from '@infra/redis/redis.module';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AppConfig]), RedisModule],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
