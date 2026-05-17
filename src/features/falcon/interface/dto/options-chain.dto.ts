import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FalconOptionCEPE {
  @ApiProperty({ description: 'Instrument token', example: 12345678 })
  instrument_token: number;

  @ApiProperty({ description: 'Trading symbol', example: 'NIFTY25MAY24000CE' })
  tradingsymbol: string;

  @ApiProperty({ description: 'Option name', example: 'NIFTY' })
  name: string;

  @ApiPropertyOptional({ description: 'Last traded price', example: 245.5 })
  last_price?: number | null;

  @ApiPropertyOptional({ description: 'UIR ID if available' })
  uir_id?: string;

  @ApiPropertyOptional({ description: 'Option type', example: 'CE' })
  instrument_type?: string;
}

export class FalconOptionStrike {
  @ApiProperty({ description: 'Strike price', example: 24000 })
  strike: number;

  @ApiPropertyOptional({ description: 'Call option data', type: FalconOptionCEPE })
  CE?: FalconOptionCEPE;

  @ApiPropertyOptional({ description: 'Put option data', type: FalconOptionCEPE })
  PE?: FalconOptionCEPE;
}

export class FalconOptionsChainDataDto {
  @ApiProperty({ description: 'Symbol name', example: 'NIFTY' })
  symbol: string;

  @ApiPropertyOptional({ description: 'Available expiry dates', example: ['2025-05-29', '2025-06-05'] })
  expiries?: string[];

  @ApiPropertyOptional({ description: 'Available strike prices', example: [23500, 23550, 23600] })
  strikes?: number[];

  @ApiPropertyOptional({ description: 'Options chain grouped by expiry and strike' })
  options?: {
    [expiry: string]: {
      [strike: string]: { CE?: FalconOptionCEPE; PE?: FalconOptionCEPE };
    };
  };

  @ApiProperty({ description: 'Whether LTP filter is applied', example: false })
  ltp_only: boolean;
}

export class FalconOptionsChainResponseDto {
  @ApiProperty({ description: 'Success status', example: true })
  success: boolean;

  @ApiPropertyOptional({ description: 'Options chain data', type: FalconOptionsChainDataDto })
  data?: FalconOptionsChainDataDto;
}

export class FalconDeepOptionCE {
  @ApiProperty({ description: 'Instrument token', example: 12345678 })
  instrument_token: number;

  @ApiPropertyOptional({ description: 'Last traded price', example: 245.5 })
  last_price?: number | null;

  @ApiPropertyOptional({ description: 'Open interest', example: 1250000 })
  oi?: number;

  @ApiPropertyOptional({ description: 'Volume', example: 500000 })
  volume?: number;

  @ApiPropertyOptional({ description: 'Open price', example: 240.0 })
  open?: number;

  @ApiPropertyOptional({ description: 'High price', example: 250.0 })
  high?: number;

  @ApiPropertyOptional({ description: 'Low price', example: 235.0 })
  low?: number;

  @ApiPropertyOptional({ description: 'Close price', example: 245.5 })
  close?: number;

  @ApiPropertyOptional({ description: 'Bid price', example: 245.0 })
  bid?: number;

  @ApiPropertyOptional({ description: 'Ask price', example: 246.0 })
  ask?: number;

  @ApiPropertyOptional({ description: 'Bid quantity', example: 100 })
  bq?: number;

  @ApiPropertyOptional({ description: 'Ask quantity', example: 100 })
  aq?: number;

  @ApiPropertyOptional({ description: 'Implied Volatility', example: 15.5 })
  iv?: number;

  @ApiPropertyOptional({ description: 'Delta', example: 0.55 })
  delta?: number;

  @ApiPropertyOptional({ description: 'Gamma', example: 0.03 })
  gamma?: number;

  @ApiPropertyOptional({ description: 'Theta', example: -5.2 })
  theta?: number;

  @ApiPropertyOptional({ description: 'Vega', example: 12.5 })
  vega?: number;

  @ApiPropertyOptional({ description: 'Theoretical price', example: 245.0 })
  theoretical_price?: number;
}

export class FalconDeepOptionStrike {
  @ApiProperty({ description: 'Strike price', example: 24000 })
  strike: number;

  @ApiPropertyOptional({ description: 'Call option with full market data', type: () => Object })
  CE?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Put option with full market data', type: () => Object })
  PE?: Record<string, any>;
}

export class FalconDeepOptionExpiry {
  @ApiProperty({ description: 'Expiry date', example: '2025-05-29' })
  expiry: string;

  @ApiPropertyOptional({ description: 'PCR (Put-Call Ratio)', example: 0.95 })
  pcr?: number;

  @ApiPropertyOptional({ description: 'Total Call OI', example: 1500000 })
  total_ce_oi?: number;

  @ApiPropertyOptional({ description: 'Total Put OI', example: 1425000 })
  total_pe_oi?: number;

  @ApiPropertyOptional({ description: 'Call strikes in this expiry', type: () => FalconDeepOptionStrike, isArray: true })
  strikes?: FalconDeepOptionStrike[];
}

export class FalconDeepOptionsChainResponseDto {
  @ApiProperty({ description: 'Success status', example: true })
  success: boolean;

  @ApiPropertyOptional({ description: 'Underlying symbol', example: 'NIFTY' })
  symbol?: string;

  @ApiPropertyOptional({ description: 'Underlying LTP', example: 23850.0 })
  underlying_ltp?: number;

  @ApiPropertyOptional({ description: 'Expiry data with full market depth', type: () => FalconDeepOptionExpiry, isArray: true })
  expiries?: FalconDeepOptionExpiry[];
}