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
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiHeader,
  ApiBody,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../../guards/api-key.guard';

// Ambient declarations to satisfy TS in environments without DOM/lib definitions
declare const console: any;

@Controller('stock')
@UseGuards(ApiKeyGuard)
@ApiTags('stock')
@ApiSecurity('apiKey')
export class StockController {
  constructor(private readonly stockService: StockService) {}

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

}
