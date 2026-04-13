/**
 * @file admin-falcon.controller.ts
 * @module falcon
 * @description Admin-guarded Falcon (Kite) endpoints for the operator dashboard.
 *   Mirrors the client-facing /stock/falcon/* surface but under /admin/falcon/*
 *   secured by x-admin-token so the admin dashboard can call it directly.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '@features/admin/guards/admin.guard';
import { FalconInstrumentService } from '@features/falcon/application/falcon-instrument.service';
import { FalconProviderAdapter } from '@features/falcon/infra/falcon-provider.adapter';
import { RedisService } from '@infra/redis/redis.service';
import { FalconTokensDto, FalconHistoricalQueryDto } from './dto/falcon-market-data.dto';

@ApiTags('admin-falcon')
@ApiSecurity('admin')
@UseGuards(AdminGuard)
@Controller('admin/falcon')
export class AdminFalconController {
  constructor(
    private readonly instruments: FalconInstrumentService,
    private readonly adapter: FalconProviderAdapter,
    private readonly redis: RedisService,
  ) {}

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
}
