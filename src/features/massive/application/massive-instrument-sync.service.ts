/**
 * @file massive-instrument-sync.service.ts
 * @module massive
 * @description Daily cron that syncs Massive reference tickers into massive_instruments,
 *   creates instrument_mappings rows (provider='massive'), and wires UIR IDs so the
 *   streaming layer can route WS subscriptions to Massive symbols.
 * @author BharatERP
 * @created 2026-04-19
 * @updated 2026-04-19
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { MassiveInstrument } from '../domain/massive-instrument.entity';
import { MassiveRestClient } from '../infra/massive-rest.client';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { UniversalInstrument } from '@features/market-data/domain/universal-instrument.entity';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { computeCanonicalSymbol } from '@shared/utils/canonical-symbol';

const CRON_JOB_NAME = 'massive-instrument-sync';
const CHUNK_SIZE = 500;

/** Maps Massive market string to canonical exchange prefix used in UIR. */
const MARKET_TO_EXCHANGE: Record<string, string> = {
  stocks: 'US',
  forex: 'FX',
  crypto: 'CRYPTO',
  indices: 'IDX',
  options: 'US',
};

/** Maps Massive market to UIR asset_class. */
const MARKET_TO_ASSET_CLASS: Record<string, string> = {
  stocks: 'equity',
  forex: 'currency',
  crypto: 'crypto',
  indices: 'equity',
  options: 'equity',
};

/**
 * Maps Massive/Polygon instrument types to the UIR canonical type set.
 * UIR only knows EQ, IDX, FUT, CE, PE — everything else must be normalized.
 * Equity-like instruments (CS, ETF, ADRC, etc.) → EQ so canonical is "US:AAPL" not "US:AAPL:CS".
 */
function toUirInstrumentType(massiveType: string, market: string): string {
  if (market === 'indices') return 'IDX';
  const equityTypes = new Set([
    'CS', 'ETF', 'ADRC', 'ADRW', 'ADRP', 'GDR', 'GDRS',
    'PFD', 'RIGHT', 'WARRANT', 'UNIT', 'SP', 'FUND', 'ELT',
    'OS', 'OTHER',
  ]);
  if (equityTypes.has(massiveType?.toUpperCase())) return 'EQ';
  return 'EQ'; // safe default for unknown types
}

/**
 * Polygon prefixes its market tickers with a namespace: "C:EURUSD" (forex), "X:BTCUSD" (crypto).
 * Strip these so the UIR underlying is the clean human symbol ("EURUSD", "BTCUSD").
 * The raw provider_token in instrument_mappings keeps the original Polygon form so the
 * WS subscribe call can reconstruct the correct channel (e.g. "C.EURUSD" for forex endpoint).
 */
function toCleanUnderlying(ticker: string, market: string): string {
  if (market === 'forex') return ticker.replace(/^C:/i, '');
  if (market === 'crypto') return ticker.replace(/^X:/i, '');
  return ticker;
}

export interface MassiveSyncResult {
  market: string;
  synced: number;
  linked: number;
  durationMs: number;
  error?: string;
}

@Injectable()
export class MassiveInstrumentSyncService implements OnModuleInit {
  private readonly logger = new Logger(MassiveInstrumentSyncService.name);
  private lastSyncResult: MassiveSyncResult[] | null = null;
  private lastSyncAt: string | null = null;
  private syncInProgress = false;

  constructor(
    private readonly config: ConfigService,
    private readonly rest: MassiveRestClient,
    @InjectRepository(MassiveInstrument)
    private readonly massiveRepo: Repository<MassiveInstrument>,
    @InjectRepository(InstrumentMapping)
    private readonly mappingRepo: Repository<InstrumentMapping>,
    @InjectRepository(UniversalInstrument)
    private readonly uirRepo: Repository<UniversalInstrument>,
    private readonly instrumentRegistry: InstrumentRegistryService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabled = this.config.get<string>('MASSIVE_INSTRUMENT_SYNC_ENABLED', 'true');
    if (enabled === 'false') {
      this.logger.log('[MassiveSync] Cron disabled (MASSIVE_INSTRUMENT_SYNC_ENABLED=false)');
      return;
    }
    const cronExpr = this.config.get<string>('MASSIVE_INSTRUMENTS_CRON', '15 10 * * *');
    const tz = this.config.get<string>('MASSIVE_INSTRUMENTS_CRON_TZ', 'America/New_York') || 'America/New_York';
    try {
      const job = new CronJob(cronExpr, () => {
        void this.runScheduledSyncWithRetries();
      }, null, false, tz);
      this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
      job.start();
      this.logger.log(`[MassiveSync] Cron scheduled: ${cronExpr} (${tz})`);
    } catch (err) {
      this.logger.error('[MassiveSync] Failed to register cron job', err as any);
    }
  }

