import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { VortexInstrumentService } from '../../../services/vortex-instrument.service';
import { RequestBatchingService } from '../../../services/request-batching.service';
import { VortexProviderService } from '../../../providers/vortex-provider.service';
import { RedisService } from '../../../services/redis.service';
import { MetricsService } from '../../../services/metrics.service';
import { FnoQueryParserService } from '../../../services/fno-query-parser.service';

@Injectable()
export class VayuFutureService {
  constructor(
    private readonly vortexInstrumentService: VortexInstrumentService,
    private readonly requestBatchingService: RequestBatchingService,
    private readonly vortexProvider: VortexProviderService,
    private readonly redisService: RedisService,
    private readonly metrics: MetricsService,
    private readonly fnoQueryParser: FnoQueryParserService,
  ) {}

  async getVortexFutures(
    q?: string,
    exchange?: string,
    expiry_from?: string,
    expiry_to?: string,
    limit?: number,
    offset?: number,
    ltpOnlyRaw?: string | boolean,
    sort?: 'relevance' | 'expiry' | 'strike',
  ) {
    try {
      const t0 = Date.now();
      const requestedLimit = limit ? parseInt(limit.toString()) : 50;
      const startOffset = offset ? parseInt(offset.toString()) : 0;
      const ltpOnly =
        String(ltpOnlyRaw || '').toLowerCase() === 'true' ||
        ltpOnlyRaw === true;
      const sortMode = (sort || 'relevance').toString().toLowerCase();

      // Parse trading-style F&O queries like "nifty 28mar 26000" or "banknifty 25jan".
      // The parser only provides hints; explicit query params always win.
      const parsed = q && q.trim() ? this.fnoQueryParser.parse(q) : undefined;
      const underlyingSymbol = parsed?.underlying;
      const effectiveQuery = underlyingSymbol ? undefined : q;
      const effectiveExpiryFrom = parsed?.expiryFrom || expiry_from;
      const effectiveExpiryTo = parsed?.expiryTo || expiry_to;

      // Console log for easy debugging and later tuning of parsing behaviour
      // eslint-disable-next-line no-console
      console.log('[Vayu Futures Search]', {
        q,
        underlying: underlyingSymbol,
        expiry_from: effectiveExpiryFrom,
        expiry_to: effectiveExpiryTo,
        exchange,
        ltp_only: ltpOnly,
      });

      const parsedLabel =
        parsed &&
        (parsed.underlying ||
          parsed.strike ||
          parsed.optionType ||
          parsed.expiryFrom)
          ? 'yes'
          : 'no';
      this.metrics.foSearchRequestsTotal.inc({
        endpoint: 'vayu_futures',
        ltp_only: String(ltpOnly),
        parsed: parsedLabel,
      });
      const latencyTimer = this.metrics.foSearchLatencySeconds.startTimer({
        endpoint: 'vayu_futures',
        ltp_only: String(ltpOnly),
      });

      const cacheKeyBase = [
        'vayu:fno:futures',
        `under=${underlyingSymbol || 'ANY'}`,
        `ex=${exchange || 'ANY'}`,
        `ef=${effectiveExpiryFrom || 'ANY'}`,
        `et=${effectiveExpiryTo || 'ANY'}`,
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
          console.log('[Vayu Futures Search] Cache HIT', { cacheKey });
          latencyTimer();
          return cached;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          '[Vayu Futures Search] Cache READ failed (non-fatal)',
          (e as any)?.message,
        );
      }

      if (!ltpOnly) {
        // First attempt: use parsed underlying_symbol + filters
        let result =
          await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
            // Use exact underlying_symbol when parsed to keep DB filters index-friendly
            query: effectiveQuery,
            underlying_symbol: underlyingSymbol,
            exchange: exchange ? [exchange] : undefined,
            instrument_type: ['FUTSTK', 'FUTIDX', 'FUTCOM', 'FUTCUR'], // Added FUTCOM, FUTCUR
            expiry_from: effectiveExpiryFrom,
            expiry_to: effectiveExpiryTo,
            limit: requestedLimit,
            offset: startOffset,
            sort_by: 'expiry_date',
            sort_order: 'asc',
            only_active: false,
          });

