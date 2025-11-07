import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ClearCacheDto {
  @ApiPropertyOptional({ description: 'Cache key pattern (optional, defaults to vortex:*)' })
  @IsOptional()
  @IsString()
  pattern?: string;
}


