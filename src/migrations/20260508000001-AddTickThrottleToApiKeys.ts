import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTickThrottleToApiKeys1778258600000 implements MigrationInterface {
  name = 'AddTickThrottleToApiKeys1778258600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS live_tick_throttle_ms INT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE api_keys DROP COLUMN IF EXISTS live_tick_throttle_ms`,
    );
  }
}
