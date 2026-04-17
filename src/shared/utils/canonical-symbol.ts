/**
 * @file canonical-symbol.ts
 * @module shared
 * @description Generates and parses canonical symbol identifiers (Exchange:Underlying[:Type[:Expiry[:Strike]]]).
 * @author BharatERP
 * @created 2026-04-17
 * @updated 2026-04-17
 */

export interface CanonicalSymbolInput {
  exchange: string;
  underlying: string;
  instrument_type: string; // EQ, FUT, CE, PE, IDX
  expiry?: Date | null;
  strike?: number | null;
  option_type?: string | null; // CE, PE
}

export interface ParsedCanonicalSymbol {
  exchange: string;
  underlying: string;
  instrument_type: string; // EQ, FUT, CE, PE, IDX
  expiry?: string; // YYYYMMDD format
  strike?: number;
  option_type?: string;
}

/**
 * Formats a Date to YYYYMMDD string.
 */
export function formatExpiryDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Formats a strike price: integers have no decimals, fractional values keep their decimals.
 */
function formatStrike(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : String(strike);
}

/**
 * Generates a canonical symbol string from structured input.
 *
 * Format by type:
 * - EQ:  `{exchange}:{underlying}`
 * - IDX: `{exchange}:{underlying}:IDX`
 * - FUT: `{exchange}:{underlying}:FUT:{YYYYMMDD}`
 * - CE:  `{exchange}:{underlying}:CE:{YYYYMMDD}:{strike}`
 * - PE:  `{exchange}:{underlying}:PE:{YYYYMMDD}:{strike}`
 */
export function computeCanonicalSymbol(input: CanonicalSymbolInput): string {
  const { exchange, underlying, instrument_type } = input;
  const type = instrument_type.toUpperCase();

  switch (type) {
    case 'EQ':
      return `${exchange}:${underlying}`;

    case 'IDX':
      return `${exchange}:${underlying}:IDX`;

    case 'FUT': {
      const expiry = input.expiry ? formatExpiryDate(input.expiry) : '';
      return `${exchange}:${underlying}:FUT:${expiry}`;
    }

    case 'CE':
    case 'PE': {
      const expiry = input.expiry ? formatExpiryDate(input.expiry) : '';
      const strike = input.strike != null ? formatStrike(input.strike) : '0';
      return `${exchange}:${underlying}:${type}:${expiry}:${strike}`;
    }

    default:
      return `${exchange}:${underlying}:${type}`;
  }
}

/**
 * Parses a canonical symbol string back into its structured components.
 *
 * - 2 parts: equity (exchange:underlying, type=EQ)
 * - 3 parts: index or bare symbol (exchange:underlying:IDX)
 * - 4 parts: future (exchange:underlying:FUT:YYYYMMDD)
 * - 5 parts: option (exchange:underlying:CE|PE:YYYYMMDD:strike)
 */
export function parseCanonicalSymbol(symbol: string): ParsedCanonicalSymbol {
  const parts = symbol.split(':');

  switch (parts.length) {
    case 2:
      return {
        exchange: parts[0],
        underlying: parts[1],
        instrument_type: 'EQ',
      };

    case 3:
      return {
        exchange: parts[0],
        underlying: parts[1],
        instrument_type: parts[2],
      };

    case 4:
      return {
        exchange: parts[0],
        underlying: parts[1],
        instrument_type: parts[2],
        expiry: parts[3],
      };

    case 5: {
      const type = parts[2];
      return {
        exchange: parts[0],
        underlying: parts[1],
        instrument_type: type,
        expiry: parts[3],
        strike: Number(parts[4]),
        option_type: type === 'CE' || type === 'PE' ? type : undefined,
      };
    }

    default:
      return {
        exchange: parts[0] ?? '',
        underlying: parts[1] ?? '',
        instrument_type: parts[2] ?? 'EQ',
      };
  }
}
