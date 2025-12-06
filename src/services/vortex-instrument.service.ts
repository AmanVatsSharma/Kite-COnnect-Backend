import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { VortexInstrument } from '../entities/vortex-instrument.entity';
import { InstrumentMapping } from '../entities/instrument-mapping.entity';
import { VortexProviderService } from '../providers/vortex-provider.service';
import { RedisService } from './redis.service';
import { RequestBatchingService } from './request-batching.service';

// Ambient declarations for environments missing DOM/lib typings
declare const console: any;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;

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
    private requestBatchingService: RequestBatchingService,
  ) {}

  /**
   * Sync Vortex instruments from CSV
   * Downloads CSV from Vortex API and syncs to database
   */
  async syncVortexInstruments(
    exchange?: string,
    csvUrl?: string,
    onProgress?: (p: {
      phase: 'init' | 'fetch_csv' | 'upsert' | 'complete';
      total?: number;
      processed?: number;
      synced?: number;
      updated?: number;
      errors?: number;
      lastMessage?: string;
    }) => void,
  ): Promise<{ synced: number; updated: number; total?: number }> {
    try {
      this.logger.log(
        `[VortexInstrumentService] Starting Vortex instrument sync for exchange=${exchange || 'all'}`,
      );
      onProgress?.({ phase: 'init', lastMessage: 'Starting Vortex instrument sync' });

      // Get instruments from Vortex provider
      const instruments = await this.vortexProvider.getInstruments(exchange, {
        csvUrl,
      });

      if (!instruments || instruments.length === 0) {
        this.logger.warn(
          '[VortexInstrumentService] No instruments received from Vortex provider',
        );
        onProgress?.({
          phase: 'complete',
          total: 0,
          processed: 0,
          synced: 0,
          updated: 0,
          errors: 0,
          lastMessage: 'No instruments received from provider',
        });
        return { synced: 0, updated: 0, total: 0 };
      }

      this.logger.log(
        `[VortexInstrumentService] Received ${instruments.length} instruments from Vortex CSV`,
      );
      onProgress?.({
        phase: 'fetch_csv',
        total: instruments.length,
        processed: 0,
        synced: 0,
        updated: 0,
        errors: 0,
        lastMessage: `Fetched ${instruments.length} instruments from CSV`,
      });

      let synced = 0;
      let updated = 0;
      let processed = 0;
      let errors = 0;

      onProgress?.({
        phase: 'upsert',
        total: instruments.length,
        processed,
        synced,
        updated,
        errors,
        lastMessage: 'Beginning upsert of instruments',
      });

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
                is_active: true, // Reactivate instrument on sync
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
          errors++;
          this.logger.error(
            `[VortexInstrumentService] Failed to process instrument token=${vortexInstrument.token}`,
            error,
          );
        }
        processed++;
        // Emit progress periodically
        if (processed % 500 === 0) {
          onProgress?.({
            phase: 'upsert',
            total: instruments.length,
            processed,
            synced,
            updated,
            errors,
            lastMessage: `Upsert progress ${processed}/${instruments.length}`,
          });
        }
      }

      this.logger.log(
        `[VortexInstrumentService] Sync completed. Synced: ${synced}, Updated: ${updated}`,
      );
      onProgress?.({
        phase: 'complete',
        total: instruments.length,
        processed,
        synced,
        updated,
        errors,
        lastMessage: 'Sync complete',
      });
      return { synced, updated, total: instruments.length };
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentService] Error syncing Vortex instruments',
        error,
      );
      onProgress?.({
        phase: 'complete',
        total: 0,
        processed: 0,
        synced: 0,
        updated: 0,
        errors: 1,
        lastMessage: `Error: ${(error as any)?.message || 'unknown'}`,
      });
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
    q?: string;
  }): Promise<{ instruments: VortexInstrument[]; total: number }> {
    try {
      const queryBuilder =
        this.vortexInstrumentRepo.createQueryBuilder('instrument');

      if (filters?.q && filters.q.trim()) {
        const query = filters.q.trim();
        if (query.length >= 2) {
          queryBuilder.andWhere(
            `(instrument.symbol ILIKE :q OR instrument.instrument_name ILIKE :q)`,
            { q: `%${query}%` },
          );
        } else {
          queryBuilder.andWhere('instrument.symbol ILIKE :q', {
            q: `%${query}%`,
          });
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
    query?: string; // Free-text symbol search (matches v.symbol via ILIKE / FTS)
    underlying_symbol?: string; // Exact underlying symbol (e.g., NIFTY, BANKNIFTY, GOLD)
    symbol?: string; // Exact symbol match (e.g., RELIANCE)
    exchange?: string[]; // Multiple exchanges
    instrument_type?: string[]; // EQUITIES, OPTSTK, OPTIDX, etc.
    option_type?: 'CE' | 'PE'; // For options
    options_only?: boolean; // If true, restrict to rows with option_type IS NOT NULL
    expiry_from?: string; // YYYYMMDD
    expiry_to?: string; // YYYYMMDD
    strike_min?: number;
    strike_max?: number;
    limit?: number; // Default 50, max 500
    offset?: number;
    sort_by?: 'symbol' | 'strike_price' | 'expiry_date';
    sort_order?: 'asc' | 'desc';
    detailed?: boolean; // Return minimal or full data (reserved for future use)
    skip_count?: boolean; // Skip expensive count() when only probing
    only_active?: boolean; // When true, restrict to v.is_active = true; otherwise include all
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
      const qb = this.vortexInstrumentRepo.createQueryBuilder('v');

      // Control whether we restrict to active instruments or not.
      // By default, we do NOT filter by is_active, so callers see the full universe
      // (matching vortex_instruments stats). Callers that require only active rows
      // (e.g., validation/cleanup or strict ltp_only listings) should pass only_active=true.
      if (filters.only_active) {
        qb.where('v.is_active = :active', { active: true });
      }

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

      // Exact underlying symbol filter (used by trading-style F&O search)
      if (filters.underlying_symbol && filters.underlying_symbol.trim()) {
        const underlying = filters.underlying_symbol.trim().toUpperCase();
        qb.andWhere('v.symbol = :underlyingSymbol', {
          underlyingSymbol: underlying,
        });
      }

      // Exact symbol match (used by searchVortexInstruments for direct lookup)
      if (filters.symbol && filters.symbol.trim()) {
        const exactSymbol = filters.symbol.trim().toUpperCase();
        qb.andWhere('v.symbol = :exactSymbol', {
          exactSymbol: exactSymbol,
        });
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
      if (filters.options_only) {
        qb.andWhere('v.option_type IS NOT NULL');
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

      // Get total count for pagination (optional skip for probe/ltp_only)
      let total = 0;
      if (!filters.skip_count) {
        total = await qb.getCount();
      }

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
      const hasMore = filters.skip_count ? instruments.length === limit : offset + limit < total;

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
        total: filters.skip_count ? -1 : total,
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
   * Build EXCHANGE-TOKEN pairs from instrument list (authoritative DB exchange).
   */
  public buildPairsFromInstruments(
    instruments: VortexInstrument[],
  ): Array<{ exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'; token: string }> {
    try {
      const allowed = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);
      const pairs: Array<{ exchange: any; token: string }> = [];
      for (const i of instruments || []) {
        const ex = String(i?.exchange || '').toUpperCase();
        const tok = String(i?.token ?? '').trim();
        if (allowed.has(ex) && /^\d+$/.test(tok)) {
          pairs.push({ exchange: ex, token: tok });
        }
      }
      return pairs as any;
    } catch (e) {
      this.logger.warn('[VortexInstrumentService] buildPairsFromInstruments failed', e as any);
      return [];
    }
  }

  /**
   * Hydrate LTP by EXCHANGE-TOKEN pairs via provider (cache-first internally).
   */
  public async hydrateLtpByPairs(
    pairs: Array<{ exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'; token: string | number }>,
  ): Promise<Record<string, { last_price: number | null }>> {
    try {
      if (!pairs || pairs.length === 0) return {};
      // Use centralized request batching to optimize Vortex API calls (1/sec gate)
      return await this.requestBatchingService.getLtpByPairs(pairs as any, this.vortexProvider);
    } catch (e) {
      this.logger.warn('[VortexInstrumentService] hydrateLtpByPairs failed', e as any);
      return {};
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

      // Use optimized query with prefix matching for autocomplete
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
   * Fetch instrument details only (no LTP) for a list of tokens.
   * Optimized in 1000-sized batches. Returns a map keyed by token.
   */
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
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.error('[VortexInstrumentService] Error in getVortexInstrumentDetails', error);
      this.logger.error('[VortexInstrumentService] getVortexInstrumentDetails failed', error);
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

      // 3) No implicit fallback: unresolved tokens are left out per backend semantics

      // 4) Fetch LTP using explicit pairs via batching service
      const ltpByPairKey = await this.requestBatchingService.getLtpByPairs(pairs, this.vortexProvider);

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

    const result = await this.getCachedOrExecute(
      cacheKey,
      300, // 5 minutes TTL
      async () => {
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
          .select(['v.token', 'v.symbol', 'v.exchange', 'v.instrument_name', 'v.description'])
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
      probe_attempts?: number;
      probe_interval_ms?: number;
      require_consensus?: number;
      safe_cleanup?: boolean;
      limit?: number;
    },
    onProgress?: (p: {
      event: 'start' | 'batch_start' | 'batch_complete' | 'complete';
      total_instruments?: number;
      batch_index?: number;
      batches?: number;
      batch_size?: number;
      valid_so_far?: number;
      invalid_so_far?: number;
      indeterminate_so_far?: number;
      lastMessage?: string;
    }) => void,
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
      description?: string | null;
      expiry_date?: string | null;
      option_type?: string | null;
      strike_price?: number | null;
      tick?: number | null;
      lot_size?: number | null;
      reason: string;
      ltp_response: any;
    }>;
    cleanup: {
      deactivated: number;
      removed: number;
    };
    batches_processed: number;
    diagnostics?: {
      reason_counts: Record<string, number>;
      resolution: { requested: number; included: number; invalid_exchange: number; missing_from_response: number };
      attempts?: number;
      require_consensus?: number;
      probe_interval_ms?: number;
      indeterminate?: number;
    };
  }> {
    try {
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log('[VortexInstrumentService] Starting validation with filters:', filters);

      const batchSize = filters.batch_size || 1000;
      const autoCleanup = filters.auto_cleanup || false;
      const dryRun = filters.dry_run !== false; // Default to true
      const probeAttempts = Math.max(1, Number(filters.probe_attempts ?? 3));
      const probeIntervalMs = Math.max(1000, Number(filters.probe_interval_ms ?? 1000));
      const requireConsensus = Math.max(1, Math.min(Number(filters.require_consensus ?? 2), probeAttempts));
      const safeCleanup = !(filters.safe_cleanup === false);

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
      // Map high-level instrument_type to specific instrument_name codes if provided
      if (!filters.instrument_name && filters['instrument_type']) {
        const type = String(filters['instrument_type']).toUpperCase();
        const map: Record<string, string[]> = {
          EQUITIES: ['EQ'],
          FUTURES: ['FUTSTK', 'FUTIDX', 'FUTCUR', 'FUTCOM'],
          OPTIONS: ['OPTSTK', 'OPTIDX', 'OPTCUR'],
          COMMODITIES: ['FUTCOM'],
          CURRENCY: ['FUTCUR', 'OPTCUR'],
        };
        const names = map[type] || [];
        if (names.length) {
          queryBuilder.andWhere('instrument.instrument_name IN (:...names)', {
            names,
          });
        }
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

      let allInstruments = await queryBuilder.getMany();
      if (filters?.limit && Number(filters.limit) > 0) {
        allInstruments = allInstruments.slice(0, Number(filters.limit));
      }
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
      onProgress?.({
        event: 'start',
        total_instruments: totalInstruments,
        batches: batches.length,
        batch_size: batchSize,
        lastMessage: `Starting validation of ${totalInstruments} instruments in ${batches.length} batches`,
      });

      // Step 3: Process each batch
      const invalidInstruments: Array<{
        token: number;
        exchange: string;
        symbol: string;
        instrument_name: string;
        description?: string | null;
        expiry_date?: string | null;
        option_type?: string | null;
        strike_price?: number | null;
        tick?: number | null;
        lot_size?: number | null;
        reason: string;
        ltp_response: any;
      }> = [];
      let validLtpCount = 0;
      let invalidLtpCount = 0;
      let errorCount = 0;
      const reasonCounts: Record<string, number> = {};
      let totalPairsIncluded = 0;
      let totalInvalidExchange = 0;
      let totalMissingFromResponse = 0;
      let totalIndeterminate = 0;

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} instruments`,
        );
        onProgress?.({
          event: 'batch_start',
          batch_index: batchIndex + 1,
          batches: batches.length,
          batch_size: batch.length,
          valid_so_far: validLtpCount,
          invalid_so_far: invalidLtpCount,
          indeterminate_so_far: totalIndeterminate,
          lastMessage: `Batch ${batchIndex + 1} started`,
        });

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
                description: instrument.description || null,
                expiry_date: instrument.expiry_date || null,
                option_type: instrument.option_type || null,
                strike_price: instrument.strike_price || null,
                tick: instrument.tick || null,
                lot_size: instrument.lot_size || null,
                reason: 'invalid_exchange',
                ltp_response: null,
              });
              invalidLtpCount++;
              totalInvalidExchange++;
              reasonCounts['invalid_exchange'] = (reasonCounts['invalid_exchange'] || 0) + 1;
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
            onProgress?.({
              event: 'batch_complete',
              batch_index: batchIndex + 1,
              batches: batches.length,
              batch_size: batch.length,
              valid_so_far: validLtpCount,
              invalid_so_far: invalidLtpCount,
              indeterminate_so_far: totalIndeterminate,
              lastMessage: `Batch ${batchIndex + 1} skipped (no valid pairs)`,
            });
            continue;
          }

          // Multi-probe with consensus and >=1s spacing between Vortex calls
          // Build map for quick lookups
          const pairKeyToInstrument = new Map<string, VortexInstrument>();
          for (const instrument of batch) {
            const normalizedEx = this.normalizeExchange(instrument.exchange || '');
            if (normalizedEx && allowedExchanges.has(normalizedEx)) {
              const pairKey = `${normalizedEx}-${instrument.token}`;
              pairKeyToInstrument.set(pairKey, instrument);
            }
          }
          const tokenState: Record<number, { hits: number; probes: number }> = {};
          for (const instrument of batch) {
            tokenState[instrument.token] = { hits: 0, probes: 0 };
          }
          let attemptHadEmpty = false;
          for (let attempt = 0; attempt < probeAttempts; attempt++) {
            // Console for easy debugging
            // eslint-disable-next-line no-console
            console.log(`[VortexInstrumentService] Probe ${attempt + 1}/${probeAttempts} for ${pairs.length} pairs (batch ${batchIndex + 1})`);
            // Use centralized batching service instead of direct provider call
            const ltpResults = await this.requestBatchingService.getLtpByPairs(pairs, this.vortexProvider);
            totalPairsIncluded += pairs.length;
            const keysCount = Object.keys(ltpResults || {}).length;
            if (keysCount === 0) attemptHadEmpty = true;
            // For every instrument in this batch, count probe and hits
            for (const instrument of batch) {
              const normalizedEx = this.normalizeExchange(instrument.exchange || '');
              if (!normalizedEx || !allowedExchanges.has(normalizedEx)) continue;
              const pairKey = `${normalizedEx}-${instrument.token}`;
              tokenState[instrument.token].probes += 1;
              const ltpData: any = (ltpResults && (ltpResults as any)[pairKey]) || undefined;
              const lastPrice = ltpData?.last_price;
              if (Number.isFinite(lastPrice) && lastPrice > 0) {
                tokenState[instrument.token].hits += 1;
              }
            }
            if (attempt < probeAttempts - 1) {
              await new Promise((r) => setTimeout(r, probeIntervalMs));
            }
          }
          // Classify after probes
          for (const instrument of batch) {
            const normalizedEx = this.normalizeExchange(instrument.exchange || '');
            if (!normalizedEx || !allowedExchanges.has(normalizedEx)) continue;
            const state = tokenState[instrument.token] || { hits: 0, probes: 0 };
            if (state.hits > 0) {
              validLtpCount++;
              continue;
            }
            // No hits across attempts
            if (attemptHadEmpty) {
              // Mark as indeterminate, do not count as invalid for cleanup
              totalIndeterminate++;
              invalidInstruments.push({
                token: instrument.token,
                exchange: instrument.exchange || 'UNKNOWN',
                symbol: instrument.symbol || '',
                instrument_name: instrument.instrument_name || '',
                description: instrument.description || null,
                expiry_date: instrument.expiry_date || null,
                option_type: instrument.option_type || null,
                strike_price: instrument.strike_price || null,
                tick: instrument.tick || null,
                lot_size: instrument.lot_size || null,
                reason: 'indeterminate',
                ltp_response: null,
              });
              reasonCounts['indeterminate'] = (reasonCounts['indeterminate'] || 0) + 1;
            } else if (state.probes >= requireConsensus) {
              invalidLtpCount++;
              invalidInstruments.push({
                token: instrument.token,
                exchange: instrument.exchange || 'UNKNOWN',
                symbol: instrument.symbol || '',
                instrument_name: instrument.instrument_name || '',
                description: instrument.description || null,
                expiry_date: instrument.expiry_date || null,
                option_type: instrument.option_type || null,
                strike_price: instrument.strike_price || null,
                tick: instrument.tick || null,
                lot_size: instrument.lot_size || null,
                reason: 'no_ltp_data',
                ltp_response: null,
              });
              reasonCounts['no_ltp_data'] = (reasonCounts['no_ltp_data'] || 0) + 1;
            } else {
              totalIndeterminate++;
              invalidInstruments.push({
                token: instrument.token,
                exchange: instrument.exchange || 'UNKNOWN',
                symbol: instrument.symbol || '',
                instrument_name: instrument.instrument_name || '',
                description: instrument.description || null,
                expiry_date: instrument.expiry_date || null,
                option_type: instrument.option_type || null,
                strike_price: instrument.strike_price || null,
                tick: instrument.tick || null,
                lot_size: instrument.lot_size || null,
                reason: 'indeterminate',
                ltp_response: null,
              });
              reasonCounts['indeterminate'] = (reasonCounts['indeterminate'] || 0) + 1;
            }
          }
          onProgress?.({
            event: 'batch_complete',
            batch_index: batchIndex + 1,
            batches: batches.length,
            batch_size: batch.length,
            valid_so_far: validLtpCount,
            invalid_so_far: invalidLtpCount,
            indeterminate_so_far: totalIndeterminate,
            lastMessage: `Batch ${batchIndex + 1} complete`,
          });
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
            reasonCounts['batch_error'] = (reasonCounts['batch_error'] || 0) + 1;
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
        const candidates = safeCleanup
          ? invalidInstruments.filter((x) => x.reason !== 'indeterminate')
          : invalidInstruments;
        const invalidTokens = candidates.map((inv) => inv.token);
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Starting cleanup: deactivating ${invalidTokens.length} invalid instruments${safeCleanup ? ' (safe_cleanup enabled)' : ''}`,
        );
        if (safeCleanup && candidates.length !== invalidInstruments.length) {
          // eslint-disable-next-line no-console
          console.log(`[VortexInstrumentService] Safe cleanup: skipping ${invalidInstruments.length - candidates.length} indeterminate instruments`);
        }

        // Deactivate invalid instruments using query builder for better reliability
        // Batch processing to avoid SQL parameter limits (PostgreSQL has ~65535 parameter limit)
        // Process in chunks of 10000 tokens at a time
        const BATCH_SIZE = 10000;
        const tokenBatches: number[][] = [];
        for (let i = 0; i < invalidTokens.length; i += BATCH_SIZE) {
          tokenBatches.push(invalidTokens.slice(i, i + BATCH_SIZE));
        }

        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Deactivating ${invalidTokens.length} invalid instruments in ${tokenBatches.length} batches`,
        );
        
        // Process each batch
        for (let batchIdx = 0; batchIdx < tokenBatches.length; batchIdx++) {
          const tokenBatch = tokenBatches[batchIdx];
          // Console for easy debugging
          // eslint-disable-next-line no-console
          console.log(
            `[VortexInstrumentService] Processing deactivation batch ${batchIdx + 1}/${tokenBatches.length} with ${tokenBatch.length} tokens`,
          );
          
          try {
            const updateResult = await this.vortexInstrumentRepo
              .createQueryBuilder()
              .update(VortexInstrument)
              .set({ is_active: false })
              .where('token IN (:...tokens)', { tokens: tokenBatch })
              .execute();
            
            const batchAffected = updateResult.affected || 0;
            deactivatedCount += batchAffected;
            
            // Console for easy debugging
            // eslint-disable-next-line no-console
            console.log(
              `[VortexInstrumentService] Batch ${batchIdx + 1} deactivated: ${batchAffected} instruments`,
            );
          } catch (batchError) {
            // Console for easy debugging
            // eslint-disable-next-line no-console
            console.error(
              `[VortexInstrumentService] Error deactivating batch ${batchIdx + 1}:`,
              batchError,
            );
            this.logger.error(
              `[VortexInstrumentService] Failed to deactivate batch ${batchIdx + 1}`,
              batchError,
            );
            // Continue with next batch instead of failing completely
          }
        }
        
        // Console for easy debugging
        // eslint-disable-next-line no-console
        console.log(
          `[VortexInstrumentService] Deactivation completed: ${deactivatedCount} instruments deactivated out of ${invalidTokens.length} expected`,
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

      onProgress?.({
        event: 'complete',
        total_instruments: totalInstruments,
        batches: batches.length,
        batch_size: batchSize,
        valid_so_far: validLtpCount,
        invalid_so_far: invalidLtpCount,
        indeterminate_so_far: totalIndeterminate,
        lastMessage: 'Validation complete',
      });

      return {
        summary,
        invalid_instruments: invalidInstruments,
        cleanup: {
          deactivated: deactivatedCount,
          removed: removedCount,
        },
        batches_processed: batches.length,
        diagnostics: {
          reason_counts: reasonCounts,
          resolution: {
            requested: totalInstruments,
            included: totalPairsIncluded,
            invalid_exchange: totalInvalidExchange,
            missing_from_response: totalMissingFromResponse,
          },
          attempts: probeAttempts,
          require_consensus: requireConsensus,
          probe_interval_ms: probeIntervalMs,
          indeterminate: totalIndeterminate,
        },
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

  /**
   * Permanently delete instruments by filter (exchange and/or instrument_name).
   * At least one filter is required to prevent accidental full-table deletion.
   * Returns number of deleted rows.
   */
  async deleteInstrumentsByFilter(opts: {
    exchange?: string;
    instrument_name?: string;
    instrument_type?: string;
  }): Promise<number> {
    const { exchange, instrument_name, instrument_type } = opts || {};
    if (!exchange && !instrument_name && !instrument_type) {
      throw new Error('At least one filter (exchange or instrument_name) is required');
    }
    try {
      // Build delete query with filters
      const qb = this.vortexInstrumentRepo
        .createQueryBuilder()
        .delete()
        .from(VortexInstrument as any);
      const whereParts: string[] = [];
      const params: any = {};
      if (exchange) {
        whereParts.push('exchange = :exchange');
        params.exchange = exchange;
      }
      if (instrument_name) {
        whereParts.push('instrument_name = :instrument_name');
        params.instrument_name = instrument_name;
      }
      if (!instrument_name && instrument_type) {
        const type = String(instrument_type).toUpperCase();
        const map: Record<string, string[]> = {
          EQUITIES: ['EQ'],
          FUTURES: ['FUTSTK', 'FUTIDX', 'FUTCUR', 'FUTCOM'],
          OPTIONS: ['OPTSTK', 'OPTIDX', 'OPTCUR'],
          COMMODITIES: ['FUTCOM'],
          CURRENCY: ['FUTCUR', 'OPTCUR'],
        };
        const names = map[type] || [];
        if (names.length) {
          whereParts.push('instrument_name IN (:...names)');
          params.names = names;
        }
      }
      if (whereParts.length) {
        qb.where(whereParts.join(' AND '), params);
      }
      const result = await qb.execute();
      const deleted = result.affected || 0;
      // eslint-disable-next-line no-console
      console.log('[VortexInstrumentService] deleteInstrumentsByFilter:', {
        exchange,
        instrument_name,
        instrument_type,
        deleted,
      });
      return deleted;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[VortexInstrumentService] deleteInstrumentsByFilter failed', error);
      throw error;
    }
  }
}
