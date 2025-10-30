import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Query,
} from '@nestjs/common';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  private readonly logger = new Logger('SearchController');
  constructor(private readonly searchService: SearchService) {}

  // GET /api/search?q&exchange&segment&instrumentType&limit
  @Get()
  async search(
    @Query('q') q: string,
    @Query('limit') limitRaw?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
  ) {
    if (!q || q.trim().length === 0) {
      throw new HttpException(
        { success: false, message: 'q is required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const limit = Math.min(Number(limitRaw || 10), 50);
    const filters: any = { exchange, segment, instrumentType };
    const items = await this.searchService.searchInstruments(q.trim(), limit, filters);
    const tokens = items.map((i) => i.instrumentToken).slice(0, Math.min(limit, 10));
    const quotes = await this.searchService.hydrateQuotes(tokens, 'ltp');
    return {
      success: true,
      data: items.map((it) => ({
        ...it,
        last_price: quotes?.[String(it.instrumentToken)]?.last_price ?? null,
      })),
      timestamp: new Date().toISOString(),
    };
  }

  // GET /api/search/suggest?q&limit
  @Get('suggest')
  async suggest(@Query('q') q: string, @Query('limit') limitRaw?: string) {
    const limit = Math.min(Number(limitRaw || 5), 20);
    if (!q || q.trim().length === 0) {
      return { success: true, data: [], timestamp: new Date().toISOString() };
    }
    const items = await this.searchService.searchInstruments(q.trim(), limit);
    return { success: true, data: items, timestamp: new Date().toISOString() };
  }

  // GET /api/search/filters - placeholder returning empty facets for now
  @Get('filters')
  async filters(
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
  ) {
    const filters: any = { exchange, segment, instrumentType };
    const data = await this.searchService.facetCounts(filters);
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  // GET /api/search/popular - placeholder until we wire counters
  @Get('popular')
  async popular(@Query('limit') limitRaw?: string) {
    const limit = Math.min(Number(limitRaw || 10), 50);
    this.logger.log(`popular requested, limit=${limit}`);
    // Placeholder popular tickers list can be sourced later
    return { success: true, data: [], timestamp: new Date().toISOString() };
  }
}


