import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsinForLogos20260506 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "falcon_instruments" ADD COLUMN "isin" varchar(16)`,
    );
    await queryRunner.query(
      `ALTER TABLE "universal_instruments" ADD COLUMN "isin" varchar(16)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "universal_instruments" DROP COLUMN "isin"`,
    );
    await queryRunner.query(
      `ALTER TABLE "falcon_instruments" DROP COLUMN "isin"`,
    );
  }
}
