import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDescriptionToFalconInstruments1700000000004 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE falcon_instruments
      ADD COLUMN IF NOT EXISTS description TEXT NULL
    `);
    // Optional: prefix/suffix search optimization for tradingsymbol already exists; description is computed field
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE falcon_instruments
      DROP COLUMN IF EXISTS description
    `);
  }
}



