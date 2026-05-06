import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTrialFieldsToApiKeys1715011200000
  implements MigrationInterface
{
  name = 'AddTrialFieldsToApiKeys1715011200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE api_keys DROP COLUMN IF EXISTS expires_at`,
    );
    await queryRunner.query(
      `ALTER TABLE api_keys DROP COLUMN IF EXISTS is_test`,
    );
  }
}
