import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { VortexInstrument } from '../entities/vortex-instrument.entity';
import { InstrumentMapping } from '../entities/instrument-mapping.entity';
import { VortexProviderService } from '../providers/vortex-provider.service';
import { RedisService } from './redis.service';

/**
 * VortexInstrumentService
 *
 * Handles Vortex-specific instrument operations including:
 * - CSV download and parsing from Vortex API
 * - Database synchronization with vortex_instruments table
 * - Instrument mapping management
 * - Daily automated sync via cron job
 */
@Injectable()
export class VortexInstrumentService {
  private readonly logger = new Logger(VortexInstrumentService.name);

  constructor(
    @InjectRepository(VortexInstrument)
    private vortexInstrumentRepo: Repository<VortexInstrument>,
    @InjectRepository(InstrumentMapping)
    private mappingRepo: Repository<InstrumentMapping>,
    private vortexProvider: VortexProviderService,
    private redisService: RedisService,
  ) {}

  /**
   * Sync Vortex instruments from CSV
   * Downloads CSV from Vortex API and syncs to database
   */
  async syncVortexInstruments(
    exchange?: string,
    csvUrl?: string,
  ): Promise<{ synced: number; updated: number }> {
    try {
      this.logger.log(
        `[VortexInstrumentService] Starting Vortex instrument sync for exchange=${exchange || 'all'}`,
      );

      // Get instruments from Vortex provider
      const instruments = await this.vortexProvider.getInstruments(exchange, {
        csvUrl,
      });

      if (!instruments || instruments.length === 0) {
        this.logger.warn(
          '[VortexInstrumentService] No instruments received from Vortex provider',
        );
        return { synced: 0, updated: 0 };
      }

      this.logger.log(
        `[VortexInstrumentService] Received ${instruments.length} instruments from Vortex CSV`,
      );

      let synced = 0;
      let updated = 0;

      for (const vortexInstrument of instruments) {
        try {
          // Check if instrument already exists
          const existingInstrument = await this.vortexInstrumentRepo.findOne({
            where: { token: vortexInstrument.token },
          });

          // Generate description for better documentation
          const description = this.generateDescription(vortexInstrument);

          if (existingInstrument) {
            // Update existing instrument
            await this.vortexInstrumentRepo.update(
              { token: vortexInstrument.token },
              {
                exchange: vortexInstrument.exchange,
                symbol: vortexInstrument.symbol,
                instrument_name: vortexInstrument.instrument_name,
                expiry_date: vortexInstrument.expiry_date,
                option_type: vortexInstrument.option_type,
                strike_price: vortexInstrument.strike_price,
                tick: vortexInstrument.tick,
                lot_size: vortexInstrument.lot_size,
                description,
              },
            );
            updated++;
            this.logger.debug(
              `[VortexInstrumentService] Updated instrument token=${vortexInstrument.token}, symbol=${vortexInstrument.symbol}`,
            );
          } else {
            // Create new instrument
            const newInstrument = this.vortexInstrumentRepo.create({
              token: vortexInstrument.token,
              exchange: vortexInstrument.exchange,
              symbol: vortexInstrument.symbol,
              instrument_name: vortexInstrument.instrument_name,
              expiry_date: vortexInstrument.expiry_date,
              option_type: vortexInstrument.option_type,
              strike_price: vortexInstrument.strike_price,
              tick: vortexInstrument.tick,
              lot_size: vortexInstrument.lot_size,
              description,
            });
            await this.vortexInstrumentRepo.save(newInstrument);
            synced++;
            this.logger.debug(
              `[VortexInstrumentService] Created instrument token=${vortexInstrument.token}, symbol=${vortexInstrument.symbol}`,
            );
          }

          // Update instrument mapping with exchange-token format
          await this.updateInstrumentMapping(vortexInstrument);
        } catch (error) {
          this.logger.error(
            `[VortexInstrumentService] Failed to process instrument token=${vortexInstrument.token}`,
            error,
          );
        }
      }

      this.logger.log(
        `[VortexInstrumentService] Sync completed. Synced: ${synced}, Updated: ${updated}`,
      );
      return { synced, updated };
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentService] Error syncing Vortex instruments',
        error,
      );
      throw error;
    }
  }

  /**
   * Update instrument mapping for Vortex provider
   * Creates mapping with format: exchange-token (e.g., NSE_EQ-22)
   */
  private async updateInstrumentMapping(vortexInstrument: any): Promise<void> {
    try {
      const providerToken = `${vortexInstrument.exchange}-${vortexInstrument.token}`;

      const existingMap = await this.mappingRepo.findOne({
        where: {
          provider: 'vortex',
          provider_token: providerToken,
        },
      });

      if (existingMap) {
        // Update existing mapping if token changed
        if (existingMap.instrument_token !== vortexInstrument.token) {
          existingMap.instrument_token = vortexInstrument.token;
          await this.mappingRepo.save(existingMap);
          this.logger.debug(
            `[VortexInstrumentService] Updated mapping: ${providerToken} -> ${vortexInstrument.token}`,
          );
        }
      } else {
        // Create new mapping
        await this.mappingRepo.save(
          this.mappingRepo.create({
            provider: 'vortex',
            provider_token: providerToken,
            instrument_token: vortexInstrument.token,
          }),
        );
        this.logger.debug(
          `[VortexInstrumentService] Created mapping: ${providerToken} -> ${vortexInstrument.token}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[VortexInstrumentService] Failed to update mapping for token ${vortexInstrument.token}`,
        error,
      );
    }
  }

  /**
   * Get Vortex instruments with filters
   */
  async getVortexInstruments(filters?: {
    exchange?: string;
    instrument_name?: string;
    symbol?: string;
    option_type?: string;
    is_active?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ instruments: VortexInstrument[]; total: number }> {
    try {
      const queryBuilder =
        this.vortexInstrumentRepo.createQueryBuilder('instrument');

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

      // Select all fields including description
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
        '[VortexInstrumentService] Error getting Vortex instruments',
        error,
      );
      throw error;
    }
  }

  /**
   * Search Vortex instruments by symbol or instrument name
   */
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
        '[VortexInstrumentService] Error searching Vortex instruments',
        error,
      );
      throw error;
    }
  }

  /**
   * Get Vortex instrument by token
   */
  async getVortexInstrumentByToken(
    token: number,
  ): Promise<VortexInstrument | null> {
    try {
      return await this.vortexInstrumentRepo.findOne({ where: { token } });
    } catch (error) {
      this.logger.error(
        `[VortexInstrumentService] Error getting Vortex instrument by token ${token}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Daily cron job to sync Vortex instruments at 8:30 AM
   * CSV is refreshed daily after 8:30 AM according to Vortex documentation
   */
  @Cron('30 8 * * *') // 8:30 AM daily
  async syncVortexInstrumentsDaily() {
    try {
      this.logger.log(
        '[VortexInstrumentService] Starting daily Vortex instrument sync',
      );
      const result = await this.syncVortexInstruments();
      this.logger.log(
        `[VortexInstrumentService] Daily sync completed: ${result.synced} synced, ${result.updated} updated`,
      );
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentService] Error in daily Vortex instrument sync',
        error,
      );
    }
  }

  /**
   * Get statistics about Vortex instruments
   */
  async getVortexInstrumentStats(): Promise<{
    total: number;
    byExchange: Record<string, number>;
    byInstrumentType: Record<string, number>;
    lastSync: Date | null;
  }> {
    try {
      const total = await this.vortexInstrumentRepo.count();

      // Count by exchange
      const exchangeStats = await this.vortexInstrumentRepo
        .createQueryBuilder('instrument')
        .select('instrument.exchange', 'exchange')
        .addSelect('COUNT(*)', 'count')
        .groupBy('instrument.exchange')
        .getRawMany();

      const byExchange = exchangeStats.reduce((acc, stat) => {
        acc[stat.exchange] = parseInt(stat.count);
        return acc;
      }, {});

      // Count by instrument type
      const typeStats = await this.vortexInstrumentRepo
        .createQueryBuilder('instrument')
        .select('instrument.instrument_name', 'instrument_name')
        .addSelect('COUNT(*)', 'count')
        .groupBy('instrument.instrument_name')
        .getRawMany();

      const byInstrumentType = typeStats.reduce((acc, stat) => {
        acc[stat.instrument_name] = parseInt(stat.count);
        return acc;
      }, {});

      // Get last sync time (most recent updated_at)
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
        '[VortexInstrumentService] Error getting Vortex instrument stats',
        error,
      );
      throw error;
    }
  }

  /**
   * Resolve a human symbol to a stored Vortex instrument.
   * Accepts forms like "NSE_EQ:RELIANCE", "RELIANCE", or "RELIANCE-EQ" with optional exchange.
   * Returns best match and candidate list for disambiguation.
   */
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

      // Parse exchange prefix e.g., NSE_EQ:RELIANCE or NSE_EQ_RELIANCE
      const prefixMatch = raw.match(
        /^(NSE_EQ|NSE_FO|BSE_EQ|MCX_FO|NSE_CUR|CDS_FO)[:_]/,
      );
      if (prefixMatch) {
        exchange = prefixMatch[1];
        sym = raw.slice(prefixMatch[0].length);
      }

      // Allow RELIANCE-EQ form => symbol=RELIANCE, instrument_name=EQ
      let instrumentType: string | undefined;
      const hyphen = sym.split('-');
      if (hyphen.length === 2) {
        sym = hyphen[0];
        instrumentType = hyphen[1];
      }

      // Build query
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
        // fallback fuzzy search
        const fuzzy = await this.vortexInstrumentRepo
          .createQueryBuilder('v')
          .where('v.symbol LIKE :q', { q: `%${sym}%` })
          .andWhere('v.is_active = :ia', { ia: true })
          .limit(10)
          .getMany();
        return { instrument: null, candidates: fuzzy };
      }

      // Prefer exact exchange if provided, else first
      let best = list[0];
      if (exchange) {
        const exactExchange = list.find(
          (i) => i.exchange?.toUpperCase() === exchange,
        );
        if (exactExchange) best = exactExchange;
      }

      return { instrument: best, candidates: list };
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentService] Error resolving Vortex symbol',
        error,
      );
      return { instrument: null, candidates: [] };
    }
  }

  /**
   * Advanced search for Vortex instruments with multiple filters and pagination
   * Optimized for handling 200K+ instruments efficiently
   */
  async searchVortexInstrumentsAdvanced(filters: {
    query?: string; // Symbol search
    exchange?: string[]; // Multiple exchanges
    instrument_type?: string[]; // EQUITIES, OPTSTK, OPTIDX, etc.
    option_type?: 'CE' | 'PE'; // For options
    expiry_from?: string; // YYYYMMDD
    expiry_to?: string; // YYYYMMDD
    strike_min?: number;
    strike_max?: number;
    limit?: number; // Default 50, max 500
    offset?: number;
    sort_by?: 'symbol' | 'strike_price' | 'expiry_date';
    sort_order?: 'asc' | 'desc';
    detailed?: boolean; // Return minimal or full data
  }): Promise<{
    instruments: VortexInstrument[];
    total: number;
    hasMore: boolean;
    queryTime: number;
  }> {
    const startTime = Date.now();

    try {
      // Set defaults
      const limit = Math.min(filters.limit || 50, 500); // Cap at 500
      const offset = filters.offset || 0;
      const sortBy = filters.sort_by || 'symbol';
      const sortOrder = filters.sort_order || 'asc';

      // Build query with optimized indexes
      const qb = this.vortexInstrumentRepo
        .createQueryBuilder('v')
        .where('v.is_active = :active', { active: true });

      // Symbol search with full-text search for better performance
      if (filters.query && filters.query.trim()) {
        const query = filters.query.trim();
        if (query.length >= 2) {
          // Use full-text search for better performance on large datasets
          qb.andWhere(
            `
            (v.symbol ILIKE :query OR 
             to_tsvector('english', v.symbol) @@ plainto_tsquery('english', :query))
          `,
            { query: `%${query}%` },
          );
        } else {
          // For very short queries, use simple ILIKE
          qb.andWhere('v.symbol ILIKE :query', { query: `%${query}%` });
        }
      }

      // Exchange filtering
      if (filters.exchange && filters.exchange.length > 0) {
        qb.andWhere('v.exchange IN (:...exchanges)', {
          exchanges: filters.exchange,
        });
      }

      // Instrument type filtering
      if (filters.instrument_type && filters.instrument_type.length > 0) {
        qb.andWhere('v.instrument_name IN (:...types)', {
          types: filters.instrument_type,
        });
      }

      // Option-specific filters
      if (filters.option_type) {
        qb.andWhere('v.option_type = :optionType', {
          optionType: filters.option_type,
        });
      }

      // Expiry date range filtering
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

      // Strike price range filtering
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

      // Get total count for pagination
      const total = await qb.getCount();

      // Apply sorting
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

      // Apply pagination
      qb.limit(limit).offset(offset);

      // Execute query
      const instruments = await qb.getMany();

      // Calculate hasMore
      const hasMore = offset + limit < total;

      const queryTime = Date.now() - startTime;

      // Log slow queries for monitoring
      if (queryTime > 500) {
        this.logger.warn(
          `[VortexInstrumentService] Slow query detected: ${queryTime}ms for filters:`,
          filters,
        );
      }

      return {
        instruments,
        total,
        hasMore,
        queryTime,
      };
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentService] Error in advanced search',
        error,
      );
      throw error;
    }
  }

  /**
   * Fast autocomplete for symbol search
   * Returns minimal data for quick response
   */
  async getVortexAutocomplete(
    query: string,
    limit: number = 10,
  ): Promise<{
    suggestions: Array<{
      token: number;
      symbol: string;
      exchange: string;
      instrument_name: string;
    }>;
    queryTime: number;
  }> {
    const startTime = Date.now();

    try {
      if (!query || query.trim().length < 1) {
        return { suggestions: [], queryTime: Date.now() - startTime };
      }

      const trimmedQuery = query.trim();

      // Use optimized query with prefix matching for autocomplete
      const suggestions = await this.vortexInstrumentRepo
        .createQueryBuilder('v')
        .select(['v.token', 'v.symbol', 'v.exchange', 'v.instrument_name'])
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
        })),
        queryTime,
      };
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentService] Error in autocomplete',
        error,
      );
      return { suggestions: [], queryTime: Date.now() - startTime };
    }
  }

  /**
   * Get options chain for a symbol
   * Returns structured options data with strikes and expiries
   */
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
      // Get all options for the symbol
      const options = await this.vortexInstrumentRepo
        .createQueryBuilder('v')
        .where('v.symbol = :symbol', { symbol: symbol.toUpperCase() })
        .andWhere('v.option_type IS NOT NULL')
        .andWhere('v.is_active = :active', { active: true })
        .orderBy('v.expiry_date', 'ASC')
        .addOrderBy('v.strike_price', 'ASC')
        .getMany();

      // Structure the data
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
      this.logger.error(
        '[VortexInstrumentService] Error getting options chain',
        error,
      );
      throw error;
    }
  }

  /**
   * Batch lookup for multiple instruments
   * Optimized for fetching multiple instruments with live prices
   */
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

      // Get instruments (handle up to 1000 tokens in batches)
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
      
      const instruments = allInstruments;

      // Get live prices (limit to 100 for LTP to avoid rate limits)
      const ltpTokens = tokens.slice(0, 100);
      const ltp = await this.getVortexLTP(ltpTokens);

      // Convert to keyed objects
      const instrumentsMap: Record<number, VortexInstrument> = {};
      for (const instrument of instruments) {
        instrumentsMap[instrument.token] = instrument;
      }

      const queryTime = Date.now() - startTime;

      return {
        instruments: instrumentsMap,
        ltp,
        queryTime,
      };
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentService] Error in batch lookup',
        error,
      );
      throw error;
    }
  }

  /**
   * Get live prices for Vortex instruments
   */
  async getVortexLTP(
    tokens: number[],
  ): Promise<Record<number, { last_price: number }>> {
    try {
      if (!tokens || tokens.length === 0) {
        return {};
      }

      // 1) Build authoritative exchange-token pairs from vortex_instruments
      const rows = await this.vortexInstrumentRepo.find({
        where: { token: In(tokens) },
        select: ['token', 'exchange'],
      });
      const allowed = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);
      const pairKeyToToken = new Map<string, number>();
      const pairs: Array<{ exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'; token: string }>
        = [];
      const found = new Set<number>();
      for (const r of rows) {
        const ex = String(r.exchange || '').toUpperCase();
        const tok = String(r.token);
        if (allowed.has(ex) && /^\d+$/.test(tok)) {
          pairs.push({ exchange: ex as any, token: tok });
          pairKeyToToken.set(`${ex}-${tok}`, r.token);
          found.add(r.token);
        }
      }

      // 2) Fallback to instrument_mappings (provider=vortex) for missing tokens
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
              pairs.push({ exchange: ex as any, token: tok });
              pairKeyToToken.set(`${ex}-${tok}`, m.instrument_token);
              found.add(m.instrument_token);
            }
          }
        } catch (e) {
          this.logger.warn(
            '[VortexInstrumentService] Mapping fallback failed; some tokens will use NSE_EQ',
            e,
          );
        }
      }

      // 3) Last-resort fallback to NSE_EQ for any still-missing tokens (to avoid drops)
      const stillMissing = tokens.filter((t) => !found.has(t));
      for (const t of stillMissing) {
        const tok = String(t);
        if (/^\d+$/.test(tok)) {
          pairs.push({ exchange: 'NSE_EQ', token: tok });
          pairKeyToToken.set(`NSE_EQ-${tok}`, t);
        }
      }

      // 4) Fetch LTP using explicit pairs (single or chunked calls handled by provider)
      const ltpByPairKey = await this.vortexProvider.getLTPByPairs(pairs);

      // 5) Convert back to number-keyed map
      const result: Record<number, { last_price: number }> = {};
      for (const [exToken, priceData] of Object.entries(ltpByPairKey || {})) {
        const tokenNum = pairKeyToToken.get(exToken);
        const lp = priceData?.last_price;
        if (tokenNum !== undefined && Number.isFinite(lp) && (lp as any) > 0) {
          result[tokenNum] = { last_price: lp as any };
        }
      }

      // Ensure coverage for all input tokens
      for (const t of tokens) {
        if (!(t in result)) result[t] = { last_price: null as any };
      }

      return result;
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentService] Error getting Vortex LTP',
        error,
      );
      return {};
    }
  }

  /**
   * Get cached data or execute function and cache result
   */
  private async getCachedOrExecute<T>(
    cacheKey: string,
    ttlSeconds: number,
    executeFn: () => Promise<T>,
  ): Promise<T> {
    try {
      // Try to get from cache first
      const cached = await this.redisService.get<string>(cacheKey);
      if (cached) {
        this.logger.debug(
          `[VortexInstrumentService] Cache hit for key: ${cacheKey}`,
        );
        return JSON.parse(cached);
      }

      // Execute function and cache result
      this.logger.debug(
        `[VortexInstrumentService] Cache miss for key: ${cacheKey}, executing function`,
      );
      const result = await executeFn();

      // Cache the result
      await this.redisService.set(cacheKey, JSON.stringify(result), ttlSeconds);
      this.logger.debug(
        `[VortexInstrumentService] Cached result for key: ${cacheKey} with TTL: ${ttlSeconds}s`,
      );

      return result;
    } catch (error) {
      this.logger.warn(
        `[VortexInstrumentService] Cache operation failed for key: ${cacheKey}`,
        error,
      );
      // Fallback to direct execution if cache fails
      return await executeFn();
    }
  }

  /**
   * Get Vortex instrument stats with caching
   */
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
      600, // 10 minutes TTL
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
                acc[row.exchange] = parseInt(row.count);
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
                acc[row.instrument_name] = parseInt(row.count);
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

  /**
   * Get autocomplete suggestions with caching
   */
  async getVortexAutocompleteCached(
    query: string,
    limit: number = 10,
  ): Promise<{
    suggestions: Array<{
      token: number;
      symbol: string;
      exchange: string;
      instrument_name: string;
    }>;
    queryTime: number;
  }> {
    const startTime = Date.now();

    if (!query || query.trim().length < 1) {
      return { suggestions: [], queryTime: Date.now() - startTime };
    }

    const trimmedQuery = query.trim();
    const cacheKey = `vortex:autocomplete:${trimmedQuery.toLowerCase()}:${limit}`;

    const result = await this.getCachedOrExecute(
      cacheKey,
      300, // 5 minutes TTL
      async () => {
        const suggestions = await this.vortexInstrumentRepo
          .createQueryBuilder('v')
          .select(['v.token', 'v.symbol', 'v.exchange', 'v.instrument_name'])
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
        }));
      },
    );

    return {
      suggestions: result,
      queryTime: Date.now() - startTime,
    };
  }

  /**
   * Get popular instruments with caching
   */
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

    const result = await this.getCachedOrExecute(
      'vortex:popular:instruments',
      3600, // 1 hour TTL
      async () => {
        // Get most common symbols (this could be enhanced with actual trading volume data)
        const popularSymbols = await this.vortexInstrumentRepo
          .createQueryBuilder('v')
          .select(['v.token', 'v.symbol', 'v.exchange', 'v.instrument_name'])
          .where('v.is_active = :active', { active: true })
          .andWhere('v.instrument_name IN (:...types)', {
            types: ['EQUITIES', 'EQ'],
          })
          .orderBy('v.symbol', 'ASC')
          .limit(limit)
          .getMany();

        // Get live prices for popular instruments
        const tokens = popularSymbols.map((i) => i.token);
        const ltp = tokens.length > 0 ? await this.getVortexLTP(tokens) : {};

        return popularSymbols.map((s) => ({
          token: s.token,
          symbol: s.symbol,
          exchange: s.exchange,
          instrument_name: s.instrument_name,
          last_price: ltp?.[s.token]?.last_price ?? null,
        }));
      },
    );

    return {
      instruments: result,
      queryTime: Date.now() - startTime,
    };
  }

  /**
   * Get individual instrument with caching
   */
  async getVortexInstrumentByTokenCached(token: number): Promise<{
    instrument: VortexInstrument | null;
    ltp: { last_price: number } | null;
    queryTime: number;
  }> {
    const startTime = Date.now();
    const cacheKey = `vortex:instrument:${token}`;

    const result = await this.getCachedOrExecute(
      cacheKey,
      3600, // 1 hour TTL
      async () => {
        const instrument = await this.vortexInstrumentRepo.findOne({
          where: { token, is_active: true },
        });

        if (!instrument) {
          return { instrument: null, ltp: null };
        }

        const ltp = await this.getVortexLTP([token]);

        return {
          instrument,
          ltp: ltp[token] || null,
        };
      },
    );

    return {
      ...result,
      queryTime: Date.now() - startTime,
    };
  }

  /**
   * Clear cache for specific patterns
   * Note: RedisService doesn't support pattern-based deletion, so we'll clear specific keys
   */
  async clearVortexCache(pattern?: string): Promise<void> {
    try {
      // Since RedisService doesn't have keys() method, we'll clear specific known cache keys
      const commonKeys = ['vortex:stats', 'vortex:popular:instruments'];

      for (const key of commonKeys) {
        if (!pattern || key.includes(pattern)) {
          await this.redisService.del(key);
        }
      }

      this.logger.log(`[VortexInstrumentService] Cleared Vortex cache keys`);
    } catch (error) {
      this.logger.warn(
        '[VortexInstrumentService] Failed to clear cache',
        error,
      );
    }
  }

  /**
   * Generate human-readable description for an instrument
   * Format: "EXCHANGE SYMBOL INSTRUMENT_NAME [EXPIRY] [STRIKE] [OPTION_TYPE]"
   * Examples:
   * - "NSE_EQ RELIANCE EQ"
   * - "NSE_FO NIFTY 25JAN2024 22000 CE"
   * - "MCX_FO GOLD FUTCOM"
   */
  private generateDescription(instrument: any): string {
    const parts: string[] = [instrument.exchange || '', instrument.symbol || ''];
    
    if (instrument.instrument_name) {
      parts.push(instrument.instrument_name);
    }
    
    // Add expiry date if present (format: YYYYMMDD -> DDMMMYYYY)
    if (instrument.expiry_date && instrument.expiry_date.length === 8) {
      try {
        const year = instrument.expiry_date.substring(0, 4);
        const month = instrument.expiry_date.substring(4, 6);
        const day = instrument.expiry_date.substring(6, 8);
        const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        const monthName = monthNames[parseInt(month) - 1] || month;
        parts.push(`${day}${monthName}${year}`);
      } catch (e) {
        // If parsing fails, use raw expiry_date
        parts.push(instrument.expiry_date);
      }
    }
    
    // Add strike price if present
    if (instrument.strike_price && Number.isFinite(instrument.strike_price) && instrument.strike_price > 0) {
      parts.push(String(instrument.strike_price));
    }
    
    // Add option type if present
    if (instrument.option_type) {
      parts.push(instrument.option_type);
    }
    
    return parts.filter(p => p).join(' ');
  }

  /**
   * Normalize exchange string to standard format
   * Uses same logic as vortex-provider.service.ts for consistency
   * 
   * @param ex - Exchange string from database
   * @returns Normalized exchange or null if invalid
   */
  private normalizeExchange(
    ex: string,
  ): 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO' | null {
    const s = (ex || '').toUpperCase().trim();
    if (!s) return null;
    
    // Exact matches first
    if (s === 'NSE_EQ') return 'NSE_EQ';
    if (s === 'NSE_FO') return 'NSE_FO';
    if (s === 'NSE_CUR') return 'NSE_CUR';
    if (s === 'MCX_FO') return 'MCX_FO';
    
    // Pattern matching (same as provider)
    if (
      s.includes('NSE_EQ') ||
      (s === 'NSE' && !s.includes('FO') && !s.includes('CUR')) ||
      s === 'EQ' ||
      s.includes('EQUITY')
    ) {
      return 'NSE_EQ';
    }
    if (
      s.includes('NSE_FO') ||
      s.includes('FO') ||
      s.includes('FUT') ||
      s.includes('FNO')
    ) {
      return 'NSE_FO';
    }
    if (s.includes('NSE_CUR') || s.includes('CDS') || s.includes('CUR')) {
      return 'NSE_CUR';
    }
    if (s.includes('MCX')) {
      return 'MCX_FO';
    }
    
    return null;
  }

  /**
   * Validate and cleanup invalid Vortex instruments
   * 
   * Tests LTP fetch capability for instruments in batches, identifies invalid instruments,
   * and optionally deactivates them.
   * 
   * Flow:
   * 1. Query instruments from DB with filters
   * 2. Group into batches of specified size (default 1000)
   * 3. For each batch:
   *    - Build exchange-token pairs using authoritative exchange from DB
   *    - Call vortexProvider.getLTPByPairs() with pairs
   *    - Identify tokens with null/invalid LTP
   *    - Log reasons (no_data, wrong_exchange, invalid_token, etc.)
   * 4. Generate statistics and report
   * 5. If auto_cleanup=true and dry_run=false:
   *    - Set is_active=false for invalid instruments
   *    - Log cleanup actions
   * 
   * @param filters - Filter criteria for instruments
   * @param vortexProvider - Vortex provider service instance
   * @returns Validation results with statistics and invalid instruments list
   */
  async validateAndCleanupInstruments(
    filters: {
      exchange?: string;
      instrument_name?: string;
      symbol?: string;
      option_type?: string;
      batch_size?: number;
      auto_cleanup?: boolean;
      dry_run?: boolean;
      include_invalid_list?: boolean;
    },
    vortexProvider: any,
  ): Promise<{
    summary: {
      total_instruments: number;
      tested: number;
      valid_ltp: number;
      invalid_ltp: number;
      errors: number;
    };
    invalid_instruments: Array<{
      token: number;
      exchange: string;
      symbol: string;
      instrument_name: string;
      reason: string;
      ltp_response: any;
    }>;
    cleanup: {
      deactivated: number;
      removed: number;
    };
    batches_processed: number;
  }> {
    try {
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log('[VortexInstrumentService] Starting validation with filters:', filters);

      const batchSize = filters.batch_size || 1000;
      const autoCleanup = filters.auto_cleanup || false;
      const dryRun = filters.dry_run !== false; // Default to true

      // Step 1: Query instruments from DB with filters
      const queryBuilder = this.vortexInstrumentRepo.createQueryBuilder('instrument');

      if (filters.exchange) {
        queryBuilder.andWhere('instrument.exchange = :exchange', {
          exchange: filters.exchange,
        });
      }

      if (filters.instrument_name) {
        queryBuilder.andWhere('instrument.instrument_name = :instrument_name', {
          instrument_name: filters.instrument_name,
        });
      }

      if (filters.symbol) {
        queryBuilder.andWhere('instrument.symbol ILIKE :symbol', {
          symbol: `%${filters.symbol}%`,
        });
      }

      if (filters.option_type !== undefined) {
        if (filters.option_type === null) {
          queryBuilder.andWhere('instrument.option_type IS NULL');
        } else {
          queryBuilder.andWhere('instrument.option_type = :option_type', {
            option_type: filters.option_type,
          });
        }
      }

      // Only validate active instruments
      queryBuilder.andWhere('instrument.is_active = :is_active', { is_active: true });

      const allInstruments = await queryBuilder.getMany();
      const totalInstruments = allInstruments.length;

      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        `[VortexInstrumentService] Found ${totalInstruments} instruments to validate`,
      );

      if (totalInstruments === 0) {
        return {
          summary: {
            total_instruments: 0,
            tested: 0,
            valid_ltp: 0,
            invalid_ltp: 0,
            errors: 0,
          },
          invalid_instruments: [],
          cleanup: { deactivated: 0, removed: 0 },
          batches_processed: 0,
        };
      }

      // Step 2: Group into batches
      const batches: VortexInstrument[][] = [];
      for (let i = 0; i < allInstruments.length; i += batchSize) {
        batches.push(allInstruments.slice(i, i + batchSize));
      }

      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        `[VortexInstrumentService] Processing ${batches.length} batches of up to ${batchSize} instruments each`,
      );

      // Step 3: Process each batch
      const invalidInstruments: Array<{
        token: number;
        exchange: string;
        symbol: string;
        instrument_name: string;
        reason: string;
        ltp_response: any;
      }> = [];
      let validLtpCount = 0;
      let invalidLtpCount = 0;
      let errorCount = 0;

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} instruments`,
        );

        try {
          // Build exchange-token pairs using authoritative exchange from DB
          const pairs: Array<{
            exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
            token: string | number;
          }> = [];

          const allowedExchanges = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);

          for (const instrument of batch) {
            // Normalize exchange using same logic as provider for consistency
            const normalizedEx = this.normalizeExchange(instrument.exchange || '');
            if (normalizedEx && allowedExchanges.has(normalizedEx)) {
              pairs.push({
                exchange: normalizedEx as any,
                token: instrument.token,
              });
              // Console for easy debugging
              // eslint-disable-next-line no-console
              console.log(
                `[VortexInstrumentService] Mapped token ${instrument.token} to exchange ${normalizedEx} (original: ${instrument.exchange})`,
              );
            } else {
              // Instrument with invalid/unresolved exchange
              invalidInstruments.push({
                token: instrument.token,
                exchange: instrument.exchange || 'UNKNOWN',
                symbol: instrument.symbol || '',
                instrument_name: instrument.instrument_name || '',
                reason: 'invalid_exchange',
                ltp_response: null,
              });
              invalidLtpCount++;
              // Console for easy debugging
              // eslint-disable-next-line no-console
              console.log(
                `[VortexInstrumentService] Instrument ${instrument.token} has invalid/unresolved exchange: ${instrument.exchange} (normalized: ${normalizedEx || 'null'})`,
              );
            }
          }

          if (pairs.length === 0) {
            // Console for easy debugging
            // eslint-disable-next-line no-console
            console.log(
              `[VortexInstrumentService] Batch ${batchIndex + 1} has no valid pairs, skipping`,
            );
            continue;
          }

          // Call vortexProvider.getLTPByPairs() with pairs
          // Console for easy debugging
          // eslint-disable-next-line no-console
          console.log(
            `[VortexInstrumentService] Fetching LTP for ${pairs.length} pairs in batch ${batchIndex + 1}`,
          );
          const ltpResults = await vortexProvider.getLTPByPairs(pairs);

          // Identify tokens with null/invalid LTP
          // Use normalized exchange for pair key matching
          const pairKeyToInstrument = new Map<string, VortexInstrument>();
          for (const instrument of batch) {
            const normalizedEx = this.normalizeExchange(instrument.exchange || '');
            if (normalizedEx && allowedExchanges.has(normalizedEx)) {
              const pairKey = `${normalizedEx}-${instrument.token}`;
              pairKeyToInstrument.set(pairKey, instrument);
            }
          }

          for (const [pairKey, ltpData] of Object.entries(ltpResults)) {
            const instrument = pairKeyToInstrument.get(pairKey);
            if (!instrument) continue;

            const lastPrice = (ltpData as any)?.last_price;
            const hasValidLtp =
              Number.isFinite(lastPrice) && lastPrice !== null && lastPrice > 0;

            if (hasValidLtp) {
              validLtpCount++;
              // Console for easy debugging
              // eslint-disable-next-line no-console
              console.log(
                `[VortexInstrumentService] Instrument ${instrument.token} (${instrument.symbol}) has valid LTP: ${lastPrice}`,
              );
            } else {
              invalidLtpCount++;
              const reason = lastPrice === null ? 'no_ltp_data' : 'invalid_ltp_value';
              invalidInstruments.push({
                token: instrument.token,
                exchange: instrument.exchange || 'UNKNOWN',
                symbol: instrument.symbol || '',
                instrument_name: instrument.instrument_name || '',
                reason,
                ltp_response: ltpData,
              });
              // Console for easy debugging
              // eslint-disable-next-line no-console
              console.log(
                `[VortexInstrumentService] Instrument ${instrument.token} (${instrument.symbol}) has invalid LTP: reason=${reason}, response=${JSON.stringify(ltpData)}`,
              );
            }
          }

          // Check for instruments in batch that weren't in LTP results
          // Use normalized exchange for pair key matching
          for (const instrument of batch) {
            const normalizedEx = this.normalizeExchange(instrument.exchange || '');
            if (!normalizedEx || !allowedExchanges.has(normalizedEx)) continue;

            const pairKey = `${normalizedEx}-${instrument.token}`;
            if (!(pairKey in ltpResults)) {
              invalidLtpCount++;
              invalidInstruments.push({
                token: instrument.token,
                exchange: instrument.exchange || 'UNKNOWN',
                symbol: instrument.symbol || '',
                instrument_name: instrument.instrument_name || '',
                reason: 'missing_from_response',
                ltp_response: null,
              });
              // Console for easy debugging
              // eslint-disable-next-line no-console
              console.log(
                `[VortexInstrumentService] Instrument ${instrument.token} (${instrument.symbol}) missing from LTP response`,
              );
            }
          }
        } catch (batchError) {
          errorCount++;
          // Console for easy debugging
          // eslint-disable-next-line no-console
          console.error(
            `[VortexInstrumentService] Error processing batch ${batchIndex + 1}:`,
            batchError,
          );
          this.logger.error(
            `[VortexInstrumentService] Error processing batch ${batchIndex + 1}`,
            batchError,
          );
          // Mark all instruments in this batch as having errors
          for (const instrument of batch) {
            invalidInstruments.push({
              token: instrument.token,
              exchange: instrument.exchange || 'UNKNOWN',
              symbol: instrument.symbol || '',
              instrument_name: instrument.instrument_name || '',
              reason: 'batch_error',
              ltp_response: { error: batchError.message },
            });
            invalidLtpCount++;
          }
        }

        // Rate limiting: wait 1 second between batches to respect Vortex rate limits
        if (batchIndex < batches.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Step 4: Generate statistics
      const summary = {
        total_instruments: totalInstruments,
        tested: totalInstruments,
        valid_ltp: validLtpCount,
        invalid_ltp: invalidLtpCount,
        errors: errorCount,
      };

      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log('[VortexInstrumentService] Validation summary:', summary);

      // Step 5: Cleanup if requested
      let deactivatedCount = 0;
      let removedCount = 0;

      if (autoCleanup && !dryRun && invalidInstruments.length > 0) {
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Starting cleanup: deactivating ${invalidInstruments.length} invalid instruments`,
        );

        const invalidTokens = invalidInstruments.map((inv) => inv.token);

        // Deactivate invalid instruments using query builder for better reliability
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Deactivating ${invalidTokens.length} invalid instruments`,
        );
        
        const updateResult = await this.vortexInstrumentRepo
          .createQueryBuilder()
          .update(VortexInstrument)
          .set({ is_active: false })
          .where('token IN (:...tokens)', { tokens: invalidTokens })
          .execute();
        
        deactivatedCount = updateResult.affected || 0;
        
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Deactivation query executed: affected=${deactivatedCount}, expected=${invalidTokens.length}`,
        );
        
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Cleanup completed: ${deactivatedCount} instruments deactivated`,
        );
        this.logger.log(
          `[VortexInstrumentService] Deactivated ${deactivatedCount} invalid instruments`,
        );
      } else if (autoCleanup && dryRun) {
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Dry run mode: would deactivate ${invalidInstruments.length} instruments`,
        );
      }

      return {
        summary,
        invalid_instruments: invalidInstruments,
        cleanup: {
          deactivated: deactivatedCount,
          removed: removedCount,
        },
        batches_processed: batches.length,
      };
    } catch (error) {
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.error('[VortexInstrumentService] Validation error:', error);
      this.logger.error('[VortexInstrumentService] Validation failed', error);
      throw error;
    }
  }

  /**
   * Delete all inactive instruments from the database
   * 
   * Permanently removes all instruments where is_active = false.
   * This operation cannot be undone, so use with caution.
   * 
   * @returns Number of deleted instruments
   */
  async deleteInactiveInstruments(): Promise<number> {
    try {
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log('[VortexInstrumentService] Starting deletion of inactive instruments');

      // First, count how many will be deleted
      const count = await this.vortexInstrumentRepo.count({
        where: { is_active: false },
      });

      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        `[VortexInstrumentService] Found ${count} inactive instruments to delete`,
      );

      if (count === 0) {
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          '[VortexInstrumentService] No inactive instruments to delete',
        );
        return 0;
      }

      // Delete all inactive instruments using query builder for better reliability
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        `[VortexInstrumentService] Executing delete query for ${count} inactive instruments`,
      );
      
      const deleteResult = await this.vortexInstrumentRepo
        .createQueryBuilder()
        .delete()
        .from(VortexInstrument)
        .where('is_active = :isActive', { isActive: false })
        .execute();

      const deletedCount = deleteResult.affected || 0;
      
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        `[VortexInstrumentService] Delete query executed: affected=${deletedCount}, expected=${count}`,
      );

      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        `[VortexInstrumentService] Successfully deleted ${deletedCount} inactive instruments`,
      );
      this.logger.log(
        `[VortexInstrumentService] Deleted ${deletedCount} inactive instruments`,
      );

      return deletedCount;
    } catch (error) {
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.error('[VortexInstrumentService] Error deleting inactive instruments:', error);
      this.logger.error(
        '[VortexInstrumentService] Failed to delete inactive instruments',
        error,
      );
      throw error;
    }
  }
}
