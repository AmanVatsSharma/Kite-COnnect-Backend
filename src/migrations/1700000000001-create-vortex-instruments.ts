import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';

export class CreateVortexInstruments1700000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create vortex_instruments table
    const exists = await queryRunner.hasTable('vortex_instruments');
    if (!exists) {
      await queryRunner.createTable(
        new Table({
          name: 'vortex_instruments',
          columns: [
            { name: 'token', type: 'int', isPrimary: true },
            { name: 'exchange', type: 'varchar', length: '16', isNullable: false },
            { name: 'symbol', type: 'varchar', length: '64', isNullable: false },
            { name: 'instrument_name', type: 'varchar', length: '64', isNullable: false },
            { name: 'expiry_date', type: 'varchar', length: '8', isNullable: true },
            { name: 'option_type', type: 'varchar', length: '2', isNullable: true },
            { name: 'strike_price', type: 'decimal', precision: 10, scale: 2, isNullable: true },
            { name: 'tick', type: 'decimal', precision: 10, scale: 4, default: 0.05 },
            { name: 'lot_size', type: 'int', default: 1 },
            { name: 'is_active', type: 'boolean', default: true },
            { name: 'created_at', type: 'timestamp', default: 'now()' },
            { name: 'updated_at', type: 'timestamp', default: 'now()' },
          ],
          indices: [
            new TableIndex({
              columnNames: ['token'],
              name: 'IDX_vortex_instruments_token',
            }),
            new TableIndex({
              columnNames: ['exchange'],
              name: 'IDX_vortex_instruments_exchange',
            }),
            new TableIndex({
              columnNames: ['symbol'],
              name: 'IDX_vortex_instruments_symbol',
            }),
            new TableIndex({
              columnNames: ['instrument_name'],
              name: 'IDX_vortex_instruments_instrument_name',
            }),
            new TableIndex({
              columnNames: ['exchange', 'symbol'],
              name: 'IDX_vortex_instruments_exchange_symbol',
            }),
          ],
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('vortex_instruments');
    if (hasTable) {
      await queryRunner.dropTable('vortex_instruments');
    }
  }
}
