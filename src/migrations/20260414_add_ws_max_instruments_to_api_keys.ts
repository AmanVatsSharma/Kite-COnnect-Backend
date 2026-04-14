import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWsMaxInstrumentsToApiKeys1744646401000 implements MigrationInterface {
  name = 'AddWsMaxInstrumentsToApiKeys1744646401000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS ws_max_instruments INT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE api_keys DROP COLUMN IF EXISTS ws_max_instruments`,
    );
  }
}
