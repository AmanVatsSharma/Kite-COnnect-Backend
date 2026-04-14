import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class AddAppConfigs1744646400000 implements MigrationInterface {
  name = 'AddAppConfigs1744646400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('app_configs');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'app_configs',
        columns: [
          {
            name: 'key',
            type: 'varchar',
            length: '128',
            isPrimary: true,
          },
          {
            name: 'value',
            type: 'text',
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            default: 'now()',
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('app_configs', true);
  }
}
