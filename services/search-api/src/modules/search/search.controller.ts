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
    // Prefer pair-based hydration when vortexExchange is present
    const topItems = items.slice(0, Math.min(limit, 10));
    const hasVortexEx = topItems.some((i: any) => i?.vortexExchange);
    const quotes = hasVortexEx
      ? await this.searchService.hydrateLtpByPairs(topItems as any)
      : await this.searchService.hydrateQuotes(
          topItems.map((i) => i.instrumentToken),
          'ltp',
        );
    return {
      success: true,
      data: items.map((it: any) => ({
        ...it,
        last_price: quotes?.[String(it.instrumentToken)]?.last_price ?? null,
      })),
      timestamp: new Date().toISOString(),
    };
  }

  // GET /api/search/suggest?q&limit
  @Get('suggest')
  async suggest(
    @Query('q') q: string,
    @Query('limit') limitRaw?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
    @Query('vortexExchange') vortexExchange?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('strike_min') strike_min?: string,
    @Query('strike_max') strike_max?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    const limit = Math.min(Number(limitRaw || 5), 20);
    if (!q || q.trim().length === 0) {
      return { success: true, data: [], timestamp: new Date().toISOString() };
    }
    const filters: any = {
      exchange,
      segment,
      instrumentType,
      vortexExchange,
      expiry_from,
      expiry_to,
      strike_min,
      strike_max,
    };
    const items = await this.searchService.searchInstruments(q.trim(), limit, filters);
    const topItems = items.slice(0, Math.min(limit, 10));
    const hasVortexEx = topItems.some((i: any) => i?.vortexExchange);
    const quotes = hasVortexEx
      ? await this.searchService.hydrateLtpByPairs(topItems as any)
      : await this.searchService.hydrateQuotes(
          topItems.map((i) => i.instrumentToken),
          'ltp',
        );

    const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
    const enriched = items.map((it: any) => ({
      ...it,
      last_price: quotes?.[String(it.instrumentToken)]?.last_price ?? null,
    }));
    const filtered = ltpOnly
      ? enriched.filter((v: any) => Number.isFinite(v?.last_price) && (v?.last_price ?? 0) > 0)
      : enriched;
    this.logger.log(
      `[Suggest] q="${q}" limit=${limit} ltp_only=${ltpOnly} enriched=${enriched.length} returned=${filtered.length}`,
    );
    return { success: true, data: filtered, timestamp: new Date().toISOString() };
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


