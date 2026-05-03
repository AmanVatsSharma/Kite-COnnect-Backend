/**
 * @file binance-instrument-sync.service.ts
 * @module binance
 * @description Daily cron that syncs Binance Spot exchangeInfo into binance_instruments,
 *   creates instrument_mappings rows (provider='binance'), and wires UIR IDs so the
 *   streaming layer can route WS subscriptions to Binance symbols.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 *
 * Filtering: only `status='TRADING'` symbols whose `quoteAsset` is in BINANCE_QUOTES
 * (default USDT,USDC,BUSD,BTC,ETH; override via env). Yields ~800 of Binance's ~2000 pairs.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { BinanceInstrument } from '../domain/binance-instrument.entity';
import { BinanceRestClient } from '../infra/binance-rest.client';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { UniversalInstrument } from '@features/market-data/domain/universal-instrument.entity';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { computeCanonicalSymbol } from '@shared/utils/canonical-symbol';
import {
  BinanceExchangeInfoSymbol,
  BinanceLotSizeFilter,
  BinanceMinNotionalFilter,
  BinancePriceFilter,
} from '../dto/binance-exchange-info.dto';
import {
  BINANCE_CANONICAL_EXCHANGE,
  BINANCE_DEFAULT_QUOTE_FILTER,
  BINANCE_PROVIDER_NAME,
} from '../binance.constants';

const CRON_JOB_NAME = 'binance-instrument-sync';
const CHUNK_SIZE = 500;

export interface BinanceSyncResult {
  total: number;
  synced: number;
  linked: number;
  skipped: number;
  durationMs: number;
  error?: string;
}

@Injectable()
export class BinanceInstrumentSyncService implements OnModuleInit {
  private readonly logger = new Logger(BinanceInstrumentSyncService.name);
  private lastSyncResult: BinanceSyncResult | null = null;
  private lastSyncAt: string | null = null;
  private syncInProgress = false;

  constructor(
    private readonly config: ConfigService,
    private readonly rest: BinanceRestClient,
    @InjectRepository(BinanceInstrument)
    private readonly binanceRepo: Repository<BinanceInstrument>,
    @InjectRepository(InstrumentMapping)
    private readonly mappingRepo: Repository<InstrumentMapping>,
    @InjectRepository(UniversalInstrument)
    private readonly uirRepo: Repository<UniversalInstrument>,
    private readonly instrumentRegistry: InstrumentRegistryService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabled = this.config.get<string>(
      'BINANCE_INSTRUMENT_SYNC_ENABLED',
      'true',
    );
    if (enabled === 'false') {
      this.logger.log(
        '[BinanceSync] Cron disabled (BINANCE_INSTRUMENT_SYNC_ENABLED=false)',
      );
      return;
    }
    const cronExpr = this.config.get<string>(
      'BINANCE_INSTRUMENTS_CRON',
      '30 0 * * *',
    );
    const tz = this.config.get<string>('BINANCE_INSTRUMENTS_CRON_TZ', 'UTC') || 'UTC';
    try {
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
      this.logger.log(`[BinanceSync] Cron scheduled: ${cronExpr} (${tz})`);
    } catch (err) {
      this.logger.error('[BinanceSync] Failed to register cron job', err as any);
    }
  }

  /** Quote-asset whitelist: env BINANCE_QUOTES overrides BINANCE_DEFAULT_QUOTE_FILTER. */
  private getQuoteFilter(): Set<string> {
    const raw = this.config.get<string>('BINANCE_QUOTES', '');
    const list = (raw && raw.trim().length > 0
      ? raw.split(',')
      : Array.from(BINANCE_DEFAULT_QUOTE_FILTER)
    )
      .map((q) => q.trim().toUpperCase())
      .filter(Boolean);
    return new Set(list);
  }

  /** Triggered from admin endpoint or cron. */
  async syncBinanceInstruments(
    onProgress?: (p: { processed: number; linked: number }) => void,
  ): Promise<BinanceSyncResult> {
    if (this.syncInProgress) {
      return { total: 0, synced: 0, linked: 0, skipped: 0, durationMs: 0, error: 'sync_in_progress' };
    }
    this.syncInProgress = true;
    const t0 = Date.now();
    let synced = 0;
    let linked = 0;
    let skipped = 0;
    let total = 0;

    try {
      const info = await this.rest.getExchangeInfo();
      if (!info?.symbols?.length) {
        const err = 'exchangeInfo returned no symbols';
        this.logger.error(`[BinanceSync] ${err}`);
        return this.finishSync({ total: 0, synced: 0, linked: 0, skipped: 0, durationMs: Date.now() - t0, error: err });
      }

      const quoteFilter = this.getQuoteFilter();
      const accepted: BinanceExchangeInfoSymbol[] = [];
      for (const s of info.symbols) {
        total++;
        if (s.status !== 'TRADING') { skipped++; continue; }
        if (!s.isSpotTradingAllowed) { skipped++; continue; }
        if (!quoteFilter.has(s.quoteAsset.toUpperCase())) { skipped++; continue; }
        accepted.push(s);
      }
      this.logger.log(
        `[BinanceSync] Filtered ${accepted.length}/${total} symbols (quote=${[...quoteFilter].join(',')}; skipped=${skipped})`,
      );

      // Build entity rows
      const rows = accepted.map((s) => this.toEntity(s));

      // Upsert binance_instruments in chunks
      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        await this.binanceRepo.upsert(chunk, {
          conflictPaths: ['symbol'],
          skipUpdateIfNoValuesChanged: false,
        });
        synced += chunk.length;
        if (onProgress && synced % 1000 < CHUNK_SIZE) {
          onProgress({ processed: synced, linked });
        }
      }

      // Upsert instrument_mappings — provider_token = symbol (uppercase)
      const mappingRows = rows.map((r) => ({
        provider: BINANCE_PROVIDER_NAME,
        provider_token: r.symbol,
        instrument_token: 0, // sentinel — schema requires NOT NULL int (mirrors Massive sync)
        uir_id: null as number | null,
      }));
      for (let i = 0; i < mappingRows.length; i += CHUNK_SIZE) {
        const chunk = mappingRows.slice(i, i + CHUNK_SIZE);
        await this.mappingRepo.upsert(chunk, {
          conflictPaths: ['provider', 'provider_token'],
          skipUpdateIfNoValuesChanged: false,
        });
      }

      // Upsert UIR rows + link uir_id back into mappings
      linked = await this.upsertUniversalInstruments(rows);

      // Refresh in-memory registry so the streaming layer sees new mappings immediately
      try {
        await this.instrumentRegistry.refresh();
        this.logger.log('[BinanceSync] Instrument registry refreshed');
      } catch (err) {
        this.logger.warn('[BinanceSync] Registry refresh failed (non-fatal)', err as any);
      }

      this.logger.log(
        `[BinanceSync] Completed: total=${total}, synced=${synced}, linked=${linked}, skipped=${skipped}, ms=${Date.now() - t0}`,
      );
      return this.finishSync({ total, synced, linked, skipped, durationMs: Date.now() - t0 });
    } catch (err) {
      const msg = (err as any)?.message || String(err);
      this.logger.error(`[BinanceSync] failed: ${msg}`, err as any);
      return this.finishSync({ total, synced, linked, skipped, durationMs: Date.now() - t0, error: msg });
    }
  }

  private finishSync(r: BinanceSyncResult): BinanceSyncResult {
    this.lastSyncResult = r;
    this.lastSyncAt = new Date().toISOString();
    this.syncInProgress = false;
    return r;
  }

  /** Map exchangeInfo row → BinanceInstrument entity (extracts filter values). */
  private toEntity(s: BinanceExchangeInfoSymbol): BinanceInstrument {
    const priceFilter = s.filters.find(
      (f) => f.filterType === 'PRICE_FILTER',
    ) as BinancePriceFilter | undefined;
    const lotFilter = s.filters.find(
      (f) => f.filterType === 'LOT_SIZE',
    ) as BinanceLotSizeFilter | undefined;
    const notionalFilter = s.filters.find(
      (f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL',
    ) as BinanceMinNotionalFilter | undefined;

    return this.binanceRepo.create({
      symbol: s.symbol.toUpperCase(),
      base_asset: s.baseAsset.toUpperCase(),
      quote_asset: s.quoteAsset.toUpperCase(),
      status: s.status,
      tick_size: priceFilter?.tickSize ?? null,
      step_size: lotFilter?.stepSize ?? null,
      min_notional: notionalFilter?.minNotional ?? null,
      is_active: true,
    });
  }

  /**
   * For each Binance instrument, upsert a UniversalInstrument row and link its ID
   * back to the instrument_mapping. Mirrors MassiveInstrumentSyncService.upsertUniversalInstruments().
   */
  async upsertUniversalInstruments(rows: BinanceInstrument[]): Promise<number> {
    let linked = 0;

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);

      for (const row of chunk) {
        try {
          const canonicalSymbol = computeCanonicalSymbol({
            exchange: BINANCE_CANONICAL_EXCHANGE,
            underlying: row.symbol,
            instrument_type: 'EQ',
          });

          await this.uirRepo.upsert(
            {
              canonical_symbol: canonicalSymbol,
              exchange: BINANCE_CANONICAL_EXCHANGE,
              underlying: row.symbol,
              instrument_type: 'EQ',
              name: `${row.base_asset}/${row.quote_asset}`.substring(0, 128),
              segment: 'spot',
              is_active: true,
              asset_class: 'crypto',
              lot_size: 1,
              tick_size: row.tick_size != null ? Number(row.tick_size) : 0.00000001,
              expiry: null,
              strike: 0,
              option_type: null,
            },
            {
              conflictPaths: ['canonical_symbol'],
              skipUpdateIfNoValuesChanged: false,
            },
          );

          const uirRow = await this.uirRepo.findOne({
            where: { canonical_symbol: canonicalSymbol },
          });
          if (uirRow) {
            await this.mappingRepo.update(
              { provider: BINANCE_PROVIDER_NAME as any, provider_token: row.symbol },
              { uir_id: Number(uirRow.id) },
            );
            linked++;
          }
        } catch (err) {
          this.logger.warn(
            `[BinanceSync] UIR upsert failed for ${row.symbol}: ${(err as any)?.message}`,
            err as any,
          );
        }
      }
    }

    return linked;
  }

  private async runScheduledSyncWithRetries(maxAttempts = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.log(`[BinanceSync] Scheduled sync attempt ${attempt}/${maxAttempts}`);
        const r = await this.syncBinanceInstruments();
        if (!r.error) return;
        if (attempt < maxAttempts) {
          const delayMs = 5000 * Math.pow(2, attempt - 1);
          this.logger.warn(`[BinanceSync] Attempt ${attempt} returned error: ${r.error}; retry in ${delayMs}ms`);
          await new Promise((res) => setTimeout(res, delayMs));
        }
      } catch (err) {
        this.logger.error(`[BinanceSync] Attempt ${attempt} threw`, err as any);
        if (attempt < maxAttempts) {
          const delayMs = 5000 * Math.pow(2, attempt - 1);
          await new Promise((res) => setTimeout(res, delayMs));
        }
      }
    }
    this.logger.error('[BinanceSync] All retry attempts exhausted');
  }

  getSyncStatus() {
    return {
      inProgress: this.syncInProgress,
      lastSyncAt: this.lastSyncAt,
      lastResult: this.lastSyncResult,
    };
  }
}
