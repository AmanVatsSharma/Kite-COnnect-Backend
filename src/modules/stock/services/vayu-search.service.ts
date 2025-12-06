import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { VortexInstrumentService } from '../../../services/vortex-instrument.service';
import { RequestBatchingService } from '../../../services/request-batching.service';
import { VortexProviderService } from '../../../providers/vortex-provider.service';
import { RedisService } from '../../../services/redis.service';
import { MetricsService } from '../../../services/metrics.service';
import { FnoQueryParserService } from '../../../services/fno-query-parser.service';

@Injectable()
export class VayuSearchService {
  constructor(
    private readonly vortexInstrumentService: VortexInstrumentService,
    private readonly requestBatchingService: RequestBatchingService,
    private readonly vortexProvider: VortexProviderService,
    private readonly redisService: RedisService,
    private readonly metrics: MetricsService,
    private readonly fnoQueryParser: FnoQueryParserService,
  ) {}

  async autocompleteFo(
    q: string,
    scope?: 'nse' | 'mcx' | 'all',
    limitRaw?: number,
  ) {
    try {
      const limit = Math.min(Number(limitRaw || 10), 50);
      const trimmed = String(q || '').trim();
      if (!trimmed) {
        return {
          success: true,
          data: { suggestions: [], performance: { queryTime: 0 } },
        };
      }
      const parsed = this.fnoQueryParser.parse(trimmed);
      const baseQuery = parsed.underlying || trimmed.toUpperCase();
      const scopeNorm = (scope || 'all').toLowerCase();
      const t0 = Date.now();

      const timer = this.metrics.foSearchLatencySeconds.startTimer({
        endpoint: 'vayu_fno_autocomplete',
        ltp_only: 'false',
      });
      this.metrics.foSearchRequestsTotal.inc({
        endpoint: 'vayu_fno_autocomplete',
        ltp_only: 'false',
        parsed:
          parsed &&
          (parsed.underlying ||
            parsed.strike ||
            parsed.optionType ||
            parsed.expiryFrom)
            ? 'yes'
            : 'no',
      });

      const cacheKey = [
        'vayu:fno:autocomplete',
        `q=${baseQuery}`,
        `scope=${scopeNorm}`,
        `lim=${limit}`,
      ].join('|');
      const cacheTtl = Number(process.env.FO_CACHE_TTL_SECONDS || 2);

      try {
        const cached = await this.redisService.get<any>(cacheKey);
        if (cached && cached.success === true) {
          // eslint-disable-next-line no-console
          console.log('[Vayu F&O Autocomplete] Cache HIT', { cacheKey });
          timer();
          return cached;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          '[Vayu F&O Autocomplete] Cache READ failed (non-fatal)',
          (e as any)?.message,
        );
      }

      const { suggestions, queryTime } =
        await this.vortexInstrumentService.getVortexAutocompleteCached(
          baseQuery,
          limit * 4,
        );

      const foTypes = new Set([
        'FUTSTK',
        'FUTIDX',
        'FUTCUR',
        'FUTCOM',
        'OPTSTK',
        'OPTIDX',
        'OPTCUR',
        'OPTFUT', // Added OPTFUT for consistency with other services
      ]);

      const scoped = (suggestions || []).filter((s: any) => {
        if (!foTypes.has(String(s.instrument_name || '').toUpperCase()))
          return false;
        const ex = String(s.exchange || '').toUpperCase();
        if (scopeNorm === 'nse') return ex.startsWith('NSE');
        if (scopeNorm === 'mcx') return ex === 'MCX_FO';
        return true;
      });

      // Deduplicate by symbol, keep first occurrence
      const seen = new Set<string>();
      const deduped: Array<{
        token: number;
        symbol: string;
        exchange: string;
        instrument_name: string;
        description?: string | null;
      }> = [];
      for (const s of scoped) {
        const sym = String(s.symbol || '').toUpperCase();
        if (!sym || seen.has(sym)) continue;
        seen.add(sym);
        deduped.push({
          token: s.token,
          symbol: sym,
          exchange: s.exchange,
          instrument_name: s.instrument_name,
          description: s.description,
        });
        if (deduped.length >= limit) break;
      }

      const response = {
        success: true,
        data: {
          suggestions: deduped,
          performance: { queryTime: queryTime ?? Date.now() - t0 },
        },
      };
      try {
        await this.redisService.set(cacheKey, response, cacheTtl);
        // eslint-disable-next-line no-console
        console.log('[Vayu F&O Autocomplete] Cache SET', {
          cacheKey,
          ttl: cacheTtl,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          '[Vayu F&O Autocomplete] Cache WRITE failed (non-fatal)',
          (e as any)?.message,
        );
      }
      timer();
      return response;
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to autocomplete F&O underlyings',
          error: (error as any)?.message || 'unknown',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async searchVortexInstruments(
    q: string,
    exchange?: string,
    instrumentType?: string,
    symbol?: string,
    limitRaw?: number,
    offsetRaw?: number,
    ltpOnlyRaw?: string | boolean,
    includeLtpRaw?: string | boolean,
  ) {
    try {
      const limit = limitRaw ? parseInt(limitRaw.toString()) : 50;
      const offset = offsetRaw ? parseInt(offsetRaw.toString()) : 0;
      const ltpOnly =
        String(ltpOnlyRaw || '').toLowerCase() === 'true' ||
        ltpOnlyRaw === true;
      const includeLtp =
        String(includeLtpRaw || 'true').toLowerCase() === 'true' ||
        includeLtpRaw === true;

      let types = instrumentType ? instrumentType.split(',') : undefined;
      if (types) {
        const mapping: Record<string, string[]> = {
          EQUITIES: ['EQUITIES', 'EQ', 'EQIDX'],
          FUTURES: ['FUTSTK', 'FUTIDX', 'FUTCUR', 'FUTCOM'],
          OPTIONS: ['OPTSTK', 'OPTIDX', 'OPTCUR', 'OPTFUT'],
          COMMODITIES: ['FUTCOM', 'OPTFUT'],
          CURRENCY: ['FUTCUR', 'OPTCUR'],
        };
        const mapped: string[] = [];
        for (const t of types) {
          const upper = t.toUpperCase().trim();
          if (mapping[upper]) {
            mapped.push(...mapping[upper]);
          } else {
            mapped.push(upper); // Keep as-is if not a category
          }
        }
        types = [...new Set(mapped)]; // Deduplicate
      }

      const result =
        await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: exchange ? exchange.split(',') : undefined,
          instrument_type: types,
          symbol: symbol,
          limit,
          offset,
          only_active: false,
        });

      const items = result.instruments || [];
      // Build authoritative pairs from DB result
      const pairs = items.map((i) => ({
        exchange: String(i.exchange || '').toUpperCase(),
        token: String(i.token),
      }));

      let pairLtp: Record<string, { last_price: number | null }> = {};
      if ((includeLtp || ltpOnly) && pairs.length) {
        pairLtp = await this.requestBatchingService.getLtpByPairs(
          pairs as any,
          this.vortexProvider,
        );
      }

      const list = items.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = pairLtp?.[key]?.last_price ?? null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          instrument_name: i.instrument_name,
          expiry_date: i.expiry_date,
          option_type: i.option_type,
          strike_price: i.strike_price,
          tick: i.tick,
          lot_size: i.lot_size,
          description: i.description,
          last_price: lp,
        };
      });

