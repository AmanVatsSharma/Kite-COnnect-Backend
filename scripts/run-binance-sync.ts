/**
 * @file scripts/run-binance-sync.ts
 * @module scripts
 * @description One-shot CLI to trigger BinanceInstrumentSyncService.syncBinanceInstruments()
 *   from outside the cron schedule. Boots a standalone Nest application context (no HTTP server),
 *   calls the same service the cron calls, then exits. Use when you want to seed the catalog
 *   without waiting for the daily cron at 00:30 UTC.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/run-binance-sync.ts
 *
 * Side-effects:
 *   - Writes to binance_instruments, instrument_mappings, universal_instruments
 *   - Calls InstrumentRegistryService.refresh() at the end so the script's in-process
 *     registry sees the new rows. The running dev server's registry is a separate process
 *     and won't see the new rows until *its* next refresh (next cron, next provider sync,
 *     or a manual /api/admin/instruments/refresh-registry call).
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-27
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { BinanceInstrumentSyncService } from '../src/features/binance/application/binance-instrument-sync.service';

async function main() {
  const logger = new Logger('run-binance-sync');
  logger.log('Booting Nest application context (no HTTP)…');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const sync = app.get(BinanceInstrumentSyncService);
    logger.log('Calling syncBinanceInstruments()…');
    const result = await sync.syncBinanceInstruments();
    logger.log(`Done: ${JSON.stringify(result)}`);
    if (result.error) process.exitCode = 1;
  } catch (err) {
    logger.error('Sync threw', err as any);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
