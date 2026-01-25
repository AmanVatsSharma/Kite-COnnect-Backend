import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class DebugResolveQueryDto {
  @ApiProperty({ description: 'Comma-separated numeric tokens', example: '738561,135938' })
  @IsString()
  tokens: string;
}

export class DebugBuildQQueryDto {
  @ApiProperty({ description: 'Comma-separated numeric tokens', example: '738561,135938' })
  @IsString()
  tokens: string;

  @ApiPropertyOptional({ description: 'Quotes mode', enum: ['ltp', 'ohlc', 'full'], example: 'ltp' })
  @IsOptional()
  @IsString()
  @IsIn(['ltp', 'ohlc', 'full'])
  mode?: 'ltp' | 'ohlc' | 'full';
}


