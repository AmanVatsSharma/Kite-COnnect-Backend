import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUniversalInstruments1713340800000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS universal_instruments (
        id BIGSERIAL PRIMARY KEY,
        canonical_symbol VARCHAR(128) NOT NULL,
        exchange VARCHAR(8) NOT NULL,
        underlying VARCHAR(64) NOT NULL,
        instrument_type VARCHAR(8) NOT NULL,
        expiry DATE NULL,
        strike DECIMAL(14,4) NULL DEFAULT 0,
        option_type VARCHAR(2) NULL,
        lot_size INT NOT NULL DEFAULT 1,
        tick_size DECIMAL(10,4) NOT NULL DEFAULT 0.05,
        name VARCHAR(128) NOT NULL DEFAULT '',
        segment VARCHAR(16) NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT true,
        asset_class VARCHAR(16) NOT NULL DEFAULT 'equity',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_uir_canonical_symbol
      ON universal_instruments(canonical_symbol)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_uir_exchange_underlying
      ON universal_instruments(exchange, underlying)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_uir_is_active
      ON universal_instruments(is_active)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_uir_is_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_uir_exchange_underlying`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_uir_canonical_symbol`);
    await queryRunner.query(`DROP TABLE IF EXISTS universal_instruments`);
  }
}
