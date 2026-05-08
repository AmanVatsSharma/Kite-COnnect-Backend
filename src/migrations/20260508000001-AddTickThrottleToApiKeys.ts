import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTickThrottleToApiKeys20260508 implements MigrationInterface {
  name = 'AddTickThrottleToApiKeys20260508';

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
