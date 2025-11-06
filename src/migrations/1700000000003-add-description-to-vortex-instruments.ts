import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Migration: Add description field to vortex_instruments table
 * 
 * The description field provides a human-readable description of each instrument
 * for better documentation and debugging. It's computed from exchange, symbol,
 * instrument_name, expiry_date, strike_price, and option_type.
 * 
 * Examples:
 * - "NSE_EQ RELIANCE EQ"
 * - "NSE_FO NIFTY 25JAN2024 22000 CE"
 * - "MCX_FO GOLD FUTCOM"
 */
export class AddDescriptionToVortexInstruments1700000000003
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if column already exists
    const table = await queryRunner.getTable('vortex_instruments');
    const hasDescription = table?.findColumnByName('description');

    if (!hasDescription) {
      await queryRunner.addColumn(
        'vortex_instruments',
        new TableColumn({
          name: 'description',
          type: 'text',
          isNullable: true,
          comment: 'Human-readable description computed from instrument fields',
        }),
      );

      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        '[Migration] Added description column to vortex_instruments table',
      );
    } else {
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        '[Migration] Description column already exists in vortex_instruments table',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('vortex_instruments');
    const hasDescription = table?.findColumnByName('description');

    if (hasDescription) {
      await queryRunner.dropColumn('vortex_instruments', 'description');
      // Console for easy debugging
      // eslint-disable-next-line no-console
      console.log(
        '[Migration] Removed description column from vortex_instruments table',
      );
    }
  }
}

