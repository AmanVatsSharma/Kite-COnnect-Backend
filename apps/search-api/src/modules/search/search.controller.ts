/**
 * @file apps/search-api/src/modules/search/search.controller.ts
 * @module search-api
 * @description REST controller for instrument search, suggest, facets, SSE streaming,
 *              and selection telemetry. All search results are keyed by universal
 *              instrument `id` + `canonicalSymbol`.
 *
 * Exports:
 *   - SearchController — NestJS controller mounted at /api/search
 *
 * Endpoints:
 *   GET  /api/search               — full search with optional LTP hydration
 *   GET  /api/search/suggest       — lightweight autocomplete (smaller limit)
 *   GET  /api/search/filters       — facet distribution (exchange, segment, type)
 *   GET  /api/search/popular       — placeholder for trending tickers
 *   POST /api/search/telemetry/selection — synonym learning signal
 *   GET  /api/search/stream        — SSE stream of LTP ticks for given tokens
 *
 * Side-effects:
 *   - Writes Redis synonym telemetry keys on POST /telemetry/selection
 *   - Emits SSE ticks until 30s TTL or client disconnect
 *
 * Key invariants:
 *   - Results use `id` (universal_instruments.id) as primary identifier
 *   - `mode=eq|fno|curr|commodities` maps to `vortexExchange` filter shorthand
 *   - ltp_only=true probes a wider set, then filters to instruments with live prices
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-22
 */

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
import { SearchService, SearchResultItem } from './search.service';

const MODE_TO_VORTEX_EXCHANGE: Record<string, string> = {
  eq: 'NSE_EQ',
  fno: 'NSE_FO',
  curr: 'NSE_CUR',
  commodities: 'MCX_FO',
};

@Controller('search')
export class SearchController {
  private readonly logger = new Logger('SearchController');
  constructor(private readonly searchService: SearchService) {}

