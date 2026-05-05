/**
 * @file stock-quotes.controller.ts
 * @module stock
 * @description Stock REST: quotes, tickers, LTP, OHLC, historical and market-data reads.
 * @author BharatERP
 * @created 2026-03-28
 */
import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpException,
  HttpStatus,
  UseGuards,
  Request,
} from '@nestjs/common';
import { StockService } from '@features/stock/application/stock.service';
import { UniversalLtpService } from '@features/stock/application/universal-ltp.service';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiHeader,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '@shared/guards/api-key.guard';
import { InstrumentsRequestDto } from './dto/instruments.dto';

@Controller('stock')
@UseGuards(ApiKeyGuard)
@ApiTags('stock')
@ApiSecurity('apiKey')
export class StockQuotesController {
  constructor(
    private readonly stockService: StockService,
    private readonly universalLtpService: UniversalLtpService,
    private readonly registry: InstrumentRegistryService,
  ) {}

  /**
   * Helper to enrich items with UIR metadata.
   */
  private enrichWithUir(item: any, token: string | number) {
    const uirId = this.registry.resolveTokenAcrossProviders(token);
    const canonical_symbol =
      uirId != null ? (this.registry.getCanonicalSymbol(uirId) ?? null) : null;
    return {
      ...item,
      uir_id: uirId ?? null,
      canonical_symbol,
    };
  }

  /**
   * Helper to enrich a record/map of items.
   */
  private enrichRecordWithUir(data: Record<string, any>) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data || {})) {
      out[k] = this.enrichWithUir(v, k);
    }
    return out;
  }

  /**
   * POST /api/stock/universal/ltp
   * Provider-agnostic LTP resolution by universal instrument ID.
   * Prefers vortex; falls back to kite for instruments without a vortex token.
   * Body: { ids: number[] }
   */
  @Post('universal/ltp')
  @ApiOperation({
    summary: 'Get LTP by universal instrument IDs (provider auto-resolved)',
    description:
      'Accepts an array of universal_instruments.id values. Resolves each to vortex or kite provider internally and returns a map of id → { last_price }.',
  })
  @ApiBody({
    schema: {
      properties: { ids: { type: 'array', items: { type: 'number' } } },
      required: ['ids'],
    },
  })
  async universalLtp(@Body() body: { ids: number[] }) {
    return this.universalLtpService.getUniversalLtp(
      (body?.ids || []).map(Number).filter(Number.isFinite),
    );
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
    description: 'Quote data map',
  })
  async getQuotes(
    @Body() body: InstrumentsRequestDto,
    @Query('mode') modeRaw?: string,
    @Query('ltp_only') ltpOnlyRaw?: string,
    @Request() req?: any,
  ) {
    try {
      const instruments = (body?.instruments || [])
        .map(Number)
        .filter(Number.isFinite);
      if (!instruments.length) {
        throw new HttpException(
          { success: false, message: 'instruments array is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const modeNorm = (modeRaw || 'full').toLowerCase();
      const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true';

      let quotes: any = {};
      const provider = req.headers?.['x-provider'];

      if (provider === 'falcon' || provider === 'kite') {
        quotes = await this.stockService.getKiteQuotes(
          instruments,
          req.headers?.['x-api-key'] || req.query?.['api_key'],
        );
      } else if (provider === 'vortex' || provider === 'vayu') {
        quotes = await this.stockService.getVortexQuotes(
          instruments,
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

      const enriched = this.enrichRecordWithUir(quotes as any);

      return {
        success: true,
        data: enriched,
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
        data: items.map((i) =>
          this.enrichWithUir(
            {
              instrument_token: i.instrument_token,
              symbol: i.tradingsymbol,
              segment: i.segment,
              instrument_type: i.instrument_type,
              last_price:
                ltp?.[i.instrument_token]?.last_price ?? i.last_price ?? null,
            },
            i.instrument_token,
          ),
        ),
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
        data: this.enrichWithUir(
          {
            instrument_token: instrument.instrument_token,
            symbol: instrument.tradingsymbol,
            segment: instrument.segment,
            instrument_type: instrument.instrument_type,
            last_price: ltp?.[instrument.instrument_token]?.last_price ?? null,
          },
          instrument.instrument_token,
        ),
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

  /**
   * GET /api/stock/ltp
   * Legacy LTP endpoint.
   */
  @Get('ltp')
  @ApiOperation({ summary: 'Get LTP for instrument tokens (comma-separated)' })
  @ApiQuery({ name: 'tokens', required: true, example: '256265,738561' })
  async getLtpLegacy(@Query('tokens') tokensRaw: string) {
    try {
      const tokens = (tokensRaw || '')
        .split(',')
        .map(Number)
        .filter(Number.isFinite);
      if (!tokens.length) {
        throw new HttpException(
          { success: false, message: 'tokens query is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const ltp = await this.stockService.getLTP(tokens);
      const enriched = this.enrichRecordWithUir(ltp as any);
      return { success: true, data: enriched };
    } catch (error) {
      if (error instanceof HttpException) throw error;
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

  /**
   * POST /api/stock/ltp
   * Legacy LTP endpoint (POST).
   */
  @Post('ltp')
  @ApiOperation({ summary: 'Get LTP for instrument tokens' })
  async postLtpLegacy(@Body() body: { instruments: number[] }) {
    try {
      const tokens = (body?.instruments || [])
        .map(Number)
        .filter(Number.isFinite);
      if (!tokens.length) {
        throw new HttpException(
          { success: false, message: 'instruments array is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const ltp = await this.stockService.getLTP(tokens);
      const enriched = this.enrichRecordWithUir(ltp as any);
      return { success: true, data: enriched };
    } catch (error) {
      if (error instanceof HttpException) throw error;
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

  @Get('ohlc')
  @ApiOperation({ summary: 'Get OHLC for instrument tokens (comma-separated)' })
  @ApiQuery({ name: 'tokens', required: true, example: '256265,738561' })
  async getOhlcLegacy(@Query('tokens') tokensRaw: string) {
    try {
      const tokens = (tokensRaw || '')
        .split(',')
        .map(Number)
        .filter(Number.isFinite);
      if (!tokens.length) {
        throw new HttpException(
          { success: false, message: 'tokens query is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const data = await this.stockService.getOHLC(tokens);
      const enriched = this.enrichRecordWithUir(data as any);
      return { success: true, data: enriched };
    } catch (error) {
      if (error instanceof HttpException) throw error;
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
  @ApiOperation({ summary: 'Get historical data for an instrument token' })
  @ApiQuery({ name: 'from', required: true, example: '2026-04-01' })
  @ApiQuery({ name: 'to', required: true, example: '2026-04-11' })
  @ApiQuery({ name: 'interval', required: true, example: 'day' })
  async getHistorical(
    @Param('token') tokenRaw: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('interval') interval: string,
  ) {
    try {
      const token = Number(tokenRaw);
      if (!Number.isFinite(token)) {
        throw new HttpException(
          { success: false, message: 'Invalid token' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const data = await this.stockService.getHistoricalData(
        token,
        from,
        to,
        interval,
      );
      // Historical data is an array of candles, we don't enrich individual candles with UIR
      // but we could wrap the response if needed. For now, keep as-is or enrich top-level.
      return {
        success: true,
        instrument_token: token,
        ...this.enrichWithUir({}, token), // Add uir_id and canonical_symbol at top level
        data,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
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
}
