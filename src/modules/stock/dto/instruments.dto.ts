import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsInt } from 'class-validator';

export class InstrumentsRequestDto {
  @ApiProperty({ type: [Number], example: [738561, 5633], description: 'List of instrument tokens (max varies by endpoint)' })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  instruments!: number[];
}


