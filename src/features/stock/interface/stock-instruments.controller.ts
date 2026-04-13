/**
 * @file stock-instruments.controller.ts
 * @module stock
 * @description Stock REST: instrument sync, list, resolve, search, get-by-token.
 * @author BharatERP
 * @created 2026-03-28
 */
import {
  Controller,
  Get,
  Post,
  Param,
  Query,
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
} from "@nestjs/swagger";
import { ApiKeyGuard } from "@shared/guards/api-key.guard";

@Controller("stock")
@UseGuards(ApiKeyGuard)
@ApiTags("stock")
@ApiSecurity("apiKey")
export class StockInstrumentsController {
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
}
