import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('instrument_mappings')
@Index(['provider', 'provider_token'], { unique: true })
export class InstrumentMapping {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16 })
  provider: 'kite' | 'vortex';

  @Column({ type: 'varchar', length: 64 })
  provider_token: string;

  @Column({ type: 'int' })
  instrument_token: number; // FK to instruments.instrument_token (not enforced, for simplicity)

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}


