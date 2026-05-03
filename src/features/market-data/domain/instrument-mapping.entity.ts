/**
 * @file instrument-mapping.entity.ts
 * @module market-data
 * @description Maps provider-specific instrument tokens to universal instrument registry IDs.
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-04-26
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('instrument_mappings')
@Index(['provider', 'provider_token'], { unique: true })
@Index(['uir_id'])
export class InstrumentMapping {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16 })
  provider: 'kite' | 'vortex' | 'massive' | 'binance';

  @Column({ type: 'varchar', length: 64 })
  provider_token: string;

  @Column({ type: 'int' })
  instrument_token: number; // FK to instruments.instrument_token (not enforced, for simplicity)

  @Column({ type: 'bigint', nullable: true })
  uir_id: number | null; // FK to universal_instruments.id

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
