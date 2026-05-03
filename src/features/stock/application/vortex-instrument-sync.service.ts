/**
 * @file vortex-instrument-sync.service.ts
 * @module stock
 * @description CSV sync, instrument_mapping upserts, and daily cron for Vortex instruments.
 * @author BharatERP
 * @created 2026-03-28
 * @updated 2026-04-22
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { UniversalInstrument } from '@features/market-data/domain/universal-instrument.entity';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';
import { generateVortexInstrumentDescription } from '@features/stock/application/vortex-instrument-helpers';
import { normalizeExchange } from '@shared/utils/exchange-normalizer';
import { computeCanonicalSymbol } from '@shared/utils/canonical-symbol';

@Injectable()
export class VortexInstrumentSyncService {
  private readonly logger = new Logger(VortexInstrumentSyncService.name);

  constructor(
    @InjectRepository(VortexInstrument)
    private readonly vortexInstrumentRepo: Repository<VortexInstrument>,
    @InjectRepository(InstrumentMapping)
    private readonly mappingRepo: Repository<InstrumentMapping>,
    @InjectRepository(UniversalInstrument)
    private readonly uirRepo: Repository<UniversalInstrument>,
    private readonly vortexProvider: VortexProviderService,
    private readonly instrumentRegistry: InstrumentRegistryService,
  ) {}

  /**
   * Sync Vortex instruments from CSV
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
        `[VortexInstrumentSyncService] Starting Vortex instrument sync for exchange=${exchange || 'all'}`,
      );
      onProgress?.({ phase: 'init', lastMessage: 'Starting Vortex instrument sync' });

      const instruments = await this.vortexProvider.getInstruments(exchange, {
        csvUrl,
      });

      if (!instruments || instruments.length === 0) {
        this.logger.warn(
          '[VortexInstrumentSyncService] No instruments received from Vortex provider',
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
        `[VortexInstrumentSyncService] Received ${instruments.length} instruments from Vortex CSV`,
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
          const existingInstrument = await this.vortexInstrumentRepo.findOne({
            where: { token: vortexInstrument.token },
          });

          const description = generateVortexInstrumentDescription(vortexInstrument);

          if (existingInstrument) {
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
                is_active: true,
              },
            );
            updated++;
            this.logger.debug(
              `[VortexInstrumentSyncService] Updated instrument token=${vortexInstrument.token}, symbol=${vortexInstrument.symbol}`,
            );
          } else {
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
              `[VortexInstrumentSyncService] Created instrument token=${vortexInstrument.token}, symbol=${vortexInstrument.symbol}`,
            );
          }

          await this.updateInstrumentMapping(vortexInstrument);
          await this.upsertUniversalInstrument(vortexInstrument);
        } catch (error) {
          errors++;
          this.logger.error(
            `[VortexInstrumentSyncService] Failed to process instrument token=${vortexInstrument.token}`,
            error,
          );
        }
        processed++;
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
        `[VortexInstrumentSyncService] Sync completed. Synced: ${synced}, Updated: ${updated}`,
      );

      // Cross-link kite↔vortex mappings by instrument_token, then refresh registry
      try {
        await this.crossLinkProviderMappings();
        await this.instrumentRegistry.refresh();
        this.logger.log('[VortexInstrumentSyncService] Cross-link complete, InstrumentRegistry refreshed');
      } catch (refreshErr) {
        this.logger.warn('[VortexInstrumentSyncService] Cross-link/refresh failed (non-fatal)', refreshErr);
      }

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
      this.logger.error('[VortexInstrumentSyncService] Error syncing Vortex instruments', error);
      onProgress?.({
        phase: 'complete',
        total: 0,
        processed: 0,
        synced: 0,
        updated: 0,
        errors: 1,
        lastMessage: `Error: ${(error as Error)?.message || 'unknown'}`,
      });
      throw error;
    }
  }

  private async crossLinkProviderMappings(): Promise<void> {
    try {
      await Promise.all([
        this.mappingRepo.query(`
          UPDATE instrument_mappings AS vx
          SET uir_id = kx.uir_id
          FROM instrument_mappings AS kx
          WHERE kx.provider = 'kite'
            AND vx.provider = 'vortex'
            AND kx.instrument_token = vx.instrument_token
            AND kx.uir_id IS NOT NULL
            AND (vx.uir_id IS NULL OR vx.uir_id != kx.uir_id)
        `),
        this.mappingRepo.query(`
          UPDATE instrument_mappings AS kx
          SET uir_id = vx.uir_id
          FROM instrument_mappings AS vx
          WHERE vx.provider = 'vortex'
            AND kx.provider = 'kite'
            AND vx.instrument_token = kx.instrument_token
            AND vx.uir_id IS NOT NULL
            AND (kx.uir_id IS NULL OR kx.uir_id != vx.uir_id)
        `),
      ]);
    } catch (e) {
      this.logger.warn('[VortexInstrumentSyncService] Cross-link pass failed (non-fatal)', e as Error);
    }
  }

  private async updateInstrumentMapping(vortexInstrument: {
    exchange?: string;
    token?: number;
  }): Promise<void> {
    try {
      const providerToken = `${vortexInstrument.exchange}-${vortexInstrument.token}`;

      const existingMap = await this.mappingRepo.findOne({
        where: {
          provider: 'vortex',
          provider_token: providerToken,
        },
      });

      if (existingMap) {
        if (existingMap.instrument_token !== vortexInstrument.token) {
          existingMap.instrument_token = vortexInstrument.token;
          await this.mappingRepo.save(existingMap);
          this.logger.debug(
            `[VortexInstrumentSyncService] Updated mapping: ${providerToken} -> ${vortexInstrument.token}`,
          );
        }
      } else {
        await this.mappingRepo.save(
          this.mappingRepo.create({
            provider: 'vortex',
            provider_token: providerToken,
            instrument_token: vortexInstrument.token,
          }),
        );
        this.logger.debug(
          `[VortexInstrumentSyncService] Created mapping: ${providerToken} -> ${vortexInstrument.token}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[VortexInstrumentSyncService] Failed to update mapping for token ${vortexInstrument.token}`,
        error,
      );
    }
  }

  /**
   * Upsert a single Vortex instrument into the universal instrument registry
   * and link its instrument_mapping row via uir_id.
   */
  private async upsertUniversalInstrument(vortexInstrument: {
    exchange?: string;
    token?: number;
    symbol?: string;
    instrument_name?: string;
    expiry_date?: string;
    option_type?: string;
    strike_price?: number;
    tick?: number;
    lot_size?: number;
  }): Promise<void> {
    try {
      const normalizedExchange = normalizeExchange(vortexInstrument.exchange || '', 'vortex');
      const underlying = (vortexInstrument.symbol || '').toUpperCase().trim();
      if (!underlying) return;

      // Map Vortex instrument_name to our type system
      // Vortex uses: EQ, FUTIDX, FUTSTK, OPTIDX, OPTSTK, FUTCUR, OPTCUR, FUTCOM, OPTCOM
      let instrumentType = 'EQ';
      const iName = (vortexInstrument.instrument_name || '').toUpperCase();
      if (iName.startsWith('FUT')) instrumentType = 'FUT';
      else if (iName.startsWith('OPT') && vortexInstrument.option_type === 'CE') instrumentType = 'CE';
      else if (iName.startsWith('OPT') && vortexInstrument.option_type === 'PE') instrumentType = 'PE';
      else if (iName === 'EQ') instrumentType = 'EQ';

      // Parse expiry from YYYYMMDD string
      let expiry: Date | null = null;
      if (vortexInstrument.expiry_date && vortexInstrument.expiry_date.length === 8) {
        const y = vortexInstrument.expiry_date.slice(0, 4);
        const m = vortexInstrument.expiry_date.slice(4, 6);
        const d = vortexInstrument.expiry_date.slice(6, 8);
        expiry = new Date(`${y}-${m}-${d}`);
        if (isNaN(expiry.getTime())) expiry = null;
      }

      const strike = Number(vortexInstrument.strike_price) || null;
      const optionType = (instrumentType === 'CE' || instrumentType === 'PE') ? instrumentType : null;

      const canonicalSymbol = computeCanonicalSymbol({
        exchange: normalizedExchange,
        underlying,
        instrument_type: instrumentType,
        expiry,
        strike,
        option_type: optionType,
      });

      await this.uirRepo.upsert({
        canonical_symbol: canonicalSymbol,
        exchange: normalizedExchange,
        underlying,
        instrument_type: instrumentType,
        expiry,
        strike: strike || 0,
        option_type: optionType,
        lot_size: vortexInstrument.lot_size || 1,
        tick_size: Number(vortexInstrument.tick) || 0.05,
        name: underlying,
        segment: normalizedExchange,
        is_active: true,
        asset_class: normalizedExchange === 'MCX' ? 'commodity' : (normalizedExchange === 'CDS' ? 'currency' : 'equity'),
      }, {
        conflictPaths: ['canonical_symbol'],
        skipUpdateIfNoValuesChanged: false,
      });

      // Link mapping to UIR
      const uirRow = await this.uirRepo.findOne({ where: { canonical_symbol: canonicalSymbol } });
      if (uirRow) {
        const providerToken = `${vortexInstrument.exchange}-${vortexInstrument.token}`;
        await this.mappingRepo.update(
          { provider: 'vortex' as const, provider_token: providerToken },
          { uir_id: Number(uirRow.id) },
        );
      }
    } catch (err) {
      this.logger.debug(`[VortexInstrumentSyncService] UIR upsert failed for token=${vortexInstrument.token}: ${(err as Error)?.message}`);
    }
  }

  @Cron('30 8 * * *')
  async syncVortexInstrumentsDaily(): Promise<void> {
    try {
      this.logger.log('[VortexInstrumentSyncService] Starting daily Vortex instrument sync');
      const result = await this.syncVortexInstruments();
      this.logger.log(
        `[VortexInstrumentSyncService] Daily sync completed: ${result.synced} synced, ${result.updated} updated`,
      );
    } catch (error) {
      this.logger.error('[VortexInstrumentSyncService] Error in daily Vortex instrument sync', error);
    }
  }
}
