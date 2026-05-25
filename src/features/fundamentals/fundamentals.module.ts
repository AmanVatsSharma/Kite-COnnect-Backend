/**
 * @file fundamentals.module.ts
 * @module fundamentals
 * @description NestJS feature module for stock fundamentals caching and fetching.
 *              Wires cache entity, fetch service, and controller.
 * @author BharatERP
 * @created 2026-05-24
 * @updated 2026-05-24
 *
 * Imports:
 *   - TypeOrmModule.forFeature([FundamentalsCache])
 *   - RedisModule (for FundamentalsFetchService + FundamentalsService)
 *   - ConfigModule (auto-provided by global ConfigModule)
 *
 * Exports:
 *   - FundamentalsService, FundamentalsFetchService
 *
 * Depends on:
 *   - @infra/redis/redis.module                — RedisService injection
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FundamentalsCache } from './domain/entities/fundamentals-cache.entity';
import { FundamentalsService } from './application/fundamentals.service';
import { FundamentalsFetchService } from './application/fundamentals-fetch.service';
import { FundamentalsController } from './interface/fundamentals.controller';
import { RedisModule } from '@infra/redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FundamentalsCache]),
    RedisModule,
  ],
  controllers: [FundamentalsController],
  providers: [FundamentalsService, FundamentalsFetchService],
  exports: [FundamentalsService, FundamentalsFetchService],
})
export class FundamentalsModule {}