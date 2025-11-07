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
}


