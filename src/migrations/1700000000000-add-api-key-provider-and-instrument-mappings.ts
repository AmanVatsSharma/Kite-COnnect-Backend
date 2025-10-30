import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableIndex,
} from 'typeorm';

export class AddApiKeyProviderAndInstrumentMappings1700000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add provider column to api_keys (nullable)
    const hasProvider = await queryRunner.hasColumn('api_keys', 'provider');
    if (!hasProvider) {
      await queryRunner.addColumn(
        'api_keys',
        new TableColumn({
          name: 'provider',
          type: 'varchar',
          length: '16',
          isNullable: true,
        }),
      );
    }

    // Create instrument_mappings table
    const exists = await queryRunner.hasTable('instrument_mappings');
    if (!exists) {
      await queryRunner.createTable(
        new Table({
          name: 'instrument_mappings',
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            {
              name: 'provider',
              type: 'varchar',
              length: '16',
              isNullable: false,
            },
            {
              name: 'provider_token',
              type: 'varchar',
              length: '64',
              isNullable: false,
            },
            { name: 'instrument_token', type: 'int', isNullable: false },
            { name: 'created_at', type: 'timestamp', default: 'now()' },
            { name: 'updated_at', type: 'timestamp', default: 'now()' },
          ],
          indices: [
            new TableIndex({
              columnNames: ['provider', 'provider_token'],
              isUnique: true,
              name: 'IDX_provider_provider_token_unique',
            }),
          ],
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasMappings = await queryRunner.hasTable('instrument_mappings');
    if (hasMappings) {
      await queryRunner.dropTable('instrument_mappings');
    }
    const hasProvider = await queryRunner.hasColumn('api_keys', 'provider');
    if (hasProvider) {
      await queryRunner.dropColumn('api_keys', 'provider');
    }
  }
}
