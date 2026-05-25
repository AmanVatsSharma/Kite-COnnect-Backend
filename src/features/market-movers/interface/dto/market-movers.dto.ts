/**
 * File:        market-movers.dto.ts
 * Module:      market-movers
 * Description: DTOs for market movers HTTP endpoint.
 * @author BharatERP
 * @created 2026-05-24
 * @updated 2026-05-24
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum MoversType {
  GAINERS = 'gainers',
  LOSERS = 'losers',
  ACTIVE = 'active',
}

export class MarketMoversQueryDto {
  @ApiPropertyOptional({ enum: MoversType, default: MoversType.GAINERS })
  @IsOptional()
  @IsEnum(MoversType)
  type?: MoversType = MoversType.GAINERS;

  @ApiPropertyOptional({ description: 'NSE or BSE', default: 'NSE' })
  @IsOptional()
  @IsString()
  exchange?: string = 'NSE';
}

export class MoverItemDto {
  @ApiProperty({ description: 'Trading symbol' })
  symbol!: string;

  @ApiProperty({ description: 'Company name' })
  name!: string;

  @ApiProperty({ description: 'Last traded price' })
  lastPrice!: number;

  @ApiProperty({ description: 'Percentage change' })
  changePercent!: number;

  @ApiProperty({ description: 'Volume traded' })
  volume!: number;

  @ApiPropertyOptional({ description: 'Reason for the move (if available)' })
  reason?: string;
}

export class MarketMoversDataDto {
  @ApiProperty()
  type!: string;

  @ApiProperty()
  exchange!: string;

  @ApiProperty()
  generatedAt!: string;

  @ApiProperty({ type: [MoverItemDto] })
  items!: MoverItemDto[];
}

export class MarketMoversResponseDto {
  @ApiProperty()
  success!: boolean;

  @ApiProperty({ type: MarketMoversDataDto })
  data!: MarketMoversDataDto;
}