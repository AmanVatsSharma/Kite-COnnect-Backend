import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * VortexInstrument Entity
 *
 * Represents instruments from Vortex API CSV data.
 * Separate from Kite instruments to avoid conflicts and maintain data integrity.
 *
 * CSV Field Mappings:
 * - token → token (primary key)
 * - exchange → exchange (NSE_EQ, NSE_FO, NSE_CUR, MCX_FO)
 * - symbol → symbol (trading symbol)
 * - instrument_name → instrument_name (instrument type)
 * - expiry_date → expiry_date (YYYYMMDD format)
 * - option_type → option_type (CE/PE/null)
 * - strike_price → strike_price (strike price in rupees)
 * - tick → tick (tick size)
 * - lot_size → lot_size (lot size)
 */
@Entity('vortex_instruments')
@Index(['token'])
@Index(['exchange'])
@Index(['symbol'])
@Index(['instrument_name'])
@Index(['exchange', 'symbol'])
export class VortexInstrument {
  @PrimaryColumn({ type: 'int' })
  token: number;

  @Column({ type: 'varchar', length: 16 })
  exchange: string; // NSE_EQ, NSE_FO, NSE_CUR, MCX_FO

  @Column({ type: 'varchar', length: 64 })
  symbol: string; // Trading symbol

  @Column({ type: 'varchar', length: 64 })
  instrument_name: string; // Instrument type (FUTIDX, OPTIDX, EQ, etc.)

  @Column({ type: 'varchar', length: 8, nullable: true })
  expiry_date: string; // YYYYMMDD format

  @Column({ type: 'varchar', length: 2, nullable: true })
  option_type: string; // CE/PE/null

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  strike_price: number; // Strike price in rupees

  @Column({ type: 'decimal', precision: 10, scale: 4, default: 0.05 })
  tick: number; // Tick size

  @Column({ type: 'int', default: 1 })
  lot_size: number; // Lot size

  @Column({ type: 'text', nullable: true })
  description: string; // Computed description: e.g., "NSE_EQ RELIANCE EQ" or "NSE_FO NIFTY 25JAN2024 22000 CE"

  @Column({ default: true })
  is_active: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
