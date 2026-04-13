/**
 * @file vortex-instrument-cleanup.service.ts
 * @module stock
 * @description Vortex instrument LTP validation batches, deactivation, and filtered deletes.
 * @author BharatERP
 * @created 2026-03-28
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';
import { RequestBatchingService } from '@features/market-data/application/request-batching.service';
import { normalizeVortexExchange } from '@features/stock/application/vortex-instrument-helpers';

@Injectable()
export class VortexInstrumentCleanupService {
  private readonly logger = new Logger(VortexInstrumentCleanupService.name);

  constructor(
    @InjectRepository(VortexInstrument)
    private readonly vortexInstrumentRepo: Repository<VortexInstrument>,
    private readonly vortexProvider: VortexProviderService,
    private readonly requestBatchingService: RequestBatchingService,
  ) {}

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
      instrument_type?: string;
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
      ltp_response: unknown;
    }>;
    cleanup: {
      deactivated: number;
      removed: number;
    };
    batches_processed: number;
    diagnostics?: {
      reason_counts: Record<string, number>;
      resolution: {
        requested: number;
        included: number;
        invalid_exchange: number;
        missing_from_response: number;
      };
      attempts?: number;
      require_consensus?: number;
      probe_interval_ms?: number;
      indeterminate?: number;
    };
  }> {
    try {
      this.logger.log(
        `[VortexInstrumentCleanupService] Starting validation with filters: ${JSON.stringify(filters)}`,
      );

      const batchSize = filters.batch_size || 1000;
      const autoCleanup = filters.auto_cleanup || false;
      const dryRun = filters.dry_run !== false;
      const probeAttempts = Math.max(1, Number(filters.probe_attempts ?? 3));
      const probeIntervalMs = Math.max(1000, Number(filters.probe_interval_ms ?? 1000));
      const requireConsensus = Math.max(
        1,
        Math.min(Number(filters.require_consensus ?? 2), probeAttempts),
      );
      const safeCleanup = !(filters.safe_cleanup === false);

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
      if (!filters.instrument_name && filters.instrument_type) {
        const type = String(filters.instrument_type).toUpperCase();
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

      queryBuilder.andWhere('instrument.is_active = :is_active', { is_active: true });

      let allInstruments = await queryBuilder.getMany();
      if (filters?.limit && Number(filters.limit) > 0) {
        allInstruments = allInstruments.slice(0, Number(filters.limit));
      }
      const totalInstruments = allInstruments.length;

      this.logger.log(
        `[VortexInstrumentCleanupService] Found ${totalInstruments} instruments to validate`,
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

      const batches: VortexInstrument[][] = [];
      for (let i = 0; i < allInstruments.length; i += batchSize) {
        batches.push(allInstruments.slice(i, i + batchSize));
      }

      this.logger.log(
        `[VortexInstrumentCleanupService] Processing ${batches.length} batches of up to ${batchSize} instruments each`,
      );
      onProgress?.({
        event: 'start',
        total_instruments: totalInstruments,
        batches: batches.length,
        batch_size: batchSize,
        lastMessage: `Starting validation of ${totalInstruments} instruments in ${batches.length} batches`,
      });

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
        ltp_response: unknown;
      }> = [];
      let validLtpCount = 0;
      let invalidLtpCount = 0;
      let errorCount = 0;
      const reasonCounts: Record<string, number> = {};
      let totalPairsIncluded = 0;
      let totalInvalidExchange = 0;
      let totalMissingFromResponse = 0;
      let totalIndeterminate = 0;

      const allowedExchanges = new Set(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO']);

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        this.logger.log(
          `[VortexInstrumentCleanupService] Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} instruments`,
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
          const pairs: Array<{
            exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
            token: string | number;
          }> = [];

          for (const instrument of batch) {
            const normalizedEx = normalizeVortexExchange(instrument.exchange || '');
            if (normalizedEx && allowedExchanges.has(normalizedEx)) {
              pairs.push({
                exchange: normalizedEx as 'NSE_EQ',
                token: instrument.token,
              });
              this.logger.debug(
                `[VortexInstrumentCleanupService] Mapped token ${instrument.token} to exchange ${normalizedEx}`,
              );
            } else {
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
              reasonCounts.invalid_exchange = (reasonCounts.invalid_exchange || 0) + 1;
              this.logger.debug(
                `[VortexInstrumentCleanupService] Instrument ${instrument.token} invalid exchange: ${instrument.exchange}`,
              );
            }
          }

          if (pairs.length === 0) {
            this.logger.log(
              `[VortexInstrumentCleanupService] Batch ${batchIndex + 1} has no valid pairs, skipping`,
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

          const pairKeyToInstrument = new Map<string, VortexInstrument>();
          for (const instrument of batch) {
            const normalizedEx = normalizeVortexExchange(instrument.exchange || '');
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
            this.logger.log(
              `[VortexInstrumentCleanupService] Probe ${attempt + 1}/${probeAttempts} for ${pairs.length} pairs (batch ${batchIndex + 1})`,
            );
            const ltpResults = await this.requestBatchingService.getLtpByPairs(
              pairs,
              this.vortexProvider,
            );
            totalPairsIncluded += pairs.length;
            const keysCount = Object.keys(ltpResults || {}).length;
            if (keysCount === 0) attemptHadEmpty = true;
            for (const instrument of batch) {
              const normalizedEx = normalizeVortexExchange(instrument.exchange || '');
              if (!normalizedEx || !allowedExchanges.has(normalizedEx)) continue;
              const pairKey = `${normalizedEx}-${instrument.token}`;
              tokenState[instrument.token].probes += 1;
              const ltpData: { last_price?: number } | undefined =
                (ltpResults && (ltpResults as Record<string, { last_price?: number }>)[pairKey]) ||
                undefined;
              const lastPrice = ltpData?.last_price;
              if (Number.isFinite(lastPrice) && lastPrice > 0) {
                tokenState[instrument.token].hits += 1;
              }
            }
            if (attempt < probeAttempts - 1) {
              await new Promise((r) => setTimeout(r, probeIntervalMs));
            }
          }
          for (const instrument of batch) {
            const normalizedEx = normalizeVortexExchange(instrument.exchange || '');
            if (!normalizedEx || !allowedExchanges.has(normalizedEx)) continue;
            const state = tokenState[instrument.token] || { hits: 0, probes: 0 };
            if (state.hits > 0) {
              validLtpCount++;
              continue;
            }
            if (attemptHadEmpty) {
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
              reasonCounts.indeterminate = (reasonCounts.indeterminate || 0) + 1;
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
              reasonCounts.no_ltp_data = (reasonCounts.no_ltp_data || 0) + 1;
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
              reasonCounts.indeterminate = (reasonCounts.indeterminate || 0) + 1;
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
        } catch (batchError: unknown) {
          errorCount++;
          const msg = batchError instanceof Error ? batchError.message : String(batchError);
          this.logger.error(
            `[VortexInstrumentCleanupService] Error processing batch ${batchIndex + 1}`,
            batchError,
          );
          for (const instrument of batch) {
            invalidInstruments.push({
              token: instrument.token,
              exchange: instrument.exchange || 'UNKNOWN',
              symbol: instrument.symbol || '',
              instrument_name: instrument.instrument_name || '',
              reason: 'batch_error',
              ltp_response: { error: msg },
            });
            invalidLtpCount++;
            reasonCounts.batch_error = (reasonCounts.batch_error || 0) + 1;
          }
        }

        if (batchIndex < batches.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      const summary = {
        total_instruments: totalInstruments,
        tested: totalInstruments,
        valid_ltp: validLtpCount,
        invalid_ltp: invalidLtpCount,
        errors: errorCount,
      };

      this.logger.log(
        `[VortexInstrumentCleanupService] Validation summary: ${JSON.stringify(summary)}`,
      );

      let deactivatedCount = 0;
      let removedCount = 0;

      if (autoCleanup && !dryRun && invalidInstruments.length > 0) {
        const candidates = safeCleanup
          ? invalidInstruments.filter((x) => x.reason !== 'indeterminate')
          : invalidInstruments;
        const invalidTokens = candidates.map((inv) => inv.token);
        this.logger.log(
          `[VortexInstrumentCleanupService] Starting cleanup: deactivating ${invalidTokens.length} invalid instruments`,
        );
        if (safeCleanup && candidates.length !== invalidInstruments.length) {
          this.logger.log(
            `[VortexInstrumentCleanupService] Safe cleanup: skipping ${invalidInstruments.length - candidates.length} indeterminate instruments`,
          );
        }

        const BATCH = 10000;
        const tokenBatches: number[][] = [];
        for (let i = 0; i < invalidTokens.length; i += BATCH) {
          tokenBatches.push(invalidTokens.slice(i, i + BATCH));
        }

        for (let batchIdx = 0; batchIdx < tokenBatches.length; batchIdx++) {
          const tokenBatch = tokenBatches[batchIdx];
          this.logger.log(
            `[VortexInstrumentCleanupService] Deactivation batch ${batchIdx + 1}/${tokenBatches.length} (${tokenBatch.length} tokens)`,
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
            this.logger.log(
              `[VortexInstrumentCleanupService] Batch ${batchIdx + 1} deactivated: ${batchAffected}`,
            );
          } catch (batchError) {
            this.logger.error(
              `[VortexInstrumentCleanupService] Failed to deactivate batch ${batchIdx + 1}`,
              batchError,
            );
          }
        }

        this.logger.log(
          `[VortexInstrumentCleanupService] Deactivation completed: ${deactivatedCount} instruments`,
        );
      } else if (autoCleanup && dryRun) {
        this.logger.log(
          `[VortexInstrumentCleanupService] Dry run: would deactivate ${invalidInstruments.length} instruments`,
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
      this.logger.error('[VortexInstrumentCleanupService] Validation failed', error);
      throw error;
    }
  }

  async deleteInactiveInstruments(): Promise<number> {
    try {
      this.logger.log('[VortexInstrumentCleanupService] Starting deletion of inactive instruments');

      const count = await this.vortexInstrumentRepo.count({
        where: { is_active: false },
      });

      this.logger.log(`[VortexInstrumentCleanupService] Found ${count} inactive instruments to delete`);

      if (count === 0) {
        return 0;
      }

      const deleteResult = await this.vortexInstrumentRepo
        .createQueryBuilder()
        .delete()
        .from(VortexInstrument)
        .where('is_active = :isActive', { isActive: false })
        .execute();

      const deletedCount = deleteResult.affected || 0;

      this.logger.log(
        `[VortexInstrumentCleanupService] Deleted ${deletedCount} inactive instruments`,
      );

      return deletedCount;
    } catch (error) {
      this.logger.error(
        '[VortexInstrumentCleanupService] Failed to delete inactive instruments',
        error,
      );
      throw error;
    }
  }

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
      const qb = this.vortexInstrumentRepo.createQueryBuilder().delete().from(VortexInstrument as any);
      const whereParts: string[] = [];
      const params: Record<string, unknown> = {};
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
      this.logger.log('[VortexInstrumentCleanupService] deleteInstrumentsByFilter', {
        exchange,
        instrument_name,
        instrument_type,
        deleted,
      });
      return deleted;
    } catch (error) {
      this.logger.error('[VortexInstrumentCleanupService] deleteInstrumentsByFilter failed', error);
      throw error;
    }
  }
}
