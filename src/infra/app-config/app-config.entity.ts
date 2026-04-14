/**
 * @file app-config.entity.ts
 * @module infra/app-config
 * @description Key-value store for runtime operator configuration (provider credentials etc).
 *   Values are encrypted-at-rest in production (recommendation); stored as plain text here.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14
 */
import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
  CreateDateColumn,
} from 'typeorm';

@Entity('app_configs')
export class AppConfig {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  key: string;

  @Column({ type: 'text' })
  value: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
