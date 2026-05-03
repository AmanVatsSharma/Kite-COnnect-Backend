/**
 * @file binance-instrument.entity.ts
 * @module binance
 * @description TypeORM entity for the binance_instruments table — one row per Binance Spot symbol.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('binance_instruments')
@Index(['symbol'], { unique: true })
@Index(['quote_asset'])
@Index(['is_active'])
export class BinanceInstrument {
  @PrimaryGeneratedColumn()
  id: number;

  /** Symbol as Binance reports it (always uppercase, no separator). e.g. "BTCUSDT". */
  @Column({ type: 'varchar', length: 32 })
  symbol: string;

  /** Base asset of the pair. e.g. "BTC". */
  @Column({ type: 'varchar', length: 16 })
  base_asset: string;

  /** Quote asset of the pair. e.g. "USDT". */
  @Column({ type: 'varchar', length: 16 })
  quote_asset: string;

  /** TRADING | HALT | BREAK | END_OF_DAY | AUCTION_MATCH | PRE_TRADING | POST_TRADING. We only ingest TRADING. */
  @Column({ type: 'varchar', length: 24, default: 'TRADING' })
  status: string;

  /** Minimum price increment, from PRICE_FILTER.tickSize. */
  @Column({ type: 'decimal', precision: 20, scale: 10, nullable: true })
  tick_size: string | null;

  /** Minimum quantity increment, from LOT_SIZE.stepSize. */
  @Column({ type: 'decimal', precision: 20, scale: 10, nullable: true })
  step_size: string | null;

  /** Minimum notional order value (price × quantity), from MIN_NOTIONAL filter. */
  @Column({ type: 'decimal', precision: 20, scale: 10, nullable: true })
  min_notional: string | null;

  @Column({ default: true })
  is_active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
