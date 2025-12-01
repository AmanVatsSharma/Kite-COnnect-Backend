import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumnOptions,
  TableIndex,
} from 'typeorm';

// Migration name must include a JS timestamp for this project.
export class AddRequestAuditLogs1764547200001 implements MigrationInterface {
  name = 'AddRequestAuditLogs1764547200001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('request_audit_logs');
    if (exists) {
      return;
    }

    const columns: TableColumnOptions[] = [
      {
        name: 'id',
        type: 'int',
        isPrimary: true,
        isGenerated: true,
        generationStrategy: 'increment',
      },
      {
        name: 'ts',
        type: 'timestamptz',
        default: 'now()',
      },
      { name: 'api_key', type: 'varchar', length: '255', isNullable: true },
      { name: 'api_key_id', type: 'int', isNullable: true },
      { name: 'tenant_id', type: 'varchar', length: '255', isNullable: true },
      { name: 'kind', type: 'varchar', length: '16', isNullable: false },
      {
        name: 'route_or_event',
        type: 'varchar',
        length: '255',
        isNullable: false,
      },
      { name: 'method', type: 'varchar', length: '16', isNullable: true },
      { name: 'status', type: 'int', isNullable: true },
      { name: 'ip', type: 'varchar', length: '64', isNullable: true },
      { name: 'user_agent', type: 'text', isNullable: true },
      { name: 'origin', type: 'varchar', length: '255', isNullable: true },
      { name: 'country', type: 'varchar', length: '64', isNullable: true },
      { name: 'asn', type: 'varchar', length: '64', isNullable: true },
      { name: 'duration_ms', type: 'int', isNullable: true },
      { name: 'meta', type: 'jsonb', isNullable: true },
    ];

    await queryRunner.createTable(
      new Table({
        name: 'request_audit_logs',
        columns,
      }),
    );

    await queryRunner.createIndices('request_audit_logs', [
      new TableIndex({
        columnNames: ['api_key'],
        name: 'IDX_request_audit_logs_api_key',
      }),
      new TableIndex({
        columnNames: ['tenant_id'],
        name: 'IDX_request_audit_logs_tenant_id',
      }),
      new TableIndex({
        columnNames: ['ts'],
        name: 'IDX_request_audit_logs_ts',
      }),
      new TableIndex({
        columnNames: ['kind', 'ts'],
        name: 'IDX_request_audit_logs_kind_ts',
      }),
      new TableIndex({
        columnNames: ['ip'],
        name: 'IDX_request_audit_logs_ip',
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('request_audit_logs');
    if (!exists) return;
    await queryRunner.dropTable('request_audit_logs');
  }
}


