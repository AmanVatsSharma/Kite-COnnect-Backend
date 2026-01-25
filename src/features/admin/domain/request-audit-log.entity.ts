import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * RequestAuditLog
 *
 * Stores a lightweight audit trail of HTTP and WebSocket activity per API key,
 * including origin metadata (IP, User-Agent, optional geo/ASN).
 *
 * This is designed for:
 * - Abuse / resell detection
 * - Forensics and debugging
 * - High-level analytics (where are calls coming from?)
 */
@Entity('request_audit_logs')
@Index(['api_key'])
@Index(['tenant_id'])
@Index(['ts'])
@Index(['kind', 'ts'])
@Index(['ip'])
export class RequestAuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ type: 'timestamptz' })
  ts: Date;

  @Column({ type: 'varchar', length: 255, nullable: true })
  api_key: string | null;

  @Column({ type: 'int', nullable: true })
  api_key_id: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  tenant_id: string | null;

  // http | ws (extendable to other kinds if needed)
  @Column({ type: 'varchar', length: 16 })
  kind: 'http' | 'ws';

  // HTTP route (e.g., /stock/ltp) or WS event (e.g., subscribe)
  @Column({ type: 'varchar', length: 255 })
  route_or_event: string;

  // HTTP method or WS operation type
  @Column({ type: 'varchar', length: 16, nullable: true })
  method: string | null;

  // HTTP status code; for WS, synthetic status (e.g., 101 for connect, 499 for disconnect)
  @Column({ type: 'int', nullable: true })
  status: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'text', nullable: true })
  user_agent: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  origin: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  country: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  asn: string | null;

  @Column({ type: 'int', nullable: true })
  duration_ms: number | null;

  // Small JSON bag for extra details (e.g., ws namespace, query params snapshot)
  @Column({ type: 'jsonb', nullable: true })
  meta: any | null;
}


