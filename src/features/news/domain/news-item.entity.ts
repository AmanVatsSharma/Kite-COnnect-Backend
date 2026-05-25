/**
 * @file news-item.entity.ts
 * @module news
 * @description Finnhub news item entity — persisted in Postgres for audit and search.
 * @author BharatERP
 * @created 2026-05-24
 *
 * Exports:
 *   - NewsItem — TypeORM entity for `news_items` table
 *
 * Depends on:
 *   - typeorm — decorators
 *
 * Side-effects:
 *   - Database reads/writes on every query
 *
 * Key invariants:
 *   - finnhubId is unique per Finnhub source; source+url is unique to avoid duplicate URLs
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('news_items')
@Index(['finnhubId'])
@Index(['source'])
@Index(['category'])
@Index(['publishedAt'])
export class NewsItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Finnhub's numeric news ID */
  @Column({ type: 'int', nullable: true })
  finnhubId: number | null;

  /** Source outlet (e.g. "CNBC", "Economic Times") */
  @Column({ type: 'varchar', length: 128 })
  source: string;

  /** Finnhub category: general, forex, crypto, commodity */
  @Column({ type: 'varchar', length: 32, default: 'general' })
  category: string;

  /** Headline / title of the article */
  @Column({ type: 'text' })
  headline: string;

  /** Summary / excerpt */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  /** Direct URL to the article */
  @Column({ type: 'varchar', length: 1024 })
  url: string;

  /** Optional hero image URL */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  imageUrl: string | null;

  /** When the article was published (Unix timestamp → ISO via Finnhub) */
  @Column({ type: 'timestamptz' })
  publishedAt: Date;

  /** Comma-separated ticker list from Finnhub's `related` field */
  @Column({ type: 'text', nullable: true })
  relatedSymbolsRaw: string | null;

  /** Parsed array of symbols (derived from relatedSymbolsRaw) */
  @Column({ type: 'jsonb', nullable: true })
  relatedSymbols: string[] | null;

  @CreateDateColumn()
  createdAt: Date;
}