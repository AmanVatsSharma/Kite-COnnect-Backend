import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsInt } from 'class-validator';

export class BatchTokensDto {
  @ApiProperty({ type: [Number], maxItems: 100, description: 'Array of instrument tokens (max 100)' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  tokens!: number[];
}


