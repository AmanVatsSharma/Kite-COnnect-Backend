/**
 * @file massive-instrument.entity.ts
 * @module massive
 * @description TypeORM entity for the massive_instruments table — one row per Massive ticker.
 * @author BharatERP
 * @created 2026-04-19
 * @updated 2026-04-19
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('massive_instruments')
@Index(['market'])
@Index(['ticker', 'market'], { unique: true })
export class MassiveInstrument {
  @PrimaryGeneratedColumn()
  id: number;

  /** Massive/Polygon symbol e.g. "AAPL", "BTC-USD", "EUR/USD". */
  @Column({ type: 'varchar', length: 32 })
  ticker: string;

  @Column({ type: 'varchar', length: 256, default: '' })
  name: string;

  /** Asset class: stocks | forex | crypto | indices | options */
  @Column({ type: 'varchar', length: 16 })
  market: string;

  /** ISO locale e.g. "us", "global" */
  @Column({ type: 'varchar', length: 8, default: 'us' })
  locale: string;

  /** EQ, IDX, FUT, CE, PE */
  @Column({ type: 'varchar', length: 16, default: 'EQ' })
  instrument_type: string;

  /** ISO 4217 currency code e.g. "USD" */
  @Column({ type: 'varchar', length: 8, default: 'USD' })
  currency: string;

  @Column({ default: true })
  is_active: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
