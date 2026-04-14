/**
 * @file falcon.controller.ts
 * @module falcon
 * @description Client-facing Falcon (Kite) REST endpoints: instruments, LTP, Quote, OHLC, Historical.
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-04-14 — added instruments/export (NDJSON stream) and instruments/resolve (symbol→token)
 */
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Res,
  HttpStatus,
  HttpException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { FalconInstrumentService } from '@features/falcon/application/falcon-instrument.service';
import { FalconProviderAdapter } from '@features/falcon/infra/falcon-provider.adapter';
import { RedisService } from '@infra/redis/redis.service';
import { randomUUID } from 'crypto';
import { ApiBadRequestResponse, ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '@shared/guards/api-key.guard';
import { FalconTokensDto, FalconHistoricalQueryDto, FalconBatchHistoricalDto } from './dto/falcon-market-data.dto';

@ApiTags('falcon')
@UseGuards(ApiKeyGuard)
@ApiSecurity('apiKey')
@Controller('stock/falcon')
export class FalconController {
  constructor(
    private readonly falconInstruments: FalconInstrumentService,
    private readonly falconAdapter: FalconProviderAdapter,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Falcon provider health and sample LTP probe' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async health() {
    try {
      const probe = await this.falconAdapter.getLTP(['26000']); // SBIN as a common example token
      const ok = Number.isFinite(probe?.['26000']?.last_price as any);
      return {
        success: true,
        provider: 'falcon',
        httpOk: true,
        sample_ok: ok,
        sample_token: '26000',
      };
    } catch (e: any) {
      return {
        success: false,
        provider: 'falcon',
        httpOk: false,
        error: e?.message || 'unknown',
      };
    }
  }

  @Post('instruments/sync')
  @ApiOperation({ summary: 'Sync Falcon (Kite) instruments into falcon_instruments' })
  @ApiQuery({ name: 'exchange', required: false })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async syncInstruments(
    @Query('exchange') exchange?: string,
  ) {
    try {
      const res = await this.falconInstruments.syncFalconInstruments(exchange);
      return { success: true, ...res };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon sync failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments')
  async getInstruments(
    @Query('exchange') exchange?: string,
    @Query('instrument_type') instrument_type?: string,
    @Query('segment') segment?: string,
    @Query('is_active') is_active_raw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    try {
      const is_active = String(is_active_raw || '').toLowerCase() === 'true' ? true : String(is_active_raw || '').toLowerCase() === 'false' ? false : undefined;
      const limit = Math.max(1, Math.min(1000, parseInt(String(limitRaw || '100')) || 100));
      const offset = Math.max(0, parseInt(String(offsetRaw || '0')) || 0);
      const result = await this.falconInstruments.getFalconInstruments({
        exchange,
        instrument_type,
        segment,
        is_active,
        limit,
        offset,
      });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to fetch Falcon instruments', error: (error as any)?.message || 'unknown' },
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
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
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
        const { instruments } = await this.falconInstruments.getFalconInstruments({
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
      // Best-effort: write error as final NDJSON line then close
      try {
        res.write(JSON.stringify({ error: true, message: e?.message || 'unknown' }) + '\n');
      } catch {}
    } finally {
      res.end();
    }
  }

  @Get('instruments/resolve')
  @ApiOperation({ summary: 'Resolve trading symbols to Falcon instrument tokens' })
  @ApiQuery({ name: 'symbols', required: true, example: 'RELIANCE,NIFTY,SBIN' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async resolveSymbols(
    @Query('symbols') symbolsRaw?: string,
    @Query('exchange') exchange?: string,
  ) {
    const symbols = String(symbolsRaw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!symbols.length) {
      throw new HttpException(
        { success: false, message: 'symbols query param is required (comma-separated)' },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const data = await this.falconInstruments.resolveSymbolsToTokens(symbols, exchange);
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Symbol resolution failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/:token')
  async getInstrumentByToken(@Param('token') tokenRaw?: string) {
    try {
      const token = Number(tokenRaw);
      if (!Number.isFinite(token)) {
        throw new HttpException({ success: false, message: 'Invalid token' }, HttpStatus.BAD_REQUEST);
      }
      const instrument = await this.falconInstruments.getFalconInstrumentByToken(token);
      if (!instrument) {
        throw new HttpException({ success: false, message: 'Instrument not found' }, HttpStatus.NOT_FOUND);
      }
      return { success: true, data: instrument };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to fetch Falcon instrument', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/search')
  async search(@Query('q') q?: string, @Query('limit') limitRaw?: string) {
    try {
      if (!q) {
        throw new HttpException({ success: false, message: 'q is required' }, HttpStatus.BAD_REQUEST);
      }
      const limit = Math.max(1, Math.min(200, parseInt(String(limitRaw || '20')) || 20));
      const data = await this.falconInstruments.searchFalconInstruments(q, limit);
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon search failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/stats')
  async stats() {
    try {
      const data = await this.falconInstruments.getFalconInstrumentStats();
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon stats failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('instruments/sync/stream')
  @ApiOperation({ summary: 'Stream live status while syncing Falcon instruments (SSE)' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async syncInstrumentsStream(
    @Res() res: Response,
    @Query('exchange') exchange?: string,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const jobId = randomUUID();
    const key = `falcon:sync:job:${jobId}`;
    const write = (data: any) => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };
    write({ event: 'started', jobId, exchange: exchange || 'all', ts: Date.now() });
    setImmediate(async () => {
      try {
        await this.redis.set(key, { status: 'started', ts: Date.now() }, 3600);
      } catch {}
      try {
        const summary = await this.falconInstruments.syncFalconInstruments(exchange, undefined, async (p) => {
          write({ event: 'progress', ...p, ts: Date.now() });
          try {
            await this.redis.set(key, { status: 'running', progress: p, ts: Date.now() }, 3600);
          } catch {}
        });
        write({ event: 'completed', summary, ts: Date.now() });
        try {
          await this.redis.set(key, { status: 'completed', summary, ts: Date.now() }, 3600);
        } catch {}
      } catch (e: any) {
        write({ event: 'error', message: e?.message || 'unknown', ts: Date.now() });
        try {
          await this.redis.set(key, { status: 'failed', error: e?.message || 'unknown', ts: Date.now() }, 3600);
        } catch {}
      } finally {
        try {
          res.end();
        } catch {}
      }
    });
  }

  @Get('instruments/sync/status')
  @ApiOperation({ summary: 'Poll Falcon sync job status' })
  @ApiQuery({ name: 'jobId', required: true })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async syncStatus(@Query('jobId') jobId?: string) {
    if (!jobId) {
      throw new HttpException({ success: false, message: 'jobId is required' }, HttpStatus.BAD_REQUEST);
    }
    try {
      const key = `falcon:sync:job:${jobId}`;
      const v = await this.redis.get<any>(key);
      return { success: true, jobId, status: v || null };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to read sync status', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('ltp')
  @ApiOperation({ summary: 'Get Falcon LTP for instrument tokens' })
  @ApiOkResponse({ description: 'Map of token → { last_price }' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async ltp(@Body() body: { instruments: number[] }) {
    try {
      const tokens = (body?.instruments || []).map((t) => String(t));
      if (!tokens.length) {
        throw new HttpException(
          { success: false, message: 'instruments array is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const ltp = await this.falconAdapter.getLTP(tokens);
      return { success: true, data: ltp, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon LTP failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('ltp')
  @ApiOperation({ summary: 'Get Falcon LTP for instrument tokens (comma-separated)' })
  @ApiQuery({ name: 'tokens', required: true, example: '738561,5633' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async getLtp(@Query('tokens') tokensRaw?: string) {
    try {
      const tokens = String(tokensRaw || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      if (!tokens.length) {
        throw new HttpException(
          { success: false, message: 'tokens query is required (comma-separated numeric tokens)' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const ltp = await this.falconAdapter.getLTP(tokens);
      return { success: true, data: ltp, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon LTP failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('instruments/batch')
  @ApiOperation({ summary: 'Batch lookup Falcon instruments by tokens' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async batch(@Body() body: { tokens: number[] }) {
    try {
      const tokens = Array.isArray(body?.tokens) ? body.tokens.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
      if (!tokens.length) {
        throw new HttpException(
          { success: false, message: 'tokens array is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const data = await this.falconInstruments.getFalconInstrumentsBatch(tokens);
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon batch failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('validate-instruments')
  @ApiOperation({ summary: 'Validate Falcon instruments via live LTP, optional cleanup' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async validate(@Body() body: { limit?: number; offset?: number; batchSize?: number; dry_run?: boolean; auto_cleanup?: boolean }) {
    try {
      const result = await this.falconInstruments.validateFalconInstruments({
        limit: body?.limit,
        offset: body?.offset,
        batchSize: body?.batchSize,
        dry_run: body?.dry_run,
        auto_cleanup: body?.auto_cleanup,
      });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon validate failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ===== Filtered lists =====
  @Get('equities')
  @ApiOperation({ summary: 'List Falcon equities with filters and optional LTP-only' })
  @ApiQuery({ name: 'exchange', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'is_active', required: false, example: true })
  @ApiQuery({ name: 'ltp_only', required: false, example: false })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async equities(
    @Query('exchange') exchange?: string,
    @Query('q') q?: string,
    @Query('is_active') isActiveRaw?: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    try {
      const is_active = String(isActiveRaw || '').toLowerCase() === 'true' ? true : String(isActiveRaw || '').toLowerCase() === 'false' ? false : undefined;
      const ltp_only = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      const limit = parseInt(String(limitRaw || '100')) || 100;
      const offset = parseInt(String(offsetRaw || '0')) || 0;
      const result = await this.falconInstruments.getEquities({ exchange, q, is_active, ltp_only, limit, offset });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to fetch Falcon equities', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('futures')
  @ApiOperation({ summary: 'List Falcon futures with filters and optional LTP-only' })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'exchange', required: false })
  @ApiQuery({ name: 'expiry_from', required: false, example: '2025-01-01' })
  @ApiQuery({ name: 'expiry_to', required: false, example: '2025-12-31' })
  @ApiQuery({ name: 'is_active', required: false, example: true })
  @ApiQuery({ name: 'ltp_only', required: false, example: false })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async futures(
    @Query('symbol') symbol?: string,
    @Query('exchange') exchange?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('is_active') isActiveRaw?: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    try {
      const is_active = String(isActiveRaw || '').toLowerCase() === 'true' ? true : String(isActiveRaw || '').toLowerCase() === 'false' ? false : undefined;
      const ltp_only = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      const limit = parseInt(String(limitRaw || '100')) || 100;
      const offset = parseInt(String(offsetRaw || '0')) || 0;
      const result = await this.falconInstruments.getFutures({ symbol, exchange, expiry_from, expiry_to, is_active, ltp_only, limit, offset });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to fetch Falcon futures', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('options')
  @ApiOperation({ summary: 'List Falcon options with filters and optional LTP-only' })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'exchange', required: false })
  @ApiQuery({ name: 'expiry_from', required: false, example: '2025-01-01' })
  @ApiQuery({ name: 'expiry_to', required: false, example: '2025-12-31' })
  @ApiQuery({ name: 'strike_min', required: false })
  @ApiQuery({ name: 'strike_max', required: false })
  @ApiQuery({ name: 'option_type', required: false, enum: ['CE','PE'] })
  @ApiQuery({ name: 'is_active', required: false, example: true })
  @ApiQuery({ name: 'ltp_only', required: false, example: false })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async options(
    @Query('symbol') symbol?: string,
    @Query('exchange') exchange?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('strike_min') strike_min_raw?: string,
    @Query('strike_max') strike_max_raw?: string,
    @Query('option_type') option_type_raw?: 'CE' | 'PE',
    @Query('is_active') isActiveRaw?: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    try {
      const is_active = String(isActiveRaw || '').toLowerCase() === 'true' ? true : String(isActiveRaw || '').toLowerCase() === 'false' ? false : undefined;
      const ltp_only = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      const strike_min = strike_min_raw ? Number(strokeSafeNumber(strike_min_raw)) : undefined;
      const strike_max = strike_max_raw ? Number(strokeSafeNumber(strike_max_raw)) : undefined;
      const option_type = option_type_raw === 'CE' || option_type_raw === 'PE' ? option_type_raw : undefined;
      const limit = parseInt(String(limitRaw || '100')) || 100;
      const offset = parseInt(String(offsetRaw || '0')) || 0;
      const result = await this.falconInstruments.getOptions({ symbol, exchange, expiry_from, expiry_to, strike_min, strike_max, option_type, is_active, ltp_only, limit, offset });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to fetch Falcon options', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('commodities')
  @ApiOperation({ summary: 'List Falcon commodities (MCX) with filters and optional LTP-only' })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'exchange', required: false, example: 'MCX' })
  @ApiQuery({ name: 'instrument_type', required: false })
  @ApiQuery({ name: 'is_active', required: false, example: true })
  @ApiQuery({ name: 'ltp_only', required: false, example: false })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async commodities(
    @Query('symbol') symbol?: string,
    @Query('exchange') exchange?: string,
    @Query('instrument_type') instrument_type?: string,
    @Query('is_active') isActiveRaw?: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    try {
      const is_active = String(isActiveRaw || '').toLowerCase() === 'true' ? true : String(isActiveRaw || '').toLowerCase() === 'false' ? false : undefined;
      const ltp_only = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      const limit = parseInt(String(limitRaw || '100')) || 100;
      const offset = parseInt(String(offsetRaw || '0')) || 0;
      const result = await this.falconInstruments.getCommodities({ symbol, exchange, instrument_type, is_active, ltp_only, limit, offset });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to fetch Falcon commodities', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ===== Human-friendly tickers =====
  @Get('tickers/search')
  @ApiOperation({ summary: 'Search Falcon tickers and return live price + metadata' })
  @ApiQuery({ name: 'q', required: true, example: 'NSE:SBIN or SBIN' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'ltp_only', required: false, example: false })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async tickerSearch(
    @Query('q') q?: string,
    @Query('limit') limitRaw?: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
  ) {
    try {
      if (!q) {
        throw new HttpException({ success: false, message: 'q is required' }, HttpStatus.BAD_REQUEST);
      }
      const limit = parseInt(String(limitRaw || '20')) || 20;
      const ltp_only = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      const data = await this.falconInstruments.searchTickers(q, limit, ltp_only);
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon ticker search failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('tickers/:symbol')
  @ApiOperation({ summary: 'Get Falcon ticker by symbol with live LTP' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async tickerBySymbol(@Param('symbol') symbol: string) {
    try {
      const data = await this.falconInstruments.getTickerBySymbol(symbol);
      if (!data) {
        throw new HttpException({ success: false, message: 'Symbol not found' }, HttpStatus.NOT_FOUND);
      }
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon get ticker failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ===== Market Data: Quote / OHLC / Historical =====

  @Post('quote')
  @ApiOperation({ summary: 'Full quote for instrument tokens (OHLC, depth, OI, Greeks)' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async quote(@Body() body: FalconTokensDto) {
    try {
      const tokens = (body?.tokens || []).map(String).filter(Boolean);
      if (!tokens.length) {
        throw new HttpException({ success: false, message: 'tokens array is required' }, HttpStatus.BAD_REQUEST);
      }
      const data = await this.falconAdapter.getQuote(tokens);
      return { success: true, data, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon quote failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('ohlc')
  @ApiOperation({ summary: 'OHLC summary for instrument tokens' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async ohlc(@Body() body: FalconTokensDto) {
    try {
      const tokens = (body?.tokens || []).map(String).filter(Boolean);
      if (!tokens.length) {
        throw new HttpException({ success: false, message: 'tokens array is required' }, HttpStatus.BAD_REQUEST);
      }
      const data = await this.falconAdapter.getOHLC(tokens);
      return { success: true, data, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon OHLC failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('historical/batch')
  @ApiOperation({
    summary: 'Batch historical candles for up to 10 tokens in a single call',
    description: 'Fetches OHLCV candle data for multiple tokens in one request (max 10). Each token uses its own from/to/interval. Concurrency-limited to 3 parallel requests (~3 RPS). Uses per-token Redis cache with smart TTL (60s for 1-min today → 86400s for day interval past dates).',
  })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  @ApiBody({ type: FalconBatchHistoricalDto, description: 'Up to 10 token historical requests' })
  @ApiOkResponse({ description: 'Map of instrument_token → candle data. Individual tokens may contain { error } if that token failed.' })
  @ApiBadRequestResponse({ description: 'requests array missing or empty' })
  async historicalBatch(@Body() body: FalconBatchHistoricalDto) {
    try {
      const requests = (body?.requests || []).slice(0, 10);
      if (!requests.length) {
        throw new HttpException({ success: false, message: 'requests array is required (max 10)' }, HttpStatus.BAD_REQUEST);
      }
      const data = await this.falconAdapter.getBatchHistoricalData(requests);
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
  @ApiQuery({ name: 'continuous', required: false, example: false })
  @ApiQuery({ name: 'oi', required: false, example: false })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
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
      const data = await this.falconAdapter.getHistoricalData(token, q.from, q.to, q.interval, continuous, oi);
      return { success: true, data, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon historical data failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  // =========================================================================
  // Vayu-parity additions
  // =========================================================================

  @Get('options/chain/:symbol')
  @ApiOperation({ summary: 'Falcon options chain for an underlying symbol (grouped by expiry/strike)' })
  @ApiQuery({ name: 'ltp_only', required: false, example: false })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async optionsChain(
    @Param('symbol') symbol: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
  ) {
    try {
      const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      return await this.falconInstruments.getOptionsChain(symbol, ltpOnly);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon options chain failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('underlyings/:symbol/futures')
  @ApiOperation({ summary: 'All active futures for a specific Falcon underlying symbol' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NFO' })
  @ApiQuery({ name: 'ltp_only', required: false, example: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async underlyingFutures(
    @Param('symbol') symbol: string,
    @Query('exchange') exchange?: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    try {
      const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      const limit = parseInt(String(limitRaw || '100')) || 100;
      const offset = parseInt(String(offsetRaw || '0')) || 0;
      const result = await this.falconInstruments.getUnderlyingFutures(symbol, exchange, limit, offset, ltpOnly);
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon underlying futures failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('underlyings/:symbol/options')
  @ApiOperation({ summary: 'Options chain for a Falcon underlying symbol (alias for options/chain/:symbol)' })
  @ApiQuery({ name: 'ltp_only', required: false, example: false })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async underlyingOptions(
    @Param('symbol') symbol: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
  ) {
    try {
      const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      return await this.falconInstruments.getOptionsChain(symbol, ltpOnly);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon underlying options failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('fno/autocomplete')
  @ApiOperation({ summary: 'F&O underlying symbol autocomplete (only symbols with active derivatives)' })
  @ApiQuery({ name: 'q', required: true, example: 'NIF' })
  @ApiQuery({ name: 'scope', required: false, enum: ['nse', 'mcx', 'all'] })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async fnoAutocomplete(
    @Query('q') q?: string,
    @Query('scope') scope?: 'nse' | 'mcx' | 'all',
    @Query('limit') limitRaw?: string,
  ) {
    try {
      if (!q) {
        throw new HttpException({ success: false, message: 'q is required' }, HttpStatus.BAD_REQUEST);
      }
      const limit = parseInt(String(limitRaw || '10')) || 10;
      return await this.falconInstruments.autocompleteFno(q, scope, limit);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon F&O autocomplete failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('mcx-options')
  @ApiOperation({ summary: 'MCX options with filters and optional LTP enrichment' })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'option_type', required: false, enum: ['CE', 'PE'] })
  @ApiQuery({ name: 'expiry_from', required: false })
  @ApiQuery({ name: 'expiry_to', required: false })
  @ApiQuery({ name: 'strike_min', required: false })
  @ApiQuery({ name: 'strike_max', required: false })
  @ApiQuery({ name: 'is_active', required: false })
  @ApiQuery({ name: 'ltp_only', required: false, example: false })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async mcxOptions(
    @Query('symbol') symbol?: string,
    @Query('option_type') optionTypeRaw?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('strike_min') strikeMinRaw?: string,
    @Query('strike_max') strikeMaxRaw?: string,
    @Query('is_active') isActiveRaw?: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    try {
      const is_active = String(isActiveRaw || '').toLowerCase() === 'true' ? true : String(isActiveRaw || '').toLowerCase() === 'false' ? false : undefined;
      const ltp_only = String(ltpOnlyRaw || '').toLowerCase() === 'true';
      const option_type = optionTypeRaw === 'CE' || optionTypeRaw === 'PE' ? optionTypeRaw : undefined;
      const strike_min = strikeMinRaw ? strokeSafeNumber(strikeMinRaw) : undefined;
      const strike_max = strikeMaxRaw ? strokeSafeNumber(strikeMaxRaw) : undefined;
      const limit = parseInt(String(limitRaw || '100')) || 100;
      const offset = parseInt(String(offsetRaw || '0')) || 0;
      const result = await this.falconInstruments.getMcxOptions({
        symbol, option_type, expiry_from, expiry_to, strike_min, strike_max, is_active, ltp_only, limit, offset,
      });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon MCX options failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/popular')
  @ApiOperation({ summary: 'Popular Falcon instruments (hardcoded list + live LTP)' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async popularInstruments(@Query('limit') limitRaw?: string) {
    try {
      const limit = parseInt(String(limitRaw || '50')) || 50;
      const result = await this.falconInstruments.getPopularInstruments(limit);
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon popular instruments failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/cached-stats')
  @ApiOperation({ summary: 'Falcon instrument stats (Redis-cached, faster than /stats)' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async cachedStats() {
    try {
      const data = await this.falconInstruments.getCachedStats();
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Falcon cached stats failed', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('instruments/sync/start')
  @ApiOperation({ summary: 'Start Falcon instrument sync in the background (always async)' })
  @ApiQuery({ name: 'exchange', required: false })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async syncStart(@Query('exchange') exchange?: string) {
    try {
      return await this.falconInstruments.startSyncAlwaysAsync(exchange);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to start sync job', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('instruments/inactive')
  @ApiOperation({ summary: 'Permanently delete all inactive Falcon instruments (is_active=false)' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async deleteInactiveInstruments() {
    try {
      const result = await this.falconInstruments.deleteInactiveInstruments();
      return { success: true, message: 'Inactive instruments deleted', ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to delete inactive instruments', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('instruments')
  @ApiOperation({ summary: 'Permanently delete Falcon instruments by exchange and/or instrument_type filter' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NFO' })
  @ApiQuery({ name: 'instrument_type', required: false, example: 'PE' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async deleteByFilter(
    @Query('exchange') exchange?: string,
    @Query('instrument_type') instrument_type?: string,
  ) {
    if (!exchange && !instrument_type) {
      throw new HttpException(
        { success: false, message: 'At least one filter required: exchange or instrument_type' },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const result = await this.falconInstruments.deleteByFilter(exchange, instrument_type);
      return { success: true, message: 'Delete completed', ...result, filters: { exchange, instrument_type } };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to delete instruments', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('cache/clear')
  @ApiOperation({ summary: 'Clear Falcon Redis cache (profile, margins, stats keys)' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async clearCache() {
    try {
      await this.falconInstruments.clearFalconCache();
      return { success: true, message: 'Falcon cache cleared' };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to clear Falcon cache', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('validate-instruments/status')
  @ApiOperation({ summary: 'Poll Falcon validation job status by jobId' })
  @ApiQuery({ name: 'jobId', required: true })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async validateStatus(@Query('jobId') jobId?: string) {
    if (!jobId) {
      throw new HttpException({ success: false, message: 'jobId is required' }, HttpStatus.BAD_REQUEST);
    }
    try {
      const key = `falcon:validate:job:${jobId}`;
      const v = await this.redis.get<any>(key);
      return { success: true, jobId, status: v || null };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to read validation status', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('validate-instruments/stream')
  @ApiOperation({ summary: 'Stream live validation progress (SSE) for Falcon instruments' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async validateStream(
    @Res() res: Response,
    @Body() body?: { limit?: number; offset?: number; batchSize?: number; dry_run?: boolean; auto_cleanup?: boolean },
  ) {
    (res as any).setHeader('Content-Type', 'text/event-stream');
    (res as any).setHeader('Cache-Control', 'no-cache');
    (res as any).setHeader('Connection', 'keep-alive');
    (res as any).flushHeaders?.();
    const jobId = randomUUID();
    const key = `falcon:validate:job:${jobId}`;
    const write = (data: any) => {
      try { (res as any).write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* noop */ }
    };
    write({ event: 'started', jobId, ts: Date.now() });
    setImmediate(async () => {
      try {
        await this.redis.set(key, { status: 'running', ts: Date.now() }, 3600);
      } catch { /* noop */ }
      try {
        const result = await this.falconInstruments.validateFalconInstruments({
          limit: body?.limit,
          offset: body?.offset,
          batchSize: body?.batchSize,
          dry_run: body?.dry_run,
          auto_cleanup: body?.auto_cleanup,
        });
        write({ event: 'completed', result, ts: Date.now() });
        try { await this.redis.set(key, { status: 'completed', result, ts: Date.now() }, 3600); } catch { /* noop */ }
      } catch (e: any) {
        write({ event: 'error', message: e?.message || 'unknown', ts: Date.now() });
        try { await this.redis.set(key, { status: 'failed', error: e?.message || 'unknown', ts: Date.now() }, 3600); } catch { /* noop */ }
      } finally {
        try { (res as any).end(); } catch { /* noop */ }
      }
    });
  }

  @Post('validate-instruments/export')
  @ApiOperation({ summary: 'Export invalid Falcon instruments as CSV' })
  @ApiHeader({ name: 'x-api-key', required: true, description: 'Your API key' })
  async validateExport(
    @Res() res: Response,
    @Body() body?: { limit?: number; offset?: number; batchSize?: number },
  ) {
    try {
      const result = await this.falconInstruments.validateFalconInstruments({
        limit: body?.limit,
        offset: body?.offset,
        batchSize: body?.batchSize,
        dry_run: true,
        auto_cleanup: false,
      });
      const csv =
        'token,reason\n' +
        result.invalid_instruments.map((t) => `${t},invalid_ltp`).join('\n');
      (res as any).setHeader('Content-Type', 'text/csv');
      (res as any).setHeader('Content-Disposition', 'attachment; filename="invalid_falcon_instruments.csv"');
      (res as any).send(csv);
    } catch (error) {
      if (!((res as any).headersSent)) {
        throw new HttpException(
          { success: false, message: 'Falcon validate export failed', error: (error as any)?.message || 'unknown' },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }
  }

  // =========================================================================
  // End Vayu-parity additions
  // =========================================================================
}

function strokeSafeNumber(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

