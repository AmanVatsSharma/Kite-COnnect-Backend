import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  HttpException,
  HttpStatus,
  UseGuards,
  Request,
  Res,
} from '@nestjs/common';
import { StockService } from './stock.service';
import { VortexInstrumentService } from '../../services/vortex-instrument.service';
import { VortexProviderService } from '../../providers/vortex-provider.service';
import { RedisService } from '../../services/redis.service';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiHeader,
  ApiProduces,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { ApiKeyGuard } from '../../guards/api-key.guard';
import { LtpRequestDto } from './dto/ltp.dto';
import { InstrumentsRequestDto } from './dto/instruments.dto';
import { BatchTokensDto } from './dto/batch-tokens.dto';
import { ClearCacheDto } from './dto/clear-cache.dto';
import { ValidateInstrumentsDto } from './dto/validate-instruments.dto';
import { randomUUID } from 'crypto';
import { RequestBatchingService } from '../../services/request-batching.service';
import { MetricsService } from '../../services/metrics.service';
import { FnoQueryParserService } from '../../services/fno-query-parser.service';
import { VayuEquityService } from './services/vayu-equity.service';
import { VayuFutureService } from './services/vayu-future.service';
import { VayuOptionService } from './services/vayu-option.service';

// Ambient declarations to satisfy TS in environments without DOM/lib definitions
declare const console: any;
declare function setImmediate(handler: (...args: any[]) => void, ...args: any[]): any;

@Controller('stock')
@UseGuards(ApiKeyGuard)
@ApiTags('stock')
@ApiSecurity('apiKey')
export class StockController {
  constructor(
    private readonly stockService: StockService,
    private readonly vortexInstrumentService: VortexInstrumentService,
    private readonly vortexProvider: VortexProviderService,
    private readonly redisService: RedisService,
    private readonly requestBatchingService: RequestBatchingService,
    private readonly fnoQueryParser: FnoQueryParserService,
    private readonly metrics: MetricsService,
    private readonly vayuEquityService: VayuEquityService,
    private readonly vayuFutureService: VayuFutureService,
    private readonly vayuOptionService: VayuOptionService,
  ) {}

