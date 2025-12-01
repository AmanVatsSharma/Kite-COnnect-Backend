import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
} from 'typeorm';

// Migration name must include a JS timestamp for this project.
export class AddApiKeyAbuseFlags1764547200002 implements MigrationInterface {
  name = 'AddApiKeyAbuseFlags1764547200002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('api_key_abuse_flags');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'api_key_abuse_flags',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'api_key',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'tenant_id',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'risk_score',
            type: 'int',
            isNullable: false,
            default: 0,
          },
          {
            name: 'reason_codes',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'blocked',
            type: 'boolean',
            isNullable: false,
            default: false,
          },
          {
            name: 'detected_at',
            type: 'timestamptz',
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            default: 'now()',
          },
          {
            name: 'last_seen_at',
            type: 'timestamptz',
            isNullable: true,
          },
        ],
      }),
    );

    await queryRunner.createIndices('api_key_abuse_flags', [
      new TableIndex({
        columnNames: ['api_key'],
        isUnique: true,
        name: 'UQ_api_key_abuse_flags_api_key',
      }),
      new TableIndex({
        columnNames: ['blocked', 'risk_score'],
        name: 'IDX_api_key_abuse_flags_blocked_risk',
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('api_key_abuse_flags');
    if (!exists) return;
    await queryRunner.dropTable('api_key_abuse_flags');
  }
}


