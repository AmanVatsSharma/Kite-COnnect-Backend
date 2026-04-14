/**
 * @file admin-falcon.controller.ts
 * @module falcon
 * @description Admin-guarded Falcon (Kite) endpoints for the operator dashboard.
 *   Mirrors the client-facing /stock/falcon/* surface but under /admin/falcon/*
 *   secured by x-admin-token so the admin dashboard can call it directly.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14 — added ticker restart/status/shards, instruments export/resolve, batch historical, options chain, cache flush
 */
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Param,
  Patch,
  Res,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiOperation, ApiParam, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '@features/admin/guards/admin.guard';
import { FalconInstrumentService } from '@features/falcon/application/falcon-instrument.service';
import { FalconProviderAdapter } from '@features/falcon/infra/falcon-provider.adapter';
import { KiteProviderService } from '@features/kite-connect/infra/kite-provider.service';
import { MarketDataStreamService } from '@features/market-data/application/market-data-stream.service';
import { RedisService } from '@infra/redis/redis.service';
import { FalconTokensDto, FalconHistoricalQueryDto, FalconBatchHistoricalDto } from './dto/falcon-market-data.dto';

@ApiTags('admin-falcon')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
@Controller('admin/falcon')
export class AdminFalconController {
  constructor(
    private readonly instruments: FalconInstrumentService,
    private readonly adapter: FalconProviderAdapter,
    private readonly redis: RedisService,
    private readonly kiteProvider: KiteProviderService,
    private readonly streamService: MarketDataStreamService,
  ) {}

  // ─── Config ───────────────────────────────────────────────────────────────