      const filtered = ltpOnly
        ? list.filter(
            (v) =>
              Number.isFinite((v as any)?.last_price) &&
              ((v as any)?.last_price ?? 0) > 0,
          )
        : list;

      return {
        success: true,
        data: filtered,
        pagination: {
          total: result.total,
          hasMore: result.hasMore,
          limit,
          offset,
        },
        include_ltp: includeLtp,
        ltp_only: ltpOnly,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to search Vayu instruments',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async searchVortexTickers(
    q: string,
    ltpOnlyRaw?: string | boolean,
    includeLtpRaw?: string | boolean,
  ) {
    try {
      if (!q) {
        throw new HttpException(
          { success: false, message: 'q is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const { instrument, candidates } =
        await this.vortexInstrumentService.resolveVortexSymbol(q);
      const items = instrument ? [instrument] : candidates;
      const includeLtp =
        String(includeLtpRaw || 'true').toLowerCase() === 'true' ||
        includeLtpRaw === true;
      // Build authoritative pairs from DB result; avoid NSE_EQ implicit fallback
      const pairs =
        items?.map((i) => ({
          exchange: String(i.exchange || '').toUpperCase(),
          token: String(i.token),
        })) || [];
      let pairLtp: Record<string, { last_price: number | null }> = {};
      if (includeLtp && pairs.length) {
        pairLtp = await this.requestBatchingService.getLtpByPairs(
          pairs as any,
          this.vortexProvider,
        );
      }

      const ltpOnly =
        String(ltpOnlyRaw || '').toLowerCase() === 'true' ||
        ltpOnlyRaw === true;
      const list = items.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = includeLtp ? pairLtp?.[key]?.last_price ?? null : null;
        return {
          token: i.token,
          symbol: i.symbol,
          exchange: i.exchange,
          instrument_name: i.instrument_name,
          expiry_date: i.expiry_date,
          option_type: i.option_type,
          strike_price: i.strike_price,
          tick: i.tick,
          lot_size: i.lot_size,
          description: i.description,
          last_price: lp,
        };
      });
      const filtered = ltpOnly
        ? list.filter(
            (v) =>
              Number.isFinite((v as any)?.last_price) &&
              ((v as any)?.last_price ?? 0) > 0,
          )
        : list;

      return {
        success: true,
        data: filtered,
        include_ltp: includeLtp,
        ltp_only: ltpOnly || false,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to search Vayu tickers',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getVortexTickerBySymbol(
    symbol: string,
    ltpOnlyRaw?: string | boolean,
  ) {
    try {
      const { instrument } =
        await this.vortexInstrumentService.resolveVortexSymbol(symbol);
      if (!instrument) {
        throw new HttpException(
          { success: false, message: 'Vayu symbol not found' },
          HttpStatus.NOT_FOUND,
        );
      }

      try {
        const ltp = await this.vortexInstrumentService.getVortexLTP([
          instrument.token,
        ]);
        const ltpOnly =
          String(ltpOnlyRaw || '').toLowerCase() === 'true' ||
          ltpOnlyRaw === true;
        const lastPrice = ltp?.[instrument.token]?.last_price ?? null;

        if (
          ltpOnly &&
          !(Number.isFinite(lastPrice) && (lastPrice as any) > 0)
        ) {
          throw new HttpException(
            {
              success: false,
              message: 'LTP not available for requested symbol (ltp_only=true)',
            },
            HttpStatus.NOT_FOUND,
          );
        }

        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log('[Get Vayu Ticker] Returning data for symbol:', {
          symbol,
          token: instrument.token,
          hasDescription: !!instrument.description,
          hasLtp: !!lastPrice,
        });

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
            tick: instrument.tick,
            lot_size: instrument.lot_size,
            description: instrument.description,
            last_price: lastPrice,
          },
          ltp_only: ltpOnly || false,
        };
      } catch (ltpError) {
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.warn(
          `[Get Vayu Ticker] Failed to get LTP for ${symbol}:`,
          ltpError,
        );
        if (ltpError instanceof HttpException) throw ltpError;
        throw new HttpException(
          {
            success: false,
            message: 'Failed to fetch live price',
            error: (ltpError as any)?.message || 'Unknown LTP error',
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get ticker details',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

