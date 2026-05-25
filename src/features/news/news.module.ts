/**
 * @file news.module.ts
 * @module news
 * @description Finnhub news feature module: fetch, store, and broadcast financial news.
 * @author BharatERP
 * @created 2026-05-24
 *
 * Exports:
 *   - NewsModule — NestJS module wiring
 *
 * Depends on:
 *   - TypeOrmModule (NewsItem repo)
 *   - ScheduleModule (interval polling)
 *   - RedisModule
 *   - NewsService, NewsSchedulerService, NewsController, NewsGateway
 *
 * Side-effects:
 *   - Registers setInterval poll on onModuleInit (via NewsSchedulerService)
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from '@infra/redis/redis.module';
import { AuthModule } from '@features/auth/auth.module';
import { NewsItem } from './domain/news-item.entity';
import { NewsService } from './application/news.service';
import { NewsSchedulerService } from './application/news-scheduler.service';
import { NewsController } from './interface/news.controller';
import { NewsGateway } from './interface/news.gateway';

@Module({
  imports: [
    ScheduleModule,
    TypeOrmModule.forFeature([NewsItem]),
    RedisModule,
    AuthModule,
  ],
  controllers: [NewsController],
  providers: [NewsService, NewsSchedulerService, NewsGateway],
  exports: [NewsService],
})
export class NewsModule {}