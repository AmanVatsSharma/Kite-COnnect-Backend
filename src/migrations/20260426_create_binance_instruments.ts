import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBinanceInstruments1745683200000
  implements MigrationInterface
{
  name = 'CreateBinanceInstruments1745683200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('binance_instruments');
    if (exists) return;

    await queryRunner.query(`
      CREATE TABLE binance_instruments (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(32) NOT NULL,
        base_asset VARCHAR(16) NOT NULL,
        quote_asset VARCHAR(16) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'TRADING',
        tick_size NUMERIC(20, 10) NULL,
        step_size NUMERIC(20, 10) NULL,
        min_notional NUMERIC(20, 10) NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_binance_instruments_symbol
        ON binance_instruments(symbol)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_binance_instruments_quote_asset
        ON binance_instruments(quote_asset)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_binance_instruments_is_active
        ON binance_instruments(is_active)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_binance_instruments_is_active`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_binance_instruments_quote_asset`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_binance_instruments_symbol`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS binance_instruments`);
  }
}
