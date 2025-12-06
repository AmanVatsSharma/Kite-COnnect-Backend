import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { VortexProviderService } from '../../../providers/vortex-provider.service';
import { VortexInstrumentService } from '../../../services/vortex-instrument.service';
import { RequestBatchingService } from '../../../services/request-batching.service';
import { LtpRequestDto } from '../dto/ltp.dto';

@Injectable()
export class VayuMarketDataService {
  constructor(
    private readonly vortexProvider: VortexProviderService,
    private readonly vortexInstrumentService: VortexInstrumentService,
    private readonly requestBatchingService: RequestBatchingService,
  ) {}

  async getVortexHealth() {
    try {
      const status = await this.vortexProvider.checkHealth();
      return {
        success: true,
        data: status,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Vayu health check failed',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getVortexLtp(body: LtpRequestDto, q?: string) {
    try {
      // Handle query param q=EXCHANGE-TOKEN format (like Kite)
      if (q) {
        const pairs = q.split(',').map((item) => {
          const [exchange, token] = item.split(/[:\-\s]/);
          return { exchange, token };
        });

        if (pairs.length === 0) {
          throw new HttpException(
            { success: false, message: 'Invalid q parameter' },
            HttpStatus.BAD_REQUEST,
          );
        }

        // Fetch via provider (will handle batching if needed)
        const ltpData = await this.vortexProvider.getLTPByPairs(pairs as any);

        // Enrich with instrument metadata for q= search (common usage pattern)
        const tokens = pairs.map((p) => p.token);
        // Note: getVortexInstrumentDetails returns map by TOKEN (number)
        // We need to match it back to input pairs
        let metaMap: Record<string, any> = {};
        try {
          // We need numeric tokens for detail lookup
          const numericTokens = tokens
            .map((t) => parseInt(t))
            .filter((n) => !isNaN(n));
          if (numericTokens.length > 0) {
            metaMap =
              await this.vortexInstrumentService.getVortexInstrumentDetails(
                numericTokens,
              );
          }
        } catch (e) {
          // Metadata fetch non-fatal
        }

        // Transform response to flat map keyed by EXCHANGE:TOKEN
        const flat: Record<string, any> = {};
        for (const p of pairs) {
          const key = `${p.exchange}:${p.token}`; // Kite format
          const internalKey = `${p.exchange}-${p.token}`; // Provider format
          const data = ltpData[internalKey] || { last_price: null };
          const tokenNum = parseInt(p.token);
          const meta = !isNaN(tokenNum) ? metaMap[tokenNum] : null;

          flat[key] = {
            instrument_token: Number(p.token),
            last_price: data.last_price,
            // Add metadata if available
            ...(meta
              ? {
                  description: meta.description,
                  symbol: meta.symbol,
                  exchange: meta.exchange,
                  instrument_name: meta.instrument_name,
                  expiry_date: meta.expiry_date,
                  option_type: meta.option_type,
                  strike_price: meta.strike_price,
                  tick: meta.tick,
                  lot_size: meta.lot_size,
                }
              : {}),
          };
        }

        return {
          success: true,
          data: flat,
        };
      }

      // Handle body instruments array (Vayu specific format)
      if (
        !body.instruments ||
        !Array.isArray(body.instruments) ||
        body.instruments.length === 0
      ) {
        throw new HttpException(
          {
            success: false,
            message: 'Instruments array or q parameter is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const tokens = body.instruments;
      const ltp = await this.vortexInstrumentService.getVortexLTP(tokens);

      return {
        success: true,
        data: ltp,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        {
          success: false,
          message: 'Failed to get LTP',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async debugResolve(tokens: string) {
    if (!tokens) return { error: 'tokens param required (comma separated)' };
    const tokenList = tokens.split(',').map((t) => t.trim());
    const resolved = [];
    for (const t of tokenList) {
      // 1. Check vortex_instruments
      const inst =
        await this.vortexInstrumentService.getVortexInstrumentByToken(
          Number(t),
        );
      if (inst) {
        resolved.push({
          token: t,
          exchange: inst.exchange,
          source: 'vortex_instruments',
        });
        continue;
      }
      // 2. Check mappings
      // (Accessing repo via service workaround or add method to service)
      // For debug, we can just return what we found
      resolved.push({ token: t, exchange: null, source: 'not_found' });
    }
    return { success: true, data: resolved };
  }

  async debugBuildQ(tokens: string, mode: string = 'ltp') {
    if (!tokens) return { error: 'tokens param required' };
    const tokenList = tokens
      .split(',')
      .map((t) => Number(t))
      .filter((n) => !isNaN(n));
    const result =
      await this.vortexInstrumentService.getVortexInstrumentsBatch(tokenList);
    const pairs = this.vortexInstrumentService.buildPairsFromInstruments(
      Object.values(result.instruments),
    );
    const qParams = pairs
      .map((p) => `q=${p.exchange}-${p.token}`)
      .join('&');
    return {
      success: true,
      pairs: pairs.map((p) => `${p.exchange}-${p.token}`),
      url: `/data/quotes?${qParams}&mode=${mode}`,
      stats: {
        requested: tokenList.length,
        included: pairs.length,
        unresolved: tokenList.length - pairs.length,
      },
    };
  }

  async debugBatchStats() {
    return this.requestBatchingService.getStats();
  }
}

