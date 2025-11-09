import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class ValidateInstrumentsDto {
  @ApiPropertyOptional({ description: 'Filter by exchange', example: 'MCX_FO', enum: ['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO'] })
  @IsOptional()
  @IsString()
  @IsIn(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO'])
  exchange?: string;

  @ApiPropertyOptional({ description: 'Filter by instrument type', example: 'FUTCOM' })
  @IsOptional()
  @IsString()
  instrument_name?: string;

  @ApiPropertyOptional({ description: 'Filter by symbol (partial match)', example: 'GOLD' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ description: 'Filter by option type (CE/PE/null)', example: 'CE' })
  @IsOptional()
  @IsString()
  @IsIn(['CE', 'PE'])
  option_type?: string;

  @ApiPropertyOptional({ description: 'Number of instruments to test per batch', example: 1000, default: 1000 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(1000)
  batch_size?: number = 1000;

  @ApiPropertyOptional({ description: 'If true, deactivates invalid instruments', example: false, default: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  auto_cleanup?: boolean = false;

  @ApiPropertyOptional({ description: 'If true, only reports without making changes', example: true, default: true })
  @IsOptional()
  @Transform(({ value }) => !(value === 'false' || value === false))
  @IsBoolean()
  dry_run?: boolean = true;

  @ApiPropertyOptional({ description: 'If true, include full list of invalid instruments in response', example: false, default: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  include_invalid_list?: boolean = false;

  @ApiPropertyOptional({ description: 'Number of probe attempts per batch for consensus', example: 3, default: 3, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  probe_attempts?: number = 3;

  @ApiPropertyOptional({ description: 'Milliseconds to wait between Vortex calls (>=1000 enforced)', example: 1000, default: 1000, minimum: 1000 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1000)
  probe_interval_ms?: number = 1000;

  @ApiPropertyOptional({ description: 'Consensus threshold for classifying as no_ltp', example: 2, default: 2, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  require_consensus?: number = 2;

  @ApiPropertyOptional({ description: 'If true, never deactivate indeterminate tokens (recommended)', example: true, default: true })
  @IsOptional()
  @Transform(({ value }) => !(value === 'false' || value === false))
  @IsBoolean()
  safe_cleanup?: boolean = true;

  @ApiPropertyOptional({ description: 'Cap the total number of instruments processed (optional)', example: 2000 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;
}


