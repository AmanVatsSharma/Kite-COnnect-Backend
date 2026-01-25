import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * ApiKeyAbuseFlag
 *
 * Tracks abuse / resell suspicion for individual API keys.
 * Populated by AbuseDetectionService from request_audit_logs + metrics.
 */
@Entity('api_key_abuse_flags')
@Index(['api_key'], { unique: true })
@Index(['blocked', 'risk_score'])
export class ApiKeyAbuseFlag {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  api_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  tenant_id: string | null;

  // Higher means more suspicious. Scale is arbitrary and internal.
  @Column({ type: 'int', default: 0 })
  risk_score: number;

  // JSON array of machine-readable reason codes (e.g., ['many_ips', 'high_rps'])
  @Column({ type: 'jsonb', nullable: true })
  reason_codes: string[] | null;

  @Column({ type: 'boolean', default: false })
  blocked: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  detected_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  last_seen_at: Date | null;
}


