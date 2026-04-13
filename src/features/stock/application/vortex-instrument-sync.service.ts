/**
 * @file vortex-instrument-sync.service.ts
 * @module stock
 * @description CSV sync, instrument_mapping upserts, and daily cron for Vortex instruments.
 * @author BharatERP
 * @created 2026-03-28
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';
import { generateVortexInstrumentDescription } from '@features/stock/application/vortex-instrument-helpers';

@Injectable()
export class VortexInstrumentSyncService {
  private readonly logger = new Logger(VortexInstrumentSyncService.name);

  constructor(
    @InjectRepository(VortexInstrument)
    private readonly vortexInstrumentRepo: Repository<VortexInstrument>,
    @InjectRepository(InstrumentMapping)
    private readonly mappingRepo: Repository<InstrumentMapping>,
    private readonly vortexProvider: VortexProviderService,
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
