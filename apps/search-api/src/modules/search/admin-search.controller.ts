/**
 * @file apps/search-api/src/modules/search/admin-search.controller.ts
 * @module search-api
 * @description Admin REST endpoints for the Search Admin panel. Mounted at
 *              /api/search/admin and gated by the same `x-admin-token` header
 *              the trading-app's admin endpoints use. Read-only in V1.
 *
 * Exports:
 *   - AdminSearchController                 — NestJS controller mounted at /api/search/admin
 *
 * Endpoints:
 *   GET /api/search/admin/overview          — combined Meili + Redis-synonym snapshot
 *
 * Side-effects:
 *   - Forwards reads to MeiliSearch (stats + settings) and Redis (synonym SCAN)
 *
 * Key invariants:
 *   - All endpoints reject calls missing or with mismatched `x-admin-token`
 *     (HTTP 401). The token is compared with `ADMIN_TOKEN` env on the search-api
 *     container — set the same value on both trading-app and search-api so the
 *     dashboard's existing sessionStorage token works for both.
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-01
 */

import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Query,
} from '@nestjs/common';
import { AdminSearchService, SearchAdminOverview } from './admin-search.service';

@Controller('search/admin')
export class AdminSearchController {
  private readonly logger = new Logger('AdminSearchController');
  constructor(private readonly admin: AdminSearchService) {}

  /**
   * GET /api/search/admin/overview?topN=30
   * Returns Meili index stats, top selection signals, and aggregated popular queries
   * for the admin Search Admin panel. Single endpoint → single network round-trip.
   */
  @Get('overview')
  async overview(
    @Headers('x-admin-token') adminTokenHeader: string | undefined,
    @Query('topN') topNRaw?: string,
  ): Promise<{ success: boolean; data: SearchAdminOverview }> {
    this.assertAdmin(adminTokenHeader);
    const topN = Math.min(Math.max(Number(topNRaw || 30), 5), 200);
    const data = await this.admin.getOverview(topN);
    this.logger.log(
      `[AdminOverview] docs=${data.meili.numberOfDocuments} synonyms=${data.meili.settings.synonymCount} ` +
      `signalsScanned=${data.selectionSignals.scanned} popularCount=${data.popularQueries.length} ` +
      `errors=${data.errors.length}`,
    );
    return { success: true, data };
  }

  /**
   * Reject the request if the admin token is missing or doesn't match.
   * Reusing the trading-app's `x-admin-token` convention so the dashboard's existing
   * token-storage flow keeps working — no new auth UX needed.
   */
  private assertAdmin(headerVal: string | undefined): void {
    const expected = process.env.ADMIN_TOKEN || '';
    if (!expected) {
      // Fail closed — refuse admin requests if the search-api container has no token configured
      throw new HttpException(
        { success: false, message: 'admin disabled (ADMIN_TOKEN not set on search-api)' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!headerVal || String(headerVal).trim() !== expected) {
      throw new HttpException(
        { success: false, message: 'unauthorized' },
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