  /** Trigger sync from admin endpoint or cron. */
  async syncMassiveInstruments(
    market?: string,
    onProgress?: (p: { market: string; processed: number; linked: number }) => void,
  ): Promise<MassiveSyncResult[]> {
    if (!this.rest.isReady()) {
      this.logger.warn('[MassiveSync] REST client not ready (MASSIVE_API_KEY not set)');
      return [];
    }

    const marketsRaw = market
      ? [market]
      : (this.config.get<string>('MASSIVE_INSTRUMENT_MARKETS', 'stocks,forex,crypto') || 'stocks,forex,crypto')
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean);

    this.syncInProgress = true;
    const results: MassiveSyncResult[] = [];

    for (const mkt of marketsRaw) {
      const result = await this.syncOneMarket(mkt, onProgress);
      results.push(result);
    }

    this.lastSyncResult = results;
    this.lastSyncAt = new Date().toISOString();
    this.syncInProgress = false;

    // Refresh in-memory registry so streaming layer picks up new mappings immediately
    try {
      await this.instrumentRegistry.refresh();
      this.logger.log('[MassiveSync] Instrument registry refreshed');
    } catch (err) {
      this.logger.warn('[MassiveSync] Registry refresh failed (non-fatal)', err as any);
    }

    return results;
  }

  private async syncOneMarket(
    market: string,
    onProgress?: (p: { market: string; processed: number; linked: number }) => void,
  ): Promise<MassiveSyncResult> {
    const t0 = Date.now();
    let synced = 0;
    let linked = 0;

    try {
      this.logger.log(`[MassiveSync] Starting sync for market=${market}`);
      const allRows: MassiveInstrument[] = [];
      let cursor: string | undefined;

      // Paginate through all tickers using next_url cursor
      do {
        const page = await this.rest.getReferenceTickers(undefined, market, 1000, cursor);
        if (!page?.results?.length) break;

        for (const r of page.results) {
          if (!r.ticker || !r.active) continue;
          allRows.push(
            this.massiveRepo.create({
              ticker: r.ticker,
              name: r.name || '',
              market,
              locale: r.locale || 'us',
              instrument_type: r.type || 'EQ',
              currency: (r.currency_symbol || r.currency_name || 'USD').substring(0, 8),
              is_active: true,
            }),
          );
        }

        // Extract cursor token from next_url if present
        cursor = page.next_url ? this.extractCursor(page.next_url) : undefined;
      } while (cursor);

      this.logger.log(`[MassiveSync] Fetched ${allRows.length} tickers for market=${market}`);

      // Upsert into massive_instruments in chunks
      for (let i = 0; i < allRows.length; i += CHUNK_SIZE) {
        const chunk = allRows.slice(i, i + CHUNK_SIZE);
        await this.massiveRepo.upsert(chunk, {
          conflictPaths: ['ticker', 'market'],
          skipUpdateIfNoValuesChanged: false,
        });
        synced += chunk.length;

        if (onProgress && synced % 1000 < CHUNK_SIZE) {
          onProgress({ market, processed: synced, linked });
        }
      }

      // Upsert instrument_mappings rows — use clean underlying as provider_token
      // so the streaming layer subscribes with the right symbol (e.g. "EURUSD" not "C:EURUSD").
      const mappingRows = allRows.map((r) => ({
        provider: 'massive' as any,
        provider_token: toCleanUnderlying(r.ticker, r.market),
        instrument_token: 0,
        uir_id: null as number | null,
      }));

      for (let i = 0; i < mappingRows.length; i += CHUNK_SIZE) {
        const chunk = mappingRows.slice(i, i + CHUNK_SIZE);
        await this.mappingRepo.upsert(chunk, {
          conflictPaths: ['provider', 'provider_token'],
          skipUpdateIfNoValuesChanged: false,
        });
      }

      // Link UIR IDs
      linked = await this.upsertUniversalInstruments(allRows);

      this.logger.log(`[MassiveSync] Completed market=${market}: synced=${synced}, linked=${linked}, ms=${Date.now() - t0}`);
      return { market, synced, linked, durationMs: Date.now() - t0 };
    } catch (err) {
      const msg = (err as any)?.message || String(err);
      this.logger.error(`[MassiveSync] market=${market} failed: ${msg}`, err as any);
      return { market, synced, linked, durationMs: Date.now() - t0, error: msg };
    }
  }

  /**
   * For each Massive instrument, upsert a UniversalInstrument row and link its ID
   * back to the instrument_mapping. Mirrors FalconInstrumentService.upsertUniversalInstruments().
   */
  async upsertUniversalInstruments(rows: MassiveInstrument[]): Promise<number> {
    let linked = 0;

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);

      for (const row of chunk) {
        try {
          const exchange = MARKET_TO_EXCHANGE[row.market] ?? row.market.toUpperCase();
          // Strip Polygon market prefix (C:EURUSD→EURUSD, X:BTCUSD→BTCUSD) for clean
          // canonical symbols and human-readable search. The raw ticker is kept as
          // provider_token so the WS layer can reconstruct the correct channel prefix.
          const underlying = toCleanUnderlying(row.ticker, row.market);
          const instrumentType = toUirInstrumentType(row.instrument_type, row.market);
          const assetClass = MARKET_TO_ASSET_CLASS[row.market] ?? 'equity';

          const canonicalSymbol = computeCanonicalSymbol({
            exchange,
            underlying,
            instrument_type: instrumentType,
          });

          await this.uirRepo.upsert(
            {
              canonical_symbol: canonicalSymbol,
              exchange,
              underlying,
              instrument_type: instrumentType,
              name: (row.name || '').substring(0, 128),
              segment: row.market,
              is_active: true,
              asset_class: assetClass,
              lot_size: 1,
              tick_size: 0.01,
              expiry: null,
              strike: 0,
              option_type: null,
            },
            {
              conflictPaths: ['canonical_symbol'],
              skipUpdateIfNoValuesChanged: false,
            },
          );

          const uirRow = await this.uirRepo.findOne({ where: { canonical_symbol: canonicalSymbol } });
          if (uirRow) {
            await this.mappingRepo.update(
              { provider: 'massive' as any, provider_token: toCleanUnderlying(row.ticker, row.market) },
              { uir_id: Number(uirRow.id) },
            );
            linked++;
          }
        } catch (err) {
          this.logger.warn(`[MassiveSync] UIR upsert failed for ${row.ticker}: ${(err as any)?.message}`, err as any);
        }
      }
    }

    return linked;
  }

  private async runScheduledSyncWithRetries(maxAttempts = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.log(`[MassiveSync] Scheduled sync attempt ${attempt}/${maxAttempts}`);
        await this.syncMassiveInstruments();
        return;
      } catch (err) {
        this.logger.error(`[MassiveSync] Attempt ${attempt} failed`, err as any);
        if (attempt < maxAttempts) {
          const delayMs = 5000 * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    this.logger.error('[MassiveSync] All retry attempts exhausted');
  }

  /** Extract cursor param from Massive's next_url string. */
  private extractCursor(nextUrl: string): string | undefined {
    try {
      const url = new URL(nextUrl.startsWith('http') ? nextUrl : `https://api.massive.com${nextUrl}`);
      return url.searchParams.get('cursor') ?? undefined;
    } catch {
      return undefined;
    }
  }

  getSyncStatus() {
    return {
      inProgress: this.syncInProgress,
      lastSyncAt: this.lastSyncAt,
      lastResult: this.lastSyncResult,
    };
  }
}
