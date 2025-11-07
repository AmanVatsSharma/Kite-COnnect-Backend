import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIndexesVortexInstruments1700000000004 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_vi_token ON vortex_instruments(token)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_vi_exchange ON vortex_instruments(exchange)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_vi_symbol ON vortex_instruments(symbol)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_vi_is_active ON vortex_instruments(is_active)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_vi_token');
    await queryRunner.query('DROP INDEX IF EXISTS idx_vi_exchange');
    await queryRunner.query('DROP INDEX IF EXISTS idx_vi_symbol');
    await queryRunner.query('DROP INDEX IF EXISTS idx_vi_is_active');
  }
}


