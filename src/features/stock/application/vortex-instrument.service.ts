/**
 * @file vortex-instrument.service.ts
 * @module stock
 * @description Facade for Vortex instrument use cases (sync, search, LTP, cache, cleanup).
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-03-28 — Split into focused services; public API unchanged for callers.
 */

import { Injectable } from '@nestjs/common';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { VortexInstrumentSyncService } from '@features/stock/application/vortex-instrument-sync.service';
import { VortexInstrumentCleanupService } from '@features/stock/application/vortex-instrument-cleanup.service';
import { VortexInstrumentCacheService } from '@features/stock/application/vortex-instrument-cache.service';
import { VortexInstrumentSearchService } from '@features/stock/application/vortex-instrument-search.service';
import { VortexInstrumentReadService } from '@features/stock/application/vortex-instrument-read.service';
import { VortexInstrumentLtpService } from '@features/stock/application/vortex-instrument-ltp.service';

@Injectable()
export class VortexInstrumentService {
  constructor(
    private readonly sync: VortexInstrumentSyncService,
    private readonly cleanup: VortexInstrumentCleanupService,
    private readonly cache: VortexInstrumentCacheService,
    private readonly search: VortexInstrumentSearchService,
    private readonly read: VortexInstrumentReadService,
    private readonly ltp: VortexInstrumentLtpService,
  ) {}

  syncVortexInstruments(
    exchange?: string,
    csvUrl?: string,
    onProgress?: Parameters<VortexInstrumentSyncService['syncVortexInstruments']>[2],
  ): ReturnType<VortexInstrumentSyncService['syncVortexInstruments']> {
    return this.sync.syncVortexInstruments(exchange, csvUrl, onProgress);
  }

  async syncVortexInstrumentsDaily(): Promise<void> {
    return this.sync.syncVortexInstrumentsDaily();
  }

  getVortexInstruments(
    filters?: Parameters<VortexInstrumentSearchService['getVortexInstruments']>[0],
  ): ReturnType<VortexInstrumentSearchService['getVortexInstruments']> {
    return this.search.getVortexInstruments(filters);
  }

  searchVortexInstruments(
    query: string,
    limit?: number,
  ): ReturnType<VortexInstrumentSearchService['searchVortexInstruments']> {
    return this.search.searchVortexInstruments(query, limit);
  }

  getVortexInstrumentByToken(
    token: number,
  ): ReturnType<VortexInstrumentReadService['getVortexInstrumentByToken']> {
    return this.read.getVortexInstrumentByToken(token);
  }

  getVortexInstrumentStats(): ReturnType<VortexInstrumentReadService['getVortexInstrumentStats']> {
    return this.read.getVortexInstrumentStats();
  }

  resolveVortexSymbol(
    symbol: string,
    exchangeHint?: string,
  ): ReturnType<VortexInstrumentSearchService['resolveVortexSymbol']> {
    return this.search.resolveVortexSymbol(symbol, exchangeHint);
  }

  searchVortexInstrumentsAdvanced(
    filters: Parameters<VortexInstrumentSearchService['searchVortexInstrumentsAdvanced']>[0],
  ): ReturnType<VortexInstrumentSearchService['searchVortexInstrumentsAdvanced']> {
    return this.search.searchVortexInstrumentsAdvanced(filters);
  }

  buildPairsFromInstruments(
    instruments: VortexInstrument[],
  ): ReturnType<VortexInstrumentReadService['buildPairsFromInstruments']> {
    return this.read.buildPairsFromInstruments(instruments);
  }

  hydrateLtpByPairs(
    pairs: Parameters<VortexInstrumentReadService['hydrateLtpByPairs']>[0],
  ): ReturnType<VortexInstrumentReadService['hydrateLtpByPairs']> {
    return this.read.hydrateLtpByPairs(pairs);
  }

  getVortexAutocomplete(
    query: string,
    limit?: number,
  ): ReturnType<VortexInstrumentSearchService['getVortexAutocomplete']> {
    return this.search.getVortexAutocomplete(query, limit);
  }

  getVortexOptionsChain(
    symbol: string,
  ): ReturnType<VortexInstrumentReadService['getVortexOptionsChain']> {
    return this.read.getVortexOptionsChain(symbol);
  }

  getVortexInstrumentsBatch(
    tokens: number[],
  ): ReturnType<VortexInstrumentReadService['getVortexInstrumentsBatch']> {
    return this.read.getVortexInstrumentsBatch(tokens);
  }

  getVortexInstrumentDetails(
    tokens: number[],
  ): ReturnType<VortexInstrumentReadService['getVortexInstrumentDetails']> {
    return this.read.getVortexInstrumentDetails(tokens);
  }

  getVortexLTP(tokens: number[]): ReturnType<VortexInstrumentLtpService['getVortexLTP']> {
    return this.ltp.getVortexLTP(tokens);
  }

  getVortexInstrumentStatsCached(): ReturnType<
    VortexInstrumentCacheService['getVortexInstrumentStatsCached']
  > {
    return this.cache.getVortexInstrumentStatsCached();
  }

  getVortexAutocompleteCached(
    query: string,
    limit?: number,
  ): ReturnType<VortexInstrumentCacheService['getVortexAutocompleteCached']> {
    return this.cache.getVortexAutocompleteCached(query, limit);
  }

  getVortexPopularInstrumentsCached(
    limit?: number,
  ): ReturnType<VortexInstrumentCacheService['getVortexPopularInstrumentsCached']> {
    return this.cache.getVortexPopularInstrumentsCached(limit);
  }

  getVortexInstrumentByTokenCached(
    token: number,
  ): ReturnType<VortexInstrumentCacheService['getVortexInstrumentByTokenCached']> {
    return this.cache.getVortexInstrumentByTokenCached(token);
  }

  clearVortexCache(pattern?: string): ReturnType<VortexInstrumentCacheService['clearVortexCache']> {
    return this.cache.clearVortexCache(pattern);
  }

  validateAndCleanupInstruments(
    filters: Parameters<VortexInstrumentCleanupService['validateAndCleanupInstruments']>[0],
    onProgress?: Parameters<VortexInstrumentCleanupService['validateAndCleanupInstruments']>[1],
  ): ReturnType<VortexInstrumentCleanupService['validateAndCleanupInstruments']> {
    return this.cleanup.validateAndCleanupInstruments(filters, onProgress);
  }

  deleteInactiveInstruments(): ReturnType<VortexInstrumentCleanupService['deleteInactiveInstruments']> {
    return this.cleanup.deleteInactiveInstruments();
  }

  deleteInstrumentsByFilter(
    opts: Parameters<VortexInstrumentCleanupService['deleteInstrumentsByFilter']>[0],
  ): ReturnType<VortexInstrumentCleanupService['deleteInstrumentsByFilter']> {
    return this.cleanup.deleteInstrumentsByFilter(opts);
  }
}
