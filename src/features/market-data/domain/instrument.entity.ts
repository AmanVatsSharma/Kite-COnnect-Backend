import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('instruments')
@Index(['instrument_token'])
@Index(['tradingsymbol'])
@Index(['instrument_type'])
export class Instrument {
  @PrimaryColumn()
  instrument_token: number;

  @Column({ nullable: true })
  exchange_token: number;

  @Column()
  tradingsymbol: string;

  @Column()
  name: string;

  @Column('decimal', { precision: 14, scale: 4, transformer: { to: (v: any) => v, from: (v: any) => parseFloat(v) } })
  last_price: number;

  @Column()
  expiry: string;

  @Column('decimal', { precision: 14, scale: 4, transformer: { to: (v: any) => v, from: (v: any) => parseFloat(v) } })
  strike: number;

  @Column('decimal', { precision: 10, scale: 4, transformer: { to: (v: any) => v, from: (v: any) => parseFloat(v) } })
  tick_size: number;

  @Column('decimal', { precision: 14, scale: 4, transformer: { to: (v: any) => v, from: (v: any) => parseFloat(v) } })
  lot_size: number;

  @Column()
  instrument_type: string;

  @Column()
  segment: string;

  @Column()
  exchange: string;

  @Column({ default: true })
  is_active: boolean;

  @Column({ default: false })
  is_subscribed: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
