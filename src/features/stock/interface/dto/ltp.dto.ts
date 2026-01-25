import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class LtpPairDto {
  @ApiProperty({ enum: ['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO'], example: 'NSE_EQ' })
  @IsIn(['NSE_EQ', 'NSE_FO', 'NSE_CUR', 'MCX_FO'])
  exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';

  @ApiProperty({ description: 'Instrument token', example: 26000 })
  @Transform(({ value }) => Number(value))
  @IsNumber()
  token: number;
}

export class LtpRequestDto {
  @ApiPropertyOptional({ type: [Number], description: 'List of instrument tokens' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  instruments?: number[];

  @ApiPropertyOptional({ type: [LtpPairDto], description: 'Explicit exchange-token pairs' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => LtpPairDto)
  pairs?: LtpPairDto[];
}


