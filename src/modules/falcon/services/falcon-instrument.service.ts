import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { FalconInstrument } from '../entities/falcon-instrument.entity';
import { Instrument } from '../../../entities/instrument.entity';
import { InstrumentMapping } from '../../../entities/instrument-mapping.entity';
import { KiteProviderService } from '../../../providers/kite-provider.service';

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
}


