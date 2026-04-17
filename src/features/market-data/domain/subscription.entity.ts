/**
 * @file subscription.entity.ts
 * @module market-data
 * @description Persisted instrument subscriptions per user, with UIR linkage for symbol-based access.
 * @author BharatERP
 * @created 2025-01-01
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

@Entity('subscriptions')
@Index(['user_id', 'instrument_token'])
export class Subscription {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  user_id: string;

  @Column()
  instrument_token: number;

  @Column()
  subscription_type: string; // 'live', 'historical', 'both'

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'json', nullable: true })
  metadata: any;

  @Column({ type: 'bigint', nullable: true })
  uir_id: number | null; // FK to universal_instruments.id

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
