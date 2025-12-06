import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { VortexInstrumentService } from '../../services/vortex-instrument.service';
import { RequestBatchingService } from '../request-batching.service';
import { VortexProviderService } from '../../providers/vortex-provider.service';
import { RedisService } from '../../services/redis.service';
import { FnoQueryParserService } from '../../services/fno-query-parser.service';
import { MetricsService } from '../../services/metrics.service';

@Injectable()
export class VayuOptionService {
  constructor(
    private readonly vortexInstrumentService: VortexInstrumentService,
    private readonly requestBatchingService: RequestBatchingService,
    private readonly vortexProvider: VortexProviderService,
    private readonly redisService: RedisService,
    private readonly fnoQueryParser: FnoQueryParserService,
    private readonly metrics: MetricsService,
  ) {}

  async getVortexOptions(
    q?: string,
    exchange?: string,
    option_type?: 'CE' | 'PE',
    expiry_from?: string,
    expiry_to?: string,
    strike_min?: number,
    strike_max?: number,
    limit?: number,
    offset?: number,
    ltpOnlyRaw?: string | boolean,
    sort?: 'relevance' | 'expiry' | 'strike',
  ) {
    try {
      const t0 = Date.now();
      const requestedLimit = limit ? parseInt(limit.toString()) : 50;
      const startOffset = offset ? parseInt(offset.toString()) : 0;
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);
      const sortMode = (sort || 'relevance').toString().toLowerCase();

      // Parse trading-style options queries like "nifty 26000 ce" or "banknifty 45000 pe".
      const parsed = q && q.trim() ? this.fnoQueryParser.parse(q) : undefined;
      const underlyingSymbol = parsed?.underlying;

      let effectiveQuery = underlyingSymbol ? undefined : q;
      let effectiveOptionType: 'CE' | 'PE' | undefined = option_type;
      let effectiveExpiryFrom = parsed?.expiryFrom || expiry_from;
      let effectiveExpiryTo = parsed?.expiryTo || expiry_to;
      let effectiveStrikeMin = strike_min;
      let effectiveStrikeMax = strike_max;

      // Only use parsed hints when explicit query params are not provided
      if (!effectiveOptionType && parsed?.optionType) {
        effectiveOptionType = parsed.optionType;
      }
      if (
        parsed?.strike !== undefined &&
        effectiveStrikeMin === undefined &&
        effectiveStrikeMax === undefined
      ) {
        effectiveStrikeMin = parsed.strike;
        effectiveStrikeMax = parsed.strike;
      }

      // Console log for easy debugging of parsing behaviour and downstream filters
      // eslint-disable-next-line no-console
      console.log('[Vayu Options Search]', {
        q,
        underlying: underlyingSymbol,
        strike: parsed?.strike,
        option_type: effectiveOptionType,
        expiry_from: effectiveExpiryFrom,
        expiry_to: effectiveExpiryTo,
        exchange,
        ltpOnly,
      });

      const parsedLabel =
        parsed && (parsed.underlying || parsed.strike || parsed.optionType || parsed.expiryFrom)
          ? 'yes'
          : 'no';
      this.metrics.foSearchRequestsTotal.inc({
        endpoint: 'vayu_options',
        ltp_only: String(ltpOnly),
        parsed: parsedLabel,
      });
      const latencyTimer = this.metrics.foSearchLatencySeconds.startTimer({
        endpoint: 'vayu_options',
        ltp_only: String(ltpOnly),
      });

      const cacheKeyBase = [
        'vayu:fno:options',
        `under=${underlyingSymbol || 'ANY'}`,
        `ex=${exchange || 'ANY'}`,
        `of=${effectiveOptionType || 'ANY'}`,
        `ef=${effectiveExpiryFrom || 'ANY'}`,
        `et=${effectiveExpiryTo || 'ANY'}`,
        `sm=${effectiveStrikeMin ?? 'ANY'}`,
        `sx=${effectiveStrikeMax ?? 'ANY'}`,
        `ltp=${ltpOnly ? '1' : '0'}`,
        `lim=${requestedLimit}`,
        `off=${startOffset}`,
        `sort=${sortMode}`,
      ].join('|');
      const cacheKey = cacheKeyBase;
      const foCacheTtlSec = Number(process.env.FO_CACHE_TTL_SECONDS || 2);

      try {
        const cached = await this.redisService.get<any>(cacheKey);
        if (cached && cached.success === true) {
          // eslint-disable-next-line no-console
          console.log('[Vayu Options Search] Cache HIT', { cacheKey });
          latencyTimer();
          return cached;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu Options Search] Cache READ failed (non-fatal)', (e as any)?.message);
      }

      // Updated instrument types to include OPTFUT and OPTCUR
      const instrumentTypes = ['OPTSTK', 'OPTIDX', 'OPTFUT', 'OPTCUR'];

      if (!ltpOnly) {
        // First attempt: parsed filters with exact underlying_symbol
        let result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          // Use exact underlying_symbol when parsed to keep DB filters tight and index-friendly
          query: effectiveQuery,
          underlying_symbol: underlyingSymbol,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: instrumentTypes,
          option_type: effectiveOptionType,
          expiry_from: effectiveExpiryFrom,
          expiry_to: effectiveExpiryTo,
          strike_min: effectiveStrikeMin,
          strike_max: effectiveStrikeMax,
          options_only: true,
          limit: requestedLimit,
          offset: startOffset,
          sort_by: 'expiry_date',
          sort_order: 'asc',
          only_active: false,
        });

