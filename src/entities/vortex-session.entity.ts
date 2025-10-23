import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('vortex_sessions')
@Index(['is_active'])
export class VortexSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: false })
  access_token: string;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date | null;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'json', nullable: true })
  metadata: any;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}


