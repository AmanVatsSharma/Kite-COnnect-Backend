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
} from '@nestjs/common';
import { StockService } from './stock.service';
import { VortexInstrumentService } from '../../services/vortex-instrument.service';
import { ApiTags, ApiOperation, ApiBody, ApiQuery, ApiResponse, ApiSecurity, ApiHeader } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { ApiKeyGuard } from '../../guards/api-key.guard';

@Controller('stock')
@UseGuards(ApiKeyGuard)
@ApiTags('stock')
@ApiSecurity('apiKey')
export class StockController {
  constructor(
    private readonly stockService: StockService,
    private readonly vortexInstrumentService: VortexInstrumentService,
  ) {}

  @Post('instruments/sync')
  @ApiOperation({ summary: 'Sync instruments from selected provider (supports ?provider and Vortex CSV)' })
  @ApiHeader({ name: 'x-provider', required: false, description: 'Force provider for this request: kite|vortex' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE' })
  @ApiQuery({ name: 'provider', required: false, example: 'kite', description: 'Provider to sync: kite|vortex (overrides global for this call)' })
  @ApiQuery({ name: 'csv_url', required: false, description: 'When provider=vortex, optional CSV URL to import instruments' })
  async syncInstruments(@Query('exchange') exchange?: string, @Query('provider') provider?: 'kite' | 'vortex', @Query('csv_url') csvUrl?: string, @Request() req?: any) {
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
  @ApiOperation({ summary: 'Resolve trading symbol to instrument token (e.g., NSE:SBIN, NSE_SBIN, SBIN-EQ)' })
  @ApiQuery({ name: 'symbol', required: true, example: 'NSE_SBIN' })
  @ApiQuery({ name: 'segment', required: false, example: 'NSE' })
  async resolveSymbol(@Query('symbol') symbol: string, @Query('segment') seg?: string) {
    try {
      if (!symbol) {
        throw new HttpException(
          { success: false, message: 'symbol is required' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const { instrument, candidates } = await this.stockService.resolveSymbol(symbol, seg);
      return { success: true, data: { instrument, candidates } };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: 'Failed to resolve symbol', error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('instruments/search')
  @ApiOperation({ summary: 'Search instruments by symbol or name' })
  @ApiQuery({ name: 'q', required: true, example: 'RELIANCE' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  async searchInstruments(
    @Query('q') query: string,
    @Query('limit') limit?: number,
  ) {
    try {
      // Accept NSE:SBIN or NSE_SBIN as a direct lookup
      if (/^(NSE|BSE|NFO|CDS|MCX)[:_]/i.test(query)) {
        const resolved = await this.stockService.resolveSymbol(query);
        return {
          success: true,
          data: resolved.instrument ? [resolved.instrument] : resolved.candidates,
        };
      }
      if (!query) {
        throw new HttpException(
          {
            success: false,
            message: 'Search query is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const instruments = await this.stockService.searchInstruments(
        query,
        limit ? parseInt(limit.toString()) : 20,
      );

      return {
        success: true,
        data: instruments,
      };
    } catch (error) {
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

      const instrument = await this.stockService.getInstrumentByToken(instrumentToken);
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
  @ApiOperation({ summary: 'Get quotes for instruments with mode selection (ltp|ohlc|full)' })
  @ApiHeader({ name: 'x-provider', required: false, description: 'Force provider for this request: kite|vortex' })
  @ApiQuery({ name: 'mode', required: false, example: 'full', description: 'ltp | ohlc | full (default: full)' })
  @ApiBody({ schema: { properties: { instruments: { type: 'array', items: { type: 'number' }, example: [738561, 5633] } } } })
  @ApiResponse({ status: 200, description: 'Quote data response' })
  async getQuotes(@Body() body: { instruments: number[] }, @Request() req: any, @Query('mode') mode?: 'ltp' | 'ohlc' | 'full') {
    try {
      const { instruments } = body;
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
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
      let quotes: any;
      if (modeNorm === 'ltp') {
        quotes = await this.stockService.getLTP(instruments, req.headers, req.headers?.['x-api-key'] || req.query?.['api_key']);
      } else if (modeNorm === 'ohlc') {
        quotes = await this.stockService.getOHLC(instruments, req.headers, req.headers?.['x-api-key'] || req.query?.['api_key']);
      } else {
        quotes = await this.stockService.getQuotes(instruments, req.headers, req.headers?.['x-api-key'] || req.query?.['api_key']);
      }
      return {
        success: true,
        data: quotes,
        timestamp: new Date().toISOString(),
        mode: modeNorm,
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
  @ApiOperation({ summary: 'Search human tickers and return live price + metadata' })
  @ApiQuery({ name: 'q', required: true, example: 'NSE_SBIN' })
  async searchTickers(@Query('q') q: string) {
    try {
      if (!q) {
        throw new HttpException({ success: false, message: 'q is required' }, HttpStatus.BAD_REQUEST);
      }
      const { instrument, candidates } = await this.stockService.resolveSymbol(q);
      const items = instrument ? [instrument] : candidates;
      const tokens = items.map(i => i.instrument_token);
      const ltp = tokens.length ? await this.stockService.getLTP(tokens) : {};
      return {
        success: true,
        data: items.map(i => ({
          instrument_token: i.instrument_token,
          symbol: i.tradingsymbol,
          segment: i.segment,
          instrument_type: i.instrument_type,
          last_price: ltp?.[i.instrument_token]?.last_price ?? i.last_price ?? null,
        })),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException({ success: false, message: 'Failed to search tickers', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('tickers/:symbol')
  @ApiOperation({ summary: 'Get live price and metadata by human ticker (e.g., NSE_SBIN)' })
  async getTickerBySymbol(@Param('symbol') symbol: string) {
    try {
      const { instrument } = await this.stockService.resolveSymbol(symbol);
      if (!instrument) {
        throw new HttpException({ success: false, message: 'Symbol not found' }, HttpStatus.NOT_FOUND);
      }
      const ltp = await this.stockService.getLTP([instrument.instrument_token]);
      return {
        success: true,
        data: {
          instrument_token: instrument.instrument_token,
          symbol: instrument.tradingsymbol,
          segment: instrument.segment,
          instrument_type: instrument.instrument_type,
          last_price: ltp?.[instrument.instrument_token]?.last_price ?? instrument.last_price ?? null,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException({ success: false, message: 'Failed to fetch ticker', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('ltp')
  @ApiOperation({ summary: 'Get LTP for instruments' })
  @ApiHeader({ name: 'x-provider', required: false, description: 'Force provider for this request: kite|vortex' })
  @ApiBody({ schema: { properties: { instruments: { type: 'array', items: { type: 'number' }, example: [738561, 5633] } } } })
  async getLTP(@Body() body: { instruments: number[] }, @Request() req: any) {
    try {
      const { instruments } = body;
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
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

      const ltp = await this.stockService.getLTP(instruments, req.headers, req.headers?.['x-api-key'] || req.query?.['api_key']);
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
  @ApiHeader({ name: 'x-provider', required: false, description: 'Force provider for this request: kite|vortex' })
  @ApiBody({ schema: { properties: { instruments: { type: 'array', items: { type: 'number' }, example: [738561, 5633] } } } })
  async getOHLC(@Body() body: { instruments: number[] }, @Request() req: any) {
    try {
      const { instruments } = body;
      if (!instruments || !Array.isArray(instruments) || instruments.length === 0) {
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

      const ohlc = await this.stockService.getOHLC(instruments, req.headers, req.headers?.['x-api-key'] || req.query?.['api_key']);
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
  @ApiHeader({ name: 'x-provider', required: false, description: 'Force provider for this request: kite|vortex' })
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
        { success: false, message: 'Failed to fetch last tick', error: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('subscribe')
  @ApiOperation({ summary: 'Subscribe current user to an instrument' })
  @ApiBody({ schema: { properties: { instrumentToken: { type: 'number', example: 738561 }, subscriptionType: { type: 'string', example: 'live' } } } })
  async subscribeToInstrument(
    @Request() req: any,
    @Body() body: { instrumentToken: number; subscriptionType?: 'live' | 'historical' | 'both' },
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

      await this.stockService.unsubscribeFromInstrument(userId, instrumentToken);

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
      const subscriptions = await this.stockService.getUserSubscriptions(userId);

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

  // ===== VORTEX-SPECIFIC ENDPOINTS =====

  @Get('vortex/instruments')
  @ApiOperation({ summary: 'Get Vortex instruments with optional filters' })
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

      const result = await this.vortexInstrumentService.getVortexInstruments(filters);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch Vortex instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('vortex/instruments/search')
  @ApiOperation({ summary: 'Search Vortex instruments by symbol or instrument name' })
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

      const instruments = await this.vortexInstrumentService.searchVortexInstruments(
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
          message: 'Failed to search Vortex instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('vortex/instruments/stats')
  @ApiOperation({ summary: 'Get Vortex instrument statistics' })
  async getVortexInstrumentStats() {
    try {
      const stats = await this.vortexInstrumentService.getVortexInstrumentStats();
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch Vortex instrument stats',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('vortex/instruments/:token')
  @ApiOperation({ summary: 'Get specific Vortex instrument by token' })
  @ApiResponse({ status: 200, description: 'Vortex instrument found' })
  @ApiResponse({ status: 404, description: 'Vortex instrument not found' })
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

      const instrument = await this.vortexInstrumentService.getVortexInstrumentByToken(tokenNumber);
      
      if (!instrument) {
        throw new HttpException(
          {
            success: false,
            message: 'Vortex instrument not found',
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
          message: 'Failed to fetch Vortex instrument',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('vortex/instruments/sync')
  @ApiOperation({ summary: 'Manually sync Vortex instruments from CSV' })
  @ApiQuery({ name: 'exchange', required: false, example: 'NSE_EQ' })
  @ApiQuery({ name: 'csv_url', required: false, description: 'Optional CSV URL override' })
  async syncVortexInstruments(
    @Query('exchange') exchange?: string,
    @Query('csv_url') csvUrl?: string,
  ) {
    try {
      const result = await this.vortexInstrumentService.syncVortexInstruments(exchange, csvUrl);
      return {
        success: true,
        message: 'Vortex instruments synced successfully',
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to sync Vortex instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }


  @Get('vortex/options/chain/:symbol')
  @ApiOperation({ summary: 'Get options chain for a symbol' })
  async getVortexOptionsChain(@Param('symbol') symbol: string) {
    try {
      const result = await this.vortexInstrumentService.getVortexOptionsChain(symbol);

      // Get live prices for all options
      const allTokens = Object.values(result.options)
        .flatMap(expiry => Object.values(expiry))
        .flatMap(strike => [strike.CE?.token, strike.PE?.token])
        .filter(Boolean) as number[];

      const ltp = allTokens.length > 0 ? await this.vortexInstrumentService.getVortexLTP(allTokens) : {};

      // Add live prices to options chain
      const optionsWithPrices = { ...result.options };
      for (const [expiry, strikes] of Object.entries(optionsWithPrices)) {
        for (const [strikeStr, optionPair] of Object.entries(strikes)) {
          const strike = Number(strikeStr);
          if (optionPair.CE) {
            optionPair.CE = { ...optionPair.CE, last_price: ltp?.[optionPair.CE.token]?.last_price ?? null } as any;
          }
          if (optionPair.PE) {
            optionPair.PE = { ...optionPair.PE, last_price: ltp?.[optionPair.PE.token]?.last_price ?? null } as any;
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
        },
      };
    } catch (error) {
      throw new HttpException({ success: false, message: 'Failed to get options chain', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('vortex/instruments/batch')
  @ApiOperation({ summary: 'Batch lookup for multiple Vortex instruments' })
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
  async getVortexInstrumentsBatch(@Body() body: { tokens: number[] }) {
    try {
      if (!body.tokens || !Array.isArray(body.tokens) || body.tokens.length === 0) {
        throw new HttpException({ success: false, message: 'Tokens array is required' }, HttpStatus.BAD_REQUEST);
      }

      if (body.tokens.length > 100) {
        throw new HttpException({ success: false, message: 'Maximum 100 tokens allowed' }, HttpStatus.BAD_REQUEST);
      }

      const result = await this.vortexInstrumentService.getVortexInstrumentsBatch(body.tokens);

      return {
        success: true,
        data: {
          instruments: Object.fromEntries(
            Object.entries(result.instruments).map(([token, instrument]) => [
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
            ])
          ),
          ltp: result.ltp,
          performance: {
            queryTime: result.queryTime,
          },
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException({ success: false, message: 'Failed to get batch instruments', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ===== MARKET SEGMENT ENDPOINTS =====

  @Get('vortex/equities')
  @ApiOperation({ summary: 'Get Vortex equities with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol search' })
  @ApiQuery({ name: 'exchange', required: false, description: 'Exchange filter' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getVortexEquities(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    try {
      const filters = {
        query: q,
        exchange: exchange ? [exchange] : undefined,
        instrument_type: ['EQUITIES'],
        limit,
        offset,
      };

      const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(filters);
      
      const tokens = result.instruments.map(i => i.token);
      const ltp = tokens.length > 0 ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};

      return {
        success: true,
        data: {
          instruments: result.instruments.map(i => ({
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            last_price: ltp?.[i.token]?.last_price ?? null,
          })),
          pagination: {
            total: result.total,
            hasMore: result.hasMore,
          },
        },
      };
    } catch (error) {
      throw new HttpException({ success: false, message: 'Failed to get equities', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('vortex/futures')
  @ApiOperation({ summary: 'Get Vortex futures with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol search' })
  @ApiQuery({ name: 'exchange', required: false, description: 'Exchange filter' })
  @ApiQuery({ name: 'expiry_from', required: false, description: 'Expiry date from' })
  @ApiQuery({ name: 'expiry_to', required: false, description: 'Expiry date to' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getVortexFutures(
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    try {
      const filters = {
        query: q,
        exchange: exchange ? [exchange] : undefined,
        instrument_type: ['FUTSTK', 'FUTIDX'],
        expiry_from,
        expiry_to,
        limit,
        offset,
      };

      const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(filters);
      
      const tokens = result.instruments.map(i => i.token);
      const ltp = tokens.length > 0 ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};

      return {
        success: true,
        data: {
          instruments: result.instruments.map(i => ({
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            expiry_date: i.expiry_date,
            last_price: ltp?.[i.token]?.last_price ?? null,
          })),
          pagination: {
            total: result.total,
            hasMore: result.hasMore,
          },
        },
      };
    } catch (error) {
      throw new HttpException({ success: false, message: 'Failed to get futures', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('vortex/options')
  @ApiOperation({ summary: 'Get Vortex options with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol search' })
  @ApiQuery({ name: 'exchange', required: false, description: 'Exchange filter' })
  @ApiQuery({ name: 'option_type', required: false, enum: ['CE', 'PE'] })
  @ApiQuery({ name: 'expiry_from', required: false, description: 'Expiry date from' })
  @ApiQuery({ name: 'expiry_to', required: false, description: 'Expiry date to' })
  @ApiQuery({ name: 'strike_min', required: false, type: Number })
  @ApiQuery({ name: 'strike_max', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
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
  ) {
    try {
      const filters = {
        query: q,
        exchange: exchange ? [exchange] : undefined,
        instrument_type: ['OPTSTK', 'OPTIDX'],
        option_type,
        expiry_from,
        expiry_to,
        strike_min,
        strike_max,
        limit,
        offset,
      };

      const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(filters);
      
      const tokens = result.instruments.map(i => i.token);
      const ltp = tokens.length > 0 ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};

      return {
        success: true,
        data: {
          instruments: result.instruments.map(i => ({
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            expiry_date: i.expiry_date,
            option_type: i.option_type,
            strike_price: i.strike_price,
            last_price: ltp?.[i.token]?.last_price ?? null,
          })),
          pagination: {
            total: result.total,
            hasMore: result.hasMore,
          },
        },
      };
    } catch (error) {
      throw new HttpException({ success: false, message: 'Failed to get options', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('vortex/commodities')
  @ApiOperation({ summary: 'Get Vortex commodities (MCX) with filters' })
  @ApiQuery({ name: 'q', required: false, description: 'Symbol search' })
  @ApiQuery({ name: 'expiry_from', required: false, description: 'Expiry date from' })
  @ApiQuery({ name: 'expiry_to', required: false, description: 'Expiry date to' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getVortexCommodities(
    @Query('q') q?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    try {
      const filters = {
        query: q,
        exchange: ['MCX_FO'],
        expiry_from,
        expiry_to,
        limit,
        offset,
      };

      const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(filters);
      
      const tokens = result.instruments.map(i => i.token);
      const ltp = tokens.length > 0 ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};

      return {
        success: true,
        data: {
          instruments: result.instruments.map(i => ({
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            instrument_name: i.instrument_name,
            expiry_date: i.expiry_date,
            last_price: ltp?.[i.token]?.last_price ?? null,
          })),
          pagination: {
            total: result.total,
            hasMore: result.hasMore,
          },
        },
      };
    } catch (error) {
      throw new HttpException({ success: false, message: 'Failed to get commodities', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('vortex/instruments/popular')
  @ApiOperation({ summary: 'Get popular Vortex instruments with caching' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max instruments (default 50)' })
  async getVortexPopularInstruments(@Query('limit') limit?: number) {
    try {
      const result = await this.vortexInstrumentService.getVortexPopularInstrumentsCached(limit || 50);

      return {
        success: true,
        data: {
          instruments: result.instruments,
          performance: {
            queryTime: result.queryTime,
          },
        },
      };
    } catch (error) {
      throw new HttpException({ success: false, message: 'Failed to get popular instruments', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('vortex/instruments/cached-stats')
  @ApiOperation({ summary: 'Get Vortex instrument stats with caching' })
  async getVortexInstrumentStatsCached() {
    try {
      const result = await this.vortexInstrumentService.getVortexInstrumentStatsCached();

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
      throw new HttpException({ success: false, message: 'Failed to get cached stats', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('vortex/cache/clear')
  @ApiOperation({ summary: 'Clear Vortex cache' })
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
  async clearVortexCache(@Body() body: { pattern?: string }) {
    try {
      await this.vortexInstrumentService.clearVortexCache(body.pattern);

      return {
        success: true,
        message: 'Cache cleared successfully',
      };
    } catch (error) {
      throw new HttpException({ success: false, message: 'Failed to clear cache', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('vortex/tickers/search')
  @ApiOperation({ summary: 'Search Vortex tickers and return live price + metadata' })
  @ApiQuery({ name: 'q', required: true, example: 'NSE_EQ_RELIANCE' })
  async searchVortexTickers(@Query('q') q: string) {
    try {
      if (!q) {
        throw new HttpException({ success: false, message: 'q is required' }, HttpStatus.BAD_REQUEST);
      }
      
      const { instrument, candidates } = await this.vortexInstrumentService.resolveVortexSymbol(q);
      const items = instrument ? [instrument] : candidates;
      const tokens = items.map(i => i.token);
      const ltp = tokens.length ? await this.vortexInstrumentService.getVortexLTP(tokens) : {};
      
      return {
        success: true,
        data: items.map(i => ({
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          instrument_name: i.instrument_name,
          expiry_date: i.expiry_date,
          option_type: i.option_type,
          strike_price: i.strike_price,
          last_price: ltp?.[i.token]?.last_price ?? null,
        })),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException({ success: false, message: 'Failed to search Vortex tickers', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('vortex/tickers/:symbol')
  @ApiOperation({ summary: 'Get live price and metadata by Vortex ticker (e.g., NSE_EQ_RELIANCE)' })
  async getVortexTickerBySymbol(@Param('symbol') symbol: string) {
    try {
      const { instrument } = await this.vortexInstrumentService.resolveVortexSymbol(symbol);
      if (!instrument) {
        throw new HttpException({ success: false, message: 'Vortex symbol not found' }, HttpStatus.NOT_FOUND);
      }
      
      const ltp = await this.vortexInstrumentService.getVortexLTP([instrument.token]);
      
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
          last_price: ltp?.[instrument.token]?.last_price ?? null,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException({ success: false, message: 'Failed to fetch Vortex ticker', error: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
