/**
 * @file apps/search-api/src/modules/search/dto/search-query.dto.ts
 * @module search-api
 * @description class-validator DTO for /api/search and /api/search/suggest query params.
 *              Replaces bare @Query() strings so the global ValidationPipe
 *              (main.ts) can enforce types and bounds.
 *
 * All fields are optional EXCEPT `q`. Unknown query params are stripped by the
 * global ValidationPipe (`whitelist: true`).
 *
 * The `parsedExpiryFrom` / `parsedExpiryTo` / `isMonthly` / `isWeekly` fields
 * are populated by the F&O query parser pipeline (Task 6) and layered into
 * the MeiliSearch filter alongside the explicit user-supplied params.
 *
 * @author BharatERP
 * @created 2026-06-23
 */
import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SearchQueryDto {
  @IsString()
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  exchange?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  segment?: string;

  @IsOptional()
  @IsIn(['EQ', 'FUT', 'CE', 'PE', 'ETF', 'IDX'])
  instrumentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  vortexExchange?: string;

  @IsOptional()
  @IsIn(['CE', 'PE'])
  optionType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  assetClass?: string;

  @IsOptional()
  @IsIn([
    'falcon',
    'vayu',
    'atlas',
    'drift',
    'kite',
    'vortex',
    'massive',
    'binance',
  ])
  streamProvider?: string;

  @IsOptional()
  @IsIn(['eq', 'fno', 'curr', 'commodities'])
  mode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  expiry_from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  expiry_to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  strike_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  strike_max?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  offset?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sort?: string;

  @IsOptional()
  @IsBooleanString()
  ltp_only?: string;

  @IsOptional()
  @IsBooleanString()
  live?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  fields?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  include?: string;

  // ── NL parser pipeline outputs (additive) ──────────────────────────────────
  // These are populated by FnoQueryParserService in Task 6. The DTO accepts
  // them so callers (and tests) can pre-set them, but the controller is the
  // canonical writer.

  /** ISO date (YYYY-MM-DD) — derived from the parser when the user said e.g. "this thursday". */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  parsedExpiryFrom?: string;

  /** ISO date (YYYY-MM-DD) — derived from the parser when the user said e.g. "next week expiry". */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  parsedExpiryTo?: string;

  /** True when the parser detected "monthly" / "monthly expiry" phrasing. */
  @IsOptional()
  isMonthly?: boolean;

  /** True when the parser detected "weekly" / "weekly expiry" phrasing. */
  @IsOptional()
  isWeekly?: boolean;
}
