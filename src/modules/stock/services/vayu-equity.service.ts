import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { VortexInstrumentService } from '../../services/vortex-instrument.service';
import { RequestBatchingService } from '../request-batching.service';
import { VortexProviderService } from '../../providers/vortex-provider.service';

@Injectable()
export class VayuEquityService {
  constructor(
    private readonly vortexInstrumentService: VortexInstrumentService,
    private readonly requestBatchingService: RequestBatchingService,
    private readonly vortexProvider: VortexProviderService,
  ) {}

  async getVortexEquities(
    q?: string,
    exchange?: string,
    limit?: number,
    offset?: number,
    ltpOnlyRaw?: string | boolean,
  ) {
    try {
      const t0 = Date.now();
      const requestedLimit = limit ? parseInt(limit.toString()) : 50;
      const startOffset = offset ? parseInt(offset.toString()) : 0;
      const ltpOnly = (String(ltpOnlyRaw || '').toLowerCase() === 'true') || (ltpOnlyRaw === true);

      // Updated instrument types to include EQIDX
      const instrumentTypes = ['EQUITIES', 'EQIDX'];

      if (!ltpOnly) {
        const result = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
          query: q,
          exchange: exchange ? [exchange] : undefined,
          instrument_type: instrumentTypes,
          limit: requestedLimit,
          offset: startOffset,
        });
        const pairs = this.vortexInstrumentService.buildPairsFromInstruments(result.instruments as any);
        const ltpByPair = pairs.length
          ? await this.requestBatchingService.getLtpByPairs(pairs as any, this.vortexProvider)
          : {};
        const list = result.instruments.map((i) => {
          const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
          const lp = ltpByPair?.[key]?.last_price ?? null;
          return {
            token: i.token,
            symbol: i.symbol,
            exchange: i.exchange,
            description: (i as any)?.description || null,
            last_price: lp,
          };
        });
        return {
          success: true,
          data: {
            instruments: list,
            pagination: {
              total: result.total,
              hasMore: result.hasMore,
            },
            ltp_only: false,
            performance: { queryTime: Date.now() - t0 },
          },
        };
      }

      // Fast single-shot probe for ltp_only=true
      const probeLimit = Math.min(500, Math.max(requestedLimit * 4, requestedLimit + startOffset));
      const page = await this.vortexInstrumentService.searchVortexInstrumentsAdvanced({
        query: q,
        exchange: exchange ? [exchange] : undefined,
        instrument_type: instrumentTypes,
        limit: probeLimit,
        offset: startOffset,
        skip_count: true,
      });
      const pairs = this.vortexInstrumentService.buildPairsFromInstruments(page.instruments as any);
      const ltpByPair = pairs.length
        ? await this.requestBatchingService.getLtpByPairs(pairs as any, this.vortexProvider)
        : {};
      const enriched = page.instruments.map((i) => {
        const key = `${String(i.exchange || '').toUpperCase()}-${String(i.token)}`;
        const lp = ltpByPair?.[key]?.last_price ?? null;
        return { token: i.token, symbol: i.symbol, exchange: i.exchange, description: (i as any)?.description || null, last_price: lp };
      });
      const filtered = enriched.filter((v: any) => Number.isFinite(v?.last_price) && ((v?.last_price ?? 0) > 0));
      const sliced = filtered.slice(0, requestedLimit);

      return {
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
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get equities',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

