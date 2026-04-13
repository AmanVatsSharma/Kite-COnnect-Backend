/**
 * @file vortex-instrument-cache.service.ts
 * @module stock
 * @description Redis-backed caching for Vortex instrument stats, autocomplete, and popular list.
 * @author BharatERP
 * @created 2026-03-28
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { RedisService } from '@infra/redis/redis.service';
import { VortexInstrumentLtpService } from '@features/stock/application/vortex-instrument-ltp.service';

@Injectable()
export class VortexInstrumentCacheService {
  private readonly logger = new Logger(VortexInstrumentCacheService.name);

  constructor(
    @InjectRepository(VortexInstrument)
    private readonly vortexInstrumentRepo: Repository<VortexInstrument>,
    private readonly redisService: RedisService,
    private readonly ltpService: VortexInstrumentLtpService,
  ) {}

  private async getCachedOrExecute<T>(
    cacheKey: string,
    ttlSeconds: number,
    executeFn: () => Promise<T>,
  ): Promise<T> {
    try {
      const cached = await this.redisService.get<string>(cacheKey);
      if (cached) {
        this.logger.debug(`[VortexInstrumentCacheService] Cache hit for key: ${cacheKey}`);
        return JSON.parse(cached);
      }

      this.logger.debug(
        `[VortexInstrumentCacheService] Cache miss for key: ${cacheKey}, executing function`,
      );
      const result = await executeFn();

      await this.redisService.set(cacheKey, JSON.stringify(result), ttlSeconds);
      this.logger.debug(
        `[VortexInstrumentCacheService] Cached result for key: ${cacheKey} with TTL: ${ttlSeconds}s`,
      );

      return result;
    } catch (error) {
      this.logger.warn(
        `[VortexInstrumentCacheService] Cache operation failed for key: ${cacheKey}`,
        error,
      );
      return await executeFn();
    }
  }

  async getVortexInstrumentStatsCached(): Promise<{
    total: number;
    byExchange: Record<string, number>;
    byInstrumentType: Record<string, number>;
    lastSync: Date | null;
    queryTime: number;
  }> {
    const startTime = Date.now();

    const result = await this.getCachedOrExecute(
      'vortex:stats',
      600,
      async () => {
        const total = await this.vortexInstrumentRepo.count({
          where: { is_active: true },
        });

        const byExchange = await this.vortexInstrumentRepo
          .createQueryBuilder('instrument')
          .select('instrument.exchange', 'exchange')
          .addSelect('COUNT(*)', 'count')
          .where('instrument.is_active = :active', { active: true })
          .groupBy('instrument.exchange')
          .getRawMany()
          .then((rows) =>
            rows.reduce(
              (acc, row) => {
                acc[row.exchange] = parseInt(row.count, 10);
                return acc;
              },
              {} as Record<string, number>,
            ),
          );

        const byInstrumentType = await this.vortexInstrumentRepo
          .createQueryBuilder('instrument')
          .select('instrument.instrument_name', 'instrument_name')
          .addSelect('COUNT(*)', 'count')
          .where('instrument.is_active = :active', { active: true })
          .groupBy('instrument.instrument_name')
          .getRawMany()
          .then((rows) =>
            rows.reduce(
              (acc, row) => {
                acc[row.instrument_name] = parseInt(row.count, 10);
                return acc;
              },
              {} as Record<string, number>,
            ),
          );

        const lastSync = await this.vortexInstrumentRepo
          .createQueryBuilder('instrument')
          .select('MAX(instrument.updated_at)', 'lastSync')
          .getRawOne()
          .then((row) => (row?.lastSync ? new Date(row.lastSync) : null));

        return {
          total,
          byExchange,
          byInstrumentType,
          lastSync,
        };
      },
    );

    return {
      ...result,
      queryTime: Date.now() - startTime,
    };
  }

  async getVortexAutocompleteCached(
    query: string,
    limit: number = 10,
  ): Promise<{
    suggestions: Array<{
      token: number;
      symbol: string;
      exchange: string;
      instrument_name: string;
      description?: string | null;
    }>;
    queryTime: number;
  }> {
    const startTime = Date.now();

    if (!query || query.trim().length < 1) {
      return { suggestions: [], queryTime: Date.now() - startTime };
    }

    const trimmedQuery = query.trim();
    const cacheKey = `vortex:autocomplete:${trimmedQuery.toLowerCase()}:${limit}`;

    const result = await this.getCachedOrExecute(cacheKey, 300, async () => {
      const suggestions = await this.vortexInstrumentRepo
        .createQueryBuilder('v')
        .select(['v.token', 'v.symbol', 'v.exchange', 'v.instrument_name', 'v.description'])
        .where('v.is_active = :active', { active: true })
        .andWhere('v.symbol ILIKE :query', { query: `${trimmedQuery}%` })
        .orderBy('v.symbol', 'ASC')
        .limit(limit)
        .getMany();

      return suggestions.map((s) => ({
        token: s.token,
        symbol: s.symbol,
        exchange: s.exchange,
        instrument_name: s.instrument_name,
        description: s.description,
      }));
    });

    return {
      suggestions: result,
      queryTime: Date.now() - startTime,
    };
  }

  async getVortexPopularInstrumentsCached(limit: number = 50): Promise<{
    instruments: Array<{
      token: number;
      symbol: string;
      exchange: string;
      instrument_name: string;
      last_price: number | null;
    }>;
    queryTime: number;
  }> {
    const startTime = Date.now();

    const result = await this.getCachedOrExecute('vortex:popular:instruments', 3600, async () => {
      const popularSymbols = await this.vortexInstrumentRepo
        .createQueryBuilder('v')
        .select(['v.token', 'v.symbol', 'v.exchange', 'v.instrument_name', 'v.description'])
        .where('v.is_active = :active', { active: true })
        .andWhere('v.instrument_name IN (:...types)', {
          types: ['EQUITIES', 'EQ'],
        })
        .orderBy('v.symbol', 'ASC')
        .limit(limit)
        .getMany();

      const tokens = popularSymbols.map((i) => i.token);
      const ltp = tokens.length > 0 ? await this.ltpService.getVortexLTP(tokens) : {};

      return popularSymbols.map((s) => ({
        token: s.token,
        symbol: s.symbol,
        exchange: s.exchange,
        instrument_name: s.instrument_name,
        last_price: ltp?.[s.token]?.last_price ?? null,
      }));
    });

    return {
      instruments: result,
      queryTime: Date.now() - startTime,
    };
  }

  async getVortexInstrumentByTokenCached(token: number): Promise<{
    instrument: VortexInstrument | null;
    ltp: { last_price: number } | null;
    queryTime: number;
  }> {
    const startTime = Date.now();
    const cacheKey = `vortex:instrument:${token}`;

    const result = await this.getCachedOrExecute(cacheKey, 3600, async () => {
      const instrument = await this.vortexInstrumentRepo.findOne({
        where: { token, is_active: true },
      });

      if (!instrument) {
        return { instrument: null, ltp: null };
      }

      const ltp = await this.ltpService.getVortexLTP([token]);

      return {
        instrument,
        ltp: ltp[token] || null,
      };
    });

    return {
      ...result,
      queryTime: Date.now() - startTime,
    };
  }

  async clearVortexCache(pattern?: string): Promise<void> {
    try {
      const commonKeys = ['vortex:stats', 'vortex:popular:instruments'];

      for (const key of commonKeys) {
        if (!pattern || key.includes(pattern)) {
          await this.redisService.del(key);
        }
      }

      this.logger.log('[VortexInstrumentCacheService] Cleared Vortex cache keys');
    } catch (error) {
      this.logger.warn('[VortexInstrumentCacheService] Failed to clear cache', error);
    }
  }
}
