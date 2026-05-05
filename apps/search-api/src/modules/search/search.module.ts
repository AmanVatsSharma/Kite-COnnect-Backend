/**
 * @file apps/search-api/src/modules/search/search.module.ts
 * @module search-api
 * @description Wires up the public search endpoints + the admin overview endpoint.
 *              The admin controller is gated internally by ADMIN_TOKEN — same module
 *              boundary, separate auth surface.
 */
import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { AdminSearchController } from './admin-search.controller';
import { AdminSearchService } from './admin-search.service';

@Module({
  controllers: [SearchController, AdminSearchController],
  providers: [SearchService, AdminSearchService],
})
export class SearchModule {}
