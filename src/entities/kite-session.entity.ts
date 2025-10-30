import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('kite_sessions')
@Index(['is_active'])
export class KiteSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: false })
  access_token: string;

  @Column({ nullable: true })
  public_token: string;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'json', nullable: true })
  metadata: any;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
