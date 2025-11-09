import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { FalconInstrument } from '../entities/falcon-instrument.entity';
import { Instrument } from '../../../entities/instrument.entity';
import { InstrumentMapping } from '../../../entities/instrument-mapping.entity';
import { KiteProviderService } from '../../../providers/kite-provider.service';
import { FalconProviderAdapter } from './falcon-provider.adapter';

@Injectable()
export class FalconInstrumentService {
  private readonly logger = new Logger(FalconInstrumentService.name);

  constructor(
    @InjectRepository(FalconInstrument)
    private falconInstrumentRepo: Repository<FalconInstrument>,
    @InjectRepository(Instrument)
    private instrumentRepo: Repository<Instrument>,
    @InjectRepository(InstrumentMapping)
    private mappingRepo: Repository<InstrumentMapping>,
    private kite: KiteProviderService,
    private falconAdapter: FalconProviderAdapter,
  ) {}

  async syncFalconInstruments(
    exchange?: string,
    csvUrl?: string,
    onProgress?: (progress: { processed: number; created: number; updated: number }) => Promise<void> | void,
  ): Promise<{ synced: number; updated: number }> {
    let synced = 0;
    let updated = 0;
    try {
      this.logger.log(
        `[FalconInstrumentService] Starting Falcon instrument sync for exchange=${exchange || 'all'}`,
      );
      const rows = await this.kite.getInstruments(exchange);
      if (!Array.isArray(rows) || rows.length === 0) {
        this.logger.warn('[FalconInstrumentService] No instruments received from Kite provider');
        return { synced, updated };
      }
      this.logger.log(`[FalconInstrumentService] Received ${rows.length} instruments from Kite`);
      let processed = 0;
      for (const row of rows) {
        processed++;
        try {
          const token = Number(row.instrument_token);
          if (!Number.isFinite(token)) continue;
          const existing = await this.falconInstrumentRepo.findOne({ where: { instrument_token: token } });
          const payload: Partial<FalconInstrument> = {
            instrument_token: token,
            exchange_token: Number(row.exchange_token) || 0,
            tradingsymbol: String(row.tradingsymbol || ''),
            name: String(row.name || ''),
            last_price: Number(row.last_price) || 0,
            expiry: String(row.expiry || ''),
            strike: Number(row.strike) || 0,
            tick_size: Number(row.tick_size) || 0.05,
            lot_size: Number(row.lot_size) || 1,
            instrument_type: String(row.instrument_type || ''),
            segment: String(row.segment || ''),
            exchange: String(row.exchange || ''),
            is_active: true,
          };
          // Compute description (equities, futures, options)
          try {
            payload.description = this.buildDescription(payload as FalconInstrument);
          } catch {}
          if (existing) {
            await this.falconInstrumentRepo.update({ instrument_token: token }, payload);
            updated++;
          } else {
            await this.falconInstrumentRepo.save(this.falconInstrumentRepo.create(payload as any));
            synced++;
          }
          // Upsert instrument mapping for Kite provider
          try {
            const providerToken = String(token);
            const mapExisting = await this.mappingRepo.findOne({
              where: { provider: 'kite', provider_token: providerToken },
            });
            if (mapExisting) {
              if (mapExisting.instrument_token !== token) {
                mapExisting.instrument_token = token;
                await this.mappingRepo.save(mapExisting);
              }
            } else {
              await this.mappingRepo.save(
                this.mappingRepo.create({
                  provider: 'kite',
                  provider_token: providerToken,
                  instrument_token: token,
                }),
              );
            }
          } catch (mapErr) {
            this.logger.warn(`[FalconInstrumentService] Mapping upsert failed for ${token}`, mapErr as any);
          }
        } catch (e) {
          this.logger.warn('[FalconInstrumentService] Failed to process a row', e as any);
        }
        if (onProgress && processed % 1000 === 0) {
          await onProgress({ processed, created: synced, updated });
        }
      }
      this.logger.log(
        `[FalconInstrumentService] Sync completed. Synced: ${synced}, Updated: ${updated}`,
      );
      return { synced, updated };
    } catch (error) {
      this.logger.error('[FalconInstrumentService] Error syncing Falcon instruments', error as any);
      return { synced, updated };
    }
  }

  async getFalconInstruments(filters?: {
    exchange?: string;
    instrument_type?: string;
    segment?: string;
    is_active?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ instruments: FalconInstrument[]; total: number }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    if (filters?.exchange) qb.andWhere('fi.exchange = :ex', { ex: filters.exchange });
    if (filters?.instrument_type) qb.andWhere('fi.instrument_type = :it', { it: filters.instrument_type });
    if (filters?.segment) qb.andWhere('fi.segment = :seg', { seg: filters.segment });
    if (typeof filters?.is_active === 'boolean')
      qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    const total = await qb.getCount();
    if (filters?.limit) qb.limit(filters.limit);
    if (filters?.offset) qb.offset(filters.offset);
    qb.orderBy('fi.tradingsymbol', 'ASC');
    const instruments = await qb.getMany();
    return { instruments, total };
  }