  @Post('instruments/sync')
  @ApiOperation({
    summary:
      'Sync instruments from selected provider (supports ?provider and Vayu CSV)',
  })
  @ApiHeader({
    name: 'x-provider',
    required: false,
    description: 'Force provider for this request: falcon|vayu',
  })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE' })
  @ApiQuery({
    name: 'provider',
    required: false,
    example: 'kite',
    description:
      'Provider to sync: falcon|vayu (overrides global for this call)',
  })
  @ApiQuery({
    name: 'csv_url',
    required: false,
    description: 'When provider=vayu, optional CSV URL to import instruments',
  })
  async syncInstruments(
    @Query('exchange') exchange?: string,
    @Query('provider') provider?: 'kite' | 'vortex',
    @Query('csv_url') csvUrl?: string,
    @Request() req?: any,
  ) {
    try {
      const result = await this.stockService.syncInstruments(exchange, {
        provider,
        csv_url: csvUrl,
        headers: req?.headers,
        apiKey: req?.headers?.['x-api-key'] || req?.query?.['api_key'],
      });
      return {
        success: true,
        message: 'Instruments synced successfully',
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to sync instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Delete('vayu/instruments')
  @ApiOperation({ summary: 'Permanently delete Vayu instruments by filter' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'instrument_name', required: false, example: 'EQ' })
  @ApiQuery({
    name: 'instrument_type',
    required: false,
    example: 'EQUITIES',
    description: 'High-level type (EQUITIES, FUTURES, OPTIONS, COMMODITIES, CURRENCY)',
  })
  async deleteVayuInstrumentsByFilter(
    @Query('exchange') exchange?: string,
    @Query('instrument_name') instrument_name?: string,
    @Query('instrument_type') instrument_type?: string,
  ) {
    try {
      if (!exchange && !instrument_name && !instrument_type) {
        throw new HttpException(
          {
            success: false,
            message:
              'At least one filter is required: exchange or instrument_name or instrument_type',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      const deleted =
        await this.vortexInstrumentService.deleteInstrumentsByFilter({
          exchange,
          instrument_name,
          instrument_type,
        });
      return {
        success: true,
        message: 'Delete completed',
        deleted,
        filters: { exchange, instrument_name, instrument_type },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to delete instruments',
          error: (error as any)?.message || 'unknown',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Post('vayu/instruments/sync/stream')
  @ApiOperation({
    summary: 'Stream live status while syncing Vayu (Vortex) instruments (SSE)',
    description:
      'Streams JSON events with progress of CSV fetch and upsert. Emits fields: { phase, total, processed, synced, updated, errors, lastMessage }.',
  })
  @ApiProduces('text/event-stream')
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'csv_url', required: false, description: 'Optional CSV URL override' })
  async streamVayuSync(
    @Query('exchange') exchange?: string,
    @Query('csv_url') csvUrl?: string,
    @Res() res?: any,
  ) {
    try {
      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const send = (data: any) => {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[Vayu Sync SSE] write failed:', e);
        }
      };

      send({ success: true, event: 'start', exchange: exchange || 'all', ts: new Date().toISOString() });

      const result = await this.vortexInstrumentService.syncVortexInstruments(
        exchange,
        csvUrl,
        (p) => send({ success: true, event: 'progress', ...p, ts: new Date().toISOString() }),
      );

      send({ success: true, event: 'complete', result, ts: new Date().toISOString() });
      res.end();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[Vayu Sync SSE] Error:', error);
      try {
        res.write(`data: ${JSON.stringify({ success: false, error: (error as any)?.message || 'unknown' })}\n\n`);
      } catch {}
      res.end();
    }
  }

  @ApiTags('vayu')
  @Post('vayu/instruments/sync')
  @ApiOperation({
    summary: 'Start Vayu (Vortex) instruments sync (supports async polling)',
    description:
      'If async=true, starts a background sync job and returns jobId. Poll progress via GET /api/stock/vayu/instruments/sync/status?jobId=... Otherwise runs sync inline and returns summary.',
  })
  @ApiProduces('application/json')
  @ApiResponse({
    status: 200,
    description: 'Sync started or completed',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string' },
        jobId: { type: 'string', nullable: true, example: 'a2b6f2ee-0f27-4a2d-ae26-0ff4ac4a93fc' },
        data: {
          type: 'object',
          nullable: true,
          description: 'Present when async=false (inline run)',
          properties: {
            synced: { type: 'number', example: 1200 },
            updated: { type: 'number', example: 3400 },
            total: { type: 'number', example: 4600 },
          },
        },
        timestamp: { type: 'string' },
      },
    },
  })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'csv_url', required: false, description: 'Optional CSV URL override' })
  @ApiQuery({ name: 'async', required: false, example: true, description: 'Run in background and poll status' })
  async startVayuSync(
    @Query('exchange') exchange?: string,
    @Query('csv_url') csvUrl?: string,
    @Query('async') asyncRaw?: string | boolean,
  ) {
    const isAsync = String(asyncRaw || '').toLowerCase() === 'true' || asyncRaw === true;
    if (!isAsync) {
      try {
        const summary = await this.vortexInstrumentService.syncVortexInstruments(exchange, csvUrl);
        return { success: true, message: 'Sync completed', data: summary, timestamp: new Date().toISOString() };
      } catch (error) {
        if (error instanceof HttpException) throw error;
        throw new HttpException(
          { success: false, message: 'Vayu sync failed', error: (error as any)?.message || 'unknown' },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }
    // Async path using Redis progress store
    try {
      const jobId = randomUUID();
      const key = `vayu:sync:job:${jobId}`;
      await this.redisService.set(key, { status: 'started', exchange: exchange || 'all', ts: Date.now() }, 3600);
      setImmediate(async () => {
        try {
          await this.vortexInstrumentService.syncVortexInstruments(exchange, csvUrl, async (p) => {
            try {
              await this.redisService.set(key, { status: 'running', progress: p, ts: Date.now() }, 3600);
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('[Vayu Sync] Failed to write progress to Redis', e);
            }
          });
          await this.redisService.set(key, { status: 'completed', ts: Date.now() }, 3600);
        } catch (e) {
          await this.redisService.set(key, { status: 'failed', error: (e as any)?.message || 'unknown', ts: Date.now() }, 3600);
        }
      });
      return { success: true, message: 'Sync job started', jobId, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to start Vayu sync', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/instruments/sync/status')
  @ApiOperation({ summary: 'Poll Vayu (Vortex) sync status' })
  @ApiProduces('application/json')
  @ApiQuery({ name: 'jobId', required: true })
  @ApiResponse({
    status: 200,
    description: 'Returns job status from progress store',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'running' },
            progress: {
              type: 'object',
              nullable: true,
              properties: {
                phase: { type: 'string', example: 'upsert' },
                total: { type: 'number', example: 28981 },
                processed: { type: 'number', example: 15000 },
                synced: { type: 'number', example: 5000 },
                updated: { type: 'number', example: 9000 },
                errors: { type: 'number', example: 10 },
                lastMessage: { type: 'string', example: 'Upsert progress 15000/28981' },
              },
            },
            ts: { type: 'number', example: 1731147600000 },
          },
        },
      },
    },
  })
  async getVayuSyncStatus(@Query('jobId') jobId: string) {
    try {
      if (!jobId) {
        throw new HttpException({ success: false, message: 'jobId is required' }, HttpStatus.BAD_REQUEST);
      }
      const key = `vayu:sync:job:${jobId}`;
      const data = await this.redisService.get<any>(key);
      if (!data) {
        throw new HttpException({ success: false, message: 'Job not found or expired' }, HttpStatus.NOT_FOUND);
      }
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to fetch status', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Post('vayu/instruments/sync/start')
  @ApiOperation({
    summary: 'Start Vayu (Vortex) instruments sync (always async)',
    description:
      'Starts a background sync job and immediately returns a jobId to poll or monitor.',
  })
  @ApiProduces('application/json')
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'csv_url', required: false, description: 'Optional CSV URL override' })
  async startVayuSyncAlwaysAsync(
    @Query('exchange') exchange?: string,
    @Query('csv_url') csvUrl?: string,
  ) {
    try {
      const jobId = randomUUID();
      const key = `vayu:sync:job:${jobId}`;
      await this.redisService.set(key, { status: 'started', exchange: exchange || 'all', ts: Date.now() }, 3600);
      setImmediate(async () => {
        try {
          await this.vortexInstrumentService.syncVortexInstruments(exchange, csvUrl, async (p) => {
            try {
              await this.redisService.set(key, { status: 'running', progress: p, ts: Date.now() }, 3600);
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('[Vayu Sync] Failed to write progress to Redis', e);
            }
          });
          await this.redisService.set(key, { status: 'completed', ts: Date.now() }, 3600);
        } catch (e) {
          await this.redisService.set(key, { status: 'failed', error: (e as any)?.message || 'unknown', ts: Date.now() }, 3600);
        }
      });
      return { success: true, message: 'Sync job started', jobId, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to start Vayu sync', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments')
  @ApiOperation({ summary: 'List instruments with optional filters' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE' })
  @ApiQuery({ name: 'instrument_type', required: false, example: 'EQ' })
  @ApiQuery({ name: 'segment', required: false, example: 'NSE' })
  @ApiQuery({ name: 'is_active', required: false, example: true })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getInstruments(
    @Query('exchange') exchange?: string,
    @Query('instrument_type') instrumentType?: string,
    @Query('segment') segment?: string,
    @Query('is_active') isActive?: boolean,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    try {
      const filters = {
        exchange,
        instrument_type: instrumentType,
        segment,
        is_active: isActive,
        limit: limit ? parseInt(limit.toString()) : undefined,
        offset: offset ? parseInt(offset.toString()) : undefined,
      };

      const result = await this.stockService.getInstruments(filters);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('resolve')
  @ApiOperation({
    summary:
      'Resolve trading symbol to instrument token (e.g., NSE:SBIN, NSE_SBIN, SBIN-EQ)',
  })
  @ApiQuery({ name: 'symbol', required: true, example: 'NSE_SBIN' })
  @ApiQuery({ name: 'segment', required: false, example: 'NSE' })
  async resolveSymbol(
    @Query('symbol') symbol: string,
    @Query('segment') seg?: string,
  ) {
    try {
      if (!symbol) {
        throw new HttpException(
          { success: false, message: 'symbol is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const { instrument, candidates } = await this.stockService.resolveSymbol(
        symbol,
        seg,
      );
      return { success: true, data: { instrument, candidates } };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to resolve symbol',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/search')
  @ApiOperation({
    summary: 'Search instruments by symbol or name (case-insensitive)',
  })
  @ApiQuery({ name: 'q', required: true, example: 'rel' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  async searchInstruments(
    @Query('q') query: string,
    @Query('limit') limit?: number,
  ) {
    try {
      // Trim and validate query
      const trimmedQuery = query?.trim();
      if (!trimmedQuery || trimmedQuery.length === 0) {
        throw new HttpException(
          {
            success: false,
            message: 'Search query is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Accept NSE:SBIN or NSE_SBIN as a direct lookup
      if (/^(NSE|BSE|NFO|CDS|MCX)[:_]/i.test(trimmedQuery)) {
        const resolved = await this.stockService.resolveSymbol(trimmedQuery);
        return {
          success: true,
          data: resolved.instrument
            ? [resolved.instrument]
            : resolved.candidates,
        };
      }

      const instruments = await this.stockService.searchInstruments(
        trimmedQuery,
        limit ? parseInt(limit.toString()) : 20,
      );

      return {
        success: true,
        data: instruments,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to search instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/:token')
  @ApiOperation({ summary: 'Get instrument by token' })
  async getInstrumentByToken(@Param('token') token: string) {
    try {
      const instrumentToken = parseInt(token);
      if (isNaN(instrumentToken)) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid instrument token',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const instrument =
        await this.stockService.getInstrumentByToken(instrumentToken);
      if (!instrument) {
        throw new HttpException(
          {
            success: false,
            message: 'Instrument not found',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        data: instrument,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch instrument',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('quotes')
  @ApiOperation({
    summary:
      'Get quotes for instruments with mode selection (ltp|ohlc|full) and optional LTP-only filtering',
    description:
      'Returns a map of token → quote object. The system enriches missing LTP via Vayu (Vortex) with a single fallback request before responding. If ltp_only=true, instruments without a valid last_price are omitted.',
  })
  @ApiHeader({
    name: 'x-provider',
    required: false,
    description: 'Force provider for this request: falcon|vayu',
  })
  @ApiQuery({
    name: 'mode',
    required: false,
    example: 'full',
    description: 'ltp | ohlc | full (default: full)',
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: true,
    description:
      'If true, only instruments with a valid last_price are returned',
  })
  @ApiBody({
    schema: {
      properties: {
        instruments: {
          type: 'array',
          items: { type: 'number' },
          example: [738561, 5633],
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Quote data response. When ltp_only=true, only instruments with last_price are returned.',
  })
  async getQuotes(
    @Body() body: InstrumentsRequestDto,
    @Request() req: any,
    @Query('mode') mode?: 'ltp' | 'ohlc' | 'full',
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    try {
      const { instruments } = body;
      if (
        !instruments ||
        !Array.isArray(instruments) ||
        instruments.length === 0
      ) {
        throw new HttpException(
          {
            success: false,
            message: 'Instruments array is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (instruments.length > 100) {
        throw new HttpException(
          {
            success: false,
            message: 'Maximum 100 instruments allowed per request',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      const modeNorm = (mode || 'full').toLowerCase();
      const ltpOnly =
        String(ltpOnlyRaw || '').toLowerCase() === 'true' ||
        ltpOnlyRaw === true;
      let quotes: any;
      if (modeNorm === 'ltp') {
        quotes = await this.stockService.getLTP(
          instruments,
          req.headers,
          req.headers?.['x-api-key'] || req.query?.['api_key'],
        );
      } else if (modeNorm === 'ohlc') {
        quotes = await this.stockService.getOHLC(
          instruments,
          req.headers,
          req.headers?.['x-api-key'] || req.query?.['api_key'],
        );
      } else {
        quotes = await this.stockService.getQuotes(
          instruments,
          req.headers,
          req.headers?.['x-api-key'] || req.query?.['api_key'],
        );
      }

      // Optional filtering: only include tokens with a valid last_price
      if (ltpOnly && quotes && typeof quotes === 'object') {
        const filtered: Record<string, any> = {};
        Object.entries(quotes).forEach(([k, v]: any) => {
          const lp = v?.last_price;
          if (Number.isFinite(lp) && lp > 0) filtered[k] = v;
        });
        quotes = filtered;
      }
      return {
        success: true,
        data: quotes,
        timestamp: new Date().toISOString(),
        mode: modeNorm,
        ltp_only: ltpOnly || false,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch quotes',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('tickers/search')
  @ApiOperation({
    summary: 'Search human tickers and return live price + metadata',
  })
  @ApiQuery({ name: 'q', required: true, example: 'NSE_SBIN' })
  async searchTickers(@Query('q') q: string) {
    try {
      if (!q) {
        throw new HttpException(
          { success: false, message: 'q is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const { instrument, candidates } =
        await this.stockService.resolveSymbol(q);
      const items = instrument ? [instrument] : candidates;
      const tokens = items.map((i) => i.instrument_token);
      const ltp = tokens.length ? await this.stockService.getLTP(tokens) : {};
      return {
        success: true,
        data: items.map((i) => ({
          instrument_token: i.instrument_token,
          symbol: i.tradingsymbol,
          segment: i.segment,
          instrument_type: i.instrument_type,
          last_price:
            ltp?.[i.instrument_token]?.last_price ?? i.last_price ?? null,
        })),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to search tickers',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('tickers/:symbol')
  @ApiOperation({
    summary: 'Get live price and metadata by human ticker (e.g., NSE_SBIN)',
  })
  async getTickerBySymbol(@Param('symbol') symbol: string) {
    try {
      const { instrument } = await this.stockService.resolveSymbol(symbol);
      if (!instrument) {
        throw new HttpException(
          { success: false, message: 'Symbol not found' },
          HttpStatus.NOT_FOUND,
        );
      }
      const ltp = await this.stockService.getLTP([instrument.instrument_token]);
      return {
        success: true,
        data: {
          instrument_token: instrument.instrument_token,
          symbol: instrument.tradingsymbol,
          segment: instrument.segment,
          instrument_type: instrument.instrument_type,
          last_price:
            ltp?.[instrument.instrument_token]?.last_price ??
            instrument.last_price ??
            null,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch ticker',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('ltp')
  @ApiOperation({ summary: 'Get LTP for instruments' })
  @ApiHeader({
    name: 'x-provider',
    required: false,
    description: 'Force provider for this request: falcon|vayu',
  })
  @ApiBody({
    schema: {
      properties: {
        instruments: {
          type: 'array',
          items: { type: 'number' },
          example: [738561, 5633],
        },
      },
    },
  })
  async getLTP(@Body() body: InstrumentsRequestDto, @Request() req: any) {
    try {
      const { instruments } = body;
      if (
        !instruments ||
        !Array.isArray(instruments) ||
        instruments.length === 0
      ) {
        throw new HttpException(
          {
            success: false,
            message: 'Instruments array is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (instruments.length > 100) {
        throw new HttpException(
          {
            success: false,
            message: 'Maximum 100 instruments allowed per request',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const ltp = await this.stockService.getLTP(
        instruments,
        req.headers,
        req.headers?.['x-api-key'] || req.query?.['api_key'],
      );
      return {
        success: true,
        data: ltp,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch LTP',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('ohlc')
  @ApiOperation({ summary: 'Get OHLC for instruments' })
  @ApiHeader({
    name: 'x-provider',
    required: false,
    description: 'Force provider for this request: falcon|vayu',
  })
  @ApiBody({
    schema: {
      properties: {
        instruments: {
          type: 'array',
          items: { type: 'number' },
          example: [738561, 5633],
        },
      },
    },
  })
  async getOHLC(@Body() body: InstrumentsRequestDto, @Request() req: any) {
    try {
      const { instruments } = body;
      if (
        !instruments ||
        !Array.isArray(instruments) ||
        instruments.length === 0
      ) {
        throw new HttpException(
          {
            success: false,
            message: 'Instruments array is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (instruments.length > 100) {
        throw new HttpException(
          {
            success: false,
            message: 'Maximum 100 instruments allowed per request',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const ohlc = await this.stockService.getOHLC(
        instruments,
        req.headers,
        req.headers?.['x-api-key'] || req.query?.['api_key'],
      );
      return {
        success: true,
        data: ohlc,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch OHLC',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('historical/:token')
  @ApiOperation({ summary: 'Get historical data for an instrument' })
  @ApiHeader({
    name: 'x-provider',
    required: false,
    description: 'Force provider for this request: falcon|vayu',
  })
  @ApiQuery({ name: 'from', required: true, example: '2024-01-01' })
  @ApiQuery({ name: 'to', required: true, example: '2024-01-31' })
  @ApiQuery({ name: 'interval', required: false, example: 'day' })
  async getHistoricalData(
    @Param('token') token: string,
    @Query('from') fromDate: string,
    @Query('to') toDate: string,
    @Query('interval') interval: string = 'day',
    @Request() req?: any,
  ) {
    try {
      const instrumentToken = parseInt(token);
      if (isNaN(instrumentToken)) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid instrument token',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!fromDate || !toDate) {
        throw new HttpException(
          {
            success: false,
            message: 'From date and to date are required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const historicalData = await this.stockService.getHistoricalData(
        instrumentToken,
        fromDate,
        toDate,
        interval,
        req?.headers,
        req?.headers?.['x-api-key'] || req?.query?.['api_key'],
      );

      return {
        success: true,
        data: historicalData,
        instrumentToken,
        fromDate,
        toDate,
        interval,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch historical data',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('market-data/:token/history')
  async getMarketDataHistory(
    @Param('token') token: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    try {
      const instrumentToken = parseInt(token);
      if (isNaN(instrumentToken)) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid instrument token',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.stockService.getMarketDataHistory(
        instrumentToken,
        limit ? parseInt(limit.toString()) : 100,
        offset ? parseInt(offset.toString()) : 0,
      );

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch market data history',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('market-data/:token/last')
  @ApiOperation({ summary: 'Get last cached tick for an instrument' })
  async getLastTick(@Param('token') token: string) {
    try {
      const instrumentToken = parseInt(token);
      if (isNaN(instrumentToken)) {
        throw new HttpException(
          { success: false, message: 'Invalid instrument token' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const tick = await this.stockService.getLastTick(instrumentToken);
      return { success: true, data: tick };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch last tick',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('subscribe')
  @ApiOperation({ summary: 'Subscribe current user to an instrument' })
  @ApiBody({
    schema: {
      properties: {
        instrumentToken: { type: 'number', example: 738561 },
        subscriptionType: { type: 'string', example: 'live' },
      },
    },
  })
  async subscribeToInstrument(
    @Request() req: any,
    @Body()
    body: {
      instrumentToken: number;
      subscriptionType?: 'live' | 'historical' | 'both';
    },
  ) {
    try {
      const { instrumentToken, subscriptionType = 'live' } = body;
      const userId = req.user?.id || 'anonymous';

      if (!instrumentToken) {
        throw new HttpException(
          {
            success: false,
            message: 'Instrument token is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const subscription = await this.stockService.subscribeToInstrument(
        userId,
        instrumentToken,
        subscriptionType,
      );

      return {
        success: true,
        message: 'Subscribed to instrument successfully',
        data: subscription,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to subscribe to instrument',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('subscribe/:token')
  @ApiOperation({ summary: 'Unsubscribe current user from instrument' })
  async unsubscribeFromInstrument(
    @Request() req: any,
    @Param('token') token: string,
  ) {
    try {
      const instrumentToken = parseInt(token);
      const userId = req.user?.id || 'anonymous';

      if (isNaN(instrumentToken)) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid instrument token',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.stockService.unsubscribeFromInstrument(
        userId,
        instrumentToken,
      );

      return {
        success: true,
        message: 'Unsubscribed from instrument successfully',
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to unsubscribe from instrument',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('subscriptions')
  @ApiOperation({ summary: 'Get user subscriptions' })
  async getUserSubscriptions(@Request() req: any) {
    try {
      const userId = req.user?.id || 'anonymous';
      const subscriptions =
        await this.stockService.getUserSubscriptions(userId);

      return {
        success: true,
        data: subscriptions,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch user subscriptions',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get system stats' })
  async getSystemStats() {
    try {
      const stats = await this.stockService.getSystemStats();
      return {
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch system stats',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ===== VAYU-SPECIFIC ENDPOINTS =====

  @ApiTags('vayu')
  @Get('vayu/health')
  @ApiOperation({ summary: 'Vayu provider health and debug status' })
  async getVayuHealth() {
    try {
      const ping = await this.vortexProvider.ping();
      const status = this.vortexProvider.getDebugStatus();
      // eslint-disable-next-line no-console
      console.log('[Vayu Health]', { ping, status });
      return { success: true, ping, status, timestamp: new Date().toISOString() };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Vayu health check failed', error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/debug/resolve')
  @ApiOperation({ summary: 'Resolve exchanges for tokens with source attribution' })
  @ApiQuery({ name: 'tokens', required: true, example: '738561,135938' })
  async debugResolve(@Query('tokens') tokens?: string) {
    try {
      const ids = String(tokens || '')
        .split(',')
        .map((x) => x.trim())
        .filter((s) => /^\d+$/.test(s))
        .slice(0, 1000);
      if (!ids.length) {
        throw new HttpException(
          { success: false, message: 'tokens query param required (comma-separated numeric tokens)' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const resolution = await this.vortexProvider.debugResolveExchanges(ids);
      // eslint-disable-next-line no-console
      console.log('[Vayu Debug Resolve]', { count: resolution.length });
      return { success: true, data: resolution, count: resolution.length, timestamp: new Date().toISOString() };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Debug resolve failed', error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/debug/build-q')
  @ApiOperation({ summary: 'Build Vortex quotes query for tokens (debug)' })
  @ApiQuery({ name: 'tokens', required: true, example: '738561,135938' })
  @ApiQuery({ name: 'mode', required: false, example: 'ltp', description: 'ltp|ohlc|full' })
  async debugBuildQ(@Query('tokens') tokens?: string, @Query('mode') mode?: 'ltp' | 'ohlc' | 'full') {
    try {
      const ids = String(tokens || '')
        .split(',')
        .map((x) => x.trim())
        .filter((s) => /^\d+$/.test(s))
        .slice(0, 1000);
      if (!ids.length) {
        throw new HttpException(
          { success: false, message: 'tokens query param required (comma-separated numeric tokens)' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const m = (String(mode || 'ltp').toLowerCase() as 'ltp' | 'ohlc' | 'full');
      if (!['ltp', 'ohlc', 'full'].includes(m)) {
        throw new HttpException(
          { success: false, message: 'mode must be one of ltp|ohlc|full' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const result = await this.vortexProvider.debugBuildQuery(ids, m);
      // eslint-disable-next-line no-console
      console.log('[Vayu Debug BuildQ]', { stats: result.stats });
      return { success: true, ...result, timestamp: new Date().toISOString() } as any;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Debug build-q failed', error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/debug/batch-stats')
  @ApiOperation({ summary: 'Show batching service stats (debug)' })
  async getBatchStats() {
    try {
      const stats = this.requestBatchingService.getBatchStats() as any;
      return { success: true, data: stats, timestamp: new Date().toISOString() };
    } catch (error) {
      throw new HttpException(
        { success: false, message: 'Failed to fetch batch stats', error: (error as any)?.message || 'unknown' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/ltp')
  @ApiOperation({
    summary:
      'Get Vayu LTP using exchange-token pairs (q=NSE_EQ-22&q=NSE_FO-135938)',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    description:
      'Repeat this query param for each pair, format: EXCHANGE-TOKEN (e.g., q=NSE_EQ-22)'
  })
  async getVayuLtpByQuery(@Query('q') q: string | string[]) {
    try {
      const items = Array.isArray(q) ? q : q ? [q] : [];
      const allowed = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);
      const pairs = items
        .map((s) => String(s || '').trim().toUpperCase())
        .filter((s) => s.includes('-'))
        .map((s) => {
          const [ex, tok] = s.split('-');
          return { exchange: ex, token: tok } as any;
        })
        .filter((p) => allowed.has(String(p.exchange)) && /^\d+$/.test(String(p.token)));

      if (pairs.length === 0) {
        throw new HttpException(
          {
            success: false,
            message:
              'At least one valid q=EXCHANGE-TOKEN is required (e.g., q=NSE_EQ-22)',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const data = await this.requestBatchingService.getLtpByPairs(
        pairs as any,
        this.vortexProvider,
      );

      // Enrich response with instrument metadata (description, tick, lot_size, etc.)
      const tokens: number[] = Array.from(
        new Set(
          pairs
            .map((p: any) => Number(String(p.token)))
            .filter((n) => Number.isFinite(n)),
        ),
      );

      // Build map from pairKey to token for enrichment
      const pairKeyToToken = new Map<string, number>();
      for (const p of pairs as any[]) {
        const ex = String(p.exchange).toUpperCase();
        const tok = Number(String(p.token));
        if (Number.isFinite(tok)) pairKeyToToken.set(`${ex}-${tok}`, tok);
      }

      let enrichedData: Record<string, any> = {};
      try {
        const instruments = await this.vortexInstrumentService.getVortexInstrumentDetails(tokens);
        enrichedData = {};
        for (const [pairKey, ltpData] of Object.entries<any>(data || {})) {
          const tok = pairKeyToToken.get(pairKey);
          if (!tok) {
            enrichedData[pairKey] = ltpData;
            continue;
          }
          const instrument = instruments[tok];
          if (!instrument) {
            enrichedData[pairKey] = ltpData;
            continue;
          }
          const baseObjPair = (ltpData && typeof ltpData === 'object') ? ltpData : {};
          enrichedData[pairKey] = {
            ...baseObjPair,
            description: instrument?.description || null,
            symbol: instrument?.symbol || null,
            exchange: instrument?.exchange || null,
            instrument_name: instrument?.instrument_name || null,
            expiry_date: instrument?.expiry_date || null,
            option_type: instrument?.option_type || null,
            strike_price: instrument?.strike_price || null,
            tick: instrument?.tick || null,
            lot_size: instrument?.lot_size || null,
          };
        }
      } catch (enrichError) {
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.warn('[Vayu LTP GET] Failed to enrich instruments, returning LTP only:', enrichError);
        enrichedData = data as any;
      }

      return {
        success: true,
        data: enrichedData,
        count: Object.keys(enrichedData || {}).length,
        timestamp: new Date().toISOString(),
        mode: 'pairs',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch Vayu LTP',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Post('vayu/ltp')
  @ApiOperation({
    summary: 'Get Vayu LTP with enriched instrument data',
    description:
      'Fetches Last Traded Price (LTP) for instruments. Supports two modes: 1) instruments array (token-keyed response), 2) pairs array (exchange-token keyed response). Response includes enriched instrument metadata (description, symbol, exchange, etc.) along with LTP data.',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully fetched LTP data with enriched instrument information',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          description: 'LTP data keyed by token (instruments mode) or EXCHANGE-TOKEN (pairs mode)',
          additionalProperties: {
            type: 'object',
            properties: {
              last_price: { type: 'number', nullable: true, example: 2456.75 },
              description: { type: 'string', nullable: true, example: 'NSE_EQ RELIANCE EQ' },
              symbol: { type: 'string', nullable: true, example: 'RELIANCE' },
              exchange: { type: 'string', nullable: true, example: 'NSE_EQ' },
              instrument_name: { type: 'string', nullable: true, example: 'EQ' },
              expiry_date: { type: 'string', nullable: true, example: null },
              option_type: { type: 'string', nullable: true, example: null },
              strike_price: { type: 'number', nullable: true, example: null },
              tick: { type: 'number', nullable: true, example: 0.05 },
              lot_size: { type: 'number', nullable: true, example: 1 },
            },
          },
        },
        count: { type: 'number', example: 2 },
        timestamp: { type: 'string', example: '2025-01-01T10:00:00.000Z' },
        mode: { type: 'string', enum: ['instruments', 'pairs'], example: 'instruments' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid input parameters',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 500,
    description: 'Internal server error',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string' },
        error: { type: 'string' },
      },
    },
  })
  @ApiBody({ type: LtpRequestDto })
  async postVayuLtp(@Body() body: LtpRequestDto) {
    try {
      // Allow two input modes:
      // 1) instruments: number[]  → returns token-keyed map { [token]: { last_price } }
      // 2) pairs: { exchange, token }[] → returns pair-keyed map { ['EXCHANGE-TOKEN']: { last_price } }

      const hasInstruments = Array.isArray((body as any)?.instruments) && (body as any).instruments.length > 0;
      if (hasInstruments) {
        const raw = (body as any).instruments as Array<string | number>;
        // Sanitize numeric tokens and enforce soft cap (1000)
        const tokens = raw
          .map((t) => String(t ?? '').trim())
          .filter((t) => /^\d+$/.test(t));

        if (tokens.length === 0) {
          throw new HttpException(
            {
              success: false,
              message: 'instruments must contain at least one numeric token',
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        if (tokens.length > 1000) {
          throw new HttpException(
            {
              success: false,
              message: 'Maximum 1000 instruments allowed per request',
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        const startedAt = Date.now();
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log('[Vayu LTP] instruments mode:', { count: tokens.length });
        
        try {
          const data = await this.requestBatchingService.getLTP(
            tokens,
            this.vortexProvider,
          );
          
          // Enrich with instrument descriptions and other data
          const enrichedData: Record<string, any> = {};
          try {
            const instrumentTokens = tokens.map((t) => parseInt(t));
            const instruments = await this.vortexInstrumentService.getVortexInstrumentsBatch(instrumentTokens);
            
            for (const [token, ltpData] of Object.entries(data)) {
              try {
                const instrument = instruments.instruments[parseInt(token)];
                const baseObj = (ltpData && typeof ltpData === 'object') ? ltpData : {};
                enrichedData[token] = {
                  ...baseObj,
                  description: instrument?.description || null,
                  symbol: instrument?.symbol || null,
                  exchange: instrument?.exchange || null,
                  instrument_name: instrument?.instrument_name || null,
                  expiry_date: instrument?.expiry_date || null,
                  option_type: instrument?.option_type || null,
                  strike_price: instrument?.strike_price || null,
                  tick: instrument?.tick || null,
                  lot_size: instrument?.lot_size || null,
                };
              } catch (enrichError) {
                // Console for easy debugging
                // eslint-disable-next-line no-console
                console.warn(`[Vayu LTP] Failed to enrich token ${token}:`, enrichError);
                // Fallback: return LTP data without enrichment
                enrichedData[token] = ltpData;
              }
            }
          } catch (enrichError) {
            // Console for easy debugging
            // eslint-disable-next-line no-console
            console.error('[Vayu LTP] Failed to enrich instruments, returning LTP only:', enrichError);
            // Fallback: return LTP data without enrichment if enrichment fails
            Object.assign(enrichedData, data);
          }
          
          const elapsed = Date.now() - startedAt;
          this.vortexProvider['logger']?.log?.(
            `[Vayu LTP] instruments served: ${tokens.length} tokens in ${elapsed}ms`,
          );
          return {
            success: true,
            data: enrichedData,
            count: Object.keys(enrichedData || {}).length,
            timestamp: new Date().toISOString(),
            mode: 'instruments',
          };
        } catch (ltpError) {
          // Console for easy debugging
          // eslint-disable-next-line no-console
          console.error('[Vayu LTP] Failed to fetch LTP:', ltpError);
          throw ltpError;
        }
      }

      const allowed = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);
      const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
      const sanitized = pairs
        .map((p) => ({
          exchange: String(p?.exchange || '').toUpperCase(),
          token: String(p?.token ?? '').trim(),
        }))
        .filter((p) => allowed.has(p.exchange) && /^\d+$/.test(p.token))
        .map((p) => ({ exchange: p.exchange as any, token: p.token }));

      if (sanitized.length === 0) {
        throw new HttpException(
          {
            success: false,
            message:
              'Either provide instruments: number[] or non-empty pairs: [{ exchange, token }]',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      try {
        const data = await this.requestBatchingService.getLtpByPairs(
          sanitized as any,
          this.vortexProvider,
        );
        
        // Enrich with instrument descriptions and other data
        const enrichedData: Record<string, any> = {};
        try {
          const instrumentTokens = sanitized.map((p) => parseInt(p.token));
          const instruments = await this.vortexInstrumentService.getVortexInstrumentsBatch(instrumentTokens);
          
          for (const [pairKey, ltpData] of Object.entries(data)) {
            try {
              const token = parseInt(pairKey.split('-').pop() || '0');
              const instrument = instruments.instruments[token];
              const baseObj2 = (ltpData && typeof ltpData === 'object') ? ltpData : {};
              enrichedData[pairKey] = {
                ...baseObj2,
                description: instrument?.description || null,
                symbol: instrument?.symbol || null,
                exchange: instrument?.exchange || null,
                instrument_name: instrument?.instrument_name || null,
                expiry_date: instrument?.expiry_date || null,
                option_type: instrument?.option_type || null,
                strike_price: instrument?.strike_price || null,
                tick: instrument?.tick || null,
                lot_size: instrument?.lot_size || null,
              };
            } catch (enrichError) {
              // Console for easy debugging
              // eslint-disable-next-line no-console
              console.warn(`[Vayu LTP] Failed to enrich pair ${pairKey}:`, enrichError);
              // Fallback: return LTP data without enrichment
              enrichedData[pairKey] = ltpData;
            }
          }
        } catch (enrichError) {
          // Console for easy debugging
          // eslint-disable-next-line no-console
          console.error('[Vayu LTP] Failed to enrich instruments, returning LTP only:', enrichError);
          // Fallback: return LTP data without enrichment if enrichment fails
          Object.assign(enrichedData, data);
        }
        
        return {
          success: true,
          data: enrichedData,
          count: Object.keys(enrichedData || {}).length,
          timestamp: new Date().toISOString(),
          mode: 'pairs',
        };
      } catch (ltpError) {
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.error('[Vayu LTP] Failed to fetch LTP by pairs:', ltpError);
        throw ltpError;
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch Vayu LTP',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Post('vayu/validate-instruments')
  @ApiOperation({
    summary: 'Validate and cleanup invalid Vortex instruments',
    description:
      'Tests LTP fetch capability for instruments in batches, identifies invalid instruments, and optionally deactivates them. Useful for cleaning up instruments that no longer return valid LTP data. Recommended workflow: 1) Run with dry_run=true to see results, 2) Review invalid_instruments list, 3) Run with auto_cleanup=true and dry_run=false to deactivate invalid instruments, 4) Use DELETE /vayu/instruments/inactive to permanently remove them.',
  })
  @ApiResponse({
    status: 200,
    description: 'Validation completed successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        summary: {
          type: 'object',
          properties: {
            total_instruments: { type: 'number', example: 5000 },
            tested: { type: 'number', example: 5000 },
            valid_ltp: { type: 'number', example: 4500 },
            invalid_ltp: { type: 'number', example: 500 },
            errors: { type: 'number', example: 0 },
          },
        },
        invalid_instruments: {
          type: 'array',
          description: 'Only included if include_invalid_list=true. Array of invalid instruments with details.',
          items: {
            type: 'object',
            properties: {
              token: { type: 'number', example: 12345 },
              exchange: { type: 'string', example: 'MCX_FO' },
              symbol: { type: 'string', example: 'INVALID' },
              instrument_name: { type: 'string', example: 'FUTCOM' },
              reason: { type: 'string', example: 'no_ltp_data' },
              ltp_response: { type: 'object', nullable: true },
            },
          },
        },
        invalid_instruments_count: {
          type: 'number',
          description: 'Count of invalid instruments (always included, even when list is not)',
          example: 500,
        },
        note: {
          type: 'string',
          description: 'Informational message about response format',
          example: 'Invalid instruments list not included to avoid large responses. Set include_invalid_list=true to include the full list.',
        },
        cleanup: {
          type: 'object',
          properties: {
            deactivated: { type: 'number', example: 0 },
            removed: { type: 'number', example: 0 },
          },
        },
        batches_processed: { type: 'number', example: 5 },
        timestamp: { type: 'string', example: '2025-01-01T10:00:00.000Z' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid input parameters',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 500,
    description: 'Internal server error during validation',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string' },
        error: { type: 'string' },
      },
    },
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        exchange: {
          type: 'string',
          example: 'MCX_FO',
          description: 'Filter by exchange (NSE_EQ, NSE_FO, NSE_CUR, MCX_FO)',
        },
        instrument_name: {
          type: 'string',
          example: 'FUTCOM',
          description: 'Filter by instrument type',
        },
        symbol: {
          type: 'string',
          example: 'GOLD',
          description: 'Filter by symbol (partial match)',
        },
        option_type: {
          type: 'string',
          example: 'CE',
          description: 'Filter by option type (CE/PE/null)',
        },
        batch_size: {
          type: 'number',
          example: 1000,
          default: 1000,
          description: 'Number of instruments to test per batch',
        },
        auto_cleanup: {
          type: 'boolean',
          example: false,
          default: false,
          description: 'If true, deactivates invalid instruments',
        },
        dry_run: {
          type: 'boolean',
          example: true,
          default: true,
          description: 'If true, only reports without making changes',
        },
        include_invalid_list: {
          type: 'boolean',
          example: false,
          default: false,
          description: 'If true, includes full list of invalid instruments in response (may be large). Default false to avoid large responses.',
        },
        probe_attempts: {
          type: 'number',
          example: 3,
          default: 3,
          description: 'Number of probe attempts per batch for consensus',
        },
        probe_interval_ms: {
          type: 'number',
          example: 1000,
          default: 1000,
          description: 'Milliseconds to wait between Vortex calls (>=1000 enforced)',
        },
        require_consensus: {
          type: 'number',
          example: 2,
          default: 2,
          description: 'Consensus threshold for classifying as no_ltp',
        },
        safe_cleanup: {
          type: 'boolean',
          example: true,
          default: true,
          description: 'If true, never deactivate indeterminate tokens (recommended)',
        },
      },
    },
  })
  async validateVortexInstruments(
    @Body()
    body: ValidateInstrumentsDto,
    @Query('async') asyncRaw?: string | boolean,
  ) {
    try {
      const isAsync =
        String(asyncRaw || '').toLowerCase() === 'true' || asyncRaw === true;
      if (isAsync) {
        const jobId = randomUUID();
        const key = `vayu:validate:job:${jobId}`;
        await this.redisService.set(
          key,
          {
            status: 'started',
            ts: Date.now(),
            filters: {
              exchange: body.exchange,
              instrument_name: body.instrument_name,
              symbol: body.symbol,
              batch_size: body.batch_size || 1000,
            },
          },
          3600,
        );
        setImmediate(async () => {
          try {
            await this.vortexInstrumentService.validateAndCleanupInstruments(
              {
                exchange: body.exchange,
                instrument_name: body.instrument_name,
                symbol: body.symbol,
                option_type: body.option_type,
                batch_size: body.batch_size || 1000,
                auto_cleanup: body.auto_cleanup || false,
                dry_run: body.dry_run !== false,
                include_invalid_list: false,
                probe_attempts: body.probe_attempts,
                probe_interval_ms: body.probe_interval_ms,
                require_consensus: body.require_consensus,
                safe_cleanup: body.safe_cleanup,
                limit: body.limit,
              },
              this.vortexProvider,
              async (p) => {
                try {
                  await this.redisService.set(
                    key,
                    { status: 'running', progress: p, ts: Date.now() },
                    3600,
                  );
                } catch (e) {
                  // eslint-disable-next-line no-console
                  console.warn('[Vayu Validate] Failed to write progress to Redis', e);
                }
              },
            );
            await this.redisService.set(
              key,
              { status: 'completed', ts: Date.now() },
              3600,
            );
          } catch (e) {
            await this.redisService.set(
              key,
              {
                status: 'failed',
                error: (e as any)?.message || 'unknown',
                ts: Date.now(),
              },
              3600,
            );
          }
        });
        return {
          success: true,
          message: 'Validation job started',
          jobId,
          timestamp: new Date().toISOString(),
        };
      }
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log('[Validate Instruments] Request received:', {
        exchange: body.exchange,
        instrument_name: body.instrument_name,
        symbol: body.symbol,
        batch_size: body.batch_size || 1000,
        auto_cleanup: body.auto_cleanup || false,
        dry_run: body.dry_run !== false, // Default to true
      });

      const includeInvalidList = body.include_invalid_list || false;

      const result = await this.vortexInstrumentService.validateAndCleanupInstruments(
        {
          exchange: body.exchange,
          instrument_name: body.instrument_name,
          symbol: body.symbol,
          option_type: body.option_type,
          batch_size: body.batch_size || 1000,
          auto_cleanup: body.auto_cleanup || false,
          dry_run: body.dry_run !== false,
          include_invalid_list: includeInvalidList,
          probe_attempts: body.probe_attempts,
          probe_interval_ms: body.probe_interval_ms,
          require_consensus: body.require_consensus,
          safe_cleanup: body.safe_cleanup,
          limit: body.limit,
        },
        this.vortexProvider,
      );

      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log('[Validate Instruments] Validation completed:', {
        total: result.summary.total_instruments,
        valid: result.summary.valid_ltp,
        invalid: result.summary.invalid_ltp,
        deactivated: result.cleanup?.deactivated || 0,
        invalidListIncluded: includeInvalidList,
      });

      // Build response - only include invalid_instruments list if requested
      const response: any = {
        success: true,
        summary: result.summary,
        cleanup: result.cleanup,
        batches_processed: result.batches_processed,
        timestamp: new Date().toISOString(),
      };
      if ((result as any)?.diagnostics) {
        response.diagnostics = (result as any).diagnostics;
      }

      // Add helpful messages based on cleanup status
      const autoCleanup = body.auto_cleanup || false;
      const dryRun = body.dry_run !== false;
      
      if (!autoCleanup && result.invalid_instruments.length > 0) {
        response.action_required = `Found ${result.invalid_instruments.length} invalid instruments. To deactivate them, run this endpoint again with: { "auto_cleanup": true, "dry_run": false }`;
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(`[Validate Instruments] Action required: Set auto_cleanup=true and dry_run=false to deactivate ${result.invalid_instruments.length} invalid instruments`);
      } else if (autoCleanup && dryRun) {
        response.action_required = `Dry run mode: Would deactivate ${result.invalid_instruments.length} instruments. Set "dry_run": false to actually deactivate them.`;
      } else if (autoCleanup && !dryRun && result.cleanup?.deactivated === 0) {
        response.action_required = 'No instruments were deactivated. Check logs for errors.';
      } else if (autoCleanup && !dryRun && result.cleanup?.deactivated > 0) {
        response.action_required = `Successfully deactivated ${result.cleanup.deactivated} instruments. Use DELETE /vayu/instruments/inactive to permanently delete them.`;
      }

      // Only include invalid_instruments list if explicitly requested
      if (includeInvalidList) {
        response.invalid_instruments = result.invalid_instruments;
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(`[Validate Instruments] Including ${result.invalid_instruments.length} invalid instruments in response`);
      } else {
        // Still log summary of invalid instruments for debugging
        if (result.invalid_instruments.length > 0) {
          // Console for easy debugging
          // eslint-disable-next-line no-console
          console.log(`[Validate Instruments] ${result.invalid_instruments.length} invalid instruments found (not included in response, set include_invalid_list=true to include)`);
          // Log first few examples
          const examples = result.invalid_instruments.slice(0, 5);
          // Console for easy debugging
          // eslint-disable-next-line no-console
          console.log('[Validate Instruments] Sample invalid instruments:', examples);
        }
        response.invalid_instruments_count = result.invalid_instruments.length;
        response.note = 'Invalid instruments list not included to avoid large responses. Set include_invalid_list=true to include the full list.';
      }

      return response;
    } catch (error) {
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.error('[Validate Instruments] Error:', error);
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to validate instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Post('vayu/validate-instruments/export')
  @ApiOperation({ summary: 'Validate instruments and export invalid set as CSV' })
  @ApiResponse({ status: 200, description: 'CSV content of invalid instruments' })
  @ApiBody({ type: ValidateInstrumentsDto })
  async exportInvalidInstruments(
    @Body() body: ValidateInstrumentsDto,
    @Request() req: any,
  ) {
    try {
      const result = await this.vortexInstrumentService.validateAndCleanupInstruments(
        {
          exchange: body.exchange,
          instrument_name: body.instrument_name,
          symbol: body.symbol,
          option_type: body.option_type,
          batch_size: body.batch_size || 1000,
          auto_cleanup: false,
          dry_run: true,
          include_invalid_list: true,
          probe_attempts: body.probe_attempts,
          probe_interval_ms: body.probe_interval_ms,
          require_consensus: body.require_consensus,
          safe_cleanup: body.safe_cleanup,
        },
        this.vortexProvider,
      );

      const rows = [
        ['token', 'exchange', 'symbol', 'instrument_name', 'reason'],
        ...result.invalid_instruments.map((x: any) => [
          x.token,
          x.exchange || '',
          x.symbol || '',
          x.instrument_name || '',
          x.reason || 'no_ltp_data',
        ]),
      ];
      const csv = rows.map((r) => r.map((v) => String(v).replace(/"/g, '""')).map((v) => /[",\n]/.test(v) ? `"${v}"` : v).join(',')).join('\n');
      (req?.res || (req as any).res)?.setHeader?.('Content-Type', 'text/csv');
      (req?.res || (req as any).res)?.setHeader?.('Content-Disposition', 'attachment; filename="invalid_instruments.csv"');
      return csv;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to export invalid instruments', error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Post('vayu/validate-instruments/stream')
  @ApiOperation({
    summary: 'Stream live status for Vayu validation/cleanup (SSE)',
    description:
      'Streams JSON events per batch. Emits: { event, total_instruments, batch_index, batches, valid_so_far, invalid_so_far, indeterminate_so_far }',
  })
  @ApiProduces('text/event-stream')
  @ApiBody({ type: ValidateInstrumentsDto })
  async streamValidateVortexInstruments(
    @Body() body: ValidateInstrumentsDto,
    @Res() res?: any,
  ) {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const send = (data: any) => {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[Vayu Validate SSE] write failed:', e);
        }
      };
      send({
        success: true,
        event: 'start',
        ts: new Date().toISOString(),
      });
      const result = await this.vortexInstrumentService.validateAndCleanupInstruments(
        {
          exchange: body.exchange,
          instrument_name: body.instrument_name,
          symbol: body.symbol,
          option_type: body.option_type,
          batch_size: body.batch_size || 1000,
          auto_cleanup: body.auto_cleanup || false,
          dry_run: body.dry_run !== false,
          include_invalid_list: body.include_invalid_list || false,
          probe_attempts: body.probe_attempts,
          probe_interval_ms: body.probe_interval_ms,
          require_consensus: body.require_consensus,
          safe_cleanup: body.safe_cleanup,
          limit: body.limit,
        },
        this.vortexProvider,
        (p) =>
          send({
            success: true,
            event: 'progress',
            ...p,
            ts: new Date().toISOString(),
          }),
      );
      send({
        success: true,
        event: 'complete',
        result,
        ts: new Date().toISOString(),
      });
      res.end();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[Vayu Validate SSE] Error:', error);
      try {
        res.write(
          `data: ${JSON.stringify({
            success: false,
            error: (error as any)?.message || 'unknown',
          })}\n\n`,
        );
      } catch {}
      res.end();
    }
  }

  @ApiTags('vayu')
  @Get('vayu/validate-instruments/status')
  @ApiOperation({ summary: 'Poll Vayu validation/cleanup status' })
  @ApiProduces('application/json')
  @ApiQuery({ name: 'jobId', required: true })
  async getValidateStatus(@Query('jobId') jobId: string) {
    try {
      if (!jobId) {
        throw new HttpException(
          { success: false, message: 'jobId is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const key = `vayu:validate:job:${jobId}`;
      const data = await this.redisService.get<any>(key);
      if (!data) {
        throw new HttpException(
          { success: false, message: 'Job not found or expired' },
          HttpStatus.NOT_FOUND,
        );
      }
      return { success: true, data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch validation status',
          error: (error as any)?.message || 'unknown',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/instruments')
  @ApiOperation({ summary: 'Get Vayu instruments with optional filters' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'instrument_name', required: false, example: 'EQ' })
  @ApiQuery({ name: 'symbol', required: false, example: 'RELIANCE' })
  @ApiQuery({ name: 'option_type', required: false, example: 'CE' })
  @ApiQuery({ name: 'is_active', required: false, example: true })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({
    name: 'include_ltp',
    required: false,
    example: true,
    description:
      'If true (default), enrich each instrument with LTP using Vortex quotes (mode=ltp)',
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: false,
    description: 'If true, only instruments with a valid last_price are returned',
  })
  async getVortexInstruments(
    @Query('exchange') exchange?: string,
    @Query('instrument_name') instrumentName?: string,
    @Query('symbol') symbol?: string,
    @Query('option_type') optionType?: string,
    @Query('is_active') isActive?: boolean,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('include_ltp') includeLtpRaw?: string | boolean,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    try {
      const filters = {
        exchange,
        instrument_name: instrumentName,
        symbol,
        option_type: optionType,
        is_active: isActive,
        limit: limit ? parseInt(limit.toString()) : undefined,
        offset: offset ? parseInt(offset.toString()) : undefined,
      };

      const result =
        await this.vortexInstrumentService.getVortexInstruments(filters);
      const includeLtp =
        String(includeLtpRaw || 'true').toLowerCase() === 'true' ||
        includeLtpRaw === true;
      const ltpOnly =
        String(ltpOnlyRaw || 'false').toLowerCase() === 'true' ||
        ltpOnlyRaw === true;
      const instruments = result.instruments || [];
      let pairLtp: Record<string, { last_price: number | null }> = {};
      if (includeLtp && instruments.length) {
        const pairs = instruments.map((i) => ({
          exchange: String(i?.exchange || '').toUpperCase(),
          token: String(i?.token),
        }));
        pairLtp = await this.requestBatchingService.getLtpByPairs(
          pairs as any,
          this.vortexProvider,
        );
      }
      const enriched = instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = includeLtp ? pairLtp?.[key]?.last_price ?? null : null;
        return { ...i, last_price: lp };
      });
      const filtered = ltpOnly
        ? enriched.filter(
            (v: any) =>
              Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0),
          )
        : enriched;
      const filteredOut = enriched.length - filtered.length;

      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log('[Get Vayu Instruments] Returning', {
        total: result.total,
        count: filtered.length,
        include_ltp: includeLtp,
        ltp_only: ltpOnly,
        filtered_out: filteredOut,
        hasDescriptions: filtered.some((i) => (i as any)?.description),
      });
      
      return {
        success: true,
        data: {
          instruments: filtered,
          total: result.total,
          pagination: {
            returned: filtered.length,
            filtered_out: filteredOut,
          },
        },
        include_ltp: includeLtp,
        ltp_only: ltpOnly,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch Vayu instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/instruments/search')
  @ApiOperation({
    summary: 'Search Vayu instruments by symbol or instrument name',
  })
  @ApiQuery({ name: 'q', required: true, example: 'RELIANCE' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({
    name: 'include_ltp',
    required: false,
    example: true,
    description:
      'If true (default), enrich each instrument with LTP using Vortex quotes (mode=ltp)',
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: false,
    description: 'If true, only instruments with a valid last_price are returned',
  })
  async searchVortexInstruments(
    @Query('q') query: string,
    @Query('limit') limit?: number,
    @Query('include_ltp') includeLtpRaw?: string | boolean,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    try {
      if (!query || query.trim().length === 0) {
        return {
          success: true,
          data: { instruments: [] },
        };
      }

      const instruments =
        await this.vortexInstrumentService.searchVortexInstruments(
          query.trim(),
          limit ? parseInt(limit.toString()) : 50,
        );

      const includeLtp =
        String(includeLtpRaw || 'true').toLowerCase() === 'true' ||
        includeLtpRaw === true;
      const ltpOnly =
        String(ltpOnlyRaw || 'false').toLowerCase() === 'true' ||
        ltpOnlyRaw === true;
      let list = instruments || [];
      let pairLtp: Record<string, { last_price: number | null }> = {};
      if (includeLtp && list.length) {
        const pairs = list.map((i) => ({
          exchange: String((i as any)?.exchange || '').toUpperCase(),
          token: String((i as any)?.token),
        }));
        pairLtp = await this.requestBatchingService.getLtpByPairs(
          pairs as any,
          this.vortexProvider,
        );
      }
      const enriched = list.map((i) => {
        const key = `${String((i as any).exchange || '').toUpperCase()}-${String((i as any).token)}`;
        const lp = includeLtp ? pairLtp?.[key]?.last_price ?? null : null;
        return { ...(i as any), last_price: lp };
      });
      const filtered = ltpOnly
        ? enriched.filter(
            (v: any) =>
              Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0),
          )
        : enriched;

      return {
        success: true,
        data: { instruments: filtered },
        include_ltp: includeLtp,
        ltp_only: ltpOnly,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to search Vayu instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/instruments/stats')
  @ApiOperation({ summary: 'Get Vayu instrument statistics' })
  async getVortexInstrumentStats() {
    try {
      const stats =
        await this.vortexInstrumentService.getVortexInstrumentStats();
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch Vayu instrument stats',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/instruments/:token')
  @ApiOperation({ summary: 'Get specific Vayu instrument by token' })
  @ApiResponse({ status: 200, description: 'Vayu instrument found' })
  @ApiResponse({ status: 404, description: 'Vayu instrument not found' })
  async getVortexInstrumentByToken(@Param('token') token: string) {
    try {
      const tokenNumber = parseInt(token);
      if (!Number.isFinite(tokenNumber)) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid token format',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const instrument =
        await this.vortexInstrumentService.getVortexInstrumentByToken(
          tokenNumber,
        );

      if (!instrument) {
        throw new HttpException(
          {
            success: false,
            message: 'Vayu instrument not found',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        data: { instrument },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch Vayu instrument',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('vayu/instruments/sync')
  @ApiOperation({ summary: 'Manually sync Vayu instruments from CSV' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({
    name: 'csv_url',
    required: false,
    description: 'Optional CSV URL override',
  })
  async syncVortexInstruments(
    @Query('exchange') exchange?: string,
    @Query('csv_url') csvUrl?: string,
  ) {
    try {
      const result = await this.vortexInstrumentService.syncVortexInstruments(
        exchange,
        csvUrl,
      );
      return {
        success: true,
        message: 'Vayu instruments synced successfully',
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to sync Vayu instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/options/chain/:symbol')
  @ApiOperation({ summary: 'Get options chain for a symbol' })
  @ApiQuery({ name: 'ltp_only', required: false, example: true, description: 'If true, only options with valid last_price are returned' })
  async getVortexOptionsChain(@Param('symbol') symbol: string, @Query('ltp_only') ltpOnlyRaw?: string | boolean) {
    try {
      const result =
        await this.vortexInstrumentService.getVortexOptionsChain(symbol);

      // Get live prices for all options
      const allTokens = Object.values(result.options)
        .flatMap((expiry) => Object.values(expiry))
        .flatMap((strike) => [strike.CE?.token, strike.PE?.token])
        .filter(Boolean) as number[];

      const ltp =
        allTokens.length > 0
          ? await this.vortexInstrumentService.getVortexLTP(allTokens)
          : {};

      // Add live prices to options chain
      const optionsWithPrices = { ...result.options };
      for (const [expiry, strikes] of Object.entries(optionsWithPrices)) {
        for (const [strikeStr, optionPair] of Object.entries(strikes)) {
          const strike = Number(strikeStr);
          if (optionPair.CE) {
            optionPair.CE = {
              ...optionPair.CE,
              last_price: ltp?.[optionPair.CE.token]?.last_price ?? null,
            } as any;
          }
          if (optionPair.PE) {
            optionPair.PE = {
              ...optionPair.PE,
              last_price: ltp?.[optionPair.PE.token]?.last_price ?? null,
            } as any;
          }
        }
      }

      // Optional filter by LTP
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);
      if (ltpOnly) {
        for (const [expiry, strikes] of Object.entries(optionsWithPrices)) {
          for (const [strikeStr, optionPair] of Object.entries(strikes)) {
            const ceOk = Number.isFinite((optionPair as any)?.CE?.last_price) && (((optionPair as any)?.CE?.last_price ?? 0) > 0);
            const peOk = Number.isFinite((optionPair as any)?.PE?.last_price) && (((optionPair as any)?.PE?.last_price ?? 0) > 0);
            if (!ceOk && !peOk) {
              delete (strikes as any)[strikeStr];
            }
          }
          if (Object.keys(strikes).length === 0) {
            delete (optionsWithPrices as any)[expiry];
          }
        }
      }

      return {
        success: true,
        data: {
          symbol: result.symbol,
          expiries: result.expiries,
          strikes: result.strikes,
          options: optionsWithPrices,
          performance: {
            queryTime: result.queryTime,
          },
          ltp_only: ltpOnly || false,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get options chain',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Post('vayu/instruments/batch')
  @ApiOperation({ summary: 'Batch lookup for multiple Vayu instruments' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tokens: {
          type: 'array',
          items: { type: 'number' },
          maxItems: 100,
          description: 'Array of instrument tokens (max 100)',
        },
      },
      required: ['tokens'],
    },
  })
  @ApiQuery({ name: 'ltp_only', required: false, example: true, description: 'If true, only instruments with a valid last_price are returned' })
  async getVortexInstrumentsBatch(@Body() body: BatchTokensDto, @Query('ltp_only') ltpOnlyRaw?: string | boolean) {
    try {
      if (
        !body.tokens ||
        !Array.isArray(body.tokens) ||
        body.tokens.length === 0
      ) {
        throw new HttpException(
          { success: false, message: 'Tokens array is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (body.tokens.length > 100) {
        throw new HttpException(
          { success: false, message: 'Maximum 100 tokens allowed' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result =
        await this.vortexInstrumentService.getVortexInstrumentsBatch(
          body.tokens,
        );

      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);

      // Build and optionally filter entries by LTP
      const entries = Object.entries(result.instruments).map(([token, instrument]) => [
        token,
        {
          token: instrument.token,
          symbol: instrument.symbol,
          exchange: instrument.exchange,
          instrument_name: instrument.instrument_name,
          expiry_date: instrument.expiry_date,
          option_type: instrument.option_type,
          strike_price: instrument.strike_price,
          tick: instrument.tick,
          lot_size: instrument.lot_size,
          last_price: result.ltp?.[instrument.token]?.last_price ?? null,
        },
      ] as const);
      const filteredEntries = ltpOnly
        ? entries.filter(([, v]) => Number.isFinite((v as any)?.last_price) && (((v as any)?.last_price ?? 0) > 0))
        : entries;

      return {
        success: true,
        data: {
          instruments: Object.fromEntries(filteredEntries),
          ltp: result.ltp,
          performance: {
            queryTime: result.queryTime,
          },
          ltp_only: ltpOnly || false,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get batch instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ===== MARKET SEGMENT ENDPOINTS =====

  @ApiTags('vayu')
  @Get('vayu/equities')
  @ApiOperation({ summary: 'Get Vayu equities with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol search' })
  @ApiQuery({
    name: 'exchange',
    required: false,
    description: 'Exchange filter',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'ltp_only', required: false, example: true, description: 'If true, only instruments with a valid last_price are returned' })
  async getVortexEquities(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    return this.vayuEquityService.getVortexEquities(
      q,
      exchange,
      limit,
      offset,
      ltpOnlyRaw,
    );
  }
  /*
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);

      if (!ltpOnly) {
        const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['EQUITIES'],
          limit: requestedLimit,
          offset: startOffset,
        });
        const pairs = this.vortexInstrumentService.buildPairsFromInstruments(result.instruments as any);
        const ltpByPair = pairs.length
          ? await this.requestBatchingService.getLtpByPairs(pairs as any, this.vortexProvider)
          : {};
        const list = result.instruments.map((i) => {
          const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
          const lp = ltpByPair?.[key]?.last_price ?? null;
          return {
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            description: (i as any)?.description || null,
            last_price: lp,
          };
        });
        return {
          success: true,
          data: {
            instruments: list,
            pagination: {
              total: result.total,
              hasMore: result.hasMore,
            },
            ltp_only: false,
            performance: { queryTime: Date.now() - t0 },
          },
        };
      }

      // Fast single-shot probe for ltp_only=true
      const probeLimit = Math.min(500, Math.max(requestedLimit * 4, requestedLimit + startOffset));
      const page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
        query: q,
        exchange: exchange ? [exchange] : undefined,
        instrument_type: ['EQUITIES'],
        limit: probeLimit,
        offset: startOffset,
        skip_count: true,
      });
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(page.instruments as any);
      const ltpByPair = pairs.length
        ? await this.requestBatchingService.getLtpByPairs(pairs as any, this.vortexProvider)
        : {};
      const enriched = page.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        return { token: i.token, symbol: i.symbol, exchange: i.exchange, description: (i as any)?.description || null, last_price: lp };
      });
      const filtered = enriched.filter((v: any) => Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0));
      const sliced = filtered.slice(0, requestedLimit);

      return {
        success: true,
        data: {
          instruments: sliced,
          pagination: {
            total: undefined,
            hasMore: page.hasMore,
          },
          ltp_only: true,
          performance: { queryTime: Date.now() - t0 },
        },
      };
  */

  @ApiTags('vayu')
  @Get('vayu/futures')
  @ApiOperation({ summary: 'Get Vayu futures with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol search' })
  @ApiQuery({
    name: 'exchange',
    required: false,
    description: 'Exchange filter',
  })
  @ApiQuery({
    name: 'expiry_from',
    required: false,
    description: 'Expiry date from',
  })
  @ApiQuery({
    name: 'expiry_to',
    required: false,
    description: 'Expiry date to',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'ltp_only', required: false, example: true, description: 'If true, only instruments with a valid last_price are returned' })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['relevance', 'expiry', 'strike'],
    description: 'Sort mode: relevance (default), expiry, or strike',
  })
  async getVortexFutures(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('sort') sort?: 'relevance' | 'expiry' | 'strike',
  ) {
    return this.vayuFutureService.getVortexFutures(
      q,
      exchange,
      expiry_from,
      expiry_to,
      limit,
      offset,
      ltpOnlyRaw,
      sort,
    );
  }
  /*
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);
      const sortMode = (sort || 'relevance').toString().toLowerCase();

      // Parse trading-style F&O queries like "nifty 28mar 26000" or "banknifty 25jan".
      // The parser only provides hints; explicit query params always win.
      const parsed = q && q.trim() ? this.fnoQueryParser.parse(q) : undefined;
      const underlyingSymbol = parsed?.underlying;
      const effectiveQuery = underlyingSymbol ? undefined : q;
      const effectiveExpiryFrom = parsed?.expiryFrom || expiry_from;
      const effectiveExpiryTo = parsed?.expiryTo || expiry_to;

      // Console log for easy debugging and later tuning of parsing behaviour
      // eslint-disable-next-line no-console
      console.log('[Vayu Futures Search]', {
        q,
        underlying: underlyingSymbol,
        expiry_from: effectiveExpiryFrom,
        expiry_to: effectiveExpiryTo,
        exchange,
        ltp_only: ltpOnly,
      });

      const parsedLabel =
        parsed && (parsed.underlying || parsed.strike || parsed.optionType || parsed.expiryFrom)
          ? 'yes'
          : 'no';
      this.metrics.foSearchRequestsTotal.inc({
        endpoint: 'vayu_futures',
        ltp_only: String(ltpOnly),
        parsed: parsedLabel,
      });
      const latencyTimer = this.metrics.foSearchLatencySeconds.startTimer({
        endpoint: 'vayu_futures',
        ltp_only: String(ltpOnly),
      });

      const cacheKeyBase = [
        'vayu:fno:futures',
        `under=${underlyingSymbol || 'ANY'}`,
        `ex=${exchange || 'ANY'}`,
        `ef=${effectiveExpiryFrom || 'ANY'}`,
        `et=${effectiveExpiryTo || 'ANY'}`,
        `ltp=${ltpOnly ? '1' : '0'}`,
        `lim=${requestedLimit}`,
        `off=${startOffset}`,
        `sort=${sortMode}`,
      ].join('|');
      const cacheKey = cacheKeyBase;
      const foCacheTtlSec = Number(process.env.FO_CACHE_TTL_SECONDS || 2);

      try {
        const cached = await this.redisService.get<any>(cacheKey);
        if (cached && cached.success === true) {
          // eslint-disable-next-line no-console
          console.log('[Vayu Futures Search] Cache HIT', { cacheKey });
          latencyTimer();
          return cached;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu Futures Search] Cache READ failed (non-fatal)', (e as any)?.message);
      }

      if (!ltpOnly) {
        // First attempt: use parsed underlying_symbol + filters
        let result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          // Use exact underlying_symbol when parsed to keep DB filters index-friendly
          query: effectiveQuery,
          underlying_symbol: underlyingSymbol,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['FUTSTK', 'FUTIDX'],
          expiry_from: effectiveExpiryFrom,
          expiry_to: effectiveExpiryTo,
          limit: requestedLimit,
          offset: startOffset,
          sort_by: 'expiry_date',
          sort_order: 'asc',
          only_active: false,
        });

        // Graceful fallback: if no instruments found and we had a query,
        // retry with a looser fuzzy symbol search (query=q) and no underlying_symbol.
        if ((!result.instruments || result.instruments.length === 0) && q && q.trim()) {
          // eslint-disable-next-line no-console
          console.log('[Vayu Futures Search] No rows for parsed filters, falling back to fuzzy symbol search');
          result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
            query: q.trim(),
            underlying_symbol: undefined,
            exchange: exchange ? [exchange] : undefined,
            instrument_type: ['FUTSTK', 'FUTIDX'],
            expiry_from: effectiveExpiryFrom,
            expiry_to: effectiveExpiryTo,
            limit: requestedLimit,
            offset: startOffset,
            sort_by: 'expiry_date',
            sort_order: 'asc',
            only_active: false,
          });
        }
        const pairs = this.vortexInstrumentService.buildPairsFromInstruments(result.instruments as any);
        const ltpByPair = pairs.length
          ? await this.requestBatchingService.getLtpByPairs(pairs as any, this.vortexProvider)
          : {};
        const list = result.instruments.map((i) => {
          const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
          const lp = ltpByPair?.[key]?.last_price ?? null;
          const daysToExpiry = this.computeDaysToExpiry(i.expiry_date as any);
          return {
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            description: (i as any)?.description || null,
            expiry_date: i.expiry_date,
            instrument_name: i.instrument_name,
            tick: (i as any)?.tick,
            lot_size: (i as any)?.lot_size,
            days_to_expiry: daysToExpiry,
            last_price: lp,
          };
        });
        const ranked = this.rankFoInstruments(list, sortMode, undefined);
        const response = {
          success: true,
          data: {
            instruments: ranked,
            pagination: {
              total: result.total,
              hasMore: result.hasMore,
            },
            ltp_only: false,
            performance: { queryTime: Date.now() - t0 },
          },
        };
        try {
          await this.redisService.set(cacheKey, response, foCacheTtlSec);
          // eslint-disable-next-line no-console
          console.log('[Vayu Futures Search] Cache SET', { cacheKey, ttl: foCacheTtlSec });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[Vayu Futures Search] Cache WRITE failed (non-fatal)', (e as any)?.message);
        }
        latencyTimer();
        return response;
      }

      // Fast single-shot probe for ltp_only=true
      const probeLimit = Math.min(500, Math.max(requestedLimit * 4, requestedLimit + startOffset));
      // First attempt: parsed filters + only_active=true for tradable subset
      let page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
        query: effectiveQuery,
        underlying_symbol: underlyingSymbol,
        exchange: exchange ? [exchange] : undefined,
        instrument_type: ['FUTSTK', 'FUTIDX'],
        expiry_from: effectiveExpiryFrom,
        expiry_to: effectiveExpiryTo,
        limit: probeLimit,
        offset: startOffset,
        skip_count: true,
        sort_by: 'expiry_date',
        sort_order: 'asc',
        only_active: true,
      });

      if ((!page.instruments || page.instruments.length === 0) && q && q.trim()) {
        // eslint-disable-next-line no-console
        console.log('[Vayu Futures Search] ltp_only probe empty, falling back to fuzzy symbol search');
        page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q.trim(),
          underlying_symbol: undefined,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['FUTSTK', 'FUTIDX'],
          expiry_from: effectiveExpiryFrom,
          expiry_to: effectiveExpiryTo,
          limit: probeLimit,
          offset: startOffset,
          skip_count: true,
          sort_by: 'expiry_date',
          sort_order: 'asc',
          only_active: true,
        });
      }
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(page.instruments as any);
      const ltpByPair = pairs.length
        ? await this.requestBatchingService.getLtpByPairs(pairs as any, this.vortexProvider)
        : {};
      const enriched = page.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          description: (i as any)?.description || null,
          expiry_date: i.expiry_date as any,
          instrument_name: i.instrument_name,
          tick: (i as any)?.tick,
          lot_size: (i as any)?.lot_size,
          days_to_expiry: this.computeDaysToExpiry(i.expiry_date as any),
          last_price: lp,
        };
      });
      const filtered = enriched.filter((v: any) => Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0));
      const ranked = this.rankFoInstruments(filtered, sortMode, undefined);
      const sliced = ranked.slice(0, requestedLimit);

      const response = {
        success: true,
        data: {
          instruments: sliced,
          pagination: {
            total: undefined,
            hasMore: page.hasMore,
          },
          ltp_only: true,
          performance: { queryTime: Date.now() - t0 },
        },
      };
      try {
        await this.redisService.set(cacheKey, response, foCacheTtlSec);
        // eslint-disable-next-line no-console
        console.log('[Vayu Futures Search] Cache SET (ltp_only)', {
          cacheKey,
          ttl: foCacheTtlSec,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu Futures Search] Cache WRITE failed (ltp_only, non-fatal)', (e as any)?.message);
      }
      latencyTimer();
      return response;
  */

  @ApiTags('vayu')
  @Get('vayu/options')
  @ApiOperation({ summary: 'Get Vayu options with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol search' })
  @ApiQuery({
    name: 'exchange',
    required: false,
    description: 'Exchange filter',
  })
  @ApiQuery({ name: 'option_type', required: false, enum: ['CE', 'PE'] })
  @ApiQuery({
    name: 'expiry_from',
    required: false,
    description: 'Expiry date from',
  })
  @ApiQuery({
    name: 'expiry_to',
    required: false,
    description: 'Expiry date to',
  })
  @ApiQuery({ name: 'strike_min', required: false, type: Number })
  @ApiQuery({ name: 'strike_max', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'ltp_only', required: false, example: true, description: 'If true, only instruments with a valid last_price are returned' })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['relevance', 'expiry', 'strike'],
    description: 'Sort mode: relevance (default), expiry, or strike',
  })
  async getVortexOptions(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('option_type') option_type?: 'CE' | 'PE',
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('strike_min') strike_min?: number,
    @Query('strike_max') strike_max?: number,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('sort') sort?: 'relevance' | 'expiry' | 'strike',
  ) {
    return this.vayuOptionService.getVortexOptions(
      q,
      exchange,
      option_type,
      expiry_from,
      expiry_to,
      strike_min,
      strike_max,
      limit,
      offset,
      ltpOnlyRaw,
      sort,
    );
  }
  /*
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);
       const sortMode = (sort || 'relevance').toString().toLowerCase();

      // Parse trading-style options queries like "nifty 26000 ce" or "banknifty 45000 pe".
      const parsed = q && q.trim() ? this.fnoQueryParser.parse(q) : undefined;
      const underlyingSymbol = parsed?.underlying;

      let effectiveQuery = underlyingSymbol ? undefined : q;
      let effectiveOptionType: 'CE' | 'PE' | undefined = option_type;
      let effectiveExpiryFrom = parsed?.expiryFrom || expiry_from;
      let effectiveExpiryTo = parsed?.expiryTo || expiry_to;
      let effectiveStrikeMin = strike_min;
      let effectiveStrikeMax = strike_max;

      // Only use parsed hints when explicit query params are not provided
      if (!effectiveOptionType && parsed?.optionType) {
        effectiveOptionType = parsed.optionType;
      }
      if (
        parsed?.strike !== undefined &&
        effectiveStrikeMin === undefined &&
        effectiveStrikeMax === undefined
      ) {
        effectiveStrikeMin = parsed.strike;
        effectiveStrikeMax = parsed.strike;
      }

      // Console log for easy debugging of parsing behaviour and downstream filters
      // eslint-disable-next-line no-console
      console.log('[Vayu Options Search]', {
        q,
        underlying: underlyingSymbol,
        strike: parsed?.strike,
        option_type: effectiveOptionType,
        expiry_from: effectiveExpiryFrom,
        expiry_to: effectiveExpiryTo,
        exchange,
        ltp_only: ltpOnly,
      });

      const parsedLabel =
        parsed && (parsed.underlying || parsed.strike || parsed.optionType || parsed.expiryFrom)
          ? 'yes'
          : 'no';
      this.metrics.foSearchRequestsTotal.inc({
        endpoint: 'vayu_options',
        ltp_only: String(ltpOnly),
        parsed: parsedLabel,
      });
      const latencyTimer = this.metrics.foSearchLatencySeconds.startTimer({
        endpoint: 'vayu_options',
        ltp_only: String(ltpOnly),
      });

      const cacheKeyBase = [
        'vayu:fno:options',
        `under=${underlyingSymbol || 'ANY'}`,
        `ex=${exchange || 'ANY'}`,
        `of=${effectiveOptionType || 'ANY'}`,
        `ef=${effectiveExpiryFrom || 'ANY'}`,
        `et=${effectiveExpiryTo || 'ANY'}`,
        `sm=${effectiveStrikeMin ?? 'ANY'}`,
        `sx=${effectiveStrikeMax ?? 'ANY'}`,
        `ltp=${ltpOnly ? '1' : '0'}`,
        `lim=${requestedLimit}`,
        `off=${startOffset}`,
        `sort=${sortMode}`,
      ].join('|');
      const cacheKey = cacheKeyBase;
      const foCacheTtlSec = Number(process.env.FO_CACHE_TTL_SECONDS || 2);

      try {
        const cached = await this.redisService.get<any>(cacheKey);
        if (cached && cached.success === true) {
          // eslint-disable-next-line no-console
          console.log('[Vayu Options Search] Cache HIT', { cacheKey });
          latencyTimer();
          return cached;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu Options Search] Cache READ failed (non-fatal)', (e as any)?.message);
      }

      if (!ltpOnly) {
        // First attempt: parsed filters with exact underlying_symbol
        let result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          // Use exact underlying_symbol when parsed to keep DB filters tight and index-friendly
          query: effectiveQuery,
          underlying_symbol: underlyingSymbol,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['OPTSTK', 'OPTIDX'],
          option_type: effectiveOptionType,
          expiry_from: effectiveExpiryFrom,
          expiry_to: effectiveExpiryTo,
          strike_min: effectiveStrikeMin,
          strike_max: effectiveStrikeMax,
          options_only: true,
          limit: requestedLimit,
          offset: startOffset,
          sort_by: 'expiry_date',
          sort_order: 'asc',
          only_active: false,
        });

        if ((!result.instruments || result.instruments.length === 0) && q && q.trim()) {
          // eslint-disable-next-line no-console
          console.log('[Vayu Options Search] No rows for parsed filters, falling back to fuzzy symbol search');
          result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
            query: q.trim(),
            underlying_symbol: undefined,
            exchange: exchange ? [exchange] : undefined,
            instrument_type: ['OPTSTK', 'OPTIDX'],
            option_type: effectiveOptionType,
            expiry_from: effectiveExpiryFrom,
            expiry_to: effectiveExpiryTo,
            strike_min: effectiveStrikeMin,
            strike_max: effectiveStrikeMax,
            options_only: true,
            limit: requestedLimit,
            offset: startOffset,
            sort_by: 'expiry_date',
            sort_order: 'asc',
            only_active: false,
          });
        }
        const pairs = this.vortexInstrumentService.buildPairsFromInstruments(result.instruments as any);
        const ltpByPair = pairs.length ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any) : {};
        const parsedStrikeHint = parsed?.strike;
        const list = result.instruments.map((i) => {
          const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
          const lp = ltpByPair?.[key]?.last_price ?? null;
          const daysToExpiry = this.computeDaysToExpiry(i.expiry_date as any);
          return {
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            description: (i as any)?.description || null,
            expiry_date: i.expiry_date,
            option_type: i.option_type,
            strike_price: i.strike_price,
            days_to_expiry: daysToExpiry,
            last_price: lp,
          };
        });
        const ranked = this.rankFoInstruments(list, sortMode, parsedStrikeHint);
        const response = {
          success: true,
          data: {
            instruments: ranked,
            pagination: {
              total: result.total,
              hasMore: result.hasMore,
            },
            ltp_only: false,
            performance: { queryTime: Date.now() - t0 },
          },
        };
        try {
          await this.redisService.set(cacheKey, response, foCacheTtlSec);
          // eslint-disable-next-line no-console
          console.log('[Vayu Options Search] Cache SET', { cacheKey, ttl: foCacheTtlSec });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[Vayu Options Search] Cache WRITE failed (non-fatal)', (e as any)?.message);
        }
        latencyTimer();
        return response;
      }

      // Fast single-shot probe for ltp_only=true
      const probeLimit = Math.min(500, Math.max(requestedLimit * 4, requestedLimit + startOffset));
      // First attempt: parsed filters with only_active=true for tradable subset
      let page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
        query: effectiveQuery,
        underlying_symbol: underlyingSymbol,
        exchange: exchange ? [exchange] : undefined,
        instrument_type: ['OPTSTK', 'OPTIDX'],
        option_type: effectiveOptionType,
        expiry_from: effectiveExpiryFrom,
        expiry_to: effectiveExpiryTo,
        strike_min: effectiveStrikeMin,
        strike_max: effectiveStrikeMax,
        options_only: true,
        limit: probeLimit,
        offset: startOffset,
        skip_count: true,
        sort_by: 'expiry_date',
        sort_order: 'asc',
        only_active: true,
      });

      if ((!page.instruments || page.instruments.length === 0) && q && q.trim()) {
        // eslint-disable-next-line no-console
        console.log('[Vayu Options Search] ltp_only probe empty, falling back to fuzzy symbol search');
        page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q.trim(),
          underlying_symbol: undefined,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['OPTSTK', 'OPTIDX'],
          option_type: effectiveOptionType,
          expiry_from: effectiveExpiryFrom,
          expiry_to: effectiveExpiryTo,
          strike_min: effectiveStrikeMin,
          strike_max: effectiveStrikeMax,
          options_only: true,
          limit: probeLimit,
          offset: startOffset,
          skip_count: true,
          sort_by: 'expiry_date',
          sort_order: 'asc',
          only_active: true,
        });
      }
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(page.instruments as any);
      const ltpByPair = pairs.length ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any) : {};
      const enriched = page.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          description: (i as any)?.description || null,
          expiry_date: i.expiry_date as any,
          option_type: i.option_type,
          strike_price: i.strike_price,
          days_to_expiry: this.computeDaysToExpiry(i.expiry_date as any),
          last_price: lp,
        };
      });
      const filtered = enriched.filter((v: any) => Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0));
      const ranked = this.rankFoInstruments(filtered, sortMode, parsed?.strike);
      const sliced = ranked.slice(0, requestedLimit);

      const response = {
        success: true,
        data: {
          instruments: sliced,
          pagination: {
            total: undefined,
            hasMore: page.hasMore,
          },
          ltp_only: true,
          performance: { queryTime: Date.now() - t0 },
        },
      };
      try {
        await this.redisService.set(cacheKey, response, foCacheTtlSec);
        // eslint-disable-next-line no-console
        console.log('[Vayu Options Search] Cache SET (ltp_only)', {
          cacheKey,
          ttl: foCacheTtlSec,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu Options Search] Cache WRITE failed (ltp_only, non-fatal)', (e as any)?.message);
      }
      latencyTimer();
      return response;
  */

  @ApiTags('vayu')
  @Get('vayu/mcx-options')
  @ApiOperation({ summary: 'Get Vayu MCX options with trading-style search' })
  @ApiQuery({ name: 'q', required: false, description: 'Trading-style search (e.g., \"gold 62000 ce\")' })
  @ApiQuery({ name: 'option_type', required: false, enum: ['CE', 'PE'] })
  @ApiQuery({
    name: 'expiry_from',
    required: false,
    description: 'Expiry date from (YYYYMMDD)',
  })
  @ApiQuery({
    name: 'expiry_to',
    required: false,
    description: 'Expiry date to (YYYYMMDD)',
  })
  @ApiQuery({ name: 'strike_min', required: false, type: Number })
  @ApiQuery({ name: 'strike_max', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: true,
    description: 'If true, only instruments with a valid last_price are returned',
  })
  async getVortexMcxOptions(
    @Query('q') q?: string,
    @Query('option_type') option_type?: 'CE' | 'PE',
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('strike_min') strike_min?: number,
    @Query('strike_max') strike_max?: number,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    return this.vayuOptionService.getVortexMcxOptions(
      q,
      option_type,
      expiry_from,
      expiry_to,
      strike_min,
      strike_max,
      limit,
      offset,
      ltpOnlyRaw,
    );
  }
  /*
      const ltpOnly =
        String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;

      // Parse trading-style MCX options queries like "gold 62000 ce"
      const parsed = q && q.trim() ? this.fnoQueryParser.parse(q) : undefined;
      const underlyingSymbol = parsed?.underlying;

      let effectiveQuery = underlyingSymbol ? undefined : q;
      let effectiveOptionType: 'CE' | 'PE' | undefined = option_type;
      let effectiveExpiryFrom = parsed?.expiryFrom || expiry_from;
      let effectiveExpiryTo = parsed?.expiryTo || expiry_to;
      let effectiveStrikeMin = strike_min;
      let effectiveStrikeMax = strike_max;

      if (!effectiveOptionType && parsed?.optionType) {
        effectiveOptionType = parsed.optionType;
      }
      if (
        parsed?.strike !== undefined &&
        effectiveStrikeMin === undefined &&
        effectiveStrikeMax === undefined
      ) {
        effectiveStrikeMin = parsed.strike;
        effectiveStrikeMax = parsed.strike;
      }

      // Console log for debugging MCX options parsing and filters
      // eslint-disable-next-line no-console
      console.log('[Vayu MCX Options Search]', {
        q,
        underlying: underlyingSymbol,
        strike: parsed?.strike,
        option_type: effectiveOptionType,
        expiry_from: effectiveExpiryFrom,
        expiry_to: effectiveExpiryTo,
        ltp_only: ltpOnly,
      });

      const parsedLabel =
        parsed && (parsed.underlying || parsed.strike || parsed.optionType || parsed.expiryFrom)
          ? 'yes'
          : 'no';
      this.metrics.foSearchRequestsTotal.inc({
        endpoint: 'vayu_mcx_options',
        ltp_only: String(ltpOnly),
        parsed: parsedLabel,
      });
      const latencyTimer = this.metrics.foSearchLatencySeconds.startTimer({
        endpoint: 'vayu_mcx_options',
        ltp_only: String(ltpOnly),
      });

      const cacheKeyBase = [
        'vayu:fno:mcx_options',
        `under=${underlyingSymbol || 'ANY'}`,
        `of=${effectiveOptionType || 'ANY'}`,
        `ef=${effectiveExpiryFrom || 'ANY'}`,
        `et=${effectiveExpiryTo || 'ANY'}`,
        `sm=${effectiveStrikeMin ?? 'ANY'}`,
        `sx=${effectiveStrikeMax ?? 'ANY'}`,
        `ltp=${ltpOnly ? '1' : '0'}`,
        `lim=${requestedLimit}`,
        `off=${startOffset}`,
      ].join('|');
      const cacheKey = cacheKeyBase;
      const foCacheTtlSec = Number(process.env.FO_CACHE_TTL_SECONDS || 2);

      try {
        const cached = await this.redisService.get<any>(cacheKey);
        if (cached && cached.success === true) {
          // eslint-disable-next-line no-console
          console.log('[Vayu MCX Options Search] Cache HIT', { cacheKey });
          latencyTimer();
          return cached;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu MCX Options Search] Cache READ failed (non-fatal)', (e as any)?.message);
      }

      if (!ltpOnly) {
        let result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(
          {
            query: effectiveQuery,
            underlying_symbol: underlyingSymbol,
            exchange: ['MCX_FO'],
            // Do not constrain instrument_name: rely on option_type / options_only to distinguish from futures
            instrument_type: undefined,
            option_type: effectiveOptionType,
            options_only: true,
            expiry_from: effectiveExpiryFrom,
            expiry_to: effectiveExpiryTo,
            strike_min: effectiveStrikeMin,
            strike_max: effectiveStrikeMax,
            limit: requestedLimit,
            offset: startOffset,
            sort_by: 'expiry_date',
            sort_order: 'asc',
            only_active: false,
          },
        );

        if ((!result.instruments || result.instruments.length === 0) && q && q.trim()) {
          // eslint-disable-next-line no-console
          console.log('[Vayu MCX Options Search] No rows for parsed filters, falling back to fuzzy symbol search');
          result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(
            {
              query: q.trim(),
              underlying_symbol: undefined,
              exchange: ['MCX_FO'],
              instrument_type: undefined,
              option_type: effectiveOptionType,
              options_only: true,
              expiry_from: effectiveExpiryFrom,
              expiry_to: effectiveExpiryTo,
              strike_min: effectiveStrikeMin,
              strike_max: effectiveStrikeMax,
              limit: requestedLimit,
              offset: startOffset,
              sort_by: 'expiry_date',
              sort_order: 'asc',
              only_active: false,
            },
          );
        }
        const pairs = this.vortexInstrumentService.buildPairsFromInstruments(
          result.instruments as any,
        );
        const ltpByPair = pairs.length
          ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any)
          : {};
        const list = result.instruments.map((i) => {
          const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
          const lp = ltpByPair?.[key]?.last_price ?? null;
          const daysToExpiry = this.computeDaysToExpiry(i.expiry_date as any);
          return {
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            description: (i as any)?.description || null,
            expiry_date: i.expiry_date,
            option_type: i.option_type,
            strike_price: i.strike_price,
            days_to_expiry: daysToExpiry,
            last_price: lp,
          };
        });
        const ranked = this.rankFoInstruments(list, 'relevance', parsed?.strike);
        const response = {
          success: true,
          data: {
            instruments: ranked,
            pagination: {
              total: result.total,
              hasMore: result.hasMore,
            },
            ltp_only: false,
            performance: { queryTime: Date.now() - t0 },
          },
        };
        try {
          await this.redisService.set(cacheKey, response, foCacheTtlSec);
          // eslint-disable-next-line no-console
          console.log('[Vayu MCX Options Search] Cache SET', {
            cacheKey,
            ttl: foCacheTtlSec,
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[Vayu MCX Options Search] Cache WRITE failed (non-fatal)', (e as any)?.message);
        }
        latencyTimer();
        return response;
      }

      // Fast-path probe for ltp_only=true with single-shot LTP hydration
      const probeLimit = Math.min(
        500,
        Math.max(requestedLimit * 4, requestedLimit + startOffset),
      );
      let page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(
        {
          query: effectiveQuery,
          underlying_symbol: underlyingSymbol,
          exchange: ['MCX_FO'],
          instrument_type: undefined,
          option_type: effectiveOptionType,
          options_only: true,
          expiry_from: effectiveExpiryFrom,
          expiry_to: effectiveExpiryTo,
          strike_min: effectiveStrikeMin,
          strike_max: effectiveStrikeMax,
          limit: probeLimit,
          offset: startOffset,
          skip_count: true,
          sort_by: 'expiry_date',
          sort_order: 'asc',
          only_active: true,
        },
      );

      if ((!page.instruments || page.instruments.length === 0) && q && q.trim()) {
        // eslint-disable-next-line no-console
        console.log('[Vayu MCX Options Search] ltp_only probe empty, falling back to fuzzy symbol search');
        page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(
          {
            query: q.trim(),
            underlying_symbol: undefined,
            exchange: ['MCX_FO'],
            instrument_type: undefined,
            option_type: effectiveOptionType,
            options_only: true,
            expiry_from: effectiveExpiryFrom,
            expiry_to: effectiveExpiryTo,
            strike_min: effectiveStrikeMin,
            strike_max: effectiveStrikeMax,
            limit: probeLimit,
            offset: startOffset,
            skip_count: true,
            sort_by: 'expiry_date',
            sort_order: 'asc',
            only_active: true,
          },
        );
      }
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(
        page.instruments as any,
      );
      const ltpByPair = pairs.length
        ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any)
        : {};
      const enriched = page.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(
          i.token,
        )}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          description: (i as any)?.description || null,
          expiry_date: i.expiry_date as any,
          days_to_expiry: this.computeDaysToExpiry(i.expiry_date as any),
          option_type: i.option_type,
          strike_price: i.strike_price,
          last_price: lp,
        };
      });
      const filtered = enriched.filter(
        (v: any) =>
          Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0),
      );
      const ranked = this.rankFoInstruments(filtered, 'relevance', parsed?.strike);
      const sliced = ranked.slice(0, requestedLimit);

      const response = {
        success: true,
        data: {
          instruments: sliced,
          pagination: {
            total: undefined,
            hasMore: page.hasMore,
          },
          ltp_only: true,
          performance: { queryTime: Date.now() - t0 },
        },
      };
      try {
        await this.redisService.set(cacheKey, response, foCacheTtlSec);
        // eslint-disable-next-line no-console
        console.log('[Vayu MCX Options Search] Cache SET (ltp_only)', {
          cacheKey,
          ttl: foCacheTtlSec,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu MCX Options Search] Cache WRITE failed (ltp_only, non-fatal)', (e as any)?.message);
      }
      latencyTimer();
      return response;
  */

  @ApiTags('vayu')
  @Get('vayu/fno/autocomplete')
  @ApiOperation({ summary: 'Autocomplete for NSE/MCX F&O underlyings' })
  @ApiQuery({
    name: 'q',
    required: true,
    description: 'Partial underlying / symbol (e.g., NIFTY, BANK, GOLD)',
  })
  @ApiQuery({
    name: 'scope',
    required: false,
    enum: ['nse', 'mcx', 'all'],
    description: 'Limit results to NSE, MCX, or all F&O underlyings',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async autocompleteFo(
    @Query('q') q: string,
    @Query('scope') scope?: 'nse' | 'mcx' | 'all',
    @Query('limit') limitRaw?: number,
  ) {
    try {
      const limit = Math.min(Number(limitRaw || 10), 50);
      const trimmed = String(q || '').trim();
      if (!trimmed) {
        return {
          success: true,
          data: { suggestions: [], performance: { queryTime: 0 } },
        };
      }
      const parsed = this.fnoQueryParser.parse(trimmed);
      const baseQuery = parsed.underlying || trimmed.toUpperCase();
      const scopeNorm = (scope || 'all').toLowerCase();
      const t0 = Date.now();

      const timer = this.metrics.foSearchLatencySeconds.startTimer({
        endpoint: 'vayu_fno_autocomplete',
        ltp_only: 'false',
      });
      this.metrics.foSearchRequestsTotal.inc({
        endpoint: 'vayu_fno_autocomplete',
        ltp_only: 'false',
        parsed:
          parsed && (parsed.underlying || parsed.strike || parsed.optionType || parsed.expiryFrom)
            ? 'yes'
            : 'no',
      });

      const cacheKey = [
        'vayu:fno:autocomplete',
        `q=${baseQuery}`,
        `scope=${scopeNorm}`,
        `lim=${limit}`,
      ].join('|');
      const cacheTtl = Number(process.env.FO_CACHE_TTL_SECONDS || 2);

      try {
        const cached = await this.redisService.get<any>(cacheKey);
        if (cached && cached.success === true) {
          // eslint-disable-next-line no-console
          console.log('[Vayu F&O Autocomplete] Cache HIT', { cacheKey });
          timer();
          return cached;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          '[Vayu F&O Autocomplete] Cache READ failed (non-fatal)',
          (e as any)?.message,
        );
      }

      const { suggestions, queryTime } =
        await this.vortexInstrumentService.getVortexAutocompleteCached(
          baseQuery,
          limit * 4,
        );

      const foTypes = new Set([
        'FUTSTK',
        'FUTIDX',
        'FUTCUR',
        'FUTCOM',
        'OPTSTK',
        'OPTIDX',
        'OPTCUR',
      ]);

      const scoped = (suggestions || []).filter((s: any) => {
        if (!foTypes.has(String(s.instrument_name || '').toUpperCase())) return false;
        const ex = String(s.exchange || '').toUpperCase();
        if (scopeNorm === 'nse') return ex.startsWith('NSE');
        if (scopeNorm === 'mcx') return ex === 'MCX_FO';
        return true;
      });

      // Deduplicate by symbol, keep first occurrence
      const seen = new Set<string>();
      const deduped: Array<{
        token: number;
        symbol: string;
        exchange: string;
        instrument_name: string;
      }> = [];
      for (const s of scoped) {
        const sym = String(s.symbol || '').toUpperCase();
        if (!sym || seen.has(sym)) continue;
        seen.add(sym);
        deduped.push({
          token: s.token,
          symbol: sym,
          exchange: s.exchange,
          instrument_name: s.instrument_name,
        });
        if (deduped.length >= limit) break;
      }

      const response = {
        success: true,
        data: {
          suggestions: deduped,
          performance: { queryTime: queryTime ?? Date.now() - t0 },
        },
      };
      try {
        await this.redisService.set(cacheKey, response, cacheTtl);
        // eslint-disable-next-line no-console
        console.log('[Vayu F&O Autocomplete] Cache SET', {
          cacheKey,
          ttl: cacheTtl,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          '[Vayu F&O Autocomplete] Cache WRITE failed (non-fatal)',
          (e as any)?.message,
        );
      }
      timer();
      return response;
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to autocomplete F&O underlyings',
          error: (error as any)?.message || 'unknown',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/underlyings/:symbol/futures')
  @ApiOperation({
    summary: 'List futures for a given underlying, grouped by expiry',
  })
  @ApiQuery({
    name: 'exchange',
    required: false,
    description: 'Optional exchange filter (e.g., NSE_FO)',
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: true,
    description: 'If true, only contracts with valid last_price are returned',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getUnderlyingFutures(
    @Param('symbol') symbol: string,
    @Query('exchange') exchange?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
    @Query('limit') limitRaw?: number,
    @Query('offset') offsetRaw?: number,
  ) {
    try {
      const baseSymbol = String(symbol || '').trim().toUpperCase();
      const ltpOnly =
        String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
      const limit = Math.min(Number(limitRaw || 100), 500);
      const offset = Number(offsetRaw || 0);
      const t0 = Date.now();

      const timer = this.metrics.foSearchLatencySeconds.startTimer({
        endpoint: 'vayu_underlyings_futures',
        ltp_only: String(ltpOnly),
      });
      this.metrics.foSearchRequestsTotal.inc({
        endpoint: 'vayu_underlyings_futures',
        ltp_only: String(ltpOnly),
        parsed: 'no',
      });

      const cacheKey = [
        'vayu:fno:underlying:futures',
        `sym=${baseSymbol}`,
        `ex=${exchange || 'ANY'}`,
        `ltp=${ltpOnly ? '1' : '0'}`,
        `lim=${limit}`,
        `off=${offset}`,
      ].join('|');
      const ttl = Number(process.env.FO_CACHE_TTL_SECONDS || 2);

      try {
        const cached = await this.redisService.get<any>(cacheKey);
        if (cached && cached.success === true) {
          // eslint-disable-next-line no-console
          console.log('[Vayu Underlying Futures] Cache HIT', { cacheKey });
          timer();
          return cached;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          '[Vayu Underlying Futures] Cache READ failed (non-fatal)',
          (e as any)?.message,
        );
      }

      const result =
        await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: undefined,
          underlying_symbol: baseSymbol,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['FUTSTK', 'FUTIDX'],
          limit,
          offset,
          sort_by: 'expiry_date',
          sort_order: 'asc',
        });
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(
        result.instruments as any,
      );
      const ltpByPair = pairs.length
        ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any)
        : {};

      const contracts = result.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        const daysToExpiry = this.computeDaysToExpiry(i.expiry_date as any);
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          description: (i as any)?.description || null,
          expiry_date: i.expiry_date,
          instrument_name: i.instrument_name,
          tick: (i as any)?.tick,
          lot_size: (i as any)?.lot_size,
          days_to_expiry: daysToExpiry,
          last_price: lp,
        };
      });

      const filtered = ltpOnly
        ? contracts.filter(
            (c: any) =>
              Number.isFinite(c?.last_price) && ((c?.last_price ?? 0) > 0),
          )
        : contracts;

      // Group by expiry date for easy options-chain style UIs
      const groups: Record<string, any[]> = {};
      for (const c of filtered) {
        const exp = String(c.expiry_date || 'NA');
        if (!groups[exp]) groups[exp] = [];
        groups[exp].push(c);
      }
      const expiries = Object.keys(groups).sort();

      const response = {
        success: true,
        data: {
          symbol: baseSymbol,
          expiries,
          groups,
          pagination: {
            total: result.total,
            hasMore: result.hasMore,
          },
          ltp_only: ltpOnly,
          performance: { queryTime: Date.now() - t0 },
        },
      };
      try {
        await this.redisService.set(cacheKey, response, ttl);
        // eslint-disable-next-line no-console
        console.log('[Vayu Underlying Futures] Cache SET', { cacheKey, ttl });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          '[Vayu Underlying Futures] Cache WRITE failed (non-fatal)',
          (e as any)?.message,
        );
      }
      timer();
      return response;
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get underlying futures',
          error: (error as any)?.message || 'unknown',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/underlyings/:symbol/options')
  @ApiOperation({
    summary: 'List options for a given underlying (options chain view)',
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: true,
    description: 'If true, only strikes with valid LTP are kept in the chain',
  })
  async getUnderlyingOptions(
    @Param('symbol') symbol: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    // This endpoint is a thin alias over the existing options chain endpoint,
    // keeping the same semantics while providing a more discoverable path.
    return this.getVortexOptionsChain(symbol, ltpOnlyRaw);
  }

  /**
   * Compute days to expiry from a Vortex expiry_date (YYYYMMDD) string.
   * Returns null when the expiry is missing or invalid.
   */
  private computeDaysToExpiry(expiry?: string | null): number | null {
    if (!expiry || typeof expiry !== 'string' || expiry.length !== 8) {
      return null;
    }
    try {
      const year = Number(expiry.substring(0, 4));
      const month = Number(expiry.substring(4, 6));
      const day = Number(expiry.substring(6, 8));
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return null;
      }
      const expDate = new Date(Date.UTC(year, month - 1, day));
      const now = new Date();
      const diffMs = expDate.getTime() - now.getTime();
      const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      return diffDays;
    } catch {
      return null;
    }
  }

  /**
   * Simple ranking function for F&O instruments.
   * - Primary: nearest expiry (days_to_expiry ascending; nulls last)
   * - Secondary (options): distance of strike from targetStrike (when provided)
   * - Tertiary: symbol then token for stability
   */
  private rankFoInstruments(
    items: Array<{
      token: number;
      symbol: string;
      days_to_expiry?: number | null;
      strike_price?: number | null;
      [key: string]: any;
    }>,
    sortMode: string,
    targetStrike?: number,
  ) {
    const mode = (sortMode || 'relevance').toLowerCase();
    const copy = [...items];

    const strikeRef = Number.isFinite(targetStrike as any)
      ? (targetStrike as number)
      : undefined;

    const cmpDays = (a: any, b: any) => {
      const da = typeof a.days_to_expiry === 'number' ? a.days_to_expiry : Infinity;
      const db = typeof b.days_to_expiry === 'number' ? b.days_to_expiry : Infinity;
      return da - db;
    };

    const cmpStrike = (a: any, b: any) => {
      const sa = Number(a.strike_price ?? 0);
      const sb = Number(b.strike_price ?? 0);
      return sa - sb;
    };

    const cmpStrikeDistance = (a: any, b: any) => {
      if (!Number.isFinite(strikeRef as any)) return 0;
      const da = Math.abs(Number(a.strike_price ?? 0) - (strikeRef as number));
      const db = Math.abs(Number(b.strike_price ?? 0) - (strikeRef as number));
      return da - db;
    };

    copy.sort((a, b) => {
      if (mode === 'expiry') {
        const d = cmpDays(a, b);
        if (d !== 0) return d;
        return cmpStrike(a, b);
      }
      if (mode === 'strike') {
        const d = cmpStrike(a, b);
        if (d !== 0) return d;
        return cmpDays(a, b);
      }
      // relevance (default): nearest expiry + (when available) closest strike to target
      let d = cmpDays(a, b);
      if (d !== 0) return d;
      d = cmpStrikeDistance(a, b);
      if (d !== 0) return d;
      // stable tie-breakers
      const symCmp = String(a.symbol || '').localeCompare(String(b.symbol || ''));
      if (symCmp !== 0) return symCmp;
      return Number(a.token) - Number(b.token);
    });

    return copy;
  }

  @ApiTags('vayu')
  @Get('vayu/commodities')
  @ApiOperation({ summary: 'Get Vayu commodities (MCX) with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol search' })
  @ApiQuery({
    name: 'expiry_from',
    required: false,
    description: 'Expiry date from',
  })
  @ApiQuery({
    name: 'expiry_to',
    required: false,
    description: 'Expiry date to',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'ltp_only', required: false, example: true, description: 'If true, only instruments with a valid last_price are returned' })
  async getVortexCommodities(
    @Query('q') q?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    try {
      const t0 = Date.now();
      const requestedLimit = limit ? parseInt(limit.toString()) : 50;
      const startOffset = offset ? parseInt(offset.toString()) : 0;
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);

      if (!ltpOnly) {
        const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: ['MCX_FO'],
          expiry_from,
          expiry_to,
          limit: requestedLimit,
          offset: startOffset,
        });
        const pairs = this.vortexInstrumentService.buildPairsFromInstruments(result.instruments as any);
        const ltpByPair = pairs.length ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any) : {};
        const list = result.instruments.map((i) => ({
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          instrument_name: i.instrument_name,
          expiry_date: i.expiry_date,
          description: (i as any)?.description || null,
          last_price: ltpByPair?.[`${String(i.exchange || '').toUpperCase()}-${String(i.token)}`]?.last_price ?? null,
        }));
        return {
          success: true,
          data: {
            instruments: list,
            pagination: {
              total: result.total,
              hasMore: result.hasMore,
            },
            ltp_only: false,
            performance: { queryTime: Date.now() - t0 },
          },
        };
      }

      // Fast single-shot probe for ltp_only=true
      const probeLimit = Math.min(500, Math.max(requestedLimit * 4, requestedLimit + startOffset));
      const page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
        query: q,
        exchange: ['MCX_FO'],
        expiry_from,
        expiry_to,
        limit: probeLimit,
        offset: startOffset,
        skip_count: true,
      });
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(page.instruments as any);
      const ltpByPair = pairs.length ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any) : {};
      const enriched = page.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          description: (i as any)?.description || null,
          instrument_name: i.instrument_name,
          expiry_date: i.expiry_date as any,
          last_price: lp,
        };
      });
      const filtered = enriched.filter((v: any) => Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0));
      const sliced = filtered.slice(0, requestedLimit);

      return {
        success: true,
        data: {
          instruments: sliced,
          pagination: {
            total: undefined,
            hasMore: page.hasMore,
          },
          ltp_only: true,
          performance: { queryTime: Date.now() - t0 },
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get commodities',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/instruments/popular')
  @ApiOperation({ summary: 'Get popular Vayu instruments with caching' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max instruments (default 50)',
  })
  @ApiQuery({ name: 'ltp_only', required: false, example: true, description: 'If true, only instruments with a valid last_price are returned' })
  async getVortexPopularInstruments(@Query('limit') limit?: number, @Query('ltp_only') ltpOnlyRaw?: string | boolean) {
    try {
      const baseLimit = limit ? parseInt(limit.toString()) : 50;
      const fetchLimit = Math.min(Math.max(baseLimit * 4, baseLimit), 500);
      const result =
        await this.vortexInstrumentService.getVortexPopularInstrumentsCached(
          fetchLimit,
        );

      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);
      const list = result.instruments;
      const filtered = ltpOnly
        ? list.filter((v: any) => Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0))
        : list;

      return {
        success: true,
        data: {
          instruments: filtered.slice(0, baseLimit),
          performance: {
            queryTime: result.queryTime,
          },
          ltp_only: ltpOnly || false,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get popular instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/instruments/cached-stats')
  @ApiOperation({ summary: 'Get Vayu instrument stats with caching' })
  async getVortexInstrumentStatsCached() {
    try {
      const result =
        await this.vortexInstrumentService.getVortexInstrumentStatsCached();

      return {
        success: true,
        data: {
          total: result.total,
          byExchange: result.byExchange,
          byInstrumentType: result.byInstrumentType,
          lastSync: result.lastSync,
          performance: {
            queryTime: result.queryTime,
          },
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get cached stats',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Post('vayu/cache/clear')
  @ApiOperation({ summary: 'Clear Vayu cache' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Cache key pattern (optional, defaults to vortex:*)',
        },
      },
    },
  })
  async clearVortexCache(@Body() body: ClearCacheDto) {
    try {
      await this.vortexInstrumentService.clearVortexCache(body.pattern);

      return {
        success: true,
        message: 'Cache cleared successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to clear cache',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/tickers/search')
  @ApiOperation({
    summary: 'Search Vayu tickers and return live price + metadata',
  })
  @ApiQuery({ name: 'q', required: true, example: 'NSE_EQ_RELIANCE' })
  @ApiQuery({
    name: 'include_ltp',
    required: false,
    example: true,
    description:
      'If true (default), enrich each item with LTP using Vortex quotes (mode=ltp)',
  })
  @ApiQuery({ name: 'ltp_only', required: false, example: true, description: 'If true, only tickers with a valid last_price are returned' })
  async searchVortexTickers(@Query('q') q: string, @Query('ltp_only') ltpOnlyRaw?: string | boolean, @Query('include_ltp') includeLtpRaw?: string | boolean) {
    try {
      if (!q) {
        throw new HttpException(
          { success: false, message: 'q is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const { instrument, candidates } =
        await this.vortexInstrumentService.resolveVortexSymbol(q);
      const items = instrument ? [instrument] : candidates;
      const includeLtp =
        String(includeLtpRaw || 'true').toLowerCase() === 'true' ||
        includeLtpRaw === true;
      // Build authoritative pairs from DB result; avoid NSE_EQ implicit fallback
      const pairs =
        items?.map((i) => ({
          exchange: String(i.exchange || '').toUpperCase(),
          token: String(i.token),
        })) || [];
      let pairLtp: Record<string, { last_price: number | null }> = {};
      if (includeLtp && pairs.length) {
        pairLtp = await this.requestBatchingService.getLtpByPairs(
          pairs as any,
          this.vortexProvider,
        );
      }

      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);
      const list = items.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = includeLtp ? pairLtp?.[key]?.last_price ?? null : null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          instrument_name: i.instrument_name,
          expiry_date: i.expiry_date,
          option_type: i.option_type,
          strike_price: i.strike_price,
          tick: i.tick,
          lot_size: i.lot_size,
          description: i.description,
          last_price: lp,
        };
      });
      const filtered = ltpOnly
        ? list.filter((v) => Number.isFinite((v as any)?.last_price) && (((v as any)?.last_price ?? 0) > 0))
        : list;

      return {
        success: true,
        data: filtered,
        include_ltp: includeLtp,
        ltp_only: ltpOnly || false,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to search Vayu tickers',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Get('vayu/tickers/:symbol')
  @ApiOperation({
    summary:
      'Get live price and metadata by Vayu ticker (e.g., NSE_EQ_RELIANCE)',
    description:
      'Fetches complete instrument information including LTP, description, and all metadata for a given Vayu symbol. Supports ltp_only filter to return 404 if LTP is unavailable.',
  })
  @ApiQuery({
    name: 'ltp_only',
    required: false,
    example: true,
    description: 'If true, returns 404 when LTP is unavailable for the symbol',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully fetched ticker data',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            token: { type: 'number', example: 738561 },
            symbol: { type: 'string', example: 'RELIANCE' },
            exchange: { type: 'string', example: 'NSE_EQ' },
            instrument_name: { type: 'string', example: 'EQ' },
            expiry_date: { type: 'string', nullable: true, example: null },
            option_type: { type: 'string', nullable: true, example: null },
            strike_price: { type: 'number', nullable: true, example: null },
            tick: { type: 'number', example: 0.05 },
            lot_size: { type: 'number', example: 1 },
            description: { type: 'string', example: 'NSE_EQ RELIANCE EQ' },
            last_price: { type: 'number', nullable: true, example: 2456.75 },
          },
        },
        ltp_only: { type: 'boolean', example: false },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Symbol not found or LTP unavailable (when ltp_only=true)',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 500,
    description: 'Internal server error',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string' },
        error: { type: 'string' },
      },
    },
  })
  async getVortexTickerBySymbol(@Param('symbol') symbol: string, @Query('ltp_only') ltpOnlyRaw?: string | boolean) {
    try {
      const { instrument } =
        await this.vortexInstrumentService.resolveVortexSymbol(symbol);
      if (!instrument) {
        throw new HttpException(
          { success: false, message: 'Vayu symbol not found' },
          HttpStatus.NOT_FOUND,
        );
      }

      try {
        const ltp = await this.vortexInstrumentService.getVortexLTP([
          instrument.token,
        ]);
        const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);
        const lastPrice = ltp?.[instrument.token]?.last_price ?? null;
        
        if (ltpOnly && !(Number.isFinite(lastPrice) && ((lastPrice as any) > 0))) {
          throw new HttpException(
            { success: false, message: 'LTP not available for requested symbol (ltp_only=true)' },
            HttpStatus.NOT_FOUND,
          );
        }

        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log('[Get Vayu Ticker] Returning data for symbol:', {
          symbol,
          token: instrument.token,
          hasDescription: !!instrument.description,
          hasLtp: !!lastPrice,
        });

        return {
          success: true,
          data: {
            token: instrument.token,
            symbol: instrument.symbol,
            exchange: instrument.exchange,
            instrument_name: instrument.instrument_name,
            expiry_date: instrument.expiry_date,
            option_type: instrument.option_type,
            strike_price: instrument.strike_price,
            tick: instrument.tick,
            lot_size: instrument.lot_size,
            description: instrument.description,
            last_price: lastPrice,
          },
          ltp_only: ltpOnly || false,
        };
      } catch (ltpError) {
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.error('[Get Vayu Ticker] Failed to fetch LTP:', ltpError);
        if (ltpError instanceof HttpException) throw ltpError;
        throw new HttpException(
          {
            success: false,
            message: 'Failed to fetch LTP for symbol',
            error: ltpError.message,
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch Vayu ticker',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiTags('vayu')
  @Delete('vayu/instruments/inactive')
  @ApiOperation({
    summary: 'Delete all inactive Vortex instruments',
    description:
      'Permanently deletes all instruments from vortex_instruments table where is_active = false. Use with caution as this operation cannot be undone. Recommended workflow: 1) Use validate-instruments endpoint to identify invalid instruments, 2) Review the results, 3) Use this endpoint to clean up inactive instruments.',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully deleted inactive instruments',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'Successfully deleted 150 inactive instruments' },
        deleted_count: { type: 'number', example: 150 },
        timestamp: { type: 'string', example: '2025-01-01T10:00:00.000Z' },
      },
    },
  })
  @ApiResponse({
    status: 500,
    description: 'Internal server error during deletion',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string' },
        error: { type: 'string' },
      },
    },
  })
  async deleteInactiveVortexInstruments() {
    try {
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log('[Delete Inactive Instruments] Request received');

      const deletedCount =
        await this.vortexInstrumentService.deleteInactiveInstruments();

      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        `[Delete Inactive Instruments] Deleted ${deletedCount} inactive instruments`,
      );

      return {
        success: true,
        message: `Successfully deleted ${deletedCount} inactive instruments`,
        deleted_count: deletedCount,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.error('[Delete Inactive Instruments] Error:', error);
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to delete inactive instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
