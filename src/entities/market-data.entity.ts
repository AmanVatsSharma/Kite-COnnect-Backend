import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { Instrument } from './instrument.entity';

@Entity('market_data')
@Index(['instrument_token', 'timestamp'])
@Index(['timestamp'])
export class MarketData {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  instrument_token: number;

  @Column('decimal', { precision: 10, scale: 2 })
  last_price: number;

  @Column('decimal', { precision: 10, scale: 2 })
  open: number;

  @Column('decimal', { precision: 10, scale: 2 })
  high: number;

  @Column('decimal', { precision: 10, scale: 2 })
  low: number;

  @Column('decimal', { precision: 10, scale: 2 })
  close: number;

  @Column('bigint')
  volume: number;

  @Column('decimal', { precision: 10, scale: 2 })
  ohlc_open: number;

  @Column('decimal', { precision: 10, scale: 2 })
  ohlc_high: number;

  @Column('decimal', { precision: 10, scale: 2 })
  ohlc_low: number;

  @Column('decimal', { precision: 10, scale: 2 })
  ohlc_close: number;

  @Column('bigint')
  ohlc_volume: number;

  @Column()
  timestamp: Date;

  @Column({ default: 'live' })
  data_type: string; // 'live', 'historical'

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Instrument, { eager: false })
  @JoinColumn({ name: 'instrument_token', referencedColumnName: 'instrument_token' })
  instrument: Instrument;
}
