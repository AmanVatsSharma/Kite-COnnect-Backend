import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUirIdColumns1713340900000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE instrument_mappings
      ADD COLUMN IF NOT EXISTS uir_id BIGINT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS uir_id BIGINT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_instrument_mappings_uir_id
      ON instrument_mappings(uir_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_instrument_mappings_uir_id`);
    await queryRunner.query(`
      ALTER TABLE subscriptions DROP COLUMN IF EXISTS uir_id
    `);
    await queryRunner.query(`
      ALTER TABLE instrument_mappings DROP COLUMN IF EXISTS uir_id
    `);
  }
}