  async getFalconInstrumentByToken(token: number): Promise<FalconInstrument | null> {
    return this.falconInstrumentRepo.findOne({ where: { instrument_token: token } });
  }

  async getFalconInstrumentsBatch(tokens: number[]): Promise<Record<number, FalconInstrument>> {
    const list = await this.falconInstrumentRepo.find({ where: { instrument_token: In(tokens) } as any });
    const out: Record<number, FalconInstrument> = {};
    list.forEach((i) => (out[i.instrument_token] = i));
    return out;
  }

  async searchFalconInstruments(q: string, limit = 20): Promise<FalconInstrument[]> {
    const normalized = (q || '').trim().toUpperCase();
    if (!normalized) return [];
    return await this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .where('UPPER(fi.tradingsymbol) LIKE :q', { q: `%${normalized}%` })
      .orWhere('UPPER(fi.name) LIKE :q', { q: `%${normalized}%` })
      .andWhere('fi.is_active = true')
      .limit(limit)
      .orderBy('fi.tradingsymbol', 'ASC')
      .getMany();
  }

  async getFalconInstrumentStats(): Promise<{
    total: number;
    by_exchange: Record<string, number>;
    by_type: Record<string, number>;
    active: number;
    inactive: number;
  }> {
    const total = await this.falconInstrumentRepo.count();
    const active = await this.falconInstrumentRepo.count({ where: { is_active: true } as any });
    const inactive = total - active;
    const by_exchange_rows = await this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .select('fi.exchange', 'exchange')
      .addSelect('COUNT(*)', 'count')
      .groupBy('fi.exchange')
      .getRawMany<{ exchange: string; count: string }>();
    const by_type_rows = await this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .select('fi.instrument_type', 'instrument_type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('fi.instrument_type')
      .getRawMany<{ instrument_type: string; count: string }>();
    const by_exchange: Record<string, number> = {};
    by_exchange_rows.forEach((r) => (by_exchange[r.exchange] = Number(r.count)));
    const by_type: Record<string, number> = {};
    by_type_rows.forEach((r) => (by_type[r.instrument_type] = Number(r.count)));
    return { total, by_exchange, by_type, active, inactive };
  }

  async getEquities(filters: {
    exchange?: string;
    q?: string;
    is_active?: boolean;
    ltp_only?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Array<FalconInstrument & { last_price_live?: number | null }>; total: number }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    qb.where(`(fi.instrument_type = 'EQ' OR fi.segment IN ('NSE','BSE'))`);
    if (filters?.exchange) qb.andWhere('fi.exchange = :ex', { ex: filters.exchange });
    if (typeof filters?.is_active === 'boolean') qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    if (filters?.q) {
      const q = `%${String(filters.q).trim().toUpperCase()}%`;
      qb.andWhere('(UPPER(fi.tradingsymbol) LIKE :q OR UPPER(fi.name) LIKE :q)', { q });
    }
    const total = await qb.getCount();
    const limit = Math.max(1, Math.min(1000, filters?.limit ?? 100));
    const offset = Math.max(0, filters?.offset ?? 0);
    qb.orderBy('fi.tradingsymbol', 'ASC').limit(limit).offset(offset);
    const items = await qb.getMany();
    // LTP enrichment
    let withLive = items.map((i) => ({ ...i, last_price_live: null as number | null }));
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      const ltp = await this.falconAdapter.getLTP(tokens);
      withLive = items.map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        return { ...i, last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null };
      });
      if (filters?.ltp_only) {
        withLive = withLive.filter((x) => Number.isFinite(x.last_price_live) && (x.last_price_live as any) > 0);
      }
    } catch {}
    return { items: withLive, total };
  }

  async getFutures(filters: {
    symbol?: string;
    exchange?: string;
    expiry_from?: string;
    expiry_to?: string;
    is_active?: boolean;
    ltp_only?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Array<FalconInstrument & { last_price_live?: number | null }>; total: number }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    qb.where(`(fi.instrument_type = 'FUT' OR fi.segment ILIKE '%FUT%')`);
    if (filters?.exchange) qb.andWhere('fi.exchange = :ex', { ex: filters.exchange });
    if (filters?.symbol) qb.andWhere('fi.tradingsymbol = :sym', { sym: filters.symbol });
    if (filters?.expiry_from) qb.andWhere('fi.expiry >= :ef', { ef: filters.expiry_from });
    if (filters?.expiry_to) qb.andWhere('fi.expiry <= :et', { et: filters.expiry_to });
    if (typeof filters?.is_active === 'boolean') qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    const total = await qb.getCount();
    const limit = Math.max(1, Math.min(1000, filters?.limit ?? 100));
    const offset = Math.max(0, filters?.offset ?? 0);
    qb.orderBy('fi.tradingsymbol', 'ASC').limit(limit).offset(offset);
    const items = await qb.getMany();
    let withLive = items.map((i) => ({ ...i, last_price_live: null as number | null }));
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      const ltp = await this.falconAdapter.getLTP(tokens);
      withLive = items.map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        return { ...i, last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null };
      });
      if (filters?.ltp_only) {
        withLive = withLive.filter((x) => Number.isFinite(x.last_price_live) && (x.last_price_live as any) > 0);
      }
    } catch {}
    return { items: withLive, total };
  }

  async getOptions(filters: {
    symbol?: string;
    exchange?: string;
    expiry_from?: string;
    expiry_to?: string;
    strike_min?: number;
    strike_max?: number;
    option_type?: 'CE' | 'PE';
    is_active?: boolean;
    ltp_only?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Array<FalconInstrument & { last_price_live?: number | null }>; total: number }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    qb.where(`(fi.instrument_type IN ('CE','PE') OR fi.segment ILIKE '%OPT%')`);
    if (filters?.exchange) qb.andWhere('fi.exchange = :ex', { ex: filters.exchange });
    if (filters?.symbol) qb.andWhere('fi.tradingsymbol = :sym', { sym: filters.symbol });
    if (filters?.expiry_from) qb.andWhere('fi.expiry >= :ef', { ef: filters.expiry_from });
    if (filters?.expiry_to) qb.andWhere('fi.expiry <= :et', { et: filters.expiry_to });
    if (typeof filters?.strike_min === 'number') qb.andWhere('fi.strike >= :smin', { smin: filters.strike_min });
    if (typeof filters?.strike_max === 'number') qb.andWhere('fi.strike <= :smax', { smax: filters.strike_max });
    if (filters?.option_type) qb.andWhere('fi.instrument_type = :ot', { ot: filters.option_type });
    if (typeof filters?.is_active === 'boolean') qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    const total = await qb.getCount();
    const limit = Math.max(1, Math.min(1000, filters?.limit ?? 100));
    const offset = Math.max(0, filters?.offset ?? 0);
    qb.orderBy('fi.tradingsymbol', 'ASC').limit(limit).offset(offset);
    const items = await qb.getMany();
    let withLive = items.map((i) => ({ ...i, last_price_live: null as number | null }));
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      const ltp = await this.falconAdapter.getLTP(tokens);
      withLive = items.map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        return { ...i, last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null };
      });
      if (filters?.ltp_only) {
        withLive = withLive.filter((x) => Number.isFinite(x.last_price_live) && (x.last_price_live as any) > 0);
      }
    } catch {}
    return { items: withLive, total };
  }

  async getCommodities(filters: {
    symbol?: string;
    exchange?: string; // default MCX at controller
    instrument_type?: string;
    is_active?: boolean;
    ltp_only?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Array<FalconInstrument & { last_price_live?: number | null }>; total: number }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    if (filters?.exchange) qb.where('fi.exchange = :ex', { ex: filters.exchange });
    else qb.where(`fi.exchange = 'MCX'`);
    if (filters?.symbol) qb.andWhere('fi.tradingsymbol = :sym', { sym: filters.symbol });
    if (filters?.instrument_type) qb.andWhere('fi.instrument_type = :it', { it: filters.instrument_type });
    if (typeof filters?.is_active === 'boolean') qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    const total = await qb.getCount();
    const limit = Math.max(1, Math.min(1000, filters?.limit ?? 100));
    const offset = Math.max(0, filters?.offset ?? 0);
    qb.orderBy('fi.tradingsymbol', 'ASC').limit(limit).offset(offset);
    const items = await qb.getMany();
    let withLive = items.map((i) => ({ ...i, last_price_live: null as number | null }));
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      const ltp = await this.falconAdapter.getLTP(tokens);
      withLive = items.map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        return { ...i, last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null };
      });
      if (filters?.ltp_only) {
        withLive = withLive.filter((x) => Number.isFinite(x.last_price_live) && (x.last_price_live as any) > 0);
      }
    } catch {}
    return { items: withLive, total };
  }

  async searchTickers(q: string, limit = 20, ltp_only = false) {
    const normalized = (q || '').trim().toUpperCase();
    if (!normalized) return [];
    const list = await this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .where('UPPER(fi.tradingsymbol) LIKE :q', { q: `%${normalized}%` })
      .orWhere('UPPER(fi.name) LIKE :q', { q: `%${normalized}%` })
      .andWhere('fi.is_active = true')
      .limit(Math.max(1, Math.min(200, limit)))
      .orderBy('fi.tradingsymbol', 'ASC')
      .getMany();
    const tokens = list.map((i) => String(i.instrument_token));
    let ltp: Record<string, any> = {};
    try {
      ltp = await this.falconAdapter.getLTP(tokens);
    } catch {}
    const out = list
      .map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        const last_price = Number.isFinite(lp) && lp > 0 ? lp : null;
        return {
          instrument_token: i.instrument_token,
          symbol: i.tradingsymbol,
          exchange: i.exchange,
          instrument_type: i.instrument_type,
          description: i.description,
          last_price,
        };
      })
      .filter((x) => (ltp_only ? Number.isFinite(x.last_price) && (x.last_price as any) > 0 : true));
    return out;
  }

  async getTickerBySymbol(symbol: string) {
    const sym = (symbol || '').trim().toUpperCase();
    if (!sym) return null;
    const row = await this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .where('fi.tradingsymbol = :sym', { sym })
      .orderBy('fi.tradingsymbol', 'ASC')
      .getOne();
    if (!row) return null;
    let last_price: number | null = null;
    try {
      const ltp = await this.falconAdapter.getLTP([String(row.instrument_token)]);
      const lp = Number(ltp?.[String(row.instrument_token)]?.last_price);
      last_price = Number.isFinite(lp) && lp > 0 ? lp : null;
    } catch {}
    return {
      instrument_token: row.instrument_token,
      symbol: row.tradingsymbol,
      exchange: row.exchange,
      instrument_type: row.instrument_type,
      description: row.description,
      last_price,
    };
  }
  async validateFalconInstruments(opts: {
    limit?: number;
    offset?: number;
    batchSize?: number;
    dry_run?: boolean;
    auto_cleanup?: boolean;
  }): Promise<{
    tested: number;
    invalid_instruments: number[];
    deactivated?: number;
  }> {
    const limit = Math.max(1, Math.min(10000, opts?.limit ?? 2000));
    const offset = Math.max(0, opts?.offset ?? 0);
    const batchSize = Math.max(10, Math.min(1000, opts?.batchSize ?? 200));
    const list = await this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .where('fi.is_active = true')
      .orderBy('fi.tradingsymbol', 'ASC')
      .limit(limit)
      .offset(offset)
      .getMany();
    const tokens = list.map((i) => i.instrument_token);
    const invalid: number[] = [];
    // Batch loop
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      try {
        const ltp = await this.kite.getLTP(batch.map((t) => String(t)));
        for (const t of batch) {
          const lp = Number(ltp?.[t]?.last_price);
          if (!Number.isFinite(lp) || lp <= 0) invalid.push(t);
        }
      } catch (e) {
        this.logger.warn(`[FalconInstrumentService] LTP validation batch failed`, e as any);
      }
    }
    let deactivated = 0;
    if (!opts?.dry_run && opts?.auto_cleanup && invalid.length) {
      try {
        await this.falconInstrumentRepo
          .createQueryBuilder()
          .update(FalconInstrument)
          .set({ is_active: false } as any)
          .where({ instrument_token: In(invalid) } as any)
          .execute();
        deactivated = invalid.length;
      } catch (e) {
        this.logger.warn('[FalconInstrumentService] Auto cleanup failed', e as any);
      }
    }
    return { tested: tokens.length, invalid_instruments: invalid, deactivated };
  }

  private buildDescription(i: FalconInstrument): string {
    const ex = (i.exchange || '').toUpperCase();
    const sym = (i.tradingsymbol || '').toUpperCase();
    const it = (i.instrument_type || '').toUpperCase();
    if (it === 'EQ' || i.segment?.toUpperCase() === 'NSE' || i.segment?.toUpperCase() === 'BSE') {
      return `${ex} ${sym} EQ`.trim();
    }
    // FUT/OPT with expiry (YYYY-MM-DD) -> DDMONYYYY
    const expiry = (i.expiry || '').trim();
    const ddMonYYYY = (() => {
      if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return '';
      const [y, m, d] = expiry.split('-').map((s) => parseInt(s, 10));
      const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
      const mon = months[(m || 1) - 1] || '';
      return `${String(d).padStart(2, '0')}${mon}${y}`;
    })();
    if (it === 'FUT' || i.segment?.toUpperCase().includes('FUT')) {
      return `${ex} ${sym} ${ddMonYYYY} FUT`.trim();
    }
    if (it === 'CE' || it === 'PE' || i.segment?.toUpperCase().includes('OPT')) {
      const strike = Number(i.strike) || 0;
      return `${ex} ${sym} ${ddMonYYYY} ${strike} ${it}`.trim();
    }
    // MCX/others
    return `${ex} ${sym} ${it}`.trim();
  }
}


