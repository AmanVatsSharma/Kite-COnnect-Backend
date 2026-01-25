import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * FalconInstrument Entity
 *
 * Represents instruments from Kite (Falcon) instruments CSV/API.
 * Separate from core instruments to keep provider data isolated.
 *
 * CSV Field Mappings (Kite):
 * - instrument_token → instrument_token (primary key)
 * - exchange_token → exchange_token
 * - tradingsymbol → tradingsymbol
 * - name → name
 * - last_price → last_price (stale in CSV, not realtime)
 * - expiry → expiry (YYYY-MM-DD)
 * - strike → strike
 * - tick_size → tick_size
 * - lot_size → lot_size
 * - instrument_type → instrument_type (EQ, FUT, CE, PE)
 * - segment → segment (e.g., NSE, NFO-FUT, NFO-OPT, MCX)
 * - exchange → exchange (NSE, BSE, NFO, MCX, ...)
 */
@Entity('falcon_instruments')
@Index(['instrument_token'])
@Index(['exchange'])
@Index(['tradingsymbol'])
@Index(['instrument_type'])
@Index(['segment'])
@Index(['exchange', 'tradingsymbol'])
export class FalconInstrument {
  @PrimaryColumn({ type: 'int' })
  instrument_token: number;

  @Column({ type: 'int' })
  exchange_token: number;

  @Column({ type: 'varchar', length: 64 })
  tradingsymbol: string;

  @Column({ type: 'varchar', length: 128, default: '' })
  name: string;

  @Column({ type: 'decimal', precision: 14, scale: 4, default: 0 })
  last_price: number;

  @Column({ type: 'varchar', length: 16, default: '' })
  expiry: string;

  @Column({ type: 'decimal', precision: 14, scale: 4, default: 0 })
  strike: number;

  @Column({ type: 'decimal', precision: 10, scale: 4, default: 0.05 })
  tick_size: number;

  @Column({ type: 'int', default: 1 })
  lot_size: number;

  @Column({ type: 'varchar', length: 16 })
  instrument_type: string;

  @Column({ type: 'varchar', length: 32 })
  segment: string;

  @Column({ type: 'varchar', length: 16 })
  exchange: string;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'text', nullable: true })
  description: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}


