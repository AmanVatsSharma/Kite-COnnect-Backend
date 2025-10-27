import { MigrationInterface, QueryRunner } from 'typeorm';

export class OptimizeVortexInstruments1700000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Composite index for symbol + exchange searches (most common)
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vortex_symbol_exchange 
      ON vortex_instruments(symbol, exchange)
    `);

    // Composite index for exchange + instrument type filtering
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vortex_exchange_type 
      ON vortex_instruments(exchange, instrument_name)
    `);

    // Specialized index for options search (symbol + expiry + strike + option_type)
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vortex_options 
      ON vortex_instruments(symbol, expiry_date, strike_price, option_type) 
      WHERE option_type IS NOT NULL
    `);

    // Full-text search index for fuzzy symbol matching
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vortex_symbol_fts 
      ON vortex_instruments USING gin(to_tsvector('english', symbol))
    `);

    // Partial index for active instruments only (most queries filter by is_active)
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vortex_active_symbol 
      ON vortex_instruments(symbol, exchange) 
      WHERE is_active = true
    `);

    // Index for strike price range queries on options
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vortex_strike_price 
      ON vortex_instruments(strike_price) 
      WHERE option_type IS NOT NULL AND strike_price > 0
    `);

    // Index for expiry date range queries
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vortex_expiry_date 
      ON vortex_instruments(expiry_date) 
      WHERE expiry_date IS NOT NULL
    `);

    // Composite index for autocomplete queries (symbol prefix matching)
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vortex_symbol_prefix 
      ON vortex_instruments(symbol text_pattern_ops) 
      WHERE is_active = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes in reverse order
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vortex_symbol_prefix`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vortex_expiry_date`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vortex_strike_price`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vortex_active_symbol`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vortex_symbol_fts`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vortex_options`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vortex_exchange_type`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_vortex_symbol_exchange`);
  }
}
