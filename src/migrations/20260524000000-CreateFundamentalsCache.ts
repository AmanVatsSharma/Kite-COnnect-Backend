import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFundamentalsCache20260524000000 implements MigrationInterface {
  name = 'CreateFundamentalsCache20260524000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "fundamentals_cache" (
        "id" SERIAL PRIMARY KEY,
        "symbol" VARCHAR(32) NOT NULL,
        "exchange" VARCHAR(16) NOT NULL DEFAULT 'NSE',
        "fetchedAt" TIMESTAMPTZ NOT NULL,
        "nextFetchAt" TIMESTAMPTZ NOT NULL,
        "data" JSONB,
        "priceData" JSONB,
        "stale" BOOLEAN NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_fundamentals_cache_symbol_exchange" UNIQUE ("symbol", "exchange")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_fundamentals_cache_nextFetchAt"
      ON "fundamentals_cache" ("nextFetchAt");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "fundamentals_cache";`);
  }
}