        // Graceful fallback: if no instruments found and we had a query,
        // retry with a looser fuzzy symbol search (query=q) and no underlying_symbol.
        if (
          (!result.instruments || result.instruments.length === 0) &&
          q &&
          q.trim()
        ) {
          // eslint-disable-next-line no-console
          console.log(
            '[Vayu Futures Search] No rows for parsed filters, falling back to fuzzy symbol search',
          );
          result =
            await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
              query: q.trim(),
              underlying_symbol: undefined,
              exchange: exchange ? [exchange] : undefined,
              instrument_type: ['FUTSTK', 'FUTIDX', 'FUTCOM', 'FUTCUR'], // Added FUTCOM, FUTCUR
              expiry_from: effectiveExpiryFrom,
              expiry_to: effectiveExpiryTo,
              limit: requestedLimit,
              offset: startOffset,
              sort_by: 'expiry_date',
              sort_order: 'asc',
              only_active: false,
            });
        }
        const pairs = this.vortexInstrumentService.buildPairsFromInstruments(
          result.instruments as any,
        );
        const ltpByPair = pairs.length
          ? await this.requestBatchingService.getLtpByPairs(
              pairs as any,
              this.vortexProvider,
            )
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
            instrument_name: i.instrument_name,
            tick: (i as any)?.tick,
            lot_size: (i as any)?.lot_size,
            days_to_expiry: daysToExpiry,
            last_price: lp,
          };
        });
        const ranked = this.rankFoInstruments(list, sortMode, undefined);
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
          console.log('[Vayu Futures Search] Cache SET', {
            cacheKey,
            ttl: foCacheTtlSec,
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            '[Vayu Futures Search] Cache WRITE failed (non-fatal)',
            (e as any)?.message,
          );
        }
        latencyTimer();
        return response;
      }

      // Fast single-shot probe for ltp_only=true
      const probeLimit = Math.min(
        500,
        Math.max(requestedLimit * 4, requestedLimit + startOffset),
      );
      // First attempt: parsed filters + only_active=true for tradable subset
      let page =
        await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: effectiveQuery,
          underlying_symbol: underlyingSymbol,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: ['FUTSTK', 'FUTIDX', 'FUTCOM', 'FUTCUR'], // Added FUTCOM, FUTCUR
          expiry_from: effectiveExpiryFrom,
          expiry_to: effectiveExpiryTo,
          limit: probeLimit,
          offset: startOffset,
          skip_count: true,
          sort_by: 'expiry_date',
          sort_order: 'asc',
          only_active: true,
        });

      if (
        (!page.instruments || page.instruments.length === 0) &&
        q &&
        q.trim()
      ) {
        // eslint-disable-next-line no-console
        console.log(
          '[Vayu Futures Search] ltp_only probe empty, falling back to fuzzy symbol search',
        );
        page =
          await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
            query: q.trim(),
            underlying_symbol: undefined,
            exchange: exchange ? [exchange] : undefined,
            instrument_type: ['FUTSTK', 'FUTIDX', 'FUTCOM', 'FUTCUR'], // Added FUTCOM, FUTCUR
            expiry_from: effectiveExpiryFrom,
            expiry_to: effectiveExpiryTo,
            limit: probeLimit,
            offset: startOffset,
            skip_count: true,
            sort_by: 'expiry_date',
            sort_order: 'asc',
            only_active: true,
          });
      }
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(
        page.instruments as any,
      );
      const ltpByPair = pairs.length
        ? await this.requestBatchingService.getLtpByPairs(
            pairs as any,
            this.vortexProvider,
          )
        : {};
      const enriched = page.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          description: (i as any)?.description || null,
          expiry_date: i.expiry_date as any,
          instrument_name: i.instrument_name,
          tick: (i as any)?.tick,
          lot_size: (i as any)?.lot_size,
          days_to_expiry: this.computeDaysToExpiry(i.expiry_date as any),
          last_price: lp,
        };
      });
      const filtered = enriched.filter(
        (v: any) =>
          Number.isFinite(v?.last_price) && (v?.last_price ?? 0) > 0,
      );
      const ranked = this.rankFoInstruments(filtered, sortMode, undefined);
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
        console.log('[Vayu Futures Search] Cache SET (ltp_only)', {
          cacheKey,
          ttl: foCacheTtlSec,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          '[Vayu Futures Search] Cache WRITE failed (ltp_only, non-fatal)',
          (e as any)?.message,
        );
      }
      latencyTimer();
      return response;
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get futures',
          error: error.message,
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
      if (
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        !Number.isFinite(day)
      ) {
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
      const da =
        typeof a.days_to_expiry === 'number' ? a.days_to_expiry : Infinity;
      const db =
        typeof b.days_to_expiry === 'number' ? b.days_to_expiry : Infinity;
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
      const symCmp = String(a.symbol || '').localeCompare(
        String(b.symbol || ''),
      );
      if (symCmp !== 0) return symCmp;
      return Number(a.token) - Number(b.token);
    });

    return copy;
  }
}
