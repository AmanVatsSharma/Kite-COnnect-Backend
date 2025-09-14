import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('instruments')
@Index(['instrument_token'])
@Index(['tradingsymbol'])
@Index(['instrument_type'])
export class Instrument {
  @PrimaryColumn()
  instrument_token: number;

  @Column()
  exchange_token: number;

  @Column()
  tradingsymbol: string;

  @Column()
  name: string;

  @Column()
  last_price: number;

  @Column()
  expiry: string;

  @Column()
  strike: number;

  @Column()
  tick_size: number;

  @Column()
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
