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
} from "@nestjs/common";
import { StockService } from "@features/stock/application/stock.service";
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiHeader,
  ApiBody,
  ApiResponse,
} from "@nestjs/swagger";
import { ApiKeyGuard } from "@shared/guards/api-key.guard";
import { InstrumentsRequestDto } from "./dto/instruments.dto";

@Controller("stock")
@UseGuards(ApiKeyGuard)
@ApiTags("stock")
@ApiSecurity("apiKey")
export class StockQuotesController {
  constructor(private readonly stockService: StockService) {}

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
}
