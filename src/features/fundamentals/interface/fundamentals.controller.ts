/**
 * @file fundamentals.controller.ts
 * @module fundamentals
 * @description REST controller for stock fundamentals. Endpoints under /api/stock/.
 *              Fetches cached fundamentals from Postgres, falls back to Yahoo Finance.
 * @author BharatERP
 * @created 2026-05-24
 * @updated 2026-05-24
 *
 * Endpoints:
 *   GET  /api/stock/:symbol/fundamentals      — Get fundamentals for a symbol
 *   GET  /api/stock/fundamentals/batch       — Batch get (query: symbols=NIFTY,RELIANCE)
 *   POST /api/stock/:symbol/fundamentals/refresh — Force refresh cache
 *   GET  /api/stock/fundamentals/stats       — Cache statistics
 *   DEL  /api/stock/fundamentals/cache       — Clear cache (query: symbol, exchange)
 *
 * Depends on:
 *   - FundamentalsService                     — cache-aware fundamentals fetch
 *   - FundamentalsResponseDto               — response shapes
 */
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { FundamentalsService } from '../application/fundamentals.service';
import {
  FundamentalsResponseDto,
  CacheStatsDto,
} from './dto/fundamentals-response.dto';

@Controller('stock')
export class FundamentalsController {
  constructor(private readonly fundamentalsService: FundamentalsService) {}

  /**
   * GET /api/stock/:symbol/fundamentals
   * Returns fundamentals for a single symbol. Exchange defaults to NSE.
   */
  @Get(':symbol/fundamentals')
  async getFundamentals(
    @Param('symbol') symbol: string,
    @Query('exchange') exchange: string = 'NSE',
  ): Promise<FundamentalsResponseDto> {
    const sym = (symbol || '').trim().toUpperCase();
    if (!sym) {
      throw new BadRequestException('Symbol is required');
    }

    const result = await this.fundamentalsService.getFundamentals(sym, exchange);

    if (!result.success) {
      throw new NotFoundException(result.data);
    }

    return {
      success: true,
      dataStale: result.dataStale,
      source: result.source,
      data: result.data,
      fetchedAt: result.fetchedAt,
    };
  }

  /**
   * GET /api/stock/fundamentals/batch?symbols=NIFTY,RELIANCE&exchange=NSE
   * Batch get fundamentals for up to 5 symbols. 500ms delay between requests.
   */
  @Get('fundamentals/batch')
  async getFundamentalsBatch(
    @Query('symbols') symbols: string,
    @Query('exchange') exchange: string = 'NSE',
  ): Promise<{ success: boolean; results: FundamentalsResponseDto[] }> {
    if (!symbols || !symbols.trim()) {
      throw new BadRequestException('symbols query param required (comma-separated)');
    }

    const symbolList = symbols
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (symbolList.length === 0) {
      throw new BadRequestException('At least one symbol required');
    }

    const results = await this.fundamentalsService.getFundamentalsBatch(
      symbolList,
      exchange,
    );

    return {
      success: true,
      results: results.map((r) => ({
        success: r.success,
        dataStale: r.dataStale,
        source: r.source,
        data: r.data,
        fetchedAt: r.fetchedAt,
      })),
    };
  }

  /**
   * POST /api/stock/:symbol/fundamentals/refresh
   * Force-refresh fundamentals cache for a symbol (bypasses TTL check).
   */
  @Post(':symbol/fundamentals/refresh')
  async refreshFundamentals(
    @Param('symbol') symbol: string,
    @Query('exchange') exchange: string = 'NSE',
  ): Promise<FundamentalsResponseDto> {
    const sym = (symbol || '').trim().toUpperCase();
    if (!sym) {
      throw new BadRequestException('Symbol is required');
    }

    const result = await this.fundamentalsService.refreshFundamentals(sym, exchange);

    if (!result.success) {
      throw new NotFoundException(result.data);
    }

    return {
      success: true,
      source: result.source,
      data: result.data,
      fetchedAt: result.fetchedAt,
    };
  }

  /**
   * GET /api/stock/fundamentals/stats
   * Returns cache statistics (total, fresh, stale, byExchange).
   */
  @Get('fundamentals/stats')
  async getCacheStats(): Promise<CacheStatsDto> {
    return this.fundamentalsService.getCacheStats();
  }

  /**
   * DELETE /api/stock/fundamentals/cache
   * Clear cache. If symbol+exchange provided, clears single entry; otherwise clears all.
   */
  @Delete('fundamentals/cache')
  async clearCache(
    @Query('symbol') symbol?: string,
    @Query('exchange') exchange?: string,
  ): Promise<{ success: boolean; cleared: number }> {
    const cleared = await this.fundamentalsService.clearCache(
      symbol?.trim().toUpperCase(),
      exchange?.trim().toUpperCase(),
    );
    return { success: true, ...cleared };
  }
}