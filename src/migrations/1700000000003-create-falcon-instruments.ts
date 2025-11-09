import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFalconInstruments1700000000003 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS falcon_instruments (
        instrument_token INT PRIMARY KEY,
        exchange_token INT NOT NULL,
        tradingsymbol VARCHAR(64) NOT NULL,
        name VARCHAR(128) NOT NULL DEFAULT '',
        last_price NUMERIC(14,4) NOT NULL DEFAULT 0,
        expiry VARCHAR(16) NOT NULL DEFAULT '',
        strike NUMERIC(14,4) NOT NULL DEFAULT 0,
        tick_size NUMERIC(10,4) NOT NULL DEFAULT 0.05,
        lot_size INT NOT NULL DEFAULT 1,
        instrument_type VARCHAR(16) NOT NULL,
        segment VARCHAR(32) NOT NULL,
        exchange VARCHAR(16) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_falcon_symbol_exchange
      ON falcon_instruments(tradingsymbol, exchange)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_falcon_exchange_type
      ON falcon_instruments(exchange, instrument_type)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_falcon_segment
      ON falcon_instruments(segment)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_falcon_active_symbol
      ON falcon_instruments(tradingsymbol, exchange)
      WHERE is_active = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_falcon_active_symbol`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_falcon_segment`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_falcon_exchange_type`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_falcon_symbol_exchange`);
    await queryRunner.query(`DROP TABLE IF EXISTS falcon_instruments`);
  }
}