  @Get('config')
  @ApiOperation({ summary: 'View current Falcon (Kite) API credential status (masked)' })
  async getConfig() {
    try {
      const data = await this.kiteProvider.getConfigStatus();
      return { success: true, data };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to read Falcon config', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch('config')
  @ApiOperation({ summary: 'Update Falcon (Kite) API key / secret — persists in Redis, survives restarts' })
  async updateConfig(@Body() body: { apiKey?: string; apiSecret?: string }) {
    const { apiKey, apiSecret } = body || {};
    if (!apiKey?.trim()) {
      throw new HttpException({ success: false, message: 'apiKey is required' }, HttpStatus.BAD_REQUEST);
    }
    try {
      await this.kiteProvider.updateApiCredentials(apiKey.trim(), apiSecret?.trim());
      return { success: true, message: 'Falcon API key updated. Re-authenticate at /api/auth/falcon/login to generate a new access token.' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to update Falcon config', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Ticker Control ───────────────────────────────────────────────────────

  @Post('ticker/restart')
  @ApiOperation({ summary: 'Restart Kite WebSocket ticker (resets reconnect counter)' })
  async restartTicker() {
    try {
      await this.kiteProvider.restartTicker();
      return { success: true, message: 'Kite ticker restarted successfully' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to restart Kite ticker', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('ticker/status')
  @ApiOperation({ summary: 'Kite ticker health: connection state, reconnect count, upstream subscription utilization' })
  async tickerStatus() {
    try {
      const debug = this.kiteProvider.getDebugStatus();
      const subscribedCount = this.streamService.getSubscribedInstrumentCount();
      const upstreamLimit = 3000;
      return {
        success: true,
        data: {
          ...debug,
          subscribedInstruments: subscribedCount,
          upstreamLimit,
          utilizationPct: Math.round((subscribedCount / upstreamLimit) * 100),
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to fetch ticker status', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Account ──────────────────────────────────────────────────────────────

  @Get('profile')
  @ApiOperation({ summary: 'Kite account profile (user, exchanges, products)' })
  async profile() {
    try {
      const data = await this.adapter.getProfile();
      return { success: true, data };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to fetch Kite profile', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('margins')
  @ApiOperation({ summary: 'Kite account margins (equity and/or commodity)' })
  @ApiQuery({ name: 'segment', required: false, enum: ['equity', 'commodity'] })
  async margins(@Query('segment') segment?: 'equity' | 'commodity') {
    try {
      const seg = segment === 'equity' || segment === 'commodity' ? segment : undefined;
      const data = await this.adapter.getMargins(seg);
      return { success: true, data };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to fetch Kite margins', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Instruments ──────────────────────────────────────────────────────────

  @Get('stats')
  @ApiOperation({ summary: 'Falcon instrument counts by exchange and type' })
  async stats() {
    try {
      const data = await this.instruments.getFalconInstrumentStats();
      return { success: true, data };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Falcon stats failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments')
  @ApiOperation({ summary: 'List Falcon instruments with filters' })
  @ApiQuery({ name: 'exchange', required: false })
  @ApiQuery({ name: 'instrument_type', required: false })
  @ApiQuery({ name: 'segment', required: false })
  @ApiQuery({ name: 'is_active', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  async getInstruments(
    @Query('exchange') exchange?: string,
    @Query('instrument_type') instrument_type?: string,
    @Query('segment') segment?: string,
    @Query('is_active') is_active_raw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    try {
      const is_active =
        String(is_active_raw || '').toLowerCase() === 'true'
          ? true
          : String(is_active_raw || '').toLowerCase() === 'false'
          ? false
          : undefined;
      const limit = Math.max(1, Math.min(1000, parseInt(String(limitRaw || '50')) || 50));
      const offset = Math.max(0, parseInt(String(offsetRaw || '0')) || 0);
      const result = await this.instruments.getFalconInstruments({ exchange, instrument_type, segment, is_active, limit, offset });
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to list instruments', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/search')
  @ApiOperation({ summary: 'Full-text search Falcon instruments' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false })
  async searchInstruments(@Query('q') q?: string, @Query('limit') limitRaw?: string) {
    if (!q) {
      throw new HttpException({ success: false, message: 'q is required' }, HttpStatus.BAD_REQUEST);
    }
    try {
      const limit = Math.max(1, Math.min(200, parseInt(String(limitRaw || '20')) || 20));
      const data = await this.instruments.searchFalconInstruments(q, limit);
      return { success: true, data };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Search failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/export')
  @ApiOperation({ summary: 'Stream all Falcon instruments as NDJSON (chunked transfer encoding)' })
  @ApiQuery({ name: 'exchange', required: false })
  @ApiQuery({ name: 'instrument_type', required: false })
  @ApiQuery({ name: 'segment', required: false })
  @ApiQuery({ name: 'is_active', required: false })
  async exportInstruments(
    @Res() res: Response,
    @Query('exchange') exchange?: string,
    @Query('instrument_type') instrument_type?: string,
    @Query('segment') segment?: string,
    @Query('is_active') is_active_raw?: string,
  ) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    const PAGE = 1000;
    let offset = 0;
    const is_active =
      String(is_active_raw || '').toLowerCase() === 'true'
        ? true
        : String(is_active_raw || '').toLowerCase() === 'false'
        ? false
        : undefined;
    try {
      for (;;) {
        const { instruments } = await this.instruments.getFalconInstruments({
          exchange,
          instrument_type,
          segment,
          is_active,
          limit: PAGE,
          offset,
        });
        if (!instruments.length) break;
        for (const inst of instruments) {
          res.write(JSON.stringify(inst) + '\n');
        }
        if (instruments.length < PAGE) break;
        offset += PAGE;
      }
    } catch (e: any) {
      try {
        res.write(JSON.stringify({ error: true, message: e?.message || 'unknown' }) + '\n');
      } catch {}
    } finally {
      res.end();
    }
  }

  @Get('instruments/resolve')
  @ApiOperation({ summary: 'Resolve trading symbols to Falcon instrument tokens' })
  @ApiQuery({ name: 'symbols', required: true, example: 'RELIANCE,NIFTY' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE' })
  async resolveSymbols(@Query('symbols') symbolsRaw?: string, @Query('exchange') exchange?: string) {
    const symbols = String(symbolsRaw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!symbols.length) {
      throw new HttpException({ success: false, message: 'symbols is required' }, HttpStatus.BAD_REQUEST);
    }
    try {
      const data = await this.instruments.resolveSymbolsToTokens(symbols, exchange);
      return { success: true, data };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Symbol resolution failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('instruments/sync')
  @ApiOperation({ summary: 'Trigger Falcon instrument sync (blocking)' })
  async syncInstruments(@Body() body: { exchange?: string } = {}) {
    try {
      const result = await this.instruments.syncFalconInstruments(body?.exchange);
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Sync failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/sync/status')
  @ApiOperation({ summary: 'Poll Falcon sync job status' })
  @ApiQuery({ name: 'jobId', required: true })
  async syncStatus(@Query('jobId') jobId?: string) {
    if (!jobId) {
      throw new HttpException({ success: false, message: 'jobId is required' }, HttpStatus.BAD_REQUEST);
    }
    try {
      const v = await this.redis.get<any>(`falcon:sync:job:${jobId}`);
      return { success: true, jobId, status: v || null };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to read sync status', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Market Data ──────────────────────────────────────────────────────────

  @Post('ltp')
  @ApiOperation({ summary: 'Last traded price for instrument tokens' })
  async ltp(@Body() body: FalconTokensDto) {
    try {
      const tokens = (body?.tokens || []).map(String).filter(Boolean);
      if (!tokens.length) {
        throw new HttpException({ success: false, message: 'tokens array is required' }, HttpStatus.BAD_REQUEST);
      }
      const data = await this.adapter.getLTP(tokens);
      return { success: true, data, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'LTP failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('quote')
  @ApiOperation({ summary: 'Full quote (OHLC, depth, OI, Greeks) for instrument tokens' })
  async quote(@Body() body: FalconTokensDto) {
    try {
      const tokens = (body?.tokens || []).map(String).filter(Boolean);
      if (!tokens.length) {
        throw new HttpException({ success: false, message: 'tokens array is required' }, HttpStatus.BAD_REQUEST);
      }
      const data = await this.adapter.getQuote(tokens);
      return { success: true, data, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Quote failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('ohlc')
  @ApiOperation({ summary: 'OHLC summary for instrument tokens' })
  async ohlc(@Body() body: FalconTokensDto) {
    try {
      const tokens = (body?.tokens || []).map(String).filter(Boolean);
      if (!tokens.length) {
        throw new HttpException({ success: false, message: 'tokens array is required' }, HttpStatus.BAD_REQUEST);
      }
      const data = await this.adapter.getOHLC(tokens);
      return { success: true, data, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'OHLC failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('historical/batch')
  @ApiOperation({ summary: 'Batch historical candles for up to 10 tokens in a single call' })
  async adminHistoricalBatch(@Body() body: FalconBatchHistoricalDto) {
    try {
      const requests = (body?.requests || []).slice(0, 10);
      if (!requests.length) {
        throw new HttpException({ success: false, message: 'requests array is required (max 10)' }, HttpStatus.BAD_REQUEST);
      }
      const data = await this.adapter.getBatchHistoricalData(requests);
      return { success: true, data, count: Object.keys(data).length, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Batch historical failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('historical/:token')
  @ApiOperation({ summary: 'Historical candles for a single instrument token' })
  @ApiQuery({ name: 'from', required: true, example: '2026-04-01' })
  @ApiQuery({ name: 'to', required: true, example: '2026-04-11' })
  @ApiQuery({ name: 'interval', required: true, enum: ['minute','3minute','5minute','10minute','15minute','30minute','60minute','day'] })
  @ApiQuery({ name: 'continuous', required: false })
  @ApiQuery({ name: 'oi', required: false })
  async historical(@Param('token') tokenRaw: string, @Query() q: FalconHistoricalQueryDto) {
    try {
      const token = Number(tokenRaw);
      if (!Number.isFinite(token)) {
        throw new HttpException({ success: false, message: 'Invalid token' }, HttpStatus.BAD_REQUEST);
      }
      if (!q.from || !q.to || !q.interval) {
        throw new HttpException({ success: false, message: 'from, to, and interval are required' }, HttpStatus.BAD_REQUEST);
      }
      const continuous = String(q.continuous || '').toLowerCase() === 'true';
      const oi = String(q.oi || '').toLowerCase() === 'true';
      const data = await this.adapter.getHistoricalData(token, q.from, q.to, q.interval, continuous, oi);
      return { success: true, data, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Historical data failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Multi-Shard Status ───────────────────────────────────────────────────

  @Get('ticker/shards')
  @ApiOperation({ summary: 'Per-shard Kite WebSocket status and total capacity' })
  async shardStatus() {
    try {
      const shards = this.kiteProvider.getShardStatus();
      const limit = this.kiteProvider.getSubscriptionLimit();
      const used = this.streamService.getSubscribedInstrumentCount();
      return {
        success: true,
        data: {
          shards,
          totalCapacity: limit,
          used,
          remaining: Math.max(0, limit - used),
          utilizationPct: limit > 0 ? Math.round((used / limit) * 100) : 0,
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to fetch shard status', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Options Chain Admin ──────────────────────────────────────────────────

  @Get('options/chain/:symbol')
  @ApiOperation({ summary: 'Options chain for an underlying symbol (admin view, with Redis cache)' })
  @ApiParam({ name: 'symbol', required: true, example: 'NIFTY' })
  @ApiQuery({ name: 'ltp_only', required: false })
  async adminOptionsChain(
    @Param('symbol') symbol: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
  ) {
    try {
      if (!symbol) {
        throw new HttpException({ success: false, message: 'symbol is required' }, HttpStatus.BAD_REQUEST);
      }
      const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      return await this.instruments.getOptionsChain(symbol, ltpOnly);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Options chain failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Cache Management ─────────────────────────────────────────────────────

  @Delete('cache/flush')
  @ApiOperation({ summary: 'Flush Falcon Redis caches: options, ltp, or historical by token' })
  async flushCache(
    @Body() body: { type: 'options' | 'ltp' | 'historical'; symbol?: string; token?: number },
  ) {
    try {
      const { type, symbol, token } = body || {};
      if (!type) {
        throw new HttpException({ success: false, message: 'type is required (options|ltp|historical)' }, HttpStatus.BAD_REQUEST);
      }
      let deleted = 0;
      if (type === 'options') {
        const sym = String(symbol || '').toUpperCase();
        if (!sym) throw new HttpException({ success: false, message: 'symbol required for options cache flush' }, HttpStatus.BAD_REQUEST);
        deleted += await this.redis.scanDelete(`falcon:options:chain:${sym}*`);
      } else if (type === 'ltp' && token) {
        await this.redis.del(`ltp:${token}`);
        deleted = 1;
      } else if (type === 'historical' && token) {
        deleted += await this.redis.scanDelete(`falcon:hist:${token}:*`);
      } else {
        throw new HttpException({ success: false, message: 'Provide symbol (options) or token (ltp|historical)' }, HttpStatus.BAD_REQUEST);
      }
      return { success: true, deleted, type, symbol, token };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Cache flush failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
