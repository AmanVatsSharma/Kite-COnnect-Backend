import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VayuOptionCEPE {
  @ApiPropertyOptional({ description: 'CE instrument token', example: 12345678 })
  token?: string;

  @ApiPropertyOptional({ description: 'Last traded price', example: 245.5 })
  last_price?: number;

  @ApiPropertyOptional({ description: 'UIR ID if available' })
  uir_id?: string;
}

export class VayuOptionStrike {
  @ApiProperty({ description: 'Strike price', example: 24000 })
  strike: number;

  @ApiPropertyOptional({ description: 'Call option data', type: VayuOptionCEPE })
  CE?: VayuOptionCEPE;

  @ApiPropertyOptional({ description: 'Put option data', type: VayuOptionCEPE })
  PE?: VayuOptionCEPE;
}

export class VayuOptionExpiry {
  @ApiProperty({ description: 'Expiry date string', example: '2025-05-29' })
  expiry: string;

  @ApiPropertyOptional({ description: 'Strikes for this expiry', type: () => VayuOptionStrike, isArray: true })
  strikes?: VayuOptionStrike[];
}

export class VayuOptionsChainResponseDto {
  @ApiProperty({ description: 'Success status', example: true })
  success: true;

  @ApiPropertyOptional({ description: 'Options chain data', type: Object })
  data?: {
    symbol: string;
    expiries: string[];
    strikes: number[];
    options: {
      [expiry: string]: {
        [strike: string]: { CE?: VayuOptionCEPE; PE?: VayuOptionCEPE };
      };
    };
    performance?: {
      queryTime: number;
    };
    ltp_only: boolean;
  };

  @ApiPropertyOptional({ description: 'Error message if failed' })
  message?: string;
}