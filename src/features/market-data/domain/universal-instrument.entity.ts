/**
 * @file universal-instrument.entity.ts
 * @module market-data
 * @description Universal Instrument Registry entity — canonical instrument representation across all providers.
 * @author BharatERP
 * @created 2026-04-17
 * @updated 2026-04-17
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('universal_instruments')
@Index(['canonical_symbol'], { unique: true })
@Index(['exchange', 'underlying'])
@Index(['is_active'])
export class UniversalInstrument {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 128 })
  canonical_symbol: string;

  @Column({ type: 'varchar', length: 8 })
  exchange: string;

  @Column({ type: 'varchar', length: 64 })
  underlying: string;

  @Column({ type: 'varchar', length: 8 })
  instrument_type: string;

  @Column({ type: 'date', nullable: true })
  expiry: Date | null;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 4,
    nullable: true,
    default: 0,
  })
  strike: number | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  option_type: string | null;

  @Column({ type: 'int', default: 1 })
  lot_size: number;

  @Column({ type: 'decimal', precision: 10, scale: 4, default: 0.05 })
  tick_size: number;

  @Column({ type: 'varchar', length: 128, default: '' })
  name: string;

  @Column({ type: 'varchar', length: 16, default: '' })
  segment: string;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'varchar', length: 16, default: 'equity' })
  asset_class: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
