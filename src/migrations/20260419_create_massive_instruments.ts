import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMassiveInstruments1745075200000 implements MigrationInterface {
  name = 'CreateMassiveInstruments1745075200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('massive_instruments');
    if (exists) return;

    await queryRunner.query(`
      CREATE TABLE massive_instruments (
        id SERIAL PRIMARY KEY,
        ticker VARCHAR(32) NOT NULL,
        name VARCHAR(256) NOT NULL DEFAULT '',
        market VARCHAR(16) NOT NULL,
        locale VARCHAR(8) NOT NULL DEFAULT 'us',
        instrument_type VARCHAR(16) NOT NULL DEFAULT 'EQ',
        currency VARCHAR(8) NOT NULL DEFAULT 'USD',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_massive_instruments_ticker_market
        ON massive_instruments(ticker, market)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_massive_instruments_market
        ON massive_instruments(market)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_massive_instruments_market`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_massive_instruments_ticker_market`);
    await queryRunner.query(`DROP TABLE IF EXISTS massive_instruments`);
  }
}
