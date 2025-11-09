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

      const data = await this.vortexProvider.getLTPByPairs(pairs as any);

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
          enrichedData[pairKey] = {
            ...ltpData,
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
          const data = await this.vortexProvider.getLTP(tokens);
          
          // Enrich with instrument descriptions and other data
          const enrichedData: Record<string, any> = {};
          try {
            const instrumentTokens = tokens.map((t) => parseInt(t));
            const instruments = await this.vortexInstrumentService.getVortexInstrumentsBatch(instrumentTokens);
            
            for (const [token, ltpData] of Object.entries(data)) {
              try {
                const instrument = instruments.instruments[parseInt(token)];
                enrichedData[token] = {
                  ...ltpData,
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
        const data = await this.vortexProvider.getLTPByPairs(sanitized as any);
        
        // Enrich with instrument descriptions and other data
        const enrichedData: Record<string, any> = {};
        try {
          const instrumentTokens = sanitized.map((p) => parseInt(p.token));
          const instruments = await this.vortexInstrumentService.getVortexInstrumentsBatch(instrumentTokens);
          
          for (const [pairKey, ltpData] of Object.entries(data)) {
            try {
              const token = parseInt(pairKey.split('-').pop() || '0');
              const instrument = instruments.instruments[token];
              enrichedData[pairKey] = {
                ...ltpData,
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
      },
    },
  })
  async validateVortexInstruments(
    @Body()
    body: ValidateInstrumentsDto,
  ) {
    try {
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

  @Get('vayu/instruments')
  @ApiOperation({ summary: 'Get Vayu instruments with optional filters' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'instrument_name', required: false, example: 'EQ' })
  @ApiQuery({ name: 'symbol', required: false, example: 'RELIANCE' })
  @ApiQuery({ name: 'option_type', required: false, example: 'CE' })
  @ApiQuery({ name: 'is_active', required: false, example: true })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async getVortexInstruments(
    @Query('exchange') exchange?: string,
    @Query('instrument_name') instrumentName?: string,
    @Query('symbol') symbol?: string,
    @Query('option_type') optionType?: string,
    @Query('is_active') isActive?: boolean,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
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
      
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log('[Get Vayu Instruments] Returning', {
        total: result.total,
        count: result.instruments.length,
        hasDescriptions: result.instruments.some((i) => i.description),
      });
      
      return {
        success: true,
        data: result,
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

  @Get('vayu/instruments/search')
  @ApiOperation({
    summary: 'Search Vayu instruments by symbol or instrument name',
  })
  @ApiQuery({ name: 'q', required: true, example: 'RELIANCE' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  async searchVortexInstruments(
    @Query('q') query: string,
    @Query('limit') limit?: number,
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

      return {
        success: true,
        data: { instruments },
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
    try {
      const requestedLimit = limit ? parseInt(limit.toString()) : 50;
      const startOffset = offset ? parseInt(offset.toString()) : 0;
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);

      if (!ltpOnly) {
        const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['EQUITIES'],
          limit: requestedLimit,
          offset: startOffset,
        });
        const tokens = result.instruments.map((i) => i.token);
        const ltp = tokens.length ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};
        const list = result.instruments.map((i) => ({
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          last_price: ltp?.[i.token]?.last_price ?? null,
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
          },
        };
      }

      const collected: Array<{ token: number; symbol: string; exchange: string; last_price: number | null }> = [];
      let currentOffset = startOffset;
      let hasMore = true;
      const pageSize = Math.min(Math.max(requestedLimit, 1), 500);

      while (collected.length < requestedLimit && hasMore) {
        const page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['EQUITIES'],
          limit: pageSize,
          offset: currentOffset,
        });
        const tokens = page.instruments.map((i) => i.token);
        const ltp = tokens.length ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};
        for (const i of page.instruments) {
          const lp = ltp?.[i.token]?.last_price ?? null;
          if (Number.isFinite(lp) && (lp as any) > 0) {
            collected.push({ token: i.token, symbol: i.symbol, exchange: i.exchange, last_price: lp });
            if (collected.length >= requestedLimit) break;
          }
        }
        hasMore = page.hasMore;
        currentOffset += pageSize;
        if (!hasMore) break;
      }

      return {
        success: true,
        data: {
          instruments: collected.slice(0, requestedLimit),
          pagination: {
            total: undefined,
            hasMore,
          },
          ltp_only: true,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get equities',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

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
  async getVortexFutures(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    try {
      const requestedLimit = limit ? parseInt(limit.toString()) : 50;
      const startOffset = offset ? parseInt(offset.toString()) : 0;
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);

      if (!ltpOnly) {
        const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['FUTSTK', 'FUTIDX'],
          expiry_from,
          expiry_to,
          limit: requestedLimit,
          offset: startOffset,
        });
        const tokens = result.instruments.map((i) => i.token);
        const ltp = tokens.length ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};
        const list = result.instruments.map((i) => ({
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          expiry_date: i.expiry_date,
          last_price: ltp?.[i.token]?.last_price ?? null,
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
          },
        };
      }

      const collected: Array<{ token: number; symbol: string; exchange: string; expiry_date: any; last_price: number | null }> = [];
      let currentOffset = startOffset;
      let hasMore = true;
      const pageSize = Math.min(Math.max(requestedLimit, 1), 500);

      while (collected.length < requestedLimit && hasMore) {
        const page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['FUTSTK', 'FUTIDX'],
          expiry_from,
          expiry_to,
          limit: pageSize,
          offset: currentOffset,
        });
        const tokens = page.instruments.map((i) => i.token);
        const ltp = tokens.length ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};
        for (const i of page.instruments) {
          const lp = ltp?.[i.token]?.last_price ?? null;
          if (Number.isFinite(lp) && (lp as any) > 0) {
            collected.push({ token: i.token, symbol: i.symbol, exchange: i.exchange, expiry_date: i.expiry_date as any, last_price: lp });
            if (collected.length >= requestedLimit) break;
          }
        }
        hasMore = page.hasMore;
        currentOffset += pageSize;
        if (!hasMore) break;
      }

      return {
        success: true,
        data: {
          instruments: collected.slice(0, requestedLimit),
          pagination: {
            total: undefined,
            hasMore,
          },
          ltp_only: true,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get futures',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

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
  ) {
    try {
      const requestedLimit = limit ? parseInt(limit.toString()) : 50;
      const startOffset = offset ? parseInt(offset.toString()) : 0;
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);

      if (!ltpOnly) {
        const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['OPTSTK', 'OPTIDX'],
          option_type,
          expiry_from,
          expiry_to,
          strike_min,
          strike_max,
          limit: requestedLimit,
          offset: startOffset,
        });
        const tokens = result.instruments.map((i) => i.token);
        const ltp = tokens.length ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};
        const list = result.instruments.map((i) => ({
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          expiry_date: i.expiry_date,
          option_type: i.option_type,
          strike_price: i.strike_price,
          last_price: ltp?.[i.token]?.last_price ?? null,
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
          },
        };
      }

      const collected: Array<{ token: number; symbol: string; exchange: string; expiry_date: any; option_type?: string; strike_price?: number; last_price: number | null }> = [];
      let currentOffset = startOffset;
      let hasMore = true;
      const pageSize = Math.min(Math.max(requestedLimit, 1), 500);

      while (collected.length < requestedLimit && hasMore) {
        const page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['OPTSTK', 'OPTIDX'],
          option_type,
          expiry_from,
          expiry_to,
          strike_min,
          strike_max,
          limit: pageSize,
          offset: currentOffset,
        });
        const tokens = page.instruments.map((i) => i.token);
        const ltp = tokens.length ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};
        for (const i of page.instruments) {
          const lp = ltp?.[i.token]?.last_price ?? null;
          if (Number.isFinite(lp) && (lp as any) > 0) {
            collected.push({ token: i.token, symbol: i.symbol, exchange: i.exchange, expiry_date: i.expiry_date as any, option_type: i.option_type, strike_price: i.strike_price, last_price: lp });
            if (collected.length >= requestedLimit) break;
          }
        }
        hasMore = page.hasMore;
        currentOffset += pageSize;
        if (!hasMore) break;
      }

      return {
        success: true,
        data: {
          instruments: collected.slice(0, requestedLimit),
          pagination: {
            total: undefined,
            hasMore,
          },
          ltp_only: true,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get options',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

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
        const tokens = result.instruments.map((i) => i.token);
        const ltp = tokens.length ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};
        const list = result.instruments.map((i) => ({
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          instrument_name: i.instrument_name,
          expiry_date: i.expiry_date,
          last_price: ltp?.[i.token]?.last_price ?? null,
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
          },
        };
      }

      const collected: Array<{ token: number; symbol: string; exchange: string; instrument_name: string; expiry_date: any; last_price: number | null }> = [];
      let currentOffset = startOffset;
      let hasMore = true;
      const pageSize = Math.min(Math.max(requestedLimit, 1), 500);

      while (collected.length < requestedLimit && hasMore) {
        const page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: ['MCX_FO'],
          expiry_from,
          expiry_to,
          limit: pageSize,
          offset: currentOffset,
        });
        const tokens = page.instruments.map((i) => i.token);
        const ltp = tokens.length ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};
        for (const i of page.instruments) {
          const lp = ltp?.[i.token]?.last_price ?? null;
          if (Number.isFinite(lp) && (lp as any) > 0) {
            collected.push({ token: i.token, symbol: i.symbol, exchange: i.exchange, instrument_name: i.instrument_name, expiry_date: i.expiry_date as any, last_price: lp });
            if (collected.length >= requestedLimit) break;
          }
        }
        hasMore = page.hasMore;
        currentOffset += pageSize;
        if (!hasMore) break;
      }

      return {
        success: true,
        data: {
          instruments: collected.slice(0, requestedLimit),
          pagination: {
            total: undefined,
            hasMore,
          },
          ltp_only: true,
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

  @Get('vayu/tickers/search')
  @ApiOperation({
    summary: 'Search Vayu tickers and return live price + metadata',
  })
  @ApiQuery({ name: 'q', required: true, example: 'NSE_EQ_RELIANCE' })
  @ApiQuery({ name: 'ltp_only', required: false, example: true, description: 'If true, only tickers with a valid last_price are returned' })
  async searchVortexTickers(@Query('q') q: string, @Query('ltp_only') ltpOnlyRaw?: string | boolean) {
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
      const tokens = items.map((i) => i.token);
      const ltp = tokens.length
        ? await this.vortexInstrumentService.getVortexLTP(tokens)
        : {};

      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);
      const list = items.map((i) => ({
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
        last_price: ltp?.[i.token]?.last_price ?? null,
      }));
      const filtered = ltpOnly
        ? list.filter((v) => Number.isFinite((v as any)?.last_price) && (((v as any)?.last_price ?? 0) > 0))
        : list;

      return {
        success: true,
        data: filtered,
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
