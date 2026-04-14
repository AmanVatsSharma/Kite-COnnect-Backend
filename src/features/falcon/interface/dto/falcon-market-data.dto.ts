/**
 * @file falcon-market-data.dto.ts
 * @module falcon
 * @description DTOs for Falcon market data endpoints: Quote, OHLC, Historical candles, Batch historical, Cache flush.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14 — added FalconBatchHistoricalDto, FalconCacheFlushDto
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const VALID_INTERVALS = ['minute', '3minute', '5minute', '10minute', '15minute', '30minute', '60minute', 'day'] as const;
export type HistoricalInterval = (typeof VALID_INTERVALS)[number];

export class FalconTokensDto {
  @ApiProperty({
    description: 'Array of instrument tokens (numeric strings) or EXCHANGE:SYMBOL identifiers. Max 500.',
    example: ['256265', '738561'],
    type: [String],
  })
  tokens!: string[];
}

export class FalconHistoricalQueryDto {
  @ApiProperty({
    description: "From date in 'YYYY-MM-DD' or 'YYYY-MM-DD HH:mm:ss' format",
    example: '2026-04-01',
  })
  from!: string;

  @ApiProperty({
    description: "To date in 'YYYY-MM-DD' or 'YYYY-MM-DD HH:mm:ss' format",
    example: '2026-04-11',
  })
  to!: string;

  @ApiProperty({
    description: 'Candle interval',
    enum: VALID_INTERVALS,
    example: 'day',
  })
  interval!: HistoricalInterval;

  @ApiPropertyOptional({
    description: 'Fetch continuous contract data (F&O only). Defaults to false.',
    example: false,
  })
  continuous?: string;

  @ApiPropertyOptional({
    description: 'Include Open Interest in candles (F&O only). Defaults to false.',
    example: false,
  })
  oi?: string;
}

/** Single item in a batch historical request. */
export class FalconBatchHistoricalItemDto {
  @ApiProperty({ description: 'Instrument token (numeric)', example: 738561 })
  token!: number;

  @ApiProperty({ description: "From date 'YYYY-MM-DD' or 'YYYY-MM-DD HH:mm:ss'", example: '2026-04-01' })
  from!: string;

  @ApiProperty({ description: "To date 'YYYY-MM-DD' or 'YYYY-MM-DD HH:mm:ss'", example: '2026-04-11' })
  to!: string;

  @ApiProperty({ description: 'Candle interval', enum: VALID_INTERVALS, example: 'day' })
  interval!: HistoricalInterval;

  @ApiPropertyOptional({ description: 'Continuous contract (F&O only)', example: false })
  continuous?: boolean;

  @ApiPropertyOptional({ description: 'Include OI (F&O only)', example: false })
  oi?: boolean;
}

/** Body for POST /historical/batch — up to 10 tokens in a single call. */
export class FalconBatchHistoricalDto {
  @ApiProperty({
    description: 'Array of historical requests (max 10). Each must include token, from, to, interval.',
    type: [FalconBatchHistoricalItemDto],
  })
  requests!: FalconBatchHistoricalItemDto[];
}

/** Body for DELETE /admin/falcon/cache/flush. */
export class FalconCacheFlushDto {
  @ApiProperty({
    description: 'Cache type to flush',
    enum: ['options', 'ltp', 'historical'],
    example: 'options',
  })
  type!: 'options' | 'ltp' | 'historical';

  @ApiPropertyOptional({
    description: 'Underlying symbol — required when type=options (e.g. NIFTY)',
    example: 'NIFTY',
  })
  symbol?: string;

  @ApiPropertyOptional({
    description: 'Instrument token — required when type=ltp or type=historical',
    example: 738561,
  })
  token?: number;
}
