/**
 * @file falcon-market-data.dto.ts
 * @module falcon
 * @description DTOs for Falcon market data endpoints: Quote, OHLC, Historical candles.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14
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