  /**
   * GET /api/search
   * Universal instrument search. Supports all filter dimensions.
   * Pass ltp_only=true to return only instruments with a live price.
   */
  @Get()
  async search(
    @Query('q') q: string,
    @Query('limit') limitRaw?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
    @Query('vortexExchange') vortexExchange?: string,
    @Query('optionType') optionType?: string,
    @Query('assetClass') assetClass?: string,
    @Query('mode') mode?: string,
    @Query('expiry_from') expiry_from?: string,
    @Query('expiry_to') expiry_to?: string,
    @Query('strike_min') strike_min?: string,
    @Query('strike_max') strike_max?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    if (!q || q.trim().length === 0) {
      throw new HttpException({ success: false, message: 'q is required' }, HttpStatus.BAD_REQUEST);
    }

    const limit = Math.min(Number(limitRaw || 10), 50);
    const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
    const modeVe = mode ? MODE_TO_VORTEX_EXCHANGE[String(mode).toLowerCase()] : undefined;

    const filters = {
      exchange,
      segment,
      instrumentType,
      vortexExchange: vortexExchange || modeVe,
      optionType,
      assetClass,
      expiry_from,
      expiry_to,
      strike_min,
      strike_max,
    };

    const probeMult = Number(process.env.LTP_ONLY_PROBE_MULTIPLIER || 5);
    const searchCap = Number(process.env.SEARCH_LTP_ONLY_HYDRATE_CAP || 200);
    const probeLimit = ltpOnly ? Math.min(Math.max(limit * probeMult, limit), searchCap) : limit;

    const items = await this.searchService.searchInstruments(q.trim(), probeLimit, filters);
    const quotes = await this.searchService.hydrateLtpByItems(items.slice(0, probeLimit));

    const enriched = items.map((it) => ({
      ...it,
      last_price: quotes?.[String(it.id)]?.last_price ?? null,
    }));

    const data = (ltpOnly
      ? enriched.filter((v) => Number.isFinite(v.last_price) && (v.last_price ?? 0) > 0)
      : enriched
    ).slice(0, limit);

    this.logger.log(`[Search] q="${q}" limit=${limit} probe=${probeLimit} ltp_only=${ltpOnly} returned=${data.length}`);
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  /**
   * GET /api/search/suggest
   * Lightweight typeahead — smaller default limit, same filter surface.
   */
  @Get('suggest')
  async suggest(
    @Query('q') q: string,
    @Query('limit') limitRaw?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
    @Query('vortexExchange') vortexExchange?: string,
    @Query('optionType') optionType?: string,
    @Query('mode') mode?: string,
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

    const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
    const modeVe = mode ? MODE_TO_VORTEX_EXCHANGE[String(mode).toLowerCase()] : undefined;

    const filters = {
      exchange,
      segment,
      instrumentType,
      vortexExchange: vortexExchange || modeVe,
      optionType,
      expiry_from,
      expiry_to,
      strike_min,
      strike_max,
    };

    const probeMult = Number(process.env.LTP_ONLY_PROBE_MULTIPLIER || 5);
    const suggestCap = Number(process.env.SUGGEST_LTP_ONLY_HYDRATE_CAP || 100);
    const probeLimit = ltpOnly ? Math.min(Math.max(limit * probeMult, limit), suggestCap) : limit;

    const items = await this.searchService.searchInstruments(q.trim(), probeLimit, filters);
    const quotes = await this.searchService.hydrateLtpByItems(items.slice(0, probeLimit));

    const enriched = items.map((it) => ({
      ...it,
      last_price: quotes?.[String(it.id)]?.last_price ?? null,
    }));

    const data = (ltpOnly
      ? enriched.filter((v) => Number.isFinite(v.last_price) && (v.last_price ?? 0) > 0)
      : enriched
    ).slice(0, limit);

    this.logger.log(`[Suggest] q="${q}" limit=${limit} ltp_only=${ltpOnly} returned=${data.length}`);
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  /**
   * GET /api/search/filters
   * Returns facet distributions for building filter UIs (exchange, segment, type, etc.)
   */
  @Get('filters')
  async filters(
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
    @Query('assetClass') assetClass?: string,
  ) {
    const data = await this.searchService.facetCounts({ exchange, segment, instrumentType, assetClass });
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  /**
   * GET /api/search/popular
   * Trending / popular instruments — wired to Redis counters in a future iteration.
   */
  @Get('popular')
  async popular(@Query('limit') limitRaw?: string) {
    const limit = Math.min(Number(limitRaw || 10), 50);
    this.logger.log(`popular requested, limit=${limit}`);
    return { success: true, data: [], timestamp: new Date().toISOString() };
  }

  /**
   * POST /api/search/telemetry/selection
   * Client signals which result was selected. Used to train dynamic synonyms.
   * Body: { q, symbol, universalId? }
   */
  @Post('telemetry/selection')
  async selection(
    @Body() body: { q?: string; symbol?: string; universalId?: number; instrumentToken?: number },
  ) {
    const q = String(body?.q || '').trim();
    const symbol = String(body?.symbol || '').trim();
    const uid = body?.universalId ?? body?.instrumentToken; // accept both for backward compat
    if (!q || !symbol) {
      throw new HttpException({ success: false, message: 'q and symbol are required' }, HttpStatus.BAD_REQUEST);
    }
    await this.searchService.logSelectionTelemetry(q, symbol, Number.isFinite(uid) ? Number(uid) : undefined);
    return { success: true };
  }

  /**
   * GET /api/search/stream
   * SSE stream pushing LTP ticks every ~1s for up to 30s (configurable via SSE_DEFAULT_TTL_MS).
   * Pass ?tokens=1,2,3 or ?q=NIFTY to auto-resolve tokens from search.
   */
  @Get('stream')
  async stream(
    @Res() res: Response,
    @Req() req: Request,
    @Query('tokens') tokensRaw?: string,
    @Query('q') q?: string,
    @Query('ltp_only') ltpOnlyRaw?: string | boolean,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const ltpOnly = String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;
    const parseTokens = (s?: string): number[] =>
      String(s || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));

    let ids: number[] = parseTokens(tokensRaw).slice(0, 100);
    const ttlMs = Number(process.env.SSE_DEFAULT_TTL_MS || 30_000);
    const started = Date.now();

    const send = (data: any) => {
      res.write(`event: ltp\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
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
          // SSE stream uses vortexToken for LTP polling if available
          ids = items
            .map((i: SearchResultItem) => i.vortexToken ?? i.kiteToken)
            .filter((t): t is number => t !== undefined)
            .slice(0, 100);
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

    req.on('close', () => clearInterval(timer));
  }
}
