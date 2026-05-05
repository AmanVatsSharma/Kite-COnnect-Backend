/**
 * @file vortex-instrument-ltp.service.ts
 * @module stock
 * @description Batched Vortex LTP resolution via instrument rows and mapping fallback.
 * @author BharatERP
 * @created 2026-03-28
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';
import { RequestBatchingService } from '@features/market-data/application/request-batching.service';

@Injectable()
export class VortexInstrumentLtpService {
  private readonly logger = new Logger(VortexInstrumentLtpService.name);

  constructor(
    @InjectRepository(VortexInstrument)
    private readonly vortexInstrumentRepo: Repository<VortexInstrument>,
    @InjectRepository(InstrumentMapping)
    private readonly mappingRepo: Repository<InstrumentMapping>,
    private readonly requestBatchingService: RequestBatchingService,
    private readonly vortexProvider: VortexProviderService,
  ) {}

  /**
   * Live prices for Vortex instruments (pair-key batching).
   */
  async getVortexLTP(
    tokens: number[],
  ): Promise<Record<number, { last_price: number }>> {
    try {
      if (!tokens || tokens.length === 0) {
        return {};
      }

      const rows = await this.vortexInstrumentRepo.find({
        where: { token: In(tokens) },
        select: ['token', 'exchange'],
      });
      const allowed = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);
      const pairKeyToToken = new Map<string, number>();
      const pairs: Array<{
        exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
        token: string;
      }> = [];
      const found = new Set<number>();
      for (const r of rows) {
        const ex = String(r.exchange || '').toUpperCase();
        const tok = String(r.token);
        if (allowed.has(ex) && /^\d+$/.test(tok)) {
          pairs.push({ exchange: ex as 'NSE_EQ', token: tok });
          pairKeyToToken.set(`${ex}-${tok}`, r.token);
          found.add(r.token);
        }
      }

      const missing = tokens.filter((t) => !found.has(t));
      if (missing.length) {
        try {
          const maps = await this.mappingRepo.find({
            where: { provider: 'vortex', instrument_token: In(missing) } as any,
            select: ['provider_token', 'instrument_token'] as any,
          });
          for (const m of maps) {
            const key = String(m.provider_token || '').toUpperCase();
            const [ex, tok] = key.split('-');
            if (allowed.has(ex) && /^\d+$/.test(tok)) {
              pairs.push({ exchange: ex as 'NSE_EQ', token: tok });
              pairKeyToToken.set(`${ex}-${tok}`, m.instrument_token);
              found.add(m.instrument_token);
            }
          }
        } catch (e) {
          this.logger.warn(
            '[VortexInstrumentLtpService] Mapping fallback failed; some tokens omitted',
            e,
          );
        }
      }

      const ltpByPairKey = await this.requestBatchingService.getLtpByPairs(
        pairs,
        this.vortexProvider,
      );

      const result: Record<number, { last_price: number }> = {};
      for (const [exToken, priceData] of Object.entries(ltpByPairKey || {})) {
        const tokenNum = pairKeyToToken.get(exToken);
        const lp = priceData?.last_price;
        if (
          tokenNum !== undefined &&
          Number.isFinite(lp) &&
          (lp as number) > 0
        ) {
          result[tokenNum] = { last_price: lp as number };
        }
      }

      for (const t of tokens) {
        if (!(t in result)) result[t] = { last_price: null as any };
      }

      return result;
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentLtpService] Error getting Vortex LTP',
        error,
      );
      return {};
    }
  }
}
