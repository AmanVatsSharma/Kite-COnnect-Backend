/**
 * @file fundamentals-cache.entity.ts
 * @module fundamentals
 * @description Postgres cache entity for fundamental data fetched from Yahoo Finance.
 * @author BharatERP
 * @created 2026-05-24
 * @updated 2026-05-24
 *
 * Exports:
 *   - FundamentalsCache                      — TypeORM entity for fundamentals_cache table
 *
 * Depends on:
 *   - typeorm (decorators)
 *
 * Side-effects:
 *   - DB write via TypeORM upsert on cache fetch
 *
 * Key invariants:
 *   - symbol is unique per exchange; (symbol, exchange) is the natural key
 *   - data column is JSONB holding the full Yahoo Finance response shape
 *   - nextFetchAt computed at write time using FUNDAMENTALS_CACHE_TTL_HOURS env var (default 24h)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('fundamentals_cache')
@Index(['symbol', 'exchange'], { unique: true })
@Index(['nextFetchAt'])
export class FundamentalsCache {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 32 })
  symbol: string;

  @Column({ type: 'varchar', length: 16, default: 'NSE' })
  exchange: string;

  @Column({ type: 'timestamp with time zone' })
  fetchedAt: Date;

  @Column({ type: 'timestamp with time zone' })
  nextFetchAt: Date;

  /** Full Yahoo Finance response stored as JSONB for flexibility */
  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, any> | null;

  /** Raw price data from chart endpoint */
  @Column({ type: 'jsonb', nullable: true })
  priceData: Record<string, any> | null;

  /** True when data was served from cache but is stale (nextFetchAt passed) */
  @Column({ type: 'boolean', default: false })
  stale: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}