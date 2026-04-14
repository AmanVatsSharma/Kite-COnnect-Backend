/**
 * @file falcon-instrument.service.ts
 * @module falcon
 * @description Sync Kite Connect instruments into falcon_instruments with batched upserts, daily cron, retries, and optional reconciliation (Vortex-style).
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-03-28
 *
 * Notes:
 * - Requires Kite OAuth (KITE_ACCESS_TOKEN or Redis kite:access_token) for sync.
 * - Cron schedule: FALCON_INSTRUMENTS_CRON (default 09:45 IST) via FALCON_INSTRUMENTS_CRON_TZ.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { Repository, In, FindOptionsWhere } from 'typeorm';
import { randomUUID } from 'crypto';
import { FalconInstrument } from '@features/falcon/domain/falcon-instrument.entity';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { KiteProviderService } from '@features/kite-connect/infra/kite-provider.service';
import { FalconProviderAdapter } from '@features/falcon/infra/falcon-provider.adapter';
import { RedisService } from '@infra/redis/redis.service';

const UPSERT_CHUNK = 600;
const MAPPING_CHUNK = 800;
const CRON_JOB_NAME = 'falconInstrumentsDaily';

export type FalconInstrumentSyncResult = {
  synced: number;
  updated: number;
  reconciled?: number;
  skipped?: boolean;
  skipReason?: string;
};

export type FalconInstrumentSyncOptions = {
  /** When true, set is_active=false for DB rows not present in this dump (scoped by exchange if set). Default from FALCON_INSTRUMENT_RECONCILE. */
  reconcile?: boolean;
  /** Skip refreshSession + client check (tests or caller already verified Kite). */
  skipKitePreflight?: boolean;
};

@Injectable()
export class FalconInstrumentService implements OnModuleInit {
  private readonly logger = new Logger(FalconInstrumentService.name);

  /** Hardcoded popular Kite instrument trading symbols for the popular-instruments endpoint. */
  private static readonly POPULAR_SYMBOLS = [
    'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX',
    'RELIANCE', 'INFY', 'TCS', 'HDFCBANK', 'ICICIBANK', 'SBIN',
    'WIPRO', 'HCLTECH', 'AXISBANK', 'KOTAKBANK', 'LT',
    'BAJFINANCE', 'MARUTI', 'TATAMOTORS', 'ADANIENT',
    'GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS',
  ];

  constructor(
    @InjectRepository(FalconInstrument)
    private falconInstrumentRepo: Repository<FalconInstrument>,
    @InjectRepository(InstrumentMapping)
    private mappingRepo: Repository<InstrumentMapping>,
    private kite: KiteProviderService,
    private falconAdapter: FalconProviderAdapter,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    const enabled = this.isScheduledSyncEnabled();
    if (!enabled) {
      this.logger.log(
        '[FalconInstrumentService] Scheduled Falcon sync disabled (FALCON_INSTRUMENT_SYNC_ENABLED=false)',
      );
      return;
    }
    try {
      this.schedulerRegistry.deleteCronJob(CRON_JOB_NAME);
    } catch {
      // no existing job
    }
    const cronExpr = this.config.get<string>(
      'FALCON_INSTRUMENTS_CRON',
      '45 9 * * *',
    );
    const tz =
      this.config.get<string>('FALCON_INSTRUMENTS_CRON_TZ', 'Asia/Kolkata') ||
      'Asia/Kolkata';
    const job = new CronJob(
      cronExpr,
      () => {
        void this.runScheduledSyncWithRetries();
      },
      null,
      false,
      tz,
    );
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.logger.log(
      `[FalconInstrumentService] Registered daily sync cron "${cronExpr}" (${tz})`,
    );
  }

  private isScheduledSyncEnabled(): boolean {
    const raw = this.config.get<string>('FALCON_INSTRUMENT_SYNC_ENABLED', 'true');
    return String(raw).toLowerCase() !== 'false';
  }

  private reconcileDefault(): boolean {
    const raw = this.config.get<string>('FALCON_INSTRUMENT_RECONCILE', 'true');
    return String(raw).toLowerCase() !== 'false';
  }