        if ((!result.instruments || result.instruments.length === 0) && q && q.trim()) {
          // eslint-disable-next-line no-console
          console.log('[Vayu Options Search] No rows for parsed filters, falling back to fuzzy symbol search');
          result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
            query: q.trim(),
            underlying_symbol: undefined,
            exchange: exchange ? [exchange] : undefined,
            instrument_type: instrumentTypes,
            option_type: effectiveOptionType,
            expiry_from: effectiveExpiryFrom,
            expiry_to: effectiveExpiryTo,
            strike_min: effectiveStrikeMin,
            strike_max: effectiveStrikeMax,
            options_only: true,
            limit: requestedLimit,
            offset: startOffset,
            sort_by: 'expiry_date',
            sort_order: 'asc',
            only_active: false,
          });
        }
        const pairs = this.vortexInstrumentService.buildPairsFromInstruments(result.instruments as any);
        const ltpByPair = pairs.length ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any) : {};
        const parsedStrikeHint = parsed?.strike;
        const list = result.instruments.map((i) => {
          const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
          const lp = ltpByPair?.[key]?.last_price ?? null;
          const daysToExpiry = this.computeDaysToExpiry(i.expiry_date as any);
          return {
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            description: (i as any)?.description || null,
            expiry_date: i.expiry_date,
            option_type: i.option_type,
            strike_price: i.strike_price,
            days_to_expiry: daysToExpiry,
            last_price: lp,
          };
        });
        const ranked = this.rankFoInstruments(list, sortMode, parsedStrikeHint);
        const response = {
          success: true,
          data: {
            instruments: ranked,
            pagination: {
              total: result.total,
              hasMore: result.hasMore,
            },
            ltp_only: false,
            performance: { queryTime: Date.now() - t0 },
          },
        };
        try {
          await this.redisService.set(cacheKey, response, foCacheTtlSec);
          // eslint-disable-next-line no-console
          console.log('[Vayu Options Search] Cache SET', { cacheKey, ttl: foCacheTtlSec });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[Vayu Options Search] Cache WRITE failed (non-fatal)', (e as any)?.message);
        }
        latencyTimer();
        return response;
      }

      // Fast single-shot probe for ltp_only=true
      const probeLimit = Math.min(500, Math.max(requestedLimit * 4, requestedLimit + startOffset));
      // First attempt: parsed filters with only_active=true for tradable subset
      let page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
        query: effectiveQuery,
        underlying_symbol: underlyingSymbol,
        exchange: exchange ? [exchange] : undefined,
        instrument_type: instrumentTypes,
        option_type: effectiveOptionType,
        expiry_from: effectiveExpiryFrom,
        expiry_to: effectiveExpiryTo,
        strike_min: effectiveStrikeMin,
        strike_max: effectiveStrikeMax,
        options_only: true,
        limit: probeLimit,
        offset: startOffset,
        skip_count: true,
        sort_by: 'expiry_date',
        sort_order: 'asc',
        only_active: true,
      });

      if ((!page.instruments || page.instruments.length === 0) && q && q.trim()) {
        // eslint-disable-next-line no-console
        console.log('[Vayu Options Search] ltp_only probe empty, falling back to fuzzy symbol search');
        page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q.trim(),
          underlying_symbol: undefined,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: instrumentTypes,
          option_type: effectiveOptionType,
          expiry_from: effectiveExpiryFrom,
          expiry_to: effectiveExpiryTo,
          strike_min: effectiveStrikeMin,
          strike_max: effectiveStrikeMax,
          options_only: true,
          limit: probeLimit,
          offset: startOffset,
          skip_count: true,
          sort_by: 'expiry_date',
          sort_order: 'asc',
          only_active: true,
        });
      }
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(page.instruments as any);
      const ltpByPair = pairs.length ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any) : {};
      const enriched = page.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          description: (i as any)?.description || null,
          expiry_date: i.expiry_date as any,
          option_type: i.option_type,
          strike_price: i.strike_price,
          days_to_expiry: this.computeDaysToExpiry(i.expiry_date as any),
          last_price: lp,
        };
      });
      const filtered = enriched.filter((v: any) => Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0));
      const ranked = this.rankFoInstruments(filtered, sortMode, parsed?.strike);
      const sliced = ranked.slice(0, requestedLimit);

      const response = {
        success: true,
        data: {
          instruments: sliced,
          pagination: {
            total: undefined,
            hasMore: page.hasMore,
          },
          ltp_only: true,
          performance: { queryTime: Date.now() - t0 },
        },
      };
      try {
        await this.redisService.set(cacheKey, response, foCacheTtlSec);
        // eslint-disable-next-line no-console
        console.log('[Vayu Options Search] Cache SET (ltp_only)', {
          cacheKey,
          ttl: foCacheTtlSec,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu Options Search] Cache WRITE failed (ltp_only, non-fatal)', (e as any)?.message);
      }
      latencyTimer();
      return response;
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get options',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getVortexMcxOptions(
    q?: string,
    option_type?: 'CE' | 'PE',
    expiry_from?: string,
    expiry_to?: string,
    strike_min?: number,
    strike_max?: number,
    limit?: number,
    offset?: number,
    ltpOnlyRaw?: string | boolean,
  ) {
    try {
      const t0 = Date.now();
      const requestedLimit = limit ? parseInt(limit.toString()) : 50;
      const startOffset = offset ? parseInt(offset.toString()) : 0;
      const ltpOnly =
        String(ltpOnlyRaw || '').toLowerCase() === 'true' || ltpOnlyRaw === true;

      // Parse trading-style MCX options queries like "gold 62000 ce"
      const parsed = q && q.trim() ? this.fnoQueryParser.parse(q) : undefined;
      const underlyingSymbol = parsed?.underlying;

      let effectiveQuery = underlyingSymbol ? undefined : q;
      let effectiveOptionType: 'CE' | 'PE' | undefined = option_type;
      let effectiveExpiryFrom = parsed?.expiryFrom || expiry_from;
      let effectiveExpiryTo = parsed?.expiryTo || expiry_to;
      let effectiveStrikeMin = strike_min;
      let effectiveStrikeMax = strike_max;

      if (!effectiveOptionType && parsed?.optionType) {
        effectiveOptionType = parsed.optionType;
      }
      if (
        parsed?.strike !== undefined &&
        effectiveStrikeMin === undefined &&
        effectiveStrikeMax === undefined
      ) {
        effectiveStrikeMin = parsed.strike;
        effectiveStrikeMax = parsed.strike;
      }

      // Console log for debugging MCX options parsing and filters
      // eslint-disable-next-line no-console
      console.log('[Vayu MCX Options Search]', {
        q,
        underlying: underlyingSymbol,
        strike: parsed?.strike,
        option_type: effectiveOptionType,
        expiry_from: effectiveExpiryFrom,
        expiry_to: effectiveExpiryTo,
        ltpOnly,
      });

      const parsedLabel =
        parsed && (parsed.underlying || parsed.strike || parsed.optionType || parsed.expiryFrom)
          ? 'yes'
          : 'no';
      this.metrics.foSearchRequestsTotal.inc({
        endpoint: 'vayu_mcx_options',
        ltp_only: String(ltpOnly),
        parsed: parsedLabel,
      });
      const latencyTimer = this.metrics.foSearchLatencySeconds.startTimer({
        endpoint: 'vayu_mcx_options',
        ltp_only: String(ltpOnly),
      });

      const cacheKeyBase = [
        'vayu:fno:mcx_options',
        `under=${underlyingSymbol || 'ANY'}`,
        `of=${effectiveOptionType || 'ANY'}`,
        `ef=${effectiveExpiryFrom || 'ANY'}`,
        `et=${effectiveExpiryTo || 'ANY'}`,
        `sm=${effectiveStrikeMin ?? 'ANY'}`,
        `sx=${effectiveStrikeMax ?? 'ANY'}`,
        `ltp=${ltpOnly ? '1' : '0'}`,
        `lim=${requestedLimit}`,
        `off=${startOffset}`,
      ].join('|');
      const cacheKey = cacheKeyBase;
      const foCacheTtlSec = Number(process.env.FO_CACHE_TTL_SECONDS || 2);

      try {
        const cached = await this.redisService.get<any>(cacheKey);
        if (cached && cached.success === true) {
          // eslint-disable-next-line no-console
          console.log('[Vayu MCX Options Search] Cache HIT', { cacheKey });
          latencyTimer();
          return cached;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu MCX Options Search] Cache READ failed (non-fatal)', (e as any)?.message);
      }

      // Explicitly include relevant instrument types for MCX options if needed, but MCX_FO exchange filter is primary.
      // However, we can be more specific if we know they are mostly OPTFUT.
      const instrumentTypes = undefined; // Keeping undefined to rely on exchange and options_only flag

      if (!ltpOnly) {
        let result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(
          {
            query: effectiveQuery,
            underlying_symbol: underlyingSymbol,
            exchange: ['MCX_FO'],
            // Do not constrain instrument_name: rely on option_type / options_only to distinguish from futures
            instrument_type: instrumentTypes,
            option_type: effectiveOptionType,
            options_only: true,
            expiry_from: effectiveExpiryFrom,
            expiry_to: effectiveExpiryTo,
            strike_min: effectiveStrikeMin,
            strike_max: effectiveStrikeMax,
            limit: requestedLimit,
            offset: startOffset,
            sort_by: 'expiry_date',
            sort_order: 'asc',
            only_active: false,
          },
        );

        if ((!result.instruments || result.instruments.length === 0) && q && q.trim()) {
          // eslint-disable-next-line no-console
          console.log('[Vayu MCX Options Search] No rows for parsed filters, falling back to fuzzy symbol search');
          result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(
            {
              query: q.trim(),
              underlying_symbol: undefined,
              exchange: ['MCX_FO'],
              instrument_type: instrumentTypes,
              option_type: effectiveOptionType,
              options_only: true,
              expiry_from: effectiveExpiryFrom,
              expiry_to: effectiveExpiryTo,
              strike_min: effectiveStrikeMin,
              strike_max: effectiveStrikeMax,
              limit: requestedLimit,
              offset: startOffset,
              sort_by: 'expiry_date',
              sort_order: 'asc',
              only_active: false,
            },
          );
        }
        const pairs = this.vortexInstrumentService.buildPairsFromInstruments(
          result.instruments as any,
        );
        const ltpByPair = pairs.length
          ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any)
          : {};
        const list = result.instruments.map((i) => {
          const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
          const lp = ltpByPair?.[key]?.last_price ?? null;
          const daysToExpiry = this.computeDaysToExpiry(i.expiry_date as any);
          return {
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            description: (i as any)?.description || null,
            expiry_date: i.expiry_date,
            option_type: i.option_type,
            strike_price: i.strike_price,
            days_to_expiry: daysToExpiry,
            last_price: lp,
          };
        });
        const ranked = this.rankFoInstruments(list, 'relevance', parsed?.strike);
        const response = {
          success: true,
          data: {
            instruments: ranked,
            pagination: {
              total: result.total,
              hasMore: result.hasMore,
            },
            ltp_only: false,
            performance: { queryTime: Date.now() - t0 },
          },
        };
        try {
          await this.redisService.set(cacheKey, response, foCacheTtlSec);
          // eslint-disable-next-line no-console
          console.log('[Vayu MCX Options Search] Cache SET', {
            cacheKey,
            ttl: foCacheTtlSec,
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[Vayu MCX Options Search] Cache WRITE failed (non-fatal)', (e as any)?.message);
        }
        latencyTimer();
        return response;
      }

      // Fast-path probe for ltp_only=true with single-shot LTP hydration
      const probeLimit = Math.min(
        500,
        Math.max(requestedLimit * 4, requestedLimit + startOffset),
      );
      let page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(
        {
          query: effectiveQuery,
          underlying_symbol: underlyingSymbol,
          exchange: ['MCX_FO'],
          instrument_type: instrumentTypes,
          option_type: effectiveOptionType,
          options_only: true,
          expiry_from: effectiveExpiryFrom,
          expiry_to: effectiveExpiryTo,
          strike_min: effectiveStrikeMin,
          strike_max: effectiveStrikeMax,
          limit: probeLimit,
          offset: startOffset,
          skip_count: true,
          sort_by: 'expiry_date',
          sort_order: 'asc',
          only_active: true,
        },
      );

      if ((!page.instruments || page.instruments.length === 0) && q && q.trim()) {
        // eslint-disable-next-line no-console
        console.log('[Vayu MCX Options Search] ltp_only probe empty, falling back to fuzzy symbol search');
        page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced(
          {
            query: q.trim(),
            underlying_symbol: undefined,
            exchange: ['MCX_FO'],
            instrument_type: instrumentTypes,
            option_type: effectiveOptionType,
            options_only: true,
            expiry_from: effectiveExpiryFrom,
            expiry_to: effectiveExpiryTo,
            strike_min: effectiveStrikeMin,
            strike_max: effectiveStrikeMax,
            limit: probeLimit,
            offset: startOffset,
            skip_count: true,
            sort_by: 'expiry_date',
            sort_order: 'asc',
            only_active: true,
          },
        );
      }
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(
        page.instruments as any,
      );
      const ltpByPair = pairs.length
        ? await this.vortexInstrumentService.hydrateLtpByPairs(pairs as any)
        : {};
      const enriched = page.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(
          i.token,
        )}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          description: (i as any)?.description || null,
          expiry_date: i.expiry_date as any,
          days_to_expiry: this.computeDaysToExpiry(i.expiry_date as any),
          option_type: i.option_type,
          strike_price: i.strike_price,
          last_price: lp,
        };
      });
      const filtered = enriched.filter(
        (v: any) =>
          Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0),
      );
      const ranked = this.rankFoInstruments(filtered, 'relevance', parsed?.strike);
      const sliced = ranked.slice(0, requestedLimit);

      const response = {
        success: true,
        data: {
          instruments: sliced,
          pagination: {
            total: undefined,
            hasMore: page.hasMore,
          },
          ltp_only: true,
          performance: { queryTime: Date.now() - t0 },
        },
      };
      try {
        await this.redisService.set(cacheKey, response, foCacheTtlSec);
        // eslint-disable-next-line no-console
        console.log('[Vayu MCX Options Search] Cache SET (ltp_only)', {
          cacheKey,
          ttl: foCacheTtlSec,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Vayu MCX Options Search] Cache WRITE failed (ltp_only, non-fatal)', (e as any)?.message);
      }
      latencyTimer();
      return response;
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get MCX options',
          error: (error as any)?.message || error,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private computeDaysToExpiry(expiry?: string | null): number | null {
    if (!expiry || typeof expiry !== 'string' || expiry.length !== 8) {
      return null;
    }
    try {
      const year = Number(expiry.substring(0, 4));
      const month = Number(expiry.substring(4, 6));
      const day = Number(expiry.substring(6, 8));
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return null;
      }
      const expDate = new Date(Date.UTC(year, month - 1, day));
      const now = new Date();
      const diffMs = expDate.getTime() - now.getTime();
      const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      return diffDays;
    } catch {
      return null;
    }
  }

  private rankFoInstruments(
    items: Array<{
      token: number;
      symbol: string;
      days_to_expiry?: number | null;
      strike_price?: number | null;
      [key: string]: any;
    }>,
    sortMode: string,
    targetStrike?: number,
  ) {
    const mode = (sortMode || 'relevance').toLowerCase();
    const copy = [...items];

    const strikeRef = Number.isFinite(targetStrike as any)
      ? (targetStrike as number)
      : undefined;

    const cmpDays = (a: any, b: any) => {
      const da = typeof a.days_to_expiry === 'number' ? a.days_to_expiry : Infinity;
      const db = typeof b.days_to_expiry === 'number' ? b.days_to_expiry : Infinity;
      return da - db;
    };

    const cmpStrike = (a: any, b: any) => {
      const sa = Number(a.strike_price ?? 0);
      const sb = Number(b.strike_price ?? 0);
      return sa - sb;
    };

    const cmpStrikeDistance = (a: any, b: any) => {
      if (!Number.isFinite(strikeRef as any)) return 0;
      const da = Math.abs(Number(a.strike_price ?? 0) - (strikeRef as number));
      const db = Math.abs(Number(b.strike_price ?? 0) - (strikeRef as number));
      return da - db;
    };

    copy.sort((a, b) => {
      if (mode === 'expiry') {
        const d = cmpDays(a, b);
        if (d !== 0) return d;
        return cmpStrike(a, b);
      }
      if (mode === 'strike') {
        const d = cmpStrike(a, b);
        if (d !== 0) return d;
        return cmpDays(a, b);
      }
      // relevance (default): nearest expiry + (when available) closest strike to target
      let d = cmpDays(a, b);
      if (d !== 0) return d;
      d = cmpStrikeDistance(a, b);
      if (d !== 0) return d;
      // stable tie-breakers
      const symCmp = String(a.symbol || '').localeCompare(String(b.symbol || ''));
      if (symCmp !== 0) return symCmp;
      return Number(a.token) - Number(b.token);
    });

    return copy;
  }
}

