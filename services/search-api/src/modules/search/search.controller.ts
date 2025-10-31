import {
  Controller,
  Get,
  Post,
  Body,
  HttpException,
  HttpStatus,
  Logger,
  Query,
  Res,
  Req,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  private readonly logger = new Logger('SearchController');
  constructor(private readonly searchService: SearchService) {}

  // GET /api/search?q&exchange&segment&instrumentType&limit&vortexExchange&expiry_from&expiry_to&strike_min&strike_max&ltp_only
  @Get()
  async search(
    @Query('q') q: string,
    @Query('limit') limitRaw?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
    @Query('vortexExchange') vortexExchange?: string,
    @Query('mode') mode?: 'eq' | 'fno' | 'curr' | 'commodities',
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('strike_min') strike_min?: string,
    @Query('strike_max') strike_max?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    if (!q || q.trim().length === 0) {
      throw new HttpException(
        { success: false, message: 'q is required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const limit = Math.min(Number(limitRaw || 10), 50);
    const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
    const modeMap: any = { eq: 'NSE_EQ', fno: 'NSE_FO', curr: 'NSE_CUR', commodities: 'MCX_FO' };
    const modeVe = mode ? modeMap[String(mode).toLowerCase()] : undefined;
    const filters: any = {
      exchange,
      segment,
      instrumentType,
      vortexExchange: vortexExchange || modeVe,
      expiry_from,
      expiry_to,
      strike_min,
      strike_max,
    };
    const probeMult = Number(process.env.LTP_ONLY_PROBE_MULTIPLIER || 5);
    const searchCap = Number(process.env.SEARCH_LTP_ONLY_HYDRATE_CAP || 200);
    const hardCap = 1000;
    const probeLimit = ltpOnly
      ? Math.min(Math.max(limit * probeMult, limit), searchCap, hardCap)
      : limit;
    const items = await this.searchService.searchInstruments(q.trim(), probeLimit, filters);
    // Prefer pair-based hydration when vortexExchange is present; hydrate up to probeLimit
    const topItems = items.slice(0, probeLimit);
    const hasVortexEx = topItems.some((i: any) => i?.vortexExchange);
    const quotes = hasVortexEx
      ? await this.searchService.hydrateLtpByPairs(topItems as any)
      : await this.searchService.hydrateQuotes(
          topItems.map((i) => i.instrumentToken),
          'ltp',
        );
    const enriched = items.map((it: any) => ({
      ...it,
      last_price: quotes?.[String(it.instrumentToken)]?.last_price ?? null,
    }));
    const filtered = ltpOnly
      ? enriched.filter((v: any) => Number.isFinite(v?.last_price) && (v?.last_price ?? 0) > 0)
      : enriched;
    const data = filtered.slice(0, limit);
    this.logger.log(
      `[Search] q="${q}" limit=${limit} probe=${probeLimit} ltp_only=${ltpOnly} hydrated=${topItems.length} returned=${data.length}`,
    );
    return { success: true, data, timestamp: new Date().toISOString() };
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
    @Query('mode') mode?: 'eq' | 'fno' | 'curr' | 'commodities',
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
    const modeMap: any = { eq: 'NSE_EQ', fno: 'NSE_FO', curr: 'NSE_CUR', commodities: 'MCX_FO' };
    const modeVe = mode ? modeMap[String(mode).toLowerCase()] : undefined;
    const filters: any = {
      exchange,
      segment,
      instrumentType,
      vortexExchange: vortexExchange || modeVe,
      expiry_from,
      expiry_to,
      strike_min,
      strike_max,
    };
    const probeMult = Number(process.env.LTP_ONLY_PROBE_MULTIPLIER || 5);
    const suggestCap = Number(process.env.SUGGEST_LTP_ONLY_HYDRATE_CAP || 100);
    const hardCap = 1000;
    const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
    const probeLimit = ltpOnly
      ? Math.min(Math.max(limit * probeMult, limit), suggestCap, hardCap)
      : limit;
    const items = await this.searchService.searchInstruments(q.trim(), probeLimit, filters);
    const topItems = items.slice(0, probeLimit);
    const hasVortexEx = topItems.some((i: any) => i?.vortexExchange);
    const quotes = hasVortexEx
      ? await this.searchService.hydrateLtpByPairs(topItems as any)
      : await this.searchService.hydrateQuotes(
          topItems.map((i) => i.instrumentToken),
          'ltp',
        );
    const enriched = items.map((it: any) => ({
      ...it,
      last_price: quotes?.[String(it.instrumentToken)]?.last_price ?? null,
    }));
    const filtered = ltpOnly
      ? enriched.filter((v: any) => Number.isFinite(v?.last_price) && (v?.last_price ?? 0) > 0)
      : enriched;
    const data = filtered.slice(0, limit);
    this.logger.log(
      `[Suggest] q="${q}" limit=${limit} probe=${probeLimit} ltp_only=${ltpOnly} enriched=${enriched.length} returned=${data.length}`,
    );
    return { success: true, data, timestamp: new Date().toISOString() };
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

  // POST /api/search/telemetry/selection
  @Post('telemetry/selection')
  async selection(@Body() body: { q?: string; symbol?: string; instrumentToken?: number }) {
    const q = String(body?.q || '').trim();
    const symbol = String(body?.symbol || '').trim();
    const token = Number(body?.instrumentToken);
    if (!q || !symbol) {
      throw new HttpException(
        { success: false, message: 'q and symbol are required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    // Best effort; never block UI
    await this.searchService.logSelectionTelemetry(q, symbol, Number.isFinite(token) ? token : undefined);
    return { success: true };
  }

  // GET /api/search/stream - SSE for LTP updates (~1s, 30s TTL)
  @Get('stream')
  async stream(
    @Res() res: Response,
    @Req() req: Request,
    @Query('tokens') tokens?: string,
    @Query('q') q?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
    const parseTokens = (s?: string): number[] =>
      String(s || '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n));
    let ids: number[] = parseTokens(tokens).slice(0, 100);
    let lastSentAt = 0;
    const ttlMs = Number(process.env.SSE_DEFAULT_TTL_MS || 30000);
    const started = Date.now();
    const send = (data: any) => {
      res.write(`event: ltp\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      lastSentAt = Date.now();
    };
    const timer = setInterval(async () => {
      try {
        if (Date.now() - started > ttlMs) {
          clearInterval(timer);
          res.end();
          return;
        }
        if (!ids.length && q) {
          const items = await this.searchService.searchInstruments(q.trim(), 10, {});
          ids = items.map((i: any) => i.instrumentToken).slice(0, 100);
        }
        if (!ids.length) return;
        const quotes = await this.searchService.hydrateQuotes(ids, 'ltp');
        const payload = ltpOnly
          ? Object.fromEntries(
              Object.entries(quotes).filter(([, v]: any) => Number.isFinite(v?.last_price) && (v?.last_price ?? 0) > 0),
            )
          : quotes;
        send({ quotes: payload, ts: new Date().toISOString() });
      } catch {
        // skip tick on error
      }
    }, 1000);
    req.on('close', () => {
      clearInterval(timer);
    });
  }
}


