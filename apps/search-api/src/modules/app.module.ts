/**
 * @file apps/search-api/src/modules/app.module.ts
 * @module search-api
 * @description Root NestJS module for the search-api microservice.
 * @author BharatERP
 * @created 2025-12-01
 * @updated 2026-04-22
 */
import { Module } from '@nestjs/common';
import { SearchModule } from './search/search.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [SearchModule, HealthModule],
})
export class AppModule {}
