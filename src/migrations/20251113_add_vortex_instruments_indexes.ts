/**
 * @file 20251113_add_vortex_instruments_indexes.ts
 * @module migrations
 * @description Adds performant indexes for Vortex instruments search (GIN trigram + filtered btree)
 * @author BharatERP
 * @created 2025-11-13
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVortexInstrumentsIndexes20251113 implements MigrationInterface {
  name = 'AddVortexInstrumentsIndexes20251113';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable pg_trgm for fast ILIKE searches
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    // Trigram index for symbol prefix/fuzzy search
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vi_symbol_trgm ON vortex_instruments USING GIN (symbol gin_trgm_ops)`,
    );
    // Btree composite indexes for common filters
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vi_active_exchange_name ON vortex_instruments (is_active, exchange, instrument_name)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_vi_active_expiry ON vortex_instruments (is_active, expiry_date)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_vi_active_expiry`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_vi_active_exchange_name`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_vi_symbol_trgm`,
    );
    // Do not drop extension automatically (may be used elsewhere)
  }
}


