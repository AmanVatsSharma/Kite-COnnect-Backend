import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Instrument } from '../../entities/instrument.entity';
import { MarketData } from '../../entities/market-data.entity';
import { InstrumentMapping } from '../../entities/instrument-mapping.entity';
import { Subscription } from '../../entities/subscription.entity';
import { MarketDataProviderResolverService } from '../../services/market-data-provider-resolver.service';
import { MarketDataProvider } from '../../providers/market-data.provider';
import { RedisService } from '../../services/redis.service';
import { RequestBatchingService } from '../../services/request-batching.service';
import { MarketDataGateway } from '../../gateways/market-data.gateway';
import { VortexInstrumentService } from '../../services/vortex-instrument.service';
import { Inject, forwardRef } from '@nestjs/common';

@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  constructor(
    @InjectRepository(Instrument)
    private instrumentRepository: Repository<Instrument>,
    @InjectRepository(MarketData)
    private marketDataRepository: Repository<MarketData>,
    @InjectRepository(Subscription)
    private subscriptionRepository: Repository<Subscription>,
    @InjectRepository(InstrumentMapping)
    private mappingRepository: Repository<InstrumentMapping>,
    private providerResolver: MarketDataProviderResolverService,
    private redisService: RedisService,
    private requestBatchingService: RequestBatchingService,
    private vortexInstrumentService: VortexInstrumentService,
    @Inject(forwardRef(() => MarketDataGateway)) private marketDataGateway: MarketDataGateway,
  ) {}

  async syncInstruments(exchange?: string, opts?: { provider?: 'kite' | 'vortex'; csv_url?: string; headers?: Record<string, any>; apiKey?: string }): Promise<{ synced: number; updated: number }> {
    try {
      const httpHeaders = opts?.headers || {};
      const providerInstance = await this.providerResolver.resolveForHttp(httpHeaders, opts?.apiKey);
      const providerName = ((httpHeaders['x-provider'] || opts?.provider) as string | undefined)?.toString().toLowerCase();
      const effectiveProvider: 'kite' | 'vortex' = providerName === 'vortex' ? 'vortex' : 'kite';
      this.logger.log(`Starting instrument sync for exchange=${exchange || 'all'} via provider=${providerName}`);

      // Delegate Vortex sync to VortexInstrumentService
      if (effectiveProvider === 'vortex') {
        this.logger.log('Delegating Vortex instrument sync to VortexInstrumentService');
        return await this.vortexInstrumentService.syncVortexInstruments(exchange, opts?.csv_url);
      }

      // Continue with Kite sync logic
      const instruments = await providerInstance.getInstruments(exchange, { csvUrl: opts?.csv_url });
      let synced = 0;
      let updated = 0;

      for (const kiteInstrument of instruments) {
        const existingInstrument = await this.instrumentRepository.findOne({
          where: { instrument_token: kiteInstrument.instrument_token },
        });

        if (existingInstrument) {
          // Update existing instrument
          await this.instrumentRepository.update(
            { instrument_token: kiteInstrument.instrument_token },
            {
              exchange_token: kiteInstrument.exchange_token,
              tradingsymbol: kiteInstrument.tradingsymbol,
              name: kiteInstrument.name,
              last_price: kiteInstrument.last_price || 0,
              expiry: kiteInstrument.expiry,
              strike: kiteInstrument.strike || 0,
              tick_size: kiteInstrument.tick_size || 0.05,
              lot_size: kiteInstrument.lot_size || 1,
              instrument_type: kiteInstrument.instrument_type,
              segment: kiteInstrument.segment,
              exchange: kiteInstrument.exchange,
            }
          );
          updated++;
        } else {
          // Create new instrument
          const newInstrument = this.instrumentRepository.create({
            instrument_token: kiteInstrument.instrument_token,
            exchange_token: kiteInstrument.exchange_token,
            tradingsymbol: kiteInstrument.tradingsymbol,
            name: kiteInstrument.name,
            last_price: kiteInstrument.last_price || 0,
            expiry: kiteInstrument.expiry,
            strike: kiteInstrument.strike || 0,
            tick_size: kiteInstrument.tick_size || 0.05,
            lot_size: kiteInstrument.lot_size || 1,
            instrument_type: kiteInstrument.instrument_type,
            segment: kiteInstrument.segment,
            exchange: kiteInstrument.exchange,
          });
          await this.instrumentRepository.save(newInstrument);
          synced++;
        }
        // Upsert instrument mapping: provider_token for Kite only
        // Vortex mapping is handled by VortexInstrumentService
        try {
          const providerToken = String(kiteInstrument.instrument_token);
          const existingMap = await this.mappingRepository.findOne({ where: { provider: 'kite', provider_token: providerToken } });
          if (existingMap) {
            if (existingMap.instrument_token !== kiteInstrument.instrument_token) {
              existingMap.instrument_token = kiteInstrument.instrument_token;
              await this.mappingRepository.save(existingMap);
            }
          } else {
            await this.mappingRepository.save(this.mappingRepository.create({
              provider: 'kite',
              provider_token: providerToken,
              instrument_token: kiteInstrument.instrument_token,
            }));
          }
        } catch (e) {
          this.logger.warn(`Mapping upsert failed for token ${kiteInstrument.instrument_token}`, e as any);
        }
      }

      this.logger.log(`Instrument sync completed. Synced: ${synced}, Updated: ${updated}`);
      return { synced, updated };
    } catch (error) {
      this.logger.error('Error syncing instruments', error);
      throw error;
    }
  }

  async getInstruments(filters?: {
    exchange?: string;
    instrument_type?: string;
    segment?: string;
    is_active?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ instruments: Instrument[]; total: number }> {
    try {
      const queryBuilder = this.instrumentRepository.createQueryBuilder('instrument');

      if (filters?.exchange) {
        queryBuilder.andWhere('instrument.exchange = :exchange', { exchange: filters.exchange });
      }

      if (filters?.instrument_type) {
        queryBuilder.andWhere('instrument.instrument_type = :instrument_type', { 
          instrument_type: filters.instrument_type 
        });
      }

      if (filters?.segment) {
        queryBuilder.andWhere('instrument.segment = :segment', { segment: filters.segment });
      }

      if (filters?.is_active !== undefined) {
        queryBuilder.andWhere('instrument.is_active = :is_active', { is_active: filters.is_active });
      }

      const total = await queryBuilder.getCount();

      if (filters?.limit) {
        queryBuilder.limit(filters.limit);
      }

      if (filters?.offset) {
        queryBuilder.offset(filters.offset);
      }

      queryBuilder.orderBy('instrument.tradingsymbol', 'ASC');

      const instruments = await queryBuilder.getMany();

      return { instruments, total };
    } catch (error) {
      this.logger.error('Error fetching instruments', error);
      throw error;
    }
  }

  async getInstrumentByToken(instrumentToken: number): Promise<Instrument | null> {
    try {
      return await this.instrumentRepository.findOne({
        where: { instrument_token: instrumentToken },
      });
    } catch (error) {
      this.logger.error(`Error fetching instrument ${instrumentToken}`, error);
      throw error;
    }
  }

  async searchInstruments(query: string, limit: number = 20): Promise<Instrument[]> {
    try {
      return await this.instrumentRepository
        .createQueryBuilder('instrument')
        .where('instrument.tradingsymbol LIKE :query', { query: `%${query}%` })
        .orWhere('instrument.name LIKE :query', { query: `%${query}%` })
        .andWhere('instrument.is_active = :is_active', { is_active: true })
        .limit(limit)
        .orderBy('instrument.tradingsymbol', 'ASC')
        .getMany();
    } catch (error) {
      this.logger.error('Error searching instruments', error);
      throw error;
    }
  }

  /**
   * Resolve a human symbol to a stored instrument.
   * Accepts forms like "NSE:SBIN", "SBIN", or "SBIN-EQ" with optional segment.
   * Returns best match and candidate list for disambiguation.
   */
  async resolveSymbol(symbol: string, segmentHint?: string): Promise<{ instrument: Instrument | null; candidates: Instrument[] }>{
    const raw = symbol.trim().toUpperCase();
    let seg: string | undefined = segmentHint?.toUpperCase();
    let sym = raw;
    // Parse segment prefix e.g., NSE:SBIN or NSE_SBIN
    const prefixMatch = raw.match(/^(NSE|BSE|NFO|CDS|MCX)[:_]/);
    if (prefixMatch) {
      seg = prefixMatch[1];
      sym = raw.slice(prefixMatch[0].length);
    }
    // Allow SBIN-EQ form => symbol=SBIN, instrument_type=EQ
    let instrumentType: string | undefined;
    const hyphen = sym.split('-');
    if (hyphen.length === 2) {
      sym = hyphen[0];
      instrumentType = hyphen[1];
    }

    // Build query
    const qb = this.instrumentRepository.createQueryBuilder('i')
      .where('i.tradingsymbol = :sym', { sym })
      .orWhere('i.tradingsymbol LIKE :like', { like: `${sym}-%` });
    if (seg) qb.andWhere('i.segment = :seg', { seg });
    if (instrumentType) qb.andWhere('i.instrument_type = :it', { it: instrumentType });
    qb.orderBy('i.segment', 'ASC');

    const list = await qb.getMany();
    if (list.length === 0) {
      // fallback fuzzy
      const fuzzy = await this.instrumentRepository.createQueryBuilder('i')
        .where('i.tradingsymbol LIKE :q', { q: `%${sym}%` })
        .andWhere('i.is_active = :ia', { ia: true })
        .limit(10)
        .getMany();
      return { instrument: null, candidates: fuzzy };
    }

    // Prefer exact segment if provided, else first
    let best = list[0];
    if (seg) {
      const exactSeg = list.find(i => i.segment?.toUpperCase() === seg);
      if (exactSeg) best = exactSeg;
    }
    return { instrument: best, candidates: list };
  }

  async getQuotes(instrumentTokens: number[], headers?: Record<string, any>, apiKey?: string): Promise<any> {
    try {
      // Check cache first
      const cachedQuotes = await this.redisService.getCachedQuote(
        instrumentTokens.map(token => token.toString())
      );

      if (cachedQuotes) {
        this.logger.log(`Returning cached quotes for ${instrumentTokens.length} instruments`);
        return cachedQuotes;
      }

      // Use request batching service for efficient API calls
      const provider = await this.providerResolver.resolveForHttp(headers || {}, apiKey);
      const quotes = await this.requestBatchingService.getQuote(
        instrumentTokens.map(token => token.toString()),
        provider,
      );

      // Cache the result
      await this.redisService.cacheQuote(
        instrumentTokens.map(token => token.toString()),
        quotes,
        30
      );

      this.logger.log(`Fetched quotes for ${instrumentTokens.length} instruments`);
      return quotes;
    } catch (error) {
      this.logger.error('Error fetching quotes', error);
      throw error;
    }
  }

  async getLTP(instrumentTokens: number[], headers?: Record<string, any>, apiKey?: string): Promise<any> {
    try {
      const provider = await this.providerResolver.resolveForHttp(headers || {}, apiKey);
      const ltp = await this.requestBatchingService.getLTP(
        instrumentTokens.map(token => token.toString()),
        provider,
      );

      this.logger.log(`Fetched LTP for ${instrumentTokens.length} instruments`);
      return ltp;
    } catch (error) {
      this.logger.error('Error fetching LTP', error);
      throw error;
    }
  }

  async getOHLC(instrumentTokens: number[], headers?: Record<string, any>, apiKey?: string): Promise<any> {
    try {
      const provider = await this.providerResolver.resolveForHttp(headers || {}, apiKey);
      const ohlc = await this.requestBatchingService.getOHLC(
        instrumentTokens.map(token => token.toString()),
        provider,
      );

      this.logger.log(`Fetched OHLC for ${instrumentTokens.length} instruments`);
      return ohlc;
    } catch (error) {
      this.logger.error('Error fetching OHLC', error);
      throw error;
    }
  }

  async getHistoricalData(
    instrumentToken: number,
    fromDate: string,
    toDate: string,
    interval: string,
    headers?: Record<string, any>,
    apiKey?: string,
  ): Promise<any> {
    try {
      const provider = await this.providerResolver.resolveForHttp(headers || {}, apiKey);
      const historicalData = await provider.getHistoricalData(
        instrumentToken,
        fromDate,
        toDate,
        interval,
      );

      this.logger.log(`Fetched historical data for instrument ${instrumentToken}`);
      return historicalData;
    } catch (error) {
      this.logger.error('Error fetching historical data', error);
      throw error;
    }
  }

  async storeMarketData(instrumentToken: number, data: any): Promise<void> {
    try {
      const marketData = this.marketDataRepository.create({
        instrument_token: instrumentToken,
        last_price: data.last_price || 0,
        open: data.ohlc?.open || 0,
        high: data.ohlc?.high || 0,
        low: data.ohlc?.low || 0,
        close: data.ohlc?.close || 0,
        volume: data.volume || 0,
        ohlc_open: data.ohlc?.open || 0,
        ohlc_high: data.ohlc?.high || 0,
        ohlc_low: data.ohlc?.low || 0,
        ohlc_close: data.ohlc?.close || 0,
        ohlc_volume: data.ohlc?.volume || 0,
        timestamp: new Date(),
        data_type: 'live',
      });

      try {
        await this.marketDataRepository.save(marketData);
        this.logger.log(`Stored market data for instrument ${instrumentToken}`);
      } catch (dbError) {
        // Log database error but don't block broadcasting
        this.logger.warn(`Failed to store market data in DB for token ${instrumentToken}: ${dbError.message}. Continuing with broadcast.`);
      }

      // Cache the data (non-blocking)
      try {
        await this.redisService.cacheMarketData(instrumentToken, data, 60);
        await this.redisService.set(`last_tick:${instrumentToken}`, data, 300);
      } catch (cacheError) {
        this.logger.warn(`Failed to cache market data: ${cacheError.message}`);
      }

      // Always broadcast to WebSocket clients (even if DB save failed)
      await this.marketDataGateway.broadcastMarketData(instrumentToken, data);
    } catch (error) {
      this.logger.error('Error storing market data', error);
      // Don't throw - allow tick processing to continue
    }
  }

  async getLastTick(instrumentToken: number): Promise<any> {
    try {
      return await this.redisService.get(`last_tick:${instrumentToken}`);
    } catch (e) {
      this.logger.error('Error fetching last tick', e);
      return null;
    }
  }

  async getMarketDataHistory(
    instrumentToken: number,
    limit: number = 100,
    offset: number = 0,
  ): Promise<{ data: MarketData[]; total: number }> {
    try {
      const queryBuilder = this.marketDataRepository
        .createQueryBuilder('marketData')
        .where('marketData.instrument_token = :instrumentToken', { instrumentToken })
        .orderBy('marketData.timestamp', 'DESC');

      const total = await queryBuilder.getCount();

      const data = await queryBuilder
        .limit(limit)
        .offset(offset)
        .getMany();

      return { data, total };
    } catch (error) {
      this.logger.error('Error fetching market data history', error);
      throw error;
    }
  }

  async subscribeToInstrument(
    userId: string,
    instrumentToken: number,
    subscriptionType: 'live' | 'historical' | 'both' = 'live',
  ): Promise<Subscription> {
    try {
      const existingSubscription = await this.subscriptionRepository.findOne({
        where: {
          user_id: userId,
          instrument_token: instrumentToken,
        },
      });

      if (existingSubscription) {
        existingSubscription.is_active = true;
        existingSubscription.subscription_type = subscriptionType;
        return await this.subscriptionRepository.save(existingSubscription);
      }

      const subscription = this.subscriptionRepository.create({
        user_id: userId,
        instrument_token: instrumentToken,
        subscription_type: subscriptionType,
        is_active: true,
      });

      return await this.subscriptionRepository.save(subscription);
    } catch (error) {
      this.logger.error('Error creating subscription', error);
      throw error;
    }
  }

  async unsubscribeFromInstrument(userId: string, instrumentToken: number): Promise<void> {
    try {
      await this.subscriptionRepository.update(
        { user_id: userId, instrument_token: instrumentToken },
        { is_active: false }
      );
    } catch (error) {
      this.logger.error('Error unsubscribing from instrument', error);
      throw error;
    }
  }

  async getUserSubscriptions(userId: string): Promise<Subscription[]> {
    try {
      return await this.subscriptionRepository.find({
        where: { user_id: userId, is_active: true },
        relations: ['instrument'],
      });
    } catch (error) {
      this.logger.error('Error fetching user subscriptions', error);
      throw error;
    }
  }

  async getSystemStats(): Promise<any> {
    try {
      const [instrumentCount, marketDataCount, subscriptionCount] = await Promise.all([
        this.instrumentRepository.count(),
        this.marketDataRepository.count(),
        this.subscriptionRepository.count({ where: { is_active: true } }),
      ]);

      const batchStats = this.requestBatchingService.getBatchStats();
      const connectionStats = this.marketDataGateway.getConnectionStats();

      return {
        instruments: instrumentCount,
        marketDataRecords: marketDataCount,
        activeSubscriptions: subscriptionCount,
        batchStats,
        connectionStats,
      };
    } catch (error) {
      this.logger.error('Error fetching system stats', error);
      throw error;
    }
  }
}
