/**
 * @file vortex-instrument-read.service.ts
 * @module stock
 * @description Vortex instrument reads: stats, options chain, batch lookups, pair hydration.
 * @author BharatERP
 * @created 2026-03-28
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';
import { RequestBatchingService } from '@features/market-data/application/request-batching.service';
import { VortexInstrumentLtpService } from '@features/stock/application/vortex-instrument-ltp.service';

@Injectable()
export class VortexInstrumentReadService {
  private readonly logger = new Logger(VortexInstrumentReadService.name);

  constructor(
    @InjectRepository(VortexInstrument)
    private readonly vortexInstrumentRepo: Repository<VortexInstrument>,
    private readonly vortexProvider: VortexProviderService,
    private readonly requestBatchingService: RequestBatchingService,
    private readonly ltpService: VortexInstrumentLtpService,
  ) {}

  async getVortexInstrumentByToken(token: number): Promise<VortexInstrument | null> {
    try {
      return await this.vortexInstrumentRepo.findOne({ where: { token } });
    } catch (error) {
      this.logger.error(
        `[VortexInstrumentReadService] Error getting Vortex instrument by token ${token}`,
        error,
      );
      throw error;
    }
  }

  async getVortexInstrumentStats(): Promise<{
    total: number;
    byExchange: Record<string, number>;
    byInstrumentType: Record<string, number>;
    lastSync: Date | null;
  }> {
    try {
      const total = await this.vortexInstrumentRepo.count();

      const exchangeStats = await this.vortexInstrumentRepo
        .createQueryBuilder('instrument')
        .select('instrument.exchange', 'exchange')
        .addSelect('COUNT(*)', 'count')
        .groupBy('instrument.exchange')
        .getRawMany();

      const byExchange = exchangeStats.reduce((acc, stat) => {
        acc[stat.exchange] = parseInt(stat.count, 10);
        return acc;
      }, {} as Record<string, number>);

      const typeStats = await this.vortexInstrumentRepo
        .createQueryBuilder('instrument')
        .select('instrument.instrument_name', 'instrument_name')
        .addSelect('COUNT(*)', 'count')
        .groupBy('instrument.instrument_name')
        .getRawMany();

      const byInstrumentType = typeStats.reduce((acc, stat) => {
        acc[stat.instrument_name] = parseInt(stat.count, 10);
        return acc;
      }, {} as Record<string, number>);

      const lastSync = await this.vortexInstrumentRepo
        .createQueryBuilder('instrument')
        .select('MAX(instrument.updated_at)', 'lastSync')
        .getRawOne();

      return {
        total,
        byExchange,
        byInstrumentType,
        lastSync: lastSync?.lastSync || null,
      };
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentReadService] Error getting Vortex instrument stats',
        error,
      );
      throw error;
    }
  }

  buildPairsFromInstruments(
    instruments: VortexInstrument[],
  ): Array<{ exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'; token: string }> {
    try {
      const allowed = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);
      const pairs: Array<{ exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'; token: string }> =
        [];
      for (const i of instruments || []) {
        const ex = String(i?.exchange || '').toUpperCase();
        const tok = String(i?.token ?? '').trim();
        if (allowed.has(ex) && /^\d+$/.test(tok)) {
          pairs.push({ exchange: ex as 'NSE_EQ', token: tok });
        }
      }
      return pairs;
    } catch (e) {
      this.logger.warn('[VortexInstrumentReadService] buildPairsFromInstruments failed', e as Error);
      return [];
    }
  }

  async hydrateLtpByPairs(
    pairs: Array<{ exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'; token: string | number }>,
  ): Promise<Record<string, { last_price: number | null }>> {
    try {
      if (!pairs || pairs.length === 0) return {};
      return await this.requestBatchingService.getLtpByPairs(pairs as any, this.vortexProvider);
    } catch (e) {
      this.logger.warn('[VortexInstrumentReadService] hydrateLtpByPairs failed', e as Error);
      return {};
    }
  }

  async getVortexOptionsChain(symbol: string): Promise<{
    symbol: string;
    expiries: string[];
    strikes: number[];
    options: Record<
      string,
      Record<number, { CE?: VortexInstrument; PE?: VortexInstrument }>
    >;
    queryTime: number;
  }> {
    const startTime = Date.now();

    try {
      const options = await this.vortexInstrumentRepo
        .createQueryBuilder('v')
        .where('v.symbol = :symbol', { symbol: symbol.toUpperCase() })
        .andWhere('v.option_type IS NOT NULL')
        .andWhere('v.is_active = :active', { active: true })
        .orderBy('v.expiry_date', 'ASC')
        .addOrderBy('v.strike_price', 'ASC')
        .getMany();

      const expiries = [
        ...new Set(options.map((o) => o.expiry_date).filter(Boolean) as string[]),
      ].sort();
      const strikes = [
        ...new Set(options.map((o) => o.strike_price).filter((p) => p && p > 0) as number[]),
      ].sort((a, b) => a - b);

      const optionsChain: Record<
        string,
        Record<number, { CE?: VortexInstrument; PE?: VortexInstrument }>
      > = {};

      for (const option of options) {
        if (!option.expiry_date || !option.strike_price) continue;

        if (!optionsChain[option.expiry_date]) {
          optionsChain[option.expiry_date] = {};
        }

        if (!optionsChain[option.expiry_date][option.strike_price]) {
          optionsChain[option.expiry_date][option.strike_price] = {};
        }

        if (option.option_type === 'CE') {
          optionsChain[option.expiry_date][option.strike_price].CE = option;
        } else if (option.option_type === 'PE') {
          optionsChain[option.expiry_date][option.strike_price].PE = option;
        }
      }

      const queryTime = Date.now() - startTime;

      return {
        symbol: symbol.toUpperCase(),
        expiries,
        strikes,
        options: optionsChain,
        queryTime,
      };
    } catch (error) {
      this.logger.error('[VortexInstrumentReadService] Error getting options chain', error);
      throw error;
    }
  }

  async getVortexInstrumentsBatch(tokens: number[]): Promise<{
    instruments: Record<number, VortexInstrument>;
    ltp: Record<number, { last_price: number }>;
    queryTime: number;
  }> {
    const startTime = Date.now();

    try {
      if (!tokens || tokens.length === 0) {
        return { instruments: {}, ltp: {}, queryTime: Date.now() - startTime };
      }

      const batchSize = 1000;
      const allInstruments: VortexInstrument[] = [];

      for (let i = 0; i < tokens.length; i += batchSize) {
        const batch = tokens.slice(i, i + batchSize);
        const instruments = await this.vortexInstrumentRepo
          .createQueryBuilder('v')
          .where('v.token IN (:...tokens)', { tokens: batch })
          .andWhere('v.is_active = :active', { active: true })
          .select([
            'v.token',
            'v.exchange',
            'v.symbol',
            'v.instrument_name',
            'v.expiry_date',
            'v.option_type',
            'v.strike_price',
            'v.tick',
            'v.lot_size',
            'v.description',
            'v.is_active',
          ])
          .getMany();
        allInstruments.push(...instruments);
      }

      const ltpTokens = tokens.slice(0, 100);
      const ltp = await this.ltpService.getVortexLTP(ltpTokens);

      const instrumentsMap: Record<number, VortexInstrument> = {};
      for (const instrument of allInstruments) {
        instrumentsMap[instrument.token] = instrument;
      }

      const queryTime = Date.now() - startTime;

      return {
        instruments: instrumentsMap,
        ltp,
        queryTime,
      };
    } catch (error) {
      this.logger.error('[VortexInstrumentReadService] Error in batch lookup', error);
      throw error;
    }
  }

  async getVortexInstrumentDetails(tokens: number[]): Promise<Record<number, VortexInstrument>> {
    const result: Record<number, VortexInstrument> = {};
    try {
      if (!Array.isArray(tokens) || tokens.length === 0) return result;

      const batchSize = 1000;
      for (let i = 0; i < tokens.length; i += batchSize) {
        const batch = tokens.slice(i, i + batchSize);
        const rows = await this.vortexInstrumentRepo
          .createQueryBuilder('v')
          .where('v.token IN (:...tokens)', { tokens: batch })
          .select([
            'v.token',
            'v.exchange',
            'v.symbol',
            'v.instrument_name',
            'v.expiry_date',
            'v.option_type',
            'v.strike_price',
            'v.tick',
            'v.lot_size',
            'v.description',
            'v.is_active',
          ])
          .getMany();
        for (const row of rows) {
          result[row.token] = row;
        }
      }

      return result;
    } catch (error) {
      this.logger.error('[VortexInstrumentReadService] getVortexInstrumentDetails failed', error);
      throw error;
    }
  }
}
