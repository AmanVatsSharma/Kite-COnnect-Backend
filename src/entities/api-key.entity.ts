import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('api_keys')
@Index(['key'], { unique: true })
@Index(['tenant_id'])
export class ApiKey {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  key: string;

  @Column({ nullable: false })
  tenant_id: string;

  @Column({ nullable: true })
  name: string;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'int', default: 600 })
  rate_limit_per_minute: number;

  @Column({ type: 'int', default: 2000 })
  connection_limit: number;

  @Column({ type: 'json', nullable: true })
  metadata: any;

  // Optional provider override for this API key. When null, resolution falls back to global/env.
  @Column({ type: 'varchar', length: 16, nullable: true })
  provider?: 'kite' | 'vortex' | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
