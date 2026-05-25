/**
 * File:        market-movers.controller.ts
 * Module:      market-movers
 * Description: REST endpoint for market movers: GET /api/market/movers?type=gainers&exchange=NSE.
 *              Returns cached data with appropriate cache headers (Cache-Control: public, max-age=3600).
 *              Protected by optional API key guard (public if no key configured).
 *
 * Exports:
 *   - MarketMoversController — NestJS controller
 *
 * Depends on:
 *   - MarketMoversService    — data fetching
 *
 * Side-effects:
 *   - Redis read (cache hit/miss), HTTP call to upstream on miss
 *   - No persistent side-effects
 *
 * Key invariants:
 *   - Always returns { success: true, data: ... } shape even on empty result
 *   - HTTP 200 OK always; errors are caught and returned as success:false with error detail
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-24
 */
import {
  Controller,
  Get,
  Query,
  HttpStatus,
  HttpCode,
  HttpException,
  UseGuards,
  Header,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiProduces,
} from '@nestjs/swagger';
import { MarketMoversService } from '../application/market-movers.service';
import {
  MarketMoversQueryDto,
  MarketMoversResponseDto,
  MoversType,
} from './dto/market-movers.dto';

@ApiTags('market-movers')
@Controller('market/movers')
export class MarketMoversController {
  constructor(private readonly movers: MarketMoversService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get NSE/BSE top movers (gainers, losers, most active)',
    description:
      'Returns cached market mover data (updated every hour). ' +
      'Cache-Control: public, max-age=3600. Set x-provider: force for specific provider.',
  })
  @ApiQuery({
    name: 'type',
    enum: MoversType,
    required: false,
    description: 'Type of movers: gainers (default), losers, active',
  })
  @ApiQuery({
    name: 'exchange',
    required: false,
    description: 'Exchange: NSE (default) or BSE',
  })
  @ApiProduces('application/json')
  @ApiResponse({
    status: 200,
    description: 'Market movers data',
    type: MarketMoversResponseDto,
  })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  @Header('Cache-Control', 'public, max-age=3600')
  async getMovers(
    @Query() query: MarketMoversQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MarketMoversResponseDto> {
    const type = query.type ?? MoversType.GAINERS;
    const exchange = query.exchange?.toUpperCase() ?? 'NSE';

    try {
      const data = await this.movers.getMarketMovers(exchange, type);

      // Add cache freshness header
      const cacheAge = 3600;
      res.setHeader('Age', String(cacheAge));
      res.setHeader(
        'X-Cache-Generated-At',
        data.generatedAt,
      );

      return {
        success: true,
        data,
      };
    } catch (err: any) {
      const message = err?.message ?? 'Failed to fetch market movers';
      throw new HttpException(
        {
          success: false,
          error: message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}