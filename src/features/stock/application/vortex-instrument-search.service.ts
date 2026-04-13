/**
 * @file vortex-instrument-search.service.ts
 * @module stock
 * @description Vortex instrument list/filter/search and advanced F&amp;O-style queries.
 * @author BharatERP
 * @created 2026-03-28
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { FnoQueryParserService } from '@features/market-data/application/fno-query-parser.service';

@Injectable()
export class VortexInstrumentSearchService {
  private readonly logger = new Logger(VortexInstrumentSearchService.name);

  constructor(
    @InjectRepository(VortexInstrument)
    private readonly vortexInstrumentRepo: Repository<VortexInstrument>,
    private readonly fnoQueryParser: FnoQueryParserService,
  ) {}

  async getVortexInstruments(filters?: {
    exchange?: string;
    instrument_name?: string;
    symbol?: string;
    option_type?: string;
    is_active?: boolean;
    limit?: number;
    offset?: number;
    q?: string;
  }): Promise<{ instruments: VortexInstrument[]; total: number }> {
    try {
      const queryBuilder =
        this.vortexInstrumentRepo.createQueryBuilder('instrument');

      if (filters?.q && filters.q.trim()) {
        const rawQ = filters.q.trim();
        let isFno = false;
        let parsed: any = null;

        try {
          if (this.fnoQueryParser) {
            parsed = this.fnoQueryParser.parse(rawQ);
            isFno = !!(
              parsed.strike ||
              parsed.optionType ||
              parsed.expiryFrom ||
              parsed.expiryTo
            );
          }
        } catch (e) {
          this.logger.warn(
            `[VortexInstrumentSearchService] Error parsing F&O query "${rawQ}"`,
            e,
          );
          isFno = false;
        }

        if (isFno && parsed) {
          if (parsed.underlying) {
            queryBuilder.andWhere('instrument.symbol ILIKE :underlying', {
              underlying: `${parsed.underlying}%`,
            });
          }
          if (parsed.strike) {
            queryBuilder.andWhere('instrument.strike_price = :strike', {
              strike: parsed.strike,
            });
          }
          if (parsed.optionType) {
            queryBuilder.andWhere('instrument.option_type = :optionType', {
              optionType: parsed.optionType,
            });
          }
          if (parsed.expiryFrom) {
            queryBuilder.andWhere('instrument.expiry_date >= :expiryFrom', {
              expiryFrom: parsed.expiryFrom,
            });
          }
          if (parsed.expiryTo) {
            queryBuilder.andWhere('instrument.expiry_date <= :expiryTo', {
              expiryTo: parsed.expiryTo,
            });
          }
        } else {
          if (rawQ.length >= 2) {
            queryBuilder.andWhere(
              `(instrument.symbol ILIKE :q OR instrument.instrument_name ILIKE :q)`,
              { q: `%${rawQ}%` },
            );
          } else {
            queryBuilder.andWhere('instrument.symbol ILIKE :q', {
              q: `%${rawQ}%`,
            });
          }
        }
      }

      if (filters?.exchange) {
        queryBuilder.andWhere('instrument.exchange = :exchange', {
          exchange: filters.exchange,
        });
      }

      if (filters?.instrument_name) {
        queryBuilder.andWhere('instrument.instrument_name = :instrument_name', {
          instrument_name: filters.instrument_name,
        });
      }

      if (filters?.symbol) {
        queryBuilder.andWhere('instrument.symbol ILIKE :symbol', {
          symbol: `%${filters.symbol}%`,
        });
      }

      if (filters?.option_type) {
        queryBuilder.andWhere('instrument.option_type = :option_type', {
          option_type: filters.option_type,
        });
      }

      if (filters?.is_active !== undefined) {
        queryBuilder.andWhere('instrument.is_active = :is_active', {
          is_active: filters.is_active,
        });
      }

      const total = await queryBuilder.getCount();

      if (filters?.limit) {
        queryBuilder.limit(filters.limit);
      }

      if (filters?.offset) {
        queryBuilder.offset(filters.offset);
      }

      queryBuilder.orderBy('instrument.symbol', 'ASC');

      queryBuilder.select([
        'instrument.token',
        'instrument.exchange',
        'instrument.symbol',
        'instrument.instrument_name',
        'instrument.expiry_date',
        'instrument.option_type',
        'instrument.strike_price',
        'instrument.tick',
        'instrument.lot_size',
        'instrument.description',
        'instrument.is_active',
        'instrument.created_at',
        'instrument.updated_at',
      ]);

      const instruments = await queryBuilder.getMany();

      return { instruments, total };
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentSearchService] Error getting Vortex instruments',
        error,
      );
      throw error;
    }
  }

  async searchVortexInstruments(
    query: string,
    limit: number = 50,
  ): Promise<VortexInstrument[]> {
    try {
      if (!query || query.trim().length === 0) {
        return [];
      }

      const searchTerm = `%${query.trim()}%`;

      return await this.vortexInstrumentRepo
        .createQueryBuilder('instrument')
        .where('instrument.symbol ILIKE :searchTerm', { searchTerm })
        .orWhere('instrument.instrument_name ILIKE :searchTerm', { searchTerm })
        .andWhere('instrument.is_active = :isActive', { isActive: true })
        .orderBy('instrument.symbol', 'ASC')
        .limit(limit)
        .getMany();
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentSearchService] Error searching Vortex instruments',
        error,
      );
      throw error;
    }
  }

  async resolveVortexSymbol(
    symbol: string,
    exchangeHint?: string,
  ): Promise<{
    instrument: VortexInstrument | null;
    candidates: VortexInstrument[];
  }> {
    try {
      const raw = symbol.trim().toUpperCase();
      let exchange: string | undefined = exchangeHint?.toUpperCase();
      let sym = raw;

      const prefixMatch = raw.match(
        /^(NSE_EQ|NSE_FO|BSE_EQ|MCX_FO|NSE_CUR|CDS_FO)[:_]/,
      );
      if (prefixMatch) {
        exchange = prefixMatch[1];
        sym = raw.slice(prefixMatch[0].length);
      }

      let instrumentType: string | undefined;
      const hyphen = sym.split('-');
      if (hyphen.length === 2) {
        sym = hyphen[0];
        instrumentType = hyphen[1];
      }

      const qb = this.vortexInstrumentRepo
        .createQueryBuilder('v')
        .where('v.symbol = :sym', { sym })
        .orWhere('v.symbol LIKE :like', { like: `${sym}-%` });

      if (exchange) {
        qb.andWhere('v.exchange = :exchange', { exchange });
      }

      if (instrumentType) {
        qb.andWhere('v.instrument_name = :instrumentType', { instrumentType });
      }

      qb.orderBy('v.exchange', 'ASC');

      const list = await qb.getMany();

      if (list.length === 0) {
        const fuzzy = await this.vortexInstrumentRepo
          .createQueryBuilder('v')
          .where('v.symbol LIKE :q', { q: `%${sym}%` })
          .andWhere('v.is_active = :ia', { ia: true })
          .limit(10)
          .getMany();
        return { instrument: null, candidates: fuzzy };
      }

      let best = list[0];
      if (exchange) {
        const exactExchange = list.find(
          (i) => i.exchange?.toUpperCase() === exchange,
        );
        if (exactExchange) best = exactExchange;
      }

      return { instrument: best, candidates: list };
    } catch (error) {
      this.logger.error('[VortexInstrumentSearchService] Error resolving Vortex symbol', error);
      return { instrument: null, candidates: [] };
    }
  }

  async searchVortexInstrumentsAdvanced(filters: {
    query?: string;
    underlying_symbol?: string;
    symbol?: string;
    exchange?: string[];
    instrument_type?: string[];
    option_type?: 'CE' | 'PE';
    options_only?: boolean;
    expiry_from?: string;
    expiry_to?: string;
    strike_min?: number;
    strike_max?: number;
    limit?: number;
    offset?: number;
    sort_by?: 'symbol' | 'strike_price' | 'expiry_date';
    sort_order?: 'asc' | 'desc';
    detailed?: boolean;
    skip_count?: boolean;
    only_active?: boolean;
  }): Promise<{
    instruments: VortexInstrument[];
    total: number;
    hasMore: boolean;
    queryTime: number;
  }> {
    const startTime = Date.now();

    try {
      const limit = Math.min(filters.limit || 50, 500);
      const offset = filters.offset || 0;
      const sortBy = filters.sort_by || 'symbol';
      const sortOrder = filters.sort_order || 'asc';

      const qb = this.vortexInstrumentRepo.createQueryBuilder('v');

      if (filters.only_active) {
        qb.where('v.is_active = :active', { active: true });
      }

      if (filters.query && filters.query.trim()) {
        const query = filters.query.trim();
        if (query.length >= 2) {
          qb.andWhere(
            `
            (v.symbol ILIKE :query OR 
             to_tsvector('english', v.symbol) @@ plainto_tsquery('english', :query))
          `,
            { query: `%${query}%` },
          );
        } else {
          qb.andWhere('v.symbol ILIKE :query', { query: `%${query}%` });
        }
      }

      if (filters.underlying_symbol && filters.underlying_symbol.trim()) {
        const underlying = filters.underlying_symbol.trim().toUpperCase();
        qb.andWhere('v.symbol ILIKE :underlyingSymbol', {
          underlyingSymbol: `${underlying}%`,
        });
      }

      if (filters.symbol && filters.symbol.trim()) {
        const exactSymbol = filters.symbol.trim().toUpperCase();
        qb.andWhere('v.symbol = :exactSymbol', {
          exactSymbol: exactSymbol,
        });
      }

      if (filters.exchange && filters.exchange.length > 0) {
        qb.andWhere('v.exchange IN (:...exchanges)', {
          exchanges: filters.exchange,
        });
      }

      if (filters.instrument_type && filters.instrument_type.length > 0) {
        qb.andWhere('v.instrument_name IN (:...types)', {
          types: filters.instrument_type,
        });
      }

      if (filters.option_type) {
        qb.andWhere('v.option_type = :optionType', {
          optionType: filters.option_type,
        });
      }
      if (filters.options_only) {
        qb.andWhere('v.option_type IS NOT NULL');
      }

      if (filters.expiry_from) {
        qb.andWhere('v.expiry_date >= :expiryFrom', {
          expiryFrom: filters.expiry_from,
        });
      }
      if (filters.expiry_to) {
        qb.andWhere('v.expiry_date <= :expiryTo', {
          expiryTo: filters.expiry_to,
        });
      }

      if (filters.strike_min !== undefined) {
        qb.andWhere('v.strike_price >= :strikeMin', {
          strikeMin: filters.strike_min,
        });
      }
      if (filters.strike_max !== undefined) {
        qb.andWhere('v.strike_price <= :strikeMax', {
          strikeMax: filters.strike_max,
        });
      }

      let total = 0;
      if (!filters.skip_count) {
        total = await qb.getCount();
      }

      switch (sortBy) {
        case 'symbol':
          qb.orderBy('v.symbol', sortOrder.toUpperCase() as 'ASC' | 'DESC');
          break;
        case 'strike_price':
          qb.orderBy(
            'v.strike_price',
            sortOrder.toUpperCase() as 'ASC' | 'DESC',
          );
          break;
        case 'expiry_date':
          qb.orderBy(
            'v.expiry_date',
            sortOrder.toUpperCase() as 'ASC' | 'DESC',
          );
          break;
        default:
          qb.orderBy('v.symbol', 'ASC');
      }

      qb.limit(limit).offset(offset);

      const instruments = await qb.getMany();

      const hasMore = filters.skip_count ? instruments.length === limit : offset + limit < total;

      const queryTime = Date.now() - startTime;

      if (queryTime > 500) {
        this.logger.warn(
          `[VortexInstrumentSearchService] Slow query: ${queryTime}ms`,
          filters,
        );
      }

      return {
        instruments,
        total: filters.skip_count ? -1 : total,
        hasMore,
        queryTime,
      };
    } catch (error) {
      this.logger.error('[VortexInstrumentSearchService] Error in advanced search', error);
      throw error;
    }
  }

  async getVortexAutocomplete(
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

    try {
      if (!query || query.trim().length < 1) {
        return { suggestions: [], queryTime: Date.now() - startTime };
      }

      const trimmedQuery = query.trim();

      const suggestions = await this.vortexInstrumentRepo
        .createQueryBuilder('v')
        .select(['v.token', 'v.symbol', 'v.exchange', 'v.instrument_name', 'v.description'])
        .where('v.is_active = :active', { active: true })
        .andWhere('v.symbol ILIKE :query', { query: `${trimmedQuery}%` })
        .orderBy('v.symbol', 'ASC')
        .limit(limit)
        .getMany();

      const queryTime = Date.now() - startTime;

      return {
        suggestions: suggestions.map((s) => ({
          token: s.token,
          symbol: s.symbol,
          exchange: s.exchange,
          instrument_name: s.instrument_name,
          description: s.description,
        })),
        queryTime,
      };
    } catch (error) {
      this.logger.error('[VortexInstrumentSearchService] Error in autocomplete', error);
      return { suggestions: [], queryTime: Date.now() - startTime };
    }
  }
}