  /** Daily job: refresh Kite session, full sync, retries on transport errors (not on missing credentials). */
  async runScheduledSyncWithRetries(): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.kite.refreshSession();
        if (!this.kite.isClientInitialized()) {
          this.logger.warn(
            `[FalconInstrumentService] Daily sync: Kite HTTP client not ready (missing credentials). IST ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — skipping.`,
          );
          return;
        }
        const result = await this.syncFalconInstruments(undefined, undefined, undefined, {
          reconcile: this.reconcileDefault(),
        });
        if (result.skipped) {
          this.logger.warn(
            `[FalconInstrumentService] Daily sync skipped: ${result.skipReason}`,
          );
          return;
        }
        this.logger.log(
          `[FalconInstrumentService] Daily sync completed (IST): synced=${result.synced} updated=${result.updated} reconciled=${result.reconciled ?? 0}`,
        );
        return;
      } catch (e) {
        this.logger.error(
          `[FalconInstrumentService] Daily sync attempt ${attempt}/${maxAttempts} failed`,
          e as Error,
        );
        const delay = Math.min(60000, 5000 * Math.pow(2, attempt - 1));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    this.logger.error(
      '[FalconInstrumentService] Daily Falcon instrument sync failed after retries',
    );
  }

  async syncFalconInstruments(
    exchange?: string,
    _csvUrl?: string,
    onProgress?: (progress: {
      processed: number;
      created: number;
      updated: number;
    }) => Promise<void> | void,
    opts?: FalconInstrumentSyncOptions,
  ): Promise<FalconInstrumentSyncResult> {
    let synced = 0;
    let updated = 0;
    let reconciled = 0;
    try {
      this.logger.log(
        `[FalconInstrumentService] Starting Falcon instrument sync for exchange=${exchange || 'all'}`,
      );
      if (!opts?.skipKitePreflight) {
        await this.kite.refreshSession();
        if (!this.kite.isClientInitialized()) {
          this.logger.warn(
            '[FalconInstrumentService] Kite client not initialized; sync aborted',
          );
          return {
            synced: 0,
            updated: 0,
            skipped: true,
            skipReason: 'kite_client_unavailable',
          };
        }
      }

      const rows = await this.kite.getInstruments(exchange);
      if (!Array.isArray(rows) || rows.length === 0) {
        this.logger.warn(
          '[FalconInstrumentService] No instruments received from Kite provider',
        );
        return {
          synced: 0,
          updated: 0,
          skipped: true,
          skipReason: 'no_rows_from_kite',
        };
      }
      this.logger.log(
        `[FalconInstrumentService] Received ${rows.length} instruments from Kite`,
      );

      const payloads: FalconInstrument[] = [];
      for (const row of rows) {
        const token = Number(row.instrument_token);
        if (!Number.isFinite(token)) continue;
        const payload = this.falconInstrumentRepo.create({
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
        } as FalconInstrument);
        try {
          payload.description = this.buildDescription(payload);
        } catch {
          payload.description = '';
        }
        payloads.push(payload);
      }

      const fetchedTokens = new Set(payloads.map((p) => p.instrument_token));
      let processed = 0;

      for (let i = 0; i < payloads.length; i += UPSERT_CHUNK) {
        const chunk = payloads.slice(i, i + UPSERT_CHUNK);
        const tokenIds = chunk.map((c) => c.instrument_token);
        let existingRows: { instrument_token: number }[] = [];
        try {
          existingRows = await this.falconInstrumentRepo.find({
            where: { instrument_token: In(tokenIds) },
            select: ['instrument_token'],
          });
        } catch (e) {
          this.logger.warn(
            '[FalconInstrumentService] Existing-token lookup failed for chunk',
            e as Error,
          );
        }
        const existingSet = new Set(
          existingRows.map((r) => r.instrument_token),
        );
        for (const c of chunk) {
          if (existingSet.has(c.instrument_token)) updated++;
          else synced++;
        }

        try {
          await this.falconInstrumentRepo.upsert(
            chunk.map((c) => ({ ...c })),
            {
              conflictPaths: ['instrument_token'],
              skipUpdateIfNoValuesChanged: false,
            },
          );
        } catch (e) {
          this.logger.error(
            '[FalconInstrumentService] falcon_instruments upsert chunk failed',
            e as Error,
          );
          throw e;
        }

        for (let m = 0; m < tokenIds.length; m += MAPPING_CHUNK) {
          const sub = tokenIds.slice(m, m + MAPPING_CHUNK);
          const mappingRows = sub.map((t) => ({
            provider: 'kite' as const,
            provider_token: String(t),
            instrument_token: t,
          }));
          try {
            await this.mappingRepo.upsert(mappingRows, {
              conflictPaths: ['provider', 'provider_token'],
              skipUpdateIfNoValuesChanged: false,
            });
          } catch (mapErr) {
            this.logger.warn(
              '[FalconInstrumentService] instrument_mappings upsert batch failed',
              mapErr as Error,
            );
          }
        }

        processed += chunk.length;
        if (onProgress && processed % 1000 === 0) {
          await onProgress({ processed, created: synced, updated });
        }
      }

      const wantReconcile =
        opts?.reconcile !== undefined ? opts.reconcile : this.reconcileDefault();
      if (wantReconcile && fetchedTokens.size > 0) {
        try {
          reconciled = await this.reconcileInactiveRows(fetchedTokens, exchange);
          if (reconciled > 0) {
            this.logger.log(
              `[FalconInstrumentService] Reconciliation deactivated ${reconciled} rows`,
            );
          }
        } catch (e) {
          this.logger.warn(
            '[FalconInstrumentService] Reconciliation pass failed',
            e as Error,
          );
        }
      }

      // Populate Redis symbol → token cache for WS resolution
      try {
        await this.populateSymbolCache(payloads);
      } catch (e) {
        this.logger.warn('[FalconInstrumentService] Symbol cache population failed (non-fatal)', e as Error);
      }

      this.logger.log(
        `[FalconInstrumentService] Sync completed. Synced: ${synced}, Updated: ${updated}`,
      );
      return { synced, updated, reconciled };
    } catch (error) {
      this.logger.error(
        '[FalconInstrumentService] Error syncing Falcon instruments',
        error as Error,
      );
      return { synced, updated, reconciled };
    }
  }

  /**
   * Populate Redis symbol → token cache: falcon:sym2tok:{EXCHANGE}:{SYMBOL} = instrument_token.
   * TTL: 86400s (refreshed on each sync). Used by resolveSymbolsToTokens for fast WS resolution.
   */
  private async populateSymbolCache(instruments: FalconInstrument[]): Promise<void> {
    if (!instruments.length) return;
    const CHUNK = 500;
    let count = 0;
    for (let i = 0; i < instruments.length; i += CHUNK) {
      const batch = instruments.slice(i, i + CHUNK);
      await Promise.all(
        batch.map((inst) =>
          Promise.resolve(
            this.redis.set(
              `falcon:sym2tok:${inst.exchange.toUpperCase()}:${inst.tradingsymbol.toUpperCase()}`,
              inst.instrument_token,
              86400,
            ),
          ).catch(() => {}),
        ),
      );
      count += batch.length;
    }
    this.logger.log(`[FalconInstrumentService] Symbol cache populated: ${count} entries`);
  }

  /**
   * Resolve trading symbols to Kite instrument tokens.
   * Tries Redis cache first; falls back to DB query.
   * Returns { symbol: token | null } — null when symbol not found.
   */
  async resolveSymbolsToTokens(
    symbols: string[],
    exchange?: string,
  ): Promise<Record<string, number | null>> {
    const result: Record<string, number | null> = {};
    if (!symbols.length) return result;

    for (const sym of symbols) {
      const upperSym = sym.toUpperCase();
      let token: number | null = null;

      // Try Redis cache first
      if (exchange) {
        try {
          const cached = await this.redis.get<number>(
            `falcon:sym2tok:${exchange.toUpperCase()}:${upperSym}`,
          );
          if (cached != null && Number.isFinite(Number(cached))) {
            token = Number(cached);
          }
        } catch {}
      }

      // DB fallback
      if (token == null) {
        try {
          const where: FindOptionsWhere<FalconInstrument> = {
            tradingsymbol: upperSym,
            is_active: true,
          };
          if (exchange) where.exchange = exchange.toUpperCase();
          const row = await this.falconInstrumentRepo.findOne({
            where,
            select: ['instrument_token'],
          });
          token = row?.instrument_token ?? null;
        } catch {}
      }

      result[sym] = token;
    }
    return result;
  }

  /**
   * Set is_active=false for rows that are active but whose token is missing from the latest Kite dump.
   * When exchange is set, only that exchange is scanned and deactivated (aligned with partial sync).
   */
  private async reconcileInactiveRows(
    fetchedTokens: Set<number>,
    exchange?: string,
  ): Promise<number> {
    const take = 2500;
    let offset = 0;
    let deactivated = 0;
    for (;;) {
      const where: FindOptionsWhere<FalconInstrument> = { is_active: true };
      if (exchange) where.exchange = exchange;
      const slice = await this.falconInstrumentRepo.find({
        where,
        select: ['instrument_token'],
        order: { instrument_token: 'ASC' },
        take,
        skip: offset,
      });
      if (!slice.length) break;
      const toDeactivate: number[] = [];
      for (const row of slice) {
        if (!fetchedTokens.has(row.instrument_token)) {
          toDeactivate.push(row.instrument_token);
        }
      }
      if (toDeactivate.length) {
        await this.falconInstrumentRepo
          .createQueryBuilder()
          .update(FalconInstrument)
          .set({ is_active: false })
          .where('instrument_token IN (:...ids)', { ids: toDeactivate })
          .execute();
        deactivated += toDeactivate.length;
      }
      if (slice.length < take) break;
      offset += take;
    }
    return deactivated;
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
    if (filters?.exchange)
      qb.andWhere('fi.exchange = :ex', { ex: filters.exchange });
    if (filters?.instrument_type)
      qb.andWhere('fi.instrument_type = :it', { it: filters.instrument_type });
    if (filters?.segment)
      qb.andWhere('fi.segment = :seg', { seg: filters.segment });
    if (typeof filters?.is_active === 'boolean')
      qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    const total = await qb.getCount();
    if (filters?.limit) qb.limit(filters.limit);
    if (filters?.offset) qb.offset(filters.offset);
    qb.orderBy('fi.tradingsymbol', 'ASC');
    const instruments = await qb.getMany();
    return { instruments, total };
  }

  async getFalconInstrumentByToken(
    token: number,
  ): Promise<FalconInstrument | null> {
    return this.falconInstrumentRepo.findOne({ where: { instrument_token: token } });
  }

  async getFalconInstrumentsBatch(
    tokens: number[],
  ): Promise<Record<number, FalconInstrument>> {
    const list = await this.falconInstrumentRepo.find({
      where: { instrument_token: In(tokens) } as any,
    });
    const out: Record<number, FalconInstrument> = {};
    list.forEach((i) => (out[i.instrument_token] = i));
    return out;
  }

  async searchFalconInstruments(
    q: string,
    limit = 20,
  ): Promise<FalconInstrument[]> {
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
    const active = await this.falconInstrumentRepo.count({
      where: { is_active: true } as any,
    });
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
    by_type_rows.forEach(
      (r) => (by_type[r.instrument_type] = Number(r.count)),
    );
    return { total, by_exchange, by_type, active, inactive };
  }

  async getEquities(filters: {
    exchange?: string;
    q?: string;
    is_active?: boolean;
    ltp_only?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<FalconInstrument & { last_price_live?: number | null }>;
    total: number;
  }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    qb.where(`(fi.instrument_type = 'EQ' OR fi.segment IN ('NSE','BSE'))`);
    if (filters?.exchange) qb.andWhere('fi.exchange = :ex', { ex: filters.exchange });
    if (typeof filters?.is_active === 'boolean')
      qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    if (filters?.q) {
      const q = `%${String(filters.q).trim().toUpperCase()}%`;
      qb.andWhere('(UPPER(fi.tradingsymbol) LIKE :q OR UPPER(fi.name) LIKE :q)', {
        q,
      });
    }
    const total = await qb.getCount();
    const limit = Math.max(1, Math.min(1000, filters?.limit ?? 100));
    const offset = Math.max(0, filters?.offset ?? 0);
    qb.orderBy('fi.tradingsymbol', 'ASC').limit(limit).offset(offset);
    const items = await qb.getMany();
    let withLive = items.map((i) => ({
      ...i,
      last_price_live: null as number | null,
    }));
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      const ltp = await this.falconAdapter.getLTP(tokens);
      withLive = items.map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        return {
          ...i,
          last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null,
        };
      });
      if (filters?.ltp_only) {
        withLive = withLive.filter(
          (x) =>
            Number.isFinite(x.last_price_live) && (x.last_price_live as any) > 0,
        );
      }
    } catch {
      /* enrichment optional */
    }
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
  }): Promise<{
    items: Array<FalconInstrument & { last_price_live?: number | null }>;
    total: number;
  }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    qb.where(`(fi.instrument_type = 'FUT' OR fi.segment ILIKE '%FUT%')`);
    if (filters?.exchange) qb.andWhere('fi.exchange = :ex', { ex: filters.exchange });
    if (filters?.symbol) qb.andWhere('fi.tradingsymbol = :sym', {
      sym: filters.symbol,
    });
    if (filters?.expiry_from) qb.andWhere('fi.expiry >= :ef', { ef: filters.expiry_from });
    if (filters?.expiry_to) qb.andWhere('fi.expiry <= :et', { et: filters.expiry_to });
    if (typeof filters?.is_active === 'boolean')
      qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    const total = await qb.getCount();
    const limit = Math.max(1, Math.min(1000, filters?.limit ?? 100));
    const offset = Math.max(0, filters?.offset ?? 0);
    qb.orderBy('fi.tradingsymbol', 'ASC').limit(limit).offset(offset);
    const items = await qb.getMany();
    let withLive = items.map((i) => ({
      ...i,
      last_price_live: null as number | null,
    }));
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      const ltp = await this.falconAdapter.getLTP(tokens);
      withLive = items.map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        return {
          ...i,
          last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null,
        };
      });
      if (filters?.ltp_only) {
        withLive = withLive.filter(
          (x) =>
            Number.isFinite(x.last_price_live) && (x.last_price_live as any) > 0,
        );
      }
    } catch {
      /* optional */
    }
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
  }): Promise<{
    items: Array<FalconInstrument & { last_price_live?: number | null }>;
    total: number;
  }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    qb.where(`(fi.instrument_type IN ('CE','PE') OR fi.segment ILIKE '%OPT%')`);
    if (filters?.exchange) qb.andWhere('fi.exchange = :ex', { ex: filters.exchange });
    if (filters?.symbol) qb.andWhere('fi.tradingsymbol = :sym', {
      sym: filters.symbol,
    });
    if (filters?.expiry_from) qb.andWhere('fi.expiry >= :ef', { ef: filters.expiry_from });
    if (filters?.expiry_to) qb.andWhere('fi.expiry <= :et', { et: filters.expiry_to });
    if (typeof filters?.strike_min === 'number')
      qb.andWhere('fi.strike >= :smin', { smin: filters.strike_min });
    if (typeof filters?.strike_max === 'number')
      qb.andWhere('fi.strike <= :smax', { smax: filters.strike_max });
    if (filters?.option_type)
      qb.andWhere('fi.instrument_type = :ot', { ot: filters.option_type });
    if (typeof filters?.is_active === 'boolean')
      qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    const total = await qb.getCount();
    const limit = Math.max(1, Math.min(1000, filters?.limit ?? 100));
    const offset = Math.max(0, filters?.offset ?? 0);
    qb.orderBy('fi.tradingsymbol', 'ASC').limit(limit).offset(offset);
    const items = await qb.getMany();
    let withLive = items.map((i) => ({
      ...i,
      last_price_live: null as number | null,
    }));
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      const ltp = await this.falconAdapter.getLTP(tokens);
      withLive = items.map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        return {
          ...i,
          last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null,
        };
      });
      if (filters?.ltp_only) {
        withLive = withLive.filter(
          (x) =>
            Number.isFinite(x.last_price_live) && (x.last_price_live as any) > 0,
        );
      }
    } catch {
      /* optional */
    }
    return { items: withLive, total };
  }

  async getCommodities(filters: {
    symbol?: string;
    exchange?: string;
    instrument_type?: string;
    is_active?: boolean;
    ltp_only?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<FalconInstrument & { last_price_live?: number | null }>;
    total: number;
  }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    if (filters?.exchange) qb.where('fi.exchange = :ex', { ex: filters.exchange });
    else qb.where(`fi.exchange = 'MCX'`);
    if (filters?.symbol) qb.andWhere('fi.tradingsymbol = :sym', {
      sym: filters.symbol,
    });
    if (filters?.instrument_type)
      qb.andWhere('fi.instrument_type = :it', { it: filters.instrument_type });
    if (typeof filters?.is_active === 'boolean')
      qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    const total = await qb.getCount();
    const limit = Math.max(1, Math.min(1000, filters?.limit ?? 100));
    const offset = Math.max(0, filters?.offset ?? 0);
    qb.orderBy('fi.tradingsymbol', 'ASC').limit(limit).offset(offset);
    const items = await qb.getMany();
    let withLive = items.map((i) => ({
      ...i,
      last_price_live: null as number | null,
    }));
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      const ltp = await this.falconAdapter.getLTP(tokens);
      withLive = items.map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        return {
          ...i,
          last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null,
        };
      });
      if (filters?.ltp_only) {
        withLive = withLive.filter(
          (x) =>
            Number.isFinite(x.last_price_live) && (x.last_price_live as any) > 0,
        );
      }
    } catch {
      /* optional */
    }
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
    } catch {
      /* optional */
    }
    const out = list
      .map((i) => {
        const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
        const last_price =
          Number.isFinite(lp) && lp > 0 ? lp : null;
        return {
          instrument_token: i.instrument_token,
          symbol: i.tradingsymbol,
          exchange: i.exchange,
          instrument_type: i.instrument_type,
          description: i.description,
          last_price,
        };
      })
      .filter((x) =>
        ltp_only
          ? Number.isFinite(x.last_price) && (x.last_price as any) > 0
          : true,
      );
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
    } catch {
      /* optional */
    }
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
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      try {
        const ltp = await this.kite.getLTP(batch.map((t) => String(t)));
        for (const t of batch) {
          const lp = Number(ltp?.[t]?.last_price);
          if (!Number.isFinite(lp) || lp <= 0) invalid.push(t);
        }
      } catch (e) {
        this.logger.warn(
          `[FalconInstrumentService] LTP validation batch failed`,
          e as Error,
        );
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
        this.logger.warn(
          '[FalconInstrumentService] Auto cleanup failed',
          e as Error,
        );
      }
    }
    return { tested: tokens.length, invalid_instruments: invalid, deactivated };
  }

  // =====================================================================
  // Vayu-parity additions
  // =====================================================================

  /**
   * Options chain for a symbol: all CE/PE rows grouped by expiry → strike → { CE, PE }.
   * Kite stores the underlying name in `name` (e.g. "NIFTY", "RELIANCE").
   */
  async getOptionsChain(
    symbol: string,
    ltpOnly = false,
  ): Promise<{
    success: boolean;
    data: {
      symbol: string;
      expiries: string[];
      strikes: number[];
      options: Record<string, Record<string, { CE?: any; PE?: any }>>;
      ltp_only: boolean;
    };
  }> {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) {
      return { success: true, data: { symbol: sym, expiries: [], strikes: [], options: {}, ltp_only: ltpOnly } };
    }
    const rows = await this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .where('UPPER(fi.name) = :sym', { sym })
      .andWhere("fi.instrument_type IN ('CE', 'PE')")
      .orderBy('fi.expiry', 'ASC')
      .addOrderBy('fi.strike', 'ASC')
      .getMany();

    let ltpMap: Record<string, any> = {};
    try {
      const tokens = rows.map((r) => String(r.instrument_token));
      if (tokens.length) ltpMap = await this.falconAdapter.getLTP(tokens);
    } catch { /* enrichment optional */ }

    const expirySet = new Set<string>();
    const strikeSet = new Set<number>();
    const options: Record<string, Record<string, { CE?: any; PE?: any }>> = {};

    for (const row of rows) {
      const lp = Number(ltpMap?.[String(row.instrument_token)]?.last_price);
      const last_price_live = Number.isFinite(lp) && lp > 0 ? lp : null;
      if (ltpOnly && !last_price_live) continue;
      const expiry = row.expiry || '';
      const strikeNum = Number(row.strike);
      const strikeKey = String(strikeNum);
      expirySet.add(expiry);
      strikeSet.add(strikeNum);
      if (!options[expiry]) options[expiry] = {};
      if (!options[expiry][strikeKey]) options[expiry][strikeKey] = {};
      options[expiry][strikeKey][row.instrument_type as 'CE' | 'PE'] = {
        instrument_token: row.instrument_token,
        tradingsymbol: row.tradingsymbol,
        name: row.name,
        exchange: row.exchange,
        segment: row.segment,
        expiry: row.expiry,
        strike: strikeNum,
        lot_size: row.lot_size,
        tick_size: row.tick_size,
        last_price_live,
      };
    }

    return {
      success: true,
      data: {
        symbol: sym,
        expiries: [...expirySet].sort(),
        strikes: [...strikeSet].sort((a, b) => a - b),
        options,
        ltp_only: ltpOnly,
      },
    };
  }

  /**
   * All active futures for a specific underlying symbol.
   * Kite: underlying name stored in `name` field, instrument_type = 'FUT'.
   */
  async getUnderlyingFutures(
    symbol: string,
    exchange?: string,
    limit = 100,
    offset = 0,
    ltpOnly = false,
  ): Promise<{
    items: Array<FalconInstrument & { last_price_live: number | null }>;
    total: number;
  }> {
    const sym = String(symbol || '').trim().toUpperCase();
    const qb = this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .where('UPPER(fi.name) = :sym', { sym })
      .andWhere("fi.instrument_type = 'FUT'")
      .andWhere('fi.is_active = true');
    if (exchange) qb.andWhere('fi.exchange = :ex', { ex: exchange });
    const total = await qb.getCount();
    const lim = Math.max(1, Math.min(1000, limit));
    const off = Math.max(0, offset);
    qb.orderBy('fi.expiry', 'ASC').limit(lim).offset(off);
    const items = await qb.getMany();

    let ltpMap: Record<string, any> = {};
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      if (tokens.length) ltpMap = await this.falconAdapter.getLTP(tokens);
    } catch { /* optional */ }

    let withLive = items.map((i) => {
      const lp = Number(ltpMap?.[String(i.instrument_token)]?.last_price);
      return { ...i, last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null };
    });
    if (ltpOnly) withLive = withLive.filter((i) => i.last_price_live !== null);
    return { items: withLive, total };
  }

  /**
   * F&O underlying symbol autocomplete.
   * Returns distinct underlying `name` values that have active FUT/CE/PE instruments.
   */
  async autocompleteFno(
    q: string,
    scope?: 'nse' | 'mcx' | 'all',
    limit = 10,
  ): Promise<{
    success: boolean;
    data: { suggestions: Array<{ symbol: string; exchange: string }> };
  }> {
    const normalized = String(q || '').trim().toUpperCase();
    if (!normalized) {
      return { success: true, data: { suggestions: [] } };
    }
    const lim = Math.max(1, Math.min(50, limit));
    const qb = this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .select('fi.name', 'name')
      .addSelect('MIN(fi.exchange)', 'exchange')
      .where("fi.instrument_type IN ('FUT', 'CE', 'PE')")
      .andWhere('fi.is_active = true')
      .andWhere('UPPER(fi.name) LIKE :q', { q: `${normalized}%` });
    if (scope === 'nse') qb.andWhere("fi.exchange IN ('NFO', 'CDS', 'BFO', 'NSE')");
    else if (scope === 'mcx') qb.andWhere("fi.exchange = 'MCX'");
    qb.groupBy('fi.name').limit(lim * 4);
    const rows = await qb.getRawMany<{ name: string; exchange: string }>();

    const seen = new Set<string>();
    const suggestions: Array<{ symbol: string; exchange: string }> = [];
    for (const row of rows) {
      const name = String(row.name || '').toUpperCase();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      suggestions.push({ symbol: name, exchange: row.exchange });
      if (suggestions.length >= lim) break;
    }
    return { success: true, data: { suggestions } };
  }

  /**
   * MCX options (exchange = 'MCX', instrument_type CE/PE) with filters.
   */
  async getMcxOptions(filters: {
    symbol?: string;
    option_type?: 'CE' | 'PE';
    expiry_from?: string;
    expiry_to?: string;
    strike_min?: number;
    strike_max?: number;
    is_active?: boolean;
    ltp_only?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<FalconInstrument & { last_price_live?: number | null }>;
    total: number;
  }> {
    const qb = this.falconInstrumentRepo.createQueryBuilder('fi');
    qb.where("fi.exchange = 'MCX'").andWhere("fi.instrument_type IN ('CE', 'PE')");
    if (filters?.symbol) {
      const sym = filters.symbol.toUpperCase();
      qb.andWhere('UPPER(fi.name) = :sym', { sym });
    }
    if (filters?.option_type) qb.andWhere('fi.instrument_type = :ot', { ot: filters.option_type });
    if (filters?.expiry_from) qb.andWhere('fi.expiry >= :ef', { ef: filters.expiry_from });
    if (filters?.expiry_to) qb.andWhere('fi.expiry <= :et', { et: filters.expiry_to });
    if (typeof filters?.strike_min === 'number') qb.andWhere('fi.strike >= :smin', { smin: filters.strike_min });
    if (typeof filters?.strike_max === 'number') qb.andWhere('fi.strike <= :smax', { smax: filters.strike_max });
    if (typeof filters?.is_active === 'boolean') qb.andWhere('fi.is_active = :ia', { ia: filters.is_active });
    const total = await qb.getCount();
    const limit = Math.max(1, Math.min(1000, filters?.limit ?? 100));
    const offset = Math.max(0, filters?.offset ?? 0);
    qb.orderBy('fi.expiry', 'ASC').addOrderBy('fi.strike', 'ASC').limit(limit).offset(offset);
    const items = await qb.getMany();
    let withLive = items.map((i) => ({ ...i, last_price_live: null as number | null }));
    try {
      const tokens = items.map((i) => String(i.instrument_token));
      if (tokens.length) {
        const ltp = await this.falconAdapter.getLTP(tokens);
        withLive = items.map((i) => {
          const lp = Number(ltp?.[String(i.instrument_token)]?.last_price);
          return { ...i, last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null };
        });
        if (filters?.ltp_only) {
          withLive = withLive.filter((x) => Number.isFinite(x.last_price_live) && (x.last_price_live as any) > 0);
        }
      }
    } catch { /* optional */ }
    return { items: withLive, total };
  }

  /** Popular hardcoded symbols — looks them up by tradingsymbol (EQ instruments) + enriches with LTP. */
  async getPopularInstruments(limit = 50): Promise<{
    items: Array<{
      instrument_token: number;
      tradingsymbol: string;
      name: string;
      exchange: string;
      instrument_type: string;
      last_price_live: number | null;
      description: string;
    }>;
  }> {
    const lim = Math.max(1, Math.min(200, limit));
    const rows = await this.falconInstrumentRepo
      .createQueryBuilder('fi')
      .where('fi.tradingsymbol IN (:...syms)', { syms: FalconInstrumentService.POPULAR_SYMBOLS })
      .andWhere('fi.is_active = true')
      .andWhere("fi.instrument_type = 'EQ'")
      .orderBy('fi.tradingsymbol', 'ASC')
      .limit(lim)
      .getMany();

    let ltpMap: Record<string, any> = {};
    try {
      const tokens = rows.map((r) => String(r.instrument_token));
      if (tokens.length) ltpMap = await this.falconAdapter.getLTP(tokens);
    } catch { /* optional */ }

    const items = rows.map((r) => {
      const lp = Number(ltpMap?.[String(r.instrument_token)]?.last_price);
      return {
        instrument_token: r.instrument_token,
        tradingsymbol: r.tradingsymbol,
        name: r.name,
        exchange: r.exchange,
        instrument_type: r.instrument_type,
        last_price_live: Number.isFinite(lp) && lp > 0 ? lp : null,
        description: r.description,
      };
    });
    return { items };
  }

  /** Permanently delete all instruments where is_active = false. */
  async deleteInactiveInstruments(): Promise<{ deleted: number }> {
    const result = await this.falconInstrumentRepo
      .createQueryBuilder()
      .delete()
      .from(FalconInstrument)
      .where('is_active = false')
      .execute();
    const deleted = result.affected ?? 0;
    this.logger.log(`[FalconInstrumentService] Deleted ${deleted} inactive instruments`);
    return { deleted };
  }

  /** Permanently delete instruments by exchange and/or instrument_type filter. */
  async deleteByFilter(
    exchange?: string,
    instrument_type?: string,
  ): Promise<{ deleted: number }> {
    if (!exchange && !instrument_type) {
      throw new Error('At least one filter required: exchange or instrument_type');
    }
    const qb = this.falconInstrumentRepo
      .createQueryBuilder()
      .delete()
      .from(FalconInstrument);
    const conditions: string[] = [];
    const params: Record<string, string> = {};
    if (exchange) { conditions.push('exchange = :ex'); params.ex = exchange; }
    if (instrument_type) { conditions.push('instrument_type = :it'); params.it = instrument_type; }
    qb.where(conditions.join(' AND '), params);
    const result = await qb.execute();
    const deleted = result.affected ?? 0;
    this.logger.log(
      `[FalconInstrumentService] Deleted ${deleted} instruments (exchange=${exchange ?? 'any'}, type=${instrument_type ?? 'any'})`,
    );
    return { deleted };
  }

  /** Clear known Falcon Redis cache keys (profile, margins, stats). */
  async clearFalconCache(): Promise<void> {
    const keys = [
      'falcon:profile',
      'falcon:margins:equity',
      'falcon:margins:commodity',
      'falcon:margins:all',
      'falcon:stats',
    ];
    for (const key of keys) {
      try { await this.redis.del(key); } catch { /* non-fatal */ }
    }
    this.logger.log('[FalconInstrumentService] Cleared Falcon cache keys');
  }

  /** Stats — served from Redis if fresh, computed on miss. */
  async getCachedStats() {
    const key = 'falcon:stats';
    try {
      const cached = await this.redis.get<any>(key);
      if (cached) return cached;
    } catch { /* non-fatal */ }
    const stats = await this.getFalconInstrumentStats();
    try { await this.redis.set(key, stats, 60); } catch { /* non-fatal */ }
    return stats;
  }

  /**
   * Start a Falcon instrument sync in the background and return a jobId.
   * Poll progress via the existing sync/status endpoint using the returned jobId.
   */
  async startSyncAlwaysAsync(exchange?: string): Promise<{
    success: boolean;
    jobId: string;
    message: string;
    timestamp: string;
  }> {
    const jobId = randomUUID();
    const key = `falcon:sync:job:${jobId}`;
    try {
      await this.redis.set(key, { status: 'started', exchange: exchange || 'all', ts: Date.now() }, 3600);
    } catch { /* non-fatal */ }
    setImmediate(async () => {
      try {
        await this.redis.set(key, { status: 'running', ts: Date.now() }, 3600).catch(() => { /* noop */ });
        const summary = await this.syncFalconInstruments(
          exchange,
          undefined,
          async (p) => {
            try { await this.redis.set(key, { status: 'running', progress: p, ts: Date.now() }, 3600); } catch { /* noop */ }
          },
        );
        await this.redis.set(key, { status: 'completed', summary, ts: Date.now() }, 3600).catch(() => { /* noop */ });
      } catch (e: any) {
        await this.redis.set(key, { status: 'failed', error: e?.message || 'unknown', ts: Date.now() }, 3600).catch(() => { /* noop */ });
      }
    });
    return { success: true, jobId, message: 'Sync job started', timestamp: new Date().toISOString() };
  }

  // =====================================================================
  // End Vayu-parity additions
  // =====================================================================

  private buildDescription(i: FalconInstrument): string {
    const ex = (i.exchange || '').toUpperCase();
    const sym = (i.tradingsymbol || '').toUpperCase();
    const it = (i.instrument_type || '').toUpperCase();
    if (
      it === 'EQ' ||
      i.segment?.toUpperCase() === 'NSE' ||
      i.segment?.toUpperCase() === 'BSE'
    ) {
      return `${ex} ${sym} EQ`.trim();
    }
    const expiry = (i.expiry || '').trim();
    const ddMonYYYY = (() => {
      if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return '';
      const [y, m, d] = expiry.split('-').map((s) => parseInt(s, 10));
      const months = [
        'JAN',
        'FEB',
        'MAR',
        'APR',
        'MAY',
        'JUN',
        'JUL',
        'AUG',
        'SEP',
        'OCT',
        'NOV',
        'DEC',
      ];
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
    return `${ex} ${sym} ${it}`.trim();
  }
}
